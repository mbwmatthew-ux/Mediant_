# Audio-Analysis Pipeline Benchmark — Spec

> Captured from the project owner's message on 2026-10-30, which superseded
> the in-progress score-reading accuracy plan for this turn.

Before implementing any further architectural changes to Mediant, establish
whether the existing audio-analysis system can accurately detect musical
mistakes when given a perfectly correct digital score.

Audit the current CREPE, onset-detection, DTW, and Gemini performance-analysis
pipeline. Design a controlled benchmark using verified MusicXML scores and
corresponding audio recordings with independently documented pitch and rhythm
errors.

The benchmark must distinguish score-reading failures, audio-transcription
failures, alignment failures, and final feedback-generation failures.

Reuse existing infrastructure wherever possible. Do not replace models,
redesign the architecture, or modify production behavior during this stage.

Report note-error precision and recall, false positives, measure-localization
accuracy, repeatability, and per-instrument performance.

Identify the specific component responsible for each major failure and
propose only the smallest changes supported by measured evidence.

The goal is to establish a stable, consistently accurate audio-analysis
engine — not to rebuild Mediant again.

Begin with a read-only audit and a concrete benchmark implementation plan.
Do not spend API credits or deploy changes without explicit authorization.
