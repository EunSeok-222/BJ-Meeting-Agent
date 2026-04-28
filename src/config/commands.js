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
  new SlashCommandBuilder()
    .setName("회의정리재시도")
    .setDescription("실패했던 회의 음성 파일을 다시 요약하여 노션에 업로드합니다."),
].map(command => command.toJSON());

async function registerCommands(token, clientId, guildIds = []) {
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("슬래시 커맨드 등록 시작...");
    
    // 중복 제거를 위해 글로벌 커맨드 삭제 (빈 배열 전달)
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log("기존 글로벌 커맨드 정리 완료.");
    
    // 길드 커맨드 등록 (즉시 반영 및 중복 방지)
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log(`길드(${guildId}) 커맨드 등록 성공!`);
    }
    
    console.log("슬래시 커맨드 등록 성공!");
  } catch (error) {
    console.error("슬래시 커맨드 등록 중 오류 발생:", error);
  }
}

module.exports = { commands, registerCommands };
