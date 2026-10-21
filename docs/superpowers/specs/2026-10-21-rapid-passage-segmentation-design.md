# Rapid-Passage Note Segmentation — Design Spec

## Problem

`run_pitch_tracking` (`modal_worker/worker.py`) still under-counts real
notes in fast, rapidly-alternating passages ("bariolage" — rapid
string-crossing figuration, common in Bach solo string writing). Diagnosed
this session (2026-10-21) on real MusicNet audio, piece 2186 (Bach Violin
Partita No. 3, Preludio): still ~16% under-counting even after today's
legato-step fix (commit `82d0409`). Root cause, confirmed directly against
raw CREPE output at `t=118.9–119.6s`: CREPE's confidence stays high
throughout (0.6–0.9, not a confidence dropout), but individual real notes
last only 1–2 frames (40–80ms) at the 40ms CREPE hop — shorter than
`_PITCH_JUMP_SUSTAIN_FRAMES = 3` (120ms), the minimum "real note" duration
assumption every existing detector relies on (both the real-leap check at
2.5 semitones and today's new legato check at 1.0 semitones). Neither
`librosa.onset.onset_detect` nor either jump detector can see a note this
fast.

Three cheap frame-level heuristics were spiked directly against real audio
before this spec was written, and all three failed for reasons recorded in
`agent_workspace/AGENT_TASKS.md` and the Obsidian session note
`Sessions/2026-10-21 — legato pitch-step detection, shipped with a known
regression.md`:

1. **Non-revert within 2 frames** (does the new value snap back to the old
   one soon after) — fired correctly on real bariolage notes, but also
   fired on the *recovery* from an octave-error glitch elsewhere (piece
   2242), since a transition FROM a glitch value also "doesn't revert."
2. **Require a 2-frame-stable "before"** (reject if the pre-jump value was
   itself a lone blip) — fixed the recovery case, but still produced 558
   fires across all of piece 2242 (a piece that should have close to zero
   real hidden notes of this kind), from octave errors that persist 2+
   frames before correcting.
3. **Confidence floor on the new value** — real glitches often do show
   lower confidence than real transitions (0.2–0.43 vs 0.65–0.9 in the
   examples checked), but real bariolage notes sometimes measure at
   similarly low confidence too (one real note measured conf=0.356),
   because both are inherently 1-frame-undersampled measurements.

Worse than ordinary noise: tracing one specific false fire (piece 2242,
`t≈7.36s`) found CREPE reading `79.3→91.1→72.3` over 3 frames (all
low-confidence, 0.2–0.43) while genuinely attacking a new, correct note
that only settles at `62.2` three frames later (confidence 0.6–0.87, holds
4+ frames). A frame-pairwise heuristic fired on this and would report the
WRONG pitch at the WRONG time — not just a false positive, an actively
incorrect note. This is exactly what the existing `_PITCH_JUMP_MEDIAN_FRAMES`
3-frame median exists to ride out, and real bariolage notes are sometimes
shorter than that transient itself.

**Conclusion driving this spec:** the question "is this frame a real note
or noise" cannot be answered by comparing a frame to its immediate
neighbors — it depends on the whole passage's structure. This spec
replaces pairwise frame comparison with a global segmentation that
considers a whole voiced segment at once.

## Goals

- Detect real note changes in voiced segments where individual notes are
  as short as 1 CREPE frame (40ms), without reintroducing the
  false-positive modes above.
- Stay pure post-processing over the existing "tiny" CREPE model's output
  — no new model, no decoder swap, no added inference cost (this session's
  hard constraint: a CREPE "full" model swap was already rejected for a
  ~17x latency increase against a +1.8pt gain).
- Additive only: this is a new, standalone detector that runs alongside
  the existing `_detect_within_segment_pitch_jumps` (both the 2.5-semitone
  real-leap check and today's 1.0-semitone legato check). It must not
  replace or modify either — those are proven, shipped mechanisms, and
  touching them would reopen regression risk on everything they already
  fixed (2186/2217/2297's earlier gains, 2242/2293's gains).

## Non-goals

- Not attempting to fix 2222's known, accepted regression from today's
  legato fix (separate, already-closed investigation).
- Not attempting DTW drift correction (separately and definitively ruled
  out today, independent of input data quality — see the 2026-10-13
  Obsidian note's 2026-10-21 postscript).
- Not a full HMM/Viterbi decode (Approach B, considered and set aside
  during brainstorming — more hyperparameters than the DP approach below,
  each one a fresh place to repeat this session's threshold-overlap
  failures; only reach for it if the DP's single penalty knob proves
  insufficiently expressive on real data).

## Architecture

A new, standalone function:

```python
def _detect_rapid_passage_notes(
    pitch_np, conf_np, frame_times, voiced_segments: list[tuple[float, float]],
) -> list[float]:
```

Called from `run_pitch_tracking` right after the existing call to
`_detect_within_segment_pitch_jumps` (currently `worker.py:968-974`),
extending `candidate_times` the same way:

```python
candidate_times.extend(
    _detect_rapid_passage_notes(pitch_np, conf_np, frame_times, voiced_segments)
)
```

Not tagged `from_probe` (same reasoning as the existing jump detectors):
these are believed-real attacks, never collapsed by
`_cluster_sustained_events`. Overlap with candidates the existing
detectors already found is handled by `_dedupe_times`'s existing 0.05s
tolerance — no new dedup logic needed.

For each voiced segment, independently:

1. Build a per-frame MIDI array from `pitch_np` over that segment's frame
   range (same Hz→MIDI conversion already used elsewhere:
   `69 + 12*log2(hz/440.0)`).
2. Run the DP segmentation (below) to get a list of
   `(start_idx, end_idx, representative_pitch)` segments covering every
   frame in the voiced segment, using `conf_np` as per-frame weights.
3. Walk consecutive segments. Emit a candidate time
   (`frame_times[segment.start_idx]`) wherever a segment's representative
   pitch differs from the PREVIOUS segment's representative by more than
   `_RAPID_NOISE_FLOOR_SEMITONES = 0.3` (a starting value, not a load-
   bearing threshold — this is now just "did anything real happen at
   all"; the DP segmentation itself already decided the real/noise
   question via `PENALTY`, so this final check only exists to skip two
   adjacent segments that happen to land on the same pitch after all.
   Confirm during implementation that this value doesn't need tuning —
   since the DP already filters noise upstream, two adjacent segments
   landing within 0.3 semitones of each other but NOT merged by the DP
   itself should be rare; if real data shows otherwise, treat it with the
   same calibration discipline as `PENALTY`, not a guess).

## Cost function

For a candidate segment spanning frame indices `[i, j)`:

- **Representative pitch** `R(i,j)`: the confidence-weighted median of
  `midi[i:j]`. Median (not mean) so a single still-noisy frame inside an
  otherwise-good segment doesn't skew the representative value; weighting
  by `conf_np` so higher-confidence frames count more toward the median.
- **Octave-confusion discount**: reuse `_dtw_path`'s existing formula —
  `dist = abs(midi[k] - R)`, then `dist = min(dist, abs(dist - 12) + 3.0)`
  — since CREPE's octave errors are exactly the glitch shape this
  mechanism must absorb rather than split on.
- **Segment cost**: `cost(i,j) = Σ_{k=i}^{j-1} conf_np[k] * dist(midi[k], R(i,j))`.

## Algorithm

Classic penalized changepoint segmentation (same family as PELT), via
dynamic programming:

```
C[0] = 0
C[t] = min over s in [0, t) of ( C[s] + cost(s, t) + PENALTY )   for t = 1..n
```

Backtrack from `C[n]` to recover the breakpoints. `n` here is the number
of frames in ONE voiced segment (typically tens to a few hundred frames,
not the whole piece), so the naive `O(n²)` DP — recomputing `cost(s,t)`
for each candidate `(s,t)` pair — is comfortably fast enough: worst case a
few hundred thousand operations per voiced segment, microseconds to low
milliseconds, negligible next to CREPE's own neural inference cost. No
need for PELT's pruning optimizations at this scale.

### `PENALTY` calibration (the one hyperparameter)

Worked out analytically during brainstorming, to be CONFIRMED against real
data before locking in a value (per this session's standing rule: never
ship a threshold from arithmetic alone):

- **Absorbing a single-frame glitch** (magnitude `D` semitones, flanked by
  long stable runs on both sides): merging the glitch into one continuous
  segment costs `≈ D + PENALTY` (one segment, the glitch frame's distance
  from the unaffected median); splitting it into its own segment costs
  `≈ 3·PENALTY` (three segments: stable-before, glitch-alone,
  stable-after). Absorption wins (what we want) whenever
  `PENALTY > D / 2`. Real glitch magnitudes observed this session: 5–12
  semitones → `PENALTY` should be above roughly **2.5–6**.
- **Splitting real bariolage notes** (several distinct pitches, each
  several semitones from its neighbors, each lasting 1–2 frames): forcing
  `k` of them into one segment costs roughly the sum of each frame's
  distance from the group's overall median (large — real examples this
  session show swings of several semitones per step); splitting into `k`
  segments costs `≈ k·PENALTY`. Splitting wins (what we want) whenever
  `PENALTY` is below that total cost divided by `k` — real examples this
  session suggest a ceiling around **7–8**.

These two constraints leave a real, non-empty window — a structurally
different situation from every magnitude-only threshold tried earlier
this session, because `PENALTY` interacts with frame count and transition
count, not pitch magnitude alone.

**Measured against real data (2026-10-21, before implementation):** swept
`PENALTY` from 0.5 to 8.0 against piece 2242's known glitch region
(`t=0.2–1.8s`), its known attack-transient region (`t=7.1–7.6s`), and
piece 2186's known bariolage region (`t=118.0–120.2s`). Found a sharp
safety cliff between `1.0` (both 2242 regions break — the glitch region
splits off the 86.0 octave-error blips as their own segments, and the
transient region fires separately on both 91.0 and 72.3) and `1.5` (both
become clean — 1 segment for the glitch region, exactly 2 clean segments
for the transient region, landing at R=62.3, matching the real settled
note 62.2). Bariolage coverage does NOT drop going from `1.0` to `1.5`
(15 segments either way) — so there's no coverage cost to clearing the
cliff with margin.

A synthetic unit test (a clean ±0.6-semitone square-wave vibrato — the
same depth already used as a realistic vibrato case elsewhere in this
file) then caught a gap the real-audio sweep missed: `PENALTY = 2.0`
(and `2.5`) still split this clean oscillation. Raised to **`PENALTY =
3.0`** — clean on the vibrato unit test, with no coverage loss on the
real bariolage region versus `2.5` (still 12 segments), and still clean
on both 2242 regions. Final value notably different from the ~6–7
suggested by the arithmetic estimate — real measurement (both real-audio
regions AND a synthetic adversarial case the real audio sample didn't
happen to contain) is the authority here, not the estimate.

## Error handling / edge cases

- A voiced segment shorter than ~3 frames: run the DP anyway (it degrades
  gracefully — with `n ≤ 2` there's at most one possible split), but in
  practice segments this short rarely contain more than one real note.
- All-`NaN` or zero-confidence frames inside a segment: shouldn't occur by
  construction (`voiced_segments` are built by thresholding
  `conf_np >= 0.30` frame-by-frame, so every frame inside one already
  qualifies — same guarantee the existing jump detectors rely on).
- Degenerate segment weights (confidence sums to ~0 inside a candidate
  sub-segment): guard the weighted-median computation against
  divide-by-zero; fall back to an unweighted median for that one
  candidate cost evaluation.

## Testing

Unit tests in `modal_worker/test_analysis.py`, mirroring the existing
jump-detector suite's shape and using the same `_synthetic_pitch_track`
helper:

1. A real sustained change (one note holds, then a different note holds)
   — must produce exactly one candidate at the transition.
2. A single-frame octave glitch surrounded by consistent values on both
   sides — must produce zero candidates (the critical case the earlier
   frame-level heuristics failed).
3. Vibrato (oscillating, not holding a new level) — must produce zero
   candidates.
4. **A fast bariolage-shaped run**: several distinct pitches, each held
   only 1–2 frames, each several semitones from its neighbors — must
   split into multiple candidates, roughly one per real note.
5. **An attack-transient misread**: 2–3 frames of unstable, low-confidence
   readings while genuinely moving toward a new note that then holds —
   must NOT fire on the unstable transient frames; at most one candidate,
   landing at (or near) where the new note actually settles. This is the
   specific case that proved a frame-pairwise heuristic can report an
   actively wrong pitch, not just noise — the regression test earlier
   heuristics would have failed.

## Validation strategy

Same discipline as every other change this session:

1. Unit suite must pass in full (694/694 baseline + new checks), zero
   regressions.
2. `PENALTY` calibration against the specific real 2186/2242 examples
   (above) before any corpus run.
3. Full 20-piece real MusicNet corpus validation
   (`validate_alignment_against_musicnet.py`) before any commit — primary
   target piece 2186, watching the whole corpus (especially 2242, 2293,
   2217, 2297 — pieces already shown to contain real octave-glitch
   material or already-fragile gains) for new regressions.
4. **Acceptance bar** (confirmed with the user during brainstorming): ship
   if full-corpus overall accuracy improves, even with a small individual
   per-piece regression — the same standard already applied to the
   shipped jump-detector's 2220 regression and today's legato fix's 2222
   regression.
5. Timing check: confirm no measurable latency change on the full corpus
   (this is pure post-processing over already-computed `pitch_np`/`conf_np`,
   same complexity class as the existing jump detectors, so expected
   negligible — verify, don't assume).

## Open questions for implementation

None outstanding — `PENALTY`'s calibration is explicitly a to-be-measured
step within implementation (see "Validation strategy" item 2), not a gap
in this spec.
