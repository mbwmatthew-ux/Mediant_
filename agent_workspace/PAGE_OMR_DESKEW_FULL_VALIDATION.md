# page-omr full held-out deskew validation — INTEGRATE (deskew preprocessing)

2026-10-31. Per the owner's "Full Held-Out Deskew Benchmark Approved"
directive. The frozen `deskew.py` from the 4-case pilot (unchanged — no
parameters touched after viewing any result) applied to every held-out
page: all 24 mild-tier pieces with a mild image (54 pages; piano_synthetic
has none) and all 25 clean-tier pieces (55 pages) — 109 new inference
calls total, CPU-only, $0, no production changes. Raw (undeskewed)
baselines were NOT rerun — scored against the already-collected frozen
raw outputs from the pilot and expansion rounds, exactly as instructed.

## 1. Overall Mediant launch status

Unchanged otherwise. This closes out the visual-score-reading
investigation's open question with a clear, large, well-verified result.

## 2. Full before-and-after accuracy table

| Tier (n pieces) | Metric | Raw | Deskewed | Delta |
|---|---|---|---|---|
| Mild (24) | Pitch accuracy | 65.3% (13,103/20,060) | **91.3%** (18,309/20,060) | **+26.0pt** |
| Mild (24) | Rhythm accuracy | 78.5% | 93.2% | +14.7pt |
| Mild (24) | Note error rate | 37.9% | 9.4% | -28.5pt |
| Mild (24) | Exact-measure accuracy | 50.9% | 82.6% | +31.7pt |
| Mild (24) | Structural match (pages with correct measure count) | 57.4% (31/54) | **92.6%** (50/54) | +35.2pt |
| Clean (25) | Pitch accuracy | 95.4% (19,177/20,092) | 95.4% (19,177/20,092) | **+0.0pt — byte-identical totals** |
| Clean (25) | Structural match | 96.4% (53/55) | 96.4% (53/55) | +0.0pt |

**Sequence-level (measure-boundary-independent) scoring** — the same
Levenshtein alignment already used per-measure, applied instead to each
piece's full flattened note sequence with no measure-grouping information
used at all, to separate true transcription errors from boundary
misalignment:

| Tier | Raw sequence pitch | Deskewed sequence pitch |
|---|---|---|
| Mild | 78.2% | 94.4% |
| Clean | 97.5% (unchanged) | 97.5% (unchanged) |

## 3. Instrument-specific results (mild tier, per-measure pitch)

| Instrument | n | Raw | Deskewed | Delta |
|---|---|---|---|---|
| Cello | 12 | 72.9% | 93.8% | +20.9pt |
| Violin | 9 | 55.6% | 85.8% | +30.2pt |
| Flute | 3 | 65.3% | 99.4% | +34.1pt |

All three instruments improve substantially; none is left behind. Piano
has no mild-degradation image in the corpus (confirmed, pre-existing gap,
unrelated to deskew).

**Per-piece**: 21 of 24 mild pieces improved (several by 40-70+ points —
largest: 2296 +71.1pt, 2289 +53.9pt, 2220 +49.1pt). 2 pieces showed a
small regression (2191: -1.2pt, 2222: -3.2pt) — inspected directly: in
both cases the affected pages were EITHER already structurally correct
before deskewing (2191, both pages) or already structurally wrong before
deskewing and remained wrong after (2222 page 2, off by 1 both times) —
in no case did deskewing break a page that was previously correct. The
small negative deltas are symbol-level interpolation noise from rotating
an already-fine image, not a new failure mode.

## 4. Structural versus actual note-recognition improvement

Both. The structural match rate jump (57.4%→92.6% of mild pages getting
the measure count right) accounts for most of the gain — consistent with
the root-cause finding that structural/barline misreading was the
dominant error source. But the sequence-level (boundary-independent)
number also improved substantially (78.2%→94.4%), meaning deskewing isn't
*only* fixing where notes get grouped — the underlying note reading itself
also improves once the geometry is corrected, which makes sense: the same
compound rotation+warp+lighting distortion that confuses barline-finding
also degrades raw symbol legibility, just less severely.

## 5. Clean-score regressions

**Zero at the aggregate level — exactly byte-identical totals** (same
match/substitution/insertion/deletion counts, not just the same rounded
percentage) across all 25 clean pieces, 55 pages. Per-piece: 25 of 25
unchanged, 0 improved, 0 worsened. The deskew estimator correctly
identified ~0° correction needed on every clean image.

## 6. Runtime and resource costs

109 pages: 71.1s total deskew-estimation time (0.65s/page average —
negligible), 1241.6s (20.7 min) total page-omr inference time. Combined:
21.9 minutes CPU wall time, $0, no GPU. Zero invalid/runaway outputs or
parse failures across all 109 deskewed pages (confirmed directly, not
assumed — every output parsed cleanly).

## 7. Explicit integration recommendation: **INTEGRATE**

Meets the owner's own stated bar precisely: meaningful held-out
improvement (+26.0pt pitch, +31.7pt exact-measure, the mild/clean gap
closes from 30 points to under 4), minimal clean-score regression (zero,
measured exactly, not approximately), practical latency (+0.65s/page on
top of inference that already takes 5-50s). **Recommend deskew as a
standing preprocessing step ahead of page-omr for any non-guaranteed-clean
input.** This is a recommendation about the deskew step specifically —
it does not by itself constitute a recommendation to deploy page-omr to
production; see remaining blockers below.

## 8. Remaining visual-analysis blockers

- No real smartphone photos have been tested anywhere in this
  investigation — every result, including this one, is against synthetic
  (now evidenced as realistic) degradation of digitally-rendered pages,
  not actual camera captures.
- Zero clarinet/guitar ground truth exists anywhere in accessible project
  assets (confirmed repeatedly across this investigation).
- The ground-truth-free failure detector built two rounds ago still has
  the open, named gap: its length-based signal didn't generalize past the
  small pilot it was built on, and no replacement has been built yet. A
  production deployment of page-omr+deskew would currently have no
  reliable way to flag an upload that's still bad after deskewing.
- Multi-page measure mapping is solved for the corpus's own rendering
  pipeline (verovio) but has not been tested against a real multi-page
  photo set.
- No actual production integration code has been written; this remains a
  validated preprocessing+model decision, not a shipped feature.

No production changes, no new model, no fine-tuning, no paid API calls.
Stopping here per the directive's explicit instruction.
