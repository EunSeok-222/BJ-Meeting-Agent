const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPrompt,
  parseClaudeOutput,
  isAuthError,
  ClaudeAuthError,
} = require("../src/services/claude.service");

test("buildPrompt", async (t) => {
  await t.test("참석자·전사본·표 지시 포함", () => {
    const p = buildPrompt("[이은석] 배포했어요", ["이은석", "송수빈"]);
    assert.match(p, /이은석, 송수빈/);
    assert.match(p, /\[이은석\] 배포했어요/);
    assert.match(p, /표/);
  });
  await t.test("참석자 없으면 '알 수 없음'", () => {
    assert.match(buildPrompt("x", []), /알 수 없음/);
  });
});

test("isAuthError", () => {
  assert.equal(isAuthError("Invalid API key provided"), true);
  assert.equal(isAuthError("Please run /login to authenticate"), true);
  assert.equal(isAuthError("credit balance is too low"), true);
  assert.equal(isAuthError("정상적으로 요약했습니다"), false);
  assert.equal(isAuthError(""), false);
  assert.equal(isAuthError(null), false);
});

test("parseClaudeOutput", async (t) => {
  await t.test("정상 응답 → result trim", () => {
    assert.equal(parseClaudeOutput('{"is_error":false,"result":"  요약본  "}'), "요약본");
  });
  await t.test("result 없으면 빈 문자열", () => {
    assert.equal(parseClaudeOutput('{"is_error":false}'), "");
  });
  await t.test("is_error(일반) → Error", () => {
    assert.throws(() => parseClaudeOutput('{"is_error":true,"result":"something broke"}'), /오류 응답/);
  });
  await t.test("is_error(인증) → ClaudeAuthError", () => {
    assert.throws(
      () => parseClaudeOutput('{"is_error":true,"result":"Invalid API key"}'),
      (e) => e instanceof ClaudeAuthError,
    );
  });
  await t.test("JSON 아님 → 파싱 실패 Error", () => {
    assert.throws(() => parseClaudeOutput("not json at all"), /파싱 실패/);
  });
});
