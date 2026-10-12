# DTW Sustained-Note Collapse Design

## Problem

`dtw_align_to_score` (`modal_worker/worker.py:1840`) maps each detected
audio event to the score measure it belongs to, using pure-pitch-sequence
DTW: it builds one audio pitch sequence from every event
`run_pitch_tracking` returns, one score pitch sequence from
`flatten_score_notes`, and finds the minimum-cost warping path between
them. It had zero prior validation against real, externally-labeled
performances.

A validation harness built against MusicNet (real Bach solo violin/cello/
flute recordings, note-aligned ground truth — see the Obsidian vault's
"2026-10-11 (2) — MusicNet score-alignment validation" session note)
found this is reliable on some real pieces and catastrophically wrong on
others, split cleanly in two:

- 8 of 20 scored pieces: 83-95% of notes assigned the correct measure.
- 9 of 20 scored pieces: 0-3% correct, with 54-98% landing on a measure
  more than one off ("wrong", not "off_by_one").

The split correlates exactly with one measurable number: the ratio of
`run_pitch_tracking`'s detected-event count to the score's true pitched-
note count. Every piece at ratio ≥1.37 is a catastrophic failure; every
piece in the 0.76-1.31 range scores 46-95%. All nine ≥1.37 pieces are
slow, sustained movements (Sarabande, Adagio, Fuga) — the common
mechanism is `run_pitch_tracking`'s onset detector firing multiple
spurious extra events within a single sustained note (vibrato, bow
noise, dynamic swells all perturb CREPE's frame-by-frame reading enough
to register as separate candidate windows). Confirmed in isolation on
piece 2186 (E major Partita Preludio): the DTW path gets stuck matching a
long run of spurious same-pitch events to one real score note, then has
to make a large, wrong jump later to "catch back up" — it has no way to
recover once the audio-to-score event ratio drifts from 1:1, because its
cost function is pitch-only.

This matters beyond Loop windows: `events_by_measure` (worker.py:8109),
the per-measure intonation/timing evidence gatherer that produces real
coaching lines like "E4 shows wildly inconsistent tuning, -48¢ to -28¢",
buckets events on exactly the `measure` field `dtw_align_to_score`
assigns. A wrong measure assignment doesn't just mis-place the Loop
button — it attributes intonation/timing feedback to the wrong measure
in the lesson itself. A spot-check of real production data (219 takes)
confirmed sustained/legato passages are common in the actual (mostly
pop/film, not classical) catalog users submit — this is not a
Bach-specific edge case.

## Goal

Make `dtw_align_to_score` robust to the specific failure mode measured
above — audio event count inflated by spurious re-sampling of one
sustained note — without changing anything else: no new parameters for
callers, no change to what `run_pitch_tracking` emits, no change to the
shape or length of `dtw_align_to_score`'s return value.

## Non-Goals

- **Not a fix for pattern-confusion failures.** The piece 2186
  bariolage passage (pitch-degenerate — many different score notes
  share a pitch, so pitch-only cost can't tell occurrences apart) is a
  distinct failure mode from event-count inflation and is explicitly
  out of scope. That's "Approach B" (duration-aware DTW cost) from the
  brainstorming session, deliberately not built here.
- **Not a change to `run_pitch_tracking`'s event generation.** The
  dense multi-event sampling of sustained notes that causes this
  problem is also the signal `events_by_measure` relies on to detect
  pitch instability within one note (confirmed by reading that code
  path directly). Coalescing events at the source would silently
  break that feature. The fix lives entirely inside the alignment
  step, downstream of event generation.
- **Not a change to `flatten_score_notes` or the score sequence.** The
  measured problem is audio over-representing the score, never the
  reverse; the score side of the DTW is untouched.
- **Not a feature flag.** Same fail-open posture as the Audiveris
  cross-validation design: every edge case (empty cluster, single-event
  "cluster", a piece with no sustained notes at all) degrades to
  exactly today's behavior for that event, so there is nothing to kill-
  switch. A real problem in production is a normal redeploy.

## Approach

### The clustering signal

Each event `run_pitch_tracking` emits already carries `sound_end` — the
timestamp its own release-walk logic (worker.py:936-987) determined the
physical sound actually stopped, tolerant of brief CREPE confidence dips
(vibrato, a slur, a bow change) but strict about a real release. This is
a far better "is this really a new note?" signal than any time-gap
heuristic: if event *i+1*'s onset falls at or before event *i*'s
`sound_end`, CREPE itself never detected a break in the sound between
them.

### `_cluster_sustained_events`

New module-level helper in `modal_worker/worker.py`, placed immediately
before `dtw_align_to_score`:

```python
def _cluster_sustained_events(events: list[dict]) -> list[list[dict]]:
    """
    Groups events that are almost certainly repeated samples of ONE
    physical sound (vibrato/bow-noise/dynamic-swell re-triggers within a
    sustained note) rather than separate articulations, so DTW aligns
    against one representative per real sound instead of being misled by
    how many times run_pitch_tracking happened to sample it.

    An event joins the current cluster when BOTH hold:
      - its pitch is within 1 semitone of the PREVIOUS event already in
        the cluster (chained, not compared against the cluster's fixed
        first event) — `midi_raw`, the unclamped value already used for
        wrong-note comparison elsewhere in this file;
      - its onset falls at or before the cluster's running `sound_end` —
        i.e. run_pitch_tracking's own release-walk never detected the
        sound actually stopping before this next sample started.

    Chaining against the previous event, not a fixed anchor, matters: a
    continuous portamento/wide-vibrato sustain can drift gradually by
    more than 1 semitone in total while never exceeding 1 semitone
    step-to-step and never triggering a detected release. Comparing
    against a fixed first-event anchor would wrongly split that one
    continuous sound into several clusters partway through the drift;
    chaining keeps it together, which is correct — `sound_end`
    continuity, not a pitch ceiling, is what actually defines "one
    physical sound" here.

    Otherwise it starts a new cluster. A genuinely re-articulated note
    of the same pitch (a real tongued repeat, not a vibrato artifact)
    can also satisfy both conditions, since the release-walk's own
    tolerance for brief interruptions ("a slur or tongued repeat" per
    its docstring) is deliberately generous — this is an accepted,
    scoped trade-off: when that happens, every event in the cluster
    still gets stamped with the single measure DTW assigns the cluster,
    which is the correct measure for all of them regardless (they are,
    by definition, at the same pitch in close succession, so a
    DTW match to any one of them is a match for all of them for
    measure-level purposes — the only information lost is positional
    resolution WITHIN that one measure, which this fix does not claim
    to improve).

    Input must be pre-sorted by time_sec (dtw_align_to_score already
    receives/produces events in that order). Returns a list of clusters
    in the same order, each a non-empty list of events in time order.
    """
    if not events:
        return []
    clusters: list[list[dict]] = [[events[0]]]
    cluster_sound_end = events[0]["sound_end"]
    for ev in events[1:]:
        prev_midi = clusters[-1][-1]["midi_raw"]
        same_pitch = abs(ev["midi_raw"] - prev_midi) <= 1
        no_release_yet = ev["time_sec"] <= cluster_sound_end
        if same_pitch and no_release_yet:
            clusters[-1].append(ev)
            cluster_sound_end = max(cluster_sound_end, ev["sound_end"])
        else:
            clusters.append([ev])
            cluster_sound_end = ev["sound_end"]
    return clusters
```

### Changes inside `dtw_align_to_score`

The function's signature, docstring contract, and return shape are
unchanged (same list length and field set as today — every input event
still appears exactly once in the output, now carrying the right
`measure`/`score_*` fields). Internally:

1. After the existing `if not measures or not events: return events`
   guard AND the existing `if len(score_seq) < 4: ... return []` guard
   (no point clustering on a take about to decline anyway), compute
   `clusters = _cluster_sustained_events(events)` and
   `representatives = [c[0] for c in clusters]`.
2. Replace every use of `events` in the pitch-sequence/cost-matrix/DTW-
   traceback construction with `representatives` — `n = len(representatives)`,
   `audio_midis` built from `representatives`, the cost matrix, the
   Sakoe-Chiba band, and the traceback all operate on this shorter
   sequence exactly as they operate on `events` today. Nothing about the
   DTW algorithm itself changes — only what sequence it runs on.
3. Replace the final result-building loop. Today it does
   `for idx, ev in enumerate(events): ... result.append({**ev, "measure": ..., ...})`.
   It becomes:
   ```python
   result = []
   for idx, cluster in enumerate(clusters):
       score_idx = path_audio_to_score[idx]
       sn = score_notes[score_idx]
       match_fields = {
           "measure":         sn["measure"],
           "score_idx":       score_idx,
           "score_beat":      sn["beat"],
           "score_dur_beats": sn["dur_beats"],
           "score_abs_beat":  sn["abs_beat"],
           "score_pitch":     sn["pitch"],
           "score_artic":     sn.get("artic") or "",
       }
       for ev in cluster:
           result.append({**ev, **match_fields})
   ```
   Because `clusters` was built from time-sorted `events` and preserves
   that order both across and within clusters, `result` is already
   time-sorted — no additional sort needed, but the existing
   `measures_hit = len({ev["measure"] for ev in result})` sanity-print
   stays, now computed over the full expanded list.
4. Add one diagnostic line alongside the existing
   `print(f"[dtw_align] {n} audio events → ...")`, reporting the
   collapse: `print(f"[dtw_align] {len(events)} raw events collapsed to
   {len(representatives)} alignment nodes ({len(events) - len(representatives)}
   collapsed)")`. This gives production logs direct visibility into how
   much collapsing happened per take, and gives the MusicNet validator a
   number to report without needing separate instrumentation.

### Why this is non-regressive on the already-working cases

A cluster of exactly one event (the common case for fast, short-note
passages — Allemande, Corrente, Presto) is its own representative, so
`representatives == events` for those passages and the function's
behavior is byte-for-byte identical to today. The fix only changes
behavior where consecutive same-pitch events with no detected release
between them exist at all — which is precisely the measured failure
condition, not a general change to the cost function or the band.

## Data Flow

```
run_pitch_tracking(wav_bytes)
    -> events: list[dict]            (unchanged, full dense sampling)
         |
         v
dtw_align_to_score(events, score, ...)
    -> _cluster_sustained_events(events) -> clusters
    -> representatives = [c[0] for c in clusters]
    -> DTW(representatives, score_notes) -> path_audio_to_score
    -> expand: stamp each cluster's match onto every event in it
    -> result: list[dict]            (same length/shape as `events`)
         |
         v
   (unchanged) events_by_measure, Loop window builder,
   timing/intonation evidence gathering, etc.
```

No caller of `dtw_align_to_score` changes. No caller of
`run_pitch_tracking` changes.

## Error Handling

- Empty `events` or `measures`: unchanged, existing early return still
  fires before clustering runs.
- Score with <4 pitched notes: unchanged, existing check (on
  `score_seq`, unrelated to clustering) still declines and returns `[]`.
- A single-event take: one cluster of one event, identical to today.
- All failure modes degrade to exactly today's output for the affected
  event(s) — consistent with this file's existing fail-open posture
  elsewhere (the breath-noise gate, the Audiveris cross-validation
  design).

## Testing Strategy

1. **Unit tests for `_cluster_sustained_events` in isolation**
   (`modal_worker/test_analysis.py`), using small synthetic event dicts
   (only `time_sec`, `sound_end`, `midi_raw` populated — the three
   fields the function reads):
   - Two events, same `midi_raw`, second's `time_sec` ≤ first's
     `sound_end` → one cluster of two.
   - Two events, same `midi_raw`, second's `time_sec` > first's
     `sound_end` (a real release) → two clusters of one each.
   - Two events, `midi_raw` differing by 2+ → two clusters, even if the
     second starts before the first's `sound_end`.
   - Two events, `midi_raw` differing by exactly 1 (the tolerance
     boundary), no release → one cluster (confirms the ≤1 semitone
     tolerance is inclusive).
   - Three events forming a chain (1-2 joins, 2-3 joins) → one cluster
     of three, not two separate pairs.
   - Three events with a gradual drift — midi_raw 60, then 61 (diff 1
     from event 1), then 62 (diff 1 from event 2, but diff 2 from event
     1) — all with no release between any of them → one cluster of
     three. This is the specific case chaining-against-previous exists
     for; comparing against a fixed first-event anchor would wrongly
     split it after the second event.
   - Empty input → `[]`.
   - Single event → one cluster of one.

2. **Regression test for `dtw_align_to_score`'s new behavior**, using a
   synthetic score (reuse the existing small-score fixtures this file's
   DTW tests already build) and a synthetic `events` list simulating 5
   spurious same-pitch samples of one sustained score note (consecutive
   `sound_end`s overlapping) interleaved with a few normal one-event
   notes. Assert all 5 collapsed events receive the identical, correct
   `measure`. Verified red/green: `git stash` the `dtw_align_to_score`
   changes (keep `_cluster_sustained_events` and the test), confirm the
   test fails against the old per-event loop, `git stash pop`, confirm
   it passes.

3. **Full-suite regression**: `python modal_worker/test_analysis.py`
   must stay green (665/665 without the real audio stack, 668/668 with
   it — same counts the breath-noise gate fix landed at).

4. **Real-corpus regression via MusicNet** (not a unit test — a manual
   before/after comparison using the existing
   `modal_worker/validate_alignment_against_musicnet.py`, same role
   TinySOL plays for pitch detection): re-run the full 20-piece corpus
   after the fix. Acceptance bar:
   - Every one of the 9 pieces currently at 0-3% correct must show a
     measurable improvement (the specific achievable number isn't
     fixed in advance — this fix targets event-count inflation, not
     every failure mode in those pieces, so "materially better, not
     necessarily matching the already-good pieces" is the honest bar).
   - None of the 8 pieces currently at 83-95% correct may regress by
     more than 5 percentage points (the non-regression property the
     one-event-cluster case above is designed to guarantee structurally
     — this check is the empirical confirmation of that guarantee, not
     a hope).
   - The new collapse-count diagnostic line should show near-zero
     collapsing on the already-good pieces and substantial collapsing
     on the previously-catastrophic ones, as a direct sanity check that
     the mechanism is doing what this document claims.

## Global Constraints

- No feature flag (fails open by construction — see Non-Goals).
- Zero signature/interface changes to `dtw_align_to_score` or
  `run_pitch_tracking`; every existing caller of either is untouched.
- `_cluster_sustained_events` reads only `time_sec`, `sound_end`, and
  `midi_raw` from each event — it must not assume any other field is
  present, since test fixtures and any future caller should be able to
  construct minimal events for it.
- The semitone tolerance for same-pitch clustering is exactly 1
  (`abs(diff) <= 1`), matching the tolerance already used in this file's
  own release-walk continuity check — not a new, separately-tuned
  number.
