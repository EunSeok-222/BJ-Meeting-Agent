const fs = require("fs");
const prism = require("prism-media");
const {
  joinVoiceChannel,
  getVoiceConnection,
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const state = require("../state");
const { resolveDisplayName } = require("../services/transcribe.service");
const { summarizeWithClaude, ClaudeAuthError } = require("../services/claude.service");
const { recordToNotionDirect } = require("../services/notion.service");
const { processMeeting, pendingRecordings } = require("../services/pipeline");
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

// 녹음 스트림을 모두 닫는다. (회의종료 / 봇종료 공용)
function stopRecordingStreams() {
  state.isRecording = false;
  for (const [userId, streams] of state.activeStreams) {
    try {
      streams.out.end();
    } catch (e) {
      console.error(`Stream end error (${userId}):`, e.message);
    }
  }
  state.activeStreams.clear();
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

// 처리가 15분을 넘기면 상호작용 토큰이 만료돼 editReply가 실패한다.
// 그 경우 채널에 일반 메시지로 최종 결과를 남긴다.
async function sendFinal(interaction, text) {
  try {
    await interaction.editReply(text);
  } catch (e) {
    try {
      await interaction.channel.send(text);
    } catch (e2) {
      console.error("최종 결과 메시지 전송 실패:", e2.message);
    }
  }
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // 0. 봇 종료 — 처리 안 한 회의가 있으면 정리(전사→요약→노션)한 뒤 종료한다.
  if (commandName === "봇종료") {
    state.lastTextChannelId = interaction.channelId;
    const connection = getVoiceConnection(interaction.guildId);
    const pending = pendingRecordings();

    if (!state.isRecording && pending.length === 0) {
      await interaction.reply("👋 처리할 회의가 없어 바로 종료합니다.");
      setTimeout(() => exitNow("사용자 요청(/봇종료)"), 600);
      return;
    }

    await interaction.reply("🔚 `/회의종료`를 안 하셨네요 — 지금까지 기록분을 정리하고 종료합니다...");
    if (connection) {
      stopRecordingStreams();
      await new Promise((r) => setTimeout(r, 500));
      try {
        connection.destroy();
      } catch (e) {}
    } else {
      stopRecordingStreams();
    }

    const participantsList = Array.from(state.currentMeetingParticipants);
    state.currentMeetingParticipants = new Set();
    const report = makeProgressReporter(interaction);
    const result = await processMeeting({
      guild: interaction.guild,
      participants: participantsList,
      onProgress: report,
    });

    if (result.status === "done") {
      await sendFinal(interaction, "✅ 정리 완료 — 노션에 업로드했습니다. 봇을 종료합니다.");
    } else if (result.status === "error") {
      await sendFinal(
        interaction,
        "❌ 정리 중 오류가 발생했습니다. 전사본은 보존됐으니 다시 켜서 `/회의정리재시도` 하거나 `node scripts/recover.js` 로 복구하세요. 봇을 종료합니다.",
      );
    } else {
      await sendFinal(interaction, "기록된 음성이 없어 그대로 종료합니다.");
    }
    setTimeout(() => exitNow("사용자 요청(/봇종료) — 정리 후"), 600);
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

      // 음성 연결이 잠깐 끊기거나 채널을 옮긴 경우는 복구를 시도하고,
      // 진짜 끊긴 경우에만 기록을 중단한다. (긴 회의 중 순간 끊김으로 전체 손실 방지)
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
          console.log("음성 연결 재수립 중 — 기록을 계속합니다.");
        } catch (e) {
          console.error("음성 연결이 끊겨 회의 기록을 중단합니다.");
          state.isRecording = false;
          state.activeStreams.clear();
          try {
            connection.destroy();
          } catch (err) {}
          interaction.channel
            ?.send("⚠️ 음성 연결이 끊겨 기록이 중단됐습니다. `/회의종료`로 지금까지 기록분을 정리하세요.")
            .catch(() => {});
        }
      });

      connection.receiver.speaking.removeAllListeners("start");
      connection.receiver.speaking.on("start", async (userId) => {
        if (!state.isRecording) return;

        const displayName = await resolveDisplayName(userId, interaction.guild);
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
    state.lastTextChannelId = interaction.channelId;

    stopRecordingStreams();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      connection.destroy();
    } catch (e) {}

    if (pendingRecordings().length === 0) {
      scheduleAutoExit();
      return interaction.editReply("기록된 음성이 없습니다.");
    }

    await interaction.editReply("🔄 회의 기록을 처리합니다...");

    const participantsList = Array.from(state.currentMeetingParticipants);
    state.currentMeetingParticipants = new Set();
    const report = makeProgressReporter(interaction);

    try {
      const result = await processMeeting({
        guild: interaction.guild,
        participants: participantsList,
        onProgress: report,
      });

      if (result.status === "empty") {
        await sendFinal(interaction, "전사 결과가 비어 있습니다. 음성이 제대로 녹음되지 않았을 수 있어요.");
      } else if (result.status === "error") {
        const err = result.error;
        const hint =
          err instanceof ClaudeAuthError
            ? "\n> " + err.message
            : result.transcript
              ? "\n`/회의정리재시도` 커맨드로 다시 시도할 수 있습니다. (전사본은 보존됨)"
              : "\n전사 단계에서 실패해 전사본이 없습니다. 봇 콘솔 로그를 확인하세요.";
        console.error("처리 중 에러 발생:", err);
        await sendFinal(interaction, "❌ 회의 요약/전송 중 오류가 발생했습니다." + hint);
      } else {
        const warnNote =
          result.warnings.length > 0 ? `\n\n⚠️ 일부 트랙 처리 경고:\n- ${result.warnings.join("\n- ")}` : "";
        const s = result.summary;
        const replyText = s.length > 1900 ? s.substring(0, 1900) + "..." : s;
        await sendFinal(interaction, "✅ AI 요약 및 노션 전송이 완료되었습니다!" + warnNote + "\n\n" + replyText);
      }
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
      await sendFinal(interaction, "✅ 재시도 성공! 요약 및 노션 전송이 완료되었습니다.\n\n" + replyText);

      state.lastFailedMeeting = null;
    } catch (error) {
      console.error("재시도 중 에러 발생:", error);
      const hint =
        error instanceof ClaudeAuthError
          ? "\n> " + error.message
          : "\nclaude CLI 상태(로그인/네트워크)를 확인해 주세요.";
      await sendFinal(interaction, "❌ 여전히 오류가 발생합니다." + hint);
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
