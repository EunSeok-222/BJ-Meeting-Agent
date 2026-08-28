const { execFile } = require("child_process");

// 기본은 PATH의 `claude`. 문제가 있으면 .env에 CLAUDE_BIN으로 절대경로 지정.
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
// 긴 회의 전사본(수만 토큰) 요약은 3분을 넘길 수 있어 기본 10분.
const CLAUDE_TIMEOUT_MS = (Number(process.env.CLAUDE_TIMEOUT_MIN) || 10) * 60 * 1000;

// 인증/로그인/크레딧 문제로 보이는 메시지 패턴 (재시도해도 소용없음)
const AUTH_ERROR_RE =
  /(invalid api key|api[_ ]?key|not authenticated|please run .*login|\/login|unauthorized|401|credit balance|insufficient|quota)/i;

class ClaudeAuthError extends Error {}

function isAuthError(text) {
  return AUTH_ERROR_RE.test(String(text || ""));
}

function buildPrompt(transcript, participants) {
  const participantsStr = participants.length > 0 ? participants.join(", ") : "알 수 없음";

  return `다음은 IT 개발팀 회의의 전사본(녹취록)이야. 각 줄은 "[화자] 발화" 형식이고, 화자 이름은 디스코드에서 확인된 실제 참여자야.

[회의 참여자]
${participantsStr}

[전사본]
${transcript}

[요약 지침]
1. 회의의 핵심 주제를 한 줄로 요약해줘.
2. 논의된 결정 사항들을 불렛 포인트로 정리해줘.
3. 실제로 발언한 사람들을 대상으로 담당자별 직무와 할 일을 마크다운 표로 정리해줘. 표의 열은 "담당자 | 직무 | 할 일" 세 개로 하고, 발언 기록이 없는 사람은 표에서 완전히 제외해줘.
4. 전체적인 특이사항이 있다면 마지막에 짧게 적어줘.

[필터링 규칙]
5. 안부 인사, 농담, 식사 메뉴 결정 등 사적인 대화는 요약에서 완전히 제외해줘.
- 단, 사담 과정에서 나온 업무 아이디어나 진행 상황은 놓치지 마.
6. 오직 서비스 개발, 운영, 업무 일정과 관련된 핵심 정보만 추출해줘.
7. 회의 전체가 사적인 대화뿐이거나 발언 내용이 없다면 '업무 관련 논의 사항 없음'이라고 짧게 기록해줘.

[출력 형식]
8. 모든 내용은 한국어로 작성해줘.
9. 마크다운으로 작성해줘. 제목은 "## ", 목록은 "- ", 강조는 "**굵게**", 담당자별 할 일은 표(| ... | ... |) 문법을 사용해.
10. 요약 본문만 출력하고, 인사말이나 "요약해 드리겠습니다" 같은 메타 설명은 붙이지 마.`;
}

/**
 * claude CLI의 --output-format json stdout을 파싱해 요약 텍스트를 반환한다.
 * is_error / 인증 오류를 구분해 던진다. (순수 함수 — 테스트 대상)
 */
function parseClaudeOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error("claude CLI 응답 파싱 실패: " + String(stdout).slice(0, 500));
  }
  if (parsed.is_error) {
    const msg = parsed.result || JSON.stringify(parsed);
    if (isAuthError(msg)) {
      throw new ClaudeAuthError(
        "claude CLI 인증/크레딧 문제로 보입니다. 터미널에서 `claude` 로그인/사용량을 확인하세요.\n" + msg,
      );
    }
    throw new Error("claude CLI 오류 응답: " + msg);
  }
  return (parsed.result || "").trim();
}

function runClaudeOnce(prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_BIN,
      ["-p", "--output-format", "json"],
      {
        maxBuffer: 20 * 1024 * 1024,
        timeout: CLAUDE_TIMEOUT_MS,
        shell: process.platform === "win32", // Windows의 claude.cmd 실행 대응
      },
      (err, stdout, stderr) => {
        if (err) {
          const blob = `${stderr || ""}\n${stdout || ""}`;
          if (isAuthError(blob)) {
            return reject(
              new ClaudeAuthError(
                "claude CLI 인증 문제로 보입니다. 터미널에서 `claude` 를 실행해 로그인 상태를 확인하세요.",
              ),
            );
          }
          return reject(new Error(`claude CLI 실행 실패: ${stderr || err.message}`));
        }
        try {
          resolve(parseClaudeOutput(stdout));
        } catch (e) {
          reject(e);
        }
      },
    );

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * 전사본을 Claude(claude CLI)로 요약한다. 지수 백오프로 최대 3회 재시도.
 * 인증 문제는 재시도하지 않고 즉시 던진다.
 * @returns {Promise<string>} 마크다운 요약 텍스트
 */
async function summarizeWithClaude(transcript, participants = []) {
  const prompt = buildPrompt(transcript, participants);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const out = await runClaudeOnce(prompt);
      if (!out) throw new Error("빈 응답을 받았습니다.");
      return out;
    } catch (error) {
      if (error instanceof ClaudeAuthError) {
        console.error("Claude 인증 오류:", error.message);
        throw error;
      }
      console.error(`Claude 요약 시도 ${attempt}/${maxAttempts} 실패:`, error.message);
      if (attempt >= maxAttempts) throw error;

      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s
      console.log(`${delay / 1000}초 후 다시 시도합니다...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = {
  summarizeWithClaude,
  ClaudeAuthError,
  // 순수 함수 (테스트용)
  buildPrompt,
  parseClaudeOutput,
  isAuthError,
};
