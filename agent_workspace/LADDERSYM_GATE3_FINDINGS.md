# LadderSym Gate 3 — 12-case real mistake-detection pilot: REJECT

2026-10-30. Per the owner's "Gate 3 Approved & Teacher Features
Discontinued" directive. All 12 authorized cases ran to completion, CPU
only, no paid APIs, no GPU, no model training, no extra checkpoint
downloads. **Recommendation: reject LadderSym (as tested, zero-shot, no
fine-tuning) as Mediant's mistake detector.** Full reasoning below.

## Setup

- **Pieces** (1 per instrument, reused from Task 4A/4B and every prior
  LadderSym gate for continuity): 2203 (Flute), 2296 (Cello), 2289
  (Violin) — all held-out MusicNet pieces.
- **Conditions** (4 per piece, 12 cases total): control (unmodified),
  wrong_pitch, deleted_note, duplicated_note — injected via the existing
  `modal_worker/inject_audio_mistakes.py`, reused as-is.
- **score_audio**: Gate 1B's timing-accurate renderer
  (`generate_timing_accurate_reference_audio.py`), reused as-is.
- **prompt** (symbolic MIDI): built from the same ground-truth notes used
  for score_audio, so both describe the same piece/timing.
- **Model**: the real `cocochorales/prompted` checkpoint, loaded under
  the Gate 2 resolution (`transformers==4.24.0`), CPU inference.

### A disclosed scope reduction: 10-second crop windows, not full pieces

LadderSym processes audio in independent ~2-second windows with no
cross-window search (confirmed in Gate 1's reading of its own batching
code) — a window far from the point of interest adds runtime, not
detection power. Combined with the released checkpoint's own
`use_cache=False` setting (no KV-caching — the original authors' own
choice, not something changed here), each CPU decode step costs
empirically ~0.25s, and early full-piece/full-length runs projected to
tens of minutes per case. Cropping each case to a 10-second window
around its own point of interest (or, for "control," around the same
window used for that piece's wrong_pitch case) keeps the model's own
local view unchanged while making 12 CPU cases tractable: ~5 independent
~2s windows per case. This is a scope reduction in audio DURATION, not in
how many of the 12 required cases ran — all 12 ran, in full.

### Two harness fixes, not transformers-compatibility findings

While wiring up real inference (beyond Gate 2's checkpoint-loading smoke
test), two more environment issues surfaced and were fixed — both
pre-existing inconsistencies in LadderSym's own pinned dependencies,
unrelated to the `transformers` version bump:
1. `note_seq`'s bundled protobuf-generated code predates protobuf's 2022
   API-generation requirements; newer `protobuf` (pulled in transitively)
   refuses to load it. Fixed with `PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=
   python` (an env var — same correctness, slower pure-Python
   implementation, zero dependency/version changes).
2. `pretty_midi==0.2.9` (LadderSym's own pin) uses `np.int`/`np.float`/
   etc., removed from `numpy==1.26.4` (also LadderSym's own pin). Fixed
   by restoring those as aliases for the Python builtins at the top of
   the test harness script only — exactly what they always were, no
   behavior change, no pin changes.
Also found and fixed a real bug in my own test harness (not LadderSym's
code): the `T5Config` I built for Gate 2's smoke test never set
`use_prompt`, which Gate 2 never needed (it only exercised the decoder
directly) but Gate 3's real `.inference()` path reads via
`self.model.config.use_prompt`. Added `use_prompt=True` (the same value
`config/model/laddersym_prompt_MT3Net.yaml` declares).

## Results

### Aggregate (12 cases, 6 mistake-opportunities for Missing, 6 for Extra)

| Metric | Value |
|---|---|
| Missing-note precision | 0 / 90 = **0.0%** |
| Missing-note recall | 0 / 6 = **0.0%** |
| Extra-note precision | 1 / 65 = **1.5%** |
| Extra-note recall | 1 / 6 = **16.7%** |
| Extra-note F1 | 2.8% |
| Unsupported predictions on controls | **28 across 3 control cases** (9.3/case average) — on recordings with NO injected mistake at all |
| Non-control cases with the correct mistake type detected at the correct time (±0.75s tolerance) | **1 / 9** |

Wrong-pitch mistakes were scored per the directive: one expected Missing
(the original pitch) + one expected Extra (the new pitch) at the same
onset, never a separate "wrong-pitch" class — matching LadderSym's own
3-class output space.

### Per-case detail

| Piece/Instrument | Condition | Predicted notes | Correct / Missing / Extra | Hit? |
|---|---|---|---|---|
| 2203 Flute | control | 21 | 1 / 1 / 19 | — (19 unsupported) |
| 2203 Flute | wrong_pitch | 20 | 1 / 1 / 18 | No |
| 2203 Flute | deleted_note | 16 | 2 / 14 / 0 | No |
| 2203 Flute | duplicated_note | 25 | 1 / 24 / 0 | No |
| 2296 Cello | control | 9 | 1 / 8 / 0 | — (8 unsupported) |
| 2296 Cello | wrong_pitch | 10 | 2 / 1 / 7 | No |
| 2296 Cello | deleted_note | 13 | 3 / 2 / 8 | No |
| 2296 Cello | duplicated_note | 18 | 3 / 2 / 13 | **Yes** (1 extra-note hit) |
| 2289 Violin | control | 30 | 30 / 0 / 0 | — (0 unsupported) |
| 2289 Violin | wrong_pitch | 30 | 30 / 0 / 0 | No (missed both) |
| 2289 Violin | deleted_note | 39 | 2 / 37 / 0 | No |
| 2289 Violin | duplicated_note | 49 | 49 / 0 / 0 | No (missed it) |

**The failure pattern is inconsistent in both directions, not just
"too aggressive" or "too conservative" uniformly**: Flute floods almost
every note as Missing or Extra regardless of condition (including
control); Violin does the opposite on 3 of 4 conditions (predicts
everything "Correct," missing real injected mistakes entirely) but then
floods on `deleted_note`; Cello sits in between and produced the pilot's
only real hit. A detector whose behavior swings this hard between three
single-instrument held-out pieces, with no tuning difference between
them on our end, is not behaving as a usable per-instrument detector.

### Resource usage

- Total CPU wall time, 12 cases: **42.5 minutes** (2547s).
- 10 of 12 cases: 42-72s each. 2 outliers — both `duplicated_note`
  cases — took 936s and 1041s (~17-20x longer). Frame counts were
  identical across all conditions for a given piece (1251 mistake-audio
  frames, same ~5 windows), so the outlier isn't more windows; it's each
  window running the full `max_length=60` decode budget without hitting
  EOS early, plausibly because the duplicated material and its splice
  discontinuity give the model more to (mis)transcribe before it would
  naturally stop. Reported, not deeply root-caused further — out of
  scope for a 12-case pilot.
- Peak CPU process memory: **3.1GB** (`ru_maxrss`), consistent with
  Gate 2's single-forward-pass measurement plus generation overhead.
- No GPU used anywhere in this pilot.

## Why these results don't look like "LadderSym is a bad model" so much as "this is a hard zero-shot transfer," and why that distinction doesn't change the recommendation

LadderSym was trained on CocoChorales-E — synthetic, multi-instrument
ensemble renderings from a fixed synthesis pipeline. This pilot fed it
**real solo MusicNet recordings** (quite different timbre/noise
characteristics) paired with **score_audio rendered through a different
synthesizer and soundfont** than whatever CocoChorales itself uses
(Gate 1B's own generator docstring already flags this as a known
benchmark-vs-production deviation). Zero-shot cross-dataset transfer for
audio-conditioned transcription models is a known-hard problem in
general, and the oracle-timed score reference used here is itself an
experimental advantage real production inputs would never have this
cleanly — both reasons these numbers are not, and should never be cited
as, LadderSym's "real" accuracy or Mediant's expected production
accuracy. But the recommendation is the same either way: taking the
released checkpoint as-is, with no fine-tuning budget approved or
proposed, and feeding it exactly Mediant's own kind of input (real
solo-instrument recordings + a rendered score reference), the result is
unusable — near-zero signal on the thing we need (missing/extra note
detection) and a large false-positive rate even on correct playing.

## Recommendation: REJECT (as tested; not a verdict on fine-tuned LadderSym)

Do not integrate LadderSym into Mediant's production pipeline based on
this evidence. The gap between this result and a usable detector is not
a small tuning knob — closing it would require either fine-tuning on
Mediant-distribution data (a real data-collection and training-compute
investment, well beyond this pilot's "no model training" constraint) or
substantial further input-engineering with no strong signal yet that it
would help. Gate 2's environment-compatibility work (the `transformers`
bump) remains valid, reusable infrastructure if a future, differently
-scoped effort wants to explore fine-tuning — but nothing here supports
spending more time on prompt/input engineering against the released
zero-shot checkpoint.

No further benchmarking, tuning, or integration work has been started
past this report.
