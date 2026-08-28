const state = require("./state");

/**
 * .env에서 종료 타이머 설정을 읽는다. (순수 함수 — 테스트 대상)
 * 명시적으로 0을 주면 해당 기능을 끈다. 값이 없거나 잘못되면 기본값.
 */
function resolveExitConfig(env = process.env) {
  const autoMin = Number(env.AUTO_EXIT_MINUTES);
  const safeHr = Number(env.SAFETY_IDLE_HOURS);
  return {
    autoExitMs: (Number.isFinite(autoMin) ? autoMin : 10) * 60 * 1000,
    safetyIdleMs: (Number.isFinite(safeHr) ? safeHr : 3) * 60 * 60 * 1000,
  };
}

const { autoExitMs: MEETING_DONE_EXIT_MS, safetyIdleMs: SAFETY_IDLE_MS } = resolveExitConfig();
const SAFETY_CHECK_MS = 5 * 60 * 1000; // 5분마다 점검

let autoExitTimer = null;

function exitNow(reason) {
  console.log(`봇을 종료합니다${reason ? " — " + reason : ""}.`);
  process.exit(0);
}

/**
 * 회의 처리가 끝났을 때 호출. AUTO_EXIT_MINUTES 뒤 프로세스를 종료한다.
 * 그 사이 새 회의가 시작되면 interaction 핸들러에서 cancelAutoExit()로 취소.
 */
function scheduleAutoExit() {
  if (MEETING_DONE_EXIT_MS <= 0) return;
  if (autoExitTimer) clearTimeout(autoExitTimer);
  console.log(`회의 처리 완료 — ${MEETING_DONE_EXIT_MS / 60000}분 후 봇을 자동 종료합니다.`);
  autoExitTimer = setTimeout(() => exitNow("자동 종료 시간 경과"), MEETING_DONE_EXIT_MS);
}

function cancelAutoExit() {
  if (autoExitTimer) {
    clearTimeout(autoExitTimer);
    autoExitTimer = null;
    console.log("새 회의가 시작되어 자동 종료 예약을 취소했습니다.");
  }
}

/**
 * 봇 시작 시 1회 호출. 유휴 상태가 오래 지속되면 종료한다.
 * 회의가 길어지는 경우(state.isRecording)에는 종료를 보류한다.
 */
function armSafetyTimer() {
  if (SAFETY_IDLE_MS <= 0) return;
  const deadline = Date.now() + SAFETY_IDLE_MS;
  const iv = setInterval(() => {
    if (Date.now() < deadline) return;
    if (state.isRecording) return; // 회의 진행 중이면 보류
    exitNow("유휴 상태 지속(안전 타이머)");
  }, SAFETY_CHECK_MS);
  if (iv.unref) iv.unref();
}

module.exports = {
  scheduleAutoExit,
  cancelAutoExit,
  armSafetyTimer,
  exitNow,
  resolveExitConfig,
};
