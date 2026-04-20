const { SlashCommandBuilder, REST, Routes } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("회의시작")
    .setDescription("음성 채널에서 회의 기록을 시작합니다."),
  new SlashCommandBuilder()
    .setName("회의종료")
    .setDescription("회의를 종료하고 AI 요약본을 생성하여 노션에 저장합니다."),
  new SlashCommandBuilder()
    .setName("노션재전송")
    .setDescription("마지막으로 생성된 요약본을 노션으로 다시 전송합니다."),
  new SlashCommandBuilder()
    .setName("노션저장")
    .setDescription("입력한 내용을 노션 회의록에 저장합니다.")
    .addStringOption(option =>
      option.setName("내용")
        .setDescription("노션에 저장할 내용")
        .setRequired(true)
    ),
].map(command => command.toJSON());

async function registerCommands(token, clientId) {
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("슬래시 커맨드 등록 시작...");
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("슬래시 커맨드 등록 성공!");
  } catch (error) {
    console.error("슬래시 커맨드 등록 중 오류 발생:", error);
  }
}

module.exports = { commands, registerCommands };
