/**
 * Web Serial API 기반 아두이노 시리얼 통신 모듈 (115200 bps)
 */
class MidiMoterSerial {
  constructor(onLog, onStatusChange) {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.isConnected = false;
    this.readLoopActive = false;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.writeQueue = Promise.resolve();

    this.onLog = onLog || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
  }

  /** 브라우저 Web Serial 지원 여부 확인 */
  isSupported() {
    return 'serial' in navigator;
  }

  /** 시리얼 포트 선택 및 연결 */
  async connect(baudRate = 115200) {
    if (!this.isSupported()) {
      this.onLog('[오류] 이 브라우저는 Web Serial API를 지원하지 않습니다. Chrome 또는 Edge를 사용해 주세요.');
      return false;
    }

    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate });

      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this.isConnected = true;
      this.onStatusChange(true);
      this.onLog(`[연결] 시리얼 포트가 열렸습니다 (${baudRate} bps). 아두이노 부팅 대기 중...`);

      // 수신 루프 백그라운드 시작
      this._startReadLoop();

      // Arduino Uno는 포트 오픈 시 자동 리셋되므로 약 1.8초 후 PING 확인
      setTimeout(() => {
        if (this.isConnected) {
          this.sendLine('PING');
        }
      }, 1800);

      return true;
    } catch (err) {
      this.onLog(`[연결 실패] ${err.message}`);
      await this.disconnect();
      return false;
    }
  }

  /** 시리얼 연결 해제 */
  async disconnect() {
    this.readLoopActive = false;

    try {
      if (this.isConnected && this.writer) {
        // 연결 해제 전 안전하게 모든 모터 정지 명령 전송
        await this.sendLine('S');
      }
    } catch (_) {}

    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
      }
    } catch (_) {}

    try {
      if (this.writer) {
        this.writer.releaseLock();
      }
    } catch (_) {}

    try {
      if (this.port) {
        await this.port.close();
      }
    } catch (_) {}

    this.reader = null;
    this.writer = null;
    this.port = null;
    this.isConnected = false;
    this.onStatusChange(false);
    this.onLog('[해제] 시리얼 연결이 종료되었습니다.');
  }

  /** 줄 단위 명령 전송 (직렬 큐로 충돌 방지) */
  sendLine(cmd) {
    if (!this.isConnected || !this.writer) return Promise.resolve();

    const data = this.encoder.encode(cmd + '\n');
    this.writeQueue = this.writeQueue
      .then(() => this.writer.write(data))
      .catch((err) => {
        this.onLog(`[전송 오류] ${err.message}`);
      });
    return this.writeQueue;
  }

  /** 4채널 주파수(0.1Hz 정수 단위) 일괄 전송 */
  sendAllChannels(freqsX10) {
    const [f0, f1, f2, f3] = freqsX10.map((v) => Math.max(0, Math.round(v)));
    return this.sendLine(`A ${f0} ${f1} ${f2} ${f3}`);
  }

  /** 단일 채널 주파수(0.1Hz 정수 단위) 전송 */
  sendChannel(ch, freqX10) {
    return this.sendLine(`N ${ch} ${Math.max(0, Math.round(freqX10))}`);
  }

  /** 전체 정지 명령 */
  stopAll() {
    return this.sendLine('S');
  }

  /** 아두이노 수신 데이터 읽기 루프 */
  async _startReadLoop() {
    this.readLoopActive = true;
    let buffer = '';

    try {
      while (this.readLoopActive && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          buffer += this.decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              this.onLog(`[Arduino] ${trimmed}`);
            }
          }
        }
      }
    } catch (err) {
      if (this.readLoopActive) {
        this.onLog(`[수신 오류] ${err.message}`);
      }
    }
  }
}

window.MidiMoterSerial = MidiMoterSerial;
