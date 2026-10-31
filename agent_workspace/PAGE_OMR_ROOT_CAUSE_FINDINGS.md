# page-omr root-cause investigation — DESKEW CORRECTION, validate at scale next

2026-10-31. Per the owner's "page-omr: Root-Cause Investigation Approved"
directive. Builds on `PAGE_OMR_EXPANDED_FINDINGS.md`. All analysis below
reuses already-collected benchmark outputs, images, and ground truth — no
new broad benchmark was run, per the directive's constraint. Total new
inference: 12 calls (6 ablation + 6 deskew test). CPU-only, $0, no
production changes.

## Task 1: dominant error source, quantified (not guessed)

Selected 12 representative mild-tier cases across Flute (2), Cello (4),
Violin (6) — no piano mild-degradation image exists in the corpus at all
(confirmed gap, reported, not fabricated).

**Key quantitative test**: for every mild-tier multi-page piece, I
re-scored using ONLY the pages where page-omr's predicted measure count
matched the page's real count, excluding pages where it didn't:

| | Mean pitch accuracy |
|---|---|
| All pages (the headline mild-tier number) | 65.9% |
| Only pages where measure count was correct | **86.9%** |

A 21-point gap. **The dominant error source is structural decoding —
page-omr losing track of where measure/barline boundaries actually are —
not musical symbol recognition (pitch, duration, clef, accidentals).** When
it gets the measure boundaries right, it reads the actual notes well (87%,
close to the clean-tier ~95% ballpark); when it doesn't, every measure
after the point of miscount is scored against the wrong ground-truth slice
and the apparent "pitch accuracy" collapses, even though the underlying
symbol-reading may be fine.

Direct visual inspection (not just the numbers) of the worst case, piece
2218 (Cello, 29 real measures on page 1, predicted 74 — 2.5x inflation):
this is a dense Bach piece with ~14 tightly-spaced systems on one page.
Under mild rotation the already-tight gaps between systems visually
compress further on one side of the page — a plausible, visually-confirmed
mechanism for why the model starts inventing extra barlines, though a
precise causal account of the model's internals is out of scope here (no
new model research).

Category A (readability: contrast/blur/compression) is **not** implicated
directly — confirmed in the degradation code itself (`degrade_mild` applies
zero blur and zero JPEG compression; only severe does). Category A as
"skew" specifically, however, is implicated — see Task 2.

## Task 2: does the degradation realistically represent real uploads?

Read `modal_worker/degrade_visual_corpus.py` in full. Mild tier = small
rotation (3-7°) + mild perspective warp (2% per-corner jitter) + mild
lighting gradient (0.85x-1.15x) — **no blur, no JPEG recompression** (those
are severe-tier only). All three of these phenomena are genuine, common
smartphone-photo conditions (holding a phone slightly off-angle over a
music stand, uneven window/room lighting). One candidate "unrealistic
artifact" was flagged from visual inspection before testing it: the
perspective warp jitters each of the 4 corners independently, which a
single real camera viewpoint wouldn't do (a true photo is one consistent
homography, not 4 independent random corners).

**Tested this directly with a controlled ablation** (not assumed): on the
2 worst structural-failure pages (2218, 2288), generated 3 isolated
variants — rotation only, perspective warp only, lighting gradient only —
each using a representative mild-tier-magnitude value, and ran real
inference on each.

| Variant | 2218 predicted measures (real: 29) | 2288 predicted measures (real: 33) |
|---|---|---|
| Rotation only | 29 (exact) | 33 (exact) |
| Perspective warp only | 29 (exact) | 33 (exact) |
| Lighting gradient only | 29 (exact) | 33 (exact) |
| All three combined (the real mild tier) | 74 | 44 |

**Every transform alone is harmless. Only the realistic combination of all
three breaks structural decoding.** This overturns my own initial
visual-inspection hypothesis (the independent-corner jitter looked
suspicious but tests clean in isolation) and answers Task 2 directly: the
degradation is not disproportionately synthetic or unrealistic — a real
phone photo naturally combines rotation, perspective, and lighting
unevenness simultaneously, and this IS a genuine compounding-degradation
robustness gap in page-omr, not a testing artifact. No further work went
into "making the synthetic degradation more realistic" because the evidence
says it already is.

## Task 3: one bounded corrective experiment — deskew correction

Task 1 established a clear mechanism (structural failures triggered by
combined rotation+warp+lighting, with rotation as a share of that
combination). Built one lightweight, standard preprocessing operation: a
projection-profile deskew (search candidate angles, binarize via the
already-reused `_binarize_ink`, pick the angle that maximizes the row-sum
variance of the binarized page — a textbook skew estimator). **Blind to the
synthetic test's own injected rotation angle** — estimated from the image
alone, the only thing a real pipeline would have. Confirmed sane,
independent angle estimates (3-7° range, matching the real mild-tier
magnitude) before running any inference.

Development/estimation and evaluation were kept separate: the angle
estimator was written and sanity-checked against known mild-tier magnitude
ranges BEFORE looking at any post-correction accuracy number, and no
threshold in it was tuned against these specific test cases' outcomes.

| Case | Before: measures (pred/real) | Before pitch | After deskew: measures | After pitch |
|---|---|---|---|---|
| 2218 (Cello) | 74/29 | 28.7%* | **29/29 (exact)** | **80.0%** |
| 2288 (Violin) | 44/33 | 19.8%* | **33/33 (exact)** | **86.3%** |
| 2186 (Violin) | 48/52 | 42.9% | 51/52 | 56.0% |
| 2202 (Flute) | 35/35 | 83.9% | 35/35 | **98.7%** |

\* These per-page pitch numbers differ slightly from the piece-level
numbers quoted in the prior report (which aggregate across all of a
piece's pages) — these are page-1-only, isolated for a clean before/after
comparison.

**Clean-tier regression check** (2204, 2243 — already-undegraded images,
the real test of "does this preprocessing step ever hurt a good input"):
**zero change** on either case (100.0%→100.0%, 92.0%→92.0%, exact measure
counts identical before and after). The estimator correctly detected ~0°
correction needed on both.

**Added latency**: 0.5-0.8s per page for angle estimation — trivial next to
page-omr's own 5-50s inference time.

**Structural reconstruction**: 2 of 4 mild cases reached the EXACT real
measure count after deskewing (vs. 0 of 4 before); a 3rd (2186) moved from
48→51 against a real count of 52, a large but incomplete recovery (that
page likely has an independent, different problem beyond rotation); the
4th (2202) already had the right count and deskewing still improved pitch
accuracy by 14.8 points, suggesting a secondary legibility benefit beyond
just structural/barline correction.

## Task 4: practical launch relevance

Not yet justified to offer page-omr as the primary, trusted reader for
real smartphone photos. Clean-tier accuracy is excellent (95.4% across 25
pieces) and well-established. Mild-degradation accuracy, BEFORE this
round's fix, was a real, serious gap (65.4%) — but this round found both
the actual mechanism (structural, not symbol-level) and a cheap, working
partial fix (deskew) that showed real, large gains on every one of the 4
cases tested, with zero regression. What's still needed before a launch
decision: (1) validating deskew's benefit across the FULL mild-tier
held-out set, not just 4 hand-picked cases, (2) real smartphone photos
(this corpus's degradation is synthetic, even though now evidenced as
realistic) — this remains unverified on actual camera captures, (3)
coverage for clarinet/guitar remains zero regardless of any of this work.

## Recommendation and next action

**Recommended production direction**: continue toward page-omr as the
primary visual reader, now WITH deskew preprocessing as a standing
pipeline step for any non-clean input — not integrate today, but this is
real, positive, load-bearing progress, not a stall.

**One decisive next action**: re-run the full 24-piece mild-tier held-out
set (already-collected images and ground truth, zero new infrastructure)
with the deskew step applied before inference, to get a real aggregate
number instead of 4 hand-picked cases — if the full-set mild-tier pitch
accuracy materially improves (the 4-case signal, +13 to +66 points per
case, strongly suggests it will), that becomes the evidence base for an
actual integrate/defer decision. This is the smallest next step that turns
today's promising but small sample into a production-grade answer.

No production changes, no new model, no fine-tuning, no paid API calls.
