# page-omr expanded validation — CONTINUE WITH ONE SPECIFIC FIX

2026-10-31. Per the owner's "page-omr: Expanded Validation Approved"
directive. Builds on `PAGE_OMR_BENCHMARK_FINDINGS.md` (the 5-piece pilot).
Same checkpoint (`tobiashornbogen/page-omr-a1-kern`, already sha256-verified),
same isolated venv, same adapter/scorer, CPU-only, no paid APIs, no
production changes.

## Task 1: multi-page measure boundaries — SOLVED, validated at full scale

The pilot deliberately excluded multi-page pieces because the corpus builder
never recorded which ground-truth measure numbers land on which rendered
page. Solved by loading each piece's own `.musicxml` into a fresh
`verovio.toolkit()` (the exact same default options
`build_visual_validation_corpus.py`'s `render_musicxml_to_pngs` already
uses) and, for each page, calling `renderToSVG(page)` — the IDENTICAL call
that produced the real PNGs — then checking which measure elements actually
appear in that page's own SVG.

Validated two independent ways before trusting it on anything: verovio's
own `getPageWithElement(id)` API vs. direct substring presence in each
page's rendered SVG. Both agreed exactly on all 25 corpus pieces (not just a
small example) — page counts matched `ground_truth.json`'s own `n_pages`,
total measure counts matched, zero overlap between any two pages' measure
sets, every page's measure numbers contiguous. Zero pieces failed
validation. This is not a guess or an offset heuristic — it's the real
layout the renderer actually used.

## Task 2a: existing deskew/denoise preprocessing — tested, does not help

**Real finding, stated plainly: Mediant has no actual whole-page deskew
preprocessing.** `_normalize_page_orientation` is EXIF-tag-only (discrete
90/180/270° correction, a no-op on these corpus PNGs — they carry no EXIF
tags). `dewarp_row` explicitly assumes one isolated staff system per crop
(it tracks staff lines across vertical strips of a single row) — applying
it to a whole multi-system page would require first splitting into rows and
reassembling, which is the "substantial new infrastructure" the owner's
directive said to flag rather than build. The one genuinely reusable,
already-existing, whole-page-applicable transform found is `_binarize_ink`
(Otsu-threshold ink/background split, worker.py lines ~3924-3990) — its own
logic has no row assumption, it's just never been called page-wide before.

Tested raw vs. binarized on all 8 mild/severe cases from the 4 multi-tier
pilot pieces (2204, 2220, 2243, 2296):

| Tier | Raw pitch avg | Binarized pitch avg | Effect |
|---|---|---|---|
| mild | 61.9% | 60.8% | no consistent benefit (±1-8pts either direction, no pattern) |
| severe | 7.9% | 1.4% | **actively worse** — 3 of 4 severe cases collapsed to 1 predicted measure (near-total blank output) instead of being rescued |

Binarization destroys grayscale/anti-aliasing information the DINOv2 encoder
likely relies on; hard black/white thresholding under heavy JPEG/blur
degradation appears to push the input further out of distribution, not
closer to it. **Frozen decision: raw images, no binarization**, for the
Task 3 expansion below. The two cello pieces singled out for attention
(2220, 2296) specifically showed no rescue either (2220 mild: 50.9%→43.2%;
2296 mild: 21.1%→21.6%).

## Task 2b: ground-truth-free failure detector — built, evaluated, a real limitation found and corrected

Detector inputs only what production would have: the model's own raw
output length, a repetition-collapse ratio (reusing page-omr's own
`detect_repetition_loops`, present in its repo but not wired into the
default inference path — not reinvented here), and latency. No ground-truth
measure count used anywhere in the detector's logic.

**On the 13-case pilot** (calibration set): flags 3 of 5 real failures
(pitch < 30%) with **zero false positives** across all 8 non-failure cases.
Precision 100%, recall 60%. Catches the "obvious runaway" sub-type
(measure-count explosion, degenerate single-token repetition) but misses
output that's wrong yet structurally normal-looking (2296/severe: 9.9%
pitch, completely ordinary length and timing).

**On the 40-case held-out expansion, this did NOT hold up — caught and
corrected before reporting it as fact.** Applying the SAME absolute
character-count threshold (2500 chars) to these pieces produced 21 false
positives out of 40 cases (specificity collapsed from 100% to 47.5%) —
*and* none of the 40 held-out cases actually had pitch below 30% in the
first place, so there was nothing real for the detector to catch here
either way. Root cause: the pilot's 5 pieces happened to be short
(8-85 measures); several held-out pieces run 65-274 measures, so correct,
normal kern output on a longer piece legitimately exceeds 2500 characters
with nothing wrong at all. The absolute-length threshold does not
generalize — it was fit to too small and unrepresentative a sample.

The repetition-collapse-ratio signal, by contrast, held up perfectly: zero
false positives across all 53 cases evaluated (13 pilot + 40 expansion), but
it only ever fires on the single-repeated-token degenerate-collapse failure
mode — which did not occur even once anywhere in the 40-case mild-tier
expansion. **Honest conclusion: as built, this detector does not reliably
flag mild-degradation quality problems** — the one failure sub-type it
catches reliably (repetition collapse) is a severe-tier-only phenomenon in
everything tested so far; mild-tier errors are the "wrong but normal-
looking" kind this detector was already known, from the pilot, not to
catch. This is the one concrete gap behind this report's final
recommendation.

## Task 3: expansion to the 20 held-out pieces, clean + mild tiers

All 20 remaining corpus pieces completed, zero hard failures (no crashes,
no unparseable output). **Every one of these 20 pieces happens to be
multi-page** (the pilot already used the corpus's only 5 single-page
pieces) — so single-page-vs-multi-page is a pilot-vs-expansion comparison,
not a split within the expansion itself.

### By tier (20 held-out pieces, clearly separate from the 5-piece pilot)

| Tier | Pitch | Rhythm | Note error rate | Exact-measure |
|---|---|---|---|---|
| clean | 95.4% | 92.5% | 5.0% | 86.5% |
| mild | 65.4% | 79.1% | 37.5% | 51.4% |

**Combined with the pilot (all 25 pieces, single- and multi-page together,
tiers kept separate):** clean 95.4% pitch / mild 65.3% pitch (24 pieces —
piano_synthetic has no mild image). The held-out expansion's numbers are
remarkably close to the pilot's own (96.3%/64.7%) — this is a real,
reassuring consistency check: the 5-piece pilot was not a lucky or
unrepresentative sample, and multi-page handling does not measurably hurt
accuracy versus single-page.

### By instrument (held-out set)

| Instrument | Clean pitch | Mild pitch |
|---|---|---|
| Cello (n=10) | 96.6% | 74.6% |
| Flute (n=2) | 99.8% | 61.2% |
| Violin (n=8) | 92.8% | 54.6% |

Violin shows the weakest mild-tier robustness of the three; Cello the
strongest (reversing the pilot's own framing, where 2 of the pilot's worst
mild-tier performers were both Cello pieces — the full held-out sample
shows that was not representative of Cello generally).

### Clarinet/guitar coverage

**Confirmed: none exists anywhere in accessible project assets.** The
corpus (MusicNet-derived + one synthetic piano piece) covers only Violin,
Cello, Flute, Piano. One real clarinet photo exists
(`modal_worker/testdata/real_photo_sideways_exif_portrait.jpg`, from the
2026-10-01 EXIF-rotation bug) but its own README explicitly states it has
no verified note-content ground truth — using it here would mean scoring
against an untrustworthy or fabricated reference, which is excluded by the
owner's own standing rule against relabeling/fabricating samples. This is a
real, pre-existing coverage gap, independent of page-omr.

### Multi-page reliability

The page-to-measure MAPPING itself is reliable (Task 1, validated with zero
errors on all 25 pieces). What is NOT fully reliable: individual pages'
own predicted measure count sometimes differs from that page's real count
under degradation — 21 of 90 mild-tier multi-page page-instances (23%) show
a mismatch, vs. only 2 of 45 on clean. When a page's measure count is wrong,
every measure after the point of mismatch on that page is scored against
the wrong ground-truth slice (the same cascading-misalignment effect the
single-page pilot already found within one page) — meaning the mild-tier
accuracy numbers above are a real, honest result, not inflated by hidden
realignment, but also not a best-case bound on what correct per-page
segmentation could achieve.

### Resource usage

40 cases (100 page-inferences, clean+mild, 20 pieces): **33.6 minutes**
total CPU wall time. Longest single case: 2222/clean, 944s (one outlier —
2222 is this corpus's largest page-count-dense piece, 217 measures over 2
pages, 3/8 time signature). Zero GPU, zero dollars. Combined with the pilot
(164.5s) and the Task 2 preprocessing check (~2 min): **this entire
multi-day investigation has cost under 40 minutes of CPU time and $0.**

## Recommendation: CONTINUE WITH ONE SPECIFIC FIX

Not INTEGRATE: the owner's own stopping rule is explicit — "Mild-degradation
performance must improve materially, or the system must identify low-
quality uploads and request clearer images instead of silently producing
incorrect feedback." Neither happened. The one legitimately-reusable
existing preprocessing step (binarization) did not materially improve
mild-tier accuracy, and the ground-truth-free failure detector, evaluated
honestly on 53 real cases, does not reliably catch mild-degradation quality
problems (its one working signal — repetition-collapse — never fires on
mild-tier data in this corpus at all).

Not REJECT: clean-score accuracy is genuinely excellent and, more
importantly, now CONSISTENT at real scale — 95.4% pitch across all 25
corpus pieces, both single- and multi-page, three real instruments plus the
one polyphonic sample, with a validated, reliable page-mapping mechanism.
This is not a fluke result from a small pilot.

**The one specific fix**: replace the failure detector's absolute
character-length threshold (shown not to generalize) with a NORMALIZED
signal — output length relative to the piece's own apparent complexity
(e.g., characters per predicted measure, or per rendered system, rather
than a raw character count), recalibrated on a larger sample than the 13
cases this version used. This is a scoped, well-understood engineering fix,
not new model research and not a new enhancement pipeline — the repetition-
collapse half of the detector already works and should be kept as-is.
Until that fix exists and is itself validated on held-out data, page-omr
should not take over score-reading for uploads that can't be confirmed
clean, since there is currently no reliable way to tell a user "please
retake this photo" instead of silently feeding them a ~65%-accurate
transcription.

No integration work has been started. No further benchmarking beyond what
this report describes.
