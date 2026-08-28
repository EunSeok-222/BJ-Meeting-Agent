const test = require("node:test");
const assert = require("node:assert/strict");
const {
  markdownToBlocks,
  parseRichText,
  buildTableBlock,
  splitTableRow,
  isTableRow,
  isTableSeparator,
  classifyCategory,
  resolveAttendees,
} = require("../src/services/notion.service");

test("표 줄 판별", () => {
  assert.equal(isTableRow("| a | b |"), true);
  assert.equal(isTableRow("  | a | b |  "), true);
  assert.equal(isTableRow("- 그냥 불릿"), false);
  assert.equal(isTableSeparator("| --- | --- |"), true);
  assert.equal(isTableSeparator("| :--: | ---: |"), true);
  assert.equal(isTableSeparator("| 담당자 | 직무 |"), false);
});

test("splitTableRow — 파이프 분리 + trim", () => {
  assert.deepEqual(splitTableRow("| 담당자 | 직무 | 할 일 |"), ["담당자", "직무", "할 일"]);
  assert.deepEqual(splitTableRow("|a|b|"), ["a", "b"]);
});

test("buildTableBlock — 셀 폭·헤더·패딩", () => {
  const block = buildTableBlock([
    ["담당자", "할 일"],
    ["이은석", "배포"],
    ["송수빈"], // 짧은 행 → 패딩
  ]);
  assert.equal(block.type, "table");
  assert.equal(block.table.table_width, 2);
  assert.equal(block.table.has_column_header, true);
  assert.equal(block.table.children.length, 3);
  const padded = block.table.children[2].table_row.cells;
  assert.equal(padded.length, 2);
  assert.deepEqual(padded[1], [{ type: "text", text: { content: "" } }]);
});

test("markdownToBlocks — 블록 타입 매핑", () => {
  const md = [
    "## 제목",
    "- 항목 1",
    "1. 번호 항목",
    "| 담당자 | 할 일 |",
    "| --- | --- |",
    "| 이은석 | 배포 |",
    "그냥 문단",
  ].join("\n");
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading_2", "bulleted_list_item", "numbered_list_item", "table", "paragraph"],
  );
  // 구분선은 건너뛰고 헤더+데이터 2행
  assert.equal(blocks[3].table.children.length, 2);
});

test("parseRichText — 볼드 분리와 2000자 청킹", () => {
  const parts = parseRichText("앞 **강조** 뒤");
  assert.equal(parts.length, 3);
  assert.equal(parts[1].annotations.bold, true);
  assert.equal(parts[1].text.content, "강조");

  const long = parseRichText("x".repeat(2500));
  assert.equal(long.length, 2);
  assert.equal(long[0].text.content.length, 2000);
  assert.equal(long[1].text.content.length, 500);
});

test("classifyCategory", () => {
  assert.equal(classifyCategory(["이은석", "송수빈"]), "프론트 회의");
  assert.equal(classifyCategory(["이신지", "peng"]), "백엔드 회의");
  assert.equal(classifyCategory(["이신지", "김영철"]), "백엔드 회의");
  assert.equal(classifyCategory(["이은석", "송수빈", "이신지", "peng"]), "전체 회의");
  assert.equal(classifyCategory([]), "전체 회의");
});

test("resolveAttendees — userId 우선, 이름 폴백, 중복 제거", () => {
  const r1 = resolveAttendees(
    [
      { userId: "u1", name: "이은석" },
      { userId: "u2", name: "송수빈" },
      { userId: "u3", name: "낯선사람" },
    ],
    { u1: "notion-1" },
    { 송수빈: "notion-2" },
  );
  assert.deepEqual(r1.attendeeIds, [{ id: "notion-1" }, { id: "notion-2" }]);
  assert.deepEqual(r1.unmapped, ["낯선사람"]);

  // userId 매핑이 이름 매핑을 이김
  const r2 = resolveAttendees([{ userId: "u1", name: "이은석" }], { u1: "by-id" }, { 이은석: "by-name" });
  assert.deepEqual(r2.attendeeIds, [{ id: "by-id" }]);

  // 같은 노션 ID로 매핑되는 두 화자는 한 번만
  const r3 = resolveAttendees(
    [
      { userId: "u1", name: "peng" },
      { userId: "u2", name: "김영철" },
    ],
    {},
    { peng: "same", 김영철: "same" },
  );
  assert.equal(r3.attendeeIds.length, 1);
});
