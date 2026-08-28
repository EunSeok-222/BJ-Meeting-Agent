# 최초 1회 세팅 가이드 (Windows)

한 번만 하면 되고, 컴퓨터를 껐다 켜도 다시 할 필요 없다.

## 0. 사전 확인

- Node.js 설치됨 (`node --version`)
- Python 설치됨 (`py --version` 또는 `python --version`) — 권장 3.10~3.12
- `claude` CLI 로그인됨 (`claude -p "안녕" --output-format json` 이 JSON을 뱉으면 OK)
- NVIDIA GPU 드라이버 최신

## 1. Node 의존성 설치

```powershell
cd C:\Users\dldms\bookjob-ai-bot
npm install
```

## 2. Python 가상환경 + faster-whisper 설치

```powershell
cd C:\Users\dldms\bookjob-ai-bot

# 가상환경 생성 (.venv 폴더가 디스크에 영구 저장됨)
py -m venv .venv

# faster-whisper + CUDA 런타임 라이브러리 설치
.\.venv\Scripts\pip install --upgrade pip
.\.venv\Scripts\pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12
```

> `py -m venv .venv` 에서 Python 3.13이 잡히고 `faster-whisper` 설치가 실패하면
> (일부 의존성 휠이 3.13 미지원), 3.11로 다시 만든다:
> ```powershell
> rmdir /s /q .venv
> py -3.11 -m venv .venv
> .\.venv\Scripts\pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12
> ```

## 3. 전사 동작 확인

아무 한국어 음성 WAV 파일(`sample.wav`)을 준비한 뒤:

```powershell
.\.venv\Scripts\python scripts\transcribe.py sample.wav
```

- 처음 실행 시 Whisper `large-v3` 모델(약 1.5GB)을 자동 다운로드한다. (한 번만)
- stderr에 `device=cuda` 로그가 보이고, 마지막에 JSON이 출력되면 성공.
- CUDA 관련 에러가 나면:
  ```powershell
  # CPU 폴백 (느리지만 동작 확인용)
  $env:WHISPER_DEVICE="cpu"; $env:WHISPER_COMPUTE="int8"
  .\.venv\Scripts\python scripts\transcribe.py sample.wav
  ```
  이 경우 GPU 런타임 문제이므로 `nvidia-cublas-cu12 nvidia-cudnn-cu12` 재설치 또는 드라이버 업데이트.

## 4. .env 확인

`DISCORD_TOKEN`, `NOTION_KEY`, `BJ_NOTION_DATABASE_ID`, `NOTION_USER_MAPPING` 이 채워져 있어야 한다.
(`GEMINI_API_KEY`는 더 이상 필요 없음. `ANTHROPIC_API_KEY`도 불필요 — `claude` CLI가 기존 로그인 사용.)

선택: `claude` 실행이 안 되면 `.env`에 절대경로 지정
```
CLAUDE_BIN=C:\Users\dldms\AppData\Roaming\npm\claude.cmd
```

## 5. 바탕화면 실행 아이콘 만들기

1. 파일 탐색기에서 `C:\Users\dldms\bookjob-ai-bot\start-bot.bat` 우클릭
2. **보내기 → 바탕 화면(바로 가기 만들기)**
3. 바탕화면의 바로가기 이름을 `회의봇 시작` 등으로 변경
4. (선택) 바로가기 우클릭 → 속성 → 아이콘 변경

이제 회의 전에 이 아이콘을 더블클릭하면 봇이 켜지고,
회의 종료(`/회의종료`) 후 약 10분이 지나면 봇이 스스로 종료된다.
(깜빡하고 안 껐어도 3시간 유휴 시 자동 종료)

## 운영 메모

- 매주 반복이면: 아이콘 더블클릭 → `/회의시작` → 회의 → `/회의종료` → 노션 확인 → 창은 알아서 닫힘
- 처리 순서: 사람별 음성 트랙 각각 전사(GPU) → 시간순 병합 → `claude -p`로 요약 → 노션 업로드
- 전사/요약 로그는 봇 콘솔 창에 실시간 출력됨
