// node --test 는 파일별로 별도 프로세스에서 실행하므로, require 전에 env를 세팅한다.
process.env.DISCORD_NAME_MAPPING = JSON.stringify({ "301702495938543616": "김영철" });

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveDisplayName } = require("../src/services/transcribe.service");

test("resolveDisplayName — DISCORD_NAME_MAPPING 오버라이드가 최우선", async () => {
  // 디스코드 닉네임이 무엇이든 회의록에는 지정한 이름으로
  assert.equal(await resolveDisplayName("301702495938543616", null), "김영철");
  // 매핑에 없으면 (guild 없을 때) userId 그대로
  assert.equal(await resolveDisplayName("999999999999", null), "999999999999");
});
