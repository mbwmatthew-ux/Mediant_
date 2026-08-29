# Analysis Accuracy Baseline

Status: **not yet measured.** This document exists to make the measurement
mechanical, not to report a number. There is no honest number to report today
— see "Why there is no number" below.

Last updated: 2026-08-29, at the close of Phase 1 (`analysis-accuracy-phase-1`,
plan `.superpowers/sdd/2026-08-28-measured-analysis-accuracy/`).

---

## Why there is no number

Producing precision/recall requires reading `takes` joined against
`flag_annotations` from the project's Supabase database. That requires
service-role credentials — `flag_annotations` denies both `anon` and
`authenticated` writes, and the `fa_service_read` policy exists specifically
to gate this kind of read. This environment has no service-role access
configured, so Step 1 of the harvesting process (below) has not been run.

This is a deliberate deferral, not an estimate standing in for one. No
precision or recall figure appears anywhere in this document, including as an
example — a plausible-looking number in a file titled "baseline" would be
indistinguishable from a measured one to a future reader, and inventing it is
the exact failure this plan exists to prevent. The honest state of the
corpus, right now, is unknown — not "small," not "n=3." Unknown.

Whoever next has service-role access can populate this document by running the
query below and passing its output through
`modal_worker/score_against_annotations.py`. Nothing about the tooling is
missing or unfinished; only the credentials and the calendar time for teachers
to annotate enough takes are missing.

---

## Step 1: the harvesting query

Run this against the project database with service-role access. It has not
been run as part of this task.

```sql
SELECT t.id, t.instrument, t.piece_title,
       jsonb_array_length(COALESCE(t.flags, '[]'::jsonb)) AS n_flags,
       COUNT(a.id) AS n_annotations,
       COUNT(*) FILTER (WHERE a.action = 'approve') AS approved,
       COUNT(*) FILTER (WHERE a.action = 'edit')    AS edited,
       COUNT(*) FILTER (WHERE a.action = 'reject')  AS rejected,
       COUNT(*) FILTER (WHERE a.action = 'add')     AS added
FROM takes t
LEFT JOIN flag_annotations a ON a.take_id = t.id
WHERE t.job_status = 'done'
GROUP BY t.id
ORDER BY n_annotations DESC;
```

This gives a per-take overview — how many flags shipped, how many were
annotated, and the split of teacher verdicts. It is a sanity check on corpus
size, not the input to the scorer itself. The scorer (Step 2) needs the raw
rows: each take's `flags` array and the full set of `flag_annotations` rows
for that take (`take_id`, `flag_key`, `flag_index`, `action`, `edited_flag`,
`updated_at`), not just the aggregate counts above.

## Step 2: turning the query into numbers

`modal_worker/score_against_annotations.py` computes precision and recall. It
takes no database connection of its own — feed it the rows Step 1 (or the
underlying per-take/per-annotation query) returns.

For each take:

```python
from score_against_annotations import score_take, aggregate, format_report

per_take = [score_take(take["flags"], annotations_for(take["id"]))
            for take in done_takes]
totals = aggregate(per_take)
print(format_report(totals))
```

`score_take(flags, annotations)` returns per-flag-type counts for one take.
`aggregate(per_take)` sums those across every take and derives precision and
recall. `format_report(totals)` renders the fixed-width table reproduced
empty, below.

### Counting rules (from the module's own docstring — read `score_against_annotations.py` for the full reasoning)

- **approve or edit → true positive.** An edit means the finding was real and
  only the wording was wrong; that is a writing problem, and folding it into
  the detection score would hide both a real writing problem and a real
  detection success.
- **reject → false positive.**
- **add → false negative.** Something real the analyzer never reported.
- **unlabelled → excluded from both.** Never counted as correct. Most flags
  will be unlabelled early in the corpus's life, and treating silence as
  approval is exactly how a precision number flatters itself.

`precision = tp / (tp + fp)`, `recall = tp / (tp + fn)`. Either is `n/a`
(reported as `None`, not `0`) when its denominator is zero — a flag type with
no labelled shipped flags has no precision, not 0% precision, and a flag type
that was never added-as-missing has no recall gap to report.

### Two extra columns, and why they matter more than the headline number

`format_report` prints two columns beyond precision/recall/tp/fp/fn/labelled:

- **`legacy_matched`** — annotations written before the `flag_key` field
  existed carry `flag_key = NULL` but a valid `flag_index` (the flag's array
  position at annotation time). The scorer falls back to matching those by
  position. That match is only correct if the take has not been re-analysed
  since the annotation was written — re-analysis can reorder or replace the
  flags array, silently pointing a stale `flag_index` at the wrong flag. Rows
  matched this way are counted and reported separately rather than folded
  invisibly into the reliable `flag_key` path, so a reader can see how much
  of a number rests on positional matching versus the durable key.
- **`disagreed`** — `flag_annotations` no longer enforces one row per
  `(take_id, teacher_id, flag_key)` (dropped deliberately in migration
  20260829000003, because re-analysing and re-annotating the same issue can
  legitimately produce two rows sharing a `flag_key`). The scorer keeps only
  the most recent row per `flag_key` (latest `updated_at` wins). That dedup
  also silently swallows a different case: two *different* teachers grading
  the same flag_key with different verdicts — one approve, one reject. Which
  one "wins" is an artifact of who graded later, not a real resolution of the
  disagreement. Every such case is tallied in `disagreed` so a reader can see
  how much of the precision/recall number rests on a judgement call rather
  than a clean, uncontested read.

A precision figure quoted without these two columns is not comparable across
corpora and should not be trusted on its own — a flag type with a high
`legacy_matched` or `disagreed` count relative to its `n_labelled` needs a
wider error bar than the raw percentage implies.

### A third caveat that has no column yet: re-analysis invalidates annotations

`analysis_evidence.take_id` is the table's primary key and the webhook upserts
`ON CONFLICT (take_id)`, so **re-analysing a take overwrites its evidence
bundle.** Annotations, meanwhile, persist and are matched by `flag_key`.

The failure that produces:

> A teacher rejects `timing:20` when it measured 130 ms. The take is
> re-analysed. `timing:20` now measures 400 ms and is plainly correct. The
> stale reject still matches by key and is counted as a false positive against
> a measurement that never produced it.

Neither existing column catches this. `disagreed` is about two *raters*
conflicting, not a rater conflicting with a *later measurement*.
`legacy_matched` is about positional matching, and this row matched cleanly on
its key. So a re-analysed corpus can understate precision with nothing in the
report saying so.

**Detection signal, for whoever wires it up:** compare the time the *current*
bundle was written against the annotation's `updated_at`. An annotation older
than the bundle it is being scored against was written about a different
measurement, and belongs in a third caveat column (`stale_after_reanalysis`, or
similar) rather than being silently trusted.

**That signal does not exist yet, and `created_at` is not it.**
`analysis_evidence.created_at` is `DEFAULT NOW()` on INSERT, and the webhook's
upsert sets only `take_id`, `version` and `bundle` — so on the conflict path
`created_at` keeps its *original* value and still reads as the first analysis
even after the bundle has been replaced. Wiring this up therefore needs a
schema change first (an `updated_at` column with an on-update trigger, or the
webhook stamping a written-at timestamp explicitly), not just a scorer change.

All of that is deliberately **not implemented in Phase 1** — it is Phase 2
work, recorded here so nobody quotes a number off a re-analysed corpus without
knowing this is in it. Until it exists, prefer scoring takes that have been
analysed exactly once.

## Step 3: what comes after this document (calibration, not this plan)

`modal_worker/replay.py` re-decides flags from a stored evidence bundle
(`analysis_evidence`, written by every analysis run since Task 2 of this
phase) under different numeric thresholds — offline, deterministically, with
no audio, network or API keys. It exists so that changing e.g. the timing
placement threshold from 110ms to 90ms can be evaluated against the whole
corpus in milliseconds instead of re-running the pipeline against real
recordings.

**Its limitations, restated here because they bound what the next phase can do
even once this baseline is populated.** There are two, and the second is the
bigger one.

**1. It cannot evaluate a change to *how* something is measured.**
`replay_bundle` re-applies a final numeric gate to an already-measured value. A
new pitch-tracking model, a different analysis window, a new detector — all
require a real pipeline run against real audio.

**2. It cannot measure a loosening, and therefore cannot measure recall.**
`replay_bundle` *filters* `bundle["flags"]` — the flags that already shipped. So
the question it answers is **"which already-shipped flags survive at threshold
X?"**, not "what would this take have reported at threshold X?". Tightening a
threshold removes flags that are in the bundle, so its effect on **precision**
is measurable. Loosening a threshold would admit flags that were never emitted
and are therefore not in the bundle at all, so replay can never show them.

**Recall — the thing Phase 2 most needs to improve — is the one direction this
tool cannot measure.** `bundle["timing_notes"]` and `bundle["events"]` do carry
the raw per-note residuals and cents that would in principle let a looser gate
be evaluated, but doing so means *re-deriving* flags from those arrays, which
this harness deliberately does not do. Anyone who needs a loosening measured
has to write that re-derivation or run the real pipeline; a replay sweep must
not be read as having covered it.

A related gap worth knowing before trusting a sweep: **no threshold is recorded
in the bundle.** `replay.py`'s `DEFAULT_THRESHOLDS` is a hand-maintained mirror
of the constants in `worker.py`, nothing enforces the correspondence, and it
has already drifted from production once (an `overall` rule with no threshold
mapping, and a `<=`/`<` boundary mismatch on `contrast` — both fixed
2026-08-29). Re-check that table against `worker.py` before quoting a sweep.

---

## Results (empty — no measurement taken)

Corpus size: **not queried.** Date of measurement: **not yet measured.**

| Flag type   | Precision | Recall | Labelled (n) | Legacy matched | Disagreed | Target |
|-------------|-----------|--------|---------------|-----------------|-----------|--------|
| intonation  | not measured | not measured | — | — | — | not set |
| timing      | not measured | not measured | — | — | — | not set |
| error       | not measured | not measured | — | — | — | not set |
| dynamics    | not measured | not measured | — | — | — | not set |
| tone        | not measured | not measured | — | — | — | not set |
| posture     | not measured | not measured | — | — | — | not set |
| technique   | not measured | not measured | — | — | — | not set |

`tone`, `posture` and `technique` are Gemini-only observations with no
corroborating measurement (`evidence_class: "unverifiable"` in
`modal_worker/evidence.py`'s `_DETECTOR_BY_TYPE`) — precision/recall are still
computable from teacher verdicts for these types, but there is no numeric
threshold behind them for `replay.py` to calibrate. `intonation`, `timing`,
`error` and `dynamics` are `"measured"` and have thresholds `replay.py` can
tune once real numbers exist.

Targets are intentionally blank. Setting a target precision/recall before the
first real measurement would itself be a fabricated number wearing a
different hat — a target implies a plan to get there, and there is nothing
to plan toward yet.

---

## Where Phase 1 actually left the plan's five Terminal State criteria

The plan
(`docs/superpowers/plans/2026-08-28-measured-analysis-accuracy.md`) sets five
criteria. The honest grade at the close of Phase 1 is **two partly true, three
not yet**. It is written down here so the next person starts from the truth
rather than from a claim they have to disprove first.

| # | Criterion | Status |
|---|-----------|--------|
| 1 | **Precision is measured, not assumed.** | **Not yet.** The scorer exists and is tested; no corpus has been read, so no precision exists. |
| 2 | **Recall is measured and deliberately chosen.** | **Not yet.** Same corpus gap, plus no per-type target has been set (deliberately — see above). Note also that `replay.py` structurally cannot measure recall at all. |
| 3 | **Every flag is traceable to its measurement, rule and threshold.** | **Partly.** Measurement and rule are recorded per flag in `analysis_evidence`. **Threshold is not.** Nothing stores the threshold live at analysis time; `replay.py`'s `DEFAULT_THRESHOLDS` is a hand-maintained mirror that has drifted from production before. |
| 4 | **Everything unverifiable is marked.** | **Not yet — not delivered at all.** `evidence_class: "unverifiable"` exists only inside a service-role-only JSONB column. Nothing in `src/` reads it. The criterion says *visibly distinguished*; nothing is visible to any user. |
| 5 | **Regression is impossible to ship silently.** | **Partly.** The criterion is "a change that lowers precision **on the corpus** fails CI". There is no corpus, no scorer invocation in CI and no gate (lint runs `\|\| true`). What shipped is "unit-test regressions fail CI" — real and valuable, but a different and much weaker claim. |

What Phase 1 built is **instrumentation**: durable flag identity, a recorded
evidence bundle, an offline replay harness, a scorer, and CI that runs the unit
suites. It is not a closed measurement loop, and reading it as one is how the
next phase would end up quoting a number nothing stands behind.

---

## The gate into the next phase is the corpus, not the code

Every task in this plan — stable `flag_key`s that survive re-analysis
(Task 1), per-flag evidence bundles written to `analysis_evidence` (Tasks 2,
3), the write-path fix so teacher annotations actually carry `flag_key`
(Task 3b), offline threshold replay (Task 4), and the scorer itself
(Task 5) — is finished, tested, and merged into this branch. `score_take`,
`aggregate` and `format_report` are ready to run the moment the query above
can be executed. `replay.py` is ready to calibrate the moment there is
something real to calibrate against.

None of that makes the numbers trustworthy today. A precision/recall figure is
only as good as the annotated corpus behind it, and the live annotation UI —
**the teacher dashboard, `src/pages/TeacherDashboard.jsx`, which is the only
annotation path that renders and the only one that sends `flagKey`** —
existing is not the same as teachers having used it on enough takes.

(Do not confuse it with `submitAnnotation`/`deleteAnnotation` in
`src/pages/Analysis.jsx`. Those are dead code: zero callers, part of the
pre-existing lint errors, and never given a `flagKey`. Anything they wrote
would land with `flag_key = NULL` and fall into the weaker `legacy_matched`
path. See the `Backlog` entry in `AGENT_TASKS.md`.) That gap closes with calendar time —
takes get uploaded, teachers annotate them — not with more engineering
effort. Re-running this task once that has happened, with real service-role
access, is the entire remaining work of standing up the baseline.
