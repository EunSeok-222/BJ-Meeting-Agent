const fs = require("fs");
const prism = require("prism-media");
const {
  joinVoiceChannel,
  getVoiceConnection,
  EndBehaviorType,
} = require("@discordjs/voice");
const state = require("../state");
const { transcribeMeeting } = require("../services/transcribe.service");
const { summarizeWithClaude, ClaudeAuthError } = require("../services/claude.service");
const { recordToNotionDirect } = require("../services/notion.service");
const { scheduleAutoExit, cancelAutoExit, exitNow } = require("../lifecycle");
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

// 진행 상황 메시지를 너무 자주 편집하지 않도록 최소 간격을 둔다.
function makeProgressReporter(interaction) {
  let last = "";
  let lastAt = 0;
  return (text) => {
    const now = Date.now();
    if (text === last) return;
    if (now - lastAt < 1200) return;
    last = text;
    lastAt = now;
    interaction.editReply(text).catch(() => {});
  };
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // 0. 봇 종료
  if (commandName === "봇종료") {
    await interaction.reply("👋 봇을 종료합니다. 다시 쓰려면 바탕화면 아이콘을 더블클릭하세요.");
    setTimeout(() => exitNow("사용자 요청(/봇종료)"), 800);
    return;
  }

  // 1. 회의 시작
  if (commandName === "회의시작") {
    if (state.isRecording) {
      return interaction.reply({ content: "이미 회의 기록이 진행 중입니다!", flags: [MessageFlags.Ephemeral] });
    }

    const channel = interaction.member.voice.channel;
    if (!channel) return interaction.reply({ content: "먼저 음성 채널에 들어가 주세요!", flags: [MessageFlags.Ephemeral] });

    if (state.lastFailedMeeting) {
      return interaction.reply({
        content: "⚠️ 이전 회의 요약 실패 데이터가 남아있습니다.\n`/회의정리재시도`로 완료하거나, `/노션저장` 등으로 정리한 후 새 회의를 시작해 주세요.",
        flags: [MessageFlags.Ephemeral]
      });
    }

    try {
      cancelAutoExit(); // 자동 종료 예약이 걸려 있었다면 취소

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      await interaction.reply("🎤 회의 기록 에이전트가 입장했습니다. 지금부터 목소리를 수집합니다.");
      state.isRecording = true;

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
        out.on("finish", () => cleanupUserStream(userId));
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
    const files = fs.readdirSync(recordingsDir).filter((f) => /^\d+-\d+\.pcm$/.test(f));

    if (files.length === 0) {
      scheduleAutoExit();
      return interaction.editReply("기록된 음성이 없습니다.");
    }

    await interaction.editReply("🔄 회의 기록을 처리합니다...");

    const participantsList = Array.from(state.currentMeetingParticipants);
    state.currentMeetingParticipants = new Set();
    const report = makeProgressReporter(interaction);

    try {
      const { transcript, participants: spokenParticipants, speakers } = await transcribeMeeting(
        files,
        recordingsDir,
        interaction.guild,
        report,
      );
      state.lastTranscript = transcript;
      state.lastSpeakers = speakers;

      if (!transcript.trim()) {
        state.lastFailedMeeting = null;
        return interaction.editReply("전사 결과가 비어 있습니다. 음성이 제대로 녹음되지 않았을 수 있어요.");
      }

      const participantsForSummary = participantsList.length > 0 ? participantsList : spokenParticipants;

      await interaction.editReply("🤖 AI가 회의록을 작성 중입니다...").catch(() => {});
      const summary = await summarizeWithClaude(transcript, participantsForSummary);
      state.lastSummary = summary;
      state.lastParticipants = participantsForSummary;

      await interaction.editReply("📤 노션에 업로드 중입니다...").catch(() => {});
      await recordToNotionDirect(summary, participantsForSummary, { speakers });

      const replyText = summary.length > 1900 ? summary.substring(0, 1900) + "..." : summary;
      await interaction.editReply("✅ AI 요약 및 노션 전송이 완료되었습니다!\n\n" + replyText);

      state.lastFailedMeeting = null;
    } catch (error) {
      console.error("처리 중 에러 발생:", error);
      state.lastFailedMeeting = {
        transcript: state.lastTranscript || "",
        participants: participantsList,
        speakers: state.lastSpeakers || [],
      };
      const hint =
        error instanceof ClaudeAuthError
          ? "\n> " + error.message
          : "\n`/회의정리재시도` 커맨드로 나중에 다시 시도할 수 있습니다.";
      await interaction.editReply("❌ 회의 요약/전송 중 오류가 발생했습니다." + hint);
    } finally {
      scheduleAutoExit();
    }
  }

  // 3. 회의 정리 재시도
  if (commandName === "회의정리재시도") {
    if (!state.lastFailedMeeting) {
      return interaction.reply({ content: "재시도할 실패 내역이 없습니다.", flags: [MessageFlags.Ephemeral] });
    }

    await interaction.deferReply();
    const { transcript, participants, speakers } = state.lastFailedMeeting;

    if (!transcript || !transcript.trim()) {
      state.lastFailedMeeting = null;
      return interaction.editReply("❌ 보존된 전사본이 없어 재시도할 수 없습니다. 다시 녹음이 필요합니다.");
    }

    try {
      await interaction.editReply("🔄 보존된 전사본으로 다시 요약 및 노션 전송을 시도합니다...");

      const summary = await summarizeWithClaude(transcript, participants);
      state.lastSummary = summary;
      state.lastParticipants = participants;
      state.lastSpeakers = speakers || [];
      await recordToNotionDirect(summary, participants, { speakers: speakers || [] });

      const replyText = summary.length > 1900 ? summary.substring(0, 1900) + "..." : summary;
      await interaction.editReply("✅ 재시도 성공! 요약 및 노션 전송이 완료되었습니다.\n\n" + replyText);

      state.lastFailedMeeting = null;
    } catch (error) {
      console.error("재시도 중 에러 발생:", error);
      const hint =
        error instanceof ClaudeAuthError
          ? "\n> " + error.message
          : "\nclaude CLI 상태(로그인/네트워크)를 확인해 주세요.";
      await interaction.editReply("❌ 여전히 오류가 발생합니다." + hint);
    } finally {
      scheduleAutoExit();
    }
  }

  // 4. 노션 재전송
  if (commandName === "노션재전송") {
    if (!state.lastSummary) return interaction.reply({ content: "재전송할 요약본이 없습니다.", flags: [MessageFlags.Ephemeral] });
    await interaction.reply("🔄 마지막 요약본을 노션으로 다시 전송합니다...");
    try {
      await recordToNotionDirect(state.lastSummary, state.lastParticipants, {
        speakers: state.lastSpeakers || [],
      });
      await interaction.editReply("✅ 노션 전송이 완료되었습니다!");
    } catch (error) {
      await interaction.editReply("❌ 노션 전송에 실패했습니다. 봇 콘솔 로그를 확인해 주세요.");
    }
  }

  // 5. 노션 저장
  if (commandName === "노션저장") {
    const content = interaction.options.getString("내용");
    await interaction.reply("🔄 입력하신 내용을 노션으로 전송합니다...");
    try {
      await recordToNotionDirect(content);
      await interaction.editReply("✅ 노션 전송이 완료되었습니다!");
    } catch (error) {
      await interaction.editReply("❌ 노션 전송에 실패했습니다. 봇 콘솔 로그를 확인해 주세요.");
    }
  }
}

module.exports = {
  handleInteraction
};
