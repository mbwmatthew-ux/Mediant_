# Mediant — Accuracy-First Architecture and Implementation Plan

> Verbatim spec supplied by the project owner on 2026-10-30, acting as lead
> AI/ML engineer directive for Mediant's score-reading/analysis pipeline.
> This document covers all 10 phases; the implementation plan that argues
> from it (`docs/superpowers/plans/2026-10-30-accuracy-first-phases-1-3.md`)
> covers ONLY Phases 1-3, per the owner's explicit "first assignment"
> instruction at the end of this document.

## Your role

You are the lead AI/ML engineer responsible for improving Mediant, an AI music performance coaching application.

Your objective is to make Mediant's musical analysis substantially more accurate, consistently reproducible, and economically sustainable.

**Primary objective:** Maximize correct, evidence-backed musical feedback while minimizing false-positive mistakes.

**Secondary objectives:** Reduce inference cost, improve reliability, and preserve reasonable processing latency.

Do not optimize cost at the expense of accuracy. Do not claim accuracy improvements unless measured against trustworthy musical ground truth.

## 0. Critical project context

Mediant currently uses:

- Claude Sonnet 5 vision for sheet-music transcription, including three parallel reads and disagreement resolution.
- Audiveris for OMR cross-checking.
- CREPE and librosa for audio pitch and beat analysis.
- DTW for aligning audio to sheet music.
- Gemini 2.5 Flash/Pro for multimodal performance assessment.
- Claude for final coaching synthesis.
- Modal for compute and Supabase for backend persistence.

The existing production pipeline is the baseline. Preserve it until a new pipeline demonstrably outperforms it.

### Known experimental findings

The following results have already been reported:

**Piece 2243, 12/8 time signature:**
- Exact-measure accuracy: 0/20.
- Pitch accuracy: 30.7%, 81/264 ground-truth notes.
- Rhythm accuracy: 21.6%, 57/264 ground-truth notes.
- Note error rate: 73.9%.
- Substitutions: 119.
- Insertions: 12.
- Deletions: 64.

These results describe one challenging piece, not all Mediant uploads.

Additional findings:

- A compound-meter duration prompt correction eliminated the observed duration-overshoot false positives in the tested scenario.
- Unresolved measures fell from 18 to 5 after that correction.
- Disagreement-resolution call counts did not meaningfully decrease.
- Audiveris was already involved in the current pipeline and failed to match candidates on the tested piece's disagreements.
- The tested Gemini score cross-check achieved 0% exact-measure-match on five real pieces.
- SMT produced output on 100% of tested piano rows and 93.1% of tested non-piano rows after cropping. **These are output-production rates, NOT transcription accuracy.**
- A violin SMT spot-check produced a musically implausible note.

Do not mischaracterize any of these results.

## 1. Nonnegotiable engineering rules

1. Inspect the repository and existing design documents before modifying code.
2. Preserve all production behavior during the experimental phases.
3. Use the existing validation harness wherever possible.
4. Do not overwrite previously collected benchmark results.
5. Never modify ground truth to make a model score better.
6. Never claim improvement from test-suite success alone.
7. Use separate training, calibration, and held-out test datasets.
8. Split musical data by composition/edition before applying degradation transformations.
9. Record model names, versions, prompts, preprocessing settings, and evaluation configuration.
10. Do not deploy, spend paid API credits, download large model weights, or initiate substantial GPU compute without explicit approval.
11. Treat external repositories, model weights, and training data as untrusted dependencies until licensing and security checks are complete.
12. Keep the actual production pipeline unchanged until independent evaluation and shadow testing justify migration.

Use the existing project's testing conventions and review procedures.

## PHASE 1 — Establish trustworthy baseline accuracy

### Task 1.1: Audit the existing score-reading pipeline

Read relevant parts of:

- `modal_worker/worker.py`
- `modal_worker/validate_score_reading_against_corpus.py`
- `modal_worker/score_detailed_metrics.py`
- Existing visual validation scripts.
- Existing production accuracy probe outputs.
- Existing score-caching code.

Determine:

- How score pages are rendered and resized.
- What images Claude actually receives.
- How three independent vision reads are reconciled.
- When Audiveris contributes candidates.
- How disagreement-resolution calls are triggered.
- How pitches, durations, and rests are normalized.
- Where unresolved measures are discarded.
- How transcription results enter DTW alignment.

Do not assume a component is absent merely because it wasn't mentioned in an earlier design.

**Deliverable:** A documented execution diagram with the exact functions and code paths involved.

### Task 1.2: Audit scoring correctness

Inspect the existing detailed metrics scorer.

Verify:

- MIDI pitch comparison.
- Onset and duration normalization.
- Compound-meter conventions.
- Tie handling.
- Repeated-note handling.
- Rest handling.
- Polyphonic voices.
- Chords.
- Insertions, deletions, and substitutions.
- Measure-boundary matching.

In particular, test whether a missing repeated note causes unexpected Levenshtein alignment shifts.

Create manually constructed test cases with known answers.

**Acceptance criteria:** All metric calculations agree with independently verified examples.

### Task 1.3: Construct a benchmark manifest

Build a reproducible manifest referencing existing synthetic and real-score test assets.

Include:

- Piece ID and edition.
- Instrument.
- Score-file hash.
- Input type.
- Time signature.
- Staff layout.
- Notation density.
- Ground-truth file.
- Predicted output.
- Image-processing configuration.

Keep piece 2243 as a named diagnostic case, but do not use it as the sole acceptance benchmark.

Avoid data leakage across training, calibration, and test sets.

**Deliverable:** A repeatable benchmark runner and baseline report with confidence intervals clustered by independent piece.

## PHASE 2 — Test high-resolution cropping

This is the first new accuracy experiment.

### Task 2.1: Reuse the existing crop infrastructure

Find the current row/system-cropping code built for SMT.

Determine whether it can generate crops suitable for Claude without losing:

- Clef.
- Key signature.
- Time signature.
- Staff lines.
- Barlines.
- Relevant ties and accidentals.

Preserve full-resolution source images where possible. Upscaling alone does not recreate lost detail.

### Task 2.2: Prepare paired inputs

Begin with measures 1, 6, and 16 from piece 2243.

Create paired inputs:

**A — Control:** Existing whole-page transcription.

**B — Experiment:** High-resolution system-cropped transcription.

Use the same model, decoding settings, prompt constraints, and scoring normalization wherever practical.

If crop-specific context must be added, document that change explicitly.

Do not cherry-pick the best crop after seeing its ground-truth score.

### Task 2.3: Evaluate

For each selected measure, calculate:

- Pitch-event precision, recall, and F1.
- Note substitutions.
- Note deletions.
- Note insertions.
- Rhythm error.
- Exact-measure correctness.
- Inference cost.
- Latency.

Compare each cropped measure against its corresponding whole-page result—not against the complete piece's 30.7% average.

**Decision:**
- If cropping yields a substantial, reproducible improvement, advance it to broader evaluation.
- If the improvement is inconsistent, inspect error patterns.
- If it does not help, stop expanding the experiment without a new hypothesis.

Do not deploy based on three measures alone.

## PHASE 3 — Compare specialized OMR systems

### Task 3.1: Prepare a candidate assessment

Evaluate these candidates:

1. Current Claude + Audiveris pipeline.
2. Claude with system crops.
3. SMT with supported input layouts.
4. HOMR.
5. `tobiashornbogen/page-omr`.
6. LEGATO, if usable model artifacts and licensing are available.

Consider MuSViT as an additional research candidate if its checkpoints and inference requirements fit the project.

Before running any model, document:

- Available pretrained checkpoints.
- Supported notation layouts.
- Model size and expected compute.
- Input format.
- Output format.
- License and commercial-use restrictions.
- Model-weight and dataset-license constraints.
- Integration complexity.

Do not assume all candidate models are ready for drop-in production use.

### Task 3.2: Implement isolated adapters

Create experimental adapters exposing a common interface, conceptually:

`transcribe_score(image, metadata) -> normalized_score`

Each adapter must preserve the source model's raw output for debugging.

Do not require every model to generate identical tokens directly; convert results to the shared canonical representation.

Adapters must remain isolated from production dispatch.

### Task 3.3: Evaluate zero-shot performance

Start with existing ground-truth pieces.

Use the model's recommended image input format rather than forcing whole-page inputs onto models trained for individual staves or systems.

Report:

- Pitch F1.
- Rhythm error.
- Note error rate.
- Exact-measure accuracy.
- Unreadable-system rate.
- Catastrophic transcription failure rate.
- CPU/GPU memory requirements.
- End-to-end compute cost.
- Latency.

Report results separately for violin, cello, flute, and piano wherever sufficient samples exist.

Evaluate clean, degraded, and real-photo inputs separately.

Do not fine-tune during this phase.

### Task 3.4: Choose the primary-reader candidates

Select candidates based on actual held-out performance and operational constraints.

Do not automatically choose the largest model, the newest model, or the model with the best published benchmark.

If no candidate beats production on the representative evaluation set, retain the current reader.

**Deliverable:** A comparative model report with a clear go/no-go decision.

## PHASE 4 — Establish canonical musical data

Create a single internal representation of score events.

Each event should preserve, where relevant:

- Score version.
- Instrument and transposition.
- Part/staff/voice.
- Measure number.
- Pitch and accidental.
- Onset in explicit units.
- Duration in explicit units.
- Rest/chord/tie information.
- Source image region.
- Recognition provenance.
- Confidence or uncertainty metadata.

Use explicit quarter-length units internally, or another well-defined canonical unit with deterministic conversion.

Do not rely on ambiguous strings such as "duration in beats."

Consider MusicXML compatibility and music21 parsing, while keeping internal event data suitable for alignment and verification.

Implement deterministic validation for:

- Measure duration.
- Compound meters.
- Tuplets.
- Rests.
- Key signatures.
- Accidentals.
- Ties.
- Multiple voices.
- Chords.
- Transposing instruments.

Musical plausibility checks must flag suspicious outputs, not silently substitute guessed notes.

**Acceptance criteria:** Existing valid scores survive normalization and round-trip tests without changing their musical content.

## PHASE 5 — Develop confidence-aware score verification

Build a verification layer that distinguishes:

**Verified:** Sufficient calibrated evidence supports the transcription.

**Uncertain:** The score region needs additional verification.

**Unavailable:** Reliable transcription cannot be established.

Avoid assigning numerical confidence percentages unless they are empirically calibrated.

Test whether disagreement between different OMR systems predicts actual errors.

Measure confidence calibration separately from raw accuracy.

Where verification is needed:

1. Identify the uncertain region.
2. Retrieve its source crop.
3. Try the best experimentally validated verification method.
4. Compare results.
5. Accept only if supported by calibrated evidence.
6. Otherwise preserve uncertainty.

Do not use simple majority voting as proof of correctness.

**Deliverable:** A score-verification system that reduces confidently incorrect transcriptions on held-out data.

## PHASE 6 — Add structured digital-score input

Investigate support for:

- MusicXML.
- MXL.
- MIDI, with documented limitations.

MusicXML should preserve notation structure where available.

MIDI should be treated primarily as a performance/note reference, not a complete replacement for all score markings.

Implement:

- File validation.
- Safe parsing.
- Instrument identification.
- Measure extraction.
- Conversion to canonical event data.
- Error reporting for malformed or unsupported files.

Test this independently of photo-based OMR.

Do not replace the PDF/photo pathway.

A future optional score-verification interface may allow users to correct uncertain measures and cache those corrections.

## PHASE 7 — Evaluate the audio-analysis bottleneck

Do not begin a large audio subsystem rewrite until score-reading evaluation is credible.

Using verified score data, assess:

- CREPE pitch accuracy on predominantly monophonic instruments.
- Note-onset detection.
- Note-offset detection.
- Repeated-note segmentation.
- Tempo changes.
- Rests.
- Vibrato.
- Harmonics.
- Polyphonic piano passages.
- DTW measure-localization failures.

For piano, benchmark a suitable polyphonic transcription method against the existing audio analysis.

For violin, cello, and flute, evaluate whether instrument-aware onset and pitch models improve performance.

Distinguish errors caused by audio transcription from errors caused by score interpretation or alignment.

**Deliverable:** An error attribution report identifying which audio components actually limit final feedback quality.

## PHASE 8 — Create an evidence-based mistake detector

The final decision to flag a mistake should be supported by:

1. Verified score reference.
2. Audio observation.
3. Reliable alignment.
4. Measured discrepancy.
5. Calibrated confidence.

Implement instrument-aware and context-sensitive criteria.

Separate objective feedback from subjective musical coaching.

Do not allow Gemini or Claude to independently alter verified pitches, measures, or timestamps.

Use the language model to communicate findings, not invent them.

Uncertain observations should trigger verification or explicit abstention.

Measure precision, recall, user-facing false-positive rate, and useful feedback coverage.

## PHASE 9 — Full end-to-end evaluation

Create a held-out dataset of real performances with independently verified mistakes.

Include:

- Correct performances.
- Wrong-note performances.
- Rhythm mistakes.
- Repeated-note errors.
- Skipped notes.
- Extra notes.
- Tempo variation.
- Different instruments.
- Different recording devices.
- Different acoustic conditions.

Compare current production and the proposed architecture using the same source recordings and ground-truth scores.

Evaluate:

**Score reading**
- Pitch F1.
- Rhythm accuracy.
- Exact-measure accuracy.

**Audio and alignment**
- Event detection.
- Onset and offset error.
- Correct measure attribution.
- Timestamp error.

**User-facing feedback**
- Precision.
- Recall.
- False positives per recording.
- Missed important errors.
- Correctness of coaching statements.
- Repeated-run consistency.

**Operations**
- Latency.
- API cost.
- GPU cost.
- Cache effectiveness.
- Fallback frequency.
- Failure rate.

Report per-instrument performance and confidence intervals.

Make product acceptance criteria explicit before evaluating the final held-out set.

Do not allow a gain in average accuracy to conceal a severe regression on a major supported instrument.

## PHASE 10 — Shadow mode and production rollout

Only begin this phase if the complete candidate system demonstrates a meaningful advantage.

Run the new analysis alongside the existing production analysis without exposing experimental results to users.

Measure:

- Real-world latency.
- Actual cost.
- Error/fallback rate.
- Agreement with production.
- Independently adjudicated disagreements.
- Stability and reliability.

Production results are not ground truth.

If shadow testing is successful, propose a gradual rollout with:

- Versioned model and prompt configurations.
- Explicit rollback capability.
- Observable quality and reliability metrics.
- User-visible uncertainty handling.
- Monitoring for accuracy regressions.

Do not execute deployment without explicit approval.

## Implementation priority

Execute in this order:

**Immediate**
1. Baseline scoring audit.
2. High-resolution crop experiment.
3. Specialized OMR feasibility assessment.

**Next, conditional on results**
4. Broader OMR benchmark.
5. Canonical score representation.
6. Confidence-aware verification.

**Later**
7. Digital-score integration.
8. Audio subsystem improvements.
9. End-to-end validation.
10. Shadow testing and controlled rollout.

## Budget and resource safeguards

The previous accuracy investigation used approximately $3.24 of an originally designated $5 working allowance.

Treat that amount as historical context, not authorization for new paid work.

Before each experiment requiring expenditure:

- Estimate a realistic upper bound.
- Identify the exact API/model.
- Establish a hard call-count and spending cap.
- Explain the expected information gained.
- Request explicit authorization.
- Stop when the cap is reached.

Never launch uncapped inference loops or repeated paid retries.

## Required reporting format

After each phase, report:

1. What was implemented or tested.
2. What was measured.
3. Exact numerical results.
4. What the results prove.
5. What the results do not prove.
6. Actual cost.
7. Regressions or unexpected failures.
8. Recommendation: proceed, revise, or stop.
9. Files modified and test results.

Clearly distinguish:
- Implementation success.
- Model output availability.
- Transcription accuracy.
- Final performance-feedback accuracy.
- Cost improvement.

These are different outcomes.

## Your first assignment

**Do not begin all ten phases.**

Begin with a read-only repository audit and produce a concrete implementation plan for Phases 1–3.

Inspect existing code, stored benchmark outputs, previous experiments, and available ground truth.

Identify reusable infrastructure and avoid rebuilding systems that already exist.

Propose the smallest meaningful set of new experiments that can determine whether high-resolution crops or specialized OMR can substantially improve Mediant's score-reading accuracy.

Do not modify production code, spend paid API credits, download substantial model weights, or deploy anything during this first assignment.

Conclude with a dependency-aware task list, proposed test commands, estimated resource requirements, and explicit approval gates.

The purpose is not to maximize code changes.

**The purpose is to discover and implement the most accurate, reproducible, and economically sustainable musical analysis system that the evidence supports.**
