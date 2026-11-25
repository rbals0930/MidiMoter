/**
 * Web Audio API 기반 4채널 브라우저 미리듣기 신시사이저
 * 아두이노 미연결 상태에서도 스텝모터와 유사한 4성부 사운드를 PC 스피커로 청음
 */
class AudioPreviewSynth {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.channels = [null, null, null, null];
    // X(하이)·Y(멜로디) 전면 배치 + Z(미들)·A(베이스) 균형 잡힌 4단 계층 밸런스
    this.channelGains = [0.78, 0.78, 0.58, 0.70];
    this.enabled = true;
    this.volume = 0.3;
  }

  /** 사용자 클릭 등 제스처 이후 AudioContext 지연 초기화 */
  _ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.enabled ? this.volume * 0.25 : 0;

      // 스텝모터 특유의 톱니/사각파 고주파 치찰음을 부드럽게 다듬는 로우패스 필터
      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 2600;

      this.filter.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      // 4개 채널 오실레이터 및 개별 게인 노드 생성
      for (let i = 0; i < 4; i++) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        // CH 3(베이스)는 톱니파, 나머지는 사각파로 스텝모터 느낌 구현
        osc.type = i === 3 ? 'sawtooth' : 'square';
        osc.frequency.value = 220;
        gain.gain.value = 0;

        osc.connect(gain);
        gain.connect(this.filter);
        osc.start();

        this.channels[i] = { osc, gain, lastFreq: 0 };
      }
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /** 미리듣기 활성화 여부 설정 */
  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.masterGain && this.ctx) {
      const target = enabled ? this.volume * 0.25 : 0;
      this.masterGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.015);
    }
  }

  /** 마스터 음량 설정 (0.0 ~ 1.0) */
  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && this.ctx && this.enabled) {
      this.masterGain.gain.setTargetAtTime(this.volume * 0.25, this.ctx.currentTime, 0.015);
    }
  }

  /** 특정 채널의 주파수(Hz) 설정 (0이면 무음, forceRetrigger=true면 짧은 쉼 후 재타건) */
  setChannelFreq(ch, freqHz, forceRetrigger = false) {
    if (ch < 0 || ch >= 4) return;
    if (!this.enabled && freqHz > 0) return;

    if (freqHz > 0) {
      this._ensureContext();
    }
    if (!this.ctx || !this.channels[ch]) return;

    const now = this.ctx.currentTime;
    const node = this.channels[ch];
    const gainParam = node.gain.gain;

    if (freqHz > 0) {
      const baseGain = this.channelGains[ch] ?? 0.5;
      const isNewAttack =
        node.lastFreq === 0 || Math.abs(node.lastFreq - freqHz) > 0.5 || forceRetrigger;

      if (!isNewAttack) {
        return;
      }

      gainParam.cancelScheduledValues(now);
      gainParam.setValueAtTime(gainParam.value, now);

      const peak = Math.min(1.0, baseGain * 1.28);
      const sustain = baseGain * 0.78;

      if (forceRetrigger && node.lastFreq > 0) {
        // 60Hz 프레임 경계 안에 짧은 무음이 겹친 경우 14ms 무음 딥 후 재타건
        gainParam.setTargetAtTime(0.015, now, 0.002);
        gainParam.setValueAtTime(0.015, now + 0.014);
        node.osc.frequency.setValueAtTime(freqHz, now + 0.014);
        gainParam.linearRampToValueAtTime(peak, now + 0.020);
        gainParam.setTargetAtTime(sustain, now + 0.022, 0.045);
      } else {
        node.osc.frequency.setTargetAtTime(freqHz, now, 0.002);
        gainParam.linearRampToValueAtTime(peak, now + 0.006);
        gainParam.setTargetAtTime(sustain, now + 0.008, 0.045);
      }
      node.lastFreq = freqHz;
    } else {
      gainParam.cancelScheduledValues(now);
      gainParam.setValueAtTime(gainParam.value, now);
      gainParam.setTargetAtTime(0, now, 0.003);
      node.lastFreq = 0;
    }
  }

  /** 4채널 일괄 주파수 설정 */
  setAllFreqs(freqsHz, retriggerMask = null) {
    for (let i = 0; i < 4; i++) {
      this.setChannelFreq(i, freqsHz[i] || 0, !!(retriggerMask && retriggerMask[i]));
    }
  }

  /** 모든 채널 즉시 무음 */
  stopAll() {
    this.setAllFreqs([0, 0, 0, 0]);
  }
}

window.AudioPreviewSynth = AudioPreviewSynth;
