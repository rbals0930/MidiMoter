"""
MidiMoter 3단계 로컬 변환 백엔드 서버 (v3.2)
FastAPI + yt-dlp + librosa HPSS + Demucs AI 스템 분리 + basic-pitch ONNX + 4트랙 자동 분리
-----------------------------------------------------------------------------------------
변환 모드:
  - clean  (기본, 빠른 4트랙 · 큰 줄기): HPSS 드럼 제거 + basic-pitch + 4트랙 자동 분리 (20~40초)
  - stems  (고품질 4트랙 · Demucs AI)  : Demucs(htdemucs)로 보컬/반주/베이스/드럼(폐기) 분리 후
                                         각 스템별 채보 -> 4트랙 MIDI 생성 (기악곡 자동 폴백)
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
        "onset_threshold": 0.62,
        "frame_threshold": 0.48,
        "min_note_ms": 110.0,
        "min_velocity": 48,
    },
    "stems": {
        "remove_drums": False,  # Demucs가 드럼 스템을 직접 분리·폐기함
        "onset_threshold": 0.56,
        "frame_threshold": 0.42,
        "min_note_ms": 95.0,
        "min_velocity": 42,
    },
    "detail": {
        "remove_drums": False,
        "onset_threshold": 0.50,
        "frame_threshold": 0.35,
        "min_note_ms": 65.0,
        "min_velocity": 25,
    },
}

app = FastAPI(title="MidiMoter AI Converter API", version="3.2")

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

    # 모든 시작/종료 시각 수집 (1ms 반올림으로 미세 지터 병합)
    events: List[Tuple[float, int, pretty_midi.Note]] = []
    for n in notes:
        s = round(n.start, 3)
        e = round(n.end, 3)
        if e <= s:
            continue
        events.append((s, 1, n))   # 1 = on
        events.append((e, 0, n))   # 0 = off (같은 시각엔 off 먼저)

    events.sort(key=lambda x: (x[0], x[1]))

    active: Dict[int, List[int]] = {}  # pitch -> [velocities]
    prev_assigned: List[Optional[Tuple[int, int]]] = [None] * num_voices  # (pitch, vel)
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

        # 후보 리스트: (pitch, max_vel)
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
                # 최고음 멜로디 (강한 음 중 최고음)
                mel_pool = [c for c in pool if c[1] >= max_vel * 0.65] or pool
                mel = max(mel_pool, key=lambda c: c[0])
                selected_map[mel[0]] = mel[1]
                pool.remove(mel)

                # 베이스 (마지막 트랙이 베이스 역할일 때, 강한 음 중 최저음)
                if prefer_bass_on_last and len(selected_map) < num_voices and pool:
                    bass_pool = [c for c in pool if c[1] >= max_vel * 0.55] or pool
                    bass = min(bass_pool, key=lambda c: c[0])
                    selected_map[bass[0]] = bass[1]
                    pool.remove(bass)

                # 나머지 화음: 음량이 강한 순
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

        # 남은 새 음표들을 남은 트랙에 배치
        rest_sorted = sorted(unassigned.items(), key=lambda x: x[0])  # 저음 -> 고음
        if prefer_bass_on_last and (num_voices - 1) in empty_chs and rest_sorted:
            p, v = rest_sorted.pop(0)
            assigned[num_voices - 1] = (p, v)
            empty_chs.remove(num_voices - 1)

        for ch in empty_chs:
            if rest_sorted:
                p, v = rest_sorted.pop()  # 고음부터 상위 트랙 배치
                assigned[ch] = (p, v)

        for ch in range(num_voices):
            if assigned[ch] is not None:
                flush_channel(ch, cur_t, assigned[ch][0], assigned[ch][1])
            else:
                flush_channel(ch, cur_t, 0, 0)

        prev_assigned = assigned

    # 마지막 열려 있는 노트 마감
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
    """
    Meta Demucs(htdemucs)로 오디오를 vocals / bass / other / drums 4개 WAV 스템으로 분리.
    """
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
    """
    cfg = MODE_PRESETS.get(mode, MODE_PRESETS["clean"])

    if mode == "stems":
        # 고품질 모드: Demucs로 보컬/반주/베이스 분리 (드럼 스템은 자동 폐기)
        stems = separate_stems_with_demucs(src_audio, work_dir)

        # 각 스템을 22050Hz 모노로 맞춰 basic-pitch 채보
        vocals_notes: List[pretty_midi.Note] = []
        other_notes: List[pretty_midi.Note] = []
        bass_notes: List[pretty_midi.Note] = []

        if "vocals" in stems:
            v_wav = work_dir / "stem_vocals_22k.wav"
            convert_audio_ffmpeg(stems["vocals"], v_wav, sample_rate=22050, channels=1)
            vocals_notes = predict_filtered_notes(
                v_wav,
                onset_threshold=cfg["onset_threshold"],
                frame_threshold=cfg["frame_threshold"],
                min_note_ms=cfg["min_note_ms"],
                min_velocity=cfg["min_velocity"],
                min_freq=130.8,   # C3 이상 (보컬/리드 대역)
                max_freq=1568.0,
            )

        if "other" in stems:
            o_wav = work_dir / "stem_other_22k.wav"
            convert_audio_ffmpeg(stems["other"], o_wav, sample_rate=22050, channels=1)
            other_notes = predict_filtered_notes(
                o_wav,
                onset_threshold=cfg["onset_threshold"],
                frame_threshold=cfg["frame_threshold"],
                min_note_ms=cfg["min_note_ms"],
                min_velocity=cfg["min_velocity"],
                min_freq=65.4,
                max_freq=1568.0,
            )

        if "bass" in stems:
            b_wav = work_dir / "stem_bass_22k.wav"
            convert_audio_ffmpeg(stems["bass"], b_wav, sample_rate=22050, channels=1)
            bass_notes = predict_filtered_notes(
                b_wav,
                onset_threshold=cfg["onset_threshold"],
                frame_threshold=cfg["frame_threshold"],
                min_note_ms=cfg["min_note_ms"],
                min_velocity=cfg["min_velocity"],
                min_freq=41.2,    # E1 ~ C4 (베이스 전용 대역)
                max_freq=330.0,
            )

        has_vocals = len(vocals_notes) >= 8
        has_bass = len(bass_notes) >= 5

        if has_vocals and has_bass:
            # 보컬 + 반주(2성부) + 베이스 정석 4트랙 구성
            t_x = split_notes_into_k_voices(vocals_notes, 1, prefer_bass_on_last=False, pick_mode="high")[0]
            t_yz = split_notes_into_k_voices(other_notes, 2, prefer_bass_on_last=False)
            t_a = split_notes_into_k_voices(bass_notes, 1, prefer_bass_on_last=False, pick_mode="low")[0]
            tracks = [t_x, t_yz[0], t_yz[1], t_a]
            names = ["X-Axis Vocals", "Y-Axis Harmony 1", "Z-Axis Harmony 2", "A-Axis Bass"]
        elif (not has_vocals) and has_bass:
            # 기악곡(보컬 없음): 반주(other)에서 X·Y·Z 3성부 + 베이스 스템 A축
            t_xyz = split_notes_into_k_voices(other_notes, 3, prefer_bass_on_last=False)
            t_a = split_notes_into_k_voices(bass_notes, 1, prefer_bass_on_last=False, pick_mode="low")[0]
            tracks = [t_xyz[0], t_xyz[1], t_xyz[2], t_a]
            names = ["X-Axis Lead", "Y-Axis Harmony 1", "Z-Axis Harmony 2", "A-Axis Bass"]
        elif has_vocals and (not has_bass):
            # 베이스 없는 어쿠스틱/피아노 보컬곡: 보컬 X축 + 반주에서 Y·Z·A 3성부
            t_x = split_notes_into_k_voices(vocals_notes, 1, prefer_bass_on_last=False, pick_mode="high")[0]
            t_yza = split_notes_into_k_voices(other_notes, 3, prefer_bass_on_last=True)
            tracks = [t_x, t_yza[0], t_yza[1], t_yza[2]]
            names = ["X-Axis Vocals", "Y-Axis Harmony 1", "Z-Axis Harmony 2", "A-Axis Bass"]
        else:
            # 솔로 피아노 등: other 스템을 4트랙 자동 분리
            tracks = split_notes_into_k_voices(other_notes, 4, prefer_bass_on_last=True)
            names = ["X-Axis Melody", "Y-Axis Harmony 1", "Z-Axis Harmony 2", "A-Axis Bass"]

        return build_4track_midi(tracks, names, out_mid_path)

    # 빠른 4트랙 모드 (clean / detail)
    wav_path = work_dir / "input_22k.wav"
    prepare_wav_for_basic_pitch(src_audio, wav_path, remove_drums=cfg["remove_drums"])
    all_notes = predict_filtered_notes(
        wav_path,
        onset_threshold=cfg["onset_threshold"],
        frame_threshold=cfg["frame_threshold"],
        min_note_ms=cfg["min_note_ms"],
        min_velocity=cfg["min_velocity"],
    )
    tracks = split_notes_into_k_voices(all_notes, 4, prefer_bass_on_last=True)
    names = ["X-Axis Melody", "Y-Axis Harmony 1", "Z-Axis Harmony 2", "A-Axis Bass"]
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
        "version": "3.2",
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
        print(f"MidiMoter AI 4트랙 변환 서버 시작: http://{args.host}:{args.port} (Demucs={DEMUCS_AVAILABLE})")
        uvicorn.run(app, host=args.host, port=args.port)
