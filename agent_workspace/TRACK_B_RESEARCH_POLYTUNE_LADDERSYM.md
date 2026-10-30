# Research comparison: Polytune / LadderSym vs. Mediant's current pipeline

Research only — no implementation, no model download, no API spend. Prepared
2026-10-30 per owner request, following Task 4B's conclusion that Gemini
should not continue as Mediant's primary mistake detector.

## What each model is

**Polytune** (Chou et al., AAAI 2025, `arxiv.org/abs/2501.02030`) — two
Audio Spectrogram Transformer (AST) encoders (one for a reference/score
audio, one for the performance audio) fused into a joint encoder, decoded
by a T5 decoder into MIDI-like tokens. Trained and evaluated on
**14 instruments**: piano (via MAESTRO-E) plus 13 orchestral/wind/string
instruments via CocoChorales-E — flute, clarinet, oboe, bassoon, violin,
viola, **cello**, trumpet, French horn, tuba, trombone, contrabass, tenor
sax. Reports 64.1% average Error Detection F1, a +40pp improvement over
prior work at the time. Processes audio in short, fixed 2.145s
non-overlapping segments rather than whole clips.

**LadderSym** (Chou et al., same group, ICLR 2026, `arxiv.org/abs/2510.08580`)
— the direct successor to Polytune. Adds a two-stream encoder with
inter-stream alignment modules and feeds the symbolic score in as decoder
prompts, addressing the paper's stated weakness of Polytune's late fusion.
Same datasets (MAESTRO-E, CocoChorales-E — same 14-instrument coverage),
same short-segment framing (`split_frame_length=2000`, i.e. ~2s). Reports a
large jump over Polytune: missed-note F1 26.8%→56.3%, extra-note F1
72.0%→86.4%. A March-2026 third-party re-evaluation of the public
checkpoints reports extra-note F1 0.8561, missed-note F1 0.5349,
correct-note F1 0.9441 on MAESTRO-E (prompted).

**Flute, violin, and cello — three of Mediant's own validated MusicNet
instruments from Track B — are directly in both models' training
coverage.** This is a real, concrete point of overlap, not a guess.

## Comparison table

| Criterion | Polytune | LadderSym | Mediant (current) |
|---|---|---|---|
| **Checkpoint availability** | Hosted on Hugging Face (`ben2002chou/Polytune`); README says the official checkpoint reproduces the paper's results; file sizes not listed | Hosted on Hugging Face (`ben2002chou/laddersym-checkpoints`), 4 checkpoints (cocochorales/maestro × prompted/unprompted); file sizes not listed on the model card | n/a |
| **Supported instruments** | 14 (piano + 13 via CocoChorales-E, incl. flute/violin/cello) | Same 14 (same datasets) | Any instrument Claude/Gemini can read from sheet music — not a fixed list, but unvalidated breadth |
| **Required input format** | Score audio + performance audio, 2.145s non-overlapping segments; sample rate/file format not documented | `prompt_file` = MIDI score, `score_file` = WAV (reference/rendered score audio — exact nature needs direct script inspection), `mistake_file` = WAV (performance to check); output is a 3-track MIDI (extra/missing/correct notes) | Score IMAGE (not MIDI) via Claude vision → structured JSON; audio via CREPE/DTW/Gemini — no MIDI step today |
| **License** | Not confirmed in the repo page fetched (arXiv paper itself is CC BY 4.0; code/data license unconfirmed from what was fetched — needs a direct LICENSE-file check) | **MIT**, confirmed on both the GitHub repo and the Hugging Face checkpoint model card | n/a |
| **Reproducibility** | Training/eval/inference commands documented; **dataset download requires a Globus account** (added friction) | Training/eval/inference commands documented, including a single-pair CLI (`laddersym_test_inference.py`); datasets downloadable via a setup script from Hugging Face (no Globus) | n/a |
| **Integration complexity vs. Mediant** | Same MIDI-prompt / dual-WAV-input shape as LadderSym (see below) | Needs: (1) a score→MIDI conversion step Mediant doesn't currently have (though Mediant's Claude-vision score JSON is a small, well-bounded `music21`/`pretty_midi` conversion away from MIDI — not a research gap, a short build task); (2) a rendered/reference score-audio WAV (Mediant's existing "AI reference audio" feature, which already synthesizes performance audio via `pyFluidSynth`, may directly satisfy this — needs direct confirmation against the actual inference script, not assumed); (3) a translation layer from LadderSym's 3-track-MIDI output to Mediant's measure+time+description flag schema (a bounded, well-defined mapping, not open-ended) | n/a |
| **Expected compute cost** | Training used a single NVIDIA A100-80GB (hours not reported); inference compute **not documented for either model** — segment-based (~2s chunks) architecture suggests inference is far cheaper than training, but this is an assumption, not a measurement | Same — not documented | CREPE/DTW run on Modal CPU/GPU workers already in production; Gemini calls are the per-take API-cost line item being replaced |

## What's unverified and needs a direct check, not an assumption

- **Checkpoint file sizes** — not listed on either Hugging Face page. The
  first, free step of any approved experiment should be a `HEAD` request or
  `git lfs ls-files` check against the HF repo (no download) to confirm size
  before committing to a download.
- **LadderSym's `score_file` WAV** — whether it must be a real human
  reference performance or a synthesized/rendered rendering of the MIDI
  score. This materially changes integration cost (Mediant's existing
  reference-audio feature may or may not satisfy it) and should be settled
  by reading `laddersym_test_inference.py` directly, not guessed from a
  README summary.
- **Code/data license for Polytune specifically** — the HF checkpoint page
  and GitHub README text weren't conclusive on this from what was fetched;
  LadderSym's MIT license is confirmed, Polytune's needs a direct
  LICENSE-file check if it's pursued at all.
- **Inference compute** (GPU required? CPU-feasible? latency per take?) —
  undocumented by either project. This is exactly what the smallest
  experiment below would measure directly rather than estimate.

## Why LadderSym, not Polytune, is the one to actually test

Same authors, same two datasets, same instrument coverage, same license
(MIT, confirmed), same short-segment architecture family, but LadderSym is
reported as a substantial accuracy improvement over Polytune on the same
benchmarks, and its reproducibility story is simpler (Hugging-Face-hosted
dataset downloads vs. Polytune's Globus-account requirement). There's no
case for benchmarking Polytune directly unless LadderSym's checkpoint or
dependencies turn out to be blocked.

## Proposed smallest experiment

**Reuse Track B's existing infrastructure end-to-end — no new ground truth,
no new injected-mistake tooling, no MAESTRO-E/CocoChorales-E download.**

1. **Free, zero-download pre-check (do this first):** confirm LadderSym's
   `maestro/prompted/model.ckpt` file size via a HEAD request against
   Hugging Face, and read `laddersym_test_inference.py` directly (it's
   public on GitHub) to settle the `score_file` question above, before any
   download decision.
2. Take a small subset of Track B's already-built, already-validated
   held-out MusicNet benchmark (reuse `modal_worker/inject_audio_mistakes.py`
   and the same held-out piece list `run_task3_benchmark.py` uses) —
   **MusicNet is a different corpus from MAESTRO/CocoChorales, so this is a
   genuinely independent test set, not data the model was trained on.**
   Restrict to the 3 instruments already validated as in-coverage: flute,
   violin, cello.
3. Convert each piece's existing MIDI ground truth (already loaded by
   `midi_score_to_dict`/`load_ground_truth`) to the MIDI prompt file
   LadderSym expects — this is the one small, bounded build step, not a
   research question.
4. Download the single `maestro/prompted` checkpoint (pending the size
   check in step 1) and run LadderSym's own single-pair inference script
   locally (CPU first; only escalate to a GPU environment if CPU proves
   infeasible) against the same injected-mistake and control audio Task 3
   already used.
5. Score using the exact same metrics Track B's Task 3 and Task 4A/4B
   already reported — detection, measure-localization accuracy, control
   false-positive rate, per-instrument breakdown — so the result is
   directly comparable to the existing 96.3% detection / 57.7%
   localization / 100% control-false-positive CREPE+DTW baseline, and to
   Gemini's Task 4A/4B numbers.

This reuses validated ground truth and injection tooling from Task 2/3,
needs exactly one model checkpoint download (size to be confirmed first),
and needs zero additional API spend (LadderSym is a local/self-hosted
model, not a billed API).

## Go/no-go criteria for approval

**Go** (worth a larger follow-on integration effort) if, on this small
held-out set:
- Missed-note and wrong-pitch detection at the correct measure clears a
  meaningfully higher bar than CREPE+DTW's current 57.7% localization
  accuracy, **and**
- The control (unmodified) false-positive rate is substantially below
  CREPE+DTW's current 100%, **and**
- Inference completes in a time/compute budget that's plausible for
  Mediant's real per-take latency target (not strictly real-time, but not
  minutes-per-take either) on hardware Mediant could reasonably provision.

**No-go** (park and document, don't pursue further) if:
- Detection/localization isn't clearly better than the existing CREPE+DTW
  baseline on this independent test set, or
- The `score_file` input turns out to require a real human reference
  recording Mediant can't produce for arbitrary user-uploaded pieces, or
- Checkpoint size or inference compute makes self-hosting impractical on
  Mediant's current infrastructure.

No production code changes, no replacement deployment, and no further
development phase would follow a "go" without a separate approval and plan
— this stays a benchmark-only decision point.
