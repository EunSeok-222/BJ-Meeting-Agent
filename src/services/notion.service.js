const { notion, DATABASE_ID } = require("../config/clients");

const NOTION_CHILDREN_LIMIT = 100; // 한 요청당 블록 수 제한

/**
 * 텍스트를 노션 제한인 2000자 단위로 쪼개서 rich_text 배열용 객체들을 생성합니다.
 */
function createRichTextChunks(text, annotations = {}) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 2000) {
    const chunk = {
      type: "text",
      text: { content: text.substring(i, i + 2000) },
    };
    if (Object.keys(annotations).length > 0) {
      chunk.annotations = annotations;
    }
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * 텍스트 내의 볼드체(**텍스트**)를 노션의 rich_text 형식으로 변환합니다.
 * 각 텍스트 조각이 2000자를 넘지 않도록 안전하게 처리합니다.
 */
function parseRichText(text) {
  const parts = [];
  const boldRegex = /\*\*(.*?)\*\*/g;
  let lastIndex = 0;
  let match;

  while ((match = boldRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...createRichTextChunks(text.substring(lastIndex, match.index)));
    }
    parts.push(...createRichTextChunks(match[1], { bold: true }));
    lastIndex = boldRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(...createRichTextChunks(text.substring(lastIndex)));
  }

  return parts.length > 0 ? parts : createRichTextChunks(text);
}

/** 표 셀 하나를 rich_text 배열로. 빈 셀도 유효한 형태로 반환. */
function cellRichText(text) {
  const t = (text || "").trim();
  if (!t) return [{ type: "text", text: { content: "" } }];
  return parseRichText(t);
}

/** "| a | b | c |" 형태의 마크다운 표 줄인가 */
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

/** "| --- | :--: |" 같은 구분선인가 */
function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function buildTableBlock(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  return {
    object: "block",
    type: "table",
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children: rows.map((cells) => ({
        object: "block",
        type: "table_row",
        table_row: {
          cells: Array.from({ length: width }, (_, i) => cellRichText(cells[i])),
        },
      })),
    },
  };
}

/**
 * 마크다운 한 줄을 노션 블록으로 변환합니다. (표는 markdownToBlocks에서 처리)
 */
function markdownLineToBlock(line) {
  line = line.trim();
  if (!line) return null;

  if (line.startsWith("### ")) {
    return { object: "block", type: "heading_3", heading_3: { rich_text: parseRichText(line.replace("### ", "")) } };
  }
  if (line.startsWith("## ")) {
    return { object: "block", type: "heading_2", heading_2: { rich_text: parseRichText(line.replace("## ", "")) } };
  }
  if (line.startsWith("# ")) {
    return { object: "block", type: "heading_1", heading_1: { rich_text: parseRichText(line.replace("# ", "")) } };
  }
  if (line.startsWith("* ") || line.startsWith("- ")) {
    const content = line.startsWith("* ") ? line.replace("* ", "") : line.replace("- ", "");
    return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: parseRichText(content) } };
  }
  if (/^\d+\.\s/.test(line)) {
    const content = line.replace(/^\d+\.\s/, "");
    return { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: parseRichText(content) } };
  }

  return { object: "block", type: "paragraph", paragraph: { rich_text: parseRichText(line) } };
}

/**
 * 마크다운 전체를 노션 블록 배열로 변환합니다.
 * 연속된 표 줄은 하나의 table 블록으로 묶습니다.
 */
function markdownToBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isTableRow(line)) {
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isTableSeparator(lines[i])) rows.push(splitTableRow(lines[i]));
        i++;
      }
      i--; // for-loop의 i++ 보정
      if (rows.length > 0) blocks.push(buildTableBlock(rows));
      continue;
    }

    const block = markdownLineToBlock(line);
    if (block) blocks.push(block);
  }

  return blocks;
}

/**
 * 참석 인원/조합으로 회의 카테고리를 판별한다. (순수 함수 — 테스트 대상)
 */
function classifyCategory(participants) {
  const pSet = new Set(participants);
  if (participants.length === 2) {
    if (pSet.has("이은석") && (pSet.has("송수빈") || pSet.has("수빈 송"))) return "프론트 회의";
    if (pSet.has("이신지") && (pSet.has("김영철") || pSet.has("peng"))) return "백엔드 회의";
  }
  return "전체 회의";
}

/**
 * 화자 목록을 노션 people ID로 매핑한다. userId 매핑 우선, 없으면 이름 매핑. (순수 함수)
 * @returns {{attendeeIds:{id:string}[], unmapped:string[]}}
 */
function resolveAttendees(speakers, idMapping = {}, nameMapping = {}) {
  const seen = new Set();
  const attendeeIds = [];
  const unmapped = [];
  for (const { userId, name } of speakers) {
    const id = (userId && idMapping[userId]) || nameMapping[name];
    if (id) {
      if (!seen.has(id)) {
        seen.add(id);
        attendeeIds.push({ id });
      }
    } else {
      unmapped.push(name);
    }
  }
  return { attendeeIds, unmapped };
}

// 이름 -> 노션 User ID (기존)
const USER_MAPPING = process.env.NOTION_USER_MAPPING ? JSON.parse(process.env.NOTION_USER_MAPPING) : {};
// 디스코드 userId -> 노션 User ID (이름이 바뀌어도 안 흔들림, 우선 적용)
const USER_ID_MAPPING = process.env.NOTION_USER_ID_MAPPING ? JSON.parse(process.env.NOTION_USER_ID_MAPPING) : {};

/**
 * @param {string} summaryText  마크다운 요약
 * @param {string[]} participants  참석자 표시명 목록
 * @param {{ speakers?: {userId: string, name: string}[] }} [options]
 */
async function recordToNotionDirect(summaryText, participants = [], options = {}) {
  if (!DATABASE_ID) {
    console.log("⚠️ .env에 BJ_NOTION_DATABASE_ID가 없어서 노션 기록을 생략합니다.");
    return;
  }

  try {
    const category = classifyCategory(participants);

    const speakers =
      options.speakers && options.speakers.length > 0
        ? options.speakers
        : participants.map((name) => ({ userId: null, name }));
    const { attendeeIds, unmapped } = resolveAttendees(speakers, USER_ID_MAPPING, USER_MAPPING);

    if (unmapped.length > 0) {
      console.log(`⚠️ 노션 매핑 정보가 없어 참석자에서 제외됨: ${unmapped.join(", ")}`);
    }
    if (attendeeIds.length > 0) {
      console.log(`✅ ${attendeeIds.length}명의 참석자가 노션에 등록됩니다.`);
    }

    const children = [
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: "🤖 AI 요약본" } }] },
      },
      ...markdownToBlocks(summaryText),
    ];

    // 페이지 생성 (첫 100블록)
    const created = await notion.request({
      path: "pages",
      method: "POST",
      body: {
        parent: { data_source_id: DATABASE_ID },
        properties: {
          "Meeting name": {
            title: [{ text: { content: `${new Date().toLocaleDateString("ko-KR")} AI 회의록` } }],
          },
          "회의 진행일": { date: { start: new Date().toISOString().split("T")[0] } },
          Category: { multi_select: [{ name: category }] },
          Attendees: { people: attendeeIds },
        },
        children: children.slice(0, NOTION_CHILDREN_LIMIT),
      },
    });

    // 100블록 초과분은 append (긴 회의 요약이 잘리지 않도록)
    const pageId = created && created.id;
    if (pageId && children.length > NOTION_CHILDREN_LIMIT) {
      for (let i = NOTION_CHILDREN_LIMIT; i < children.length; i += NOTION_CHILDREN_LIMIT) {
        await notion.request({
          path: `blocks/${pageId}/children`,
          method: "PATCH",
          body: { children: children.slice(i, i + NOTION_CHILDREN_LIMIT) },
        });
      }
      console.log(`요약이 길어 ${children.length}개 블록을 나눠서 업로드했습니다.`);
    }

    console.log(`북잡 회의록 업데이트 완료! (카테고리: ${category})`);
  } catch (error) {
    console.error("노션 전송 실패:", error.body ? error.body : error);
    throw error;
  }
}

module.exports = {
  recordToNotionDirect,
  // 순수 함수 (테스트용)
  markdownToBlocks,
  markdownLineToBlock,
  parseRichText,
  buildTableBlock,
  splitTableRow,
  isTableRow,
  isTableSeparator,
  classifyCategory,
  resolveAttendees,
};
