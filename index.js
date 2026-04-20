require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const { handleMessage } = require("./src/handlers/message.handler");
const { handleInteraction } = require("./src/handlers/interaction.handler");
const { registerCommands } = require("./src/config/commands");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// 봇이 준비되었을 때 실행
client.once("clientReady", async () => {
  console.log(`성공! ${client.user.tag} 에이전트가 온라인입니다.`);
  
  // 슬래시 커맨드 등록
  await registerCommands(process.env.DISCORD_TOKEN, client.user.id);
});

// 메시지 수신 시 핸들러 호출 (기존 방식 유지)
client.on("messageCreate", handleMessage);

// 슬래시 커맨드 수신 시 핸들러 호출
client.on("interactionCreate", handleInteraction);

// 저장용 폴더가 없으면 생성
if (!fs.existsSync("./recordings")) fs.mkdirSync("./recordings");

client.login(process.env.DISCORD_TOKEN);
