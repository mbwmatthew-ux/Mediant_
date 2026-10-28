# Visual Pipeline Cost & Accuracy Redesign — Design

**Status:** Draft, pending review (this copy is also being shared with an outside
technical reviewer before implementation planning begins).

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
    │   only
    │
    └─→ Gemini pipeline: video + every score page uploaded to Gemini
        2.5 Flash/Pro, which watches+reads together and authors the actual
        performance flags (wrong note, rhythm, dynamics, articulation)
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
coaching text) + parsed score (cached by score_path for reuse on the next
take of the same piece)
    │
    ▼
Frontend: score stays visible during analysis, flagged measures highlighted,
Loop plays the exact flagged range, next take's analysis explicitly compares
to the previous take
```

Two independent per-analysis API cost centers exist today, not one:

1. **Score reading** — 3x Claude Sonnet 5 vision calls, unconditionally, every analysis.
2. **Coaching synthesis** — 1x Claude Sonnet 5 text call, unconditionally, every analysis.

Gemini's flag-authoring step is already on a cheaper model family
(2.5 Flash/Pro) and is **not** a target of this spec — it's noted here only
so the reviewer has the full cost picture, not because anyone has asked for
it to change.

## 2. Problem statement

Current Anthropic API spend is unsustainable against the business model:
$7/month, unlimited use, with an assumed average of ~60 analyses/user/month
— meaning each analysis needs to cost roughly $0.10 **total** (across score
reading, coaching, and anything else) to keep the subscription profitable.
The team has exhausted its Anthropic credit allowance multiple times in
recent weeks. Score reading (3 full Sonnet 5 vision calls per analysis,
Sonnet 5 running adaptive thinking by default) is believed to be the
dominant cost center — this has not yet been measured with real dollar
figures per analysis, only reasoned about from token pricing; getting a real
measured number is part of this spec's validation plan (Section 6), not an
assumed fact.

## 3. Proposed change A: score-reading extraction cascade

**Goal:** stop treating the most expensive available model as the default,
unconditional reader. Reserve it for pages that actually need it.

**Scope boundary:** "universal" here means solo-instrument notation across
instrument types (violin, cello, flute, piano, etc. — including multi-staff
solo instruments like piano's grand staff, which is one performer reading
two staves). It does **not** mean multi-performer ensemble/orchestral
scores — that remains an explicitly pending, unapproved product decision
(`agent_workspace/PRODUCT_DECISIONS.md`), not something this spec expands.

**Architecture:**

1. **Audiveris** (unchanged) — free, deterministic, open-source OMR, already
   self-hosted on the existing Modal image, already runs on every row of
   every raster page in parallel with Claude today. No change to this stage
   itself.
2. **SMT-based transcription (new)** — Sheet Music Transformer
   (`github.com/antoniorv6/SMT`, MIT licensed, pretrained weights on Hugging
   Face), self-hosted on Modal GPU compute (billed by compute time, not
   per-token), becomes the default primary reader, replacing Sonnet 5 as the
   first choice. Instrument metadata (already captured at upload) routes to
   the right staff-layout handling — single staff for violin/cello/flute/etc.,
   grand staff for piano.
3. **Reconciliation** — Audiveris's and SMT's readings are compared using the
   existing confidence-state machine (`fuse_measure_confidence` /
   `_cross_source_measure_match`), extended to accept SMT as a source the
   same way it already accepts Audiveris's `oemer_measure` parameter.
4. **Claude/Gemini vision (demoted to rare fallback)** — dispatched only
   when Audiveris and SMT disagree, or both report low confidence, on a
   meaningful portion of the piece. This is where most of today's cost goes
   away: the expensive path becomes conditional, not default. Every page
   still gets the best answer the system can produce for *that specific
   page* — a clean page resolves cheaply and confidently; a hard page still
   gets the expensive check. No analysis is ever given a worse result to
   save money; the system only spends more when the cheap stages genuinely
   couldn't agree.

**Known risk, stated plainly for the reviewer:** SMT's publicly available
checkpoints are narrowly scoped by their training data —
`smt-camera-grandstaff` is documented as "pianoform images only," and
`smt-string-quartets` is scoped to ensemble parts. Neither is confirmed to
generalize to the solo violin/cello/flute repertoire that makes up most of
this product's real corpus. This is exactly why Section 6 (validation)
happens *before* any commitment to fine-tuning, rather than assuming SMT
works and finding out in production.

## 4. Proposed change B: coaching-synthesis model

**This maps directly onto what was described conversationally as "Haiku
makes the final judgment call."** It turns out this isn't a new call to add
— it's an existing one to change. `compare_and_coach_claude` is already the
single point where the visual (score/DTW-verified issues) and audio
(Gemini's assessment, CREPE-derived timing) analysis merge into the text the
user actually reads. It already receives `instrument`, the verified issue
list, and Gemini's assessment. It is **text-only** — no images — and the
prompt is a tightly templated rewrite task (fixed JSON schema, explicit
"2 sentences, 40 words max" constraint, forbidden-phrase list). That's a
good fit for a materially cheaper model.

**Proposed change:** swap `CLAUDE_MODEL` in `compare_and_coach_claude`
(`worker.py:8149`) from `claude-sonnet-5` to `claude-haiku-4-5`. Same prompt,
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
silent gap. This is a small, additive prompt change on the same call, not a
new architectural piece.

**Open question, not yet answered:** is Haiku 4.5's writing quality on this
exact templated task good enough to ship? This needs a real comparison
(same inputs, both models, human judgment on a sample of real past takes)
before committing — not assumed from pricing alone.

## 5. Explicitly out of scope

- Gemini's flag-authoring step (`evaluate_with_gemini`) — already on a
  cheaper model family, not raised by anyone as a problem.
- Multi-performer ensemble/orchestral score support — pending, unapproved
  product decision.
- Non-standard notation (handwritten manuscripts, tablature) — not
  addressed by SMT's available checkpoints and not requested.
- Replacing DTW alignment, CREPE pitch tracking, or the Loop/comparison
  features — all unchanged by this spec.

## 6. Validation plan (before any fine-tuning commitment)

This project already built a validation harness this session
(`modal_worker/build_visual_validation_corpus.py`,
`modal_worker/degrade_visual_corpus.py`,
`modal_worker/validate_score_reading_against_corpus.py`) against a 24-piece
MusicNet-derived corpus (solo violin/cello/flute) with clean/mild/severe
degradation tiers and real music21-derived ground truth, scored via
`_cross_source_measure_match`. This spec extends it rather than replacing
it:

1. Add synthetic corpus entries for staff layouts not yet covered — at
   minimum, piano (grand staff) — using the same `music21`/`verovio`
   rendering pipeline already built (it already supports arbitrary
   instrumentation; the existing corpus just hasn't used that range yet).
2. Run SMT **zero-shot** (no fine-tuning) against the full corpus — clean
   and degraded tiers — reusing the existing scoring/aggregation code with
   the model under test swapped from Claude to SMT inference.
3. Measure the real zero-shot accuracy gap, broken down by instrument/staff
   layout. This tells us which, if any, staff layouts need fine-tuning —
   not a guess.
4. Only after that measurement: decide whether fine-tuning is needed at
   all, and if so, scope it to the specific gaps found (Section 7).

This runs entirely on self-hosted Modal GPU compute — zero Anthropic API
cost, independent of the $19.93 Anthropic credit constraint.

## 7. Fine-tuning plan (conditional)

Not scoped in detail here because it depends entirely on Section 6's
results — speculatively designing a training run before knowing whether one
is needed would violate this project's own "validate before committing"
principle. If Section 6 finds real gaps: the same corpus-build/degrade
scripts, extended to cover the gap instruments/layouts, double as training
data generators (not just eval data), and fine-tuning targets SMT
specifically (lighter and more tractable to self-host than LEGATO's
Llama-3.2-11B-Vision backbone) on exactly the gaps measured.

## 8. Cost model (estimated, not yet measured — flagged as such)

| Call | Today | Proposed |
|---|---|---|
| Score reading (per analysis) | 3x Claude Sonnet 5 vision ($3/$15 per 1M tokens in/out) | Audiveris (free) + SMT (Modal GPU compute) always; Claude/Gemini vision only on disagreement |
| Coaching synthesis (per analysis) | 1x Claude Sonnet 5 text ($3/$15) | 1x Claude Haiku 4.5 text ($1/$5) — ~3x cheaper, same call |

Gemini 2.5 Flash/Pro pricing ($0.30/$2.50 per 1M tokens) is included here
only as a reference point for the rare-fallback case in Section 3, if that
fallback uses Gemini rather than Claude — not yet decided, and not load-bearing
for this spec's approval.

**No per-analysis dollar figure is claimed as fact anywhere in this
document.** The token-price numbers above are from current published rate
cards; actual per-analysis cost depends on real image/output token counts
that haven't been measured yet. Getting that real number is explicitly part
of the validation work, not assumed here.

## 9. Error handling

Every new stage follows the exact fail-open convention already established
for Audiveris in this codebase: a crash, timeout, or low-confidence result
at any stage never blocks the pipeline and never causes a silent guess — it
degrades to the next stage up (SMT fails → Claude/Gemini fallback fires;
Claude/Gemini fails → today's existing error-shaped result,
`{"error": ..., "measures": []}`). No new kill switches are introduced,
matching the existing design rationale: every failure mode already
degrades to a known-safe behavior by construction.

## 10. Testing strategy

- Score-reading cascade: extend the existing harness (Section 6) rather
  than building parallel test infrastructure.
- Coaching-model swap: a focused comparison on a sample of real past takes'
  verified issue lists, run through both Sonnet 5 and Haiku 4.5, reviewed
  for whether the output still satisfies the existing constraints (word
  limit, forbidden-phrase list, correct measure numbers verbatim from the
  input — this is a rewrite task, not a reasoning task, so a strict format
  check plus a sample of human review should be sufficient).
- Regression: the existing `test_analysis.py` suite and the existing
  Audiveris cross-validation tests must stay green throughout.

## 11. Open questions for review

1. Does SMT's architecture, trained on different repertoire, actually
   transfer to Mediant's real solo-instrument corpus well enough to be
   worth self-hosting? (Section 6 answers this empirically before any
   commitment.)
2. Is Haiku 4.5 good enough for the coaching-text task, or does the
   template need adjusting to compensate for a smaller model? (Needs the
   comparison in Section 10, not assumed.)
3. What confidence threshold should trigger the Claude/Gemini fallback in
   Section 3 (how much disagreement is "enough of the piece to matter")?
   Not yet specified numerically — this needs to be set from real
   disagreement-rate data once the cascade exists, not guessed in advance.
4. Should the rare fallback in Section 3 use Claude or Gemini vision? Both
   are viable; Gemini is meaningfully cheaper per the research in this
   project's history, but has no track record on this exact task in this
   codebase the way Claude's 3-way-read mechanism does. Not resolved here.
