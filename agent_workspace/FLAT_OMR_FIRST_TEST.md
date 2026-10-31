# Flat OMR API — first paid test vs. page-omr

2026-10-31. Per the owner's "Mediant — Flat OMR API Setup and First Test"
directive. Exactly one paid conversion was run, after verifying auth and
balance. No production/deploy changes; no library import; token was never
printed, logged, or committed.

## Setup

- Token read from `FLAT_API_TOKEN` env var only, scoped to this one
  process invocation, never written to any file or printed. (The token
  was shared in plaintext in chat to set this up — **recommend rotating
  it in the Flat dashboard**, since plaintext-in-chat is not a secure
  distribution channel regardless of what this session did with it.)
- `GET /v2/omr/capabilities` confirmed auth (HTTP 200) and the account's
  real balance: **30 credits, costPerPage=1** before spending anything.
- Used the Interactive Jobs API exactly as documented
  (`flat.io/developers/docs/api/omr/jobs`): create draft job with
  `"output": "musicxml"` (no `interactiveSteps`, no `scores` scope used —
  confirmed this never touches the Flat Library) → add one file (base64)
  → start → long-poll → download the musicxml export.

## Score selected

**Piece 2220 (Cello), clean tier, single page** (48 ground-truth
measures) — chosen deliberately over a mild/degraded image for this
FIRST test: it isolates each engine's best-case accuracy without the
synthetic-degradation variable this investigation has spent several
rounds characterizing for page-omr specifically, giving a clean apples-
to-apples baseline before any follow-up test introduces degradation as a
second variable. page-omr already has a recorded, validated result for
this exact piece/tier (100% pitch accuracy, confirmed earlier this
session through the actual production adapter).

## Confirmed before spending

1 page × 1 credit/page = **1 credit**, against a 30-credit balance —
confirmed sufficient, then exactly one job was created and started.
**Verified after the job completed**: balance dropped from 30 to 29 —
exactly one credit was spent, matching the pre-spend confirmation
exactly, not merely assumed.

## Conversion and scoring method

Flat's returned MusicXML was parsed with **the same `music21`-based
canonicalization function the ground-truth corpus itself was built
with** (`extract_ground_truth_measures`, from `build_visual_validation_
corpus.py` — reused via the existing `page_omr_score.py` scorer, not a
new ad hoc converter), then scored against the same `ground_truth.json`
entry with **the exact same scorer** used for every page-omr number in
this investigation (`score_piece`/`score_sequence`). The comparison below
is apples-to-apples: same ground truth, same scoring code, same piece.

## Result

| Metric | Flat OMR | page-omr (+deskew, no-op on clean) |
|---|---|---|
| Pitch accuracy | 96.4% | **100%** |
| Rhythm accuracy | 100% | 100% |
| Exact-measure accuracy | 91.7% (44/48) | **100%** (48/48) |
| Measure count | 48/48 (match) | 48/48 (match) |
| Processing time | 71.1s (cloud) | **9.5s** (local CPU, $0) |
| Cost | 1 credit (real money) | $0 |

**Flat's errors, inspected directly**: 4 measures (25, 26, 41, 42), each
with exactly 2 pitch substitutions and otherwise-perfect rhythm (right
note count, right durations, just 2 wrong pitches per measure) — a
clean, structurally-normal misread, not a garbled or degenerate output.
Not investigated further (score to be interpreted, not root-caused, per
the directive's scope — one credit was authorized, not an error-analysis
budget).

## Recommendation for the next comparison

**This is one piece, one tier, one sample — not a generalizable claim.**
On this single, favorable (clean, single-page, previously page-omr-
perfect) case, page-omr matched or beat Flat on every accuracy metric
and was ~7x faster at zero marginal cost, while Flat is a paid,
per-page-billed cloud service with no local compute cost. That is a
real, measured first data point in page-omr's favor, not a reason to
conclude Flat underperforms in general — a single clean page is close to
the easiest case for both engines, and this test cannot speak to Flat's
behavior on mild/severe degradation, multi-page scores, or any
instrument besides cello, none of which were tested here (only one
credit was authorized).

**Recommend, if further Flat comparison is approved**: spend any
additional credits on a mild-degradation image instead of another clean
one — that is where this investigation has already found page-omr's
real weakness (now closed significantly by deskew), so it is the
comparison most likely to be decision-relevant. Do not spend further
credits without separate approval, per the directive's explicit
constraint.

No production changes. No deploy. No additional paid conversions were
run beyond the one authorized.
