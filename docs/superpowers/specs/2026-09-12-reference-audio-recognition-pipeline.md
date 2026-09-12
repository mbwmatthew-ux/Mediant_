# Reference-Audio Recognition Pipeline: Multi-Signal Redesign

**Status:** Approved by user (3-day budget, oemer over homr pending
re-evaluation). Revised after a second external-AI review round; five
changes incorporated (ground-truth testing, validator asymmetry,
written-vs-concert pitch range, Claude/oemer measure alignment,
segmentation confidence + fallback) — see inline call-outs below marked
**[Revision 2]**.

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
| `split_row_into_measures(row_bytes) -> {measures, boundaries, confidence}` | New | Detects vertical barlines within an already-dewarped row crop and returns per-measure crops **in left-to-right positional order**, plus a confidence score for the segmentation itself (see **[Revision 2] Measure alignment** below — this ordered list, not any number either recognizer invents, is what makes Claude's and oemer's outputs comparable). |
| `read_score_notes_oemer(crop_bytes) -> dict` | New (changed from row-level to **measure-crop-level** per [Revision 2]) | Shells out to the `oemer` CLI on one **measure crop** (not a whole row), parses the resulting `.musicxml` with the **already-existing** `parse_score_document`, returns the same `ScoreResult` shape every other reader returns. Running per measure-crop rather than per row means oemer never has to agree with anyone about where a measure starts — that's already decided by the crop it was given. |
| `validate_measure(measure, instrument, time_sig) -> {valid, issues}` | New | Deterministic checks: duration-sum matches the time signature's beat count, every pitch is within the declared instrument's **written** playable range, no unexpected polyphony for a monophonic instrument. See **[Revision 2] Validator asymmetry** — `invalid` is strong evidence of a problem; `valid` is not strong evidence of correctness. |
| `align_claude_to_measure_crops(claude_row_measures, crop_count) -> list[dict] \| None` | New — **[Revision 2] addition**, not in the original spec | Positionally aligns Claude's measures for one row (already ordered left-to-right by printed number) to that row's measure-crop list by **index, not by number**. Returns `None` (alignment refused) if Claude's measure count for that row doesn't match `crop_count` — this mismatch is itself the signal that either segmentation or Claude's read is wrong for this row, and forcing a positional match anyway would silently mislabel every measure after the mismatch. |
| `fuse_measure_confidence(claude_candidate, oemer_candidate, validation) -> {confidence, needs_resolution}` | New | Combines Claude's own agreement/disagreement state (already computed per measure), the OMR candidate for that SAME measure-crop (if alignment succeeded), and the validator's verdict into one confidence outcome. Measure identity here is always "this specific crop," never a printed number matched across two independent sources. |
| `resolve_measure_disagreement(measure_crop_bytes, candidates) -> dict` | New | For a low-confidence measure only: uses that measure's own crop (already isolated), gives Claude the specific candidates already produced, and asks a closed-ended "which one matches, or transcribe just this" question — never an open re-read of the whole page again. |

`read_score_notes_claude` (already shipped tonight) keeps its existing
2-3-read same-model logic as the FIRST signal source, unchanged in this
spec — it becomes one input to fusion rather than the sole authority.

### [Revision 2] Measure alignment between Claude and oemer

The original draft of this spec assumed Claude's measure 17 and oemer's
measure 17 refer to the same printed measure. They might not: if oemer
misses a barline, splits one measure into two, or mishandles a
multi-measure rest, every measure after that point shifts, and the two
sources would appear to disagree on measures that are actually fine —
poisoning the whole row's fusion with false mismatches.

The fix is to never ask oemer to establish measure identity at all.
`split_row_into_measures` (Claude-independent, purely a barline-detection
pass over one row image) produces the canonical, ordered list of visual
measure regions for that row. Two things are then checked before any
cross-source fusion is trusted for that row:

1. Does `split_row_into_measures`'s own confidence for this row clear a
   threshold (see [Revision 2] Segmentation confidence below)?
2. Does Claude's own measure count for this row match the crop count?

Only if both hold does oemer run per individual measure crop, with its
result associated to Claude's same-position measure by **index alone**.
If either check fails, oemer runs once on the whole row (same input
shape as Claude gets) and its output is used only as loose corroborating
evidence, not measure-by-measure fused evidence, for that row. This means
alignment is refused rather than guessed whenever it can't be trusted —
a strictly safer default than forcing a positional match that might be
off by one.

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
5. **New:** each dewarped row goes through `split_row_into_measures`,
   producing an ordered list of measure crops plus a segmentation
   confidence for that row.
6. Claude reads the (dewarped) row crops via the existing
   `read_score_notes_claude` — unchanged, still 2-3 same-model reads,
   still measure-by-measure fingerprint comparison, but now operating on
   better-conditioned input. This is still Claude reading whole ROWS
   (not individual measure crops) for its own transcription — Claude is
   good at reading printed measure numbers across a row's full context;
   asking it to read one measure crop in isolation would lose that
   context. Only the disagreement-resolution path (step 10) and oemer
   (step 7) work on isolated measure crops.
7. **New [Revision 2]:** for each row, `align_claude_to_measure_crops`
   checks whether Claude's measure count for that row matches
   `split_row_into_measures`'s crop count. **If they match**, `oemer`
   runs on each individual measure crop (via `read_score_notes_oemer`),
   and its result is associated with Claude's measure at the same
   position — never by any number oemer itself might infer. **If they
   don't match, or row segmentation confidence was low**, oemer runs on
   the whole (dewarped) row instead, exactly like Claude does, and its
   output is treated as row-level corroborating evidence only (can still
   feed `validate_measure`-style sanity checks) rather than being
   fused measure-by-measure — a mismatched positional force-fit would
   silently mislabel every measure after the first misalignment, which
   is worse than not fusing at all for that row.
8. **New:** every measure from Claude's result is run through
   `validate_measure`.
9. **New:** `fuse_measure_confidence` combines Claude's own
   agreement/disagreement state (already computed), the OMR candidate
   for that same measure-crop (when step 7 aligned successfully), and
   the validator's verdict into a final confidence per measure.
10. **New:** any measure below the confidence threshold goes through
    `resolve_measure_disagreement` using that measure's own crop (from
    step 5) — a single, cheap, closed-ended call — rather than another
    open-ended full-page or full-row re-read.
11. The reconciled, fused measure set is returned in the same shape
    `read_score_notes_claude` already returns, so
    `read_score_notes_for_reference_audio` and the main analysis
    pipeline need no changes downstream of this function.

### Confidence fusion logic (concrete, not hand-wavy)

**[Revision 2] Validator asymmetry — read this before touching the table
below.** `validate_measure` is a ONE-DIRECTIONAL signal:
`invalid` is strong evidence something is wrong, but `valid` is NOT
evidence something is right. A measure with the right note COUNT, right
total duration, right instrument range, and correct monophony can still
have every individual pitch wrong (e.g. printed C-D-E-F read back as
C-D-F-G — both are four quarter notes in range, both pass every
deterministic check, only one is correct). The verdict table below
already respects this (there is no rule that treats `valid` alone as
sufficient for high confidence — every acceptance path also requires
Claude agreement, and the strongest acceptance path also requires OMR
agreement), but it is called out explicitly here so a future change to
this table doesn't quietly start treating "validator passed" as "probably
correct." It never means that on its own.

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

### [Revision 2] Segmentation confidence and fallback

`split_row_into_measures` detects vertical structures and calls them
barlines, but real notation has plenty of other vertical-looking things
that aren't ordinary barlines: note stems, repeat barlines, double
barlines, first/second-ending brackets, dynamic hairpins, text, and
barlines partially obscured by print quality or the row's own curvature.
Treating segmentation as always-certain would produce bad micro-crops
that then feed both oemer and the disagreement-resolution path garbage
input.

`split_row_into_measures` therefore returns a confidence score alongside
its crops (see the Architecture table above), computed from signals like
barline-candidate regularity (real barlines in a row tend to be roughly
evenly spaced for a fixed time signature) and how many candidates were
ambiguous (thin vertical marks near the confidence threshold for "is this
really a full-height barline"). When confidence is below threshold for a
row, the pipeline does NOT use per-measure crops for that row at all —
it falls back to treating the whole row as one unit for both oemer
(row-level, not measure-level, per the Measure Alignment section above)
and for disagreement resolution (falls back to the existing row-level
re-crop-and-ask behavior already in `read_score_notes_claude`, not a
bad measure crop). A row with unreliable segmentation gets strictly the
OLD behavior for that row, never a worse one.

## Deterministic validation — exact checks for Day 1

- **Duration sum**: sum of `duration_beats` across all notes+rests in the
  measure must equal `beats_per_measure_from_time_sig(time_sig)` (already
  exists) within a small tolerance (0.05 beats, for float rounding) —
  UNLESS the measure is explicitly a pickup/anacrusis (first measure of
  the piece) or the last measure of the piece, both of which can be
  legitimately partial.
- **Pitch range — [Revision 2] written range, validated BEFORE
  transposition.** Claude and oemer both report what's printed on the
  page — the **written** pitch, not the concert/sounding pitch a
  Bb clarinet's printed C (which sounds Bb) would imply.
  `transpose_for_instrument` (already exists) is applied later, only at
  MIDI-synthesis time in `generate_reference_audio`, to turn written
  pitch into sounding pitch for playback — it must NOT be applied before
  validation, or a completely correct clarinet transcription could
  appear to be out of range for no real reason (or worse, a genuinely
  out-of-range transcription could accidentally land back in range after
  a transposition shift, hiding a real error). Validate the raw reported
  pitch directly against a new `INSTRUMENT_WRITTEN_RANGE` table (written
  range only, one min/max MIDI pitch pair per instrument, keyed the same
  lowercase-name convention as `INSTRUMENT_TRANSPOSE`) — e.g. a clarinet
  reporting a pitch two octaves outside its real WRITTEN range is flagged
  `invalid`, regardless of what any recognizer says or what instrument
  transposition would eventually apply.
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
### [Revision 2] Ground-truth live test — replaces "plausible" as the bar

**The original draft of this spec said the live test should confirm
disputed measures "resolve to a plausible, validator-passing result."
That is explicitly rejected as an acceptance criterion** — plausibility
is exactly the property a confident hallucination already has, and
validator-passing is, per the asymmetry callout above, not evidence of
correctness either. A system that produces a plausible, validator-passing,
WRONG transcription and calls the test green has learned nothing from
tonight's investigation.

**Ground truth must come from a real, verified source — not from a
manual visual reading done under time pressure during this project.**
When this spec was written, an attempt was made to hand-transcribe the
test photo directly by eye; it was abandoned mid-attempt because
distinguishing adjacent staff positions (e.g. G5 vs A5, one step apart)
on this specific photo, even cropped and zoomed 2x, could not be done
with the confidence this test requires — producing a "ground truth" that
way would just relocate the project's core failure mode from the model
onto the person building the test. Acceptable ground-truth sources, in
order of preference:

1. The take's owner verifies or corrects a candidate transcription
   directly against the physical page (fastest, most reliable, no
   external dependency).
2. A clean published source for this exact piece/arrangement ("Procession
   of the Nobles," arr. Jay Bocook, MusicWorks 1992, plate 26423039) —
   a purchased/official score or a verified transcription (e.g. IMSLP,
   MuseScore) can serve as ground truth without needing the photo itself
   to be re-read by anyone.
3. A cleaner photo or real scan of the same page, if one can be
   produced — removes the ambiguity that made the direct-transcription
   attempt above unreliable, and can then be read (by a person, at that
   point, not an LLM) with real confidence.

**This ground-truth transcription is a Day 1 prerequisite deliverable**,
not something assembled ad hoc when Day 3's live test needs it — get it
early so the acceptance bar is known before implementation, not
retrofitted after.

**Acceptance criteria against that ground truth** (all measured, none
assessed by eye post-hoc):
- **Exact pitch accuracy**: fraction of notes whose pitch matches ground
  truth exactly.
- **Exact duration accuracy**: fraction of notes whose duration matches
  ground truth exactly.
- **Missing/extra-note rate**: notes present in ground truth but absent
  from output, and vice versa.
- **Measure-perfect accuracy**: fraction of measures that are 100%
  correct (every note, every duration) — the strictest and most
  representative single number, since one wrong note still produces
  audibly wrong reference audio for that whole measure.
- **Confidently-accepted-incorrect-measure count**: measures the fusion
  pipeline marked high-confidence (`needs_resolution = False`) that are
  actually wrong against ground truth. **This is the single most
  important number in the whole test** — it's a direct measurement of
  exactly the failure mode (confident, plausible, wrong) that this
  entire redesign exists to eliminate. A pipeline that improves
  measure-perfect accuracy while this count stays nonzero has not solved
  the actual problem.

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
  `compute_row_readability`, `dewarp_row`, `split_row_into_measures`
  (including its confidence score), `INSTRUMENT_WRITTEN_RANGE` table,
  `POLYPHONIC_INSTRUMENTS` set, `validate_measure`. All unit-testable
  with synthetic fixtures, no live credits needed. **Also produce the
  ground-truth transcription** (see Testing section) — a Day 1
  deliverable, not something assembled when Day 3 needs it.
- **Day 2 — [Revision 2] explicit GO/NO-GO ordering, do not build the
  full integration before this gate:**
  1. Install `oemer` in a scratch/dev environment (or a throwaway Modal
     function, matching tonight's own spike-testing pattern for
     Audiveris).
  2. Run it manually against 5-10 real dewarped measure/row crops from
     the actual problem photo (using Day 1's `dewarp_row` output).
  3. Compare oemer's raw output against the Day 1 ground truth.
  4. **Decide GO/NO-GO** on oemer as a second signal source based on
     that comparison. oemer does not need to be highly accurate to be
     useful here — it only needs to independently disagree with Claude
     often enough, and correctly enough, to be worth the API/compute
     cost. It is being asked "does this genuinely independent system
     disagree with Claude here," not "is this the primary recognizer" —
     a much lower bar than Audiveris was held to. A 70-80% raw accuracy
     could still be a net win as a disagreement signal.
  5. **Only if GO**: implement `read_score_notes_oemer` for real
     (including the Modal image dependency work and the CPU/GPU
     onnxruntime risk noted below), `align_claude_to_measure_crops`,
     `fuse_measure_confidence`, `resolve_measure_disagreement`.
  6. **If NO-GO**: skip oemer entirely for this iteration; still build
     `fuse_measure_confidence` (Claude-agreement + validator only, OMR
     signal permanently `unavailable`) and `resolve_measure_disagreement`
     — the validator + targeted-resolution improvements stand on their
     own and are still worth shipping without a second recognition
     source.
- **Day 3**: wire steps 3-11 of Data Flow into
  `read_score_notes_for_reference_audio` (or a new orchestrating
  function, implementer's judgment on the cleanest seam), ship the
  upload-flow quality-gate UI using `compute_row_readability`'s output
  (the interline-based warning, replacing the earlier raw-pixel-count
  idea from before this spec), run the ground-truth live test from Day
  1's deliverable and report the five acceptance metrics (not a
  plausibility check), deploy.
