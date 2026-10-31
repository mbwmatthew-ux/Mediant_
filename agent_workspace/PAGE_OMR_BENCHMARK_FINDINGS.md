# page-omr five-piece benchmark — EXPAND TESTING

2026-10-30. Per the owner's "page-omr Benchmark Approved" directive. Downloaded
and verified (sha256 match against the HF-reported hash) the official
`tobiashornbogen/page-omr-a1-kern` checkpoint (737MB, MIT). Ran in an isolated
venv (`/private/tmp/.../scratchpad/page_omr_eval/venv`) — Mediant's production
dependencies were never touched. CPU-only, no paid APIs, no production changes.

## Environment fix (not a model finding)

page-omr's `pyproject.toml` pins only `transformers>=4.30.0` — an extremely
loose floor. The default `pip install -e .` resolved `transformers==5.22.1`
(latest), which silently breaks the bundled `transformers.Dinov2Model` encoder
badly enough that the decoder collapses into one repeated token ("1ryy", an
invisible whole rest) regardless of input image or checkpoint — confirmed on
3 different images across 2 different checkpoints, including page-omr's own
bundled `examples/sample_pages/sample.png`. Pinned `transformers==4.46.3`
(the same fix that resolved an analogous version-skew bug in this project's
earlier SMT investigation) — confirmed via the same bundled sample image:
real, well-formed two-staff kern output in 5.6s. This is a one-line pin, not
"extensive environment reconstruction."

## A real scoring bug caught before trusting any number

The first benchmark pass scored 0-12.5% pitch accuracy everywhere, which was
implausibly bad even for a weak model. Direct inspection (not assumed)
found the actual page-omr output for `piano_synthetic` was **musically
identical, note-for-note, to ground truth** — yet scored ~12%. Root cause:
music21's humdrum reader leaves `measure.number == 0` on every measure after
the first for a bare `=` barline (no explicit number), so 7 of 8 measures
collapsed onto one dict key and were discarded before scoring ever ran. Fixed
by renumbering measures 1..N by their real left-to-right order (safe — no
piece in this corpus starts at measure 0). Re-scored from the already-saved
raw kern files (no re-inference needed). **The numbers below are from the
fixed scorer; the first pass's numbers were wrong and are not used anywhere.**

## Scope: 5 pieces, not 6 — single-page only, disclosed

page-omr has no concept of multi-page continuation (each page image is an
independent sample to the model), and the existing corpus-build tooling
(`build_visual_validation_corpus.py`) never records which ground-truth
measure numbers land on which rendered page — verovio decides pagination
internally and that mapping isn't persisted anywhere. Guessing an offset to
stitch a continuation page's locally-renumbered output onto ground truth's
continuous numbering would risk silently wrong scores. Restricted to the
corpus's 5 single-page pieces instead: Piano (`piano_synthetic`, the corpus's
only polyphonic sample), Cello x2 (2220, 2296), Flute (2204), Violin (2243 —
has an existing Claude+Audiveris baseline number for direct comparison).
Multi-page support is a real, separate follow-up (needs page-boundary
tracking added to the corpus builder).

`degraded/mild` and `degraded/severe` are the corpus's synthetic
camera-condition tiers (rotation, perspective warp, blur, JPEG re-encoding) —
the closest available approximation to real photos with verified ground
truth; no `piano_synthetic` degraded-tier images exist in the corpus (a
real, pre-existing gap, not created by this benchmark).

## Results

| Tier | Pieces | Pitch acc. | Rhythm acc. | Note error rate | Exact-measure | Measure-count mismatches |
|---|---|---|---|---|---|---|
| clean | 5 | **96.3%** (1013/1052) | 99.1% | 3.9% | 86.0% | 0/5 |
| mild | 4* | 64.7% (660/1020) | 67.0% | 46.8% | 44.4% | 2/4 |
| severe | 4* | 7.5% (76/1020) | 0.1% | 100.5% | 0.0% | 4/4 |

\* piano_synthetic has no mild/severe image in the corpus.

Per-piece pitch accuracy (clean / mild / severe):
- 2204 Flute: 100.0% / 91.4% / 0.3%
- 2220 Cello: 100.0% / 50.9% / 10.8%
- 2243 Violin: 92.0% / 84.1% / 10.6%
- 2296 Cello: 92.2% / 21.1% / 9.9%
- piano_synthetic Piano: 100.0% / — / —

**Severe tier's failure mode is not just "lower accuracy" — it's a
reproducible runaway-hallucination pattern**: predicted measure counts
exploded to 4-14x ground truth on every severe case that had this problem
(2220: 682 predicted vs. 48 real; 2243: 218 vs. 20), correlating with real
latency spikes (33.7s and 44.9s vs. 4-10s for every clean/mild case) — the
model keeps generating structure (mostly more degenerate repeated content)
instead of terminating, a real robustness failure under heavy image
degradation, confirmed across 2 independent pieces.

Mild-tier robustness is genuinely inconsistent across pieces, not uniformly
"moderately worse": Flute held at 91.4%, Violin at 84.1%, but both Cello
pieces collapsed (50.9%, 21.1%) — this isn't an instrument-level pattern
either, since the two Cello pieces themselves diverge once mild degradation
is applied.

Spot-checked raw output against ground truth directly (not just trusting the
scorer) on `piano_synthetic` (exact pitch-for-pitch match) and the first 6
measures of `2243/clean` (5 of 6 measures pitch-perfect; the one real
discrepancy, measure 6, is a genuine melodic-contour transcription error near
the measure's end, not a parsing artifact).

## Comparison with the existing pipeline

Only one piece has both a real page-omr number and a real existing-baseline
number: **2243 (Violin, clean tier)**. page-omr: 92.0% pitch / 96.6% rhythm.
Existing Claude+Audiveris production pipeline (from the prior accuracy
investigation, same piece, same clean image): 30.7% pitch / 21.6% rhythm.
**This is the only valid comparison point** — the existing baseline has never
been run against the other 4 pieces in this benchmark, and this is 1 piece,
not a representative sample. No superiority claim is made beyond this single
data point.

## Resource usage

13 of 15 possible page-inferences ran (2 skipped — no mild/severe image for
piano_synthetic). Total CPU wall time: ~164.5s (2.7 min) across all 13.
Per-case latency: 4.4-10.2s on every clean/mild case; two severe-tier outliers
at 33.7s and 44.9s (the runaway-generation pattern above). Peak child process
RSS: 2671 MB. Zero GPU used (CPU-only per the directive; MPS was available on
this machine but never invoked). Zero dollars spent (local inference only).

## Integration feasibility

page-omr's kern output, once converted through this benchmark's adapter
(`kern_to_measures` → the same `{"number","notes":[{"pitch","is_rest","beat",
"duration_beats"}]}` shape `extract_ground_truth_measures`/`parse_musicxml`
already produce), is structurally the SAME shape worker.py's existing
cross-validation machinery already consumes for Audiveris's OMR output
(`_cross_source_measure_match`'s `oemer_measure` parameter, `fuse_measure_
confidence`'s OMR corroboration input). Sheet-music highlighting is
unaffected regardless (confirmed in the prior research phase — it comes from
an independent Gemini localization call, not from whichever engine
transcribes notes). Concretely: **no frontend changes needed, no changes
needed to downstream DTW/audio analysis** — both already consume whatever
canonical note list the score-reading step hands them.

Real remaining gaps before any production integration: (1) multi-page
measure continuity (scoped out of this benchmark, not solved); (2) the
severe-degradation runaway-hallucination failure mode needs either a
pre-processing fix (deskew/denoise before feeding page-omr — Mediant's
existing pipeline already does dewarping for Claude's reads) or a hard
output-length/measure-count sanity cap; (3) only tested on monophonic
strings/winds + one tiny polyphonic piano sample — no clarinet or guitar
coverage exists in this corpus at all, independent of page-omr.

## Recommendation: EXPAND TESTING

Not INTEGRATE — too narrow a sample (5 single-page pieces) and the
severe-degradation failure mode is real, reproducible, and unresolved. Not
REJECT — the clean-tier result is a genuine, dramatic improvement over the
one comparable existing-baseline data point (96.3% vs. 30.7% pitch
accuracy), reversing what an earlier, buggy scoring pass had wrongly
suggested. Per the directive's own Step 3 rule ("if initial output is valid
and demonstrates meaningful accuracy, expand"): expand to the full 24-piece
corpus (clean + mild tiers, where results are informative; severe tier's
collapse is already conclusive enough not to need a bigger sample) to get a
statistically firmer per-instrument read, and separately investigate whether
image pre-processing (deskew/denoise) rescues the severe-tier collapse before
making any integration decision.
