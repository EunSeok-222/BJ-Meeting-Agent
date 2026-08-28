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

function pythonBin() {
  return fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : process.env.PYTHON_BIN || "python";
}

async function resolveDisplayName(userId, guild) {
  if (state.userNames.has(userId)) return state.userNames.get(userId);
  if (guild) {
    try {
      const member = await guild.members.fetch(userId);
      state.userNames.set(userId, member.displayName);
      return member.displayName;
    } catch (e) {
      /* 조회 실패 시 아래에서 userId를 그대로 사용 */
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

    child.on("close", (code) => {
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

/**
 * recordings 폴더의 사람별 PCM 트랙을 각각 전사하고,
 * 시간순으로 정렬된 "[이름] 발화" 형태의 전사본 문자열을 만든다.
 *
 * @param {string[]} pcmFiles
 * @param {string} recordingsDir
 * @param {import("discord.js").Guild|null} guild
 * @param {(stage: string) => void} [onProgress] 단계 알림 콜백
 * @returns {Promise<{ transcript: string, participants: string[], speakers: {userId: string, name: string}[] }>}
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

  const tracks = [];
  for (const pcm of pcmFiles) {
    const m = pcm.match(TRACK_FILE_RE);
    if (!m) continue;
    const [, userId, epochStr] = m;
    const pcmPath = path.join(recordingsDir, pcm);
    const wavPath = path.join(recordingsDir, pcm.replace(/\.pcm$/, ".wav"));
    await convertPcmToWav(pcmPath, wavPath);
    tracks.push({ userId, startEpoch: Number(epochStr), pcmPath, wavPath });
  }

  if (tracks.length === 0) {
    return { transcript: "", participants: [], speakers: [] };
  }

  notify(`🎙️ 음성 트랙 ${tracks.length}개 변환 완료. 전사 중...`);

  const whisperResults = await runWhisper(
    tracks.map((t) => t.wavPath),
    (done, tot) => notify(`📝 전사 중... (${done}/${tot} 트랙)`),
  );
  const segmentsByFile = new Map(
    whisperResults.map((r) => [path.resolve(r.file), r.segments || []]),
  );

  const merged = [];
  const speakerMap = new Map(); // userId -> name
  for (const track of tracks) {
    const name = await resolveDisplayName(track.userId, guild);
    const segments = segmentsByFile.get(path.resolve(track.wavPath)) || [];
    for (const seg of segments) {
      const text = (seg.text || "").trim();
      if (!text) continue;
      merged.push({ at: track.startEpoch + seg.start * 1000, name, text });
      speakerMap.set(track.userId, name);
    }
  }
  merged.sort((a, b) => a.at - b.at);

  const transcript = merged.map((m) => `[${m.name}] ${m.text}`).join("\n");
  const participants = [...new Set(merged.map((m) => m.name))];
  const speakers = [...speakerMap.entries()].map(([userId, name]) => ({ userId, name }));

  // 성공적으로 전사본을 만들었으면 임시 파일 정리
  for (const track of tracks) {
    try {
      fs.unlinkSync(track.wavPath);
    } catch (e) {
      /* 무시 */
    }
    try {
      fs.unlinkSync(track.pcmPath);
    } catch (e) {
      /* 무시 */
    }
  }

  return { transcript, participants, speakers };
}

module.exports = {
  transcribeMeeting,
  TRACK_FILE_RE,
};
