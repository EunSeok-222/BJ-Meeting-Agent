# 🎙️ Bookjob AI Scribe (Discord to Notion)

> **디스코드 음성 회의를 실시간으로 수집하고, Gemini 2.5 Flash를 이용해 요약한 뒤 노션 데이터베이스에 자동으로 기록하는 에이전트입니다.**

"북잡(Bookjob)" 팀의 생산성을 높이기 위해 개발되었으며, 긴 회의 중 발생하는 사담을 필터링하고 핵심 액션 플랜을 도출하는 데 최적화되어 있습니다.

---

## 🚀 주요 기능
* **음성 수집 및 병합**: 디스코드 음성 채널의 유저별 스트림을 PCM으로 저장 후 자동 병합.
* **고효율 오디오 압축**: FFmpeg를 사용하여 대용량 오디오를 MP3(64kbps)로 압축, 업로드 속도 최적화.
* **Gemini 2.5 Flash 분석**: 100만 토큰 이상의 컨텍스트 윈도우를 활용해 1~2시간의 긴 회의도 한 번에 요약.
* **사담 필터링 로직**: 프롬프트 엔지니어링을 통해 안부 인사, 농담 등 불필요한 대화 제외.
* **노션 데이터베이스 연동**: 요약된 내용을 주제, 결정사항, 담당자별 할 일(Table) 형식으로 자동 업로드.

## 🛠️ 기술 스택
* **Runtime**: Node.js
* **Library**: `discord.js`, `@discordjs/voice`, `prism-media`
* **AI**: `Google Generative AI (Gemini)`, `Google AI File Manager`
* **Tools**: `FFmpeg` (via `ffmpeg-static`), `Notion SDK`

## 📦 설치 및 실행

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
```

### 3. 실행
```bash
node index.js
```

## 💡 개발 중 직면한 과제 (Troubleshooting)

### PCM 포맷 처리 문제
디스코드에서 나오는 순수 PCM 데이터는 헤더가 없어 일반적인 플레이어에서 읽을 수 없었습니다. 이를 해결하기 위해 `fs`로 바이너리 데이터를 직접 병합한 뒤, FFmpeg에 강제로 입력 옵션(`-f s16le`, `-ar 48000`)을 주어 MP3로 변환하는 방식을 택했습니다.

### 대용량 오디오 메모리 이슈
1시간 이상의 회의 파일은 Base64로 전송 시 서버 메모리 부족(OOM)을 일으킵니다. 이를 방지하기 위해 `GoogleAIFileManager`를 사용하여 파일을 클라우드 스토리지에 업로드하고 URI 방식으로 제미나이에게 전달하여 안정성을 확보했습니다.

### 노션 API 글자 수 제한
노션 블록의 2,000자 제한을 고려하여, 요약본이 길어질 경우 자동으로 텍스트를 슬라이싱하고 생략 알림을 추가하는 예외 처리를 구현했습니다.

---

## 👨‍💻 Author
**이은석 (Frontend Developer)** "북잡(Bookjob)" 서비스의 프론트엔드 리드로서 팀의 개발 문화와 생산성 도구를 고민합니다.

---
