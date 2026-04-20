const fs = require("fs");
const prism = require("prism-media");
const {
  joinVoiceChannel,
  getVoiceConnection,
  EndBehaviorType,
} = require("@discordjs/voice");
const state = require("../state");
const { mergePcmFiles, convertToMp3 } = require("../services/audio.service");
const { summarizeWithGemini } = require("../services/gemini.service");
const { recordToNotionDirect } = require("../services/notion.service");
const { MessageFlags } = require("discord.js");

function cleanupUserStream(userId) {
  if (state.activeStreams.has(userId)) {
    const { out } = state.activeStreams.get(userId);
    try {
      out.end();
    } catch (e) {}
    state.activeStreams.delete(userId);
    console.log(`${userId}님의 오디오 스트림 정리 완료`);
  }
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // 1. 회의 시작
  if (commandName === "회의시작") {
    if (state.isRecording) {
      return interaction.reply({ content: "이미 회의 기록이 진행 중입니다!", flags: [MessageFlags.Ephemeral] });
    }

    const channel = interaction.member.voice.channel;
    if (!channel) return interaction.reply({ content: "먼저 음성 채널에 들어가 주세요!", flags: [MessageFlags.Ephemeral] });

    try {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      await interaction.reply("🎤 회의 기록 에이전트가 입장했습니다. 지금부터 목소리를 수집합니다.");
      state.isRecording = true;

      // 음성 상태 모니터링 (자동 종료 대응)
      connection.on("stateChange", (oldState, newState) => {
        if (newState.status === "disconnected") {
          state.isRecording = false;
          state.activeStreams.clear();
        }
      });

      connection.receiver.speaking.removeAllListeners("start");
      connection.receiver.speaking.on("start", async (userId) => {
        if (!state.isRecording) return;

        let displayName = state.userNames.get(userId);
        if (!displayName) {
          try {
            const member = await interaction.guild.members.fetch(userId);
            displayName = member.displayName;
            state.userNames.set(userId, displayName);
          } catch (e) {
            displayName = userId;
          }
        }

        state.currentMeetingParticipants.add(displayName);
        console.log(`${displayName}(${userId})님이 말하기 시작함`);

        if (state.activeStreams.has(userId)) return;

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

        audioStream.on("error", (err) => {
          console.error(`AudioStream Error (${userId}):`, err.message);
          cleanupUserStream(userId);
        });

        opusDecoder.on("error", (err) => {
          console.error(`OpusDecoder Error (${userId}):`, err.message);
          cleanupUserStream(userId);
        });

        out.on("error", (err) => {
          console.error(`FileStream Error (${userId}):`, err.message);
          cleanupUserStream(userId);
        });

        state.activeStreams.set(userId, { audioStream, opusDecoder, out });

        out.on("finish", () => {
          cleanupUserStream(userId);
        });

        audioStream.pipe(opusDecoder).pipe(out);
      });
    } catch (error) {
      console.error("회의 시작 중 에러:", error);
      interaction.reply({ content: "❌ 회의를 시작하는 중 오류가 발생했습니다.", flags: [MessageFlags.Ephemeral] });
    }
  }

  // 2. 회의 종료
  if (commandName === "회의종료") {
    const channel = interaction.member.voice.channel;
    if (!channel) return interaction.reply({ content: "먼저 음성 채널에 들어가 주세요!", flags: [MessageFlags.Ephemeral] });

    const connection = getVoiceConnection(interaction.guild.id);
    if (!connection) {
      return interaction.reply({ content: "현재 기록 중인 회의가 없습니다!", flags: [MessageFlags.Ephemeral] });
    }

    await interaction.deferReply();

    state.isRecording = false;
    for (const [userId, streams] of state.activeStreams) {
      try {
        streams.out.end();
      } catch (e) {
        console.error(`Stream end error (${userId}):`, e.message);
      }
    }
    state.activeStreams.clear();

    await new Promise((resolve) => setTimeout(resolve, 500));
    connection.destroy();

    const recordingsDir = "./recordings";
    const files = fs.readdirSync(recordingsDir).filter((f) => f.endsWith(".pcm"));

    if (files.length === 0) return interaction.editReply("기록된 음성이 없습니다.");

    await interaction.editReply("🔄 음성 조각들을 합치고 제미나이와 회의록을 작성 중입니다...");

    const participantsList = Array.from(state.currentMeetingParticipants);
    state.currentMeetingParticipants = new Set();

    const tempPcm = "./recordings/merged.pcm";
    const outputMedia = "./meeting_summary.mp3";

    try {
      await mergePcmFiles(files, recordingsDir, tempPcm);
      await convertToMp3(tempPcm, outputMedia);
      
      const summary = await summarizeWithGemini(outputMedia, participantsList);
      state.lastSummary = summary;

      await recordToNotionDirect(summary);

      const replyText = summary.length > 1900 ? summary.substring(0, 1900) + "..." : summary;
      await interaction.editReply("✅ 제미나이 요약 및 노션 전송이 완료되었습니다!\n\n" + replyText);
    } catch (error) {
      console.error("처리 중 에러 발생:", error);
      await interaction.editReply("❌ 회의 요약 중 오류가 발생했습니다.");
    } finally {
      if (fs.existsSync(tempPcm)) fs.unlinkSync(tempPcm);
      if (fs.existsSync(outputMedia)) fs.unlinkSync(outputMedia);
    }
  }

  // 3. 노션 재전송
  if (commandName === "노션재전송") {
    if (!state.lastSummary) return interaction.reply({ content: "재전송할 요약본이 없습니다.", flags: [MessageFlags.Ephemeral] });
    await interaction.reply("🔄 마지막 요약본을 노션으로 다시 전송합니다...");
    await recordToNotionDirect(state.lastSummary);
    await interaction.editReply("✅ 노션 전송이 완료되었습니다!");
  }

  // 4. 노션 저장
  if (commandName === "노션저장") {
    const content = interaction.options.getString("내용");
    await interaction.reply("🔄 입력하신 내용을 노션으로 전송합니다...");
    await recordToNotionDirect(content);
    await interaction.editReply("✅ 노션 전송이 완료되었습니다!");
  }
}

module.exports = {
  handleInteraction
};
