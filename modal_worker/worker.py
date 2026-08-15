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
        # PDF → PNG rendering for Gemini (so PDF scores work the same as image scores)
        "pymupdf==1.24.11",
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

def pdf_first_page_to_png(pdf_bytes: bytes, dpi: int = 150) -> bytes | None:
    """Render the first page of a PDF to a PNG image for Gemini vision input."""
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        page = doc[0]
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        return pix.tobytes("png")
    except Exception as e:
        print(f"[pdf_first_page_to_png] failed: {e}")
        return None


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


def _instrument_pitch_bounds(instrument: str) -> tuple[float, float]:
    """Return (fmin_hz, fmax_hz) for CREPE based on the instrument's playable range.
    Tighter bounds reduce false positives from out-of-range noise.
    CREPE tops out around 1975 Hz internally; violin's high E (2637 Hz) is above that
    — Gemini's audio evaluation handles the high register for violin."""
    i = instrument.lower()
    if "violin" in i:
        return 196.0, 2093.0      # G3 – C7 (CREPE ceiling; high E7 covered by Gemini)
    if "viola" in i:
        return 131.0, 2093.0      # C3 – C7
    if "cello" in i:
        return 65.0, 1047.0       # C2 – C6
    if "double bass" in i or ("bass" in i and "bassoon" not in i):
        return 41.0, 524.0        # E1 – C5
    if "flute" in i:
        return 262.0, 2093.0      # C4 – C7
    if any(x in i for x in ("oboe", "clarinet", "saxophone")):
        return 138.0, 1760.0      # C#3 – A6
    if "bassoon" in i:
        return 58.0, 698.0        # Bb1 – F5
    if "trumpet" in i:
        return 165.0, 1047.0      # E3 – C6
    if any(x in i for x in ("trombone", "french horn", "tuba", "horn")):
        return 58.0, 698.0
    if any(x in i for x in ("piano", "keyboard", "harp")):
        return 27.5, 2093.0       # A0 – C7
    return 32.70, 2093.0          # safe default covering cello–violin range


def run_pitch_tracking(wav_bytes: bytes, guide_times: list[float] | None = None, instrument: str = "") -> list[dict]:
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
        fmin_hz, fmax_hz = _instrument_pitch_bounds(instrument)
        pitch, periodicity = torchcrepe.predict(
            audio_tensor,
            CREPE_SR,
            CREPE_HOP,
            fmin=fmin_hz,
            fmax=fmax_hz,
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
            midi_float   = 12.0 * math.log2(dominant_hz / 440.0) + 69.0
            midi_raw     = int(round(midi_float))
            # Compute cents from the UN-clamped value so out-of-range notes
            # don't produce bogus offsets like -500¢.
            cents_offset = round((midi_float - midi_raw) * 100)  # -50..+50 ¢
            midi         = max(36, min(96, midi_raw))  # C2–C7 clamp (for display only)

            # RMS-based loudness — also used to gate out breathing / ambient noise
            s   = int(event_t * SR)
            e   = min(len(y), s + SR // 10)
            rms = float(np.sqrt(np.mean(y[s:e] ** 2))) if e > s else 0.0
            # Discard events below breath-noise floor (~-45 dBFS); real soft notes
            # hit ~0.02 RMS even on quiet passages; breathing is typically 0.001–0.008
            if rms < 0.012:
                continue
            loudness = "loud" if rms > 0.15 else "medium" if rms > 0.04 else "soft"

            confidence = int(min(100, float(np.mean(window_conf)) * 100))

            events.append({
                "time_sec":    float(event_t),
                "end_sec":     float(next_t),
                "pitches":     [midi_to_scientific(midi)],
                "midi":        midi,       # C2–C7 clamped (display only)
                "midi_raw":    midi_raw,   # unclamped — used for wrong-note comparison
                "pitch_hz":    round(dominant_hz, 2),
                "cents_offset": cents_offset,
                "confidence":  confidence,
                "loudness":    loudness,
                "source":      "crepe+librosa+dense",
            })

        events.sort(key=lambda e: e["time_sec"])

        # Clarinet harmonic suppression: clarinet overblows at the 12th (3× frequency),
        # so CREPE can track the 3rd harmonic instead of the fundamental. If the instrument
        # is clarinet and an event is almost exactly a 12th (19 semitones ±2) above
        # a nearby event within 400ms, discard the higher one — it's almost certainly
        # a harmonic of the lower note, not an actual clarion-register pitch.
        if "clarinet" in instrument.lower() and len(events) > 1:
            TWELFTH = 19  # semitones
            harmonic_tolerance = 2  # semitones
            discard = set()
            for i, ev in enumerate(events):
                if i in discard:
                    continue
                hi = ev["midi_raw"]
                for j in range(max(0, i - 3), i):
                    if j in discard:
                        continue
                    lo = events[j]["midi_raw"]
                    diff = hi - lo
                    if abs(diff - TWELFTH) <= harmonic_tolerance:
                        gap = abs(ev["time_sec"] - events[j]["time_sec"])
                        if gap <= 0.40:
                            discard.add(i)
                            break
            if discard:
                print(f"[pitch_tracking] clarinet: suppressed {len(discard)} likely 12th-harmonic events")
                events = [e for i, e in enumerate(events) if i not in discard]

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


# ── DTW alignment ─────────────────────────────────────────────────────────

def midi_from_name(pitch_name: str) -> int | None:
    """Convert scientific pitch notation ("F#4", "Bb3") to MIDI number."""
    import re
    m = re.match(r'^([A-Ga-g])([#b♯♭]?)(-?\d+)$', pitch_name.strip())
    if not m:
        return None
    step, accidental, octave_str = m.group(1).upper(), m.group(2), int(m.group(3))
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[step]
    acc  = 1 if accidental in ("#", "♯") else (-1 if accidental in ("b", "♭") else 0)
    return (octave_str + 1) * 12 + base + acc


def flatten_score_notes(
    score: dict,
    start_measure: int | None = None,
    end_measure: int | None = None,
    beats_per_measure: int | None = None,
) -> list[dict]:
    """
    Flatten a score into the ordered list of pitched notes DTW aligns against,
    restricted to the measures the student actually played.

    The window matters enormously. A photo of two pages can contain 60+ measures
    while the take covers 18 of them; DTW warps the WHOLE audio onto the WHOLE
    note sequence it is given, so handing it the full score stretches those 18
    measures across all 60 and every resulting measure number is wrong. The
    caller knows the range (the student enters start/end measure), so honour it.

    Also stamps abs_beat — the note's position in beats from the start of the
    window — which is what the timing analysis diffs performed onsets against.

    Notes without a parseable pitch are skipped (same rule DTW always used).
    Rests are already absent: parse_musicxml drops them deliberately.

    Returns: [{"midi", "measure", "beat", "dur_beats", "pitch"}]
      beat       — 1-based position within its measure, in the time signature's
                   beat unit (music21's `el.beat`).
      dur_beats  — quarterLength from music21. Equal to the beat unit only in
                   simple metres; treated as approximate for duration checks.
    """
    out: list[dict] = []
    for m in score.get("measures", []):
        num = m.get("number")
        if start_measure is not None and isinstance(num, int) and num < start_measure:
            continue
        if end_measure is not None and isinstance(num, int) and num > end_measure:
            continue
        for note in m.get("notes", []):
            pitch = note.get("pitch")
            if not pitch:
                continue
            midi = midi_from_name(pitch)
            if midi is None:
                continue
            try:
                beat = float(note.get("beat") or 1.0)
            except (TypeError, ValueError):
                beat = 1.0
            try:
                dur = float(note.get("duration_beats") or 0.0)
            except (TypeError, ValueError):
                dur = 0.0
            out.append({
                "midi":      midi,
                "measure":   m["number"],
                "beat":      beat,
                "dur_beats": dur,
                "pitch":     pitch,
            })
    # Absolute beat position across the window, derived from the measure NUMBER
    # rather than order of appearance. Rest-only measures are absent from this
    # list (multirests especially — this repertoire opens with an 11-bar rest),
    # so counting appearances would collapse every rest to zero beats and make
    # the timing fit think the player jumped ahead. Using the number lets the
    # rests consume the beats they really occupy.
    bpm_m = max(1, int(beats_per_measure or 4))
    if out:
        first_m = min(sn["measure"] for sn in out)
        for sn in out:
            sn["abs_beat"] = (sn["measure"] - first_m) * bpm_m + (sn["beat"] - 1.0)
    return out


def dtw_align_to_score(
    events: list[dict],
    score: dict,
    start_measure: int,
    beats_per_measure: int,
    end_measure: int | None = None,
) -> list[dict]:
    """
    Align CREPE pitch events to score measures using Dynamic Time Warping.

    Works by building two sequences:
      - audio_seq: MIDI pitch of each detected event (from CREPE)
      - score_seq: MIDI pitch of each score note, flattened in order

    DTW finds the minimum-cost warping path between them. Each audio event
    is mapped to the score note it best aligns with, and inherits that
    note's measure number and — critically — the note's OWN detected time_sec
    stays on the event, so alignment_ranges built from this reflect where the
    matching PITCH CONTENT was actually heard, not a beat-count estimate. This
    is far more robust to tempo fluctuation, rubato, and hesitations than any
    beat-grid model, and doesn't accumulate drift from a missed/extra beat.

    Works for any score with enough readable note pitches — MusicXML/MXL
    (precise) or Claude-vision-read from a photo (less precise per-note, but
    DTW's global warping path is robust to a few wrong/missing notes since it
    optimizes the WHOLE sequence match, not note-by-note). Declines (returns
    []) if the score has fewer than 4 usable pitched notes; the caller should
    fall back to beat-grid alignment in that case.
    """
    import numpy as np

    measures = score.get("measures", [])
    if not measures or not events:
        return events

    # Only the measures the student actually played — see flatten_score_notes.
    score_notes = flatten_score_notes(score, start_measure, end_measure, beats_per_measure)
    score_seq: list[tuple[int, int]] = [(sn["midi"], sn["measure"]) for sn in score_notes]

    if len(score_seq) < 4:
        # Return [] (not `events`) so the caller can tell DTW declined and explicitly
        # fall back to beat-grid — the raw `events` have no "measure" key, so silently
        # returning them here used to risk a KeyError downstream wherever code assumes
        # every aligned event carries one.
        print(f"[dtw_align] score has <4 pitched notes — declining, caller should fall back")
        return []

    # Build audio sequence: MIDI pitch per event (use the primary pitch)
    audio_midis: list[int | None] = []
    for ev in events:
        pitches = ev.get("pitches", [])
        midi = midi_from_name(pitches[0]) if pitches else None
        audio_midis.append(midi)

    n, m_len = len(audio_midis), len(score_seq)
    score_midis = [s[0] for s in score_seq]

    # Cost matrix: semitone distance between each audio event and each score note.
    # Unpitched/silent events get a high fixed cost (don't penalize alignment).
    SILENCE_COST = 6.0
    cost = np.full((n, m_len), SILENCE_COST, dtype=np.float32)
    for i, a_midi in enumerate(audio_midis):
        if a_midi is not None:
            cost[i] = np.abs(np.array(score_midis, dtype=np.float32) - a_midi)
            # Octave confusion (12 semitones) is common — halve its penalty
            cost[i] = np.minimum(cost[i], np.abs(cost[i] - 12) + 3.0)

    # Standard DTW accumulated cost with slope constraint (Sakoe-Chiba band)
    # band_ratio limits how far the path can deviate from the diagonal.
    band = max(4, int(max(n, m_len) * 0.25))
    acc  = np.full((n, m_len), np.inf, dtype=np.float32)
    acc[0, 0] = cost[0, 0]
    for i in range(1, n):
        j_lo = max(0, i - band)
        j_hi = min(m_len - 1, i + band)
        for j in range(j_lo, j_hi + 1):
            candidates = [acc[i - 1, j]]
            if j > 0:
                candidates.append(acc[i - 1, j - 1])
                candidates.append(acc[i,     j - 1])
            acc[i, j] = cost[i, j] + min(candidates)

    # Open-END traceback: begin from the best-scoring column of the last row
    # rather than forcing the path onto the score's final note. A take that stops
    # partway (or an end_measure we could not determine) would otherwise be
    # stretched to cover every remaining measure, which is exactly what smeared
    # the measure numbers across the whole score.
    last_row = acc[n - 1]
    j_end = int(np.argmin(last_row)) if np.isfinite(last_row).any() else m_len - 1
    path_audio_to_score: list[int] = [0] * n
    i, j = n - 1, j_end
    while i > 0 or j > 0:
        path_audio_to_score[i] = j
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            prev = min(
                (acc[i - 1, j - 1], 0),
                (acc[i - 1, j],     1),
                (acc[i,     j - 1], 2),
            )
            if prev[1] == 0:
                i -= 1; j -= 1
            elif prev[1] == 1:
                i -= 1
            else:
                j -= 1
    path_audio_to_score[0] = j

    # Map each audio event to a measure number via the score alignment.
    # score_idx is kept too: it indexes flatten_score_notes(score), which carries
    # each note's expected beat position and duration. That's what makes objective
    # timing analysis possible (analyze_timing_vs_score) — previously the matched
    # score note was resolved and then thrown away, keeping only its measure.
    # Stamp the matched score note's own data straight onto the event. The timing
    # analysis then needs no index back into a re-derived list — previously it
    # re-flattened the score itself, so any difference in filtering between the
    # two (exactly what adding the played-range window introduces) would have
    # attributed every residual to the wrong note.
    result = []
    for idx, ev in enumerate(events):
        score_idx = path_audio_to_score[idx]
        sn = score_notes[score_idx]
        result.append({
            **ev,
            "measure":          sn["measure"],
            "score_idx":        score_idx,
            "score_beat":       sn["beat"],
            "score_dur_beats":  sn["dur_beats"],
            "score_abs_beat":   sn["abs_beat"],
            "score_pitch":      sn["pitch"],
        })

    # Sanity check: count how many distinct measures were assigned
    measures_hit = len({ev["measure"] for ev in result})
    total_score_measures = len(measures)
    print(f"[dtw_align] {n} audio events → {measures_hit}/{total_score_measures} score measures covered")
    return result


# ── Objective timing analysis ──────────────────────────────────────────────

# Thresholds. Deliberately conservative: a false "you rushed" is worse than a
# missed one, and these are the first objective timing numbers the product has
# emitted, so they should be revisited once real analyses accumulate.
_TIMING_MIN_NOTES        = 8     # below this a tempo fit isn't trustworthy
_TIMING_MIN_SPB          = 0.12  # sanity band for seconds-per-beat (=500 BPM)
_TIMING_MAX_SPB          = 3.0   # (=20 BPM)
_TIMING_PLACEMENT_MS     = 110.0 # |median residual| in a measure to flag placement
_TIMING_DRIFT_PCT        = 7.0   # local-vs-global tempo delta to call rush/drag
_TIMING_DRIFT_MIN_NOTES  = 3     # notes needed in a measure for a local tempo fit
_TIMING_DUR_SHORT        = 0.60  # actual/expected duration ratio → clipped
_TIMING_DUR_LONG         = 1.65  # → held too long
_TIMING_DUR_MIN_MS       = 140.0 # ignore duration errors smaller than this


def _robust_linear_fit(xs: list[float], ys: list[float]) -> tuple[float, float, list[float]] | None:
    """
    Least-squares fit y = intercept + slope*x, refit twice after trimming outliers
    beyond 2.5x the median absolute residual.

    Plain least squares is badly skewed by a couple of gross outliers — one long
    hesitation would tilt the whole tempo estimate and smear error across every
    other note. Trimming keeps the fit on the notes that were actually in tempo.

    Returns (intercept, slope, residuals_for_all_inputs) or None if degenerate.
    """
    if len(xs) < 3:
        return None
    idx = list(range(len(xs)))
    intercept = slope = 0.0
    for _ in range(3):
        n = len(idx)
        if n < 3:
            return None
        mx = sum(xs[i] for i in idx) / n
        my = sum(ys[i] for i in idx) / n
        sxx = sum((xs[i] - mx) ** 2 for i in idx)
        if sxx <= 1e-9:
            return None
        sxy = sum((xs[i] - mx) * (ys[i] - my) for i in idx)
        slope = sxy / sxx
        intercept = my - slope * mx
        resid_all = [ys[i] - (intercept + slope * xs[i]) for i in range(len(xs))]
        cur = sorted(abs(resid_all[i]) for i in idx)
        mad = cur[len(cur) // 2]
        if mad <= 1e-6:
            break
        keep = [i for i in idx if abs(resid_all[i]) <= 2.5 * mad]
        if len(keep) < 3 or len(keep) == len(idx):
            idx = keep if len(keep) >= 3 else idx
            break
        idx = keep
    residuals = [ys[i] - (intercept + slope * xs[i]) for i in range(len(xs))]
    return intercept, slope, residuals


def analyze_timing_vs_score(
    aligned: list[dict],
    score: dict,
    beats_per_measure: int,
) -> dict:
    """
    Derive objective timing feedback by diffing performed onsets against the
    score's expected beat positions, using the DTW note correspondence.

    This is the "write down what was played and compare it to the sheet music"
    idea, minus the unreliable step: we never transcribe to notation. DTW already
    tells us which score note each performed note is, and MusicXML already gives
    exact beat positions — so the comparison is an alignment problem (solved)
    rather than a transcription problem (not reliably solved).

    Three independent findings, all with real numbers so they need no external
    corroboration to be stated as fact:
      placement — a measure sitting consistently early/late against the tempo
      drift     — a stretch played faster/slower than the piece's own tempo
      duration  — a note held much longer/shorter than written

    Requires score_idx on the aligned events, i.e. score-DTW alignment. Returns
    {"ok": False, "reason": ...} when the input can't support a trustworthy fit;
    the caller should then emit nothing rather than guess.
    """
    bpm_measure = max(1, int(beats_per_measure or 4))

    # Read the matched score note straight off the event (stamped by
    # dtw_align_to_score). Deliberately NOT re-deriving the score note list here:
    # DTW aligns against the played-measure window only, so a list rebuilt with
    # different filtering would misattribute every residual.
    # One onset per score note: the earliest event mapped to it. DTW is
    # many-to-one (a sustained note yields several CREPE events), and only the
    # first marks the attack.
    onset_by_idx: dict[int, dict] = {}
    for ev in aligned:
        si = ev.get("score_idx")
        t  = ev.get("time_sec")
        if si is None or t is None or ev.get("score_abs_beat") is None:
            continue
        if ev.get("confidence", 100) < 25:
            continue
        cur = onset_by_idx.get(si)
        if cur is None or t < cur["time_sec"]:
            onset_by_idx[si] = ev

    if len(onset_by_idx) < _TIMING_MIN_NOTES:
        return {"ok": False, "reason": f"only {len(onset_by_idx)} matched onsets"}

    score_notes = {
        si: {"measure": ev["measure"], "beat": ev.get("score_beat") or 1.0,
             "dur_beats": ev.get("score_dur_beats") or 0.0,
             "pitch": ev.get("score_pitch") or "", "abs_beat": ev["score_abs_beat"]}
        for si, ev in onset_by_idx.items()
    }

    pairs = sorted(
        ((score_notes[si]["abs_beat"], ev["time_sec"], si) for si, ev in onset_by_idx.items()),
        key=lambda p: p[0],
    )
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]

    fit = _robust_linear_fit(xs, ys)
    if fit is None:
        return {"ok": False, "reason": "degenerate tempo fit"}
    intercept, spb, residuals = fit
    if not (_TIMING_MIN_SPB <= spb <= _TIMING_MAX_SPB):
        return {"ok": False, "reason": f"implausible tempo ({spb:.3f} s/beat)"}

    # Per-measure local tempo, used by both findings below.
    per_measure_pairs: dict[int, list[tuple[float, float]]] = {}
    for (abs_beat, t_actual, si) in pairs:
        per_measure_pairs.setdefault(score_notes[si]["measure"], []).append((abs_beat, t_actual))
    local_spb_by_measure: dict[int, float] = {}
    for m, pts in per_measure_pairs.items():
        if len(pts) < _TIMING_DRIFT_MIN_NOTES:
            continue
        lf = _robust_linear_fit([p[0] for p in pts], [p[1] for p in pts])
        if lf is None:
            continue
        if _TIMING_MIN_SPB <= lf[1] <= _TIMING_MAX_SPB:
            local_spb_by_measure[m] = lf[1]

    # ── Drift: local tempo vs the tempo the player ESTABLISHED at the start ──
    # Not vs the global average: if someone plays half the piece steady and then
    # rushes, the global fit lands between the two, and the steady half gets
    # reported as "dragging" — telling a student they slowed down where they in
    # fact played it correctly. Rushing/dragging musically means departing from
    # the tempo you set, so the opening is the honest reference.
    ordered_measures = sorted(per_measure_pairs.keys())
    ref_pts: list[tuple[float, float]] = []
    for m in ordered_measures:
        ref_pts.extend(per_measure_pairs[m])
        if len(ref_pts) >= max(2 * _TIMING_DRIFT_MIN_NOTES, bpm_measure * 2):
            break
    ref_spb = spb
    ref_fit = _robust_linear_fit([p[0] for p in ref_pts], [p[1] for p in ref_pts]) if len(ref_pts) >= 3 else None
    if ref_fit and _TIMING_MIN_SPB <= ref_fit[1] <= _TIMING_MAX_SPB:
        ref_spb = ref_fit[1]

    drift: dict[int, dict] = {}
    for m, local_spb in local_spb_by_measure.items():
        # Positive pct = local seconds-per-beat smaller = playing faster = rushing.
        pct = (ref_spb - local_spb) / ref_spb * 100.0
        if abs(pct) >= _TIMING_DRIFT_PCT:
            drift[m] = {
                "pct":       round(abs(pct), 1),
                "direction": "rushing" if pct > 0 else "dragging",
                "local_bpm": round(60.0 / local_spb, 1),
                "piece_bpm": round(60.0 / ref_spb, 1),
            }

    # ── Placement: per-measure median residual against the global fit ──
    # Only meaningful where the measure is IN the piece's tempo: if the measure
    # is itself a tempo change, its notes are "late" because the passage moved,
    # which the drift finding already says better. Reporting both would blame a
    # tempo change on note placement.
    by_measure: dict[int, list[float]] = {}
    note_rows: list[dict] = []
    for (abs_beat, t_actual, si), resid in zip(pairs, residuals):
        sn = score_notes[si]
        ms = resid * 1000.0
        by_measure.setdefault(sn["measure"], []).append(ms)
        note_rows.append({
            "measure": sn["measure"], "beat": sn["beat"], "pitch": sn["pitch"],
            "time_sec": t_actual, "residual_ms": ms,
        })

    placement: dict[int, dict] = {}
    for m, vals in by_measure.items():
        if m in drift:
            continue
        local_spb = local_spb_by_measure.get(m)
        if local_spb is not None and abs(local_spb - spb) / spb >= 0.05:
            continue  # measure runs at its own tempo — not a placement error
        sv = sorted(vals)
        med = sv[len(sv) // 2]
        if abs(med) >= _TIMING_PLACEMENT_MS:
            worst = max(vals, key=abs)
            placement[m] = {
                "median_ms": round(med, 1),
                "worst_ms":  round(worst, 1),
                "direction": "late" if med > 0 else "early",
                "n":         len(vals),
            }

    # ── Duration: written length vs how long the note actually got ──
    # Only compare consecutive score notes, so the gap really is this note's
    # sounding length and not a jump across something DTW skipped.
    durations: dict[int, dict] = {}
    have = sorted(onset_by_idx.keys())
    for si in have:
        nxt = si + 1
        if nxt not in onset_by_idx:
            continue
        sn = score_notes[si]
        exp_beats = sn.get("dur_beats") or 0.0
        if exp_beats <= 0:
            continue
        expected = exp_beats * spb
        actual   = onset_by_idx[nxt]["time_sec"] - onset_by_idx[si]["time_sec"]
        if expected <= 0 or actual <= 0:
            continue
        ratio = actual / expected
        delta_ms = (actual - expected) * 1000.0
        if abs(delta_ms) < _TIMING_DUR_MIN_MS:
            continue
        if ratio <= _TIMING_DUR_SHORT or ratio >= _TIMING_DUR_LONG:
            m = sn["measure"]
            prev = durations.get(m)
            if prev is None or abs(delta_ms) > abs(prev["delta_ms"]):
                durations[m] = {
                    "beat":      sn["beat"],
                    "pitch":     sn["pitch"],
                    "ratio":     round(ratio, 2),
                    "delta_ms":  round(delta_ms, 1),
                    "direction": "short" if ratio <= _TIMING_DUR_SHORT else "long",
                    "time_sec":  onset_by_idx[si]["time_sec"],
                }

    # One explanation per measure, most-fundamental first. These findings are not
    # independent: a measure entered late also compresses the note before the next
    # on-time entry (a spurious "too short"), and a note held past its length skews
    # that measure's local tempo fit (a spurious "rushing"). Reporting the
    # side-effect instead of the cause would send the student after the wrong fix.
    #   placement (entered early/late)  >  duration (note length)  >  drift (tempo)
    for m in placement:
        durations.pop(m, None)
        drift.pop(m, None)
    for m in durations:
        drift.pop(m, None)

    # Piece-level tempo trend. A gradual accelerando never trips the per-measure
    # threshold (each measure is only ~1% off its neighbour) but still adds up to
    # a large change end-to-end, so compare the opening window with the closing one.
    overall = None
    if len(ordered_measures) >= 4:
        tail_pts: list[tuple[float, float]] = []
        for m in reversed(ordered_measures):
            tail_pts[:0] = per_measure_pairs[m]
            if len(tail_pts) >= max(2 * _TIMING_DRIFT_MIN_NOTES, bpm_measure * 2):
                break
        tail_fit = _robust_linear_fit([p[0] for p in tail_pts], [p[1] for p in tail_pts]) if len(tail_pts) >= 3 else None
        if tail_fit and _TIMING_MIN_SPB <= tail_fit[1] <= _TIMING_MAX_SPB:
            end_spb = tail_fit[1]
            pct = (ref_spb - end_spb) / ref_spb * 100.0
            if abs(pct) >= _TIMING_DRIFT_PCT:
                overall = {
                    "pct":        round(abs(pct), 1),
                    "direction":  "accelerating" if pct > 0 else "slowing",
                    "start_bpm":  round(60.0 / ref_spb, 1),
                    "end_bpm":    round(60.0 / end_spb, 1),
                    "measure_lo": ordered_measures[0],
                    "measure_hi": ordered_measures[-1],
                }

    print(f"[timing] fit {60.0 / spb:.1f} BPM from {len(pairs)} notes | "
          f"placement={len(placement)} drift={len(drift)} duration={len(durations)} "
          f"overall={(overall or {}).get('direction')}")

    return {
        "ok": True,
        "spb": spb,
        "bpm": 60.0 / spb,
        "n_notes": len(pairs),
        "placement": placement,
        "drift": drift,
        "durations": durations,
        "overall": overall,
        "notes": note_rows,
    }


# ── Reference MIDI alignment ───────────────────────────────────────────────

def parse_reference_midi(midi_bytes: bytes, start_measure: int) -> list[dict]:
    """
    Parse a reference MIDI into a flat list of note events with real timing.

    Unlike score DTW (which only uses pitch sequences), reference alignment
    also carries time_sec from the reference performance, letting us invert
    the time-warp function and get accurate measure timestamps in student time.

    Returns: [{"midi": int, "time_sec": float, "measure": int, "beat": float}]
    """
    import tempfile, os
    import music21 as m21

    with tempfile.NamedTemporaryFile(suffix=".mid", delete=False) as f:
        f.write(midi_bytes)
        midi_path = f.name

    try:
        score = m21.converter.parse(midi_path, format="midi")

        # Build a tempo map: list of (offset_quarter_beats, bpm)
        tempo_entries: list[tuple[float, float]] = []
        for el in score.flatten().getElementsByClass(m21.tempo.MetronomeMark):
            if el.number and el.number > 0:
                tempo_entries.append((float(el.offset), float(el.number)))
        if not tempo_entries:
            tempo_entries = [(0.0, 120.0)]
        tempo_entries.sort(key=lambda x: x[0])

        def qb_to_sec(offset_qb: float) -> float:
            """Convert quarter-beat offset to elapsed seconds using the tempo map."""
            elapsed = 0.0
            prev_qb, prev_bpm = 0.0, tempo_entries[0][1]
            for mark_qb, bpm in tempo_entries:
                if mark_qb >= offset_qb:
                    break
                elapsed  += (mark_qb - prev_qb) * (60.0 / prev_bpm)
                prev_qb   = mark_qb
                prev_bpm  = bpm
            elapsed += (offset_qb - prev_qb) * (60.0 / prev_bpm)
            return elapsed

        parts = score.parts
        if not parts:
            return []

        # Use the most note-rich part (likely the solo instrument line)
        source_part = max(parts, key=lambda p: len(p.flatten().notes))

        notes_out: list[dict] = []
        for el in source_part.flatten().notesAndRests:
            if isinstance(el, m21.note.Rest):
                continue
            offset_qb   = float(el.offset)
            time_sec    = qb_to_sec(offset_qb)
            measure_num = getattr(el, "measureNumber", None) or 1

            if isinstance(el, m21.note.Note):
                notes_out.append({
                    "midi":     el.pitch.midi,
                    "time_sec": round(time_sec, 3),
                    "measure":  start_measure + measure_num - 1,
                    "beat":     float(getattr(el, "beat", 1.0)),
                })
            elif isinstance(el, m21.chord.Chord):
                for n in el.notes:
                    notes_out.append({
                        "midi":     n.pitch.midi,
                        "time_sec": round(time_sec, 3),
                        "measure":  start_measure + measure_num - 1,
                        "beat":     float(getattr(el, "beat", 1.0)),
                    })

        notes_out.sort(key=lambda n: n["time_sec"])
        print(f"[parse_reference_midi] {len(notes_out)} notes, "
              f"tempo_entries={tempo_entries[:3]}, "
              f"duration={notes_out[-1]['time_sec']:.1f}s" if notes_out else "empty")
        return notes_out

    except Exception as e:
        print(f"[parse_reference_midi] error: {e}")
        return []
    finally:
        os.unlink(midi_path)


def dtw_align_to_reference(
    events: list[dict],
    ref_notes: list[dict],
    start_measure: int,
) -> tuple[list[dict], list[dict]]:
    """
    Align student CREPE events to a reference MIDI using Dynamic Time Warping.

    This is more accurate than score DTW because:
      - The reference MIDI carries real timing (time_sec per note).
      - DTW finds the optimal pitch alignment.
      - The time-warp path lets us invert reference timestamps into student
        timestamps, giving calibrated measure boundaries in student time.

    Returns:
        (aligned_events, alignment_ranges)
        aligned_events: events with 'measure' assigned from reference
        alignment_ranges: [{"measure": int, "start": float, "end": float}]
    """
    import numpy as np

    if not ref_notes or not events:
        return events, []

    if len(ref_notes) < 4:
        print("[dtw_align_to_reference] reference has <4 notes — skipping")
        return events, []

    # ── Build sequences ────────────────────────────────────────────────────
    audio_midis: list[int | None] = []
    for ev in events:
        pitches = ev.get("pitches", [])
        midi    = midi_from_name(pitches[0]) if pitches else None
        audio_midis.append(midi)

    n      = len(audio_midis)
    m_len  = len(ref_notes)
    ref_midis = [r["midi"] for r in ref_notes]

    # ── Cost matrix ────────────────────────────────────────────────────────
    SILENCE_COST = 6.0
    cost = np.full((n, m_len), SILENCE_COST, dtype=np.float32)
    for i, a_midi in enumerate(audio_midis):
        if a_midi is not None:
            cost[i] = np.abs(np.array(ref_midis, dtype=np.float32) - a_midi)
            cost[i] = np.minimum(cost[i], np.abs(cost[i] - 12) + 3.0)

    # ── DTW with Sakoe-Chiba band ──────────────────────────────────────────
    band = max(4, int(max(n, m_len) * 0.25))
    acc  = np.full((n, m_len), np.inf, dtype=np.float32)
    acc[0, 0] = cost[0, 0]
    for i in range(1, n):
        j_lo = max(0, i - band)
        j_hi = min(m_len - 1, i + band)
        for j in range(j_lo, j_hi + 1):
            candidates = [acc[i - 1, j]]
            if j > 0:
                candidates.extend([acc[i - 1, j - 1], acc[i, j - 1]])
            acc[i, j] = cost[i, j] + min(candidates)

    # ── Traceback ─────────────────────────────────────────────────────────
    path: list[int] = [0] * n
    i, j = n - 1, m_len - 1
    while i > 0 or j > 0:
        path[i] = j
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            prev = min(
                (acc[i - 1, j - 1], 0),
                (acc[i - 1, j],     1),
                (acc[i,     j - 1], 2),
            )
            if prev[1] == 0:   i -= 1; j -= 1
            elif prev[1] == 1: i -= 1
            else:              j -= 1
    path[0] = j

    # ── Assign measures from reference ────────────────────────────────────
    aligned: list[dict] = []
    for idx, ev in enumerate(events):
        ref_idx     = path[idx]
        measure_num = ref_notes[ref_idx]["measure"]
        aligned.append({**ev, "measure": measure_num})

    # ── Build alignment_ranges using the time-warp path ───────────────────
    # For each measure, find the student-time window by inverting the warp:
    # student event[i] aligns with ref_notes[path[i]].
    # Group student event times by their assigned measure.
    ranges_acc: dict[int, dict] = {}
    for idx, ev in enumerate(aligned):
        m = ev["measure"]
        t = ev["time_sec"]
        if m not in ranges_acc:
            ranges_acc[m] = {"start": t, "end": t}
        else:
            ranges_acc[m]["start"] = min(ranges_acc[m]["start"], t)
            ranges_acc[m]["end"]   = max(ranges_acc[m]["end"],   t)

    # Use reference timing to pad measure ends to at least one reference measure length
    ref_measure_dur: dict[int, float] = {}
    for ref_note in ref_notes:
        m = ref_note["measure"]
        if m not in ref_measure_dur:
            ref_measure_dur[m] = 0.0
    # Compute reference measure durations from consecutive measure start times
    sorted_measures = sorted(ref_measure_dur.keys())
    ref_measure_starts: dict[int, float] = {}
    for m in sorted_measures:
        notes_in_m = [r["time_sec"] for r in ref_notes if r["measure"] == m]
        if notes_in_m:
            ref_measure_starts[m] = min(notes_in_m)

    alignment_ranges: list[dict] = []
    for m, r in sorted(ranges_acc.items()):
        # Estimate how long this measure lasted based on the reference duration
        ref_start     = ref_measure_starts.get(m, 0.0)
        next_m        = next((x for x in sorted_measures if x > m), None)
        ref_next_start= ref_measure_starts.get(next_m, ref_start + 2.0) if next_m else ref_start + 2.0
        ref_dur       = max(0.5, ref_next_start - ref_start)

        alignment_ranges.append({
            "measure": m,
            "start":   r["start"],
            "end":     max(r["end"], r["start"] + ref_dur * 0.9),
        })

    measures_hit = len({ev["measure"] for ev in aligned})
    print(f"[dtw_align_to_reference] {n} events → {measures_hit} measures, "
          f"ranges={len(alignment_ranges)}")
    return aligned, alignment_ranges


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
        raw_events = run_pitch_tracking(wav_bytes, guide_times=beats["beat_times"], instrument=instrument)

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
                # Audiveris OMR disabled — takes 60-120s and produces noisy output.
                # Visual scores are read by Claude vision in run_full_analysis instead.
                print(f"[analyze] visual score — skipping Audiveris (handled by Claude vision in async path)")
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

def parse_mmss_to_seconds(t) -> float | None:
    """
    Parse a Gemini timestamp into seconds. Accepts "M:SS", "MM:SS", "H:MM:SS",
    plain seconds ("12", "12.5"), or numbers. Returns None if unparseable.
    """
    if t is None:
        return None
    if isinstance(t, (int, float)):
        return float(t) if t >= 0 else None
    s = str(t).strip()
    if not s:
        return None
    # Strip a leading "0:" hour field is handled by splitting on ":"
    if ":" in s:
        parts = s.split(":")
        try:
            parts_f = [float(p) for p in parts]
        except ValueError:
            return None
        total = 0.0
        for p in parts_f:
            total = total * 60 + p
        return total if total >= 0 else None
    try:
        v = float(s)
        return v if v >= 0 else None
    except ValueError:
        return None


def repair_truncated_json(text: str) -> str | None:
    """
    Rebuild parseable JSON from a reply that was cut off mid-structure.

    A model that hits max_tokens stops mid-object, so the text ends with
    something like `...,{"number":31,"notes":[{"p":"D` — every enclosing bracket
    is still open. Naively taking up to the last `}` just yields a different
    unbalanced fragment, which is why the score read was failing outright and
    losing every measure rather than the last one or two.

    Strategy: walk the text tracking string/escape state so brackets inside
    string literals are ignored, remember the position after the last element
    that closed cleanly, truncate there, then close whatever is still open.
    Returns None if nothing salvageable.
    """
    depth = 0
    in_str = False
    esc = False
    stack: list[str] = []
    last_good: int | None = None      # index just past a completed element
    last_good_stack: list[str] = []

    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in '{[':
            stack.append(ch)
        elif ch in '}]':
            if not stack:
                break
            stack.pop()
            # A complete element inside a container is a safe cut point.
            if stack:
                last_good = i + 1
                last_good_stack = list(stack)

    if last_good is None:
        return None
    head = text[:last_good]
    closers = ''.join(']' if b == '[' else '}' for b in reversed(last_good_stack))
    return head + closers


def extract_json_object(raw: str) -> dict | None:
    import json, re
    # Strip all markdown code fences regardless of position or leading whitespace
    text = re.sub(r'```(?:json)?\s*', '', raw, flags=re.IGNORECASE).strip()
    start = text.find('{')
    end   = text.rfind('}')
    if start == -1:
        return None
    if end != -1:
        try:
            return json.loads(text[start:end + 1])
        except Exception:
            pass
    # Truncated / malformed — salvage the complete portion rather than losing all.
    repaired = repair_truncated_json(text[start:])
    if repaired:
        try:
            obj = json.loads(repaired)
            print(f"[extract_json_object] salvaged truncated JSON ({len(repaired):,} of {len(text):,} chars)")
            return obj
        except Exception:
            return None
    return None


def upload_video_to_gemini(video_bytes: bytes, mime_type: str, api_key: str) -> str:
    """Upload video to Gemini Files API. Raises on failure — never returns None."""
    import httpx, json, time
    boundary = f"gem_{int(time.time() * 1000)}"
    metadata = json.dumps({"file": {"displayName": "practice-recording"}})
    CRLF = "\r\n"
    pre  = f"--{boundary}{CRLF}Content-Type: application/json; charset=UTF-8{CRLF}{CRLF}{metadata}{CRLF}--{boundary}{CRLF}Content-Type: {mime_type}{CRLF}{CRLF}"
    post = f"{CRLF}--{boundary}--"
    body = pre.encode() + video_bytes + post.encode()
    with httpx.Client(timeout=120) as client:
        resp = client.post(
            f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={api_key}&uploadType=multipart",
            content=body,
            headers={"Content-Type": f"multipart/related; boundary={boundary}"},
        )
        if not resp.is_success:
            raise RuntimeError(f"Gemini upload failed {resp.status_code}: {resp.text[:300]}")
        file_data = resp.json()["file"]
        file_id   = file_data["name"].split("/")[-1]
        state     = file_data.get("state", "PROCESSING")
        for attempt in range(20):
            if state == "ACTIVE":
                break
            time.sleep(3)
            poll  = client.get(f"https://generativelanguage.googleapis.com/v1beta/files/{file_id}?key={api_key}")
            state = poll.json().get("state", "UNKNOWN")
            print(f"[upload_video_to_gemini] poll {attempt+1}: state={state}")
        if state != "ACTIVE":
            raise RuntimeError(f"Gemini file never became ACTIVE after 60s (final state: {state})")
        print(f"[upload_video_to_gemini] file ACTIVE: {file_data['uri']}")
        return file_data["uri"]


# Models to try in order — flash first (faster + cheaper), pro as last resort
GEMINI_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
]


def _instrument_guidance(instrument: str) -> str:
    i = instrument.lower()
    if "clarinet" in i:
        return (f"For {instrument} (clarinet): listen for squeaks and cracks at the register break (throat tones: written G#4–Bb4). "
                "Flag every register break squeak. Also flag: chalumeau register (below written B4) sounding unfocused or hollow; "
                "clarion register (written B4–C6) going sharp from over-blowing; weak or breathy tone from insufficient support. "
                "IMPORTANT: clarinet overblows at the 12th (not the octave). When the player is in the chalumeau register, "
                "the strong 12th harmonic can sound in the upper register — do NOT flag this as a wrong note or upper-register issue "
                "unless you are certain the score and the player's embouchure/register key confirm they are in the clarion register. "
                "Only report upper-register intonation or tone issues when the score clearly shows notes above written Bb4.")
    if any(x in i for x in ("flute", "oboe", "bassoon", "saxophone")):
        return (f"For {instrument} (woodwind): listen specifically for squeaks, cracks, and register breaks — flag every one. "
                "Also flag: over-blowing causing pitch to go sharp in the upper register, weak or breathy tone from insufficient air support, "
                "smeared articulation from poor tongue placement, and octave/register key issues.")
    if any(x in i for x in ("trumpet", "trombone", "french horn", "tuba", "horn")):
        return (f"For {instrument} (brass): flag missed lip slurs, clipped valve attacks, notes that don't speak cleanly, "
                "intonation in the upper register (brass plays sharp when overblown), and breath support failures causing notes to cut out.")
    if "violin" in i or "viola" in i:
        return (
            f"For {instrument} (bowed string — unfretted): hold intonation to a high standard; even 15–20 cents off is flaggable. "
            "INTONATION — flag every note or passage that is sharp or flat, including: shifts that land out of tune, "
            "open-string notes that don't resonate with the stopped pitch, and consistent directional drift (e.g. playing sharp in first position). "
            "Name the specific note and estimate the deviation (e.g. 'B4 roughly 25¢ sharp at m.5 beat 2'). "
            "Note: CREPE pitch analysis may miss the extreme high register (above C7); rely on your audio perception there. "
            "BOW TONE — flag bow scratches (excessive weight or bow moving too slowly), sul tasto sound (bow drifting toward the fingerboard), "
            "glassy thin tone (too near the bridge with too little weight), choked or uncontrolled spiccato in slow passages, "
            "and bow changes that click or interrupt the musical line. "
            "STRING CROSSINGS — flag when an adjacent string sounds accidentally, or when the arc of the crossing is abrupt rather than smooth. "
            "SHIFTS — flag late arrivals, out-of-tune landings, and position changes that disrupt the musical line. "
            "VIBRATO — flag absent vibrato in expressive passages, vibrato that starts too late, or vibrato that is too fast/wide/mechanical."
        )
    if "cello" in i:
        return (
            "For cello (bowed string — unfretted): hold intonation to a high standard; even 15–20 cents off is flaggable. "
            "INTONATION — flag every flat or sharp note. Pay extra attention to thumb position passages (above the harmonic node) "
            "where intonation is hardest. Name the note and direction. "
            "BOW TONE — flag bow scratches (too much arm weight at slow speed), glassy unfocused tone (too little weight or contact point too near bridge), "
            "bow changes that bump or click, and inconsistent sounding point. "
            "SHIFTS — flag late arrivals, out-of-tune landings, and shifts that disrupt the phrase. "
            "STRING CROSSINGS — flag any accidental brushing of adjacent strings. "
            "THUMB POSITION — flag intonation instability in thumb position and any excess thumb pressure that damps the string. "
            "VIBRATO — flag absent or mechanical vibrato in lyrical passages."
        )
    if "double bass" in i or ("bass" in i and "bassoon" not in i and "voice" not in i):
        return (
            "For double bass (bowed string — unfretted): "
            "INTONATION — flag every flat or sharp note; intonation is hardest in upper positions and thumb position. "
            "BOW TONE — flag scratchy or grinding tone from heavy arm or slow bow speed, thin tone from too little weight. "
            "RHYTHM — double bass is the harmonic and rhythmic anchor; flag any dragging, rushing, or unsteady pulse. "
            "SHIFTS — flag late arrivals and out-of-tune landings in position changes."
        )
    if any(x in i for x in ("piano", "keyboard")):
        return (f"For {instrument}: flag wrong notes (name the pitch heard vs. expected), notes that don't speak, "
                "pedaling that creates muddiness over incompatible harmonies, and uneven voicing where the melody disappears.")
    if any(x in i for x in ("voice", "soprano", "alto", "tenor")):
        return (f"For {instrument} (voice): flag pitchy passages (name sharp or flat), unstable or overly wide vibrato, "
                "vowel modifications that change pitch, and breath support failures at phrase ends.")
    return "Flag all audible errors: wrong notes, intonation drift, tone issues, and rhythmic problems."


def _technique_visual_guidance(instrument: str) -> str:
    """Per-instrument visual technique prompts for Gemini's video observation."""
    i = instrument.lower()
    if "violin" in i or "viola" in i:
        return (
            f"For {instrument}: "
            "BOW ARM — observe contact point (is the bow between the bridge and fingerboard, or drifting sul tasto toward the fingerboard?); "
            "bow tilt (hair flat vs. tilted — tilting increases clarity); bow distribution (hogging upper or lower half?); "
            "bow speed (too slow and heavy → scratches; too fast and light → thin tone); "
            "bow changes at the frog and tip — do they flow or bump? "
            "RIGHT WRIST — is the wrist flexible through the bow change, or locked? "
            "LEFT HAND — thumb position (gripping the neck rather than resting?); finger curvature (collapsed or arched?); "
            "left wrist alignment (caving under the neck?). "
            "SHOULDER / CHIN REST — is there visible tension in the left shoulder, neck, or jaw? "
            "Is the instrument held level or drooping?"
        )
    if "cello" in i:
        return (
            "For cello: "
            "BOW ARM — contact point (between bridge and fingerboard?); bow arm path (should travel roughly parallel to the bridge); "
            "bow weight (arm hanging freely vs. pressing or lifting?); bow changes — do they flow? "
            "LEFT HAND — thumb position behind the neck (not squeezing); wrist angle in thumb position (should be neutral, not bent); "
            "finger curvature on the fingerboard. "
            "POSTURE — instrument angle on the endpin (too upright or too horizontal?); "
            "is the left elbow swinging freely to support string crossings? "
            "SEAT HEIGHT — is the player leaning forward from the hips or rounding the back?"
        )
    if "double bass" in i or ("bass" in i and "bassoon" not in i):
        return (
            "For double bass: "
            "BOW ARM — contact point (near the bridge for focused tone); bow arm path; "
            "bow weight (arm weight vs. active pressing?). "
            "LEFT HAND — thumb release in upper positions (thumb should come off the back of the neck); "
            "finger spacing and curvature on the fingerboard. "
            "STANDING POSTURE — instrument angle and player stance; is the back rounded or upright?"
        )
    if any(x in i for x in ("piano", "keyboard")):
        return ("For piano: observe finger curvature (curved vs. flat fingers), wrist height (collapsing below keys?), "
                "arm weight into keys vs. arm tension, pedal foot position, and overall bench height and distance.")
    if any(x in i for x in ("clarinet", "saxophone", "oboe", "bassoon")):
        return (f"For {instrument}: observe instrument angle relative to body, embouchure shape if visible, "
                "finger position over keys (hovering close vs. far), and general posture (shoulders hunched?).")
    if any(x in i for x in ("flute",)):
        return ("For flute: observe head position (tilting down to see keys?), embouchure plate angle, "
                "finger spacing over keys, and any visible tension in the right wrist or arm.")
    if any(x in i for x in ("trumpet", "trombone", "french horn", "tuba", "horn")):
        return (f"For {instrument} (brass): observe embouchure angle and pressure, posture (slumped vs. upright), "
                "breath support posture (diaphragm engagement visible?), and slide/valve hand position.")
    if any(x in i for x in ("voice", "soprano", "alto", "tenor", "bass")):
        return ("For voice: observe posture (chin jutting forward, shoulders raised?), jaw tension, "
                "visible breath support (stomach vs. chest breathing), and general tension in neck/throat.")
    return ("Observe general posture: slouching, raised shoulders, excessive tension in arms or hands, "
            "and any visible mechanical issues with how the instrument is being held or operated.")


def get_measure_positions_gemini(
    score_bytes: bytes, score_mime: str, api_key: str
) -> dict[int, tuple[float, float]]:
    """
    Send the score image to Gemini and ask for the center (x_pct, y_pct) of each
    visible measure, where 0,0 = top-left and 100,100 = bottom-right of the image.
    Returns {measure_number: (x_pct, y_pct)} — empty dict on any failure.
    """
    import httpx, base64, json as _json
    prompt = (
        "You are looking at a sheet music score image. "
        "For every measure visible on the page, identify the approximate center point "
        "as a percentage of the image dimensions (x=0 is the left edge, x=100 is the right; "
        "y=0 is the top edge, y=100 is the bottom). "
        "Use the printed measure numbers if visible; otherwise number sequentially from 1. "
        "Return ONLY valid JSON, no markdown:\n"
        "{\"measures\": [{\"number\": <int>, \"x_pct\": <float>, \"y_pct\": <float>}]}"
    )
    b64 = base64.b64encode(score_bytes).decode()
    parts = [
        {"inlineData": {"mimeType": score_mime, "data": b64}},
        {"text": prompt},
    ]
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}",
                json={
                    "contents": [{"parts": parts}],
                    "generationConfig": {"temperature": 0, "maxOutputTokens": 2048, "responseMimeType": "application/json"},
                },
            )
        if not resp.is_success:
            print(f"[measure_positions] HTTP {resp.status_code}")
            return {}
        data = resp.json()
        resp_parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        text = next((p["text"] for p in resp_parts if "text" in p), "")
        text = text.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
        parsed = _json.loads(text)
        result = {}
        for m in parsed.get("measures", []):
            n = m.get("number")
            x = m.get("x_pct")
            y = m.get("y_pct")
            if n is not None and x is not None and y is not None:
                result[int(n)] = (float(x), float(y))
        print(f"[measure_positions] got positions for {len(result)} measures")
        return result
    except Exception as e:
        print(f"[measure_positions] failed: {e}")
        return {}


def evaluate_with_gemini(
    file_uri: str, mime_type: str,
    instrument: str, piece_title: str, composer: str,
    start_measure: int, end_measure: int | None,
    api_key: str,
    user_note: str = "",
    score_bytes: bytes | None = None,
    score_mime: str | None = None,
) -> dict:
    """
    Audio/video analysis via Gemini. When score_bytes is provided, Gemini receives
    both the score image and the recording, enabling direct score-to-audio comparison
    and accurate printed measure number reporting.
    Raises if ALL models fail — never returns None.
    """
    import httpx, base64
    end_info = f" through measure {end_measure}" if end_measure else ""
    instrument_guidance = _instrument_guidance(instrument)
    technique_guidance  = _technique_visual_guidance(instrument)
    note_block = (
        f'\nSTUDENT NOTE about this recording (subjective context — always prioritize what you actually HEAR/SEE over this; '
        f'use it only to interpret ambiguous moments, never to invent or excuse audible problems): "{user_note}"\n'
        if user_note else ""
    )

    has_score = bool(score_bytes and score_mime)
    score_block = f"""
SHEET MUSIC: You have the score image above. Read the printed measure numbers directly off the page (look for numbers printed above/below the staff, or boxed rehearsal marks which indicate measure numbers).

WHERE THE RECORDING STARTS — CRITICAL: The student's recording BEGINS at printed measure {start_measure}. The very FIRST note you hear (at 0:00) is measure {start_measure} in the score — NOT the first measure printed at the top of the page. The student did NOT play any measures before {start_measure}; ignore everything printed before measure {start_measure}. Align every note you hear to the score starting from measure {start_measure} and count forward from there.

When reporting issues, give the EXACT PRINTED measure number from the score. Every measure number you report MUST be {start_measure} or higher — never report a measure below {start_measure}, because the student did not play those.
IMPORTANT: Only flag issues during passages where notes are written in the score. Do NOT flag anything heard during rests, between phrases, or in silence — even if there is ambient sound or breathing audible in the recording. If a measure contains only rests, skip it entirely.
""" if has_score else f"""
No score image provided. The recording starts at measure {start_measure}. Use timestamps only. Every measure number you report MUST be {start_measure} or higher.
IMPORTANT: Only flag issues during passages where the student is actively playing. Do NOT flag sounds heard during rests, breaths, or silence between phrases.
"""

    prompt = f"""PERFORMANCE ANALYSIS TASK. You are analyzing a student's recording of "{piece_title}" by {composer} on {instrument}.
{score_block}
You have access to BOTH the audio AND the video. Listen carefully to the sound for categories 1–5. Observe the player visually for categories 6–7.

CRITICAL — EXAMINE EVERY MEASURE THAT WAS PLAYED, ONE BY ONE:
- Go through the recording measure by measure, from the FIRST measure the student plays to the LAST. Do not sample or summarize — actually inspect each measure in order.
- For EACH played measure, check all seven categories below. If that measure has any issue (even a small one), report it with the measure's timestamp. If a measure is genuinely clean, move on — but you must have considered it.
- The recording may be several minutes long. A typical performance has issues in MANY measures, not just 3-5. It is normal and expected to return 10, 20, or more issues spread across the whole piece. Do NOT stop early or condense the whole piece into a few findings.
- Each issue must carry the correct timestamp for WHERE it occurs in the recording (measured from the start). Issues late in the piece get late timestamps.
- You may report multiple issues in the same measure (e.g. a wrong note AND a dynamics problem). Report each separately.
- Report single-note problems (a crack, one wrong pitch) individually; report sustained problems across a phrase once for that passage.

PASSAGES / MEASURE RANGES — when an issue spans several measures, mark the whole range:
- If a problem continues across multiple measures (a phrase that rushes throughout, a long crescendo that never arrives, the whole piece playing flat), set "measure" to the FIRST measure and "measure_end" to the LAST measure of that passage, and set "time" / "time_end" to the start/end timestamps of the passage.
- Use a range when the issue is genuinely sustained. For a problem confined to one measure, omit "measure_end" (or set it equal to "measure").
- It is fine to mark the entire piece (e.g. "measure": 1, "measure_end": 40) if a single issue truly persists throughout.

{instrument_guidance}
{note_block}
MANDATORY — address all seven categories. Do not skip any:

1. INTONATION (listen): Every passage where pitch is audibly flat or sharp. Give measure number (from the score if available, else timestamp), direction (flat/sharp), and magnitude. If clean, say so.

2. TIMING / RHYTHM (listen): Rushing, dragging, uneven spacing, hesitations, beat instability. Give measure number or timestamp. If solid, say so.

3. WRONG NOTES / CRACKS (listen): Any pitch that doesn't belong, squeaks, tone breaks. Name the note heard if possible.

4. DYNAMICS (listen): Where the student ignores or fails dynamic markings. Is forte actually forte? Does piano recede?

5. TONE QUALITY (listen): Breathy, unfocused, over-pressured, or inconsistent tone. When and where?

6. POSTURE (visual): Observe head/neck alignment, shoulder tension, overall body posture, and how the instrument is supported. If the player is not visible in the frame, write "not visible".

7. TECHNIQUE (visual): {technique_guidance} If not clearly observable from this camera angle, write "not visible".

Be specific. For each issue include:
- The PRINTED measure number from the score (e.g. "m.14") — read it directly off the page if the score is provided
- The timestamp in the recording (e.g. "0:08")
- Direction (sharp/flat), magnitude, specific note or passage

TIMESTAMP ACCURACY IS THE MOST IMPORTANT FIELD — the exact location of each issue is computed from its timestamp, so get the time right:
- Give the REAL elapsed time in the recording when each issue occurs ("M:SS"), measured from the start of the audio (0:00 = the first note).
- Different issues happen at DIFFERENT times — never reuse the same timestamp for multiple issues. An issue near the end of a 2-minute recording must have a timestamp near 2:00, not 0:20.
- For the "measure" field, give your best reading of the printed measure number, but do NOT agonize over it or re-count repeatedly — the timestamp is what we rely on. Just make sure a later timestamp never gets an earlier measure.

Return JSON only (no markdown fences). Each issue MUST be an object with "measure" (int — the printed number from the score, or {start_measure} if no score), "time" (string "M:SS"), and "description" (string):
Each issue object may ALSO include "measure_end" (int) and "time_end" ("M:SS") when the issue spans a passage of several measures — omit both for a single-measure issue.
{{
  "intonation_issues": [{{"measure": <int>, "measure_end": <int|omit>, "time": "<M:SS>", "time_end": "<M:SS|omit>", "description": "<note/passage> sounds <sharp|flat> by <magnitude>"}}],
  "rhythm_issues": [{{"measure": <int>, "measure_end": <int|omit>, "time": "<M:SS>", "time_end": "<M:SS|omit>", "description": "<specific observation>"}}],
  "wrong_notes_cracks": [{{"measure": <int>, "measure_end": <int|omit>, "time": "<M:SS>", "time_end": "<M:SS|omit>", "description": "<what was heard vs. expected>"}}],
  "dynamics_issues": [{{"measure": <int>, "measure_end": <int|omit>, "time": "<M:SS>", "time_end": "<M:SS|omit>", "description": "<marking expected vs. what was played>"}}],
  "tone_issues": [{{"measure": <int>, "measure_end": <int|omit>, "time": "<M:SS>", "time_end": "<M:SS|omit>", "description": "<specific description>"}}],
  "posture_issues": ["<specific observation with timestamp if relevant>"],
  "technique_issues": ["<specific observation with timestamp if relevant>"],
  "overall": "<one sentence: the single most important thing to fix>"
}}"""

    # Build Gemini request parts
    parts: list = []
    if has_score:
        b64_score = base64.b64encode(score_bytes).decode()
        parts.append({"inlineData": {"mimeType": score_mime, "data": b64_score}})
    parts.append({"fileData": {"mimeType": mime_type, "fileUri": file_uri}})
    parts.append({"text": prompt})

    # gemini-2.5 models "think" before answering, and thinking tokens count against
    # maxOutputTokens. With a heavy prompt they can burn the whole budget thinking and
    # return an EMPTY response (finishReason MAX_TOKENS, no text). We bound thinking so
    # tokens are reserved for the actual JSON. Each model is tried with a couple of
    # configs so that if the API rejects `thinkingConfig` we still fall back cleanly.
    def _configs_for(model: str) -> list[dict]:
        think_budget = 0 if "flash" in model else 512
        return [
            {"temperature": 0, "maxOutputTokens": 16384, "responseMimeType": "application/json",
             "thinkingConfig": {"thinkingBudget": think_budget}},
            # Fallback if thinkingConfig is rejected: no thinking cap, but a much larger
            # ceiling so thinking + JSON both fit.
            {"temperature": 0, "maxOutputTokens": 40000, "responseMimeType": "application/json"},
        ]

    def _extract_text(data: dict) -> tuple[str, str]:
        cand = (data.get("candidates") or [{}])[0]
        resp_parts = cand.get("content", {}).get("parts", [])
        text = next((p.get("text", "") for p in resp_parts if not p.get("thought") and p.get("text", "").strip()), "")
        if not text:
            text = next((p.get("text", "") for p in resp_parts if p.get("text", "").strip()), "")
        return text, str(cand.get("finishReason", "?"))

    # Transient upstream failures — capacity spikes and gateway blips, not our
    # request being wrong. Previously each model/config was attempted exactly
    # once with no backoff, so a momentary "high demand" 503 on Gemini failed the
    # entire analysis and threw away the user's upload. These clear on a retry
    # seconds later, which is cheaper than making the student re-record.
    _TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504}
    _RETRY_BUDGET_S   = 100.0   # total time we may spend sleeping between retries
    _MAX_ATTEMPTS     = 3
    import time as _time, random as _random
    _retry_deadline = _time.monotonic() + _RETRY_BUDGET_S

    def _post_gemini(model: str, gen_config: dict):
        url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
               f"{model}:generateContent?key={api_key}")
        body = {"contents": [{"parts": parts}], "generationConfig": gen_config}
        attempt = 0
        while True:
            attempt += 1
            with httpx.Client(timeout=150) as client:
                resp = client.post(url, json=body)
            if resp.is_success or resp.status_code not in _TRANSIENT_STATUS:
                return resp
            if attempt >= _MAX_ATTEMPTS or _time.monotonic() >= _retry_deadline:
                return resp
            # Honour Retry-After when the server sends one; otherwise exponential
            # backoff with jitter so parallel takes don't retry in lockstep.
            ra = (resp.headers.get("Retry-After") or "").strip()
            delay = float(ra) if ra.isdigit() else min(8.0, 1.5 * (2 ** (attempt - 1)))
            delay = min(delay, max(0.0, _retry_deadline - _time.monotonic())) + _random.uniform(0, 0.4)
            print(f"[evaluate_with_gemini] {model} → HTTP {resp.status_code} "
                  f"(transient, attempt {attempt}/{_MAX_ATTEMPTS}) — retrying in {delay:.1f}s")
            _time.sleep(delay)

    last_error = "no models attempted"
    last_status = None
    for model in GEMINI_MODELS:
        try:
            text = ""
            for gen_config in _configs_for(model):
                resp = _post_gemini(model, gen_config)
                if not resp.is_success:
                    last_status = resp.status_code
                    last_error = f"{model} → HTTP {resp.status_code}: {resp.text[:200]}"
                    print(f"[evaluate_with_gemini] {last_error}")
                    if resp.status_code in (401, 403):
                        raise RuntimeError(f"Gemini auth error ({resp.status_code}) — check GOOGLE_AI_API_KEY")
                    continue  # try next config for this model
                data = resp.json()
                text, finish = _extract_text(data)
                if text:
                    break  # got a usable response
                last_error = f"{model} → empty response (finishReason={finish})"
                print(f"[evaluate_with_gemini] {last_error} | usage={data.get('usageMetadata')}")
            if not text:
                continue  # all configs for this model failed → next model
            parsed = extract_json_object(text)
            if not parsed:
                last_error = f"{model} → JSON parse failed"
                print(f"[evaluate_with_gemini] {last_error}: {text[:200]}")
                continue
            print(f"[evaluate_with_gemini] success via {model} | overall: {str(parsed.get('overall', ''))[:120]}")
            def _vis(items) -> list:
                if not items: return []
                return [x for x in items if "not visible" not in str(x).lower()]
            def _norm(items) -> list:
                """Normalise to list-of-dicts; accept both old string format and new {measure,time,description}."""
                if not items: return []
                out = []
                for x in items:
                    if isinstance(x, dict):
                        out.append(x)
                    elif isinstance(x, str) and x and "not visible" not in x.lower():
                        out.append({"measure": start_measure, "time": "", "description": x})
                return out
            return {
                "intonation_issues":   _norm(parsed.get("intonation_issues", [])),
                "rhythm_issues":       _norm(parsed.get("rhythm_issues", [])),
                "wrong_notes_cracks":  _norm(parsed.get("wrong_notes_cracks", [])),
                "dynamics_issues":     _norm(parsed.get("dynamics_issues", [])),
                "tone_issues":         _norm(parsed.get("tone_issues", [])),
                "posture_issues":      _vis(parsed.get("posture_issues", [])),
                "technique_issues":    _vis(parsed.get("technique_issues", [])),
                "overall":             parsed.get("overall", ""),
            }
        except RuntimeError:
            raise
        except Exception as e:
            last_error = f"{model} → {e}"
            print(f"[evaluate_with_gemini] {last_error}")
            continue

    # A capacity spike is temporary and not the student's fault — say so plainly
    # instead of surfacing a raw provider JSON blob, which reads like the upload
    # was broken and invites them to re-record for no reason.
    if last_status in (429, 503):
        raise RuntimeError(
            "The analysis service is temporarily overloaded (the AI provider is at "
            "capacity right now). Your recording was uploaded fine — press Try again "
            "in a minute and it should go through."
        )
    raise RuntimeError(f"All Gemini models failed. Last error: {last_error}")


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

MEASURE NUMBERING — THE MOST IMPORTANT PART OF THIS TASK. Get this wrong and every piece of feedback points at the wrong bar.

1. The printed numbers on the page are the ONLY source of truth. These are the small boxed numbers above the staff (e.g. 12, 20, 38, 50, 58). Assign them exactly as printed.
2. MULTIRESTS CONSUME MEASURE NUMBERS. A bar drawn as a thick horizontal block with a number over it (e.g. "11", "4", "2") is that many WHOLE MEASURES of rest, not one measure. If a multirest of 11 sits before the bar printed "12", then those 11 rest measures are measures 1-11. After a multirest of N, the next measure number is (current + N). Skipping a multirest without advancing the count is the single most common way to get this wrong.
3. Number every measure continuously across the whole line, including measures that contain only rests. You will NOT output the rest measures (see below) — but they must still consume their numbers, so the measures you DO output carry their true printed numbers.
4. Therefore the "number" values you output will normally have GAPS in them (e.g. ... 37, then 40 ...). That is correct and expected. A perfectly consecutive 1,2,3,4... run is almost always a sign you renumbered — do not do that.
5. Do NOT start counting from the student's starting measure, and do not renumber to make the first measure you see come out as any particular value. Only if the page shows no printed numbers anywhere should you count barlines, and in that case the FIRST measure in the image is measure 1.

Time signature hint: {time_sig}. Use what you see in the image if different.

Return every measure that CONTAINS AT LEAST ONE SOUNDED NOTE, in order. Omit measures that are entirely rest (including multirests) — but per the numbering rules above, they still consume their measure numbers. For each sounded note (skip rests):
- "p": pitch in scientific notation ("D3", "F#4") — null only if notehead present but pitch unreadable
- "b": beat position in measure (1.0 = downbeat)
- "d": duration in beats
- "a": articulation — "staccato", "tenuto", "accent", or null
- "dyn": dynamic marking at this note — "pp","p","mp","mf","f","ff","cresc","dim", or null

Use short field names to keep the JSON compact. Return JSON only (no markdown):
{{
  "key_signature": "...",
  "time_signature": "...",
  "tempo_marking": "...",
  "measures": [{{"number": {start_measure}, "notes": [{{"p": "D3", "b": 1.0, "d": 1.5, "a": null, "dyn": "p"}}]}}]
}}"""

    try:
        client = ac.Anthropic(api_key=anthropic_api_key)
        # MUST stream. A full score is one JSON object per NOTE, so a couple of
        # pages easily exceeded the old max_tokens=8192 and got cut off
        # mid-object, which failed the whole parse and silently dropped every
        # measure (score_parse: 0) — disabling DTW alignment, objective timing
        # and wrong-note checks. But simply raising max_tokens is not enough:
        # above roughly 20k the SDK refuses a non-streaming request outright
        # ("Streaming is required for operations that may take longer than 10
        # minutes"), which turned the truncation into a hard error. Streaming is
        # the supported way to ask for a long generation.
        with client.messages.stream(
            model="claude-sonnet-4-6",
            max_tokens=32000,
            messages=[{"role": "user", "content": [vision_part, {"type": "text", "text": prompt}]}],
        ) as stream:
            msg = stream.get_final_message()
        raw    = msg.content[0].text
        if getattr(msg, "stop_reason", None) == "max_tokens":
            print(f"[read_score_notes_claude] hit max_tokens ({len(raw):,} chars) — "
                  f"salvaging the complete measures")
        parsed = extract_json_object(raw)
        if not parsed:
            # Log the TAIL too: for a truncation the head always looks fine, so
            # head-only logging hid the real cause.
            print(f"[read_score_notes_claude] no JSON | stop_reason="
                  f"{getattr(msg, 'stop_reason', None)} len={len(raw):,} "
                  f"| head: {raw[:200]} | tail: {raw[-200:]}")
            # Regex fallback: extract at least time/key signature even from truncated JSON
            import re as _re
            ts_m = _re.search(r'"time_signature"\s*:\s*"([^"]+)"', raw)
            ks_m = _re.search(r'"key_signature"\s*:\s*"([^"]+)"', raw)
            if ts_m or ks_m:
                print(f"[read_score_notes_claude] partial extract: ts={ts_m and ts_m.group(1)} ks={ks_m and ks_m.group(1)}")
                return {
                    "key_signature":  ks_m.group(1) if ks_m else None,
                    "time_signature": ts_m.group(1) if ts_m else None,
                    "tempo_marking":  None,
                    "measures":       [],
                    "source":         "claude_vision_partial",
                }
            return {"key_signature": None, "time_signature": None, "tempo_marking": None,
                    "measures": [], "error": "unparseable JSON from score read"}
        def _norm_note(n: dict) -> dict:
            # Accept both old long names (pitch/beat/duration_beats/articulation/dynamic)
            # and new compact names (p/b/d/a/dyn) — normalize to long form.
            return {
                "pitch":          n.get("pitch") or n.get("p"),
                "beat":           n.get("beat")  if n.get("beat")  is not None else n.get("b"),
                "duration_beats": n.get("duration_beats") if n.get("duration_beats") is not None else n.get("d"),
                "articulation":   n.get("articulation") or n.get("a"),
                "dynamic":        n.get("dynamic") or n.get("dyn"),
            }
        measures = [
            {**m, "notes": [
                _norm_note(n) for n in m.get("notes", [])
                if str(n.get("pitch") or n.get("p", "")).lower() != "rest"
            ]}
            for m in (parsed.get("measures") or [])
            if isinstance(m.get("notes"), list)
        ]
        # DO NOT renumber to start at start_measure. This used to force
        # m["number"] = start_measure + i for every measure, which threw away the
        # printed numbers the prompt works hard to read and replaced them with a
        # consecutive run. Two things break as a result:
        #   * start_measure is where the STUDENT began playing, which is not where
        #     the PHOTO begins — a photo of the whole part renumbered so its first
        #     bar became m.20 shifted every label by the difference.
        #   * consecutive numbering cannot represent multirests. This part opens
        #     with an 11-bar rest and has 2/2/4-bar rests later; those consume
        #     measure numbers, so real numbering has gaps and the offset grows
        #     through the piece.
        # Symptom was a flag labelled m.30 whose Loop clip played printed m.20.
        # Keep whatever the page says; only repair entries that are unusable.
        _prev = None
        for i, m in enumerate(measures):
            try:
                n = int(m.get("number"))
            except (TypeError, ValueError):
                n = None
            # Numbers must be strictly increasing; anything else is a misread.
            if n is None or (_prev is not None and n <= _prev):
                n = (_prev + 1) if _prev is not None else start_measure
            m["number"] = n
            _prev = n
        total_notes = sum(len(m["notes"]) for m in measures)
        if measures:
            _nums = [m["number"] for m in measures]
            _gaps = sum(1 for a, b in zip(_nums, _nums[1:]) if b != a + 1)
            print(f"[read_score_notes_claude] {len(measures)} measures "
                  f"m.{_nums[0]}-{_nums[-1]}, {total_notes} notes, {_gaps} numbering gap(s) "
                  f"(gaps are expected wherever the part has multirests)")
            if _gaps == 0 and _nums[0] == start_measure and len(_nums) > 8:
                print("[read_score_notes_claude] WARNING: numbering is perfectly "
                      "consecutive from start_measure — printed numbers may have been "
                      "ignored; measure labels could be offset from the page")
        else:
            print(f"[read_score_notes_claude] {len(measures)} measures, {total_notes} notes")
        return {
            "key_signature":  parsed.get("key_signature"),
            "time_signature": parsed.get("time_signature"),
            "tempo_marking":  parsed.get("tempo_marking"),
            "measures":       measures,
            # Was missing entirely on the success path — without it, run_full_analysis's
            # DTW-eligibility check ("claude_vision" in score_source) could never be true
            # for a successful photo-score parse, silently forcing every take with a
            # photo score (rather than MusicXML) onto the far less accurate beat-grid
            # alignment method regardless of how many notes were actually read.
            "source":         "claude_vision",
        }
    except Exception as e:
        # Surface the reason on the dict so it reaches pipeline_debug. A failed
        # score read silently disables DTW, objective timing and wrong-note
        # checks, so "score_parse: 0 measures" with no reason is not diagnosable
        # from the take row alone — it cost a full round trip to Modal logs.
        print(f"[read_score_notes_claude] error: {e}")
        return {"key_signature": None, "time_signature": None, "tempo_marking": None,
                "measures": [], "error": f"{type(e).__name__}: {e}"}


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


def build_gemini_block(assessment: dict) -> str:
    """
    Format Gemini's assessment for the Claude coaching prompt.
    Tier B items (intonation/rhythm/wrong-notes) that were not corroborated
    by CREPE signal analysis are labelled [UNCONFIRMED] so Claude uses
    appropriately hedged language for them.
    """
    def fmt_structured(items: list) -> str:
        if not items: return "None reported."
        parts = []
        for x in items:
            if isinstance(x, dict):
                m   = x.get("measure", "?")
                t   = x.get("time", "")
                d   = x.get("description", "")
                loc = f"m.{m}" + (f" ({t})" if t else "")
                confirmed = x.get("_confirmed", True)  # Tier A items always True
                if confirmed:
                    parts.append(f"{loc}: {d}")
                else:
                    note = x.get("_crepe_note", "not corroborated by signal analysis")
                    parts.append(f"[UNCONFIRMED — {note}] {loc}: {d}")
            else:
                parts.append(str(x))
        return " | ".join(parts)
    def fmt_plain(items: list) -> str:
        if not items: return "None reported."
        return " | ".join(str(x) for x in items)
    lines = [
        "GEMINI ANALYSIS (Gemini compared the sheet music + recording simultaneously):",
        f"- Intonation: {fmt_structured(assessment.get('intonation_issues', []))}",
        f"- Rhythm/Timing: {fmt_structured(assessment.get('rhythm_issues', []))}",
        f"- Wrong notes / cracks: {fmt_structured(assessment.get('wrong_notes_cracks', []))}",
        f"- Dynamics: {fmt_structured(assessment.get('dynamics_issues', []))}",
        f"- Tone quality: {fmt_structured(assessment.get('tone_issues', []))}",
        f"- Posture (visual): {fmt_plain(assessment.get('posture_issues', []))}",
        f"- Technique (visual): {fmt_plain(assessment.get('technique_issues', []))}",
        f"- Overall: {assessment.get('overall') or 'No overall note.'}",
    ]
    return "\n".join(lines)


def _safe_measure_int(val) -> int | None:
    try: return int(val)
    except (TypeError, ValueError): return None


def _cross_check_gemini_tier_b(
    assessment: dict,
    events_by_measure: dict,
    wrong_note_candidates: list,
    evidence_candidates: list,
    cents_threshold: int,
) -> dict:
    """
    Annotate Tier B Gemini items (intonation, rhythm, wrong-notes) with
    _confirmed=True|False and _crepe_note=<reason string>.

    Tier A items (tone, dynamics, posture, technique) are left unchanged —
    Gemini is the primary (often only) source for those categories.

    Returns a shallow copy of the assessment with Tier B items annotated.
    """
    import re as _re, copy

    annotated = dict(assessment)  # shallow — we'll replace each list

    # Build measure sets from CREPE evidence strings
    inton_measures: set[int] = set()
    timing_measures: set[int] = set()
    for cand in evidence_candidates:
        m_match = _re.search(r'measure (\d+)', cand)
        if not m_match: continue
        m = int(m_match.group(1))
        if cand.startswith("intonation |"):
            inton_measures.add(m)
        elif cand.startswith("timing |"):
            timing_measures.add(m)

    wrong_note_measures: set[int] = set()
    for cand in wrong_note_candidates:
        m_match = _re.search(r'measure (\d+)', cand)
        if m_match:
            wrong_note_measures.add(int(m_match.group(1)))

    def _check(item: dict, ftype: str) -> tuple[bool, str]:
        if not isinstance(item, dict):
            return True, ""
        m = _safe_measure_int(item.get("measure"))
        if m is None:
            return True, "measure unparseable — keeping"
        ev_list = events_by_measure.get(m, [])
        n_events = len(ev_list)

        if ftype == "intonation":
            if m in inton_measures:
                return True, f"CREPE detected deviation at m.{m}"
            # Also check raw event cents directly (catches cases not in evidence_candidates)
            has_dev = any(
                ev.get("cents_offset") is not None
                and abs(ev.get("cents_offset", 0)) >= cents_threshold
                for ev in ev_list
            )
            if has_dev:
                return True, f"CREPE detected deviation at m.{m}"
            if not ev_list:
                return False, f"no CREPE events at m.{m} (coverage gap)"
            return False, f"CREPE covered m.{m} ({n_events} events) — no deviation ≥{cents_threshold}¢"

        elif ftype in ("timing", "rhythm"):
            if m in timing_measures:
                return True, f"CREPE timing anomaly at m.{m}"
            if not ev_list:
                return False, f"no CREPE events at m.{m} (coverage gap)"
            return False, f"CREPE covered m.{m} ({n_events} events) — no timing anomaly"

        elif ftype == "error":
            if m in wrong_note_measures:
                return True, f"CREPE pitch mismatch at m.{m}"
            if not ev_list:
                return False, f"no CREPE events at m.{m} (coverage gap)"
            return False, f"CREPE covered m.{m} — no wrong-note candidate"

        return True, ""  # Tier A — always confirmed

    TIER_B = {
        "intonation_issues": "intonation",
        "rhythm_issues":     "rhythm",
        "wrong_notes_cracks": "error",
    }
    for cat, ftype in TIER_B.items():
        items = assessment.get(cat, [])
        annotated_items = []
        n_conf = n_unconf = 0
        for item in items:
            ok, reason = _check(item, ftype)
            if isinstance(item, dict):
                item = {**item, "_confirmed": ok, "_crepe_note": reason}
                if ok: n_conf += 1
                else:  n_unconf += 1
            annotated_items.append(item)
        annotated[cat] = annotated_items
        if items:
            print(f"[tier_b_check] {cat}: {n_conf} confirmed, {n_unconf} unconfirmed")

    return annotated


def find_wrong_note_candidates(
    aligned: list[dict],
    score: dict,
) -> list[str]:
    """
    Direct CREPE-vs-score comparison to surface wrong note candidates.

    For each aligned audio event, compute the distance (in semitones) to the
    nearest expected note in that measure. Events that are ≥2 semitones from
    every expected note — and not explained by octave transposition — are
    flagged as wrong note candidates and formatted as evidence strings for
    the Claude coaching prompt.
    """
    if not aligned or not score.get("measures"):
        return []

    # Build map: measure_number → list of expected MIDI pitches
    score_by_measure: dict[int, list[int]] = {}
    for m in score["measures"]:
        midis = []
        for n in m.get("notes", []):
            midi = midi_from_name(n.get("pitch", ""))
            if midi is not None:
                midis.append(midi)
        if midis:
            score_by_measure[m["number"]] = midis

    if not score_by_measure:
        return []

    # Track one candidate per measure (highest confidence)
    best: dict[int, tuple[int, str]] = {}  # measure → (confidence, evidence_string)
    for ev in aligned:
        m_num   = ev.get("measure")
        ev_midi = ev.get("midi_raw", ev.get("midi"))  # prefer unclamped for accurate comparison
        ev_conf = ev.get("confidence", 0)
        if m_num is None or ev_midi is None or ev_conf < 50:
            continue
        expected = score_by_measure.get(m_num)
        if not expected:
            continue

        raw_dists = [abs(ev_midi - e) for e in expected]
        min_dist  = min(raw_dists)

        # Pitch-class distance (mod 12, circular) — octave transpositions have
        # pc_dist == 0 and must not be flagged as wrong notes.
        ev_pc       = ev_midi % 12
        pc_dists    = [min(abs(ev_pc - (e % 12)), 12 - abs(ev_pc - (e % 12))) for e in expected]
        min_pc_dist = min(pc_dists)

        if min_dist >= 2 and min_pc_dist >= 2:
            nearest = min(expected, key=lambda e: abs(ev_midi - e))
            desc = (
                f"wrong_note | measure {m_num} | "
                f"CREPE detected {midi_to_scientific(ev_midi)} ({ev.get('pitch_hz', 0):.0f} Hz, conf={ev_conf}%), "
                f"closest expected {midi_to_scientific(nearest)} ({min_dist} semitones away) "
                f"at t={ev['time_sec']:.2f}s"
            )
            prev = best.get(m_num)
            if prev is None or ev_conf > prev[0]:
                best[m_num] = (ev_conf, desc)

    candidates = [v[1] for v in sorted(best.values(), key=lambda x: -x[0])]
    return candidates[:20]


# ── Change 2: severity-weighted score formula ─────────────────────────────────
# Base weights by flag type. `magnitude` names the field on the flag dict that
# holds a numeric deviation value; None means no magnitude scaling.
# Tune these values without touching the formula — the formula reads from here.
FLAG_WEIGHTS: dict[str, dict] = {
    "error":        {"base": 8.0,  "magnitude": None},           # wrong notes — binary, high cost
    "intonation":   {"base": 3.0,  "magnitude": "cents_deviation"},   # scaled by ¢ off
    "timing":       {"base": 2.5,  "magnitude": "timing_deviation_ms"},# scaled by ms off
    "rhythm":       {"base": 2.5,  "magnitude": "timing_deviation_ms"},
    "dynamics":     {"base": 2.5,  "magnitude": None},
    "articulation": {"base": 2.0,  "magnitude": None},
    "phrasing":     {"base": 1.5,  "magnitude": None},
    "voicing":      {"base": 1.5,  "magnitude": None},
    "tone":         {"base": 2.0,  "magnitude": None},     # Gemini-only → softer
    "technique":    {"base": 1.5,  "magnitude": None},     # Gemini visual → softer
    "posture":      {"base": 1.0,  "magnitude": None},     # global/soft — lowest weight
}
_CENTS_SCALE    = 25.0   # 25¢ off → multiplier 1.0; 50¢ → 2.0; 10¢ → 0.4
_TIMING_MS_SCALE = 400.0  # 400ms off → multiplier 1.0; 800ms → 2.0; 200ms → 0.5


_UNCONFIRMED_MULT = 0.45  # Change 1: penalty multiplier for Tier B flags not backed by CREPE
                          # Revisit after ~20 analyses accumulate `confirmed` field data


def _flag_penalty(flag: dict) -> float:
    """Return the weighted penalty for a single flag (or grouped flag)."""
    ftype = flag.get("type", "")
    w     = FLAG_WEIGHTS.get(ftype, {"base": 2.0, "magnitude": None})
    base  = w["base"]
    mag   = w["magnitude"]

    if mag == "cents_deviation":
        c    = flag.get("cents_deviation")
        mult = min(2.5, max(0.4, abs(c) / _CENTS_SCALE)) if c is not None else 1.0
    elif mag == "timing_deviation_ms":
        ms   = flag.get("timing_deviation_ms")
        mult = min(2.0, max(0.4, ms / _TIMING_MS_SCALE)) if ms is not None else 1.0
    else:
        mult = 1.0

    # confirmed=False → unconfirmed Tier B flag; apply discount
    # Tier A flags (posture, tone, technique, dynamics) always have confirmed=True
    confirm_mult = 1.0 if flag.get("confirmed", True) else _UNCONFIRMED_MULT

    if flag.get("grouped") and flag.get("occurrences"):
        # Per-occurrence: first at full weight, subsequent at 50%; each inherits own
        # confirmation status AND its own deviation magnitude for scaling.
        total = 0.0
        for i, occ in enumerate(flag["occurrences"]):
            occ_confirm = 1.0 if occ.get("confirmed", flag.get("confirmed", True)) else _UNCONFIRMED_MULT
            weight = 1.0 if i == 0 else 0.5
            if mag == "cents_deviation":
                c = occ.get("cents_deviation")
                occ_mult = min(2.5, max(0.4, abs(c) / _CENTS_SCALE)) if c is not None else 1.0
            elif mag == "timing_deviation_ms":
                ms = occ.get("timing_deviation_ms")
                occ_mult = min(2.0, max(0.4, ms / _TIMING_MS_SCALE)) if ms is not None else 1.0
            else:
                occ_mult = mult
            total += base * occ_mult * occ_confirm * weight
        return total

    return base * mult * confirm_mult


def compute_weighted_score(flags: list[dict]) -> int:
    """Replace the flat -6/flag formula with a severity-weighted penalty sum."""
    total = sum(_flag_penalty(f) for f in flags)
    return max(45, min(98, round(95 - total)))


# ── Change 4: Gemini measure-number cross-validation ─────────────────────────
def validate_gemini_measures(assessment: dict, score: dict) -> tuple[dict, int]:
    """
    Remove Gemini items with impossible measure numbers (≤ 0).

    We intentionally do NOT discard based on the parsed score range because
    read_score_notes_claude may only return a partial parse (e.g. 8 of 20
    measures) — discarding Gemini flags for the unparsed tail would silently
    drop real feedback for the second half of the performance.

    Returns (validated_assessment, n_discarded).
    """
    discarded = 0
    validated: dict = {}

    for cat in ("intonation_issues", "rhythm_issues", "wrong_notes_cracks",
                "dynamics_issues", "tone_issues"):
        items = assessment.get(cat, [])
        clean = []
        for item in items:
            if isinstance(item, dict):
                raw_m = item.get("measure")
                try:
                    m = int(raw_m)
                    if m <= 0:
                        print(f"[gemini_validate] discarding {cat} m.{m} — impossible measure number")
                        discarded += 1
                        continue
                except (ValueError, TypeError, AttributeError):
                    pass  # keep if measure is unparseable — can't validate
            clean.append(item)
        validated[cat] = clean

    # Preserve visual / non-measure categories unchanged
    for k in ("posture_issues", "technique_issues", "overall"):
        validated[k] = assessment.get(k, [] if k != "overall" else "")

    if discarded:
        print(f"[gemini_validate] discarded {discarded} items with impossible measure numbers")

    return validated, discarded


def _group_similar_flags(flags: list) -> list:
    """
    Group flags of the same type that share a directional theme (e.g., all intonation
    flags that are 'sharp') into a single grouped flag with an `occurrences` list.
    Single flags and ungroupable flags are returned unchanged.
    """
    _SHARP = {'sharp', 'high'}
    _FLAT  = {'flat', 'low'}
    _RUSH  = {'rush', 'hurr', 'early', 'ahead'}
    _DRAG  = {'drag', 'late', 'behind', 'slow', 'delay'}

    # Only intonation and timing/rhythm carry a meaningful recurring "direction"
    # (all-sharp, all-dragging, etc.) that is worth collapsing into one grouped flag.
    # Everything else — wrong notes, dynamics, tone, posture, technique — stays as
    # distinct flags so the student sees each issue across the piece individually.
    GROUPABLE = {'intonation', 'timing', 'rhythm'}

    def _direction(flag) -> str | None:
        text = f"{flag.get('title','')} {flag.get('raw_detail','')} {flag.get('detail','')}".lower()
        ftype = flag.get('type', '')
        if ftype == 'intonation':
            if any(w in text for w in _SHARP): return 'sharp'
            if any(w in text for w in _FLAT):  return 'flat'
        elif ftype in ('timing', 'rhythm'):
            if any(w in text for w in _RUSH): return 'rushing'
            if any(w in text for w in _DRAG): return 'dragging'
        return ftype  # use type itself as direction key for others

    # Cluster by (type, direction). Non-groupable types get a unique key per flag
    # (keyed by measure) so they are never merged.
    clusters: dict = {}
    for idx, flag in enumerate(flags):
        ftype = flag.get('type', '')
        if ftype in GROUPABLE:
            key = (ftype, _direction(flag))
        else:
            key = (ftype, f"__solo_{flag.get('measure')}_{idx}")
        clusters.setdefault(key, []).append(flag)

    result = []
    for (ftype, direction), group in clusters.items():
        if len(group) < 2 or ftype in ('posture', 'technique'):
            result.extend(group)
            continue
        labels = [chr(ord('a') + i) for i in range(min(26, len(group)))]
        occurrences = [
            {
                'label':               labels[i],
                'measure':             f['measure'],
                'title':               f['title'],
                'detail':              f.get('detail', f.get('body', '')),
                'timestamp_start':     f.get('timestamp_start'),
                'timestamp_end':       f.get('timestamp_end'),
                'confirmed':           f.get('confirmed', True),
                'cents_deviation':     f.get('cents_deviation'),
                'timing_deviation_ms': f.get('timing_deviation_ms'),
            }
            for i, f in enumerate(group)
        ]
        dir_word = direction if direction != ftype else ftype
        # Group is confirmed if any occurrence is confirmed (some CREPE backing = use full weight)
        group_confirmed = any(f.get('confirmed', True) for f in group)
        result.append({
            'type':            ftype,
            'title':           f"Recurring {dir_word} — {len(group)} passages",
            'grouped':         True,
            'occurrences':     occurrences,
            'confirmed':       group_confirmed,
            'measure':         group[0]['measure'],
            'timestamp_start': group[0].get('timestamp_start'),
            'timestamp_end':   group[0].get('timestamp_end'),
            'detail':          (f"This {dir_word} issue recurs across {len(group)} passages. "
                                "Work on each spot individually at half-tempo, then connect."),
            'body':            (f"This {dir_word} issue recurs across {len(group)} passages. "
                                "Work on each spot individually at half-tempo, then connect."),
            'confidence':      max(f.get('confidence', 100) for f in group),
        })

    result.sort(key=lambda x: x.get('measure', 0))
    return result


def compare_and_coach_claude(
    score: dict, aligned: list[dict], alignment_ranges: list[dict],
    tempo: dict, piece_title: str, composer: str, instrument: str,
    gemini_assessment: dict, anthropic_api_key: str,
    user_note: str = "",
    video_duration: float = 0.0,
    start_measure: int = 1,
    beat_times: list | None = None,
    beats_per_measure: int | None = None,
    end_measure: int | None = None,
    dtw_verified: bool = False,
) -> list[dict]:
    import anthropic as ac, re
    CLAUDE_MODEL = "claude-sonnet-4-6"
    allowed_types = {
        "intonation", "timing", "rhythm", "articulation", "dynamics",
        "voicing", "phrasing", "tone", "error", "posture", "technique",
    }
    # Unfretted strings require tighter intonation; flag at 8¢ instead of 10¢
    is_string = any(x in instrument.lower() for x in ("violin", "viola", "cello", "double bass"))
    cents_flag_threshold = 8 if is_string else 10

    events_by_measure: dict[int, list] = {}
    for ev in aligned:
        events_by_measure.setdefault(ev["measure"], []).append(ev)

    valid_measures   = {m["number"] for m in score.get("measures", [])}
    score_measure_map = {m["number"]: m for m in score.get("measures", [])}

    # Collect all measure numbers Gemini flagged AND the earliest timestamp Gemini
    # gave for each measure. Gemini watches the whole video + reads the score, so its
    # "time" field is the most reliable clock anchor we have — we use it to build loop
    # ranges when CREPE alignment didn't cover that measure (the common case for
    # visual/PDF scores). Without this, flags collapse onto the few measures CREPE
    # aligned, and loops play a fraction of a second instead of the passage.
    gemini_flagged_nums: set[int] = set()
    gemini_measure_time: dict[int, float] = {}   # measure → earliest seconds seen
    for _cat in ("intonation_issues", "rhythm_issues", "wrong_notes_cracks", "dynamics_issues", "tone_issues"):
        for _item in gemini_assessment.get(_cat, []):
            if isinstance(_item, dict):
                try:
                    _m = int(_item["measure"])
                except (KeyError, ValueError, TypeError):
                    continue
                gemini_flagged_nums.add(_m)
                _t = parse_mmss_to_seconds(_item.get("time"))
                if _t is not None:
                    prev = gemini_measure_time.get(_m)
                    if prev is None or _t < prev:
                        gemini_measure_time[_m] = _t

    # Synthesize skeleton entries for Gemini-flagged measures not in the parsed score.
    # This handles the case where read_score_notes_claude only returned a partial parse
    # (e.g. the first 8 of 20 measures) — without this, the second-half feedback is lost.
    for _n in gemini_flagged_nums:
        if _n > 0 and _n not in score_measure_map:
            score_measure_map[_n] = {"number": _n, "notes": []}

    # played_measures = CREPE-covered measures ∪ ALL Gemini-flagged measures.
    # Do NOT intersect with valid_measures — the score parse may be incomplete.
    active_nums = (set(events_by_measure.keys()) | gemini_flagged_nums)
    played_measures = [score_measure_map[n] for n in sorted(active_nums) if n in score_measure_map]
    # Fallback: if score has measures but neither source found any, use all score measures
    if not played_measures and score_measure_map:
        played_measures = [score_measure_map[n] for n in sorted(score_measure_map)]

    if not played_measures and not gemini_assessment:
        return []
    range_map        = {r["measure"]: r for r in alignment_ranges}
    range_start_map  = {r["measure"]: r["start"] for r in alignment_ranges}
    bpm              = beats_per_measure_from_time_sig(score.get("time_signature"))

    # Estimate a typical measure duration (seconds) for building loop windows when
    # neither CREPE nor Gemini give an explicit range. Prefer the median of measured
    # CREPE ranges; fall back to a musically sane default.
    _rng_durs = sorted(
        max(0.3, r["end"] - r["start"]) for r in alignment_ranges if r["end"] > r["start"]
    )
    if _rng_durs:
        est_measure_sec = _rng_durs[len(_rng_durs) // 2]
    elif tempo.get("bpm") and bpm:
        est_measure_sec = (60.0 / max(30.0, float(tempo["bpm"]))) * bpm
    else:
        est_measure_sec = 2.5
    est_measure_sec = max(1.2, min(8.0, est_measure_sec))

    # Full measure span, used to place a flag proportionally along the recording when
    # we have no explicit time anchor at all.
    _span_nums = (
        set(valid_measures)
        | set(gemini_flagged_nums)
        | {r["measure"] for r in alignment_ranges}
        | set(events_by_measure.keys())
    )
    _span_nums = {n for n in _span_nums if isinstance(n, int) and n > 0}
    span_min = min(_span_nums) if _span_nums else 1
    span_max = max(_span_nums) if _span_nums else 1
    piece_len = video_duration if video_duration and video_duration > 0 else (
        max((r["end"] for r in alignment_ranges), default=0.0) or (len(_span_nums) * est_measure_sec)
    )

    # Bounds for mapping a timestamp → measure. The LOW end must be the true first
    # measure of the piece (1, or the parsed minimum) — NOT span_min, because when
    # Gemini mislabels every issue as the last measure, span_min would collapse to
    # that same number and defeat the spread. Assuming the piece starts at measure 1
    # lets us distribute issues across the whole recording by their real timestamps.
    measure_lo = min(valid_measures) if valid_measures else 1
    measure_hi = span_max
    if measure_hi <= measure_lo:
        measure_lo = 1
        measure_hi = max(span_max, len(score.get("measures", [])) or 1, 1)

    import bisect as _bisect

    # End-measure anchor for an EXACT two-point time->measure map, plus the time that
    # anchor corresponds to (the last playing moment — NOT the full duration, which may
    # include trailing silence). Both are set below.
    anchor_end: int | None = None
    anchor_time: float | None = None
    # Real detected beat onsets, RESCALED so the anchored last beat lands exactly on
    # anchor_time. Set once anchor_end/anchor_time are known (below). This is the most
    # accurate measure-boundary source available: raw beat_times reflect the performer's
    # ACTUAL tempo (rubato, a march that isn't perfectly metronomic) far better than a
    # straight-line or constant-tempo assumption — the rescale just removes whatever
    # drift a raw, uncorrected beat count would otherwise accumulate by the end.
    scaled_beat_times: list[float] | None = None

    def time_to_measure(tsec: float | None) -> int | None:
        """
        Map a recording timestamp to a measure number. Gemini reliably reports WHEN
        an issue happens (it watched the video) but often misreads the printed measure
        number off the score photo — so we trust the timestamp and derive the measure.
        """
        if tsec is None:
            return None
        bpm_grid = beats_per_measure if (beats_per_measure and beats_per_measure >= 1) else bpm
        # ABSOLUTE BEST, when available: DTW-verified alignment ranges. These come from
        # matching the ACTUAL PITCH SEQUENCE the student played against the score's note
        # sequence (dtw_align_to_score/dtw_align_to_reference) — so a measure's boundary
        # here reflects real note content, not beat-count arithmetic. Immune to the one
        # failure mode nothing else can fully fix: a beat tracker miscounting a beat
        # somewhere earlier in the piece and shifting every later boundary by that much.
        if dtw_verified and alignment_ranges:
            # Half-open [start, end). The ranges are contiguous — each measure's
            # end IS the next measure's first onset — so an inclusive upper bound
            # matches the earlier measure first and attributes every downbeat to
            # the measure before it. The final range stays inclusive so the last
            # note of the piece still lands somewhere.
            for _i, r in enumerate(alignment_ranges):
                _last = _i == len(alignment_ranges) - 1
                if r["start"] <= tsec < r["end"] or (_last and tsec == r["end"]):
                    return r["measure"]
        # BEST (no DTW): real detected beats, anchor-corrected. Tracks the performance's actual
        # tempo variation across the piece (a straight-line/constant-tempo model can't),
        # while the rescale guarantees no drift at either end.
        if scaled_beat_times and len(scaled_beat_times) >= 2 and bpm_grid >= 1:
            idx = _bisect.bisect_right(scaled_beat_times, tsec) - 1
            if idx < 0:
                idx = 0
            m = start_measure + idx // bpm_grid
            return max(start_measure, min(anchor_end, m)) if anchor_end else m
        # NEXT: two-point linear anchor. When we know the last measure (from the user or
        # a reliable estimate) but have no usable beat-time array, map [0, duration] ->
        # [start_measure, anchor_end] linearly. Exact at both ends, immune to tempo
        # estimation error, but assumes constant tempo throughout.
        if anchor_end and anchor_end > start_measure:
            denom = anchor_time if (anchor_time and anchor_time > 0) else piece_len
            if denom and denom > 0:
                # Floor (not round) so this is exactly invertible by
                # measure_to_time_range below — with round(), the measure label and
                # the loop's time window could disagree by up to half a measure.
                frac = min(1.0, max(0.0, tsec / denom))
                m = start_measure + int(frac * (anchor_end - start_measure))
                return max(start_measure, min(anchor_end, m))
        try:
            tempo_bpm = float((tempo or {}).get("bpm") or 0)
        except (TypeError, ValueError):
            tempo_bpm = 0.0
        # Next: a UNIFORM grid from the global tempo. A raw beat-count (below) drifts
        # high over the piece because beat trackers detect spurious beats in fast
        # passages (e.g. sixteenth-note runs) — that over-count accumulates so the END
        # measure comes out too high. A steady tempo grid does not accumulate that error.
        if tempo_bpm > 20 and bpm_grid >= 1:
            sec_per_measure = bpm_grid * 60.0 / tempo_bpm
            if sec_per_measure > 0.2:
                return start_measure + int(max(0.0, tsec) // sec_per_measure)
        # Fallback: count detected beats (unscaled — no anchor was available to correct it).
        if beat_times and len(beat_times) >= 2 and bpm_grid >= 1:
            idx = _bisect.bisect_right(beat_times, tsec) - 1
            if idx < 0:
                idx = 0
            return start_measure + idx // bpm_grid
        for r in alignment_ranges:
            if r["start"] <= tsec <= r["end"]:
                return r["measure"]
        if piece_len > 0 and measure_hi > measure_lo:
            frac = min(1.0, max(0.0, tsec / piece_len))
            return int(round(measure_lo + frac * (measure_hi - measure_lo)))
        return None

    def _raw_measure_time_range(m0: int, m1: int) -> tuple[float, float]:
        """Same priority tiers as before — see measure_to_time_range for the margin
        applied on top of this raw result."""
        bpm_grid = beats_per_measure if (beats_per_measure and beats_per_measure >= 1) else bpm

        # ABSOLUTE BEST, when available: DTW-verified ranges — same source and tier
        # time_to_measure checks first, so the label and the loop window can never
        # disagree. Built from real detected note onsets matched to the score's actual
        # pitch sequence, not beat-count arithmetic.
        if dtw_verified:
            r0, r1 = range_map.get(m0), range_map.get(m1)
            if r0 and r1:
                return (r0["start"], max(r0["start"], r1["end"]))
            if r0:
                return (r0["start"], r0["end"])

        # BEST (no DTW): real detected beats, anchor-corrected — same tier and array
        # time_to_measure checks first, so the label and the loop window can never
        # disagree about where a measure's real (tempo-fluctuation-aware) boundary is.
        if scaled_beat_times and len(scaled_beat_times) >= 2 and bpm_grid >= 1:
            n = len(scaled_beat_times)
            avg_beat = (scaled_beat_times[-1] - scaled_beat_times[0]) / max(1, n - 1)
            idx0 = (m0 - start_measure) * bpm_grid
            idx1 = (m1 + 1 - start_measure) * bpm_grid
            t0 = scaled_beat_times[idx0] if 0 <= idx0 < n else scaled_beat_times[-1] + avg_beat * (idx0 - (n - 1))
            t1 = scaled_beat_times[idx1] if 0 <= idx1 < n else scaled_beat_times[-1] + avg_beat * (idx1 - (n - 1))
            return (max(0.0, t0), max(t0, t1))

        if anchor_end and anchor_end > start_measure:
            denom = anchor_time if (anchor_time and anchor_time > 0) else piece_len
            total = anchor_end - start_measure
            if denom and denom > 0 and total > 0:
                f0 = max(0.0, (m0 - start_measure) / total)
                f1 = min(1.0, (m1 + 1 - start_measure) / total)
                return (f0 * denom, max(f0 * denom, f1 * denom))

        try:
            tempo_bpm = float((tempo or {}).get("bpm") or 0)
        except (TypeError, ValueError):
            tempo_bpm = 0.0
        if tempo_bpm > 20 and bpm_grid >= 1:
            sec_per_measure = bpm_grid * 60.0 / tempo_bpm
            if sec_per_measure > 0.2:
                start = max(0.0, (m0 - start_measure) * sec_per_measure)
                end   = max(start, (m1 + 1 - start_measure) * sec_per_measure)
                return (start, end)

        if beat_times and len(beat_times) >= 2 and bpm_grid >= 1:
            n = len(beat_times)
            avg_beat = (beat_times[-1] - beat_times[0]) / max(1, n - 1)
            idx0 = (m0 - start_measure) * bpm_grid
            idx1 = (m1 + 1 - start_measure) * bpm_grid
            t0 = beat_times[idx0] if 0 <= idx0 < n else beat_times[-1] + avg_beat * (idx0 - (n - 1))
            t1 = beat_times[idx1] if 0 <= idx1 < n else beat_times[-1] + avg_beat * (idx1 - (n - 1))
            return (max(0.0, t0), max(t0, t1))

        r0, r1 = range_map.get(m0), range_map.get(m1)
        if r0 and r1:
            return (r0["start"], max(r0["start"], r1["end"]))
        if r0:
            return (r0["start"], r0["end"])

        if piece_len > 0 and span_max > span_min:
            f0 = max(0.0, (m0 - span_min) / max(1, (span_max - span_min)))
            f1 = min(1.0, (m1 + 1 - span_min) / max(1, (span_max - span_min)))
            return (f0 * piece_len, max(f0 * piece_len, f1 * piece_len))

        return (0.0, max(1.2, est_measure_sec))

    def measure_to_time_range(m0: int, m1: int | None = None) -> tuple[float, float]:
        """
        EXACT inverse of time_to_measure: returns the [start_sec, end_sec) time window
        occupied by measures m0..m1 (inclusive), using the SAME priority tiers in the
        SAME order as time_to_measure. This is what guarantees the Loop button always
        plays exactly the measure(s) printed on the flag — the label and the audio are
        two views of one mapping, not two independently-computed values that can
        silently disagree.

        Beat detection on a real (monophonic, non-percussive) performance is never
        perfect — a beat tracker can anchor a beat's estimated time slightly ahead of
        the true acoustic onset, and any single missed/extra detected beat anywhere
        earlier in the piece shifts every later index-based boundary by that much. No
        amount of downstream math can fully undo that; instead we shrink the window
        slightly INWARD from each raw computed boundary (delay the start, pull in the
        end by a small fraction of a beat) so a small estimation error can no longer
        pull in a neighboring measure's notes. This trades a sliver of the true first/
        last note for eliminating audibly wrong content from the next/previous measure
        — the better trade-off for a practice loop.
        """
        m1 = m1 if (isinstance(m1, int) and m1 >= m0) else m0
        bpm_grid = beats_per_measure if (beats_per_measure and beats_per_measure >= 1) else bpm
        t0, t1 = _raw_measure_time_range(m0, m1)

        n_beats = max(1, (m1 + 1 - m0) * bpm_grid)
        spb = max(0.05, (t1 - t0) / n_beats)   # seconds per beat, estimated locally
        margin = min(0.25, spb * 0.15)         # up to 15% of one beat, capped at 250ms
        # The start margin exists to protect against bleeding in the TAIL of a real
        # previous measure. The very first playable measure has no previous measure to
        # bleed from, so delaying its start only risks clipping the true opening note
        # for no benefit — skip the start margin there.
        start_margin = margin if m0 > start_measure else 0.0
        t0_adj, t1_adj = t0 + start_margin, t1 - margin
        if t1_adj - t0_adj < 0.5:
            # Margin would collapse an already-short window — better to risk a sliver
            # of bleed than to under-play the labeled measure(s) entirely.
            return (t0, t1)
        return (t0_adj, t1_adj)

    evidence_candidates: list[str] = []
    for m in played_measures:
        events  = sorted(events_by_measure.get(m["number"], []), key=lambda e: e["time_sec"])
        r       = range_map.get(m["number"])
        m_start = r["start"] if r else (events[0]["time_sec"] if events else 0)
        m_dur   = max(0.5, r["end"] - r["start"]) if r else 4.0
        spb     = m_dur / max(1, bpm)
        for ev in events:
            cents = ev.get("cents_offset")
            if cents is not None and abs(cents) >= cents_flag_threshold and ev.get("confidence", 100) >= 25:
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
    # Candidates are appended in measure order, and within a measure intonation is
    # appended before timing — so a flat [:8] truncation quietly meant "the first
    # couple of measures only, intonation first". Take the strongest by magnitude
    # instead, and keep more of them, so late-measure and timing evidence can
    # actually reach the model.
    def _evidence_magnitude(cand: str) -> float:
        m = re.search(r'([+-]?\d+(?:\.\d+)?)¢', cand)
        if m:
            return abs(float(m.group(1)))
        m = re.search(r'(\d+(?:\.\d+)?)s gap', cand)
        if m:
            return float(m.group(1)) * 100.0   # 1s gap ranks like 100¢
        return 0.0
    strongest = sorted(evidence_candidates, key=_evidence_magnitude, reverse=True)[:16]

    # Add direct CREPE-vs-score wrong note candidates
    wrong_note_candidates = find_wrong_note_candidates(aligned, score)

    # Objective timing must be computed BEFORE the no-evidence guard below and
    # counted as evidence in its own right. A performance that is in tune, on the
    # right notes, and that Gemini had no comment on can still be rhythmically
    # wrong — that used to return zero flags here, which is exactly the "nothing
    # on timing" gap this analysis exists to close.
    timing_report = None
    if score.get("measures") and any(ev.get("score_idx") is not None for ev in aligned):
        try:
            timing_report = analyze_timing_vs_score(aligned, score, bpm)
        except Exception as e:                      # never fail the whole analysis
            print(f"[compare_and_coach_claude] timing analysis error: {e}")
            timing_report = None
    has_timing_data = bool(
        timing_report and timing_report.get("ok") and (
            timing_report["placement"] or timing_report["drift"]
            or timing_report["durations"] or timing_report.get("overall")
        )
    )

    crepe_has_data = bool(strongest or wrong_note_candidates or has_timing_data)
    # Gemini is always present — check if it found anything across all categories
    has_gemini_data = bool(any(
        gemini_assessment.get(k) for k in (
            "intonation_issues", "rhythm_issues", "wrong_notes_cracks",
            "dynamics_issues", "tone_issues", "posture_issues", "technique_issues",
        )
    ))
    if not strongest and not wrong_note_candidates and not has_gemini_data and not has_timing_data:
        print("[compare_and_coach_claude] no evidence from CREPE or Gemini; returning no flags")
        return []

    # If alignment produced no ranges, synthesize from actual event timestamps.
    # Previously used hardcoded start=0 end=30 for every measure, making all Loop
    # buttons play the same 30-second clip regardless of which measure was flagged.
    if not alignment_ranges and played_measures:
        fallback_ranges = []
        total_evs = sorted(aligned, key=lambda e: e["time_sec"]) if aligned else []
        duration_hint = (total_evs[-1]["time_sec"] + 2.0) if total_evs else 30.0
        sec_per_measure = duration_hint / max(len(played_measures), 1)
        for i, m in enumerate(played_measures):
            evs = sorted(events_by_measure.get(m["number"], []), key=lambda e: e["time_sec"])
            if evs:
                start = evs[0]["time_sec"]
                end   = evs[-1].get("end_sec", evs[-1]["time_sec"] + sec_per_measure)
            else:
                start = i * sec_per_measure
                end   = start + sec_per_measure
            fallback_ranges.append({"measure": m["number"], "start": start, "end": max(end, start + 0.5)})
        alignment_ranges = fallback_ranges
        # Refresh the range lookups so resolve_loop_range (called later) can use these.
        range_map.clear()
        range_map.update({r["measure"]: r for r in alignment_ranges})
        range_start_map.clear()
        range_start_map.update({r["measure"]: r["start"] for r in alignment_ranges})

    # valid_list = every measure Claude is allowed to flag. It must cover everything
    # we actually show Claude (played_measures) plus every measure Gemini flagged and
    # every aligned measure — otherwise Claude's flag is silently dropped at validation
    # and whole sections of the piece disappear from the report.
    valid_list_set: set[int] = set(r["measure"] for r in alignment_ranges)
    valid_list_set |= {m["number"] for m in played_measures}
    valid_list_set |= set(gemini_flagged_nums)
    if not valid_list_set and score.get("measures"):
        valid_list_set = {m["number"] for m in score["measures"]}
    gemini_measures = set(gemini_flagged_nums)
    valid_list = sorted(n for n in valid_list_set if isinstance(n, int) and n > 0)

    # ── Gemini-first canonical issue set ──────────────────────────────────
    # Gemini watched the full video AND read the score, so it is the PRIMARY author
    # of flags for note errors, timing, dynamics, tone, posture, and technique. CREPE
    # owns intonation (precise cents) and corroborates note/timing issues. Claude is
    # used ONLY to write the coaching text for this fixed list — it can no longer drop
    # issues, which is exactly what previously capped coverage at a handful of flags.

    # CREPE corroboration sets (which measures the signal independently supports)
    timing_conf_measures: set[int] = set()
    timing_gap_ms: dict[int, float] = {}
    for cand in evidence_candidates:
        if cand.startswith("timing |"):
            mm = re.search(r'measure (\d+)', cand)
            gm = re.search(r'(\d+\.\d+)s gap', cand)
            if mm:
                _m = int(mm.group(1))
                timing_conf_measures.add(_m)
                if gm:
                    timing_gap_ms[_m] = round(float(gm.group(1)) * 1000, 1)
    wrongnote_conf_measures: set[int] = set()
    for cand in wrong_note_candidates:
        mm = re.search(r'measure (\d+)', cand)
        if mm:
            wrongnote_conf_measures.add(int(mm.group(1)))

    canonical: list[dict] = []

    def _canonicalize_measure_refs(text: str, m0: int, m1: int | None) -> str:
        """
        Gemini's free-text description sometimes cites ITS OWN (unreliable) measure
        number — which can differ from the corrected canonical measure derived from
        the timestamp. Left alone, Claude's coaching text picks up Gemini's wrong
        number from the "observed" text it's shown, so a flag could be labeled
        "m.25" while its own body talks about "measure 28". Rewrite every measure
        reference in the text to the canonical measure(s) so the label and the
        coaching text can never disagree — this is a no-op for text that already
        cites the right number (e.g. our own CREPE-generated strings).
        """
        range_label  = f"measures {m0}-{m1}" if m1 else f"measure {m0}"
        single_label = f"measure {m0}"
        text = re.sub(
            r'\b(?:measures|mm\.?)\s*\d+\s*(?:-|–|—|to|through)\s*\d+\b',
            range_label, text, flags=re.IGNORECASE,
        )
        text = re.sub(
            r'\b(?:measure|m\.)\s*\d+\b',
            single_label, text, flags=re.IGNORECASE,
        )
        return text

    def _add(measure, ftype, observed, time_sec, confirmed,
             cents=None, timing=None, is_global=False,
             measure_end=None, time_end_sec=None, direction=None, priority=0):
        observed = str(observed or "").strip()
        if not observed or "not visible" in observed.lower():
            return
        m0 = int(measure)
        m1 = int(measure_end) if isinstance(measure_end, (int, float)) and measure_end > m0 else None
        observed = _canonicalize_measure_refs(observed, m0, m1)
        canonical.append({
            "measure":      m0,
            "measure_end":  m1,
            "type":         ftype,
            "observed":     observed,
            "time_sec":     time_sec,
            "time_end_sec": time_end_sec,
            "confirmed":    bool(confirmed),
            "cents":        cents,
            "timing":       timing,
            "global":       is_global,
            "direction":    direction,   # "sharp"/"flat" for intonation; else None
            # Dedup tie-break only (see the sort below); not part of the output.
            "_priority":    priority,
        })

    # 1. Gemini-authored issues (note errors, timing, dynamics, tone) — one flag each.
    GEMINI_DIRECT = [
        ("wrong_notes_cracks", "error"),
        ("rhythm_issues",      "timing"),
        ("dynamics_issues",    "dynamics"),
        ("tone_issues",        "tone"),
    ]
    # First pass: collect Gemini's direct issues so we can detect + repair a
    # degenerate response (every issue stamped with the same measure/timestamp).
    gemini_items: list = []   # (ftype, gm_measure, tsec, desc, gm_measure_end, tsec_end)
    for cat, ftype in GEMINI_DIRECT:
        for item in gemini_assessment.get(cat, []):
            if not isinstance(item, dict):
                continue
            desc = str(item.get("description") or "").strip()
            if not desc or "not visible" in desc.lower():
                continue
            gemini_items.append((
                ftype,
                _safe_measure_int(item.get("measure")),
                parse_mmss_to_seconds(item.get("time")),
                desc,
                _safe_measure_int(item.get("measure_end")),
                parse_mmss_to_seconds(item.get("time_end")),
            ))

    # Safety net for the recording start offset. The student began at measure
    # start_measure, so no issue can be below it. If Gemini ignored that (it read the
    # measure numbers off the top of the page instead of where the recording begins),
    # its measures come out uniformly too low. Detect that (min reported measure below
    # start) and shift ALL Gemini measures up by the offset so they anchor to the real
    # start — Gemini's relative spacing is usually right, only its base is wrong.
    if start_measure > 1:
        gm_nums = [it[1] for it in gemini_items if it[1] is not None and it[1] > 0]
        if gm_nums:
            gm_min = min(gm_nums)
            if gm_min < start_measure:
                offset = start_measure - gm_min
                print(f"[compare_and_coach_claude] Gemini measures start at {gm_min} but "
                      f"recording starts at {start_measure} — shifting all by +{offset}")
                gemini_items = [
                    (ft,
                     (gm + offset if gm is not None else None),
                     ts, d,
                     (gme + offset if gme is not None else None),
                     te)
                    for (ft, gm, ts, d, gme, te) in gemini_items
                ]

    # Rescale Gemini timestamps if its clock overran the real recording. Gemini
    # sometimes reports times past the actual end (its internal sense of tempo drifts),
    # which would push late issues + passages past the end of the video where they get
    # clamped to a broken 2s sliver. If the max timestamp exceeds the true duration,
    # map Gemini's whole timeline proportionally back onto the real recording.
    if piece_len and piece_len > 0:
        all_ts = [t for it in gemini_items for t in (it[2], it[5]) if t is not None]
        max_ts = max(all_ts) if all_ts else 0.0
        if max_ts > piece_len * 1.05:
            scale = piece_len / max_ts
            print(f"[compare_and_coach_claude] Gemini timeline overran ({max_ts:.0f}s > "
                  f"{piece_len:.0f}s) — rescaling timestamps by {scale:.3f}")
            gemini_items = [
                (ft, gm,
                 (ts * scale if ts is not None else None), d, gme,
                 (te * scale if te is not None else None))
                for (ft, gm, ts, d, gme, te) in gemini_items
            ]

    distinct_ts = {it[2] for it in gemini_items if it[2] is not None}
    distinct_gm = {it[1] for it in gemini_items if it[1]}
    print(f"[compare_and_coach_claude] Gemini raw: {len(gemini_items)} issues, "
          f"{len(distinct_gm)} distinct measures {sorted(distinct_gm)}, "
          f"{len(distinct_ts)} distinct timestamps")

    # Set the end-measure anchor used by time_to_measure for exact two-point mapping.
    # We compute TWO independent estimates of the last played measure and reconcile them
    # with the user's stated end_measure so a small typing slip (e.g. 23 instead of 24)
    # can be caught and corrected:
    #   • grid_end   — from the beat grid at the last playing moment (reliable over a
    #                  short span; drifts over long ones).
    #   • gemini_end — from Gemini's RELATIVE span. Its absolute numbers may be offset,
    #                  but the gap between its first and last reported measure matches
    #                  the true number of measures played.
    _bpm_grid = beats_per_measure if (beats_per_measure and beats_per_measure >= 1) else bpm
    _last_play_t = 0.0
    for _it in gemini_items:
        for _t in (_it[2], _it[5]):
            if _t is not None:
                _last_play_t = max(_last_play_t, _t)
    if aligned:
        _last_play_t = max([_last_play_t] + [(_e.get("time_sec") or 0.0) for _e in aligned])
    # Anchor the end of the two-point map to the last playing moment so the final note
    # lands exactly on anchor_end (trailing silence in the recording is ignored).
    if _last_play_t > 0:
        anchor_time = _last_play_t
    grid_end_est = None
    if beat_times and len(beat_times) >= 2 and _bpm_grid >= 1 and _last_play_t > 0:
        _idx = _bisect.bisect_right(beat_times, _last_play_t) - 1
        if _idx < 0:
            _idx = 0
        grid_end_est = start_measure + _idx // _bpm_grid
    _gm_vals = [it[1] for it in gemini_items if it[1]] + [it[4] for it in gemini_items if it[4]]
    gemini_end_est = None
    if _gm_vals and (max(_gm_vals) - min(_gm_vals)) >= 2:
        gemini_end_est = start_measure + (max(_gm_vals) - min(_gm_vals))

    # The score itself is the most reliable end estimate available: it literally
    # lists the measures. It was never consulted here, so the end of the piece was
    # inferred purely from the beat grid and Gemini's issue span — and BOTH only
    # ever reach as far as the last thing they happened to notice. Any measures
    # after that fell outside the two-point map and could not be flagged at all,
    # which is why reports stopped short of the end of the piece.
    score_end_est = None
    _score_measures = [m.get("number") for m in score.get("measures", []) if m.get("number")]
    if len(_score_measures) >= 2:
        score_end_est = int(max(_score_measures))

    if end_measure and end_measure > start_measure:
        anchor_end = int(end_measure)
        # Reactive correction: only override the user's value when BOTH independent
        # estimates agree with each other (within 1) and differ from the user's value by
        # a small amount (1-2 measures) — a genuine slip. Never override on a big
        # disagreement (that means an estimate is unreliable, e.g. beat-grid drift).
        _ests = [e for e in (grid_end_est, gemini_end_est) if e and e > start_measure]
        if len(_ests) == 2 and abs(_ests[0] - _ests[1]) <= 1:
            _agreed = int(round(sum(_ests) / 2))
            if 1 <= abs(_agreed - anchor_end) <= 2:
                print(f"[compare_and_coach_claude] user end_measure={anchor_end} looks off — "
                      f"beat grid ({grid_end_est}) and Gemini span ({gemini_end_est}) agree on "
                      f"~{_agreed}; correcting to {_agreed}")
                anchor_end = _agreed
        if anchor_end == int(end_measure):
            print(f"[compare_and_coach_claude] using user end_measure={anchor_end} — "
                  f"two-point map m.{start_measure}..m.{anchor_end}")
    else:
        # No user end — take the LARGEST estimate. Every one of these is really a
        # lower bound ("as far as I read / noticed / tracked"), so they all
        # under-shoot independently, and under-shooting is the failure that
        # silently drops the end of the piece. Over-shooting only adds empty
        # measures nobody flags, which is harmless. In particular the score's own
        # count can under-shoot when a truncated score read was salvaged, so it
        # must not be trusted on its own.
        _ests = [e for e in (score_end_est, gemini_end_est, grid_end_est)
                 if e and e > start_measure]
        if _ests:
            anchor_end = int(max(_ests))
            print(f"[compare_and_coach_claude] estimated end_measure={anchor_end} "
                  f"(score={score_end_est}, beat grid={grid_end_est}, Gemini span={gemini_end_est})")

    # Build scaled_beat_times: the real detected beat onsets, rescaled so the beat at
    # anchor_end lands exactly on anchor_time. A raw beat count alone drifts over a long
    # span (spurious beats in fast passages accumulate error), which is why earlier
    # tiers exist — but a raw count also THROWS AWAY the real tempo shape captured by
    # actual beat detection, which is what a uniform tempo/two-point model can never
    # capture (a march is not played by metronome). Anchoring the real beats removes
    # the drift while keeping that real shape, so mid-piece measure boundaries track
    # the performer's actual tempo instead of an idealized constant one.
    if beat_times and len(beat_times) >= 2 and _bpm_grid >= 1 and anchor_end and anchor_time and anchor_time > 0:
        _n = len(beat_times)
        _avg_beat = (beat_times[-1] - beat_times[0]) / max(1, _n - 1)
        _idx_end = (anchor_end - start_measure) * _bpm_grid
        _raw_end_t = beat_times[_idx_end] if 0 <= _idx_end < _n else beat_times[-1] + _avg_beat * (_idx_end - (_n - 1))
        if _raw_end_t and _raw_end_t > 0:
            _scale = anchor_time / _raw_end_t
            scaled_beat_times = [t * _scale for t in beat_times]
            print(f"[compare_and_coach_claude] using anchor-corrected real beat times "
                  f"(rescale factor {_scale:.3f}) as the primary measure-boundary source")

    # Measure numbers come from the BEAT GRID (time_to_measure), not Gemini's photo
    # reading — Gemini watches the video so its TIMESTAMP is reliable, but reading the
    # printed measure number off a phone photo is not (it drifts, offsets, misreads).
    # The beat grid is deterministic, monotonic, and anchored at the student's real
    # start_measure, so measures stay in sync with what was actually played.
    # We can map time->measure if we have either a tempo or detected beats.
    have_beat_grid = time_to_measure(0.0) is not None
    if have_beat_grid:
        print("[compare_and_coach_claude] deriving measure numbers from the tempo/beat "
              f"grid (anchored at m.{start_measure})")

    # Degenerate-response repair: if Gemini collapsed everything onto ~one location
    # (one measure AND no timestamp spread) AND we have no beat grid, distribute the
    # issues evenly across the recording by their order.
    need_spread = (not have_beat_grid) and len(gemini_items) >= 3 \
        and len(distinct_ts) <= 1 and len(distinct_gm) <= 1
    if need_spread:
        print("[compare_and_coach_claude] degenerate Gemini measures/timestamps — "
              "spreading issues across the recording by order")

    for idx, (ftype, gm_measure, tsec, desc, gm_measure_end, tsec_end) in enumerate(gemini_items):
        if need_spread and piece_len > 0:
            tsec = piece_len * (idx + 0.5) / len(gemini_items)
            gm_measure_end, tsec_end = None, None   # ranges are meaningless when spreading
        # Beat-grid measure from the timestamp is primary; Gemini's own number is only a
        # fallback when there is no timestamp to place the issue.
        m = time_to_measure(tsec)
        if m is None:
            m = gm_measure
        if m is None or m <= 0:
            continue
        # Passage end: derive from the end timestamp via the beat grid; fall back to
        # Gemini's measure_end only if there is no end timestamp.
        m_end = None
        if tsec_end is not None:
            derived = time_to_measure(tsec_end)
            if derived and derived > m:
                m_end = derived
        elif gm_measure_end and gm_measure_end > (gm_measure or 0) and m is not None:
            # keep Gemini's relative span length when we only have its measures
            span = gm_measure_end - gm_measure
            if span > 0:
                m_end = m + span
        if ftype == "error":
            conf = m in wrongnote_conf_measures  # Tier B — CREPE must corroborate
        elif ftype == "timing":
            conf = m in timing_conf_measures
        else:
            conf = True                          # Tier A — Gemini authoritative
        _add(m, ftype, desc, tsec, conf, timing=timing_gap_ms.get(m),
             measure_end=m_end, time_end_sec=tsec_end)

    # 2. Intonation — CREPE owns it. One flag per measure with a real deviation.
    # Number these measures with the SAME time->measure mapping used for Gemini flags
    # (from the event's timestamp), so intonation and everything else stay consistent
    # and don't drift apart. The loop is anchored on the event timestamp too.
    inton: dict[int, dict] = {}   # measure -> {cents, time, sharp}
    for ev in aligned:
        c = ev.get("cents_offset")
        if c is not None and abs(c) >= cents_flag_threshold and ev.get("confidence", 100) >= 25:
            t  = ev.get("time_sec")
            mm = time_to_measure(t)
            if mm is None:
                mm = ev.get("measure")
            if mm is None:
                continue
            d = inton.setdefault(mm, {"cents": 0.0, "time": None, "sharp": False})
            if abs(c) > d["cents"]:
                d["cents"] = abs(c)
                d["sharp"] = c > 0
            if t is not None and (d["time"] is None or t < d["time"]):
                d["time"] = t
    for m, d in inton.items():
        direction = "sharp" if d["sharp"] else "flat"
        fix_hint = (
            "loosen the embouchure slightly and drop jaw pressure, or open the throat"
            if direction == "sharp" else
            "tighten the embouchure slightly and increase air support"
        )
        _add(m, "intonation",
             f"pitch runs {round(d['cents'])}¢ {direction} in this measure — {fix_hint}",
             d["time"], confirmed=True, cents=round(d["cents"], 1), direction=direction)

    # 2b. Timing — CREPE+DTW owns it, exactly as CREPE owns intonation above.
    # Previously timing had NO objective author: flags came only from Gemini's
    # subjective rhythm_issues, and survived only if a crude heuristic (a >0.8 s
    # gap) happened to corroborate them, so anything short of a long hesitation
    # was detected by nobody and then culled as unconfirmed. These carry measured
    # millisecond/percentage numbers, so they are confirmed=True by construction.
    if timing_report and timing_report.get("ok"):
        def _t_of(measure):
            r = range_map.get(measure)
            return r["start"] if r else None

        for m, p in timing_report["placement"].items():
            ms = abs(p["median_ms"])
            _add(m, "timing",
                 f"notes land about {int(round(ms))} ms {p['direction']} against the beat here — "
                 f"count the pulse aloud and place the downbeat exactly with it",
                 _t_of(m), confirmed=True, timing=round(ms, 1), priority=2)

        for m, d in timing_report["drift"].items():
            _add(m, "timing",
                 f"this measure runs at about {d['local_bpm']:.0f} BPM against your "
                 f"{d['piece_bpm']:.0f} BPM — {d['pct']}% {d['direction']}; "
                 f"practise it with a metronome at {d['piece_bpm']:.0f}",
                 _t_of(m), confirmed=True, priority=2)

        for m, du in timing_report["durations"].items():
            held = du["direction"] == "long"
            _add(m, "timing",
                 f"the {du['pitch']} on beat {du['beat']:g} is held "
                 f"{'about ' + str(round(du['ratio'], 1)) + 'x its written length' if held else 'only ' + str(int(round(du['ratio'] * 100))) + '% of its written length'} "
                 f"({abs(int(round(du['delta_ms'])))} ms {'too long' if held else 'too short'}) — "
                 f"{'release it on the following beat' if held else 'sustain it to its full value'}",
                 du.get("time_sec") or _t_of(m), confirmed=True,
                 timing=round(abs(du["delta_ms"]), 1), priority=2)

        ov = timing_report.get("overall")
        if ov:
            _add(ov["measure_lo"], "timing",
                 f"tempo {ov['direction']} across the passage — you start around "
                 f"{ov['start_bpm']:.0f} BPM and finish around {ov['end_bpm']:.0f} BPM "
                 f"({ov['pct']}%); play it through with a metronome to hold one tempo",
                 _t_of(ov["measure_lo"]), confirmed=True, is_global=True, priority=2,
                 measure_end=ov["measure_hi"] if ov["measure_hi"] > ov["measure_lo"] else None)

    # 3. CREPE-detected wrong notes not already flagged by Gemini.
    for cand in wrong_note_candidates:
        mm = re.search(r'measure (\d+)', cand)
        if mm:
            _add(int(mm.group(1)), "error", cand, None, confirmed=True)

    # 4. Posture & technique — global visual observations from Gemini.
    # Derive a measure from any timestamp in the text so the flag lands somewhere
    # sensible; posture/technique are whole-performance notes so the exact spot is
    # not critical, but we avoid dumping them all on one measure.
    def _first_ts(text: str) -> float | None:
        mt = re.search(r'(\d+:\d{2})', text)
        return parse_mmss_to_seconds(mt.group(1)) if mt else None
    for obs in gemini_assessment.get("posture_issues", []):
        ts = _first_ts(str(obs))
        _add(time_to_measure(ts) or measure_lo, "posture", str(obs), ts, confirmed=True, is_global=True)
    for obs in gemini_assessment.get("technique_issues", []):
        ts = _first_ts(str(obs))
        _add(time_to_measure(ts) or measure_lo, "technique", str(obs), ts, confirmed=True, is_global=True)

    if not canonical:
        print("[compare_and_coach_claude] no canonical issues from Gemini or CREPE")
        return []

    # Dedup: one issue per (measure, type); posture/technique collapse to one each.
    seen_keys: set = set()
    deduped_issues: list[dict] = []
    # Prefer confirmed, then larger deviation, so the strongest survives a dedup.
    # _priority breaks ties within a (measure, type): a measured timing finding
    # must beat Gemini's unquantified one for the same measure, which would
    # otherwise win purely by being appended first.
    for iss in sorted(canonical, key=lambda x: (not x["confirmed"], -x.get("_priority", 0), -(x["cents"] or 0))):
        if iss["type"] in ("posture", "technique"):
            key = iss["type"]
        else:
            key = (iss["measure"], iss["type"])
        if key in seen_keys:
            continue
        seen_keys.add(key)
        deduped_issues.append(iss)
    deduped_issues.sort(key=lambda x: (x["measure"], x["type"]))
    # Cover the whole piece: coach up to 40 distinct issues (was 16). The user wants
    # every played measure examined, so we do not throttle coverage here.
    deduped_issues = deduped_issues[:40]

    # Drop unconfirmed (Tier B, not corroborated by CREPE) issues entirely rather than
    # showing them hedged ("possible hesitation", "may have rushed") — the user doesn't
    # want low-confidence guesses in the report at all, only things we can state as fact.
    dropped_unconfirmed = sum(1 for iss in deduped_issues if not iss["confirmed"])
    deduped_issues = [iss for iss in deduped_issues if iss["confirmed"]]
    if dropped_unconfirmed:
        print(f"[compare_and_coach_claude] dropped {dropped_unconfirmed} unconfirmed "
              f"(hedged) issue(s) — only reporting confirmed findings")
    if not deduped_issues:
        return []

    # ── Claude writes coaching text for EACH canonical issue (no selection) ──
    coaching_by_index: dict[int, dict] = {}
    issue_lines = []
    for i, iss in enumerate(deduped_issues):
        m_end = iss.get("measure_end")
        loc = f"m.{iss['measure']}-{m_end}" if m_end else f"m.{iss['measure']}"
        if iss["time_sec"] is not None:
            loc += f" ({int(iss['time_sec']) // 60}:{int(iss['time_sec']) % 60:02d})"
        issue_lines.append(f"[{i}] type={iss['type']} | {loc} | observed: {iss['observed']}")
    coach_prompt = f"""You are a master {instrument} teacher writing feedback on a student's performance of "{piece_title}" by {composer}.

Below is the VERIFIED list of issues found in the performance. Write specific coaching for EACH issue. Do NOT add, remove, merge, reorder, or skip any — return exactly one coaching entry per issue, matched by its index "i".

The location given for each issue (e.g. "m.25" or "m.25-27") is the VERIFIED, authoritative measure — it was computed from the recording's timing, not read off the page, so trust it completely. If the "observed" text for an issue mentions a different measure number, that is a stale/incorrect reference — ignore it and use ONLY the given location in your title and body. Never cite a measure number in your response other than the one given for that issue.

Every issue below is CONFIRMED — state it as fact. Never use hedging language like "possible", "may have", "appears to", or "worth checking".

For "intonation" issues specifically: the title you write will be discarded and replaced with just "Sharp" or "Flat", so don't worry about the title for those — but make the body state the exact cents deviation (given in "observed") and a concrete embouchure/air-support fix for that direction.
{f'Student note about this take (context only, do not excuse issues): "{user_note}"' if user_note else ''}

ISSUES:
{chr(10).join(issue_lines)}

Return JSON only (no markdown):
{{"coaching": [{{"i": <index>, "title": "<6-10 word specific title naming the exact issue>", "body": "<3 sentences: (1) what happened and where, (2) why it matters musically, (3) a specific practice fix the student can do today>"}}]}}"""
    try:
        client = ac.Anthropic(api_key=anthropic_api_key)
        msg    = client.messages.create(
            model=CLAUDE_MODEL, max_tokens=16000,
            messages=[{"role": "user", "content": coach_prompt}],
        )
        parsed = extract_json_object(msg.content[0].text)
        for c in (parsed or {}).get("coaching", []):
            if isinstance(c, dict) and isinstance(c.get("i"), (int, float)):
                coaching_by_index[int(c["i"])] = {
                    "title": str(c.get("title", "")).strip(),
                    "body":  str(c.get("body", "")).strip(),
                }
    except Exception as e:
        print(f"[compare_and_coach_claude] coaching call failed, using templates: {e}")

    # ── Assemble final flags (Gemini/CREPE issue set is the floor) ──────────
    TYPE_LABEL = {
        "error": "Note accuracy", "intonation": "Intonation", "timing": "Timing",
        "rhythm": "Rhythm", "dynamics": "Dynamics", "tone": "Tone quality",
        "posture": "Posture", "technique": "Technique", "articulation": "Articulation",
        "phrasing": "Phrasing", "voicing": "Voicing",
    }
    flags: list[dict] = []
    for i, iss in enumerate(deduped_issues):
        coach = coaching_by_index.get(i) or {}
        if iss["type"] == "intonation" and iss.get("direction"):
            # User preference: the intonation title should just say "Sharp"/"Flat" —
            # the cents amount and fix belong in the body, not the headline. Overrides
            # whatever title Claude wrote (it's told this will happen; the coaching
            # prompt asks it to focus effort on the body for these instead).
            title = iss["direction"].capitalize()
        else:
            title = coach.get("title") or f"{TYPE_LABEL.get(iss['type'], iss['type'].title())} — m.{iss['measure']}"
        body  = coach.get("body") or (
            f"{iss['observed']}. Focus a few slow, careful repetitions on this spot, "
            f"listening closely, before playing it back up to tempo."
        )
        # Build the loop window from the SAME mapping that produced the measure label
        # (measure_to_time_range is the exact inverse of time_to_measure). This is what
        # guarantees the Loop button always plays the measure(s) shown on the flag —
        # previously the window was built from the raw Gemini timestamp plus a fixed
        # 3.5s pad, which routinely overran (or, when padding backward, preceded) the
        # labeled measure's real boundaries, so what played didn't match what was shown.
        m_end = iss.get("measure_end")
        ts_start, ts_end = measure_to_time_range(iss["measure"], m_end)
        # measure_to_time_range already gives the EXACT duration of the labeled
        # measure(s) — do NOT pad it up to est_measure_sec (a coarse GLOBAL average
        # across the whole piece). That was the bug: whenever the global average was
        # longer than this specific measure's real duration, the loop got stretched
        # past the measure's true end into neighboring measures never mentioned in the
        # flag. Only guard against a pathologically short (near-inaudible) window.
        MIN_AUDIBLE = 1.0
        if ts_end - ts_start < MIN_AUDIBLE:
            ts_end = ts_start + MIN_AUDIBLE
        if piece_len > 0:
            ts_end = min(ts_end, piece_len)
        ts_start, ts_end = round(max(0.0, ts_start), 3), round(max(ts_start, ts_end), 3)
        flags.append({
            "measure":              iss["measure"],
            "measure_end":          m_end,
            "beat":                 None,
            "type":                 iss["type"],
            "title":                title,
            "raw_detail":           iss["observed"],
            "detail":               body,
            "body":                 body,
            "confidence":           92 if iss["confirmed"] else 74,
            "timestamp_start":      ts_start,
            "timestamp_end":        ts_end,
            "cents_deviation":      iss["cents"],
            "timing_deviation_ms":  iss["timing"],
            "confirmed":            iss["confirmed"],
        })

    flags.sort(key=lambda x: x["measure"])
    # Do NOT group: the user wants to see EVERY played measure with an issue as its own
    # row, not collapsed into "Recurring intonation — N passages" headers. Each issue
    # stays a distinct flag. Cap at 40 to cover the whole piece without runaway.
    grouped = flags[:40]
    print(f"[compare_and_coach_claude] {len(deduped_issues)} canonical issues → "
          f"{len(flags)} flags → {len(grouped)} individual (ungrouped): "
          f"{[(g.get('measure'), g.get('type'), g.get('grouped')) for g in grouped]}")
    return grouped


def assess_quality(
    score: dict, events: list[dict], aligned: list[dict],
    alignment_ranges: list[dict],
) -> dict:
    # Gemini is always present (required upstream) — quality depends on CREPE + score
    reasons: list[str] = []
    if len(score.get("measures", [])) < 2:
        reasons.append("Score could not be parsed — measure timestamps are approximate.")
    if len(events) < 8:
        reasons.append("Few audio events detected — recording may be very short or quiet.")
    if len(aligned) < 4:
        reasons.append("Few events aligned to score measures — timestamp accuracy limited.")
    if not reasons:
        return {"trust": "high", "canProceed": True, "reasons": []}
    return {"trust": "medium", "canProceed": True, "reasons": reasons}


def post_webhook(webhook_url: str, webhook_secret: str | None, payload: dict, anon_key: str | None = None) -> None:
    import httpx
    try:
        headers = {"Content-Type": "application/json"}
        if webhook_secret:
            headers["x-webhook-secret"] = webhook_secret
        if anon_key:
            headers["Authorization"] = f"Bearer {anon_key}"
            headers["apikey"] = anon_key
        with httpx.Client(timeout=30) as client:
            resp = client.post(webhook_url, json=payload, headers=headers)
            print(f"[post_webhook] status={resp.status_code}")
            if resp.status_code >= 400:
                print(f"[post_webhook] body={resp.text[:200]}")
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

    take_id             = payload["take_id"]
    webhook_url         = payload["webhook_url"]
    webhook_secret      = payload.get("webhook_secret")
    webhook_anon_key    = payload.get("webhook_anon_key")
    video_url           = payload.get("video_url")
    video_mime          = payload.get("video_mime_type", "video/mp4")
    score_url           = payload.get("score_url")
    score_mime          = payload.get("score_mime_type", "")
    score_path          = payload.get("score_path")          # stable storage path for cache key
    cached_score_notes  = payload.get("cached_score_notes")  # pre-parsed notes from Supabase cache
    reference_midi_url  = payload.get("reference_midi_url")  # optional signed URL
    instrument          = payload.get("instrument", "instrument")
    piece_title         = payload.get("piece_title", "this piece")
    composer            = payload.get("composer", "the composer")
    time_sig            = payload.get("time_sig", "4/4")
    start_measure       = int(payload.get("start_measure", 1))
    end_measure         = payload.get("end_measure")
    gemini_key          = payload.get("gemini_api_key")
    anthropic_key       = payload.get("anthropic_api_key")
    user_note           = (payload.get("user_note") or "").strip()[:800]
    debug_steps: list[str] = []  # pipeline step log for diagnostics
    parsed_score_notes: dict | None = None  # freshly parsed notes to cache via webhook

    try:
        num, denom = map(int, time_sig.split("/"))
        is_compound = num % 3 == 0 and num // 3 >= 2 and denom >= 8
        bpm_int = num // 3 if is_compound else num
    except Exception:
        bpm_int = 4

    try:
        from concurrent.futures import ThreadPoolExecutor

        # ── Step 1: Download video ─────────────────────────────────────────
        print(f"[run_full_analysis] downloading video for take {take_id}")
        with httpx.Client(timeout=120) as client:
            vresp = client.get(video_url, follow_redirects=True)
            vresp.raise_for_status()
            video_bytes = vresp.content
        print(f"[run_full_analysis] video: {len(video_bytes):,} bytes")

        if not gemini_key:
            raise RuntimeError("GOOGLE_AI_API_KEY not provided — Gemini audio analysis is required")

        # ── Steps 2-4 in parallel: CREPE + Gemini upload + score download ─
        # These three pipelines are fully independent after the video download.
        # Running them concurrently cuts total time by ~50% (Gemini upload/poll
        # used to block CREPE for 30-60s on a warm file).

        def _crepe_pipeline():
            wav_b, dur = extract_audio_from_video(video_bytes)
            bts = run_beat_tracking(wav_b)
            evts = run_pitch_tracking(wav_b, guide_times=bts["beat_times"], instrument=instrument)
            return wav_b, dur, bts, evts

        def _gemini_pipeline():
            print("[run_full_analysis] uploading video to Gemini Files API")
            uri = upload_video_to_gemini(video_bytes, video_mime, gemini_key)
            # Download score bytes for simultaneous comparison (visual formats only)
            sc_bytes: bytes | None = None
            sc_mime:  str   | None = None
            if score_url:
                try:
                    with httpx.Client(timeout=60) as cl:
                        sr = cl.get(score_url, follow_redirects=True)
                        sr.raise_for_status()
                        sc_bytes = sr.content
                    kind = sniff_score_kind(sc_bytes, score_mime, score_url)
                    if kind == "visual":
                        # "visual" covers PNG, JPEG, TIFF, and PDF (sniff_score_kind returns
                        # "visual" for PDFs). Gemini inlineData accepts application/pdf natively.
                        # score_mime from the browser is the authoritative type (e.g. "application/pdf").
                        sc_mime = score_mime or "image/png"
                        print(f"[_gemini_pipeline] score included ({len(sc_bytes):,}B, {sc_mime})")
                    else:
                        sc_bytes = None
                        print(f"[_gemini_pipeline] score kind={kind} — not visual, skipping inline")
                except Exception as e:
                    print(f"[_gemini_pipeline] score download failed (continuing without): {e}")
            return evaluate_with_gemini(
                uri, video_mime, instrument,
                piece_title, composer, start_measure, end_measure, gemini_key,
                user_note=user_note,
                score_bytes=sc_bytes,
                score_mime=sc_mime,
            )

        def _score_pipeline():
            s: dict = {"key_signature": None, "time_signature": None, "tempo_marking": None, "measures": []}
            ps_notes = None
            if not score_url:
                return s, ps_notes
            print("[run_full_analysis] downloading score")
            with httpx.Client(timeout=90) as client:
                sresp = client.get(score_url, follow_redirects=True)
                sresp.raise_for_status()
                sb = sresp.content
            print(f"[run_full_analysis] score: {len(sb):,} bytes, mime={score_mime}")
            kind = sniff_score_kind(sb, score_mime, score_url)
            print(f"[run_full_analysis] score kind: {kind}")
            if kind in ("xml", "mxl"):
                res = parse_score_document(sb, start_measure)
                if not res.get("error") and res.get("measures"):
                    s = res
            elif kind == "visual" and anthropic_key:
                if cached_score_notes and cached_score_notes.get("measures"):
                    s = cached_score_notes
                else:
                    res = read_score_notes_claude(sb, score_mime, start_measure, instrument, time_sig, anthropic_key)
                    if res.get("measures"):
                        s = res
                        ps_notes = res
                    elif res.get("error"):
                        s = {**s, "error": res["error"]}
            # For any visual score, get exact measure positions from Gemini
            if kind == "visual" and gemini_key and s.get("measures"):
                positions = get_measure_positions_gemini(sb, score_mime, gemini_key)
                if positions:
                    for m in s["measures"]:
                        pos = positions.get(m["number"])
                        if pos:
                            m["x_pct"], m["y_pct"] = pos
            return s, ps_notes

        with ThreadPoolExecutor(max_workers=3) as pool:
            crepe_fut  = pool.submit(_crepe_pipeline)
            gemini_fut = pool.submit(_gemini_pipeline)
            score_fut  = pool.submit(_score_pipeline)

            wav_bytes, video_duration, beats, raw_events = crepe_fut.result()
            debug_steps.append(f"audio_extracted: {len(wav_bytes):,}B duration={video_duration:.1f}s")
            debug_steps.append(f"beat_tracking: tempo={beats['tempo_bpm']:.1f}bpm beats={len(beats['beat_times'])}")
            debug_steps.append(f"pitch_tracking: {len(raw_events)} events (CREPE)")

            try:
                gemini_assessment = gemini_fut.result()
                debug_steps.append(
                    f"gemini: intonation={len(gemini_assessment.get('intonation_issues',[]))} "
                    f"rhythm={len(gemini_assessment.get('rhythm_issues',[]))} "
                    f"wrong_notes={len(gemini_assessment.get('wrong_notes_cracks',[]))}"
                )
                print(f"[run_full_analysis] Gemini assessment complete: "
                      f"{len(gemini_assessment.get('intonation_issues', []))} intonation, "
                      f"{len(gemini_assessment.get('rhythm_issues', []))} rhythm")
            except Exception as gemini_err:
                debug_steps.append(f"gemini: FAILED {gemini_err}")
                raise

            score, parsed_score_notes_inner = score_fut.result()
            if parsed_score_notes_inner:
                parsed_score_notes = parsed_score_notes_inner
            total_m = len(score.get("measures", []))
            _score_err = score.get("error")
            debug_steps.append(
                f"score_parse: {total_m} measures" + (f" — FAILED: {_score_err}" if _score_err else "")
            )

        # Change 4: cross-validate Gemini measure numbers against parsed score range
        gemini_assessment, n_discarded = validate_gemini_measures(gemini_assessment, score)
        if n_discarded:
            debug_steps.append(f"gemini_validate: discarded {n_discarded} out-of-range measure refs")

        # Override bpm_int if the score parser detected a time signature
        detected_ts = score.get("time_signature")
        if detected_ts:
            try:
                ts_num, ts_denom = map(int, detected_ts.split("/"))
                is_cpd = ts_num % 3 == 0 and ts_num // 3 >= 2 and ts_denom >= 8
                bpm_int = ts_num // 3 if is_cpd else ts_num
                debug_steps.append(f"bpm_int_override: {detected_ts} → bpm_int={bpm_int}")
                print(f"[run_full_analysis] bpm_int overridden to {bpm_int} from score time_sig={detected_ts}")
            except Exception:
                pass

        events_with_measures = assign_events_to_measures(raw_events, beats["beat_times"], bpm_int, start_measure)

        # ── Reference MIDI (optional, fast) ───────────────────────────────
        ref_notes: list[dict] = []
        if reference_midi_url:
            try:
                print("[run_full_analysis] downloading reference MIDI")
                with httpx.Client(timeout=60) as client:
                    rresp = client.get(reference_midi_url, follow_redirects=True)
                    rresp.raise_for_status()
                    ref_midi_bytes = rresp.content
                ref_notes = parse_reference_midi(ref_midi_bytes, start_measure)
                debug_steps.append(f"reference_midi: {len(ref_notes)} notes")
            except Exception as ref_err:
                print(f"[run_full_analysis] reference MIDI error (non-fatal): {ref_err}")
                debug_steps.append(f"reference_midi: error={ref_err}")

        # ── Step 4: Assign events to measures ─────────────────────────────
        # Priority order for alignment (most → least accurate):
        #   1. Reference MIDI DTW  — pitch + real timing from a canonical recording
        #   2. Score DTW           — pitch sequences from MusicXML (no timing reference)
        #   3. Beat-grid           — tempo-based linear mapping
        #   4. Tempo anchor        — last-resort estimation

        aligned: list[dict] = []
        alignment_ranges: list[dict] = []
        alignment_method_used = "beat_grid"   # overwritten below on success; used for the backend label

        if ref_notes and len(ref_notes) >= 4:
            print(f"[run_full_analysis] using reference MIDI alignment ({len(ref_notes)} reference notes)")
            aligned, alignment_ranges = dtw_align_to_reference(raw_events, ref_notes, start_measure)
            alignment_method_used = "reference_midi_dtw"
            debug_steps.append(f"alignment: reference_midi_dtw aligned={len(aligned)} ranges={len(alignment_ranges)}")
        else:
            total_score_notes = sum(len(m.get("notes", [])) for m in score.get("measures", []))
            score_source      = (score.get("source") or "")
            # DTW matches the ACTUAL PITCH SEQUENCE played against the score's note
            # sequence, so a flag's measure/timestamp is anchored to where that specific
            # pattern of notes was really heard — not a beat-count estimate that drifts
            # if a beat tracker ever misses/adds one beat somewhere earlier in the piece.
            # Previously restricted to MusicXML ("music21" source) scores; most takes
            # here use a photo of the sheet music instead (Claude-vision-read), which
            # was always falling back to the far less accurate beat-grid method even
            # though the score dict has the same {measures: [{notes: [...]}]} shape DTW
            # needs. Photo-read note data is less precise per-note than MusicXML, so
            # require a larger sample (12 vs 4) before trusting it for alignment.
            is_musicxml = "music21" in score_source
            is_vision   = score_source.startswith("claude_vision")
            min_notes   = 4 if is_musicxml else 12
            if total_score_notes >= min_notes and (is_musicxml or is_vision):
                print(f"[run_full_analysis] using score DTW ({total_score_notes} score notes, "
                      f"source={score_source}, window=m.{start_measure}..{end_measure or 'open'})")
                aligned = dtw_align_to_score(raw_events, score, start_measure, bpm_int,
                                             end_measure=end_measure)
                if aligned:
                    alignment_method_used = "score_dtw"
                debug_steps.append(f"alignment: score_dtw notes={total_score_notes} aligned={len(aligned)}")
            if not aligned:
                if total_score_notes >= min_notes and (is_musicxml or is_vision):
                    print("[run_full_analysis] score DTW declined/empty — falling back to beat-grid")
                print(f"[run_full_analysis] using beat-grid alignment (score_notes={total_score_notes}, source={score_source})")
                aligned = [ev for ev in events_with_measures if "measure" in ev]
                alignment_method_used = "beat_grid"
                debug_steps.append(f"alignment: beat_grid aligned={len(aligned)}")

            # Build alignment_ranges from aligned events when not using reference
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
            # Chain each measure's end to the NEXT measure's first onset, so the
            # ranges are contiguous and non-overlapping.
            #
            # These onset spans are the single source of truth for both the flag's
            # measure number (time_to_measure) and its Loop window
            # (measure_to_time_range), so their shape has to be right twice over:
            #   * the old `start + 0.9 * nominal measure` padding could OVERLAP the
            #     next measure, and time_to_measure returns the FIRST range that
            #     contains the timestamp — so notes belonging to m+1 were labelled
            #     m, i.e. the number disagreed with the clip that played.
            #   * min/max of onsets alone ends a measure on its LAST NOTE'S ONSET,
            #     which both truncates that note from the loop and leaves a gap
            #     before the next measure; timestamps landing in the gap fell
            #     through to the beat grid and disagreed with the DTW ranges again.
            _items = [(m, r) for m, r in sorted(ranges_acc.items()) if r["start"] != float("inf")]
            alignment_ranges = []
            for _i, (_m, _r) in enumerate(_items):
                _start = _r["start"]
                _nxt = _items[_i + 1] if _i + 1 < len(_items) else None
                if _nxt is not None:
                    _end = _nxt[1]["start"]
                    # A gap in measure numbers means measures we detected nothing
                    # in; don't let one measure swallow all of them.
                    if _nxt[0] != _m + 1:
                        _end = min(_end, _start + sec_per_measure)
                else:
                    # Last measure: no following onset to chain to, so give it a
                    # full nominal measure past its final detected note.
                    _end = max(_r["end"] + sec_per_measure / max(1, bpm_int), _start + sec_per_measure)
                alignment_ranges.append({
                    "measure": _m,
                    "start":   _start,
                    "end":     max(_end, _start + 0.25),
                })

        if end_measure:
            aligned          = [ev for ev in aligned if ev["measure"] <= end_measure]
            alignment_ranges = [r for r in alignment_ranges if r["measure"] <= end_measure]

        # Fallback: tempo-based alignment
        if not aligned and raw_events:
            print("[run_full_analysis] falling back to tempo-based alignment")
            aligned, sec_per_measure, alignment_ranges = anchor_and_align_py(
                score, raw_events, beats["tempo_bpm"], beats["duration_sec"] or video_duration, start_measure,
            )
            debug_steps.append(f"alignment: tempo_anchor (fallback) aligned={len(aligned)}")
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
        quality = assess_quality(score, raw_events, aligned, alignment_ranges)
        if ref_notes:
            quality["alignment_source"] = "reference_midi"
        print(f"[run_full_analysis] quality trust={quality['trust']}, canProceed={quality['canProceed']}")
        debug_steps.append(f"quality: trust={quality['trust']}")

        # ── Step 7: Claude coaching (Gemini audio data is always present) ──
        flags: list[dict] = []
        if anthropic_key:
            flags = compare_and_coach_claude(
                score=score, aligned=aligned, alignment_ranges=alignment_ranges,
                tempo={"bpm": beats["tempo_bpm"], "steadiness": "steady"},
                piece_title=piece_title, composer=composer, instrument=instrument,
                gemini_assessment=gemini_assessment, anthropic_api_key=anthropic_key,
                user_note=user_note,
                video_duration=beats.get("duration_sec") or video_duration,
                start_measure=start_measure,
                beat_times=beats.get("beat_times"),
                beats_per_measure=bpm_int,
                end_measure=end_measure,
                dtw_verified=(alignment_method_used in ("score_dtw", "reference_midi_dtw")),
            )
            debug_steps.append(f"claude_coaching: {len(flags)} flags")
        else:
            raise RuntimeError("ANTHROPIC_API_KEY not provided")

        alignment_method = alignment_method_used
        base_score = compute_weighted_score(flags)
        backend    = f"modal+gemini+claude ({alignment_method})"
        print(f"[run_full_analysis] done | score={base_score} | flags={len(flags)} | backend={backend}")

        post_webhook(webhook_url, webhook_secret, {
            "takeId":            take_id,
            "score":             base_score,
            "flags":             flags,
            "measureLayout":     score if score.get("measures") else None,
            "audioAlignment":    alignment_ranges if alignment_ranges else None,
            "analysisQuality":   quality,
            "analysisBackend":   backend,
            "pipelineDebug":     debug_steps,
            "parsedScoreNotes":  parsed_score_notes,
            "scorePath":         score_path,
        }, anon_key=webhook_anon_key)

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[run_full_analysis] FATAL ERROR for take {take_id}: {e}\n{tb}")
        debug_steps.append(f"FATAL: {e}")
        post_webhook(webhook_url, webhook_secret, {
            "takeId":        take_id,
            "error":         str(e),
            "pipelineDebug": debug_steps,
        }, anon_key=webhook_anon_key)


# ── Fire-and-forget dispatcher endpoint ───────────────────────────────────

@app.function(image=image, timeout=30, min_containers=1)
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
