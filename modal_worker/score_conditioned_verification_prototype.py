"""
"MEDIANT — Score-Conditioned Audio Verification Feasibility" sprint, Task 2.

Prototypes a wrong-note verifier that works from frame-level CREPE
evidence inside a time window anchored by Parangonar's alignment
(Task 1, `parangonar_alignment_experiment.py`, commit `c34459d`),
instead of requiring a clean discrete CREPE event sequence first. That
requirement is exactly what has failed repeatedly this session: CREPE
over-generates candidate events on dense passages (confirmed dominant
failure on 9/12 pieces under the prior sprint's own diagnostic), and no
amount of DTW/event-matching tuning fixes bad input events. This
prototype never asks "did CREPE emit the right event" — it asks "is
there confident per-frame pitch evidence for the expected note, or for
some specific OTHER note, inside this time window" directly from
torchcrepe's raw (Hz, periodicity) output.

CREPE frame extraction mirrors `worker.run_pitch_tracking`'s own
parameters exactly (16kHz, 40ms hop, model="tiny", batch_size=256,
weighted_argmax decoder, `_instrument_pitch_bounds` for fmin/fmax) so
results are comparable to production — but returns raw frames instead
of clustering them into discrete events. `worker.py` is imported
unchanged; nothing in it is modified.

Hard constraint preserved exactly (from the directive): a note is never
flagged "wrong_note" just because evidence for the EXPECTED pitch is
weak or absent. Weak/absent expected-pitch evidence alone always
returns "unverifiable". A "wrong_note" verdict requires POSITIVE,
sustained (>= MIN_EVIDENCE_SEC), confident evidence for a SPECIFIC
other pitch, and that pitch must not be an octave of the expected one
(octave ambiguity reports "unverifiable", not "wrong_note" — a true
wrong-pitch injection is built 2-7 semitones away, never an octave, by
`inject_audio_mistakes.inject_mistake`, so no real injected case should
ever need this branch, but a real wrong note in production audio
legitimately could be an octave off, and that's a different, separately
interesting failure mode this prototype deliberately declines to call
"wrong").

Evaluation method — reuses existing, already-validated infrastructure,
nothing rebuilt:
  - Alignment: `parangonar_alignment_experiment.py`'s `pa.AudioToScoreMatcher`
    (Task 1), run fresh on whichever audio (unmodified or injected) is
    actually being tested — never on ground truth, so the anchor time
    this verifier uses is exactly what a real production call would see.
  - Mistake injection: `inject_audio_mistakes.inject_mistake_verified`
    (already repaired this session with observability/unambiguity
    gates) — unmodified, not rebuilt.
  - Ground truth + instrument lookup:
    `validate_alignment_against_musicnet.load_rows`/`INSTRUMENT_MAP` and
    `benchmark_full_pipeline.load_ground_truth_with_end_sec` — unmodified,
    not rebuilt.

Test set: the 8 dev pieces where Task 1 measured Parangonar alignment at
92.7-99.2% (2202, 2203, 2217, 2221, 2288, 2293, 2294, 2295) — deliberately
EXCLUDES 2220/2242/2296/2244/2241, where Parangonar's own alignment is
weak or (2241) catastrophically broken, so a detection failure there
would be conflating alignment error with verification error, exactly
the mistake the directive warns against. The frozen 6-piece set
(2204/2218/2222/2297/2244/2289) is also excluded — already opened/
non-blind per this session's own rule.

No production code touched. `worker.py` unaffected. Isolated validation
venv only.

RESULTS (measured 2026-11-01, real MusicNet audio, 8 dev pieces):

Recall (one verified `wrong_pitch` injection attempted per piece, using
the existing `inject_mistake_verified` gate unmodified): only 2 of 8
pieces (2288, 2294) produced ANY injection the existing gate considers
valid (acoustically recognizable + musically unambiguous) within 8
attempts each — the other 6 failed the SAME "not acoustically
recognizable" gate already documented in the P0 sprint's Task 3 (a
known limitation of the pitch-shift injection methodology itself, not a
new finding). Of the 2 valid cases: **2/2 detected (100%)** — a real
improvement over production's already-measured 0/18, but n=2, far too
small to generalize, and drawn from the same small subset the injection
methodology happens to tolerate.

False positives (all score notes, unmodified correct audio, 8 pieces,
7211 total notes): **8/8 pieces had >=1 false "wrong_note" flag** —
WORSE than production's already-measured 9/18 (50%) at the same
piece-level granularity. Note-level false-flag rate: 18.78% (1354/7211)
with a fixed +/-0.2s evidence window.

One decisive diagnostic was run before reporting, not a tuning cycle:
the fixed-window false-positive rate looked attributable to window
bleed into neighboring notes on dense passages (avg inter-note spacing
on these pieces is close to 0.2s) — the same shape of bug as the
chroma/CQT sprint's fixed-frame-resolution regression. Tested the
obvious, principled fix (`note_window`: bound each note's window by
its neighbors' own aligned times, never a fixed radius). **Result: the
false-positive rate got WORSE, not better** — 28.57% (2060/7211) at
the note level, piece-level unchanged at 8/8. This disproves the
neighbor-bleed hypothesis and points to something deeper: CREPE's own
per-frame pitch continuity creates transition-region frames right at
note boundaries (the tracker's smoothing lags across the real attack),
and tightening the window concentrates evidence on exactly those
transition frames while giving the correct pitch fewer frames to reach
MIN_EVIDENCE_SEC — making the problem worse, not better. No window
radius parameter fixes this; it needs either an onset-anchored
exclusion margin (skip the first N ms after a true onset, not just
bound by neighbor time) or a different confidence/continuity signal
entirely — out of scope for this task per "no unbounded architecture
search" / "do not start an uncontrolled sequence of replacements."
Stopped here after one diagnostic, as instructed.

**Conclusion: this frame-level verifier, as prototyped, is NOT a GO.**
It is not confused with an alignment-quality result (Parangonar's own
Task 1 alignment, which this reuses unchanged, remains strong on these
8 pieces) — the false-positive regression is specific to this frame-
level verification logic, not to the alignment anchor it depends on.
The recall signal (2/2) is real but on too small and too biased a
sample to call a win. Both code paths (fixed-radius and neighbor-
bounded) are left in the file as `note_window`/`verify_note` — the
neighbor-bounded version is the one actually exercised by `main()` now,
kept because it is the more defensible design even though it measured
worse on this metric; a future attempt should NOT retry window-sizing
again without first addressing the CREPE-transition-frame issue
directly.

UPDATE (2026-11-04, new owner directive): tested transition-frame
exclusion (`compute_transition_mask`, `TRANSITION_SEMITONE_THRESHOLD`)
instead of window resizing — mechanically different: it excludes
individual FRAMES from evidence based on the frame's OWN local pitch
stability (frame-to-frame semitone jump > 0.75 in one 40ms hop),
independent of window boundaries, rather than changing which frames a
window includes based on neighbor timing. `main()` now runs this
config (fixed window + transition exclusion) by default.

**Confirmed FAIL, per the directive's own stop condition.** Same 8 dev
pieces, 7211 notes (non-oracle, Parangonar-anchored — the condition
that matters for GO/STOP):

    config                              note-level FP
    fixed window, no exclusion (orig)   18.78% (1354/7211)
    neighbor-bound, no exclusion        28.57% (2060/7211)
    fixed window, WITH exclusion (new)  29.87% (2154/7211)  <- WORSE than original

Oracle-timing diagnostic only (not the GO/STOP number) told a different,
partial story: transition exclusion DID help there — 55.30% (no
exclusion) -> 34.25% (with exclusion) — confirming transition frames are
part of why oracle timing was so bad. But the condition that actually
matters (non-oracle) got worse, not better, so this does not change the
verdict.

**Precision** (new metric this round — recall alone hid how bad this
is): full-piece sweep on the 2 original verified injections (2288,
2294), transition-exclusion config: 2288 — 1 true positive / 87 total
flags (1.15%); 2294 — 1 true positive / 321 total flags (0.31%).
**Combined: 2/408 = 0.49% precision.** Recall unchanged at 2/2 (100%) —
the real wrong notes are still caught, just buried in overwhelming
false positives.

No further variant attempted, per "do not automatically try more
variations" — this candidate failed on the metric that matters
(non-oracle FP got worse) and precision is catastrophic regardless.
See `task3_end_to_end_comparison.py` and
`task1_expand_injection_coverage.py` for the rest of this round's work;
`agent_workspace/AUDIO_PIPELINE_AUDIT.md` for the full decision report.
"""
import sys
import csv
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf
import librosa
import torch
import torchcrepe
import partitura as pt
import parangonar as pa

import worker as w
from validate_alignment_against_musicnet import load_rows, INSTRUMENT_MAP
from benchmark_full_pipeline import load_ground_truth_with_end_sec
from inject_audio_mistakes import inject_mistake_verified

DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")

DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]

CREPE_SR = 16000
CREPE_HOP = 640            # 40ms frames — same as worker.run_pitch_tracking
CONF_THRESHOLD = 0.45      # same confidence bar as production's CONF_THRESHOLD
IN_TUNE_CENTS = 50.0       # within a half-semitone counts as "the expected pitch"
MIN_EVIDENCE_SEC = 0.08    # same floor as production's MIN_DUR_SEC quality gate
WINDOW_RADIUS_SEC = 0.20   # +/- window around the alignment-predicted time

# 2026-11-04 owner directive, Task 2: transition-frame exclusion. A frame
# whose pitch jumps more than this many semitones from the IMMEDIATELY
# PRECEDING frame (40ms earlier) is still mid-attack/portamento, not
# settled on a note — exclude it from evidence entirely, regardless of
# which note's window it falls in. This is mechanically different from
# the already-failed `note_window` neighbor-bound fix (2026-11-01): that
# changed which frames a window INCLUDES based on NEIGHBOR TIMING; this
# changes which INCLUDED frames COUNT AS EVIDENCE based on the frame's
# OWN local pitch stability, independent of window boundaries. A fast
# but genuine vibrato/intonation wobble moves far less than one semitone
# in 40ms; a real attack or note-to-note transition moves several
# semitones over 1-2 frames — this threshold targets the latter only.
TRANSITION_SEMITONE_THRESHOLD = 0.75


def crepe_frames(wav_bytes: bytes, instrument: str):
    """Raw per-frame CREPE (Hz, periodicity), same params as
    worker.run_pitch_tracking, returned as frame arrays rather than
    clustered into discrete events."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav_bytes)
        wav_path = f.name
    y, _ = librosa.load(wav_path, sr=CREPE_SR, mono=True)
    audio_tensor = torch.from_numpy(y).unsqueeze(0).float()
    fmin_hz, fmax_hz = w._instrument_pitch_bounds(instrument)
    pitch, periodicity = torchcrepe.predict(
        audio_tensor, CREPE_SR, CREPE_HOP,
        fmin=fmin_hz, fmax=fmax_hz,
        model="tiny", batch_size=256, device="cpu",
        decoder=torchcrepe.decode.weighted_argmax,
        return_periodicity=True, pad=True,
    )
    pitch_np = pitch.squeeze().numpy()
    conf_np = periodicity.squeeze().numpy()
    n = len(pitch_np)
    frame_times = np.arange(n) * (CREPE_HOP / CREPE_SR)
    return frame_times, pitch_np, conf_np


def hz_to_midi(hz: np.ndarray) -> np.ndarray:
    return 69.0 + 12.0 * np.log2(hz / 440.0)


def compute_transition_mask(pitch_np: np.ndarray, conf_np: np.ndarray) -> np.ndarray:
    """
    True at frame i if its pitch moved more than TRANSITION_SEMITONE_THRESHOLD
    semitones from frame i-1 (40ms earlier) -- a plausible proxy for "CREPE's
    tracker is still mid-attack/portamento here, not settled," independent
    of any note's window. Computed once per piece over the FULL frame
    array (not per-note), so it never depends on window boundaries. Both
    sides of a detected jump are marked (the landing point could be
    either side of the hop boundary). Frames with no usable pitch on
    either side of the comparison are never marked by this rule alone --
    the existing `pitch_np > 0` gate already excludes them elsewhere.
    """
    n = len(pitch_np)
    transition = np.zeros(n, dtype=bool)
    voiced = pitch_np > 0
    both_voiced = voiced[:-1] & voiced[1:]
    midi = np.full(n, np.nan)
    midi[voiced] = hz_to_midi(pitch_np[voiced])
    jump = np.zeros(n - 1, dtype=bool)
    jump[both_voiced] = np.abs(midi[1:][both_voiced] - midi[:-1][both_voiced]) > TRANSITION_SEMITONE_THRESHOLD
    transition[:-1] |= jump
    transition[1:] |= jump
    return transition


def note_window(t: float, prev_t: float | None, next_t: float | None,
                 max_radius: float = WINDOW_RADIUS_SEC) -> tuple[float, float]:
    """
    Window bounds for one note's evidence, capped at `max_radius` on each
    side but never crossing into a neighboring note's own aligned time.
    A fixed +/-0.2s radius (first version of this prototype) measured a
    much worse false-positive rate than production (8/8 vs production's
    9/18 pieces) -- on these pieces, average inter-note spacing is close
    to 0.2s on dense passages, so the fixed window routinely captured the
    ADJACENT correct note's own frames and reported them as "confident
    evidence for a different pitch." Same shape of bug as the chroma/CQT
    sprint's fixed-frame-resolution regression on fast pieces. Bounding
    the window by the neighbor's own aligned time removes that bleed
    without being a speculative threshold tune -- it's a correctness fix
    to what "near this note" should mean.
    """
    left = max_radius if prev_t is None else min(max_radius, max(0.0, (t - prev_t) * 0.5))
    right = max_radius if next_t is None else min(max_radius, max(0.0, (next_t - t) * 0.5))
    return t - left, t + right


def verify_note(frame_times, pitch_np, conf_np, expected_midi: float,
                 window_start: float, window_end: float,
                 transition_mask: np.ndarray | None = None) -> dict:
    """
    Score-conditioned frame-level verification for ONE expected note.
    See module docstring for the hard constraint this implements.

    `transition_mask`, if given (see `compute_transition_mask`), excludes
    frames flagged as mid-attack/portamento from evidence entirely --
    orthogonal to the window bounds themselves.
    """
    mask = (
        (frame_times >= window_start)
        & (frame_times <= window_end)
        & (conf_np >= CONF_THRESHOLD)
        & (pitch_np > 0)
    )
    if transition_mask is not None:
        mask = mask & ~transition_mask
    frame_hop_sec = CREPE_HOP / CREPE_SR
    if not mask.any():
        return {"verdict": "unverifiable", "reason": "no confident frames in window",
                "competing_midi": None, "competing_sec": 0.0}

    midis = hz_to_midi(pitch_np[mask])
    confs = conf_np[mask]

    expected_cents = np.abs(midis - expected_midi) * 100.0
    expected_hit = expected_cents <= IN_TUNE_CENTS
    expected_sec = float(expected_hit.sum() * frame_hop_sec)

    if expected_sec >= MIN_EVIDENCE_SEC:
        return {"verdict": "correct",
                "reason": f"{expected_sec:.3f}s confident evidence for expected pitch",
                "competing_midi": None, "competing_sec": expected_sec}

    other_mask = ~expected_hit
    if not other_mask.any():
        return {"verdict": "unverifiable", "reason": "no competing pitch evidence either",
                "competing_midi": None, "competing_sec": 0.0}

    other_midis = midis[other_mask]
    other_confs = confs[other_mask]
    rounded = np.round(other_midis).astype(int)
    weights: dict[int, float] = {}
    for r, c in zip(rounded, other_confs):
        weights[int(r)] = weights.get(int(r), 0.0) + float(c)

    dominant_midi = max(weights, key=weights.get)
    dominant_sec = float((rounded == dominant_midi).sum() * frame_hop_sec)
    is_octave = (abs(dominant_midi - round(expected_midi)) % 12 == 0
                 and dominant_midi != round(expected_midi))

    if is_octave:
        return {"verdict": "unverifiable",
                "reason": f"dominant competing evidence (MIDI {dominant_midi}) is an octave of expected pitch — ambiguous, not flagged",
                "competing_midi": dominant_midi, "competing_sec": dominant_sec}

    if dominant_sec >= MIN_EVIDENCE_SEC:
        return {"verdict": "wrong_note",
                "reason": f"{dominant_sec:.3f}s confident evidence for MIDI {dominant_midi}, not the expected pitch",
                "competing_midi": dominant_midi, "competing_sec": dominant_sec}

    return {"verdict": "unverifiable",
            "reason": "competing evidence too brief/weak to flag",
            "competing_midi": dominant_midi, "competing_sec": dominant_sec}


def _align(matcher, audio: np.ndarray, sr: int, na):
    return matcher(audio.astype(np.float32), na, sample_rate=sr)


def run_false_positive_check(matcher, piece_id: str, instrument: str,
                              use_neighbor_bound: bool = False,
                              use_transition_exclusion: bool = False) -> dict | None:
    """Unmodified, correct audio: any 'wrong_note' verdict here is a false positive."""
    musicxml = SCORES / f"{piece_id}.musicxml"
    wav = DATA / "audio" / f"{piece_id}.wav"
    if not (musicxml.exists() and wav.exists()):
        return None

    audio, sr = sf.read(str(wav))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    score = pt.load_musicxml(str(musicxml))
    na = score.note_array()

    alignment = _align(matcher, audio, sr, na)
    import io
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    frame_times, pitch_np, conf_np = crepe_frames(buf.getvalue(), instrument)
    transition_mask = compute_transition_mask(pitch_np, conf_np) if use_transition_exclusion else None

    times = [e.get("performance_time") for e in alignment]

    false_positives = 0
    unverifiable = 0
    correct = 0
    for i, t in enumerate(times):
        if t is None:
            continue
        prev_t = (times[i - 1] if i > 0 else None) if use_neighbor_bound else None
        next_t = (times[i + 1] if i + 1 < len(times) else None) if use_neighbor_bound else None
        window_start, window_end = note_window(float(t), prev_t, next_t)
        expected_midi = float(na[i]["pitch"])
        v = verify_note(frame_times, pitch_np, conf_np, expected_midi, window_start, window_end,
                         transition_mask=transition_mask)
        if v["verdict"] == "wrong_note":
            false_positives += 1
        elif v["verdict"] == "unverifiable":
            unverifiable += 1
        else:
            correct += 1

    n = len(na)
    return {"piece": piece_id, "n_notes": n, "false_positives": false_positives,
            "unverifiable": unverifiable, "correct": correct}


def run_recall_check(matcher, piece_id: str, instrument: str, score_dict: dict,
                      beats_per_measure: int, injection_seed: int | None = None,
                      use_neighbor_bound: bool = False,
                      use_transition_exclusion: bool = False) -> dict | None:
    """One verified wrong_pitch injection per piece: does the verifier flag it?"""
    musicxml = SCORES / f"{piece_id}.musicxml"
    wav = DATA / "audio" / f"{piece_id}.wav"
    label = DATA / "labels" / f"{piece_id}.csv"
    if not (musicxml.exists() and wav.exists() and label.exists()):
        return None

    ground_truth = load_ground_truth_with_end_sec(label)
    with open(wav, "rb") as f:
        wav_bytes_orig = f.read()

    base_seed = injection_seed if injection_seed is not None else int(piece_id)
    inj = inject_mistake_verified(wav_bytes_orig, ground_truth, score_dict,
                                   beats_per_measure, instrument, base_seed=base_seed)
    if not inj["valid"]:
        return {"piece": piece_id, "valid": False,
                "attempts": len(inj["attempts"]),
                "reasons": [a.get("reason") for a in inj["attempts"]]}

    injected = inj["result"]["injected"]
    injected_wav_bytes = inj["result"]["wav_bytes"]

    import io
    audio, sr = sf.read(io.BytesIO(injected_wav_bytes))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    score = pt.load_musicxml(str(musicxml))
    na = score.note_array()

    alignment = _align(matcher, audio, sr, na)
    frame_times, pitch_np, conf_np = crepe_frames(injected_wav_bytes, instrument)
    transition_mask = compute_transition_mask(pitch_np, conf_np) if use_transition_exclusion else None

    nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - injected["onset_sec"]))
    target_start_beat = nearest["start_beat"]
    idx = int(np.argmin(np.abs(na["onset_beat"] - target_start_beat)))

    times = [e.get("performance_time") for e in alignment]
    t = times[idx]
    if t is None:
        return {"piece": piece_id, "valid": True, "detected": False,
                "reason": "alignment produced no performance_time for the injected note's score index"}

    prev_t = (times[idx - 1] if idx > 0 else None) if use_neighbor_bound else None
    next_t = (times[idx + 1] if idx + 1 < len(times) else None) if use_neighbor_bound else None
    window_start, window_end = note_window(float(t), prev_t, next_t)

    expected_midi = float(na[idx]["pitch"])  # the CORRECT pitch per the score
    v = verify_note(frame_times, pitch_np, conf_np, expected_midi, window_start, window_end,
                     transition_mask=transition_mask)
    detected = v["verdict"] == "wrong_note"
    return {"piece": piece_id, "valid": True, "detected": detected,
            "measure": injected.get("measure"),
            "original_note": injected["original_note"], "new_note": injected["new_note"],
            "verdict": v["verdict"], "reason": v["reason"],
            "competing_midi": v["competing_midi"]}


def main():
    matcher = pa.AudioToScoreMatcher()
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}

    print("=== False-positive check: FIXED window + TRANSITION-FRAME EXCLUSION (new, 2026-11-04) ===")
    fp_results = []
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        r = run_false_positive_check(matcher, pid, instrument,
                                      use_neighbor_bound=False, use_transition_exclusion=True)
        if r is None:
            print(f"{pid}: SKIP (missing file)")
            continue
        fp_results.append(r)
        print(f"{pid} ({instrument}): notes={r['n_notes']} "
              f"false_positives={r['false_positives']} "
              f"unverifiable={r['unverifiable']} correct={r['correct']}")

    pieces_with_fp = sum(1 for r in fp_results if r["false_positives"] > 0)
    total_notes = sum(r["n_notes"] for r in fp_results)
    total_fp = sum(r["false_positives"] for r in fp_results)
    print(f"\nFP summary (fixed window + transition exclusion): {pieces_with_fp}/{len(fp_results)} "
          f"pieces had >=1 false flag; {total_fp}/{total_notes} notes false-flagged "
          f"({100.0 * total_fp / total_notes:.2f}% of all notes) -- compare against the "
          f"already-measured fixed-window-NO-exclusion baseline of 18.78% (1354/7211) "
          f"and neighbor-bound-NO-exclusion of 28.57% (2060/7211), both in this file's docstring.")

    print("\n=== Recall check (one verified wrong_pitch injection per piece) ===")
    recall_results = []
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        if not musicxml.exists():
            continue
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        r = run_recall_check(matcher, pid, instrument, score_dict, beats_per_measure,
                              use_neighbor_bound=False, use_transition_exclusion=True)
        if r is None:
            print(f"{pid}: SKIP (missing file)")
            continue
        recall_results.append(r)
        if not r["valid"]:
            print(f"{pid}: no valid injection found in {r['attempts']} attempts "
                  f"({r['reasons']})")
        else:
            print(f"{pid}: original={r.get('original_note')} new={r.get('new_note')} "
                  f"verdict={r.get('verdict')} detected={r.get('detected')} "
                  f"({r.get('reason')})")

    valid_cases = [r for r in recall_results if r["valid"]]
    detected = sum(1 for r in valid_cases if r.get("detected"))
    print(f"\nRecall summary: {detected}/{len(valid_cases)} verified wrong_pitch "
          f"injections detected (of {len(recall_results)} dev pieces attempted)")


if __name__ == "__main__":
    main()
