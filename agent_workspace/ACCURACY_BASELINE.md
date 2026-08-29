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

## Step 3: what comes after this document (calibration, not this plan)

`modal_worker/replay.py` re-decides flags from a stored evidence bundle
(`analysis_evidence`, written by every analysis run since Task 2 of this
phase) under different numeric thresholds — offline, deterministically, with
no audio, network or API keys. It exists so that changing e.g. the timing
placement threshold from 110ms to 90ms can be evaluated against the whole
corpus in milliseconds instead of re-running the pipeline against real
recordings.

**Its documented limitation, restated here because it bounds what the next
phase can do without this baseline:** `replay_bundle` re-applies a final
numeric gate to an already-measured value. It cannot evaluate a change to
*how* something is measured — a new pitch-tracking model, a different
analysis window, a new detector. Those require a real pipeline run against
real audio. Replay covers threshold calibration, which is the bulk of the
next phase's work but not all of it.

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

## The gate into the next phase is the corpus, not the code

Every task in this plan — stable `flag_key`s that survive re-analysis
(Task 1), per-flag evidence bundles written to `analysis_evidence` (Tasks 2,
3), the write-path fix so teacher annotations actually carry `flag_key`
(Task 3b), offline threshold replay (Task 4), and the scorer itself
(Task 5) — is finished, tested, and merged into this branch. `score_take`,
`aggregate` and `format_report` are ready to run the moment the query above
can be executed. `replay.py` is ready to calibrate the moment there is
something real to calibrate against.

None of that makes the numbers trustworthy today. A precision/recall figure
is only as good as the annotated corpus behind it, and building the
annotation UI (already shipped, per `AGENT_TASKS.md`) is not the same as
teachers having used it on enough takes. That gap closes with calendar time —
takes get uploaded, teachers annotate them — not with more engineering
effort. Re-running this task once that has happened, with real service-role
access, is the entire remaining work of standing up the baseline.
