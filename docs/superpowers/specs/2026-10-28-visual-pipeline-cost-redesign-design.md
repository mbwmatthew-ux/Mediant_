# Visual Pipeline Cost & Accuracy Redesign — Design

**Status:** Revised after external technical review. The reviewer's verdict —
approved for the validation phase, revision required before production
migration — is adopted as this document's status. Nothing in Sections 3-4
below is a committed production change; each is a candidate pending the
acceptance criteria in Section 6.

**Revision note:** this version corrects several factual errors the external
reviewer caught (pricing, an internal inconsistency about score caching, and
overstated certainty about SMT's role) and adopts most of their architectural
suggestions, after independently verifying each one against this codebase or
official pricing pages rather than taking either the original draft or the
review at face value. Section 12 at the end records what was verified, what
was corrected, and the one point where the available evidence didn't support
the review as written.

## 0. What Mediant is, for context

Mediant is an AI music performance coach. A musician uploads a video of
themselves playing a piece, optionally with a photo or PDF of the sheet
music. The system analyzes the recording against the score and returns
measure-linked feedback (pitch, rhythm, dynamics, articulation), lets the
user jump straight to the audio of any flagged measure ("Loop"), and keeps
a persistent chat thread per song that compares each new take to the
previous one. Product pricing is a single $7/month subscription with
**unlimited** analysis attempts — there are no paid tiers of quality, which
is a hard constraint on everything below: every analysis must be the best
one the system can produce, and the system has to be cheap enough, on
average, that unlimited use doesn't lose money.

## 1. The full pipeline today (for the reviewer's context)

This spec only proposes changing the pieces marked **[THIS SPEC]** below.
Everything else is existing, working production code
(`modal_worker/worker.py`), described here so the proposed changes can be
judged in context rather than in isolation.

```
Upload (video + optional score image/PDF + metadata: instrument, piece,
         declared BPM, start/end measure)
    │
    ▼
run_full_analysis (Modal, spawned detached, webhooks Supabase on completion)
    │
    ├─→ CREPE pipeline: extract audio → librosa beat tracking → CREPE pitch
    │   tracking (guided by beat times + instrument-specific register bounds)
    │
    ├─→ Score-reading pipeline [THIS SPEC — Section 3]: currently
    │   read_score_notes_claude — 3 parallel Claude Sonnet 5 vision reads +
    │   majority vote, cross-checked against Audiveris (free, open-source
    │   OMR, already self-hosted on the same Modal image) for tie-breaking
    │   only — BUT gated by a score cache keyed on the uploaded file's
    │   content hash (see "Score caching" below), so this is not actually
    │   paid for on every single analysis
    │
    └─→ Gemini pipeline: video + every score page uploaded to
        `gemini-2.5-flash` (falling back to `gemini-2.5-pro` on failure —
        `GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"]`), which
        watches+reads together and authors the actual performance flags
        (wrong note, rhythm, dynamics, articulation)
    │
    ▼
DTW alignment (dtw_align_to_score): pure-pitch dynamic time warping aligns
the audio's detected pitch sequence against the score's note sequence,
rest-anchored and segmented for robustness, producing a verified
timestamp + measure/beat for each matched note. This is the "VERIFIED"
authority — not Gemini's or Claude's guess — behind every flag's measure
number.
    │
    ▼
compare_and_coach_claude [THIS SPEC — Section 4]: takes the DTW-verified
issue list + Gemini's assessment + instrument + piece metadata, currently
calls Claude Sonnet 5 (text-only, no images) to write the final 2-sentence
coaching text per issue, in a fixed JSON schema
    │
    ▼
Webhook → Supabase: flags (measure number, timestamp range, issue type,
coaching text) + parsed score (cached, see below) + Supabase persists
score_cache keyed by the score file's content hash
    │
    ▼
Frontend: score stays visible during analysis, flagged measures highlighted,
Loop plays the exact flagged range, next take's analysis explicitly compares
to the previous take
```

**Score caching — corrected (reviewer's point 2):** the first draft of this
document said score reading costs 3 Sonnet 5 vision calls "unconditionally,
every analysis," immediately after also saying the parsed score is
"cached... for reuse on the next take." Those two statements were in genuine
tension, and the reviewer was right to flag it. Verified directly against
the code (`supabase/functions/analyze-performance/index.ts:1347-1361`,
`modal_worker/worker.py:10082-10092`):

- The cache **does** exist and **does** correctly short-circuit
  `read_score_notes_claude` — a hit returns the cached parse without
  downloading or re-reading anything.
- The cache key is **already content-hash-based**, not a bare storage path
  — the frontend (`src/components/NewRecordingModal.jsx:276-288`) names the
  uploaded score file's storage object by its SHA-256 hash specifically
  *because* a timestamp-based path broke caching (that exact failure and
  fix are documented in a comment at that line: the same photo used to get
  a new path — and therefore a cache miss — on every upload). This is
  independently already the fix the reviewer suggested; it predates this
  spec.

So the corrected statement is: score reading is paid for once per
**distinct** uploaded score file (by content), not once per analysis.
Repeat takes of the same song that re-upload the identical file hit the
cache for free.

**What's still actually true, and still the real problem:** a cache keyed
by exact file bytes does **not** hit when a user *re-photographs* the same
physical sheet music for a later take — a new photo, even of the identical
page, hashes differently (different lighting, crop, angle). Given this
product's real usage pattern (phone photos, not re-uploads of a saved PDF),
first-time-per-piece-per-photo cost is plausibly still the common case, not
a rare one. **This needs instrumentation before Section 8's cost model can
be trusted**: real cache hit rate, and — separately — how often a page is
photographed more than once across a user's takes of the same piece. This
replaces the reviewer's suggested fix (it's already built) with the
measurement they correctly said was missing.

Two independent per-analysis API cost centers exist today, not one:

1. **Score reading** — 3x Claude Sonnet 5 vision calls, on each distinct
   (by content hash) score file, not literally every analysis (see above).
2. **Coaching synthesis** — 1x Claude Sonnet 5 text call, every analysis,
   no caching (each take's issues are different).

Gemini's flag-authoring step is already on a cheaper model family and is
**not** a target of this spec for cost reduction — Section 3 does propose
*extending* its existing prompt/response schema, but that's an accuracy/cost
move for score reading, not a change to what Gemini itself costs.

## 2. Problem statement

Current Anthropic API spend is unsustainable against the business model.
The original framing here was "$7/month ÷ ~60 analyses/month ≈ $0.10 per
analysis is the target" — the external reviewer correctly pointed out this
is not the right target: $0.10/analysis would consume essentially the
entire subscription price in inference cost alone, leaving nothing for
payment processing, Supabase, Modal, storage, bandwidth, support, or margin.
**Corrected framing, pending your confirmation of a target gross margin:**
at a 70% gross margin target, allowable COGS is $7 × 30% = $2.10/month per
user; at ~60 analyses/month that's **≈$0.035/analysis**, not $0.10. The
arithmetic here is verified; the 70% margin and 60-analyses assumption are
business inputs only you can confirm — this spec treats $0.03-0.04 as the
working target but flags it as pending your sign-off, not as settled.

**Also flagged by the reviewer and worth adopting:** "unlimited use" plans
typically have median usage well below the mean, with a small number of
heavy users dominating cost. A cost model built only on the average
(whatever that average turns out to be) will underestimate the plan's real
exposure. The validation work in Section 6 should capture the distribution,
not just an average, once real usage data exists.

The team has exhausted its Anthropic credit allowance multiple times in
recent weeks. Score reading (3 full Sonnet 5 vision calls per *distinct*
score file, Sonnet 5 running adaptive thinking by default) is believed to be
the dominant cost center — this has not yet been measured with real dollar
figures, only reasoned about from token pricing. Getting a real measured
number, including real cache hit rate, is part of this spec's validation
plan (Section 6), not an assumed fact.

## 3. Proposed change A: score-reading extraction cascade

**Goal:** stop treating the most expensive available model as the default
reader for every distinct score file. Reserve it for pages, or parts of
pages, that actually need it.

**Scope boundary:** "universal" here means solo-instrument notation across
instrument types (violin, cello, flute, piano, etc. — including multi-staff
solo instruments like piano's grand staff, which is one performer reading
two staves). It does **not** mean multi-performer ensemble/orchestral
scores — that remains an explicitly pending, unapproved product decision
(`agent_workspace/PRODUCT_DECISIONS.md`), not something this spec expands.

**Architecture (revised — SMT is a candidate, not a committed default):**

1. **Audiveris** (unchanged) — free, deterministic, open-source OMR, already
   self-hosted on the existing Modal image, already runs on every row of
   every raster page in parallel with Claude today. No change to this stage
   itself.
2. **SMT-based transcription — candidate primary reader, gated on Section 6
   acceptance criteria, not yet a committed default.** Sheet Music
   Transformer (`github.com/antoniorv6/SMT`, MIT licensed; the
   `smt-camera-grandstaff` checkpoint is confirmed small — 21.4M parameters,
   per its Hugging Face model card — so self-hosting it is plausibly cheap,
   though this needs measuring, not assuming, per Section 6). Promotion
   from "candidate" to "production primary" happens only if it clears the
   explicit acceptance criteria in Section 6 — not automatically once
   someone writes the integration code.
3. **Reconciliation, calibrated rather than raw agreement (reviewer's point
   6, adopted).** The original draft treated "Audiveris and SMT agree" as
   sufficient grounds for trust. That's not safe on its own — two
   independent-but-imperfect readers can share a correlated blind spot (the
   same unusual engraving, the same image defect) and agree while both are
   wrong. The reconciliation logic needs to estimate something closer to
   *P(correct | agreement, image quality, layout type)*, calibrated against
   the validation corpus's real ground truth — not necessarily a trained
   model, a ruleset derived from the validation data is enough to start.
4. **Fallback — localized, not whole-piece, and cheapest option tried
   first (reviewer's points 7 and 8, adopted together).** The original
   draft said the fallback fires "on disagreement... on a meaningful
   portion of the piece," which the reviewer correctly called too coarse —
   4 bad measures in a 6-page piece shouldn't resend all 6 pages. Revised
   cascade, cheapest-first:
   - Identify the *specific* uncertain measures/systems, not the whole page
     — this reuses the targeted-crop and resolution machinery that already
     exists for Claude-internal disagreement (`_whole_page_crop_for_resolution`,
     the `_RESOLUTION_CALL_CAP`-bounded resolution calls), rather than
     building new cropping infrastructure.
   - **Try extending the Gemini call already being made, first.**
     `evaluate_with_gemini` already receives every score page alongside the
     video. Before paying for any new vision call, test whether that
     existing call's response schema can be extended with additional
     fields (e.g. `score_crosscheck`, `uncertain_measures`) covering just
     the uncertain measures, at no extra API call. This might degrade
     flag-authoring quality if the added task competes with it in the same
     prompt — that's exactly why it's a controlled experiment, not an
     assumed win.
   - **Only if that doesn't produce a usable signal:** crop just the
     uncertain system/measures and send that crop (not the full page) to a
     vision fallback, then merge the result back into the full score.

**Known risk, stated plainly for the reviewer:** SMT's publicly available
checkpoints are narrowly scoped by their training data —
`smt-camera-grandstaff` is documented as "pianoform images only," and
`smt-string-quartets` is scoped to ensemble parts. **There is currently no
published SMT checkpoint for single-staff solo violin/cello/flute** — the
repertoire that makes up most of this product's real corpus. This is not a
detail; it's the central open question Section 6 exists to answer before
any commitment to fine-tuning or to SMT as a production primary.

## 4. Proposed change B: coaching-synthesis model

**This maps directly onto what was described conversationally as "Haiku
makes the final judgment call."** It turns out this isn't a new call to add
— it's an existing one to change. `compare_and_coach_claude` is already the
single point where the visual (score/DTW-verified issues) and audio
(Gemini's assessment, CREPE-derived timing) analysis merge into the text the
user actually reads. It already receives `instrument`, the verified issue
list, and Gemini's assessment. It is **text-only** — no images — and the
prompt is a tightly templated rewrite task (fixed JSON schema, explicit
"2 sentences, 40 words max" constraint, forbidden-phrase list).

**Candidate model, corrected from the original draft:** `claude-haiku-5-5`,
not `claude-haiku-4-5`. Verified directly against Anthropic's current
pricing page: Sonnet 5 is $2/$10 per million input/output tokens
(permanently — Anthropic cancelled its originally-announced September 1,
2026 increase to $3/$15), and Haiku 5.5 is $0.10/$0.50 for prompts under
100K tokens. That's **20x cheaper on both input and output**, not the ~3x
the original draft estimated from stale Haiku 4.5 pricing ($1/$5). For a
≤40-word structured output, coaching cost becomes close to irrelevant
regardless of which of these models is used.

**Proposed change:** swap `CLAUDE_MODEL` in `compare_and_coach_claude`
(`worker.py:8149`) from `claude-sonnet-5` to `claude-haiku-5-5`. Same prompt,
same JSON schema, same call site — no new integration.

**A real, currently-missing product improvement this unlocks:** today,
measures the score reader couldn't confidently read are silently dropped
from the flag list before they ever reach the coaching prompt
(`unresolved_measures`, computed early in `compare_and_coach_claude`,
suppresses those flags at emission — the user is never told *why* a measure
has no feedback). Once the new extraction cascade (Section 3) produces
richer, per-measure confidence data than today's single boolean, that data
can be threaded into the coaching prompt so the user gets an honest
explanation ("measures 12-14 weren't clear enough in your photo to give
confident feedback — try a sharper shot of that passage") instead of a
silent gap.

**Testing, expanded per the reviewer's point 12 (adopted):** `
compare_and_coach_claude` isn't deciding *where* a mistake happened — DTW
already verified the location, and Gemini/CREPE already supplied the
underlying facts. This call is converting already-verified structured facts
into prose. That means the real baseline comparison has three arms, not two:
Sonnet 5 (current) vs. Haiku 5.5 (candidate) vs. a **deterministic/template
baseline** (e.g. a string template keyed on issue type + measure + severity,
zero LLM cost). The template baseline isn't expected to win on coaching
quality, but running it tells us how much value the language model is
actually adding above free string formatting — a number this spec doesn't
currently have.

## 5. Explicitly out of scope

- Gemini's flag-authoring *cost* — already on a cheaper model family, not
  raised by anyone as a cost problem. (Section 3 does propose testing an
  extension to what that call *returns*, which is a different thing from
  reducing its cost.)
- Multi-performer ensemble/orchestral score support — pending, unapproved
  product decision.
- Non-standard notation (handwritten manuscripts, tablature) — not
  addressed by SMT's available checkpoints and not requested.
- Replacing DTW alignment, CREPE pitch tracking, or the Loop/comparison
  features — all unchanged by this spec.

## 6. Validation plan (before any fine-tuning or production-promotion commitment)

This project already built a validation harness this session
(`modal_worker/build_visual_validation_corpus.py`,
`modal_worker/degrade_visual_corpus.py`,
`modal_worker/validate_score_reading_against_corpus.py`) against a 24-piece
MusicNet-derived corpus (solo violin/cello/flute) with clean/mild/severe
degradation tiers and real music21-derived ground truth, scored via
`_cross_source_measure_match`. This spec extends it rather than replacing
it, and adds explicit pass/fail criteria the original draft lacked.

**Explicit acceptance criteria (reviewer's point 4, adopted) — SMT is
promoted from candidate to production primary reader only if, measured
against the full validation corpus including the real-photo set below:**

- End-to-end measure-localization accuracy does not fall by more than a
  threshold to be set from the zero-shot measurement itself (not guessed in
  advance of having any data).
- The rate of catastrophic score-read failures (not "imperfect," but
  unusable — e.g. wrong time signature cascading into wrong measure
  numbers throughout) stays below an explicit ceiling.
- Fallback utilization (how often the cascade needs the expensive path)
  stays low enough that the blended cost target in Section 2 is actually
  met — this is a product/cost criterion, not just an accuracy one.

**Two kinds of metrics, not one (reviewer's point 4, adopted) — product
metrics matter more than raw OMR transcription fidelity:** Mediant doesn't
fundamentally care whether an OMR model perfectly reproduces notation. It
cares whether enough information is extracted to correctly align the
performance and correctly locate feedback. Both sets get measured:

- *OMR metrics:* pitch/event precision and recall, measure-boundary
  accuracy, sequence error (what the existing harness already measures).
- *Product metrics (new):* DTW alignment success rate, correct
  flagged-measure rate, timestamp error, catastrophic misalignment rate,
  percentage of a piece that needed fallback.

**Validation sequence, expanded with a real-world stage (reviewer's point
5, adopted):**

1. Add synthetic corpus entries for staff layouts not yet covered — at
   minimum, piano (grand staff) — using the same `music21`/`verovio`
   rendering pipeline already built (it already supports arbitrary
   instrumentation; the existing corpus just hasn't used that range yet).
2. Run SMT **zero-shot** (no fine-tuning) against the full synthetic
   corpus — clean and degraded tiers — reusing the existing scoring code
   with the model under test swapped from Claude to SMT inference.
3. **Add a real-photo validation set.** Synthetic degradation (perspective
   warp, lighting gradient, blur, recompression) cannot fully reproduce
   real photographed sheet music: pencil markings, fingerings, bowings,
   genuine curved-page geometry, shadows, bad photocopies, scanner
   artifacts, partial systems, handwritten annotations, or edition-specific
   engraving. This project already has one deliberately-deferred real
   anchor case (a real clarinet photo, ground truth not yet transcribed —
   see `modal_worker/visual_validation_anchors/README.md`) for exactly this
   reason. Transcribing 50-100 real, representative Mediant score uploads
   is the minimum bar before any production decision, not optional
   polish.
4. Benchmark actual compute cost (reviewer's point 11, adopted) — CPU vs.
   T4 vs. L4 on Modal, including preprocessing, cold start, and
   pages/systems per analysis. Modal's per-second GPU pricing is
   approximately $0.000164/s (T4) and $0.000222/s (L4) per third-party
   aggregators citing Modal's own pricing page — not independently
   confirmed against `modal.com/pricing` directly in this round of
   research, so re-verify before finalizing a cost model.
5. Only after all of the above: decide whether fine-tuning is needed at
   all, and if so, scope it to the specific gaps measured (Section 7).

This runs entirely on self-hosted Modal GPU compute — zero Anthropic API
cost for the synthetic stage, independent of the current Anthropic credit
constraint. The real-photo transcription work (step 3) costs time, not API
dollars.

## 7. Fine-tuning plan (conditional)

Not scoped in detail here because it depends entirely on Section 6's
results. If Section 6 finds real gaps: the same corpus-build/degrade
scripts, extended to cover the gap instruments/layouts, double as training
data generators (not just eval data), and fine-tuning targets SMT
specifically (lighter and more tractable to self-host than LEGATO's
Llama-3.2-11B-Vision backbone) on exactly the gaps measured.

## 8. Cost model

| Call | Today | Candidate |
|---|---|---|
| Score reading (per *distinct* score file, not per analysis — see Section 1) | 3x Claude Sonnet 5 vision — **$2/$10** per 1M tokens in/out (verified against Anthropic's current pricing page; corrects the original draft's stale $3/$15) | Audiveris (free) + SMT (Modal GPU compute, ~$0.0002/GPU-second) always; Gemini's existing call extended first; new vision fallback only if that's insufficient, localized to the uncertain measures only |
| Coaching synthesis (per analysis, every time — not cached) | 1x Claude Sonnet 5 text — $2/$10 | 1x Claude Haiku 5.5 text — **$0.10/$0.50** (≤100K-token prompts) — 20x cheaper, not the ~3x the original draft estimated |

Model pins, corrected (reviewer's point 9, adopted — the original draft
incorrectly quoted one price for "Gemini 2.5 Flash/Pro" as if they were the
same model): `gemini-2.5-flash` is $0.30/$2.50 per 1M tokens
(input covers text/image/video); `gemini-2.5-pro` is approximately
$1.25/$10 for prompts under 200K tokens, per multiple independent secondary
sources — not fetched directly from Google's own pricing page in this
round, so treat as corroborated-but-not-primary-sourced until confirmed.

**No per-analysis dollar figure is claimed as fact anywhere in this
document.** The token prices above (Anthropic figures) are independently
verified against Anthropic's own current pricing page. Gemini and Modal
figures are corroborated across multiple secondary sources but not fetched
from the vendors' own pages in this round — re-verify before a go/no-go
decision. Actual per-analysis cost additionally depends on real image/output
token counts, real cache hit rate, and real fallback-utilization rate, none
of which are measured yet — that measurement is Section 6, not this table.

## 9. Error handling

Every new stage follows the exact fail-open convention already established
for Audiveris in this codebase: a crash, timeout, or low-confidence result
at any stage never blocks the pipeline and never causes a silent guess — it
degrades to the next stage up (SMT fails → Gemini-extension/vision fallback
fires; that fails → today's existing error-shaped result, `{"error": ...,
"measures": []}`). No new kill switches are introduced, matching the
existing design rationale: every failure mode already degrades to a
known-safe behavior by construction.

## 10. Testing strategy

- Score-reading cascade: extend the existing harness (Section 6) rather
  than building parallel test infrastructure; add the real-photo set and
  the product-metric measurements described there.
- Coaching-model comparison: Sonnet 5 vs. Haiku 5.5 vs. deterministic
  template (Section 4), on a sample of real past takes' verified issue
  lists, checked against the existing hard constraints (word limit,
  forbidden-phrase list, measure numbers reproduced verbatim) plus human
  review of coaching quality.
- Regression: the existing `test_analysis.py` suite and the existing
  Audiveris cross-validation tests must stay green throughout.

## 11. Open questions for review

1. Does SMT's architecture, trained on different repertoire, actually
   transfer to Mediant's real solo-instrument corpus well enough to be
   worth self-hosting? (Section 6 answers this empirically; there is
   currently no published checkpoint for this exact repertoire, so this is
   a genuine unknown, not a formality.)
2. Is Haiku 5.5 good enough for the coaching-text task, and does it clear
   the deterministic-template baseline by enough to justify its (small but
   nonzero) cost? (Section 10.)
3. What specific numeric thresholds (accuracy drop, catastrophic-failure
   rate, fallback-utilization rate) gate SMT's promotion to production
   primary? Not yet set — this needs real disagreement-rate and accuracy
   data from Section 6, not a guess made in advance.
4. Does extending the existing Gemini call's response schema (Section 3)
   actually work without degrading flag-authoring quality? Unknown until
   the controlled experiment runs.
5. What target gross margin should the cost model in Section 2 actually be
   built around? The $0.03-0.04/analysis figure here assumes 70% — this is
   a business decision, not a technical one, and needs your confirmation.
6. Real score-cache hit rate and real photo-recapture rate (how often the
   same piece gets re-photographed vs. re-uploaded identically across
   takes) — not measured yet, and directly determines whether score-reading
   cost is actually a per-piece cost or closer to a per-take cost in
   practice.

## 12. What changed in this revision, and why

Verified directly (not taken on the reviewer's word, and not left as the
original draft had it):

- **Score-cache "contradiction":** real, caused by imprecise wording in the
  original draft, not a real engineering bug — read the actual edge
  function and worker code (Section 1). The cache already uses a content
  hash, which was the reviewer's own suggested fix; it just predates this
  document.
- **Sonnet 5 pricing:** fetched Anthropic's current pricing page directly.
  The reviewer was right that $2/$10 is now permanent — this document's
  original $3/$15 came from a stale cached reference. Also found, in the
  course of checking this, that some third-party sources incorrectly claim
  $3/$15 is current; the primary source (Anthropic's own page) settles it.
- **Haiku 5.5 pricing and model ID:** confirmed $0.10/$0.50 (≤100K tokens)
  and `claude-haiku-5-5` directly against Anthropic's pricing page.
- **SMT parameter count (21.4M):** confirmed directly against the model's
  Hugging Face card.
- **Gemini 2.5 Pro pricing:** corroborated across multiple independent
  secondary sources at ~$1.25/$10, but not fetched from Google's own page —
  flagged as such rather than presented as equally certain.
- **Modal GPU per-second pricing:** corroborated across multiple
  third-party aggregators, not fetched from `modal.com/pricing` directly —
  flagged as such.

Adopted without reservation: candidate-not-default language for SMT,
explicit pass/fail criteria, product metrics alongside OMR metrics, the
real-photo validation stage, calibrated-not-raw agreement, localized
fallback reusing existing targeted-resolution machinery, testing the
existing Gemini call before adding a new vision call, corrected/pinned
Gemini model pricing, and the deterministic-coaching-baseline comparison.

Adopted with a correction to the reviewer's own framing: the cost-target
math (70% margin → ~$0.035/analysis) is arithmetically right, but the 70%
margin and 60-analyses-per-month inputs are business assumptions, not
established facts — presented here as pending your confirmation rather than
as settled.
