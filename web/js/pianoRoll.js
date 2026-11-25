/**
 * HTML5 Canvas 기반 4채널 피아노 롤(Piano Roll) 시각화 및 인터랙티브 에디터
 * - 탐색 모드(seek): 기존과 동일하게 캔버스 클릭으로 구간 이동
 * - 편집 모드(edit): 상단 눈금 바 클릭=구간 이동, 본문 좌클릭/드래그=음표 추가·이동·길이조절,
 *   우클릭/Delete=음표 삭제, 휠=세로 음역 스크롤, Shift+휠=가로 스크롤
 */
class PianoRollRenderer {
  constructor(canvasEl, onSeek, callbacks = {}) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.onSeek = onSeek || (() => {});
    this.onChange = callbacks.onChange || (() => {});
    this.onPreviewNote = callbacks.onPreviewNote || (() => {});
    this.onSelectionChange = callbacks.onSelectionChange || (() => {});
    this.onScrollSync = callbacks.onScrollSync || (() => {});

    this.segments = [];
    this.durationMs = 0;
    this.playheadMs = 0;
    this.channelMuted = [false, false, false, false];
    this.pxPerSec = 95; // 가로 줌 배율 (1초당 픽셀)

    // 편집 모드 상태
    this.mode = 'seek';        // 'seek' | 'edit'
    this.activeChannel = 0;    // 0(X), 1(Y), 2(Z), 3(A)
    this.bpm = 120;
    this.snapDiv = 4;          // 0=자유, 1=1/4박, 2=1/8박, 4=1/16박
    this.selectedIdx = -1;
    this.dragState = null;
    this.manualScrollMs = null;

    this.minNote = 36;         // C2
    this.maxNote = 86;         // D6
    this.leftMargin = 50;
    this.rulerHeight = 22;
    this.channelColors = ['#60a5fa', '#34d399', '#fbbf24', '#f472b6'];

    this._bindEvents();
    this.resize();
    this.render();
  }

  _topOffset() {
    return this.mode === 'edit' ? this.rulerHeight : 0;
  }

  _getSnapStepMs() {
    if (this.snapDiv <= 0) return 0;
    return (60000 / this.bpm) / this.snapDiv;
  }

  _snapMs(ms, roundMode = 'round') {
    const step = this._getSnapStepMs();
    if (step <= 0) return Math.max(0, Math.round(ms));
    const fn = roundMode === 'floor' ? Math.floor : roundMode === 'ceil' ? Math.ceil : Math.round;
    return Math.max(0, fn(ms / step) * step);
  }

  _xToMs(x, width) {
    const viewStartMs = this._getViewStartMs(width);
    return viewStartMs + ((x - this.leftMargin) / this.pxPerSec) * 1000;
  }

  _yToNote(y, height) {
    const top = this._topOffset();
    const bodyH = Math.max(1, height - top);
    const noteSpan = Math.max(12, this.maxNote - this.minNote + 1);
    const rowH = bodyH / noteSpan;
    const raw = this.maxNote - Math.floor((y - top) / rowH);
    return Math.max(24, Math.min(108, raw));
  }

  /** 지정 좌표에 위치한 음표 히트 테스트 (현재 편집 축 우선) */
  _hitTestNote(x, y, width, height) {
    const top = this._topOffset();
    if (x < this.leftMargin || y < top) return null;

    const viewStartMs = this._getViewStartMs(width);
    const bodyH = Math.max(1, height - top);
    const noteSpan = Math.max(12, this.maxNote - this.minNote + 1);
    const rowH = bodyH / noteSpan;

    let bestMatch = null;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const seg = this.segments[i];
      if (seg.note < this.minNote || seg.note > this.maxNote) continue;

      const x1 = this.leftMargin + ((seg.startMs - viewStartMs) / 1000) * this.pxPerSec;
      const x2 = this.leftMargin + ((seg.endMs - viewStartMs) / 1000) * this.pxPerSec;
      const y1 = top + (this.maxNote - seg.note) * rowH;
      const y2 = y1 + rowH;

      const hitX1 = Math.max(this.leftMargin, x1) - 2;
      if (x >= hitX1 && x <= x2 + 3 && y >= y1 && y <= y2) {
        const bw = x2 - x1;
        const isResizeEdge = bw >= 10 && x >= x2 - 7 && x <= x2 + 3;
        const match = { idx: i, seg, isResizeEdge };
        // 현재 편집 중인 채널의 음표를 최우선 선택
        if (seg.ch === this.activeChannel) return match;
        if (!bestMatch) bestMatch = match;
      }
    }
    return bestMatch;
  }

  _bindEvents() {
    // 부모 컨테이너 크기 변화를 실시간 감지해 캔버스 해상도를 1:1 유지 (글자 늘어짐 방지)
    if (typeof ResizeObserver !== 'undefined') {
      const target = this.canvas.parentElement || this.canvas;
      this.resizeObserver = new ResizeObserver(() => {
        this.resize();
        this.render();
      });
      this.resizeObserver.observe(target);
    }

    window.addEventListener('resize', () => {
      this.resize();
      this.render();
    });

    // 편집 모드에서 우클릭 시 해당 음표 즉시 삭제
    this.canvas.addEventListener('contextmenu', (e) => {
      if (this.mode !== 'edit') return;
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this._hitTestNote(x, y, rect.width, rect.height);
      if (hit) {
        const nextSegments = this.segments.filter((_, idx) => idx !== hit.idx);
        this.selectedIdx = -1;
        this.onSelectionChange(-1);
        this.onChange(nextSegments, null, '음표 삭제');
      }
    });

    // 편집 모드에서 마우스 휠: 세로 음역 스크롤 / Shift+휠: 가로 시간 스크롤
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'edit') return;
        e.preventDefault();
        if (e.shiftKey) {
          const rect = this.canvas.getBoundingClientRect();
          const drawW = Math.max(100, rect.width - this.leftMargin);
          const windowMs = (drawW / this.pxPerSec) * 1000;
          const maxStart = Math.max(0, this.durationMs - windowMs);
          const baseStart =
            this.manualScrollMs !== null ? this.manualScrollMs : this._getViewStartMs(rect.width);
          const deltaMs = (e.deltaY > 0 ? 1 : -1) * Math.max(400, windowMs * 0.15);
          this.manualScrollMs = Math.max(0, Math.min(maxStart, baseStart + deltaMs));
          this.render();
        } else {
          this.scrollPitch(e.deltaY > 0 ? -2 : 2);
        }
      },
      { passive: false }
    );

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < this.leftMargin) return;

      // 탐색 모드이거나 편집 모드 상단 눈금 바 클릭 -> 구간 이동(Seek)
      if (this.mode !== 'edit' || y < this._topOffset()) {
        if (this.durationMs <= 0) return;
        const clickedMs = Math.max(0, Math.min(this.durationMs, this._xToMs(x, rect.width)));
        this.manualScrollMs = null;
        this.onSeek(clickedMs);
        if (this.mode === 'edit') {
          this.dragState = { type: 'scrub' };
          try {
            this.canvas.setPointerCapture(e.pointerId);
          } catch (_) {}
        }
        return;
      }

      // 편집 모드 본문 클릭/드래그 처리
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch (_) {}

      const hit = this._hitTestNote(x, y, rect.width, rect.height);
      if (hit) {
        this.selectedIdx = hit.idx;
        this.onSelectionChange(hit.idx);

        if (hit.isResizeEdge) {
          this.dragState = {
            type: 'resize',
            segIndex: hit.idx,
            origStartMs: hit.seg.startMs,
            origEndMs: hit.seg.endMs,
            origNote: hit.seg.note,
            draft: { ...hit.seg },
            moved: false,
          };
        } else {
          const clickMs = this._xToMs(x, rect.width);
          this.dragState = {
            type: 'move',
            segIndex: hit.idx,
            origStartMs: hit.seg.startMs,
            origEndMs: hit.seg.endMs,
            origNote: hit.seg.note,
            grabOffsetMs: clickMs - hit.seg.startMs,
            lastPreviewNote: hit.seg.note,
            draft: { ...hit.seg },
            moved: false,
          };
          this.onPreviewNote(hit.seg.ch, hit.seg.note);
        }
        this.render();
        return;
      }

      // 빈 영역 클릭 -> 새 음표 생성 드래그 시작
      const rawMs = Math.max(0, this._xToMs(x, rect.width));
      const startMs = this.snapDiv > 0 ? this._snapMs(rawMs, 'floor') : Math.round(rawMs);
      const defaultStepMs = this._getSnapStepMs() || 250;
      const note = this._yToNote(y, rect.height);

      this.selectedIdx = -1;
      this.onSelectionChange(-1);

      const draft = {
        ch: this.activeChannel,
        note,
        startMs,
        endMs: startMs + defaultStepMs,
      };
      this.dragState = {
        type: 'create',
        segIndex: -1,
        anchorMs: startMs,
        defaultStepMs,
        lastPreviewNote: note,
        draft,
        moved: false,
      };
      this.onPreviewNote(draft.ch, note);
      this.render();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (!this.dragState) {
        if (this.mode !== 'edit') {
          this.canvas.style.cursor = 'pointer';
          return;
        }
        if (y < this._topOffset()) {
          this.canvas.style.cursor = 'pointer';
          return;
        }
        const hit = this._hitTestNote(x, y, rect.width, rect.height);
        if (hit) {
          this.canvas.style.cursor = hit.isResizeEdge ? 'ew-resize' : 'grab';
        } else if (x >= this.leftMargin) {
          this.canvas.style.cursor = 'crosshair';
        } else {
          this.canvas.style.cursor = 'default';
        }
        return;
      }

      const d = this.dragState;
      if (d.type === 'scrub') {
        const clamped = Math.max(0, Math.min(this.durationMs, this._xToMs(x, rect.width)));
        this.onSeek(clamped);
        return;
      }

      const curMs = Math.max(0, this._xToMs(x, rect.width));
      const minStep = Math.max(40, this._getSnapStepMs() || 80);

      if (d.type === 'create') {
        const newNote = this._yToNote(y, rect.height);
        if (newNote !== d.lastPreviewNote) {
          d.draft.note = newNote;
          d.lastPreviewNote = newNote;
          this.onPreviewNote(d.draft.ch, newNote);
        }
        if (Math.abs(curMs - d.anchorMs) >= 20) {
          d.moved = true;
          if (curMs >= d.anchorMs) {
            const snappedEnd = this.snapDiv > 0 ? this._snapMs(curMs, 'ceil') : Math.round(curMs);
            d.draft.startMs = d.anchorMs;
            d.draft.endMs = Math.max(d.anchorMs + minStep, snappedEnd);
          } else {
            const snappedStart = this.snapDiv > 0 ? this._snapMs(curMs, 'floor') : Math.round(curMs);
            d.draft.startMs = snappedStart;
            d.draft.endMs = Math.max(snappedStart + minStep, d.anchorMs + d.defaultStepMs);
          }
        }
        this.render();
      } else if (d.type === 'move') {
        this.canvas.style.cursor = 'grabbing';
        const dur = d.origEndMs - d.origStartMs;
        const newStart = this._snapMs(Math.max(0, curMs - d.grabOffsetMs), 'round');
        const newNote = this._yToNote(y, rect.height);

        if (Math.abs(newStart - d.origStartMs) >= 1 || newNote !== d.origNote) {
          d.moved = true;
        }
        d.draft.startMs = newStart;
        d.draft.endMs = newStart + dur;
        d.draft.note = newNote;

        if (newNote !== d.lastPreviewNote) {
          d.lastPreviewNote = newNote;
          this.onPreviewNote(d.draft.ch, newNote);
        }
        this.render();
      } else if (d.type === 'resize') {
        const snappedEnd = this._snapMs(curMs, 'round');
        const newEnd = Math.max(d.origStartMs + minStep, snappedEnd);
        if (Math.abs(newEnd - d.origEndMs) >= 1) {
          d.moved = true;
        }
        d.draft.endMs = newEnd;
        this.render();
      }
    });

    const finishDrag = (e) => {
      if (!this.dragState) return;
      const d = this.dragState;
      this.dragState = null;

      try {
        if (this.canvas.hasPointerCapture(e.pointerId)) {
          this.canvas.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}

      if (d.type === 'scrub') return;

      if (d.type === 'create') {
        const prioritySeg = { ...d.draft };
        const nextSegments = [...this.segments, prioritySeg];
        this.onChange(nextSegments, prioritySeg, '음표 추가');
      } else if (d.type === 'move' && d.moved) {
        const prioritySeg = { ...d.draft };
        const nextSegments = this.segments.filter((_, i) => i !== d.segIndex);
        nextSegments.push(prioritySeg);
        this.onChange(nextSegments, prioritySeg, '음표 이동');
      } else if (d.type === 'resize' && d.moved) {
        const prioritySeg = { ...d.draft };
        const nextSegments = this.segments.filter((_, i) => i !== d.segIndex);
        nextSegments.push(prioritySeg);
        this.onChange(nextSegments, prioritySeg, '음표 길이 조절');
      } else {
        this.render();
      }
    };

    this.canvas.addEventListener('pointerup', finishDrag);
    this.canvas.addEventListener('pointercancel', finishDrag);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (this.viewW === w && this.viewH === h && this.canvas.width === Math.round(w * dpr) && this.canvas.height === Math.round(h * dpr)) {
      return;
    }
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = w;
    this.viewH = h;
  }

  /** 곡 데이터 갱신 (keepView=true면 편집 중 스크롤·음역 뷰를 유지) */
  setSongData(segments, durationMs, options = {}) {
    this.segments = segments || [];
    this.durationMs = durationMs || 0;
    this.selectedIdx = -1;

    if (options.keepView) {
      this.render();
      return;
    }

    this.playheadMs = 0;
    this.manualScrollMs = null;

    if (this.segments.length > 0) {
      let lo = 96;
      let hi = 24;
      for (const s of this.segments) {
        if (s.note < lo) lo = s.note;
        if (s.note > hi) hi = s.note;
      }
      this.minNote = Math.max(24, lo - 3);
      this.maxNote = Math.min(96, Math.max(lo + 24, hi + 3));
      if (this.mode === 'edit') {
        this._fitPitchWindowForEdit();
      }
    } else {
      this.minNote = 48; // C3
      this.maxNote = 76; // E5
    }

    this.render();
  }

  /** 편집 모드에서 마우스로 찍기 쉽도록 세로 표시 창을 약 28반음 폭으로 조정 */
  _fitPitchWindowForEdit() {
    const span = this.maxNote - this.minNote;
    if (span > 30 || span < 18) {
      const center = Math.round((this.minNote + this.maxNote) / 2);
      const nextMin = Math.max(24, Math.min(108 - 28, center - 14));
      this.minNote = nextMin;
      this.maxNote = nextMin + 28;
    }
  }

  setMode(mode) {
    this.mode = mode === 'edit' ? 'edit' : 'seek';
    this.dragState = null;
    if (this.mode === 'edit') {
      this._fitPitchWindowForEdit();
    } else {
      this.selectedIdx = -1;
      this.manualScrollMs = null;
    }
    this.resize();
    this.render();
  }

  setActiveChannel(ch) {
    this.activeChannel = Math.max(0, Math.min(3, ch));
    this.render();
  }

  setBpm(bpm) {
    this.bpm = Math.max(30, Math.min(300, bpm || 120));
    this.render();
  }

  setSnapDiv(div) {
    this.snapDiv = Math.max(0, div);
    this.render();
  }

  scrollPitch(deltaSemitones) {
    const span = Math.max(12, this.maxNote - this.minNote);
    const nextMin = Math.max(24, Math.min(108 - span, this.minNote + deltaSemitones));
    this.minNote = nextMin;
    this.maxNote = nextMin + span;
    this.render();
  }

  deleteSelected() {
    if (this.mode !== 'edit' || this.selectedIdx < 0 || this.selectedIdx >= this.segments.length) {
      return false;
    }
    const nextSegments = this.segments.filter((_, i) => i !== this.selectedIdx);
    this.selectedIdx = -1;
    this.onSelectionChange(-1);
    this.onChange(nextSegments, null, '음표 삭제');
    return true;
  }

  setPlayhead(ms) {
    this.playheadMs = ms;
    this.manualScrollMs = null;
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

  /** 외부 가로 스크롤바 동기화를 위한 현재 뷰포트·전체 길이 측정값 반환 */
  getScrollMetrics() {
    const w = this.viewW || 600;
    const drawW = Math.max(100, w - this.leftMargin);
    const totalPx = Math.max(drawW, Math.round((this.durationMs / 1000) * this.pxPerSec));
    const windowMs = (drawW / this.pxPerSec) * 1000;
    const maxScrollMs = Math.max(0, this.durationMs - windowMs);
    const viewStartMs = this._getViewStartMs(w);
    const scrollLeftPx = Math.round((viewStartMs / 1000) * this.pxPerSec);
    return {
      drawW,
      totalPx,
      scrollLeftPx,
      viewStartMs,
      maxScrollMs,
      leftMargin: this.leftMargin,
    };
  }

  /** 외부 가로 스크롤바 이동 시 해당 시작 시각(ms)으로 수동 스크롤 */
  setScrollMs(ms, silentSync = false) {
    const { maxScrollMs } = this.getScrollMetrics();
    this.manualScrollMs = Math.max(0, Math.min(maxScrollMs, ms));
    this.render(silentSync);
  }

  /** 플레이헤드(또는 수동 스크롤 오프셋) 기준 화면 시작 시각 계산 */
  _getViewStartMs(width) {
    const drawW = Math.max(100, width - this.leftMargin);
    const windowMs = (drawW / this.pxPerSec) * 1000;
    if (this.durationMs <= windowMs) return 0;

    if (this.manualScrollMs !== null) {
      return Math.max(0, Math.min(this.durationMs - windowMs, this.manualScrollMs));
    }

    const leadMs = windowMs * 0.28;
    const rawStart = this.playheadMs - leadMs;
    return Math.max(0, Math.min(this.durationMs - windowMs, rawStart));
  }

  _drawNoteBar(ctx, seg, viewStartMs, top, rowH, w, options = {}) {
    const x1 = this.leftMargin + ((seg.startMs - viewStartMs) / 1000) * this.pxPerSec;
    const x2 = this.leftMargin + ((seg.endMs - viewStartMs) / 1000) * this.pxPerSec;

    const drawX1 = Math.max(this.leftMargin, x1);
    const drawX2 = Math.min(w, x2);
    const bw = drawX2 - drawX1;
    if (bw <= 0) return;

    const drawWBar = Math.max(1.5, bw);
    const y = top + (this.maxNote - seg.note) * rowH;
    const bh = Math.max(3, rowH - 1);

    const isActive = this.playheadMs >= seg.startMs && this.playheadMs <= seg.endMs;
    const isPassed = seg.endMs < this.playheadMs;
    const isMuted = this.channelMuted[seg.ch];

    let alpha = isMuted ? 0.18 : isActive ? 1.0 : isPassed ? 0.38 : 0.84;
    if (options.ghost) alpha = 0.22;
    if (options.preview) alpha = 0.92;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.channelColors[seg.ch];
    ctx.fillRect(drawX1, y, drawWBar, bh);

    if (options.selected || options.preview || (isActive && !isMuted && !options.ghost)) {
      ctx.strokeStyle = options.selected || options.preview ? '#ffffff' : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = options.selected || options.preview ? 2 : 1.2;
      ctx.strokeRect(drawX1, y, drawWBar, bh);
      ctx.lineWidth = 1;
    }

    // 편집 모드에서 충분히 긴 음표의 오른쪽 끝단 리사이즈 핸들 힌트
    if (this.mode === 'edit' && !options.ghost && bw >= 12 && x2 <= w + 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fillRect(Math.max(drawX1, drawX2 - 3), y + 1, 2, Math.max(1, bh - 2));
    }
  }

  render(skipScrollSync = false) {
    const ctx = this.ctx;
    const w = this.viewW || 600;
    const h = this.viewH || 240;
    const top = this._topOffset();
    const bodyH = Math.max(1, h - top);

    ctx.fillStyle = '#0c1017';
    ctx.fillRect(0, 0, w, h);

    const noteSpan = Math.max(12, this.maxNote - this.minNote + 1);
    const rowH = bodyH / noteSpan;
    const viewStartMs = this._getViewStartMs(w);
    const drawW = w - this.leftMargin;
    const viewEndMs = viewStartMs + (drawW / this.pxPerSec) * 1000;

    // 1) 가로 음계 그리드 및 왼쪽 피아노 건반 스트립
    const blackSet = new Set([1, 3, 6, 8, 10]);
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const keyStripW = 10;
    const stripX = this.leftMargin - keyStripW;

    for (let n = this.minNote; n <= this.maxNote; n++) {
      const y = top + (this.maxNote - n) * rowH;
      const semi = n % 12;
      const isBlack = blackSet.has(semi);

      if (isBlack) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
        ctx.fillRect(this.leftMargin, y, drawW, rowH);
      }

      // 왼쪽 피아노 건반 힌트 스트립
      ctx.fillStyle = isBlack ? '#151b26' : '#263042';
      ctx.fillRect(stripX, y, keyStripW - 1, Math.max(1, rowH - 0.6));

      if (semi === 0) {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.26)';
        ctx.beginPath();
        ctx.moveTo(this.leftMargin, y + rowH);
        ctx.lineTo(w, y + rowH);
        ctx.stroke();

        const oct = Math.floor(n / 12) - 1;
        ctx.fillStyle = '#cbd5e1';
        ctx.font = 'bold 10px Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`C${oct}`, stripX - 4, y + Math.min(rowH - 2, rowH * 0.78));
      } else if (this.mode === 'edit' && rowH >= 13 && (semi === 5 || semi === 9)) {
        // 편집 모드에서 줄 높이가 충분할 때 F/A 기준음도 보조 표시
        const oct = Math.floor(n / 12) - 1;
        ctx.fillStyle = '#64748b';
        ctx.font = '9px Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`${noteNames[semi]}${oct}`, stripX - 4, y + rowH * 0.76);
      }
    }

    // 2) 편집 모드 박자 그리드선 (BPM & 스냅 기준)
    if (this.mode === 'edit') {
      const beatMs = 60000 / this.bpm;
      const stepMs = this.snapDiv > 0 ? beatMs / this.snapDiv : beatMs;
      const stepPx = (stepMs / 1000) * this.pxPerSec;
      const drawStepMs = stepPx >= 7 ? stepMs : beatMs;

      const firstStep = Math.floor(viewStartMs / drawStepMs);
      const lastStep = Math.ceil(viewEndMs / drawStepMs);

      for (let k = firstStep; k <= lastStep; k++) {
        const tMs = k * drawStepMs;
        if (tMs < viewStartMs) continue;
        const x = this.leftMargin + ((tMs - viewStartMs) / 1000) * this.pxPerSec;

        const isBar = this.snapDiv > 0 && drawStepMs === stepMs ? k % (this.snapDiv * 4) === 0 : k % 4 === 0;
        const isBeat = this.snapDiv > 0 && drawStepMs === stepMs ? k % this.snapDiv === 0 : true;

        ctx.strokeStyle = isBar
          ? 'rgba(148, 163, 184, 0.28)'
          : isBeat
          ? 'rgba(148, 163, 184, 0.14)'
          : 'rgba(148, 163, 184, 0.05)';
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // 3) 세로 시간 눈금 (상단 룰러 또는 탐색 모드 본문)
    const firstSec = Math.ceil(viewStartMs / 1000);
    const lastSec = Math.floor(viewEndMs / 1000);
    if (this.mode === 'edit') {
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, w, this.rulerHeight);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('구간이동', 4, 14);
    }

    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'left';
    for (let s = firstSec; s <= lastSec; s++) {
      const x = this.leftMargin + ((s * 1000 - viewStartMs) / 1000) * this.pxPerSec;
      if (this.mode !== 'edit') {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)';
        ctx.beginPath();
        ctx.moveTo(x, this.rulerHeight - 6);
        ctx.lineTo(x, this.rulerHeight);
        ctx.stroke();
      }

      if (s % 2 === 0) {
        const min = Math.floor(s / 60);
        const sec = s % 60;
        ctx.fillStyle = this.mode === 'edit' ? '#cbd5e1' : '#64748b';
        ctx.fillText(`${min}:${sec.toString().padStart(2, '0')}`, x + 3, this.mode === 'edit' ? 14 : 11);
      }
    }

    if (this.mode === 'edit') {
      ctx.strokeStyle = '#334155';
      ctx.beginPath();
      ctx.moveTo(0, this.rulerHeight);
      ctx.lineTo(w, this.rulerHeight);
      ctx.stroke();
    }

    // 4) 4채널 음표 세그먼트 블록 그리기 (본문 영역만 클리핑)
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.leftMargin, top, drawW, bodyH);
    ctx.clip();

    const activeDrag = this.dragState;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (seg.note < this.minNote || seg.note > this.maxNote) continue;
      if (seg.endMs <= viewStartMs || seg.startMs >= viewEndMs) continue;

      const isDraggedTarget =
        activeDrag && (activeDrag.type === 'move' || activeDrag.type === 'resize') && activeDrag.segIndex === i;

      this._drawNoteBar(ctx, seg, viewStartMs, top, rowH, w, {
        selected: i === this.selectedIdx && !isDraggedTarget,
        ghost: isDraggedTarget,
      });
    }

    // 드래그 중인 신규/이동/리사이즈 음표 프리뷰 표시
    if (activeDrag && activeDrag.draft) {
      const dSeg = activeDrag.draft;
      if (dSeg.note >= this.minNote && dSeg.note <= this.maxNote) {
        this._drawNoteBar(ctx, dSeg, viewStartMs, top, rowH, w, { preview: true });
      }
    }

    ctx.restore();
    ctx.globalAlpha = 1.0;

    // 왼쪽 여백 구분선
    ctx.strokeStyle = '#2c3547';
    ctx.beginPath();
    ctx.moveTo(this.leftMargin, 0);
    ctx.lineTo(this.leftMargin, h);
    ctx.stroke();

    // 5) 현재 재생 위치 플레이헤드 (빨간 세로선)
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

    if (!skipScrollSync) {
      this.onScrollSync(this.getScrollMetrics());
    }
  }
}

window.PianoRollRenderer = PianoRollRenderer;
