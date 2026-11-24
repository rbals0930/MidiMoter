"""
MidiMoter 3단계 로컬 변환 백엔드 서버 (v3.3)
FastAPI + yt-dlp + librosa HPSS + Demucs AI 스템 분리 + basic-pitch ONNX
+ Note Stitching(떨림 병합) + Smart Bass Handoff + 축별 맞춤 잔향 컷
-----------------------------------------------------------------------------------------
변환 모드:
  - clean  (기본, 빠른 4트랙 · 큰 줄기): HPSS 드럼 제거 + basic-pitch + 4트랙 자동 분리·정제 (20~40초)
  - stems  (고품질 4트랙 · Demucs AI)  : Demucs(htdemucs)로 보컬/반주/베이스/드럼(폐기) 분리,
                                         보컬곡·기악곡(Off Vocal) 자동 판별 + 조용한 구간 베이스 보완
  - detail (빠른 4트랙 · 디테일)       : 세밀한 감도 채보 + 4트랙 자동 분리

CLI 단독 변환 지원:
  python server.py --youtube "https://youtu.be/..." --out "../midi/output.mid" --mode stems
"""

import argparse
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote

import imageio_ffmpeg
import librosa
import numpy as np
import pretty_midi
import soundfile as sf
import uvicorn
import yt_dlp
from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import predict
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

# 기본 저장 폴더 (MidiMoter/midi)
BASE_DIR = Path(__file__).resolve().parent
MIDI_OUT_DIR = BASE_DIR.parent / "midi"
MIDI_OUT_DIR.mkdir(parents=True, exist_ok=True)

FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()
DEMUCS_AVAILABLE = importlib.util.find_spec("demucs") is not None

# 변환 모드별 파라미터 프리셋
MODE_PRESETS = {
    "clean": {
        "remove_drums": True,
        "onset_threshold": 0.60,
        "frame_threshold": 0.46,
        "min_note_ms": 95.0,
        "min_velocity": 46,
        # 축별 최소 지속시간(초): X(멜로디), Y(화음1), Z(코드 패드), A(베이스)
        "axis_min_dur": (0.070, 0.085, 0.120, 0.100),
        "stitch_gap": (0.045, 0.045, 0.055, 0.055),
    },
    "stems": {
        "remove_drums": False,  # Demucs가 드럼 스템을 직접 분리·폐기함
        "onset_threshold": 0.55,
        "frame_threshold": 0.42,
        "min_note_ms": 85.0,
        "min_velocity": 42,
        "axis_min_dur": (0.070, 0.085, 0.120, 0.100),
        "stitch_gap": (0.045, 0.045, 0.055, 0.055),
    },
    "detail": {
        "remove_drums": False,
        "onset_threshold": 0.50,
        "frame_threshold": 0.35,
        "min_note_ms": 65.0,
        "min_velocity": 25,
        "axis_min_dur": (0.050, 0.055, 0.070, 0.070),
        "stitch_gap": (0.035, 0.035, 0.040, 0.040),
    },
}

app = FastAPI(title="MidiMoter AI Converter API", version="3.3")

# file:// 로 연 index.html 에서도 호출할 수 있도록 CORS 전체 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Song-Title", "X-Saved-Filename"],
)


class YoutubeRequest(BaseModel):
    url: str
    mode: str = "clean"


def sanitize_filename(name: str) -> str:
    """파일명으로 안전한 문자열로 정리"""
    cleaned = re.sub(r'[\\/:*?"<>|]+', "_", name).strip()
    cleaned = re.sub(r"\s+", "_", cleaned)
    return cleaned[:60] or "converted_song"


def convert_audio_ffmpeg(src_path: Path, dst_wav: Path, sample_rate: int = 22050, channels: int = 1) -> None:
    """imageio-ffmpeg 내장 바이너리로 지정 샘플레이트/채널 WAV 변환"""
    cmd = [
        FFMPEG_EXE,
        "-y",
        "-i", str(src_path),
        "-ac", str(channels),
        "-ar", str(sample_rate),
        str(dst_wav),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or not dst_wav.exists():
        err = proc.stderr.decode("utf-8", errors="ignore")[-400:]
        raise RuntimeError(f"FFmpeg WAV 변환 실패: {err}")


def prepare_wav_for_basic_pitch(src_path: Path, dst_wav: Path, remove_drums: bool = True) -> None:
    """22050Hz 모노 WAV 변환 + 선택적 librosa HPSS 타악기 제거"""
    raw_wav = dst_wav if not remove_drums else dst_wav.with_name("raw_22k.wav")
    convert_audio_ffmpeg(src_path, raw_wav, sample_rate=22050, channels=1)

    if remove_drums:
        y, sr = librosa.load(str(raw_wav), sr=22050, mono=True)
        y_harmonic = librosa.effects.harmonic(y, margin=2.0)
        sf.write(str(dst_wav), y_harmonic, sr)


def predict_filtered_notes(
    wav_path: Path,
    onset_threshold: float,
    frame_threshold: float,
    min_note_ms: float,
    min_velocity: int,
    min_freq: float = 65.4,
    max_freq: float = 1568.0,
) -> List[pretty_midi.Note]:
    """basic-pitch ONNX 추론 후 저강도/짧은 잡음 음표를 제거한 Note 리스트 반환"""
    _, midi_data, _ = predict(
        str(wav_path),
        model_or_model_path=ICASSP_2022_MODEL_PATH,
        onset_threshold=onset_threshold,
        frame_threshold=frame_threshold,
        minimum_note_length=min_note_ms,
        minimum_frequency=min_freq,
        maximum_frequency=max_freq,
        midi_tempo=120.0,
    )

    min_dur_sec = min_note_ms / 1000.0
    notes: List[pretty_midi.Note] = []
    for inst in midi_data.instruments:
        for n in inst.notes:
            if n.velocity >= min_velocity and (n.end - n.start) >= min_dur_sec:
                notes.append(pretty_midi.Note(
                    velocity=int(n.velocity),
                    pitch=int(n.pitch),
                    start=float(n.start),
                    end=float(n.end),
                ))
    return notes


# ---------------------------------------------------------------------------
# 후처리 유틸: Note Stitching(떨림 병합) 및 Smart Bass Handoff
# ---------------------------------------------------------------------------
def stitch_track_notes(
    notes: List[pretty_midi.Note],
    max_gap_sec: float = 0.045,
    min_dur_sec: float = 0.070,
) -> List[pretty_midi.Note]:
    """같은 음정이 미세한 간격(<= max_gap_sec)으로 끊기는 AI 채보 떨림을 병합하고 잔향 컷"""
    if not notes:
        return []
    sorted_notes = sorted(notes, key=lambda n: (n.start, n.end))
    stitched: List[pretty_midi.Note] = []

    for n in sorted_notes:
        if stitched and stitched[-1].pitch == n.pitch and (n.start - stitched[-1].end) <= max_gap_sec:
            stitched[-1].end = max(stitched[-1].end, n.end)
            stitched[-1].velocity = max(stitched[-1].velocity, n.velocity)
        else:
            stitched.append(pretty_midi.Note(
                velocity=n.velocity,
                pitch=n.pitch,
                start=n.start,
                end=n.end,
            ))

    return [n for n in stitched if (n.end - n.start) >= min_dur_sec]


def is_covered_by(t_start: float, t_end: float, ref_notes: List[pretty_midi.Note], pad: float = 0.18) -> bool:
    """특정 시간 구간이 기준 트랙(예: bass 스템)에 이미 덮여 있는지 확인"""
    for r in ref_notes:
        if r.end + pad < t_start:
            continue
        if r.start - pad > t_end:
            break
        return True
    return False


# ---------------------------------------------------------------------------
# 4트랙 자동 분리 엔진 (반음 충돌 제거 + 음량 기반 역할 선별 + Voice Locking)
# ---------------------------------------------------------------------------
def split_notes_into_k_voices(
    notes: List[pretty_midi.Note],
    num_voices: int,
    prefer_bass_on_last: bool = True,
    pick_mode: str = "high",
) -> List[List[pretty_midi.Note]]:
    """
    다성부 Note 리스트를 num_voices(1~4)개의 깔끔한 단선율 트랙으로 분리.
    - 1반음 충돌 제거 (더 강한 음만 생존)
    - Salient Skyline(강한 최고음) + 강한 베이스 + 핵심 화음 선별
    - Voice Locking으로 한 트랙의 음이 중간에 다른 트랙으로 튀지 않도록 연속성 유지
    """
    if not notes or num_voices <= 0:
        return [[] for _ in range(max(0, num_voices))]

    events: List[Tuple[float, int, pretty_midi.Note]] = []
    for n in notes:
        s = round(n.start, 3)
        e = round(n.end, 3)
        if e <= s:
            continue
        events.append((s, 1, n))   # 1 = on
        events.append((e, 0, n))   # 0 = off (같은 시각엔 off 먼저)

    events.sort(key=lambda x: (x[0], x[1]))

    active: Dict[int, List[int]] = {}
    prev_assigned: List[Optional[Tuple[int, int]]] = [None] * num_voices
    open_notes: List[Optional[pretty_midi.Note]] = [None] * num_voices
    result_tracks: List[List[pretty_midi.Note]] = [[] for _ in range(num_voices)]

    def flush_channel(ch: int, t: float, next_pitch: int, next_vel: int):
        cur = open_notes[ch]
        if cur is not None and cur.pitch != next_pitch:
            cur.end = t
            if cur.end - cur.start >= 0.03:
                result_tracks[ch].append(cur)
            open_notes[ch] = None
        if next_pitch > 0 and open_notes[ch] is None:
            open_notes[ch] = pretty_midi.Note(
                velocity=max(1, min(127, next_vel)),
                pitch=next_pitch,
                start=t,
                end=t,
            )

    idx = 0
    total = len(events)
    while idx < total:
        cur_t = events[idx][0]
        while idx < total and abs(events[idx][0] - cur_t) <= 0.001:
            _, ev_type, note_obj = events[idx]
            idx += 1
            if ev_type == 1:
                active.setdefault(note_obj.pitch, []).append(note_obj.velocity)
            else:
                vels = active.get(note_obj.pitch)
                if vels:
                    if note_obj.velocity in vels:
                        vels.remove(note_obj.velocity)
                    else:
                        vels.pop(0)
                    if not vels:
                        del active[note_obj.pitch]

        cands = [(p, max(vs)) for p, vs in active.items() if vs]

        # 1) 1반음 충돌 제거 (음량 강한 음 우선 생존)
        cands.sort(key=lambda x: (-x[1], -x[0]))
        clean: List[Tuple[int, int]] = []
        for p, v in cands:
            if not any(abs(kp - p) == 1 for kp, _ in clean):
                clean.append((p, v))

        # 2) num_voices개 핵심 음 선별
        selected_map: Dict[int, int] = {}
        if len(clean) <= num_voices:
            for p, v in clean:
                selected_map[p] = v
        else:
            max_vel = clean[0][1] or 1
            pool = list(clean)

            if num_voices == 1:
                strong = [c for c in pool if c[1] >= max_vel * 0.65] or pool
                pick = min(strong, key=lambda c: c[0]) if pick_mode == "low" else max(strong, key=lambda c: c[0])
                selected_map[pick[0]] = pick[1]
            else:
                mel_pool = [c for c in pool if c[1] >= max_vel * 0.65] or pool
                mel = max(mel_pool, key=lambda c: c[0])
                selected_map[mel[0]] = mel[1]
                pool.remove(mel)

                if prefer_bass_on_last and len(selected_map) < num_voices and pool:
                    bass_pool = [c for c in pool if c[1] >= max_vel * 0.55] or pool
                    bass = min(bass_pool, key=lambda c: c[0])
                    selected_map[bass[0]] = bass[1]
                    pool.remove(bass)

                pool.sort(key=lambda c: (-c[1], -c[0]))
                while len(selected_map) < num_voices and pool:
                    p, v = pool.pop(0)
                    selected_map[p] = v

        # 3) Voice Locking: 이전 프레임에서 울리던 음은 같은 트랙에 유지
        assigned: List[Optional[Tuple[int, int]]] = [None] * num_voices
        unassigned = dict(selected_map)
        empty_chs: List[int] = []

        for ch in range(num_voices):
            prev = prev_assigned[ch]
            if prev is not None and prev[0] in unassigned:
                p = prev[0]
                assigned[ch] = (p, unassigned.pop(p))
            else:
                empty_chs.append(ch)

        rest_sorted = sorted(unassigned.items(), key=lambda x: x[0])
        if prefer_bass_on_last and (num_voices - 1) in empty_chs and rest_sorted:
            p, v = rest_sorted.pop(0)
            assigned[num_voices - 1] = (p, v)
            empty_chs.remove(num_voices - 1)

        for ch in empty_chs:
            if rest_sorted:
                p, v = rest_sorted.pop()
                assigned[ch] = (p, v)

        for ch in range(num_voices):
            if assigned[ch] is not None:
                flush_channel(ch, cur_t, assigned[ch][0], assigned[ch][1])
            else:
                flush_channel(ch, cur_t, 0, 0)

        prev_assigned = assigned

    last_t = events[-1][0] if events else 0.0
    for ch in range(num_voices):
        flush_channel(ch, last_t, 0, 0)

    return result_tracks


def build_4track_midi(
    track_notes: List[List[pretty_midi.Note]],
    track_names: List[str],
    out_mid_path: Path,
) -> Path:
    """4개 단선율 트랙을 표준 SMF Format 1 MIDI 파일로 저장"""
    programs = [73, 0, 48, 33]  # Flute(멜로디), Piano(화음1), Strings(화음2), Bass(베이스)
    pm = pretty_midi.PrettyMIDI(initial_tempo=120.0)

    for i in range(4):
        inst = pretty_midi.Instrument(program=programs[i], name=track_names[i])
        inst.notes = track_notes[i] if i < len(track_notes) else []
        pm.instruments.append(inst)

    out_mid_path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(out_mid_path))
    return out_mid_path


def separate_stems_with_demucs(src_audio: Path, work_dir: Path) -> Dict[str, Path]:
    """Meta Demucs(htdemucs)로 오디오를 vocals / bass / other / drums 4개 WAV 스템으로 분리"""
    if not DEMUCS_AVAILABLE:
        raise RuntimeError(
            "Demucs가 설치되어 있지 않습니다. 가상환경에 `pip install demucs`를 설치해 주세요."
        )

    wav_44k = work_dir / "demucs_input.wav"
    convert_audio_ffmpeg(src_audio, wav_44k, sample_rate=44100, channels=2)

    demucs_out = work_dir / "demucs_out"
    env = os.environ.copy()
    ffmpeg_dir = str(Path(FFMPEG_EXE).parent)
    env["PATH"] = ffmpeg_dir + os.pathsep + env.get("PATH", "")

    cmd = [
        sys.executable,
        "-m", "demucs",
        "-n", "htdemucs",
        "-o", str(demucs_out),
        str(wav_44k),
    ]
    proc = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="ignore")[-500:]
        raise RuntimeError(f"Demucs AI 스템 분리 실패: {err}")

    stem_dir = demucs_out / "htdemucs" / wav_44k.stem
    stems = {}
    for name in ("vocals", "other", "bass", "drums"):
        p = stem_dir / f"{name}.wav"
        if p.exists():
            stems[name] = p

    if "other" not in stems:
        raise RuntimeError("Demucs 출력 스템 파일을 찾지 못했습니다.")
    return stems


def transcribe_audio_to_4track_midi(
    src_audio: Path,
    out_mid_path: Path,
    work_dir: Path,
    mode: str = "clean",
) -> Path:
    """
    선택된 모드(clean / stems / detail)로 오디오를 4트랙 MIDI로 변환
    모든 모드에 Note Stitching(떨림 병합)과 축별 맞춤 잔향 컷 적용
    """
    cfg = MODE_PRESETS.get(mode, MODE_PRESETS["clean"])
    min_durs = cfg["axis_min_dur"]
    gaps = cfg["stitch_gap"]

    if mode == "stems":
        # 1) Demucs로 보컬/반주/베이스 분리 (drums 스템 완전 폐기)
        stems = separate_stems_with_demucs(src_audio, work_dir)

        o_wav = work_dir / "stem_other_22k.wav"
        convert_audio_ffmpeg(stems["other"], o_wav, sample_rate=22050, channels=1)
        y_other, sr = sf.read(str(o_wav), dtype="float32")
        rms_other = float(np.sqrt(np.mean(y_other ** 2))) + 1e-8

        # 보컬 스템 존재 및 에너지 비율 측정 (보컬곡 vs 기악/Off Vocal 자동 판별)
        y_voc = None
        rms_voc = 0.0
        v_wav = work_dir / "stem_vocals_22k.wav"
        if "vocals" in stems:
            convert_audio_ffmpeg(stems["vocals"], v_wav, sample_rate=22050, channels=1)
            y_voc, _ = sf.read(str(v_wav), dtype="float32")
            rms_voc = float(np.sqrt(np.mean(y_voc ** 2)))

        # 베이스 스템 전용 채보 (E1 ~ E4)
        bass_notes: List[pretty_midi.Note] = []
        if "bass" in stems:
            b_wav = work_dir / "stem_bass_22k.wav"
            convert_audio_ffmpeg(stems["bass"], b_wav, sample_rate=22050, channels=1)
            bass_notes = predict_filtered_notes(
                b_wav,
                onset_threshold=0.52,
                frame_threshold=0.40,
                min_note_ms=110.0,
                min_velocity=44,
                min_freq=41.2,
                max_freq=330.0,
            )

        track_a_bass = stitch_track_notes(
            split_notes_into_k_voices(bass_notes, 1, prefer_bass_on_last=False, pick_mode="low")[0],
            max_gap_sec=gaps[3],
            min_dur_sec=min_durs[3],
        )

        # 보컬 에너지가 반주의 18% 이상이면 보컬곡으로 판단해 vocals를 독립 채보
        is_vocal_song = (y_voc is not None) and (rms_voc >= rms_other * 0.18)
        vocals_notes: List[pretty_midi.Note] = []
        if is_vocal_song:
            vocals_notes = predict_filtered_notes(
                v_wav,
                onset_threshold=cfg["onset_threshold"],
                frame_threshold=cfg["frame_threshold"],
                min_note_ms=cfg["min_note_ms"],
                min_velocity=cfg["min_velocity"],
                min_freq=130.8,
                max_freq=1568.0,
            )
            if len(vocals_notes) < 20:
                is_vocal_song = False

        if is_vocal_song:
            # 보컬곡: X=Vocals, Y·Z=Other(2성부), A=Bass(+조용한 구간 왼손 보완)
            other_notes = predict_filtered_notes(
                o_wav,
                onset_threshold=cfg["onset_threshold"],
                frame_threshold=cfg["frame_threshold"],
                min_note_ms=cfg["min_note_ms"],
                min_velocity=cfg["min_velocity"],
                min_freq=65.4,
                max_freq=1568.0,
            )

            lh_cands = [
                n for n in other_notes
                if n.pitch <= 55 and not is_covered_by(n.start, n.end, track_a_bass, pad=0.18)
            ]
            lh_mono = stitch_track_notes(
                split_notes_into_k_voices(lh_cands, 1, prefer_bass_on_last=False, pick_mode="low")[0],
                max_gap_sec=gaps[3],
                min_dur_sec=min_durs[3],
            )
            track_a = sorted(track_a_bass + lh_mono, key=lambda n: n.start)

            used_lh = {(round(n.start, 2), n.pitch) for n in lh_cands}
            upper_other = [n for n in other_notes if (round(n.start, 2), n.pitch) not in used_lh and n.pitch >= 48]

            track_x = stitch_track_notes(
                split_notes_into_k_voices(vocals_notes, 1, prefer_bass_on_last=False, pick_mode="high")[0],
                max_gap_sec=gaps[0],
                min_dur_sec=min_durs[0],
            )
            yz = split_notes_into_k_voices(upper_other, 2, prefer_bass_on_last=False)
            track_y = stitch_track_notes(yz[0], max_gap_sec=gaps[1], min_dur_sec=min_durs[1])
            track_z = stitch_track_notes(yz[1], max_gap_sec=gaps[2], min_dur_sec=min_durs[2])
            names = ["X-Axis Vocals", "Y-Axis Harmony 1", "Z-Axis Harmony 2", "A-Axis Bass"]
            return build_4track_midi([track_x, track_y, track_z, track_a], names, out_mid_path)

        # 기악곡 / Off Vocal: other + vocals를 합산해 피아노 고음 잔여분까지 손실 없이 보존 (drums 완전 제외)
        if y_voc is not None:
            min_len = min(len(y_other), len(y_voc))
            y_harm = y_other[:min_len] + y_voc[:min_len]
            peak = float(np.max(np.abs(y_harm))) or 1.0
            if peak > 0.98:
                y_harm = y_harm * (0.95 / peak)
        else:
            y_harm = y_other

        harm_wav = work_dir / "harmonic_no_drums_22k.wav"
        sf.write(str(harm_wav), y_harm, sr)
        harm_notes = predict_filtered_notes(
            harm_wav,
            onset_threshold=cfg["onset_threshold"],
            frame_threshold=cfg["frame_threshold"],
            min_note_ms=cfg["min_note_ms"],
            min_velocity=cfg["min_velocity"],
            min_freq=65.4,
            max_freq=1568.0,
        )

        # Smart Bass Handoff: 베이스 스템이 쉬는 조용한 구간은 피아노 왼손 저음(<= G3)으로 A축 보완
        lh_cands = [
            n for n in harm_notes
            if n.pitch <= 55 and not is_covered_by(n.start, n.end, track_a_bass, pad=0.18)
        ]
        lh_mono = stitch_track_notes(
            split_notes_into_k_voices(lh_cands, 1, prefer_bass_on_last=False, pick_mode="low")[0],
            max_gap_sec=gaps[3],
            min_dur_sec=min_durs[3],
        )
        track_a = sorted(track_a_bass + lh_mono, key=lambda n: n.start)

        used_lh = {(round(n.start, 2), n.pitch) for n in lh_cands}
        upper_harm = [n for n in harm_notes if (round(n.start, 2), n.pitch) not in used_lh and n.pitch >= 48]

        xyz = split_notes_into_k_voices(upper_harm, 3, prefer_bass_on_last=False)
        track_x = stitch_track_notes(xyz[0], max_gap_sec=gaps[0], min_dur_sec=min_durs[0])
        track_y = stitch_track_notes(xyz[1], max_gap_sec=gaps[1], min_dur_sec=min_durs[1])
        track_z = stitch_track_notes(xyz[2], max_gap_sec=gaps[2], min_dur_sec=min_durs[2])
        names = ["X-Axis Lead", "Y-Axis Harmony 1", "Z-Axis Chord Pad", "A-Axis Bass"]
        return build_4track_midi([track_x, track_y, track_z, track_a], names, out_mid_path)

    # 빠른 4트랙 모드 (clean / detail) + Note Stitching 및 축별 맞춤 잔향 컷 적용
    wav_path = work_dir / "input_22k.wav"
    prepare_wav_for_basic_pitch(src_audio, wav_path, remove_drums=cfg["remove_drums"])
    all_notes = predict_filtered_notes(
        wav_path,
        onset_threshold=cfg["onset_threshold"],
        frame_threshold=cfg["frame_threshold"],
        min_note_ms=cfg["min_note_ms"],
        min_velocity=cfg["min_velocity"],
    )
    raw_tracks = split_notes_into_k_voices(all_notes, 4, prefer_bass_on_last=True)
    tracks = [
        stitch_track_notes(raw_tracks[i], max_gap_sec=gaps[i], min_dur_sec=min_durs[i])
        for i in range(4)
    ]
    names = ["X-Axis Melody", "Y-Axis Harmony 1", "Z-Axis Chord Pad", "A-Axis Bass"]
    return build_4track_midi(tracks, names, out_mid_path)


def download_and_convert_youtube(
    url: str,
    out_path: Optional[Path] = None,
    mode: str = "clean",
):
    """유튜브 URL -> 오디오 다운로드 -> 선택 모드로 4트랙 MIDI 변환"""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        out_tmpl = str(tmp / "audio.%(ext)s")

        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": out_tmpl,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "ffmpeg_location": str(Path(FFMPEG_EXE).parent),
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title") or "youtube_song"

        downloaded = list(tmp.glob("audio.*"))
        if not downloaded:
            raise RuntimeError("유튜브 오디오 파일을 다운로드하지 못했습니다.")

        if out_path is None:
            safe_name = sanitize_filename(title)
            out_path = MIDI_OUT_DIR / f"{safe_name}_{mode}_4track.mid"

        transcribe_audio_to_4track_midi(downloaded[0], out_path, tmp, mode=mode)
        return title, out_path


@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "version": "3.3",
        "ffmpeg": os.path.basename(FFMPEG_EXE),
        "demucs_available": DEMUCS_AVAILABLE,
        "midi_dir": str(MIDI_OUT_DIR),
        "modes": list(MODE_PRESETS.keys()),
    }


@app.post("/api/convert/youtube")
def api_convert_youtube(req: YoutubeRequest):
    url = req.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="유튜브 URL을 입력해 주세요.")

    try:
        title, mid_path = download_and_convert_youtube(url, mode=req.mode)
        midi_bytes = mid_path.read_bytes()
        return Response(
            content=midi_bytes,
            media_type="audio/midi",
            headers={
                "X-Song-Title": quote(title),
                "X-Saved-Filename": quote(mid_path.name),
            },
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"유튜브 변환 실패: {exc}")


@app.post("/api/convert/audio")
async def api_convert_audio(
    file: UploadFile = File(...),
    mode: str = Form("clean"),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="오디오 파일이 비어 있습니다.")

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            ext = Path(file.filename).suffix or ".mp3"
            raw_path = tmp / f"upload{ext}"
            raw_path.write_bytes(await file.read())

            title = Path(file.filename).stem
            safe_name = sanitize_filename(title)
            out_path = MIDI_OUT_DIR / f"{safe_name}_{mode}_4track.mid"

            transcribe_audio_to_4track_midi(raw_path, out_path, tmp, mode=mode)
            midi_bytes = out_path.read_bytes()
            return Response(
                content=midi_bytes,
                media_type="audio/midi",
                headers={
                    "X-Song-Title": quote(title),
                    "X-Saved-Filename": quote(out_path.name),
                },
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"오디오 변환 실패: {exc}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MidiMoter 3단계 AI 4트랙 변환 서버 / CLI")
    parser.add_argument("--youtube", type=str, help="변환할 유튜브 URL (CLI 즉시 변환 모드)")
    parser.add_argument("--out", type=str, help="저장할 .mid 파일 경로 (옵션)")
    parser.add_argument("--mode", type=str, default="clean", choices=["clean", "stems", "detail"], help="변환 모드")
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    if args.youtube:
        out_p = Path(args.out).resolve() if args.out else None
        title, saved = download_and_convert_youtube(args.youtube, out_path=out_p, mode=args.mode)
        print(f"[변환 완료] 제목: {title} (mode={args.mode})")
        print(f"[저장 경로] {saved} ({saved.stat().st_size:,} bytes)")
    else:
        print(f"MidiMoter AI 4트랙 변환 서버 시작: http://{args.host}:{args.port} (v3.3, Demucs={DEMUCS_AVAILABLE})")
        uvicorn.run(app, host=args.host, port=args.port)
