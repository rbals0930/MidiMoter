"""
MidiMoter 로컬 AI 변환 백엔드 서버 (v6.0)
FastAPI + yt-dlp + librosa(beat_track · chroma_cqt) + Demucs AI + basic-pitch ONNX
+ 드럼 블리드·배음 고스트 제거 + 적응형 16분음표 칼박 퀀타이즈
+ 보이스 리딩 기반 비분열 4단 계층 분배 엔진 (A 베이스 -> Z 미들 -> Y 멜로디 -> X 하이)
-----------------------------------------------------------------------------------------
변환 모드:
  - clean  (기본, 원음 클린 4계층): 원음 basic-pitch + 블리드/배음 정리 + 16분음표 칼박 + 솔로 비분열 4단 분배
  - stems  (고품질 4계층, 권장)   : Demucs(htdemucs) 드럼 완전 제거 + 공통 칼박 그리드 + 악기별 리얼 4단 분배
  - detail (원음 풀디테일 4계층)   : 필터/퀀타이즈 최소화된 원음 디테일 + 솔로 비분열 4단 분배

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

# 4단 계층 표준 트랙 이름 (web/js/midiParser.js 자동 축 매핑 정규식과 100% 호환)
LAYER_TRACK_NAMES = ["X-Axis High", "Y-Axis Melody", "Z-Axis Middle", "A-Axis Bass"]

# 변환 모드별 파라미터 프리셋 (v6.0: 블리드·배음 제거 + 16분음표 칼박 + 축별 아티큘레이션)
MODE_PRESETS = {
    "clean": {
        "onset_threshold": 0.40,
        "frame_threshold": 0.28,
        "min_note_ms": 50.0,
        "min_velocity": 24,
        "out_of_key_penalty": 8,
        "bleed_ratio": 0.50,
        "bleed_min_vel": 34,
        "bleed_max_dur": 0.095,
        "quant_max_err": 0.30,
        "quant_strict_err": 0.25,
        "quant_tol_strict": 0.42,
        "quant_tol_soft": 0.30,
        "smooth_accomp_steps": 2,
        "lead_gate": 0.82,
        "lead_min_gap": 0.032,
        "lead_max_gap": 0.075,
        "lead_min_note": 0.042,
        "accomp_gate": 0.88,
        "bass_gate": 0.90,
        "accomp_min_gap": 0.028,
        "accomp_max_gap": 0.065,
        "accomp_min_note": 0.045,
    },
    "stems": {
        "onset_threshold": 0.38,
        "frame_threshold": 0.26,
        "min_note_ms": 48.0,
        "min_velocity": 22,
        "out_of_key_penalty": 6,
        "bleed_ratio": 0.45,
        "bleed_min_vel": 30,
        "bleed_max_dur": 0.090,
        "quant_max_err": 0.30,
        "quant_strict_err": 0.25,
        "quant_tol_strict": 0.42,
        "quant_tol_soft": 0.30,
        "smooth_accomp_steps": 2,
        "lead_gate": 0.82,
        "lead_min_gap": 0.032,
        "lead_max_gap": 0.075,
        "lead_min_note": 0.042,
        "accomp_gate": 0.88,
        "bass_gate": 0.90,
        "accomp_min_gap": 0.028,
        "accomp_max_gap": 0.065,
        "accomp_min_note": 0.045,
    },
    "detail": {
        "onset_threshold": 0.35,
        "frame_threshold": 0.24,
        "min_note_ms": 45.0,
        "min_velocity": 18,
        "out_of_key_penalty": 0,
        "bleed_ratio": 0.38,
        "bleed_min_vel": 24,
        "bleed_max_dur": 0.075,
        "quant_max_err": 0.24,
        "quant_strict_err": 0.20,
        "quant_tol_strict": 0.28,
        "quant_tol_soft": 0.22,
        "smooth_accomp_steps": 2,
        "lead_gate": 0.86,
        "lead_min_gap": 0.026,
        "lead_max_gap": 0.065,
        "lead_min_note": 0.038,
        "accomp_gate": 0.89,
        "bass_gate": 0.90,
        "accomp_min_gap": 0.024,
        "accomp_max_gap": 0.055,
        "accomp_min_note": 0.040,
    },
}

app = FastAPI(title="MidiMoter AI Converter API", version="6.0")

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


def apply_stepper_articulation(
    notes: List[pretty_midi.Note],
    gate_ratio: float = 0.86,
    min_gap_sec: float = 0.048,
    max_gap_sec: float = 0.115,
    min_note_sec: float = 0.065,
) -> List[pretty_midi.Note]:
    """
    스텝모터 연주 시 음표와 음표 사이가 0ms로 붙어 사이렌처럼 뭉개지는 현상을 방지하기 위해
    게이트 비율과 최소 숨표(무음 간격)를 확보하는 후처리 함수
    """
    if not notes:
        return []

    sorted_notes = sorted(notes, key=lambda n: (n.start, n.end))
    cleaned: List[pretty_midi.Note] = []
    for n in sorted_notes:
        if (n.end - n.start) < 0.035:
            continue
        if cleaned and cleaned[-1].end > n.start:
            cleaned[-1].end = n.start
        cleaned.append(pretty_midi.Note(
            velocity=n.velocity,
            pitch=n.pitch,
            start=float(n.start),
            end=float(n.end),
        ))

    cleaned = [n for n in cleaned if (n.end - n.start) >= 0.035]
    if not cleaned:
        return []

    out: List[pretty_midi.Note] = []
    total = len(cleaned)
    for idx, n in enumerate(cleaned):
        orig_dur = n.end - n.start
        if idx + 1 < total:
            nxt = cleaned[idx + 1]
            avail = nxt.start - n.start
            existing_gap = max(0.0, nxt.start - n.end)

            # 프레이즈 끝 등 이미 충분한 자연 휴지가 있으면 억지로 자르지 않고 보호
            if existing_gap >= min_gap_sec:
                new_end = n.end
            else:
                gate_cut = min(max_gap_sec, max(min_gap_sec, orig_dur * (1.0 - gate_ratio)))
                target_end = min(n.end, nxt.start - gate_cut)
                if avail >= min_note_sec + 0.032:
                    new_end = max(n.start + min_note_sec, target_end)
                    new_end = min(new_end, nxt.start - 0.032)
                elif avail > 0.055:
                    new_end = n.start + max(0.040, avail * 0.65)
                    new_end = min(new_end, nxt.start - 0.025)
                else:
                    trim = min(0.020, avail * 0.30)
                    new_end = max(n.start + min(0.030, avail - 0.008), min(n.end, nxt.start - trim))
        else:
            new_end = n.end

        if (new_end - n.start) >= 0.030:
            out.append(pretty_midi.Note(
                velocity=n.velocity,
                pitch=n.pitch,
                start=n.start,
                end=new_end,
            ))

    return out


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
# v3.5 조성(Key/Scale) 추정 + 조성 인식 필터 + Chroma 기반 4축 화음 보강
# ---------------------------------------------------------------------------
KRUMHANSL_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KRUMHANSL_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def analyze_chroma_and_key(wav_path: Path) -> Optional[dict]:
    """
    22050Hz WAV에서 Chroma CQT와 Krumhansl-Schmuckler 프로파일로
    곡의 주 조성(장/단조 7음계) 및 시간대별 화음 에너지를 추출
    """
    try:
        y, sr = librosa.load(str(wav_path), sr=22050, mono=True)
        if y.size < sr * 0.5 or float(np.max(np.abs(y))) < 1e-5:
            return None

        hop = 2048
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
        if chroma.size == 0:
            return None
        frame_times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=hop)

        chroma_sum = np.sum(chroma, axis=1)
        if float(np.std(chroma_sum)) < 1e-6:
            return None

        best_corr = -2.0
        best_root = 0
        best_minor = False
        for r in range(12):
            maj_corr = float(np.corrcoef(chroma_sum, np.roll(KRUMHANSL_MAJOR, r))[0, 1])
            min_corr = float(np.corrcoef(chroma_sum, np.roll(KRUMHANSL_MINOR, r))[0, 1])
            if not np.isnan(maj_corr) and maj_corr > best_corr:
                best_corr, best_root, best_minor = maj_corr, r, False
            if not np.isnan(min_corr) and min_corr > best_corr:
                best_corr, best_root, best_minor = min_corr, r, True

        intervals = (0, 2, 3, 5, 7, 8, 10) if best_minor else (0, 2, 4, 5, 7, 9, 11)
        scale_pcs = {(best_root + iv) % 12 for iv in intervals}
        return {
            "root": int(best_root),
            "is_minor": bool(best_minor),
            "scale_pcs": scale_pcs,
            "chroma": chroma,
            "frame_times": frame_times,
        }
    except Exception:
        return None


def key_aware_filter_notes(
    notes: List[pretty_midi.Note],
    key_info: Optional[dict],
    base_min_vel: int,
    out_of_key_penalty: int = 8,
) -> List[pretty_midi.Note]:
    """
    조성 내 음표는 기본 임계값으로 통과시키고,
    조성 밖 임시표·전조 음표는 과도한 길이 삭제 없이 완만한 강도 기준(+out_of_key_penalty)만 적용해 보존
    """
    if not key_info:
        return notes

    scale_pcs = key_info["scale_pcs"]
    out: List[pretty_midi.Note] = []
    for n in notes:
        if (n.pitch % 12) in scale_pcs:
            if n.velocity >= base_min_vel:
                out.append(n)
        else:
            if n.velocity >= (base_min_vel + out_of_key_penalty):
                out.append(n)
    return out


def normalize_min_pitch(notes: List[pretty_midi.Note], min_pitch: int = 36) -> List[pretty_midi.Note]:
    """웹 스텝모터 하한(기본 C2=MIDI 36) 미만 초저음을 옥타브 상향 정규화해 축 역전을 방지"""
    out: List[pretty_midi.Note] = []
    for n in notes:
        p = int(n.pitch)
        while p < min_pitch and p + 12 <= 127:
            p += 12
        out.append(pretty_midi.Note(
            velocity=int(n.velocity),
            pitch=p,
            start=float(n.start),
            end=float(n.end),
        ))
    return out


def filter_percussive_bleed(
    notes: List[pretty_midi.Note],
    vel_ratio: float = 0.50,
    floor_vel: int = 34,
    max_dur: float = 0.095,
) -> List[pretty_midi.Note]:
    """주변 ±1.5초 음량(p90) 대비 약하고 짧은 드럼·타악 잔음 블리드 파편 제거"""
    if not notes:
        return []
    sorted_notes = sorted(notes, key=lambda n: n.start)
    starts = np.array([n.start for n in sorted_notes], dtype=float)
    vels = np.array([n.velocity for n in sorted_notes], dtype=float)

    out: List[pretty_midi.Note] = []
    for n in sorted_notes:
        dur = n.end - n.start
        if dur < max_dur:
            lo = int(np.searchsorted(starts, n.start - 1.5, side="left"))
            hi = int(np.searchsorted(starts, n.start + 1.5, side="right"))
            loc_p90 = float(np.percentile(vels[lo:hi], 90)) if hi > lo else float(n.velocity)
            if n.velocity < max(float(floor_vel), loc_p90 * vel_ratio):
                continue
        out.append(n)
    return out


def remove_harmonic_ghosts(notes: List[pretty_midi.Note]) -> List[pretty_midi.Note]:
    """더 강한 저음 기본음(+12/+19/+24) 위에 짧고 약하게 뜬 고립 배음 스파이크 제거(연속 고음 멜로디는 보호)"""
    if not notes:
        return []

    sorted_notes = sorted(notes, key=lambda n: (n.start, n.pitch))
    total = len(sorted_notes)
    keep: List[pretty_midi.Note] = []
    active_prev: List[int] = []

    for i, n in enumerate(sorted_notes):
        active_prev = [idx for idx in active_prev if sorted_notes[idx].end >= n.start]
        dur = n.end - n.start
        is_ghost = False

        if dur < 0.135 and n.velocity < 54:
            has_fund = False
            for j in active_prev:
                m = sorted_notes[j]
                ovl = min(n.end, m.end) - max(n.start, m.start)
                if ovl >= dur * 0.45 and (n.pitch - m.pitch) in (12, 19, 24) and m.velocity >= n.velocity * 0.85:
                    has_fund = True
                    break

            if not has_fund:
                f = i + 1
                while f < total and sorted_notes[f].start <= n.end:
                    m = sorted_notes[f]
                    ovl = min(n.end, m.end) - max(n.start, m.start)
                    if ovl >= dur * 0.45 and (n.pitch - m.pitch) in (12, 19, 24) and m.velocity >= n.velocity * 0.85:
                        has_fund = True
                        break
                    f += 1

            if has_fund:
                # 앞뒤 0.35초 내 유사 고음역(±5반음) 연속 음표가 존재하면 실제 고음 멜로디 문맥으로 보호
                has_mel_ctx = False
                k = i - 1
                while k >= 0 and sorted_notes[k].start >= n.start - 2.0:
                    other = sorted_notes[k]
                    if abs(other.pitch - n.pitch) <= 5 and 0.0 < (n.start - other.end) <= 0.35:
                        has_mel_ctx = True
                        break
                    k -= 1
                if not has_mel_ctx:
                    k = i + 1
                    while k < total and sorted_notes[k].start <= n.end + 0.35:
                        other = sorted_notes[k]
                        if abs(other.pitch - n.pitch) <= 5 and 0.0 < (other.start - n.end) <= 0.35:
                            has_mel_ctx = True
                            break
                        k += 1
                if not has_mel_ctx:
                    is_ghost = True

        if not is_ghost:
            keep.append(n)
        active_prev.append(i)

    return keep


def detect_tempo_and_beats(wav_full_path: Path) -> Tuple[float, np.ndarray]:
    """원본 오디오에서 동적 비트 타임라인과 정규화된 BPM(60~185)을 추출"""
    try:
        y, sr = librosa.load(str(wav_full_path), sr=22050, mono=True)
        if y.size < sr * 0.5:
            return 120.0, np.array([], dtype=float)
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=512, trim=False)
        bpm = float(np.atleast_1d(tempo)[0]) if np.size(tempo) > 0 else 120.0
        beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=512).astype(float)
    except Exception:
        return 120.0, np.array([], dtype=float)

    if not np.isfinite(bpm) or bpm <= 0.0:
        bpm = 120.0

    if len(beat_times) >= 4:
        med_d = float(np.median(np.diff(beat_times)))
        if med_d > 0.0:
            # 2배수 오탐지(예: 233 BPM -> 116 BPM) 정규화
            if med_d < 0.34 and len(beat_times[::2]) >= 4:
                beat_times = beat_times[::2]
                med_d = float(np.median(np.diff(beat_times)))
            # 반배수 오탐지 보정
            elif med_d > 0.72:
                mids = (beat_times[:-1] + beat_times[1:]) * 0.5
                beat_times = np.sort(np.concatenate([beat_times, mids]))
                med_d = float(np.median(np.diff(beat_times)))
            if med_d > 0.0:
                bpm = 60.0 / med_d

    while bpm < 60.0:
        bpm *= 2.0
    while bpm > 185.0:
        bpm *= 0.5
    return float(max(60.0, min(185.0, bpm))), beat_times


def detect_tempo_bpm(wav_full_path: Path) -> float:
    """호환용 단일 BPM 추출 래퍼"""
    return detect_tempo_and_beats(wav_full_path)[0]


def build_sixteenth_grid(
    beat_times: Optional[np.ndarray],
    bpm: float,
    max_end_sec: float,
    ref_notes: List[pretty_midi.Note],
) -> Tuple[np.ndarray, float]:
    """실제 비트 타임라인(또는 BPM 위상 탐색) 기반 16분음표 격자 생성"""
    if beat_times is not None and len(beat_times) >= 4:
        bt = np.asarray(beat_times, dtype=float)
        diffs = np.diff(bt)
        med_d = float(np.median(diffs)) if len(diffs) > 0 else 0.5
        if med_d > 0.0:
            step = med_d / 4.0
            lead: List[float] = []
            t0 = float(bt[0])
            while t0 - step >= 0.0:
                t0 -= step
                lead.append(t0)
            lead.reverse()

            grid_pts: List[float] = list(lead)
            for k in range(len(bt) - 1):
                seg_len = float(bt[k + 1] - bt[k])
                for sub in range(4):
                    grid_pts.append(float(bt[k]) + seg_len * (sub / 4.0))

            cur = float(bt[-1])
            end_limit = max(max_end_sec + 1.0, cur + step)
            while cur <= end_limit:
                grid_pts.append(cur)
                cur += step
            return np.array(grid_pts, dtype=float), float(step)

    safe_bpm = max(60.0, min(185.0, float(bpm) if np.isfinite(bpm) else 120.0))
    step = 60.0 / safe_bpm / 4.0
    starts = np.array([n.start for n in ref_notes if n.velocity >= 40], dtype=float)
    if starts.size == 0 and ref_notes:
        starts = np.array([n.start for n in ref_notes], dtype=float)

    best_off = 0.0
    if starts.size > 0:
        best_err = 1e9
        for off in np.linspace(0.0, step, 25, endpoint=False):
            rem = np.abs(((starts - off + step * 0.5) % step) - step * 0.5)
            err = float(np.mean(rem))
            if err < best_err:
                best_err, best_off = err, float(off)

    end_limit = max(1.0, max_end_sec + 1.0)
    grid = np.arange(best_off, end_limit, step, dtype=float)
    return grid, float(step)


def compute_quant_tolerance(
    notes: List[pretty_midi.Note],
    grid: np.ndarray,
    step: float,
    cfg: dict,
) -> float:
    """음표 시작점과 16분음표 격자의 상대 오차율(rel_err)을 평가해 스냅 강도를 결정 (루바토 보호)"""
    if not notes or grid.size < 2 or step <= 0.0:
        return 0.0

    starts = np.array([n.start for n in notes], dtype=float)
    idxs = np.clip(np.searchsorted(grid, starts), 1, grid.size - 1)
    dists = np.minimum(np.abs(starts - grid[idxs - 1]), np.abs(starts - grid[idxs]))
    rel_err = float(np.mean(dists / step))

    if rel_err <= cfg["quant_strict_err"]:
        return float(cfg["quant_tol_strict"])
    if rel_err <= cfg["quant_max_err"]:
        return float(cfg["quant_tol_soft"])
    return 0.0


def quantize_notes_adaptive(
    notes: List[pretty_midi.Note],
    grid: np.ndarray,
    step: float,
    cfg: dict,
    tol_override: Optional[float] = None,
) -> List[pretty_midi.Note]:
    """적응형 16분음표 퀀타이즈 및 동음 중복/미세 겹침 정리"""
    if not notes:
        return []

    tol = compute_quant_tolerance(notes, grid, step, cfg) if tol_override is None else float(tol_override)
    if tol <= 0.0 or grid.size < 2 or step <= 0.0:
        return [
            pretty_midi.Note(
                velocity=int(n.velocity),
                pitch=int(n.pitch),
                start=max(0.0, float(n.start)),
                end=max(0.0, float(n.end)),
            )
            for n in sorted(notes, key=lambda x: (x.start, -x.pitch))
        ]

    max_dist = step * tol

    def snap_time(t_val: float) -> float:
        pos = int(np.searchsorted(grid, t_val))
        if pos <= 0:
            best = float(grid[0])
        elif pos >= grid.size:
            best = float(grid[-1])
        else:
            left, right = float(grid[pos - 1]), float(grid[pos])
            best = left if abs(left - t_val) <= abs(right - t_val) else right
        return best if abs(best - t_val) <= max_dist else float(t_val)

    snapped: List[pretty_midi.Note] = []
    for n in notes:
        gs = max(0.0, snap_time(n.start))
        ge = max(0.0, snap_time(n.end))
        if ge <= gs + 0.020:
            ge = gs + step
        snapped.append(pretty_midi.Note(
            velocity=int(n.velocity),
            pitch=int(n.pitch),
            start=gs,
            end=ge,
        ))

    by_pitch: Dict[int, List[pretty_midi.Note]] = {}
    for n in snapped:
        by_pitch.setdefault(n.pitch, []).append(n)

    merged: List[pretty_midi.Note] = []
    for lst in by_pitch.values():
        lst.sort(key=lambda x: (x.start, -x.end))
        acc: List[pretty_midi.Note] = []
        for n in lst:
            if acc and n.start <= acc[-1].end + 0.005:
                # 동시 중복 스냅이나 짧은 잔여 파편은 병합하고, 정상 연타는 겹침만 컷
                if (n.start - acc[-1].start) < 0.015 or (acc[-1].end - acc[-1].start) < step * 0.9:
                    acc[-1].end = max(acc[-1].end, n.end)
                    acc[-1].velocity = max(acc[-1].velocity, n.velocity)
                else:
                    acc[-1].end = min(acc[-1].end, n.start)
                    if (n.end - n.start) >= 0.020:
                        acc.append(n)
            else:
                acc.append(n)
        merged.extend(acc)

    merged.sort(key=lambda x: (x.start, -x.pitch))
    return merged


# ---------------------------------------------------------------------------
# v6.0 보이스 리딩 기반 비분열 4단 계층 분배 엔진 (A 베이스 -> Z 미들 -> Y 멜로디 -> X 하이)
# ---------------------------------------------------------------------------
def _compute_layer_boundaries(pitches: List[int]) -> Tuple[int, int, int]:
    """곡의 실제 음역 분포에서 A(베이스) / Z(미들) / Y(멜로디) / X(하이) 경계 3개 자동 산출"""
    if not pitches:
        return 46, 55, 67
    ps = sorted(pitches)
    b_bass = max(46, min(53, int(round(float(np.percentile(ps, 25))))))
    b_mid = max(b_bass + 7, min(64, int(round(float(np.percentile(ps, 55))))))
    b_mel = max(b_mid + 7, min(74, int(round(float(np.percentile(ps, 82))))))
    return b_bass, b_mid, b_mel


def _remove_semitone_clashes(
    items: List[Tuple[int, pretty_midi.Note]],
    blocked_pitches: Optional[List[int]] = None,
) -> List[Tuple[int, pretty_midi.Note]]:
    """음량이 강한 음을 우선으로 1반음 충돌(배음/잡음) 및 기준 음과의 충돌을 제거"""
    ranked = sorted(items, key=lambda x: (-x[1].velocity, -x[1].pitch))
    clean: List[Tuple[int, pretty_midi.Note]] = []
    blocked = blocked_pitches or []
    for nid, n in ranked:
        if any(abs(bp - n.pitch) <= 1 for bp in blocked):
            continue
        if any(abs(kn.pitch - n.pitch) == 1 for _, kn in clean):
            continue
        clean.append((nid, n))
    return clean


def _extract_mono_nid_stream(
    notes: List[pretty_midi.Note],
    prefer_low: bool = False,
    fold_spikes: bool = False,
) -> List[Tuple[int, pretty_midi.Note]]:
    """
    단일 스템(예: Demucs bass 또는 vocals)에서 고유 nid(동음 재타건)를 보존한 깔끔한 단선율 추출
    """
    if not notes:
        return []

    events: List[Tuple[float, int, int, pretty_midi.Note]] = []
    for nid, n in enumerate(notes):
        s, e = round(n.start, 3), round(n.end, 3)
        if (e - s) < 0.035:
            continue
        events.append((s, 1, nid, n))
        events.append((e, 0, nid, n))
    if not events:
        return []
    events.sort(key=lambda x: (x[0], x[1]))

    active: Dict[int, pretty_midi.Note] = {}
    open_note: Optional[pretty_midi.Note] = None
    open_nid: Optional[int] = None
    out: List[pretty_midi.Note] = []

    idx = 0
    total = len(events)
    while idx < total:
        t = events[idx][0]
        while idx < total and abs(events[idx][0] - t) <= 0.001:
            _, etype, nid, nobj = events[idx]
            idx += 1
            if etype == 1:
                active[nid] = nobj
            else:
                active.pop(nid, None)

        if not active:
            if open_note is not None:
                open_note.end = t
                if (open_note.end - open_note.start) >= 0.035:
                    out.append(open_note)
                open_note = None
                open_nid = None
            continue

        if open_nid is not None and open_nid in active:
            pick_nid, pick_n = open_nid, active[open_nid]
        else:
            clean = _remove_semitone_clashes(list(active.items()))
            cands = clean or list(active.items())
            if prefer_low:
                pick_nid, pick_n = min(cands, key=lambda x: (x[1].pitch, -x[1].velocity))
            else:
                pick_nid, pick_n = max(cands, key=lambda x: (x[1].velocity, x[1].pitch))

        if open_nid != pick_nid:
            if open_note is not None:
                open_note.end = t
                if (open_note.end - open_note.start) >= 0.035:
                    out.append(open_note)
            open_note = pretty_midi.Note(
                velocity=max(1, min(127, int(pick_n.velocity))),
                pitch=int(pick_n.pitch),
                start=t,
                end=t,
            )
            open_nid = pick_nid

    if open_note is not None:
        open_note.end = events[-1][0]
        if (open_note.end - open_note.start) >= 0.035:
            out.append(open_note)

    if fold_spikes and len(out) >= 2:
        for i in range(1, len(out)):
            cur = out[i]
            prev = out[i - 1]
            if (cur.end - cur.start) < 0.14 and (cur.start - prev.end) <= 0.25 and abs(cur.pitch - prev.pitch) >= 11:
                nxt = out[i + 1] if (i + 1) < len(out) else None
                is_iso = nxt is None or (nxt.start - cur.end) > 0.25 or abs(cur.pitch - nxt.pitch) >= 11
                if is_iso:
                    folded = cur.pitch
                    while folded - prev.pitch >= 11 and folded - 12 >= 48:
                        folded -= 12
                    while prev.pitch - folded >= 11 and folded + 12 <= 84:
                        folded += 12
                    if abs(folded - prev.pitch) < abs(cur.pitch - prev.pitch):
                        cur.pitch = folded

    return [(i, n) for i, n in enumerate(out)]


def _flush_layer_channels(
    tracks: List[List[pretty_midi.Note]],
    open_notes: List[Optional[pretty_midi.Note]],
    open_nids: List[Optional[int]],
    assigned: List[Optional[Tuple[int, pretty_midi.Note]]],
    t: float,
) -> None:
    """할당된 4축 음표를 이전 프레임과 비교해 동음 재타건(nid 변경)을 보존하며 기록"""
    for ch in range(4):
        pick = assigned[ch]
        cur = open_notes[ch]
        if pick is None:
            if cur is not None:
                cur.end = t
                if (cur.end - cur.start) >= 0.035:
                    tracks[ch].append(cur)
                open_notes[ch] = None
                open_nids[ch] = None
        else:
            nid, n = pick
            if open_nids[ch] != nid:
                if cur is not None:
                    cur.end = t
                    if (cur.end - cur.start) >= 0.035:
                        tracks[ch].append(cur)
                open_notes[ch] = pretty_midi.Note(
                    velocity=max(1, min(127, int(n.velocity))),
                    pitch=int(n.pitch),
                    start=t,
                    end=t,
                )
                open_nids[ch] = nid


def _can_place_ordered(
    assigned: List[Optional[Tuple[int, pretty_midi.Note]]],
    cand_ax: int,
    pitch: int,
) -> bool:
    """모든 동시 활성 축 간 X(0) > Y(1) > Z(2) > A(3) 계층 순서가 유지되는지 검증"""
    for other_ax in range(4):
        other = assigned[other_ax]
        if other is None:
            continue
        op = other[1].pitch
        if other_ax < cand_ax and op <= pitch:
            return False
        if other_ax > cand_ax and op >= pitch:
            return False
    return True


def _select_up_to_k_clean(
    clean: List[Tuple[int, pretty_midi.Note]],
    k: int,
    pick_bass: bool = True,
) -> List[Tuple[int, pretty_midi.Note]]:
    """반음 충돌 제거 목록(음량순)에서 최대 k개(최고음 리드 + 최저음 베이스 + 핵심 화음)를 선별해 내림차순 반환"""
    if not clean or k <= 0:
        return []
    if len(clean) <= k:
        return sorted(clean, key=lambda x: -x[1].pitch)

    max_v = clean[0][1].velocity or 1
    pool = list(clean)
    selected: List[Tuple[int, pretty_midi.Note]] = []

    hi_pool = [x for x in pool if x[1].velocity >= max_v * 0.65]
    top = max(hi_pool or pool, key=lambda x: x[1].pitch)
    selected.append(top)
    pool.remove(top)

    if pick_bass and len(selected) < k and pool:
        lo_pool = [x for x in pool if x[1].velocity >= max_v * 0.55]
        bot = min(lo_pool or pool, key=lambda x: x[1].pitch)
        selected.append(bot)
        pool.remove(bot)

    pool.sort(key=lambda x: (-x[1].velocity, -x[1].pitch))
    while len(selected) < k and pool:
        selected.append(pool.pop(0))

    selected.sort(key=lambda x: -x[1].pitch)
    return selected


def split_notes_into_4layers(
    notes: List[pretty_midi.Note],
    bass_override_notes: Optional[List[pretty_midi.Note]] = None,
) -> List[List[pretty_midi.Note]]:
    """
    원음 음표만 사용해 보이스 리딩 기반 비분열 4단 계층 분배 (v6.0):
    - 동시 발음이 1개인 단선율/인트로 리프는 고정 경계로 찢지 않고 단일 축(기본 Y 멜로디)에 연속 유지
    - 2~4성부로 쌓일 때만 A(베이스) -> Z(미들) -> Y(멜로디) -> X(하이) 순으로 역전 0% 적층
    """
    bass_pool = bass_override_notes or []
    all_pool = list(notes) + list(bass_pool)
    if not all_pool:
        return [[], [], [], []]

    b_bass, b_mid, b_mel = _compute_layer_boundaries([n.pitch for n in all_pool])

    # bass_override는 음수 nid(-1, -2, ...), 주 음표는 양수/0 nid(0, 1, ...)로 구분
    events: List[Tuple[float, int, int, int, pretty_midi.Note]] = []
    for idx_n, n in enumerate(notes):
        s, e = round(n.start, 3), round(n.end, 3)
        if (e - s) < 0.035:
            continue
        events.append((s, 1, 0, idx_n, n))
        events.append((e, 0, 0, idx_n, n))

    for idx_b, bn in enumerate(bass_pool):
        s, e = round(bn.start, 3), round(bn.end, 3)
        if (e - s) < 0.035:
            continue
        nid_b = -1 - idx_b
        events.append((s, 1, 1, nid_b, bn))
        events.append((e, 0, 1, nid_b, bn))

    if not events:
        return [[], [], [], []]
    events.sort(key=lambda x: (x[0], x[1]))

    active_main: Dict[int, pretty_midi.Note] = {}
    active_bass: Dict[int, pretty_midi.Note] = {}
    open_notes: List[Optional[pretty_midi.Note]] = [None] * 4
    open_nids: List[Optional[int]] = [None] * 4
    tracks: List[List[pretty_midi.Note]] = [[] for _ in range(4)]
    last_solo_ax = 1  # 단선율 솔로 연속성 유지를 위한 기본 축 (Y 멜로디)

    idx = 0
    total = len(events)
    while idx < total:
        t = events[idx][0]
        while idx < total and abs(events[idx][0] - t) <= 0.001:
            _, etype, src_kind, nid, nobj = events[idx]
            idx += 1
            target_map = active_bass if src_kind == 1 else active_main
            if etype == 1:
                target_map[nid] = nobj
            else:
                target_map.pop(nid, None)

        assigned: List[Optional[Tuple[int, pretty_midi.Note]]] = [None] * 4
        blocked_for_main: List[int] = []

        # 1) Demucs bass 스템이 주어지면 A축(3)에 우선 고정
        if active_bass:
            if open_nids[3] is not None and open_nids[3] in active_bass:
                pick_b = (open_nids[3], active_bass[open_nids[3]])
            else:
                pick_b = min(active_bass.items(), key=lambda x: (x[1].pitch, -x[1].velocity))
            assigned[3] = pick_b
            blocked_for_main.append(pick_b[1].pitch)

        # 2) active_main에서 반음 충돌 및 베이스 중복 이하 음 제거
        clean = _remove_semitone_clashes(list(active_main.items()), blocked_pitches=blocked_for_main)
        if assigned[3] is not None:
            bp = assigned[3][1].pitch
            clean = [(nid, n) for nid, n in clean if n.pitch > bp + 1]

        # 3) 동시 음 개수별 비분열 4단 계층 배치 (X > Y > Z > A)
        if assigned[3] is not None:
            rem = _select_up_to_k_clean(clean, 3, pick_bass=False)
            m_rem = len(rem)
            if m_rem == 1:
                nid, n = rem[0]
                p = n.pitch
                locked_ax = next((ax for ax in (0, 1, 2) if open_nids[ax] == nid), None)
                if locked_ax is not None:
                    ax = locked_ax
                elif p > b_mel + 2:
                    ax = 0
                elif p <= b_mid:
                    ax = 1
                else:
                    ax = last_solo_ax if last_solo_ax in (0, 1) else 1
                assigned[ax] = (nid, n)
                if ax in (0, 1) and p > b_mid:
                    last_solo_ax = ax
            elif m_rem == 2:
                hi, lo = rem[0], rem[1]
                if hi[1].pitch > b_mel:
                    assigned[0] = hi
                    assigned[1 if lo[1].pitch > b_mid else 2] = lo
                else:
                    assigned[1] = hi
                    assigned[2] = lo
            elif m_rem >= 3:
                assigned[0], assigned[1], assigned[2] = rem[0], rem[1], rem[2]
        else:
            sel = _select_up_to_k_clean(clean, 4, pick_bass=True)
            m = len(sel)
            if m == 1:
                nid, n = sel[0]
                p = n.pitch
                locked_ax = next((ax for ax in range(4) if open_nids[ax] == nid), None)
                if locked_ax is not None:
                    ax = locked_ax
                elif p <= b_bass - 4:
                    ax = 3
                elif p > b_mel + 2:
                    ax = 0
                elif p <= b_mid:
                    ax = 1
                else:
                    ax = last_solo_ax if last_solo_ax in (0, 1) else 1
                assigned[ax] = (nid, n)
                if ax in (0, 1) and p > b_mid:
                    last_solo_ax = ax
            elif m == 2:
                hi, lo = sel[0], sel[1]
                if lo[1].pitch <= b_bass + 3:
                    assigned[3] = lo
                    assigned[0 if hi[1].pitch > b_mel else 1] = hi
                elif hi[1].pitch > b_mel:
                    assigned[0] = hi
                    assigned[1 if lo[1].pitch > b_mid else 2] = lo
                else:
                    assigned[1] = hi
                    assigned[2] = lo
            elif m == 3:
                hi, mid, lo = sel[0], sel[1], sel[2]
                if lo[1].pitch <= b_bass + 3:
                    assigned[3] = lo
                    if hi[1].pitch > b_mel:
                        assigned[0] = hi
                        assigned[1 if mid[1].pitch > b_mid else 2] = mid
                    else:
                        assigned[1] = hi
                        assigned[2] = mid
                else:
                    assigned[0], assigned[1], assigned[2] = hi, mid, lo
            elif m >= 4:
                assigned[0], assigned[1], assigned[2], assigned[3] = sel[0], sel[1], sel[2], sel[3]

        _flush_layer_channels(tracks, open_notes, open_nids, assigned, t)

    last_t = events[-1][0]
    _flush_layer_channels(tracks, open_notes, open_nids, [None, None, None, None], last_t)
    return tracks


def arrange_vocal_stems_4layers(
    vocal_notes: List[pretty_midi.Note],
    other_notes: List[pretty_midi.Note],
    bass_notes: List[pretty_midi.Note],
) -> List[List[pretty_midi.Note]]:
    """
    stems 보컬곡 전용 4단 계층 편곡 (100% 원음 음표):
    - A축(3): Demucs bass 스템 단선율 고정
    - Y축(1): Demucs vocals 스템 단선율 고정
    - X축(0): Y(보컬)보다 높은 고음 반주/하모니
    - Z축(2): A(베이스)보다 높고 Y(보컬)보다 낮은 중저음 반주 화음
    - 보컬이 1.2초 이상 쉬는 전주·간주·후주 구간은 other 스템을 X·Y·Z 3계층에 자연 배치
    """
    mono_bass = _extract_mono_nid_stream(bass_notes, prefer_low=True, fold_spikes=False)
    mono_vocal = _extract_mono_nid_stream(vocal_notes, prefer_low=False, fold_spikes=True)

    # 1.2초 이상 보컬 공백 구간(전주·간주·후주) 계산
    rest_spans: List[Tuple[float, float]] = []
    if mono_vocal:
        first_s = mono_vocal[0][1].start
        if first_s >= 1.20:
            rest_spans.append((0.0, first_s - 0.18))
        for i in range(len(mono_vocal) - 1):
            prev_e = mono_vocal[i][1].end
            nxt_s = mono_vocal[i + 1][1].start
            if (nxt_s - prev_e) >= 1.20:
                rest_spans.append((prev_e + 0.18, nxt_s - 0.18))
        last_e = mono_vocal[-1][1].end
        rest_spans.append((last_e + 0.18, 1e9))
    else:
        rest_spans.append((0.0, 1e9))

    other_ps = sorted(n.pitch for n in other_notes)
    if other_ps:
        b_o_mid = max(55, min(67, int(round(float(np.percentile(other_ps, 45))))))
        b_o_mel = max(b_o_mid + 6, min(76, int(round(float(np.percentile(other_ps, 78))))))
    else:
        b_o_mid, b_o_mel = 60, 72

    voc_med = int(round(float(np.median([n.pitch for _, n in mono_vocal])))) if mono_vocal else 67

    def is_in_long_rest(t_sec: float) -> bool:
        for r0, r1 in rest_spans:
            if r0 <= t_sec < r1:
                return True
        return False

    # 이벤트 구성: src_kind 0=other, 1=bass, 2=vocal, 3=rest boundary sync
    events: List[Tuple[float, int, int, int, Optional[pretty_midi.Note]]] = []
    for nid, n in enumerate(other_notes):
        s, e = round(n.start, 3), round(n.end, 3)
        if (e - s) >= 0.035:
            events.append((s, 1, 0, nid, n))
            events.append((e, 0, 0, nid, n))
    for nid, bn in mono_bass:
        events.append((round(bn.start, 3), 1, 1, -10000 - nid, bn))
        events.append((round(bn.end, 3), 0, 1, -10000 - nid, bn))
    for nid, vn in mono_vocal:
        events.append((round(vn.start, 3), 1, 2, -20000 - nid, vn))
        events.append((round(vn.end, 3), 0, 2, -20000 - nid, vn))
    for r0, r1 in rest_spans:
        events.append((round(r0, 3), 2, 3, -1, None))
        if r1 < 1e8:
            events.append((round(r1, 3), 2, 3, -1, None))

    if not events:
        return [[], [], [], []]
    events.sort(key=lambda x: (x[0], x[1]))

    active_other: Dict[int, pretty_midi.Note] = {}
    active_bass: Dict[int, pretty_midi.Note] = {}
    active_voc: Dict[int, pretty_midi.Note] = {}
    open_notes: List[Optional[pretty_midi.Note]] = [None] * 4
    open_nids: List[Optional[int]] = [None] * 4
    tracks: List[List[pretty_midi.Note]] = [[] for _ in range(4)]

    idx = 0
    total = len(events)
    while idx < total:
        t = events[idx][0]
        while idx < total and abs(events[idx][0] - t) <= 0.001:
            _, etype, src_kind, nid, nobj = events[idx]
            idx += 1
            if src_kind == 3 or nobj is None:
                continue
            tmap = active_other if src_kind == 0 else (active_bass if src_kind == 1 else active_voc)
            if etype == 1:
                tmap[nid] = nobj
            else:
                tmap.pop(nid, None)

        assigned: List[Optional[Tuple[int, pretty_midi.Note]]] = [None] * 4

        # Y축(1) 보컬 우선 배치
        voc_p: Optional[int] = None
        if active_voc:
            pick_v = next(iter(active_voc.items()))
            assigned[1] = pick_v
            voc_p = pick_v[1].pitch

        # A축(3) 베이스 배치 (보컬보다 최소 2반음 이상 낮을 때만)
        bass_p: Optional[int] = None
        if active_bass:
            pick_b = next(iter(active_bass.items()))
            if voc_p is None or pick_b[1].pitch < voc_p - 1:
                assigned[3] = pick_b
                bass_p = pick_b[1].pitch

        # other 스템에서 보컬/베이스와 충돌하지 않는 음 추리기
        blocked = [p for p in (voc_p, bass_p) if p is not None]
        clean_other = _remove_semitone_clashes(list(active_other.items()), blocked_pitches=blocked)
        if bass_p is not None:
            clean_other = [(nid, n) for nid, n in clean_other if n.pitch > bass_p + 1]

        if voc_p is not None:
            # 보컬 가창 중: X축(하이) = voc_p보다 높은 반주, Z축(미들) = voc_p보다 낮은 반주
            hi_cands = [(nid, n) for nid, n in clean_other if n.pitch > voc_p + 1]
            mid_cands = [(nid, n) for nid, n in clean_other if n.pitch < voc_p - 1]
            if hi_cands:
                locked = [x for x in hi_cands if x[0] == open_nids[0]]
                assigned[0] = locked[0] if locked else max(hi_cands, key=lambda x: (x[1].velocity, x[1].pitch))
            if mid_cands:
                locked = [x for x in mid_cands if x[0] == open_nids[2]]
                assigned[2] = locked[0] if locked else max(mid_cands, key=lambda x: (x[1].velocity, x[1].pitch))
        elif is_in_long_rest(t) and clean_other:
            # 전주/간주/후주(>=1.2초 휴지): other 음표를 X·Y·Z 3계층에 역전 없이 배치
            for item in clean_other:
                p = item[1].pitch
                if p > b_o_mel:
                    ax_pref = (0, 1, 2)
                elif p > b_o_mid:
                    ax_pref = (1, 0, 2)
                else:
                    ax_pref = (2, 1, 0)
                for ax in ax_pref:
                    if assigned[ax] is None and _can_place_ordered(assigned, ax, p):
                        assigned[ax] = item
                        break
        elif clean_other:
            # 짧은 보컬 숨 고름 구간: voc_med 기준으로 고음(X)/중음(Z)만 유지해 Y(보컬) 호흡 보호
            hi_cands = [(nid, n) for nid, n in clean_other if n.pitch > voc_med + 1]
            mid_cands = [(nid, n) for nid, n in clean_other if n.pitch <= voc_med]
            if hi_cands:
                locked = [x for x in hi_cands if x[0] == open_nids[0]]
                cand_x = locked[0] if locked else max(hi_cands, key=lambda x: (x[1].velocity, x[1].pitch))
                if _can_place_ordered(assigned, 0, cand_x[1].pitch):
                    assigned[0] = cand_x
            if mid_cands:
                locked = [x for x in mid_cands if x[0] == open_nids[2]]
                cand_z = locked[0] if locked else max(mid_cands, key=lambda x: (x[1].velocity, x[1].pitch))
                if _can_place_ordered(assigned, 2, cand_z[1].pitch):
                    assigned[2] = cand_z

        _flush_layer_channels(tracks, open_notes, open_nids, assigned, t)

    last_t = events[-1][0]
    _flush_layer_channels(tracks, open_notes, open_nids, [None, None, None, None], last_t)
    return tracks


def build_4track_midi(
    track_notes: List[List[pretty_midi.Note]],
    track_names: List[str],
    out_mid_path: Path,
    initial_tempo: float = 120.0,
) -> Path:
    """4개 단선율 트랙을 표준 SMF Format 1 MIDI 파일로 저장"""
    programs = [80, 73, 48, 33]  # High(Synth Lead), Melody(Flute), Middle(Strings), Bass(Finger Bass)
    pm = pretty_midi.PrettyMIDI(initial_tempo=max(40.0, min(240.0, float(initial_tempo))))

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


def smooth_accompaniment_track(
    notes: List[pretty_midi.Note],
    step: float,
    max_merge_steps: int = 2,
) -> List[pretty_midi.Note]:
    """Z(미들)·A(베이스) 축에서 같은 음이 16분음표 기관총처럼 쪼개지는 떨림을 최대 8분음표 단위로 안정화"""
    if not notes:
        return []
    sorted_notes = sorted(notes, key=lambda n: n.start)
    out: List[pretty_midi.Note] = []
    max_dur = max(0.08, step * max_merge_steps + 0.015)

    for n in sorted_notes:
        if (
            out
            and out[-1].pitch == n.pitch
            and (n.start - out[-1].end) <= 0.020
            and (n.end - out[-1].start) <= max_dur
        ):
            out[-1].end = max(out[-1].end, n.end)
            out[-1].velocity = max(out[-1].velocity, n.velocity)
        else:
            out.append(pretty_midi.Note(
                velocity=int(n.velocity),
                pitch=int(n.pitch),
                start=float(n.start),
                end=float(n.end),
            ))
    return out


def _articulate_4tracks(
    tracks: List[List[pretty_midi.Note]],
    cfg: dict,
    grid_step: float = 0.125,
) -> List[List[pretty_midi.Note]]:
    """
    축별 차별 스텝모터 아티큘레이션 적용:
    - Z·A 반주 축은 연속 동일음 8분음표 안정화 후 단단한 반주 게이트 적용
    - X·Y 리드 축은 선명하고 경쾌한 타건 스타카토 적용
    """
    worked = [list(tr) for tr in tracks]
    while len(worked) < 4:
        worked.append([])

    max_merge_steps = int(cfg.get("smooth_accomp_steps", 1))
    if max_merge_steps > 1:
        worked[2] = smooth_accompaniment_track(worked[2], grid_step, max_merge_steps=max_merge_steps)
        worked[3] = smooth_accompaniment_track(worked[3], grid_step, max_merge_steps=max_merge_steps)

    return [
        apply_stepper_articulation(
            worked[0],
            gate_ratio=cfg["lead_gate"],
            min_gap_sec=cfg["lead_min_gap"],
            max_gap_sec=cfg["lead_max_gap"],
            min_note_sec=cfg["lead_min_note"],
        ),
        apply_stepper_articulation(
            worked[1],
            gate_ratio=cfg["lead_gate"],
            min_gap_sec=cfg["lead_min_gap"],
            max_gap_sec=cfg["lead_max_gap"],
            min_note_sec=cfg["lead_min_note"],
        ),
        apply_stepper_articulation(
            worked[2],
            gate_ratio=cfg["accomp_gate"],
            min_gap_sec=cfg["accomp_min_gap"],
            max_gap_sec=cfg["accomp_max_gap"],
            min_note_sec=cfg["accomp_min_note"],
        ),
        apply_stepper_articulation(
            worked[3],
            gate_ratio=cfg["bass_gate"],
            min_gap_sec=cfg["accomp_min_gap"],
            max_gap_sec=cfg["accomp_max_gap"],
            min_note_sec=cfg["accomp_min_note"],
        ),
    ]


def transcribe_audio_to_4track_midi(
    src_audio: Path,
    out_mid_path: Path,
    work_dir: Path,
    mode: str = "clean",
) -> Path:
    """
    선택된 모드(clean / stems / detail)로 오디오를 4트랙 MIDI로 변환 (v6.0)
    - 드럼 블리드·배음 고스트 제거 + 적응형 16분음표 칼박 퀀타이즈
    - 보이스 리딩 기반 비분열 4단 계층 분배 (A 베이스 -> Z 미들 -> Y 멜로디 -> X 하이)
    """
    cfg = MODE_PRESETS.get(mode, MODE_PRESETS["clean"])

    if mode == "stems":
        full_22k = work_dir / "full_22k.wav"
        convert_audio_ffmpeg(src_audio, full_22k, sample_rate=22050, channels=1)
        bpm, beat_times = detect_tempo_and_beats(full_22k)

        # Demucs AI로 vocals / other / bass / drums(폐기) 분리
        stems = separate_stems_with_demucs(src_audio, work_dir)

        o_wav = work_dir / "stem_other_22k.wav"
        convert_audio_ffmpeg(stems["other"], o_wav, sample_rate=22050, channels=1)
        y_other, sr = sf.read(str(o_wav), dtype="float32")
        rms_other = float(np.sqrt(np.mean(y_other ** 2))) + 1e-8

        y_voc = None
        rms_voc = 0.0
        v_wav = work_dir / "stem_vocals_22k.wav"
        if "vocals" in stems:
            convert_audio_ffmpeg(stems["vocals"], v_wav, sample_rate=22050, channels=1)
            y_voc, _ = sf.read(str(v_wav), dtype="float32")
            rms_voc = float(np.sqrt(np.mean(y_voc ** 2)))

        # 베이스 스템 전용 채보 후 >= MIDI 36(C2) 옥타브 정규화 -> A축 베이스 전담
        bass_notes: List[pretty_midi.Note] = []
        if "bass" in stems:
            b_wav = work_dir / "stem_bass_22k.wav"
            convert_audio_ffmpeg(stems["bass"], b_wav, sample_rate=22050, channels=1)
            bass_raw = predict_filtered_notes(
                b_wav,
                onset_threshold=0.42,
                frame_threshold=0.30,
                min_note_ms=60.0,
                min_velocity=24,
                min_freq=41.2,
                max_freq=280.0,
            )
            bass_notes = normalize_min_pitch(bass_raw, min_pitch=36)

        # 기악곡 8비트/신스가 vocals 스템으로 새어 오탐지되지 않도록 엄격한 기준(0.28) 적용
        is_vocal_song = (y_voc is not None) and (rms_voc >= rms_other * 0.28)
        voc_notes: List[pretty_midi.Note] = []
        if is_vocal_song:
            voc_raw = predict_filtered_notes(
                v_wav,
                onset_threshold=0.40,
                frame_threshold=0.28,
                min_note_ms=55.0,
                min_velocity=24,
                min_freq=130.8,
                max_freq=1318.5,
            )
            voc_notes = [n for n in voc_raw if (n.end - n.start) >= 0.05]
            if len(voc_notes) < 20:
                is_vocal_song = False

        if is_vocal_song:
            other_notes = predict_filtered_notes(
                o_wav,
                onset_threshold=cfg["onset_threshold"],
                frame_threshold=cfg["frame_threshold"],
                min_note_ms=cfg["min_note_ms"],
                min_velocity=cfg["min_velocity"],
                min_freq=65.4,
                max_freq=1568.0,
            )
            other_notes = filter_percussive_bleed(
                other_notes,
                vel_ratio=cfg["bleed_ratio"],
                floor_vel=cfg["bleed_min_vel"],
                max_dur=cfg["bleed_max_dur"],
            )
            other_notes = remove_harmonic_ghosts(other_notes)

            combined = voc_notes + other_notes + bass_notes
            max_end = max((n.end for n in combined), default=0.0)
            grid, grid_step = build_sixteenth_grid(beat_times, bpm, max_end, combined)
            common_tol = compute_quant_tolerance(combined, grid, grid_step, cfg)

            voc_notes = quantize_notes_adaptive(voc_notes, grid, grid_step, cfg, tol_override=common_tol)
            other_notes = quantize_notes_adaptive(other_notes, grid, grid_step, cfg, tol_override=common_tol)
            bass_notes = quantize_notes_adaptive(bass_notes, grid, grid_step, cfg, tol_override=common_tol)
            raw_tracks = arrange_vocal_stems_4layers(voc_notes, other_notes, bass_notes)
        else:
            # 기악곡: other + vocals(드럼/베이스 제외) 실제 음표 -> X·Y·Z, bass 스템 -> A
            if y_voc is not None:
                ml = min(len(y_other), len(y_voc))
                y_harm = y_other[:ml] + y_voc[:ml]
                pk2 = float(np.max(np.abs(y_harm))) or 1.0
                if pk2 > 0.98:
                    y_harm = y_harm * (0.95 / pk2)
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
            harm_notes = filter_percussive_bleed(
                harm_notes,
                vel_ratio=cfg["bleed_ratio"],
                floor_vel=cfg["bleed_min_vel"],
                max_dur=cfg["bleed_max_dur"],
            )
            harm_notes = remove_harmonic_ghosts(harm_notes)

            combined = harm_notes + bass_notes
            max_end = max((n.end for n in combined), default=0.0)
            grid, grid_step = build_sixteenth_grid(beat_times, bpm, max_end, combined)
            common_tol = compute_quant_tolerance(combined, grid, grid_step, cfg)

            harm_notes = quantize_notes_adaptive(harm_notes, grid, grid_step, cfg, tol_override=common_tol)
            bass_notes = quantize_notes_adaptive(bass_notes, grid, grid_step, cfg, tol_override=common_tol)
            raw_tracks = split_notes_into_4layers(harm_notes, bass_override_notes=bass_notes)

        tracks = _articulate_4tracks(raw_tracks, cfg, grid_step=grid_step)
        return build_4track_midi(tracks, LAYER_TRACK_NAMES, out_mid_path, initial_tempo=bpm)

    if mode == "clean":
        # 원음 클린 4계층 모드: 65.4Hz 이상 채보 + 블리드/배음 제거 + 16분음표 칼박 + 비분열 4단 분배
        wav_path = work_dir / "full_22k.wav"
        convert_audio_ffmpeg(src_audio, wav_path, sample_rate=22050, channels=1)
        bpm, beat_times = detect_tempo_and_beats(wav_path)
        key_info = analyze_chroma_and_key(wav_path)
        raw_notes = predict_filtered_notes(
            wav_path,
            onset_threshold=cfg["onset_threshold"],
            frame_threshold=cfg["frame_threshold"],
            min_note_ms=cfg["min_note_ms"],
            min_velocity=cfg["min_velocity"],
            min_freq=65.4,
            max_freq=1568.0,
        )
        clean_notes = key_aware_filter_notes(
            raw_notes,
            key_info,
            base_min_vel=cfg["min_velocity"],
            out_of_key_penalty=cfg["out_of_key_penalty"],
        )
        clean_notes = filter_percussive_bleed(
            clean_notes,
            vel_ratio=cfg["bleed_ratio"],
            floor_vel=cfg["bleed_min_vel"],
            max_dur=cfg["bleed_max_dur"],
        )
        clean_notes = remove_harmonic_ghosts(clean_notes)
        max_end = max((n.end for n in clean_notes), default=0.0)
        grid, grid_step = build_sixteenth_grid(beat_times, bpm, max_end, clean_notes)
        clean_notes = quantize_notes_adaptive(clean_notes, grid, grid_step, cfg)

        raw_tracks = split_notes_into_4layers(clean_notes)
        tracks = _articulate_4tracks(raw_tracks, cfg, grid_step=grid_step)
        return build_4track_midi(tracks, LAYER_TRACK_NAMES, out_mid_path, initial_tempo=bpm)

    # detail 모드: 65.4Hz 이상 풀디테일 채보 + 완만한 블리드·배음 정리 + 가벼운 퀀타이즈 + 비분열 4단 분배
    wav_path = work_dir / "input_22k.wav"
    prepare_wav_for_basic_pitch(src_audio, wav_path, remove_drums=False)
    bpm, beat_times = detect_tempo_and_beats(wav_path)
    raw_notes = predict_filtered_notes(
        wav_path,
        onset_threshold=cfg["onset_threshold"],
        frame_threshold=cfg["frame_threshold"],
        min_note_ms=cfg["min_note_ms"],
        min_velocity=cfg["min_velocity"],
        min_freq=65.4,
        max_freq=1568.0,
    )
    raw_notes = filter_percussive_bleed(
        raw_notes,
        vel_ratio=cfg["bleed_ratio"],
        floor_vel=cfg["bleed_min_vel"],
        max_dur=cfg["bleed_max_dur"],
    )
    raw_notes = remove_harmonic_ghosts(raw_notes)
    max_end = max((n.end for n in raw_notes), default=0.0)
    grid, grid_step = build_sixteenth_grid(beat_times, bpm, max_end, raw_notes)
    raw_notes = quantize_notes_adaptive(raw_notes, grid, grid_step, cfg)

    raw_tracks = split_notes_into_4layers(raw_notes)
    tracks = _articulate_4tracks(raw_tracks, cfg, grid_step=grid_step)
    return build_4track_midi(tracks, LAYER_TRACK_NAMES, out_mid_path, initial_tempo=bpm)


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
        "version": "6.0",
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
        print(f"MidiMoter AI 4트랙 편곡 서버 시작: http://{args.host}:{args.port} (v6.0, Demucs={DEMUCS_AVAILABLE})")
        uvicorn.run(app, host=args.host, port=args.port)
