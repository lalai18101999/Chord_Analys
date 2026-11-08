from __future__ import annotations

import asyncio
import hmac
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import wave
from importlib.util import find_spec
from collections import Counter, defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import mido
import ffmpeg as ffmpeg_bundle
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("CHORDCRAFT_DATA_DIR", ROOT / "data")).resolve()
JOBS_DIR = DATA_DIR / "jobs"
WEB_DIR = Path(os.environ.get("CHORDCRAFT_WEB_DIR", ROOT.parent / "dist")).resolve()
MAX_UPLOAD_BYTES = 150 * 1024 * 1024
JOB_RETENTION_SECONDS = 24 * 60 * 60
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac"}
PITCH_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
logger = logging.getLogger(__name__)


async def cleanup_job_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(cleanup_expired_jobs)
        except OSError:
            logger.exception("Could not remove expired analysis jobs.")
        await asyncio.sleep(60 * 60)


@asynccontextmanager
async def lifespan(_: FastAPI):
    cleanup_expired_jobs()
    cleanup_task = asyncio.create_task(cleanup_job_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="Chordcraft Analysis Server",
    version="0.1.0",
    lifespan=lifespan,
)
analysis_lock = asyncio.Lock()
ffmpeg_bundle.init()
ffmpeg_bundle.add_to_path()
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get(
        "CHORDCRAFT_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.middleware("http")
async def protect_analysis(request: Request, call_next):
    protected_request = request.method == "POST" and request.url.path in {
        "/api/analyze",
        "/api/auth/verify",
    }
    if protected_request:
        try:
            verify_access(request.headers.get("x-chordcraft-password"))
        except HTTPException as error:
            return JSONResponse(
                status_code=error.status_code,
                content={"detail": error.detail},
            )
    if request.method == "POST" and request.url.path == "/api/analyze":
        if analysis_lock.locked():
            return JSONResponse(
                status_code=429,
                content={"detail": "Another song is being analyzed. Please wait and try again."},
            )
        await analysis_lock.acquire()
        try:
            return await call_next(request)
        finally:
            analysis_lock.release()
    return await call_next(request)


def password_required() -> bool:
    return (
        os.environ.get("CHORDCRAFT_REQUIRE_PASSWORD", "").lower() == "true"
        or bool(os.environ.get("RAILWAY_ENVIRONMENT"))
        or bool(os.environ.get("PORT"))
    )


def verify_access(password: str | None) -> None:
    if not password_required():
        return
    expected_password = os.environ.get("CHORDCRAFT_ACCESS_PASSWORD", "")
    if len(expected_password) < 16:
        raise HTTPException(
            status_code=503,
            detail="The server owner must configure a shared access password of at least 16 characters.",
        )
    if password is None or not hmac.compare_digest(password, expected_password):
        raise HTTPException(status_code=401, detail="Incorrect shared password.")


def cleanup_expired_jobs() -> None:
    if not JOBS_DIR.is_dir():
        return
    cutoff = time.time() - JOB_RETENTION_SECONDS
    for job_dir in JOBS_DIR.iterdir():
        if job_dir.is_dir() and job_dir.stat().st_mtime < cutoff:
            shutil.rmtree(job_dir)


def resolve_command(name: str) -> str | None:
    if name == "ffmpeg":
        bundled_command = Path(ffmpeg_bundle.FFMPEG_PATH)
        if bundled_command.is_file():
            return str(bundled_command)
    if name == "ffprobe":
        bundled_command = Path(ffmpeg_bundle.FFPROBE_PATH)
        if bundled_command.is_file():
            return str(bundled_command)

    executable = f"{name}.exe" if os.name == "nt" else name
    environment_command = Path(sys.executable).with_name(executable)
    if environment_command.is_file():
        return str(environment_command)
    return shutil.which(name)


def safe_job_file(job_id: str, filename: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise HTTPException(status_code=404, detail="Analysis result not found.")
    if Path(filename).name != filename or filename.startswith("."):
        raise HTTPException(status_code=404, detail="File not found.")
    path = (JOBS_DIR / job_id / filename).resolve()
    if not path.is_relative_to(JOBS_DIR.resolve()) or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    return path


def run_command(
    command: list[str],
    timeout: int,
    step: str,
) -> None:
    try:
        environment = os.environ.copy()
        environment["PYTHONUTF8"] = "1"
        executable_directories = [
            str(ffmpeg_bundle.FFMPEG_FOLDER),
            str(Path(command[0]).parent),
            environment.get("PATH", ""),
        ]
        environment["PATH"] = os.pathsep.join(executable_directories)
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=environment,
        )
    except subprocess.TimeoutExpired as error:
        raise HTTPException(
            status_code=504,
            detail=f"{step} timed out. Try a shorter audio file or a faster computer.",
        ) from error
    except OSError as error:
        raise HTTPException(status_code=503, detail=f"Could not start {step}.") from error

    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout).strip()
        details = details[-1200:] if details else "No additional details."
        raise HTTPException(status_code=500, detail=f"{step} failed: {details}")


async def run_command_async(
    command: list[str],
    timeout: int,
    step: str,
) -> None:
    await asyncio.to_thread(run_command, command, timeout, step)


def solola_compatible_lead_notes(
    guitar_stem: Path,
) -> list[dict[str, float | int]]:
    if find_spec("librosa") is None:
        raise HTTPException(
            status_code=503,
            detail="The SoloLa-compatible engine requires librosa in the current Python environment.",
        )

    try:
        import librosa
        import numpy as np

        sample_rate = 22050
        hop_length = 256
        frame_length = 2048
        audio, _ = librosa.load(guitar_stem, sr=sample_rate, mono=True)
        if len(audio) < frame_length:
            raise HTTPException(
                status_code=422,
                detail="The separated guitar stem is too short for lead transcription.",
            )
        frequencies, voiced, confidence = librosa.pyin(
            audio,
            fmin=librosa.note_to_hz("E2"),
            fmax=librosa.note_to_hz("E6"),
            sr=sample_rate,
            frame_length=frame_length,
            hop_length=hop_length,
        )
    except HTTPException:
        raise
    except (OSError, ValueError, RuntimeError) as error:
        raise HTTPException(
            status_code=500,
            detail=f"SoloLa-compatible pitch extraction failed: {error}",
        ) from error

    raw_pitches = np.full(len(frequencies), -1, dtype=int)
    usable = voiced & np.isfinite(frequencies) & (confidence >= 0.55)
    raw_pitches[usable] = np.rint(librosa.hz_to_midi(frequencies[usable])).astype(int)

    smoothed = raw_pitches.copy()
    for frame in range(len(raw_pitches)):
        if raw_pitches[frame] < 0:
            continue
        neighborhood = raw_pitches[max(0, frame - 2):min(len(raw_pitches), frame + 3)]
        valid = sorted(int(pitch) for pitch in neighborhood if pitch >= 0)
        if valid:
            smoothed[frame] = valid[len(valid) // 2]

    for frame in range(1, len(smoothed) - 1):
        if smoothed[frame] < 0 and smoothed[frame - 1] == smoothed[frame + 1]:
            smoothed[frame] = smoothed[frame - 1]

    notes: list[dict[str, float | int]] = []
    run_start = 0
    while run_start < len(smoothed):
        pitch = int(smoothed[run_start])
        run_end = run_start + 1
        while run_end < len(smoothed) and smoothed[run_end] == pitch:
            run_end += 1
        duration = (run_end - run_start) * hop_length / sample_rate
        if pitch >= 0 and duration >= 0.08:
            notes.append(
                {
                    "pitch": pitch,
                    "start": max(0.0, run_start * hop_length / sample_rate - hop_length / (2 * sample_rate)),
                    "duration": duration,
                }
            )
        run_start = run_end

    if not notes:
        raise HTTPException(
            status_code=422,
            detail="No stable lead notes were detected in the separated guitar stem.",
        )
    return notes


def write_visual_notes_midi(
    notes: list[dict[str, float | int]],
    destination: Path,
    ticks_per_beat: int,
    tempo: int,
) -> list[dict[str, Any]]:
    midi = mido.MidiFile(type=1, ticks_per_beat=ticks_per_beat)
    meta_track = mido.MidiTrack()
    meta_track.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
    meta_track.append(mido.MetaMessage("end_of_track", time=0))
    midi.tracks.append(meta_track)

    ticks_per_second = ticks_per_beat * 1_000_000 / tempo
    tick_notes: list[dict[str, Any]] = []
    events: list[tuple[int, int, mido.Message]] = []
    for note in notes:
        start_tick = round(float(note["start"]) * ticks_per_second)
        end_tick = max(
            start_tick + 1,
            round((float(note["start"]) + float(note["duration"])) * ticks_per_second),
        )
        pitch = int(note["pitch"])
        tick_notes.append(
            {
                "pitch": pitch,
                "start_tick": start_tick,
                "end_tick": end_tick,
                "velocity": 90,
                "channel": 0,
            }
        )
        events.extend(
            [
                (start_tick, 1, mido.Message("note_on", channel=0, note=pitch, velocity=90)),
                (end_tick, 0, mido.Message("note_off", channel=0, note=pitch, velocity=0)),
            ]
        )
    events.sort(key=lambda event: (event[0], event[1]))
    track = mido.MidiTrack()
    previous_tick = 0
    for tick, _, message in events:
        message.time = tick - previous_tick
        track.append(message)
        previous_tick = tick
    track.append(mido.MetaMessage("end_of_track", time=0))
    midi.tracks.append(track)
    midi.save(destination)
    return tick_notes


def midi_notes(path: Path) -> list[dict[str, Any]]:
    midi = mido.MidiFile(path)
    notes: list[dict[str, Any]] = []
    for track in midi.tracks:
        tick = 0
        active: dict[tuple[int, int], deque[tuple[int, int]]] = defaultdict(deque)
        for message in track:
            tick += message.time
            if message.type == "note_on" and message.velocity > 0:
                active[(message.channel, message.note)].append((tick, message.velocity))
            elif message.type in {"note_off", "note_on"}:
                pending = active[(message.channel, message.note)]
                if pending:
                    start, velocity = pending.popleft()
                    notes.append(
                        {
                            "pitch": message.note,
                            "start_tick": start,
                            "end_tick": max(start + 1, tick),
                            "velocity": velocity,
                            "channel": message.channel,
                        }
                    )
    return notes


def remove_notes_before_audio_onset(
    notes: list[dict[str, Any]],
    audio_path: Path,
    ticks_per_beat: int,
    tempo: int,
) -> list[dict[str, Any]]:
    import librosa
    import numpy as np

    sample_rate = 22050
    hop_length = 256
    audio, _ = librosa.load(audio_path, sr=sample_rate, mono=True)
    if not len(audio):
        return []

    rms = librosa.feature.rms(y=audio, frame_length=2048, hop_length=hop_length)[0]
    peak = float(np.max(rms, initial=0))
    if peak <= 1e-8:
        return []

    threshold = peak * 0.02
    active_frames = rms > threshold
    consecutive_frames = 3
    onset_frame = next(
        (
            index
            for index in range(max(0, len(active_frames) - consecutive_frames + 1))
            if np.all(active_frames[index:index + consecutive_frames])
        ),
        None,
    )
    if onset_frame is None:
        return []

    onset_seconds = onset_frame * hop_length / sample_rate
    seconds_per_tick = tempo / (ticks_per_beat * 1_000_000)
    return [
        note
        for note in notes
        if note["start_tick"] * seconds_per_tick >= onset_seconds - 0.08
    ]


def write_notes_midi(source: Path, destination: Path, notes: list[dict[str, Any]]) -> None:
    original = mido.MidiFile(source)
    output = mido.MidiFile(type=1, ticks_per_beat=original.ticks_per_beat)
    meta_events: list[tuple[int, mido.MetaMessage]] = []
    for track in original.tracks:
        tick = 0
        for message in track:
            tick += message.time
            if message.is_meta and message.type != "end_of_track":
                meta_events.append((tick, message.copy(time=0)))
    meta_events.sort(key=lambda item: item[0])
    meta_track = mido.MidiTrack()
    previous_tick = 0
    for tick, message in meta_events:
        message.time = tick - previous_tick
        meta_track.append(message)
        previous_tick = tick
    meta_track.append(mido.MetaMessage("end_of_track", time=0))
    output.tracks.append(meta_track)

    events: list[tuple[int, int, mido.Message]] = []
    for note in notes:
        events.append(
            (
                note["start_tick"],
                1,
                mido.Message(
                    "note_on",
                    channel=note["channel"],
                    note=note["pitch"],
                    velocity=note["velocity"],
                    time=0,
                ),
            )
        )
        events.append(
            (
                note["end_tick"],
                0,
                mido.Message(
                    "note_off",
                    channel=note["channel"],
                    note=note["pitch"],
                    velocity=0,
                    time=0,
                ),
            )
        )

    events.sort(key=lambda item: (item[0], item[1]))
    music_track = mido.MidiTrack()
    last_tick = 0
    for tick, _, message in events:
        message.time = tick - last_tick
        music_track.append(message)
        last_tick = tick
    music_track.append(mido.MetaMessage("end_of_track", time=0))
    output.tracks.append(music_track)
    output.save(destination)


def detect_lead_start(
    onset_groups: dict[int, list[dict[str, Any]]],
    ticks_per_beat: int,
) -> int | None:
    return min(lead_phrase_onsets(onset_groups, ticks_per_beat), default=None)


def lead_phrase_onsets(
    onset_groups: dict[int, list[dict[str, Any]]],
    ticks_per_beat: int,
) -> set[int]:
    candidates = [
        (onset, next(iter(pitches)))
        for onset, group in sorted(onset_groups.items())
        if len(pitches := {note["pitch"] for note in group}) == 1
        and next(iter(pitches)) >= 60
    ]
    phrases: list[list[tuple[int, int]]] = []
    current: list[tuple[int, int]] = []
    max_gap = ticks_per_beat * 3

    def is_lead_phrase(phrase: list[tuple[int, int]]) -> bool:
        pitches = {pitch for _, pitch in phrase}
        return (
            len(phrase) >= 6
            and phrase[-1][0] - phrase[0][0] >= ticks_per_beat * 4
            and len(pitches) >= 4
            and sum(pitch for _, pitch in phrase) / len(phrase) >= 64
        )

    for candidate in candidates:
        if current and candidate[0] - current[-1][0] > max_gap:
            if is_lead_phrase(current):
                phrases.append(current)
            current = []
        current.append(candidate)
    if current and is_lead_phrase(current):
        phrases.append(current)
    return {onset for phrase in phrases for onset, _ in phrase}


def split_guitar_midi(
    source: Path,
    job_dir: Path,
) -> tuple[Path, list[dict[str, Any]], int | None]:
    midi = mido.MidiFile(source)
    notes = midi_notes(source)
    onset_groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    onset_window = max(1, round(midi.ticks_per_beat * 0.12))
    for note in notes:
        onset = round(note["start_tick"] / onset_window) * onset_window
        onset_groups[onset].append(note)

    phrase_onsets = lead_phrase_onsets(onset_groups, midi.ticks_per_beat)
    lead: list[dict[str, Any]] = []
    for onset, group in sorted(onset_groups.items()):
        if onset in phrase_onsets:
            lead.extend(group)

    lead_start_tick = min((note["start_tick"] for note in lead), default=None)
    lead_path = job_dir / "guitar_lead.mid"
    write_notes_midi(source, lead_path, lead)
    return lead_path, notes, lead_start_tick


def midi_tempo(midi: mido.MidiFile) -> int:
    for track in midi.tracks:
        for message in track:
            if message.type == "set_tempo":
                return message.tempo
    return 500_000


def midi_visual_events(path: Path) -> list[dict[str, float | int]]:
    midi = mido.MidiFile(path)
    seconds_per_tick = midi_tempo(midi) / (midi.ticks_per_beat * 1_000_000)
    return [
        {
            "pitch": note["pitch"],
            "start": round(note["start_tick"] * seconds_per_tick, 3),
            "duration": round(
                (note["end_tick"] - note["start_tick"]) * seconds_per_tick,
                3,
            ),
        }
        for note in midi_notes(path)
    ]


def write_guitar_tab(
    notes: list[dict[str, Any]],
    destination: Path,
    ticks_per_beat: int,
    chords: list[dict[str, Any]],
) -> None:
    tunings = (40, 45, 50, 55, 59, 64)
    string_names = ("E", "A", "D", "G", "B", "e")
    fret_limit = 24
    positions: list[list[tuple[int, int]]] = [[] for _ in tunings]
    for note in sorted(notes, key=lambda item: item["start_tick"]):
        candidates = [
            (note["pitch"] - tuning, index)
            for index, tuning in enumerate(tunings)
            if 0 <= note["pitch"] - tuning <= fret_limit
        ]
        if not candidates:
            continue
        fret, string_index = min(candidates, key=lambda option: option[0])
        beat = max(0, round(note["start_tick"] / max(1, ticks_per_beat)))
        positions[string_index].append((beat, fret))

    last_beat = max((beat for row in positions for beat, _ in row), default=0)
    column_count = min(max(last_beat + 1, 8), 512)
    lines = ["Chordcraft draft tablature", "Standard tuning: E A D G B e"]
    if chords:
        chord_labels = " | ".join(
            f"{int(chord['time'] // 60)}:{int(chord['time'] % 60):02d} {chord['name']}"
            for chord in chords
        )
        lines.append(f"Estimated chords: {chord_labels}")
    lines.append("")
    for name, row in zip(string_names, positions, strict=True):
        cells = ["--" for _ in range(column_count)]
        for beat, fret in row:
            if beat < column_count:
                cells[beat] = str(fret) if fret < 10 else f"{fret}"
        lines.append(f"{name}|-" + "-".join(cells) + "-|")
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")


def chord_timeline(
    notes: list[dict[str, Any]],
    ticks_per_beat: int,
    tempo: int,
    style: str = "song",
) -> list[dict[str, Any]]:
    bins: dict[int, Counter[int]] = defaultdict(Counter)
    ticks_per_window = max(1, ticks_per_beat * 2)
    for note in notes:
        start = max(0, note["start_tick"])
        end = max(start + 1, note["end_tick"])
        first_window = start // ticks_per_window
        last_window = (end - 1) // ticks_per_window
        for window_index in range(first_window, last_window + 1):
            window_start = window_index * ticks_per_window
            overlap = min(end, window_start + ticks_per_window) - max(
                start, window_start
            )
            if overlap > 0:
                bins[window_index][note["pitch"] % 12] += overlap * max(
                    1, note.get("velocity", 1)
                )

    chord_types = (
        ("", (0, 4, 7)),
        ("m", (0, 3, 7)),
        ("dim", (0, 3, 6)),
        ("aug", (0, 4, 8)),
        ("sus2", (0, 2, 7)),
        ("sus4", (0, 5, 7)),
        ("7", (0, 4, 7, 10)),
        ("maj7", (0, 4, 7, 11)),
        ("m7", (0, 3, 7, 10)),
        ("mMaj7", (0, 3, 7, 11)),
        ("dim7", (0, 3, 6, 9)),
        ("m7b5", (0, 3, 6, 10)),
        ("6", (0, 4, 7, 9)),
        ("m6", (0, 3, 7, 9)),
        ("add9", (0, 2, 4, 7)),
        ("9", (0, 2, 4, 7, 10)),
        ("5", (0, 7)),
    )
    if style == "basic":
        chord_types = (("", (0, 4, 7)), ("m", (0, 3, 7)), ("5", (0, 7)))
    timeline: list[dict[str, Any]] = []
    for bin_index, pitch_weights in sorted(bins.items()):
        if len(pitch_weights) < 2:
            continue
        total_weight = sum(pitch_weights.values())
        best_chord: str | None = None
        best_score = float("-inf")
        for root in range(12):
            for suffix, intervals in chord_types:
                if len(pitch_weights) < 3 and suffix != "5":
                    continue
                chord_tones = {(root + interval) % 12 for interval in intervals}
                matched_weight = sum(
                    weight
                    for pitch, weight in pitch_weights.items()
                    if pitch in chord_tones
                )
                coverage = matched_weight / total_weight
                root_weight = pitch_weights[root] / total_weight
                score = coverage + root_weight * 0.12 - (len(intervals) - 3) * 0.025
                if score > best_score:
                    best_score = score
                    best_chord = f"{PITCH_NAMES[root]}{suffix}"
        threshold = 0.74 if style == "basic" else 0.68
        if best_chord and best_score >= threshold:
            time_seconds = bin_index * 2 * tempo / 1_000_000
            if timeline and timeline[-1]["name"] == best_chord:
                continue
            timeline.append({"name": best_chord, "time": time_seconds})

    if style == "song":
        for index in range(1, len(timeline) - 1):
            if timeline[index - 1]["name"] == timeline[index + 1]["name"]:
                timeline[index]["name"] = timeline[index - 1]["name"]
        timeline = [
            chord
            for index, chord in enumerate(timeline)
            if index == 0 or chord["name"] != timeline[index - 1]["name"]
        ]
    return timeline


def find_midi(output_dir: Path) -> Path:
    candidates = sorted(output_dir.glob("*.mid")) + sorted(output_dir.glob("*.midi"))
    if not candidates:
        raise HTTPException(
            status_code=500,
            detail="Basic Pitch did not create a MIDI file. Check the engine logs.",
        )
    return candidates[0]


@app.get("/api/health")
def health() -> dict[str, Any]:
    demucs_ready = resolve_command("demucs") is not None
    basic_pitch_ready = resolve_command("basic-pitch") is not None
    ffmpeg_ready = resolve_command("ffmpeg") is not None
    ffprobe_ready = resolve_command("ffprobe") is not None
    onnx_ready = find_spec("onnxruntime") is not None
    solola_ready = find_spec("librosa") is not None
    engine_ready = (
        demucs_ready
        and basic_pitch_ready
        and ffmpeg_ready
        and ffprobe_ready
        and onnx_ready
    )
    access_required = password_required()
    access_configured = (
        len(os.environ.get("CHORDCRAFT_ACCESS_PASSWORD", "")) >= 16
        if access_required
        else True
    )
    ready = engine_ready and access_configured
    missing = []
    if not demucs_ready:
        missing.append("Demucs")
    if not basic_pitch_ready:
        missing.append("Basic Pitch")
    if not ffmpeg_ready:
        missing.append("FFmpeg")
    if not ffprobe_ready:
        missing.append("FFprobe")
    if not onnx_ready:
        missing.append("ONNX Runtime")
    if not access_configured:
        missing.append("a server access password (at least 16 characters)")
    return {
        "ready": ready,
        "message": "Analysis engine and server access are ready."
        if ready
        else f"Server setup is incomplete: {', '.join(missing)}.",
        "password_required": access_required,
        "access_configured": access_configured,
        "solola_compatible_ready": solola_ready,
        "solola_compatible_message": "SoloLa-style pitch extraction is available in this engine."
        if solola_ready
        else "Install the engine requirements to enable librosa-based pitch extraction.",
        "components": {
            "demucs": demucs_ready,
            "basic_pitch": basic_pitch_ready,
            "ffmpeg": ffmpeg_ready,
            "ffprobe": ffprobe_ready,
            "onnx_runtime": onnx_ready,
            "solola_compatible": solola_ready,
        },
    }


@app.post("/api/auth/verify")
def verify_shared_password() -> dict[str, bool]:
    return {"ready": True}


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    parts: str = Form("all"),
    chord_style: str = Form("song"),
    lead_engine: str = Form("basic_pitch"),
) -> dict[str, Any]:
    available_parts = {"vocals", "piano", "guitar_chords", "guitar_lead", "bass"}
    selected_parts = available_parts if parts == "all" else set(parts.split(","))
    if not selected_parts or not selected_parts.issubset(available_parts):
        raise HTTPException(status_code=400, detail="Choose at least one supported song part.")
    if chord_style not in {"basic", "song", "complex"}:
        raise HTTPException(status_code=400, detail="Choose a supported chord style.")
    if lead_engine not in {"basic_pitch", "solola_compatible"}:
        raise HTTPException(status_code=400, detail="Choose a supported guitar lead engine.")
    if lead_engine == "solola_compatible" and "guitar_lead" not in selected_parts:
        raise HTTPException(
            status_code=400,
            detail="Select Guitar lead to use the SoloLa engine.",
        )
    extension = Path(file.filename or "").suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Unsupported audio format.")
    demucs_command = resolve_command("demucs")
    basic_pitch_command = resolve_command("basic-pitch")
    needs_transcription = bool(
        {"piano", "guitar_chords"} & selected_parts
        or ("guitar_lead" in selected_parts and lead_engine == "basic_pitch")
    )
    if demucs_command is None or (needs_transcription and basic_pitch_command is None):
        raise HTTPException(
            status_code=503,
            detail="Install the local engine requirements before analyzing audio.",
        )

    job_id = uuid.uuid4().hex
    job_dir = JOBS_DIR / job_id
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_expired_jobs()
    job_dir.mkdir(parents=True, exist_ok=False)
    source_path = job_dir / f"source{extension}"
    total_bytes = 0
    try:
        with source_path.open("wb") as target:
            while chunk := await file.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="The maximum file size is 150 MB.")
                target.write(chunk)
    finally:
        await file.close()

    if total_bytes == 0:
        raise HTTPException(status_code=400, detail="The uploaded audio file is empty.")

    stems_dir = job_dir / "stems"
    stems_dir.mkdir()
    await run_command_async(
        [
            demucs_command,
            "-n",
            "htdemucs_6s",
            "--out",
            str(stems_dir),
            "--mp3",
            str(source_path),
        ],
        timeout=60 * 60,
        step="Instrument separation",
    )
    separated_dir = stems_dir / "htdemucs_6s" / source_path.stem
    if not separated_dir.is_dir():
        raise HTTPException(status_code=500, detail="The separator did not produce its expected stems.")

    files: list[dict[str, str]] = []
    requested_stems = set()
    if "piano" in selected_parts:
        requested_stems.add("piano")
    if {"guitar_chords", "guitar_lead"} & selected_parts:
        requested_stems.add("guitar")
    if "bass" in selected_parts:
        requested_stems.add("bass")
    if "vocals" in selected_parts:
        requested_stems.add("vocals")
    for stem in ("piano", "guitar", "bass", "vocals"):
        if stem not in requested_stems:
            continue
        stem_path = separated_dir / f"{stem}.mp3"
        if stem_path.is_file():
            saved_stem = job_dir / f"{stem}.wav"
            ffmpeg_command = resolve_command("ffmpeg")
            if ffmpeg_command is None:
                raise HTTPException(
                    status_code=503,
                    detail="FFmpeg is required to prepare separated tracks.",
                )
            await run_command_async(
                [
                    ffmpeg_command,
                    "-y",
                    "-i",
                    str(stem_path),
                    "-vn",
                    "-c:a",
                    "pcm_s16le",
                    str(saved_stem),
                ],
                timeout=60 * 5,
                step=f"Preparing {stem} stem",
            )
            files.append(
                {
                    "label": stem.capitalize(),
                    "kind": "audio",
                    "url": f"/api/jobs/{job_id}/files/{saved_stem.name}",
                }
            )

    midi_dir = job_dir / "transcription"
    midi_dir.mkdir()
    piano_note_count = 0
    guitar_note_count = 0
    visual_tracks: dict[str, list[dict[str, float | int]]] = {
        "piano": [],
        "guitar_lead": [],
    }
    guitar_lead_start_seconds: float | None = None
    guitar_chord_notes: list[dict[str, Any]] = []
    piano_chord_notes: list[dict[str, Any]] = []
    guitar_ticks_per_beat = 480
    guitar_tempo = 500_000
    piano_ticks_per_beat = 480
    piano_tempo = 500_000
    guitar_tab_notes: list[dict[str, Any]] = []
    guitar_tab_path: Path | None = None
    guitar_tab_ticks_per_beat = 480
    tempo_bpm = 120
    piano_stem = job_dir / "piano.wav"
    guitar_stem = job_dir / "guitar.wav"
    for stem_path in (piano_stem, guitar_stem):
        if not stem_path.is_file():
            continue
        if stem_path.stem == "guitar" and lead_engine == "solola_compatible" and "guitar_chords" not in selected_parts:
            continue
        if basic_pitch_command is None:
            raise HTTPException(
                status_code=503,
                detail="Basic Pitch is required to transcribe the selected song parts.",
            )
        stem_output = midi_dir / stem_path.stem
        stem_output.mkdir()
        await run_command_async(
            [
                basic_pitch_command,
                "--model-serialization",
                "onnx",
                str(stem_output),
                str(stem_path),
            ],
            timeout=60 * 30,
            step=f"{stem_path.stem.capitalize()} transcription",
        )
        generated_midi = find_midi(stem_output)
        saved_midi = job_dir / f"{stem_path.stem}.mid"
        shutil.copy2(generated_midi, saved_midi)
        notes = midi_notes(saved_midi)

        if stem_path.stem == "piano":
            piano_midi = mido.MidiFile(saved_midi)
            piano_ticks_per_beat = piano_midi.ticks_per_beat
            piano_tempo = midi_tempo(piano_midi)
            notes = remove_notes_before_audio_onset(
                notes,
                stem_path,
                piano_ticks_per_beat,
                piano_tempo,
            )
            write_notes_midi(saved_midi, saved_midi, notes)
            piano_chord_notes = notes
            piano_note_count = len(notes)
            visual_tracks["piano"] = midi_visual_events(saved_midi)
            tempo_bpm = round(60_000_000 / piano_tempo)
            files.append(
                {
                    "label": "Piano MIDI",
                    "kind": "midi",
                    "url": f"/api/jobs/{job_id}/files/{saved_midi.name}",
                }
            )
        elif stem_path.stem == "guitar":
            guitar_note_count = len(notes)
            source_midi = mido.MidiFile(saved_midi)
            guitar_ticks_per_beat = source_midi.ticks_per_beat
            guitar_tempo = midi_tempo(source_midi)
            tempo_bpm = round(60_000_000 / midi_tempo(source_midi))
            if "guitar_chords" in selected_parts:
                guitar_chord_notes = notes
            if "guitar_lead" in selected_parts and lead_engine == "basic_pitch":
                lead_path, _, lead_start_tick = split_guitar_midi(saved_midi, job_dir)
                guitar_tab_notes = midi_notes(lead_path)
                guitar_tab_ticks_per_beat = source_midi.ticks_per_beat
                guitar_tab_path = job_dir / "guitar_tab.txt"
                visual_tracks["guitar_lead"] = midi_visual_events(lead_path)
                if lead_start_tick is not None:
                    seconds_per_tick = midi_tempo(source_midi) / (
                        source_midi.ticks_per_beat * 1_000_000
                    )
                    guitar_lead_start_seconds = round(
                        lead_start_tick * seconds_per_tick,
                        2,
                    )
                files.append(
                    {
                        "label": "Guitar MIDI",
                        "kind": "midi",
                        "url": f"/api/jobs/{job_id}/files/{lead_path.name}",
                    }
                )

    if "guitar_lead" in selected_parts and lead_engine == "solola_compatible":
        if not guitar_stem.is_file():
            raise HTTPException(
                status_code=422,
                detail="Demucs did not return a guitar stem for SoloLa to analyze.",
            )
        lead_notes = await asyncio.to_thread(solola_compatible_lead_notes, guitar_stem)
        guitar_tab_path = job_dir / "guitar_tab.txt"
        lead_midi_path = job_dir / "guitar_lead.mid"
        guitar_tab_ticks_per_beat = 480
        guitar_tab_notes = write_visual_notes_midi(
            lead_notes,
            lead_midi_path,
            guitar_tab_ticks_per_beat,
            500_000,
        )
        visual_tracks["guitar_lead"] = midi_visual_events(lead_midi_path)
        guitar_lead_start_seconds = round(
            min(float(note["start"]) for note in lead_notes),
            2,
        )
        guitar_note_count = len(lead_notes)
        files.append(
            {
                "label": "Guitar MIDI",
                "kind": "midi",
                "url": f"/api/jobs/{job_id}/files/{lead_midi_path.name}",
            }
        )

    duration_seconds = 0.0
    for stem_path in (piano_stem, guitar_stem, job_dir / "bass.wav", job_dir / "vocals.wav"):
        if stem_path.is_file():
            with wave.open(str(stem_path), "rb") as audio_file:
                duration_seconds = audio_file.getnframes() / audio_file.getframerate()
            break
    chords = []
    chord_source = None
    if "guitar_chords" in selected_parts:
        chords = chord_timeline(
            guitar_chord_notes,
            guitar_ticks_per_beat,
            guitar_tempo,
            chord_style,
        )
        if chords:
            chord_source = "guitar"
        elif "piano" in selected_parts:
            chords = chord_timeline(
                piano_chord_notes,
                piano_ticks_per_beat,
                piano_tempo,
                chord_style,
            )
            if chords:
                chord_source = "piano"
    if guitar_tab_path is not None:
        write_guitar_tab(
            guitar_tab_notes,
            guitar_tab_path,
            guitar_tab_ticks_per_beat,
            chords,
        )
        files.append(
            {
                "label": "Guitar TAB",
                "kind": "tab",
                "url": f"/api/jobs/{job_id}/files/{guitar_tab_path.name}",
            }
        )
    warnings = [
        "Automatic transcriptions are drafts and may need musical correction.",
        "Chord labels use the separated guitar stem first, with the piano stem as a fallback; the lead tab is filtered to monophonic melody candidates and may omit or misclassify notes.",
    ]
    return {
        "id": job_id,
        "duration_seconds": duration_seconds,
        "chords": chords,
        "chord_source": chord_source,
        "selected_parts": sorted(selected_parts),
        "lead_engine": lead_engine,
        "files": files,
        "notes": {"piano": piano_note_count, "guitar": guitar_note_count},
        "visual_tracks": visual_tracks,
        "guitar_lead_start_seconds": guitar_lead_start_seconds,
        "tempo_bpm": tempo_bpm,
        "warnings": warnings,
    }


@app.get("/api/jobs/{job_id}/files/{filename}")
def download_file(job_id: str, filename: str) -> FileResponse:
    path = safe_job_file(job_id, filename)
    media_type = "audio/wav" if path.suffix == ".wav" else "application/octet-stream"
    return FileResponse(path, filename=path.name, media_type=media_type)


@app.get("/")
def root():
    index = WEB_DIR / "index.html"
    if index.is_file():
        return FileResponse(index)
    return {
        "service": "Chordcraft local engine",
        "health": "/api/health",
        "docs": "/docs",
    }


@app.head("/")
def root_health_check() -> Response:
    return Response(status_code=200)


@app.get("/{frontend_path:path}")
def frontend(frontend_path: str) -> FileResponse:
    if frontend_path == "api" or frontend_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found.")
    requested_file = (WEB_DIR / frontend_path).resolve()
    if requested_file.is_relative_to(WEB_DIR) and requested_file.is_file():
        return FileResponse(requested_file)
    index = WEB_DIR / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(status_code=404, detail="Not found.")
