const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const state = require("../state");
const { convertPcmToWav } = require("./audio.service");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const VENV_PYTHON = path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe");
const TRANSCRIBE_SCRIPT = path.join(PROJECT_ROOT, "scripts", "transcribe.py");

// `{userId}-{startEpoch}.pcm` 형태만 처리 대상으로 인정한다.
const TRACK_FILE_RE = /^(\d+)-(\d+)\.pcm$/;

// 디스코드 수신 PCM: s16le, 48kHz, 스테레오
const PCM_BYTES_PER_SEC = 48000 * 2 * 2;
const PCM_FRAME_BYTES = 4;

// 전사 프로세스 안전 타임아웃 (화자별 트랙 병합 후엔 보통 수 분이면 끝남)
const WHISPER_TIMEOUT_MS = (Number(process.env.WHISPER_TIMEOUT_MIN) || 120) * 60 * 1000;

function pythonBin() {
  return fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : process.env.PYTHON_BIN || "python";
}

/* ────────────────────────────── 순수 함수 (테스트 대상) ────────────────────────────── */

/** "123-1699999999999.pcm" -> { userId, epoch } | null */
function parseTrackFilename(name) {
  const m = String(name).match(TRACK_FILE_RE);
  if (!m) return null;
  return { userId: m[1], epoch: Number(m[2]) };
}

/**
 * 한 화자의 발화 조각들을 이어붙인 트랙에서, 각 조각이 차지하는 시간 구간(초)을 계산한다.
 * 조각 사이 실제 침묵은 트랙에 포함되지 않으므로, 각 조각의 실제 epoch을 앵커로 유지한다.
 * @param {{epoch:number, byteLen:number}[]} bursts  epoch 오름차순
 * @returns {{epoch:number, trackStart:number, trackEnd:number}[]}
 */
function buildBurstOffsets(bursts) {
  const out = [];
  let cursor = 0;
  for (const b of bursts) {
    const dur = b.byteLen / PCM_BYTES_PER_SEC;
    out.push({ epoch: b.epoch, trackStart: cursor, trackEnd: cursor + dur });
    cursor += dur;
  }
  return out;
}

/**
 * 이어붙인 트랙 기준 초 오프셋(segStart)을 실제 벽시계 ms로 환산한다.
 */
function segmentToWallClockMs(segStart, offsets) {
  if (!offsets || offsets.length === 0) return 0;
  for (const o of offsets) {
    if (segStart < o.trackEnd) {
      const within = Math.max(0, segStart - o.trackStart);
      return o.epoch + within * 1000;
    }
  }
  const last = offsets[offsets.length - 1];
  return last.epoch + (last.trackEnd - last.trackStart) * 1000;
}

/**
 * 여러 화자의 세그먼트({ at, name, userId, text })를 시간순 전사본으로 병합한다.
 * @returns {{transcript:string, participants:string[], speakers:{userId:string,name:string}[]}}
 */
function mergeSpeakerSegments(segments) {
  const sorted = [...segments].sort((a, b) => a.at - b.at);
  const lines = [];
  const speakerMap = new Map();
  const spokenNames = new Set();

  for (const s of sorted) {
    const text = (s.text || "").trim();
    if (!text) continue;
    lines.push(`[${s.name}] ${text}`);
    spokenNames.add(s.name);
    if (s.userId) speakerMap.set(s.userId, s.name);
  }

  return {
    transcript: lines.join("\n"),
    participants: [...spokenNames],
    speakers: [...speakerMap.entries()].map(([userId, name]) => ({ userId, name })),
  };
}

/* ────────────────────────────── I/O ────────────────────────────── */

async function resolveDisplayName(userId, guild) {
  if (state.userNames.has(userId)) return state.userNames.get(userId);
  if (guild) {
    try {
      const member = await guild.members.fetch(userId);
      state.userNames.set(userId, member.displayName);
      return member.displayName;
    } catch (e) {
      /* 조회 실패 시 userId를 그대로 사용 */
    }
  }
  return userId;
}

/**
 * transcribe.py를 실행하고 stdout(JSON)을 파싱해 반환한다.
 * stderr의 "전사 완료 (n/total)" 로그를 보고 onProgress(done, total)를 호출한다.
 */
function runWhisper(wavPaths, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), [TRANSCRIBE_SCRIPT, ...wavPaths], {
      windowsHide: true,
      timeout: WHISPER_TIMEOUT_MS,
    });

    let stdout = "";
    let stderrTail = "";
    const total = wavPaths.length;

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });

    child.stderr.on("data", (d) => {
      const text = d.toString("utf8");
      stderrTail = (stderrTail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        console.log("[whisper]", line.trim());
        const m = line.match(/전사 완료 \((\d+)\/(\d+)\)/);
        if (m && typeof onProgress === "function") {
          onProgress(Number(m[1]), Number(m[2]) || total);
        }
      }
    });

    child.on("error", (err) => reject(new Error("전사 프로세스 실행 불가: " + err.message)));

    child.on("close", (code, signal) => {
      if (signal) {
        return reject(new Error(`전사 프로세스가 신호로 종료됨 (${signal}). 타임아웃일 수 있습니다.`));
      }
      if (code !== 0) {
        return reject(new Error(`전사 프로세스 실패 (exit ${code}): ${stderrTail.trim()}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error("전사 결과 파싱 실패: " + stdout.slice(0, 500)));
      }
    });
  });
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    /* 무시 */
  }
}

/**
 * recordings 폴더의 발화 조각 PCM들을 화자별로 하나의 트랙으로 이어붙인 뒤 전사하고,
 * 시간순으로 정렬된 "[이름] 발화" 전사본을 만든다.
 *
 * 화자별 1트랙으로 합치므로 (참석자 수만큼만 전사) 2~3시간 회의에서도
 * 프로세스 실행 횟수·명령행 길이·전사 시간이 폭발하지 않는다.
 *
 * @returns {Promise<{transcript:string, participants:string[], speakers:{userId,name}[], warnings:string[]}>}
 */
async function transcribeMeeting(pcmFiles, recordingsDir, guild, onProgress) {
  const notify = (s) => {
    if (typeof onProgress === "function") {
      try {
        onProgress(s);
      } catch (e) {
        /* 무시 */
      }
    }
  };
  const warnings = [];

  // 1. 조각을 화자별로 그룹핑
  const byUser = new Map();
  for (const f of pcmFiles) {
    const parsed = parseTrackFilename(f);
    if (!parsed) continue;
    if (!byUser.has(parsed.userId)) byUser.set(parsed.userId, []);
    byUser.get(parsed.userId).push({ file: f, epoch: parsed.epoch });
  }
  if (byUser.size === 0) {
    return { transcript: "", participants: [], speakers: [], warnings };
  }

  const tmpFiles = [];
  const perUser = [];

  // 2. 화자별로 조각 이어붙이기 -> merged.pcm -> merged.wav, 오프셋 테이블 생성
  for (const [userId, bursts] of byUser) {
    bursts.sort((a, b) => a.epoch - b.epoch);
    const mergedPcm = path.join(recordingsDir, `${userId}.merged.pcm`);
    const wavPath = path.join(recordingsDir, `${userId}.merged.wav`);
    tmpFiles.push(mergedPcm, wavPath);

    const ws = fs.createWriteStream(mergedPcm);
    const burstMeta = [];
    for (const b of bursts) {
      let buf;
      try {
        buf = fs.readFileSync(path.join(recordingsDir, b.file));
      } catch (e) {
        warnings.push(`조각 읽기 실패: ${b.file}`);
        continue;
      }
      const usable = buf.length - (buf.length % PCM_FRAME_BYTES);
      if (usable <= 0) continue;
      await new Promise((res, rej) =>
        ws.write(buf.subarray(0, usable), (err) => (err ? rej(err) : res())),
      );
      burstMeta.push({ epoch: b.epoch, byteLen: usable });
    }
    await new Promise((res) => ws.end(res));

    if (burstMeta.length === 0) {
      safeUnlink(mergedPcm);
      continue;
    }
    try {
      await convertPcmToWav(mergedPcm, wavPath);
    } catch (e) {
      warnings.push(`WAV 변환 실패(${userId}): ${e.message}`);
      continue;
    }
    perUser.push({ userId, wavPath, offsets: buildBurstOffsets(burstMeta) });
  }

  const cleanup = () => {
    for (const f of tmpFiles) safeUnlink(f);
    for (const [, bursts] of byUser) {
      for (const b of bursts) safeUnlink(path.join(recordingsDir, b.file));
    }
  };

  if (perUser.length === 0) {
    cleanup();
    return { transcript: "", participants: [], speakers: [], warnings };
  }

  notify(`🎙️ 화자 ${perUser.length}명 트랙 병합 완료. 전사 중...`);

  // 3. 화자별 WAV를 한 번의 whisper 호출로 전사
  const wavToUser = new Map(perUser.map((u) => [path.resolve(u.wavPath), u]));
  let whisperResults;
  try {
    whisperResults = await runWhisper(
      perUser.map((u) => u.wavPath),
      (done, tot) => notify(`📝 전사 중... (${done}/${tot} 화자)`),
    );
  } catch (e) {
    cleanup();
    throw e;
  }

  // 4. 세그먼트 -> 벽시계 시각 환산 + 화자 이름 해석
  const allSegments = [];
  for (const r of whisperResults) {
    const u = wavToUser.get(path.resolve(r.file));
    if (!u) continue;
    const name = await resolveDisplayName(u.userId, guild);
    for (const seg of r.segments || []) {
      const text = (seg.text || "").trim();
      if (!text) continue;
      allSegments.push({
        at: segmentToWallClockMs(seg.start, u.offsets),
        name,
        userId: u.userId,
        text,
      });
    }
  }

  const merged = mergeSpeakerSegments(allSegments);

  // 5. 전사본이 확보됐으면 원본/임시 파일 정리 (이후 단계가 실패해도 디스크·손실 방지)
  cleanup();

  return { ...merged, warnings };
}

module.exports = {
  transcribeMeeting,
  // 순수 함수 (테스트용)
  parseTrackFilename,
  buildBurstOffsets,
  segmentToWallClockMs,
  mergeSpeakerSegments,
  TRACK_FILE_RE,
  PCM_BYTES_PER_SEC,
};
