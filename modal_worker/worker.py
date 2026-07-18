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


def dtw_align_to_score(
    events: list[dict],
    score: dict,
    start_measure: int,
    beats_per_measure: int,
) -> list[dict]:
    """
    Align CREPE pitch events to score measures using Dynamic Time Warping.

    Works by building two sequences:
      - audio_seq: MIDI pitch of each detected event (from CREPE)
      - score_seq: MIDI pitch of each score note, flattened in order

    DTW finds the minimum-cost warping path between them. Each audio event
    is mapped to the score note it best aligns with, and inherits that
    note's measure number. This handles tempo fluctuations, hesitations,
    and repeats far better than linear time mapping.

    Only activated when the score has structured note data (MusicXML/MXL).
    Falls back gracefully if the score has fewer than 4 notes total.
    """
    import numpy as np

    measures = score.get("measures", [])
    if not measures or not events:
        return events

    # Build flattened score sequence: (midi_pitch, measure_number)
    score_seq: list[tuple[int, int]] = []
    for m in measures:
        for note in m.get("notes", []):
            pitch = note.get("pitch")
            if pitch:
                midi = midi_from_name(pitch)
                if midi is not None:
                    score_seq.append((midi, m["number"]))

    if len(score_seq) < 4:
        print(f"[dtw_align] score has <4 pitched notes — falling back to beat-grid alignment")
        return events

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

    # Traceback from (n-1, m_len-1) to (0, 0)
    path_audio_to_score: list[int] = [0] * n
    i, j = n - 1, m_len - 1
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

    # Map each audio event to a measure number via the score alignment
    result = []
    for idx, ev in enumerate(events):
        score_idx   = path_audio_to_score[idx]
        measure_num = score_seq[score_idx][1]
        result.append({**ev, "measure": measure_num})

    # Sanity check: count how many distinct measures were assigned
    measures_hit = len({ev["measure"] for ev in result})
    total_score_measures = len(measures)
    print(f"[dtw_align] {n} audio events → {measures_hit}/{total_score_measures} score measures covered")
    return result


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

def extract_json_object(raw: str) -> dict | None:
    import json, re
    # Strip all markdown code fences regardless of position or leading whitespace
    text = re.sub(r'```(?:json)?\s*', '', raw, flags=re.IGNORECASE).strip()
    start = text.find('{')
    end   = text.rfind('}')
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(text[start:end + 1])
    except Exception:
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
                    "generationConfig": {"temperature": 0, "maxOutputTokens": 2048},
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
    score_block = """
SHEET MUSIC: You have the score image above. Read the printed measure numbers directly off the page (look for numbers printed above/below the staff, or boxed rehearsal marks which indicate measure numbers). When reporting issues, give the EXACT PRINTED measure number from the score — do not guess or estimate.
IMPORTANT: Only flag issues during passages where notes are written in the score. Do NOT flag anything heard during rests, between phrases, or in silence — even if there is ambient sound or breathing audible in the recording. If a measure contains only rests, skip it entirely.
""" if has_score else f"""
No score image provided. The recording starts at measure {start_measure}. Use timestamps only.
IMPORTANT: Only flag issues during passages where the student is actively playing. Do NOT flag sounds heard during rests, breaths, or silence between phrases.
"""

    prompt = f"""PERFORMANCE ANALYSIS TASK. You are analyzing a student's recording of "{piece_title}" by {composer} on {instrument}.
{score_block}
You have access to BOTH the audio AND the video. Listen carefully to the sound for categories 1–5. Observe the player visually for categories 6–7.

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

Return JSON only (no markdown fences). Each issue MUST be an object with "measure" (int — the printed number from the score, or {start_measure} if no score), "time" (string "M:SS"), and "description" (string):
{{
  "intonation_issues": [{{"measure": <int>, "time": "<M:SS>", "description": "<note/passage> sounds <sharp|flat> by <magnitude>"}}],
  "rhythm_issues": [{{"measure": <int>, "time": "<M:SS>", "description": "<specific observation>"}}],
  "wrong_notes_cracks": [{{"measure": <int>, "time": "<M:SS>", "description": "<what was heard vs. expected>"}}],
  "dynamics_issues": [{{"measure": <int>, "time": "<M:SS>", "description": "<marking expected vs. what was played>"}}],
  "tone_issues": [{{"measure": <int>, "time": "<M:SS>", "description": "<specific description>"}}],
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

    last_error = "no models attempted"
    for model in GEMINI_MODELS:
        try:
            with httpx.Client(timeout=120) as client:
                resp = client.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
                    json={
                        "contents": [{"parts": parts}],
                        "generationConfig": {"temperature": 0, "maxOutputTokens": 4096},
                    },
                )
            if not resp.is_success:
                last_error = f"{model} → HTTP {resp.status_code}: {resp.text[:200]}"
                print(f"[evaluate_with_gemini] {last_error}")
                if resp.status_code in (401, 403):
                    raise RuntimeError(f"Gemini auth error ({resp.status_code}) — check GOOGLE_AI_API_KEY")
                continue
            data = resp.json()
            # Skip thinking parts (gemini-2.5 series); use resp_parts to avoid shadowing request parts
            resp_parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            text = next((p.get("text", "") for p in resp_parts if not p.get("thought") and p.get("text", "").strip()), "")
            if not text:
                last_error = f"{model} → empty response"
                print(f"[evaluate_with_gemini] {last_error}")
                continue
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

MEASURE NUMBERING — CRITICAL: Trust the printed measure numbers you can see on the page (numbers above/below the staff or boxed rehearsal numbers). The first printed number you see is the authoritative start. Do not renumber or recount — use exactly what is printed. If no numbers are printed, count barlines starting from {start_measure}.

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
            model="claude-haiku-4-5-20251001",
            max_tokens=8192,
            messages=[{"role": "user", "content": [vision_part, {"type": "text", "text": prompt}]}],
        )
        raw    = msg.content[0].text
        parsed = extract_json_object(raw)
        if not parsed:
            print(f"[read_score_notes_claude] no JSON: {raw[:300]}")
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
    Discard Gemini issue items whose reported measure numbers fall outside the
    range of measures that music21 (or Claude vision) actually parsed.  Only
    meaningful when `score["measures"]` is non-empty.

    Returns (validated_assessment, n_discarded).
    """
    measures = score.get("measures", [])
    if not measures:
        return assessment, 0

    known_nums = {int(m["number"]) for m in measures if isinstance(m.get("number"), (int, float))}
    if not known_nums:
        return assessment, 0

    min_m, max_m = min(known_nums), max(known_nums)
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
                    if m < min_m or m > max_m:
                        print(f"[gemini_validate] discarding {cat} m.{m} — outside "
                              f"parsed score range [{min_m},{max_m}]")
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
        print(f"[gemini_validate] discarded {discarded} items with out-of-range measure numbers")

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

    # Cluster by (type, direction)
    clusters: dict = {}
    for flag in flags:
        key = (flag.get('type'), _direction(flag))
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
) -> list[dict]:
    import anthropic as ac, re
    CLAUDE_MODEL = "claude-haiku-4-5-20251001"
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
    strongest = evidence_candidates[:8]

    # Add direct CREPE-vs-score wrong note candidates
    wrong_note_candidates = find_wrong_note_candidates(aligned, score)

    crepe_has_data = bool(strongest or wrong_note_candidates)
    # Gemini is always present — check if it found anything across all categories
    has_gemini_data = bool(any(
        gemini_assessment.get(k) for k in (
            "intonation_issues", "rhythm_issues", "wrong_notes_cracks",
            "dynamics_issues", "tone_issues", "posture_issues", "technique_issues",
        )
    ))
    if not strongest and not wrong_note_candidates and not has_gemini_data:
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

    valid_list = sorted(set(r["measure"] for r in alignment_ranges))
    if not valid_list and score.get("measures"):
        valid_list = sorted(m["number"] for m in score["measures"])
    # Extend valid_list with measure numbers Gemini read from the printed score
    gemini_measures: set[int] = set()
    for _cat in ("intonation_issues", "rhythm_issues", "wrong_notes_cracks", "dynamics_issues", "tone_issues"):
        for _item in gemini_assessment.get(_cat, []):
            if isinstance(_item, dict):
                try:
                    gemini_measures.add(int(_item["measure"]))
                except (KeyError, ValueError, TypeError):
                    pass
    if gemini_measures:
        valid_list = sorted(set(valid_list) | gemini_measures)

    # Change 1: cross-check Tier B Gemini items against CREPE signal data
    annotated_assessment = _cross_check_gemini_tier_b(
        gemini_assessment, events_by_measure, wrong_note_candidates,
        evidence_candidates, cents_flag_threshold,
    )
    gemini_block = build_gemini_block(annotated_assessment)
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
    all_candidates = strongest + wrong_note_candidates
    if all_candidates:
        cand_block = "MEASURABLE ISSUE CANDIDATES (from CREPE pitch analysis):\n" + "\n".join(
            f"{i+1}. {e}" for i, e in enumerate(all_candidates)
        )
    else:
        cand_block = "MEASURABLE ISSUE CANDIDATES: (pitch analysis did not produce specific candidates — rely on Gemini evidence below)"
    prompt = f"""You are a master {instrument} teacher giving targeted, evidence-based feedback on "{piece_title}" by {composer}.

{chr(10).join(measure_blocks)}

{cand_block}

Tempo: {tempo.get('bpm', '?')} BPM. Key: {score.get('key_signature', '?')}. Time signature: {score.get('time_signature', '?')}.
{gemini_block}
{f'STUDENT NOTE (subjective context — prioritize the evidence above; use only to interpret ambiguous moments, never to invent or excuse issues): "{user_note}"' if user_note else ''}

EVIDENCE TIERS — READ BEFORE WRITING FLAGS:
Items WITHOUT [UNCONFIRMED] are corroborated by CREPE signal analysis. Treat them as facts.
Items marked [UNCONFIRMED — no CREPE events at m.N (coverage gap)] mean CREPE had no data for that measure at all — signal analysis simply couldn't reach it.
Items marked [UNCONFIRMED — CREPE covered m.N ... no deviation ≥N¢] mean CREPE actively analyzed that measure and found no problem — this is a direct disagreement between Gemini and the signal.

For ALL [UNCONFIRMED] items you MUST:
  * Use hedged language in body and title: "may have been", "possibly", "appears to", "worth checking" — NEVER "was flat", "was rushing", "played the wrong note"

For [UNCONFIRMED] items where CREPE COVERED the measure but found nothing ("no deviation"):
  * This is a signal disagreement. Treat with maximum caution.
  * NEVER elevate to a primary/headline issue even with hedging. Place it only as a minor secondary note.
  * Do not group these into top flags under any circumstances.

For [UNCONFIRMED] items where CREPE had a COVERAGE GAP ("no CREPE events"):
  * CREPE simply had no data — Gemini may be the only signal available. It may still be real.
  * May be promoted to a headline/primary issue ONLY if it is part of a grouped flag (multiple occurrences across measures), OR if the category is one CREPE cannot measure (posture, tone, technique, dynamics).
  * Single-occurrence coverage-gap flags: include with hedging, but keep secondary unless grouped.

YOUR TASK: Identify ALL significant, actionable issues. Report every confirmed issue — do not stop early. Cover every category that Gemini observed a problem in.

PRIORITY ORDER (most important first):
1. Wrong notes / pitch errors / tone cracks — flag EVERY confirmed one ("error" type)
2. Intonation with specific direction: sharp or flat, magnitude, which note or passage ("intonation" type)
3. Rhythm/timing issues — flag every distinct rhythmic problem ("rhythm" or "timing" type)
4. Dynamics — every place a dynamic marking was missed or ignored
5. Tone quality issues
6. Posture problems if Gemini observed them visually ("posture" type)
7. Technique issues if Gemini observed them visually ("technique" type)
If Gemini reported issues in a category, you MUST include at least one flag for that category.

HARD RULES:
- Every "measure" field MUST be one of: [{', '.join(str(m) for m in valid_list)}].
- Do NOT flag rests, silence, missing notes, or coverage gaps.
- For "intonation" flags: raw_detail MUST cite cents ("+22¢") OR a timestamp (e.g. "0:08") OR a measure reference (e.g. "m.5").
- "type" must be exactly one of: intonation, timing, rhythm, articulation, dynamics, tone, error, voicing, phrasing, posture, technique.
  - "error" → wrong notes, squeaks, cracks, or any pitch that doesn't belong
  - "intonation" → audibly flat or sharp pitch (not a wrong note, just out of tune)
  - "tone" → breathy, unfocused, or over-pressured sound quality
  - "dynamics" → missed dynamic markings (too loud, too soft)
  - "articulation" → staccato/tenuto/accent execution failures
  - "phrasing" → musical shape, line, or expression issues
  - "posture" → body alignment, shoulder tension, instrument hold issues (observed visually by Gemini)
  - "technique" → mechanical execution issues: bow technique (string players), finger position, embouchure (observed visually)
  - For string instruments: bow scratches, sounding point, bow distribution, and left-hand frame issues go under "technique"; intonation on shifts goes under "intonation"
- Do NOT invent issues not supported by the Gemini evidence or CREPE candidates.
- If the Gemini evidence says something is clean in a category, do not flag it.
- Use "posture" or "technique" ONLY when Gemini's posture_issues or technique_issues explicitly mention an observation.

Return JSON only (no markdown):
{{
  "flags": [
    {{
      "measure": <int from the allowed list>,
      "beat": <number 1-based or null>,
      "type": "<type from the list above>",
      "confidence": <70-100>,
      "title": "<6-10 word specific title naming the exact issue>",
      "raw_detail": "<one sentence: the specific evidence — cite a timestamp, measure, or Gemini observation>",
      "body": "<3-sentence coaching paragraph: (1) what happened and when, (2) why it matters musically, (3) a specific daily practice fix>"
    }}
  ]
}}"""
    try:
        client = ac.Anthropic(api_key=anthropic_api_key)
        msg    = client.messages.create(
            model=CLAUDE_MODEL, max_tokens=6000,
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
        if not isinstance(m_num, (int, float)) or int(m_num) not in set(valid_list):
            continue
        if f.get("confidence", 100) < 60:
            continue
        if not all(f.get(k) for k in ("type", "title", "raw_detail", "body")):
            continue
        if str(f.get("type")) not in allowed_types:
            continue
        raw_detail = str(f.get("raw_detail", ""))
        if str(f.get("type")) == "intonation":
            # Accept: cents offset (+22¢), timestamp (0:08 or 1:23), or measure reference (m.5 / measure 5)
            has_evidence = (
                re.search(r'[+-]\d+¢', raw_detail)
                or re.search(r'\d+:\d{2}', raw_detail)
                or re.search(r'\bm\.?\s*\d+\b', raw_detail, re.IGNORECASE)
                or re.search(r'\bmeasure\s+\d+\b', raw_detail, re.IGNORECASE)
            )
            if not has_evidence:
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
        body_text = str(f.get("body", ""))
        ftype_str = str(f["type"])

        # Derive CREPE-backed deviation values (Change 2) and confirmation status (Change 1)
        cents_deviation:      float | None = None
        timing_deviation_ms:  float | None = None
        # Tier A types (dynamics, tone, posture, technique, articulation, etc.) are always
        # treated as confirmed — Gemini is the authoritative source for those.
        TIER_B_TYPES = {"intonation", "timing", "rhythm", "error"}
        confirmed: bool = ftype_str not in TIER_B_TYPES  # Tier A defaults True

        if ftype_str == "intonation":
            m_events = events_by_measure.get(m_num, [])
            cents_vals = [abs(ev.get("cents_offset") or 0) for ev in m_events
                          if ev.get("cents_offset") is not None
                          and abs(ev.get("cents_offset", 0)) >= cents_flag_threshold]
            if cents_vals:
                cents_deviation = round(max(cents_vals), 1)
                confirmed = True
            else:
                cm = re.search(r'([+-]?\d+)\s*¢', raw_detail)
                if cm:
                    cents_deviation = float(abs(int(cm.group(1))))
                # confirmed stays False — Gemini flagged it but CREPE didn't find deviation
        elif ftype_str in ("timing", "rhythm"):
            for cand in evidence_candidates:
                if f"measure {m_num}" in cand and "timing |" in cand:
                    gm = re.search(r'(\d+\.\d+)s gap', cand)
                    if gm:
                        timing_deviation_ms = round(float(gm.group(1)) * 1000, 1)
                    confirmed = True
                    break
        elif ftype_str == "error":
            confirmed = any(f"measure {m_num}" in cand for cand in wrong_note_candidates)

        flags.append({
            "measure":              m_num,
            "beat":                 beat,
            "type":                 ftype_str,
            "title":                str(f["title"]),
            "raw_detail":           raw_detail,
            "detail":               body_text,
            "body":                 body_text,
            "confidence":           int(f.get("confidence", 100)),
            "timestamp_start":      ts_start,
            "timestamp_end":        ts_end,
            "cents_deviation":      cents_deviation,
            "timing_deviation_ms":  timing_deviation_ms,
            "confirmed":            confirmed,   # False → unconfirmed Tier B, lower score penalty
        })
    # Deduplicate: allow one flag per (measure, type) but always allow posture/technique
    # regardless of measure (they're typically whole-performance observations).
    seen: set = set()
    deduped = []
    for flag in sorted(flags, key=lambda x: -x["confidence"]):
        ftype = flag["type"]
        if ftype in ("posture", "technique"):
            # Only one posture and one technique flag total (they're global observations)
            if ftype not in seen:
                seen.add(ftype)
                deduped.append(flag)
        else:
            key = (flag["measure"], ftype)
            if key not in seen:
                seen.add(key)
                deduped.append(flag)
    deduped.sort(key=lambda x: x["measure"])
    grouped = _group_similar_flags(deduped)
    # Hard cap: never return more than 12 flags (grouped items count as one)
    grouped = grouped[:12]
    print(f"[compare_and_coach_claude] {len(deduped)} raw flags → {len(grouped)} after grouping: "
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
            debug_steps.append(f"score_parse: {total_m} measures")

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

        if ref_notes and len(ref_notes) >= 4:
            print(f"[run_full_analysis] using reference MIDI alignment ({len(ref_notes)} reference notes)")
            aligned, alignment_ranges = dtw_align_to_reference(raw_events, ref_notes, start_measure)
            debug_steps.append(f"alignment: reference_midi_dtw aligned={len(aligned)} ranges={len(alignment_ranges)}")
        else:
            total_score_notes = sum(len(m.get("notes", [])) for m in score.get("measures", []))
            score_source      = (score.get("source") or "")

            if total_score_notes >= 4 and "music21" in score_source:
                print(f"[run_full_analysis] using score DTW ({total_score_notes} score notes)")
                aligned = dtw_align_to_score(raw_events, score, start_measure, bpm_int)
                debug_steps.append(f"alignment: score_dtw notes={total_score_notes} aligned={len(aligned)}")
            else:
                print(f"[run_full_analysis] using beat-grid alignment (score_notes={total_score_notes}, source={score_source})")
                aligned = [ev for ev in events_with_measures if "measure" in ev]
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
            )
            debug_steps.append(f"claude_coaching: {len(flags)} flags")
        else:
            raise RuntimeError("ANTHROPIC_API_KEY not provided")

        alignment_method = (
            "reference_midi_dtw" if ref_notes
            else "score_dtw" if (sum(len(m.get("notes", [])) for m in score.get("measures", [])) >= 4)
            else "beat_grid"
        )
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
