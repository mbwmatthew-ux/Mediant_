# Task 4A — Gemini-only performance-feedback accuracy pilot

Owner-approved, 2026-10-30. Scope: 2 wrong_pitch + 2 deleted_note + 2
duplicated_note + 3 unmodified controls = 9 real paid calls to the real,
unmodified `evaluate_with_gemini`, Gemini 2.5 Flash only (Pro fallback
disabled at runtime, no file edit), independent of CREPE/DTW and Claude
coaching (neither is called anywhere in this experiment). Hard cap
$2.00 / 9 calls. Tooling: `modal_worker/run_task4a_gemini_pilot.py`,
`modal_worker/inject_audio_mistakes.py` (crossfade fix, see below).

No real score-music page images exist for these MusicNet pieces (no
MuseScore/Lilypond installed) — owner confirmed proceeding in
`evaluate_with_gemini`'s own existing "no score provided" fallback
branch, unmodified. **That branch's own prompt tells Gemini to report
every issue's "measure" as `start_measure` regardless of where it
actually occurred — so "measure" is not a usable signal in this test.**
Scoring used "time" (the field Gemini reports from listening) instead.

## Pre-work: crossfading the injected mistakes

Before any paid call, added a 10ms linear crossfade at every splice
boundary `inject_audio_mistakes.py`'s own docstring had identified as a
hard digital click (wrong_pitch's two edges, deleted_note's two edges,
duplicated_note's one splice point). Verified via
`measure_injection_boundary_artifacts.py`: `deleted_note`'s offset and
`duplicated_note`'s splice now measure exactly 0.0 jump (down from 12.4x
and 1.4x the fixture's normal in-tone delta); the two remaining nonzero
numbers are the measurement fixture's own inherent tone-to-tone boundary,
present even with no mistake injected — not an artifact of this code.
Caught and fixed one real bug in the first draft (the duplicated_note
anchor was computed from the wrong sample position). All 7 tests pass.
Zero cost — pure local signal processing.

## Real cost and latency

All 9 cases ran successfully. **Real total spend: $0.2450 of the $2.00
cap** (worst-case pre-call gate had reserved ~$0.96-1.09 total — real
cost came in at roughly 1/4 of the conservative estimate). Per-call
range: $0.0178–$0.0383, latency 22.3–48.9s (includes file upload + Gemini
processing). No Pro fallback was triggered (Flash succeeded on the first
attempt every time); no retries were needed (no transient HTTP failures
occurred).

| Piece | Instrument | Condition | Latency | Real cost |
|---|---|---|---|---|
| 2203 | Flute | wrong_pitch | 26.1s | $0.0197 |
| 2241 | Violin | wrong_pitch | 48.9s | $0.0383 |
| 2218 | Cello | deleted_note | 34.4s | $0.0286 |
| 2296 | Cello | deleted_note | 31.5s | $0.0265 |
| 2244 | Violin | duplicated_note | 40.6s | $0.0330 |
| 2204 | Flute | duplicated_note | 22.3s | $0.0178 |
| 2289 | Violin | control | 40.5s | $0.0317 |
| 2202 | Flute | control | 27.6s | $0.0204 |
| 2288 | Cello | control | 39.5s | $0.0289 |

## The central finding: issue counts scale with duration, not content

Before scoring individual flags, a simple cross-check: how many total
issues did each call return, against that piece's real duration?

| Piece | Condition | Duration | Total issues | Rate | Intonation-only rate |
|---|---|---|---|---|---|
| 2203 | wrong_pitch | 156.2s | 114 | 1/1.37s | 1/5.39s |
| 2241 | wrong_pitch | 242.2s | 246 | 1/0.98s | 1/1.02s |
| 2218 | deleted_note | 200.0s | 200 | 1/1.00s | 1/1.02s |
| 2296 | deleted_note | 291.9s | 147 | 1/1.99s | 1/2.06s |
| 2244 | duplicated_note | 214.5s | 217 | 1/0.99s | 1/1.02s |
| 2204 | duplicated_note | 132.7s | 98 | 1/1.35s | 1/1.53s |
| 2289 | **control** | 203.4s | 204 | 1/1.00s | 1/1.02s |
| 2202 | **control** | 181.2s | 116 | 1/1.56s | 1/7.25s |
| 2288 | **control** | 191.7s | 202 | 1/0.95s | 1/1.03s |

**6 of 9 cases — injected AND control alike, across all three
instruments and completely different real pieces — produce almost
exactly one issue per second of audio.** Piece 2241 (wrong_pitch,
Violin) and piece 2289 (control, Violin, a different piece entirely)
both generate a 200+ item intonation list that descends the diatonic
scale one scale-step per second ("D5 ~20¢ flat" → "A4 ~20¢ flat" → "G4
~20¢ flat" → ... → "A0 ~20¢ flat"), with near-identical phrasing,
regardless of what's actually being played. This is strong,
quantifiable evidence that for a long (2-5 minute), no-score audio clip,
**Gemini's Flash model produces a formulaic, duration-scaled stream of
generic observations rather than genuinely tracking individual notes**
— the same "fires regardless of content" pattern Track B's CREPE/DTW
free-leg benchmark found for its own "detection" metric (100% false
positive rate on control audio), now observed at the Gemini
flag-authoring stage too.

## Scoring against the injected ground truth

Given "measure" is unusable, scoring used the category most semantically
relevant to each mistake type (`wrong_notes_cracks` for wrong_pitch/
deleted_note/duplicated_note) and checked whether ANY entry's "time"
field landed within a few seconds of the real injected `onset_sec`, with
a plausible mistake-type description — read by hand, not by automated
string matching, per the owner's explicit requirement.

| Piece | Mistake | Injected at | Result |
|---|---|---|---|
| 2203 | wrong_pitch | 132.2s | Borderline hit — "A note is missed in the fast run" at 2:12 (132s), close in time. But `wrong_notes_cracks` here cycles through 4 fixed phrases at a near-regular ~8s interval across the whole piece, so a coincidental landing near any given timestamp is not unlikely. |
| 2241 | wrong_pitch | 191.0s | **Miss.** Only 2 generic, whole-piece-spanning entries ("numerous instances... throughout the performance"), no specific flag near 191s. |
| 2218 | deleted_note | 168.5s | **Miss.** Same pattern — 1 generic whole-piece entry, nothing specific. |
| 2296 | deleted_note | 247.9s | **Confident false negative.** The single `wrong_notes_cracks` entry states: *"There are no wrong notes or cracks in the performance."* A note really was deleted at 247.9s. |
| 2244 | duplicated_note | 178.6s | **Confident false negative.** States: *"No wrong notes or cracks observed."* A note really was duplicated at 178.6s. |
| 2204 | duplicated_note | 113.8s | **Miss.** 7 specific entries at an 18s cadence (0, 19, 37, 55, 73, 91, 109s) — none within ~5s of 113.8s. |

**5 of 6 injected mistakes were missed; 2 of those misses were confident,
explicit false negatives** ("no wrong notes" stated despite a real
injected mistake). Only 1 of 6 is even an arguable hit, and that one is
confounded by the same periodic-template pattern found everywhere else.

## Controls: not automatically classified as false, but suspicious

Per the owner's explicit instruction, control flags are NOT assumed
false just because no mistake was injected — these are real MusicNet
performances and could contain genuine imperfections. However, the
SAME verbatim-repeated phrasing recurs at different timestamps within a
single control response (piece 2202: "A wrong note was played, sounds
like a C instead of a D" appears **three separate times**, at 0:12,
1:04, and 2:33, word-for-word identical) — a strong signature of
template generation rather than three independent, specific
observations of three different real moments in the recording. This
doesn't prove any individual flag is false, but it undermines confidence
that these are genuine, independently-grounded observations rather than
filler generated to satisfy an expected response shape.

## What this does and does not prove

**Proves:** `evaluate_with_gemini`, called exactly as production calls
it, on a WHOLE long (2-5 minute) solo recording with no score image,
using Gemini 2.5 Flash, does not reliably and specifically identify
these six injected mistakes. Two of six misses were confident false
negatives. The output volume scales with clip duration almost
exactly 1:1, independent of actual musical content, across both
injected and control conditions and across all three instruments tested.

**Does not prove:** that Gemini is incapable of this task in general.
Two material differences from real production use were present in this
pilot and may be driving the formulaic-output pattern: (1) no score
image was available (production always provides one, and the "no score"
prompt branch explicitly tells Gemini to rely on timestamps alone,
offering it far less grounding than it would have in real use); (2) full
2-5 minute pieces were used whole, not short clips — production take
lengths vary, but a much shorter, more attention-dense clip centered on
one passage might behave very differently. Neither of these was tested
here.

## Recommendation

**Do not proceed to the full fused pipeline (`compare_and_coach_claude`)
on this design.** The Gemini-only leg itself does not show the
reliability needed to be a trustworthy input to a fusion stage — feeding
noisy, duration-scaled, confidently-wrong flags into Claude's synthesis
would not produce an interpretable signal about Claude's own
coaching-fusion quality.

**If this line of investigation continues, the next experiment should
change the design, not just add Claude on top of this one:** test
`evaluate_with_gemini` on short (20-40s) clips centered on a single
mistake, and/or with a real score image present (matching actual
production conditions), before concluding anything final about Gemini's
real capability. This pilot's specific combination (whole long piece,
no score) may have specifically triggered the formulaic/templated
degeneration mode observed here, rather than being representative of how
Gemini performs in the system's real, intended configuration.

## Files

- `modal_worker/inject_audio_mistakes.py` — crossfade fix (committed `0369643`)
- `modal_worker/run_task4a_gemini_pilot.py` — the pilot runner (budget-gated, real-cost-tracked)
- `modal_worker/task4a_pilot_results.json` — full real results, all 9 cases
