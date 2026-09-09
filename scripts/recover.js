/**
 * 봇이 `/회의종료` 전에 꺼져서 처리하지 못한 회의를,
 * recordings/ 에 남아있는 PCM 조각으로 복구한다.
 *
 * 사용:
 *   node scripts/recover.js
 *
 * 동작:
 *   1. recordings/*.pcm 을 recordings/recover-<ts>/ 로 옮김 (원본 폴더는 다음 회의를 위해 비움)
 *   2. 화자별 트랙 병합 + 전사 → recovered/transcript-<ts>.txt 로 먼저 저장
 *   3. Claude 요약 → recovered/summary-<ts>.md
 *   4. 노션 업로드
 *
 * 화자 이름은 아래 KNOWN_NAMES 로 매핑한다. (봇 재시작 시 state.userNames 캐시가 사라지므로)
 * 팀원이 바뀌면 이 표를 수정.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const state = require("../src/state");
const { transcribeMeeting } = require("../src/services/transcribe.service");
const { summarizeWithClaude } = require("../src/services/claude.service");
const { recordToNotionDirect } = require("../src/services/notion.service");

// 디스코드 userId -> 표시명.
// .env 의 DISCORD_NAME_MAPPING(JSON) 을 우선 사용하고, 없으면 아래 기본값.
// (봇 재시작 시 state.userNames 캐시가 사라지므로 복구 시엔 이 표로 이름을 해석한다.)
const KNOWN_NAMES = process.env.DISCORD_NAME_MAPPING
  ? JSON.parse(process.env.DISCORD_NAME_MAPPING)
  : {
      "433873045158101014": "이은석",
      "1141980484671389707": "송수빈",
      "1284880963070984216": "이신지",
      "301702495938543616": "김영철", // 디스코드 닉네임은 "Peng"
    };

const RECORDINGS_DIR = path.join(__dirname, "..", "recordings");
const OUT_DIR = path.join(__dirname, "..", "recovered");
const TRACK_RE = /^\d+-\d+\.pcm$/;

async function main() {
  // 0. 화자 이름 캐시 시드 (transcribeMeeting 이 guild 없이도 이름을 해석하도록)
  for (const [id, name] of Object.entries(KNOWN_NAMES)) state.userNames.set(id, name);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. 남은 조각을 스테이징 폴더로 이동 (원본 recordings/ 는 다음 회의를 위해 비워둠)
  const all = fs.readdirSync(RECORDINGS_DIR).filter((f) => TRACK_RE.test(f));
  if (all.length === 0) {
    console.log("recordings/ 에 복구할 PCM 조각이 없습니다.");
    return;
  }
  const stageDir = path.join(RECORDINGS_DIR, `recover-${stamp}`);
  fs.mkdirSync(stageDir, { recursive: true });
  for (const f of all) fs.renameSync(path.join(RECORDINGS_DIR, f), path.join(stageDir, f));
  console.log(`조각 ${all.length}개를 ${path.relative(process.cwd(), stageDir)} 로 옮겼습니다.`);

  const byUser = {};
  for (const f of all) {
    const uid = f.split("-")[0];
    byUser[uid] = (byUser[uid] || 0) + 1;
  }
  console.log(
    "화자별 조각:",
    Object.entries(byUser)
      .map(([id, n]) => `${KNOWN_NAMES[id] || id}=${n}`)
      .join(" · "),
  );

  // 2. 전사
  console.log("\n[1/3] 전사 시작...");
  const { transcript, participants, speakers, warnings = [] } = await transcribeMeeting(
    all,
    stageDir,
    null,
    (s) => console.log("  " + s),
  );

  if (!transcript.trim()) {
    console.error("전사 결과가 비어 있습니다. 조각은 " + stageDir + " 에 그대로 있습니다.");
    process.exit(1);
  }

  const transcriptFile = path.join(OUT_DIR, `transcript-${stamp}.txt`);
  fs.writeFileSync(transcriptFile, transcript, "utf8");
  console.log(`  전사본 저장: ${path.relative(process.cwd(), transcriptFile)} (${transcript.length}자)`);
  if (warnings.length) console.log("  경고:", warnings.join(" / "));

  // 3. 요약
  console.log("\n[2/3] Claude 요약 중...");
  const summary = await summarizeWithClaude(transcript, participants);
  const summaryFile = path.join(OUT_DIR, `summary-${stamp}.md`);
  fs.writeFileSync(summaryFile, summary, "utf8");
  console.log(`  요약 저장: ${path.relative(process.cwd(), summaryFile)}`);

  // 4. 노션 업로드
  console.log("\n[3/3] 노션 업로드 중...");
  await recordToNotionDirect(summary, participants, { speakers });

  console.log("\n✅ 복구 완료.");
  console.log("   참석자:", participants.join(", "));
  console.log("   전사본:", path.relative(process.cwd(), transcriptFile));
  console.log("   요약본:", path.relative(process.cwd(), summaryFile));
  console.log(`   (스테이징 폴더 ${path.relative(process.cwd(), stageDir)} 는 전사 성공 시 정리됩니다)`);
}

main().catch((err) => {
  console.error("\n❌ 복구 실패:", err.message);
  console.error("   recordings/recover-* 폴더의 조각과 recovered/ 의 중간 결과를 확인하세요.");
  console.error("   전사본이 이미 저장됐다면, 그 파일 내용으로 요약만 다시 시도할 수 있습니다.");
  process.exit(1);
});
