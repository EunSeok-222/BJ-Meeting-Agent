require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const { handleInteraction } = require("./src/handlers/interaction.handler");
const { registerCommands } = require("./src/config/commands");
const { armSafetyTimer } = require("./src/lifecycle");
const { processMeeting, pendingRecordings } = require("./src/services/pipeline");
const state = require("./src/state");

// @discordjs/voice 0.19+ 는 Node 22.12+ 를 권장한다. 낮으면 음성 수신이 불안정할 수 있음.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.warn(
    `⚠️ Node ${process.versions.node} 사용 중 — @discordjs/voice 는 Node 22.12+ 권장입니다. ` +
      `음성 수신이 불안정하면 Node를 올려주세요.`,
  );
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("clientReady", async () => {
  console.log(`성공! ${client.user.tag} 에이전트가 온라인입니다.`);

  const guildIds = client.guilds.cache.map((guild) => guild.id);
  await registerCommands(process.env.DISCORD_TOKEN, client.user.id, guildIds);

  armSafetyTimer();
});

client.on("interactionCreate", handleInteraction);

if (!fs.existsSync("./recordings")) fs.mkdirSync("./recordings");

// Ctrl+C / kill 로 종료해도, 처리 안 한 회의가 있으면 정리(전사→요약→노션)한 뒤 종료한다.
// (콘솔 창을 X로 닫는 경우는 OS가 즉시 죽여서 이 훅이 못 돌 수 있음 — 그때는 scripts/recover.js)
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) {
    console.log("한 번 더 눌러 강제 종료합니다.");
    process.exit(1);
  }
  shuttingDown = true;

  if (!state.isRecording && pendingRecordings().length === 0) {
    console.log(`${signal} — 처리할 회의가 없어 종료합니다.`);
    process.exit(0);
  }

  console.log(`${signal} — 회의 정리 후 종료합니다. (한 번 더 누르면 강제 종료)`);
  state.isRecording = false;
  for (const [, streams] of state.activeStreams) {
    try {
      streams.out.end();
    } catch (e) {}
  }
  state.activeStreams.clear();
  await new Promise((r) => setTimeout(r, 500));

  const notify = async (msg) => {
    try {
      if (!state.lastTextChannelId) return;
      const ch = await client.channels.fetch(state.lastTextChannelId);
      await ch?.send(msg);
    } catch (e) {}
  };

  const result = await processMeeting({
    guild: client.guilds.cache.first() || null,
    participants: Array.from(state.currentMeetingParticipants),
    onProgress: (t) => console.log("  " + t),
  });

  if (result.status === "done") {
    console.log("✅ 회의 정리 완료 — 노션에 업로드했습니다.");
    await notify("✅ (봇 종료) 회의 정리 완료 — 노션에 업로드했습니다.");
  } else if (result.status === "error") {
    console.error("❌ 정리 실패:", result.error && result.error.message);
    await notify(
      "❌ (봇 종료) 정리 실패. 전사본은 보존됨 — 다시 켜서 `/회의정리재시도` 하거나 `node scripts/recover.js` 로 복구하세요.",
    );
  } else {
    console.log("기록된 음성이 없습니다.");
  }
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

client.login(process.env.DISCORD_TOKEN);
