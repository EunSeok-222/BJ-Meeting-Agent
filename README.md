# NoteFlow AI (Discord to Notion)

> **디스코드 음성 회의를 수집해 사람별로 전사(faster-whisper)한 뒤, Claude(`claude` CLI)로 요약하여 노션 데이터베이스에 자동 기록하는 에이전트입니다.**

"북잡(Bookjob)" 팀의 생산성을 높이기 위해 개발되었으며, 긴 회의 중 발생하는 사담을 필터링하고 핵심 액션 플랜을 도출하는 데 최적화되어 있습니다.
<img width="800" height="450" alt="Video Project 1 (1)" src="https://github.com/user-attachments/assets/ce892e0c-071a-40c7-84a5-28b8c626fb57" />

---

## 처리 파이프라인

```
/회의시작  → 음성 채널 입장 → 발화자별로 각각 PCM 트랙 저장
/회의종료  → 트랙별 PCM → 16kHz mono WAV 변환
           → faster-whisper(GPU)로 트랙별 전사
           → 세그먼트를 시간순으로 병합 → "[이름] 발화" 형태 전사본
           → claude CLI(`claude -p`)로 요약(사담 필터 + 담당자별 할 일)
           → 노션 페이지 생성 (마크다운 → 블록, 참석자 매핑, 카테고리 분류)
```

화자를 **디스코드 신원으로 확정**하므로(트랙 분리 전사), 섞인 음성에서 화자를 추측하던 이전 방식보다 담당자별 정리가 정확합니다.

### 긴 회의(2~3시간) 대응
- 발화 조각(1초 침묵마다 분리)을 **화자별로 하나의 트랙으로 이어붙인 뒤** 전사 → 전사 대상이 수천 개가 아니라 참석자 수(2~6개). 조각 사이 실제 침묵은 각 조각의 epoch을 앵커로 유지해 전역 시간축 복원.
- 전사가 끝나면 전사본이 확보된 시점에 **원본/임시 파일을 정리**하고, 이후 요약·노션 단계가 실패해도 `/회의정리재시도`로 재전사 없이 복구.
- 요약 블록이 100개를 넘으면 노션에 **나눠서 append**(잘림 방지). 처리가 15분을 넘겨 상호작용 토큰이 만료되면 채널 메시지로 최종 결과를 남김.
- 음성 연결이 순간 끊기거나 채널을 옮긴 경우는 재수립을 시도하고, 진짜 끊긴 경우에만 기록을 중단하며 채널에 알림.

## 주요 기능
* **발화자별 트랙 녹음**: 디스코드 음성 채널의 유저별 스트림을 각각 PCM으로 저장.
* **로컬 GPU 전사**: `faster-whisper` `large-v3-turbo` + 배치 파이프라인을 CUDA로 구동. 외부 전송 없이 로컬에서 전사.
* **진행 상황 표시**: `/회의종료` 처리 중 전사·요약·업로드 단계를 메시지로 실시간 갱신.
* **Claude 요약**: `claude` CLI 헤드리스 호출(`claude -p --output-format json`). 별도 API 키 불필요(기존 Claude Code 인증 사용).
* **사담 필터링**: 프롬프트로 안부 인사·농담 등 제외. 발언 기록 없는 사람은 담당자 정리에서 자동 제외.
* **노션 연동**: 요약 마크다운을 파싱(볼드/헤딩/리스트)하여 블록 단위로 업로드.
* **참석자 자동 매핑**: 디스코드 참여자를 노션 사용자(Attendees)에 연결.
* **카테고리 자동 분류**: 참석 인원에 따라 `전체 회의` / `프론트 회의` / `백엔드 회의` 판별.
* **자동 종료**: 회의 처리 완료 후 약 10분 뒤 봇 프로세스 자동 종료(유휴 3시간 안전장치 포함).

## NoteFlow AI — 시스템 아키텍처
<img alt="NoteFlow AI 시스템 아키텍처" src="docs/architecture.svg" width="720" />

## 기술 스택
* **Runtime**: Node.js, Python (가상환경 `.venv`)
* **Library**: `discord.js`, `@discordjs/voice`, `prism-media`
* **STT**: `faster-whisper` (CTranslate2 / CUDA)
* **AI 요약**: `claude` CLI (Claude Code)
* **Tools**: `FFmpeg` (via `ffmpeg-static`), `@notionhq/client`

## 프로젝트 구조
```
bookjob-ai-bot/
├── index.js                          # 엔트리 포인트 (봇 초기화 및 이벤트 바인딩)
├── start-bot.bat                     # 바탕화면 더블클릭 실행용 런처
├── scripts/
│   ├── setup.md                      # 최초 1회 세팅 가이드
│   ├── transcribe.py                 # faster-whisper 래퍼 (WAV → 세그먼트 JSON)
│   └── recover.js                    # 봇이 꺼진 뒤 recordings/ 잔여 조각으로 회의 복구
├── test/                             # node:test 순수 함수 스위트
├── src/
│   ├── lifecycle.js                  # 자동 종료 타이머
│   ├── config/
│   │   ├── clients.js                # 외부 클라이언트 초기화 (Notion, ffmpeg)
│   │   └── commands.js               # 디스코드 슬래시 커맨드 정의 및 등록
│   ├── handlers/
│   │   └── interaction.handler.js    # 슬래시 커맨드 처리
│   ├── services/
│   │   ├── audio.service.js          # PCM → WAV 변환
│   │   ├── transcribe.service.js     # 트랙별 전사 + 시간순 병합
│   │   ├── claude.service.js         # claude CLI 요약 요청
│   │   ├── notion.service.js         # 노션 페이지 생성 및 마크다운 파싱
│   │   └── pipeline.js               # 전사→요약→노션 처리 (커맨드·종료 훅·복구 공용)
│   └── state.js                      # 참석자 목록 등 런타임 상태 관리
├── .env                              # 환경 변수 (Git 미추적)
└── .gitignore
```

## 설치 및 실행

**최초 1회 세팅은 [`scripts/setup.md`](scripts/setup.md) 참고** (Node 의존성 + Python 가상환경 + faster-whisper + 바탕화면 아이콘).

### 환경 변수 (`.env`)
```env
DISCORD_TOKEN=your_discord_bot_token
NOTION_KEY=your_notion_integration_token
BJ_NOTION_DATABASE_ID=your_notion_database_id
NOTION_USER_MAPPING={"이름":"노션_유저_ID", ...}

# --- 선택 ---
# NOTION_USER_ID_MAPPING={"디스코드_userId":"노션_유저_ID", ...}   # 이름보다 우선 적용, 표시명 바뀌어도 안전
# DISCORD_NAME_MAPPING={"디스코드_userId":"표시명", ...}          # 회의록에 쓸 화자 이름 강제 (닉네임이 "Peng"이어도 "김영철"로)
# CLAUDE_BIN=C:\Users\<사용자>\AppData\Roaming\npm\claude.cmd     # claude 실행이 안 될 때만
# AUTO_EXIT_MINUTES=10        # 회의 처리 후 자동 종료까지 대기(분). 0이면 자동 종료 안 함
# SAFETY_IDLE_HOURS=3         # 유휴 상태 이 시간 지나면 종료. 0이면 안전 타이머 끔
# WHISPER_MODEL=large-v3-turbo  # 정확도 최우선이면 large-v3
# WHISPER_BATCH=8            # 배치 전사 크기. 0이면 단일 모드
# WHISPER_DEVICE=cpu / WHISPER_COMPUTE=int8   # GPU 문제 시 CPU 폴백
# WHISPER_TIMEOUT_MIN=120    # 전사 프로세스 안전 타임아웃(분)
# CLAUDE_TIMEOUT_MIN=10      # claude CLI 요약 호출 타임아웃(분). 긴 회의는 늘리기
```
| 변수 | 설명 |
|:---|:---|
| `DISCORD_TOKEN` | 디스코드 봇 토큰 |
| `NOTION_KEY` | 노션 내부 통합(Integration) 토큰 |
| `BJ_NOTION_DATABASE_ID` | 회의록을 저장할 노션 데이터베이스(Data Source) ID |
| `NOTION_USER_MAPPING` | 팀원 **이름** → 노션 User ID JSON |
| `NOTION_USER_ID_MAPPING` | (선택) 디스코드 **userId** → 노션 User ID JSON. 이름 매핑보다 우선 |
| `DISCORD_NAME_MAPPING` | (선택) 디스코드 **userId** → 표시명 JSON. 전사본·요약·복구에서 이 이름을 강제(디스코드 닉네임보다 우선) |
| `CLAUDE_BIN` | (선택) `claude` 실행 파일 절대경로 |
| `AUTO_EXIT_MINUTES` / `SAFETY_IDLE_HOURS` | (선택) 자동 종료/안전 타이머 시간 |
| `WHISPER_MODEL` / `WHISPER_BATCH` / `WHISPER_DEVICE` / `WHISPER_COMPUTE` | (선택) 전사 엔진 튜닝 |
| `WHISPER_TIMEOUT_MIN` / `CLAUDE_TIMEOUT_MIN` | (선택) 전사·요약 타임아웃(분) |

> `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` 는 필요 없습니다. 요약은 로컬에 로그인된 `claude` CLI가 처리합니다.

### 실행
- **평상시**: 바탕화면 `회의봇 시작` 아이콘(= `start-bot.bat`) 더블클릭
- **터미널**: `npm start`

## 슬래시 커맨드

| 커맨드 | 설명 |
|:---|:---|
| `/회의시작` | 음성 채널에 입장하여 회의 녹음을 시작합니다. |
| `/회의종료` | 녹음을 종료하고 전사·AI 요약본을 생성하여 노션에 저장합니다. |
| `/회의정리재시도` | 요약/노션 전송이 실패했을 때 보존된 전사본으로 다시 시도합니다. |
| `/노션재전송` | 마지막으로 생성된 요약본을 노션으로 다시 전송합니다. |
| `/노션저장` | 입력한 텍스트를 직접 노션 회의록에 저장합니다. |
| `/봇종료` | 봇을 종료합니다. **정리 안 한 회의가 있으면 전사·요약·노션 업로드 후** 종료합니다. |

`/회의종료` 처리 중에는 "전사 중 (n/트랙) → AI 요약 중 → 노션 업로드 중" 진행 상황이 메시지에 실시간 표시됩니다.

### `/회의종료`를 깜빡했다면
- **`/봇종료`** 또는 콘솔에서 **Ctrl+C** → 남은 녹음을 자동으로 정리(전사→요약→노션)한 뒤 종료합니다.
- 콘솔 창을 **X로 닫으면** OS가 즉시 프로세스를 죽여 정리가 안 될 수 있습니다. 그 경우 다시 켜지 말고 **`node scripts/recover.js`** 를 실행하면 `recordings/` 에 남은 조각으로 복구합니다.

## 테스트

의존성 없이 Node 내장 러너(`node:test`)를 사용합니다.

```bash
npm test        # node --test  (test/ 자동 탐색)
```

순수 로직만 커버합니다 (Discord 음성 / 실제 whisper / 실제 Notion API 호출은 수동 검증 영역):

| 파일 | 검증 |
|:---|:---|
| `test/transcribe.service.test.js` | 파일명 파싱, 조각 오프셋 계산, 트랙 사이 침묵의 시각 환산, 세그먼트 시간순 병합·화자 dedup |
| `test/notion.service.test.js` | 마크다운→블록, 표→table 블록(구분선 스킵·셀 패딩), 볼드 분리·2000자 청킹, 카테고리 분류, 참석자 매핑(userId 우선·중복 제거) |
| `test/claude.service.test.js` | 프롬프트 구성, 인증 오류 패턴 감지, CLI JSON 응답 파싱(`is_error`·인증 오류·파싱 실패) |
| `test/lifecycle.test.js` | 자동 종료/안전 타이머 env 파싱 (명시적 0 = 비활성) |

## 트러블슈팅

### PCM 포맷 처리
디스코드 PCM은 헤더가 없어 FFmpeg에 입력 옵션(`-f s16le -ar 48000 -ac 2`)을 강제로 주어 16kHz mono WAV로 변환한 뒤 전사합니다.

### faster-whisper / CUDA
`WhisperModel(..., device="cuda", compute_type="float16")` + `BatchedInferencePipeline`(batch_size=8)로 트랙별 전사. 기본 모델은 `large-v3-turbo`(large-v3와 정확도 비슷, 2~4배 빠름).

- CUDA 런타임 DLL은 `transcribe.py`가 `.venv\...\nvidia\*\bin` 을 `os.add_dll_directory`로 자동 등록.
- HF 모델 다운로드 시 Windows 심볼릭 링크 권한 오류(WinError 1314)를 피하려고 `HF_HUB_DISABLE_SYMLINKS=1` 설정.
- 그래도 GPU가 안 되면 `WHISPER_DEVICE=cpu WHISPER_COMPUTE=int8`(느림). 정확도 최우선이면 `WHISPER_MODEL=large-v3`.

### claude CLI 호출
`execFile('claude', ['-p','--output-format','json'])` + 프롬프트는 stdin으로 전달(긴 전사본의 명령행 길이 제한 회피). Windows에서는 `shell: true`로 `claude.cmd`를 실행. 실패 시 지수 백오프로 3회 재시도.

### 노션 API 마크다운 파싱
2,000자 제한과 서식 미지원을 해결하기 위해 요약본을 줄 단위로 파싱하여 헤딩(`##`), 볼드(`**`), 불릿(`- `, `* `)을 노션 블록으로 변환합니다. 연속된 `| ... |` 줄은 노션 `table` 블록으로 묶어 변환하며(구분선 자동 스킵, 첫 행을 헤더로), 담당자별 할 일이 표로 렌더됩니다.

### 노션 SDK 호환성 (v5.x)
`data_source` 개념 도입으로 `database_id` 기반 페이지 생성이 동작하지 않아 `notion.request` 저수준 호출로 전환했습니다.

---

## 변경 이력

### 2026-08 · Gemini → Claude 전환 + 로컬 실행
- **AI 요약 엔진 교체**: Gemini 2.5 Flash 멀티모달 1회 호출 → `claude` CLI 헤드리스(`claude -p --output-format json`, 프롬프트는 stdin). 별도 API 키·과금 없이 기존 Claude Code 인증 사용.
- **음성→텍스트 분리**: Claude는 오디오 입력이 안 되므로 전사 단계를 로컬 `faster-whisper`로 분리. 음성 원본은 로컬에만 남고 Claude에는 텍스트만 전달.
- **화자 구분**: 섞인 음성 추측 → 디스코드 화자별 트랙을 각각 전사 후 시간순 병합(`[이름] 발화`). 신원이 디스코드 ID로 확정됨.
- **실행 방식**: 공기계 상시 구동 → 내 PC + `start-bot.bat` 더블클릭. 회의 처리 후 자동 종료(+유휴 안전 타이머), `/봇종료` 커맨드.
- 정리: `gemini.service.js` / `message.handler.js` 삭제, `@google/generative-ai` 의존성 제거, `message` 인텐트 제거.

### 2026-08 · 성능·편의 개선
- **전사 속도**: 모델 `large-v3` → `large-v3-turbo` + `BatchedInferencePipeline` (정확도 유지, 2~4배 빠름). `WHISPER_MODEL` / `WHISPER_BATCH` 로 되돌리기 가능.
- **진행 상황 표시**: `/회의종료` 처리 중 전사(n/화자) → 요약 → 노션 업로드 단계를 메시지로 실시간 갱신.
- **노션 표**: 요약의 마크다운 표를 노션 `table` 블록으로 변환(구분선 스킵, 첫 행 헤더).
- **안정성**: `claude` CLI 인증/크레딧 오류를 감지해 재시도 없이 안내. `NOTION_USER_ID_MAPPING`(디스코드 userId 기준)으로 표시명이 바뀌어도 참석자 연결 유지. `AUTO_EXIT_MINUTES` / `SAFETY_IDLE_HOURS` 를 `.env`로 조정(0이면 비활성).
- Windows 이슈 해결: `.bat` 인코딩(ASCII+CRLF), CUDA DLL 경로 등록(`os.add_dll_directory`), Python stdout UTF-8 고정, HF 심볼릭 링크 비활성화.

### 2026-08 · 긴 회의(2~3시간) 대응 + 테스트
- **화자별 트랙 병합**: 발화 조각(1초 침묵마다 분리)을 화자별 1트랙으로 이어붙인 뒤 전사 → 전사 대상이 수천 개 → 참석자 수(2~6). 명령행 길이 초과·프로세스 스팸·타임아웃 위험 제거. 조각 사이 실제 침묵은 각 조각의 epoch을 앵커로 전역 시간축 복원.
- **손실 방지**: 전사본이 확보된 시점에 원본/임시 파일 정리 → 이후 요약·노션 단계가 실패해도 `/회의정리재시도`로 재전사 없이 복구. `transcribe.py`는 파일 단위 예외 처리로 한 트랙 실패가 전체를 죽이지 않음.
- **노션 블록 분할**: 요약 블록이 100개를 넘으면 `PATCH children`로 나눠 append(잘림 방지).
- **Discord 한계 대응**: 처리가 15분을 넘겨 상호작용 토큰이 만료되면 채널 메시지로 최종 결과를 남김. 음성 연결이 순간 끊기거나 채널 이동한 경우는 재수립을 시도하고 진짜 끊김만 중단.
- **타임아웃 env화**: `WHISPER_TIMEOUT_MIN`(기본 120), `CLAUDE_TIMEOUT_MIN`(기본 10).
- **테스트 도입**: `node:test` 기반 순수 함수 스위트. `npm test`.

### 2026-09 · 종료 시 자동 정리 + 복구 스크립트
- **`/봇종료` / Ctrl+C 종료 시**, `/회의종료`를 안 했더라도 `recordings/` 에 남은 녹음을 전사→요약→노션 업로드한 뒤 종료. 처리 파이프라인을 `src/services/pipeline.js` 로 추출해 `/회의종료`·`/봇종료`·SIGINT 훅·복구 스크립트가 공유.
- **`scripts/recover.js`**: 봇이 이미 꺼진 상태에서 `recordings/` 잔여 조각으로 회의를 복구. 화자 이름은 `.env` 의 `DISCORD_NAME_MAPPING` 으로 해석.
- **참석자 매핑 강화**: `.env` 에 `NOTION_USER_ID_MAPPING`(디스코드 userId→노션 ID) 추가 — 표시명이 바뀌어도 안 흔들림, 이름 매핑보다 우선.

---

## Author
**이은석 (Frontend Developer)** "북잡(Bookjob)" 서비스의 프론트엔드 리드로서 팀의 개발 문화와 생산성 도구를 고민합니다.

---
