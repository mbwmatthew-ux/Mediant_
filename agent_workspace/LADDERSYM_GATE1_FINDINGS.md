# LadderSym Gate 1 — authentic score_audio: BLOCKED, specific finding below

2026-10-30. Per the owner's explicit instruction ("If synchronization is
incompatible, stop and report the specific blocker. Do not silently
substitute the original recording"), **this report stops after Gate 1.**
Gates 2 and 3 have not been started — no checkpoint downloaded, no
inference run.

## What was tested

1. Confirmed MuseScore 4's CLI (`mscore -o out.wav in.mid`) successfully
   exports WAV audio from the existing ground-truth MIDI files — this part
   works mechanically.
2. Read LadderSym's actual batching code (`inference_error.py:
   _split_token_into_length`) directly, not the README. **Confirmed: the
   model pairs mistake-audio window `i` with a score-audio window at the
   SAME frame index** (`score_start_idx = start_idx - max_length // 2`,
   i.e. a ~4.1s score window centered on the same time position as each
   ~2.05s mistake window) — a fixed, index-based correspondence with no
   search/DTW step anywhere in the inference code. This means `score_audio`
   and `mistake_audio` **must share closely matching timing throughout the
   piece**, not just overall duration — confirmed further by reading the
   real training-data construction (`dataset/dataset_2_random_coco.py`):
   `score_audio` there is drawn from the same take's own synthesized
   instrument stem, i.e. a clean rendering sharing the SAME timeline as the
   (pre-injection) performance, not an independently-tempo'd generic score.
3. Rendered real WAV audio via MuseScore for 3 of Track B's held-out
   pieces and compared duration against the real performance's known
   duration:

   | Piece | MuseScore render | Real performance | Diff |
   |---|---|---|---|
   | 2203 (Flute) | 155.70s | 156.19s | **-0.3%** |
   | 2296 (Cello) | 259.00s | 291.92s | **-11.3%** |
   | 2289 (Violin) | 236.46s | 203.36s | **+16.3%** |

4. Since rendering all 18 held-out pieces through MuseScore would be slow,
   cross-checked with a fast, MuseScore-independent proxy: `mido`'s own
   computed MIDI length (pure tempo-track math, no audio rendering) — this
   matched the real MuseScore renders within ~3s for all 3 test pieces
   (consistent offset, likely a fixed release/reverb tail MuseScore adds),
   confirming it's a reliable stand-in. Ran it across **all 18** of Track
   B's held-out flute/violin/cello pieces:

   | Piece | Instrument | MIDI tempo-track length | Real duration | Diff |
   |---|---|---|---|---|
   | 2202 | Flute | 157.20s | 181.21s | -13.3% |
   | **2203** | **Flute** | **152.70s** | **156.19s** | **-2.2%** |
   | 2204 | Flute | 118.29s | 132.41s | -10.7% |
   | 2217 | Cello | 225.43s | 186.28s | +21.0% |
   | 2218 | Cello | 231.42s | 199.97s | +15.7% |
   | 2220 | Cello | 216.00s | 302.00s | -28.5% |
   | 2221 | Cello | 213.12s | 241.16s | -11.6% |
   | 2222 | Cello | 177.51s | 202.03s | -12.1% |
   | 2293 | Cello | 227.03s | 310.15s | -26.8% |
   | 2294 | Cello | 201.97s | 228.44s | -11.6% |
   | 2295 | Cello | 177.60s | 259.45s | -31.6% |
   | 2296 | Cello | 256.00s | 291.92s | -12.3% |
   | 2297 | Cello | 241.79s | 334.26s | -27.7% |
   | 2241 | Violin | 186.34s | 242.21s | -23.1% |
   | **2242** | **Violin** | **322.45s** | **312.74s** | **+3.1%** |
   | **2244** | **Violin** | **209.77s** | **214.36s** | **-2.1%** |
   | 2288 | Violin | 157.55s | 191.74s | -17.8% |
   | 2289 | Violin | 232.70s | 203.36s | +14.4% |

**16 of 18 held-out pieces (89%) diverge from the real performance's
actual duration by more than 5%, most by 10-32%.** Only 3 pieces (2203,
2242, 2244) are close at the whole-piece level. This is not confined to
one piece or one failure mode — more tempo events in the MIDI doesn't even
correlate with better accuracy (2289 has 139 tempo events and is still
+14.4% off; 2220/2295/2297 have only 1-3 events and are 27-32% off).

## Root cause — confirmed, not guessed

This is **not a MuseScore rendering bug.** `mido`'s length computation
never touches MuseScore or any audio engine — it's pure arithmetic over
the MIDI file's own embedded tempo-change events, and it already diverges
from real duration before any rendering happens. The ground-truth MIDI
files cached for this corpus (from MusicNet's reference MIDI, imported via
`music21` earlier in Track B) carry tempo tracks that were apparently
never validated for audio-reconstruction fidelity — only for pitch and
beat-position correctness, which is all Track B's prior work (measure
numbering, DTW alignment) actually needed. The real, validated, sample-
accurate timing ground truth lives in the separate `labels/*.csv` files
(`onset_sec`/`end_sec`, directly measured from the real audio) — not in
the `.mid` file's tempo track.

## Does Mediant's existing reference-audio feature solve this? No — checked directly, same root problem

Read `generate_reference_audio` (`worker.py:6393`) directly. It builds
note timing from a **single nominal BPM** (`safe_bpm = max(20.0, min(300.0,
float(bpm)))`), not a tempo curve, then renders every note's `start_sec`/
`end_sec` at that one constant tempo via FluidSynth. It was built to
produce a generic reference performance for teaching purposes, explicitly
not to match any specific real performer's actual (varying) tempo. Using
it as `score_audio` here would hit the identical problem — likely worse,
since it has zero tempo-curve tracking at all, not even the partial/noisy
tracking some of the held-out MIDI files have.

## Pitch/rest/instrument-assignment check (the one piece that passes timing)

For 2203 (the cleanest case), beyond the clef/time-signature/measure-
numbering checks already done in Task 4B: ran onset detection on the
MuseScore-rendered WAV over the same 124-140s window used in Task 4B's
benchmark — 105 detected onsets vs. 116 real ground-truth notes in that
window (90.5%, consistent with sixteenth-note runs blurring together under
simple onset detection, not a rendering defect). Combined with the
duration match, this is a genuine pass for 2203 specifically.

## The smallest viable fix — identified, NOT built, needs approval

The real per-note `onset_sec`/`end_sec` ground truth (validated, used
throughout Track B) can drive a FluidSynth render directly — reusing
`generate_reference_audio`'s exact rendering pattern (same tool, same
soundfont) but wiring real per-note timing in place of a single nominal
BPM — producing a `score_audio` that is, by construction, timeline-matched
to the real performance as closely as the labels permit. This is a small,
well-scoped piece of **new code** (a different timing source into an
already-proven rendering path, not a new rendering technology), but it is
still new code, and per the owner's own stop condition ("If a new
dependency, substantial compute expense, or material methodological
substitution becomes necessary, stop and request approval") — this
qualifies. **Not built. Stopping here to ask.**

## Where this leaves the three gates

- **Without any new engineering:** only 2203 (Flute) clearly passes both
  the duration check and the spot-check pitch/onset correspondence. 2242
  and 2244 (Violin) are close at the whole-piece level (-2.1%/+3.1%) but
  **not yet validated at the finer, local-window level that actually
  matters for the model's ±~1s margin** — a whole-piece average can hide
  local drift that cancels out over the full duration. That finer check
  has not been run.
- **Cello has zero passing pieces** out of 10 tested — every held-out
  cello piece fails the coarse check already.
- A Gate 3 benchmark run on only 1-3 pieces, all but one unconfirmed at
  the local level, and zero cello coverage, would not be the "small,
  preselected subset of held-out violin, cello, and flute cases" the owner
  asked for — it would be close to flute-only, with the violin pieces
  needing a finer check before they could be trusted either.

## Options for how to proceed

1. **Approve building the smallest-viable fix** (FluidSynth render driven
   by real per-note `onset_sec`/`end_sec`, reusing `generate_reference_audio`'s
   pattern) before continuing Gate 1 — this would very likely unblock all
   18 pieces, including cello, since it uses validated per-note timing
   rather than trusting any MIDI tempo track.
2. **Proceed with only the 1 (or up to 3, pending a finer local check)
   already-passing pieces** — accepts a much smaller, flute-skewed, likely
   zero-cello benchmark for now.
3. **Stop here** pending further direction.

No download, no inference, no checkpoint decision has been made — all of
that is still gated on how this resolves.
