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

    return {
      title,
      format,
      numTracks: tracks.length,
      tracks,
    };
  }

  /**
   * 트랙 설정 + 옥타브 시프트 + 고음 상한 + 잡음 제거(최소 길이/강도) + 분배 모드 + 스타카토 반영
   * @param {object} parsedMidi parseMidiRaw() 반환 객체
   * @param {object} options { octaveShift, staccatoMs, maxNote, minDurationMs, minVelocity, allocMode }
   */
  function buildFourAxisTimeline(parsedMidi, options = {}) {
    const octaveShift = options.octaveShift || 0;
    const staccatoMs = Math.max(0, options.staccatoMs || 0);
    const maxNote = options.maxNote || 91;
    const minDurationMs = Math.max(0, options.minDurationMs || 0);
    const minVelocity = Math.max(0, options.minVelocity || 0);
    const allocMode = options.allocMode || 'smart'; // 'smart' | 'pitch'

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

    // 이전 프레임의 4축 음표 기억 (Voice Locking 연속성 유지용)
    let prevResolved = [0, 0, 0, 0];

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
          // 스마트 4성부 분배 모드 (유튜브/풍부한 음원 AI 채보 최적화)
          // 1) 1반음 충돌(배음/비브라토 오탐지) 제거: 더 강한 음만 생존
          // 2) Salient Skyline(강한 최고음 멜로디) + 강한 베이스 + 핵심 화음 선별
          // 3) Voice Locking: 이전 프레임에서 울리던 음은 같은 축에 고정 유지
          // -------------------------------------------------------
          cands.sort((a, b) => b.vel - a.vel || b.pitch - a.pitch);
          const cleanCands = [];
          for (const c of cands) {
            const clashes = cleanCands.some((kept) => Math.abs(kept.pitch - c.pitch) === 1);
            if (!clashes) cleanCands.push(c);
          }

          const k = emptyAxes.length;
          let selected = [];

          if (cleanCands.length <= k) {
            selected = cleanCands.map((c) => c.pitch);
          } else {
            const maxVel = cleanCands[0].vel || 1;
            const pool = [...cleanCands];

            // (a) 주멜로디 후보: 최대 음량의 65% 이상인 뚜렷한 음 중 가장 높은 음 (약한 고음 배음 무시)
            const melodyPool = pool.filter((c) => c.vel >= maxVel * 0.65);
            const melPick = (melodyPool.length > 0 ? melodyPool : pool).reduce((best, cur) =>
              cur.pitch > best.pitch ? cur : best
            );
            selected.push(melPick.pitch);
            pool.splice(pool.indexOf(melPick), 1);

            // (b) 베이스 후보: A축이 비어있고 음이 2개 이상 필요하면, 55% 이상 강도의 가장 낮은 음 선택
            if (selected.length < k && emptyAxes.includes(3) && pool.length > 0) {
              const bassPool = pool.filter((c) => c.vel >= maxVel * 0.55);
              const bassPick = (bassPool.length > 0 ? bassPool : pool).reduce((best, cur) =>
                cur.pitch < best.pitch ? cur : best
              );
              selected.push(bassPick.pitch);
              pool.splice(pool.indexOf(bassPick), 1);
            }

            // (c) 나머지 화음 축: 음량(Velocity)이 가장 강한 핵심 화음 순으로 채움
            pool.sort((a, b) => b.vel - a.vel || b.pitch - a.pitch);
            while (selected.length < k && pool.length > 0) {
              selected.push(pool.shift().pitch);
            }
          }

          // Voice Locking: 이전 프레임에서 이미 울리고 있던 음은 같은 축에 그대로 고정
          const unassignedPitches = new Set(selected);
          const remainingAxes = [];
          for (const ch of emptyAxes) {
            const prevPitch = prevResolved[ch];
            if (prevPitch > 0 && unassignedPitches.has(prevPitch)) {
              result[ch] = prevPitch;
              unassignedPitches.delete(prevPitch);
            } else {
              remainingAxes.push(ch);
            }
          }

          // 새로 진입한 음표를 남은 축에 높이 역할순(최저음->A축, 고음->X·Y·Z축)으로 배치
          const restSorted = Array.from(unassignedPitches).sort((a, b) => a - b);
          if (remainingAxes.includes(3) && restSorted.length > 0) {
            result[3] = restSorted.shift();
          }
          for (const ch of remainingAxes) {
            if (result[ch] === 0 && restSorted.length > 0) {
              result[ch] = restSorted.pop();
            }
          }
        }
      }

      prevResolved = [...result];
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

    // 스타카토 간격(ms) 적용: 음표가 전환되는 채널에 짧은 무음 틈 삽입
    let finalFrames = rawFrames;
    if (staccatoMs > 0 && rawFrames.length > 1) {
      finalFrames = [];
      for (let i = 0; i < rawFrames.length; i++) {
        const cur = rawFrames[i];
        finalFrames.push(cur);

        if (i + 1 < rawFrames.length) {
          const next = rawFrames[i + 1];
          const dur = next.timeMs - cur.timeMs;
          if (dur > 35) {
            const gapNotes = [...cur.notes];
            let needGap = false;
            for (let ch = 0; ch < 4; ch++) {
              // 현재 음이 울리고 있고 다음 프레임에서 다른 음으로 바뀔 때 짧은 숨표 삽입
              if (cur.notes[ch] > 0 && next.notes[ch] > 0 && cur.notes[ch] !== next.notes[ch]) {
                gapNotes[ch] = 0;
                needGap = true;
              }
            }
            if (needGap) {
              const gap = Math.min(staccatoMs, dur * 0.35);
              finalFrames.push({ timeMs: next.timeMs - gap, notes: gapNotes });
            }
          }
        }
      }
    }

    const durationMs = finalFrames.length > 0 ? finalFrames[finalFrames.length - 1].timeMs + 200 : 0;
    if (finalFrames.length > 0 && finalFrames[finalFrames.length - 1].notes.some((n) => n !== 0)) {
      finalFrames.push({ timeMs: durationMs, notes: [0, 0, 0, 0] });
    }

    return {
      title: parsedMidi.title,
      durationMs,
      frames: finalFrames,
      segments: framesToSegments(finalFrames, durationMs),
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
    framesToSegments,
    parseMidiRaw,
    buildFourAxisTimeline,
    parseMidiArrayBuffer,
  };
})(window);
