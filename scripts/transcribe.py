"""
faster-whisper 래퍼.

사용법:
    python transcribe.py <wav 파일 1> [<wav 파일 2> ...]

각 WAV 파일을 한국어로 전사한 뒤, 아래 형태의 JSON을 stdout으로 출력한다.
    [
      { "file": "<절대경로>", "segments": [ { "start": 1.2, "end": 4.0, "text": "..." }, ... ] },
      ...
    ]

로그/진행 상황은 모두 stderr로 보낸다. stdout에는 JSON만 나가야 한다.
"""

import json
import os
import sys

# Windows 기본 stdout 인코딩(cp949)이면 Node가 UTF-8로 읽을 때 한글이 깨진다.
# stdout에는 JSON만, stderr에는 로그만 나가므로 둘 다 UTF-8로 고정한다.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

# ---- 설정 -------------------------------------------------------------------
# Windows에서 심볼릭 링크 권한이 없으면 모델 다운로드가 실패한다(WinError 1314).
# 링크 대신 복사 모드로 강제한다.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# large-v3-turbo: large-v3와 정확도 비슷하면서 2~4배 빠름. 되돌리려면 WHISPER_MODEL=large-v3
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")          # 폴백: "cpu"
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "float16")  # 폴백: "int8_float16" 또는 "int8"
LANGUAGE = os.environ.get("WHISPER_LANG", "ko")
BATCH_SIZE = int(os.environ.get("WHISPER_BATCH", "8"))     # 0 이면 배치 파이프라인 비활성화
# --------------------------------------------------------------------------- -


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def register_cuda_dlls():
    """pip nvidia-* 패키지가 .venv에 넣어둔 CUDA 런타임 DLL 폴더를
    Windows DLL 검색 경로에 등록한다. (CTranslate2가 자동으로 안 해줌)
    반드시 faster_whisper import 전에 호출해야 한다."""
    if os.name != "nt":
        return
    try:
        import importlib.util

        spec = importlib.util.find_spec("nvidia")
        if not spec or not spec.submodule_search_locations:
            return
        nvidia_root = list(spec.submodule_search_locations)[0]
    except Exception:  # noqa: BLE001
        return

    added = []
    for sub in ("cublas", "cudnn", "cuda_nvrtc"):
        bin_dir = os.path.join(nvidia_root, sub, "bin")
        if os.path.isdir(bin_dir):
            try:
                os.add_dll_directory(bin_dir)
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
                added.append(sub)
            except OSError:
                pass
    if added:
        log(f"CUDA DLL 경로 등록: {', '.join(added)}")


def main():
    wav_paths = sys.argv[1:]
    if not wav_paths:
        log("에러: 전사할 WAV 파일 경로를 하나 이상 넘겨주세요.")
        sys.exit(2)

    if DEVICE == "cuda":
        register_cuda_dlls()

    try:
        from faster_whisper import WhisperModel

        try:
            from faster_whisper import BatchedInferencePipeline
        except ImportError:
            BatchedInferencePipeline = None
    except ImportError:
        log("에러: faster-whisper가 설치되지 않았습니다. scripts/setup.md 를 참고해 설치하세요.")
        sys.exit(1)

    log(f"Whisper 모델 로딩: {MODEL_SIZE} (device={DEVICE}, compute_type={COMPUTE_TYPE})")
    try:
        model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    except Exception as e:  # noqa: BLE001
        log(f"에러: 모델 로딩 실패 ({e}).")
        log("CUDA 런타임이 없으면 `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` 를 시도하거나,")
        log("환경변수 WHISPER_DEVICE=cpu WHISPER_COMPUTE=int8 로 CPU 폴백하세요.")
        sys.exit(1)

    use_batched = BATCH_SIZE > 0 and BatchedInferencePipeline is not None
    pipeline = BatchedInferencePipeline(model=model) if use_batched else None
    log(f"전사 모드: {'배치(batch_size=' + str(BATCH_SIZE) + ')' if use_batched else '단일'}")

    def transcribe_one(path):
        if use_batched:
            try:
                return pipeline.transcribe(
                    path, language=LANGUAGE, batch_size=BATCH_SIZE, vad_filter=True
                )
            except Exception as e:  # noqa: BLE001
                log(f"배치 전사 실패, 단일 모드로 재시도: {e}")
        return model.transcribe(path, language=LANGUAGE, vad_filter=True)

    results = []
    total = len(wav_paths)
    for idx, wav in enumerate(wav_paths, 1):
        abspath = os.path.abspath(wav)
        if not os.path.exists(abspath):
            log(f"경고: 파일 없음, 건너뜀 -> {abspath}")
            results.append({"file": abspath, "segments": []})
            continue

        log(f"전사 시작 ({idx}/{total}): {abspath}")
        try:
            segments, info = transcribe_one(abspath)
            seg_list = []
            for s in segments:
                text = (s.text or "").strip()
                if not text:
                    continue
                seg_list.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": text})
        except Exception as e:  # noqa: BLE001
            # 한 파일이 실패해도 나머지는 계속 처리한다 (긴 회의 부분 손실 방지)
            log(f"전사 실패 ({idx}/{total}), 건너뜀: {abspath} ({e})")
            seg_list = []
        log(f"전사 완료 ({idx}/{total}): {abspath} (구간 {len(seg_list)}개)")
        results.append({"file": abspath, "segments": seg_list})

    json.dump(results, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
