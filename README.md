# Bookjob AI Scribe (Discord to Notion)

> **디스코드 음성 회의를 실시간으로 수집하고, Gemini 1.5 Flash를 이용해 요약한 뒤 노션 데이터베이스에 자동으로 기록하는 에이전트입니다.**

"북잡(Bookjob)" 팀의 생산성을 높이기 위해 개발되었으며, 긴 회의 중 발생하는 사담을 필터링하고 핵심 액션 플랜을 도출하는 데 최적화되어 있습니다.

---

## 주요 기능
* **음성 수집 및 병합**: 디스코드 음성 채널의 유저별 스트림을 PCM으로 저장 후 자동 병합.
* **고효율 오디오 압축**: FFmpeg를 사용하여 대용량 오디오를 MP3(64kbps)로 압축, 업로드 속도 최적화.
* **Gemini 1.5 Flash 분석**: 100만 토큰 이상의 컨텍스트 윈도우를 활용해 1~2시간의 긴 회의도 한 번에 요약.
* **사담 필터링 로직**: 프롬프트 엔지니어링을 통해 안부 인사, 농담 등 불필요한 대화 제외. 미참석자는 요약 표에서 자동 제외.
* **노션 데이터베이스 연동**: 요약 내용을 마크다운 파싱(볼드, 헤딩, 리스트, 표 등) 후 블록 단위로 변환하여 노션에 업로드.
* **참석자 자동 매핑**: 디스코드 참여자를 노션 사용자(Attendees)에 자동으로 연결.
* **카테고리 자동 분류**: 참석 인원에 따라 `전체 회의`, `프론트 회의`, `백엔드 회의`를 자동으로 판별.

## 기술 스택
* **Runtime**: Node.js
* **Library**: `discord.js`, `@discordjs/voice`, `prism-media`
* **AI**: `Google Generative AI (Gemini 1.5 Flash)`, `Google AI File Manager`
* **Tools**: `FFmpeg` (via `ffmpeg-static`), `@notionhq/client`

## 프로젝트 구조
```
bookjob-ai-bot/
├── index.js                          # 엔트리 포인트 (봇 초기화 및 이벤트 바인딩)
├── src/
│   ├── config/
│   │   ├── clients.js                # 외부 API 클라이언트 초기화 (Gemini, Notion)
│   │   └── commands.js               # 디스코드 슬래시 커맨드 정의 및 등록
│   ├── handlers/
│   │   ├── interaction.handler.js    # 슬래시 커맨드 처리 (회의시작/종료/노션재전송)
│   │   └── message.handler.js        # 채팅 메시지 처리
│   ├── services/
│   │   ├── audio.service.js          # PCM 병합 및 FFmpeg 변환
│   │   ├── gemini.service.js         # Gemini API 요약 요청
│   │   └── notion.service.js         # 노션 페이지 생성 및 마크다운 파싱
│   └── state.js                      # 참석자 목록 등 런타임 상태 관리
├── .env                              # 환경 변수 (Git 미추적)
└── .gitignore
```

## 설치 및 실행

### 1. 필수 의존성 설치
본 프로젝트는 음성 처리를 위해 `ffmpeg`가 필요합니다. `ffmpeg-static`을 포함하고 있으므로 별도의 설치 없이 구동 가능합니다.
```bash
npm install
```

### 2. 환경 변수 설정 (`.env`)
```env
DISCORD_TOKEN=your_discord_bot_token
GEMINI_API_KEY=your_google_ai_api_key
NOTION_KEY=your_notion_integration_token
BJ_NOTION_DATABASE_ID=your_notion_database_id
NOTION_USER_MAPPING={"이름":"노션_유저_ID", ...}
```
| 변수 | 설명 |
|:---|:---|
| `DISCORD_TOKEN` | 디스코드 봇 토큰 |
| `GEMINI_API_KEY` | Google AI Studio에서 발급한 Gemini API 키 |
| `NOTION_KEY` | 노션 내부 통합(Integration) 토큰 |
| `BJ_NOTION_DATABASE_ID` | 회의록을 저장할 노션 데이터베이스(Data Source) ID |
| `NOTION_USER_MAPPING` | 팀원 이름과 노션 User ID를 매핑하는 JSON 문자열 |

### 3. 실행
```bash
node index.js
```

## 슬래시 커맨드

| 커맨드 | 설명 |
|:---|:---|
| `/회의시작` | 음성 채널에 입장하여 회의 녹음을 시작합니다. |
| `/회의종료` | 녹음을 종료하고 AI 요약본을 생성하여 노션에 저장합니다. |
| `/노션재전송` | 마지막으로 생성된 요약본을 노션으로 다시 전송합니다. |
| `/노션저장` | 입력한 텍스트를 직접 노션 회의록에 저장합니다. |

## 개발 중 직면한 과제 (Troubleshooting)

### PCM 포맷 처리 문제
디스코드에서 나오는 순수 PCM 데이터는 헤더가 없어 일반적인 플레이어에서 읽을 수 없었습니다. 이를 해결하기 위해 `fs`로 바이너리 데이터를 직접 병합한 뒤, FFmpeg에 강제로 입력 옵션(`-f s16le`, `-ar 48000`)을 주어 MP3로 변환하는 방식을 택했습니다.

### 대용량 오디오 메모리 이슈
1시간 이상의 회의 파일은 Base64로 전송 시 서버 메모리 부족(OOM)을 일으킵니다. 이를 방지하기 위해 `GoogleAIFileManager`를 사용하여 파일을 클라우드 스토리지에 업로드하고 URI 방식으로 제미나이에게 전달하여 안정성을 확보했습니다.

### 노션 API 마크다운 파싱
노션 블록의 2,000자 제한과 서식 미지원 문제를 해결하기 위해, AI 요약본을 줄 단위로 파싱하여 헤딩(`###`), 볼드(`**`), 불릿 리스트(`- `, `* `), 표(`|`) 등을 각각의 노션 블록 타입으로 변환하는 커스텀 마크다운 파서를 구현했습니다.

### 노션 SDK 호환성 (v5.x 대응)
노션 SDK v5에서 `databases.query` 함수가 제거되고 `data_source` 개념이 도입되면서, 기존 `database_id` 기반의 페이지 생성이 동작하지 않는 문제를 발견했습니다. `notion.request`를 사용한 저수준 API 호출로 전환하여 해결했습니다.

---

## Author
**이은석 (Frontend Developer)** "북잡(Bookjob)" 서비스의 프론트엔드 리드로서 팀의 개발 문화와 생산성 도구를 고민합니다.

---
