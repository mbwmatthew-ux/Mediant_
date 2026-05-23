"""
Mediant Python Worker — Modal.com deployment.

Handles two tasks:
  1. Audio transcription via CREPE (neural pitch detection, sub-semitone accuracy)
  2. Beat tracking via librosa
  3. MusicXML parsing via music21 (when a structured score is provided)

Exposes a single HTTPS endpoint:
  POST /analyze
  Body: {
    video_url: str,          # signed URL to download video/audio from
    score_url?: str,         # signed URL for MusicXML/MIDI score (optional)
    score_mime?: str,        # "application/vnd.recordare.musicxml+xml", "audio/midi", etc.
    instrument: str,
    start_measure: int,
    time_sig?: str,          # e.g. "4/4", "12/8" — hint only; music21 reads from score
  }
  Response: {
    audio: AudioResult,
    score?: ScoreResult,     # only if score_url was provided and parsed successfully
    beats: BeatResult,
    error?: str
  }
"""

import modal

app = modal.App("mediant-worker")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "curl",
        "ca-certificates",
        "ffmpeg",
        "libsndfile1",
        "libxtst6",
    )
    .run_commands(
        # Audiveris converts visual scores (PDF/images) into MusicXML/MXL.
        "curl -L -o /tmp/audiveris.deb https://github.com/Audiveris/audiveris/releases/download/5.10.2/Audiveris-5.10.2-ubuntu22.04-x86_64.deb && dpkg-deb -x /tmp/audiveris.deb / && if [ -x /opt/audiveris/bin/Audiveris ]; then ln -sf /opt/audiveris/bin/Audiveris /usr/local/bin/audiveris; elif [ -x /opt/audiveris/bin/audiveris ]; then ln -sf /opt/audiveris/bin/audiveris /usr/local/bin/audiveris; else find /opt -iname '*audiveris*' -maxdepth 4; exit 1; fi && audiveris -version && rm /tmp/audiveris.deb",
        # Install torch + torchaudio CPU-only together so torchaudio doesn't pull CUDA libs
        "pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu",
        "pip install torchcrepe",
    )
    .pip_install(
        # Audio processing
        "librosa==0.10.2",
        "soundfile==0.12.1",
        "numpy>=1.24,<2.0",
        "scipy>=1.10",
        # Score parsing
        "music21==9.1.0",
        # Utilities
        "fastapi[standard]",
        "requests==2.31.0",
        "httpx==0.27.0",
        # AI SDKs (used in async full-pipeline)
        "anthropic>=0.30.0",
    )
)

# ── Data types (dicts — no dataclasses so JSON-serializable naturally) ────────

MIDI_TO_NAME = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"
]

VISUAL_SCORE_EXTENSIONS = (".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff")
VISUAL_SCORE_MIMES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/tiff",
    "image/heic",
    "image/heif",
}

def midi_to_scientific(midi: int) -> str:
    octave = (midi // 12) - 1
    name = MIDI_TO_NAME[midi % 12]
    return f"{name}{octave}"


def is_musicxml_score(score_mime: str, score_url: str) -> bool:
    score_mime_lower = (score_mime or "").lower()
    score_url_lower = (score_url or "").lower().split("?")[0]
    return (
        "musicxml" in score_mime_lower
        or "xml" in score_mime_lower
        or score_url_lower.endswith(".xml")
        or score_url_lower.endswith(".musicxml")
        or score_url_lower.endswith(".mxl")
    )


def is_visual_score(score_mime: str, score_url: str) -> bool:
    score_mime_lower = (score_mime or "").lower()
    score_url_lower = (score_url or "").lower().split("?")[0]
    return score_mime_lower in VISUAL_SCORE_MIMES or score_url_lower.endswith(VISUAL_SCORE_EXTENSIONS)


def sniff_score_kind(score_bytes: bytes, score_mime: str, score_url: str) -> str:
    """Classify score bytes as mxl, xml, visual, or unknown."""
    head = score_bytes[:64].lstrip()
    mime = (score_mime or "").lower()
    url = (score_url or "").lower().split("?")[0]
    if score_bytes[:4] == b"PK\x03\x04" or url.endswith(".mxl"):
        return "mxl"
    if head.startswith(b"<?xml") or head.startswith(b"<score-partwise") or head.startswith(b"<score-timewise"):
        return "xml"
    if is_musicxml_score(mime, url):
        return "xml"
    if head.startswith(b"%PDF"):
        return "visual"
    if score_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "visual"
    if score_bytes[:3] == b"\xff\xd8\xff":
        return "visual"
    if score_bytes[:4] in (b"II*\x00", b"MM\x00*"):
        return "visual"
    if is_visual_score(mime, url):
        return "visual"
    return "unknown"


def score_suffix(score_bytes: bytes, score_mime: str, score_url: str) -> str:
    mime = (score_mime or "").lower()
    url = (score_url or "").lower().split("?")[0]
    if score_bytes[:4] == b"PK\x03\x04" or url.endswith(".mxl"):
        return ".mxl"
    if score_bytes[:64].lstrip().startswith(b"<?xml") or url.endswith((".xml", ".musicxml")):
        return ".musicxml"
    if score_bytes.startswith(b"%PDF") or "pdf" in mime or url.endswith(".pdf"):
        return ".pdf"
    if score_bytes.startswith(b"\x89PNG\r\n\x1a\n") or "png" in mime or url.endswith(".png"):
        return ".png"
    if score_bytes[:3] == b"\xff\xd8\xff" or "jpeg" in mime or "jpg" in mime or url.endswith((".jpg", ".jpeg")):
        return ".jpg"
    if "webp" in mime or url.endswith(".webp"):
        return ".webp"
    if "tiff" in mime or url.endswith((".tif", ".tiff")):
        return ".tif"
    return ".score"

# ── Core functions ─────────────────────────────────────────────────────────

def extract_audio_from_video(video_bytes: bytes, target_sr: int = 22050) -> tuple[bytes, float]:
    """Use FFmpeg to extract mono 22050 Hz WAV from any video/audio container."""
    import subprocess, tempfile, os

    with tempfile.NamedTemporaryFile(suffix=".input", delete=False) as inf:
        inf.write(video_bytes)
        in_path = inf.name

    out_path = in_path + ".wav"
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-i", in_path,
                "-vn",                 # no video
                "-acodec", "pcm_s16le",
                "-ar", str(target_sr),
                "-ac", "1",            # mono
                out_path,
            ],
            capture_output=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg failed: {result.stderr.decode()[:500]}")

        with open(out_path, "rb") as f:
            wav_bytes = f.read()

        # Get duration from stderr output
        stderr = result.stderr.decode()
        duration = 0.0
        for line in stderr.split("\n"):
            if "Duration:" in line:
                parts = line.split("Duration:")[1].split(",")[0].strip()
                h, m, s = parts.split(":")
                duration = float(h) * 3600 + float(m) * 60 + float(s)
                break

        return wav_bytes, duration
    finally:
        os.unlink(in_path)
        if os.path.exists(out_path):
            os.unlink(out_path)


def _dedupe_times(times: list[float], min_separation: float = 0.05) -> list[float]:
    if not times:
        return []
    times = sorted(float(t) for t in times)
    deduped = [times[0]]
    for t in times[1:]:
        if t - deduped[-1] >= min_separation:
            deduped.append(t)
    return deduped


def run_pitch_tracking(wav_bytes: bytes, guide_times: list[float] | None = None) -> list[dict]:
    """
    Detect note events using CREPE (neural pitch tracking) + librosa onset detection.

    CREPE gives sub-semitone accuracy in Hz; we compute cents_offset (-50..+50)
    from the nearest MIDI semitone so the coaching layer can say "32 cents sharp".

    Strategy:
      1. Resample to 16 kHz (CREPE's expected sample rate)
      2. torchcrepe.predict → per-frame (Hz, periodicity/confidence) at 10 ms resolution
      3. librosa onset detection + beat-guided candidate times
      4. detect voiced segments so sustained or soft notes are not skipped
      5. For each candidate window, weighted-average the confident CREPE frames
      6. Emit denser events, not just one event per onset
    """
    import tempfile, os, math
    import numpy as np
    import librosa
    import torch
    import torchcrepe

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav_bytes)
        wav_path = f.name

    try:
        SR = 22050
        HOP = 512         # librosa hop for onset detection

        y, _ = librosa.load(wav_path, sr=SR, mono=True)
        duration = librosa.get_duration(y=y, sr=SR)

        # ── CREPE pitch tracking ───────────────────────────────────────────
        CREPE_SR  = 16000
        CREPE_HOP = 640   # 40 ms frames — halves CREPE processing time; still fine-grained for measure-level coaching

        y16 = librosa.resample(y, orig_sr=SR, target_sr=CREPE_SR)
        audio_tensor = torch.from_numpy(y16).unsqueeze(0).float()  # (1, N)

        # Dense event sampling already improved coverage substantially. Use the
        # supported lightweight CREPE model here so ~1 minute takes finish reliably in
        # production instead of timing out mid-analysis.
        pitch, periodicity = torchcrepe.predict(
            audio_tensor,
            CREPE_SR,
            CREPE_HOP,
            fmin=32.70,    # C1 — well below cello low C
            fmax=2093.0,   # C7 — covers violin high E
            model="tiny",
            batch_size=256,
            device="cpu",
            decoder=torchcrepe.decode.weighted_argmax,
            return_periodicity=True,
            pad=True,
        )
        pitch_np = pitch.squeeze().numpy()        # (T,) in Hz
        conf_np  = periodicity.squeeze().numpy()  # (T,) confidence 0–1
        n_frames = len(pitch_np)
        frame_times = np.arange(n_frames) * (CREPE_HOP / CREPE_SR)  # seconds

        # ── Onset detection (at original SR for better temporal resolution) ──
        onset_frames = librosa.onset.onset_detect(
            y=y, sr=SR, hop_length=HOP,
            backtrack=True,
            units="frames",
        )
        onset_times = librosa.frames_to_time(onset_frames, sr=SR, hop_length=HOP).tolist()
        if not onset_times:
            onset_times = np.arange(0, duration, 0.5).tolist()

        # Candidate windows should be denser than pure onset detection.
        # We also use beat guide times and voiced-segment coverage so quieter or
        # sustained passages don't disappear just because onset detection missed them.
        candidate_times: list[float] = list(onset_times)
        if guide_times:
            candidate_times.extend(guide_times)
            for i in range(len(guide_times) - 1):
                gap = guide_times[i + 1] - guide_times[i]
                if gap >= 0.45:
                    candidate_times.append((guide_times[i] + guide_times[i + 1]) / 2)

        CONF_THRESHOLD = 0.45  # periodicity threshold — higher = fewer false positives
        voiced_mask = (conf_np >= 0.30) & (pitch_np > 0)

        voiced_segments: list[tuple[float, float]] = []
        seg_start = None
        for idx, voiced in enumerate(voiced_mask):
            if voiced and seg_start is None:
                seg_start = frame_times[idx]
            elif not voiced and seg_start is not None:
                seg_end = frame_times[max(0, idx - 1)]
                if seg_end - seg_start >= 0.08:
                    voiced_segments.append((float(seg_start), float(seg_end)))
                seg_start = None
        if seg_start is not None:
            seg_end = frame_times[len(frame_times) - 1]
            if seg_end - seg_start >= 0.08:
                voiced_segments.append((float(seg_start), float(seg_end)))

        for seg_start, seg_end in voiced_segments:
            if not any((seg_start - 0.03) <= t <= (seg_end + 0.03) for t in candidate_times):
                candidate_times.append(seg_start)
            probe = seg_start + 0.35
            while probe < seg_end - 0.10:
                candidate_times.append(probe)
                probe += 0.35

        candidate_times = _dedupe_times(
            [t for t in candidate_times if 0 <= t <= max(duration, frame_times[-1] if len(frame_times) else 0)],
            min_separation=0.05,
        )

        events: list[dict] = []
        for i, event_t in enumerate(candidate_times):
            next_t = candidate_times[i + 1] if i + 1 < len(candidate_times) else event_t + 0.35
            window_start = max(0.0, event_t - 0.03)
            window_end = min(event_t + 0.18, next_t - 0.01, duration + 0.01)
            if window_end <= window_start:
                window_end = min(event_t + 0.10, duration + 0.01)

            mask = (frame_times >= window_start) & (frame_times < window_end) & (conf_np >= CONF_THRESHOLD)
            if not mask.any():
                # Widen window and lower threshold once
                mask = (
                    (frame_times >= max(0.0, event_t - 0.05))
                    & (frame_times < min(event_t + 0.28, next_t, duration + 0.01))
                    & (conf_np >= 0.25)
                )
            if not mask.any():
                continue

            window_hz   = pitch_np[mask]
            window_conf = conf_np[mask]
            valid = window_hz > 0
            if not valid.any():
                continue

            dominant_hz = float(np.average(window_hz[valid], weights=window_conf[valid] + 1e-6))

            # Convert Hz → MIDI float → nearest semitone + cents offset
            midi_float  = 12.0 * math.log2(dominant_hz / 440.0) + 69.0
            midi        = int(round(midi_float))
            midi        = max(36, min(96, midi))        # C2–C7
            cents_offset = round((midi_float - midi) * 100)  # -50..+50 ¢

            # RMS-based loudness
            s   = int(event_t * SR)
            e   = min(len(y), s + SR // 10)
            rms = float(np.sqrt(np.mean(y[s:e] ** 2))) if e > s else 0.0
            loudness = "loud" if rms > 0.15 else "medium" if rms > 0.04 else "soft"

            confidence = int(min(100, float(np.mean(window_conf)) * 100))

            events.append({
                "time_sec":    float(event_t),
                "end_sec":     float(next_t),
                "pitches":     [midi_to_scientific(midi)],
                "midi":        midi,
                "pitch_hz":    round(dominant_hz, 2),
                "cents_offset": cents_offset,
                "confidence":  confidence,
                "loudness":    loudness,
                "source":      "crepe+librosa+dense",
            })

        events.sort(key=lambda e: e["time_sec"])
        print(
            f"[pitch_tracking] {len(onset_times)} onsets, "
            f"{len(voiced_segments)} voiced segments, {len(candidate_times)} candidates "
            f"→ {len(events)} voiced events (CREPE), duration={duration:.1f}s"
        )
        return events

    finally:
        os.unlink(wav_path)


def run_beat_tracking(wav_bytes: bytes, estimated_bpm: float | None = None) -> dict:
    """
    Track beats using librosa.
    Returns beat times and tempo estimate.
    """
    import tempfile, os
    import librosa
    import numpy as np

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav_bytes)
        wav_path = f.name

    try:
        y, sr = librosa.load(wav_path, sr=22050, mono=True)
        duration = librosa.get_duration(y=y, sr=sr)

        start_bpm = estimated_bpm if estimated_bpm and 30 <= estimated_bpm <= 300 else 120.0

        tempo, beat_frames = librosa.beat.beat_track(
            y=y, sr=sr,
            start_bpm=start_bpm,
            tightness=100,
        )
        beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()

        onset_frames = librosa.onset.onset_detect(y=y, sr=sr, backtrack=True)
        onset_times = librosa.frames_to_time(onset_frames, sr=sr).tolist()

        print(f"[beat_tracking] tempo={float(tempo):.1f} bpm, {len(beat_times)} beats, {len(onset_times)} onsets, duration={duration:.1f}s")

        return {
            "tempo_bpm": float(tempo),
            "beat_times": beat_times,
            "onset_times": onset_times,
            "duration_sec": float(duration),
        }
    finally:
        os.unlink(wav_path)


def parse_musicxml(score_bytes: bytes, start_measure: int) -> dict:
    """
    Parse MusicXML with music21 into structured score data.
    Returns ScoreResult dict.
    """
    import tempfile, os
    import music21 as m21

    with tempfile.NamedTemporaryFile(suffix=".musicxml", delete=False) as f:
        f.write(score_bytes)
        xml_path = f.name

    try:
        score = m21.converter.parse(xml_path)

        parts = score.parts
        if not parts:
            return {"error": "no parts found in score"}

        source_part = next((p for p in parts if len(p.flatten().notes) > 0), parts[0])
        part = source_part.flatten()

        key_sig = None
        time_sig_str = None
        tempo_marking = None

        for el in part.recurse():
            if isinstance(el, m21.key.Key) and key_sig is None:
                key_sig = str(el)
            elif isinstance(el, m21.key.KeySignature) and key_sig is None:
                key_sig = el.asKey().name
            elif isinstance(el, m21.meter.TimeSignature) and time_sig_str is None:
                time_sig_str = el.ratioString
            elif isinstance(el, m21.tempo.MetronomeMark) and tempo_marking is None:
                tempo_marking = str(el)

        measures_out = []
        measure_elements = source_part.getElementsByClass(m21.stream.Measure)

        for i, m in enumerate(measure_elements):
            measure_num = m.number if m.number is not None else (start_measure + i)
            notes_out = []

            for el in m.flatten().notesAndRests:
                if isinstance(el, m21.note.Rest):
                    # Rests are intentionally ignored in this version. False
                    # rest detection creates bad coaching, and sounded-note
                    # feedback is the trustworthy core of the product.
                    continue
                elif isinstance(el, m21.note.Note):
                    artic = None
                    if el.articulations:
                        a = el.articulations[0]
                        if isinstance(a, m21.articulations.Staccato): artic = "staccato"
                        elif isinstance(a, m21.articulations.Tenuto): artic = "tenuto"
                        elif isinstance(a, m21.articulations.Accent): artic = "accent"

                    notes_out.append({
                        "pitch": el.pitch.nameWithOctave,
                        "beat": float(el.beat),
                        "duration_beats": float(el.duration.quarterLength),
                        "articulation": artic,
                        "dynamic": None,
                    })
                elif isinstance(el, m21.chord.Chord):
                    for n in el.notes:
                        notes_out.append({
                            "pitch": n.pitch.nameWithOctave,
                            "beat": float(el.beat),
                            "duration_beats": float(el.duration.quarterLength),
                            "articulation": None,
                            "dynamic": None,
                        })

            measures_out.append({
                "number": measure_num,
                "notes": notes_out,
            })

        print(f"[parse_musicxml] {len(measures_out)} measures, key={key_sig}, time={time_sig_str}")
        return {
            "key_signature": key_sig,
            "time_signature": time_sig_str,
            "tempo_marking": tempo_marking,
            "measures": measures_out,
            "source": "music21",
        }

    except Exception as e:
        print(f"[parse_musicxml] error: {e}")
        return {"error": str(e), "measures": []}
    finally:
        os.unlink(xml_path)


def extract_musicxml_from_mxl(mxl_bytes: bytes) -> bytes | None:
    import zipfile, io

    with zipfile.ZipFile(io.BytesIO(mxl_bytes)) as zf:
        xml_files = [
            name for name in zf.namelist()
            if name.lower().endswith((".xml", ".musicxml")) and "meta-inf" not in name.lower()
        ]
        if not xml_files:
            return None
        xml_files.sort(key=lambda name: (0 if "score" in name.lower() else 1, len(name)))
        return zf.read(xml_files[0])


def parse_score_document(score_bytes: bytes, start_measure: int) -> dict:
    if score_bytes[:4] == b"PK\x03\x04":
        extracted = extract_musicxml_from_mxl(score_bytes)
        if not extracted:
            return {"error": "MXL archive had no MusicXML payload", "measures": [], "source": "music21"}
        score_bytes = extracted
    return parse_musicxml(score_bytes, start_measure)


def find_exported_musicxml(output_dir: str) -> str | None:
    import os

    candidates: list[str] = []
    for root, _, files in os.walk(output_dir):
        for filename in files:
            lower = filename.lower()
            if lower.endswith((".mxl", ".musicxml", ".xml")) and "container.xml" not in lower and "meta-inf" not in lower:
                candidates.append(os.path.join(root, filename))
    if not candidates:
        return None

    candidates.sort(key=lambda path: (0 if path.lower().endswith(".mxl") else 1, len(path)))
    return candidates[0]


def convert_visual_score_to_musicxml(score_bytes: bytes, score_mime: str, score_url: str, start_measure: int) -> dict:
    """
    Convert a PDF/image score to MusicXML with Audiveris, then parse it with music21.
    Returns the same ScoreResult shape as parse_musicxml.
    """
    import os
    import subprocess
    import tempfile

    suffix = score_suffix(score_bytes, score_mime, score_url)
    if suffix in {".heic", ".heif", ".score"}:
        return {
            "error": f"Visual score format {suffix} is not supported by the OMR worker. Use PDF, PNG, JPG, TIFF, MusicXML, or MXL.",
            "measures": [],
            "source": "audiveris",
        }

    with tempfile.TemporaryDirectory() as tmpdir:
        home_dir = os.path.join(tmpdir, "home")
        input_path = os.path.join(tmpdir, f"score{suffix}")
        output_dir = os.path.join(tmpdir, "audiveris-output")
        config_dir = os.path.join(tmpdir, "xdg-config")
        data_dir = os.path.join(tmpdir, "xdg-data")
        cache_dir = os.path.join(tmpdir, "xdg-cache")
        for path in (home_dir, output_dir, config_dir, data_dir, cache_dir):
            os.makedirs(path, exist_ok=True)
        with open(input_path, "wb") as f:
            f.write(score_bytes)

        env = {
            **os.environ,
            "HOME": home_dir,
            "XDG_CONFIG_HOME": config_dir,
            "XDG_DATA_HOME": data_dir,
            "XDG_CACHE_HOME": cache_dir,
            "JAVA_TOOL_OPTIONS": "-Djava.awt.headless=true",
        }

        commands = [
            ["audiveris", "-batch", "-transcribe", "-export", "-output", output_dir, "--", input_path],
            ["audiveris", "-batch", "-export", "-output", output_dir, "--", input_path],
        ]

        last_output = ""
        for idx, command in enumerate(commands, start=1):
            print(f"[audiveris] running OMR conversion attempt {idx}: {' '.join(command[:-1])} <score>")
            result = subprocess.run(command, capture_output=True, text=True, timeout=300, env=env)
            last_output = (result.stderr or result.stdout or "").strip()
            exported_path = find_exported_musicxml(output_dir)
            if result.returncode == 0 and exported_path:
                break
            print(f"[audiveris] attempt {idx} did not produce export. rc={result.returncode}; output={last_output[:1000]}")
        else:
            return {
                "error": f"Audiveris produced no MusicXML export: {last_output[:500] or 'no output'}",
                "measures": [],
                "source": "audiveris",
            }

        exported_path = find_exported_musicxml(output_dir)
        if not exported_path:
            print("[audiveris] no MusicXML/MXL export found")
            return {"error": "Audiveris produced no MusicXML export", "measures": [], "source": "audiveris"}

        print(f"[audiveris] exported {exported_path}")
        with open(exported_path, "rb") as f:
            exported_bytes = f.read()

        parsed = parse_score_document(exported_bytes, start_measure)
        parsed["source"] = "audiveris+music21"
        parsed["omr_export_path"] = os.path.basename(exported_path)
        return parsed


def assign_events_to_measures(
    events: list[dict],
    beat_times: list[float],
    beats_per_measure: int,
    start_measure: int,
) -> list[dict]:
    """
    Assign each audio event to a measure number using beat times.
    Beat 0 in beat_times[] corresponds to measure start_measure, beat 1.
    """
    if not beat_times or not events:
        return events

    result = []
    for ev in events:
        t = ev["time_sec"]
        lo, hi = 0, len(beat_times) - 1
        beat_idx = 0
        while lo <= hi:
            mid = (lo + hi) // 2
            if beat_times[mid] <= t:
                beat_idx = mid
                lo = mid + 1
            else:
                hi = mid - 1

        measure_offset = beat_idx // beats_per_measure
        measure_num = start_measure + measure_offset
        result.append({**ev, "measure": measure_num})

    return result


# ── Modal endpoint ─────────────────────────────────────────────────────────

@app.function(
    image=image,
    timeout=300,
    memory=4096,
    min_containers=1,
)
@modal.fastapi_endpoint(method="POST", docs=True)
def analyze(body: dict) -> dict:
    """
    Main analysis endpoint.
    Accepts video_url (required) and optional score_url.
    Returns combined audio transcription + beat tracking + optional score parsing.
    """
    import httpx

    video_url = body.get("video_url")
    score_url = body.get("score_url")
    score_mime = body.get("score_mime", "")
    instrument = body.get("instrument", "instrument")
    start_measure = int(body.get("start_measure", 1))
    time_sig_hint = body.get("time_sig", "4/4")

    if not video_url:
        return {"error": "video_url is required"}

    try:
        try:
            num, denom = map(int, time_sig_hint.split("/"))
            is_compound = num % 3 == 0 and num // 3 >= 2 and denom >= 8
            beats_per_measure = num // 3 if is_compound else num
        except Exception:
            beats_per_measure = 4

        print(f"[analyze] downloading video from signed URL ({len(video_url)} chars)")
        with httpx.Client(timeout=120) as client:
            video_resp = client.get(video_url, follow_redirects=True)
            video_resp.raise_for_status()
            video_bytes = video_resp.content
        print(f"[analyze] video downloaded: {len(video_bytes):,} bytes")

        wav_bytes, video_duration = extract_audio_from_video(video_bytes)
        print(f"[analyze] audio extracted: {len(wav_bytes):,} bytes, duration={video_duration:.1f}s")

        # Beat tracking first (fast, gives tempo hint)
        beats = run_beat_tracking(wav_bytes)

        # CREPE pitch tracking, guided by beat locations so we don't skip
        # quieter internal moments between strong onsets.
        raw_events = run_pitch_tracking(wav_bytes, guide_times=beats["beat_times"])

        beat_times = beats["beat_times"]
        events_with_measures = assign_events_to_measures(
            raw_events, beat_times, beats_per_measure, start_measure
        )

        audio_result = {
            "audio_duration_sec": beats["duration_sec"] or video_duration,
            "events": events_with_measures,
            "tempo_estimate_bpm": beats["tempo_bpm"],
            "tempo_steadiness": "steady",
            "beat_times": beat_times,
            "onset_times": beats["onset_times"],
            "source": "crepe+librosa",
        }

        score_result = None
        if score_url:
            print("[analyze] downloading score from signed URL")
            with httpx.Client(timeout=90) as client:
                score_resp = client.get(score_url, follow_redirects=True)
                score_resp.raise_for_status()
                score_bytes = score_resp.content
            print(f"[analyze] score downloaded: {len(score_bytes):,} bytes, mime={score_mime or '(unknown)'}")

            score_kind = sniff_score_kind(score_bytes, score_mime, score_url)
            print(f"[analyze] score kind: {score_kind}")
            if score_kind in ("xml", "mxl"):
                print("[analyze] parsing structured MusicXML/MXL score")
                score_result = parse_score_document(score_bytes, start_measure)
            elif score_kind == "visual":
                print("[analyze] visual score detected; converting with Audiveris OMR")
                score_result = convert_visual_score_to_musicxml(score_bytes, score_mime, score_url, start_measure)
            else:
                print(f"[analyze] score MIME '{score_mime}' is not supported for score parsing")

        return {
            "audio": audio_result,
            "score": score_result,
            "beats": beats,
        }

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[analyze] ERROR: {e}\n{tb}")
        return {"error": str(e), "traceback": tb}


# ── Helpers for the async full-pipeline ───────────────────────────────────

def extract_json_object(raw: str) -> dict | None:
    import json, re
    stripped = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.IGNORECASE).rstrip('`').strip()
    start = stripped.find('{')
    end   = stripped.rfind('}')
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(stripped[start:end + 1])
    except Exception:
        return None


def upload_video_to_gemini(video_bytes: bytes, mime_type: str, api_key: str) -> str | None:
    import httpx, json, time
    boundary = f"gem_{int(time.time() * 1000)}"
    metadata = json.dumps({"file": {"displayName": "practice-recording"}})
    CRLF = "\r\n"
    pre  = f"--{boundary}{CRLF}Content-Type: application/json; charset=UTF-8{CRLF}{CRLF}{metadata}{CRLF}--{boundary}{CRLF}Content-Type: {mime_type}{CRLF}{CRLF}"
    post = f"{CRLF}--{boundary}--"
    body = pre.encode() + video_bytes + post.encode()
    try:
        with httpx.Client(timeout=120) as client:
            resp = client.post(
                f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={api_key}&uploadType=multipart",
                content=body,
                headers={"Content-Type": f"multipart/related; boundary={boundary}"},
            )
            resp.raise_for_status()
            file_data = resp.json()["file"]
            file_id   = file_data["name"].split("/")[-1]
            state     = file_data.get("state", "PROCESSING")
            for _ in range(15):
                if state == "ACTIVE":
                    break
                time.sleep(3)
                poll  = client.get(f"https://generativelanguage.googleapis.com/v1beta/files/{file_id}?key={api_key}")
                state = poll.json().get("state", "UNKNOWN")
            if state != "ACTIVE":
                print(f"[upload_video_to_gemini] file never became ACTIVE (state={state})")
                return None
            return file_data["uri"]
    except Exception as e:
        print(f"[upload_video_to_gemini] error: {e}")
        return None


def evaluate_with_gemini(
    file_uri: str, mime_type: str,
    instrument: str, piece_title: str, composer: str,
    start_measure: int, end_measure: int | None,
    api_key: str,
) -> dict | None:
    import httpx
    GEMINI_MODEL = "gemini-2.5-pro"
    end_info = f" through measure {end_measure}" if end_measure else ""
    prompt = f"""You are an expert {instrument} teacher. Listen carefully to this student recording of "{piece_title}" by {composer}, starting at measure {start_measure}{end_info}.

Listen to the ENTIRE recording from start to finish. Give me concrete, specific observations — NOT vague generalities.

INTONATION: List every passage where pitch sounds noticeably flat or sharp. Give a timestamp and direction. If intonation sounds generally clean, say so explicitly.

RHYTHM: List any rushed or dragged passages, hesitations, uneven note-spacing, or beat instability with timestamps. If rhythm sounds solid, say so.

TECHNIQUE: List bow/breath noise, tone quality issues, insecure shifts, unclear articulation with timestamps. If technique sounds clean, say so.

OVERALL: One sentence — the single most important thing for this student to work on.

RULES: Be direct. Vague feedback is useless. If something is genuinely clean, say so. Focus on 1-3 most important issues.

Return JSON only:
{{
  "intonation_issues": ["<timestamp>: <specific observation>"],
  "rhythm_issues": ["<timestamp>: <specific observation>"],
  "technique_issues": ["<timestamp>: <specific observation>"],
  "overall": "<one sentence>"
}}"""
    try:
        with httpx.Client(timeout=120) as client:
            resp = client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={api_key}",
                json={
                    "contents": [{"parts": [
                        {"fileData": {"mimeType": mime_type, "fileUri": file_uri}},
                        {"text": prompt},
                    ]}],
                    "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "maxOutputTokens": 4096},
                },
            )
        if not resp.is_success:
            print(f"[evaluate_with_gemini] HTTP {resp.status_code}")
            return None
        data = resp.json()
        text = (data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text"))
        if not text:
            return None
        parsed = extract_json_object(text)
        if not parsed:
            return None
        print(f"[evaluate_with_gemini] overall: {str(parsed.get('overall', ''))[:100]}")
        return {
            "intonation_issues": parsed.get("intonation_issues", []),
            "rhythm_issues":     parsed.get("rhythm_issues", []),
            "technique_issues":  parsed.get("technique_issues", []),
            "overall":           parsed.get("overall", ""),
        }
    except Exception as e:
        print(f"[evaluate_with_gemini] error: {e}")
        return None


def read_score_notes_claude(
    score_bytes: bytes, score_mime: str,
    start_measure: int, instrument: str, time_sig: str,
    anthropic_api_key: str,
) -> dict:
    import base64, anthropic as ac
    CLAUDE_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    b64 = base64.b64encode(score_bytes).decode()
    if score_mime == "application/pdf":
        vision_part = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64}}
    elif score_mime in CLAUDE_IMAGE_TYPES:
        vision_part = {"type": "image", "source": {"type": "base64", "media_type": score_mime, "data": b64}}
    else:
        print(f"[read_score_notes_claude] unsupported mime: {score_mime}")
        return {"key_signature": None, "time_signature": None, "tempo_marking": None, "measures": []}

    prompt = f"""You are an expert music engraver reading sheet music for a {instrument} student.

MEASURE NUMBERING — CRITICAL: The recording starts at measure {start_measure}. The FIRST complete measure at the top-left is measure {start_measure}. Number sequentially from there. Do NOT trust printed numbers — count barlines visually.

Time signature hint: {time_sig}. Use what you see in the image if different.

Return EVERY measure bar-to-bar. For each sounded note you can read:
- pitch: scientific pitch notation ("D3", "F#4"). null only when note-head is present but pitch unreadable.
- Do NOT include rests.
- beat: position in measure (1.0 = downbeat).
- duration_beats: how many beats this note lasts.
- articulation: "staccato", "tenuto", "accent", or null.
- dynamic: "pp", "p", "mp", "mf", "f", "ff", "cresc", "dim", or null.

Return JSON only (no markdown):
{{
  "key_signature": "...",
  "time_signature": "...",
  "tempo_marking": "...",
  "measures": [{{"number": {start_measure}, "notes": [{{"pitch": "D3", "beat": 1.0, "duration_beats": 1.5, "articulation": null, "dynamic": "p"}}]}}]
}}"""

    try:
        client = ac.Anthropic(api_key=anthropic_api_key)
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=16000,
            messages=[{"role": "user", "content": [vision_part, {"type": "text", "text": prompt}]}],
        )
        raw    = msg.content[0].text
        parsed = extract_json_object(raw)
        if not parsed:
            print(f"[read_score_notes_claude] no JSON: {raw[:300]}")
            return {"key_signature": None, "time_signature": None, "tempo_marking": None, "measures": []}
        measures = [
            {**m, "notes": [n for n in m.get("notes", []) if str(n.get("pitch", "")).lower() != "rest"]}
            for m in (parsed.get("measures") or [])
            if isinstance(m.get("notes"), list)
        ]
        if measures and measures[0].get("number") != start_measure:
            for i, m in enumerate(measures):
                m["number"] = start_measure + i
        total_notes = sum(len(m["notes"]) for m in measures)
        print(f"[read_score_notes_claude] {len(measures)} measures, {total_notes} notes")
        return {
            "key_signature":  parsed.get("key_signature"),
            "time_signature": parsed.get("time_signature"),
            "tempo_marking":  parsed.get("tempo_marking"),
            "measures":       measures,
        }
    except Exception as e:
        print(f"[read_score_notes_claude] error: {e}")
        return {"key_signature": None, "time_signature": None, "tempo_marking": None, "measures": []}


def beats_per_measure_from_time_sig(time_sig: str | None) -> int:
    import re
    m = re.match(r'^(\d+)\s*/\s*(\d+)$', (time_sig or "").strip())
    if not m:
        return 4
    num, denom = int(m.group(1)), int(m.group(2))
    is_compound = num % 3 == 0 and num // 3 >= 2 and denom >= 8
    return num // 3 if is_compound else num


def anchor_and_align_py(
    score: dict,
    events: list[dict],
    tempo_bpm: float | None,
    audio_duration: float,
    start_measure: int,
) -> tuple[list[dict], float, list[dict]]:
    if not events or not score.get("measures"):
        return [], 4.0, []
    bpm_per_measure = beats_per_measure_from_time_sig(score.get("time_signature"))
    t_anchor        = events[0]["time_sec"]
    played_duration = max(1.0, audio_duration - t_anchor)
    sec_per_measure = 4.0
    if tempo_bpm and bpm_per_measure:
        tempo_based = bpm_per_measure * (60.0 / tempo_bpm)
        if 1.0 <= tempo_based <= 30.0:
            sec_per_measure = tempo_based
    sec_per_measure = max(1.0, min(30.0, sec_per_measure))
    estimated_measures = max(1, int(played_duration / sec_per_measure + 0.5))
    last_measure = min(
        start_measure + estimated_measures - 1,
        score["measures"][-1]["number"],
    )
    valid = {m["number"] for m in score["measures"] if m["number"] <= last_measure}
    aligned = []
    for ev in events:
        m_raw = start_measure + int(max(0, ev["time_sec"] - t_anchor) / sec_per_measure)
        m = max(start_measure, min(last_measure, m_raw))
        if m in valid:
            aligned.append({**ev, "measure": m})
    ranges_map: dict = {}
    for ev in aligned:
        m = ev["measure"]
        if m not in ranges_map:
            ranges_map[m] = {"start": ev["time_sec"], "end": ev["time_sec"]}
        else:
            ranges_map[m]["start"] = min(ranges_map[m]["start"], ev["time_sec"])
            ranges_map[m]["end"]   = max(ranges_map[m]["end"],   ev["time_sec"])
    alignment_ranges = [
        {"measure": m, "start": r["start"], "end": max(r["end"], r["start"] + sec_per_measure * 0.9)}
        for m, r in sorted(ranges_map.items())
    ]
    print(f"[anchor_and_align_py] sec/measure={sec_per_measure:.2f}, aligned={len(aligned)}, ranges={len(alignment_ranges)}")
    return aligned, sec_per_measure, alignment_ranges


def build_gemini_block(assessment: dict | None) -> str:
    if not assessment:
        return "DIRECT LISTENING CROSS-CHECK: unavailable."
    lines = [
        "DIRECT LISTENING CROSS-CHECK (Gemini listening to the actual recording):",
        f"- Intonation: {' | '.join(assessment['intonation_issues']) if assessment['intonation_issues'] else 'No clear intonation issues reported.'}",
        f"- Rhythm: {' | '.join(assessment['rhythm_issues']) if assessment['rhythm_issues'] else 'No clear rhythm issues reported.'}",
        f"- Technique: {' | '.join(assessment['technique_issues']) if assessment['technique_issues'] else 'No clear technique issues reported.'}",
        f"- Overall: {assessment.get('overall') or 'No overall note provided.'}",
        "Treat this block as corroborating evidence.",
    ]
    return "\n".join(lines)


def compare_and_coach_claude(
    score: dict, aligned: list[dict], alignment_ranges: list[dict],
    tempo: dict, piece_title: str, composer: str, instrument: str,
    gemini_assessment: dict | None, anthropic_api_key: str,
) -> list[dict]:
    import anthropic as ac, re
    CLAUDE_MODEL = "claude-sonnet-4-6"
    allowed_types = {"intonation", "timing", "rhythm", "articulation", "dynamics", "voicing"}
    events_by_measure: dict[int, list] = {}
    for ev in aligned:
        events_by_measure.setdefault(ev["measure"], []).append(ev)
    played_measures = [m for m in score.get("measures", []) if m["number"] in events_by_measure]
    if not played_measures and not gemini_assessment:
        return []
    range_map        = {r["measure"]: r for r in alignment_ranges}
    range_start_map  = {r["measure"]: r["start"] for r in alignment_ranges}
    valid_measures   = {m["number"] for m in score.get("measures", [])}
    bpm              = beats_per_measure_from_time_sig(score.get("time_signature"))
    evidence_candidates: list[str] = []
    for m in played_measures:
        events  = sorted(events_by_measure.get(m["number"], []), key=lambda e: e["time_sec"])
        r       = range_map.get(m["number"])
        m_start = r["start"] if r else (events[0]["time_sec"] if events else 0)
        m_dur   = max(0.5, r["end"] - r["start"]) if r else 4.0
        spb     = m_dur / max(1, bpm)
        for ev in events:
            cents = ev.get("cents_offset")
            if cents is not None and abs(cents) >= 10 and ev.get("confidence", 100) >= 25:
                beat = max(1, round((ev["time_sec"] - m_start) / spb + 1, 2))
                sign = "+" if cents > 0 else ""
                evidence_candidates.append(
                    f"intonation | measure {m['number']} beat {beat} | {'/'.join(ev['pitches'])} is {sign}{cents}¢ at {ev['time_sec']:.2f}s"
                )
        gaps = [events[i+1]["time_sec"] - events[i]["time_sec"] for i in range(len(events) - 1)]
        if len(gaps) >= 4:
            median = sorted(gaps)[len(gaps) // 2]
            for i, gap in enumerate(gaps):
                if median > 0 and gap > median * 2.2 and gap > 0.8:
                    beat = max(1, round((events[i]["time_sec"] - m_start) / spb + 1, 2))
                    evidence_candidates.append(
                        f"timing | measure {m['number']} near beat {beat} | {gap:.2f}s gap after {'/'.join(events[i]['pitches'])} at {events[i]['time_sec']:.2f}s"
                    )
    strongest = evidence_candidates[:8]
    crepe_has_data = bool(strongest)
    has_gemini = bool(gemini_assessment and any([
        gemini_assessment.get("intonation_issues"), gemini_assessment.get("rhythm_issues"), gemini_assessment.get("technique_issues"),
    ]))
    if not strongest and not has_gemini:
        print("[compare_and_coach_claude] no evidence; returning no flags")
        return []
    valid_list  = sorted(r["measure"] for r in alignment_ranges)
    gemini_block = build_gemini_block(gemini_assessment)
    measure_blocks = []
    for m in played_measures:
        sounded = [n for n in m.get("notes", []) if str(n.get("pitch", "")).lower() != "rest"]
        written = (
            "(score notation not parsed — analyze event spacing for rhythm/timing issues)"
            if not sounded else
            ", ".join(f"{n.get('pitch') or '(unreadable)'} @ beat {n.get('beat','?')} ({n.get('duration_beats','?')}b)" for n in sounded)
        )
        m_start = range_start_map.get(m["number"], 0)
        events  = sorted(events_by_measure.get(m["number"], []), key=lambda e: e["time_sec"])
        heard_parts = []
        for ev in events:
            cents = ev.get("cents_offset")
            cents_str = f" ({'+' if (cents or 0) > 0 else ''}{cents}¢)" if cents is not None and abs(cents) >= 5 else ""
            loudness  = f" [{ev.get('loudness')}]" if ev.get("loudness") else ""
            heard_parts.append(f"{'/'.join(ev['pitches'])}{cents_str} @ +{ev['time_sec'] - m_start:.2f}s{loudness}")
        heard = ", ".join(heard_parts) if heard_parts else "(no events)"
        measure_blocks.append(f"Measure {m['number']}:\n  WRITTEN: {written}\n  HEARD:   {heard}")
    cand_block = (
        f"MEASURABLE ISSUE CANDIDATES:\n" + "\n".join(f"{i+1}. {e}" for i, e in enumerate(strongest))
        if crepe_has_data else
        "MEASURABLE ISSUE CANDIDATES: (pitch analysis did not produce specific candidates — rely on direct listening below)"
    )
    prompt = f"""You are a master {instrument} teacher giving feedback to a student on "{piece_title}" by {composer}.

{chr(10).join(measure_blocks)}

{cand_block}

Tempo: {tempo.get('bpm', '?')} BPM. Key: {score.get('key_signature', '?')}. Time signature: {score.get('time_signature', '?')}.
{gemini_block}

YOUR TASK: Identify 1–4 issues. Priority: direct listening observations first, then CREPE intonation candidates, then pitch mismatches, then rhythm.

HARD RULES:
- Every "measure" field MUST be one of: [{', '.join(str(m) for m in valid_list)}].
- Do NOT flag rests, silence, missing notes, or coverage gaps.
- For intonation flags, raw_detail MUST cite cents ("+22¢") or a listening timestamp ("0:08").
- "type" must be one of: intonation, timing, rhythm, articulation, dynamics, voicing.
- If the recording sounds genuinely clean, return fewer or zero flags.

Return JSON only (no markdown):
{{
  "flags": [
    {{
      "measure": <int from the allowed list>,
      "beat": <number 1-based or null>,
      "type": "<type>",
      "confidence": <70-100>,
      "title": "<6-10 word specific title>",
      "raw_detail": "<one sentence: the evidence>",
      "body": "<3-sentence warm coaching paragraph>"
    }}
  ]
}}"""
    try:
        client = ac.Anthropic(api_key=anthropic_api_key)
        msg    = client.messages.create(
            model=CLAUDE_MODEL, max_tokens=8000,
            messages=[{"role": "user", "content": prompt}],
        )
        raw    = msg.content[0].text
        parsed = extract_json_object(raw)
        if not parsed:
            print(f"[compare_and_coach_claude] no JSON: {raw[:300]}")
            return []
    except Exception as e:
        print(f"[compare_and_coach_claude] Claude API error: {e}")
        return []
    flags = []
    for f in parsed.get("flags", []):
        m_num = f.get("measure")
        if not isinstance(m_num, (int, float)) or int(m_num) not in valid_measures:
            continue
        if f.get("confidence", 100) < 60:
            continue
        if not all(f.get(k) for k in ("type", "title", "raw_detail", "body")):
            continue
        if str(f.get("type")) not in allowed_types:
            continue
        raw_detail = str(f.get("raw_detail", ""))
        if str(f.get("type")) == "intonation":
            if not re.search(r'[+-]\d+¢', raw_detail) and not re.search(r'\d:\d{2}', raw_detail):
                continue
        if re.search(r'(rest|silence|missing note|skipped measure|dropped note|coverage gap|no events)', raw_detail, re.IGNORECASE):
            continue
        m_num = int(m_num)
        r     = range_map.get(m_num)
        if not r and alignment_ranges:
            r     = min(alignment_ranges, key=lambda x: abs(x["measure"] - m_num))
            m_num = r["measure"]
        if not r:
            continue
        beat = f.get("beat")
        if isinstance(beat, (int, float)):
            m_dur = max(0.5, r["end"] - r["start"])
            spb   = m_dur / max(1, bpm)
            center  = r["start"] + max(0, beat - 1) * spb
            ts_start = max(r["start"], center - 0.45)
            ts_end   = min(r["end"], center + max(1.0, spb * 1.25))
            if ts_end <= ts_start:
                ts_end = min(r["end"], ts_start + 1.0)
        else:
            beat, ts_start, ts_end = None, r["start"], r["end"]
        flags.append({
            "measure": m_num, "beat": beat, "type": str(f["type"]),
            "title": str(f["title"]), "raw_detail": raw_detail, "body": str(f.get("body", "")),
            "confidence": int(f.get("confidence", 100)),
            "timestamp_start": ts_start, "timestamp_end": ts_end, "spot": None, "spot_angle": 0,
        })
    seen: set = set()
    deduped = []
    for flag in sorted(flags, key=lambda x: -x["confidence"]):
        key = (flag["measure"], flag["type"])
        if key not in seen:
            seen.add(key)
            deduped.append(flag)
    print(f"[compare_and_coach_claude] {len(deduped)} flags: {[(f['measure'], f['type']) for f in deduped]}")
    return deduped[:4]


def assess_quality(
    score: dict, events: list[dict], aligned: list[dict],
    alignment_ranges: list[dict], used_modal: bool, gemini_assessment: dict | None,
) -> dict:
    reasons: list[str] = []
    if len(score.get("measures", [])) < 2:
        reasons.append("The score could not be parsed into enough readable measures.")
    if not gemini_assessment:
        if len(events) < 8:
            reasons.append("Too few audio events were extracted from the recording.")
        if len(aligned) < 8:
            reasons.append("Too few note events could be aligned to score measures.")
        if len(alignment_ranges) < 2:
            reasons.append("The recording only aligned to a very small number of measures.")
        reasons.append("Direct listening corroboration from Gemini was unavailable.")
    if not reasons:
        return {"trust": "high", "canProceed": True, "reasons": []}
    if used_modal and len(score.get("measures", [])) >= 2 and len(aligned) >= 8:
        return {"trust": "medium", "canProceed": True, "reasons": reasons}
    if gemini_assessment:
        return {"trust": "medium", "canProceed": True, "reasons": reasons}
    return {"trust": "low", "canProceed": False, "reasons": reasons}


def post_webhook(webhook_url: str, webhook_secret: str | None, payload: dict) -> None:
    import httpx
    try:
        headers = {"Content-Type": "application/json"}
        if webhook_secret:
            headers["x-webhook-secret"] = webhook_secret
        with httpx.Client(timeout=30) as client:
            resp = client.post(webhook_url, json=payload, headers=headers)
            print(f"[post_webhook] status={resp.status_code}")
    except Exception as e:
        print(f"[post_webhook] failed: {e}")


# ── Background analysis task ───────────────────────────────────────────────

@app.function(
    image=image,
    timeout=300,
    memory=4096,
)
def run_full_analysis(payload: dict) -> None:
    """
    Full async pipeline: CREPE → score parsing → Gemini eval → Claude coaching → webhook.
    Called via .spawn() so it runs detached from the dispatcher.
    """
    import httpx
    from collections import defaultdict

    take_id        = payload["take_id"]
    webhook_url    = payload["webhook_url"]
    webhook_secret = payload.get("webhook_secret")
    video_url      = payload.get("video_url")
    video_mime     = payload.get("video_mime_type", "video/mp4")
    score_url      = payload.get("score_url")
    score_mime     = payload.get("score_mime_type", "")
    instrument     = payload.get("instrument", "instrument")
    piece_title    = payload.get("piece_title", "this piece")
    composer       = payload.get("composer", "the composer")
    time_sig       = payload.get("time_sig", "4/4")
    start_measure  = int(payload.get("start_measure", 1))
    end_measure    = payload.get("end_measure")
    gemini_key     = payload.get("gemini_api_key")
    anthropic_key  = payload.get("anthropic_api_key")

    try:
        num, denom = map(int, time_sig.split("/"))
        is_compound = num % 3 == 0 and num // 3 >= 2 and denom >= 8
        bpm_int = num // 3 if is_compound else num
    except Exception:
        bpm_int = 4

    try:
        # ── Step 1: Download video + audio analysis ────────────────────────
        print(f"[run_full_analysis] downloading video for take {take_id}")
        with httpx.Client(timeout=120) as client:
            vresp = client.get(video_url, follow_redirects=True)
            vresp.raise_for_status()
            video_bytes = vresp.content
        print(f"[run_full_analysis] video: {len(video_bytes):,} bytes")

        wav_bytes, video_duration = extract_audio_from_video(video_bytes)
        beats      = run_beat_tracking(wav_bytes)
        raw_events = run_pitch_tracking(wav_bytes, guide_times=beats["beat_times"])
        events_with_measures = assign_events_to_measures(raw_events, beats["beat_times"], bpm_int, start_measure)

        # ── Step 2: Parse score ────────────────────────────────────────────
        score: dict = {"key_signature": None, "time_signature": None, "tempo_marking": None, "measures": []}
        if score_url:
            print("[run_full_analysis] downloading score")
            with httpx.Client(timeout=90) as client:
                sresp = client.get(score_url, follow_redirects=True)
                sresp.raise_for_status()
                score_bytes_dl = sresp.content
            print(f"[run_full_analysis] score: {len(score_bytes_dl):,} bytes, mime={score_mime}")
            score_kind = sniff_score_kind(score_bytes_dl, score_mime, score_url)
            print(f"[run_full_analysis] score kind: {score_kind}")
            if score_kind in ("xml", "mxl"):
                res = parse_score_document(score_bytes_dl, start_measure)
                if not res.get("error") and res.get("measures"):
                    score = res
            elif score_kind == "visual" and anthropic_key:
                res = read_score_notes_claude(score_bytes_dl, score_mime, start_measure, instrument, time_sig, anthropic_key)
                if res.get("measures"):
                    score = res
            elif score_kind == "visual":
                print("[run_full_analysis] visual score but no Anthropic key")

        # ── Step 3: Gemini evaluation ──────────────────────────────────────
        gemini_assessment = None
        if gemini_key:
            print("[run_full_analysis] uploading video to Gemini")
            gemini_uri = upload_video_to_gemini(video_bytes, video_mime, gemini_key)
            if gemini_uri:
                gemini_assessment = evaluate_with_gemini(
                    gemini_uri, video_mime, instrument,
                    piece_title, composer, start_measure, end_measure, gemini_key,
                )

        # ── Step 4: Build alignment ranges from beat-assigned events ───────
        aligned = [ev for ev in events_with_measures if "measure" in ev]
        ranges_acc: dict = defaultdict(lambda: {"start": float("inf"), "end": float("-inf")})
        for ev in aligned:
            m = ev["measure"]
            ranges_acc[m]["start"] = min(ranges_acc[m]["start"], ev["time_sec"])
            ranges_acc[m]["end"]   = max(ranges_acc[m]["end"],   ev["time_sec"])
        avg_beat = (
            (beats["beat_times"][-1] - beats["beat_times"][0]) / (len(beats["beat_times"]) - 1)
            if len(beats["beat_times"]) >= 2 else 1.0
        )
        sec_per_measure = max(1.0, min(30.0, avg_beat * bpm_int))
        alignment_ranges = [
            {"measure": m, "start": r["start"], "end": max(r["end"], r["start"] + sec_per_measure * 0.9)}
            for m, r in sorted(ranges_acc.items())
            if r["start"] != float("inf")
        ]
        if end_measure:
            aligned          = [ev for ev in aligned if ev["measure"] <= end_measure]
            alignment_ranges = [r for r in alignment_ranges if r["measure"] <= end_measure]

        # Fallback: tempo-based alignment
        if not aligned and raw_events:
            print("[run_full_analysis] falling back to tempo-based alignment")
            aligned, sec_per_measure, alignment_ranges = anchor_and_align_py(
                score, raw_events, beats["tempo_bpm"], beats["duration_sec"] or video_duration, start_measure,
            )
            if end_measure:
                aligned          = [ev for ev in aligned if ev["measure"] <= end_measure]
                alignment_ranges = [r for r in alignment_ranges if r["measure"] <= end_measure]

        print(f"[run_full_analysis] aligned={len(aligned)}, ranges={len(alignment_ranges)}")

        # ── Step 5: Synthesize skeleton when score parsing failed ──────────
        if not score.get("measures") and raw_events:
            bpm_val  = beats["tempo_bpm"] or 60.0
            synth_s  = max(1.0, min(15.0, bpm_int * (60.0 / bpm_val)))
            last_m   = end_measure or (start_measure + min(40, int(video_duration / synth_s)))
            count    = last_m - start_measure + 1
            score    = {**score, "measures": [{"number": start_measure + i, "notes": []} for i in range(count)]}
            print(f"[run_full_analysis] synthesized {count} skeleton measures")

        # ── Step 6: Quality assessment ─────────────────────────────────────
        quality = assess_quality(score, raw_events, aligned, alignment_ranges, True, gemini_assessment)
        print(f"[run_full_analysis] quality trust={quality['trust']}, canProceed={quality['canProceed']}")

        # ── Step 7: Claude coaching ────────────────────────────────────────
        flags: list[dict] = []
        if quality["canProceed"] and anthropic_key:
            flags = compare_and_coach_claude(
                score=score, aligned=aligned, alignment_ranges=alignment_ranges,
                tempo={"bpm": beats["tempo_bpm"], "steadiness": "steady"},
                piece_title=piece_title, composer=composer, instrument=instrument,
                gemini_assessment=gemini_assessment, anthropic_api_key=anthropic_key,
            )
        elif not quality["canProceed"]:
            print(f"[run_full_analysis] skipping coaching (low trust): {quality['reasons']}")

        base_score = max(50, min(98, 95 - len(flags) * 6))
        backend    = "modal+gemini+claude" if gemini_assessment else "modal+claude"
        print(f"[run_full_analysis] done | score={base_score} | flags={len(flags)} | backend={backend}")

        post_webhook(webhook_url, webhook_secret, {
            "takeId":          take_id,
            "score":           base_score,
            "flags":           flags,
            "measureLayout":   score if score.get("measures") else None,
            "audioAlignment":  alignment_ranges if alignment_ranges else None,
            "analysisQuality": quality,
            "analysisBackend": backend,
        })

    except Exception as e:
        import traceback
        print(f"[run_full_analysis] FATAL ERROR for take {take_id}: {e}\n{traceback.format_exc()}")
        post_webhook(webhook_url, webhook_secret, {"takeId": take_id, "error": str(e)})


# ── Fire-and-forget dispatcher endpoint ───────────────────────────────────

@app.function(image=image, timeout=30)
@modal.fastapi_endpoint(method="POST", docs=True)
def analyze_async(body: dict) -> dict:
    """
    Validates payload, spawns run_full_analysis in the background, returns immediately.
    The Edge Function only needs to wait ~2s for this acknowledgement.
    """
    take_id   = body.get("take_id")
    video_url = body.get("video_url")
    if not take_id or not video_url:
        return {"error": "take_id and video_url are required"}
    run_full_analysis.spawn(body)
    print(f"[analyze_async] spawned analysis for take {take_id}")
    return {"queued": True, "take_id": take_id}


@app.local_entrypoint()
def test_local():
    print("Mediant worker app loaded OK.")
    print("App name:", app.name)
