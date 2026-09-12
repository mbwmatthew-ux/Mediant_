# Reference-Audio Recognition Pipeline: Multi-Signal Redesign

**Status:** Approved by user (3-day budget, oemer over homr pending re-evaluation).

## Problem

Reference-audio generation (`generate_reference_audio` / `read_score_notes_claude`
in `modal_worker/worker.py`) has repeatedly produced wrong-note output from
real user photos, across several rounds of fixes tonight:

1. Whole-page Claude vision reads showed a hallucination signature —
   measures several bars apart came back as exact mirror images of each
   other, adjacent measures byte-for-byte identical.
2. Row-splitting (`split_page_into_rows`, already shipped) — splitting a
   page into per-system strips before the vision call — measurably helped
   one known-bad case but did not eliminate the failure mode in general.
3. Same-model 2-of-3 cross-validation (`read_score_notes_claude`, already
   shipped) — reading the same images twice/thrice with the same model and
   majority-voting disagreeing measures — catches *inconsistency* between
   calls, but cannot catch a wrong answer the model produces *consistently*
   on every independent call. It was also not fully live-verified before
   this spec was written (a live test was interrupted by an Anthropic
   API credit exhaustion, unrelated to the logic itself).
4. Audiveris (a real, deterministic OMR engine, already installed in the
   Modal image but never wired into any live path) was tested directly
   against the same problem photo: it flatly rejected the photo at native
   resolution (measured interline/staff-spacing of 8px against its own
   stated ~300 DPI / ~20px target), and even after a naive 3x upscale
   that cleared the rejection, it produced a **wrong clef** (C-clef
   instead of treble), invented **two-voice polyphony** on what is
   actually a single melodic line, and threw an internal exception on the
   key signature. The photo has visible page curvature (it is not lying
   flat), which plausibly explains both failures — Audiveris assumes
   straight, parallel staff lines.

External review (an independent AI, given a full writeup of the above)
converged on the same root diagnosis: **the current design treats one
LLM, asked repeatedly, as if repetition were independence.** Three calls
to the same model with the same prompt and the same image are correlated,
not independent — they can agree with each other while all being wrong.
The fix is to add a genuinely independent second signal (a different
recognition method entirely) plus deterministic domain validation that
doesn't need any model to be right in the first place.

## Goals

Replace pure same-model cross-validation with a multi-signal pipeline:
a second, independent OMR recognizer; deterministic music-theory
validation; a real (not proxy) image-quality gate; finer-grained
segmentation (measure-level, not just system-level); and confidence
fusion across all signals, with targeted closed-ended disagreement
resolution (crop + candidate comparison) replacing open-ended re-reads.

## Non-goals (explicitly cut to fit a 3-day budget)

- **No full-page perspective correction / page-boundary detection.**
  Solved locally instead: each system is already isolated into its own
  row crop by `split_page_into_rows`; this spec adds a *local* dewarp
  within each row crop (straightening that row's own detected staff-line
  curve), which is a much smaller problem than correcting the whole
  page's geometry and directly targets the curvature that broke Audiveris.
- **No live camera capture UI** (real-time "hold flatter / move closer"
  guidance while the camera is open). Out of scope for this pipeline
  spec — the existing plain file-picker upload flow is unchanged here,
  except for the quality-gate warning this spec adds after a photo is
  selected (post-hoc, not live).
- **No `homr` integration.** `homr` (actively maintained, CPU-friendly
  ONNX runtime, purpose-built with dewarping) looked technically
  stronger in research, but is AGPL-3.0 licensed — running it as a
  backend for a closed-source paid product carries real network-copyleft
  obligations that need explicit legal sign-off, not an engineering
  decision made mid-implementation. This spec uses **`oemer`** (MIT
  licensed, no such blocker) as the second recognition source. If
  `oemer`'s output quality proves too weak to be useful (a real risk —
  see Risks below), the fallback is to ship without a second OMR source
  rather than silently reach for `homr` without that sign-off.
- **No training or fine-tuning of any model.** Both `oemer` and Claude
  are used as pretrained, off-the-shelf components.

## Architecture

Seven pieces, each independently testable:

| Piece | New/modified | Purpose |
|---|---|---|
| `compute_row_readability(row_bytes)` | New | Measures actual interline (staff-line) spacing and local contrast for one row crop; returns a quality verdict, not a proxy like raw pixel count. |
| `dewarp_row(row_bytes)` | New | Detects the row's own staff-line curve (polynomial fit) and applies a local unwarp so the row is locally flat before recognition. No-ops (returns input unchanged) if the row is already flat or the fit fails. |
| `split_row_into_measures(row_bytes)` | New | Detects vertical barlines within an already-dewarped row crop and returns per-measure crops, for targeted disagreement resolution and tighter OMR/vision inputs. |
| `read_score_notes_oemer(row_bytes) -> dict` | New | Shells out to the `oemer` CLI on one row crop, parses the resulting `.musicxml` with the **already-existing** `parse_score_document`, returns the same `ScoreResult` shape every other reader returns. |
| `validate_measure(measure, instrument, time_sig) -> {valid, issues}` | New | Deterministic checks: duration-sum matches the time signature's beat count, every pitch is within the declared instrument's playable range, no unexpected polyphony for a monophonic instrument. |
| `fuse_measure_confidence(claude_candidates, oemer_candidate, validation) -> {measure, confidence, needs_resolution}` | New | Combines however many Claude reads ran, the OMR candidate (if any), and the validator's verdict into one confidence score per measure. |
| `resolve_measure_disagreement(measure_crop_bytes, candidates) -> dict` | New | For a low-confidence measure only: crops down to that single measure, gives Claude the specific candidates already produced, and asks a closed-ended "which one matches, or transcribe just this" question — never an open re-read of the whole page again. |

`read_score_notes_claude` (already shipped tonight) keeps its existing
2-3-read same-model logic as the FIRST signal source, unchanged in this
spec — it becomes one input to fusion rather than the sole authority.

### Data flow

1. `read_score_notes_for_reference_audio` downloads the score page(s), as
   today.
2. For each page, `split_page_into_rows` (existing) splits into per-system
   strips, as today.
3. **New:** each row crop goes through `compute_row_readability` first.
   Rows below the quality threshold are flagged (surfaced back to the
   caller as a warning-worthy signal — Day 3 wires this into the upload
   flow's quality gate for the *next* upload, not a hard stop on this
   generation) but still processed, since a marginal photo already
   uploaded should still get the best-effort pipeline's result, not a
   hard refusal after the fact.
4. **New:** each row crop goes through `dewarp_row` before either
   recognizer sees it.
5. **New:** each dewarped row goes through `split_row_into_measures`.
6. Claude reads the (dewarped) row crops via the existing
   `read_score_notes_claude` — unchanged, still 2-3 same-model reads,
   still measure-by-measure fingerprint comparison, but now operating on
   better-conditioned input.
7. **New:** `read_score_notes_oemer` runs once per (dewarped) row crop,
   independently of Claude, producing its own candidate measures.
8. **New:** every measure from Claude's result is run through
   `validate_measure`.
9. **New:** `fuse_measure_confidence` combines Claude's own
   agreement/disagreement state (already computed), the OMR candidate,
   and the validator's verdict into a final confidence per measure.
10. **New:** any measure below the confidence threshold goes through
    `resolve_measure_disagreement` using that measure's own crop (from
    step 5) — a single, cheap, closed-ended call — rather than another
    open-ended full-page or full-row re-read.
11. The reconciled, fused measure set is returned in the same shape
    `read_score_notes_claude` already returns, so
    `read_score_notes_for_reference_audio` and the main analysis
    pipeline need no changes downstream of this function.

### Confidence fusion logic (concrete, not hand-wavy)

For each measure, four independent signals feed into one verdict:

- **Claude agreement**: `agree` (2+ of however many Claude reads ran
  matched by fingerprint) or `disagree`.
- **OMR agreement**: `match` (oemer's candidate fingerprint-matches
  Claude's winning candidate), `mismatch`, or `unavailable` (oemer
  produced no usable output for this measure/row — a real, expected
  outcome given oemer's known limitations, not an error to propagate).
- **Validator verdict**: `valid` or `invalid` (with specific issues:
  wrong duration sum, out-of-range pitch, unexpected polyphony).
- **Row readability**: `good`, `marginal`, or `poor` (from step 3).

Verdict table (checked in this order, first match wins):

- `invalid` validator verdict → always `needs_resolution = True`,
  regardless of what Claude/OMR say — a measure that can't possibly be
  right isn't rescued by two sources agreeing on it.
- Claude `agree` + OMR `match` → high confidence, accept as-is,
  no resolution needed.
- Claude `agree` + OMR `unavailable` + validator `valid` → medium-high
  confidence, accept — this is the common case on a photo oemer can't
  usefully process at all; Claude cross-validation plus a passing
  domain-plausibility check is still meaningfully better evidence than
  Claude alone with no check.
- Claude `agree` + OMR `mismatch` → **`needs_resolution = True`** even
  though Claude agrees with itself — this is the exact "consistent wrong
  answer" failure mode from Non-goals/Problem that OMR disagreement is
  specifically there to catch.
- Claude `disagree` (regardless of OMR) → `needs_resolution = True`,
  same as today's existing behavior.

### `resolve_measure_disagreement` — the closed-ended resolution call

Input: the single measure's own crop (tight, from `split_row_into_measures`),
plus whatever distinct candidates are already in hand (Claude's
disagreeing versions, oemer's version if available — never more than 3-4
distinct candidates in practice). Prompt shape: "Here is measure N,
cropped tightly. Here are N candidate readings already produced. Which
one matches what's printed? If none match exactly, transcribe only this
measure." This is a strictly easier task than open transcription — a
bounded choice plus a fallback, on a tiny, unambiguous crop — and
structurally harder for the model to keep generating a plausible-but-wrong
pattern, since there's no multi-measure context left to pattern-match
against.

## Deterministic validation — exact checks for Day 1

- **Duration sum**: sum of `duration_beats` across all notes+rests in the
  measure must equal `beats_per_measure_from_time_sig(time_sig)` (already
  exists) within a small tolerance (0.05 beats, for float rounding) —
  UNLESS the measure is explicitly a pickup/anacrusis (first measure of
  the piece) or the last measure of the piece, both of which can be
  legitimately partial.
- **Pitch range**: every note's MIDI pitch (after applying
  `transpose_for_instrument`, already exists) must fall within a new
  `INSTRUMENT_RANGE` table (written+concert range per instrument, keyed
  the same lowercase-name convention as `INSTRUMENT_TRANSPOSE`) — e.g. a
  clarinet reporting a pitch two octaves outside its real range is
  flagged `invalid`, regardless of what any recognizer says.
- **Voice count**: for any instrument NOT in a new, short, explicit
  `POLYPHONIC_INSTRUMENTS` set (piano, organ, harpsichord, guitar,
  classical guitar, electric guitar, bass guitar, harp, ukulele,
  mandolin, banjo — i.e. exactly the keyboard/fretted/harp entries
  already present in `INSTRUMENT_TRANSPOSE`, copied into their own set
  rather than "derived" from a table that doesn't encode polyphony),
  more than one note reported at the same `beat` position within a
  measure is flagged `invalid` — this is exactly the invented-polyphony
  failure Audiveris produced and Claude could in principle also produce.

## Error handling

- `dewarp_row` failing (can't detect a usable staff-line curve) returns
  the row unchanged — same no-op-on-failure convention `split_page_into_rows`
  already uses, not a hard error.
- `read_score_notes_oemer` failing (subprocess error, no MusicXML
  produced, timeout) returns `{"measures": [], "error": ...}` — same
  shape convention as every other reader in this file — and fusion
  treats that row's OMR signal as `unavailable` for every measure in it,
  not as a pipeline-wide failure.
- If `oemer` is not installed/fails to import in a given container
  (deployment issue), the pipeline logs it once and proceeds as if OMR
  were `unavailable` for everything — Claude-only + validator is still
  strictly better than today's Claude-only pipeline, so a broken OMR
  integration degrades gracefully rather than taking down generation
  entirely.

## Testing

- `compute_row_readability`, `dewarp_row`, `split_row_into_measures`:
  synthetic fixtures (following `_make_synthetic_page`'s existing
  pattern in `test_analysis.py` — drawn staff lines + notehead blobs,
  this time with a deliberately curved staff line for dewarp testing and
  deliberately placed vertical barlines for measure-split testing).
- `validate_measure`: pure unit tests, no mocking needed — hand-built
  measure dicts with known-good and known-bad duration sums, pitches,
  and voice counts.
- `fuse_measure_confidence`: pure unit tests over the verdict table
  above — one test per row of the table.
- `read_score_notes_oemer`: mock the subprocess call (same convention as
  `convert_visual_score_to_musicxml`'s existing Audiveris subprocess
  tests, if any exist, or the `httpx`/`anthropic` mocking convention
  already used throughout this file) and verify it correctly shells out
  and parses whatever `parse_score_document` is given.
- `resolve_measure_disagreement`: mock the Claude call, verify the
  prompt includes the candidates and the crop, verify the response is
  parsed into the same measure shape.
- **Manual/live**: once Anthropic credits are restored, run the full
  pipeline against the real problem photo used throughout tonight's
  investigation and confirm the measures Claude/OMR previously
  disagreed on (or that were structurally invalid) now resolve to a
  plausible, validator-passing result.

## Risks

- **oemer's actual output quality on real phone photos is unverified.**
  It is a real, maintained-enough library, but has not been tested
  against this project's specific photo type before this spec. Day 2's
  first task is exactly this test, before any further Day 2/3 work
  depends on it — if it produces unusable output even after dewarping,
  the plan degrades to "Claude cross-validation + deterministic
  validator + targeted resolution, no second OMR source," which is
  still a real improvement over tonight's baseline and should be stated
  as such rather than treated as a blocker to shipping anything.
- **`oemer`'s stated dependency is `onnxruntime-gpu`** (not the CPU
  package) — this repo's Modal image is CPU-only. This may work anyway
  (onnxruntime-gpu can fall back to CPU execution) or may require
  installing plain `onnxruntime` alongside/instead. This is a Day 2
  environment-setup risk, not a design flaw; the implementer should
  verify import/inference works in the actual Modal image early on Day 2
  rather than discovering it late.
- **Local per-row dewarping may not fully replicate what full-page
  perspective correction would achieve** on a page with severe warp.
  Accepted as a deliberate scope cut (see Non-goals) — expected to help
  meaningfully on moderate curvature (the kind seen in tonight's problem
  photo) without the much larger engineering cost of general page
  flattening.

## Day-by-day scope (Global Constraints for the implementation plan)

- **Day 1** (no Anthropic API calls required to build or test):
  `compute_row_readability`, `dewarp_row`, `split_row_into_measures`,
  `INSTRUMENT_RANGE` table, `validate_measure`. All unit-testable with
  synthetic fixtures, no live credits needed.
- **Day 2**: `read_score_notes_oemer` (including the Modal image
  dependency work and the CPU/GPU onnxruntime risk above), tested first
  against the real problem photo's dewarped row crops before anything
  else in this phase proceeds. `fuse_measure_confidence`.
  `resolve_measure_disagreement`.
- **Day 3**: wire steps 3-11 of Data Flow into
  `read_score_notes_for_reference_audio` (or a new orchestrating
  function, implementer's judgment on the cleanest seam), ship the
  upload-flow quality-gate UI using `compute_row_readability`'s output
  (the interline-based warning, replacing the earlier raw-pixel-count
  idea from before this spec), end-to-end live test once credits are
  restored, deploy.
