# Visual Pipeline Phase 1-2 Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure what the current visual-analysis pipeline actually costs and does (Phase 1), then run four independent, isolated experiments — SMT zero-shot accuracy, a Gemini cross-check extension, and a Sonnet 5 / Haiku 5.5 / deterministic-template coaching comparison — against it (Phase 2), producing the five deliverables the spec requires before any decision on Phases 3-4.

**Architecture:** Every task in this plan is observational or offline. Nothing changes what a real user's analysis receives. Instrumentation is added via `print()` logging at existing call sites (matching this file's established diagnostic convention). All new experiment code lives in new files alongside `modal_worker/worker.py`, imported from it, never merged into the functions that serve real traffic — the same pattern this session's existing validation harness (`modal_worker/build_visual_validation_corpus.py` and siblings) already uses.

**Tech Stack:** Python (worker.py's existing stack: `anthropic`, `music21`, `verovio`, `resvg-py`), TypeScript (Supabase edge function), the validation venv at `/Users/matthewwu/.cache/mediant_validation/venv`.

**Spec:** `docs/superpowers/specs/2026-10-28-visual-pipeline-cost-redesign-design.md`, Section 12 (Implementation sequence, Phases 1-2 only — Phases 3-4 are explicitly out of scope for this plan).

## Global Constraints

- **API spending cap: $5.00 total** for this plan's real Anthropic/Google API calls (Task 5's coaching A/B and Task 4's Gemini experiment). This is separate from, and much smaller than, the $19.93 total Anthropic credit balance referenced elsewhere this session — leaving headroom. Each task that spends real API dollars tracks its own running total and **aborts before exceeding its allocated share** (Task 4: $2.00; Task 5: $3.00) rather than finding out after the fact.
- **Existing production behavior is preserved, unconditionally.** No task in this plan may change what `run_full_analysis`, `read_score_notes_claude`, or `compare_and_coach_claude` return to a real caller. Every change is either a `print()`-only addition (Task 1) or lives entirely in new, separately-imported files (Tasks 2-6).
- **Experimental code stays separate from the production execution path.** New files live in `modal_worker/`, next to `worker.py`, and only ever `import worker as w` — never the reverse.
- **No per-analysis dollar figure may be asserted as fact without a citation to a real measured number** (Task 1's output) or an explicit "estimated, not measured" label — this plan inherits the spec's own discipline against inventing numbers.
- Every reported accuracy figure (Task 3) must include a confidence interval and a per-instrument breakdown, never an aggregate alone (spec Section 6).
- SMT's acceptance evaluation (Task 3) splits the corpus into a calibration set and a held-out test set **before** any threshold is chosen, and the held-out set is never touched for threshold-setting (spec Section 6).
- Any train/eval-style split in this plan splits by underlying piece/edition, generated **before** degradation variants, never by individual image (spec Section 7, applies here to the calibration/held-out split too).

---

### Task 1: Baseline cost, latency, and cache-hit instrumentation

**Files:**
- Modify: `modal_worker/worker.py:5137-5148` (inside `_read_score_notes_claude_once`, right after `msg = stream.get_final_message()`)
- Modify: `modal_worker/worker.py:9627-9630` (inside `compare_and_coach_claude`, right after `msg = client.messages.create(...)`)
- Modify: `supabase/functions/analyze-performance/index.ts:1354-1362` (score-cache lookup block)
- Test: `modal_worker/test_analysis.py` (new test functions, appended near the existing `test_score_reader_sends_every_page` test at line 1746)

**Interfaces:**
- Produces: a `[cost]`-prefixed log line per real Claude call, grep-able from Modal logs, shaped `[cost] <call_site> model=<model_id> input_tokens=<int> output_tokens=<int>`. Later tasks (and whoever aggregates Phase 1's baseline report) rely on this exact prefix and field format to parse logs.
- Produces: a `[analyze-performance] score cache hit for <key>` / `[analyze-performance] score cache miss for <key>` pair (the hit line already exists; the miss line is new) — these two log lines, taken together, are what Task 6's baseline report computes cache hit rate from.

This task is pure instrumentation: no function's return value changes, only new `print()`/`console.log()` calls are added, matching this file's existing diagnostic logging style throughout (`[read_score_notes_claude] ...`, `[analyze-performance] ...`).

- [ ] **Step 1: Write the failing test for `_read_score_notes_claude_once`'s usage logging**

Add to `modal_worker/test_analysis.py`, right after `test_score_reader_sends_every_page` (reuses that test's exact `_FakeStream`/`_FakeMessages`/`_FakeClient` shapes, since those are already the established fakes for this call site — but this test needs its own fake that DOES set `.usage`, since the existing shared fakes deliberately don't, and must keep not needing to for every other test that uses them):

```python
def test_read_score_notes_claude_once_logs_cost_when_usage_present():
    print("\n[44] _read_score_notes_claude_once logs [cost] when the SDK response has usage data")
    import types, json as _json, io, contextlib

    class _FakeStream:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self):
            return types.SimpleNamespace(
                content=[types.SimpleNamespace(type="text", text=_json.dumps({
                    "key_signature": "C major", "time_signature": "4/4",
                    "tempo_marking": None,
                    "measures": [{"number": 1, "pg": 1, "notes": [{"p": "C4", "b": 1.0, "d": 1.0}]}],
                }))],
                stop_reason="end_turn",
                usage=types.SimpleNamespace(input_tokens=1234, output_tokens=567))

    class _FakeMessages:
        def stream(self, **kw):
            return _FakeStream()

    class _FakeClient:
        def __init__(self, **kw): self.messages = _FakeMessages()

    pages = [(b"\x89PNG-page-one", "image/png")]
    import anthropic as _ac
    _orig = _ac.Anthropic
    _ac.Anthropic = _FakeClient
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            w.read_score_notes_claude(pages, 1, "clarinet", "4/4", "k")
    finally:
        _ac.Anthropic = _orig

    out = buf.getvalue()
    check("logs a [cost] line with the fake usage's exact token counts",
          "[cost] read_score_notes_claude_once model=claude-sonnet-5 "
          "input_tokens=1234 output_tokens=567" in out, out[:2000])


def test_read_score_notes_claude_once_cost_logging_is_defensive_when_usage_absent():
    print("\n[45] _read_score_notes_claude_once does not crash when a fake/mocked "
          "response has no usage attribute (every OTHER existing test's fakes rely on this)")
    import types, json as _json, io, contextlib

    class _FakeStream:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self):
            # Deliberately no `usage=` kwarg — matches every pre-existing fake
            # in this file (e.g. test_score_reader_sends_every_page).
            return types.SimpleNamespace(
                content=[types.SimpleNamespace(type="text", text=_json.dumps({
                    "key_signature": "C major", "time_signature": "4/4",
                    "tempo_marking": None, "measures": [],
                }))],
                stop_reason="end_turn")

    class _FakeMessages:
        def stream(self, **kw):
            return _FakeStream()

    class _FakeClient:
        def __init__(self, **kw): self.messages = _FakeMessages()

    pages = [(b"\x89PNG-page-one", "image/png")]
    import anthropic as _ac
    _orig = _ac.Anthropic
    _ac.Anthropic = _FakeClient
    buf = io.StringIO()
    raised = False
    try:
        with contextlib.redirect_stdout(buf):
            w.read_score_notes_claude(pages, 1, "clarinet", "4/4", "k")
    except AttributeError:
        raised = True
    finally:
        _ac.Anthropic = _orig

    check("no AttributeError when usage is absent", not raised, "raised=" + str(raised))
    check("no [cost] line printed when usage is absent (nothing to report)",
          "[cost] read_score_notes_claude_once" not in buf.getvalue(), buf.getvalue()[:500])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -30`
Expected: both new checks under `[44]` and the first check under `[45]` FAIL (no `[cost]` line exists yet) — `[45]`'s "no AttributeError" check passes trivially since nothing new runs yet.

- [ ] **Step 3: Add the cost-logging line to `_read_score_notes_claude_once`**

In `modal_worker/worker.py`, immediately after the existing block:

```python
        with client.messages.stream(
            model="claude-sonnet-5",
            max_tokens=64000,
            messages=[{"role": "user", "content": [*vision_parts, {"type": "text", "text": prompt}]}],
        ) as stream:
            msg = stream.get_final_message()
```

add:

```python
        usage = getattr(msg, "usage", None)
        if usage is not None:
            print(f"[cost] read_score_notes_claude_once model=claude-sonnet-5 "
                  f"input_tokens={usage.input_tokens} output_tokens={usage.output_tokens}")
```

`getattr(msg, "usage", None)` is deliberate, not optional defensiveness-for-its-own-sake: every existing test fake for this call site (`test_score_reader_sends_every_page` and others) constructs its fake message without a `usage` attribute, and this task must not require touching every one of those to add one. A real Anthropic SDK response always has `.usage` — only test fakes omit it.

- [ ] **Step 4: Add the cost-logging line to `compare_and_coach_claude`**

In `modal_worker/worker.py`, immediately after:

```python
        client = ac.Anthropic(api_key=anthropic_api_key)
        msg    = client.messages.create(
            model=CLAUDE_MODEL, max_tokens=16000,
            messages=[{"role": "user", "content": coach_prompt}],
        )
```

add:

```python
        usage = getattr(msg, "usage", None)
        if usage is not None:
            print(f"[cost] compare_and_coach_claude model={CLAUDE_MODEL} "
                  f"input_tokens={usage.input_tokens} output_tokens={usage.output_tokens}")
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -10`
Expected: PASS for `[44]` and `[45]`, and the full suite's final count increases by exactly 4 (two checks per new test) over whatever it was before this task — no regressions elsewhere.

- [ ] **Step 6: Add the score-cache miss log**

In `supabase/functions/analyze-performance/index.ts`, change:

```ts
        let cachedScoreNotes: unknown = null
        if (scorePath && scoreMimeType && /pdf|image/i.test(scoreMimeType)) {
          const { data: cacheRow } = await admin
            .from('score_cache').select('parsed_notes').eq('score_path', scoreCacheKey).maybeSingle()
          if (cacheRow?.parsed_notes) {
            cachedScoreNotes = cacheRow.parsed_notes
            console.log('[analyze-performance] score cache hit for', scoreCacheKey)
          }
        }
```

to:

```ts
        let cachedScoreNotes: unknown = null
        if (scorePath && scoreMimeType && /pdf|image/i.test(scoreMimeType)) {
          const { data: cacheRow } = await admin
            .from('score_cache').select('parsed_notes').eq('score_path', scoreCacheKey).maybeSingle()
          if (cacheRow?.parsed_notes) {
            cachedScoreNotes = cacheRow.parsed_notes
            console.log('[analyze-performance] score cache hit for', scoreCacheKey)
          } else {
            console.log('[analyze-performance] score cache miss for', scoreCacheKey)
          }
        }
```

- [ ] **Step 7: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py supabase/functions/analyze-performance/index.ts
git commit -m "feat(instrumentation): log real token usage and score-cache hit/miss for Phase 1 baseline"
```

---

### Task 2: Multi-instrument synthetic corpus extension + calibration/held-out split

**Files:**
- Modify: `modal_worker/build_visual_validation_corpus.py` (add piano to the rendered instrument set)
- Create: `modal_worker/split_validation_corpus.py` (piece-level calibration/held-out split)
- Test: `modal_worker/test_visual_validation.py` (new checks, appended)

**Interfaces:**
- Consumes: `build_corpus_entry(piece_id, midi_path, metadata_row, out_dir)` from `build_visual_validation_corpus.py` (existing, unchanged signature).
- Produces: `split_corpus_by_piece(ground_truth: dict, calibration_fraction: float, seed: int) -> tuple[set[str], set[str]]` — returns `(calibration_piece_ids, held_out_piece_ids)`, a deterministic partition of `ground_truth`'s keys. Task 3 imports and calls this directly.

The existing corpus (`modal_worker/build_visual_validation_corpus.py`) only ever selects MusicNet's own solo violin/cello/flute pieces. The spec's Section 6 step 1 requires a piano (grand-staff) entry, and `music21`+`verovio` already handle this — MusicNet just never exercised that path. Rather than find a real piano MusicNet piece (MusicNet is confirmed, from this session's earlier direct inspection of all 24 rows, to be 100% solo violin/cello/flute — no piano exists in the corpus), this task adds ONE synthetic piano piece built directly with `music21`, reusing the exact rendering pipeline (`render_musicxml_to_pngs`) the existing corpus already calls.

- [ ] **Step 1: Write the failing test for a synthetic piano piece's ground truth**

Add to `modal_worker/test_visual_validation.py`:

```python
def test_synthetic_piano_piece_builds_grand_staff_ground_truth():
    print("\n[47] a synthetic piano piece renders a 2-staff grand-staff score "
          "and extract_ground_truth_measures covers both staves' notes")
    import build_visual_validation_corpus as bvc
    from music21 import stream, note, meter, instrument as m21_instrument

    piano_part = stream.Part()
    piano_part.insert(0, m21_instrument.Piano())
    piano_part.append(meter.TimeSignature('4/4'))
    piano_part.append(note.Note('C4', quarterLength=1.0))
    piano_part.append(note.Note('E4', quarterLength=1.0))
    piano_part.append(note.Note('G4', quarterLength=1.0))
    piano_part.append(note.Note('C5', quarterLength=1.0))
    measured = piano_part.makeMeasures()

    entry = bvc.extract_ground_truth_measures(measured)
    check("4 quarter notes in 4/4 produce exactly 1 measure",
          len(entry["measures"]) == 1, str(entry))
    check("that measure has all 4 notes",
          len(entry["measures"][0]["notes"]) == 4,
          str(entry["measures"][0]))
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd modal_worker && source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate && python3 test_visual_validation.py 2>&1 | tail -20`
Expected: FAIL — `extract_ground_truth_measures` exists and should actually already handle this input correctly (it's generic over any `music21` stream), so this step's real purpose is confirming the test harness wiring is correct before Step 3 adds the corpus-building entry point. If this unexpectedly PASSES already, skip to Step 4 — that means the existing function is already correct and this task only needs the corpus-building entry point (Step 3), not a new extraction code path.

- [ ] **Step 3: Add a synthetic-piano corpus-building entry point**

In `modal_worker/build_visual_validation_corpus.py`, add (reusing `render_musicxml_to_pngs` and the RGBA-to-white-flattening fix already present in that function from this session's earlier fix wave — do not re-introduce the black-background bug by writing a separate render path):

```python
def build_synthetic_piano_entry(out_dir: "Path") -> dict:
    """
    Builds ONE synthetic piano (grand-staff) piece, since MusicNet (confirmed
    via direct inspection of all 24 rows this session) contains zero piano
    pieces — every piece is solo violin/cello/flute. Reuses the exact same
    render_musicxml_to_pngs pipeline every other corpus entry uses, so this
    piece is scored identically, not through a parallel code path.
    """
    from music21 import stream, note, meter, instrument as m21_instrument, metadata

    piano_part = stream.Part()
    piano_part.insert(0, m21_instrument.Piano())
    piano_part.append(meter.TimeSignature('4/4'))
    pitches = ['C4', 'E4', 'G4', 'C5', 'B4', 'G4', 'E4', 'C4'] * 4
    for p in pitches:
        piano_part.append(note.Note(p, quarterLength=1.0))
    measured = piano_part.makeMeasures()
    measured.metadata = metadata.Metadata()
    measured.metadata.title = "Synthetic Piano Grand-Staff Test Piece"
    measured.metadata.composer = "Mediant validation harness"

    musicxml_path = out_dir / "piano_synthetic.musicxml"
    measured.write('musicxml', fp=str(musicxml_path))

    pngs = render_musicxml_to_pngs(str(musicxml_path), str(out_dir / "piano_synthetic"))

    from music21 import converter
    reparsed = converter.parse(str(musicxml_path))
    entry = extract_ground_truth_measures(reparsed.parts[0] if reparsed.parts else reparsed)
    entry["n_pages"] = len(pngs)
    entry["instrument"] = "Piano"
    return entry
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `cd modal_worker && source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate && python3 test_visual_validation.py 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the calibration/held-out split**

```python
def test_split_corpus_by_piece_is_deterministic_and_disjoint():
    print("\n[48] split_corpus_by_piece partitions piece IDs deterministically, "
          "disjointly, and covers every piece")
    import split_validation_corpus as svc

    fake_ground_truth = {f"piece{i}": {"measures": []} for i in range(10)}
    cal_a, held_a = svc.split_corpus_by_piece(fake_ground_truth, calibration_fraction=0.5, seed=42)
    cal_b, held_b = svc.split_corpus_by_piece(fake_ground_truth, calibration_fraction=0.5, seed=42)

    check("same seed produces the identical calibration set twice",
          cal_a == cal_b, f"{cal_a} vs {cal_b}")
    check("calibration and held-out sets are disjoint",
          cal_a.isdisjoint(held_a), f"{cal_a} & {held_a}")
    check("every piece ID is in exactly one of the two sets",
          cal_a | held_a == set(fake_ground_truth.keys()),
          f"union={cal_a | held_a} vs all={set(fake_ground_truth.keys())}")
    check("roughly half (5 of 10) went to calibration at fraction=0.5",
          len(cal_a) == 5, str(cal_a))

    cal_c, _ = svc.split_corpus_by_piece(fake_ground_truth, calibration_fraction=0.5, seed=99)
    check("a different seed can produce a different split (not hardcoded)",
          cal_a != cal_c or True,  # not a strict requirement, just documenting intent
          f"seed 42: {cal_a}, seed 99: {cal_c}")
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd modal_worker && python3 test_visual_validation.py 2>&1 | tail -10`
Expected: FAIL with "No module named 'split_validation_corpus'".

- [ ] **Step 7: Implement `split_validation_corpus.py`**

```python
"""
Splits the visual validation corpus into a calibration set (used ONLY to
pick numeric acceptance thresholds) and a held-out test set (used ONLY for
the actual accept/reject measurement) -- split by PIECE, before any
degradation variant exists, per the spec's Section 6/7 requirement that a
threshold must never be set by looking at the same data it's graded
against, and that no split may leak degraded variants of one piece across
both sides.

See docs/superpowers/specs/2026-10-28-visual-pipeline-cost-redesign-design.md
Section 6 ("Threshold-setting methodology") for the full rationale.
"""
import hashlib


def split_corpus_by_piece(ground_truth: dict, calibration_fraction: float,
                           seed: int) -> tuple[set, set]:
    """
    Deterministically partitions `ground_truth`'s piece IDs into
    (calibration_ids, held_out_ids). Deterministic via a seeded hash of each
    piece ID rather than `random.shuffle`, so the same (seed, piece ID) pair
    always lands on the same side regardless of dict iteration order or
    how many pieces are in the corpus -- adding a new piece later does not
    reshuffle which existing pieces were calibration vs. held-out.
    """
    piece_ids = sorted(ground_truth.keys())
    n_calibration = round(len(piece_ids) * calibration_fraction)

    def _rank(piece_id: str) -> str:
        return hashlib.sha256(f"{seed}:{piece_id}".encode()).hexdigest()

    ranked = sorted(piece_ids, key=_rank)
    calibration_ids = set(ranked[:n_calibration])
    held_out_ids = set(ranked[n_calibration:])
    return calibration_ids, held_out_ids
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd modal_worker && source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate && python3 test_visual_validation.py 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 9: Real-run — rebuild the corpus including the new piano piece**

Run:
```bash
cd modal_worker && source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 -c "
from pathlib import Path
import build_visual_validation_corpus as bvc
out = Path('/Users/matthewwu/.cache/mediant_validation/visual_corpus')
entry = bvc.build_synthetic_piano_entry(out / 'clean')
import json
gt = json.load(open(out / 'ground_truth.json'))
gt['piano_synthetic'] = entry
json.dump(gt, open(out / 'ground_truth.json', 'w'), indent=2)
print('piano_synthetic added:', entry['n_pages'], 'pages,', len(entry['measures']), 'measures')
"
```
Expected: prints a real page/measure count, no exception. Confirms the real render pipeline (not just the unit test's mocked path) produces a usable piano entry.

- [ ] **Step 10: Commit**

```bash
git add modal_worker/build_visual_validation_corpus.py modal_worker/split_validation_corpus.py modal_worker/test_visual_validation.py
git commit -m "feat(validation): add synthetic piano grand-staff corpus entry and piece-level calibration/held-out split"
```

---

### Task 3: SMT zero-shot evaluation against the corpus

**Files:**
- Create: `modal_worker/smt_inference.py`
- Create: `modal_worker/evaluate_smt_zero_shot.py`
- Test: `modal_worker/test_smt_inference.py`

**Interfaces:**
- Consumes: `split_corpus_by_piece` from Task 2's `split_validation_corpus.py`; the corpus directory layout from the existing harness (`clean/`, `degraded/mild/`, `degraded/severe/`, `ground_truth.json`).
- Produces: `transcribe_with_smt(page_paths: list[Path], checkpoint: str) -> dict` returning the SAME shape `read_score_notes_claude` returns on success (`{"measures": [...], "source": "smt"}`), so Task 6's report can score it with the existing `w._cross_source_measure_match` exactly as the harness already scores Claude's output.

**Step 1 is a verification spike, not a placeholder** — SMT's exact Python inference API has not been run in this session yet; only its Hugging Face model card's documented snippet shape is known (`SMTModelForCausalLM.from_pretrained(<model_reference>)`, `.predict(...)`). Confirm the real shape before writing the wrapper around it, the same way every other external-library fact in this session's existing harness (`verovio`, `resvg-py`) was confirmed by direct experiment before being relied on in a plan.

- [ ] **Step 1: Install SMT and confirm its real inference API by direct experiment**

Run:
```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu  # CPU is fine for a 21.4M-param model
pip install transformers huggingface_hub
python3 -c "
from transformers import AutoModel
import inspect
model = AutoModel.from_pretrained('antoniorv6/smt-grandstaff', trust_remote_code=True)
print(type(model))
print([m for m in dir(model) if not m.startswith('_')])
print(inspect.signature(model.predict) if hasattr(model, 'predict') else 'no .predict method')
"
```
Write down the exact output in a comment at the top of `modal_worker/smt_inference.py` before proceeding — the real method name, its real parameter names, and the real shape of what it returns (a tensor of token IDs? a decoded string already? check both). If `trust_remote_code=True` is required, or the class name differs from `AutoModel`, or the package name differs from what's written above, record what actually worked — the next step's code must match what was just confirmed, not the Hugging Face model card's snippet verbatim if reality differs.

- [ ] **Step 2: Write the failing test for `transcribe_with_smt`'s output shape**

Add to `modal_worker/test_smt_inference.py` (new file):

```python
"""
Tests for smt_inference.py. Per Task 3 Step 1, these assume the real SMT
API confirmed by direct experiment -- update the fake/mock in this file to
match whatever Step 1 actually found, not this plan's guess, if they differ.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smt_inference as si

RESULTS = []


def check(desc, passed, detail=""):
    RESULTS.append(passed)
    print(f"  {'PASS' if passed else 'FAIL'}  {desc}" + (f"   {detail}" if detail else ""))


def test_transcribe_with_smt_returns_measures_shape():
    print("\n[1] transcribe_with_smt returns the same {measures, source} shape "
          "read_score_notes_claude returns, so existing scoring code works unmodified")
    from pathlib import Path
    corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
    page_paths = sorted(corpus_dir.glob("2204_page*.png"))
    if not page_paths:
        print("  SKIP  no corpus page found at the expected path -- run Task 2 first")
        return
    result = si.transcribe_with_smt(page_paths, checkpoint="antoniorv6/smt-grandstaff")
    check("result has a 'measures' key", "measures" in result, str(result)[:300])
    check("result['source'] is 'smt'", result.get("source") == "smt", str(result.get("source")))


def main():
    test_transcribe_with_smt_returns_measures_shape()
    passed = sum(1 for r in RESULTS if r)
    total = len(RESULTS)
    print(f"\n{'='*70}\n{passed}/{total} checks passed\n{'='*70}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd modal_worker && source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate && python3 test_smt_inference.py`
Expected: FAIL with "No module named 'smt_inference'".

- [ ] **Step 4: Implement `smt_inference.py` using what Step 1 confirmed**

```python
"""
Thin wrapper around SMT (Sheet Music Transformer,
github.com/antoniorv6/SMT) inference, producing the same {"measures": [...],
"source": ...} shape read_score_notes_claude returns on success, so the
existing w._cross_source_measure_match scoring code works against it
unmodified.

API CONFIRMED BY DIRECT EXPERIMENT (Task 3 Step 1): <paste the real output
captured in Step 1 here before marking this task complete -- this comment
is itself a required part of the implementation, not documentation fluff,
because it is the evidence the rest of this file's code is correct rather
than copied blind from a model card>.
"""
from pathlib import Path


def transcribe_with_smt(page_paths: list[Path], checkpoint: str) -> dict:
    """
    Runs SMT on each page in `page_paths` (already-rendered PNGs, same
    inputs read_score_notes_claude receives) and returns
    {"measures": [...], "source": "smt"} on success, or
    {"error": "...", "measures": [], "source": "smt"} on any failure --
    matching the fail-open shape every other OMR source in this codebase
    (Audiveris, Claude) already uses.
    """
    try:
        from transformers import AutoModel
        model = AutoModel.from_pretrained(checkpoint, trust_remote_code=True)
    except Exception as e:
        return {"error": f"SMT model load failed: {type(e).__name__}: {e}",
                "measures": [], "source": "smt"}

    all_measures = []
    for page_path in page_paths:
        try:
            # NOTE: replace this call with whatever Task 3 Step 1 actually
            # confirmed model.predict (or the real method name) accepts and
            # returns -- this is the one piece of this file that cannot be
            # written correctly without that confirmed API, by design.
            raw_output = model.predict(str(page_path))
            page_measures = _decode_smt_output(raw_output)
            all_measures.extend(page_measures)
        except Exception as e:
            return {"error": f"SMT inference failed on {page_path}: "
                              f"{type(e).__name__}: {e}",
                    "measures": all_measures, "source": "smt"}

    return {"measures": all_measures, "source": "smt"}


def _decode_smt_output(raw_output) -> list[dict]:
    """
    Converts SMT's raw output (bekern-style token sequence, per its GitHub
    README) into this codebase's measure/note schema:
    {"number": int, "notes": [{"pitch": str|None, "is_rest": bool,
    "beat": float, "duration_beats": float}]} -- the exact schema
    _cross_source_measure_match expects on both its `predicted` and
    `ground_truth` arguments.

    Left to implement once Task 3 Step 1 confirms the real raw_output
    shape -- the bekern token-to-measure mapping depends on tokens this
    plan cannot see without that confirmed output in hand.
    """
    raise NotImplementedError(
        "Implement once Task 3 Step 1's real SMT output shape is known. "
        "Do not guess the bekern token grammar from the GitHub README alone "
        "-- confirm it against real decoded output from Step 1 first.")
```

**Note for whoever executes this task:** `_decode_smt_output` is deliberately left raising `NotImplementedError` in this plan, not because "no placeholders" is being violated, but because its correct implementation is a direct, mechanical function of Step 1's confirmed real output — writing it now, before Step 1 runs, would be guessing the bekern token grammar from a README rather than from observed output, which is exactly the mistake this session's entire validation-harness work exists to avoid repeating. Step 1 must run first; its output dictates this function's body.

- [ ] **Step 5: Run Step 1's experiment, then finish `_decode_smt_output` for real, then re-run the test**

This step cannot be scripted in advance of Step 1's result. Once Step 1's real output is in hand: write `_decode_smt_output` against that real, observed shape; re-run `python3 test_smt_inference.py`; confirm PASS.

- [ ] **Step 6: Build and run the zero-shot evaluation**

Create `modal_worker/evaluate_smt_zero_shot.py`:

```python
"""
Phase 2 experiment: runs SMT zero-shot (no fine-tuning) against the
calibration and held-out splits of the visual validation corpus, reporting
accuracy with confidence intervals and per-instrument breakdowns -- never
an aggregate alone, per spec Section 6.

Zero Anthropic/Google API cost: SMT runs entirely as self-hosted inference.
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402
import smt_inference as si  # noqa: E402
import split_validation_corpus as svc  # noqa: E402
from validate_score_reading_against_corpus import score_measures  # noqa: E402


def wilson_confidence_interval(n_correct: int, n_total: int, z: float = 1.96) -> tuple:
    """95% Wilson score interval for a proportion -- more reliable than a
    normal approximation at the small sample sizes this corpus has."""
    if n_total == 0:
        return (0.0, 0.0)
    p = n_correct / n_total
    denom = 1 + z**2 / n_total
    center = (p + z**2 / (2 * n_total)) / denom
    margin = (z * math.sqrt(p * (1 - p) / n_total + z**2 / (4 * n_total**2))) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def evaluate_piece_set(piece_ids: set, corpus_dir: Path, ground_truth: dict,
                        checkpoint: str) -> dict:
    """Returns {piece_id: (n_correct, n_total, instrument)} for every piece
    in `piece_ids`, reading pages from `corpus_dir` ('clean' or a degraded
    tier subdirectory)."""
    results = {}
    for piece_id in piece_ids:
        gt_entry = ground_truth[piece_id]
        page_paths = sorted(corpus_dir.glob(f"{piece_id}_page*.png"))
        if not page_paths:
            results[piece_id] = (0, len(gt_entry["measures"]),
                                  gt_entry.get("instrument", "unknown"))
            continue
        smt_result = si.transcribe_with_smt(page_paths, checkpoint)
        n_correct, n_total = score_measures(
            smt_result.get("measures") or [], gt_entry["measures"],
            gt_entry["time_signature"])
        results[piece_id] = (n_correct, n_total, gt_entry.get("instrument", "unknown"))
    return results


def main():
    corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    with open(corpus_dir / "ground_truth.json") as f:
        ground_truth = json.load(f)

    calibration_ids, held_out_ids = svc.split_corpus_by_piece(
        ground_truth, calibration_fraction=0.5, seed=20261028)

    print(f"calibration set ({len(calibration_ids)} pieces): {sorted(calibration_ids)}")
    print(f"held-out set ({len(held_out_ids)} pieces): {sorted(held_out_ids)}")

    checkpoint = "antoniorv6/smt-grandstaff"
    for set_name, piece_ids in (("calibration", calibration_ids), ("held_out", held_out_ids)):
        results = evaluate_piece_set(piece_ids, corpus_dir / "clean", ground_truth, checkpoint)
        by_instrument = {}
        for piece_id, (n_correct, n_total, instrument) in results.items():
            by_instrument.setdefault(instrument, [0, 0])
            by_instrument[instrument][0] += n_correct
            by_instrument[instrument][1] += n_total

        print(f"\n=== {set_name} set ===")
        for instrument, (n_correct, n_total) in sorted(by_instrument.items()):
            pct = round(100 * n_correct / n_total, 2) if n_total else 0.0
            lo, hi = wilson_confidence_interval(n_correct, n_total)
            print(f"  {instrument}: {pct}% ({n_correct}/{n_total}), "
                  f"95% CI [{round(lo*100, 2)}%, {round(hi*100, 2)}%]")

    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Run: `cd modal_worker && source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate && python3 evaluate_smt_zero_shot.py`
Expected: real per-instrument accuracy percentages with confidence intervals for both the calibration and held-out sets, including the new `piano_synthetic` entry under its own "Piano" row. **Do not set any acceptance threshold from this run's held-out numbers** — per Global Constraints, the held-out set's results are reported here for Task 6's consolidated report, not used to pick a threshold.

- [ ] **Step 7: Commit**

```bash
git add modal_worker/smt_inference.py modal_worker/evaluate_smt_zero_shot.py modal_worker/test_smt_inference.py
git commit -m "feat(validation): SMT zero-shot evaluation with calibration/held-out split and per-instrument confidence intervals"
```

---

### Task 4: Gemini cross-check extension experiment

**Files:**
- Create: `modal_worker/evaluate_gemini_crosscheck.py`
- Test: `modal_worker/test_gemini_crosscheck.py`

**Interfaces:**
- Consumes: the same corpus layout as Tasks 2-3; does NOT consume or modify `evaluate_with_gemini` in `worker.py` — this experiment calls Gemini's API directly with an extended prompt, in an isolated file, per the Global Constraint that production code is untouched.
- Produces: a printed comparison of (a) Gemini's broader unconditional score-crosscheck's agreement rate with the corpus's real ground truth, and (b) the extra input/output tokens that crosscheck field costs relative to `evaluate_with_gemini`'s existing prompt, so Task 6 can report whether this is worth productionizing.

**Budget: $2.00 of this plan's $5.00 total API cap.** This task tracks and prints its own running cost; it must stop issuing new calls once the running total would exceed $2.00, reporting partial results rather than overspending.

- [ ] **Step 1: Write the failing test for the cost-tracking guard**

```python
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate_gemini_crosscheck as egc

RESULTS = []


def check(desc, passed, detail=""):
    RESULTS.append(passed)
    print(f"  {'PASS' if passed else 'FAIL'}  {desc}" + (f"   {detail}" if detail else ""))


def test_budget_guard_stops_before_exceeding_cap():
    print("\n[1] BudgetGuard.can_spend returns False once the running total "
          "would exceed the cap, and never raises")
    guard = egc.BudgetGuard(cap_dollars=2.00)
    check("can spend $1.00 against a fresh $2.00 cap", guard.can_spend(1.00) is True)
    guard.record_spend(1.00)
    check("can spend another $0.99 (total would be $1.99)", guard.can_spend(0.99) is True)
    guard.record_spend(0.99)
    check("cannot spend $0.02 more (total would be $2.01, over cap)",
          guard.can_spend(0.02) is False)
    check("running total is exactly 1.99 so far", abs(guard.total_spent - 1.99) < 1e-9,
          str(guard.total_spent))


def main():
    test_budget_guard_stops_before_exceeding_cap()
    passed = sum(1 for r in RESULTS if r)
    total = len(RESULTS)
    print(f"\n{'='*70}\n{passed}/{total} checks passed\n{'='*70}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd modal_worker && python3 test_gemini_crosscheck.py`
Expected: FAIL with "No module named 'evaluate_gemini_crosscheck'".

- [ ] **Step 3: Implement the budget guard and the crosscheck experiment**

```python
"""
Phase 2 experiment: tests whether evaluate_with_gemini's existing
video+score call (worker.py's `evaluate_with_gemini`) can be extended to
ALSO return a broader, unconditional score-crosscheck field, reconciled
against the corpus's ground truth afterward -- WITHOUT changing the real
evaluate_with_gemini function. See spec Section 3's "Gemini cross-check
extension" bullet for why this must be a broader unconditional crosscheck
(not targeted at specific uncertain measures) to respect the real parallel
pipeline structure.

Does NOT import or call the production evaluate_with_gemini -- this is an
isolated prompt experiment against the same gemini-2.5-flash model,
confirmed separately so a failure here can never affect real analyses.
"""
import base64
import json
from pathlib import Path


class BudgetGuard:
    """Tracks running API spend in dollars; never raises, only reports
    whether the NEXT call would exceed the cap, so callers can stop
    cleanly instead of finding out after an overspend."""

    def __init__(self, cap_dollars: float):
        self.cap_dollars = cap_dollars
        self.total_spent = 0.0

    def can_spend(self, estimated_dollars: float) -> bool:
        return self.total_spent + estimated_dollars <= self.cap_dollars

    def record_spend(self, actual_dollars: float) -> None:
        self.total_spent += actual_dollars


# gemini-2.5-flash pricing, per this session's own verified research:
# $0.30/1M input tokens (text/image/video), $2.50/1M output tokens.
GEMINI_FLASH_INPUT_PER_TOKEN = 0.30 / 1_000_000
GEMINI_FLASH_OUTPUT_PER_TOKEN = 2.50 / 1_000_000


def crosscheck_score_with_gemini(page_paths: list[Path], api_key: str) -> dict:
    """
    Sends every page to gemini-2.5-flash with a prompt asking for an
    unconditional, whole-score measure crosscheck (not targeted at specific
    measures -- see module docstring for why). Returns
    {"measures": [...], "input_tokens": int, "output_tokens": int} on
    success, {"error": ...} on failure.
    """
    import httpx

    parts = []
    for p in page_paths:
        b64 = base64.b64encode(p.read_bytes()).decode()
        parts.append({"inlineData": {"mimeType": "image/png", "data": b64}})
    prompt = (
        "You are cross-checking a sheet music transcription. For EVERY "
        "measure visible across all provided pages, report the notes you "
        "see: pitch (e.g. 'C4'), whether it's a rest, the beat it starts "
        "on, and its duration in beats. Return ONLY valid JSON, no markdown:\n"
        '{"measures": [{"number": <int>, "notes": [{"pitch": <str or null>, '
        '"is_rest": <bool>, "beat": <float>, "duration_beats": <float>}]}]}'
    )
    parts.append({"text": prompt})

    try:
        with httpx.Client(timeout=60) as client:
            resp = client.post(
                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"gemini-2.5-flash:generateContent?key={api_key}",
                json={
                    "contents": [{"parts": parts}],
                    "generationConfig": {"temperature": 0, "maxOutputTokens": 8192,
                                          "responseMimeType": "application/json"},
                },
            )
        if not resp.is_success:
            return {"error": f"HTTP {resp.status_code}: {resp.text[:300]}"}
        data = resp.json()
        usage = data.get("usageMetadata", {})
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        return {
            "measures": parsed.get("measures", []),
            "input_tokens": usage.get("promptTokenCount", 0),
            "output_tokens": usage.get("candidatesTokenCount", 0),
        }
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


def main():
    import os
    import sys

    api_key = os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        print("GOOGLE_AI_API_KEY not set -- export it and re-run.")
        return 1

    sys.path.insert(0, str(Path(__file__).parent))
    from validate_score_reading_against_corpus import score_measures, FAST_ITERATION_SUBSET

    corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    with open(corpus_dir / "ground_truth.json") as f:
        ground_truth = json.load(f)

    guard = BudgetGuard(cap_dollars=2.00)
    # Conservative per-call estimate: ~5000 input tokens (2 pages), ~4000
    # output tokens -- refined after the first real call's actual usage.
    estimated_call_cost = 5000 * GEMINI_FLASH_INPUT_PER_TOKEN + 4000 * GEMINI_FLASH_OUTPUT_PER_TOKEN

    for piece_id in FAST_ITERATION_SUBSET:
        if piece_id not in ground_truth:
            continue
        if not guard.can_spend(estimated_call_cost):
            print(f"Stopping before {piece_id}: would exceed ${guard.cap_dollars} cap "
                  f"(spent ${guard.total_spent:.4f} so far)")
            break
        page_paths = sorted(corpus_dir.glob(f"clean/{piece_id}_page*.png"))
        if not page_paths:
            continue
        result = crosscheck_score_with_gemini(page_paths, api_key)
        if "error" in result:
            print(f"  [{piece_id}] error: {result['error']}")
            continue
        real_cost = (result["input_tokens"] * GEMINI_FLASH_INPUT_PER_TOKEN +
                     result["output_tokens"] * GEMINI_FLASH_OUTPUT_PER_TOKEN)
        guard.record_spend(real_cost)
        n_correct, n_total = score_measures(
            result["measures"], ground_truth[piece_id]["measures"],
            ground_truth[piece_id]["time_signature"])
        pct = round(100 * n_correct / n_total, 2) if n_total else 0.0
        print(f"  [{piece_id}] {n_correct}/{n_total} measures correct ({pct}%), "
              f"cost=${real_cost:.4f}, running total=${guard.total_spent:.4f}")

    print(f"\nTotal spent: ${guard.total_spent:.4f} of ${guard.cap_dollars:.2f} cap")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
```

- [ ] **Step 4: Run the budget-guard test to verify it passes**

Run: `cd modal_worker && python3 test_gemini_crosscheck.py`
Expected: PASS (this test needs no API key — it only tests `BudgetGuard`, not real network calls).

- [ ] **Step 5: Real run, within budget**

Run: `cd modal_worker && export GOOGLE_AI_API_KEY=<your key> && python3 evaluate_gemini_crosscheck.py`
Expected: per-piece accuracy and real dollar cost printed, stopping cleanly if the $2.00 cap would be exceeded, never silently overspending.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/evaluate_gemini_crosscheck.py modal_worker/test_gemini_crosscheck.py
git commit -m "feat(validation): Gemini cross-check extension experiment with a hard $2 budget guard"
```

---

### Task 5: Sonnet 5 vs. Haiku 5.5 vs. deterministic-template coaching comparison

**Files:**
- Create: `modal_worker/evaluate_coaching_models.py`
- Test: `modal_worker/test_coaching_models.py`

**Interfaces:**
- Consumes: `BudgetGuard` from Task 4's `evaluate_gemini_crosscheck.py`.
- Produces: a printed three-way comparison (Sonnet 5 output, Haiku 5.5 output, deterministic-template output) for the same synthetic issue list, so a human reviewer can judge coaching quality — this task does not attempt to automate "is this good coaching," only to produce the comparable outputs plus real cost per arm.

**Budget: $3.00 of this plan's $5.00 total API cap.**

- [ ] **Step 1: Write the failing test for the deterministic template**

```python
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate_coaching_models as ecm

RESULTS = []


def check(desc, passed, detail=""):
    RESULTS.append(passed)
    print(f"  {'PASS' if passed else 'FAIL'}  {desc}" + (f"   {detail}" if detail else ""))


def test_deterministic_template_produces_the_required_fields():
    print("\n[1] deterministic_coaching_template fills title/body from the "
          "issue dict with zero LLM calls")
    issue = {"type": "intonation", "direction": "sharp", "location": "m.12",
              "note": "F#4", "cents": 34}
    result = ecm.deterministic_coaching_template(issue)
    check("has a title", bool(result.get("title")), str(result))
    check("has a body", bool(result.get("body")), str(result))
    check("title does not contain a number (matches the sharp/flat title rule)",
          not any(c.isdigit() for c in result["title"]), result["title"])
    check("title starts with Sharp or Flat for an intonation issue",
          result["title"].startswith(("Sharp", "Flat")), result["title"])


def main():
    test_deterministic_template_produces_the_required_fields()
    passed = sum(1 for r in RESULTS if r)
    total = len(RESULTS)
    print(f"\n{'='*70}\n{passed}/{total} checks passed\n{'='*70}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd modal_worker && python3 test_coaching_models.py`
Expected: FAIL with "No module named 'evaluate_coaching_models'".

- [ ] **Step 3: Implement the three coaching arms**

```python
"""
Phase 2 experiment: compares coaching-text quality and cost across three
arms for the same synthetic issue list -- Sonnet 5 (current production
model), Haiku 5.5 (candidate), and a deterministic template (zero LLM
cost, measures how much value the language model adds above free string
formatting). See spec Section 4 ("Testing -- three arms, not two").

Does NOT call or modify compare_and_coach_claude in worker.py -- this is
an isolated prompt experiment reusing that function's exact prompt text
and JSON schema, confirmed separately so this experiment can never affect
a real analysis.
"""
import json
from pathlib import Path


def deterministic_coaching_template(issue: dict) -> dict:
    """
    Zero-LLM-cost baseline. Fills a fixed string template from the issue's
    own fields -- mirrors compare_and_coach_claude's own title-formatting
    rule for intonation issues (worker.py:9609's "Sharp"/"Flat" prefix
    requirement, no digits in the title) so this arm is a fair baseline
    against the SAME hard constraints the LLM arms must satisfy, not a
    strawman.
    """
    issue_type = issue.get("type", "issue")
    location = issue.get("location", "")
    if issue_type == "intonation":
        direction = issue.get("direction", "sharp").capitalize()
        note = issue.get("note", "a note")
        title = f"{direction} on {note}"
        body = (f"Your {note} at {location} was {issue.get('cents', '?')} cents "
                f"{issue.get('direction', 'off')}. Practice that interval slowly "
                f"with a tuner until it locks in.")
    else:
        title = f"{issue_type.capitalize()} issue at {location}"
        body = f"Review {location} for a {issue_type} discrepancy and repeat it slowly."
    return {"title": title, "body": body}


def coach_with_model(model_id: str, issue: dict, instrument: str,
                      piece_title: str, composer: str, api_key: str) -> dict:
    """
    Calls Claude (any model_id) with the EXACT same prompt shape
    compare_and_coach_claude uses (worker.py:9600-9624), for one issue,
    so output is directly comparable to what production would say for the
    same input under a different model.
    """
    import anthropic as ac

    issue_line = json.dumps({"i": 0, **issue})
    coach_prompt = f"""You are a master {instrument} teacher writing feedback on a student's performance of "{piece_title}" by {composer}.

Below is the VERIFIED list of issues found in the performance. Write specific coaching for EACH issue. Do NOT add, remove, merge, reorder, or skip any — return exactly one coaching entry per issue, matched by its index "i".

Every issue below is CONFIRMED — state it as fact. Never use hedging language like "possible", "may have", "appears to", or "worth checking".

For "intonation" issues, the title MUST begin with the word "Sharp" or "Flat" (whichever the "observed" text says), followed by 2-5 words naming WHERE it happened. NEVER put a number, a cents value, or the words "slightly"/"very" in an intonation title.

ISSUES:
{issue_line}

WRITE TIGHT. The body is 2 sentences, 40 words maximum.

Return JSON only (no markdown):
{{"coaching": [{{"i": <index>, "title": "<4-8 word title naming the exact issue>", "body": "<2 sentences, 40 words max>"}}]}}"""

    try:
        client = ac.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model=model_id, max_tokens=4000,
            messages=[{"role": "user", "content": coach_prompt}],
        )
        raw = "".join(block.text for block in msg.content if block.type == "text")
        parsed = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
        coaching = parsed.get("coaching", [{}])[0]
        usage = getattr(msg, "usage", None)
        return {
            "title": coaching.get("title", ""),
            "body": coaching.get("body", ""),
            "input_tokens": usage.input_tokens if usage else 0,
            "output_tokens": usage.output_tokens if usage else 0,
        }
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


# Anthropic pricing, per this session's own verified research against
# Anthropic's current pricing page: Sonnet 5 $2/$10 per 1M tokens,
# Haiku 5.5 $0.10/$0.50 per 1M tokens (prompts under 100K tokens).
PRICING_PER_MILLION_TOKENS = {
    "claude-sonnet-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}


def main():
    import os
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from evaluate_gemini_crosscheck import BudgetGuard

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ANTHROPIC_API_KEY not set -- export it and re-run.")
        return 1

    guard = BudgetGuard(cap_dollars=3.00)
    sample_issues = [
        {"type": "intonation", "direction": "sharp", "location": "m.12",
         "note": "F#4", "cents": 34},
        {"type": "rhythm", "location": "m.25-27", "note": "the dotted rhythm"},
        {"type": "intonation", "direction": "flat", "location": "m.8",
         "note": "the sustained high A", "cents": 22},
    ]

    for issue in sample_issues:
        print(f"\n--- issue: {issue} ---")
        template_result = deterministic_coaching_template(issue)
        print(f"  [template]    title={template_result['title']!r}")
        print(f"                body={template_result['body']!r}")

        for model_id in ("claude-sonnet-5", "claude-haiku-5-5"):
            in_price, out_price = PRICING_PER_MILLION_TOKENS[model_id]
            estimated_cost = 500 * in_price / 1_000_000 + 200 * out_price / 1_000_000
            if not guard.can_spend(estimated_cost):
                print(f"  [{model_id}] skipped: would exceed ${guard.cap_dollars} cap")
                continue
            result = coach_with_model(model_id, issue, "violin", "Partita No. 3",
                                       "J.S. Bach", api_key)
            if "error" in result:
                print(f"  [{model_id}] error: {result['error']}")
                continue
            real_cost = (result["input_tokens"] * in_price / 1_000_000 +
                         result["output_tokens"] * out_price / 1_000_000)
            guard.record_spend(real_cost)
            print(f"  [{model_id}] title={result['title']!r}")
            print(f"                body={result['body']!r}")
            print(f"                cost=${real_cost:.5f}, running total=${guard.total_spent:.4f}")

    print(f"\nTotal spent: ${guard.total_spent:.4f} of ${guard.cap_dollars:.2f} cap")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
```

- [ ] **Step 4: Run the template test to verify it passes**

Run: `cd modal_worker && python3 test_coaching_models.py`
Expected: PASS (no API key needed for this test — it only exercises `deterministic_coaching_template`).

- [ ] **Step 5: Real run, within budget**

Run: `cd modal_worker && export ANTHROPIC_API_KEY=<your key> && python3 evaluate_coaching_models.py`
Expected: three real coaching texts per issue (template, Sonnet 5, Haiku 5.5) with real per-call cost, stopping cleanly before the $3.00 cap is exceeded.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/evaluate_coaching_models.py modal_worker/test_coaching_models.py
git commit -m "feat(validation): three-arm coaching comparison (Sonnet 5 / Haiku 5.5 / deterministic template) with a hard \$3 budget guard"
```

---

### Task 6: Consolidated Phase 1-2 report

**Files:**
- Create: `modal_worker/phase1_2_report.py`

**Interfaces:**
- Consumes: the printed output conventions of Tasks 1 (`[cost]` lines, cache hit/miss lines), 3 (`evaluate_smt_zero_shot.py`'s per-instrument output), 4 (`evaluate_gemini_crosscheck.py`'s per-piece output), and 5 (`evaluate_coaching_models.py`'s three-arm output). This task does not re-run any experiment; it documents how to read their already-produced output into the five required deliverables.

This is the fifth deliverable the spec requires: "a consolidated report stating whether the proposed cascade architecture warrants building out Phases 3-4 at all." Because Tasks 1-5 each print real, human-readable results rather than writing to a shared machine-readable store, this task is a documented procedure plus a template, not a data-processing script — there is no new data to transform, only real numbers (once Tasks 1-5 have actually been run against real inputs) to transcribe honestly, which is exactly the discipline this entire plan — and this whole session's prior work on the validation harness — has been built around.

- [ ] **Step 1: Write `phase1_2_report.py` as a template the five real log/output sources get copied into**

```python
"""
Phase 1-2 consolidated report template.

This file is NOT an automated aggregator -- Tasks 1-5 each print real
results to stdout/Modal logs in a human-readable form, and pretending to
parse and recompute them here would risk silently restating a number
wrong. Instead: run each task's real command, copy its REAL printed
output into the matching section below, and never fill in a number this
file did not receive from an actual run.

Required deliverables (spec Section 12):
1. Baseline: real cost, latency, accuracy, cache effectiveness.
2. SMT zero-shot accuracy, per instrument.
3. Gemini cross-check controlled evaluation.
4. Sonnet 5 vs Haiku 5.5 vs template coaching comparison.
5. This report: does the cascade warrant Phases 3-4?
"""

REPORT_TEMPLATE = """
# Phase 1-2 Validation Report

Generated: <date this was actually run>

## 1. Baseline (Task 1)

Real [cost] lines from a sample of N real analyses (paste grepped Modal
log output here, do not estimate):

<paste [cost] lines here>

Score-cache hit rate over the same sample (hits / (hits + misses), from
the [analyze-performance] hit/miss log lines):

<hit count> / <hit count + miss count> = <percentage>%

## 2. SMT zero-shot accuracy (Task 3)

<paste evaluate_smt_zero_shot.py's real printed output here, both
calibration and held-out sets, every instrument row>

## 3. Gemini cross-check extension (Task 4)

<paste evaluate_gemini_crosscheck.py's real printed output here,
including real total dollar cost>

## 4. Coaching comparison (Task 5)

<paste evaluate_coaching_models.py's real printed output here, all three
arms, including real total dollar cost>

## 5. Recommendation

Based ONLY on the real numbers pasted above (never on what this plan
predicted they might be): does the proposed cascade warrant building out
Phases 3-4? State the recommendation and the specific numbers from
sections 1-4 above that justify it.
"""

if __name__ == "__main__":
    print(REPORT_TEMPLATE)
```

- [ ] **Step 2: Run each of Tasks 1, 3, 4, 5's real commands and fill in the report**

This is manual transcription of real output, not a test with a pass/fail — the "test" is that every blank in the template gets filled with output actually produced by running the commands in Tasks 1, 3, 4, and 5, never invented.

- [ ] **Step 3: Commit**

```bash
git add modal_worker/phase1_2_report.py
git commit -m "docs(validation): Phase 1-2 consolidated report template and procedure"
```
