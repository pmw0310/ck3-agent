# CK3 제미나이 에이전트 (CK3 Gemini Agent)

**Crusader Kings III(CK3)** 세이브 파일(`.ck3`)과 본편·활성 모드 스크립트(Clausewitz VFS 병합 기준)를 로컬 SQLite + 벡터 DB(`sqlite-vec`)로 교차 분석하여 환각 없는 맞춤형 전략 조언을 제공하는 데스크톱 온디맨드 AI 에이전트입니다.

---

## 주요 기능

- **자동 경로 탐색 & 버전/플레이세트 감시 (`pathDetector`, `versionWatcher`)**
   - CK3 문서 폴더(`Documents/Paradox Interactive/Crusader Kings III`), Steam 설치 경로, Steam 창작마당(`1158310`) 경로를 자동으로 탐지합니다.
   - 앱 시작 시 `launcher-settings.json`(본편 버전), `launcher-v2.sqlite`(활성 플레이세트), `dlc_load.json` 로드 순서 및 `.mod` 파일 버전/`mtime` 해시를 대조하여 변경 내역 배너를 표시합니다.
- **Clausewitz VFS 모드 병합 & 로컬 CPU 임베딩 인덱싱 (`indexWorker`)**
   - 본편 `game/` 스크립트 위에 활성 모드를 로드 순서 및 `replace_path` 규칙에 따라 덮어쓰고, 한글(`l_korean`) 및 영문(`l_english`) 로컬라이제이션을 결합합니다.
   - `jomini` WASM 파서와 `@huggingface/transformers`(`onnxruntime-node`) 다국어 임베딩 모델을 사용해 API 비용 없이 로컬 `sqlite-vec` 벡터 인덱스를 구축합니다.
- **초고속 대용량 `.ck3` 세이브 스트리밍 파싱 (`saveWorker`)**
   - 수백 MB 규모의 `gamestate`를 `node-stream-zip` 스트림으로 압축 해제하고 핵심 섹션만 추출해 `jomini` 배치 파싱 후 `save_state.db`에 수 초 내 적재합니다.
- **`@google/genai` 실시간 SSE 스트리밍 & 듀얼 자문 모드**
   - `세이브 판세 분석` 모드와 세이브 탐색 없이 빠르게 문답하는 `일반 질문 · 현인` 모드를 지원하며, 다중 채팅방 분기와 대화방 간 맥락 기억(`recallPastConversations`)을 제공합니다.
   - 무료 Microsoft Edge 신경망 TTS 및 제미나이 전용 TTS 음성 낭독과 `html-to-image` 고해상도 답변 이미지 캡처·복사를 지원합니다.
- **완전 포터블 `./data` 격리 아키텍처**
   - SQLite DB(`game_index.db`, `save_state.db`), `safeStorage` 암호화 API 키, 채팅 세션, TTS 캐시, 로컬 ONNX 모델 캐시 모두 `./data` 폴더에 격리됩니다.

---

## 실행 및 패키징 명령어

```bash
# 의존성 설치 (pnpm + node-linker=hoisted)
pnpm install
pnpm run rebuild

# 개발 모드 실행
pnpm run dev

# TypeScript 타입 검증, 프로덕션 번들 빌드 및 테스트
pnpm run typecheck
pnpm run build
pnpm test

# 무설치 포터블 배포 빌드 (dist/ 폴더에 zip 및 unpacked 생성)
pnpm run pack:win
```

---

## 라이선스 (License)

본 프로젝트는 **CC BY-NC-SA 4.0** (저작자표시-비상업-동일조건변경허락 4.0 국제) 라이선스를 따릅니다. 자세한 내용은 [LICENSE](./LICENSE) 파일을 참고하세요.
