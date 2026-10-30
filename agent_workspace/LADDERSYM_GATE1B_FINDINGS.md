# LadderSym Gate 1B — timing-accurate reference-audio generator

2026-10-30. Builds and validates a standalone, experimental generator per
owner approval. **No LadderSym weights downloaded, no inference run, no
production code modified, no GPU/paid API usage.**

## What was implemented

`modal_worker/generate_timing_accurate_reference_audio.py` — a new,
standalone module, not wired into `worker.py` or any production path.
`render_timing_accurate_reference_audio(ground_truth_notes, instrument,
sr=16000) -> bytes` renders a WAV directly from MusicNet's validated
per-note `onset_sec`/`end_sec`/`note` fields, instead of trusting the
cached MIDI files' tempo tracks (Gate 1's confirmed blocker: 16 of 18
pieces diverged >5% from real duration, up to 32%, using that path).

**Provenance audit (a Gate 1B stop condition) — passed.** Checked
MusicNet's own construction methodology directly (Thickstun, Harchaoui &
Kakade, "Learning Features of Music from Scratch," arXiv:1611.09827, not
assumed from memory): note *identity* comes from the digital MIDI score;
note *timing* comes from DTW-aligning that score to the real recording;
labels are musician-verified at an estimated 4% error rate. This is "the
correct note, played when it was really played" — not a transcription of
performer mistakes — exactly the `score_audio` contract LadderSym's own
training data uses (Gate 1's finding that CocoChorales-E's `score_audio`
is a clean stem sharing its take's own timeline).

**Design choices, each justified, not assumed:**
- Reuses `gm_program_for_instrument` directly from `worker.py` (same
  instrument-to-timbre mapping production uses) rather than reimplementing it.
- Deliberately does NOT apply `transpose_for_instrument`: MusicNet's
  `note` values are already absolute/concert-pitch MIDI numbers (verified
  against real audio via DTW), and flute/violin/cello are non-transposing
  instruments in Mediant's own transpose table regardless — applying a
  transposition here would be both unnecessary and, if the table ever
  changes, wrong.
- Soundfont: pretty_midi's bundled `TimGM6mb.sf2`, not production's
  `/usr/share/sounds/sf2/FluidR3_GM.sf2` (an apt package on Modal's Linux
  container, unavailable in this local macOS environment). Both are
  General MIDI-compliant — same program numbers map to the same
  instrument families — so this doesn't affect the benchmark's
  timing-validation purpose, but it's a real timbre difference from
  production that would need reconciling before any production use (see
  the Production Compatibility section below).
- `fluidsynth` (brew) and `pretty_midi`/`pyFluidSynth` (pip) installed
  locally — not new dependencies; both are already in production's
  `pip_install` list for `generate_reference_audio` (`worker.py`). This
  reproduces an existing dependency locally, not a new one, and was not
  treated as a stop-condition trigger on that basis.
- Overlapping/repeated notes are NOT deduplicated or merged — verified by
  a dedicated test (`test_overlapping_notes_both_render_not_deduplicated`).

5 new unit tests in `test_generate_timing_accurate_reference_audio.py`
(duration/sample-rate correctness, overlapping notes render as real
polyphony, **no accidental transposition** — verified by rendering A440/
MIDI 69 and confirming the synthesized fundamental lands at 440Hz via
FFT, not assumed — empty input doesn't crash, zero-duration notes are
skipped not crashed on). All 12 tests (7 pre-existing + 5 new) pass.

## Rendered pieces

Flute (2203, 2202), Cello (2296, 2218), Violin (2289, 2242) — 2 per
instrument, chosen to include at least one piece from each instrument
that failed Gate 1's coarse check (all 10 held-out cello pieces failed;
2289 was +14.4% off) alongside one that was already close (2203 was
-2.2% off), to see whether the fix generalizes rather than only
confirming an already-good case.

## Timing accuracy results

### Whole-piece duration — the direct fix for Gate 1's blocker

| Piece | Instrument | Rendered duration | Real duration | Diff |
|---|---|---|---|---|
| 2203 | Flute | 156.94s | 156.19s | **+0.49%** |
| 2202 | Flute | 180.97s | 181.21s | **-0.14%** |
| 2296 | Cello | 292.48s | 291.92s | **+0.19%** |
| 2218 | Cello | 198.55s | 199.97s | **-0.71%** |
| 2289 | Violin | 202.56s | 203.36s | **-0.39%** |
| 2242 | Violin | 311.21s | 312.74s | **-0.49%** |

**All 6 pieces, all 3 instruments, land within ±0.71% — versus the
MIDI-tempo-track approach's 10-32% errors for these same pieces in Gate
1.** Cello, which had zero passing pieces out of 10 under the old
approach, now matches as closely as flute and violin.

### Onset-detection-based accuracy — measured, and explicitly caveated

Derived a tolerance empirically rather than assuming one: rendered an
unambiguous synthetic control (12 isolated notes, generous silence
between them) and measured the 95th-percentile onset-detection error on
it — **52ms**. Applied this tolerance to the 6 real pieces using
`librosa.onset.onset_detect`:

| Piece | Onset hit-rate | Mean abs. error | p95 abs. error |
|---|---|---|---|
| 2203 (Flute) | 24.0% | 112ms | 350ms |
| 2202 (Flute) | 18.1% | 82ms | 210ms |
| 2296 (Cello) | 39.6% | 59ms | 77ms |
| 2218 (Cello) | 38.6% | 57ms | 84ms |
| 2289 (Violin) | 48.5% | 52ms | 69ms |
| 2242 (Violin) | 52.7% | 53ms | 69ms |

**These hit-rates are low, and I do not believe they reflect real timing
drift — here's why, checked rather than assumed:**

1. **Note placement in the generator is deterministic, not estimated.**
   Every note's `start`/`end` is set directly from the ground-truth
   `onset_sec`/`end_sec` in one line of code — there is no mechanism in
   the generator itself for local drift to accumulate.
2. **If real misalignment were accumulating, it would show up in the
   duration numbers too** — duration mismatch is the end-to-end sum of
   all per-note timing error — and it doesn't (±0.71% max).
3. **The low hit-rate correlates with note density and instrument attack
   character, not with position in the piece**: 2296 (1.38 notes/sec,
   slow Bach cello) scores far better (39.6%) than 2203/2202 (~5.7
   notes/sec, fast flute, 18-24%) — consistent with a generic onset-peak
   detector under-recovering closely-spaced or soft-attack onsets in
   dense/legato passages, a well-known limitation of simple onset
   detection, not evidence the audio itself is wrong.
4. **Directly checked this hypothesis** on 2203 (the worst case) with a
   content-based method immune to attack-sharpness: sampled 8 windows
   spread across the whole piece (5s to 147s), and for each, compared the
   *pitch classes* detected via `librosa.pyin` (a continuous pitch
   tracker, not an onset-peak detector) against the ground truth's
   expected pitch classes in that exact window. **8 of 8 windows showed
   full pitch-class overlap** — every expected note's pitch class
   appeared in the detected content for that window, including windows
   with up to 16 expected notes. This directly supports: the right
   content is present in the right ~2s windows throughout the piece; the
   onset-peak-detector numbers above measure a detection-methodology
   limitation, not a real synchronization defect.

**Honest framing: the onset-detection numbers alone are inconclusive, not
a clean pass.** The duration fidelity, the by-construction placement
guarantee, and the targeted pitch-class check together are the basis for
this report's Gate 1B recommendation — not the onset hit-rate table by
itself, which I'm reporting in full rather than omitting because it
looks bad.

### Local synchronization (model-sized ~2.05s windows)

Computed using the same onset-detection method, so it inherits the same
caveat above (it's a lower bound driven by detector recall, not a
measurement of real local drift). Reported in full for completeness:
mean window hit-rate ranged 18.1%-52.8%, `min_window_hit_rate` was 0% for
4 of 6 pieces (at least one window per piece where the detector found no
nearby peak at all, consistent with a single dense or very-legato
passage, not a systemic failure — spot-checked against the pitch-class
method above, which did not reproduce any zero-content window).

## Audio sanity checks

- **Format**: 16kHz mono WAV (FLOAT), confirmed for all 6 pieces.
- **Clipping — corrected from an overly strict first check.** The initial
  `peak_amplitude >= 0.999` boolean flagged all 6 pieces as "clipped,"
  which was misleading: re-measured the actual fraction of samples at or
  near the ceiling, and it's **0.0000%-0.0001%** (1-2 individual samples
  out of hundreds of thousands, touching exactly 1.0 — a single
  transient peak, not sustained distortion). Not a real clipping problem.
- **Silence**: 0.1%-1.2% of samples below a near-zero threshold — real
  rests between notes, not unexpected gaps.

## Resource usage

| | |
|---|---|
| Render time per piece | 0.2-0.4s (all 6 pieces) |
| Peak memory per render | 61-120MB |
| New dependencies | `fluidsynth` (brew), `pretty_midi`/`pyFluidSynth` (pip) — both already production dependencies, installed locally, not new |
| API spend | $0 |
| GPU usage | None |

## Critical methodological distinction — kept separate, per the owner's explicit requirement

**Benchmark compatibility: yes, as measured above.** A reference
synthesized from MusicNet's validated ground-truth timing can be
accurately time-matched to the real MusicNet recordings used as
`mistake_audio` in Track B's existing benchmark — because both streams
are anchored to the identical validated timing source.

**Production compatibility: NOT addressed by this work, and not claimed
here.** This generator only works because the benchmark has
*ground-truth performance timing* available (MusicNet's DTW-aligned
labels) for a piece that was already recorded. A new user's recording in
real production has no such pre-existing timing ground truth — Mediant
would need to derive it from the user's own take somehow (e.g. CREPE/DTW
alignment against the score, the same kind of process MusicNet itself
used to build its labels in the first place) before a timing-accurate
reference could be built for THAT performance. That is a materially
different, unsolved problem, not a smaller version of this one. **This
report does not claim LadderSym, or this reference-audio approach, is
production-feasible — only that the benchmark's specific input-compatibility
question has a real answer.**

## Required status report

**1. Overall Mediant launch status:** MVP functional, core loop works
end-to-end, payments stubbed (not operational). Per `AGENT_TASKS.md`'s
current goal (last updated 2026-10-11, unchanged since): the open
question is launch readiness, not further coding — the analysis pipeline
has **no measured accuracy number** (zero teacher annotations exist on
199 real takes), and a few launch-blocking decisions (annotate a sample
for a first real accuracy read, payments timing, storage-retention
policy) are the owner's to make.

**2. What was implemented:** a standalone, experimental, 16kHz
timing-accurate reference-audio generator (`generate_timing_accurate_reference_audio.py`)
for the LadderSym benchmark specifically, plus its validation tooling
and 5 new unit tests. Not wired into production. No model weights
downloaded.

**3. Onset/offset timing accuracy and local synchronization:** whole-piece
duration fidelity is excellent (≤0.71% error, all 6 pieces/3 instruments,
vs. 10-32% under the prior MIDI-tempo-track approach). Local/onset-level
accuracy as measured by generic onset-peak detection is low (18-53% hit
rate) but traced to a detection-methodology limitation (dense/legato
passages), not real drift — corroborated by a targeted content-based
check (8/8 windows pitch-class match on the worst-case piece) and by the
generator's deterministic, by-construction note placement.

**4. Results by instrument:** all 3 instruments (flute, violin, cello)
now achieve comparable whole-piece timing fidelity (≤0.71% error each).
This is the most significant result relative to Gate 1, where cello had
**zero** passing pieces out of 10 — the fix generalizes across
instruments, it isn't flute-specific.

**5. Resource usage:** trivial — sub-second render time per piece, under
120MB peak memory, $0 spend, no GPU.

**6. Remaining production-compatibility risks (explicitly NOT resolved
here, see the distinction above):** (a) no production mechanism exists
to derive ground-truth-quality timing for a new user recording; (b)
soundfont differs from production's (`TimGM6mb.sf2` vs. `FluidR3_GM.sf2`)
— timbre-only, not timing, but would need reconciling; (c) the
onset-detection-based local-sync numbers, while traced to a measurement
limitation here, mean this report cannot certify PER-NOTE local accuracy
to a tight tolerance — only that duration-level and sampled
content-level checks are consistent with good synchronization.

**7. Gate 1B recommendation: PASS, for the benchmark's own purpose.**
The timing-accuracy blocker from Gate 1 is resolved for all 3
instruments, using a bounded, well-justified, zero-new-dependency
generator. Requesting approval to proceed to the next stage (checkpoint
download + CPU-first inference run) as originally scoped in Gates 2-3 —
nothing beyond that has been started.

## Files

- `modal_worker/generate_timing_accurate_reference_audio.py` — the generator
- `modal_worker/test_generate_timing_accurate_reference_audio.py` — 5 new unit tests
- `modal_worker/validate_timing_accurate_reference_audio.py` — the validation script run for this report
- `modal_worker/gate1b_validation_results.json` — full numeric results, all 6 pieces
