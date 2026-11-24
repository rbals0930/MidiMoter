/**
 * MidiMoter 웹 컨트롤러 메인 애플리케이션 (v2.0)
 * - 시리얼 연결, 4축 상태 표시, MIDI 트랙 매핑·재편곡, 4채널 피아노 롤,
 *   단독 .ino 내보내기, 내장 데모 곡, 가상 건반 통합 관리
 */
(function () {
  const {
    midiToFreq,
    midiToNoteName,
    allocateFourVoices,
    framesToSegments,
    parseMidiRaw,
    buildFourAxisTimeline,
  } = window.MidiParser;

  // UI 요소 참조
  const el = {
    serialStatus: document.getElementById('serialStatus'),
    btnConnect: document.getElementById('btnConnect'),
    btnDisconnect: document.getElementById('btnDisconnect'),
    btnHardwareTest: document.getElementById('btnHardwareTest'),
    btnEmergencyStop: document.getElementById('btnEmergencyStop'),
    microstepSelect: document.getElementById('microstepSelect'),
    chkAudioPreview: document.getElementById('chkAudioPreview'),
    volumeSlider: document.getElementById('volumeSlider'),
    dropZone: document.getElementById('dropZone'),
    midiFileInput: document.getElementById('midiFileInput'),
    btnBrowseMidi: document.getElementById('btnBrowseMidi'),
    songTitle: document.getElementById('songTitle'),
    songMeta: document.getElementById('songMeta'),
    timeCurrent: document.getElementById('timeCurrent'),
    timeTotal: document.getElementById('timeTotal'),
    seekBar: document.getElementById('seekBar'),
    btnPlay: document.getElementById('btnPlay'),
    btnPause: document.getElementById('btnPause'),
    btnStop: document.getElementById('btnStop'),
    speedSlider: document.getElementById('speedSlider'),
    speedLabel: document.getElementById('speedLabel'),
    transposeSlider: document.getElementById('transposeSlider'),
    transposeLabel: document.getElementById('transposeLabel'),
    octaveSelect: document.getElementById('octaveSelect'),
    allocModeSelect: document.getElementById('allocModeSelect'),
    maxNoteSelect: document.getElementById('maxNoteSelect'),
    staccatoSlider: document.getElementById('staccatoSlider'),
    staccatoLabel: document.getElementById('staccatoLabel'),
    minDurSlider: document.getElementById('minDurSlider'),
    minDurLabel: document.getElementById('minDurLabel'),
    minVelSlider: document.getElementById('minVelSlider'),
    minVelLabel: document.getElementById('minVelLabel'),
    btnExportIno: document.getElementById('btnExportIno'),
    trackListPanel: document.getElementById('trackListPanel'),
    trackTableBody: document.getElementById('trackTableBody'),
    pianoRollCanvas: document.getElementById('pianoRollCanvas'),
    zoomSlider: document.getElementById('zoomSlider'),
    pianoKeyboard: document.getElementById('pianoKeyboard'),
    serialLog: document.getElementById('serialLog'),
    btnClearLog: document.getElementById('btnClearLog'),
    backendStatus: document.getElementById('backendStatus'),
    btnCheckBackend: document.getElementById('btnCheckBackend'),
    youtubeUrlInput: document.getElementById('youtubeUrlInput'),
    aiModeSelect: document.getElementById('aiModeSelect'),
    btnConvertYoutube: document.getElementById('btnConvertYoutube'),
    audioFileInput: document.getElementById('audioFileInput'),
    btnBrowseAudio: document.getElementById('btnBrowseAudio'),
    convertStatus: document.getElementById('convertStatus'),
  };

  const BACKEND_URL = 'http://127.0.0.1:8765';

  // 상태 관리
  const state = {
    channelNotes: [0, 0, 0, 0],
    channelMuted: [false, false, false, false],
    microstepMult: 1,
    transpose: 0,
    octaveShift: 0,
    allocMode: 'smart',     // 'smart' (음량+연속성+반음제거) | 'pitch' (단순 높이순)
    maxNote: 91,            // 기본 고음 상한 G6(91)
    staccatoMs: 0,
    minDurationMs: 0,       // 실시간 잡음 컷: 최소 음표 길이(ms)
    minVelocity: 0,         // 실시간 잡음 컷: 최소 강도(0~127)
    speed: 1.0,
    rawMidi: null,          // 업로드된 MIDI 원본(트랙 재편곡용)
    presetKey: null,        // 내장 프리셋 키 (옵션 변경 시 재빌드용)
    song: null,             // 현재 활성 4성부 곡 { title, durationMs, frames, segments }
    isPlaying: false,
    playheadMs: 0,
    frameIdx: 0,
    lastTickPerfMs: 0,
    rafId: null,
    pressedKeys: new Set(),
  };

  function appendLog(msg) {
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    el.serialLog.textContent += `\n[${time}] ${msg}`;
    el.serialLog.scrollTop = el.serialLog.scrollHeight;
  }

  // 시리얼, 오디오 미리듣기, 피아노 롤 인스턴스 생성
  const serial = new window.MidiMoterSerial(appendLog, (connected) => {
    el.serialStatus.textContent = connected ? '연결됨 (115200bps)' : '미연결';
    el.serialStatus.className = `status-pill ${connected ? 'connected' : 'disconnected'}`;
    el.btnConnect.disabled = connected;
    el.btnDisconnect.disabled = !connected;
    el.btnHardwareTest.disabled = !connected;
  });

  const audio = new window.AudioPreviewSynth();

  const pianoRoll = new window.PianoRollRenderer(el.pianoRollCanvas, (targetMs) => {
    seekToMs(targetMs);
  });

  // ---------------------------------------------------------
  // 4채널 출력 반영 (UI + 브라우저 오디오 + 아두이노 시리얼)
  // ---------------------------------------------------------
  function applyChannelNotes(notes, forceSend = false) {
    const shiftedNotes = notes.map((n, ch) => {
      if (!n || state.channelMuted[ch]) return 0;
      return Math.max(24, Math.min(108, n + state.transpose));
    });

    const changed =
      forceSend || shiftedNotes.some((n, i) => n !== state.channelNotes[i]);

    if (!changed) return;
    state.channelNotes = shiftedNotes;

    const audioFreqs = [0, 0, 0, 0];
    const motorFreqsX10 = [0, 0, 0, 0];

    for (let ch = 0; ch < 4; ch++) {
      const note = shiftedNotes[ch];
      const baseHz = midiToFreq(note);
      audioFreqs[ch] = baseHz;
      const motorHz = Math.min(10000, baseHz * state.microstepMult);
      motorFreqsX10[ch] = Math.round(motorHz * 10);

      const card = document.getElementById(`chCard${ch}`);
      const noteEl = document.getElementById(`chNote${ch}`);
      const freqEl = document.getElementById(`chFreq${ch}`);
      if (note > 0) {
        card.classList.add('active');
        noteEl.textContent = midiToNoteName(note);
        freqEl.textContent =
          state.microstepMult > 1
            ? `${baseHz.toFixed(1)} Hz (×${state.microstepMult} → ${motorHz.toFixed(0)} Hz)`
            : `${baseHz.toFixed(1)} Hz`;
      } else {
        card.classList.remove('active');
        noteEl.textContent = state.channelMuted[ch] ? 'MUTE' : '—';
        freqEl.textContent = '0.0 Hz';
      }
    }

    audio.setAllFreqs(audioFreqs);
    if (serial.isConnected) {
      serial.sendAllChannels(motorFreqsX10);
    }
  }

  function silenceAll() {
    applyChannelNotes([0, 0, 0, 0], true);
    audio.stopAll();
    if (serial.isConnected) {
      serial.stopAll();
    }
  }

  function formatTime(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  }

  // ---------------------------------------------------------
  // 트랙 선택 UI 렌더링 (MIDI 파일 로드 시)
  // ---------------------------------------------------------
  function renderTrackTable(rawMidi) {
    if (!rawMidi || !rawMidi.tracks || rawMidi.tracks.length === 0) {
      el.trackListPanel.classList.add('hidden');
      el.trackTableBody.innerHTML = '';
      return;
    }

    el.trackListPanel.classList.remove('hidden');
    el.trackTableBody.innerHTML = '';

    rawMidi.tracks.forEach((tr) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><input type="checkbox" ${tr.enabled ? 'checked' : ''} /></td>
        <td>${tr.name}</td>
        <td>${tr.noteCount.toLocaleString()}개</td>
        <td>
          <select>
            <option value="auto" ${tr.targetAxis === 'auto' ? 'selected' : ''}>자동 4성부 분배</option>
            <option value="0" ${tr.targetAxis === '0' ? 'selected' : ''}>X축 고정 (멜로디)</option>
            <option value="1" ${tr.targetAxis === '1' ? 'selected' : ''}>Y축 고정 (화음 1)</option>
            <option value="2" ${tr.targetAxis === '2' ? 'selected' : ''}>Z축 고정 (화음 2)</option>
            <option value="3" ${tr.targetAxis === '3' ? 'selected' : ''}>A축 고정 (베이스)</option>
          </select>
        </td>
      `;

      const chk = row.querySelector('input[type="checkbox"]');
      const sel = row.querySelector('select');

      chk.addEventListener('change', () => {
        tr.enabled = chk.checked;
        rebuildCurrentSong(true);
      });
      sel.addEventListener('change', () => {
        tr.targetAxis = sel.value;
        rebuildCurrentSong(true);
      });

      el.trackTableBody.appendChild(row);
    });
  }

  // ---------------------------------------------------------
  // 편곡 옵션(트랙·옥타브·스타카토) 변경 시 타임라인 재빌드
  // ---------------------------------------------------------
  function rebuildCurrentSong(preservePosition = false) {
    const prevMs = preservePosition ? state.playheadMs : 0;
    const wasPlaying = preservePosition && state.isPlaying;

    if (state.rawMidi) {
      const timeline = buildFourAxisTimeline(state.rawMidi, {
        octaveShift: state.octaveShift,
        staccatoMs: state.staccatoMs,
        maxNote: state.maxNote,
        minDurationMs: state.minDurationMs,
        minVelocity: state.minVelocity,
        allocMode: state.allocMode,
      });
      loadSong(timeline, preservePosition);
    } else if (state.presetKey && PRESETS[state.presetKey]) {
      loadSong(PRESETS[state.presetKey](), preservePosition);
    } else {
      return;
    }

    if (preservePosition && state.song) {
      seekToMs(Math.min(prevMs, state.song.durationMs));
      if (wasPlaying) startPlayback();
    }
  }

  // ---------------------------------------------------------
  // 곡 로드 및 시퀀서 제어
  // ---------------------------------------------------------
  function loadSong(song, silentLog = false) {
    stopPlayback();
    state.song = song;
    state.playheadMs = 0;
    state.frameIdx = 0;

    el.songTitle.textContent = song.title;
    el.songMeta.textContent = `4채널 프레임 ${song.frames.length.toLocaleString()}개 · 길이 ${formatTime(song.durationMs)}`;
    el.timeCurrent.textContent = '0:00';
    el.timeTotal.textContent = formatTime(song.durationMs);
    el.seekBar.value = 0;
    el.seekBar.disabled = song.frames.length === 0;
    el.btnPlay.disabled = song.frames.length === 0;
    el.btnPause.disabled = true;
    el.btnStop.disabled = song.frames.length === 0;
    el.btnExportIno.disabled = song.frames.length === 0;

    pianoRoll.setSongData(song.segments || framesToSegments(song.frames, song.durationMs), song.durationMs);

    if (!silentLog) {
      appendLog(`[곡 로드] "${song.title}" (${formatTime(song.durationMs)}, ${song.frames.length} 프레임)`);
    }
  }

  function seekToMs(targetMs) {
    if (!state.song) return;
    const clamped = Math.max(0, Math.min(state.song.durationMs, targetMs));
    state.playheadMs = clamped;
    el.timeCurrent.textContent = formatTime(clamped);

    const ratio = state.song.durationMs > 0 ? clamped / state.song.durationMs : 0;
    el.seekBar.value = Math.round(ratio * 1000);

    const frames = state.song.frames;
    let idx = 0;
    while (idx < frames.length && frames[idx].timeMs <= clamped) {
      idx++;
    }
    state.frameIdx = idx;
    pianoRoll.setPlayhead(clamped);

    if (state.isPlaying && idx > 0) {
      applyChannelNotes(frames[idx - 1].notes, true);
    }
  }

  function startPlayback() {
    if (!state.song || state.song.frames.length === 0) return;
    if (state.playheadMs >= state.song.durationMs) {
      state.playheadMs = 0;
      state.frameIdx = 0;
    }

    state.isPlaying = true;
    state.lastTickPerfMs = performance.now();
    el.btnPlay.disabled = true;
    el.btnPause.disabled = false;

    const tick = (now) => {
      if (!state.isPlaying || !state.song) return;

      const dt = (now - state.lastTickPerfMs) * state.speed;
      state.lastTickPerfMs = now;
      state.playheadMs += dt;

      const frames = state.song.frames;
      while (state.frameIdx < frames.length && frames[state.frameIdx].timeMs <= state.playheadMs) {
        applyChannelNotes(frames[state.frameIdx].notes);
        state.frameIdx++;
      }

      const ratio = state.song.durationMs > 0 ? Math.min(1, state.playheadMs / state.song.durationMs) : 0;
      el.seekBar.value = Math.round(ratio * 1000);
      el.timeCurrent.textContent = formatTime(state.playheadMs);
      pianoRoll.setPlayhead(state.playheadMs);

      if (state.playheadMs >= state.song.durationMs) {
        stopPlayback();
        appendLog(`[재생 완료] "${state.song.title}"`);
        return;
      }

      state.rafId = requestAnimationFrame(tick);
    };

    state.rafId = requestAnimationFrame(tick);
  }

  function pausePlayback() {
    if (!state.isPlaying) return;
    state.isPlaying = false;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    el.btnPlay.disabled = false;
    el.btnPause.disabled = true;
    silenceAll();
  }

  function stopPlayback() {
    state.isPlaying = false;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.playheadMs = 0;
    state.frameIdx = 0;
    el.seekBar.value = 0;
    el.timeCurrent.textContent = '0:00';
    pianoRoll.setPlayhead(0);
    if (state.song && state.song.frames.length > 0) {
      el.btnPlay.disabled = false;
      el.btnPause.disabled = true;
    }
    silenceAll();
  }

  // ---------------------------------------------------------
  // 내장 4성부 테스트 곡 생성기 (옥타브 시프트 + 스타카토 반영)
  // ---------------------------------------------------------
  function buildPresetSong(title, bpm, steps) {
    const beatMs = 60000 / bpm;
    const frames = [];
    let currentMs = 0;
    const gapBase = Math.max(15, state.staccatoMs);

    for (const step of steps) {
      const durMs = step.beats * beatMs;
      const gateMs = Math.max(20, durMs - Math.min(gapBase, durMs * 0.35));
      const shifted = step.notes.map((n) =>
        n > 0 ? Math.max(24, Math.min(96, n + state.octaveShift * 12)) : 0
      );
      frames.push({ timeMs: currentMs, notes: shifted });
      frames.push({ timeMs: currentMs + gateMs, notes: [0, 0, 0, 0] });
      currentMs += durMs;
    }

    return {
      title,
      durationMs: currentMs,
      frames,
      segments: framesToSegments(frames, currentMs),
    };
  }

  const PRESETS = {
    canon: () =>
      buildPresetSong('캐논 변주곡 (4성부 데모)', 92, [
        { beats: 2, notes: [78, 69, 66, 50] },
        { beats: 2, notes: [76, 69, 64, 45] },
        { beats: 2, notes: [74, 66, 62, 47] },
        { beats: 2, notes: [73, 66, 61, 42] },
        { beats: 2, notes: [71, 67, 62, 43] },
        { beats: 2, notes: [69, 66, 62, 50] },
        { beats: 2, notes: [71, 67, 62, 43] },
        { beats: 2, notes: [73, 69, 64, 45] },
        { beats: 1, notes: [74, 69, 66, 50] },
        { beats: 1, notes: [78, 69, 66, 50] },
        { beats: 1, notes: [76, 69, 64, 45] },
        { beats: 1, notes: [73, 69, 64, 45] },
        { beats: 1, notes: [74, 66, 62, 47] },
        { beats: 1, notes: [71, 66, 62, 47] },
        { beats: 1, notes: [73, 66, 61, 42] },
        { beats: 1, notes: [69, 66, 61, 42] },
        { beats: 2, notes: [71, 67, 62, 43] },
        { beats: 2, notes: [74, 69, 66, 50] },
      ]),

    tetris: () =>
      buildPresetSong('테트리스 테마 (4성부 데모)', 140, [
        { beats: 1, notes: [76, 68, 64, 52] },
        { beats: 0.5, notes: [71, 68, 64, 52] },
        { beats: 0.5, notes: [72, 68, 64, 52] },
        { beats: 1, notes: [74, 69, 65, 50] },
        { beats: 0.5, notes: [72, 69, 65, 50] },
        { beats: 0.5, notes: [71, 68, 64, 52] },
        { beats: 1, notes: [69, 64, 60, 45] },
        { beats: 0.5, notes: [69, 64, 60, 45] },
        { beats: 0.5, notes: [72, 64, 60, 45] },
        { beats: 1, notes: [76, 69, 64, 45] },
        { beats: 0.5, notes: [74, 69, 64, 45] },
        { beats: 0.5, notes: [72, 69, 64, 45] },
        { beats: 1.5, notes: [71, 68, 64, 47] },
        { beats: 0.5, notes: [72, 68, 64, 47] },
        { beats: 1, notes: [74, 68, 64, 52] },
        { beats: 1, notes: [76, 68, 64, 52] },
        { beats: 1, notes: [72, 69, 64, 45] },
        { beats: 1, notes: [69, 64, 60, 45] },
        { beats: 2, notes: [69, 64, 60, 45] },
      ]),

    chord: () =>
      buildPresetSong('4축 화음 진행 테스트 (C-Am-F-G-C)', 100, [
        { beats: 1, notes: [72, 0, 0, 0] },
        { beats: 1, notes: [0, 67, 0, 0] },
        { beats: 1, notes: [0, 0, 64, 0] },
        { beats: 1, notes: [0, 0, 0, 48] },
        { beats: 2, notes: [72, 67, 64, 48] },
        { beats: 2, notes: [72, 69, 64, 45] },
        { beats: 2, notes: [72, 69, 65, 41] },
        { beats: 2, notes: [71, 67, 62, 43] },
        { beats: 4, notes: [72, 67, 64, 48] },
      ]),
  };

  // ---------------------------------------------------------
  // 가상 건반 생성 (C4=60 ~ B5=83, 2옥타브)
  // ---------------------------------------------------------
  const KEYBOARD_SHORTCUTS = {
    a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66,
    g: 67, y: 68, h: 69, u: 70, j: 71, k: 72, o: 73,
    l: 74, p: 75, ';': 76,
  };
  const NOTE_TO_KEY = {};
  Object.entries(KEYBOARD_SHORTCUTS).forEach(([k, n]) => {
    NOTE_TO_KEY[n] = k.toUpperCase();
  });

  function updateManualVoices() {
    if (state.isPlaying) return;
    const allocated = allocateFourVoices(Array.from(state.pressedKeys), false);
    applyChannelNotes(allocated);
  }

  function pressVirtualKey(note, keyEl) {
    if (state.isPlaying) pausePlayback();
    if (!state.pressedKeys.has(note)) {
      state.pressedKeys.add(note);
      if (keyEl) keyEl.classList.add('pressed');
      updateManualVoices();
    }
  }

  function releaseVirtualKey(note, keyEl) {
    if (state.pressedKeys.has(note)) {
      state.pressedKeys.delete(note);
      if (keyEl) keyEl.classList.remove('pressed');
      updateManualVoices();
    }
  }

  function buildPianoKeyboard() {
    const startNote = 60;
    const endNote = 83;
    const blackOffsets = new Set([1, 3, 6, 8, 10]);

    for (let note = startNote; note <= endNote; note++) {
      const semi = note % 12;
      if (blackOffsets.has(semi)) continue;

      const whiteBtn = document.createElement('div');
      whiteBtn.className = 'piano-white';
      whiteBtn.dataset.note = note;
      whiteBtn.innerHTML = `<span>${midiToNoteName(note)}</span><span class="key-shortcut">${NOTE_TO_KEY[note] || ''}</span>`;

      whiteBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        pressVirtualKey(note, whiteBtn);
      });
      whiteBtn.addEventListener('pointerup', () => releaseVirtualKey(note, whiteBtn));
      whiteBtn.addEventListener('pointerleave', () => releaseVirtualKey(note, whiteBtn));

      const nextNote = note + 1;
      if (nextNote <= endNote && blackOffsets.has(nextNote % 12)) {
        const blackBtn = document.createElement('div');
        blackBtn.className = 'piano-black';
        blackBtn.dataset.note = nextNote;
        blackBtn.innerHTML = `<span>${midiToNoteName(nextNote)}</span><span class="key-shortcut">${NOTE_TO_KEY[nextNote] || ''}</span>`;

        blackBtn.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          pressVirtualKey(nextNote, blackBtn);
        });
        blackBtn.addEventListener('pointerup', (e) => {
          e.stopPropagation();
          releaseVirtualKey(nextNote, blackBtn);
        });
        blackBtn.addEventListener('pointerleave', () => releaseVirtualKey(nextNote, blackBtn));

        whiteBtn.appendChild(blackBtn);
      }

      el.pianoKeyboard.appendChild(whiteBtn);
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const note = KEYBOARD_SHORTCUTS[e.key.toLowerCase()];
    if (note) {
      const keyEl = el.pianoKeyboard.querySelector(`[data-note="${note}"]`);
      pressVirtualKey(note, keyEl);
    }
  });

  window.addEventListener('keyup', (e) => {
    const note = KEYBOARD_SHORTCUTS[e.key.toLowerCase()];
    if (note) {
      const keyEl = el.pianoKeyboard.querySelector(`[data-note="${note}"]`);
      releaseVirtualKey(note, keyEl);
    }
  });

  // ---------------------------------------------------------
  // MIDI 파일 업로드 처리
  // ---------------------------------------------------------
  async function handleMidiFile(file) {
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const raw = parseMidiRaw(buffer, file.name);
      state.rawMidi = raw;
      state.presetKey = null;

      // 4개 이하 트랙이면서 트랙이 정확히 4개인 경우에도 기본은 'auto'로 두되 트랙 표에서 바로 고정 가능
      renderTrackTable(raw);
      const timeline = buildFourAxisTimeline(raw, {
        octaveShift: state.octaveShift,
        staccatoMs: state.staccatoMs,
        maxNote: state.maxNote,
        minDurationMs: state.minDurationMs,
        minVelocity: state.minVelocity,
        allocMode: state.allocMode,
      });
      loadSong(timeline);
    } catch (err) {
      appendLog(`[MIDI 파싱 오류] ${err.message}`);
      alert(`MIDI 파일을 읽는 중 오류가 발생했습니다:\n${err.message}`);
    }
  }

  // ---------------------------------------------------------
  // UI 이벤트 바인딩
  // ---------------------------------------------------------
  el.btnConnect.addEventListener('click', () => serial.connect(115200));
  el.btnDisconnect.addEventListener('click', () => {
    stopPlayback();
    serial.disconnect();
  });
  el.btnHardwareTest.addEventListener('click', () => {
    stopPlayback();
    serial.sendLine('TEST');
  });
  el.btnEmergencyStop.addEventListener('click', () => {
    stopPlayback();
    state.pressedKeys.clear();
    el.pianoKeyboard.querySelectorAll('.pressed').forEach((n) => n.classList.remove('pressed'));
    silenceAll();
    appendLog('[정지] 모든 채널 출력 정지');
  });

  el.microstepSelect.addEventListener('change', (e) => {
    state.microstepMult = parseInt(e.target.value, 10) || 1;
    appendLog(`[설정] 마이크로스텝 배율 ×${state.microstepMult}`);
    applyChannelNotes(state.channelNotes, true);
  });

  el.chkAudioPreview.addEventListener('change', (e) => {
    audio.setEnabled(e.target.checked);
  });

  el.volumeSlider.addEventListener('input', (e) => {
    audio.setVolume(parseInt(e.target.value, 10) / 100);
  });

  // 채널별 단독 테스트 & 음소거
  document.querySelectorAll('.btn-test-ch').forEach((btn) => {
    const ch = parseInt(btn.dataset.ch, 10);
    const testNotes = [72, 67, 64, 48];
    btn.addEventListener('click', () => {
      if (state.isPlaying) pausePlayback();
      const notes = [0, 0, 0, 0];
      notes[ch] = testNotes[ch];
      applyChannelNotes(notes, true);
      setTimeout(() => {
        if (!state.isPlaying && state.pressedKeys.size === 0) {
          applyChannelNotes([0, 0, 0, 0], true);
        }
      }, 350);
    });
  });

  document.querySelectorAll('.btn-mute-ch').forEach((btn) => {
    const ch = parseInt(btn.dataset.ch, 10);
    btn.addEventListener('click', () => {
      state.channelMuted[ch] = !state.channelMuted[ch];
      btn.classList.toggle('muted', state.channelMuted[ch]);
      btn.textContent = state.channelMuted[ch] ? '음소거됨' : '음소거';
      pianoRoll.setMuted(state.channelMuted);
      applyChannelNotes(state.channelNotes, true);
    });
  });

  // 파일 업로드 및 드래그&드롭
  el.btnBrowseMidi.addEventListener('click', () => el.midiFileInput.click());
  el.midiFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleMidiFile(e.target.files[0]);
      e.target.value = '';
    }
  });

  el.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.dropZone.classList.add('dragover');
  });
  el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragover'));
  el.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleMidiFile(e.dataTransfer.files[0]);
    }
  });

  // 내장 프리셋 곡 버튼
  document.querySelectorAll('.btn-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.preset;
      if (PRESETS[key]) {
        state.rawMidi = null;
        state.presetKey = key;
        renderTrackTable(null);
        loadSong(PRESETS[key]());
      }
    });
  });

  // 플레이어 제어
  el.btnPlay.addEventListener('click', startPlayback);
  el.btnPause.addEventListener('click', pausePlayback);
  el.btnStop.addEventListener('click', stopPlayback);

  el.seekBar.addEventListener('input', (e) => {
    if (!state.song) return;
    const ratio = parseInt(e.target.value, 10) / 1000;
    seekToMs(ratio * state.song.durationMs);
  });

  el.speedSlider.addEventListener('input', (e) => {
    state.speed = parseInt(e.target.value, 10) / 100;
    el.speedLabel.textContent = `${state.speed.toFixed(1)}x`;
  });

  el.transposeSlider.addEventListener('input', (e) => {
    state.transpose = parseInt(e.target.value, 10);
    el.transposeLabel.textContent = state.transpose > 0 ? `+${state.transpose}` : `${state.transpose}`;
  });

  // 2단계: 옥타브 시프트, 스타카토, 가로 줌, 단독 .ino 내보내기
  el.octaveSelect.addEventListener('change', (e) => {
    state.octaveShift = parseInt(e.target.value, 10) || 0;
    appendLog(`[편곡] 옥타브 시프트: ${state.octaveShift > 0 ? '+' : ''}${state.octaveShift}`);
    rebuildCurrentSong(true);
  });

  el.allocModeSelect.addEventListener('change', (e) => {
    state.allocMode = e.target.value || 'smart';
    appendLog(`[편곡] 4성부 분배 방식: ${state.allocMode === 'smart' ? '스마트 분배' : '단순 높이순'}`);
    rebuildCurrentSong(true);
  });

  el.maxNoteSelect.addEventListener('change', (e) => {
    state.maxNote = parseInt(e.target.value, 10) || 91;
    const label = state.maxNote >= 127 ? '제한 없음' : midiToNoteName(state.maxNote);
    appendLog(`[편곡] 고음 상한: ${label}`);
    rebuildCurrentSong(true);
  });

  el.staccatoSlider.addEventListener('input', (e) => {
    state.staccatoMs = parseInt(e.target.value, 10) || 0;
    el.staccatoLabel.textContent = `${state.staccatoMs}ms`;
  });
  el.staccatoSlider.addEventListener('change', () => {
    appendLog(`[편곡] 스타카토 간격: ${state.staccatoMs}ms`);
    rebuildCurrentSong(true);
  });

  el.minDurSlider.addEventListener('input', (e) => {
    state.minDurationMs = parseInt(e.target.value, 10) || 0;
    el.minDurLabel.textContent = `${state.minDurationMs}ms`;
    rebuildCurrentSong(true);
  });

  el.minVelSlider.addEventListener('input', (e) => {
    state.minVelocity = parseInt(e.target.value, 10) || 0;
    el.minVelLabel.textContent = `${state.minVelocity}`;
    rebuildCurrentSong(true);
  });

  el.zoomSlider.addEventListener('input', (e) => {
    pianoRoll.setZoom(parseInt(e.target.value, 10));
  });

  el.btnExportIno.addEventListener('click', () => {
    if (!state.song || state.song.frames.length === 0) return;
    const res = window.InoExporter.downloadIno(state.song, {
      transpose: state.transpose,
      microstepMult: state.microstepMult,
      speed: state.speed,
      channelMuted: state.channelMuted,
    });
    const warn = res.truncated
      ? ` (Uno Flash 한도로 앞부분 ${res.eventCount}/${res.totalEvents}개 이벤트만 포함)`
      : '';
    appendLog(`[내보내기] ${res.filename} 생성 완료 — ${res.eventCount}개 이벤트${warn}`);
  });

  el.btnClearLog.addEventListener('click', () => {
    el.serialLog.textContent = '';
  });

  // ---------------------------------------------------------
  // 3단계: 로컬 AI 백엔드(유튜브/오디오 -> MIDI) 연동
  // ---------------------------------------------------------
  function setConvertStatus(msg, cls = '') {
    el.convertStatus.textContent = msg;
    el.convertStatus.className = `convert-status ${cls}`;
  }

  async function checkBackendHealth(silent = false) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/health`, { method: 'GET' });
      if (res.ok) {
        const info = await res.json().catch(() => ({}));
        const demucsTag = info.demucs_available ? ' · Demucs 준비' : '';
        el.backendStatus.textContent = `AI 서버 연결됨${demucsTag}`;
        el.backendStatus.className = 'status-pill connected';
        if (!silent) appendLog(`[AI 서버] 연결 확인 완료 (v${info.version || '3.x'}${demucsTag})`);
        return true;
      }
    } catch (_) {}
    el.backendStatus.textContent = 'AI 서버 미연결';
    el.backendStatus.className = 'status-pill disconnected';
    if (!silent) appendLog('[AI 서버] 미연결 — backend/start_server.bat 실행 후 다시 확인하세요.');
    return false;
  }

  function getModeDisplayLabel(mode) {
    if (mode === 'stems') return '고품질 4트랙 · Demucs AI 악기 분리 (약 2~4분 소요)';
    if (mode === 'detail') return '빠른 4트랙 · 디테일 모드';
    return '빠른 4트랙 · 큰 줄기·드럼 제거 모드';
  }

  async function loadMidiBufferFromBackend(arrayBuffer, songTitle, savedName) {
    const raw = parseMidiRaw(arrayBuffer, songTitle);
    state.rawMidi = raw;
    state.presetKey = null;
    renderTrackTable(raw);
    const timeline = buildFourAxisTimeline(raw, {
      octaveShift: state.octaveShift,
      staccatoMs: state.staccatoMs,
      maxNote: state.maxNote,
      minDurationMs: state.minDurationMs,
      minVelocity: state.minVelocity,
      allocMode: state.allocMode,
    });
    loadSong(timeline);
    setConvertStatus(`변환 완료! "${songTitle}" (저장됨: MidiMoter/midi/${savedName})`, 'ok');
    appendLog(`[AI 변환 완료] "${songTitle}" -> midi/${savedName}`);
  }

  async function handleYoutubeConvert() {
    const url = el.youtubeUrlInput.value.trim();
    if (!url) {
      setConvertStatus('유튜브 URL을 먼저 입력해 주세요.', 'err');
      return;
    }

    const mode = el.aiModeSelect ? el.aiModeSelect.value : 'clean';
    el.btnConvertYoutube.disabled = true;
    el.btnBrowseAudio.disabled = true;
    setConvertStatus(
      `유튜브 오디오 추출 및 4트랙 AI 변환 중 [${getModeDisplayLabel(mode)}]...`,
      'busy'
    );
    appendLog(`[AI 변환 시작] YouTube (${mode}): ${url}`);

    try {
      const res = await fetch(`${BACKEND_URL}/api/convert/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, mode }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `서버 오류 (${res.status})`);
      }

      const title = decodeURIComponent(res.headers.get('X-Song-Title') || 'YouTube 곡');
      const savedName = decodeURIComponent(res.headers.get('X-Saved-Filename') || 'converted.mid');
      const buffer = await res.arrayBuffer();
      await loadMidiBufferFromBackend(buffer, title, savedName);
    } catch (err) {
      const msg = err.message.includes('Failed to fetch')
        ? 'AI 서버에 연결할 수 없습니다. MidiMoter/backend/start_server.bat를 먼저 실행해 주세요.'
        : err.message;
      setConvertStatus(`변환 실패: ${msg}`, 'err');
      appendLog(`[AI 변환 오류] ${msg}`);
    } finally {
      el.btnConvertYoutube.disabled = false;
      el.btnBrowseAudio.disabled = false;
    }
  }

  async function handleAudioConvert(file) {
    if (!file) return;
    const mode = el.aiModeSelect ? el.aiModeSelect.value : 'clean';
    el.btnConvertYoutube.disabled = true;
    el.btnBrowseAudio.disabled = true;
    setConvertStatus(`"${file.name}" 4트랙 AI 변환 중 [${getModeDisplayLabel(mode)}]...`, 'busy');
    appendLog(`[AI 변환 시작] Audio (${mode}): ${file.name}`);

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', mode);

      const res = await fetch(`${BACKEND_URL}/api/convert/audio`, {
        method: 'POST',
        body: fd,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `서버 오류 (${res.status})`);
      }

      const title = decodeURIComponent(res.headers.get('X-Song-Title') || file.name);
      const savedName = decodeURIComponent(res.headers.get('X-Saved-Filename') || 'audio_ai.mid');
      const buffer = await res.arrayBuffer();
      await loadMidiBufferFromBackend(buffer, title, savedName);
    } catch (err) {
      const msg = err.message.includes('Failed to fetch')
        ? 'AI 서버에 연결할 수 없습니다. MidiMoter/backend/start_server.bat를 먼저 실행해 주세요.'
        : err.message;
      setConvertStatus(`변환 실패: ${msg}`, 'err');
      appendLog(`[AI 변환 오류] ${msg}`);
    } finally {
      el.btnConvertYoutube.disabled = false;
      el.btnBrowseAudio.disabled = false;
    }
  }

  el.btnCheckBackend.addEventListener('click', () => checkBackendHealth(false));
  el.btnConvertYoutube.addEventListener('click', handleYoutubeConvert);
  el.btnBrowseAudio.addEventListener('click', () => el.audioFileInput.click());
  el.audioFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleAudioConvert(e.target.files[0]);
      e.target.value = '';
    }
  });

  // 초기화
  buildPianoKeyboard();
  state.presetKey = 'canon';
  loadSong(PRESETS.canon());
  checkBackendHealth(true);
})();
