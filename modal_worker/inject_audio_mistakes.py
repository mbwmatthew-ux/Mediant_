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

Known artifacts that make injected mistakes acoustically unrealistic
----------------------------------------------------------------------
Inspected directly from the implementation below (not generic caveats):

- "wrong_pitch" splices a pitch-shifted copy of the note's own window
  back into the buffer at the exact same sample indices
  (`samples[start_idx:end_idx] = shifted`), with NO crossfade at either
  boundary. `librosa.effects.pitch_shift` is a phase-vocoder operation;
  it does not guarantee the shifted window's amplitude/phase at sample 0
  or sample -1 matches the unshifted audio immediately outside the
  window. Where those values don't line up, the output has a step
  discontinuity at each edge, which is an audible click/seam, not a
  smooth transition into a differently-pitched note the way a real
  mis-fingered note would sound.

- "deleted_note" hard-zeros the window (`samples[start_idx:end_idx] = 0.0`)
  with no fade-out/fade-in at the edges either. If the signal's value at
  `start_idx` or `end_idx` isn't already near zero (it generally won't
  be, since onset/offset times are note boundaries, not zero-crossings),
  this is also a step discontinuity -- a sharp digital click bracketing
  a dead-silent gap. A real missed/skipped note in a live recording
  still has room tone, reverb tail from the previous note, or bow/breath
  noise; it does not drop to exact digital zero. This mistake type reads
  as "a sample got deleted from the file," not as "a musician skipped a
  note."

- "duplicated_note" copies the window and concatenates it immediately
  after itself (`np.concatenate([samples[:end_idx], window,
  samples[end_idx:]])`) with no crossfade at the splice point either. If
  the window's last sample doesn't equal its own first sample (true for
  a generic waveform, and specifically true for a sine window that
  isn't an exact integer number of periods), the repeat boundary is a
  step discontinuity -- a click where the two copies join. Separately,
  pasting an identical copy of the sustained tone (same envelope, same
  exact phase/timbre throughout) is not what a real repeated note sounds
  like: an actual musician replaying a note produces a fresh attack
  transient (bow re-articulation, tongue stop, re-pluck) and a
  non-identical envelope/intonation on the second instance. This
  produces something closer to an audio-editing "copy-paste" loop than
  a performed repetition.

- Not an issue found here: none of the three paths touch samples outside
  the target note's own `[start_idx, end_idx)` window (or, for
  "duplicated_note", the inserted copy immediately after it) -- so
  mistakes never bleed into or corrupt unrelated, correctly-played
  audio elsewhere in the take.
"""
import numpy as np

SR = 22050  # matches run_pitch_tracking's own resample rate (worker.py:910)

MISTAKE_TYPES = {"wrong_pitch", "deleted_note", "duplicated_note"}


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

    if mistake_type == "deleted_note":
        samples[start_idx:end_idx] = 0.0
        new_note = None

    elif mistake_type == "wrong_pitch":
        import librosa
        semitones = float(rng.choice([-7, -6, -5, -4, -3, -2, 2, 3, 4, 5, 6, 7]))
        window = samples[start_idx:end_idx]
        shifted = librosa.effects.pitch_shift(window, sr=SR, n_steps=semitones)
        # pitch_shift can change length by a few samples -- pad/trim to fit
        # the original window exactly so nothing downstream shifts in time.
        if len(shifted) >= len(window):
            shifted = shifted[:len(window)]
        else:
            shifted = np.pad(shifted, (0, len(window) - len(shifted)))
        samples[start_idx:end_idx] = shifted
        new_note = original_note + int(round(semitones))

    else:  # duplicated_note
        window = samples[start_idx:end_idx]
        samples = np.concatenate([samples[:end_idx], window, samples[end_idx:]])
        new_note = original_note

    return {
        "wav_bytes": _save_wav(samples),
        "injected": {
            "mistake_type": mistake_type,
            "onset_sec": onset_sec, "offset_sec": offset_sec,
            "original_note": original_note, "new_note": new_note,
        },
    }
