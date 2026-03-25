require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { Client: NotionClient } = require("@notionhq/client");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const path = require("path");

// fluent-ffmpeg가 설치된 ffmpeg 및 ffprobe 패키지를 사용하도록 경로 설정
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
const notion = new NotionClient({ auth: process.env.NOTION_KEY });
const DATABASE_ID = process.env.BJ_NOTION_DATABASE_ID;

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  EndBehaviorType,
  createAudioPlayer,
} = require("@discordjs/voice");
const fs = require("fs");
const prism = require("prism-media");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// 봇이 준비되었을 때 실행
client.once("clientReady", () => {
  console.log(`성공! ${client.user.tag} 에이전트가 온라인입니다.`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // 1. 회의 시작 명령어
  if (message.content === "/회의시작") {
    const channel = message.member.voice.channel;
    if (!channel) return message.reply("먼저 음성 채널에 들어가 주세요!");

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // 듣기 위해 본인 소거 해제
    });

    message.reply(
      "🎤 회의 기록 에이전트가 입장했습니다. 지금부터 목소리를 수집합니다.",
    );

    // 사용자가 말할 때 감지
    connection.receiver.speaking.on("start", (userId) => {
      console.log(`${userId}님이 말하기 시작함`);

      // 음성 스트림 생성 및 파일 저장 (PCM 형식)
      const audioStream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });

      const fileName = `./recordings/${userId}-${Date.now()}.pcm`;
      const out = fs.createWriteStream(fileName);
      const opusDecoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960,
      });

      audioStream.pipe(opusDecoder).pipe(out);
    });
  }

  // 2. 회의 종료 명령어
  if (message.content === "/회의종료") {
    const channel = message.member.voice.channel;
    if (!channel)
      return message.reply(
        "명령어를 실행하기 전에 먼저 음성 채널에 들어가 주세요!",
      );

    const connection = getVoiceConnection(message.guild.id);

    // 만약 봇이 어떤 채널에도 연결되어 있지 않다면 (회의 중이 아니라면)
    if (!connection) {
      return message.reply("현재 기록 중인 회의가 없습니다!");
    }

    // 회의가 진행 중이었다면 연결을 끊습니다.
    connection.destroy(); // 음성 채널에서 봇 퇴장

    const recordingsDir = "./recordings";
    const files = fs
      .readdirSync(recordingsDir)
      .filter((f) => f.endsWith(".pcm"));

    if (files.length === 0) return message.reply("기록된 음성이 없습니다.");

    message.reply(
      "🔄 음성 조각들을 합치고 제미나이와 회의록을 작성 중입니다...",
    );

    const outputMedia = "./meeting_summary.mp3";

    // 1. 순수 PCM 데이터는 헤더가 없으므로 Node.js에서 직접 단순 병합(Byte Append)하는 것이 가장 안전합니다.
    const tempPcm = "./recordings/merged.pcm";
    const mergedWriteStream = fs.createWriteStream(tempPcm);

    // 조각난 PCM 파일들을 하나로 이어 붙입니다.
    for (const file of files) {
      const filePath = path.join(recordingsDir, file);
      const data = fs.readFileSync(filePath);
      mergedWriteStream.write(data);
      // 🔥 다음 회의 때 기록이 섞이지 않도록 처리된 조각 파일은 즉시 삭제합니다.
      fs.unlinkSync(filePath);
    }
    mergedWriteStream.end();

    mergedWriteStream.on("finish", () => {
      // 2. 병합된 거대한 PCM을 FFmpeg로 넘겨 용량을 20배 줄이는 MP3(64kbps)로 고효율 압축
      ffmpeg()
        .input(tempPcm)
        .inputOptions(["-f s16le", "-ar 48000", "-ac 2"])
        .outputOptions(["-f mp3", "-ar 16000", "-ac 1", "-b:a 64k"]) // 클라우드 업로드 속도를 위한 강력한 압축
        .output(outputMedia)
        .on("start", (commandLine) => {
          console.log("FFmpeg 변환 시작: " + commandLine);
        })
        .on("error", (err) => {
          console.error("FFmpeg 에러:", err.message);
          message.reply("❌ 오디오 포맷 변환 중 오류가 발생했습니다.");
        })
        .on("end", async () => {
          try {
            console.log(
              "오디오 변환(압축) 완료! 구글 File API 업로드 및 제미나이 요약 시작...",
            );
            const summary = await summarizeWithGemini(outputMedia);

            console.log("요약 결과:\n", summary);
            if (DATABASE_ID) {
              await recordToNotionDirect(summary);
            } else {
              console.log(
                "⚠️ .env에 BJ_NOTION_DATABASE_ID가 없어서 노션 기록을 생략합니다.",
              );
            }

            const replyText =
              summary.length > 1900
                ? summary.substring(0, 1900) + "..."
                : summary;
            message.reply(
              "✅ 제미나이 요약 및 클라우드 업로드가 완료되었습니다!\n\n" +
                replyText,
            );
          } catch (error) {
            console.error("요약 중 에러 발생:", error);
            message.reply("❌ 회의 요약 중 오류가 발생했습니다.");
          } finally {
            // 🔥 공간 확보 및 다음 회의 대비 임시 파일 완전 삭제
            if (fs.existsSync(tempPcm)) fs.unlinkSync(tempPcm);
            if (fs.existsSync(outputMedia)) fs.unlinkSync(outputMedia);
          }
        })
        .run();
    });
  }
});

// 저장용 폴더가 없으면 생성
if (!fs.existsSync("./recordings")) fs.mkdirSync("./recordings");

client.login(process.env.DISCORD_TOKEN);

async function summarizeWithGemini(filePath) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  console.log("구글 클라우드에 MP3 파일 업로드 중...");
  // 1. 거대한 오디오 파일을 직접 구글 파일 스토리지 서버(File API)로 안전하게 업로드
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType: "audio/mp3",
    displayName: "회의 녹음 파일",
  });
  console.log("업로드 완료 URI:", uploadResult.file.uri);

  // 2. 업로드된 파일 주소(URI)를 사용하여 텍스트 요약 요청 (메모리 부족 에러 방지)
  const meetingPrompt = `
이 음성 파일은 IT 개발팀의 회의 내용이야. 

[요약 지침]
1. 회의의 핵심 주제를 한 줄로 요약해줘.
2. 논의된 결정 사항들을 불렛 포인트로 정리해줘.
3. 이신지, 송수빈, 이은석, 김영철 등 언급된 담당자별로 직무와 할 일을 표 형태로 정리해줘.
4. 전체적인 특이사항이 있다면 마지막에 짧게 적어줘.

[필터링 규칙]
5. 안부 인사, 농담, 식사 메뉴 결정 등 사적인 대화는 요약에서 완전히 제외해줘. 
- 단, 사담 과정에서 나온 업무 아이디어나 진행 상황은 놓치지 마.
6. 오직 '북잡' 서비스 개발, 운영, 업무 일정과 관련된 핵심 정보만 추출해줘.
7. 회의 전체가 사적인 대화뿐이라면 '업무 관련 논의 사항 없음'이라고 짧게 기록해줘.

[출력 언어]
8. 모든 내용은 한국어로 작성해줘.
`;

  const result = await model.generateContent([
    meetingPrompt,
    {
      fileData: {
        fileUri: uploadResult.file.uri,
        mimeType: uploadResult.file.mimeType,
      },
    },
  ]);

  // 3. 분석이 끝났으므로 보안 및 계정 용량 관리를 위해 원격 데이터 삭제
  try {
    await fileManager.deleteFile(uploadResult.file.name);
    console.log("클라우드 원격 파일 정상 삭제됨");
  } catch (deleteError) {
    console.error("파일 삭제 에러 (무시 가능):", deleteError.message);
  }

  return result.response.text();
}

async function recordToNotionDirect(summaryText) {
  try {
    // 노션은 한 블록에 텍스트 길이 제한(2000자)이 있으므로 안전하게 자릅니다.
    const safeText =
      summaryText.length > 2000
        ? summaryText.substring(0, 2000) + "\n\n(내용이 너무 길어 일부 생략됨)"
        : summaryText;

    const response = await notion.pages.create({
      // <- 이부분 중요 개인의 노션 데이터베이스 맞게 수정해야함
      parent: { database_id: DATABASE_ID },
      properties: {
        // 1. "Meeting name" 컬럼 (텍스트)
        "Meeting name": {
          title: [
            { text: { content: `${new Date().toLocaleDateString()} 회의록` } },
          ],
        },
        // 2. "회의 진행일" 컬럼 (날짜)
        "회의 진행일": {
          date: { start: new Date().toISOString().split("T")[0] },
        },
        // 3. "Category" 컬럼 (선택 - '전체 회의'로 고정)
        Category: {
          multi_select: [{ name: "전체 회의" }],
        },
        // Attendees(참석자)는 나중에 멤버 ID를 매핑해서 자동화할 수 있습니다!
      },
      children: [
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: "🤖 AI 요약본" } }],
          },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: safeText } }],
          },
        },
      ],
    });
    console.log("북잡 회의록 업데이트 완료!");
  } catch (error) {
    console.error("노션 전송 실패:", error.body ? error.body : error);
  }
}
