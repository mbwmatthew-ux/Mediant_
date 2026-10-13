# DTW Provenance-Based Event Collapse Design

## Problem

See `docs/superpowers/specs/2026-10-12-dtw-sustained-note-collapse-design.md`
for the original problem statement (score-alignment is catastrophically
wrong — 0-3% correct — on slow/sustained real pieces, because
`run_pitch_tracking` over-samples sustained notes and `dtw_align_to_score`'s
pure-pitch DTW has no way to recover once the audio-to-score event ratio
drifts from 1:1).

That spec's "Approach A" (cluster same-pitch events using `sound_end`
continuity) was implemented, committed, and validated against the real
MusicNet corpus per its own Testing Strategy — and failed its own
non-regression bar badly. Full writeup, including the exact failure
mechanism, in the Obsidian vault's "Sessions/2026-10-12 — DTW
sustained-note-collapse attempt, reverted.md" and the Gotchas entry "A
continuity signal built for one purpose silently fails when reused for
another." Short version: `sound_end`'s ±1-semitone, interruption-tolerant
continuity check was built and validated for "how long did this note's
sound keep going" (tolerating vibrato on purpose) — reused as a proxy for
"is this a new articulation," it also rides across real half-step melodic
transitions (E-F, B-C, any neighbor-tone ornament) just as readily as it
rides through vibrato on one note. Confirmed directly: a real 5-note
ornament on MusicNet piece 2202 (`A5,G#5,G#5,A5,A5`) got merged into one
false cluster, and the fast/scale-heavy pieces that were already working
took the worst damage (one piece dropped from 67.8% to 0% correct).
Reverted as commits `1e84878`/`d7dd909`.

## Goal

Replace the discriminating signal. Instead of asking "did the sound
physically continue" (a question `sound_end` answers but that doesn't
reliably mean "no new note"), ask "did `run_pitch_tracking` believe this
event was a new detected attack, or was it a deliberately inserted dense
sample of an already-ongoing voiced region?" — a question the code
already answers internally while building `candidate_times`, and
currently throws away before returning events.

## Non-Goals

- **Not a fix for the remaining residual failure mode**, confirmed via a
  throwaway spike (not committed) before this spec was written: in
  sustained low-register legato passages, CREPE's voicing sometimes never
  dips between two genuinely different real notes, so
  `librosa.onset.onset_detect` never fires a transient between them — both
  real notes end up inside ONE voiced segment, and no provenance tag can
  separate them because the ambiguity exists before tagging happens. This
  showed up concretely on MusicNet piece 2297 (still 0% correct with this
  approach) and kept 4 of the 9 originally-catastrophic pieces only
  marginally improved. Fixing it would need a second, more sensitive onset
  pass specifically for sustained/low passages — a separate piece of work,
  tracked as a follow-up, not attempted here. This spec's acceptance bar
  (below) is scoped around what WAS validated, not around solving every
  piece.
- **Not a change to `dtw_align_to_score`'s signature, return shape, or any
  caller.** Same zero-interface-change posture as the reverted attempt.
- **Not a feature flag.** Same fail-open posture as every other design
  in this file: a missing `from_probe` field (an old cached event, a test
  fixture that predates this feature) defaults to "never collapse,"
  which is exactly today's current behavior for that event.

## Approach

### 1. Tag event provenance in `run_pitch_tracking` (worker.py:714)

`candidate_times` (worker.py:800-837) is built by merging three sources,
then deduplicating:

```python
candidate_times: list[float] = list(onset_times)
if guide_times:
    candidate_times.extend(guide_times)
    for i in range(len(guide_times) - 1):
        gap = guide_times[i + 1] - guide_times[i]
        if gap >= 0.45:
            candidate_times.append((guide_times[i] + guide_times[i + 1]) / 2)
...
for seg_start, seg_end in voiced_segments:
    if not any((seg_start - 0.03) <= t <= (seg_end + 0.03) for t in candidate_times):
        candidate_times.append(seg_start)
    probe = seg_start + 0.35
    while probe < seg_end - 0.10:
        candidate_times.append(probe)
        probe += 0.35

candidate_times = _dedupe_times(
    [t for t in candidate_times if 0 <= t <= max(duration, frame_times[-1] if len(frame_times) else 0)],
    min_separation=0.05,
)
```

Only the `probe` loop's values (the `while probe < seg_end - 0.10:` body)
are the deliberately-inserted dense mid-sustain samples this spec cares
about. Everything else — `onset_times` (real librosa onsets),
`guide_times`, the beat-guide midpoint insertion, and each voiced
segment's own `seg_start` — represents something the code believed was
either a real attack or the first believable moment a new sound began.

Track which candidate times are probe-origin, then tag it through the
dedup step and onto each built event:

```python
probe_times: list[float] = []   # NEW — collects only the probe-loop values
for seg_start, seg_end in voiced_segments:
    if not any((seg_start - 0.03) <= t <= (seg_end + 0.03) for t in candidate_times):
        candidate_times.append(seg_start)
    probe = seg_start + 0.35
    while probe < seg_end - 0.10:
        candidate_times.append(probe)
        probe_times.append(probe)              # NEW
        probe += 0.35

candidate_times = _dedupe_times(
    [t for t in candidate_times if 0 <= t <= max(duration, frame_times[-1] if len(frame_times) else 0)],
    min_separation=0.05,
)
# NEW — per final (post-dedup) candidate time, was its nearest source a
# probe insertion? min_separation (0.05s) is the same tolerance _dedupe_times
# itself already uses to decide two raw times are "the same" candidate, so
# re-using it here keeps this consistent with what already got merged away.
candidate_is_probe = [
    any(abs(t - p) < 0.05 for p in probe_times) for t in candidate_times
]
```

Then, in the events-building loop (`for i, event_t in enumerate(candidate_times):`,
worker.py:848), stamp the corresponding flag onto each emitted event. The
existing `events.append({...})` dict (worker.py:1028) gains exactly one
new key:

```python
events.append({
    "from_probe": candidate_is_probe[i],   # NEW
    "time_sec":    float(event_t),
    "end_sec":     float(next_t),
    "sound_end":   round(sound_end, 3),
    ... # everything else unchanged
})
```

No event is removed, delayed, reordered, or merged by this step — every
existing consumer of `run_pitch_tracking`'s output (intonation evidence
gathering, dynamics, timing) sees exactly the same events it always did,
with one extra key. This is why it doesn't conflict with the previous
spec's non-goal about not touching event generation: that non-goal was
about not *reducing* the event stream, which this doesn't do.

### 2. Gate clustering on provenance in `dtw_align_to_score` (worker.py:1840)

Same insertion point as the reverted attempt (after the `len(score_seq) <
4` guard, before building the audio pitch sequence), but the clustering
rule itself changes. An event only joins the preceding cluster when ALL
THREE hold:

```python
def _cluster_sustained_events(events: list[dict]) -> list[list[dict]]:
    """
    Groups PROBE-ORIGIN events (run_pitch_tracking's deliberately dense,
    0.35s-spaced mid-sustain samples — see that function's `from_probe`
    tag) into the preceding cluster when they're almost certainly a
    repeated sample of the SAME physical sound, so DTW aligns against one
    representative per real sound instead of being misled by how many
    times a sustained note happened to get re-sampled.

    An event joins the current cluster when ALL of:
      - it is probe-origin (`from_probe` is True) — an event
        run_pitch_tracking itself believes was a real detected attack
        (`from_probe` False or absent) NEVER joins anything, regardless
        of pitch or timing. This is the one change from the reverted
        2026-10-12 attempt, which allowed ANY same-pitch, no-release
        pair to merge and consequently merged real, distinct, close-
        interval notes (a 5-note ornament on MusicNet piece 2202,
        `A5,G#5,G#5,A5,A5`, got treated as one sustained note — see
        that design's own writeup for the full failure).
      - its pitch is within 1 semitone of the PREVIOUS event already in
        the cluster (chained, not a fixed anchor — unchanged from the
        prior design, still correct for the same reason: a continuous
        portamento/wide-vibrato sustain can drift gradually by more than
        1 semitone in total while never exceeding 1 semitone step-to-step).
      - its onset falls at or before the cluster's running `sound_end` —
        run_pitch_tracking's own release-walk never detected the sound
        actually stopping before this next sample started. Retained as a
        secondary, NECESSARY-but-not-SUFFICIENT condition alongside
        provenance — provenance alone, without this, would also collapse
        a probe sample that lands on a genuinely different note the
        onset detector happened to miss (the residual failure mode this
        spec's Non-Goals section documents as out of scope; requiring
        BOTH conditions keeps that failure mode from getting WORSE, even
        though it doesn't fix it).

    `from_probe`/`midi_raw`/`sound_end` are read defensively, not
    required — see the Global Constraints section. A missing
    `from_probe` defaults to False (never collapse), matching this
    file's existing fail-open posture: unknown provenance should never
    cause MORE collapsing than justified.

    Input must be pre-sorted by time_sec. Returns a list of clusters in
    the same order, each a non-empty list of events in time order.
    """
    def _midi(ev):
        if "midi_raw" in ev:
            return ev["midi_raw"]
        pitches = ev.get("pitches") or []
        return midi_from_name(pitches[0]) if pitches else None

    def _sound_end(ev):
        return ev.get("sound_end", ev["time_sec"])

    if not events:
        return []
    clusters: list[list[dict]] = [[events[0]]]
    cluster_sound_end = _sound_end(events[0])
    for ev in events[1:]:
        prev_midi = _midi(clusters[-1][-1])
        this_midi = _midi(ev)
        is_probe = ev.get("from_probe", False)
        same_pitch = (prev_midi is not None and this_midi is not None
                      and abs(this_midi - prev_midi) <= 1)
        no_release_yet = ev["time_sec"] <= cluster_sound_end
        if is_probe and same_pitch and no_release_yet:
            clusters[-1].append(ev)
            cluster_sound_end = max(cluster_sound_end, _sound_end(ev))
        else:
            clusters.append([ev])
            cluster_sound_end = _sound_end(ev)
    return clusters
```

The rest of `dtw_align_to_score`'s changes (substituting `representatives
= [c[0] for c in clusters]` for `events` when building `audio_midis`/`n`,
and expanding each cluster's DTW match back onto every original event in
the final result-building loop) are **identical** to the reverted
design's Task 2 — only the clustering function's body changes, not how
it's wired in. See that spec's "Changes inside `dtw_align_to_score`"
section for the exact surrounding diff, which still applies verbatim.

### Validated, not assumed

Unlike the reverted attempt — where every unit test passed because the
tests were written by the same reasoning that produced the (flawed)
mechanism — this design was checked against the real MusicNet corpus
BEFORE being written up, via a throwaway spike module
(`/tmp/spike_worker_provenance.py`, never committed, reproduced
`run_pitch_tracking`'s internals with provenance instrumentation added).
Full 20-piece corpus results:

| Bucket | Result |
|---|---|
| 8 previously-good pieces (2202, 2203, 2218, 2219, 2244, 2289, 2294, 2295) | All within 5 points of baseline; most within ~1 point. Non-regression bar met. |
| 9 previously-catastrophic pieces | 2221 (0.8%→87.4%), 2222 (0.1%→32.4%), 2242 (1.5%→11.5%), 2288 (2.3%→95.8%), 2293 (1.9%→82.0%) clearly improved. 2204, 2220, 2241, 2296 barely moved (the residual onset-detection gap documented in Non-Goals). |
| Outside either bucket | 2186 regressed (57.8%→15.7%); 2297 collapsed (67.8%→0%) — both traced to the same residual onset-detection gap, not a new problem this design introduces. |

## Error Handling

Identical to the reverted design: empty `events`/`measures`, <4 pitched
score notes, and a single-event take all degrade to exactly today's
behavior. Nothing here changes those paths.

## Testing Strategy

1. **Unit tests for the revised `_cluster_sustained_events`**
   (`modal_worker/test_analysis.py`), reusing the prior design's test
   cases where the underlying behavior is unchanged (empty input, single
   event, same-pitch-plus-release → two clusters, pitch-differs-by-2+ →
   two clusters, the chained-drift case), PLUS new cases specifically for
   the provenance gate:
   - Two events, same pitch, no release, but the SECOND is NOT probe
     origin (`from_probe: False`) → two clusters (the exact case that
     broke the reverted design — a real ornament/re-articulation must
     never merge).
   - Two events, same pitch, no release, SECOND is probe origin
     (`from_probe: True`) → one cluster (the case that should still
     collapse — genuine vibrato/dynamic-swell resampling).
   - An event with no `from_probe` key at all → treated as not probe,
     never merges (defensive default, matches real ad-hoc test fixtures
     elsewhere in the file that predate this feature).

2. **Regression test for `dtw_align_to_score`'s revised behavior**: adapt
   the prior design's empirically-tuned scenario (tripling a contiguous
   run of 10 real notes) but mark the spurious copies `from_probe: True`
   and the ORIGINAL note `from_probe: False` — assert they still collapse
   onto the correct measure. ADD a second scenario proving the fix for
   the actual regression: a short run of 3-4 DIFFERENT adjacent-semitone
   pitches, all marked `from_probe: False` (simulating a real ornament),
   asserting NONE of them collapse into each other even though they're
   close in time and within the ±1 semitone tolerance. Verified red/green
   via `git stash`, same convention as before.

3. **Full-suite regression**: `python modal_worker/test_analysis.py`
   must stay green.

4. **Real-corpus regression via MusicNet, run BEFORE committing the
   `dtw_align_to_score` wiring this time** (the order that was skipped
   last time): re-run `validate_alignment_against_musicnet.py` against
   the full 20-piece corpus. Acceptance bar:
   - None of the 8 previously-good pieces may regress by more than 5
     percentage points from their original (pre-either-attempt) baseline.
   - At least 5 of the 9 previously-catastrophic pieces must show
     substantial improvement (the spike's own results — 5 pieces moving
     30-93 points — are the expectation to confirm, not just "some
     improvement").
   - 2186, 2296, 2297, and any other piece affected by the documented
     residual onset-detection gap are explicitly NOT required to improve
     — record their numbers for the follow-up work, don't block on them.

## Global Constraints

- No feature flag (fails open by construction).
- Zero signature/interface changes to `dtw_align_to_score` or
  `run_pitch_tracking` — the one new field (`from_probe`) is additive,
  not a breaking change to the event dict shape.
- `_cluster_sustained_events` reads `time_sec`, `sound_end`, `midi_raw`,
  and now `from_probe` defensively — a missing field never crashes and
  never causes MORE collapsing than the safe default (no collapsing).
- The semitone tolerance for same-pitch clustering remains exactly 1
  (`abs(diff) <= 1`), unchanged from the reverted design.
- Clustering still compares each candidate against the PREVIOUS event
  already in the cluster (chained), never a fixed first-event anchor —
  unchanged, still correct for the same reason as before.
- The real-corpus validation (Testing Strategy item 4) must run and pass
  its acceptance bar BEFORE the `dtw_align_to_score` wiring commit is
  made — not as a final checkbox after unit tests pass and code is
  already committed, which is what went wrong last time.
