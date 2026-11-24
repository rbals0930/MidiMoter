/**
 * HTML5 Canvas 기반 4채널 피아노 롤(Piano Roll) 실시간 시각화 렌더러
 * - X(파랑), Y(초록), Z(노랑), A(핑크) 4축 음표 블록 표시
 * - 재생 위치(플레이헤드) 자동 스크롤 및 캔버스 클릭으로 즉시 탐색(Seek)
 */
class PianoRollRenderer {
  constructor(canvasEl, onSeek) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.onSeek = onSeek || (() => {});

    this.segments = [];
    this.durationMs = 0;
    this.playheadMs = 0;
    this.channelMuted = [false, false, false, false];
    this.pxPerSec = 95; // 가로 줌 배율 (1초당 픽셀)

    this.minNote = 36;  // C2
    this.maxNote = 86;  // D6
    this.leftMargin = 42;
    this.channelColors = ['#60a5fa', '#34d399', '#fbbf24', '#f472b6'];

    this._bindEvents();
    this.resize();
    this.render();
  }

  _bindEvents() {
    window.addEventListener('resize', () => {
      this.resize();
      this.render();
    });

    // 캔버스 클릭 시 해당 시간(ms)으로 시크
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.durationMs <= 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < this.leftMargin) return;

      const viewStartMs = this._getViewStartMs(rect.width);
      const clickedMs = viewStartMs + ((x - this.leftMargin) / this.pxPerSec) * 1000;
      const clamped = Math.max(0, Math.min(this.durationMs, clickedMs));
      this.onSeek(clamped);
    });
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(300, Math.floor(rect.width));
    const h = Math.max(180, Math.floor(rect.height));
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = w;
    this.viewH = h;
  }

  setSongData(segments, durationMs) {
    this.segments = segments || [];
    this.durationMs = durationMs || 0;
    this.playheadMs = 0;

    // 곡의 실제 음역에 맞춰 세로 표시 범위 자동 조정 (여유 ±3반음)
    if (this.segments.length > 0) {
      let lo = 96;
      let hi = 24;
      for (const s of this.segments) {
        if (s.note < lo) lo = s.note;
        if (s.note > hi) hi = s.note;
      }
      this.minNote = Math.max(24, lo - 3);
      this.maxNote = Math.min(96, Math.max(lo + 24, hi + 3));
    } else {
      this.minNote = 36;
      this.maxNote = 86;
    }

    this.render();
  }

  setPlayhead(ms) {
    this.playheadMs = ms;
    this.render();
  }

  setZoom(pxPerSec) {
    this.pxPerSec = Math.max(40, Math.min(240, pxPerSec));
    this.render();
  }

  setMuted(mutedArr) {
    this.channelMuted = [...mutedArr];
    this.render();
  }

  /** 플레이헤드가 화면 왼쪽 28% 지점에 머물도록 스크롤 오프셋 계산 */
  _getViewStartMs(width) {
    const drawW = Math.max(100, width - this.leftMargin);
    const windowMs = (drawW / this.pxPerSec) * 1000;
    if (this.durationMs <= windowMs) return 0;

    const leadMs = windowMs * 0.28;
    const rawStart = this.playheadMs - leadMs;
    return Math.max(0, Math.min(this.durationMs - windowMs, rawStart));
  }

  render() {
    const ctx = this.ctx;
    const w = this.viewW || 600;
    const h = this.viewH || 240;

    // 배경 초기화
    ctx.fillStyle = '#0c1017';
    ctx.fillRect(0, 0, w, h);

    const noteSpan = Math.max(12, this.maxNote - this.minNote + 1);
    const rowH = h / noteSpan;
    const viewStartMs = this._getViewStartMs(w);
    const drawW = w - this.leftMargin;
    const viewEndMs = viewStartMs + (drawW / this.pxPerSec) * 1000;

    // 1) 가로 음계 그리드 (옥타브 C 기준선 강조)
    const blackSet = new Set([1, 3, 6, 8, 10]);
    for (let n = this.minNote; n <= this.maxNote; n++) {
      const y = h - (n - this.minNote + 1) * rowH;
      const semi = n % 12;

      if (blackSet.has(semi)) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
        ctx.fillRect(this.leftMargin, y, drawW, rowH);
      }

      if (semi === 0) {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.24)';
        ctx.beginPath();
        ctx.moveTo(this.leftMargin, y + rowH);
        ctx.lineTo(w, y + rowH);
        ctx.stroke();

        // 왼쪽 음이름 라벨 (C2, C3, C4...)
        const oct = Math.floor(n / 12) - 1;
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`C${oct}`, this.leftMargin - 6, y + rowH - 2);
      }
    }

    // 2) 세로 시간 눈금 (1초 간격)
    const firstSec = Math.ceil(viewStartMs / 1000);
    const lastSec = Math.floor(viewEndMs / 1000);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
    ctx.fillStyle = '#64748b';
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'left';

    for (let s = firstSec; s <= lastSec; s++) {
      const x = this.leftMargin + ((s * 1000 - viewStartMs) / 1000) * this.pxPerSec;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      if (s % 2 === 0) {
        const min = Math.floor(s / 60);
        const sec = s % 60;
        ctx.fillText(`${min}:${sec.toString().padStart(2, '0')}`, x + 3, 11);
      }
    }

    // 3) 4채널 음표 세그먼트 블록 그리기
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (seg.endMs < viewStartMs || seg.startMs > viewEndMs) continue;

      const x1 = this.leftMargin + ((seg.startMs - viewStartMs) / 1000) * this.pxPerSec;
      const x2 = this.leftMargin + ((seg.endMs - viewStartMs) / 1000) * this.pxPerSec;
      const bw = Math.max(2, x2 - x1);
      const y = h - (seg.note - this.minNote + 1) * rowH;
      const bh = Math.max(3, rowH - 1);

      const isActive = this.playheadMs >= seg.startMs && this.playheadMs <= seg.endMs;
      const isMuted = this.channelMuted[seg.ch];

      ctx.globalAlpha = isMuted ? 0.2 : isActive ? 1.0 : 0.78;
      ctx.fillStyle = this.channelColors[seg.ch];
      ctx.fillRect(Math.max(this.leftMargin, x1), y, bw, bh);

      if (isActive && !isMuted) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(Math.max(this.leftMargin, x1), y, bw, bh);
        ctx.lineWidth = 1;
      }
    }
    ctx.globalAlpha = 1.0;

    // 왼쪽 여백 구분선
    ctx.strokeStyle = '#2c3547';
    ctx.beginPath();
    ctx.moveTo(this.leftMargin, 0);
    ctx.lineTo(this.leftMargin, h);
    ctx.stroke();

    // 4) 현재 재생 위치 플레이헤드 (빨간 세로선)
    if (this.durationMs > 0) {
      const px = this.leftMargin + ((this.playheadMs - viewStartMs) / 1000) * this.pxPerSec;
      if (px >= this.leftMargin && px <= w) {
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
  }
}

window.PianoRollRenderer = PianoRollRenderer;
