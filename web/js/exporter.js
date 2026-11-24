/**
 * 아두이노 단독 실행용 .ino 스케치 생성 및 다운로드 모듈
 * - 현재 4성부 타임라인을 Arduino Uno Flash(PROGMEM)에 맞는 경량 구조체 배열로 변환
 * - PC 시리얼 연결 없이 전원만 넣으면 4개 스텝모터로 즉시 연주되는 독립 스케치 출력
 */
(function (global) {
  const { midiToFreq } = window.MidiParser;

  // Arduino Uno Flash(32KB) 안전 한도: 펌웨어 코드 약 5KB 제외 -> 최대 약 2,400 이벤트 (10바이트/이벤트 = 24KB)
  const MAX_UNO_EVENTS = 2400;

  /**
   * 4채널 프레임 배열 -> (durMs, f0, f1, f2, f3) 시퀀스 배열 생성
   */
  function buildArduinoEvents(frames, durationMs, options = {}) {
    const transpose = options.transpose || 0;
    const microstepMult = options.microstepMult || 1;
    const speed = options.speed || 1.0;
    const channelMuted = options.channelMuted || [false, false, false, false];

    const events = [];
    for (let i = 0; i < frames.length; i++) {
      const cur = frames[i];
      const nextTime = i + 1 < frames.length ? frames[i + 1].timeMs : durationMs;
      let durMs = Math.round((nextTime - cur.timeMs) / speed);
      if (durMs <= 0) continue;

      const freqs = [0, 0, 0, 0];
      for (let ch = 0; ch < 4; ch++) {
        const rawNote = cur.notes[ch];
        if (rawNote > 0 && !channelMuted[ch]) {
          const shifted = Math.max(24, Math.min(96, rawNote + transpose));
          const hz = Math.min(10000, midiToFreq(shifted) * microstepMult);
          freqs[ch] = Math.round(hz); // Flash 절약을 위해 1Hz 단위 uint16_t 저장
        }
      }

      // uint16_t 최대값(65535ms) 초과 시 분할
      while (durMs > 60000) {
        events.push({ dur: 60000, freqs });
        durMs -= 60000;
      }
      events.push({ dur: durMs, freqs });
    }

    return events;
  }

  /**
   * 독립 실행형 Arduino Uno .ino 소스 코드 문자열 생성
   */
  function generateStandaloneIno(song, options = {}) {
    const allEvents = buildArduinoEvents(song.frames, song.durationMs, options);
    const truncated = allEvents.length > MAX_UNO_EVENTS;
    const events = truncated ? allEvents.slice(0, MAX_UNO_EVENTS) : allEvents;

    const rows = events.map(
      (ev) => `  { ${ev.dur}, ${ev.freqs[0]}, ${ev.freqs[1]}, ${ev.freqs[2]}, ${ev.freqs[3]} }`
    );

    const safeTitle = (song.title || 'MidiMoter_Song').replace(/[^\w가-힣\s.-]/g, '');

    const code = `/*
 * MidiMoter 단독 연주 스케치 (웹 컨트롤러 자동 생성)
 * ---------------------------------------------------------
 * 곡명: ${safeTitle}
 * 이벤트 수: ${events.length}개 (예상 PROGMEM 사용량: 약 ${((events.length * 10) / 1024).toFixed(1)} KB)${
      truncated ? `\n * ※ Arduino Uno Flash 용량 한도로 인해 앞부분 ${MAX_UNO_EVENTS}개 이벤트만 포함되었습니다.` : ''
    }
 * 하드웨어: Arduino Uno + CNC Shield V3 + A4988 x4 + NEMA17 x4
 * ※ PC 연결 없이 전원을 켜면 자동으로 4개 스텝모터가 연주합니다.
 */

#include <Arduino.h>
#include <avr/pgmspace.h>

#define X_STEP_PIN 2
#define Y_STEP_PIN 3
#define Z_STEP_PIN 4
#define A_STEP_PIN 12

#define X_DIR_PIN  5
#define Y_DIR_PIN  6
#define Z_DIR_PIN  7
#define A_DIR_PIN  13

#define ENABLE_PIN 8
#define TIMER1_OCR_VAL 799 // 16MHz / 800 = 20,000 Hz

// 1개 이벤트당 10바이트 (PROGMEM 저장)
struct NoteFrame {
  uint16_t durMs;
  uint16_t freqHz[4];
};

const uint16_t NUM_FRAMES = ${events.length};
const NoteFrame SONG_DATA[NUM_FRAMES] PROGMEM = {
${rows.join(',\n')}
};

volatile uint32_t phaseAcc[4] = { 0, 0, 0, 0 };
volatile uint32_t phaseInc[4] = { 0, 0, 0, 0 };

ISR(TIMER1_COMPA_vect) {
  uint8_t portDMask = 0;
  uint8_t portBMask = 0;

  uint32_t inc0 = phaseInc[0];
  if (inc0 > 0) {
    uint32_t p = phaseAcc[0], n = p + inc0;
    phaseAcc[0] = n;
    if (n < p) portDMask |= (1 << 2);
  }
  uint32_t inc1 = phaseInc[1];
  if (inc1 > 0) {
    uint32_t p = phaseAcc[1], n = p + inc1;
    phaseAcc[1] = n;
    if (n < p) portDMask |= (1 << 3);
  }
  uint32_t inc2 = phaseInc[2];
  if (inc2 > 0) {
    uint32_t p = phaseAcc[2], n = p + inc2;
    phaseAcc[2] = n;
    if (n < p) portDMask |= (1 << 4);
  }
  uint32_t inc3 = phaseInc[3];
  if (inc3 > 0) {
    uint32_t p = phaseAcc[3], n = p + inc3;
    phaseAcc[3] = n;
    if (n < p) portBMask |= (1 << 4);
  }

  if (portDMask || portBMask) {
    PORTD |= portDMask;
    PORTB |= portBMask;
    __builtin_avr_delay_cycles(32); // 2us 펄스폭 확보
    PORTD &= ~((1 << 2) | (1 << 3) | (1 << 4));
    PORTB &= ~(1 << 4);
  }
}

uint32_t hzToPhaseInc(uint16_t hz) {
  if (hz == 0) return 0;
  if (hz > 10000) hz = 10000;
  // 2^32 / 20000 = 214748.3648
  return (uint32_t)(((uint64_t)hz * 214748ULL));
}

void setAllFreqs(const uint16_t f[4]) {
  uint32_t inc[4];
  for (uint8_t i = 0; i < 4; i++) inc[i] = hzToPhaseInc(f[i]);
  noInterrupts();
  for (uint8_t i = 0; i < 4; i++) {
    phaseInc[i] = inc[i];
    if (inc[i] == 0) phaseAcc[i] = 0;
  }
  interrupts();
}

void stopAll() {
  uint16_t zeros[4] = { 0, 0, 0, 0 };
  setAllFreqs(zeros);
}

void setupTimer1() {
  noInterrupts();
  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1  = 0;
  OCR1A  = TIMER1_OCR_VAL;
  TCCR1B |= (1 << WGM12) | (1 << CS10);
  TIMSK1 |= (1 << OCIE1A);
  interrupts();
}

void setup() {
  pinMode(X_STEP_PIN, OUTPUT); pinMode(Y_STEP_PIN, OUTPUT);
  pinMode(Z_STEP_PIN, OUTPUT); pinMode(A_STEP_PIN, OUTPUT);
  pinMode(X_DIR_PIN, OUTPUT);  pinMode(Y_DIR_PIN, OUTPUT);
  pinMode(Z_DIR_PIN, OUTPUT);  pinMode(A_DIR_PIN, OUTPUT);
  pinMode(ENABLE_PIN, OUTPUT);

  digitalWrite(X_DIR_PIN, HIGH); digitalWrite(Y_DIR_PIN, HIGH);
  digitalWrite(Z_DIR_PIN, HIGH); digitalWrite(A_DIR_PIN, HIGH);
  digitalWrite(ENABLE_PIN, HIGH); // 초기 비활성

  setupTimer1();
  delay(800);

  // 연주 시작
  digitalWrite(ENABLE_PIN, LOW);
  NoteFrame frame;
  for (uint16_t i = 0; i < NUM_FRAMES; i++) {
    memcpy_P(&frame, &SONG_DATA[i], sizeof(NoteFrame));
    setAllFreqs(frame.freqHz);
    delay(frame.durMs);
  }

  // 연주 종료 후 드라이버 비활성화 (발열 방지)
  stopAll();
  digitalWrite(ENABLE_PIN, HIGH);
}

void loop() {
  // 리셋 버튼을 누르면 곡을 처음부터 다시 연주합니다.
}
`;

    return { code, eventCount: events.length, totalEvents: allEvents.length, truncated };
  }

  /** 브라우저 파일 다운로드 실행 */
  function downloadIno(song, options = {}) {
    const result = generateStandaloneIno(song, options);
    const baseName = (song.title || 'MidiMoter_Song')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 32) || 'MidiMoter_Song';
    const filename = `${baseName}_Standalone.ino`;

    const blob = new Blob([result.code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return { filename, ...result };
  }

  global.InoExporter = {
    generateStandaloneIno,
    downloadIno,
  };
})(window);
