"""
Synthetic mistake injection for the audio-pipeline benchmark (Task 2 of
docs/superpowers/plans/2026-10-30-audio-pipeline-benchmark.md).

Why synthetic injection rather than real documented mistakes: real
teacher-annotated takes don't exist (agent_workspace/ACCURACY_BASELINE.md
-- zero annotations on 199 real takes, no service-role access to harvest
them even if they did), and no corpus of musicians playing DELIBERATE,
LABELED mistakes exists either. A real, correct MusicNet recording plus a
precisely known, programmatically-applied perturbation gives 100% certain
ground truth for exactly what changed and where -- the perturbation IS
the label, not an estimate of one.

Pure local signal processing. No network calls, no paid APIs, no GPU.

---

Crossfading (added for Task 4A, docs/superpowers/plans/2026-10-30-audio-
pipeline-benchmark.md): every boundary identified below as a step
discontinuity now gets a short (CROSSFADE_SEC, default 10ms) linear
blend instead of a hard splice. This is a SMALL fade confined to the
very edges of each affected window -- the vast majority of each
mistake's duration is untouched, so the intended ground truth (a
different pitch, silence, or a repeated note) is still clearly present
for the large majority of its `[onset_sec, offset_sec)` window; only the
first/last `CROSSFADE_SEC` seconds taper into/out of it. Verified via `measure_injection_boundary_artifacts.py`,
re-run after this change: `deleted_note` offset_jump and `duplicated_note`
splice_jump both now measure exactly 0.0000 (0.0x) -- the discontinuities
this module's own code introduced are gone. The two remaining nonzero
numbers (onset_jump=0.2843/7.1x for all three types; wrong_pitch's
offset_jump=0.1611/4.0x) are the measurement fixture's OWN inherent
tone-to-tone boundary (it concatenates three different-frequency/phase
tones with no crossfade of its own) -- present even with NO mistake
injected at all, confirmed by construction: the crossfade anchors each
window's edge to exactly match the ORIGINAL audio at that same position,
so what's left is whatever discontinuity already existed there before any
mistake was applied, not an artifact of the injection.

Known artifacts that made injected mistakes acoustically unrealistic
(historical; now reduced by the crossfade above, not eliminated as a
fundamentally different kind of audio -- see "Residual limitations"
below for what crossfading does NOT fix)
----------------------------------------------------------------------
Original measurement, before crossfading (deterministic synthetic
fixture: three concatenated tones at different frequencies/phases
chosen so no boundary coincides with a zero-crossing), against that
fixture's typical in-tone sample-to-sample delta of 0.0399: wrong_pitch
onset 0.2067 (5.2x), wrong_pitch offset 0.4189 (10.5x), deleted_note
onset 0.1074 (2.7x), deleted_note offset 0.4958 (12.4x), duplicated_note
splice 0.0569 (1.4x) -- all boundaries landed above the fixture's
typical in-tone delta, confirming no crossfade was applied at that time.

- "wrong_pitch" splices a pitch-shifted copy of the note's own window
  back into the buffer at the exact same sample indices. Without a
  crossfade, `librosa.effects.pitch_shift`'s phase-vocoder output at the
  window's first/last sample generally does not match the unshifted
  audio immediately outside the window, producing a step discontinuity
  at each edge -- an audible click/seam, not a smooth transition into a
  differently-pitched note the way a real mis-fingered note would sound.
  Now crossfaded: the shifted window's own first/last CROSSFADE_SEC
  blend FROM the original (correct-pitch) audio at that same position,
  so the transition in and out of the wrong pitch is smooth; the wrong
  pitch is still clearly audible for the large majority of the window.

- "deleted_note" hard-zeroed the window with no fade-out/fade-in at the
  edges, which (since onset/offset times are note boundaries, not
  zero-crossings) was also a step discontinuity -- a sharp digital click
  bracketing a dead-silent gap, reading as "a sample got deleted from
  the file," not "a musician skipped a note." Now crossfaded: the first
  CROSSFADE_SEC ramps from the original note's own start down to zero,
  and the last CROSSFADE_SEC ramps from zero back up to the value the
  resumed (unmodified) audio immediately after the window actually
  starts at -- so both edges are smooth. The middle of the window is
  still true digital silence; only a short fade at each end changed.

- "duplicated_note" copies the window and concatenates it immediately
  after itself. The ONLY discontinuity this introduces is at the single
  splice point where the first (natural) playing of the note ends and
  the inserted second copy begins (window[0], i.e. the note's own
  onset value) -- the point where the second copy's end rejoins the
  original timeline was already continuous before duplication (it's
  literally the original, untouched samples immediately after the
  window). Now crossfaded: a CROSSFADE_SEC blend at that one splice
  point, between the end of the first playing and the start of the
  second. Separately, pasting an identical copy of the sustained tone
  (same envelope, same exact phase/timbre throughout) is still not what
  a real repeated note sounds like -- see "Residual limitations" below;
  crossfading the splice point does not add a fresh attack transient.

- Not an issue found here: none of the three paths touch samples outside
  the target note's own `[start_idx, end_idx)` window (or, for
  "duplicated_note", the inserted copy immediately after it) -- so
  mistakes never bleed into or corrupt unrelated, correctly-played
  audio elsewhere in the take. The crossfades above are entirely
  internal to that same window; they do not extend this boundary.

Residual limitations (crossfading does NOT fix these -- still present)
----------------------------------------------------------------------
- "duplicated_note" still pastes an EXACT copy of the first playing
  (identical envelope, phase, and intonation) rather than synthesizing a
  fresh, independently-articulated second performance of the same note.
  A real musician re-playing a note has a new attack transient and
  small intonation/timing differences the second time; this still
  doesn't. Crossfading only removes the click at the join -- it doesn't
  change that the two copies are identical audio.
- "wrong_pitch"'s `librosa.effects.pitch_shift` output, even with clean
  edges, is a phase-vocoder reconstruction -- it can still sound subtly
  processed/robotic compared to a real mis-fingered note played on the
  actual instrument, especially on fast vibrato passages.
- "deleted_note"'s silence is still TRUE digital zero (not room tone,
  reverb tail, or ambient noise) for the bulk of the window -- a real
  skipped note in a live recording is rarely dead silent. Only the
  immediate edges now fade gracefully; the body of the gap is unchanged.
"""
import numpy as np

SR = 22050  # matches run_pitch_tracking's own resample rate (worker.py:910)

MISTAKE_TYPES = {"wrong_pitch", "deleted_note", "duplicated_note"}

CROSSFADE_SEC = 0.01  # 10ms linear blend at each boundary identified above


def _load_wav(wav_bytes: bytes) -> np.ndarray:
    import soundfile as sf
    import io
    samples, sr = sf.read(io.BytesIO(wav_bytes))
    if sr != SR:
        import librosa
        samples = librosa.resample(samples.astype(np.float64), orig_sr=sr, target_sr=SR)
    return samples.astype(np.float64)


def _save_wav(samples: np.ndarray) -> bytes:
    import soundfile as sf
    import io
    buf = io.BytesIO()
    sf.write(buf, samples, SR, format="WAV")
    return buf.getvalue()


def inject_mistake(wav_bytes: bytes, ground_truth_notes: list[dict],
                    mistake_type: str, rng_seed: int) -> dict:
    """
    Picks one ground-truth note (deterministically, via rng_seed) and
    applies `mistake_type` to it:
      - "wrong_pitch": pitch-shifts that note's audio window by a random
        interval in [-7, -2] or [2, 7] semitones (never 0, never an
        octave -- an octave error is its own distinct, separately
        interesting failure mode this tool does not produce).
      - "deleted_note": silences that note's audio window entirely.
      - "duplicated_note": inserts a second copy of that note's window
        immediately after itself (shifting all later audio later).

    `ground_truth_notes` entries need "onset_sec", "end_sec", "note"
    (MIDI pitch), "start_beat" -- same shape validate_alignment_against_
    musicnet.load_ground_truth produces, plus "end_sec" (that loader
    doesn't read it; the raw MusicNet CSV has an end_time column at the
    same sample-index-at-44100Hz convention as start_time).

    `wav_bytes` and `ground_truth_notes` (and the dicts inside it) are
    never mutated -- the caller's inputs are read-only to this function,
    so the same `wav_bytes` object can be reused afterward as an
    untouched "control" recording.

    `injected["onset_sec"]`/`injected["offset_sec"]` always describe the
    target note's own window on the ORIGINAL, pre-mistake time axis --
    even for "duplicated_note", which shifts everything after the
    inserted copy later in time. These two fields are computed once from
    the original ground truth before any audio is modified and are
    never adjusted afterward.

    Returns {"wav_bytes": bytes, "injected": {...}} -- see this module's
    test file for the exact "injected" shape per mistake_type.
    """
    if mistake_type not in MISTAKE_TYPES:
        raise ValueError(f"mistake_type must be one of {MISTAKE_TYPES}, got {mistake_type!r}")

    rng = np.random.default_rng(rng_seed)
    target = ground_truth_notes[int(rng.integers(0, len(ground_truth_notes)))]
    onset_sec, offset_sec = float(target["onset_sec"]), float(target["end_sec"])
    original_note = int(target["note"])

    samples = _load_wav(wav_bytes)
    start_idx, end_idx = int(onset_sec * SR), int(offset_sec * SR)
    start_idx, end_idx = max(0, start_idx), min(len(samples), end_idx)

    fade_len = min(int(CROSSFADE_SEC * SR), (end_idx - start_idx) // 2)

    if mistake_type == "deleted_note":
        window = samples[start_idx:end_idx].copy()
        new_window = np.zeros_like(window)
        if fade_len > 0:
            # Fade OUT from the real, original note into silence over the
            # window's first fade_len samples.
            ramp_out = np.linspace(1.0, 0.0, fade_len)
            new_window[:fade_len] = window[:fade_len] * ramp_out
            # Fade IN from silence back up to whatever value the resumed,
            # unmodified audio right after the window actually starts at --
            # entirely within the window, so nothing outside [start_idx,
            # end_idx) is touched.
            resume_value = samples[end_idx] if end_idx < len(samples) else 0.0
            ramp_in = np.linspace(0.0, 1.0, fade_len)
            new_window[-fade_len:] = resume_value * ramp_in
        samples[start_idx:end_idx] = new_window
        new_note = None

    elif mistake_type == "wrong_pitch":
        import librosa
        semitones = float(rng.choice([-7, -6, -5, -4, -3, -2, 2, 3, 4, 5, 6, 7]))
        window = samples[start_idx:end_idx].copy()
        shifted = librosa.effects.pitch_shift(window, sr=SR, n_steps=semitones)
        # pitch_shift can change length by a few samples -- pad/trim to fit
        # the original window exactly so nothing downstream shifts in time.
        if len(shifted) >= len(window):
            shifted = shifted[:len(window)]
        else:
            shifted = np.pad(shifted, (0, len(window) - len(shifted)))
        if fade_len > 0:
            # Blend the shifted window's own edges FROM the original
            # (correct-pitch) audio at that same position, so entry/exit
            # are smooth. The wrong pitch is still clearly audible for
            # the large majority of the window (everything outside these
            # two short fades).
            ramp_in = np.linspace(0.0, 1.0, fade_len)
            shifted[:fade_len] = window[:fade_len] * (1 - ramp_in) + shifted[:fade_len] * ramp_in
            ramp_out = np.linspace(1.0, 0.0, fade_len)
            shifted[-fade_len:] = window[-fade_len:] * (1 - ramp_out) + shifted[-fade_len:] * ramp_out
        samples[start_idx:end_idx] = shifted
        new_note = original_note + int(round(semitones))

    else:  # duplicated_note
        window = samples[start_idx:end_idx].copy()
        inserted = window.copy()
        if fade_len > 0:
            # The only discontinuity duplication introduces is at this one
            # splice point: the end of the first (natural) playing meets
            # the inserted copy's own onset value. Anchor the inserted
            # copy's very first sample to match the single sample it now
            # sits next to (samples[end_idx - 1], the last sample of the
            # first playing), then ramp back to the copy's own natural
            # values over fade_len samples -- a sliding window of the
            # original tail would anchor to the WRONG point (fade_len
            # samples before the splice, not the splice itself).
            anchor = samples[end_idx - 1]
            ramp_in = np.linspace(0.0, 1.0, fade_len)
            inserted[:fade_len] = anchor * (1 - ramp_in) + inserted[:fade_len] * ramp_in
        samples = np.concatenate([samples[:end_idx], inserted, samples[end_idx:]])
        new_note = original_note

    return {
        "wav_bytes": _save_wav(samples),
        "injected": {
            "mistake_type": mistake_type,
            "onset_sec": onset_sec, "offset_sec": offset_sec,
            "original_note": original_note, "new_note": new_note,
        },
    }
