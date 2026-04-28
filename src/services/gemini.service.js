const { genAI, fileManager } = require("../config/clients");

async function summarizeWithGemini(filePath, participants) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  console.log("구글 클라우드에 MP3 파일 업로드 중...");
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType: "audio/mp3",
    displayName: "회의 녹음 파일",
  });
  console.log("업로드 완료 URI:", uploadResult.file.uri);

  const participantsStr =
    participants.length > 0 ? participants.join(", ") : "알 수 없음";

  const meetingPrompt = `
이 음성 파일은 IT 개발팀의 회의 내용이야. 

[회의 참여자]
${participantsStr}

[요약 지침]
1. 회의의 핵심 주제를 한 줄로 요약해줘.
2. 논의된 결정 사항들을 불렛 포인트로 정리해줘.
3. 실제로 회의에 참석하여 발언한 사람들을 대상으로 담당자별 직무와 할 일을 정리해줘. 발언하지 않은 사람은 '미참석'으로 간주하여 표에서 완전히 제외해줘.
4. 전체적인 특이사항이 있다면 마지막에 짧게 적어줘.

[필터링 규칙]
5. 안부 인사, 농담, 식사 메뉴 결정 등 사적인 대화는 요약에서 완전히 제외해줘. 
- 단, 사담 과정에서 나온 업무 아이디어나 진행 상황은 놓치지 마.
6. 오직 서비스 개발, 운영, 업무 일정과 관련된 핵심 정보만 추출해줘.
7. 회의 전체가 사적인 대화뿐이거나 발언자가 없다면 '업무 관련 논의 사항 없음'이라고 짧게 기록해줘.

[출력 언어]
8. 모든 내용은 한국어로 작성해줘.
`;

  let result;
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      result = await model.generateContent([
        meetingPrompt,
        {
          fileData: {
            fileUri: uploadResult.file.uri,
            mimeType: uploadResult.file.mimeType,
          },
        },
      ]);
      break; // 성공 시 루프 탈출
    } catch (error) {
      attempts++;
      console.error(
        `제미나이 요약 시도 ${attempts}/${maxAttempts} 실패:`,
        error.message,
      );

      if (attempts >= maxAttempts) throw error; // 마지막 시도도 실패하면 에러 던짐

      const delay = Math.pow(2, attempts) * 1000; // 2s, 4s... 지수 백오프
      console.log(`${delay / 1000}초 후 다시 시도합니다...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  try {
    await fileManager.deleteFile(uploadResult.file.name);
    console.log("클라우드 원격 파일 정상 삭제됨");
  } catch (deleteError) {
    console.error("파일 삭제 에러 (무시 가능):", deleteError.message);
  }

  return result.response.text();
}

module.exports = {
  summarizeWithGemini,
};
