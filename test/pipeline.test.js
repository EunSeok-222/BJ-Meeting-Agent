const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pendingRecordings } = require("../src/services/pipeline");

test("pendingRecordings — 트랙 파일명만 인정", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  try {
    fs.writeFileSync(path.join(dir, "123-1788955955982.pcm"), "");
    fs.writeFileSync(path.join(dir, "999-1.pcm"), "");
    fs.writeFileSync(path.join(dir, ".gitkeep"), "");
    fs.writeFileSync(path.join(dir, "merged.pcm"), "");
    fs.writeFileSync(path.join(dir, "123-1.wav"), "");

    const found = pendingRecordings(dir).sort();
    assert.deepEqual(found, ["123-1788955955982.pcm", "999-1.pcm"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pendingRecordings — 폴더가 없으면 빈 배열", () => {
  assert.deepEqual(pendingRecordings(path.join(os.tmpdir(), "nope-" + Date.now())), []);
});
