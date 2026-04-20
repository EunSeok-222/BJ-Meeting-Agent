const { notion, DATABASE_ID } = require("../config/clients");

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
    // 볼드체 이전의 일반 텍스트 추가
    if (match.index > lastIndex) {
      parts.push(...createRichTextChunks(text.substring(lastIndex, match.index)));
    }
    // 볼드체 텍스트 추가
    parts.push(...createRichTextChunks(match[1], { bold: true }));
    lastIndex = boldRegex.lastIndex;
  }

  // 남은 텍스트 추가
  if (lastIndex < text.length) {
    parts.push(...createRichTextChunks(text.substring(lastIndex)));
  }

  return parts.length > 0 ? parts : createRichTextChunks(text);
}

/**
 * 마크다운 줄을 노션 블록 객체로 변환합니다.
 */
function markdownLineToBlock(line) {
  line = line.trim();
  if (!line) return null;

  // Heading 3
  if (line.startsWith("### ")) {
    return {
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: parseRichText(line.replace("### ", "")) },
    };
  }
  // Heading 2
  if (line.startsWith("## ")) {
    return {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: parseRichText(line.replace("## ", "")) },
    };
  }
  // Heading 1
  if (line.startsWith("# ")) {
    return {
      object: "block",
      type: "heading_1",
      heading_1: { rich_text: parseRichText(line.replace("# ", "")) },
    };
  }
  // Bulleted List Item
  if (line.startsWith("* ") || line.startsWith("- ")) {
    const content = line.startsWith("* ") ? line.replace("* ", "") : line.replace("- ", "");
    return {
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: parseRichText(content) },
    };
  }
  // Numbered List Item
  if (/^\d+\.\s/.test(line)) {
    const content = line.replace(/^\d+\.\s/, "");
    return {
      object: "block",
      type: "numbered_list_item",
      numbered_list_item: { rich_text: parseRichText(content) },
    };
  }

  // Default Paragraph
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: parseRichText(line) },
  };
}

async function recordToNotionDirect(summaryText, message = null) {
  if (!DATABASE_ID) {
    console.log("⚠️ .env에 BJ_NOTION_DATABASE_ID가 없어서 노션 기록을 생략합니다.");
    return;
  }

  try {
    const lines = summaryText.split("\n");
    const children = [
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: "🤖 AI 요약본" } }],
        },
      },
    ];

    for (const line of lines) {
      const block = markdownLineToBlock(line);
      if (block) {
        children.push(block);
      }
    }

    await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        "Meeting name": {
          title: [
            { text: { content: `${new Date().toLocaleDateString()} 회의록` } },
          ],
        },
        "회의 진행일": {
          date: { start: new Date().toISOString().split("T")[0] },
        },
        Category: {
          multi_select: [{ name: "전체 회의" }],
        },
      },
      children: children.slice(0, 100),
    });

    console.log("북잡 회의록 업데이트 완료!");
    if (message) message.reply("✅ 노션에 예쁘게 포맷팅되어 전송되었습니다!");
  } catch (error) {
    console.error("노션 전송 실패:", error.body ? error.body : error);
    if (message)
      message.reply(
        "❌ 노션 전송에 실패했습니다. 로그를 확인하거나 `/노션재전송`을 시도해 보세요.",
      );
  }
}

module.exports = {
  recordToNotionDirect
};
