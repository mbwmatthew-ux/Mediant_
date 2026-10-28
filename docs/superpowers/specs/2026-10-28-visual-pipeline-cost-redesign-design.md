# Visual Pipeline Cost & Accuracy Redesign — Design

**Status:** Revised after two rounds of external technical review. Current
decision, per the reviewer's own table: content-hash cache (keep as-is),
Audiveris (keep), SMT integration (approved for experimental validation
only), calibrated reconciliation / localized vision fallback / Gemini
cross-check extension (design approved, each still needs its own
controlled experiment), Haiku 5.5 coaching (approved for A/B evaluation).
**Immediate production migration is explicitly not yet approved.** Nothing
in Sections 3-4 is a committed production change; each is a candidate
pending the acceptance criteria in Section 6 and, beyond that, the shadow
deployment in Section 11.

**Revision note:** this version incorporates a second round of review,
focused on experimental rigor and deployment safety rather than factual
corrections (the first round's pricing/caching corrections already landed).
Section 14 at the end records the full revision history across all three
review rounds.

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
   - **Try extending the Gemini call already being made, first — but
     respecting the real execution order (round 2 review, adopted).** The
     first draft of this bullet assumed Gemini could be told exactly which
     measures Audiveris/SMT found uncertain and cross-check just those.
     That's not how the pipeline actually runs: `_gemini_pipeline` and
     `_score_pipeline` are dispatched in the same `ThreadPoolExecutor` batch,
     in parallel, specifically to cut total latency ~50%
     (`run_full_analysis`, "Steps 2-4 in parallel"). Reconciliation's
     uncertain-measure list doesn't exist yet when Gemini's call is
     dispatched, so Gemini can't be targeted at it without either adding a
     sequential dependency (losing that latency win) or restructuring the
     pipeline. The approach to test instead: have Gemini return a
     **broader, unconditional** score-crosscheck of every page it already
     sees (not targeted at specific measures), independent of
     Audiveris/SMT, and reconcile the two results afterward — both are
     already available by the time `compare_and_coach_claude` runs, after
     all three branches join. This preserves parallel execution and needs
     no pipeline restructuring. Also worth stating plainly: no new API
     *call* doesn't mean no new *cost* — a longer prompt and a richer
     response both add tokens to a call that's already happening, which
     needs measuring, not assumed to be free.
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

**Threshold-setting methodology (round 2 review, adopted):** the acceptance
criteria below must not be set by looking at the same data they're then
evaluated against — picking a threshold after seeing how SMT scores on the
full corpus risks unconsciously choosing a number that happens to pass.
Split the corpus into a **calibration set** (used only to pick the
numeric thresholds) and a separate **held-out test set** (used only for
the actual accept/reject measurement), and never let a threshold be
adjusted after seeing the held-out set's results. Honest caveat: at 24
synthetic pieces, splitting further for calibration leaves few pieces per
side — the real-photo set (Section 6, step 3) and any corpus expansion
should be sized with this split in mind, not just as validation volume.

**Report confidence intervals and instrument-specific breakdowns, not just
an aggregate (round 3 review, adopted).** A small sample split further for
calibration is exactly the condition under which an aggregate accuracy
number can hide a real problem — a small aggregate improvement could
conceal a large regression confined to one instrument (e.g. piano's
grand-staff layout, the one layout with the least evidence SMT handles
well). Every reported accuracy figure in this validation must come with a
confidence interval and a per-instrument (violin/cello/flute/piano)
breakdown, not an aggregate alone.

**The gate is the complete cascade's accuracy, not SMT's accuracy in
isolation (round 3 review, adopted — sharpened from round 2's wording).**
SMT can score worse than Sonnet 5 in a standalone, reader-vs-reader
comparison while the combined Audiveris + SMT + Gemini-crosscheck +
localized-fallback system still matches or beats the current pipeline
end-to-end, because the cascade's fallback step exists precisely to catch
SMT's individual mistakes. The acceptance criteria below are evaluated
against the **full cascade's output**, never against SMT's standalone
output — a standalone SMT-vs-Sonnet comparison (Section 6, step 2) is a
useful diagnostic for understanding *why* the cascade performs the way it
does, but it is explicitly not the promotion gate by itself.

**Two independent ceilings on acceptable accuracy loss, not one (round 4
review, adopted).** A threshold set purely from the zero-shot measurement
risks calibrating acceptability to whatever the candidate happens to
achieve, rather than to what the product actually requires. Mediant is a
paid subscription promising consistent analysis quality — "regression"
needs a ceiling grounded in that promise, independent of the experiment's
own results, not just a data-driven one:

- **Product-required ceiling**, set *before* looking at SMT's results, from
  what a paying user's feedback quality needs to stay trustworthy (e.g. a
  maximum acceptable drop in correct-flagged-measure rate, chosen as a
  product requirement). This number must exist before Phase 2's
  experiments run, not be backed into afterward.
- **Data-driven ceiling** from the zero-shot measurement, used for
  exploratory calibration as already described.

Promotion requires clearing the **stricter** of the two, not just one.

**Explicit acceptance criteria — SMT is promoted from candidate to
production primary reader only if, measured end-to-end for the full
cascade against the held-out test set (never the calibration set):**

- End-to-end measure-localization accuracy does not fall by more than the
  stricter of the product-required ceiling and the data-driven threshold
  above, reported with confidence intervals and per-instrument breakdowns.
- The rate of catastrophic score-read failures (not "imperfect," but
  unusable — e.g. wrong time signature cascading into wrong measure
  numbers throughout) stays below an explicit ceiling, checked
  per-instrument, not only in aggregate.
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

**Train/eval separation (round 2 review, adopted) — split by piece, not by
image.** The existing corpus generates multiple page images and several
degradation variants (clean/mild/severe) per underlying piece. A split that
randomly assigns individual *images* to train vs. eval risks putting one
degraded variant of a piece in training and another variant of the *same*
piece in evaluation — fine-tuning could then look like it generalizes when
it's partly just recognizing that specific score. The split must happen at
the **piece/edition level, before** degradation variants are generated:
every variant of a given piece goes entirely to one side. This applies to
the real-photo set from Section 6 too — if a real photo and a piece already
in the synthetic corpus are the same underlying composition/edition, they
count as the same piece for split purposes, not independent data points.

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

**Three-state status, in structured data — not just prose (round 2 review,
adopted).** Today, a measure the score reader can't confidently read is
silently dropped before it reaches the coaching prompt (`unresolved_measures`
suppresses it at flag emission — see Section 4). That collapses what should
be three distinct outcomes into one silent gap:

- **Verified** — reliable score alignment; feedback given with full
  confidence.
- **Partial** — some measures couldn't be evaluated; feedback is still
  given for every measure that *could* be verified, and the specific
  unreadable measure numbers are identified explicitly.
- **Unavailable** — score extraction failed badly enough that no
  measure-linked feedback can be given at all for that take.

This status, and the specific unreadable measure numbers in the partial
case, must be carried as a **structured field** on the analysis result
(alongside the existing per-measure confidence data), not left solely to
whatever the coaching model's prose happens to mention — prose can be
reworded, summarized, or dropped by a model; a structured field can't. The
frontend and any future consumer of the analysis result then both read the
same authoritative signal instead of parsing it out of generated text.

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

## 11. Shadow deployment and rollout (round 2 review, adopted)

Clearing Section 6's acceptance criteria on the validation corpus is
necessary but not sufficient to flip every production analysis onto the
new cascade — a synthetic-plus-real-photo offline corpus, however good,
is still not live production traffic. Before any user-visible switch:

1. **Shadow mode.** Run the candidate cascade (Audiveris + SMT +
   calibrated reconciliation + Gemini-extension/localized fallback)
   alongside the current pipeline on a representative sample of real
   analyses, computing its answer but never showing it to the user —
   the current pipeline stays the sole user-visible authority. Measure,
   against real traffic: agreement with the current pipeline, localization
   accuracy where ground truth exists (the held-out test set, plus any
   DTW-alignment-success signal available without ground truth), fallback
   utilization rate, latency, and real dollar cost.
   **The current pipeline is not ground truth (round 3 review, adopted)**
   — it has its own known failure modes (that's the entire reason this
   project built a validation harness in the first place). When shadow and
   current disagree, don't automatically score that as the candidate being
   wrong: route a sample of disagreements to independent adjudication
   against real ground truth (manual review, or the held-out test set's
   verified data where the disagreement happens to fall on a piece it
   covers) instead of silently treating "matches the current pipeline" as
   the success metric.
2. **Gradual rollout.** Only after shadow-mode results look acceptable,
   introduce the new cascade to real users incrementally (not a full
   switch), with an explicit **rollback mechanism** — a way to revert to
   the current pipeline quickly if quality or reliability degrades in
   production in a way the offline validation didn't predict.

This matters more for a subscription product promising consistent
analysis quality than it would for a one-off tool: a regression here is a
regression every subscriber notices, not a contained experiment.

## 12. Implementation sequence (round 3 review, adopted)

Three rounds of review in, both reviewers converge on the same point: this
spec's remaining question is empirical, not architectural, and no further
design revision can answer it. The reviewer's four-phase sequence maps
directly onto work this document already specifies — restated here as the
concrete order of operations, since this is what the implementation plan
gets built from:

1. **Establish the baseline.** Measure what today's pipeline actually
   costs and does — real Sonnet 5 vision cost per distinct score file,
   real coaching cost, real score-cache hit rate, real accuracy, real
   latency. Several of these are named as unmeasured throughout this
   document (Section 2, Section 1's caching discussion, open questions 5
   and 6) — this phase is what turns those into real numbers instead of
   assumptions, and requires no new code beyond instrumentation.
2. **Independent experiments.** SMT zero-shot (Section 6, steps 1-2),
   Gemini cross-check extension (Section 3's fallback bullet), and Haiku
   5.5 coaching (Section 4) — each evaluated separately against the
   current pipeline before anything is combined. Zero Anthropic API cost
   for the SMT piece; a small, bounded cost for the Gemini and Haiku A/B
   comparisons.
3. **Combined cascade evaluation.** Only after Phase 2's individual
   results exist: assemble the full cascade and measure it end-to-end —
   accuracy (with confidence intervals and instrument breakdowns, per
   Section 6), fallback utilization, cost, and latency, on the held-out
   test set. This is the actual gate from Section 6, not Phase 2's
   individual-component results.
4. **Shadow test and controlled rollout** (Section 11) — only after Phase
   3 clears the acceptance criteria, and still without a user-visible
   switch until shadow-mode results hold up.

Phases 1-2 need no production code changes and no shadow-deployment risk
— they're the natural scope for a first implementation plan. Phases 3-4
depend on what 1-2 actually find (if SMT's zero-shot accuracy on solo
violin/cello/flute is poor enough, the cascade's shape itself may need to
change before Phase 3 can even be scoped) and are better planned once that
data exists, not speculatively now.

**Binding conditions on the Phase 1-2 implementation plan (round 4 review,
adopted — approval for Phases 1-2 is conditioned on these):**

1. **Explicit API-spending limits.** Phase 2's Gemini and Haiku A/B
   comparisons spend real (small, bounded) Anthropic/Google API dollars —
   the implementation plan must state a hard cap up front, not an
   open-ended "run some comparisons."
2. **Existing production behavior is preserved, unconditionally.** Nothing
   in Phases 1-2 changes what a real user's analysis receives — baseline
   instrumentation and independent experiments observe and measure
   production inputs/outputs, they do not alter the live decision path.
3. **Experimental code stays separate from the production execution
   path.** Phase 1-2 code (corpus tooling, SMT inference, the Gemini
   schema-extension experiment, the Haiku A/B harness) lives alongside
   `modal_worker/worker.py` the way this session's existing validation
   harness already does (`modal_worker/build_visual_validation_corpus.py`
   and siblings) — imported from, never merged into, the function that
   serves real traffic — until Phase 3/4 explicitly promotes something.

**Five concrete deliverables Phases 1-2 must produce (round 4 review,
adopted):**

1. A measured baseline: real cost, latency, accuracy, and cache
   effectiveness for the current pipeline.
2. SMT zero-shot accuracy results, broken down by instrument (violin,
   cello, flute, piano).
3. A controlled evaluation of Gemini's expanded cross-check output.
4. A Sonnet 5 vs. Haiku 5.5 vs. deterministic-template coaching
   comparison.
5. A consolidated report stating, from 1-4, whether the proposed cascade
   architecture warrants building out Phases 3-4 at all — the actual
   decision this entire validation phase exists to produce.

## 13. Open questions for review

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
   primary? Set from the calibration split (Section 6), not guessed in
   advance, and not set by looking at the held-out test set.
4. Does extending the existing Gemini call's response schema (Section 3)
   actually work — as a broader unconditional crosscheck, not a
   targeted-to-uncertain-measures one — without degrading flag-authoring
   quality or adding more token cost than it saves? Unknown until the
   controlled experiment runs.
5. What target gross margin should the cost model in Section 2 actually be
   built around? The $0.03-0.04/analysis figure here assumes 70% — this is
   a business decision, not a technical one, and needs your confirmation.
6. Real score-cache hit rate and real photo-recapture rate (how often the
   same piece gets re-photographed vs. re-uploaded identically across
   takes) — not measured yet, and directly determines whether score-reading
   cost is actually a per-piece cost or closer to a per-take cost in
   practice.

## 14. Revision history

### Round 1 (factual corrections)

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

### Round 2 (experimental rigor and deployment safety)

No factual disputes this round — the reviewer's own second-review message
confirmed the Haiku 5.5 model ID and pricing independently, matching
Round 1's verification. All five points were methodological/architectural
and adopted:

- **Calibration/held-out split** for setting SMT's acceptance thresholds
  (Section 6), so the same data can't both pick the threshold and pass it.
- **Gemini cross-check reframed** from "targeted at uncertain measures"
  (which silently assumed a sequential dependency the real parallel
  pipeline doesn't have) to "broader unconditional crosscheck, reconciled
  after both branches join" (Section 3) — verified against
  `run_full_analysis`'s actual parallel-dispatch structure, confirming the
  reviewer's architectural reading was correct.
- **Piece-level train/eval split** for any future fine-tuning data
  (Section 7), to prevent degraded variants of the same piece leaking
  across the split.
- **Three-state status in structured data** (verified/partial/unavailable,
  Section 9), not left to coaching prose.
- **Shadow deployment and gradual rollout** (new Section 11) before any
  user-visible switch, regardless of how well the offline validation goes.

### Round 3 (testing-protocol refinements; reviewer's verdict: stop
revising architecture, begin validation)

No architectural objections this round — explicitly framed by the
reviewer as refinements to the testing protocol. Adopted:

- **Confidence intervals and per-instrument breakdowns** required on every
  accuracy figure (Section 6), not an aggregate alone — a small corpus
  split further for calibration is exactly the condition where an
  aggregate can hide a regression confined to one instrument.
- **The promotion gate is the full cascade's end-to-end accuracy, not
  SMT's standalone accuracy** (Section 6, sharpened from Round 2's
  wording) — SMT can lose a standalone comparison to Sonnet 5 while the
  combined system with fallback still wins; a standalone comparison is a
  diagnostic, not the gate.
- **Shadow-mode disagreements get independently adjudicated, not scored
  against the current pipeline as if it were ground truth** (Section 11)
  — the current pipeline has its own known failure modes.
- **Four-phase implementation sequence** (new Section 12) — baseline
  measurement, independent component experiments, combined-cascade
  evaluation, then shadow test and rollout — restated from the reviewer's
  own sequence since it maps directly onto work this document already
  specifies, and is the structure the implementation plan gets built from.

The reviewer's own closing framing is worth preserving verbatim in spirit:
the design's completeness is now assessed as strong; whether the proposed
cascade actually works and is actually cheaper remains unproven until the
experiments run. That is Phase 1 and 2's job, not another revision of this
document.

**Round 4** (final clarification, then explicit approval to begin
implementation): added a product-required accuracy-regression ceiling,
set before looking at results, alongside the data-driven zero-shot
threshold — promotion now requires clearing the stricter of the two, not
a threshold calibrated solely to what the candidate happens to achieve.
Phases 1-2 approved, conditioned on explicit API-spending limits,
unconditional preservation of existing production behavior, and
experimental code staying separate from the production execution path
until a later phase explicitly promotes it. Five concrete deliverables
specified for Phases 1-2. Reviewer's verdict: "the next step is
engineering execution, not another architecture review."
