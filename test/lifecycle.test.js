const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveExitConfig } = require("../src/lifecycle");

test("resolveExitConfig", async (t) => {
  await t.test("기본값 (env 없음)", () => {
    assert.deepEqual(resolveExitConfig({}), {
      autoExitMs: 10 * 60 * 1000,
      safetyIdleMs: 3 * 60 * 60 * 1000,
    });
  });

  await t.test("명시적 0 은 비활성화(0 그대로 통과)", () => {
    const c = resolveExitConfig({ AUTO_EXIT_MINUTES: "0", SAFETY_IDLE_HOURS: "0" });
    assert.equal(c.autoExitMs, 0);
    assert.equal(c.safetyIdleMs, 0);
  });

  await t.test("사용자 지정 값", () => {
    const c = resolveExitConfig({ AUTO_EXIT_MINUTES: "5", SAFETY_IDLE_HOURS: "1" });
    assert.equal(c.autoExitMs, 5 * 60 * 1000);
    assert.equal(c.safetyIdleMs, 60 * 60 * 1000);
  });

  await t.test("잘못된 값은 기본값으로", () => {
    assert.equal(resolveExitConfig({ AUTO_EXIT_MINUTES: "abc" }).autoExitMs, 10 * 60 * 1000);
  });
});
