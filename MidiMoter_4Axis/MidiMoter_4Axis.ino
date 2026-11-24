/*
 * MidiMoter 4채널 스텝모터 신시사이저 펌웨어 (1단계)
 * ---------------------------------------------------------
 * 하드웨어: Arduino Uno + CNC Shield V3 + A4988 x4 + NEMA17 17HS4401S
 * 방식: Timer1 CTC 인터럽트 (20kHz) + 32비트 위상 누적기(DDS) + 포트 레지스터 직접 제어
 *
 * 핀 배치 (CNC Shield V3 기준):
 *   CH 0 (X축): STEP=D2 (PD2),  DIR=D5 (PD5)
 *   CH 1 (Y축): STEP=D3 (PD3),  DIR=D6 (PD6)
 *   CH 2 (Z축): STEP=D4 (PD4),  DIR=D7 (PD7)
 *   CH 3 (A축): STEP=D12 (PB4), DIR=D13 (PB5)  ※ D12/D13 독립 점퍼 설정 필요
 *   공통 ENABLE: D8 (PB0) — LOW: 활성, HIGH: 비활성
 *
 * 시리얼 프로토콜 (115200 bps, '\n' 종료):
 *   N <ch> <freq_x10>       : 특정 채널(0~3) 주파수 설정 (0.1Hz 단위, 0=정지)
 *   A <f0> <f1> <f2> <f3>   : 4채널 주파수 일괄 설정 (0.1Hz 단위)
 *   S                       : 모든 채널 즉시 정지
 *   E <0|1>                 : 드라이버 수동 비활성(0) / 활성(1)
 *   TEST                    : 4축 순차 음계 및 화음 자체 테스트
 *   PING                    : 연결 확인 (PONG 응답)
 */

#include <Arduino.h>

// 핀 정의
#define X_STEP_PIN 2
#define Y_STEP_PIN 3
#define Z_STEP_PIN 4
#define A_STEP_PIN 12

#define X_DIR_PIN  5
#define Y_DIR_PIN  6
#define Z_DIR_PIN  7
#define A_DIR_PIN  13

#define ENABLE_PIN 8

// Timer1 인터럽트 주기 설정: 16MHz / 800 = 20,000 Hz (50us 주기)
// 최대 출력 주파수: 10,000 Hz (freq_x10 기준 100000)
#define TICK_RATE_HZ     20000UL
#define TIMER1_OCR_VAL   799       // (16,000,000 / 20,000) - 1
#define MAX_FREQ_X10     100000UL  // 10,000.0 Hz 상한

// 모든 채널 무음 시 드라이버 자동 비활성화 대기 시간 (발열 방지)
#define IDLE_DISABLE_MS  2000UL

// DDS 위상 누적기 배열 (ISR과 메인 루프 간 공유)
volatile uint32_t phaseAcc[4] = { 0, 0, 0, 0 };
volatile uint32_t phaseInc[4] = { 0, 0, 0, 0 };

// 현재 설정된 주파수(0.1Hz 단위) 및 상태 변수
uint32_t currentFreqX10[4] = { 0, 0, 0, 0 };
bool driversEnabled = false;
bool manualDisable  = false;
unsigned long lastActiveMs = 0;

// 시리얼 수신 버퍼 (String 동적 할당 대신 고정 버퍼 사용으로 안정성 확보)
char serialBuf[64];
uint8_t serialIdx = 0;

// ---------------------------------------------------------
// Timer1 비교 일치 인터럽트 (20kHz, 50us마다 실행)
// 4개 채널의 위상을 누적하고 오버플로우 시 STEP 펄스를 출력
// ---------------------------------------------------------
ISR(TIMER1_COMPA_vect) {
  uint8_t portDMask = 0;
  uint8_t portBMask = 0;

  // CH 0 (X축: PD2)
  uint32_t inc0 = phaseInc[0];
  if (inc0 > 0) {
    uint32_t prev = phaseAcc[0];
    uint32_t next = prev + inc0;
    phaseAcc[0] = next;
    if (next < prev) portDMask |= (1 << 2);
  }

  // CH 1 (Y축: PD3)
  uint32_t inc1 = phaseInc[1];
  if (inc1 > 0) {
    uint32_t prev = phaseAcc[1];
    uint32_t next = prev + inc1;
    phaseAcc[1] = next;
    if (next < prev) portDMask |= (1 << 3);
  }

  // CH 2 (Z축: PD4)
  uint32_t inc2 = phaseInc[2];
  if (inc2 > 0) {
    uint32_t prev = phaseAcc[2];
    uint32_t next = prev + inc2;
    phaseAcc[2] = next;
    if (next < prev) portDMask |= (1 << 4);
  }

  // CH 3 (A축: PB4)
  uint32_t inc3 = phaseInc[3];
  if (inc3 > 0) {
    uint32_t prev = phaseAcc[3];
    uint32_t next = prev + inc3;
    phaseAcc[3] = next;
    if (next < prev) portBMask |= (1 << 4);
  }

  // 펄스를 보낼 채널이 하나라도 있으면 HIGH 출력 후 최소 펄스폭(2us) 유지 후 LOW 복귀
  if (portDMask || portBMask) {
    PORTD |= portDMask;
    PORTB |= portBMask;
    // A4988 최소 STEP HIGH 펄스폭(1us) 이상 확보: 16MHz 기준 32클럭 = 2us
    __builtin_avr_delay_cycles(32);
    PORTD &= ~((1 << 2) | (1 << 3) | (1 << 4));
    PORTB &= ~(1 << 4);
  }
}

// ---------------------------------------------------------
// 드라이버 ENABLE 핀 제어 (true=활성/LOW, false=비활성/HIGH)
// ---------------------------------------------------------
void setDriversEnabled(bool enable) {
  if (enable) {
    digitalWrite(ENABLE_PIN, LOW);
    driversEnabled = true;
  } else {
    digitalWrite(ENABLE_PIN, HIGH);
    driversEnabled = false;
  }
}

// ---------------------------------------------------------
// 주파수(0.1Hz 단위) -> 32비트 DDS 위상 증가량 변환
// phaseInc = (freq_x10 / 10) * 2^32 / 20000 = freq_x10 * 21474.83648
// ---------------------------------------------------------
uint32_t calcPhaseInc(uint32_t freqX10) {
  if (freqX10 == 0) return 0;
  if (freqX10 > MAX_FREQ_X10) freqX10 = MAX_FREQ_X10;
  return (uint32_t)(((uint64_t)freqX10 * 21474836ULL) / 1000ULL);
}

// ---------------------------------------------------------
// 특정 채널의 주파수 설정 (인터럽트 안전 갱신)
// ---------------------------------------------------------
void setChannelFreq(uint8_t ch, uint32_t freqX10) {
  if (ch >= 4) return;
  if (freqX10 > MAX_FREQ_X10) freqX10 = MAX_FREQ_X10;

  currentFreqX10[ch] = freqX10;
  uint32_t inc = calcPhaseInc(freqX10);

  // 32비트 변수 갱신 중 ISR 충돌 방지를 위해 인터럽트 일시 중단
  noInterrupts();
  phaseInc[ch] = inc;
  if (inc == 0) {
    phaseAcc[ch] = 0;
  }
  interrupts();

  // 소리가 나야 하는 상태라면 드라이버 자동 활성화
  if (freqX10 > 0 && !manualDisable) {
    if (!driversEnabled) setDriversEnabled(true);
    lastActiveMs = millis();
  }
}

// ---------------------------------------------------------
// 모든 채널 즉시 정지
// ---------------------------------------------------------
void stopAllChannels() {
  noInterrupts();
  for (uint8_t i = 0; i < 4; i++) {
    phaseInc[i] = 0;
    phaseAcc[i] = 0;
  }
  interrupts();
  for (uint8_t i = 0; i < 4; i++) {
    currentFreqX10[i] = 0;
  }
}

// ---------------------------------------------------------
// 4축 연결 및 음정 자체 테스트 (도-미-솔-도 순차 후 C장조 화음)
// ---------------------------------------------------------
void runSelfTest() {
  Serial.println(F("OK: TEST START"));
  manualDisable = false;
  setDriversEnabled(true);

  const uint32_t notes[4] = { 2616, 3296, 3920, 5233 }; // C4, E4, G4, C5 (0.1Hz 단위)

  // 1) 각 축 개별 순차 테스트
  for (uint8_t ch = 0; ch < 4; ch++) {
    stopAllChannels();
    setChannelFreq(ch, notes[ch]);
    delay(250);
  }
  stopAllChannels();
  delay(120);

  // 2) 4축 동시 화음 테스트
  for (uint8_t ch = 0; ch < 4; ch++) {
    setChannelFreq(ch, notes[ch]);
  }
  delay(600);

  stopAllChannels();
  lastActiveMs = millis();
  Serial.println(F("OK: TEST DONE"));
}

// ---------------------------------------------------------
// 수신된 시리얼 명령 파싱 및 실행
// ---------------------------------------------------------
void processCommand(char* line) {
  // 앞쪽 공백 제거
  while (*line == ' ' || *line == '\t') line++;
  if (*line == '\0') return;

  // 단일/다중 채널 명령 분기
  if (line[0] == 'N' && (line[1] == ' ' || line[1] == '\t')) {
    // 형식: N <ch> <freq_x10>
    char* p = line + 2;
    long ch = strtol(p, &p, 10);
    long fx10 = strtol(p, &p, 10);
    if (ch >= 0 && ch < 4 && fx10 >= 0) {
      setChannelFreq((uint8_t)ch, (uint32_t)fx10);
    }
  } else if (line[0] == 'A' && (line[1] == ' ' || line[1] == '\t')) {
    // 형식: A <f0> <f1> <f2> <f3>
    char* p = line + 2;
    for (uint8_t i = 0; i < 4; i++) {
      long fx10 = strtol(p, &p, 10);
      if (fx10 < 0) fx10 = 0;
      setChannelFreq(i, (uint32_t)fx10);
    }
  } else if (line[0] == 'S' && (line[1] == '\0' || line[1] == ' ')) {
    // 전체 정지
    stopAllChannels();
    Serial.println(F("OK: STOP"));
  } else if (line[0] == 'E' && (line[1] == ' ' || line[1] == '\t')) {
    // 드라이버 수동 활성/비활성
    int en = atoi(line + 2);
    if (en == 0) {
      manualDisable = true;
      stopAllChannels();
      setDriversEnabled(false);
      Serial.println(F("OK: DISABLED"));
    } else {
      manualDisable = false;
      setDriversEnabled(true);
      lastActiveMs = millis();
      Serial.println(F("OK: ENABLED"));
    }
  } else if (strcmp(line, "TEST") == 0) {
    runSelfTest();
  } else if (strcmp(line, "PING") == 0) {
    Serial.println(F("PONG"));
  }
}

// ---------------------------------------------------------
// Timer1 초기화 (CTC 모드, 분주비 1, 20kHz)
// ---------------------------------------------------------
void setupTimer1() {
  noInterrupts();
  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1  = 0;

  OCR1A  = TIMER1_OCR_VAL;            // 20kHz 비교값 (799)
  TCCR1B |= (1 << WGM12);             // CTC 모드
  TCCR1B |= (1 << CS10);              // 분주비 1 (16MHz)
  TIMSK1 |= (1 << OCIE1A);            // 비교 일치 인터럽트 활성화
  interrupts();
}

void setup() {
  Serial.begin(115200);

  // STEP / DIR / ENABLE 핀 출력 설정
  pinMode(X_STEP_PIN, OUTPUT);
  pinMode(Y_STEP_PIN, OUTPUT);
  pinMode(Z_STEP_PIN, OUTPUT);
  pinMode(A_STEP_PIN, OUTPUT);

  pinMode(X_DIR_PIN, OUTPUT);
  pinMode(Y_DIR_PIN, OUTPUT);
  pinMode(Z_DIR_PIN, OUTPUT);
  pinMode(A_DIR_PIN, OUTPUT);

  pinMode(ENABLE_PIN, OUTPUT);

  // 초기 핀 상태 설정
  digitalWrite(X_STEP_PIN, LOW);
  digitalWrite(Y_STEP_PIN, LOW);
  digitalWrite(Z_STEP_PIN, LOW);
  digitalWrite(A_STEP_PIN, LOW);

  digitalWrite(X_DIR_PIN, HIGH);
  digitalWrite(Y_DIR_PIN, HIGH);
  digitalWrite(Z_DIR_PIN, HIGH);
  digitalWrite(A_DIR_PIN, HIGH);

  // 시작 시에는 대기(비활성) 상태로 두어 발열 방지
  setDriversEnabled(false);

  setupTimer1();

  Serial.println(F("READY: MidiMoter 4-Axis Synth v1.0"));
}

void loop() {
  // 시리얼 명령 비블로킹 수신
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialIdx > 0) {
        serialBuf[serialIdx] = '\0';
        processCommand(serialBuf);
        serialIdx = 0;
      }
    } else if (serialIdx < sizeof(serialBuf) - 1) {
      serialBuf[serialIdx++] = c;
    }
  }

  // 모든 채널이 무음인 상태로 일정 시간 경과 시 드라이버 자동 비활성화
  if (driversEnabled && !manualDisable) {
    bool anyActive = (currentFreqX10[0] | currentFreqX10[1] | currentFreqX10[2] | currentFreqX10[3]) != 0;
    if (anyActive) {
      lastActiveMs = millis();
    } else if (millis() - lastActiveMs >= IDLE_DISABLE_MS) {
      setDriversEnabled(false);
    }
  }
}
