const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseTrackFilename,
  buildBurstOffsets,
  segmentToWallClockMs,
  mergeSpeakerSegments,
  PCM_BYTES_PER_SEC,
} = require("../src/services/transcribe.service");

test("parseTrackFilename", async (t) => {
  await t.test("정상 파일명", () => {
    assert.deepEqual(parseTrackFilename("123456789-1787930508414.pcm"), {
      userId: "123456789",
      epoch: 1787930508414,
    });
  });
  await t.test("비정상 파일명은 null", () => {
    assert.equal(parseTrackFilename("merged.pcm"), null);
    assert.equal(parseTrackFilename("123.merged.wav"), null);
    assert.equal(parseTrackFilename("abc-123.pcm"), null);
    assert.equal(parseTrackFilename("123-456.txt"), null);
  });
});

test("buildBurstOffsets — 조각별 시간 구간 계산", () => {
  const offsets = buildBurstOffsets([
    { epoch: 1000, byteLen: PCM_BYTES_PER_SEC }, // 1.0s
    { epoch: 100000, byteLen: PCM_BYTES_PER_SEC / 2 }, // 0.5s
  ]);
  assert.deepEqual(offsets, [
    { epoch: 1000, trackStart: 0, trackEnd: 1 },
    { epoch: 100000, trackStart: 1, trackEnd: 1.5 },
  ]);
});

test("segmentToWallClockMs — 조각 사이 실제 침묵이 epoch로 보존됨", () => {
  const offsets = buildBurstOffsets([
    { epoch: 1000, byteLen: PCM_BYTES_PER_SEC },
    { epoch: 100000, byteLen: PCM_BYTES_PER_SEC / 2 },
  ]);
  // 첫 조각 내부 0.5s 지점
  assert.equal(segmentToWallClockMs(0.5, offsets), 1500);
  // 둘째 조각 내부 0.2s 지점 → 트랙상 1.2s 지만 실제로는 epoch 100000 기준
  assert.equal(segmentToWallClockMs(1.2, offsets), 100200);
  // 트랙 길이를 넘어가면 마지막 조각 끝으로 클램프
  assert.equal(segmentToWallClockMs(9, offsets), 100500);
  // 오프셋이 없으면 0
  assert.equal(segmentToWallClockMs(3, []), 0);
});

test("mergeSpeakerSegments — 시간순 정렬·전사본·화자 목록", () => {
  const { transcript, participants, speakers } = mergeSpeakerSegments([
    { at: 300, name: "송수빈", userId: "u2", text: "지역 UI 끝났어요" },
    { at: 100, name: "이은석", userId: "u1", text: "검색 API 배포했어요" },
    { at: 200, name: "이은석", userId: "u1", text: "  " }, // 빈 텍스트는 제외
    { at: 250, name: "송수빈", userId: "u2", text: "" },
  ]);
  assert.equal(transcript, "[이은석] 검색 API 배포했어요\n[송수빈] 지역 UI 끝났어요");
  assert.deepEqual(participants, ["이은석", "송수빈"]);
  assert.deepEqual(speakers, [
    { userId: "u1", name: "이은석" },
    { userId: "u2", name: "송수빈" },
  ]);
});

test("mergeSpeakerSegments — 같은 userId는 speakers에서 한 번만", () => {
  const { speakers } = mergeSpeakerSegments([
    { at: 1, name: "A", userId: "u1", text: "x" },
    { at: 2, name: "A", userId: "u1", text: "y" },
  ]);
  assert.equal(speakers.length, 1);
});
