const fs = require("fs");
const state = require("../state");
const { transcribeMeeting } = require("./transcribe.service");
const { summarizeWithClaude } = require("./claude.service");
const { recordToNotionDirect } = require("./notion.service");

const TRACK_RE = /^\d+-\d+\.pcm$/;

/** recordings/ 에 아직 처리되지 않은 발화 조각이 있는지 확인 */
function pendingRecordings(recordingsDir = "./recordings") {
  try {
    return fs.readdirSync(recordingsDir).filter((f) => TRACK_RE.test(f));
  } catch (e) {
    return [];
  }
}

/**
 * recordings/ 의 조각을 전사 → Claude 요약 → 노션 업로드까지 처리한다.
 * Discord interaction 과 결합하지 않으므로 슬래시 커맨드, 프로세스 종료 훅, 복구 스크립트가 공유한다.
 * 진행 상황은 onProgress(text) 로 보고. state(lastTranscript/lastSummary/lastFailedMeeting 등)를 갱신한다.
 *
 * @returns {Promise<{status:"done"|"empty"|"error", transcript?:string, summary?:string,
 *                    participants?:string[], speakers?:object[], warnings?:string[], error?:Error}>}
 */
async function processMeeting({
  recordingsDir = "./recordings",
  guild = null,
  participants = [],
  onProgress,
} = {}) {
  const report = typeof onProgress === "function" ? onProgress : () => {};
  const files = pendingRecordings(recordingsDir);
  if (files.length === 0) return { status: "empty" };

  let transcript, spokenParticipants, speakers, warnings;
  try {
    ({
      transcript,
      participants: spokenParticipants,
      speakers,
      warnings = [],
    } = await transcribeMeeting(files, recordingsDir, guild, report));
  } catch (error) {
    state.lastFailedMeeting = {
      transcript: state.lastTranscript || "",
      participants,
      speakers: state.lastSpeakers || [],
    };
    return { status: "error", error };
  }

  state.lastTranscript = transcript;
  state.lastSpeakers = speakers;

  if (!transcript.trim()) {
    state.lastFailedMeeting = null;
    return { status: "empty", transcript: "" };
  }

  const participantsForSummary = participants.length > 0 ? participants : spokenParticipants;

  try {
    report("🤖 AI가 회의록을 작성 중입니다...");
    const summary = await summarizeWithClaude(transcript, participantsForSummary);
    state.lastSummary = summary;
    state.lastParticipants = participantsForSummary;

    report("📤 노션에 업로드 중입니다...");
    await recordToNotionDirect(summary, participantsForSummary, { speakers });

    state.lastFailedMeeting = null;
    return {
      status: "done",
      transcript,
      summary,
      participants: participantsForSummary,
      speakers,
      warnings,
    };
  } catch (error) {
    state.lastFailedMeeting = {
      transcript,
      participants: participantsForSummary,
      speakers: speakers || [],
    };
    return { status: "error", error, transcript };
  }
}

module.exports = { processMeeting, pendingRecordings };
