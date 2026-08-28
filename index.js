require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const { handleInteraction } = require("./src/handlers/interaction.handler");
const { registerCommands } = require("./src/config/commands");
const { armSafetyTimer } = require("./src/lifecycle");

// @discordjs/voice 0.19+ 는 Node 22.12+ 를 권장한다. 낮으면 음성 수신이 불안정할 수 있음.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.warn(
    `⚠️ Node ${process.versions.node} 사용 중 — @discordjs/voice 는 Node 22.12+ 권장입니다. ` +
      `음성 수신이 불안정하면 Node를 올려주세요.`,
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// 봇이 준비되었을 때 실행
client.once("clientReady", async () => {
  console.log(`성공! ${client.user.tag} 에이전트가 온라인입니다.`);

  // 슬래시 커맨드 등록 (글로벌 + 현재 접속된 모든 길드에 즉시 등록)
  const guildIds = client.guilds.cache.map(guild => guild.id);
  await registerCommands(process.env.DISCORD_TOKEN, client.user.id, guildIds);

  // 유휴 상태가 오래 지속되면 자동 종료 (종료 깜빡임 대비 안전장치)
  armSafetyTimer();
});

// 슬래시 커맨드 수신 시 핸들러 호출
client.on("interactionCreate", handleInteraction);

// 저장용 폴더가 없으면 생성
if (!fs.existsSync("./recordings")) fs.mkdirSync("./recordings");

client.login(process.env.DISCORD_TOKEN);
