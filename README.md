# MidiMoter — 4채널 스텝모터 오케스트라

Arduino Uno + CNC Shield V3 + A4988 × 4 + NEMA17 × 4 하드웨어를 웹 브라우저(`Web Serial API`)로 제어해, MIDI 파일 및 유튜브·오디오 음원을 4성부 화음으로 연주하는 프로젝트입니다.

---

## 주요 기능

- **웹 컨트롤러 (`web/`)**: 별도 빌드 없이 Chrome/Edge에서 `web/index.html` 바로 실행
  - `Web Serial API` (115200 bps) 실시간 4채널 연주 및 4축 자체 테스트
  - 4채널 피아노 롤(Piano Roll) 실시간 시각화 및 클릭 구간 이동
  - 표준 MIDI(`.mid`) 파싱, 트랙별 수동 축 매핑, 스마트 4성부 분배(반음 충돌 제거 + Voice Locking)
  - 옥타브 시프트, 고음 상한(`C6 / E6 / G6 / 제한 없음`), 스타카토 간격, 실시간 잡음 컷(길이/강도)
  - 브라우저 미리듣기(`Web Audio API`), 가상 건반, Arduino Uno 단독 실행 `.ino` 내보내기
- **아두이노 펌웨어 (`MidiMoter_4Axis/MidiMoter_4Axis.ino`)**
  - Timer1 20kHz CTC 인터럽트 + 32비트 DDS + 포트 레지스터 직접 제어
  - 무음 2초 유지 시 드라이버 자동 비활성화(발열 보호)
- **로컬 AI 변환 서버 (`backend/`, 선택 사항)**
  - `FastAPI` + `yt-dlp` + `librosa` HPSS 드럼 제거 + `Demucs` AI 악기 분리 + `basic-pitch` ONNX
  - 유튜브 URL 또는 MP3/WAV 파일을 4트랙 표준 MIDI로 자동 변환

---

## 하드웨어 핀맵 (CNC Shield V3 기준)

| 채널 (축) | 역할 | STEP | DIR | 비고 |
| :---: | :--- | :---: | :---: | :--- |
| CH 0 (X) | 주멜로디 / 보컬 | D2 | D5 | 독립 제어 |
| CH 1 (Y) | 화음 1 | D3 | D6 | 독립 제어 |
| CH 2 (Z) | 화음 2 | D4 | D7 | 독립 제어 |
| CH 3 (A) | 베이스 | D12 | D13 | CNC Shield `D12/D13` 독립 점퍼 설정 |
| ENABLE | 공통 활성 | D8 | - | `LOW` = 활성 / `HIGH` = 비활성 |

---

## 실행 방법

### 1. 아두이노 펌웨어 업로드 (1회)
1. Arduino IDE에서 `MidiMoter_4Axis/MidiMoter_4Axis.ino`를 열어 Arduino Uno에 업로드합니다. (추가 라이브러리 불필요)

### 2. 웹 컨트롤러 실행
1. Chrome 또는 Edge에서 `web/index.html`을 엽니다.
2. 상단 `[시리얼 연결]`로 포트를 연결하고, 내장 곡·가상 건반·`.mid` 파일을 재생합니다.

### 3. 로컬 AI 변환 서버 실행 (유튜브 / MP3 변환 사용 시)
```bash
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
start_server.bat
```
서버 실행(`http://127.0.0.1:8765`) 후 웹 페이지에서 유튜브 URL 또는 오디오 파일을 바로 4트랙 MIDI로 변환할 수 있습니다.
