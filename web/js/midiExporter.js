/**
 * 순수 JavaScript 4트랙 표준 MIDI(.mid, SMF Format 1) 인코더 및 다운로드 모듈
 * - 피아노 롤에서 직접 편집·작곡한 4채널 세그먼트를 표준 .mid 파일로 저장
 * - 외부 라이브러리 없이 바이너리 생성
 */
(function (global) {
  const TICKS_PER_QUARTER = 480;
  const TRACK_NAMES = [
    'X-Axis Melody',
    'Y-Axis Harmony 1',
    'Z-Axis Harmony 2',
    'A-Axis Bass',
  ];
  const TRACK_PROGRAMS = [73, 0, 48, 33]; // Flute, Piano, Strings, Electric Bass

  /** MIDI Variable-Length Quantity(VLQ) 인코딩 */
  function encodeVLQ(value) {
    let v = Math.max(0, Math.floor(value));
    const bytes = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      bytes.push((v & 0x7f) | 0x80);
      v >>= 7;
    }
    bytes.reverse();
    return bytes;
  }

  /** ASCII 문자열 -> 바이트 배열 */
  function asciiBytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      out.push(str.charCodeAt(i) & 0x7f);
    }
    return out;
  }

  /** 32비트 Big-Endian 바이트 배열 */
  function uint32BE(val) {
    return [
      (val >>> 24) & 0xff,
      (val >>> 16) & 0xff,
      (val >>> 8) & 0xff,
      val & 0xff,
    ];
  }

  /** 16비트 Big-Endian 바이트 배열 */
  function uint16BE(val) {
    return [(val >>> 8) & 0xff, val & 0xff];
  }

  /** 단일 트랙 MTrk 청크 생성 */
  function buildTrackChunk(segList, channel, trackName, program, bpm, includeTempo) {
    const events = [];
    const nameArr = asciiBytes(trackName);

    // 트랙 이름 메타 이벤트 (tick 0)
    events.push({
      tick: 0,
      order: 0,
      bytes: [0xff, 0x03, ...encodeVLQ(nameArr.length), ...nameArr],
    });

    // 첫 번째 트랙에 템포 메타 이벤트 삽입
    if (includeTempo) {
      const usPerQuarter = Math.round(60000000 / bpm);
      events.push({
        tick: 0,
        order: 0,
        bytes: [
          0xff,
          0x51,
          0x03,
          (usPerQuarter >>> 16) & 0xff,
          (usPerQuarter >>> 8) & 0xff,
          usPerQuarter & 0xff,
        ],
      });
    }

    // 악기(Program Change) 설정
    events.push({
      tick: 0,
      order: 1,
      bytes: [0xc0 | (channel & 0x0f), program & 0x7f],
    });

    const msToTick = (ms) => Math.max(0, Math.round((ms / 1000) * (bpm / 60) * TICKS_PER_QUARTER));

    for (const seg of segList) {
      const pitch = Math.max(0, Math.min(127, Math.round(seg.note)));
      if (pitch <= 0 || seg.endMs <= seg.startMs) continue;

      const sTick = msToTick(seg.startMs);
      const eTick = Math.max(sTick + 1, msToTick(seg.endMs));
      const vel = Math.max(1, Math.min(127, Math.round(seg.velocity || 100)));

      // 동일 틱에서는 NoteOff(order 2)를 NoteOn(order 3)보다 먼저 기록
      events.push({
        tick: sTick,
        order: 3,
        bytes: [0x90 | (channel & 0x0f), pitch, vel],
      });
      events.push({
        tick: eTick,
        order: 2,
        bytes: [0x80 | (channel & 0x0f), pitch, 0],
      });
    }

    events.sort((a, b) => a.tick - b.tick || a.order - b.order);

    const body = [];
    let prevTick = 0;
    for (const ev of events) {
      const delta = Math.max(0, ev.tick - prevTick);
      body.push(...encodeVLQ(delta), ...ev.bytes);
      prevTick = ev.tick;
    }

    // End of Track
    body.push(0x00, 0xff, 0x2f, 0x00);

    return [
      ...asciiBytes('MTrk'),
      ...uint32BE(body.length),
      ...body,
    ];
  }

  /**
   * 4채널 세그먼트 배열 -> 표준 4트랙 MIDI Uint8Array 생성
   * @param {Array} segments [{ ch, note, startMs, endMs }]
   * @param {object} options { bpm: 120, transpose: 0, channelMuted: [false...] }
   */
  function encodeFourTrackMidi(segments, options = {}) {
    const bpm = Math.max(30, Math.min(300, options.bpm || 120));
    const transpose = options.transpose || 0;
    const channelMuted = options.channelMuted || [false, false, false, false];

    const byChannel = [[], [], [], []];
    for (const seg of segments || []) {
      const ch = seg.ch;
      if (ch < 0 || ch > 3 || channelMuted[ch]) continue;
      if (!seg.note || seg.endMs <= seg.startMs) continue;
      const shiftedNote = Math.max(24, Math.min(108, seg.note + transpose));
      byChannel[ch].push({
        note: shiftedNote,
        startMs: seg.startMs,
        endMs: seg.endMs,
        velocity: seg.velocity || 100,
      });
    }

    // MThd 헤더 (SMF Format 1, 4트랙, 480 TPQ)
    const header = [
      ...asciiBytes('MThd'),
      ...uint32BE(6),
      ...uint16BE(1),
      ...uint16BE(4),
      ...uint16BE(TICKS_PER_QUARTER),
    ];

    const chunks = [...header];
    for (let ch = 0; ch < 4; ch++) {
      chunks.push(
        ...buildTrackChunk(
          byChannel[ch],
          ch,
          TRACK_NAMES[ch],
          TRACK_PROGRAMS[ch],
          bpm,
          ch === 0
        )
      );
    }

    return new Uint8Array(chunks);
  }

  /** 브라우저로 4트랙 .mid 파일 다운로드 실행 */
  function downloadMidi(song, options = {}) {
    const bytes = encodeFourTrackMidi(song.segments || [], options);
    const baseName =
      (song.title || 'MidiMoter_Edited')
        .replace(/\.[^/.]+$/, '')
        .replace(/[^\w가-힣-]/g, '_')
        .slice(0, 40) || 'MidiMoter_Edited';
    const filename = `${baseName}_4track.mid`;

    const blob = new Blob([bytes], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return { filename, byteLength: bytes.byteLength, noteCount: (song.segments || []).length };
  }

  global.MidiExporter = {
    encodeFourTrackMidi,
    downloadMidi,
  };
})(window);
