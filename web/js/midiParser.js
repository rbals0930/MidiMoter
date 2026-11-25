/**
 * 순수 JavaScript 표준 MIDI(.mid) 파서, 트랙별 매핑 및 4성부(4채널) 편곡 엔진
 * - SMF Format 0/1 파싱 + 트랙 이름/음표 수 추출
 * - 트랙별 포함 여부 & 수동 축 매핑(auto / X / Y / Z / A)
 * - 옥타브 시프트, 스타카토(음표 간 미세 무음 간격) 적용
 * - 피아노 롤 렌더링용 세그먼트 배열 생성
 */
(function (global) {
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /** MIDI 노트 번호(0~127) -> 주파수(Hz) 변환 (A4 = 69 = 440Hz) */
  function midiToFreq(note) {
    if (!note || note <= 0) return 0;
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  /** MIDI 노트 번호 -> 음이름 문자열 (예: 60 -> "C4") */
  function midiToNoteName(note) {
    if (!note || note <= 0) return '—';
    const name = NOTE_NAMES[note % 12];
    const octave = Math.floor(note / 12) - 1;
    return `${name}${octave}`;
  }

  /** 스텝모터 음역대(C2=36 ~ maxNote)로 옥타브 자동 보정 */
  function normalizeStepperPitch(note, maxNote = 91) {
    let n = note;
    while (n < 36) n += 12;
    if (maxNote < 127) {
      while (n > maxNote) n -= 12;
    }
    return n;
  }

  /**
   * 동시 발음 음표 배열을 4개 축 [X(최고음), Y(화음1), Z(화음2), A(최저음)]에 분배
   */
  function allocateFourVoices(activeNoteList, normalizeRange = true) {
    if (!activeNoteList || activeNoteList.length === 0) {
      return [0, 0, 0, 0];
    }

    const uniqueSet = new Set();
    for (const raw of activeNoteList) {
      if (raw > 0) {
        uniqueSet.add(normalizeRange ? normalizeStepperPitch(raw) : raw);
      }
    }

    const sorted = Array.from(uniqueSet).sort((a, b) => a - b);
    const len = sorted.length;

    if (len === 0) return [0, 0, 0, 0];
    if (len === 1) return [sorted[0], 0, 0, 0];
    if (len === 2) return [sorted[1], 0, 0, sorted[0]];
    if (len === 3) return [sorted[2], sorted[1], 0, sorted[0]];

    return [sorted[len - 1], sorted[len - 2], sorted[len - 3], sorted[0]];
  }

  /** Variable-Length Quantity(VLQ) 읽기 */
  function readVLQ(view, state) {
    let value = 0;
    while (state.offset < view.byteLength) {
      const byte = view.getUint8(state.offset++);
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  }

  /** ASCII 문자열 읽기 */
  function readStr(view, offset, len) {
    let s = '';
    for (let i = 0; i < len && offset + i < view.byteLength; i++) {
      s += String.fromCharCode(view.getUint8(offset + i));
    }
    return s;
  }

  /**
   * 4채널 프레임 배열 -> 피아노 롤 렌더링용 음표 블록 세그먼트 배열로 변환
   * 반환 형식: [{ ch, note, startMs, endMs }, ...]
   */
  function framesToSegments(frames, durationMs) {
    const segments = [];
    const open = [null, null, null, null];

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      for (let ch = 0; ch < 4; ch++) {
        const nextNote = f.notes[ch] || 0;
        const cur = open[ch];

        if (cur && cur.note !== nextNote) {
          cur.endMs = f.timeMs;
          if (cur.endMs > cur.startMs) segments.push(cur);
          open[ch] = null;
        }
        if (nextNote > 0 && !open[ch]) {
          open[ch] = { ch, note: nextNote, startMs: f.timeMs, endMs: f.timeMs };
        }
      }
    }

    // 마지막까지 열려 있는 세그먼트 닫기
    for (let ch = 0; ch < 4; ch++) {
      if (open[ch]) {
        open[ch].endMs = Math.max(durationMs, open[ch].startMs + 50);
        segments.push(open[ch]);
      }
    }

    return segments;
  }

  /**
   * 편집된 세그먼트 배열에서 같은 축(채널)의 겹침을 자동 절단해 단선율 유지
   * prioritySeg가 지정되면 해당 음표를 우선 보존하고 겹치는 기존 음표를 자르거나 분할함
   */
  function normalizeEditedSegments(segments, prioritySeg = null) {
    const MIN_LEN_MS = 25;
    let list = (segments || [])
      .filter((s) => s && s.ch >= 0 && s.ch <= 3 && s.note > 0 && s.endMs - s.startMs >= MIN_LEN_MS)
      .map((s) => ({
        ch: s.ch,
        note: Math.max(24, Math.min(108, Math.round(s.note))),
        startMs: Math.max(0, s.startMs),
        endMs: Math.max(0, s.endMs),
      }));

    if (prioritySeg) {
      const p = {
        ch: prioritySeg.ch,
        note: Math.max(24, Math.min(108, Math.round(prioritySeg.note))),
        startMs: Math.max(0, prioritySeg.startMs),
        endMs: Math.max(0, prioritySeg.endMs),
      };
      const resolved = [];
      for (const s of list) {
        if (s.ch !== p.ch) {
          resolved.push(s);
          continue;
        }
        // 겹치지 않는 경우 그대로 유지
        if (s.endMs <= p.startMs || s.startMs >= p.endMs) {
          resolved.push(s);
          continue;
        }
        // 기존 음이 새 음의 양쪽을 모두 감싸는 경우 좌우 분할
        if (s.startMs < p.startMs && s.endMs > p.endMs) {
          if (p.startMs - s.startMs >= MIN_LEN_MS) {
            resolved.push({ ...s, endMs: p.startMs });
          }
          if (s.endMs - p.endMs >= MIN_LEN_MS) {
            resolved.push({ ...s, startMs: p.endMs });
          }
        } else if (s.startMs < p.startMs) {
          if (p.startMs - s.startMs >= MIN_LEN_MS) {
            resolved.push({ ...s, endMs: p.startMs });
          }
        } else if (s.endMs > p.endMs) {
          if (s.endMs - p.endMs >= MIN_LEN_MS) {
            resolved.push({ ...s, startMs: p.endMs });
          }
        }
        // 기존 음이 새 음 안에 완전히 포함되면 삭제
      }
      if (p.endMs - p.startMs >= MIN_LEN_MS) {
        resolved.push(p);
      }
      list = resolved;
    }

    // 채널별 시간순 정렬 및 잔여 미세 겹침 정리
    list.sort((a, b) => a.ch - b.ch || a.startMs - b.startMs);
    const cleaned = [];
    for (let ch = 0; ch < 4; ch++) {
      const chSegs = list.filter((s) => s.ch === ch);
      for (let i = 0; i < chSegs.length; i++) {
        const cur = { ...chSegs[i] };
        if (i + 1 < chSegs.length && cur.endMs > chSegs[i + 1].startMs) {
          cur.endMs = chSegs[i + 1].startMs;
        }
        if (cur.endMs - cur.startMs >= MIN_LEN_MS) {
          cleaned.push(cur);
        }
      }
    }

    cleaned.sort((a, b) => a.startMs - b.startMs || a.ch - b.ch);
    return cleaned;
  }

  /**
   * 4채널 세그먼트 배열 -> 시퀀서 재생용 frames 배열 및 durationMs 역변환
   */
  function segmentsToFrames(segments, minDurationMs = 0) {
    const cleanSegs = normalizeEditedSegments(segments);
    const events = [];
    let maxEndMs = 0;

    for (const s of cleanSegs) {
      if (s.endMs > maxEndMs) maxEndMs = s.endMs;
      events.push({ timeMs: s.startMs, type: 'on', ch: s.ch, note: s.note });
      events.push({ timeMs: s.endMs, type: 'off', ch: s.ch, note: s.note });
    }

    // 동일 시각에는 off를 on보다 먼저 처리
    events.sort((a, b) => {
      if (Math.abs(a.timeMs - b.timeMs) > 0.5) return a.timeMs - b.timeMs;
      if (a.type === b.type) return a.ch - b.ch;
      return a.type === 'off' ? -1 : 1;
    });

    const curNotes = [0, 0, 0, 0];
    const frames = [];
    let idx = 0;

    while (idx < events.length) {
      const t = events[idx].timeMs;
      while (idx < events.length && events[idx].timeMs - t <= 0.5) {
        const ev = events[idx++];
        if (ev.type === 'on') {
          curNotes[ev.ch] = ev.note;
        } else if (curNotes[ev.ch] === ev.note) {
          curNotes[ev.ch] = 0;
        }
      }

      const snap = [...curNotes];
      const last = frames[frames.length - 1];
      if (
        !last ||
        last.notes[0] !== snap[0] ||
        last.notes[1] !== snap[1] ||
        last.notes[2] !== snap[2] ||
        last.notes[3] !== snap[3]
      ) {
        frames.push({ timeMs: t, notes: snap });
      }
    }

    const durationMs = Math.max(minDurationMs, maxEndMs > 0 ? maxEndMs + 200 : 0);
    if (frames.length > 0 && frames[frames.length - 1].notes.some((n) => n !== 0)) {
      frames.push({ timeMs: durationMs, notes: [0, 0, 0, 0] });
    }

    return {
      frames,
      segments: cleanSegs,
      durationMs,
    };
  }

  /**
   * ArrayBuffer 형태의 표준 MIDI 파일 파싱 (트랙별 원시 이벤트 보존)
   */
  function parseMidiRaw(buffer, title = 'MIDI 곡') {
    const view = new DataView(buffer);
    if (view.byteLength < 14 || readStr(view, 0, 4) !== 'MThd') {
      throw new Error('유효한 표준 MIDI(.mid) 파일 헤더(MThd)가 아닙니다.');
    }

    const headerLen = view.getUint32(4);
    const format = view.getUint16(8);
    const numTracks = view.getUint16(10);
    const division = view.getUint16(12);

    if (division & 0x8000) {
      throw new Error('SMPTE 타임코드 기반 MIDI는 현재 지원하지 않습니다.');
    }
    const ticksPerQuarter = division;

    let offset = 8 + headerLen;
    const tempoEvents = [{ tick: 0, usPerQuarter: 500000 }];
    const rawTracks = [];

    for (let t = 0; t < numTracks && offset + 8 <= view.byteLength; t++) {
      const chunkId = readStr(view, offset, 4);
      const chunkLen = view.getUint32(offset + 4);
      offset += 8;
      const trackEnd = Math.min(offset + chunkLen, view.byteLength);

      if (chunkId !== 'MTrk') {
        offset = trackEnd;
        continue;
      }

      const state = { offset };
      let absTick = 0;
      let runningStatus = 0;
      let trackName = '';
      const trackEvents = [];
      let noteOnCount = 0;

      while (state.offset < trackEnd) {
        const delta = readVLQ(view, state);
        absTick += delta;
        if (state.offset >= trackEnd) break;

        let status = view.getUint8(state.offset);
        if (status < 0x80) {
          status = runningStatus;
        } else {
          state.offset++;
          if (status < 0xf0) runningStatus = status;
        }

        if (status === 0xff) {
          if (state.offset >= trackEnd) break;
          const metaType = view.getUint8(state.offset++);
          const metaLen = readVLQ(view, state);
          if (metaType === 0x51 && metaLen === 3 && state.offset + 3 <= trackEnd) {
            const usPerQuarter =
              (view.getUint8(state.offset) << 16) |
              (view.getUint8(state.offset + 1) << 8) |
              view.getUint8(state.offset + 2);
            tempoEvents.push({ tick: absTick, usPerQuarter });
          } else if (metaType === 0x03 && metaLen > 0 && !trackName) {
            trackName = readStr(view, state.offset, metaLen).replace(/[^\x20-\x7E가-힣]/g, '').trim();
          }
          state.offset += metaLen;
        } else if (status === 0xf0 || status === 0xf7) {
          const sysexLen = readVLQ(view, state);
          state.offset += sysexLen;
        } else {
          const eventType = status & 0xf0;
          const channel = status & 0x0f;

          if (eventType === 0xc0 || eventType === 0xd0) {
            state.offset += 1;
          } else if (
            eventType === 0x80 ||
            eventType === 0x90 ||
            eventType === 0xa0 ||
            eventType === 0xb0 ||
            eventType === 0xe0
          ) {
            const data1 = state.offset < trackEnd ? view.getUint8(state.offset++) : 0;
            const data2 = state.offset < trackEnd ? view.getUint8(state.offset++) : 0;

            // 표준 퍼커션(드럼) 채널 10(인덱스 9) 제외
            if (channel !== 9) {
              if (eventType === 0x90 && data2 > 0) {
                trackEvents.push({ tick: absTick, type: 'on', note: data1, velocity: data2 });
                noteOnCount++;
              } else if (eventType === 0x80 || (eventType === 0x90 && data2 === 0)) {
                trackEvents.push({ tick: absTick, type: 'off', note: data1, velocity: 0 });
              }
            }
          }
        }
      }

      if (noteOnCount > 0) {
        rawTracks.push({
          index: rawTracks.length,
          name: trackName || `Track ${rawTracks.length + 1}`,
          noteCount: noteOnCount,
          enabled: true,
          targetAxis: 'auto', // 'auto' | '0' | '1' | '2' | '3'
          rawEvents: trackEvents,
        });
      }

      offset = trackEnd;
    }

    if (rawTracks.length === 0) {
      throw new Error('MIDI 파일에서 연주 가능한 음표 트랙을 찾지 못했습니다.');
    }

    // 템포 맵 정렬 및 틱 -> 밀리초(ms) 변환 테이블
    tempoEvents.sort((a, b) => a.tick - b.tick);
    const tempoSegments = [];
    let accMs = 0;
    let prevTick = 0;
    let prevUs = 500000;

    for (const te of tempoEvents) {
      if (te.tick > prevTick) {
        accMs += ((te.tick - prevTick) * prevUs) / (ticksPerQuarter * 1000);
      }
      tempoSegments.push({ tick: te.tick, startMs: accMs, usPerQuarter: te.usPerQuarter });
      prevTick = te.tick;
      prevUs = te.usPerQuarter;
    }

    function tickToMs(tick) {
      let seg = tempoSegments[0];
      for (let i = tempoSegments.length - 1; i >= 0; i--) {
        if (tick >= tempoSegments[i].tick) {
          seg = tempoSegments[i];
          break;
        }
      }
      return seg.startMs + ((tick - seg.tick) * seg.usPerQuarter) / (ticksPerQuarter * 1000);
    }

    // 각 트랙의 on/off 이벤트를 (startMs, endMs, durMs, note, velocity) 음표 객체로 페어링
    const tracks = rawTracks.map((tr) => {
      const timed = tr.rawEvents.map((ev) => ({
        timeMs: tickToMs(ev.tick),
        type: ev.type,
        note: ev.note,
        velocity: ev.velocity || 80,
      }));

      const openMap = new Map(); // note -> [{ startMs, velocity }]
      const notes = [];

      for (const ev of timed) {
        if (ev.type === 'on') {
          if (!openMap.has(ev.note)) openMap.set(ev.note, []);
          openMap.get(ev.note).push({ startMs: ev.timeMs, velocity: ev.velocity });
        } else {
          const stack = openMap.get(ev.note);
          if (stack && stack.length > 0) {
            const started = stack.shift();
            const durMs = Math.max(0, ev.timeMs - started.startMs);
            if (durMs > 0) {
              notes.push({
                startMs: started.startMs,
                endMs: ev.timeMs,
                durMs,
                note: ev.note,
                velocity: started.velocity,
              });
            }
          }
        }
      }

      return {
        index: tr.index,
        name: tr.name,
        noteCount: notes.length,
        enabled: tr.enabled,
        targetAxis: tr.targetAxis,
        notes,
      };
    });

    // 4트랙 축 이름 패턴(X-Axis, Y-Axis, Z-Axis, A-Axis 등)이 2개 이상 감지되면 자동으로 축 고정 매핑
    const axisMatches = tracks.map((tr) => {
      if (/^(?:X[-_\s]|X-Axis)/i.test(tr.name)) return '0';
      if (/^(?:Y[-_\s]|Y-Axis)/i.test(tr.name)) return '1';
      if (/^(?:Z[-_\s]|Z-Axis)/i.test(tr.name)) return '2';
      if (/^(?:A[-_\s]|A-Axis)/i.test(tr.name)) return '3';
      return null;
    });
    let autoMapped = false;
    if (axisMatches.filter((m) => m !== null).length >= 2) {
      const usedAxes = new Set();
      tracks.forEach((tr, i) => {
        const ax = axisMatches[i];
        if (ax !== null && !usedAxes.has(ax)) {
          tr.targetAxis = ax;
          usedAxes.add(ax);
          autoMapped = true;
        }
      });
    }

    return {
      title,
      format,
      numTracks: tracks.length,
      autoMapped,
      tracks,
    };
  }

  /**
   * 채널별 독립 스타카토/게이트 적용
   * - 전역 프레임 단위가 아니라 각 축의 세그먼트 단위로 계산해
   *   음정 전환과 같은 음 연타 모두에 확실한 무음 틈 삽입
   */
  function applyChannelStaccato(segments, staccatoMs) {
    if (!segments || segments.length === 0 || !staccatoMs || staccatoMs <= 0) {
      return segments || [];
    }

    const result = [];
    for (let ch = 0; ch < 4; ch++) {
      const chSegs = segments
        .filter((s) => s.ch === ch)
        .sort((a, b) => a.startMs - b.startMs)
        .map((s) => ({ ...s }));

      for (let i = 0; i < chSegs.length; i++) {
        const cur = chSegs[i];
        if (i + 1 < chSegs.length) {
          const nxt = chSegs[i + 1];
          const origDur = cur.endMs - cur.startMs;
          // 짧은 음표가 최소 길이(25ms) 미만으로 떨어져 탈락하지 않도록 보호
          const minKeep = origDur >= 25 ? Math.max(25, Math.min(55, origDur * 0.6)) : origDur;
          const targetEnd = nxt.startMs - staccatoMs;
          if (targetEnd < cur.endMs) {
            cur.endMs = Math.max(cur.startMs + minKeep, targetEnd);
          }
        }
        if (cur.endMs > cur.startMs) {
          result.push(cur);
        }
      }
    }

    result.sort((a, b) => a.startMs - b.startMs || a.ch - b.ch);
    return result;
  }

  /**
   * 트랙 설정 + 옥타브 시프트 + 고음 상한 + 잡음 제거(최소 길이/강도) + 분배/보강 모드 + 스타카토 반영
   * @param {object} parsedMidi parseMidiRaw() 반환 객체
   * @param {object} options { octaveShift, staccatoMs, maxNote, minDurationMs, minVelocity, allocMode, voiceFillMode }
   */
  function buildFourAxisTimeline(parsedMidi, options = {}) {
    const octaveShift = options.octaveShift || 0;
    const staccatoMs = Math.max(0, options.staccatoMs || 0);
    const maxNote = options.maxNote || 91;
    const minDurationMs = Math.max(0, options.minDurationMs || 0);
    const minVelocity = Math.max(0, options.minVelocity || 0);
    const allocMode = options.allocMode || 'smart'; // 'smart' | 'pitch'
    const voiceFillMode = options.voiceFillMode || 'original'; // 'original' | 'harmonize'

    // 활성화된 트랙에서 잡음 필터(최소 길이/최소 강도)를 통과한 음표만 on/off 이벤트로 전개
    const merged = [];
    for (const tr of parsedMidi.tracks) {
      if (!tr.enabled) continue;
      const axis = tr.targetAxis || 'auto';
      for (const n of tr.notes) {
        if (n.durMs < minDurationMs) continue;
        if (n.velocity < minVelocity) continue;
        merged.push({ timeMs: n.startMs, type: 'on', note: n.note, velocity: n.velocity, targetAxis: axis });
        merged.push({ timeMs: n.endMs, type: 'off', note: n.note, velocity: n.velocity, targetAxis: axis });
      }
    }

    if (merged.length === 0) {
      return {
        title: parsedMidi.title,
        durationMs: 0,
        frames: [],
        segments: [],
      };
    }

    merged.sort((a, b) => {
      if (Math.abs(a.timeMs - b.timeMs) > 0.001) return a.timeMs - b.timeMs;
      if (a.type === b.type) return a.note - b.note;
      return a.type === 'off' ? -1 : 1;
    });

    // 버킷별 활성 음표의 velocity 배열 관리: Map<rawNote, number[]>
    const buckets = {
      '0': new Map(),
      '1': new Map(),
      '2': new Map(),
      '3': new Map(),
      auto: new Map(),
    };

    function shiftAndClamp(note) {
      const n = normalizeStepperPitch(note, maxNote) + octaveShift * 12;
      return Math.max(24, Math.min(108, n));
    }

    // auto 트랙 전체 음역 분포에서 4단 계층(베이스/미들/멜로디/하이) 경계 1회 산출
    const autoPitches = [];
    for (const ev of merged) {
      if (ev.type === 'on' && ev.targetAxis === 'auto') {
        autoPitches.push(shiftAndClamp(ev.note));
      }
    }
    let autoBassMax = 48;
    let autoMidMax = 58;
    let autoMelMax = 70;
    if (autoPitches.length > 0) {
      autoPitches.sort((a, b) => a - b);
      const pct = (ratio) => autoPitches[Math.min(autoPitches.length - 1, Math.floor((autoPitches.length - 1) * ratio))];
      autoBassMax = Math.max(46, Math.min(53, pct(0.25)));
      autoMidMax = Math.max(autoBassMax + 7, Math.min(64, pct(0.55)));
      autoMelMax = Math.max(autoMidMax + 7, Math.min(74, pct(0.82)));
    }

    function getBucketCandidates(map) {
      // 동일 보정 피치가 여러 개면 가장 강한 velocity 유지
      const byPitch = new Map();
      for (const [rawNote, vels] of map.entries()) {
        if (!vels || vels.length === 0) continue;
        const pitch = shiftAndClamp(rawNote);
        let maxV = 0;
        for (const v of vels) if (v > maxV) maxV = v;
        const prev = byPitch.get(pitch) || 0;
        if (maxV > prev) byPitch.set(pitch, maxV);
      }
      return Array.from(byPitch.entries()).map(([pitch, vel]) => ({ pitch, vel }));
    }

    // 이전 프레임의 4축 음표 및 단선율 솔로 연속 축 기억
    let prevResolved = [0, 0, 0, 0];
    let lastSoloAxis = 1;

    function resolveFourAxes() {
      const result = [0, 0, 0, 0];

      // 1) 수동 고정 매핑된 축 우선 배치
      for (let ch = 0; ch < 4; ch++) {
        const cands = getBucketCandidates(buckets[String(ch)]);
        if (cands.length > 0) {
          cands.sort((a, b) => a.pitch - b.pitch);
          result[ch] = ch === 3 ? cands[0].pitch : cands[cands.length - 1].pitch;
        }
      }

      // 2) 남은 빈 축 목록
      const emptyAxes = [];
      for (let ch = 0; ch < 4; ch++) {
        if (result[ch] === 0) emptyAxes.push(ch);
      }

      if (emptyAxes.length > 0 && buckets.auto.size > 0) {
        let cands = getBucketCandidates(buckets.auto);

        if (allocMode === 'pitch') {
          // 기존 단순 높이순 분배 모드
          const sorted = cands.map((c) => c.pitch).sort((a, b) => a - b);
          if (emptyAxes.length === 4) {
            const alloc = allocateFourVoices(sorted, false);
            for (let i = 0; i < 4; i++) result[i] = alloc[i];
          } else {
            const remaining = [...sorted];
            if (emptyAxes.includes(3) && remaining.length >= 2) {
              result[3] = remaining.shift();
            }
            for (const ch of emptyAxes) {
              if (result[ch] === 0 && remaining.length > 0) {
                result[ch] = remaining.pop();
              }
            }
          }
        } else {
          // -------------------------------------------------------
          // 스마트 4단 계층 비침범 분배 모드 (v6.0: 솔로 비분열 + X>Y>Z>A 적층)
          // 1) 수동 축 및 1반음 충돌(배음/비브라토 오탐지) 제거
          // 2) 단선율 솔로 음은 A축으로 빠지지 않고 Y/X 솔로 축에 연속 유지
          // 3) 2~4성부 다성 구간은 X(하이) > Y(멜로디) > Z(미들) > A(베이스) 역전 없이 배치
          // -------------------------------------------------------
          const fixedPitches = [];
          for (let ch = 0; ch < 4; ch++) {
            if (result[ch] > 0) fixedPitches.push(result[ch]);
          }

          cands.sort((a, b) => b.vel - a.vel || b.pitch - a.pitch);
          const cleanCands = [];
          for (const c of cands) {
            if (fixedPitches.some((fp) => Math.abs(fp - c.pitch) <= 1)) continue;
            if (!cleanCands.some((kept) => Math.abs(kept.pitch - c.pitch) <= 1)) {
              cleanCands.push(c);
            }
          }

          const k = emptyAxes.length;
          if (cleanCands.length === 1) {
            const soloPitch = cleanCands[0].pitch;
            let pickAx = -1;
            for (const ch of emptyAxes) {
              if (prevResolved[ch] === soloPitch) {
                pickAx = ch;
                break;
              }
            }
            if (pickAx < 0) {
              if (soloPitch <= autoBassMax - 4 && emptyAxes.includes(3)) {
                pickAx = 3;
              } else if (soloPitch > autoMelMax + 2 && emptyAxes.includes(0)) {
                pickAx = 0;
              } else if (soloPitch <= autoMidMax && emptyAxes.includes(1)) {
                pickAx = 1;
              } else if (emptyAxes.includes(lastSoloAxis)) {
                pickAx = lastSoloAxis;
              } else {
                const order = [1, 0, 2, 3];
                const found = order.find((ax) => emptyAxes.includes(ax));
                pickAx = found !== undefined ? found : emptyAxes[0];
              }
            }
            if (pickAx >= 0) {
              result[pickAx] = soloPitch;
              if ((pickAx === 0 || pickAx === 1) && soloPitch > autoMidMax) {
                lastSoloAxis = pickAx;
              }
            }
          } else if (cleanCands.length >= 2) {
            let picked = [];
            if (cleanCands.length <= k) {
              picked = cleanCands.map((c) => c.pitch);
            } else {
              const maxVel = cleanCands[0].vel || 1;
              const pool = [...cleanCands];

              // (a) 주멜로디 후보: 최대 음량 65% 이상 중 최고음
              const melodyPool = pool.filter((c) => c.vel >= maxVel * 0.65);
              const melPick = (melodyPool.length > 0 ? melodyPool : pool).reduce((best, cur) =>
                cur.pitch > best.pitch ? cur : best
              );
              picked.push(melPick.pitch);
              pool.splice(pool.indexOf(melPick), 1);

              // (b) 베이스 후보: A축(3)이 비어있으면 55% 이상 중 최저음
              if (picked.length < k && emptyAxes.includes(3) && pool.length > 0) {
                const bassPool = pool.filter((c) => c.vel >= maxVel * 0.55);
                const bassPick = (bassPool.length > 0 ? bassPool : pool).reduce((best, cur) =>
                  cur.pitch < best.pitch ? cur : best
                );
                picked.push(bassPick.pitch);
                pool.splice(pool.indexOf(bassPick), 1);
              }

              // (c) 나머지 화음 축: 음량 순으로 채움
              pool.sort((a, b) => b.vel - a.vel || b.pitch - a.pitch);
              while (picked.length < k && pool.length > 0) {
                picked.push(pool.shift().pitch);
              }
            }

            // 높은 음 -> 낮은 음 내림차순 정렬로 X > Y > Z > A 보장
            picked.sort((a, b) => b - a);

            if (k === 4) {
              if (picked.length === 2) {
                const [hi, lo] = picked;
                if (lo <= autoBassMax + 3) {
                  result[3] = lo;
                  result[hi > autoMelMax ? 0 : 1] = hi;
                } else if (hi > autoMelMax) {
                  result[0] = hi;
                  result[lo > autoMidMax ? 1 : 2] = lo;
                } else {
                  result[1] = hi;
                  result[2] = lo;
                }
              } else if (picked.length === 3) {
                const [hi, mid, lo] = picked;
                if (lo <= autoBassMax + 3) {
                  result[3] = lo;
                  if (hi > autoMelMax) {
                    result[0] = hi;
                    result[mid > autoMidMax ? 1 : 2] = mid;
                  } else {
                    result[1] = hi;
                    result[2] = mid;
                  }
                } else {
                  result[0] = hi;
                  result[1] = mid;
                  result[2] = lo;
                }
              } else {
                result[0] = picked[0];
                result[1] = picked[1];
                result[2] = picked[2];
                result[3] = picked[3];
              }
            } else {
              // 일부 축이 수동 고정된 혼합 매핑
              let remAxes = [...emptyAxes];
              if (remAxes.includes(3) && picked[picked.length - 1] <= autoBassMax + 3) {
                result[3] = picked.pop();
                remAxes = remAxes.filter((ax) => ax !== 3);
              }
              if (picked.length === 2 && remAxes.length === 3 && remAxes[0] === 0 && remAxes[1] === 1 && remAxes[2] === 2) {
                const [hi, lo] = picked;
                if (hi > autoMelMax) {
                  result[0] = hi;
                  result[lo > autoMidMax ? 1 : 2] = lo;
                } else {
                  result[1] = hi;
                  result[2] = lo;
                }
              } else {
                for (let i = 0; i < picked.length && i < remAxes.length; i++) {
                  result[remAxes[i]] = picked[i];
                }
              }
            }
          }
        }
      }

      prevResolved = [...result];

      if (voiceFillMode === 'harmonize') {
        const filled = [...result];
        const hasCollision = (cand, arr) =>
          arr.some((p) => p > 0 && (p === cand || Math.abs(p - cand) === 1));
        const maxBound = Math.min(108, maxNote + octaveShift * 12);
        const inRange = (p) => p >= 36 && p <= maxBound;

        if (filled[0] > 0 && filled[3] > 0) {
          const xNote = filled[0];
          const aNote = filled[3];
          if (filled[1] === 0) {
            const yCands = [aNote + 19, aNote + 12, xNote - 12, aNote + 7];
            const pickY = yCands.find((c) => inRange(c) && !hasCollision(c, filled));
            if (pickY) filled[1] = pickY;
          }
          if (filled[2] === 0) {
            const zCands = [aNote + 12, aNote + 7, xNote - 12, aNote + 19];
            const pickZ = zCands.find((c) => inRange(c) && !hasCollision(c, filled));
            if (pickZ) filled[2] = pickZ;
          }
        } else if (filled[0] > 0 && filled[1] === 0 && filled[2] === 0 && filled[3] === 0) {
          const octDown = filled[0] - 12;
          if (inRange(octDown)) filled[1] = octDown;
        } else if (filled[0] > 0 && filled[1] > 0 && filled[2] === 0 && filled[3] === 0) {
          const lowOct = Math.min(filled[0], filled[1]) - 12;
          if (inRange(lowOct) && !hasCollision(lowOct, filled)) filled[3] = lowOct;
        }
        return filled;
      }

      return result;
    }

    const rawFrames = [];
    let idx = 0;

    while (idx < merged.length) {
      const currentTime = merged[idx].timeMs;

      while (idx < merged.length && merged[idx].timeMs - currentTime <= 1.0) {
        const ev = merged[idx++];
        const map = buckets[ev.targetAxis] || buckets.auto;
        if (ev.type === 'on') {
          if (!map.has(ev.note)) map.set(ev.note, []);
          map.get(ev.note).push(ev.velocity || 80);
        } else {
          const arr = map.get(ev.note);
          if (arr && arr.length > 1) {
            arr.shift();
          } else {
            map.delete(ev.note);
          }
        }
      }

      const notes = resolveFourAxes();
      const last = rawFrames[rawFrames.length - 1];
      if (
        !last ||
        last.notes[0] !== notes[0] ||
        last.notes[1] !== notes[1] ||
        last.notes[2] !== notes[2] ||
        last.notes[3] !== notes[3]
      ) {
        rawFrames.push({ timeMs: currentTime, notes });
      }
    }

    const rawDurationMs = rawFrames.length > 0 ? rawFrames[rawFrames.length - 1].timeMs + 200 : 0;

    // 채널별 독립 스타카토 간격(ms) 적용: 음정 전환 및 같은 음 연타 모두에 무음 틈 삽입
    if (staccatoMs > 0 && rawFrames.length > 0) {
      const rawSegments = framesToSegments(rawFrames, rawDurationMs);
      const articulatedSegs = applyChannelStaccato(rawSegments, staccatoMs);
      const rebuilt = segmentsToFrames(articulatedSegs, rawDurationMs);
      return {
        title: parsedMidi.title,
        durationMs: rebuilt.durationMs,
        frames: rebuilt.frames,
        segments: rebuilt.segments,
      };
    }

    if (rawFrames.length > 0 && rawFrames[rawFrames.length - 1].notes.some((n) => n !== 0)) {
      rawFrames.push({ timeMs: rawDurationMs, notes: [0, 0, 0, 0] });
    }

    return {
      title: parsedMidi.title,
      durationMs: rawDurationMs,
      frames: rawFrames,
      segments: framesToSegments(rawFrames, rawDurationMs),
    };
  }

  /** 기존 호환용 원스톱 파싱 래퍼 */
  function parseMidiArrayBuffer(buffer, title = 'MIDI 곡') {
    const raw = parseMidiRaw(buffer, title);
    const timeline = buildFourAxisTimeline(raw);
    return { ...timeline, rawMidi: raw };
  }

  global.MidiParser = {
    midiToFreq,
    midiToNoteName,
    normalizeStepperPitch,
    allocateFourVoices,
    applyChannelStaccato,
    framesToSegments,
    normalizeEditedSegments,
    segmentsToFrames,
    parseMidiRaw,
    buildFourAxisTimeline,
    parseMidiArrayBuffer,
  };
})(window);
