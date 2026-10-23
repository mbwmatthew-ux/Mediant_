# Visual Score-Reading Validation Harness — Design

Status: approved by user, ready for implementation plan.
Scope confirmed with the user: **score-reading accuracy (OMR/vision)** —
whether the pipeline correctly extracts notes/measures from an uploaded
page. Explicitly NOT the on-screen highlight/overlay UI (OSMD coordinate
calibration, the "sheet music annotation layer" backlog item) — that is a
separate, un-scoped initiative.

## 1. Problem

The audio side of this pipeline (CREPE pitch-tracking) has a real-corpus
validation harness (`modal_worker/validate_alignment_against_musicnet.py`)
that measures actual accuracy before and after every change, currently at
65.4% on the 24-piece MusicNet solo Bach corpus. Score-reading accuracy
(`read_score_notes_claude`, the Claude-vision + Audiveris pipeline that
turns a photographed/PDF page into measures and notes) has **no
equivalent**. `agent_workspace/ACCURACY_BASELINE.md` confirms this
explicitly: no corpus has ever been scored, no precision/recall number
exists anywhere, and the existing measurement plan is gated on teacher
annotations that do not exist yet (0 annotations on 199+ real takes, per
the 2026-10-11 product audit). Any accuracy fix to the visual-reading side
today ships unverified — exactly the blind spot that bit the audio side
before MusicNet existed (see the reverted first attempt at provenance-
based event collapse, 2026-10-12/13).

This harness closes that gap without waiting on teacher annotations: it
builds its own ground truth by construction, the same way the audio side
used a corpus with independently-known-correct labels.

## 2. Why MusicNet, and why it works for this despite being audio data

MusicNet (`/Users/matthewwu/.cache/mediant_validation/data`, already on
disk from the audio validation work) is 24 real solo Bach pieces
(violin/cello/flute), each with a MIDI file whose metadata confirms
`"Solo <Instrument>"` for all 24 — no ensembles, confirmed by direct
inspection of `musicnet_metadata.csv`.

Investigated and confirmed directly (not assumed) before writing this
spec:

- **The MIDI note values are already notation-quality, not raw
  expressive performance capture.** Sampled quarterLength distributions
  across 5 pieces cluster entirely on simple fractions (0.25, 0.5, 1.0,
  1.5, 2.0 quarter notes) with no messy/unquantized values. No
  quantization step is needed before notating.
- **Every piece carries an embedded, usable time signature** —
  confirmed on 6 sampled pieces (3/4, 4/4, pickup 1/4→4/4, etc.) —
  so `music21`'s `.makeMeasures()` can build correct measure boundaries
  with no external metadata.
- **`music21`'s MIDI import splits each piece into 1-4 "parts," but
  only one is real.** Confirmed across all 24 pieces: one part always
  has dramatically more notes than the rest (e.g. piece 2186: 1375 vs.
  265; piece 2297: 1293 vs. 49/5/3). The smaller parts are MIDI-encoding
  artifacts — a duplicated tempo-automation track (confirmed: both
  "parts" of piece 2186 carried the identical 66 tempo-change events)
  and/or sparse ornament realizations — not real second voices. Since
  every piece is confirmed solo, **"keep only the part with the most
  notes, discard the rest" is a safe, universal rule**, not a
  piece-specific hack.
- **Tempo-automation events must be stripped before notating.**
  Rendered without stripping, piece 2186 produced a page with a second,
  mostly-empty staff cluttered with ~66 visible `□ = 120`-style tempo
  boxes (one of music21's `MetronomeMark` objects per automation event)
  — not something a real printed score would show, and visual noise
  that has nothing to do with what the OMR pipeline is being tested on.
  Stripping all `MetronomeMark` elements from the selected part before
  `.makeMeasures()` produces a clean single staff. Verified by direct
  re-render (see `/tmp/2186_page1_clean.png` during design): legible,
  correctly beamed, real-looking engraving matching Bach's Partita No.
  3 Preludio (BWV1006), which is piece 2186's actual identity per
  `musicnet_metadata.csv`.

## 3. Architecture — three stages

```
MIDI (MusicNet)
  -> music21.parse
  -> select part with max note count
  -> strip MetronomeMark elements
  -> .makeMeasures() [uses embedded TimeSignature]
  -> MusicXML (ground truth) ----------------------+
  -> verovio render -> SVG -> resvg_py -> clean PNG |
                                                      v
                                      [Stage 2: degrade]
                                                      |
                                                      v
                                            degraded PNG (clean/mild/severe)
                                                      |
                                                      v
                                      [Stage 3: score]
                read_score_notes_claude(degraded PNG)
                          |
                          v
          compare per-measure note lists vs. ground truth
          (same fingerprint the pipeline already uses for
           its own two-read reconciliation)
                          |
                          v
            % correct-measure-match, per image + aggregated
```

### Stage 1: Corpus build

New file: `modal_worker/build_visual_validation_corpus.py`. Run locally
(reuses the existing dedicated venv at
`/Users/matthewwu/.cache/mediant_validation/venv`, which already pins
`music21==9.1.0` matching the Modal worker image). Not part of the
production Modal image — this is a one-time-ish local tool, re-run only
when the corpus or degradation parameters change.

New dependencies for that venv (confirmed pip-installable, no system
libraries required — `cairosvg` was tried and rejected because it needs a
system `libcairo` not present on this machine; `verovio`+`resvg-py` need
nothing beyond their own wheels):

- `verovio==6.3.0` — MusicXML → SVG. `toolkit.loadFile(path)` then
  `toolkit.renderToSVG(page_number)` (1-indexed); `toolkit.getPageCount()`
  gives the page count for multi-page pieces.
- `resvg-py==0.5.0` — SVG → PNG. `resvg_py.svg_to_bytes(svg_string=svg)`
  returns a `list[int]`; write via `bytes(result)`.

Per-piece algorithm:

1. `score = music21.converter.parse(midi_path)`.
2. `real_part = max(score.parts, key=lambda p: len(list(p.flatten().notes)))`.
3. Remove every `MetronomeMark`:
   `for mm in list(real_part.flatten().getElementsByClass('MetronomeMark')): real_part.remove(mm, recurse=True)`.
4. `measured = real_part.makeMeasures()`.
5. Set a real title/composer on `measured.metadata` from
   `musicnet_metadata.csv` (composer, work, movement) — cosmetic, but
   verovio defaults to a placeholder ("1 Fragment") otherwise, which is
   confusing when inspecting output by eye.
6. `measured.write('musicxml', fp=<corpus_dir>/clean/<piece_id>.musicxml)`.
7. Render every page via verovio + resvg_py to
   `<corpus_dir>/clean/<piece_id>_page<N>.png`.
8. Extract ground truth by walking `measured`'s measures directly (NOT
   by re-parsing the written MusicXML — walk the same in-memory object
   that was written, so there is no second parse step that could
   introduce its own discrepancy). For each `Measure`, for each element
   in `measure.notesAndRests`, build exactly the dict shape the
   production pipeline itself already uses (see `worker.py:1510-1540`,
   `parse_musicxml`'s note-building block):
   ```python
   {
     "pitch": el.pitch.nameWithOctave if isinstance(el, m21.note.Note) else None,
     "is_rest": isinstance(el, m21.note.Rest),
     "beat": float(el.beat),
     "duration_beats": float(el.duration.quarterLength),
   }
   ```
   (`articulation`/`dynamic` are part of the production schema but are
   excluded from `_measure_fingerprint` already — omit them from ground
   truth too; scoring never needs them.)
9. Write ground truth to `<corpus_dir>/ground_truth.json`:
   `{piece_id: {"measures": [{"number": N, "notes": [...]}, ...], "n_pages": N}}`.

Chords: if a measure contains a chord (multiple simultaneous notes), the
schema above (one dict per `Note`) naturally produces multiple note-dicts
sharing the same `beat` — this already matches how the rest of the
codebase represents chords (see `worker.py`'s own note-building loop,
same pattern), so no special handling is needed.

### Stage 2: Degradation

New file: `modal_worker/degrade_visual_corpus.py`. Pure image
transforms (Pillow + numpy; no new dependencies beyond what the
validation venv may already have) applied to each clean PNG, producing
`<corpus_dir>/degraded/<tier>/<piece_id>_page<N>.png`. Three tiers:

- **`clean`** — the rendered page, untouched. Tests the pipeline's
  ceiling (can it read a perfect page at all).
- **`mild`** — small rotation (3-7°, applied as a genuine image
  rotation with NO corrective EXIF tag — directly reproducing the real
  EXIF-orientation bug's failure shape, not just "a rotated image"),
  mild perspective warp (simulates holding a phone slightly off-axis),
  mild brightness gradient (simulates uneven room lighting).
- **`severe`** — larger rotation (15-25°, plus a 25% chance of a full
  90°/180°/270° rotation with no corrective tag — the exact EXIF bug
  shape, at full severity), stronger perspective warp (simulates a
  phone held at a real angle over a music stand), a harsher lighting
  gradient plus mild Gaussian blur, and JPEG re-encoding at quality 60
  (compression artifacts).

Exact pixel-level transform parameters (rotation angle ranges, warp
matrix bounds, blur radius, JPEG quality) are an implementation detail
for the plan, not re-derived here — the tiers and their intent (what
real failure mode each one is modeling) are the design decision; the
plan should pick concrete values and a fixed random seed so the corpus
is reproducible run to run.

### Stage 3: Scoring

New file: `modal_worker/validate_score_reading_against_corpus.py`.
Calls the real `read_score_notes_claude` (same function production
uses — not a mock, not a simplified reader) against each corpus image,
using real Claude + Gemini + Audiveris. Requires real API keys supplied
locally — confirmed by direct inspection that none are retrievable by
tooling available in this environment: `worker.py` takes
`anthropic_api_key`/`gemini_key` as plain function/payload arguments,
never reads them from an env var or a Modal secret itself (`modal secret
list` returns zero secrets); the actual keys live only in Supabase
project secrets (`ANTHROPIC_API_KEY`, and whatever the Gemini key's name
is there — not found in any `supabase/functions/*` source, so it may be
named differently or passed through another path), which this session
has no read access to, the same constraint hit earlier with the
storage service-role key. **The plan must have the user supply both
keys locally** (e.g. exported in the validation venv's shell
environment before running Stage 3) — this is not resolvable by further
investigation.

For each piece/tier:

1. Run `read_score_notes_claude` on that tier's page image(s) for the
   piece.
2. For each measure number present in BOTH the result and the ground
   truth, compare via the production code's own
   `_measure_fingerprint(measure_dict)` — import it directly from
   `worker.py` rather than reimplementing comparison logic. Equal
   fingerprints = correct measure.
3. A measure in ground truth but missing from the result (unread page,
   failed OMR) counts as incorrect, not excluded — matching the audio
   side's convention that a failure to produce an answer is a wrong
   answer, not a missing data point.
4. Aggregate: `% correct-measure-match` per piece, per tier, and
   overall — same metric name and convention as the audio side's
   headline number, so the two are comparable at a glance.

### Anchor cases (real, not synthetic)

New directory: `modal_worker/visual_validation_anchors/` — a small,
manually curated set of real examples already known to have caused
production failures (starting with the EXIF-rotation clarinet case from
the 2026-10-01 fix). Each anchor has its own hand-verified
`ground_truth.json` entry (same schema as above) and is scored the same
way as the synthetic corpus, but reported **by name**, separate from the
aggregate percentage — mirrors how pieces 2186/2293 are tracked
individually on the audio side rather than folded into one number.

## 4. Cost policy

Unlike the audio harness (CREPE, fully local, free to run repeatedly),
every validation run here costs real money (Claude vision + Gemini +
Audiveris per image). Full matrix: 24 pieces × 3 tiers × (however many
pages each piece renders to, typically 1-7) — not cheap to run on every
iteration.

- **Fast iteration**: a fixed 5-6 piece subset (short pieces, one page
  each) for day-to-day tuning.
- **Checkpoint/gate**: the full 24-piece × 3-tier matrix, run only
  before committing a change that's expected to move the number — same
  "spike cheap, validate properly before shipping" discipline used on
  the audio side all session.
- The plan should hardcode the fast-iteration subset (explicit piece
  IDs) rather than leaving it to be picked ad hoc each time, so repeated
  runs are comparable.

## 5. Error handling

- Corpus build: if `verovio` fails to load/render a piece's MusicXML
  (malformed output from an edge-case score), skip that piece with a
  clear log line and continue — do not let one bad piece abort the
  whole corpus build.
- Scoring: if `read_score_notes_claude` raises or returns an error
  structure for a given image, record that piece/tier as 0% for the
  measures it was supposed to cover (a crash is a failure to read, not
  a missing data point) — except for a transient-looking API error
  (timeout, rate limit), which gets one retry before being counted as a
  real failure.

## 6. Testing strategy

- Pure-Python, no-API unit tests (added to `modal_worker/test_analysis.py`
  or a new `test_visual_validation.py`, following this repo's existing
  `check()`-harness convention): the ground-truth extraction logic
  (given a small hand-built `music21` Stream, does it produce the right
  note dicts), the scoring/aggregation math (given canned predicted vs.
  ground-truth measure dicts, does it compute the right percentage), and
  each degradation transform (does "rotate 20°" actually rotate the
  image by a verifiable amount, does the perspective warp move corner
  pixels where expected).
- No unit test can cover "does Claude correctly read this page" — that
  is inherently a real-API measurement, exactly like CREPE's real-corpus
  gate on the audio side. The harness's own correctness is unit-tested;
  the pipeline's accuracy is measured by running it for real.

## 7. Out of scope (explicitly, per the scoping conversation)

- The on-screen highlight/overlay UI (OSMD coordinate calibration, the
  unbuilt "sheet music annotation layer" for photo/PDF scores). A
  correct measure-read and a correctly *displayed* highlight are two
  different failure surfaces; this harness only measures the former.
- Any change to `read_score_notes_claude` itself. This spec is the
  measurement tool only — it does not fix accuracy, it makes future
  accuracy fixes verifiable, the same role MusicNet played for the
  audio side before any pitch-tracking fix landed.
- Real photographed (non-synthetic) test images beyond the small anchor
  set — building a larger real-photo corpus is calendar-time-gated
  (someone has to take the photos), not an engineering task, and is
  future work if the synthetic-degradation tiers turn out not to
  predict real-world failures well.

## Global Constraints (for the implementation plan)

- No new dependency may require a system library beyond what `pip`
  installs (confirmed: `verovio`, `resvg-py` both satisfy this;
  `cairosvg` was evaluated and rejected for needing system `libcairo`).
- Ground-truth note dicts use exactly the production schema
  (`pitch`/`is_rest`/`beat`/`duration_beats`, `pitch` as
  `nameWithOctave` or `None`) — no new schema invented.
- Scoring reuses `_measure_fingerprint` imported from `worker.py`, not
  a reimplementation.
- "Part selection = most notes" and "strip all `MetronomeMark`
  elements" apply uniformly to all 24 pieces — no piece-specific
  special-casing.
- This harness and its corpus live outside the production Modal image;
  nothing in this spec changes `worker.py`'s deployed behavior.
- Every run's result must report the metric as `% correct-measure-match`
  per piece, per tier, and overall, plus the anchor cases by name —
  matching the audio side's reporting convention.
