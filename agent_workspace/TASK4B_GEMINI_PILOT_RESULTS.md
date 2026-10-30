# Task 4B — Production-faithful Gemini evaluation

Owner-approved, 2026-10-30. Goal: determine whether Task 4A's failures
(missed mistakes, confident false negatives, duration-scaled formulaic
output) were caused by the two ways that pilot deviated from real
production use — no score image, and whole 2-5 minute clips instead of
short ones — rather than a fundamental limit of `evaluate_with_gemini`.

Scope: 3 cases reused from Task 4A (2203 Flute/wrong_pitch, 2296
Cello/deleted_note, 2289 Violin/control), same `rng_seed=0` so the
injected audio is byte-identical to Task 4A's. Each case run under 3
NEW conditions — (A) short clip, no score; (B) short clip, full-piece
score image; (C) full recording, full-piece score image — for 9 new
calls, reusing Task 4A's already-paid (D) full-recording/no-score
results for the 4-way comparison. Gemini 2.5 Flash only, no Pro
fallback, `evaluate_with_gemini`'s real prompt/model/schema unchanged.

## Pre-work: MuseScore installation and score-rendering fidelity check

Installed MuseScore 4.7.6 via Homebrew (owner-approved local dev-tool
install, no production dependency change) and rendered all 3 pieces'
MusicNet reference MIDI to full scores (`mscore -o out.pdf in.mid`),
matching production's real convention of sending the whole score, every
page, never cropped to a measure range (confirmed by reading
`worker.py`'s `_gemini_pipeline` closure directly).

Verified before any paid call, per the owner's explicit instruction:

- **Clefs**: correct (treble for Flute/Violin, bass for Cello).
- **Time signatures**: correct — all three pieces rendered as 3/4,
  matching the independently-computed values used for excerpt framing.
- **Measure numbering**: correct and legible at every checked location.
  Spot-checked the exact excerpt region for all three pieces (2203
  measure 74, 2296 measure 56, 2289 measure 80) against the page images
  — each appears at the expected position with the expected printed
  number, confirming consistency between MuseScore's numbering and the
  `beats_per_measure_from_time_sig` formula used to compute mistake
  measures.
- **Note placement**: not independently re-transcribed note-by-note
  (out of scope for a pre-flight check), but pitches derive from the
  same MIDI file the ground truth and injection logic already use, so
  internal consistency is structural, not just visual.

**Real rendering artifacts found and not worth blocking on:**

- **2203** renders with no key signature and heavy accidentals instead
  (MuseScore's MIDI-to-key-signature inference did not pick a key for
  this piece); doesn't affect pitch correctness, only visual convention.
- **2296** renders as 3 simultaneous staves for the single solo cello
  part (the MIDI splits the implied-polyphony line across 3 tracks;
  MuseScore renders each as its own staff) rather than the single staff
  real published cello sheet music would show. All pitches are present,
  just visually distributed differently than a real engraved part.
- **2289** renders with dense, cluttered tempo-change markings (a MIDI
  tempo-map artifact — near-beat-level micro tempo fluctuations encoded
  as discrete events) that don't affect pitch or measure content.

These are honest MIDI-derived-score limitations, not available in real
production use (where a human uploads real engraved sheet music), and
are flagged here per the owner's "record any rendering ... artifacts
that may affect interpretation" requirement.

## Incident: API key committed and auto-revoked mid-run

The first run was interrupted after 1 of 9 calls by Google revoking the
Gemini key with `403 PERMISSION_DENIED: "Your API key was reported as
leaked."` Root cause: the key had been hardcoded directly into
`run_task4a_gemini_pilot.py`, which was committed (`49e7d45`) and pushed
to `github.com/mbwmatthew-ux/Mediant_`, **a public repository** — almost
certainly caught by GitHub's automated secret-scanning partnership with
Google. The same hardcoded pattern had been copied into the new,
not-yet-committed `run_task4b_gemini_pilot.py`.

Fixed before continuing: both scripts now read the key from the
`GOOGLE_AI_API_KEY` environment variable, no literal key in either file.
Confirmed (owner, 2026-10-30) the leaked key was test-only, never used as
Mediant's production Gemini credential, and the git history was left as
is (the key is already dead; rewriting public history is more disruptive
than leaving an inert string in place). The owner issued a replacement
key and the run was redone cleanly from the top rather than attempting a
partial resume, since the crashed run's single completed result (2203,
short/no-score, $0.0064) couldn't be reliably spliced back in. **Real
total spend across the incident: $0.1214 (9 approved calls) + $0.0064
(the one call made with the dead key before the 403) = $0.1278**, against
the $1.50 cap and a $0.9348 worst-case pre-call estimate — about 14% of
the conservative estimate, consistent with Task 4A's real:worst-case
ratio.

## Real cost, tokens, and latency

| Piece | Condition | Duration | Pages | Input tok | Output tok | Latency | Real cost |
|---|---|---|---|---|---|---|---|
| 2203 | short, no score | 14.9s | 0 | 2,348 | 1,490 | 8.6s | $0.0061 |
| 2203 | short, with score | 14.9s | 3 | 3,369 | 1,239 | 7.9s | $0.0065 |
| 2203 | full, with score | 156.2s | 3 | 7,881 | 2,609 | 13.6s | $0.0144 |
| 2296 | short, no score | 37.5s | 0 | 3,279 | 1,683 | 9.8s | $0.0075 |
| 2296 | short, with score | 37.5s | 3 | 4,300 | 1,212 | 7.8s | $0.0073 |
| 2296 | full, with score | 291.9s | 3 | 12,432 | 8,499 | 40.2s | $0.0337 |
| 2289 | short, no score | 11.2s | 0 | 2,578 | 1,194 | 7.5s | $0.0056 |
| 2289 | short, with score | 11.2s | 5 | 4,115 | 1,131 | 7.2s | $0.0069 |
| 2289 | full, with score | 203.4s | 5 | 10,255 | 9,270 | 38.6s | $0.0334 |

Total: **$0.1214**, 50,557 input tokens, 28,327 output tokens. Short
clips cost $0.006-0.008 and run in 7-10s; full-length clips with a score
cost $0.013-0.034 and run in 13.6-40.2s — latency and cost both scale
roughly with clip duration and output volume, not with condition type.

## The central finding, restated: duration-scaled formulaic output survives adding a score image

| Piece | Condition | Duration | Issues | Rate |
|---|---|---|---|---|
| 2203 | short, no score | 14.9s | 30 | 1/0.50s |
| 2203 | short, with score | 14.9s | 22 | 1/0.68s |
| 2203 | full, with score | 156.2s | 58 | 1/2.69s |
| 2296 | short, no score | 37.5s | 39 | 1/0.96s |
| 2296 | short, with score | 37.5s | 26 | 1/1.44s |
| 2296 | full, with score | 291.9s | 211 | 1/1.38s |
| 2289 | short, no score | 11.2s | 26 | 1/0.43s |
| 2289 | short, with score | 11.2s | 23 | 1/0.49s |
| 2289 | **full, with score** | 203.4s | **204** | **1/1.00s** |

The last row is the decisive one. **2289's full-recording, WITH-score
condition produced the exact same issue count (204) at the exact same
rate (~1/second) as Task 4A's full-recording, NO-score result for this
same piece** (Task 4A: 204 issues, 203.4s, 1/1.00s — identical numbers).
Adding a real, correctly-rendered score image to the full-length
condition did not change the output volume or its duration-scaling
pattern at all.

**Direct proof this is template generation, not listening — the score
image makes no difference:** 2289's full-with-score `intonation_issues`
list (200 entries, one roughly per second) walks the circle of fifths
mechanically, one step sharper per measure, without ever resolving
enharmonic spelling:

> m1: "The opening D5 is roughly 20¢ sharp." → m9: "The F#5 is roughly
> 20¢ sharp." → m12: "The D#5 is roughly 20¢ sharp." → ... → m196:
> **"The E###########################5 is roughly 20¢ sharp."** → m199:
> **"The C############################5 is roughly 20¢ sharp."**

Note names with 25+ stacked sharp signs are not music — no real
listening process produces this. This is a generation process counting
through the circle of fifths on a fixed per-measure clock, confirmed to
persist with a correct, legible, production-faithful score image
present. Short clips did not exhibit this extreme a failure mode (their
issue counts are far lower, and nothing this obviously broken appears in
any short-clip response) — shortening the clip clearly reduces the
severity of the degeneration, but, as the detection scoring below shows,
does not fix detection reliability.

## Scoring against the injected ground truth, across all 4 conditions

### 2203 — Flute, wrong_pitch, measure 74 (E5→G5, onset 132.18s)

| Condition | `wrong_notes_cracks` at/near measure 74 | Verdict |
|---|---|---|
| A. Full, no score (Task 4A) | "A note is missed in the fast run" at 2:12 (132s) | Borderline — close in time, but this category cycles 4 fixed phrases at a near-regular ~8s interval across the whole piece; a coincidental landing nearby isn't unlikely |
| B. Short, no score | **m74: "A squeak on the attack of the high G in measure 74"** | **Hit** — correct measure, and "high G" is the actual injected pitch (new_note=79=G5) |
| C. Short, with score | **m74: "A wrong note (sounds like a B instead of C) is played in measure 74"** | **Partial hit** — correct measure, explicitly calls it a wrong note (clearer framing than B), but the stated pitch (B→C) does not match what was actually injected (E→G) |
| D. Full, with score | Periodic list at measures 3,12,20,28,37,45,54,62,**70**,**78** — evenly spaced ~8-9 apart, 74 skipped entirely | **Miss** — same fixed-interval template pattern as Task 4A's no-score result, score image present notwithstanding |

### 2296 — Cello, deleted_note, measure 56 (onset 247.9s)

| Condition | `wrong_notes_cracks` at/near measure 56 | Verdict |
|---|---|---|
| A. Full, no score (Task 4A) | "There are no wrong notes or cracks in the performance." | **Confident false negative** |
| B. Short, no score | `wrong_notes_cracks`: empty | **Miss** |
| C. Short, with score | `wrong_notes_cracks`: empty | **Miss** |
| D. Full, with score | Periodic list at measures 1,10,22,34,**45**,**57**,62,74... — 12 apart, 56 skipped | **Miss** |

All 4 conditions miss this mistake. A score image and a short clip,
separately or together, did not produce a single flag anywhere near the
real deleted note.

### 2289 — Violin, control (no injected mistake)

| Condition | `wrong_notes_cracks` | Note |
|---|---|---|
| A. Full, no score (Task 4A) | Verbatim-repeated phrase 3x at different timestamps | Suspicious (template signature), not auto-classified false |
| B. Short, no score | 2 "crack" flags (m77, m79) | Can't be called false — real, unverified MusicNet recording |
| C. Short, with score | Empty | **Inconsistent with B on the same underlying audio** — adding the score didn't "correct" the flags, it just produced a different, contradictory answer |
| D. Full, with score | "No wrong notes or cracks observed." | Plausibly correct (genuine negative) — but the intonation list for this exact response is the circle-of-fifths degenerate pattern above, so this category being clean doesn't vouch for the response as a whole |

## Overall hit rate across the 2 real injected cases

Across the 2 injected cases × 4 conditions (A legacy Task 4A, B/C/D new)
= 8 opportunities to correctly flag a known, real mistake: **1 hit
(2203-B), 1 partial hit (2203-C), 1 borderline (2203-A), 5 clean misses**
(2203-D, 2296-A/B/C/D). Even restricting to the two conditions that come
closest to matching real production shape — C (short+score) and D
(full+score) — the hit rate is 1 partial hit out of 4 attempts.

## What this does and does not prove

**Proves:** Neither of Task 4A's two design deviations from production
— missing score image, whole-piece-length clips — is, on its own or
together, sufficient to explain away the earlier negative result.
Shortening the clip measurably reduces the severity of the
duration-scaled template degeneration (no circle-of-fifths-grade
failures in any short-clip response), but does not fix detection
reliability — 2296's deleted note was missed in every single condition
tested, short or full, scored or unscored. Adding a score image to a
short clip changed the specific words used (B explicit "squeak", C
explicit "wrong note") without clearly improving accuracy (C's stated
pitch was wrong where B's was right). Adding a score image to a
full-length clip made no measurable difference at all — same issue
count, same rate, as the no-score Task 4A result for the identical
piece, and the same mechanically-generated, musically-impossible note
spellings.

**Does not prove:** that no clip length or framing could ever work —
only the specific combinations tested here were evaluated, and only 2
real injected mistakes across 3 pieces. A systematically different
approach (e.g., per-flag targeted re-verification, or a fundamentally
different prompt/schema) was explicitly out of scope for this
experiment and untested.

## Recommendation

**Stop pursuing Gemini as the primary mistake detector in this
configuration, and evaluate specialized score-conditioned alternatives
instead.**

This is the best-supported of the three options:

- **Continue testing under production-faithful conditions** is not
  supported — the most production-faithful condition tested (full
  recording + real score image) is the *worst* one: 0 of 2 real
  mistakes detected, and the clearest, most mechanical evidence yet of
  non-grounded template generation (the circle-of-fifths pitch names).
- **Restrict Gemini to supporting analysis rather than primary
  detection** is the more defensible middle path if any further
  investment happens at all, but the evidence doesn't show Gemini
  reliably adding signal even as a support role — across every
  condition and both real injected mistakes, the hit rate tops out at 1
  partial hit out of 4 near-production-shape attempts, and the one
  short-clip "hit" required generous reading (an artifact described as
  a "squeak" rather than a stated wrong note).
- **Stop and evaluate specialized alternatives** best fits what's been
  measured across Tasks 1-4B: Track B's Task 3 already found CREPE/DTW's
  own "detection" metric fires regardless of content (100% false-positive
  rate on control audio); Task 4A and 4B both now show
  `evaluate_with_gemini`'s flag-authoring degrades into fixed-interval,
  duration-scaled templates under realistic clip lengths, independent of
  whether a score image is present. Two independently-tested components
  of the same pipeline show the same "fires on a clock, not on content"
  failure signature. That's a stronger case for re-architecting the
  mistake-detection step than for continuing to tune or re-test the
  current one.

Per the owner's explicit instruction, no further development phase or
architecture redesign is proposed here — this concludes Task 4B.

## Files

- `modal_worker/run_task4b_gemini_pilot.py` — the pilot runner (env-var key, budget-gated, real-cost-tracked)
- `modal_worker/task4b_pilot_results.json` — full real results, all 9 calls
- `modal_worker/run_task4a_gemini_pilot.py` — fixed to read key from env var (no more hardcoded key)
