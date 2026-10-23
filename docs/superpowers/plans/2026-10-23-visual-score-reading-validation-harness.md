# Visual Score-Reading Validation Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a ground-truth validation harness that measures how accurately `read_score_notes_claude` (the Claude-vision + Audiveris score-reading pipeline) extracts notes/measures from a sheet-music page, closing the "no measurement exists" gap documented in `agent_workspace/ACCURACY_BASELINE.md`.

**Architecture:** Three local scripts outside the production Modal image, run in the dedicated validation venv (`/Users/matthewwu/.cache/mediant_validation/venv`). Stage 1 renders the existing 24-piece MusicNet corpus to clean sheet-music pages with self-consistent ground truth (via `music21` + `verovio` + `resvg-py`). Stage 2 applies synthetic degradation modeling confirmed real failure modes (EXIF rotation, perspective skew, lighting, blur/compression). Stage 3 runs the real `read_score_notes_claude` against every image and scores it using the production code's own `_measure_fingerprint` comparison.

**Tech Stack:** Python 3.13, `music21==9.1.0`, `verovio==6.3.0`, `resvg-py==0.5.0`, `Pillow==13.0.0`, `numpy==1.26.4`, Modal SDK `1.6.2` (real, authenticated — the deployed `mediant-worker` app is used for Audiveris dispatch).

**Spec:** `docs/superpowers/specs/2026-10-23-visual-score-reading-validation-harness-design.md`

## Global Constraints

- No new dependency may require a system library beyond what `pip` installs. `verovio` and `resvg-py` both satisfy this (confirmed); do not substitute `cairosvg` (needs system `libcairo`, confirmed absent on this machine).
- Ground-truth note dicts use exactly the production schema: `{"pitch": <nameWithOctave or None>, "is_rest": <bool>, "beat": <float>, "duration_beats": <float>}` — copied from `worker.py`'s own `parse_musicxml` note-building block (currently `worker.py:1510-1540`; re-grep `el.pitch.nameWithOctave` before citing a line number, it drifts). No new schema invented.
- Scoring reuses `_measure_fingerprint` imported directly from `worker.py` (currently `worker.py:5531`; re-grep `^def _measure_fingerprint`), never reimplemented.
- "Part selection = most notes" and "strip all `MetronomeMark` elements" apply uniformly to all 24 pieces — no piece-specific special-casing anywhere in this plan's code.
- Everything in this plan lives outside the production Modal image (`modal_worker/*.py` new files, not touching `worker.py`'s deployed behavior) except for *importing* `worker.py` to reuse its functions.
- Every validation run's result reports `% correct-measure-match` per piece, per tier, and overall, plus anchor cases by name.
- Calling `read_score_notes_claude` for real (Stage 3) requires wrapping the call in `with w.app.run():` — confirmed by direct test: a bare `w.run_audiveris_on_row.spawn(...)` call fails with `ExecutionError: Function has not been hydrated...because the App it is defined on is not running`; wrapping in `with w.app.run():` fixes it and dispatches for real against the deployed `mediant-worker` Modal app.
- Stage 3 needs the user to supply `ANTHROPIC_API_KEY` and a Gemini key as real environment variables before running — neither is retrievable by any tool in this environment (confirmed: `worker.py` takes them as plain arguments, never reads an env var or Modal secret itself; `modal secret list` is empty; the real values live only in Supabase project secrets this session can't read).
- The real clarinet-photo anchor case (`modal_worker/testdata/real_photo_sideways_exif_portrait.jpg`) is **out of scope for this plan** by the user's explicit choice — this plan builds and proves the anchor-case *mechanism* only, against a small fixture whose ground truth is trivially and confidently correct. Populating the real photo's ground truth is deferred, explicitly, to a follow-up.

---

### Task 1: Corpus-build core — part selection and tempo-mark stripping

**Files:**
- Create: `modal_worker/build_visual_validation_corpus.py`
- Create: `modal_worker/test_visual_validation.py`

**Interfaces:**
- Produces: `select_real_part(score: music21.stream.Score) -> music21.stream.Part` — returns the part with the most notes.
- Produces: `strip_tempo_marks(part: music21.stream.Part) -> None` — removes all `MetronomeMark` elements from `part` in place.

- [ ] **Step 1: Write the failing tests**

Create `modal_worker/test_visual_validation.py`:

```python
"""
Ground-truth tests for the visual score-reading validation harness
(modal_worker/build_visual_validation_corpus.py, degrade_visual_corpus.py,
validate_score_reading_against_corpus.py).

Run:  python3 modal_worker/test_visual_validation.py

Unlike test_analysis.py, this file does NOT stub music21/numpy/Pillow —
it requires the real packages (music21==9.1.0, verovio==6.3.0,
resvg-py==0.5.0, Pillow==13.0.0, numpy==1.26.4), the same way
validate_alignment_against_musicnet.py requires the real torch/torchcrepe
stack. Run it inside the dedicated validation venv:

  source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
  python3 modal_worker/test_visual_validation.py

See docs/superpowers/specs/2026-10-23-visual-score-reading-validation-harness-design.md
for why this corpus/approach exists.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import music21
import build_visual_validation_corpus as bvc

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    return ok


def _make_two_part_score_with_tempo_marks():
    """
    A tiny Score with 2 parts: part 0 has 6 notes (the "real" line), part 1
    has 2 notes (a sparse artifact track) plus 3 MetronomeMark events on
    EACH part — mirroring exactly what was found on real MusicNet piece
    2186 (1375 vs 265 notes, both parts carrying the identical 66 tempo
    events).
    """
    score = music21.stream.Score()

    real_part = music21.stream.Part()
    real_part.append(music21.meter.TimeSignature('4/4'))
    for name in ["C4", "D4", "E4", "F4", "G4", "A4"]:
        real_part.append(music21.note.Note(name, quarterLength=1.0))
    for beat_offset, bpm in [(0.0, 120), (2.0, 110), (4.0, 100)]:
        mm = music21.tempo.MetronomeMark(number=bpm)
        real_part.insert(beat_offset, mm)

    artifact_part = music21.stream.Part()
    artifact_part.append(music21.meter.TimeSignature('4/4'))
    artifact_part.append(music21.note.Note("C2", quarterLength=2.0))
    artifact_part.append(music21.note.Note("C2", quarterLength=2.0))
    for beat_offset, bpm in [(0.0, 120), (2.0, 110), (4.0, 100)]:
        mm = music21.tempo.MetronomeMark(number=bpm)
        artifact_part.insert(beat_offset, mm)

    score.insert(0, real_part)
    score.insert(0, artifact_part)
    return score, real_part, artifact_part


def test_select_real_part_picks_the_part_with_more_notes():
    print("\n[1] select_real_part picks the part with dramatically more "
          "notes, matching the pattern confirmed on all 24 real MusicNet "
          "pieces (one dominant part, the rest are MIDI-encoding "
          "artifacts) — never the first part by position.")
    score, real_part, artifact_part = _make_two_part_score_with_tempo_marks()
    # Insert the artifact part FIRST in the score's parts ordering, so a
    # bug that just picks score.parts[0] would wrongly select it.
    picked = bvc.select_real_part(score)
    check("picks the 6-note part, not the 2-note part",
          picked is real_part, f"picked {len(list(picked.flatten().notes))}-note part")


def test_strip_tempo_marks_removes_every_metronome_mark():
    print("\n[2] strip_tempo_marks removes ALL MetronomeMark elements from "
          "a part, not just the first — reproducing the fix that turned "
          "piece 2186's page from a second staff cluttered with ~66 tempo "
          "boxes into a clean single staff.")
    score, real_part, artifact_part = _make_two_part_score_with_tempo_marks()
    before = len(list(real_part.flatten().getElementsByClass('MetronomeMark')))
    check("fixture actually has tempo marks before stripping", before == 3, str(before))
    bvc.strip_tempo_marks(real_part)
    after = len(list(real_part.flatten().getElementsByClass('MetronomeMark')))
    check("zero tempo marks remain after stripping", after == 0, str(after))
    notes_after = len(list(real_part.flatten().notes))
    check("stripping tempo marks does not remove any actual notes",
          notes_after == 6, str(notes_after))


def main():
    print("=" * 70)
    print("Visual score-reading validation harness — ground truth tests")
    print("=" * 70)
    for t in (test_select_real_part_picks_the_part_with_more_notes,
              test_strip_tempo_marks_removes_every_metronome_mark):
        try:
            t()
        except Exception as e:                                  # noqa: BLE001
            import traceback
            RESULTS.append((t.__name__, False, f"{type(e).__name__}: {e}"))
            print(f"  ERROR {t.__name__}: {type(e).__name__}: {e}")
            traceback.print_exc()
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print("\n" + "=" * 70)
    print(f"{passed}/{len(RESULTS)} checks passed")
    failed = [(n, d) for n, ok, d in RESULTS if not ok]
    for n, d in failed:
        print(f"  FAILED: {n}  {d}")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `ModuleNotFoundError: No module named 'build_visual_validation_corpus'` (the module doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `modal_worker/build_visual_validation_corpus.py`:

```python
"""
Stage 1 of the visual score-reading validation harness: renders the
existing MusicNet corpus (/Users/matthewwu/.cache/mediant_validation/data)
to clean sheet-music page images with self-consistent, known-correct
ground truth.

NOT part of the production Modal image — a local tool, run in the
dedicated validation venv (same category as validate_alignment_against_
musicnet.py). See docs/superpowers/specs/2026-10-23-visual-score-reading-
validation-harness-design.md for the full design and the direct
investigation (part-selection rule, tempo-mark stripping, rendering
toolchain) that grounds every choice below.

Usage:
    python3 build_visual_validation_corpus.py \\
        --data-dir /Users/matthewwu/.cache/mediant_validation/data \\
        --out-dir /Users/matthewwu/.cache/mediant_validation/visual_corpus
"""
import argparse
import csv
import json
import os
from pathlib import Path

import music21


def select_real_part(score: "music21.stream.Score") -> "music21.stream.Part":
    """
    Returns the Part with the most notes.

    music21's MIDI import of a MusicNet piece splits it into 1-4 "parts",
    but confirmed across all 24 real pieces (all independently confirmed
    "Solo <Instrument>" in musicnet_metadata.csv, no ensembles): exactly
    one part is the real musical line, always with a dramatic note-count
    lead over the rest (e.g. piece 2186: 1375 vs. 265; piece 2297: 1293
    vs. 49/5/3). The smaller parts are MIDI-encoding artifacts — on piece
    2186, both of its 2 parts carried the identical 66 MetronomeMark
    tempo-automation events, confirming the smaller part is a duplicated
    automation track, not a real second voice.
    """
    return max(score.parts, key=lambda p: len(list(p.flatten().notes)))


def strip_tempo_marks(part: "music21.stream.Part") -> None:
    """
    Removes every MetronomeMark from `part`, in place.

    Rendered without stripping, these tempo-automation events (one per
    MIDI tempo-change event, carried over from the original performance's
    expressive timing) show up as a visible "[] = NNN" box above the
    staff for EVERY event — confirmed on piece 2186: ~66 of them, turning
    a clean page into a second, mostly-empty staff cluttered with tempo
    boxes. A real printed score does not show this; it has nothing to do
    with what the OMR pipeline under test is being measured on.
    """
    for mm in list(part.flatten().getElementsByClass('MetronomeMark')):
        part.remove(mm, recurse=True)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `2/2 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/build_visual_validation_corpus.py modal_worker/test_visual_validation.py
git commit -m "feat(visual-validation): part selection and tempo-mark stripping"
```

---

### Task 2: Ground-truth extraction from a measured Part

**Files:**
- Modify: `modal_worker/build_visual_validation_corpus.py`
- Modify: `modal_worker/test_visual_validation.py`

**Interfaces:**
- Consumes: nothing new from Task 1 (operates on any `music21.stream.Part`/`Stream`).
- Produces: `extract_ground_truth_measures(measured: music21.stream.Stream) -> list[dict]` — returns `[{"number": int, "notes": [note_dict, ...]}, ...]`, where each `note_dict` is `{"pitch": str|None, "is_rest": bool, "beat": float, "duration_beats": float}` — exactly the production schema from `worker.py`'s `parse_musicxml`.

- [ ] **Step 1: Write the failing test**

Append to `modal_worker/test_visual_validation.py` (add the import and test, then register it in `main()`):

```python
def _make_measured_part_with_a_rest_and_an_accidental():
    """2 measures in 4/4: measure 1 has a rest then 3 quarter notes
    (one with a sharp), measure 2 has a single whole note."""
    part = music21.stream.Part()
    part.append(music21.meter.TimeSignature('4/4'))
    part.append(music21.note.Rest(quarterLength=1.0))
    part.append(music21.note.Note("C4", quarterLength=1.0))
    part.append(music21.note.Note("F#4", quarterLength=1.0))
    part.append(music21.note.Note("G4", quarterLength=1.0))
    part.append(music21.note.Note("D5", quarterLength=4.0))
    return part.makeMeasures()


def test_extract_ground_truth_measures_matches_production_schema():
    print("\n[3] extract_ground_truth_measures produces exactly the same "
          "note-dict shape worker.py's own parse_musicxml does "
          "(pitch/is_rest/beat/duration_beats, pitch as nameWithOctave or "
          "None for a rest) — not a new, separately-invented schema. "
          "Sharp spelling ('F#4', not 'Gb4') must survive untouched, "
          "matching music21's own nameWithOctave convention.")
    measured = _make_measured_part_with_a_rest_and_an_accidental()
    measures = bvc.extract_ground_truth_measures(measured)

    check("two measures extracted", len(measures) == 2, str(len(measures)))
    m1, m2 = measures[0], measures[1]
    check("measure numbers are 1 and 2",
          m1["number"] == 1 and m2["number"] == 2,
          f"{m1['number']}, {m2['number']}")

    check("measure 1 has 4 note/rest entries", len(m1["notes"]) == 4, str(len(m1["notes"])))
    rest, c4, fs4, g4 = m1["notes"]
    check("rest entry: is_rest True, pitch None, beat 1.0",
          rest["is_rest"] is True and rest["pitch"] is None and rest["beat"] == 1.0,
          str(rest))
    check("sharp spelling preserved exactly ('F#4')",
          fs4["pitch"] == "F#4", fs4["pitch"])
    check("duration_beats is the music21 quarterLength, not beat-scaled",
          c4["duration_beats"] == 1.0, str(c4["duration_beats"]))
    check("beat positions are 1-indexed within the measure",
          rest["beat"] == 1.0 and c4["beat"] == 2.0 and fs4["beat"] == 3.0 and g4["beat"] == 4.0,
          f"{[n['beat'] for n in m1['notes']]}")

    check("measure 2 has 1 note entry (the whole note)",
          len(m2["notes"]) == 1, str(len(m2["notes"])))
    check("whole note duration_beats is 4.0",
          m2["notes"][0]["duration_beats"] == 4.0, str(m2["notes"][0]["duration_beats"]))
```

Register `test_extract_ground_truth_measures_matches_production_schema` in `main()`'s tuple, after the two existing tests.

- [ ] **Step 2: Run the test to verify it fails**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `AttributeError: module 'build_visual_validation_corpus' has no attribute 'extract_ground_truth_measures'`.

- [ ] **Step 3: Write the minimal implementation**

Append to `modal_worker/build_visual_validation_corpus.py`:

```python
def extract_ground_truth_measures(measured: "music21.stream.Stream") -> list:
    """
    Walks `measured` (the output of a Part's .makeMeasures()) and builds
    ground truth in EXACTLY worker.py's own note-dict shape (see
    parse_musicxml's note-building block, currently worker.py:1510-1540 —
    re-grep `el.pitch.nameWithOctave` before trusting that line number,
    it drifts). This is not a new schema: `beat` is music21's own
    `.beat` property, `duration_beats` is music21's own
    `.duration.quarterLength` (confirmed directly in worker.py: "a
    music21 quarterLength, despite the name").

    Confirmed by direct inspection of all 24 real MusicNet pieces after
    this pipeline's part-selection + tempo-stripping + makeMeasures:
    every measure's notesAndRests is a flat, monophonic sequence (zero
    Chord objects, zero Voice objects, zero simultaneous-offset Note
    pairs found across a 60-measure sample of the most chord-prone piece,
    Cello Suite 3's Prelude). Chord handling below is a defensive
    fallback for a shape never actually observed in this corpus, not a
    load-bearing assumption.
    """
    import music21 as m21

    out = []
    for measure in measured.getElementsByClass('Measure'):
        notes_out = []
        for el in measure.notesAndRests:
            if isinstance(el, m21.note.Rest):
                notes_out.append({
                    "pitch": None,
                    "is_rest": True,
                    "beat": float(el.beat),
                    "duration_beats": float(el.duration.quarterLength),
                })
            elif isinstance(el, m21.chord.Chord):
                # Defensive: not observed in this corpus (see docstring),
                # but a Chord's constituent pitches would otherwise be
                # silently dropped.
                for p in el.pitches:
                    notes_out.append({
                        "pitch": p.nameWithOctave,
                        "is_rest": False,
                        "beat": float(el.beat),
                        "duration_beats": float(el.duration.quarterLength),
                    })
            elif isinstance(el, m21.note.Note):
                notes_out.append({
                    "pitch": el.pitch.nameWithOctave,
                    "is_rest": False,
                    "beat": float(el.beat),
                    "duration_beats": float(el.duration.quarterLength),
                })
        out.append({"number": measure.number, "notes": notes_out})
    return out
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `3/3 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/build_visual_validation_corpus.py modal_worker/test_visual_validation.py
git commit -m "feat(visual-validation): ground-truth extraction matching worker.py's note schema"
```

---

### Task 3: Rendering (MusicXML → SVG → PNG) and the per-piece pipeline function

**Files:**
- Modify: `modal_worker/build_visual_validation_corpus.py`
- Modify: `modal_worker/test_visual_validation.py`

**Interfaces:**
- Consumes: `select_real_part`, `strip_tempo_marks`, `extract_ground_truth_measures` from Tasks 1-2.
- Produces: `render_musicxml_to_pngs(musicxml_path: str, out_prefix: str) -> list[str]` — renders every page, returns the list of written PNG paths. `build_corpus_entry(piece_id: str, midi_path: str, metadata_row: dict, out_dir: Path) -> dict` — runs the full per-piece pipeline (steps 1-9 from the spec), returns `{"n_pages": int, "measures": [...]}` (the ground-truth entry for this piece) or `None` on failure.

- [ ] **Step 1: Write the failing test**

Append to `modal_worker/test_visual_validation.py`:

```python
import tempfile


def test_render_musicxml_to_pngs_produces_legible_nonempty_pages():
    print("\n[4] render_musicxml_to_pngs actually produces image files — "
          "a smoke test, not a pixel-content check (verovio+resvg-py's "
          "rendering fidelity was already confirmed by eye during "
          "spec-writing: /tmp/2186_page1_clean.png). This only proves "
          "the wiring (verovio load -> renderToSVG -> resvg_py "
          "svg_to_bytes -> file write) works end to end.")
    part = music21.stream.Part()
    part.append(music21.meter.TimeSignature('4/4'))
    for name in ["C4", "D4", "E4", "F4"]:
        part.append(music21.note.Note(name, quarterLength=1.0))
    measured = part.makeMeasures()

    with tempfile.TemporaryDirectory() as tmp:
        mxl_path = os.path.join(tmp, "test.musicxml")
        measured.write("musicxml", fp=mxl_path)
        out_prefix = os.path.join(tmp, "test")
        pngs = bvc.render_musicxml_to_pngs(mxl_path, out_prefix)

        check("at least one page rendered", len(pngs) >= 1, str(len(pngs)))
        for p in pngs:
            check(f"page file exists and is non-trivially sized: {os.path.basename(p)}",
                  os.path.exists(p) and os.path.getsize(p) > 1000,
                  f"{os.path.getsize(p) if os.path.exists(p) else 'MISSING'} bytes")


def test_build_corpus_entry_end_to_end_on_a_real_musicnet_piece():
    print("\n[5] build_corpus_entry runs the full Stage-1 pipeline on a "
          "REAL MusicNet piece (2191, the shortest solo-violin piece, "
          "539 notes) — part selection, tempo-mark stripping, "
          "makeMeasures, MusicXML write, rendering, and ground-truth "
          "extraction, in one call. This is the piece-level unit the "
          "corpus-build CLI (Task 4) loops over.")
    data_dir = os.environ.get(
        "VISUAL_VALIDATION_DATA_DIR",
        "/Users/matthewwu/.cache/mediant_validation/data")
    midi_path = os.path.join(data_dir, "midis", "2191.mid")
    if not os.path.exists(midi_path):
        check("SKIPPED (MusicNet corpus not present at " + data_dir + ")", True)
        return

    metadata_row = None
    with open(os.path.join(data_dir, "musicnet_metadata.csv")) as f:
        for row in csv.DictReader(f):
            if row["id"] == "2191":
                metadata_row = row
                break
    check("metadata row found for piece 2191", metadata_row is not None)

    with tempfile.TemporaryDirectory() as tmp:
        entry = bvc.build_corpus_entry("2191", midi_path, metadata_row, Path(tmp))
        check("entry was built (not None)", entry is not None)
        check("at least one measure extracted", len(entry["measures"]) > 0,
              str(len(entry.get("measures", []))))
        check("n_pages matches the number of rendered PNGs on disk",
              entry["n_pages"] == len(list(Path(tmp).glob("2191_page*.png"))),
              f"n_pages={entry['n_pages']}, files={list(Path(tmp).glob('2191_page*.png'))}")
        check("no measure has zero notes AND zero rests "
              "(a genuinely empty measure would signal a broken extraction)",
              all(len(m["notes"]) > 0 for m in entry["measures"]),
              str([m["number"] for m in entry["measures"] if not m["notes"]]))
```

Add `import csv` is already present at module level from Task 4's needs below — for this step, add `import csv` and `from pathlib import Path` to the top of `test_visual_validation.py` alongside the existing imports. Register both new tests in `main()`'s tuple.

- [ ] **Step 2: Run the test to verify it fails**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `AttributeError: module 'build_visual_validation_corpus' has no attribute 'render_musicxml_to_pngs'`.

- [ ] **Step 3: Write the minimal implementation**

Add to the top of `modal_worker/build_visual_validation_corpus.py` (after the existing imports):

```python
import verovio
import resvg_py
```

Append to `modal_worker/build_visual_validation_corpus.py`:

```python
def render_musicxml_to_pngs(musicxml_path: str, out_prefix: str) -> list:
    """
    Renders every page of `musicxml_path` to `{out_prefix}_page{N}.png`
    (1-indexed), returning the written paths.

    verovio only renders to SVG natively (confirmed: no renderToPNG/
    renderToBitmap method exists on its toolkit); resvg-py does the
    SVG->PNG step. Both install as prebuilt wheels with zero system
    library dependencies (confirmed on this machine) — cairosvg was
    tried first and rejected for needing a system libcairo that isn't
    present.
    """
    tk = verovio.toolkit()
    ok = tk.loadFile(musicxml_path)
    if not ok:
        return []
    paths = []
    for page_num in range(1, tk.getPageCount() + 1):
        svg = tk.renderToSVG(page_num)
        png_bytes = bytes(resvg_py.svg_to_bytes(svg_string=svg))
        out_path = f"{out_prefix}_page{page_num}.png"
        with open(out_path, "wb") as f:
            f.write(png_bytes)
        paths.append(out_path)
    return paths


def build_corpus_entry(piece_id: str, midi_path: str, metadata_row: dict, out_dir: "Path") -> dict | None:
    """
    Runs the full Stage-1 pipeline for one MusicNet piece:
      1. Parse the MIDI.
      2. Select the real part (select_real_part).
      3. Strip tempo-automation events (strip_tempo_marks).
      4. Build measures (.makeMeasures()).
      5. Set title/composer on the result's metadata, from
         `metadata_row` (musicnet_metadata.csv's own columns:
         composer/composition/movement) — cosmetic, but verovio
         defaults to a placeholder title ("1 Fragment") otherwise.
      6. Write MusicXML to `{out_dir}/{piece_id}.musicxml`.
      7. Render every page to `{out_dir}/{piece_id}_page{N}.png`.
      8. Extract ground truth from the SAME measured Stream that was
         written and rendered (not a re-parse of the written file) —
         image and ground truth are self-consistent by construction.

    Returns {"n_pages": int, "measures": [...]} on success, or None on
    any failure — the caller (Task 4's CLI loop) is responsible for
    logging and skipping, matching the "one bad piece must not abort
    the whole corpus build" error-handling rule from the spec.
    """
    try:
        score = music21.converter.parse(midi_path)
        real_part = select_real_part(score)
        strip_tempo_marks(real_part)
        measured = real_part.makeMeasures()

        measured.metadata = music21.metadata.Metadata()
        measured.metadata.title = f"{metadata_row['composition']} - {metadata_row['movement']}"
        measured.metadata.composer = metadata_row['composer']

        mxl_path = str(out_dir / f"{piece_id}.musicxml")
        measured.write('musicxml', fp=mxl_path)

        out_prefix = str(out_dir / piece_id)
        pngs = render_musicxml_to_pngs(mxl_path, out_prefix)
        if not pngs:
            print(f"[build_visual_validation_corpus] piece {piece_id}: "
                  f"verovio produced zero pages, skipping")
            return None

        measures = extract_ground_truth_measures(measured)
        return {"n_pages": len(pngs), "measures": measures}
    except Exception as e:                                       # noqa: BLE001
        print(f"[build_visual_validation_corpus] piece {piece_id}: "
              f"FAILED ({type(e).__name__}: {e}), skipping")
        return None
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `5/5 checks passed` (test [5] runs for real against the MusicNet corpus already on disk at `/Users/matthewwu/.cache/mediant_validation/data`; it self-skips with a passing check if that directory isn't present, so it also works in an environment without the corpus).

- [ ] **Step 5: Commit**

```bash
git add modal_worker/build_visual_validation_corpus.py modal_worker/test_visual_validation.py
git commit -m "feat(visual-validation): MusicXML rendering and the per-piece corpus-build pipeline"
```

---

### Task 4: Corpus-build CLI — run it for real against all 24 pieces

**Files:**
- Modify: `modal_worker/build_visual_validation_corpus.py`

**Interfaces:**
- Consumes: `build_corpus_entry` from Task 3.
- Produces: a `main()` CLI entrypoint; on disk, `{out_dir}/clean/` populated with `.musicxml` + `_page{N}.png` files per piece, and `{out_dir}/ground_truth.json`.

- [ ] **Step 1: Write the implementation**

Append to `modal_worker/build_visual_validation_corpus.py`:

```python
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default="/Users/matthewwu/.cache/mediant_validation/data",
                         help="Directory containing midis/ and musicnet_metadata.csv")
    parser.add_argument("--out-dir", default="/Users/matthewwu/.cache/mediant_validation/visual_corpus",
                         help="Directory to write clean/ and ground_truth.json into")
    parser.add_argument("--limit", type=int, default=None,
                         help="Only process the first N pieces (for fast iteration)")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    out_dir = Path(args.out_dir) / "clean"
    out_dir.mkdir(parents=True, exist_ok=True)

    metadata_by_id = {}
    with open(data_dir / "musicnet_metadata.csv") as f:
        for row in csv.DictReader(f):
            metadata_by_id[row["id"]] = row

    midi_paths = sorted((data_dir / "midis").glob("*.mid"))
    if args.limit:
        midi_paths = midi_paths[:args.limit]

    ground_truth = {}
    n_ok, n_failed = 0, 0
    for midi_path in midi_paths:
        piece_id = midi_path.stem
        metadata_row = metadata_by_id.get(piece_id)
        if metadata_row is None:
            print(f"[build_visual_validation_corpus] piece {piece_id}: "
                  f"no metadata row, skipping")
            n_failed += 1
            continue
        entry = build_corpus_entry(piece_id, str(midi_path), metadata_row, out_dir)
        if entry is None:
            n_failed += 1
            continue
        ground_truth[piece_id] = entry
        n_ok += 1
        print(f"[build_visual_validation_corpus] piece {piece_id}: "
              f"OK ({entry['n_pages']} pages, {len(entry['measures'])} measures)")

    gt_path = Path(args.out_dir) / "ground_truth.json"
    gt_path.parent.mkdir(parents=True, exist_ok=True)
    with open(gt_path, "w") as f:
        json.dump(ground_truth, f, indent=2)

    print(f"\n{n_ok} pieces built, {n_failed} skipped. "
          f"Ground truth written to {gt_path}")
    return 0 if n_ok > 0 else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
```

- [ ] **Step 2: Run it for real against the full MusicNet corpus**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/build_visual_validation_corpus.py
```

Expected: `24 pieces built, 0 skipped.` (if any piece fails, inspect its printed error — a failure here is a real finding, not something to silently ignore before moving to Task 5). Spot-check at least one rendered page by eye (e.g. open `/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean/2217_page1.png`) to confirm it looks like legible, single-staff sheet music with no stray second staff or tempo-box clutter — matching what was already confirmed for piece 2186 during spec-writing.

- [ ] **Step 3: Commit**

```bash
git add modal_worker/build_visual_validation_corpus.py
git commit -m "feat(visual-validation): corpus-build CLI entrypoint"
```

(The generated `visual_corpus/` directory itself lives in `/Users/matthewwu/.cache/mediant_validation/`, outside the repo — same convention as the existing MusicNet `data/` directory. Do not commit it.)

---

### Task 5: Degradation transforms

**Files:**
- Create: `modal_worker/degrade_visual_corpus.py`
- Modify: `modal_worker/test_visual_validation.py`

**Interfaces:**
- Produces: `rotate_no_exif(img: PIL.Image.Image, degrees: float) -> PIL.Image.Image`, `perspective_warp(img: PIL.Image.Image, corner_displacement_frac: float, rng: random.Random) -> PIL.Image.Image`, `lighting_gradient(img: PIL.Image.Image, dark_factor: float, light_factor: float) -> PIL.Image.Image`, `gaussian_blur(img: PIL.Image.Image, radius: float) -> PIL.Image.Image`, `recompress_jpeg(img: PIL.Image.Image, quality: int) -> PIL.Image.Image`.

- [ ] **Step 1: Write the failing test**

Append to `modal_worker/test_visual_validation.py` (add `import degrade_visual_corpus as dvc` near the top, next to the `build_visual_validation_corpus` import, and `from PIL import Image`):

```python
def _make_test_image():
    """A 200x200 white image with a black square in the top-left quadrant
    — enough asymmetry to detect rotation/warp/lighting effects by eye
    (via pixel sampling) without needing real sheet-music content."""
    img = Image.new("RGB", (200, 200), "white")
    for x in range(20, 80):
        for y in range(20, 80):
            img.putpixel((x, y), (0, 0, 0))
    return img


def test_rotate_no_exif_actually_rotates_the_pixels():
    print("\n[6] rotate_no_exif rotates the IMAGE CONTENT (not just an "
          "EXIF tag) — this is what makes the mild/severe tiers reproduce "
          "the real EXIF-orientation bug's failure shape: a page that is "
          "genuinely sideways in its pixel data, with no corrective tag "
          "to undo it, exactly like the real clarinet photo "
          "(real_photo_sideways_exif_portrait.jpg).")
    img = _make_test_image()
    rotated = dvc.rotate_no_exif(img, 90.0)
    # A 90-degree rotation of a top-left black square moves it toward the
    # top-right (PIL's rotate() is counter-clockwise by default).
    check("rotated image has no unexpected EXIF orientation tag",
          rotated.getexif().get(274) in (None, 1),
          str(rotated.getexif().get(274)))
    top_left_now_white = rotated.getpixel((40, 40)) == (255, 255, 255) \
        or sum(rotated.getpixel((40, 40))) > 600
    check("the black square is no longer in the top-left after a 90-degree rotation",
          top_left_now_white, str(rotated.getpixel((40, 40))))


def test_lighting_gradient_is_asymmetric():
    print("\n[7] lighting_gradient darkens one side and brightens the "
          "other — simulating a phone photo taken under an angled light "
          "or a lamp, not a uniform brightness shift (a uniform shift "
          "would not stress the pipeline's readability scoring the same "
          "way a real uneven-lighting photo does).")
    img = Image.new("RGB", (200, 200), (128, 128, 128))
    graded = dvc.lighting_gradient(img, dark_factor=0.5, light_factor=1.5)
    left = graded.getpixel((10, 100))
    right = graded.getpixel((190, 100))
    check("left and right edges differ in brightness",
          sum(left) != sum(right), f"left={left} right={right}")


def test_gaussian_blur_reduces_sharp_edges():
    print("\n[8] gaussian_blur actually softens a sharp edge (not a "
          "no-op) — simulating an out-of-focus phone photo.")
    img = _make_test_image()
    blurred = dvc.gaussian_blur(img, radius=3.0)
    # Sample a pixel right on the square's edge: sharp = pure black or
    # white, blurred = somewhere in between.
    edge_val = sum(blurred.getpixel((80, 50))) / 3
    check("the square's edge is no longer pure black or pure white",
          20 < edge_val < 235, str(edge_val))


def test_recompress_jpeg_changes_the_bytes():
    print("\n[9] recompress_jpeg actually re-encodes through JPEG "
          "(introducing real compression artifacts), not a pass-through.")
    img = _make_test_image()
    recompressed = dvc.recompress_jpeg(img, quality=60)
    check("recompressed image decodes to the same size",
          recompressed.size == img.size, str(recompressed.size))
    # JPEG is lossy even on a simple two-tone image at quality 60 —
    # at least one pixel inside the black square should drift off pure
    # black due to compression artifacts.
    drifted = any(recompressed.getpixel((x, 50)) != (0, 0, 0) for x in range(25, 75))
    check("JPEG compression introduced at least some pixel drift inside "
          "the solid black region", drifted)
```

Register tests `[6]`-`[9]` in `main()`'s tuple.

- [ ] **Step 2: Run the test to verify it fails**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `ModuleNotFoundError: No module named 'degrade_visual_corpus'`.

- [ ] **Step 3: Write the minimal implementation**

Create `modal_worker/degrade_visual_corpus.py`:

```python
"""
Stage 2 of the visual score-reading validation harness: applies
synthetic degradation to Stage 1's clean rendered pages, modeling
confirmed real failure modes (EXIF rotation, perspective skew, uneven
lighting, blur/compression).

NOT part of the production Modal image. See
docs/superpowers/specs/2026-10-23-visual-score-reading-validation-harness-design.md
for the tier design (clean/mild/severe) and what each transform models.

Usage:
    python3 degrade_visual_corpus.py \\
        --corpus-dir /Users/matthewwu/.cache/mediant_validation/visual_corpus \\
        --seed 42
"""
import argparse
import io
import random
from pathlib import Path

from PIL import Image, ImageFilter


def rotate_no_exif(img: "Image.Image", degrees: float) -> "Image.Image":
    """
    Rotates the image's actual pixel content by `degrees`, with NO
    corrective EXIF orientation tag written — this is the exact failure
    shape of the real EXIF-orientation bug (a phone stores the photo
    sensor-native plus a rotation tag; the bug was that nothing applied
    the tag, so every pixel-axis-dependent step scanned the wrong axis).
    Here we skip the tag entirely rather than writing-then-not-applying
    one, which is a strictly harder case for the pipeline to recover
    from (it also has nothing to correct against) and matches the
    degraded corpus's purpose: stress-test the read, not the EXIF
    handling specifically.
    """
    rotated = img.rotate(degrees, expand=True, fillcolor="white")
    exif = rotated.getexif()
    exif.pop(274, None)  # 274 = Orientation tag; ensure it's absent, not just 1.
    return rotated


def perspective_warp(img: "Image.Image", corner_displacement_frac: float, rng: "random.Random") -> "Image.Image":
    """
    Applies a perspective transform that displaces each of the 4 corners
    by up to `corner_displacement_frac` of the image's width/height, in a
    random direction — simulating a phone held at a slight angle over a
    music stand (what dewarp_row exists to correct).
    """
    w, h = img.size
    dx = int(w * corner_displacement_frac)
    dy = int(h * corner_displacement_frac)

    def jitter(x, y):
        return x + rng.randint(-dx, dx), y + rng.randint(-dy, dy)

    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [jitter(*p) for p in src]

    # PIL's QUAD transform maps a quadrilateral in the SOURCE image to
    # the output rectangle — the coefficients need the quad expressed as
    # the 4 corners (counter-clockwise from top-left) that should map to
    # the full output rectangle, i.e. `dst` describes where to SAMPLE
    # FROM, so warping the output means passing `dst` as the quad.
    return img.transform((w, h), Image.QUAD, sum(dst, ()), fillcolor="white")


def lighting_gradient(img: "Image.Image", dark_factor: float, light_factor: float) -> "Image.Image":
    """
    Multiplies pixel brightness by a linear gradient from `dark_factor`
    (left edge) to `light_factor` (right edge) — simulating a photo taken
    under an angled light source or window, not a uniform exposure shift.
    """
    import numpy as np
    arr = np.asarray(img).astype(np.float32)
    w = arr.shape[1]
    gradient = np.linspace(dark_factor, light_factor, w).reshape(1, w, 1)
    arr = np.clip(arr * gradient, 0, 255).astype("uint8")
    return Image.fromarray(arr)


def gaussian_blur(img: "Image.Image", radius: float) -> "Image.Image":
    """Simulates an out-of-focus phone photo."""
    return img.filter(ImageFilter.GaussianBlur(radius=radius))


def recompress_jpeg(img: "Image.Image", quality: int) -> "Image.Image":
    """Round-trips the image through JPEG at `quality`, introducing real
    compression artifacts, then returns it decoded back to a PIL Image."""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality)
    buf.seek(0)
    return Image.open(buf).convert("RGB")
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `9/9 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/degrade_visual_corpus.py modal_worker/test_visual_validation.py
git commit -m "feat(visual-validation): synthetic degradation transforms"
```

---

### Task 6: Degradation tiers and CLI — run it for real against the clean corpus

**Files:**
- Modify: `modal_worker/degrade_visual_corpus.py`
- Modify: `modal_worker/test_visual_validation.py`

**Interfaces:**
- Consumes: the 5 transform functions from Task 5.
- Produces: `degrade_mild(img: PIL.Image.Image, rng: random.Random) -> PIL.Image.Image`, `degrade_severe(img: PIL.Image.Image, rng: random.Random) -> PIL.Image.Image`, a `main()` CLI entrypoint. On disk: `{corpus_dir}/degraded/mild/` and `{corpus_dir}/degraded/severe/`, each populated with one degraded PNG per clean page.

- [ ] **Step 1: Write the failing test**

Append to `modal_worker/test_visual_validation.py`:

```python
def test_degrade_mild_and_severe_are_deterministic_given_a_seed():
    print("\n[10] degrade_mild/degrade_severe are fully deterministic "
          "given the same random.Random seed — so the degraded corpus "
          "is reproducible run to run, not a fresh random draw every "
          "time the CLI is invoked.")
    img = _make_test_image()
    out_a = dvc.degrade_mild(img.copy(), random.Random(42))
    out_b = dvc.degrade_mild(img.copy(), random.Random(42))
    check("same seed produces byte-identical mild output",
          list(out_a.getdata()) == list(out_b.getdata()))

    out_c = dvc.degrade_severe(img.copy(), random.Random(42))
    out_d = dvc.degrade_severe(img.copy(), random.Random(42))
    check("same seed produces byte-identical severe output",
          list(out_c.getdata()) == list(out_d.getdata()))

    out_e = dvc.degrade_mild(img.copy(), random.Random(43))
    check("a different seed produces different mild output",
          list(out_a.getdata()) != list(out_e.getdata()))
```

Add `import random` to the top of `test_visual_validation.py` if not already present (it is, via `random.Random` usage above — add the bare `import random` alongside the other stdlib imports). Register the test in `main()`'s tuple.

- [ ] **Step 2: Run the test to verify it fails**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `AttributeError: module 'degrade_visual_corpus' has no attribute 'degrade_mild'`.

- [ ] **Step 3: Write the minimal implementation**

Append to `modal_worker/degrade_visual_corpus.py`:

```python
def degrade_mild(img: "Image.Image", rng: "random.Random") -> "Image.Image":
    """
    Mild tier: small rotation (3-7 degrees, random sign), mild
    perspective warp (2% corner displacement), mild lighting gradient
    (0.85x-1.15x). Simulates a reasonably careful phone photo: slightly
    off-angle, slightly uneven lighting.
    """
    degrees = rng.uniform(3, 7) * rng.choice([-1, 1])
    img = rotate_no_exif(img, degrees)
    img = perspective_warp(img, corner_displacement_frac=0.02, rng=rng)
    img = lighting_gradient(img, dark_factor=0.85, light_factor=1.15)
    return img


def degrade_severe(img: "Image.Image", rng: "random.Random") -> "Image.Image":
    """
    Severe tier: larger rotation (15-25 degrees, random sign), with a
    25% chance of a full 90/180/270-degree rotation instead (the exact
    EXIF-bug shape, at full severity), stronger perspective warp (6%
    corner displacement), harsher lighting gradient (0.6x-1.3x), mild
    blur, and JPEG recompression at quality 60.
    """
    if rng.random() < 0.25:
        degrees = rng.choice([90, 180, 270])
    else:
        degrees = rng.uniform(15, 25) * rng.choice([-1, 1])
    img = rotate_no_exif(img, degrees)
    img = perspective_warp(img, corner_displacement_frac=0.06, rng=rng)
    img = lighting_gradient(img, dark_factor=0.6, light_factor=1.3)
    img = gaussian_blur(img, radius=1.5)
    img = recompress_jpeg(img, quality=60)
    return img


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-dir", default="/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    corpus_dir = Path(args.corpus_dir)
    clean_dir = corpus_dir / "clean"
    clean_pngs = sorted(clean_dir.glob("*.png"))
    if not clean_pngs:
        print(f"[degrade_visual_corpus] no clean PNGs found in {clean_dir} "
              f"— run build_visual_validation_corpus.py first")
        return 1

    for tier_name, tier_fn in [("mild", degrade_mild), ("severe", degrade_severe)]:
        tier_dir = corpus_dir / "degraded" / tier_name
        tier_dir.mkdir(parents=True, exist_ok=True)
        rng = random.Random(args.seed)
        for clean_path in clean_pngs:
            img = Image.open(clean_path).convert("RGB")
            degraded = tier_fn(img, rng)
            out_path = tier_dir / clean_path.name
            degraded.convert("RGB").save(out_path, format="PNG")
        print(f"[degrade_visual_corpus] {tier_name}: "
              f"{len(clean_pngs)} pages written to {tier_dir}")

    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
```

- [ ] **Step 4: Run the test to verify it passes, then run it for real against the clean corpus**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `10/10 checks passed`.

```bash
python3 modal_worker/degrade_visual_corpus.py
```

Expected: both `mild:` and `severe:` lines reporting the same page count as the clean corpus (Task 4's run). Spot-check at least one mild and one severe image by eye (e.g. `/Users/matthewwu/.cache/mediant_validation/visual_corpus/degraded/severe/2217_page1.png`) to confirm the degradation is visible and the page is still a plausible "photo of sheet music," not unreadable noise.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/degrade_visual_corpus.py modal_worker/test_visual_validation.py
git commit -m "feat(visual-validation): degradation tiers (mild/severe) and CLI"
```

---

### Task 7: Scoring/comparison logic (pure, no API calls)

**Files:**
- Create: `modal_worker/validate_score_reading_against_corpus.py`
- Modify: `modal_worker/test_visual_validation.py`

**Interfaces:**
- Consumes: `_measure_fingerprint` imported from `worker.py` (re-grep `^def _measure_fingerprint` before citing a line number — currently `worker.py:5531`).
- Produces: `score_measures(predicted: list[dict], ground_truth: list[dict]) -> tuple[int, int]` — returns `(n_correct, n_total)`, where `n_total` is the number of ground-truth measures and a ground-truth measure with no matching predicted measure number counts as incorrect. `aggregate_scores(per_piece_results: dict) -> dict` — rolls up `{piece_id: (n_correct, n_total)}` into per-piece and overall percentages.

- [ ] **Step 1: Write the failing test**

Append to `modal_worker/test_visual_validation.py` (add `import validate_score_reading_against_corpus as vsrac` near the top):

```python
def test_score_measures_counts_exact_fingerprint_matches():
    print("\n[11] score_measures counts a measure as correct only when "
          "its predicted note list's _measure_fingerprint matches the "
          "ground truth's exactly — reusing worker.py's own comparison "
          "function (the same one the production pipeline uses to "
          "reconcile its own two independent Claude reads), not a new, "
          "separately-invented comparison.")
    ground_truth = [
        {"number": 1, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},
        {"number": 2, "notes": [{"pitch": "D4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},
        {"number": 3, "notes": [{"pitch": "E4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},
    ]
    predicted = [
        {"number": 1, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},  # correct
        {"number": 2, "notes": [{"pitch": "D#4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},  # wrong pitch
        # measure 3 entirely missing from the predicted result
    ]
    n_correct, n_total = vsrac.score_measures(predicted, ground_truth)
    check("1 of 3 ground-truth measures matched exactly",
          n_correct == 1 and n_total == 3, f"{n_correct}/{n_total}")


def test_aggregate_scores_computes_per_piece_and_overall_percentages():
    print("\n[12] aggregate_scores rolls up per-piece (n_correct, "
          "n_total) pairs into % correct-measure-match per piece and "
          "overall — the same metric name/convention as the audio "
          "side's headline number.")
    per_piece = {
        "2191": (8, 10),
        "2204": (3, 10),
    }
    result = vsrac.aggregate_scores(per_piece)
    check("piece 2191 is 80%", result["per_piece"]["2191"] == 80.0, str(result["per_piece"]["2191"]))
    check("piece 2204 is 30%", result["per_piece"]["2204"] == 30.0, str(result["per_piece"]["2204"]))
    check("overall is 11/20 = 55%", result["overall"] == 55.0, str(result["overall"]))
```

Register both tests in `main()`'s tuple.

- [ ] **Step 2: Run the test to verify it fails**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `ModuleNotFoundError: No module named 'validate_score_reading_against_corpus'`.

- [ ] **Step 3: Write the minimal implementation**

Create `modal_worker/validate_score_reading_against_corpus.py`:

```python
"""
Stage 3 of the visual score-reading validation harness: runs the real
read_score_notes_claude against Stage 1/2's corpus images and scores the
result against ground truth.

NOT part of the production Modal image. Requires real API keys (see
module-level REQUIRED_ENV_VARS below) and dispatches real Audiveris
calls against the deployed `mediant-worker` Modal app via `with
w.app.run():` — confirmed necessary by direct test: a bare
`w.run_audiveris_on_row.spawn(...)` call outside that context fails
with "Function has not been hydrated...because the App it is defined
on is not running."

See docs/superpowers/specs/2026-10-23-visual-score-reading-validation-harness-design.md
for the full design.

Usage:
    export ANTHROPIC_API_KEY=...
    export GEMINI_API_KEY=...
    python3 validate_score_reading_against_corpus.py \\
        --corpus-dir /Users/matthewwu/.cache/mediant_validation/visual_corpus \\
        --subset            # fast-iteration subset (5 pieces); omit for --full
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import worker as w  # noqa: E402 — needs the REAL modal/music21/etc. stack; run in the validation venv.

REQUIRED_ENV_VARS = ("ANTHROPIC_API_KEY", "GEMINI_API_KEY")

# Hardcoded for fast, comparable day-to-day iteration — the shortest
# piece from each of the 3 solo instruments in the corpus, plus 2 more
# for a little breadth. Checkpoint/gate runs use --full (all 24 pieces)
# instead. See the spec's "Cost policy" section for why this exists:
# every validation run here costs real Claude+Gemini+Audiveris API
# calls, unlike the audio side's fully-local CREPE harness.
FAST_ITERATION_SUBSET = ["2191", "2204", "2298", "2659", "2203"]


def score_measures(predicted: list, ground_truth: list) -> tuple:
    """
    Returns (n_correct, n_total). `n_total` is the number of ground-truth
    measures. A ground-truth measure number with no matching entry in
    `predicted` counts as incorrect, not excluded — a failure to produce
    an answer is a wrong answer, matching the audio side's convention.
    """
    predicted_by_number = {m["number"]: m for m in predicted}
    n_correct = 0
    for gt_measure in ground_truth:
        pred_measure = predicted_by_number.get(gt_measure["number"])
        if pred_measure is not None and \
                w._measure_fingerprint(pred_measure) == w._measure_fingerprint(gt_measure):
            n_correct += 1
    return n_correct, len(ground_truth)


def aggregate_scores(per_piece_results: dict) -> dict:
    """
    `per_piece_results`: {piece_id: (n_correct, n_total)}.
    Returns {"per_piece": {piece_id: pct}, "overall": pct}.
    """
    per_piece = {}
    total_correct, total_measures = 0, 0
    for piece_id, (n_correct, n_total) in per_piece_results.items():
        per_piece[piece_id] = round(100.0 * n_correct / n_total, 4) if n_total else 0.0
        total_correct += n_correct
        total_measures += n_total
    overall = round(100.0 * total_correct / total_measures, 4) if total_measures else 0.0
    return {"per_piece": per_piece, "overall": overall}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `12/12 checks passed`. (Importing `validate_score_reading_against_corpus` imports the real `worker.py`, which needs the real `modal`/`torch`/etc. stack — already installed in this venv.)

- [ ] **Step 5: Commit**

```bash
git add modal_worker/validate_score_reading_against_corpus.py modal_worker/test_visual_validation.py
git commit -m "feat(visual-validation): scoring logic reusing worker.py's _measure_fingerprint"
```

---

### Task 8: Stage 3 CLI — real API orchestration

**Files:**
- Modify: `modal_worker/validate_score_reading_against_corpus.py`

**Interfaces:**
- Consumes: `score_measures`, `aggregate_scores` from Task 7; `w.read_score_notes_claude`, `w.app` from `worker.py`.
- Produces: a `main()` CLI entrypoint that prints `% correct-measure-match` per piece, per tier, and overall.

- [ ] **Step 1: Write the implementation**

Append to `modal_worker/validate_score_reading_against_corpus.py`:

```python
def run_validation_for_piece_tier(piece_id: str, tier_dir: Path, ground_truth_entry: dict,
                                   anthropic_key: str, gemini_key: str) -> tuple:
    """
    Runs read_score_notes_claude against every page of `piece_id` in
    `tier_dir`, then scores the combined result's measures against
    ground truth. Returns (n_correct, n_total).

    `instrument`/`time_sig` are passed as read_score_notes_claude's
    own hints to the vision prompt, not used for scoring — "Violin" is
    a reasonable stand-in for every piece here (MusicNet's instruments
    are Violin/Cello/Flute; read_score_notes_claude's prompt does not
    change its note-extraction schema based on this hint, only its
    guidance text) rather than threading the real per-piece instrument
    through, since scoring only ever checks the extracted notes, not
    whether the instrument hint was used correctly — that is a
    different, not-yet-built type of test.
    """
    page_paths = sorted(tier_dir.glob(f"{piece_id}_page*.png"))
    if not page_paths:
        print(f"  [{piece_id}] no page images found in {tier_dir}, counted as a full miss")
        return 0, len(ground_truth_entry["measures"])

    pages = []
    for p in page_paths:
        with open(p, "rb") as f:
            pages.append((f.read(), "image/png"))

    result = _call_read_score_notes_with_one_retry(pages, anthropic_key, piece_id)
    if result is None:
        return 0, len(ground_truth_entry["measures"])

    predicted_measures = result.get("measures") or []
    return score_measures(predicted_measures, ground_truth_entry["measures"])


def _call_read_score_notes_with_one_retry(pages: list, anthropic_key: str, label: str) -> dict | None:
    """
    Calls read_score_notes_claude, retrying ONCE on any exception before
    giving up — per the spec's error-handling rule: "a transient-looking
    API error (timeout, rate limit) ... gets one retry before being
    counted as a real failure." This does not try to classify transient
    vs. permanent errors precisely (the spec doesn't define that
    boundary either); one retry on any failure is the simple version of
    that rule, and a second consecutive failure is treated as real.
    Returns None if both attempts fail.
    """
    for attempt in (1, 2):
        try:
            with w.app.run():
                return w.read_score_notes_claude(
                    pages=pages, start_measure=1, instrument="Violin",
                    time_sig="4/4", anthropic_api_key=anthropic_key)
        except Exception as e:                                   # noqa: BLE001
            print(f"  [{label}] attempt {attempt} raised "
                  f"{type(e).__name__}: {e}"
                  + (" — retrying once" if attempt == 1 else " — counted as a full miss"))
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-dir", default="/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    parser.add_argument("--full", action="store_true",
                         help="Score all 24 pieces instead of the fast-iteration subset")
    args = parser.parse_args()

    missing = [v for v in REQUIRED_ENV_VARS if not os.environ.get(v)]
    if missing:
        print(f"[validate_score_reading_against_corpus] missing required "
              f"env var(s): {', '.join(missing)} — set them and re-run.")
        return 1
    anthropic_key = os.environ["ANTHROPIC_API_KEY"]
    gemini_key = os.environ["GEMINI_API_KEY"]

    corpus_dir = Path(args.corpus_dir)
    with open(corpus_dir / "ground_truth.json") as f:
        ground_truth = json.load(f)

    piece_ids = sorted(ground_truth.keys()) if args.full else FAST_ITERATION_SUBSET
    tiers = {
        "clean": corpus_dir / "clean",
        "mild": corpus_dir / "degraded" / "mild",
        "severe": corpus_dir / "degraded" / "severe",
    }

    results_by_tier = {}
    for tier_name, tier_dir in tiers.items():
        per_piece_results = {}
        for piece_id in piece_ids:
            if piece_id not in ground_truth:
                print(f"  [{tier_name}/{piece_id}] no ground truth, skipping")
                continue
            n_correct, n_total = run_validation_for_piece_tier(
                piece_id, tier_dir, ground_truth[piece_id], anthropic_key, gemini_key)
            per_piece_results[piece_id] = (n_correct, n_total)
            print(f"  [{tier_name}/{piece_id}] {n_correct}/{n_total} measures correct")
        results_by_tier[tier_name] = aggregate_scores(per_piece_results)

    print("\n" + "=" * 70)
    print("Visual score-reading validation — % correct-measure-match")
    print("=" * 70)
    for tier_name, agg in results_by_tier.items():
        print(f"\n{tier_name}:")
        for piece_id, pct in agg["per_piece"].items():
            print(f"  {piece_id}: {pct}%")
        print(f"  OVERALL ({tier_name}): {agg['overall']}%")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Verify with the user before running**

This step costs real money (Claude vision + Gemini + Audiveris calls) and requires credentials this session cannot supply. Ask the user to export `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` in the validation venv's shell, then run:

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
export ANTHROPIC_API_KEY=...   # user supplies
export GEMINI_API_KEY=...      # user supplies
python3 modal_worker/validate_score_reading_against_corpus.py
```

(no `--full` — the fast-iteration subset, 5 pieces × 3 tiers, is the cheap first real run). Expected: a `% correct-measure-match` report for `clean`/`mild`/`severe`, each with 5 per-piece lines and an `OVERALL` line. This is the first real measurement this harness produces — there is no "expected number" to check against, since none has ever existed before (that is the entire point of this plan). Record whatever number comes out in `agent_workspace/ACCURACY_BASELINE.md` or a new note, as the harness's first real baseline.

If this step cannot be run in the current session (no credentials available), commit the code as-is and note clearly in the handoff that Task 8's CLI is implemented and unit-tested at the logic level (Task 7) but has never been run end-to-end against real APIs — do not claim a baseline number that was never measured.

- [ ] **Step 3: Commit**

```bash
git add modal_worker/validate_score_reading_against_corpus.py
git commit -m "feat(visual-validation): Stage 3 CLI — real read_score_notes_claude scoring"
```

---

### Task 9: Anchor-case infrastructure (mechanism only, per the user's explicit scoping decision)

**Files:**
- Modify: `modal_worker/validate_score_reading_against_corpus.py`
- Create: `modal_worker/visual_validation_anchors/README.md`
- Create: `modal_worker/visual_validation_anchors/proof_of_mechanism/ground_truth.json`
- Create: `modal_worker/visual_validation_anchors/proof_of_mechanism/page1.png`
- Modify: `modal_worker/test_visual_validation.py`

**Interfaces:**
- Produces: `load_anchor_cases(anchors_dir: Path) -> dict` — returns `{anchor_name: {"pages": [Path, ...], "ground_truth": {"measures": [...]}}}`.

- [ ] **Step 1: Build the proof-of-mechanism fixture**

The user explicitly chose, this session, to defer the real clarinet-photo anchor's ground truth (`modal_worker/testdata/real_photo_sideways_exif_portrait.jpg`, ~70 measures) to a separate follow-up, since transcribing it accurately from a photo is genuinely error-prone and the point of an anchor is to be trustworthy. This task proves the anchor-case *mechanism* (directory layout, loading, by-name scoring) against a small fixture this plan can make trivially, confidently correct: a single rendered page from the already-built Stage-1 corpus, whose ground truth is already known exactly (it was generated, not transcribed).

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
mkdir -p /Users/matthewwu/repos/mediant-ui-shell/modal_worker/visual_validation_anchors/proof_of_mechanism
python3 - <<'EOF'
import json
import shutil
from pathlib import Path

corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus")
anchors_dir = Path("/Users/matthewwu/repos/mediant-ui-shell/modal_worker/visual_validation_anchors/proof_of_mechanism")

with open(corpus_dir / "ground_truth.json") as f:
    ground_truth = json.load(f)

piece_id = "2191"  # the shortest piece, already confirmed to build cleanly in Task 4
entry = ground_truth[piece_id]
first_page_measures = [m for m in entry["measures"] if m["number"] <= 4]  # just the first page's worth

shutil.copy(corpus_dir / "clean" / f"{piece_id}_page1.png", anchors_dir / "page1.png")
with open(anchors_dir / "ground_truth.json", "w") as f:
    json.dump({"measures": first_page_measures}, f, indent=2)
EOF
```

Then create `modal_worker/visual_validation_anchors/README.md`:

```markdown
# Visual validation anchor cases

Real (or, for `proof_of_mechanism`, deterministically-generated) examples
scored individually by name, separate from the synthetic corpus's
aggregate percentage — mirrors how pieces 2186/2293 are tracked
individually on the audio side.

Each anchor is a directory containing `page{N}.png` file(s) and a
`ground_truth.json` with `{"measures": [...]}` in the same schema as the
main corpus.

## `proof_of_mechanism/`

NOT a real failure case. One page from the already-built MusicNet corpus
(piece 2191), whose ground truth is copied directly from
`ground_truth.json` rather than hand-transcribed. Exists only to prove
the anchor-loading/scoring mechanism works end to end with a fixture
that is trivially, confidently correct.

## Deferred: the real EXIF-rotation clarinet case

`modal_worker/testdata/real_photo_sideways_exif_portrait.jpg` is the real
photo that caused the 2026-10-01 EXIF-orientation bug (see that fix's
session note and `test_split_page_into_rows_recovers_real_systems_once_
orientation_is_fixed` in `test_analysis.py`, which already confirms the
STRUCTURAL bug — rows fragmenting, Audiveris returning zero measures —
but has no ground truth for the actual NOTE CONTENT).

Deliberately NOT added as an anchor in this plan: it's ~70 measures with
time-signature changes, dynamics, and accidentals, and an anchor's whole
value depends on its ground truth being trustworthy — a transcription
error here would silently make a correct vision-read look wrong, or vice
versa. Adding it is separate follow-up work, either by someone
transcribing/verifying it directly or by a slower, explicitly-flagged
pass through the photo.
```

- [ ] **Step 2: Write the failing test**

Append to `modal_worker/test_visual_validation.py`:

```python
def test_load_anchor_cases_finds_the_proof_of_mechanism_fixture():
    print("\n[13] load_anchor_cases discovers every subdirectory under "
          "visual_validation_anchors/ that has both a ground_truth.json "
          "and at least one page image, and loads them by name — the "
          "mechanism this plan commits to proving, even though the real "
          "clarinet-photo anchor's ground truth is explicitly deferred.")
    anchors_dir = Path(os.path.dirname(os.path.abspath(__file__))) / "visual_validation_anchors"
    anchors = vsrac.load_anchor_cases(anchors_dir)
    check("proof_of_mechanism anchor was discovered",
          "proof_of_mechanism" in anchors, str(list(anchors.keys())))
    entry = anchors["proof_of_mechanism"]
    check("it has at least one page image", len(entry["pages"]) >= 1, str(entry["pages"]))
    check("its ground truth has at least one measure",
          len(entry["ground_truth"]["measures"]) > 0,
          str(len(entry["ground_truth"].get("measures", []))))
```

Register the test in `main()`'s tuple.

- [ ] **Step 3: Run the test to verify it fails**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `AttributeError: module 'validate_score_reading_against_corpus' has no attribute 'load_anchor_cases'`.

- [ ] **Step 4: Write the minimal implementation**

Append to `modal_worker/validate_score_reading_against_corpus.py`:

```python
def load_anchor_cases(anchors_dir: Path) -> dict:
    """
    Discovers every subdirectory of `anchors_dir` containing a
    ground_truth.json and at least one page{N}.png, and loads them.
    Returns {anchor_name: {"pages": [Path, ...], "ground_truth": {...}}}.
    """
    anchors = {}
    if not anchors_dir.exists():
        return anchors
    for sub in sorted(anchors_dir.iterdir()):
        if not sub.is_dir():
            continue
        gt_path = sub / "ground_truth.json"
        pages = sorted(sub.glob("page*.png"))
        if not gt_path.exists() or not pages:
            continue
        with open(gt_path) as f:
            ground_truth = json.load(f)
        anchors[sub.name] = {"pages": pages, "ground_truth": ground_truth}
    return anchors
```

Also wire anchor scoring into `main()` (append after the per-tier loop, before the final report print):

```python
    anchors_dir = Path(os.path.dirname(os.path.abspath(__file__))) / "visual_validation_anchors"
    anchors = load_anchor_cases(anchors_dir)
    anchor_results = {}
    for name, anchor in anchors.items():
        pages = []
        for p in anchor["pages"]:
            with open(p, "rb") as f:
                pages.append((f.read(), "image/png"))
        result = _call_read_score_notes_with_one_retry(pages, anthropic_key, f"anchor/{name}")
        if result is None:
            n_correct, n_total = 0, len(anchor["ground_truth"]["measures"])
        else:
            n_correct, n_total = score_measures(result.get("measures") or [], anchor["ground_truth"]["measures"])
        pct = round(100.0 * n_correct / n_total, 4) if n_total else 0.0
        anchor_results[name] = pct
        print(f"  [anchor/{name}] {n_correct}/{n_total} measures correct ({pct}%)")
```

And print anchor results in the final report — insert this directly
BEFORE the existing final `print("=" * 70)` / `return 0` lines at the
very end of `main()` (do not add a second closing divider; replace
Task 8's single closing `print("=" * 70)` with this block, which ends
with its own):

```python
    print("\nanchors:")
    for name, pct in anchor_results.items():
        print(f"  {name}: {pct}%")
    print("=" * 70)
    return 0
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 modal_worker/test_visual_validation.py
```

Expected: `13/13 checks passed`.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/validate_score_reading_against_corpus.py \
        modal_worker/visual_validation_anchors/ \
        modal_worker/test_visual_validation.py
git commit -m "feat(visual-validation): anchor-case mechanism, proven against a generated fixture"
```

---

## Final verification

- [ ] Run the full unit suite one more time: `python3 modal_worker/test_visual_validation.py` — expect `13/13 checks passed`.
- [ ] Run the existing `python3 modal_worker/test_analysis.py` suite (in the plain repo checkout, no venv needed) to confirm nothing in `worker.py` itself was touched and the existing suite is unaffected.
- [ ] Confirm `/Users/matthewwu/.cache/mediant_validation/visual_corpus/` contains `clean/` (24 pieces' `.musicxml` + PNGs), `degraded/mild/`, `degraded/severe/`, and `ground_truth.json`.
- [ ] If Task 8's real-API run was completed, record the resulting `% correct-measure-match` numbers as this harness's first real baseline (new session note and/or an update to `agent_workspace/ACCURACY_BASELINE.md` noting this is a separate score-reading measurement, not the teacher-annotation-gated flag-precision baseline that document otherwise describes). If it was not run (no credentials available this session), say so explicitly rather than reporting a number.
