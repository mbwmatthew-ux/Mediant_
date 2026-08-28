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
        # Major-version ceilings only. These three were the ONLY unpinned audio
        # deps, and they are the ones that actually run pitch tracking — while
        # numpy is held below 2.0 just above. A future torch that requires numpy
        # 2.x would break the image build with nothing in the source to blame it
        # on. The ceilings cannot exclude any current 2.x/0.0.x release, so they
        # change nothing today and only stop a silent major-version jump.
        "pip install 'torch<3.0' 'torchaudio<3.0' --index-url https://download.pytorch.org/whl/cpu",
        "pip install 'torchcrepe<1.0'",
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


def measure_note_pitch(hz_frames, conf_frames):
    """Reduce a note's CREPE frames to one pitch reading.

    Returns (midi_float, hz, cents_spread). Kept pure and separate from the
    event loop because intonation flags live or die on this number, and it
    needs to be testable without audio.

    Three corrections over the obvious "confidence-weighted mean of the Hz
    frames", in descending order of how much they actually matter:

    1. Measure the SUSTAINED CORE, not the whole note. Nearly every instrument
       scoops into the attack and sags on release; including those frames drags
       the reading off centre. Worth ~6¢ on a typical scooped entry — enough on
       its own to flag a note the listener hears as in tune.
    2. Take a MEDIAN, not a mean. CREPE's characteristic failure is a lone
       octave-jump frame, which a mean smears across the whole note (a single
       bad frame in 40 moves a mean ~30¢); a median ignores it outright.
    3. Average in MIDI (log) space rather than Hz. Pitch is logarithmic in
       frequency, so the Hz-mean of a symmetric vibrato sits slightly sharp of
       true centre. This one is correctness housekeeping, not a bug fix — the
       bias is only ~0.2¢ at ±40¢ vibrato and does not reach the flag
       threshold. It matters at extreme swings, and it costs nothing.
    """
    import numpy as np
    hz_v   = np.asarray(hz_frames,   dtype=float)
    conf_v = np.asarray(conf_frames, dtype=float)

    n_v = len(hz_v)
    if n_v >= 5:
        lo = int(n_v * 0.20)
        hi = max(lo + 1, int(n_v * 0.80))
        hz_core, conf_core = hz_v[lo:hi], conf_v[lo:hi]
    else:
        hz_core, conf_core = hz_v, conf_v

    midi_frames = 12.0 * np.log2(hz_core / 440.0) + 69.0
    order = np.argsort(midi_frames)
    mf_s  = midi_frames[order]
    cw    = np.cumsum(conf_core[order] + 1e-6)
    midi_float = float(mf_s[int(np.searchsorted(cw, cw[-1] / 2.0))])
    hz         = 440.0 * (2.0 ** ((midi_float - 69.0) / 12.0))

    # How far the pitch travelled across the core, in cents (10th–90th pct).
    # A wide spread means vibrato, a slide, or an unstable note — the centre is
    # then not a trustworthy intonation reading, and callers gate on this.
    spread = (
        float((np.percentile(mf_s, 90) - np.percentile(mf_s, 10)) * 100.0)
        if len(mf_s) >= 4 else 0.0
    )
    return midi_float, hz, spread


def apply_tuning_center(events) -> float:
    """Re-express each note's cents offset relative to the take's own reference.

    `cents_offset` is measured against A=440 equal temperament. If the
    instrument is tuned to A=442, or the player simply sits a little sharp all
    the way through, then EVERY note reads sharp and we emit one intonation
    flag per measure for what is a single tuning problem.

    The median of the confident, stable notes IS this performance's reference
    pitch. Measuring each note against it is what "in tune with yourself"
    means, and it is what a teacher actually hears. The overall offset is not
    discarded — it is returned so it can be reported once, as a tuning matter,
    which is the correct granularity for it.

    Mutates each event: keeps the raw value as `cents_raw`, rewrites
    `cents_offset` to the relative one, stamps `tuning_center`.
    """
    import numpy as np
    ref = [e["cents_offset"] for e in events
           if e.get("confidence", 0) >= 50 and e.get("cents_spread", 0) <= 35]
    center = 0.0
    if len(ref) >= 8:
        # Clamped: past this the reading is likelier a bad take or an octave
        # confusion than a tuning choice, and the notes should still surface
        # individually rather than being normalised away.
        center = max(-35.0, min(35.0, float(np.median(ref))))
    for e in events:
        e["cents_raw"]     = e["cents_offset"]
        e["cents_offset"]  = round(e["cents_offset"] - center)
        e["tuning_center"] = round(center, 1)
    return center


# A squeak is SHORT. Everything else about it is corroborating evidence.
_SQUEAK_MAX_HELD = 0.30    # seconds
_SQUEAK_SPREAD   = 25      # cents of pitch instability within the note
_SQUEAK_CONF     = 70      # CREPE periodicity below this = not a clean pitch
_SQUEAK_FLATNESS = 2.0     # x the take's median flatness = noticeably noisier

# How many consecutive bad CREPE frames may occur inside a note before the walk
# calls it released. 2 frames = 80 ms at the 40 ms hop — long enough to ride out
# vibrato, a slur, or a scoop, short enough that a real staccato gap still ends
# the note.
_RELEASE_GAP_FRAMES = 2


def take_flatness_median(events: list[dict]) -> float | None:
    """
    Median spectral flatness across the take, used as each event's baseline.

    Absolute flatness is meaningless on its own — it varies by instrument, room
    and mic. What matters is whether ONE note is noisier than how this player
    sounds the rest of the time.
    """
    vals = [e["flatness"] for e in events
            if isinstance(e.get("flatness"), (int, float))]
    if len(vals) < 4:
        return None            # too little to establish a baseline
    return median(vals)


def looks_like_squeak(ev: dict, flatness_ref: float | None) -> bool | None:
    """
    Does this event carry the acoustic signature of a squeak/crack?

    Returns True/False, or **None when there is not enough data to judge** —
    the caller must decide what to do with "unknown" rather than receiving a
    False that looks like a real negative. Collapsing unknown into False is how
    a missing field silently disables a detector.

    A squeak is brief AND at least one of: pitch that will not hold still, low
    tracking confidence, or a spectrum noticeably noisier than this take's norm.
    A written leap into the high register fails every one of those.
    """
    # Brevity is judged on the UNINTERRUPTED span. `held_sec` is deliberately
    # tolerant of dropouts so the duration analysis measures how long a note
    # sounded — but a squeak IS dropouts, so held_sec makes one look sustained.
    held = ev.get("stable_sec")
    if held is None:
        held = ev.get("held_sec")
    if held is not None and float(held) > _SQUEAK_MAX_HELD:
        return False           # sustained — a high note, not a squeak

    spread   = ev.get("cents_spread")
    conf     = ev.get("confidence")
    flatness = ev.get("flatness")

    markers = []
    if isinstance(spread, (int, float)):
        markers.append(spread >= _SQUEAK_SPREAD)
    if isinstance(conf, (int, float)):
        markers.append(conf <= _SQUEAK_CONF)
    if isinstance(flatness, (int, float)) and flatness_ref:
        markers.append(flatness >= flatness_ref * _SQUEAK_FLATNESS)

    if not markers:
        return None            # nothing measurable — caller decides
    return any(markers)


def note_body_window(event_t: float, sound_end: float | None, next_t: float | None,
                     sr: int, n_samples: int,
                     attack_trim: float = 0.030, min_len: float = 0.050,
                     max_len: float = 0.500) -> tuple[int, int]:
    """
    Sample range covering the SUSTAINED BODY of a note, excluding its attack.

    Why this exists
    ---------------
    Loudness and timbre used to be measured over a fixed 100 ms window starting
    at the onset — i.e. over the attack transient, not the note. For a half note
    held two seconds we were describing the first twentieth of it.

    That put ARTICULATION inside the dynamics measurement. A hard-tongued note
    marked *p* can produce a bigger attack peak than a gently slurred note marked
    *f*, so `analyze_dynamics_vs_score`, which compares median dB between marked
    levels, could report "no contrast" — or an inversion — from two passages that
    were played at plainly different volumes. The attack says how the note was
    STARTED; the body says how loud it was PLAYED.

    Returns (start_sample, end_sample), always non-empty and in range.
    """
    start_t = event_t + attack_trim
    end_t = sound_end if (sound_end is not None and sound_end > start_t) \
        else event_t + min_len
    # Never run into the next attack — that would measure the following note.
    if next_t is not None and next_t > start_t:
        end_t = min(end_t, next_t)

    if end_t - start_t < min_len:
        # Too short to have a body separable from its attack (a grace note, a
        # squeak). Measure from the onset rather than returning nothing.
        start_t = event_t
        end_t = max(event_t + min_len, end_t)

    # A long note does not need all of itself measured, and the middle is the
    # most representative part — same reasoning as `measure_note_pitch`.
    if end_t - start_t > max_len:
        mid = (start_t + end_t) / 2.0
        start_t, end_t = mid - max_len / 2.0, mid + max_len / 2.0

    s = max(0, int(start_t * sr))
    e = min(n_samples, int(end_t * sr))

    # The last note of a take can start so close to the end of the buffer that
    # trimming its attack runs off the end. Slide the window BACKWARDS to keep a
    # usable length instead of returning a one-sample sliver — an RMS over one
    # sample is a garbage dB value, and it would feed straight into dynamics.
    need = max(1, int(min_len * sr))
    if e - s < need:
        e = min(n_samples, max(e, s + need))
        s = max(0, e - need)
    return s, e


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

            midi_float, dominant_hz, cents_spread = measure_note_pitch(
                window_hz[valid], window_conf[valid]
            )

            midi_raw     = int(round(midi_float))
            # Compute cents from the UN-clamped value so out-of-range notes
            # don't produce bogus offsets like -500¢.
            cents_offset = round((midi_float - midi_raw) * 100)  # -50..+50 ¢
            midi         = max(36, min(96, midi_raw))  # C2–C7 clamp (for display only)

            # ── Breath-noise gate ──────────────────────────────────────────
            # Deliberately still measured over the first 100 ms from the onset:
            # this threshold is tuned against that window, and it decides which
            # events EXIST. Changing what it looks at would silently change event
            # selection across every take — a different change from improving how
            # a kept note is measured.
            s_att = int(event_t * SR)
            e_att = min(len(y), s_att + SR // 10)
            rms_attack = float(np.sqrt(np.mean(y[s_att:e_att] ** 2))) if e_att > s_att else 0.0
            # Discard events below breath-noise floor (~-45 dBFS); real soft notes
            # hit ~0.02 RMS even on quiet passages; breathing is typically 0.001–0.008
            if rms_attack < 0.012:
                continue

            confidence = int(min(100, float(np.mean(window_conf)) * 100))

            # ── When the note is RELEASED ──────────────────────────────────
            # `end_sec` is the next onset, i.e. when the following note starts —
            # not when this one stops. Holding a note past its value, or clipping
            # it short while still entering the next note on time, are both
            # invisible in that number, so "how long did they hold it" could not
            # be answered from it at all.
            #
            # Walk CREPE forward from the onset while the frame stays voiced AND
            # stays on this note (within a semitone). The first frame that fails
            # is the release.
            #
            # This runs BEFORE loudness and timbre because both now need to know
            # where the note actually ends.
            _i0 = int(np.searchsorted(frame_times, event_t))
            # The walk tolerates a BRIEF interruption rather than stopping at the
            # first bad frame. CREPE's confidence dips mid-note for entirely
            # normal reasons — vibrato, a slur or tongued repeat, a scoop into
            # pitch, a bow change — and stopping there truncated `held_sec`,
            # which biases the duration ratio downward and manufactures "you
            # clipped this note short" on notes that were held correctly.
            #
            # Only a SUSTAINED interruption is a release. The tolerance is short
            # (2 frames = 80 ms at the 40 ms hop) so a real staccato gap still
            # ends the note, and `actual = min(held, gap)` upstream still caps
            # the result at the next onset.
            #
            # Two spans are recorded, because two different questions are being
            # asked of this note and they want opposite answers:
            #
            #   held_sec   — "how long did this note SOUND?"  Tolerant, for the
            #                duration/hold analysis.
            #   stable_sec — "how long did it hold this pitch UNINTERRUPTED?"
            #                Strict, for deciding whether the event was brief and
            #                unstable, i.e. a squeak.
            #
            # Using the tolerant span for both silently removed squeak detection:
            # a squeak is full of dropouts, so riding through them made a 0.12 s
            # stable burst measure 0.32 s, which fails every "is this brief"
            # threshold (crack dur <= 0.28, squeak held <= 0.30) and got the
            # event deleted by the clarinet suppressor as well.
            _rel = _i0
            _bad = 0
            _stable_end = _i0
            _stable_open = True
            for _k in range(_i0, n_frames):
                _ok = conf_np[_k] >= 0.35 and pitch_np[_k] > 0
                if _ok:
                    _mf = 12.0 * np.log2(pitch_np[_k] / 440.0) + 69.0
                    _ok = abs(_mf - midi_float) <= 1.0
                if _ok:
                    _bad = 0
                    _rel = _k
                    if _stable_open:
                        _stable_end = _k
                else:
                    _stable_open = False        # first interruption ends the
                                                # UNINTERRUPTED span
                    _bad += 1
                    if _bad > _RELEASE_GAP_FRAMES:
                        break
            _frame_dur = CREPE_HOP / CREPE_SR
            sound_end  = float(frame_times[_rel]) + _frame_dur
            held_sec   = max(0.0, sound_end - float(event_t))
            stable_sec = max(0.0, (float(frame_times[_stable_end]) + _frame_dur)
                             - float(event_t))

            # ── Loudness and timbre, over the note's BODY ──────────────────
            # See `note_body_window`: measuring the attack transient put
            # articulation inside the dynamics reading, so a hard-tongued piano
            # note could out-measure a slurred forte one.
            s, e = note_body_window(float(event_t), sound_end,
                                    float(next_t) if next_t is not None else None,
                                    SR, len(y))
            seg = y[s:e]
            rms = float(np.sqrt(np.mean(seg ** 2))) if e > s else rms_attack
            loudness = "loud" if rms > 0.15 else "medium" if rms > 0.04 else "soft"
            # Keep the NUMBER. Three buckets cannot measure contrast: a player
            # who plays everything at one volume and a player with a full
            # dynamic range can produce the same string. dBFS is the scale
            # dynamics actually live on — differences in dB are what "louder"
            # and "softer" mean.
            db = 20.0 * math.log10(max(rms, 1e-6))

            # Pitch alone cannot tell a squeak from a written leap: both are
            # "high". What separates them is TONE — a squeak is bright and
            # noisy, a real clarion note is neither. Nothing in this pipeline
            # measured timbre at all, which is why cracks could only ever be
            # inferred from pitch geometry.
            #
            # centroid = where the spectral energy sits (brightness)
            # flatness = how noise-like vs tonal the spectrum is (0 tonal, 1 noise)
            if len(seg) >= 512:
                # Match n_fft to the segment: the last note of a take can be
                # shorter than the default 2048 window, and librosa would pad it
                # and warn on every event.
                _nfft = 2048 if len(seg) >= 2048 else 512
                centroid_hz = float(np.mean(librosa.feature.spectral_centroid(
                    y=seg, sr=SR, n_fft=_nfft, hop_length=_nfft // 4)))
                flatness    = float(np.mean(librosa.feature.spectral_flatness(
                    y=seg, n_fft=_nfft, hop_length=_nfft // 4)))
            else:
                # Too short to transform. Emit None, NOT 0.0 — a real 0.0 would
                # read as "perfectly tonal" and actively suppress a crack.
                centroid_hz = flatness = None

            events.append({
                "time_sec":    float(event_t),
                "end_sec":     float(next_t),
                "sound_end":   round(sound_end, 3),
                "held_sec":    round(held_sec, 3),
                # Longest UNINTERRUPTED span on this pitch — see the release
                # walk. Squeak brevity is judged on this, not on held_sec.
                "stable_sec":  round(stable_sec, 3),
                "pitches":     [midi_to_scientific(midi)],
                "midi":        midi,       # C2–C7 clamped (display only)
                "midi_raw":    midi_raw,   # unclamped — used for wrong-note comparison
                "pitch_hz":    round(dominant_hz, 2),
                "cents_offset": cents_offset,
                "cents_spread": round(cents_spread),
                "confidence":  confidence,
                "loudness":    loudness,
                "db":          round(db, 2),
                # Timbre — None when the segment was too short to transform.
                "centroid_hz": round(centroid_hz, 1) if centroid_hz is not None else None,
                "flatness":    round(flatness, 5) if flatness is not None else None,
                # Brightness relative to the note's own fundamental. A squeak's
                # energy sits far above f0; a clean note's centroid is a small
                # multiple of it. Normalising here makes the number comparable
                # across registers, which raw centroid is not.
                "centroid_ratio": (round(centroid_hz / dominant_hz, 2)
                                   if centroid_hz is not None and dominant_hz > 0 else None),
                "source":      "crepe+librosa+dense",
            })

        events.sort(key=lambda e: e["time_sec"])

        # Re-express intonation relative to the take's own reference pitch, so a
        # sharp-tuned instrument is one tuning note instead of a flag per bar.
        tuning_center = apply_tuning_center(events)
        if abs(tuning_center) >= 5:
            print(f"[run_pitch_tracking] performance tuning centre "
                  f"{tuning_center:+.1f}¢ vs A=440 — intonation measured relative to it")

        # Clarinet harmonic suppression: clarinet overblows at the 12th (3× frequency),
        # so CREPE can track the 3rd harmonic instead of the fundamental. If the instrument
        # is clarinet and an event is almost exactly a 12th (19 semitones ±2) above
        # a nearby event within 400ms, discard the higher one — it's almost certainly
        # a harmonic of the lower note, not an actual clarion-register pitch.
        #
        # EXCEPT: a clarinet register-break SQUEAK has exactly the same pitch
        # signature — that is what breaking to the clarion register IS. Suppressing
        # on pitch alone therefore deleted the single most common clarinet mistake
        # before any detector could see it, and cracks were unreportable on the one
        # instrument where they matter most. Timbre is what separates the two: a
        # mis-tracked harmonic belongs to a sustained, stable, tonal note; a squeak
        # is brief, unstable and noisy.
        if "clarinet" in instrument.lower() and len(events) > 1:
            TWELFTH = 19  # semitones
            harmonic_tolerance = 2  # semitones
            flatness_ref = take_flatness_median(events)
            discard = set()
            kept_squeaks = 0
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
                            # Only a tracking artifact if it does NOT sound like a
                            # squeak. `None` means we could not measure timbre at
                            # all — fall back to the old suppress-by-pitch rule
                            # rather than letting missing data flood the take with
                            # phantom clarion notes.
                            squeak = looks_like_squeak(ev, flatness_ref)
                            if squeak is True:
                                ev["squeak_suspect"] = True
                                kept_squeaks += 1
                            else:
                                discard.add(i)
                            break
            if discard or kept_squeaks:
                print(f"[pitch_tracking] clarinet: suppressed {len(discard)} likely "
                      f"12th-harmonic events, kept {kept_squeaks} as squeak candidate(s)")
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


def parse_musicxml(score_bytes: bytes, start_measure: int, instrument: str = "") -> dict:
    """
    Parse MusicXML with music21 into structured score data.
    Returns ScoreResult dict.
    """
    import tempfile, os, re
    import music21 as m21

    with tempfile.NamedTemporaryFile(suffix=".musicxml", delete=False) as f:
        f.write(score_bytes)
        xml_path = f.name

    try:
        score = m21.converter.parse(xml_path)

        parts = score.parts
        if not parts:
            return {"error": "no parts found in score"}

        # Pick the part the STUDENT played, not merely the first one with notes.
        #
        # A full score, or a piano+solo PDF, has several parts; taking the first
        # meant the entire comparison could run against a different line, and
        # every note would then look wrong for a reason nothing in the output
        # could explain. The student's declared instrument is the only signal
        # available here, so match on it and fall back to the old behaviour.
        _playable = [p for p in parts if len(p.flatten().notes) > 0] or list(parts)
        source_part = _playable[0]
        _want = (instrument or "").strip().lower()
        if _want and len(_playable) > 1:
            # Strip qualifiers so "clarinet (b♭)" matches a part named "Clarinet
            # in B-flat", and compare on the significant word.
            _key = re.sub(r"[^a-z ]", " ", _want).split()
            _key = [k for k in _key if len(k) > 2] or [_want]
            _named = []
            for p in _playable:
                _labels = [str(getattr(p, "partName", "") or ""),
                           str(getattr(p, "partAbbreviation", "") or "")]
                try:
                    for _ins in p.getInstruments(recurse=True):
                        _labels.append(str(getattr(_ins, "instrumentName", "") or ""))
                except Exception:
                    pass
                _blob = " ".join(_labels).lower()
                _score = sum(1 for k in _key if k in _blob)
                if _score:
                    _named.append((_score, len(p.flatten().notes), p))
            if _named:
                _named.sort(key=lambda t: (-t[0], -t[1]))
                source_part = _named[0][2]
                print(f"[parse_musicxml] matched part "
                      f"{str(getattr(source_part, 'partName', '') or '?')!r} "
                      f"to instrument {instrument!r} ({len(_playable)} parts in score)")
            elif len(_playable) > 1:
                print(f"[parse_musicxml] WARNING: {len(_playable)} parts and none "
                      f"matched instrument {instrument!r} — using the first, which "
                      f"may be a different line than the student played")
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

        # Repeat barlines and DC/DS jumps mean the audio contains passages the
        # note list does not — see the note on `has_repeats` in the return value.
        has_repeats = False
        try:
            for _el in source_part.recurse():
                if isinstance(_el, m21.bar.Repeat) or isinstance(
                        _el, getattr(m21.repeat, "RepeatExpression", ())):
                    has_repeats = True
                    break
        except Exception:
            has_repeats = False
        if has_repeats:
            print("[parse_musicxml] WARNING: score contains repeats and they are "
                  "NOT expanded — if the student played them, every measure after "
                  "the first repeat may be misaligned")

        measures_out = []
        measure_elements = source_part.getElementsByClass(m21.stream.Measure)

        # A dynamic marking applies from where it appears until the next one, so
        # it has to persist across measures rather than being read per note.
        cur_dynamic = None

        for i, m in enumerate(measure_elements):
            measure_num = m.number if m.number is not None else (start_measure + i)
            notes_out = []

            # Markings sit beside the notes in the measure stream, so collect
            # them in offset order and apply whichever is in force.
            _dyn_at: list[tuple[float, str]] = []
            try:
                for dyn in m.flatten().getElementsByClass(m21.dynamics.Dynamic):
                    v = (getattr(dyn, "value", "") or "").strip().lower()
                    if v:
                        _dyn_at.append((float(dyn.offset), v))
                _dyn_at.sort()
            except Exception:
                _dyn_at = []

            for el in m.flatten().notesAndRests:
                # Advance the prevailing marking to this note's position.
                for _off, _v in _dyn_at:
                    if _off <= float(el.offset) + 1e-6:
                        cur_dynamic = _v
                if isinstance(el, m21.note.Rest):
                    # Rests are intentionally ignored in this version. False
                    # rest detection creates bad coaching, and sounded-note
                    # feedback is the trustworthy core of the product.
                    continue
                elif isinstance(el, m21.note.Note):
                    # ALL articulations, not just the first.
                    #
                    # Only `el.articulations[0]` used to be read, and only three
                    # classes were recognised — so a note marked accent+staccato
                    # reported "accent" and lost the staccato. The duration check
                    # then judged a deliberately short note against its full
                    # written value and called it clipped.
                    #
                    # It also tested for "marcato", "wedge" and "portato", which
                    # this parser could never produce: dead strings that read as
                    # coverage. music21's class name is used directly so the
                    # vocabulary cannot drift out of sync again.
                    artic = "/".join(sorted({
                        type(a).__name__.lower() for a in (el.articulations or [])
                    })) or None

                    notes_out.append({
                        "pitch": el.pitch.nameWithOctave,
                        "beat": float(el.beat),
                        "duration_beats": float(el.duration.quarterLength),
                        "articulation": artic,
                        # The prevailing marking, carried forward until the next
                        # one — a `p` applies to everything after it, not just
                        # the note it sits under. Was hard-coded None, so nothing
                        # downstream could check dynamics at all.
                        "dynamic": cur_dynamic,
                    })
                elif isinstance(el, m21.chord.Chord):
                    for n in el.notes:
                        notes_out.append({
                            "pitch": n.pitch.nameWithOctave,
                            "beat": float(el.beat),
                            "duration_beats": float(el.duration.quarterLength),
                            "articulation": None,
                            "dynamic": cur_dynamic,
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
            # Repeats are NOT expanded. A repeated strain appears once here but
            # twice in the audio, so DTW must fold roughly 2x the events onto the
            # written notes and everything after the repeat is systematically
            # offset — which surfaces as wrong notes and bad timing with nothing
            # in the output to explain it.
            #
            # Expanding is the real fix and is viable (music21's expandRepeats()
            # preserves the printed measure numbers — verified: 1,2,3,4 with a
            # repeat over 1-2 becomes 1,2,1,2,3,4), but a measure number then
            # appears twice at different times, which the measure timeline and
            # Loop windows assume cannot happen. Detect and report it rather than
            # silently producing confident nonsense.
            "has_repeats": has_repeats,
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


def parse_score_document(score_bytes: bytes, start_measure: int, instrument: str = "") -> dict:
    if score_bytes[:4] == b"PK\x03\x04":
        extracted = extract_musicxml_from_mxl(score_bytes)
        if not extracted:
            return {"error": "MXL archive had no MusicXML payload", "measures": [], "source": "music21"}
        score_bytes = extracted
    return parse_musicxml(score_bytes, start_measure, instrument)


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

def median(values):
    """
    True median. `sorted(v)[len(v)//2]` takes the UPPER element on an even-length
    list, which biases every even sample upward — and several thresholds here run
    on samples as small as 2 or 4, where that bias is the difference between
    flagging and not flagging. Returns None for an empty input.
    """
    sv = sorted(values)
    n = len(sv)
    if n == 0:
        return None
    return sv[n // 2] if n % 2 else 0.5 * (sv[n // 2 - 1] + sv[n // 2])


_ACCIDENTAL_VALUE = {"#": 1, "♯": 1, "b": -1, "♭": -1, "-": -1}


def midi_from_name(pitch_name: str) -> int | None:
    """
    Convert scientific pitch notation ("F#4", "Bb3", "B-4", "F##4") to MIDI.

    **music21 writes a flat as "-", not "b".** `Pitch('B-4').nameWithOctave` is
    the string "B-4", and `parse_musicxml` feeds exactly that string in here.

    The old pattern was `([#b♯♭]?)(-?\\d+)` — "-" is not in that accidental set,
    so the accidental matched EMPTY and `(-?\\d+)` swallowed "-4" as the octave.
    `midi_from_name("B-4")` returned **-25** for a note whose real MIDI is 70: a
    95-semitone error on every flat note in every MusicXML score, which in flat-key
    repertoire (most clarinet writing) is most of the piece.

    It was invisible because `midi_to_scientific(-25)` renders as "A-4", which
    reads to a musician as A-flat. Downstream it corrupted the DTW cost matrix
    (a real note scores ~86 against a -25 entry, so alignment warps *around*
    every flat note), which in turn produced wrong measure labels, phantom rests
    from the resulting beat-axis holes, and meaningless timing residuals.

    Accidentals are now parsed as a run, so double accidentals ("F##4", "C--4")
    work too. They previously returned None and were silently dropped from the
    expectation set, which let a correctly-played double-accidental note be
    reported as wrong.

    One ambiguity is inherent to music21's format: "C-1" is both "C-flat, octave
    1" and "C, octave -1". Both land in MIDI 0-11, far below any instrument this
    product supports, so the flat reading is taken and the collision is moot.
    """
    import re
    m = re.match(r'^([A-Ga-g])([#♯b♭\-]*)(\d+)$', pitch_name.strip())
    if not m:
        return None
    step, accidentals, octave = m.group(1).upper(), m.group(2), int(m.group(3))
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[step]
    acc  = sum(_ACCIDENTAL_VALUE.get(ch, 0) for ch in accidentals)
    return (octave + 1) * 12 + base + acc


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
                # Needed downstream so a staccato note is not judged "clipped".
                "artic":     (note.get("articulation") or ""),
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
            "score_artic":      sn.get("artic") or "",
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
_TIMING_DUR_MIN_MS       = 140.0  # ignore duration errors smaller than this
# How rough the note-to-note timing may be before the fitted line stops being a
# description of this performance at all. Tempo-scaled: 18% of a beat of jitter
# between CONSECUTIVE notes is a lot at any speed, while a fixed millisecond
# figure would be far too strict at slow tempi and far too loose at fast ones.
_TIMING_FIT_MAX_MAD_MS   = 90.0
_TIMING_FIT_MAX_MAD_FRAC = 0.18
# Floor for corroborating a Gemini rhythm claim from CREPE residuals. Must sit
# ABOVE this pipeline's own onset noise — a 23 ms librosa onset grid, 50 ms
# candidate dedupe, and synthetic probes injected every 350 ms inside sustained
# notes — or the gate confirms anything. The previous value, 55 ms, sat inside
# that noise. Tempo-scaled so it means the same thing at any speed.
_TIMING_RHYTHM_CONF_MS   = 70.0
_TIMING_RHYTHM_CONF_FRAC = 0.12


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

    # ── Discard the run-up ──────────────────────────────────────────────────
    # Settling the instrument, a breath, a key click — these produce onsets
    # before any music. If one of them survives into the tempo fit it drags the
    # intercept earlier, and the real first note then measures as "late", which
    # is exactly the pause-before-playing being reported as a late downbeat.
    #
    # Music starts at the first onset with at least two more inside the next two
    # seconds: a phrase arrives in a cluster, a stray noise does not.
    _times = sorted(ev["time_sec"] for ev in onset_by_idx.values())
    _music_t0 = _times[0] if _times else 0.0
    for _i, _t in enumerate(_times):
        if sum(1 for _u in _times[_i:] if _u - _t <= 2.0) >= 3:
            _music_t0 = _t
            break
    _dropped = [si for si, ev in onset_by_idx.items() if ev["time_sec"] < _music_t0 - 0.05]
    for si in _dropped:
        del onset_by_idx[si]
    if _dropped:
        print(f"[timing] dropped {len(_dropped)} run-up onset(s) before "
              f"first note at {_music_t0:.2f}s")

    if len(onset_by_idx) < _TIMING_MIN_NOTES:
        return {"ok": False, "reason": f"only {len(onset_by_idx)} matched onsets"}

    score_notes = {
        si: {"measure": ev["measure"], "beat": ev.get("score_beat") or 1.0,
             "dur_beats": ev.get("score_dur_beats") or 0.0,
             "pitch": ev.get("score_pitch") or "", "abs_beat": ev["score_abs_beat"],
             "artic": (ev.get("score_artic") or "")}
        for si, ev in onset_by_idx.items()
    }

    # How long each matched note actually SOUNDED. DTW is many-to-one, so a
    # sustained note yields several events; the note stops when the last of them
    # stops. `held_sec` comes from CREPE's own frames (see run_pitch_tracking),
    # not from the next onset.
    held_by_idx: dict[int, float] = {}
    for ev in aligned:
        si = ev.get("score_idx")
        if si is None or si not in onset_by_idx:
            continue
        se = ev.get("sound_end")
        if se is None:
            continue
        t0 = onset_by_idx[si]["time_sec"]
        held_by_idx[si] = max(held_by_idx.get(si, 0.0), float(se) - t0)

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

    # ── Does the fitted line actually describe this performance? ────────────
    # The only validation used to be the slope sanity band above — "is the tempo
    # between 20 and 500 BPM". Nothing looked at how well the notes sit on the
    # line, even though `_robust_linear_fit` returns the residuals. A fit with
    # 400 ms of scatter emitted `confirmed=True` placement and drift flags
    # exactly as readily as a fit with 15 ms of scatter, and every one of those
    # flags is shown to the student as fact.
    #
    # The statistic is ROUGHNESS — the median jump between CONSECUTIVE
    # residuals — not the spread of the residuals themselves.
    #
    # That distinction is the whole fix. A player who holds one note too long
    # displaces every note after it, so half the piece sits off the line and the
    # spread of residuals is large. The grid is still perfectly good, and that
    # displacement is precisely the finding we want to report. Gating on spread
    # threw away exactly the takes that had something to say (caught by the
    # "note held past its value" test, which this gate broke on its first draft).
    #
    # A coherent displacement is a step: one big jump, small differences
    # everywhere else, so the MEDIAN jump stays small. A grid that genuinely
    # does not describe the performance has notes landing all over the place,
    # and the median jump is large. Roughness separates the two; spread cannot.
    _diffs = sorted(abs(residuals[i] - residuals[i - 1])
                    for i in range(1, len(residuals)))
    _rough = (median(_diffs) or 0.0) * 1000.0
    _fit_limit = max(_TIMING_FIT_MAX_MAD_MS, _TIMING_FIT_MAX_MAD_FRAC * spb * 1000.0)
    if _diffs and _rough > _fit_limit:
        print(f"[timing] tempo fit does not describe this performance: "
              f"note-to-note roughness {_rough:.0f} ms > {_fit_limit:.0f} ms "
              f"at {60.0 / spb:.0f} BPM — no timing flags from this take")
        return {"ok": False,
                "reason": f"tempo fit too rough ({_rough:.0f} ms note-to-note)"}

    # ── The first note played IS the downbeat ───────────────────────────────
    # In unaccompanied playing there is no external clock: the beat grid starts
    # when the player starts. Keep the fitted SLOPE (the tempo the playing
    # establishes) but slide the line so it passes exactly through the first
    # matched onset, so that note's residual is zero by construction and the
    # silence before it cannot be scored at all.
    #
    # Cross-referenced against the note comparison rather than assumed: `pairs`
    # is ordered by the score's own beat axis and each entry carries the score
    # note DTW matched, so pairs[0] is the earliest note of the piece the player
    # actually played — including the case where they began on a pickup or after
    # a rest, since abs_beat already encodes where in the bar it sits.
    first_beat, first_t, first_si = pairs[0]
    anchor_intercept = first_t - spb * first_beat
    residuals = [t - (anchor_intercept + spb * b) for (b, t, _si) in pairs]
    first_measure = score_notes[first_si]["measure"]
    print(f"[timing] grid anchored on the first note played: "
          f"{score_notes[first_si]['pitch'] or '?'} in m.{first_measure} "
          f"at {first_t:.2f}s (beat {score_notes[first_si]['beat']})")

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
    # …but the opening is only an honest reference if the opening was STEADY.
    # A rubato or fermata'd first phrase makes `ref_spb` meaningless, and since
    # every later measure is then compared against it at a 7% threshold, one
    # expressive opening turns the whole piece into "rushing" or "dragging".
    # Check the opening's own coherence and fall back to the piece fit when it
    # is not a tempo at all — same roughness statistic as the main fit gate.
    ref_spb = spb
    ref_fit = _robust_linear_fit([p[0] for p in ref_pts], [p[1] for p in ref_pts]) if len(ref_pts) >= 3 else None
    if ref_fit and _TIMING_MIN_SPB <= ref_fit[1] <= _TIMING_MAX_SPB:
        _ref_resid = ref_fit[2]
        _ref_rough = (median([abs(_ref_resid[i] - _ref_resid[i - 1])
                              for i in range(1, len(_ref_resid))]) or 0.0) * 1000.0
        _ref_limit = max(_TIMING_FIT_MAX_MAD_MS,
                         _TIMING_FIT_MAX_MAD_FRAC * ref_fit[1] * 1000.0)
        if _ref_rough <= _ref_limit:
            ref_spb = ref_fit[1]
        else:
            print(f"[timing] opening is not steady enough to be the tempo "
                  f"reference (roughness {_ref_rough:.0f} ms) — using the "
                  f"piece-wide fit instead")

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

    # De-trend before judging placement. The grid is pinned to the first note,
    # so a player who gradually falls behind accumulates positive residuals
    # everywhere — which is DRIFT, and the drift finding already says it. Judging
    # each measure against the median residual keeps placement meaning "this bar
    # sits off relative to the rest", not "the piece slowed down".
    _all_resid = sorted(ms for vals in by_measure.values() for ms in vals)
    _resid_centre = _all_resid[len(_all_resid) // 2] if _all_resid else 0.0

    placement: dict[int, dict] = {}
    for m, vals in by_measure.items():
        if m in drift:
            continue
        # You cannot be late to your own opening: the first note played defines
        # the beat, so the measure it lands in is the reference, not a candidate
        # for a late-entry flag. This is the pause-before-playing case.
        if m == first_measure:
            continue
        local_spb = local_spb_by_measure.get(m)
        if local_spb is not None and abs(local_spb - spb) / spb >= 0.05:
            continue  # measure runs at its own tempo — not a placement error
        # A fixed 110ms means very different things at different tempos: at 60bpm
        # it is a ninth of a beat and inaudible; at 200bpm it is more than a third
        # of a beat and glaring. Judge against the beat, with the fixed floor kept
        # as a lower bound so slow music does not become hair-trigger.
        _thresh_ms = max(_TIMING_PLACEMENT_MS, 0.16 * spb * 1000.0)

        # One stray note does not make a late measure — an entry is late when the
        # notes in that bar AGREE that it is. Requiring two and a tight spread
        # stops a single mis-matched onset from producing a downbeat flag.
        if len(vals) < 2:
            continue
        _dev = sorted(vals)
        _spread = _dev[-1] - _dev[0]
        if _spread > max(240.0, 0.5 * spb * 1000.0):
            continue

        sv = sorted(v - _resid_centre for v in vals)
        # A true median. `sv[len(sv)//2]` takes the UPPER element on an
        # even-length list, and the rule above admits as few as two notes — so
        # for a 2-note bar it returned max(v1, v2), i.e. precisely the single
        # worst onset the "two notes must agree" guard exists to exclude.
        #
        # The bias is asymmetric and therefore visible to the user: for late
        # (positive) residuals it picks the larger and OVER-reports "late"; for
        # early (negative) ones it picks the smaller magnitude and UNDER-reports
        # "early". [40, 120] flagged as late (true median 80, under threshold)
        # while [-100, -120] did not flag as early (true median -110, over it).
        _n  = len(sv)
        med = sv[_n // 2] if _n % 2 else 0.5 * (sv[_n // 2 - 1] + sv[_n // 2])
        if abs(med) >= _thresh_ms:
            worst = max((v - _resid_centre for v in vals), key=abs)
            placement[m] = {
                "median_ms": round(med, 1),
                "worst_ms":  round(worst, 1),
                "direction": "late" if med > 0 else "early",
                "n":         len(vals),
            }

    # ── Duration: does each note get the time its written value asks for? ──
    # Compared against the SCORE'S OWN BEAT GAP, not the note's written length.
    # Two things that made correct playing look wrong:
    #
    # 1. Rests. parse_musicxml drops rests, so a quarter followed by a quarter
    #    rest leaves a 2-beat gap against a 1-beat written value — read as "held
    #    twice as long" on a perfectly played bar. The beat axis already places
    #    notes after the rest, so the gap is what the music actually asks for.
    # 2. Units. `beat` and `abs_beat` are in NOTATED BEATS; `dur_beats` is a
    #    quarterLength. They agree only when the beat is a quarter. In 6/8 the
    #    dotted-quarter beat is 1.5 quarterLengths, so every note measured ~33%
    #    short; in 2/2 every note measured twice too long.
    ql_per_beat = quarter_lengths_per_beat(score.get("time_signature")) or 1.0

    durations: dict[int, dict] = {}
    have = sorted(onset_by_idx.keys())
    for si in have:
        nxt = si + 1
        if nxt not in onset_by_idx:
            continue
        sn = score_notes[si]
        gap_beats = score_notes[nxt]["abs_beat"] - sn["abs_beat"]
        if gap_beats <= 0:
            continue                      # chord tone or out-of-order match
        written_ql    = sn.get("dur_beats") or 0.0
        written_beats = written_ql / ql_per_beat
        if written_beats <= 0:
            continue
        # Written longer than the space before the next note means a tie, a
        # second voice, or a parse slip. Not something to judge the player on.
        if written_beats > gap_beats + 0.05:
            continue

        # Measure the HOLD, not the gap to the next note. Those differ exactly
        # where it matters: a note held past its value while the next still
        # arrives on time, or a note clipped short with the next on time, are
        # both invisible in the gap. Fall back to the gap only when CREPE gave
        # us no release for this note.
        expected = written_beats * spb
        held = held_by_idx.get(si)
        if held is not None and held > 0.02:
            actual = held
            measured = "held"
            # A note cannot sound past the next attack on a monophonic
            # instrument; if CREPE ran on, trust the next onset.
            _gap = onset_by_idx[nxt]["time_sec"] - onset_by_idx[si]["time_sec"]
            if _gap > 0:
                actual = min(actual, _gap)
        else:
            actual = onset_by_idx[nxt]["time_sec"] - onset_by_idx[si]["time_sec"]
            expected = gap_beats * spb
            measured = "gap"
        if expected <= 0 or actual <= 0:
            continue

        # Staccato and rests are written short on purpose. A staccato quarter
        # sounds a fraction of its value and that is correct playing, so a
        # "too short" reading there would be a fabricated error.
        # Substrings, matched against music21's own class names (see
        # parse_musicxml): "stacc" covers Staccato and Staccatissimo, "spicc"
        # Spiccato, "marc" Marcato, "stopped"/"wedge" the wedge family. The list
        # previously contained "wedge" and "portato" while the parser emitted
        # only "staccato"/"tenuto"/"accent" — three dead strings that looked
        # like coverage and matched nothing.
        _artic = (sn.get("artic") or "").lower()
        _short_by_design = any(k in _artic for k in
                               ("stacc", "spicc", "marc", "wedge", "portato",
                                "detach", "martele", "martelé"))

        ratio = actual / expected
        delta_ms = (actual - expected) * 1000.0
        if abs(delta_ms) < _TIMING_DUR_MIN_MS:
            continue
        if ratio < 1.0 and (_short_by_design or measured == "gap"):
            # `gap` cannot distinguish a clipped note from a rest that follows,
            # so it is only trusted for the "too long" direction.
            continue
        if ratio <= _TIMING_DUR_SHORT or ratio >= _TIMING_DUR_LONG:
            m = sn["measure"]
            prev = durations.get(m)
            if prev is None or abs(delta_ms) > abs(prev["delta_ms"]):
                # Distance to the next note we could READ, minus this note's
                # written value. This is NOT known to be a rest.
                #
                # parse_musicxml discards rests deliberately (see its comment:
                # "False rest detection creates bad coaching"), so nothing here
                # has rest data at all. The same hole opens whenever a note is
                # missing from the score representation for an unrelated reason:
                # the vision reader returning "p": null for an unreadable
                # notehead (its prompt permits exactly that), a pitch that fails
                # to parse, a measure the reader skipped (its prompt says
                # numbering gaps "are correct and expected"), or a
                # beats_per_measure that disagrees with the real metre.
                #
                # It was previously rendered to the student as "plus the N-beat
                # rest after it", which asserted a rest in passages containing
                # none. Kept as a diagnostic; never stated as fact.
                gap_beats_unexplained = round(gap_beats - written_beats, 3)
                durations[m] = {
                    "beat":      sn["beat"],
                    "pitch":     sn["pitch"],
                    "ratio":     round(ratio, 2),
                    "delta_ms":  round(delta_ms, 1),
                    "direction": "short" if ratio <= _TIMING_DUR_SHORT else "long",
                    "time_sec":  onset_by_idx[si]["time_sec"],
                    # What the note IS, so the coaching can name it rather than
                    # only quoting milliseconds.
                    "value":        note_value_name(written_ql),
                    "beats_written": round(written_beats, 3),
                    "beats_played":  round(actual / spb, 3) if spb > 0 else None,
                    "measured":     measured,
                    # Diagnostic only — see the comment above. Deliberately
                    # NOT named "rest": we cannot tell a rest from a note
                    # the score reader dropped.
                    "gap_after_beats": (gap_beats_unexplained
                                        if gap_beats_unexplained > 0.05 else 0.0),
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
                score_result = parse_score_document(score_bytes, start_measure, instrument)
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

NAMING A HAND — read this before writing "left" or "right":
- Say left/right from the PLAYER'S OWN perspective, never the viewer's. A camera facing the player mirrors them: the hand appearing on the RIGHT of your view is usually the player's LEFT hand. Front-facing phone cameras often mirror the image as well, so screen position alone cannot settle it.
- Do not infer the hand from screen position. Use where the hand sits ON THE INSTRUMENT, which does not change with camera angle: for clarinet, oboe, saxophone, recorder and flute the UPPER hand (closer to the mouthpiece/headjoint) is the LEFT hand and the LOWER hand is the RIGHT. For guitar the fretting hand is usually the left. For piano, lower pitches are the left hand.
- If only ONE hand is visible, work out which one it is from that rule and say so explicitly (e.g. "left hand (upper, nearest the mouthpiece)"). Never describe a hand that is not in the frame.
- If you cannot tell which hand it is, say "the visible hand" rather than guessing a side. Naming the wrong hand makes the whole observation useless to the student.

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
            # Reading a score is a deterministic extraction task, not a creative
            # one. This ran at the API default (1.0), so the SAME photo produced
            # materially different parses run to run — 54 vs 64 vs 68 measures,
            # and a time signature of 2/4 on one run and 3/4 on the next for a
            # page that plainly reads 3/4. Every one of those wrong values then
            # propagates into measure numbering and alignment.
            temperature=0,
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
            print(f"[read_score_notes_claude] time_signature="
                  f"{parsed.get('time_signature')!r} (hint was {time_sig!r})")
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


def quarter_lengths_per_beat(time_sig: str | None) -> float:
    """
    How many quarterLengths one NOTATED BEAT is worth.

    music21 reports note durations as quarterLengths but reports `beat` in the
    time signature's own beat unit, and the timing analysis works on the beat
    axis. The two only agree when the beat IS a quarter. Getting this wrong made
    every note in 6/8 look ~33% too short (a dotted-quarter beat is 1.5
    quarterLengths) and every note in 2/2 look twice too long.

      4/4, 3/4, 2/4 -> 1.0     6/8, 9/8, 12/8 -> 1.5 (dotted-quarter beat)
      2/2           -> 2.0     3/8            -> 0.5 (three eighth beats)
    """
    import re
    m = re.match(r'^(\d+)\s*/\s*(\d+)$', (time_sig or "").strip())
    if not m:
        return 1.0
    num, denom = int(m.group(1)), int(m.group(2))
    if denom <= 0:
        return 1.0
    unit = 4.0 / denom                      # quarterLengths in one denominator unit
    is_compound = num % 3 == 0 and num // 3 >= 2 and denom >= 8
    return unit * 3.0 if is_compound else unit


# Written note values in quarterLengths, so feedback can name what the note is
# rather than only quoting milliseconds.
_NOTE_VALUES = [
    (6.0, "dotted whole note"), (4.0, "whole note"), (3.0, "dotted half note"),
    (2.0, "half note"), (1.5, "dotted quarter note"), (1.0, "quarter note"),
    (0.75, "dotted eighth note"), (0.5, "eighth note"),
    (0.375, "dotted sixteenth note"), (0.25, "sixteenth note"),
    (0.125, "thirty-second note"),
]


def note_value_name(quarter_length: float) -> str:
    """Name a written duration, e.g. 3.0 -> 'dotted half note'. '' if unrecognised."""
    for ql, name in _NOTE_VALUES:
        if abs(quarter_length - ql) < 0.02:
            return name
    return ""


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


def _safe_measure_int(val) -> int | None:
    try: return int(val)
    except (TypeError, ValueError): return None


# Sounding pitch relative to WRITTEN pitch, in semitones. Keep in sync with
# src/lib/instruments.js — the form sends these exact names.
INSTRUMENT_TRANSPOSE = {
    "piccolo": 12, "flute": 0, "oboe": 0, "english horn": -7, "cor anglais": -7,
    "bassoon": 0, "contrabassoon": -12,
    "clarinet (b\u266d)": -2, "clarinet (bb)": -2, "bb clarinet": -2, "clarinet": -2,
    "clarinet (a)": -3, "a clarinet": -3,
    "clarinet (e\u266d)": 3, "clarinet (eb)": 3, "eb clarinet": 3,
    "bass clarinet": -14,
    "soprano saxophone": -2, "alto saxophone": -9, "tenor saxophone": -14,
    "baritone saxophone": -21, "alto sax": -9, "tenor sax": -14,
    # NOTE: a bare "saxophone" is deliberately ABSENT. The profile
    # instrument list offers plain "Saxophone", which used to resolve to
    # -9 — alto. A tenor player choosing it got a 5-semitone error on
    # every note, i.e. a whole score of wrong-note flags on correct
    # playing. With no entry, `declared` is None and the offset measured
    # from the audio is used instead, which is right far more often than
    # a guess between four instruments a fifth apart.
    "recorder": 0,
    "trumpet (b\u266d)": -2, "trumpet (bb)": -2, "trumpet": -2, "trumpet (c)": 0,
    "cornet (b\u266d)": -2, "cornet": -2, "flugelhorn": -2,
    "french horn (f)": -7, "french horn": -7, "horn": -7,
    "trombone": 0, "bass trombone": 0, "euphonium": 0, "tuba": 0,
    "violin": 0, "viola": 0, "cello": 0, "double bass": -12, "harp": 0,
    "classical guitar": -12, "electric guitar": -12, "guitar": -12,
    "bass guitar": -12, "ukulele": 0, "mandolin": 0, "banjo": 0,
    "piano": 0, "organ": 0, "harpsichord": 0, "voice": 0,
    "marimba": 0, "vibraphone": 0, "xylophone": 12, "glockenspiel": 24,
    "timpani": 0, "snare drum": 0, "drum set": 0,
}


# Set by find_wrong_note_candidates, read by run_full_analysis so the
# transposition decision reaches pipeline_debug. This was invisible, which is
# exactly why a "wrong note" that was really a B-flat transposition took a
# round of guesswork to pin down instead of being readable off the take.
_LAST_TRANSPOSE_DEBUG: str = ""

# Tier B findings deleted by the confirmed-only filter, kept for diagnostics so
# the gate's false-positive rate is measurable. Never shown to the student.
_LAST_DROPPED_UNCONFIRMED: list = []


def _note_transposition_debug(msg: str) -> None:
    global _LAST_TRANSPOSE_DEBUG
    _LAST_TRANSPOSE_DEBUG = msg


def transpose_for_instrument(instrument: str) -> int | None:
    """Declared-instrument transposition, or None when we do not recognise it."""
    key = (instrument or "").strip().lower()
    if not key:
        return None
    if key in INSTRUMENT_TRANSPOSE:
        return INSTRUMENT_TRANSPOSE[key]
    # Longest-substring match so "Bb Clarinet 1" or "Alto Saxophone (Eb)" resolve.
    hits = [(len(k), v) for k, v in INSTRUMENT_TRANSPOSE.items() if k in key]
    return max(hits)[1] if hits else None


def find_wrong_note_candidates(
    aligned: list[dict],
    score: dict,
    instrument: str = "",
) -> list[str]:
    """
    Direct CREPE-vs-score comparison to surface wrong note candidates.

    These become CONFIRMED "error" flags shown to the student as fact, so the
    bar for calling a note wrong is deliberately high — a false "you played the
    wrong note" against correct playing costs far more trust than a missed one.
    A candidate must survive all of:

      * confidently tracked (conf ≥ 65) and pitch-stable (spread ≤ 40¢)
      * long enough to be a note rather than a click or scrape
      * ≥2 semitones from every pitch in its measure AND its neighbours, so
        alignment slop is not blamed on the student
      * not an octave displacement (pitch-class distance ≥ 2)
      * measured or declared instrument transposition already applied

    and then the whole set must survive a global sanity gate: if a quarter of
    the notes look wrong, the score read or alignment is broken rather than the
    playing, and nothing is reported at all.
    """
    _note_transposition_debug("not evaluated")
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

    # ── Transposition guard ────────────────────────────────────────────────
    # CREPE hears SOUNDING pitch; the score shows WRITTEN pitch. For a
    # transposing instrument those differ by a fixed interval — a B-flat
    # clarinet (this repertoire) sounds a major 2nd BELOW what is written, an
    # E-flat alto sax a major 6th below. Comparing the two directly makes every
    # correctly-played note look ~2 semitones wrong, which is exactly the
    # "wrong note flags are mostly wrong, the notes I played are right" report.
    #
    # Rather than hard-code a table of instruments (and get it wrong for octave
    # choices, capos, or a student reading a concert-pitch part), measure the
    # offset: take the median semitone difference between each played note and
    # the note DTW matched it to. A real transposition shows up as a tight
    # cluster; genuinely wrong notes are scattered and leave the median at 0.
    # Measure the offset against the note DTW actually MATCHED, not the nearest
    # note in the bar. "Nearest in the bar" hides the very thing we are looking
    # for: on a stepwise passage a 2-semitone shift usually lands exactly on a
    # neighbouring scale degree that is also in that measure, so the difference
    # reads as 0 and the transposition stays invisible. (Measured on a synthetic
    # B-flat part: nearest-in-bar gave a median of 0 with the diffs split evenly
    # between -2 and 0; the matched note gives a clean -2.)
    diffs: list[int] = []
    for ev in aligned:
        ev_midi = ev.get("midi_raw", ev.get("midi"))
        matched = midi_from_name(ev.get("score_pitch") or "")
        if ev_midi is None or matched is None or ev.get("confidence", 0) < 50:
            continue
        diffs.append(int(ev_midi) - matched)
    declared = transpose_for_instrument(instrument)
    measured = None
    if len(diffs) >= 8:
        ordered = sorted(diffs)
        median  = ordered[len(ordered) // 2]
        # Only trust it if most notes agree — otherwise this is just bad playing,
        # not a transposition, and shifting would hide the real errors.
        agree = sum(1 for d in diffs if abs(d - median) <= 1)
        if agree >= 0.6 * len(diffs):
            measured = median

    if declared is not None and measured is not None and abs(measured - declared) > 1:
        # The student said one thing and the audio says another. One of them is
        # wrong and we cannot tell which — a B-flat player reading a concert
        # score looks identical to a broken alignment from here. Guessing means
        # accusing someone of wrong notes they did not play, so say nothing.
        _note_transposition_debug(
            f"CONFLICT declared={declared:+d} ({instrument}) vs measured="
            f"{measured:+d} — wrong-note detection disabled for this take")
        print(f"[find_wrong_note_candidates] SUPPRESSED — {instrument!r} implies "
              f"{declared:+d} semitones but the audio measures {measured:+d}. "
              f"Cannot tell which reading is right, so no wrong notes are reported.")
        return []

    # The student's declaration is now a required field, so prefer it: it is a
    # stated fact, where the measurement is inferred from a DTW alignment that
    # may itself be wrong. They agree in the normal case anyway.
    transpose = declared if declared is not None else (measured or 0)
    _note_transposition_debug(
        f"declared={declared if declared is not None else 'none'} "
        f"measured={measured if measured is not None else 'none'} applied={transpose:+d}")
    if transpose:
        print(f"[find_wrong_note_candidates] applying {transpose:+d} semitones "
              f"(declared={declared}, measured={measured}) for {instrument!r}")
        score_by_measure = {m: [p + transpose for p in ps] for m, ps in score_by_measure.items()}

    # ── Evidence gates ─────────────────────────────────────────────────────
    # These flags are emitted as CONFIRMED and shown as fact, so the bar for
    # calling a note wrong is deliberately high. A wrong note is a sustained,
    # confidently-tracked pitch that does not belong. Anything transient is a
    # key click, a bow scrape, a breath, a reverb tail or a CREPE octave slip —
    # none of which are the student playing a wrong note.
    MIN_CONF    = 65     # well above the 50 used for softer flags
    # `end_sec` is the NEXT onset, so this is an inter-onset interval, not a
    # true note length. Keep the floor under a 16th at 120bpm (0.125s) or fast
    # passages would become invisible to the detector; genuine key clicks, bow
    # scrapes and transients sit well below 80ms.
    MIN_DUR_SEC = 0.08
    MAX_SPREAD  = 40     # a sliding/unstable reading has no pitch to judge

    # First and last onset of each measure — the only places where an off-by-one
    # alignment can plausibly put a correctly-played note in the wrong bar.
    _by_measure: dict[int, list[float]] = {}
    for ev in aligned:
        if ev.get("measure") is not None and ev.get("time_sec") is not None:
            _by_measure.setdefault(ev["measure"], []).append(ev["time_sec"])
    _measure_edges = {m: {min(ts), max(ts)} for m, ts in _by_measure.items() if ts}

    # A squeak is not a wrong note, and must never be reported as one.
    #
    # Until 2026-08-22 clarinet register-break events were deleted outright, so
    # they could not reach this detector. Keeping them (so cracks are reportable
    # at all) opened a path: `looks_like_squeak` accepts an event that is brief
    # AND *any one of* unstable / low-confidence / noisy — so an event kept on
    # TIMBRE alone can still be confidently tracked and stable in pitch, which
    # clears every gate below. To this detector it then looks exactly like a
    # deliberately played note a 12th above the written one.
    #
    # These events are already reported, correctly, by the crack detector.
    _flatness_ref = take_flatness_median(aligned)
    _skipped_squeaks = 0

    considered = 0                       # notes that passed the gates
    suspects: list[dict] = []
    for ev in aligned:
        m_num   = ev.get("measure")
        ev_midi = ev.get("midi_raw", ev.get("midi"))  # unclamped — accurate comparison
        ev_conf = ev.get("confidence", 0)
        if m_num is None or ev_midi is None:
            continue
        if ev.get("squeak_suspect") or looks_like_squeak(ev, _flatness_ref) is True:
            _skipped_squeaks += 1
            continue
        # Duration is unknown on some paths. Skip the gate rather than the note:
        # treating "unknown" as "too short" silently switched the whole detector
        # off, which a test caught only because it asserted real notes ARE found.
        t0, t1 = ev.get("time_sec"), ev.get("end_sec")
        dur = (float(t1) - float(t0)) if (t0 is not None and t1) else None
        if (ev_conf < MIN_CONF
                or (dur is not None and dur < MIN_DUR_SEC)
                or ev.get("cents_spread", 0) > MAX_SPREAD):
            continue
        own = score_by_measure.get(m_num)
        if not own:
            continue
        considered += 1

        # A note sitting one bar off in the alignment is an alignment error, not
        # a wrong note. But alignment slop is a BOUNDARY phenomenon, so only the
        # first and last note of a measure get the neighbouring bars' pitches
        # added. Extending it to every note was far too permissive: on
        # scale-like writing three bars of pitches cover most of the scale, and
        # nothing can ever be called wrong. A test caught that immediately.
        expected = list(own)
        if ev.get("time_sec") in _measure_edges.get(m_num, ()):
            for nb in (m_num - 1, m_num + 1):
                expected.extend(score_by_measure.get(nb, []))

        min_dist = min(abs(ev_midi - e) for e in expected)

        # Pitch-class distance (mod 12, circular) — octave displacement has
        # pc_dist == 0 and is not a wrong note.
        ev_pc       = ev_midi % 12
        min_pc_dist = min(min(abs(ev_pc - (e % 12)), 12 - abs(ev_pc - (e % 12)))
                          for e in expected)

        # If the note is exactly right under the UNtransposed reading, that is
        # the fingerprint of a transposition artifact rather than a mistake —
        # the shape the user saw as "wrong note" flags on correct playing.
        # Requiring an exact match keeps this narrow: it will not swallow a
        # genuine wrong note, which lands on no reading in particular.
        if transpose and any(ev_midi == p - transpose for p in own):
            continue

        if min_dist >= 2 and min_pc_dist >= 2:
            # Report against the note DTW actually matched where we have it —
            # that names what should have sounded at this instant, rather than
            # whichever note in the bar happens to be closest to the mistake.
            # score_pitch is the WRITTEN pitch straight off the page, so it
            # needs the same transposition as everything else in
            # score_by_measure. Mixing the two named a note the student never
            # saw and reported a distance that did not match it.
            matched  = midi_from_name(ev.get("score_pitch") or "")
            in_bar   = min(own, key=lambda e: abs(ev_midi - e))
            ref      = (matched + transpose) if matched is not None else in_bar
            # The distance must be the distance to the note we NAME. `min_dist`
            # is the minimum over the whole (possibly neighbour-expanded) pitch
            # set and is what the gates above are judged on, but printing it
            # beside `ref` produced arithmetic the student can check and find
            # wrong — e.g. "detected G#4, score has D4 (5 semitones away)" when
            # G#4 to D4 is 6. Gate on the set; report against the named note.
            named_dist = abs(ev_midi - ref)
            suspects.append({
                "measure": m_num, "conf": ev_conf,
                "dur": dur if dur is not None else 0.25,
                "dist": named_dist, "time": ev.get("time_sec") or 0.0,
                "played": ev_midi, "expected": ref, "hz": ev.get("pitch_hz", 0),
            })

    # ── Global sanity gate ─────────────────────────────────────────────────
    # A student does not play a quarter of their notes wrong. If the detector
    # thinks they did, the detector is broken — a misread score, a bad DTW
    # alignment, or a transposition we failed to measure — and every flag it
    # produces is noise. Staying silent is strictly better than filling the
    # page with confident wrong-note claims about correct playing, which is
    # exactly what was reported.
    if _skipped_squeaks:
        print(f"[find_wrong_note_candidates] skipped {_skipped_squeaks} squeak-shaped "
              f"event(s) — cracks are reported by the crack detector, not as wrong notes")
    if considered >= 12 and len(suspects) > 0.25 * considered:
        print(f"[find_wrong_note_candidates] SUPPRESSED — {len(suspects)}/{considered} "
              f"notes ({100 * len(suspects) / considered:.0f}%) look wrong, which means "
              f"the score read, alignment or transposition is off, not the playing")
        return []

    # One per measure, keeping the most certain: longest and most confident,
    # then furthest from the written pitch.
    best: dict[int, dict] = {}
    for sp in suspects:
        prev = best.get(sp["measure"])
        key  = (sp["conf"] * min(sp["dur"], 0.5), sp["dist"])
        if prev is None or key > (prev["conf"] * min(prev["dur"], 0.5), prev["dist"]):
            best[sp["measure"]] = sp

    ranked = sorted(best.values(),
                    key=lambda x: -(x["conf"] * min(x["dur"], 0.5)))
    # Capped low on purpose: a handful of certain calls is more useful, and more
    # believable, than twenty marginal ones.
    return [
        f"wrong_note | measure {sp['measure']} | "
        f"CREPE detected {midi_to_scientific(sp['played'])} "
        f"({sp['hz']:.0f} Hz, conf={sp['conf']}%, {sp['dur']:.2f}s), "
        f"score has {midi_to_scientific(sp['expected'])} "
        f"({sp['dist']} semitones away) at t={sp['time']:.2f}s"
        for sp in ranked[:6]
    ]


# Marked levels on a single ordered scale. Only the ordering matters: dynamics
# are relative, and "f is louder than p" is the claim we can actually check.
_DYNAMIC_RANK = {
    "ppp": 0, "pp": 1, "p": 2, "mp": 3, "mf": 4, "f": 5, "ff": 6, "fff": 7,
    "sf": 6, "sfz": 6, "fp": 5, "rf": 6, "rfz": 6,
}
_DYN_MIN_NOTES   = 4    # notes needed at a level before it can be compared
_DYN_MIN_DB      = 3.0  # dB between levels below which there is no real contrast
_DYN_INVERT_DB   = 2.0  # dB the wrong way before calling it inverted


def analyze_dynamics_vs_score(aligned: list[dict], score: dict) -> dict:
    """
    Check dynamics against the score's own markings.

    Dynamics was the one category with no objective corroboration: events only
    carried a three-way loudness bucket (which cannot measure contrast — a
    player with no range and a player with full range produce the same string)
    and `parse_musicxml` hard-coded every note's dynamic to None. So if Gemini
    said "no contrast at the piano marking", nothing could check it.

    Two things are checkable and worth stating:
      contrast — the marked levels are all played at the same volume
      inverted — a section marked louder is actually played softer

    Deliberately RELATIVE. Absolute dBFS depends on mic distance and gain, so
    only differences *within one take* mean anything. Returns
    {"ok": False, "reason": …} when the score carries no usable markings, so
    the caller reports nothing rather than guessing.
    """
    if not aligned:
        return {"ok": False, "reason": "no aligned events"}

    # measure -> prevailing marking, carried FORWARD across measures.
    #
    # The two score sources disagree about what "dynamic" means per note.
    # parse_musicxml now stamps the prevailing marking on every note, but the
    # vision reader returns `dyn` only on the note where the marking is printed
    # — every later note is null. Reading it per measure without carrying it
    # forward therefore gave photo-based scores a handful of isolated measures,
    # never enough to clear the two-levels/four-notes bar, so dynamics silently
    # did nothing for exactly the scores most users upload.
    #
    # A marking applies until the next one. Do that here, once, so both sources
    # behave identically regardless of how the parser filled the field.
    dyn_by_measure: dict[int, str] = {}
    prevailing: str | None = None
    for m in sorted((mm for mm in score.get("measures", [])
                     if isinstance(mm.get("number"), int)),
                    key=lambda mm: mm["number"]):
        for n in m.get("notes", []):
            d = str(n.get("dynamic") or "").strip().lower()
            if d in _DYNAMIC_RANK:
                prevailing = d
                break
        if prevailing:
            dyn_by_measure[m["number"]] = prevailing

    if len(set(dyn_by_measure.values())) < 2:
        return {"ok": False, "reason": "score has fewer than two distinct dynamic markings"}

    # Loudness per marked level. One reading per note (DTW is many-to-one), and
    # only notes loud enough to have been tracked confidently.
    by_level: dict[str, list[float]] = {}
    seen_idx: set = set()
    for ev in aligned:
        db = ev.get("db")
        m  = ev.get("measure")
        if db is None or m is None or ev.get("confidence", 0) < 50:
            continue
        si = ev.get("score_idx")
        if si is not None:
            if si in seen_idx:
                continue
            seen_idx.add(si)
        lvl = dyn_by_measure.get(m)
        if lvl:
            by_level.setdefault(lvl, []).append(float(db))

    usable = {k: v for k, v in by_level.items() if len(v) >= _DYN_MIN_NOTES}
    if len(usable) < 2:
        return {"ok": False, "reason": "not enough notes under two different markings"}

    med = {k: median(v) for k, v in usable.items()}
    ranked = sorted(med, key=lambda k: _DYNAMIC_RANK[k])
    softest, loudest = ranked[0], ranked[-1]
    spread = med[loudest] - med[softest]

    findings: dict = {"ok": True, "levels": {k: round(v, 1) for k, v in med.items()},
                      "spread_db": round(spread, 1), "contrast": None, "inverted": []}

    if spread < _DYN_MIN_DB:
        findings["contrast"] = {
            "softest": softest, "loudest": loudest,
            "spread_db": round(spread, 1),
            "measures": sorted({m for m, d in dyn_by_measure.items() if d in (softest, loudest)}),
        }

    # Any pair played the wrong way round, not just the extremes.
    for i in range(len(ranked)):
        for j in range(i + 1, len(ranked)):
            lo, hi = ranked[i], ranked[j]
            if med[lo] - med[hi] >= _DYN_INVERT_DB:
                findings["inverted"].append({
                    "quieter_marking": hi, "louder_marking": lo,
                    "delta_db": round(med[lo] - med[hi], 1),
                    "measures": sorted({m for m, d in dyn_by_measure.items() if d == hi}),
                })

    print(f"[dynamics] levels={findings['levels']} spread={spread:.1f}dB "
          f"contrast={'yes' if findings['contrast'] else 'no'} "
          f"inverted={len(findings['inverted'])}")
    return findings


def find_crack_candidates(aligned: list[dict]) -> list[str]:
    """
    Detect squeaks, cracks and register breaks.

    These are NOT wrong notes and must not share that detector. A wrong note is
    a sustained, confidently-tracked pitch that does not belong;
    `find_wrong_note_candidates` is deliberately strict about exactly that
    (conf >= 65, >= 80ms, stable pitch) — which rejects every squeak, since a
    squeak is short, unstable and violently high. Gating Gemini's "a squeak
    breaks the line" on the wrong-note detector therefore threw the observation
    away, and unconfirmed issues are dropped, so cracks became invisible.

    A crack has its own signature: the pitch leaps FAR ABOVE the note being
    played, briefly, and then comes back. On a clarinet that is typically the
    12th; on brass and flute an octave or more — but the detector deliberately
    takes no `instrument` argument. The interval varies by instrument AND by how
    the crack happens, and a per-instrument threshold tuned on no data would
    reject real cracks while looking authoritative. The generic test (up, far,
    brief, returns) already separates a crack from a written leap.

    Pitch geometry alone still confuses a squeak with a written leap that
    happens to be brief, so the jump must ALSO carry the acoustic signature of a
    squeak (see `looks_like_squeak`). Where timbre cannot be measured the
    geometric test stands on its own — an unmeasurable note must not become an
    automatic negative.

    A second signature needs no pitch jump at all: an airy, noise-like burst
    where a tone should be. That is a split note or an air-ball, and no
    pitch-based test can see it.

    Returns evidence strings for the coaching prompt, one per measure.
    """
    if not aligned:
        return []

    by_measure: dict[int, dict] = {}
    ordered = sorted((e for e in aligned if e.get("time_sec") is not None),
                     key=lambda e: e["time_sec"])
    flatness_ref = take_flatness_median(ordered)
    for i, ev in enumerate(ordered):
        m = ev.get("measure")
        midi = ev.get("midi_raw", ev.get("midi"))
        if m is None or midi is None:
            continue
        t   = float(ev["time_sec"])
        # Uninterrupted span, not the dropout-tolerant one — see
        # `looks_like_squeak`. A squeak measured by held_sec looks long.
        dur = float(ev.get("stable_sec") or ev.get("held_sec") or 0.0)

        # Reference pitch = the notes around it, so this works whether or not
        # the score matched: a crack stands out against its own neighbours.
        neigh = [ordered[j].get("midi_raw", ordered[j].get("midi"))
                 for j in range(max(0, i - 3), min(len(ordered), i + 4)) if j != i]
        neigh = [n for n in neigh if n is not None]
        if len(neigh) < 2:
            continue
        neigh.sort()
        ref = neigh[len(neigh) // 2]

        squeak = looks_like_squeak(ev, flatness_ref)

        jump = midi - ref
        # Up, far, and brief — a sustained high note is just a high note.
        if jump >= 7 and dur <= 0.28:
            # It has to come back down: a crack is an interruption, not a leap
            # into a new register. Compare against what follows.
            after = [ordered[j].get("midi_raw", ordered[j].get("midi"))
                     for j in range(i + 1, min(len(ordered), i + 4))]
            after = [n for n in after if n is not None]
            if after and min(abs(n - ref) for n in after) > 4:
                continue
            # Timbre must agree, when timbre is measurable. `None` = unmeasurable,
            # and the geometric evidence carries it alone.
            if squeak is False:
                continue
            prev = by_measure.get(m)
            if prev is None or jump > prev.get("jump", 0):
                by_measure[m] = {"kind": "jump", "jump": jump, "time": t,
                                 "dur": dur, "midi": midi, "ref": ref}
            continue

        # ── Noise burst: a split/airy note that never leaves its own pitch ──
        # Deliberately stricter than the jump branch. There is no corroborating
        # pitch geometry here, so the spectrum alone has to carry it: markedly
        # noisier than this take's norm AND badly tracked. Anything looser turns
        # ordinary breath noise into a flag.
        if (flatness_ref and isinstance(ev.get("flatness"), (int, float))
                and isinstance(ev.get("confidence"), (int, float))
                and ev["flatness"] >= flatness_ref * 3.0
                and ev["confidence"] <= 55
                and dur <= 0.35):
            if by_measure.get(m) is None:      # a real pitch jump outranks this
                by_measure[m] = {"kind": "noise", "time": t, "dur": dur,
                                 "midi": midi, "ref": ref,
                                 "flat_x": ev["flatness"] / flatness_ref}

    out = []
    for m in sorted(by_measure):
        d = by_measure[m]
        if d.get("kind") == "noise":
            out.append(
                f"crack | measure {m} | note came out airy and unfocused rather "
                f"than as a clear tone ({d['flat_x']:.1f}x the take's usual noise "
                f"level) for {d['dur']:.2f}s at t={d['time']:.2f}s"
            )
        else:
            out.append(
                f"crack | measure {m} | pitch jumped {d['jump']} semitones above the "
                f"surrounding line ({midi_to_scientific(d['ref'])} -> "
                f"{midi_to_scientific(d['midi'])}) for {d['dur']:.2f}s at "
                f"t={d['time']:.2f}s"
            )
    if out:
        print(f"[find_crack_candidates] {len(out)} crack/squeak candidate(s)")
    return out[:8]


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




def _flag_penalty(flag: dict) -> float:
    """Return the weighted penalty for a single flag."""
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

    # Unconfirmed flags never reach here: `compare_and_coach_claude` filters
    # `deduped_issues` to confirmed=True before building flags (a deliberate
    # product decision — hedged findings were removed on 2026-07-24). The old
    # `_UNCONFIRMED_MULT` discount and the grouped/occurrences branch were both
    # written for the earlier hedging model and had no reachable producer once
    # `_group_similar_flags` stopped being called; they read as live policy while
    # doing nothing, which is exactly how this file's tier logic came to be
    # described wrongly. Deleted rather than left as decoration.
    return base * mult


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


def build_measure_timeline(
    measure_lo: int,
    measure_hi: int,
    anchors: dict,
    sec_per_measure: float,
    last_event_time: float | None = None,
    piece_len: float = 0.0,
) -> list[dict]:
    """
    Build THE measure->time map: one contiguous, non-overlapping span per measure
    covering measure_lo..measure_hi inclusive.

    Why this exists. Measure labels and Loop windows used to be produced by two
    separate ~70-line functions, each with the same seven-tier ladder (DTW ranges,
    scaled beats, two-point map, uniform tempo, raw beats, ...), kept mirrored by
    hand. Because each resolved its tier INDEPENDENTLY per call, a flag's label
    could come from the DTW tier while its Loop window came from the beat-grid
    tier — two different models of where a measure sits. That is the root cause of
    every "the number doesn't match the clip" and "the loop doesn't stop at the
    right measure" bug: not arithmetic, but two sources of truth.

    Here the tier is chosen ONCE by the caller (it supplies whatever anchors it
    has), and every consumer reads the single array this returns. Disagreement
    becomes structurally impossible rather than something to keep re-fixing.

    `anchors` maps measure number -> the time that measure is known to start.
    Measures with no anchor (rest-only bars, multirests, anything the detector
    missed) are INTERPOLATED between neighbouring anchors on the measure-number
    axis, so they still get real bounds instead of falling through to a different
    model. Interpolating on measure number — not on "index of measures we
    happened to detect" — is what makes an 11-bar multirest occupy eleven bars of
    time rather than collapsing to nothing.

    Returns [{"measure": int, "start": float, "end": float}], ascending, where
    every end == the next measure's start.
    """
    if measure_hi < measure_lo:
        measure_hi = measure_lo
    spm = float(sec_per_measure) if sec_per_measure and sec_per_measure > 0.05 else 1.0

    # Keep only usable anchors, and enforce that time increases with measure
    # number. A single mis-assigned onset would otherwise invert a segment and
    # produce a negative-length measure.
    pts: list[tuple[int, float]] = []
    for m, t in sorted((int(k), float(v)) for k, v in anchors.items()
                       if v is not None and measure_lo <= int(k) <= measure_hi):
        if not pts or t > pts[-1][1]:
            pts.append((m, t))

    starts: dict[int, float] = {}
    if len(pts) >= 2:
        for m in range(measure_lo, measure_hi + 1):
            if m <= pts[0][0]:
                m0, t0 = pts[0]
                m1, t1 = pts[1]
                slope = (t1 - t0) / max(1, m1 - m0)
                starts[m] = t0 - slope * (m0 - m)
            elif m >= pts[-1][0]:
                m0, t0 = pts[-2]
                m1, t1 = pts[-1]
                slope = (t1 - t0) / max(1, m1 - m0)
                starts[m] = t1 + slope * (m - m1)
            else:
                for (ma, ta), (mb, tb) in zip(pts, pts[1:]):
                    if ma <= m <= mb:
                        frac = (m - ma) / max(1, mb - ma)
                        starts[m] = ta + frac * (tb - ta)
                        break
    else:
        base_m, base_t = pts[0] if pts else (measure_lo, 0.0)
        for m in range(measure_lo, measure_hi + 1):
            starts[m] = base_t + (m - base_m) * spm

    # Strictly increasing, with a floor so no measure can be zero-length.
    MIN_DUR = 0.12
    ordered = sorted(starts)
    for i, m in enumerate(ordered):
        starts[m] = max(0.0, starts[m])
        if i and starts[m] < starts[ordered[i - 1]] + MIN_DUR:
            starts[m] = starts[ordered[i - 1]] + MIN_DUR

    # end == next start, so the spans tile the timeline with no gaps or overlaps.
    # The final measure has no successor: run it to the last sounded note plus a
    # measure, which is what makes Loop include that measure's last note instead
    # of stopping on its onset.
    out: list[dict] = []
    for i, m in enumerate(ordered):
        if i + 1 < len(ordered):
            end = starts[ordered[i + 1]]
        else:
            end = max(starts[m] + spm, (last_event_time or 0.0) + spm * 0.5)
            if piece_len > 0:
                end = min(end, piece_len)
            end = max(end, starts[m] + MIN_DUR)
        out.append({"measure": m, "start": round(starts[m], 4), "end": round(end, 4)})
    return out


def assign_flag_keys(flags: list[dict]) -> None:
    """
    Stamp a stable `flag_key` on each flag, in place.

    `flag_annotations` was keyed on flag_index — the flag's POSITION in the
    array. Re-running an analysis reorders flags, so every annotation then
    pointed at a different flag than the teacher looked at, silently corrupting
    the only ground truth this project has.

    Dedup guarantees one flag per (measure, type), so "type:measure" identifies
    a flag by what it SAYS rather than where it sits. The relabel pass can move
    a flag's measure after dedup, which can collide two same-type flags onto one
    key, so collisions take a suffix in array order.
    """
    seen: dict[str, int] = {}
    for f in flags:
        base = f"{f.get('type', 'issue')}:{f.get('measure', '?')}"
        n = seen.get(base, 0) + 1
        seen[base] = n
        f["flag_key"] = base if n == 1 else f"{base}#{n}"


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

    # ── THE measure<->time map ─────────────────────────────────────────────
    # One timeline, built once, read by everything: flag labels, Loop windows,
    # posture placement, span merging. This replaced two ~70-line functions that
    # each walked the same seven-tier ladder (DTW ranges / scaled beats /
    # two-point map / uniform tempo / raw beats / ...) and resolved their tier
    # INDEPENDENTLY per call — so a flag could be labelled from the DTW tier
    # while its Loop window came from the beat-grid tier. Two models of where a
    # measure sits is what produced every "number doesn't match the clip" and
    # "loop doesn't stop at the right measure" report. The tier is now chosen
    # once, below, and turned into a single contiguous array.
    #
    # Built lazily: anchor_end is computed further down, and these closures are
    # only ever called after that point.
    _timeline_cache: dict = {}

    def _timeline() -> list[dict]:
        if "tl" in _timeline_cache:
            return _timeline_cache["tl"]
        bpm_grid = beats_per_measure if (beats_per_measure and beats_per_measure >= 1) else bpm
        bpm_grid = max(1, int(bpm_grid or 4))

        lo = int(start_measure)
        hi = int(anchor_end) if anchor_end and anchor_end > lo else None
        seen = [int(e["measure"]) for e in (aligned or []) if e.get("measure") is not None]
        seen += [int(r["measure"]) for r in (alignment_ranges or [])]
        if seen:
            lo = min(lo, min(seen))
            hi = max(hi or lo, max(seen))
        if hi is None:
            hi = lo
        hi = max(hi, lo)

        last_t = max([0.0] + [float(e["time_sec"]) for e in (aligned or []) if e.get("time_sec") is not None])

        # Where the MUSIC starts, which is not where the recording starts. Takes
        # open with the player settling, breathing, adjusting the stand — CREPE
        # emits low-periodicity events for that, and whichever measure they land
        # on absorbs the whole run-up, so the first measure was being labelled
        # over the seconds before a note was played. Require a confident event
        # that is followed by another within two seconds, so an isolated key
        # click or breath cannot open the piece.
        # Require DENSITY, not just a neighbour: the first confident event that has
        # at least three confident events within the following two seconds. A
        # phrase begins with several notes in quick succession; a key click or a
        # stand knock does not. (Merely "followed by another within 2s" was not
        # enough — an isolated click 1.6s before the real entry still qualified
        # and opened the piece early.)
        # Cross-reference against the NOTE COMPARISON first. An event that DTW
        # matched to a score note is, by definition, the player playing the
        # piece — far stronger evidence of "the music started here" than
        # loudness or periodicity, which a breath or a key click also satisfy.
        # The density rule below is the fallback for when DTW has nothing.
        music_t0 = None
        _matched = sorted(float(e["time_sec"]) for e in (aligned or [])
                          if e.get("time_sec") is not None
                          and e.get("score_idx") is not None
                          and e.get("confidence", 0) >= 50)
        # DTW will happily match a stray click to a score note, so being matched
        # is necessary but not sufficient — the note also has to sit in a cluster
        # of other matched notes. A phrase arrives together; a knock does not.
        # (A test caught this: noise 2.4s before the entry was matched, and on
        # its own it opened the piece there.)
        for _i, _t in enumerate(_matched):
            if sum(1 for _u in _matched[_i:] if _u - _t <= 2.0) >= 3:
                music_t0 = _t
                break
        if music_t0 is not None:
            print(f"[measure_timeline] music starts at the first note matched to "
                  f"the score: {music_t0:.2f}s")

        if music_t0 is None:
            _conf = sorted(float(e["time_sec"]) for e in (aligned or [])
                           if e.get("time_sec") is not None and e.get("confidence", 0) >= 50)
            for _i, _t in enumerate(_conf):
                _near = sum(1 for _u in _conf[_i:] if _u - _t <= 2.0)
                if _near >= 3:
                    music_t0 = _t
                    break
            if music_t0 is None and _conf:
                music_t0 = _conf[0]

        # Tier choice happens HERE and only here.
        anchors: dict[int, float] = {}
        tier = "uniform"
        if dtw_verified and aligned:
            for e in aligned:
                m, t = e.get("measure"), e.get("time_sec")
                if m is None or t is None:
                    continue
                # Ignore anything before the music actually starts, so the run-up
                # is not folded into the first measure.
                if music_t0 is not None and float(t) < music_t0 - 0.05:
                    continue
                # A measure begins at its first real NOTE. Anchoring on any event
                # lets a low-periodicity blip (breath, key noise, stand knock)
                # inside the bar pull its start earlier than anything audible.
                if e.get("confidence", 0) < 50:
                    continue
                m = int(m)
                if m not in anchors or t < anchors[m]:
                    anchors[m] = float(t)
            if len(anchors) < 2:      # nothing confident — fall back to any event
                for e in aligned:
                    m, t = e.get("measure"), e.get("time_sec")
                    if m is None or t is None:
                        continue
                    if music_t0 is not None and float(t) < music_t0 - 0.05:
                        continue
                    m = int(m)
                    if m not in anchors or t < anchors[m]:
                        anchors[m] = float(t)
            tier = "dtw_onsets"
        if len(anchors) < 2 and alignment_ranges:
            anchors = {int(r["measure"]): float(r["start"]) for r in alignment_ranges}
            tier = "alignment_ranges"
        if len(anchors) < 2 and scaled_beat_times and len(scaled_beat_times) >= 2:
            anchors = {}
            for m in range(lo, hi + 1):
                idx = (m - lo) * bpm_grid
                if 0 <= idx < len(scaled_beat_times):
                    anchors[m] = float(scaled_beat_times[idx])
            tier = "scaled_beats"
        if len(anchors) < 2 and anchor_end and anchor_time and anchor_end > lo and anchor_time > 0:
            anchors = {lo: 0.0, int(anchor_end): float(anchor_time)}
            tier = "two_point"

        spm = None
        if len(anchors) >= 2:
            ks = sorted(anchors)
            spread_m, spread_t = ks[-1] - ks[0], anchors[ks[-1]] - anchors[ks[0]]
            if spread_m > 0 and spread_t > 0:
                spm = spread_t / spread_m
        if not spm or spm <= 0.05:
            _bpm_hint = 0.0
            try:
                _bpm_hint = float((tempo or {}).get("bpm") or 0.0)
            except (TypeError, ValueError):
                _bpm_hint = 0.0
            spm = (60.0 / _bpm_hint * bpm_grid) if _bpm_hint > 20 else 2.0

        tl = build_measure_timeline(lo, hi, anchors, spm,
                                    last_event_time=last_t, piece_len=piece_len)

        # Sanity gate. Anchors are only as good as the alignment behind them, and
        # the alignment is only as good as the score read. A bad read (wrong
        # measure count, hallucinated numbering) makes DTW dump most of the audio
        # onto one measure, and the timeline faithfully renders that as a single
        # measure spanning half the recording — a real take shipped m.20 running
        # 2.0s-19.3s while every other measure was ~1s. That is never musically
        # real, and it is better to fall back to an even distribution than to show
        # a Loop that plays seventeen seconds of music labelled as one bar.
        durs = sorted(r["end"] - r["start"] for r in tl)
        if len(durs) >= 4:
            med = durs[len(durs) // 2]
            worst = durs[-1]
            if med > 0 and worst > med * 4.0:
                print(f"[measure_timeline] REJECTED tier={tier}: measure spans "
                      f"range {durs[0]:.2f}-{worst:.2f}s against a median of "
                      f"{med:.2f}s — alignment is untrustworthy (usually a bad "
                      f"score read). Falling back to an even distribution.")
                # Spread the measures over the part of the recording that has
                # MUSIC in it. Starting at 0 put the whole run-up inside the first
                # measure — the loop for m.20 opened on the player still getting
                # ready, which is exactly what this fallback is supposed to avoid.
                t_begin = music_t0 if music_t0 is not None else 0.0
                n_meas = max(1, hi - lo + 1)
                step = max(0.25, (max(last_t, t_begin + spm) - t_begin) / n_meas)
                even = {m: t_begin + (m - lo) * step for m in range(lo, hi + 1)}
                tl = build_measure_timeline(lo, hi, even, step,
                                            last_event_time=last_t, piece_len=piece_len)
                tier += "+rejected_uneven"

        # Final floor: whatever tier produced this, no measure may begin before
        # the first note was played.
        if music_t0 is not None and tl and tl[0]["start"] < music_t0 - 0.05:
            shift = music_t0 - tl[0]["start"]
            for r in tl:
                r["start"] = round(r["start"] + shift, 4)
                r["end"] = round(r["end"] + shift, 4)
            print(f"[measure_timeline] shifted +{shift:.2f}s so m.{tl[0]['measure']} "
                  f"starts on the first note ({music_t0:.2f}s), not the run-up")

        print(f"[measure_timeline] tier={tier} m.{lo}-{hi} ({len(tl)} measures) "
              f"spm={spm:.2f}s anchors={len(anchors)} music_t0="
              f"{('%.2f' % music_t0) if music_t0 is not None else 'n/a'}")
        _timeline_cache["tl"] = tl
        _timeline_cache["idx"] = {r["measure"]: r for r in tl}
        return tl

    def measure_from_notes(tsec: float | None) -> int | None:
        """
        Which measure a moment belongs to, decided by the NOTES rather than by
        elapsed time: snap to the nearest event DTW matched against the score's
        pitch sequence, and take that note's measure.

        Time lookup answers "what should be sounding now if the tempo held";
        this answers "which written note was actually sounding", which is what a
        teacher means by "the issue is in bar 24". They agree in steady playing
        and diverge exactly where it matters — after a hesitation, a dropped
        note, or any rubato. Falls back to the timeline when there is no note
        correspondence (no score DTW, or a moment with no detected pitch).
        """
        if tsec is None or not aligned:
            return None
        best, best_d = None, None
        for e in aligned:
            t, m = e.get("time_sec"), e.get("measure")
            if t is None or m is None or e.get("confidence", 100) < 25:
                continue
            d = abs(float(t) - float(tsec))
            if best_d is None or d < best_d:
                best, best_d = int(m), d
        # Only trust the snap when a real note is nearby; past that the nearest
        # note says nothing useful about this moment.
        if best is not None and best_d is not None and best_d <= 1.5:
            return best
        return None

    def time_to_measure(tsec: float | None) -> int | None:
        """Recording time -> measure number. Reads the canonical timeline."""
        if tsec is None:
            return None
        tl = _timeline()
        if not tl:
            return None
        if tsec < tl[0]["start"]:
            return tl[0]["measure"]
        for r in tl:
            if r["start"] <= tsec < r["end"]:
                return r["measure"]
        return tl[-1]["measure"]

    def measure_to_time_range(m0: int, m1: int | None = None) -> tuple[float, float]:
        """
        Measure(s) -> [start, end) window. The exact inverse of time_to_measure by
        construction: same array, no parallel tier ladder to keep in sync.

        The end is the NEXT measure's start, so a Loop plays the labelled measure
        through its final note instead of stopping on that note's onset — which is
        what made loops cut off early.
        """
        tl = _timeline()
        if not tl:
            return (0.0, 0.0)
        idx = _timeline_cache["idx"]
        # Clamp into the timeline instead of falling back to tl[0]. A measure that
        # is not in the timeline (Gemini's own printed number, or one parsed out
        # of free text) used to silently resolve to the FIRST measure, so the Loop
        # played bar one while the flag said bar thirty. Clamping keeps the window
        # adjacent to what was asked for, and the invariant pass below then
        # relabels the flag to whatever actually plays.
        lo_m, hi_m = tl[0]["measure"], tl[-1]["measure"]
        a = idx.get(min(max(int(m0), lo_m), hi_m)) or tl[0]
        b = idx.get(min(max(int(m1), lo_m), hi_m)) if m1 else None
        t0, t1 = a["start"], (b or a)["end"]
        if t1 <= t0:
            t1 = a["end"]
        # Shave a hair off each edge so a loop does not audibly clip the first note
        # of the following measure. Skipped for the very first measure (nothing
        # before it to bleed in) and whenever it would collapse a short window.
        spb = (t1 - t0) / max(1, bpm)
        margin = min(0.25, spb * 0.15)
        s_adj = t0 + (margin if int(m0) > int(tl[0]["measure"]) else 0.0)
        e_adj = t1 - margin
        if e_adj - s_adj < 0.5:
            return (t0, t1)
        return (s_adj, e_adj)

    evidence_candidates: list[str] = []
    for m in played_measures:
        events  = sorted(events_by_measure.get(m["number"], []), key=lambda e: e["time_sec"])
        r       = range_map.get(m["number"])
        m_start = r["start"] if r else (events[0]["time_sec"] if events else 0)
        m_dur   = max(0.5, r["end"] - r["start"]) if r else 4.0
        spb     = m_dur / max(1, bpm)
        for ev in events:
            cents = ev.get("cents_offset")
            if cents is not None and abs(cents) >= cents_flag_threshold and ev.get("confidence", 100) >= 50 and ev.get("cents_spread", 0) <= 35:
                beat = max(1, round((ev["time_sec"] - m_start) / spb + 1, 2))
                sign = "+" if cents > 0 else ""
                evidence_candidates.append(
                    f"intonation | measure {m['number']} beat {beat} | {'/'.join(ev['pitches'])} is {sign}{cents}¢ at {ev['time_sec']:.2f}s"
                )
        gaps = [events[i+1]["time_sec"] - events[i]["time_sec"] for i in range(len(events) - 1)]
        if len(gaps) >= 4:
            # Local name was `median`, which SHADOWED the module-level median()
            # helper for the rest of this function.
            gap_median = median(gaps) or 0.0
            for i, gap in enumerate(gaps):
                if gap_median > 0 and gap > gap_median * 2.2 and gap > 0.8:
                    beat = max(1, round((events[i]["time_sec"] - m_start) / spb + 1, 2))
                    evidence_candidates.append(
                        f"timing | measure {m['number']} near beat {beat} | {gap:.2f}s gap after {'/'.join(events[i]['pitches'])} at {events[i]['time_sec']:.2f}s"
                    )
    # `evidence_candidates` is consumed in full further down (Tier B corroboration
    # and the timing/intonation confirmation sets). It used to also be ranked by
    # magnitude into a `strongest` shortlist, but that list only ever fed the
    # evidence bail-out that has since been removed — nothing read it — so the
    # ranking has gone with it rather than being left as work done for nothing.

    # Add direct CREPE-vs-score wrong note candidates
    wrong_note_candidates = find_wrong_note_candidates(aligned, score, instrument)
    crack_candidates      = find_crack_candidates(aligned)
    dynamics_report       = analyze_dynamics_vs_score(aligned, score)

    # Objective timing must be computed BEFORE the no-evidence guard below and
    # counted as evidence in its own right. A performance that is in tune, on the
    # right notes, and that Gemini had no comment on can still be rhythmically
    # wrong — that used to return zero flags here, which is exactly the "nothing
    # on timing" gap this analysis exists to close.
    timing_report = None
    if score.get("measures") and any(ev.get("score_idx") is not None for ev in aligned):
        try:
            # Feed it only the MUSIC. Events picked up while the player was still
            # getting ready sit before the first note but still get matched to a
            # score note, so the tempo fit starts the piece early and the opening
            # downbeat is then reported as a "late arrival" — it was late relative
            # to the run-up, not to the playing. _timeline() already works out
            # where the music starts; reuse that single definition rather than
            # inventing a second one here.
            _tl = _timeline()
            _music_start = _tl[0]["start"] if _tl else None
            _musical = [
                ev for ev in aligned
                if _music_start is None or (ev.get("time_sec") is None
                                            or float(ev["time_sec"]) >= _music_start - 0.05)
            ]
            if len(_musical) < len(aligned):
                print(f"[compare_and_coach_claude] timing: ignoring "
                      f"{len(aligned) - len(_musical)} pre-music event(s) before "
                      f"{_music_start:.2f}s so the opening is not judged late")
            timing_report = analyze_timing_vs_score(_musical, score, bpm)
        except Exception as e:                      # never fail the whole analysis
            print(f"[compare_and_coach_claude] timing analysis error: {e}")
            timing_report = None

    # `crepe_has_data` and `has_gemini_data` used to live here to feed the early
    # bail-out. They are gone with it — leaving them would be a standing
    # invitation to wire a new short-circuit back up to a hand-written list.
    # NOTE: there is deliberately no early "do we have any evidence?" bail-out
    # here. There used to be, and it listed its sources by hand — so every new
    # detector had to be remembered in two places, and a take whose ONLY problem
    # was a newly added detector returned nothing, because the function exited
    # before the section that would have reported it. Cracks and dynamics were
    # both silently swallowed that way.
    #
    # The authoritative check is `if not canonical` further down: it runs AFTER
    # every section has had its say, so it asks what was actually found rather
    # than what someone remembered to list. Nothing between here and there costs
    # an API call, so the short-circuit bought nothing anyway. Do not reintroduce
    # it — add detectors, and the check below picks them up for free.

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
    # Gemini's rhythm observations were corroborated only by measures that
    # already produced a full timing FLAG. But CREPE's timing findings are
    # deliberately conservative (a measure must clear the placement threshold,
    # or drift, or a duration ratio), so an audible unevenness that sits under
    # those bars had nothing to confirm it — and unconfirmed issues are dropped
    # outright, so the observation vanished rather than being reported.
    #
    # Corroborate against the raw note residuals instead: if the notes in that
    # measure are measurably uneven at all, Gemini saying so is confirmed.
    # timing_report is None whenever the score-DTW path did not run at all (a
    # failed score read, or too few matched onsets). Guarding on `.get` alone
    # crashed the whole analysis there — found by running the no-score path.
    #
    # The first version of this took ANY single note in the bar whose raw
    # residual exceeded 55 ms. Three things were wrong with that, and together
    # they made the corroboration gate a pass-through — it confirmed very nearly
    # any rhythm claim Gemini cared to make:
    #
    #   1. 55 ms is below this pipeline's own measurement noise. Onsets come off
    #      a 23 ms librosa grid, are deduped at 50 ms, and the candidate list is
    #      padded with synthetic probes every 350 ms inside sustained notes.
    #   2. It was a max over the bar, so one bad onset spoke for every note.
    #   3. `residual_ms` is stored UN-de-trended, and the grid is anchored so the
    #      first note's residual is zero by construction — any error in that one
    #      onset is added to every residual in the piece as a constant, lifting
    #      the whole take past the threshold at once.
    #
    # Gemini's rhythm category covers two different claims, and one statistic
    # cannot corroborate both:
    #
    #   "this bar sits behind the beat" -> the whole bar is displaced, so the
    #                                      bar's MEDIAN deviation is large.
    #   "the eighths are uneven"        -> alternate notes are displaced, so the
    #                                      median is washed out. A real swung bar
    #                                      measures [0, 75, 0, 75]: median 37.5,
    #                                      but every consecutive pair JUMPS 75.
    #
    # Take either, both against the same floor, so neither is a way in for noise.
    if isinstance(timing_report, dict) and timing_report.get("ok") is not False:
        _rows = timing_report.get("notes") or []
        _spb  = float(timing_report.get("spb") or 0.5)
        # De-trend exactly as the placement check does: a constant offset across
        # the whole take is a grid artefact, not something the player did.
        _centre = median([float(r.get("residual_ms") or 0.0) for r in _rows]) or 0.0
        _by_meas: dict[int, list[float]] = {}
        for _row in _rows:
            try:
                _m = int(_row["measure"])
            except (KeyError, TypeError, ValueError):
                continue
            _by_meas.setdefault(_m, []).append(
                float(_row.get("residual_ms") or 0.0) - _centre)
        _floor = max(_TIMING_RHYTHM_CONF_MS, _TIMING_RHYTHM_CONF_FRAC * _spb * 1000.0)
        for _m, _devs in _by_meas.items():
            if len(_devs) < 2:
                continue
            _offset = abs(median([abs(d) for d in _devs]) or 0.0)
            _rough  = median([abs(_devs[i] - _devs[i - 1])
                              for i in range(1, len(_devs))]) or 0.0
            if max(_offset, _rough) >= _floor:
                timing_conf_measures.add(_m)

    wrongnote_conf_measures: set[int] = set()
    for cand in wrong_note_candidates:
        mm = re.search(r'measure (\d+)', cand)
        if mm:
            wrongnote_conf_measures.add(int(mm.group(1)))
    # Dynamics was Tier A (Gemini believed unconditionally) purely because there
    # was nothing to check it against. Now there is.
    dynamics_conf_measures: set[int] = set()
    if isinstance(dynamics_report, dict) and dynamics_report.get("ok"):
        if dynamics_report.get("contrast"):
            dynamics_conf_measures.update(dynamics_report["contrast"]["measures"])
        for inv in dynamics_report.get("inverted") or []:
            dynamics_conf_measures.update(inv["measures"])

    crack_conf_measures: set[int] = set()
    for cand in crack_candidates:
        mm = re.search(r'measure (\d+)', cand)
        if mm:
            crack_conf_measures.add(int(mm.group(1)))

    canonical: list[dict] = []

    _ORD_NAMES = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
                  6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth"}

    def _note_index_in_measure(measure: int | None, tsec: float | None) -> int | None:
        """Which note of the measure sounds at `tsec`, 1-based, from the DTW match."""
        if measure is None or tsec is None:
            return None
        seen: set = set()
        ordered: list[tuple[float, int]] = []
        for ev in sorted((e for e in aligned
                          if e.get("measure") == measure
                          and e.get("time_sec") is not None
                          and e.get("score_idx") is not None),
                         key=lambda e: e["time_sec"]):
            si = ev["score_idx"]
            if si in seen:
                continue          # DTW is many-to-one; one entry per score note
            seen.add(si)
            ordered.append((float(ev["time_sec"]), si))
        if not ordered:
            return None
        best = min(range(len(ordered)), key=lambda i: abs(ordered[i][0] - tsec))
        if abs(ordered[best][0] - tsec) > 1.0:
            return None           # nothing close enough to be sure
        return best + 1

    def _canonicalize_note_ordinals(text: str, measure: int | None,
                                    tsec: float | None) -> str:
        """
        Correct "on the first note" when the timestamp says it was the third.

        Gemini counts notes by eye and gets it wrong; the DTW match plus the
        verified timestamp know which note actually sounded there. Reported as
        "a reed crack on the first note" when it happened on the third or
        fourth. Only rewrites when a note can be identified confidently.
        """
        idx = _note_index_in_measure(measure, tsec)
        name = _ORD_NAMES.get(idx or 0)
        if not name:
            return text
        return re.sub(
            r'\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)'
            r'(\s+(?:\w+\s+){0,2}?(?:note|entry|attack|pitch))\b',
            lambda m: name + m.group(2), text, flags=re.I)

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
        observed = _canonicalize_note_ordinals(observed, m0, time_sec)
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
        # Prefer the note-content match over elapsed time — see measure_from_notes.
        m = measure_from_notes(tsec) or time_to_measure(tsec)
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
            # "wrong_notes_cracks" is two different phenomena sharing one bucket,
            # and they need different corroboration. A squeak is short, unstable
            # and violently high — precisely what the wrong-note detector is
            # built to reject — so gating cracks on it silently deleted them.
            #
            # Which detector to ask used to be decided by substring-matching
            # Gemini's prose for nine keywords. That made a true finding's
            # survival depend on the LLM's word choice: "the tone splinters on
            # the high F" missed every keyword, went to the wrong-note detector,
            # failed there, and was deleted — while "breaks the phrase" matched
            # "break" and sent a genuine wrong note to the crack detector.
            #
            # Confirming against EITHER detector (the previous attempt at this)
            # was too loose in a way that produced false positives: crack
            # evidence says a note was noisy or broke, and says nothing at all
            # about whether the right pitch was played. So "any brief airy note
            # in measure N" confirmed "you played F instead of E in measure N",
            # and the student then read Gemini's unverified prose as fact at
            # confidence 92.
            #
            # A pitch claim needs pitch evidence. Cracks are not lost by this:
            # `find_crack_candidates` emits its own CONFIRMED flag for the same
            # measure further down (section 3b), carrying CREPE's evidence
            # rather than Gemini's guess, and it wins the (measure, type) dedup
            # precisely because it is confirmed.
            conf = m in wrongnote_conf_measures
        elif ftype == "timing":
            conf = m in timing_conf_measures
        elif ftype == "dynamics":
            # Only gate when the score actually carries markings to check
            # against. With no markings we cannot contradict Gemini, so
            # demanding corroboration would delete real observations.
            if isinstance(dynamics_report, dict) and dynamics_report.get("ok"):
                conf = m in dynamics_conf_measures
            else:
                conf = True
        else:
            conf = True                          # Tier A — Gemini authoritative
        _add(m, ftype, desc, tsec, conf, timing=timing_gap_ms.get(m),
             measure_end=m_end, time_end_sec=tsec_end)

    # 2. Intonation — CREPE owns it. One flag per measure with a real deviation.
    # Number these measures with the SAME time->measure mapping used for Gemini flags
    # (from the event's timestamp), so intonation and everything else stay consistent
    # and don't drift apart. The loop is anchored on the event timestamp too.
    # First: is the WHOLE performance sitting off A=440? Per-note cents are now
    # measured relative to the take's own tuning centre, so a uniformly sharp
    # instrument no longer lights up every bar. That offset is still real and
    # worth saying — once, as a tuning matter, not as an embouchure problem in
    # thirty separate measures.
    tuning_center = next((ev["tuning_center"] for ev in aligned
                          if ev.get("tuning_center")), 0.0)
    if abs(tuning_center) >= 10:
        _dir = "sharp" if tuning_center > 0 else "flat"
        _add(measure_lo, "intonation",
             f"the whole take sits about {abs(round(tuning_center))}¢ {_dir} of A=440 — "
             f"the playing is consistent with itself, so this is the instrument's "
             f"tuning rather than your embouchure. Retune to a drone or tuner before "
             f"the next run",
             min((ev.get("time_sec") for ev in aligned
                  if ev.get("time_sec") is not None), default=0.0),
             confirmed=True, is_global=True,
             measure_end=measure_hi, direction=_dir, priority=2)

    # Requiring a DTW match is right when there IS one — it means the note can be
    # named and we know which note was out of tune. But the score read fails
    # often enough to matter, and when it does no event has a match, so that
    # requirement silently deleted intonation entirely: a take that was 34c flat
    # throughout reported nothing. Fall back to judging tuning without naming the
    # note, which is still true and still useful.
    _have_matches = any(ev.get("score_idx") is not None for ev in aligned)

    inton: dict[int, dict] = {}   # measure -> {cents, time, sharp}
    for ev in aligned:
        c = ev.get("cents_offset")
        # Judge intonation only on notes we can actually name and that lasted
        # long enough to HAVE a pitch. A passing sixteenth gives CREPE a handful
        # of frames dominated by the attack transient, and an unmatched event is
        # one we cannot tie to a written note at all — neither is evidence that
        # a specific note was out of tune.
        _held = ev.get("held_sec")
        if _have_matches and ev.get("score_idx") is None:
            continue
        if _held is not None and _held < 0.12:
            continue
        if c is not None and abs(c) >= cents_flag_threshold and ev.get("confidence", 100) >= 50 and ev.get("cents_spread", 0) <= 35:
            t  = ev.get("time_sec")
            # This event IS a note DTW matched to the score, so its own measure
            # is the note-content answer. Preferring the time lookup over it (as
            # this did) threw away the better signal.
            mm = ev.get("measure") or time_to_measure(t)
            if mm is None:
                mm = ev.get("measure")
            if mm is None:
                continue
            d = inton.setdefault(mm, {"cents": 0.0, "time": None, "sharp": False,
                                      "pitch": ""})
            if abs(c) > d["cents"]:
                d["cents"] = abs(c)
                d["sharp"] = c > 0
                d["pitch"] = ev.get("score_pitch") or ""
            if t is not None and (d["time"] is None or t < d["time"]):
                d["time"] = t
    for m, d in inton.items():
        direction = "sharp" if d["sharp"] else "flat"
        _note = d.get("pitch") or ""
        fix_hint = (
            "loosen the embouchure slightly and drop jaw pressure, or open the throat"
            if direction == "sharp" else
            "tighten the embouchure slightly and increase air support"
        )
        _add(m, "intonation",
             (f"the {_note} " if _note else "pitch ")
             + f"sits {round(d['cents'])}¢ {direction} of the rest of your playing "
             f"here — {fix_hint}",
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
                 _t_of(m), confirmed=True, timing=round(ms, 1), priority=2,
                 direction=p["direction"])

        for m, d in timing_report["drift"].items():
            _add(m, "timing",
                 f"this measure runs at about {d['local_bpm']:.0f} BPM against your "
                 f"{d['piece_bpm']:.0f} BPM — {d['pct']}% {d['direction']}; "
                 f"practise it with a metronome at {d['piece_bpm']:.0f}",
                 _t_of(m), confirmed=True, priority=2, direction=d["direction"])

        for m, du in timing_report["durations"].items():
            held  = du["direction"] == "long"
            # Name the value and its beat count. "the half note got 2.6 beats
            # instead of 2" is checkable against the page; "held 1.3x its
            # written length" is not.
            _val  = du.get("value") or "note"
            _bw   = du.get("beats_written")
            _bp   = du.get("beats_played")
            # No rest claim. The old text said "plus the N-beat rest after it",
            # derived from `gap_after_beats` — which is only "distance to the
            # next note we could read", and is equally produced by a note the
            # score reader dropped. In a passage containing no rests at all it
            # asserted one, which is exactly the kind of unfounded specific this
            # product cannot afford. The note's own written value is checkable
            # against the page and needs no such qualifier.
            if _bw and _bp:
                _detail = (f"the {_val} ({du['pitch']}) on beat {du['beat']:g} is written "
                           f"for {_bw:g} beat{'s' if _bw != 1 else ''} but got "
                           f"{_bp:g} — {abs(int(round(du['delta_ms'])))} ms "
                           f"{'too long' if held else 'too short'}")
            else:
                _detail = (f"the {du['pitch']} on beat {du['beat']:g} is "
                           f"{abs(int(round(du['delta_ms'])))} ms "
                           f"{'too long' if held else 'too short'}")
            _add(m, "timing",
                 f"{_detail} — "
                 f"{'release it on the following beat' if held else 'sustain it to its full value'}",
                 du.get("time_sec") or _t_of(m), confirmed=True,
                 timing=round(abs(du["delta_ms"]), 1), priority=2,
                 direction=f"held-{du['direction']}")

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

    # 3b. CREPE-detected cracks/squeaks, same treatment.
    for cand in crack_candidates:
        mm = re.search(r'measure (\d+)', cand)
        if mm:
            _t = re.search(r't=([\d.]+)s', cand)
            _add(int(mm.group(1)), "error", cand,
                 float(_t.group(1)) if _t else None, confirmed=True)

    # 3c. Measured dynamics: the score's markings vs what was actually played.
    if isinstance(dynamics_report, dict) and dynamics_report.get("ok"):
        _con = dynamics_report.get("contrast")
        if _con:
            _ms = _con["measures"]
            _add(min(_ms), "dynamics",
                 f"the {_con['softest']} and {_con['loudest']} passages come out at "
                 f"almost the same volume ({_con['spread_db']} dB apart) — the markings "
                 f"are there but the contrast is not. Play the {_con['softest']} "
                 f"markedly softer and let the {_con['loudest']} open up",
                 _t_of(min(_ms)), confirmed=True, is_global=True,
                 measure_end=max(_ms) if max(_ms) > min(_ms) else None, priority=2)
        for _inv in (dynamics_report.get("inverted") or [])[:2]:
            _ms = _inv["measures"]
            if not _ms:
                continue
            _add(min(_ms), "dynamics",
                 f"the {_inv['quieter_marking']} passage is played "
                 f"{_inv['delta_db']} dB SOFTER than the {_inv['louder_marking']} "
                 f"passage — the two are the wrong way round",
                 _t_of(min(_ms)), confirmed=True,
                 measure_end=max(_ms) if max(_ms) > min(_ms) else None, priority=2)

    # 4. Posture & technique — global visual observations from Gemini.
    # Derive a measure from any timestamp in the text so the flag lands somewhere
    # sensible; posture/technique are whole-performance notes so the exact spot is
    # not critical, but we avoid dumping them all on one measure.
    def _first_ts(text: str) -> float | None:
        mt = re.search(r'(\d+:\d{2})', text)
        return parse_mmss_to_seconds(mt.group(1)) if mt else None
    # Posture and technique are BODY observations, not events: you do not slouch
    # for one measure. Pinning them to a single measure (whatever measure happened
    # to contain a timestamp Gemini mentioned, or measure_lo when it mentioned
    # none) put them on an essentially arbitrary bar — reported as "posture flags
    # are at the wrong measure". They now span the passage they were observed
    # over: an explicit range if Gemini gave one, otherwise the whole take, which
    # is the honest scope for a continuous physical observation.
    _played_lo = _timeline()[0]["measure"] if _timeline() else measure_lo
    _played_hi = _timeline()[-1]["measure"] if _timeline() else measure_hi
    for _cat, _ftype in (("posture_issues", "posture"), ("technique_issues", "technique")):
        for obs in gemini_assessment.get(_cat, []):
            text = str(obs)
            ts_all = [parse_mmss_to_seconds(x) for x in re.findall(r'(\d+:\d{2})', text)]
            ts_all = [t for t in ts_all if t is not None]
            if len(ts_all) >= 2:
                m_lo = time_to_measure(min(ts_all)) or _played_lo
                m_hi = time_to_measure(max(ts_all)) or _played_hi
                t0 = min(ts_all)
            elif len(ts_all) == 1:
                # A single timestamp marks where it was most visible, not its extent.
                m_lo, m_hi, t0 = _played_lo, _played_hi, ts_all[0]
            else:
                m_lo, m_hi, t0 = _played_lo, _played_hi, None
            _add(m_lo, _ftype, text, t0, confirmed=True, is_global=True,
                 measure_end=m_hi if m_hi > m_lo else None)

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

    # ── Merge genuinely CONTINUOUS issues into one multi-measure flag ──────────
    # An issue running through m.24-27 is one problem, not four; reporting it four
    # times buries the fact that it is sustained and makes the student fix it
    # measure by measure. Merge only a strictly consecutive run (m, m+1, m+2...)
    # of the SAME type AND same direction — that is what "continuous" means. An
    # isolated measure, or the same fault recurring with gaps, stays separate:
    # those are genuinely distinct events and collapsing them would hide where
    # they are. Posture/technique are already whole-passage spans and skip this.
    def _merge_key(iss: dict):
        if iss["type"] in ("posture", "technique"):
            return None                      # already spans; never merge further
        if not iss.get("direction"):
            # No direction means we cannot tell whether two adjacent flags are the
            # same continuous fault (Gemini's free-text findings). Never merge
            # those — a wrong merge invents a span that was never observed.
            return None
        return (iss["type"], iss["direction"])

    merged: list[dict] = []
    for iss in deduped_issues:
        k = _merge_key(iss)
        prev = merged[-1] if merged else None
        if (
            k is not None and prev is not None and _merge_key(prev) == k
            and iss["measure"] == (prev.get("measure_end") or prev["measure"]) + 1
        ):
            prev["measure_end"] = iss["measure"]
            prev["_span_n"] = prev.get("_span_n", 1) + 1
            # Keep the strongest magnitude in the run so severity reflects the worst
            # bar, and extend the window so Loop plays the whole passage.
            for fld in ("cents", "timing"):
                if iss.get(fld) is not None and (prev.get(fld) is None or abs(iss[fld]) > abs(prev[fld])):
                    prev[fld] = iss[fld]
            if iss.get("time_end_sec") or iss.get("time_sec"):
                prev["time_end_sec"] = iss.get("time_end_sec") or iss.get("time_sec")
            continue
        merged.append(dict(iss))
    _n_spans = sum(1 for m in merged if m.get("_span_n", 1) > 1)
    if _n_spans:
        print(f"[compare_and_coach_claude] merged {len(deduped_issues) - len(merged)} "
              f"issue(s) into {_n_spans} continuous multi-measure span(s)")
    deduped_issues = merged

    # Cover the whole piece: coach up to 40 distinct issues (was 16). The user wants
    # every played measure examined, so we do not throttle coverage here.
    deduped_issues = deduped_issues[:40]

    # Drop unconfirmed (Tier B, not corroborated by CREPE) issues entirely rather than
    # showing them hedged ("possible hesitation", "may have rushed") — the user doesn't
    # want low-confidence guesses in the report at all, only things we can state as fact.
    #
    # They are recorded before being dropped. The standing plan is to tune the
    # corroboration thresholds once enough takes have accumulated, by querying
    # how often a Tier B finding goes unconfirmed — but that query could never
    # return anything, because this filter deletes every confirmed=False row
    # before it is written anywhere. The rate was unmeasurable by construction.
    # These go to `pipeline_debug`, not to the student.
    _dropped = [iss for iss in deduped_issues if not iss["confirmed"]]
    deduped_issues = [iss for iss in deduped_issues if iss["confirmed"]]
    if _dropped:
        global _LAST_DROPPED_UNCONFIRMED
        _LAST_DROPPED_UNCONFIRMED = [
            {"measure": d.get("measure"), "type": d.get("type"),
             "observed": str(d.get("observed") or "")[:160]}
            for d in _dropped[:12]
        ]
        print(f"[compare_and_coach_claude] dropped {len(_dropped)} unconfirmed "
              f"(hedged) issue(s) — only reporting confirmed findings: "
              f"{[(d.get('measure'), d.get('type')) for d in _dropped[:8]]}")
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
Use ONLY the musical facts given in "observed". Never introduce notation that is not stated there — in particular never mention a rest, a repeat, a key change, a dynamic marking, an articulation or a tempo marking unless that exact word appears in "observed". You are not shown the score and cannot see what is on the page; asserting notation you were not given is the single fastest way to lose a musician's trust.

For "intonation" issues, the title MUST begin with the word "Sharp" or "Flat" (whichever the "observed" text says), followed by 2-5 words naming WHERE it happened — the note, register, or gesture. Examples of the right shape: "Flat on the sustained high notes", "Sharp entering the descending run", "Flat across the slurred leap". NEVER put a number, a cents value, or the words "slightly"/"very" in an intonation title — how far off it is belongs in the body, not the headline. Do not name the measure in the title.
{f'Student note about this take (context only, do not excuse issues): "{user_note}"' if user_note else ''}

ISSUES:
{chr(10).join(issue_lines)}

WRITE TIGHT. The body is 2 sentences, 40 words maximum:
  1. What went wrong, concretely — the note, beat, interval, or cents value from "observed". Name the specific thing, not the category.
  2. What to do about it — one practice instruction the student can act on today.

Cut everything else. Do NOT write "this matters because...", "in a piece like this...", "as a musician you...", or any sentence explaining why the issue is worth caring about — the student already knows. Do not restate the issue type. Do not open with praise or a transition. Every clause must carry information the student did not already have from the title.

Keep all specifics: note names, beats, cents, hand, direction. Concise means fewer words, NOT vaguer — "the F♯ on beat 3 lands early" is right, "some notes are rushed" is wrong.

Return JSON only (no markdown):
{{"coaching": [{{"i": <index>, "title": "<4-8 word title naming the exact issue>", "body": "<2 sentences, 40 words max: what went wrong specifically, then the fix>"}}]}}"""
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
            # Intonation titles say the direction AND what was out of tune, but
            # never how far out — the cents value belongs in the body, not the
            # headline. Take Claude's title only if it obeys both rules, since a
            # title that leads with the wrong direction word is worse than a
            # plain one.
            direction = iss["direction"]
            cand = re.sub(r"\s+", " ", str(coach.get("title") or "")).strip(" .")
            ok = (
                cand.lower().startswith(direction)
                and not re.search(r"\d|¢|cent", cand, re.I)
                and 2 <= len(cand.split()) <= 8
            )
            title = (cand[0].upper() + cand[1:]) if ok else direction.capitalize()
        else:
            title = coach.get("title") or f"{TYPE_LABEL.get(iss['type'], iss['type'].title())} — m.{iss['measure']}"
        body  = coach.get("body") or (
            f"{iss['observed']}. Play it slowly a few times, listening closely, "
            f"before taking it back up to tempo."
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

    # ── HARD INVARIANT: the Loop must play the measure printed on the flag ────
    # Everything above is *supposed* to keep these in step, and has been rewritten
    # several times to do so. This pass makes it impossible to ship a flag that
    # does not, regardless of which upstream path produced the measure number.
    #
    # The Loop window is authoritative, because it is what the user actually
    # hears. So we ask the canonical timeline which measure the window really
    # plays, and if the label disagrees, the LABEL is corrected — never the other
    # way round. Silently relabelling is the right trade: a flag pointing at the
    # bar you can hear is useful, a flag pointing at a bar that never plays is
    # not.
    _relabelled = 0
    for f in flags:
        ts, te = f.get("timestamp_start"), f.get("timestamp_end")
        if ts is None:
            continue
        # Probe just inside the window so a boundary does not resolve to the
        # neighbouring measure.
        probe = ts + min(0.05, max(0.0, (te - ts) * 0.1)) if te and te > ts else ts
        actual = time_to_measure(probe)
        if actual is None:
            continue
        labelled, labelled_end = f["measure"], f.get("measure_end")
        span_ok = (labelled <= actual <= labelled_end) if labelled_end else (actual == labelled)
        if not span_ok:
            print(f"[compare_and_coach_claude] flag labelled m.{labelled}"
                  f"{'-' + str(labelled_end) if labelled_end else ''} but its loop "
                  f"({ts:.2f}-{te:.2f}s) plays m.{actual} — relabelling to match the audio")
            if labelled_end and labelled_end > labelled:
                shift = actual - labelled
                f["measure"], f["measure_end"] = actual, labelled_end + shift
            else:
                f["measure"] = actual
            _relabelled += 1
    if _relabelled:
        print(f"[compare_and_coach_claude] corrected {_relabelled} flag label(s) to "
              f"match what the Loop plays")

    # Keys are assigned AFTER the relabel pass, so a key always names the
    # measure the Loop actually plays — the same measure the teacher saw.
    assign_flag_keys(flags)

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
                res = parse_score_document(sb, start_measure, instrument)
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

        # Time signature: the value the student typed WINS over the vision read.
        # The reader is a probabilistic look at a photo — it returned 2/4 for a
        # page that plainly reads 3/4, and a wrong beats-per-measure corrupts the
        # beat axis, the timeline and every derived measure number. The student is
        # looking at the actual sheet music, so their answer is the better prior.
        # The read is only consulted when no usable value was supplied.
        _user_ts = (time_sig or "").strip()
        detected_ts = score.get("time_signature")
        chosen_ts, ts_source = (None, None)
        _ts_parts = _user_ts.split("/")
        _ts_valid = (len(_ts_parts) == 2
                     and _ts_parts[0].strip().isdigit() and _ts_parts[1].strip().isdigit()
                     and int(_ts_parts[0].strip()) > 0 and int(_ts_parts[1].strip()) > 0)
        if _ts_valid:
            chosen_ts, ts_source = _user_ts, "form"
            if detected_ts and str(detected_ts).replace(" ", "") != _user_ts.replace(" ", ""):
                print(f"[run_full_analysis] score read said time_sig={detected_ts!r} but the "
                      f"form says {_user_ts!r} — using the form")
                debug_steps.append(f"time_sig: form={_user_ts} overrode score read={detected_ts}")
            score["time_signature"] = _user_ts
        elif detected_ts:
            chosen_ts, ts_source = str(detected_ts), "score"
        if chosen_ts:
            try:
                ts_num, ts_denom = map(int, chosen_ts.split("/"))
                is_cpd = ts_num % 3 == 0 and ts_num // 3 >= 2 and ts_denom >= 8
                bpm_int = ts_num // 3 if is_cpd else ts_num
                debug_steps.append(f"bpm_int: {chosen_ts} (from {ts_source}) → bpm_int={bpm_int}")
                print(f"[run_full_analysis] bpm_int={bpm_int} from {ts_source} time_sig={chosen_ts}")
            except Exception:
                pass

        # Measure range: the form bounds the score, not the other way round. A
        # read that hallucinates measures outside what the student says they
        # played must not widen the window DTW aligns against.
        if score.get("measures"):
            _before = len(score["measures"])
            _lo, _hi = start_measure, (end_measure or None)
            score["measures"] = [
                m for m in score["measures"]
                if isinstance(m.get("number"), int)
                and m["number"] >= _lo and (_hi is None or m["number"] <= _hi)
            ] or score["measures"]
            if len(score["measures"]) != _before:
                debug_steps.append(
                    f"score_window: kept {len(score['measures'])}/{_before} measures "
                    f"inside m.{_lo}-{_hi if _hi else 'end'}")
                print(f"[run_full_analysis] score windowed to the form's range "
                      f"m.{_lo}-{_hi}: {len(score['measures'])}/{_before} measures")

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
            # Make the transposition decision readable off the take. Without it,
            # diagnosing "wrong note flags on correct playing" means guessing at
            # whether the B-flat offset was applied.
            if _LAST_TRANSPOSE_DEBUG:
                debug_steps.append(f"transposition: {_LAST_TRANSPOSE_DEBUG}")
            if _LAST_DROPPED_UNCONFIRMED:
                debug_steps.append(
                    "dropped_unconfirmed: " + "; ".join(
                        f"m.{d['measure']} {d['type']}" for d in _LAST_DROPPED_UNCONFIRMED))
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
