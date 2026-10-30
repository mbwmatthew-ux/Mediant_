# Audio-Analysis Pipeline Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a controlled benchmark that injects known, documented pitch/rhythm mistakes into real audio+score pairs and runs them through the full production pipeline (CREPE → DTW → Gemini → Claude), attributing every wrong final flag to the specific stage that caused it.

**Architecture:** Three already-existing, already-run validation harnesses (score-reading, CREPE pitch detection, DTW alignment) cover three of the four failure categories with real measured numbers — this plan documents those rather than re-deriving them, then adds the one missing piece: a synthetic mistake-injection tool (free, local, deterministic) paired with a chained end-to-end scorer that is the first thing in this codebase to measure whether Gemini + Claude's final flags are actually correct against ground truth.

**Tech Stack:** Python, numpy/scipy/soundfile/librosa (already pinned in the shared validation venv), music21 (score parsing, already used), the real `worker.py` functions unmodified (`run_pitch_tracking`, `dtw_align_to_score`, `evaluate_with_gemini`, `compare_and_coach_claude`).

**Spec:** `docs/superpowers/specs/2026-10-30-audio-pipeline-benchmark.md`

## Global Constraints

- Do not modify `worker.py` or any other production code during this plan — every task here adds new, isolated validation tooling (same category as `replay.py`, `validate_pitch_against_tinysol.py`, `validate_alignment_against_musicnet.py`), never touches the dispatch path.
- Do not deploy, spend paid API credits, or initiate GPU compute without explicit owner authorization. Tasks 1-2 are entirely free (local CPU, no network calls beyond reading already-cached MusicNet files). Task 3's Gemini/Claude leg and Task 4 are **APPROVAL-GATED** — see each task's gate.
- Never modify MusicNet's own ground-truth labels. All injected mistakes are NEW synthetic audio/score pairs this plan creates; the original corpus stays untouched on disk.
- Split by piece, not by excerpt: a piece used for the clean (no-injection) baseline is never also used for an injected-mistake case, and vice versa — avoids the model learning to expect a mistake just because it's seen that piece before (per spec rule 8).
- Record exact model/version strings, prompts, and config for every paid call this plan's Task 3/4 eventually make (per spec rule 9) — scaffolded into the runner's output schema now, even though no paid call happens in this plan.
- Reuse existing infrastructure: `validate_alignment_against_musicnet.py`'s `load_ground_truth`/`midi_score_to_dict`/MusicNet file layout, `score_detailed_metrics.py`'s `align_measure` (Levenshtein note scoring), `worker.py`'s real pipeline functions — never reimplement any of these.

---

## Audit Findings (Phase 1 of the spec's "read-only audit" — completed; nothing below needs re-running)

This section is the deliverable for the spec's "begin with a read-only audit." It compiles what's **already measured**, so Task 1 below is a transcription/documentation task, not new research.

### The four failure categories, and what already has a real number

**1. Score-reading failures (Claude vision transcribing a photographed/PDF score into notes)**
Real, measured this session on piece 2243 (12/8 Violin): 0/20 exact-measure accuracy, but 30.7% pitch accuracy / 21.6% rhythm accuracy at note level (`modal_worker/score_detailed_metrics.py`, scored from `modal_worker/probe_result_2243.json`). A real bug (compound-meter beat convention) was found and fixed (commit `0b7889d`, deployed). Separate, ongoing investigation — out of scope for THIS plan, which is audio-side only. See `agent_workspace/AGENT_TASKS.md`'s "Track A" entry.

**2. Audio-transcription failures (CREPE pitch detection, in isolation from any score)**
Already measured and fixed. `modal_worker/validate_pitch_against_tinysol.py` ran the real `run_pitch_tracking` against TinySOL (Cella et al. 2020, CC-BY 4.0) — 2,224 real isolated, individually-labeled notes across 13 orchestral instruments. Round 1 (before fix): 60.7% correct, 37.0% missed, concentrated in quiet (pp) dynamics and specifically Violin/Viola. Root cause: the breath-noise gate used an absolute amplitude threshold instead of a per-take-relative one (see Obsidian `Fixes/Fix — Breath-noise gate was an absolute amplitude threshold.md`). After the fix: **95.6% correct overall, pp 96.2%, Violin 94.7%, Viola 96.8%, precision-when-detected 96.4% (unchanged — this was always a recall problem, never a wrong-pitch problem).**
Real, open gap this corpus explicitly cannot cover: TinySOL's notes are isolated, not played against a score — it validates pitch detection, not alignment (next section), and it has no corpus for the false-positive side of the breath-noise gate (admitting real noise as a note).

**3. Alignment failures (DTW matching a detected audio event to the right score measure)**
Already measured and substantially improved, with a documented, explicit "stop tuning" decision on what's left. `modal_worker/validate_alignment_against_musicnet.py` runs the real `run_pitch_tracking` + `dtw_align_to_score` against MusicNet (Zenodo doi:10.5281/zenodo.5120004) — 20 scored solo Violin/Cello/Flute Bach pieces (4 of 24 excluded by `calibrate_assumptions()`'s own sanity check), 22,095 note-events. Original baseline: 46.7% correct, sharply bimodal (83-95% on 8 pieces, 0-3% on 9 pieces). Root cause, confirmed via detected/true event-count ratio: catastrophic failures are slow/legato passages where CREPE's onset detector fires spurious extra onsets within one sustained note (vibrato, bow noise), breaking the pitch-only DTW cost function's warping path. Three shipped fixes since (rest-anchored segmentation, within-segment pitch-jump detection, local-outlier rejection) moved the real 20-piece number **46.7% → 55.7% → 63.7% → 65.4%** (current, as of 2026-10-22). Five further tuning attempts on the remaining over-counting pieces (2220, 2241, 2296, 2204, parts of 2242) were each tried and reverted — a 2026-10-15 decision in `agent_workspace/AGENT_TASKS.md` explicitly says **stop tuning this mechanism; the remaining gap needs either a new idea or a real VAD/onset model, not another threshold variant.** Owner's target is 80%+ on most/all pieces — not yet reached, and not this plan's job to chase further (see Task 3's scope note).

**4. Final feedback-generation failures (Gemini's `evaluate_with_gemini` authoring flags from audio+video+score; Claude's `compare_and_coach_claude` fusing those with CREPE/DTW evidence into the student-facing flags)**
**No existing harness measures this against ground truth at all.** `modal_worker/score_against_annotations.py` computes precision/recall from real teacher annotations, but `agent_workspace/ACCURACY_BASELINE.md` confirms zero teacher annotations exist on any of 199 real production takes, and this environment has no service-role DB access to harvest them even if they existed — that path is fully blocked, independent of this plan. This is the real, unaddressed gap, and the one new thing this plan builds toward.

### Execution-path diagram (score → audio → flags)

```
photo/PDF score ──> read_score_notes_claude (3x Claude vision + Audiveris + resolution)
                     -> score {"measures": [...], "time_signature": ...}
                     (score-reading: see category 1 above, separate plan)
recording (wav) ──> run_pitch_tracking(wav_bytes, guide_times, instrument)
                     -> events: [{"pitches": [...], "time_sec": ..., ...}, ...]
                     (category 2 above)
events + score ───> dtw_align_to_score(events, score, start_measure, beats_per_measure, end_measure)
                     -> aligned: [{..., "measure": N, "time_sec": ...}, ...]
                     (category 3 above; flatten_score_notes supplies DTW's score_seq)
video/audio + score ─> evaluate_with_gemini(file_uri, mime_type, instrument, ..., score_pages=[...])
                     -> gemini_assessment: {"intonation_issues": [...], "rhythm_issues": [...], ...}
                     (category 4, Gemini half)
aligned + gemini_assessment + score ─> compare_and_coach_claude(score, aligned, alignment_ranges,
                     tempo, ..., gemini_assessment, anthropic_api_key, ...)
                     -> list[dict] flags (final, student-facing)
                     (category 4, Claude fusion half; unresolved score measures are suppressed
                     here via NON_SCORE_DEPENDENT_TYPES, not dropped from DTW's input)
```

Confirmed directly in `modal_worker/worker.py`: `run_pitch_tracking` (:884), `dtw_align_to_score` (:2289), `flatten_score_notes` (:1899), `evaluate_with_gemini` (:3669), `compare_and_coach_claude` (:8121, unresolved-measure suppression at :8143-8154).

### What this plan will NOT re-attempt

Per the "stop tuning" decision above, this plan does not propose a sixth variant of the rest-anchor/pitch-jump DTW tuning mechanism. If Task 3's new benchmark reproduces the same bimodal, event-count-ratio-correlated failure on its injected cases, that confirms the existing root cause rather than discovering a new one — report it as confirmation, not as license to start tuning thresholds again.

---

## Task 1: Write up the audit as a committed reference doc

**Files:**
- Create: `agent_workspace/AUDIO_PIPELINE_AUDIT.md`

**Interfaces:**
- Produces: a single reference doc other tasks' reports link to instead of re-explaining the pipeline. No code interface.

- [ ] **Step 1: Write the doc**

Create `agent_workspace/AUDIO_PIPELINE_AUDIT.md` with exactly the three sections above ("The four failure categories...", "Execution-path diagram...", "What this plan will NOT re-attempt"), lightly reformatted as a standalone doc with a one-line header:

```markdown
# Audio Pipeline Audit — Baseline (2026-10-30)

Read-only audit for docs/superpowers/plans/2026-10-30-audio-pipeline-benchmark.md.
Compiles already-measured results; nothing here was re-run.

[... the three sections, verbatim ...]
```

- [ ] **Step 2: Cross-link from AGENT_TASKS.md**

Add one line under the existing "Track A" entry in `agent_workspace/AGENT_TASKS.md`'s "In Progress" section:

```markdown
- [ ] **Track B: audio-pipeline benchmark (score-reading-agnostic).** Read-only
  audit done, plan at `docs/superpowers/plans/2026-10-30-audio-pipeline-benchmark.md`,
  findings at `agent_workspace/AUDIO_PIPELINE_AUDIT.md`. Not yet started executing.
```

- [ ] **Step 3: Commit**

```bash
git add agent_workspace/AUDIO_PIPELINE_AUDIT.md agent_workspace/AGENT_TASKS.md
git commit -m "docs(validation): audit existing audio-pipeline accuracy results before building the mistake-injection benchmark"
```

No test to run — this is a documentation-only task.

---

## Task 2: Synthetic mistake-injection tool

**Files:**
- Create: `modal_worker/inject_audio_mistakes.py`
- Test: `modal_worker/test_inject_audio_mistakes.py`

**Interfaces:**
- Consumes: MusicNet's on-disk layout exactly as `validate_alignment_against_musicnet.py` expects it (`--data-dir` containing `midis/{id}.mid`, `audio/{id}.wav`, `labels/{id}.csv`), and reuses `validate_alignment_against_musicnet.midi_score_to_dict(midi_path) -> dict` (the `{"measures": [...]}` shape) unchanged.
- Produces: `inject_mistake(wav_bytes: bytes, ground_truth_notes: list[dict], mistake_type: str, rng_seed: int) -> dict` returning `{"wav_bytes": bytes, "injected": {"mistake_type": str, "onset_sec": float, "offset_sec": float, "original_note": int, "new_note": int | None}}`. Later tasks read `injected` as ground truth for what SHOULD be flagged — never read back from the audio itself.

This tool is pure local signal processing (numpy + soundfile) — no network calls, no paid APIs, no GPU. It operates on REAL MusicNet audio/labels already cached at `/tmp/musicnet_data/` from the existing alignment-validation session (see `agent_workspace/AUDIO_PIPELINE_AUDIT.md`); if that cache is gone, re-downloading is the same free, slow (~8h) process already documented in Obsidian `Sessions/2026-10-11 (2) — MusicNet score-alignment validation.md` — not a new cost, just the same one-time step.

- [ ] **Step 1: Write the failing tests**

```python
# modal_worker/test_inject_audio_mistakes.py
import numpy as np
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from inject_audio_mistakes import inject_mistake, SR


def _sine_wav(freq_hz: float, duration_sec: float) -> np.ndarray:
    t = np.linspace(0, duration_sec, int(SR * duration_sec), endpoint=False)
    return 0.5 * np.sin(2 * np.pi * freq_hz * t)


def _wav_bytes(samples: np.ndarray) -> bytes:
    import soundfile as sf
    import io
    buf = io.BytesIO()
    sf.write(buf, samples, SR, format="WAV")
    return buf.getvalue()


def test_wrong_pitch_shifts_only_the_target_note():
    # A4 (MIDI 69, 440Hz) held for 3 seconds, silence before/after.
    samples = np.concatenate([np.zeros(SR), _sine_wav(440.0, 3.0), np.zeros(SR)])
    wav_bytes = _wav_bytes(samples)
    ground_truth = [{"onset_sec": 1.0, "end_sec": 4.0, "note": 69, "start_beat": 1.0}]

    result = inject_mistake(wav_bytes, ground_truth, "wrong_pitch", rng_seed=0)

    assert result["injected"]["mistake_type"] == "wrong_pitch"
    assert result["injected"]["original_note"] == 69
    assert result["injected"]["new_note"] != 69
    assert result["injected"]["onset_sec"] == 1.0
    assert result["injected"]["offset_sec"] == 4.0
    assert isinstance(result["wav_bytes"], bytes) and len(result["wav_bytes"]) > 0


def test_deleted_note_silences_the_target_window():
    samples = np.concatenate([np.zeros(SR), _sine_wav(440.0, 2.0), np.zeros(SR)])
    wav_bytes = _wav_bytes(samples)
    ground_truth = [{"onset_sec": 1.0, "end_sec": 3.0, "note": 69, "start_beat": 1.0}]

    result = inject_mistake(wav_bytes, ground_truth, "deleted_note", rng_seed=0)

    import soundfile as sf
    import io
    out, sr = sf.read(io.BytesIO(result["wav_bytes"]))
    window = out[int(1.0 * sr):int(3.0 * sr)]
    assert np.sqrt(np.mean(window ** 2)) < 0.01  # near-silent where the note was
    assert result["injected"] == {
        "mistake_type": "deleted_note", "onset_sec": 1.0, "offset_sec": 3.0,
        "original_note": 69, "new_note": None,
    }


def test_duplicated_note_repeats_the_target_window():
    samples = np.concatenate([np.zeros(SR), _sine_wav(440.0, 1.0), np.zeros(SR * 2)])
    wav_bytes = _wav_bytes(samples)
    ground_truth = [{"onset_sec": 1.0, "end_sec": 2.0, "note": 69, "start_beat": 1.0}]

    result = inject_mistake(wav_bytes, ground_truth, "duplicated_note", rng_seed=0)

    import soundfile as sf
    import io
    out, sr = sf.read(io.BytesIO(result["wav_bytes"]))
    # Duplicating a 1s note inserts 1s of extra audio -- total length grows.
    assert len(out) / sr > len(samples) / SR
    assert result["injected"]["mistake_type"] == "duplicated_note"
    assert result["injected"]["new_note"] == 69  # same pitch, extra occurrence


def test_unknown_mistake_type_raises():
    import pytest
    samples = _sine_wav(440.0, 1.0)
    wav_bytes = _wav_bytes(samples)
    ground_truth = [{"onset_sec": 0.0, "end_sec": 1.0, "note": 69, "start_beat": 1.0}]
    with pytest.raises(ValueError, match="mistake_type"):
        inject_mistake(wav_bytes, ground_truth, "not_a_real_type", rng_seed=0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate && cd modal_worker && python3 -m pytest test_inject_audio_mistakes.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'inject_audio_mistakes'`

- [ ] **Step 3: Implement**

```python
# modal_worker/inject_audio_mistakes.py
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate && cd modal_worker && python3 -m pytest test_inject_audio_mistakes.py -v`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add modal_worker/inject_audio_mistakes.py modal_worker/test_inject_audio_mistakes.py
git commit -m "feat(validation): add synthetic audio mistake-injection tool for the pipeline benchmark"
```

---

## Task 3: Chained benchmark runner — free legs (CREPE + DTW) now, paid legs (Gemini + Claude) gated

**Files:**
- Create: `modal_worker/benchmark_full_pipeline.py`
- Test: `modal_worker/test_benchmark_full_pipeline.py`

**Interfaces:**
- Consumes: `inject_audio_mistakes.inject_mistake` (Task 2), `validate_alignment_against_musicnet.midi_score_to_dict`/`load_ground_truth` (existing), `worker.run_pitch_tracking`/`worker.dtw_align_to_score` (existing, unmodified), `score_detailed_metrics.align_measure` (existing, for the measure-localization comparison).
- Produces: `run_free_legs(piece_id, data_dir, mistake_type, rng_seed) -> dict` with keys `{"piece_id", "mistake_type", "injected", "detected_at_measure", "true_measure", "localization_correct", "cost_dollars": 0.0}`. This is what Task 4's paid leg will consume as input (same `piece_id`/`mistake_type`/`injected` identifying one benchmark case) once that's separately approved.

This task builds and runs ONLY the free half of the chain (`run_pitch_tracking` + `dtw_align_to_score`, both pure local CPU/GPU-optional compute already covered by category 2/3's existing validation) against the Task 2 injection tool's output, to confirm the injected mistake is even detectable/localizable BEFORE spending anything on Gemini/Claude. If CREPE+DTW can't even see the injected note at the right measure, there's no point paying for Gemini+Claude to evaluate a case the earlier stages already broke.

- [ ] **Step 1: Write the failing test**

```python
# modal_worker/test_benchmark_full_pipeline.py
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from benchmark_full_pipeline import run_free_legs


def test_run_free_legs_reports_localization_against_injected_ground_truth():
    fake_score = {"measures": [{"number": 1, "notes": []}, {"number": 2, "notes": []}]}
    fake_ground_truth = [
        {"onset_sec": 1.0, "end_sec": 2.0, "note": 69, "start_beat": 1.0},
        {"onset_sec": 3.0, "end_sec": 4.0, "note": 72, "start_beat": 1.0},
    ]
    fake_injection = {
        "wav_bytes": b"fake-wav-bytes",
        "injected": {"mistake_type": "wrong_pitch", "onset_sec": 1.0,
                     "offset_sec": 2.0, "original_note": 69, "new_note": 74},
    }
    fake_events = [{"pitches": ["D5"], "time_sec": 1.1}]
    fake_aligned = [{"pitches": ["D5"], "time_sec": 1.1, "measure": 1}]

    with patch("benchmark_full_pipeline.midi_score_to_dict", return_value=fake_score), \
         patch("benchmark_full_pipeline.load_ground_truth", return_value=fake_ground_truth), \
         patch("benchmark_full_pipeline.inject_mistake", return_value=fake_injection), \
         patch("benchmark_full_pipeline.w.run_pitch_tracking", return_value=fake_events), \
         patch("benchmark_full_pipeline.w.dtw_align_to_score", return_value=fake_aligned), \
         patch("benchmark_full_pipeline.w.beats_per_measure_from_time_sig", return_value=4):
        result = run_free_legs("2186", Path("/fake/data"), "wrong_pitch", rng_seed=0)

    assert result["piece_id"] == "2186"
    assert result["mistake_type"] == "wrong_pitch"
    assert result["true_measure"] == 1   # onset_sec=1.0 falls in the injected note's own measure
    assert result["detected_at_measure"] == 1
    assert result["localization_correct"] is True
    assert result["cost_dollars"] == 0.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate && cd modal_worker && python3 -m pytest test_benchmark_full_pipeline.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'benchmark_full_pipeline'`

- [ ] **Step 3: Implement**

```python
# modal_worker/benchmark_full_pipeline.py
"""
Chained end-to-end benchmark for docs/superpowers/plans/2026-10-30-audio-
pipeline-benchmark.md Task 3. Runs the FREE half of the real production
chain (run_pitch_tracking -> dtw_align_to_score) against synthetically
injected mistakes (inject_audio_mistakes.py), to find out whether a given
injected case is even detectable before Task 4 spends anything on the
Gemini/Claude leg.

APPROVAL GATE: this file deliberately stops after the free legs. A
`run_paid_legs` function belongs in a SEPARATE follow-up task, dispatched
only after the owner explicitly approves a spending cap for it (spec rule
10; this plan's Global Constraints) -- do not add Gemini/Claude calls to
this file without that separate approval.

Same category as validate_alignment_against_musicnet.py: not part of the
Modal image, needs the shared validation venv's torch/torchcrepe/librosa/
soundfile/music21 stack, run against the same /tmp/musicnet_data/ layout.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402
from validate_alignment_against_musicnet import (  # noqa: E402
    midi_score_to_dict, load_ground_truth)
from inject_audio_mistakes import inject_mistake  # noqa: E402


def run_free_legs(piece_id: str, data_dir: Path, mistake_type: str, rng_seed: int) -> dict:
    """
    One benchmark case, free legs only. Loads piece_id's real MusicNet
    score+audio+labels, injects one mistake, runs the real run_pitch_
    tracking + dtw_align_to_score against the INJECTED audio, and checks
    whether DTW localized the injected note to the same measure the
    injection's own onset_sec falls in (ground truth derived the same way
    validate_alignment_against_musicnet already does, via start_beat and
    beats_per_measure_from_time_sig -- reused, not reimplemented).

    Returns {"piece_id", "mistake_type", "injected", "detected_at_measure",
    "true_measure", "localization_correct", "cost_dollars": 0.0} --
    cost_dollars is always 0.0 here; Task 4's paid-leg function adds the
    real Gemini/Claude cost on top once that's separately approved.
    """
    score = midi_score_to_dict(data_dir / "midis" / f"{piece_id}.mid")
    ground_truth = load_ground_truth(data_dir / "labels" / f"{piece_id}.csv")
    wav_bytes = (data_dir / "audio" / f"{piece_id}.wav").read_bytes()

    result = inject_mistake(wav_bytes, ground_truth, mistake_type, rng_seed)
    injected = result["injected"]

    time_sig = score.get("time_signature") or "4/4"
    beats_per_measure = w.beats_per_measure_from_time_sig(time_sig)

    # Same formula validate_alignment_against_musicnet.py uses for ground
    # truth: find the label row nearest the injection's own onset time,
    # convert its start_beat to a measure number.
    nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - injected["onset_sec"]))
    true_measure = int(nearest["start_beat"] // beats_per_measure) + 1

    events = w.run_pitch_tracking(result["wav_bytes"], instrument="Violin")
    aligned = w.dtw_align_to_score(events, score, start_measure=1,
                                    beats_per_measure=beats_per_measure)

    detected_at_measure = None
    for ev in aligned:
        if abs(ev["time_sec"] - injected["onset_sec"]) < 0.3:
            detected_at_measure = ev.get("measure")
            break

    return {
        "piece_id": piece_id, "mistake_type": mistake_type, "injected": injected,
        "detected_at_measure": detected_at_measure, "true_measure": true_measure,
        "localization_correct": detected_at_measure == true_measure,
        "cost_dollars": 0.0,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate && cd modal_worker && python3 -m pytest test_benchmark_full_pipeline.py -v`
Expected: PASS, 1/1

- [ ] **Step 5: Commit**

```bash
git add modal_worker/benchmark_full_pipeline.py modal_worker/test_benchmark_full_pipeline.py
git commit -m "feat(validation): add free-leg (CREPE+DTW) chained benchmark runner against injected mistakes"
```

- [ ] **Step 6: STOP — do not run this against real MusicNet data yet**

Running `run_free_legs` for real (not the mocked test above) needs the real `/tmp/musicnet_data/` cache from the earlier alignment validation (free — already-downloaded, local files, no new cost) and the shared validation venv's GPU/CPU CREPE inference (free — local compute, no API). This step itself needs NO approval gate (zero paid calls), but report the real per-mistake-type localization rates to the owner before proposing Task 4, since a mistake type DTW can't even localize isn't worth paying to evaluate through Gemini/Claude.

---

## Task 4: Paid leg — Gemini + Claude flag-correctness scoring (APPROVAL GATE, not executed by this plan)

**This task is deliberately left unimplemented by this plan.** Per spec rule 10 ("do not spend paid API credits... without explicit approval") and the global constraint above, this plan stops at Task 3's free legs. Task 4's shape, so the next approval request is concrete rather than open-ended:

**Proposed scope, pending separate approval:**
- Reuse Task 3's `run_free_legs` output for whichever mistake types it showed as `localization_correct: True` (no point paying to test a case the free legs already lost).
- For each such case, call the real `evaluate_with_gemini` (score_pages = the piece's real rendered score page, file_uri = the injected-mistake wav uploaded to wherever that function expects media) and `compare_and_coach_claude` (using Task 3's real `aligned` events + that Gemini result), then check whether the returned flags name the injected mistake's measure and roughly its mistake type (wrong-note vs rhythm).
- Compute precision (of all flags raised, how many correspond to a real injected mistake) and recall (of all injected mistakes, how many were flagged) across N cases.
- Repeatability: run the SAME injected case through Gemini+Claude 3 times, check flag agreement — this is the first measurement of this metric anywhere in the codebase.
- **Hard cap, to be set in the approval request itself**: exact N (number of benchmark cases), exact model strings (`evaluate_with_gemini`'s Gemini model, `compare_and_coach_claude`'s `claude-sonnet-5`), a worst-case per-call token/cost estimate (same `BudgetGuard` pattern used earlier this session for the score-reading experiments), and an explicit dollar ceiling. Do not start this task without that number written down and approved first.

---

## Self-Review

**Spec coverage:** "audit the current pipeline" → Audit Findings section + Task 1. "controlled benchmark using verified scores + documented errors" → Task 2 (injection) + Task 3 (free-leg runner). "distinguish score-reading / audio-transcription / alignment / feedback-generation failures" → Audit Findings names all four and their existing (or missing) coverage explicitly; Task 3's `run_free_legs` output separates "not even detected/localized by CREPE+DTW" from "reached Gemini/Claude" by construction. "note-error precision/recall, false positives, measure-localization, repeatability, per-instrument" → measure-localization is Task 3's `localization_correct`; precision/recall/false-positives/repeatability all require the paid leg (Task 4, gated) since they're properties of the FINAL flags, not the free legs. "smallest changes supported by measured evidence" → this plan adds no production-code changes at all; Task 4 is explicitly not started.

**Placeholder scan:** no TBD/TODO; Task 4 is intentionally unimplemented (that's the approval gate working as intended, not a placeholder standing in for real content — its own section spells out exactly what it would do and what number it needs before it can start).

**Type consistency:** `inject_mistake`'s `injected` dict shape (Task 2) is consumed unchanged by `run_free_legs` (Task 3) and is the exact shape Task 4's proposed scope reads from — checked against each task's Interfaces block.

---

**Plan complete and saved to `docs/superpowers/plans/2026-10-30-audio-pipeline-benchmark.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Tasks 1-3 only (Task 4 needs a separate approval before it can even be dispatched).

**2. Inline Execution** — Execute Tasks 1-3 in this session using executing-plans, batch execution with checkpoints.

Which approach?
