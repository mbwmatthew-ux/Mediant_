# DTW Provenance-Based Event Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `dtw_align_to_score`'s score-alignment accuracy on sustained/legato notes without regressing fast/scale-heavy pieces — the second attempt, after the first (sound_end-continuity alone) was implemented, committed, found via real-corpus validation to badly regress 8 real pieces, and reverted.

**Architecture:** `run_pitch_tracking` tags each event with `from_probe` (was it a deliberately-inserted dense mid-sustain sample, or a believed real attack?) — pure additive metadata, zero behavior change for any existing consumer. `dtw_align_to_score` then only ever collapses a `from_probe=True` event into a preceding cluster, never a believed-real attack, regardless of pitch or timing.

**Tech Stack:** Python, `modal_worker/worker.py` (production), `modal_worker/test_analysis.py` (project's own `check()`-based harness, run via `python3 modal_worker/test_analysis.py`), `modal_worker/validate_alignment_against_musicnet.py` (real-corpus validator, already exists), dataset cached at `/tmp/musicnet_data`, real-audio-stack venv at `/tmp/urmp_venv`.

**Spec:** `docs/superpowers/specs/2026-10-13-dtw-provenance-based-collapse-design.md` (and the reverted-but-still-relevant `docs/superpowers/specs/2026-10-12-dtw-sustained-note-collapse-design.md`, cited directly where this design reuses unchanged portions of it).

## Global Constraints

- No feature flag — every edge case degrades to today's exact behavior.
- Zero signature/interface changes to `dtw_align_to_score` or `run_pitch_tracking`. `from_probe` is additive metadata on the event dict, not a breaking change.
- `_cluster_sustained_events` reads `time_sec`, `sound_end`, `midi_raw`, and `from_probe` defensively — a missing field never crashes and never causes MORE collapsing than the safe default (no collapsing).
- Semitone tolerance for same-pitch clustering is exactly 1 (`abs(diff) <= 1`), chained against the PREVIOUS event in the cluster, never a fixed first-event anchor.
- **The real-corpus MusicNet validation (Task 3, Step 9) must run and pass its acceptance bar on the uncommitted `dtw_align_to_score` wiring change BEFORE that change is committed.** This is the one structural difference from the first attempt's plan, which validated against real data only as a trailing step after the code was already committed — that ordering is exactly what let a regression ship. If the acceptance bar fails, STOP: do not commit, return to the spec/design, do not try a quick parameter tweak in place.

---

### Task 1: Tag event provenance in `run_pitch_tracking`

**Files:**
- Modify: `modal_worker/worker.py` — `run_pitch_tracking` (currently starting at line 714; re-grep `^def run_pitch_tracking` before editing).
- Test: `modal_worker/test_analysis.py` — new test function, registered in `main()`'s tuple.

**Interfaces:**
- Produces: every event `run_pitch_tracking` returns gains one new key, `from_probe: bool`. `True` only for the dense, 0.35s-spaced samples deliberately inserted mid-voiced-segment for intonation coverage; `False` for everything from a real detected onset, a beat-guide time, or a voiced segment's own start. Task 2 and Task 3 consume this field by name.

This task changes NO existing behavior — it only adds a key to a dict every existing consumer already ignores keys it doesn't recognize for. It is safe to commit on its own.

- [ ] **Step 1: Write the failing test**

This needs the real audio stack (CREPE/librosa) to produce real candidate times to tag, so it follows the same pattern as the existing tests `test_run_pitch_tracking_recovers_a_quiet_real_note_the_old_absolute_floor_missed` / `test_run_pitch_tracking_still_rejects_true_silence` (grep for `REAL_AUDIO_STACK_AVAILABLE` to confirm the exact guard pattern those use, and reuse the same `testdata/real_violin_note_tinysol_g3_mf.wav` fixture already embedded in the repo).

Add to `modal_worker/test_analysis.py`, directly after `test_run_pitch_tracking_still_rejects_true_silence` (grep to confirm it's still the last test function in the file — it should be, since the revert removed everything added after it):

```python
def test_run_pitch_tracking_tags_event_provenance():
    print("\n[181] every event carries from_probe: True for a dense mid-sustain "
          "sample, False for a believed real attack")
    if not REAL_AUDIO_STACK_AVAILABLE:
        print("  SKIP  torch/torchcrepe/librosa/soundfile/scipy not all installed "
              "in this environment")
        return
    wav_path = Path(__file__).parent / "testdata" / "real_violin_note_tinysol_g3_mf.wav"
    events = w.run_pitch_tracking(wav_path.read_bytes(), instrument="Violin")
    check("every event has a from_probe key", events and all("from_probe" in e for e in events),
          f"{len(events)} events")
    check("from_probe is always a bool, never missing or None",
          all(isinstance(e["from_probe"], bool) for e in events))
```

Register it in `main()`: add `test_run_pitch_tracking_tags_event_provenance,` as a new line right before the closing `):` of the big test tuple (currently ending with `test_run_pitch_tracking_still_rejects_true_silence):`).

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A5 "\[181\]"
```

Expected: if the real audio stack is installed, `FAIL` on "every event has a from_probe key" (the key doesn't exist yet). If not installed, `SKIP` — in that case, verify the skip path itself is reachable (it will be, since the guard is copied verbatim from an existing test) and proceed; Step 4 will still need to run successfully in the `/tmp/urmp_venv` environment where the real stack IS installed.

- [ ] **Step 3: Implement the tagging**

In `modal_worker/worker.py`, inside `run_pitch_tracking`, find this exact block (currently lines 826-837):

```python
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

Replace it with:

```python
        probe_times: list[float] = []  # only the deliberately-inserted dense mid-sustain samples
        for seg_start, seg_end in voiced_segments:
            if not any((seg_start - 0.03) <= t <= (seg_end + 0.03) for t in candidate_times):
                candidate_times.append(seg_start)
            probe = seg_start + 0.35
            while probe < seg_end - 0.10:
                candidate_times.append(probe)
                probe_times.append(probe)
                probe += 0.35

        candidate_times = _dedupe_times(
            [t for t in candidate_times if 0 <= t <= max(duration, frame_times[-1] if len(frame_times) else 0)],
            min_separation=0.05,
        )
        # Per final (post-dedup) candidate time, was its nearest source a probe
        # insertion rather than a real onset/guide/voiced-segment-start? Reuses
        # the same 0.05s tolerance _dedupe_times itself already uses to decide
        # two raw times are "the same" candidate.
        candidate_is_probe = [
            any(abs(t - p) < 0.05 for p in probe_times) for t in candidate_times
        ]
```

Then find the `events.append({` block (currently starting at line 1028) and add the new key as the FIRST entry:

```python
            events.append({
                "from_probe":  candidate_is_probe[i],
                "time_sec":    float(event_t),
                "end_sec":     float(next_t),
```

(Everything else in that dict literal is unchanged — only the new `"from_probe"` line is added.)

- [ ] **Step 4: Run the test to verify it passes, in the environment with the real audio stack**

```bash
cd modal_worker && source /tmp/urmp_venv/bin/activate && python3 test_analysis.py 2>&1 | grep -A5 "\[181\]"
```

Expected: both `check()` lines print `PASS`.

- [ ] **Step 5: Run the full suite in both environments**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | tail -4
source /tmp/urmp_venv/bin/activate && python3 test_analysis.py 2>&1 | tail -4
```

Expected: the plain-environment count increases by exactly 2 over baseline (665 + 2 = 667 — this test is a real-stack-only test, so it SKIPs there and still contributes 2 checks that both report via `check()` before the `return`... actually re-read the test: the SKIP path `return`s before any `check()` call, so in the no-real-stack environment this test contributes ZERO checks, not 2 — baseline stays 665). Zero failures either way. (Read the actual printed totals — don't assume a specific number; other work may have changed the baseline since this plan was written.)

- [ ] **Step 6: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): tag each run_pitch_tracking event with from_probe

Pure additive metadata — True for a deliberately-inserted dense
mid-sustain sample, False for a believed real attack (onset, guide
time, or voiced-segment start). No existing behavior changes; nothing
reads this field yet (Task 2/3). See docs/superpowers/specs/2026-10-13-
dtw-provenance-based-collapse-design.md."
```

---

### Task 2: `_cluster_sustained_events`, provenance-gated, standalone and unit-tested

**Files:**
- Modify: `modal_worker/worker.py` — insert new function immediately before `dtw_align_to_score` (re-grep `^def dtw_align_to_score` before inserting; Task 1 did not move it, so it should still be at line 1840, but confirm).
- Test: `modal_worker/test_analysis.py`.

**Interfaces:**
- Consumes: `from_probe` from Task 1's events (defensively — see Global Constraints).
- Produces: `_cluster_sustained_events(events: list[dict]) -> list[list[dict]]`, same signature as the reverted first attempt. Task 3 consumes this directly.

Not wired into `dtw_align_to_score` yet — standalone and inert, like Task 1.

- [ ] **Step 1: Write the failing test**

Add to `modal_worker/test_analysis.py`, after `test_run_pitch_tracking_tags_event_provenance`:

```python
def test_cluster_sustained_events():
    print("\n[182] _cluster_sustained_events only collapses PROBE-origin events, "
          "never a believed-real attack")

    def ev(t, midi, sound_end, from_probe):
        return {"time_sec": t, "midi_raw": midi, "sound_end": sound_end, "from_probe": from_probe}

    # Same pitch, no release, SECOND event is probe-origin -> one cluster.
    # This is the case that SHOULD still collapse (genuine vibrato/dynamic-
    # swell resampling of one sustained note).
    clusters = w._cluster_sustained_events(
        [ev(0.0, 60, 0.30, False), ev(0.20, 60, 0.50, True)])
    check("same pitch + no release + probe origin -> one cluster",
          len(clusters) == 1 and len(clusters[0]) == 2, f"{[len(c) for c in clusters]}")

    # Same pitch, no release, but SECOND event is NOT probe-origin -> two
    # clusters. This is the exact case that broke the reverted first attempt:
    # a believed-real re-articulation must never merge, regardless of pitch
    # or timing.
    clusters = w._cluster_sustained_events(
        [ev(0.0, 60, 0.30, False), ev(0.20, 60, 0.50, False)])
    check("same pitch + no release + NOT probe origin -> two clusters (never merges a real attack)",
          len(clusters) == 2 and all(len(c) == 1 for c in clusters), f"{[len(c) for c in clusters]}")

    # Real release (next onset after sound_end) -> two clusters even if probe.
    clusters = w._cluster_sustained_events(
        [ev(0.0, 60, 0.10, False), ev(0.20, 60, 0.50, True)])
    check("real release -> two clusters even for a probe-origin event",
          len(clusters) == 2, f"{[len(c) for c in clusters]}")

    # Pitch differs by 2+ -> two clusters even if probe and no release.
    clusters = w._cluster_sustained_events(
        [ev(0.0, 60, 0.30, False), ev(0.20, 62, 0.50, True)])
    check("pitch differs by 2+ -> two clusters even for a probe-origin event",
          len(clusters) == 2, f"{[len(c) for c in clusters]}")

    # Pitch differs by exactly 1 (tolerance boundary), no release, probe -> one cluster.
    clusters = w._cluster_sustained_events(
        [ev(0.0, 60, 0.30, False), ev(0.20, 61, 0.50, True)])
    check("pitch differs by exactly 1 + probe origin -> one cluster (boundary inclusive)",
          len(clusters) == 1 and len(clusters[0]) == 2, f"{[len(c) for c in clusters]}")

    # Gradual drift across a continuous sustain, all probe-origin after the
    # first -> stays one cluster (chaining against the previous event, not a
    # fixed anchor, carried over unchanged from the reverted first attempt).
    clusters = w._cluster_sustained_events(
        [ev(0.0, 60, 0.30, False), ev(0.20, 61, 0.50, True), ev(0.40, 62, 0.70, True)])
    check("gradual drift, all probe-origin, stays one cluster",
          len(clusters) == 1 and len(clusters[0]) == 3, f"{[len(c) for c in clusters]}")

    # A real 4-note ornament: different adjacent pitches, ALL believed real
    # attacks (from_probe=False), close in time, no detected release between
    # any of them. This is piece 2202's actual A5,G#5,G#5,A5,A5 case from the
    # MusicNet validation, reduced to the essential shape. None may collapse.
    ornament = [ev(0.0, 69, 0.23, False), ev(0.19, 68, 0.35, False),
                ev(0.27, 68, 0.41, False), ev(0.34, 69, 0.52, False)]
    clusters = w._cluster_sustained_events(ornament)
    check("a real ornament of different adjacent-semitone pitches, all "
          "real attacks, never collapses even once",
          len(clusters) == 4, f"{[len(c) for c in clusters]}")

    # Empty input -> empty output.
    check("empty input -> empty output", w._cluster_sustained_events([]) == [])

    # Single event -> one cluster of one.
    clusters = w._cluster_sustained_events([ev(0.0, 60, 0.30, False)])
    check("single event -> one cluster of one",
          len(clusters) == 1 and len(clusters[0]) == 1, f"{[len(c) for c in clusters]}")

    # Missing from_probe/midi_raw/sound_end entirely (matches real ad-hoc test
    # fixtures elsewhere in this file) must not crash, and must never cluster.
    bare = [{"time_sec": 0.0, "pitches": ["C4"]}, {"time_sec": 0.05, "pitches": ["C4"]}]
    clusters = w._cluster_sustained_events(bare)
    check("events missing from_probe/midi_raw/sound_end never crash and never cluster",
          len(clusters) == 2, f"{[len(c) for c in clusters]}")
```

Register it: add `test_cluster_sustained_events,` right after `test_run_pitch_tracking_tags_event_provenance,` in `main()`'s tuple.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A3 "\[182\]"
```

Expected: `AttributeError: module 'worker' has no attribute '_cluster_sustained_events'`.

- [ ] **Step 3: Write the implementation**

Insert into `modal_worker/worker.py`, immediately before `dtw_align_to_score`:

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
        of pitch or timing. This is the one change from an earlier,
        reverted design, which allowed ANY same-pitch, no-release pair to
        merge and consequently merged real, distinct, close-interval
        notes (a 5-note ornament on a real recording, A5,G#5,G#5,A5,A5,
        got treated as one sustained note).
      - its pitch is within 1 semitone of the PREVIOUS event already in
        the cluster (chained, not a fixed anchor — a continuous
        portamento/wide-vibrato sustain can drift gradually by more than
        1 semitone in total while never exceeding 1 semitone step-to-step
        and never triggering a detected release; comparing against a
        fixed first-event anchor would wrongly split that one continuous
        sound partway through the drift).
      - its onset falls at or before the cluster's running `sound_end` —
        run_pitch_tracking's own release-walk never detected the sound
        actually stopping before this next sample started. Kept as a
        secondary, necessary-but-not-sufficient condition alongside
        provenance: provenance alone would also collapse a probe sample
        that lands on a genuinely different note the onset detector
        happened to miss entirely (a known, separately-tracked residual
        gap — see the design spec's Non-Goals).

    `from_probe`/`midi_raw`/`sound_end` are read defensively, not
    required: a missing `from_probe` defaults to False (never collapse —
    unknown provenance must never cause MORE collapsing than the safe
    default), a missing `midi_raw` derives a pitch from `pitches[0]` via
    `midi_from_name`, and a missing `sound_end` defaults to the event's
    own `time_sec` (so it can never pull a later event into its cluster).
    This keeps every pre-existing event shape in this codebase behaving
    exactly as it did before this function existed.

    Input must be pre-sorted by time_sec (dtw_align_to_score already
    receives/produces events in that order). Returns a list of clusters
    in the same order, each a non-empty list of events in time order.
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

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A13 "\[182\]"
```

Expected: all 10 `check()` lines under `[182]` print `PASS`.

- [ ] **Step 5: Run the full suite**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | tail -4
```

Expected: pass count increases by exactly 10 over the end of Task 1, zero failures.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add provenance-gated _cluster_sustained_events

Not wired into dtw_align_to_score yet (next task, gated on real-corpus
validation before it commits). Only ever collapses a from_probe=True
event into a preceding cluster — a believed-real attack never merges,
regardless of pitch or timing, which is the fix for the regression the
first (reverted) attempt caused. Unit-tested directly against the
actual failing shape from that regression (a 4-note ornament of
different adjacent-semitone pitches).

See docs/superpowers/specs/2026-10-13-dtw-provenance-based-collapse-
design.md."
```

---

### Task 3: Wire into `dtw_align_to_score` — gated on real-corpus validation BEFORE committing

**Files:**
- Modify: `modal_worker/worker.py` — `dtw_align_to_score` (currently starting at line 1840; re-grep before editing).
- Modify: `modal_worker/test_analysis.py` — `make_performance` (line ~123); new regression tests.

**Interfaces:**
- Consumes: `_cluster_sustained_events(events) -> list[list[dict]]` from Task 2.
- Produces: no change to `dtw_align_to_score`'s public signature or return shape.

**This task's steps are NOT all meant to end in a commit.** Steps 1-8 happen on the working tree with nothing staged. Step 9 is the real-corpus validation gate. Only if Step 9 passes its acceptance bar does Step 10 commit. If Step 9 fails, STOP per this plan's Global Constraints — do not commit, do not try a quick parameter tweak in place, go back to the spec/design.

- [ ] **Step 1: Give `make_performance` real `midi_raw`/`sound_end`/`from_probe` values**

In `modal_worker/test_analysis.py`, find `make_performance` (line ~123). Change the `evs.append(...)` call from:

```python
            evs.append({"time_sec": t, "end_sec": t + SEC_PER_BEAT,
                        "pitches": [note["pitch"]], "confidence": 90,
                        "cents_offset": 0, "cents_spread": 8, "loudness": "medium"})
```

to:

```python
            # midi_raw/sound_end/from_probe: real events always carry all
            # three once _cluster_sustained_events reads them. sound_end ==
            # time_sec and from_probe == False here deliberately — this
            # fixture's notes are real, separately-timed notes (never
            # oversampling), so "no measured sustain" and "not a probe
            # sample" are both the honest values, and together they
            # guarantee these events never cluster with each other, which
            # is required for the dozens of existing tests built on this
            # fixture to keep behaving identically.
            evs.append({"time_sec": t, "end_sec": t + SEC_PER_BEAT,
                        "pitches": [note["pitch"]], "midi_raw": w.midi_from_name(note["pitch"]),
                        "sound_end": t, "from_probe": False, "confidence": 90,
                        "cents_offset": 0, "cents_spread": 8, "loudness": "medium"})
```

- [ ] **Step 2: Run the full suite to confirm this alone changes nothing**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | tail -4
```

Expected: identical pass count to the end of Task 2, zero failures.

- [ ] **Step 3: Write the OLD-vs-NEW ornament sanity check (not a permanent test — a one-off verification)**

Before writing the real regression test, confirm by hand that the ornament case from Task 2's `test_cluster_sustained_events` would have FAILED against the reverted first attempt's mechanism — i.e. that this test is doing real work, not trivially passing for an unrelated reason. Run this directly (not saved anywhere):

```bash
cd modal_worker && python3 -c "
import worker as w

def old_cluster(events):
    # The REVERTED first attempt's rule: same pitch + no release collapses,
    # with no provenance gate at all. Reconstructed here only to confirm
    # the new test actually distinguishes the two mechanisms — not part of
    # any file in the repo.
    if not events:
        return []
    clusters = [[events[0]]]
    cluster_sound_end = events[0]['sound_end']
    for ev in events[1:]:
        prev_midi = clusters[-1][-1]['midi_raw']
        same_pitch = abs(ev['midi_raw'] - prev_midi) <= 1
        no_release_yet = ev['time_sec'] <= cluster_sound_end
        if same_pitch and no_release_yet:
            clusters[-1].append(ev)
            cluster_sound_end = max(cluster_sound_end, ev['sound_end'])
        else:
            clusters.append([ev])
            cluster_sound_end = ev['sound_end']
    return clusters

ornament = [
    {'time_sec': 0.0,  'midi_raw': 69, 'sound_end': 0.23},
    {'time_sec': 0.19, 'midi_raw': 68, 'sound_end': 0.35},
    {'time_sec': 0.27, 'midi_raw': 68, 'sound_end': 0.41},
    {'time_sec': 0.34, 'midi_raw': 69, 'sound_end': 0.52},
]
old_result = old_cluster(ornament)
print(f'OLD mechanism on the ornament: {len(old_result)} cluster(s) '
      f'(expect 1 — this is the bug: it WOULD have wrongly merged all 4)')
"
```

Expected output: `OLD mechanism on the ornament: 1 cluster(s)` — confirming the old, reverted mechanism really would have merged this ornament into one cluster, and Task 2's new test (which asserts 4 clusters) is genuinely exercising the fix, not passing by coincidence.

- [ ] **Step 4: Write the failing regression test for the oversampling case**

First, empirically find a magnitude that actually breaks the CURRENT, unmodified `dtw_align_to_score` — do not assume the first attempt's "10 notes × 3 copies" still applies, since that was tuned against a different (now-replaced) clustering function:

```bash
cd modal_worker && python3 -c "
import sys
sys.path.insert(0, '.')
import test_analysis as ta

for k_notes, m_copies in [(5,3),(10,2),(10,3),(10,4),(15,3),(20,3)]:
    score = ta.make_score()
    played, evs = ta.make_performance(score)
    true_notes = [m for m in played for _ in m['notes']]
    oversampled = []
    spurious_truth_idx = []
    for idx, ev in enumerate(evs):
        if idx < k_notes:
            for c in range(m_copies):
                t = ev['time_sec'] + c * 0.05
                # from_probe True for every copy EXCEPT the first (which
                # represents the real attack the oversampling happened on).
                oversampled.append({**ev, 'time_sec': t, 'sound_end': t + 0.08,
                                     'from_probe': c > 0})
                spurious_truth_idx.append(idx)
        else:
            oversampled.append(ev)
    aligned = ta.w.dtw_align_to_score(oversampled, score, ta.START, ta.BEATS_PER_MEASURE, end_measure=ta.END)
    n_spurious = k_notes * m_copies
    wrong = sum(1 for ev, ti in zip(aligned[:n_spurious], spurious_truth_idx)
                if ev['measure'] != true_notes[ti]['number'])
    print(f'k_notes={k_notes:3d} m_copies={m_copies}  wrong among spurious={wrong}/{n_spurious}')
" 2>&1 | grep -v "^\[dtw_align\]"
```

Read the output and pick the SMALLEST `(k_notes, m_copies)` combination that shows a clearly nonzero `wrong` count (not a borderline 1-2 — a robust double-digit-percentage failure, so the test is decisive, not fragile). Use that exact combination in the test below — if it differs from `(10, 3)`, use the actual values found, not the ones in this plan.

Add to `modal_worker/test_analysis.py`, after `test_cluster_sustained_events`:

```python
def test_dtw_align_to_score_collapses_spurious_same_pitch_oversampling():
    print("\n[183] dtw_align_to_score collapses PROBE-origin oversampling "
          "before aligning, instead of being misled by it")
    score = make_score()
    played, evs = make_performance(score)
    true_notes = [m for m in played for _ in m["notes"]]

    # Use the (k_notes, m_copies) combination found empirically in this
    # task's Step 4 to robustly break the OLD per-event loop.
    N_NOTES, N_COPIES = <FILL IN FROM THE EMPIRICAL RUN ABOVE>
    oversampled = []
    spurious_truth_idx = []
    for idx, ev in enumerate(evs):
        if idx < N_NOTES:
            for c in range(N_COPIES):
                t = ev["time_sec"] + c * 0.05
                # from_probe True for every copy except the first — the
                # first IS the real attack; the rest are the spurious
                # mid-sustain re-samples being simulated.
                oversampled.append({**ev, "time_sec": t, "sound_end": t + 0.08,
                                     "from_probe": c > 0})
                spurious_truth_idx.append(idx)
        else:
            oversampled.append(ev)

    aligned = w.dtw_align_to_score(oversampled, score, START, BEATS_PER_MEASURE, end_measure=END)

    check("output has one entry per input event (shape unchanged)",
          len(aligned) == len(oversampled), f"{len(aligned)} vs {len(oversampled)}")

    n_spurious = N_NOTES * N_COPIES
    wrong = sum(1 for ev, truth_idx in zip(aligned[:n_spurious], spurious_truth_idx)
                if ev["measure"] != true_notes[truth_idx]["number"])
    check("every oversampled note's copies land on ITS correct measure, "
          "not scattered by how many times it was sampled",
          wrong == 0, f"{wrong}/{n_spurious} on the wrong measure")

    truth_rest = [m["number"] for m in true_notes[N_NOTES:]]
    got_rest = [e["measure"] for e in aligned[n_spurious:]]
    exact = sum(1 for a, b in zip(got_rest, truth_rest) if a == b)
    check("the rest of the piece still aligns correctly",
          exact == len(truth_rest), f"{exact}/{len(truth_rest)}")
```

Register it: add `test_dtw_align_to_score_collapses_spurious_same_pitch_oversampling,` after `test_cluster_sustained_events,`.

- [ ] **Step 5: Write the failing regression test for the ornament (non-regression) case**

Add directly after it:

This one needs to test the INTEGRATION (the full `dtw_align_to_score`,
not just `_cluster_sustained_events` in isolation — Task 2's test
already covers the clustering function thoroughly, including this exact
ornament shape). Use 4 of the fixture's own REAL, naturally-different
consecutive notes as the ornament, compressed close together in time
with overlapping `sound_end` (simulating "played very fast and legato,
no detected gap between them" — the real-world condition that makes
these look mergeable), so there's genuine ground truth (the fixture's
own true measure numbers) to check the end-to-end result against, not
just "did clustering keep them apart":

```python
def test_dtw_align_to_score_never_collapses_a_real_ornament():
    print("\n[184] dtw_align_to_score never collapses real, different "
          "attacks played close together with no detected release between "
          "them, even though that's the exact shape the old mechanism "
          "mistook for one sustained note")
    score = make_score()
    played, evs = make_performance(score)
    true_notes = [m for m in played for _ in m["notes"]]

    # The fixture's own first 4 notes are already different, real,
    # separately-articulated pitches: G4(67), A4(69), B4(71), C5(72) — a
    # 2/2/1-semitone gap sequence. The LAST pair (B4->C5, index 2->3) is
    # the genuine stress case: exactly 1 semitone apart, which is where
    # the old, reverted mechanism's tolerance actually triggered (the
    # first two pairs, 2 semitones apart, would never have been
    # candidates for merging under either mechanism — they don't
    # discriminate old from new, but they don't hurt either). Compress
    # all 4 into a tight, legato-fast run with each one's sound_end
    # overlapping the next's onset, all from_probe=False (real attacks,
    # not oversampling). This is the reduced shape of the actual MusicNet
    # piece 2202 failure (A5,G#5,G#5,A5,A5) that broke the first, reverted
    # attempt.
    ornament = []
    for i, ev in enumerate(evs[:4]):
        t = i * 0.08
        ornament.append({**ev, "time_sec": t, "sound_end": t + 0.12, "from_probe": False})
    with_ornament = ornament + evs[4:]

    aligned = w.dtw_align_to_score(with_ornament, score, START, BEATS_PER_MEASURE, end_measure=END)

    check("output has one entry per input event (shape unchanged)",
          len(aligned) == len(with_ornament), f"{len(aligned)} vs {len(with_ornament)}")

    exact = sum(1 for ev, truth in zip(aligned[:4], true_notes[:4])
                if ev["measure"] == truth["number"])
    check("each of the 4 close-together real notes keeps its OWN correct "
          "measure, none collapsed into a shared one",
          exact == 4, f"{exact}/4")
```

Register it: add `test_dtw_align_to_score_never_collapses_a_real_ornament,` after `test_dtw_align_to_score_collapses_spurious_same_pitch_oversampling,`.

- [ ] **Step 6: Run both new tests against the current, un-wired `dtw_align_to_score`**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A6 "\[183\]\|\[184\]"
```

Expected: `[183]` FAILs on the "every oversampled note's copies land on ITS correct measure" check (confirming the chosen magnitude from Step 4 really breaks old code — this is the genuine red/green test).

`[184]` is NOT a red/green test in the same sense, and that's expected, not a problem: the repo currently has NO clustering at all (the first attempt was fully reverted), so nothing merges anything today, and 4 distinct real notes each independently get their own correct DTW match even without any clustering logic. Expect `[184]` to already PASS here. Its job is a non-regression safety net for AFTER Step 7's wiring — proving the NEW mechanism doesn't reintroduce the bug that broke the first, reverted attempt (which Step 3's throwaway diagnostic already confirmed WOULD have failed this exact shape). If `[184]` somehow fails here, something is wrong with the test's construction (e.g. the 4 fixture notes aren't actually distinct) — fix the test before proceeding, since it must be measuring something real in both states.

- [ ] **Step 7: Wire `_cluster_sustained_events` into `dtw_align_to_score`**

This wiring is byte-for-byte identical to the reverted first attempt's Task 2 Step 5 (`docs/superpowers/plans/2026-10-12-dtw-sustained-note-collapse.md`, if it still exists on disk — check with `ls`; if not, use the exact diff below, which is self-contained).

In `modal_worker/worker.py`, inside `dtw_align_to_score`, after the existing two early-return guards:

```python
    measures = score.get("measures", [])
    if not measures or not events:
        return events

    score_notes = flatten_score_notes(score, start_measure, end_measure, beats_per_measure)
    score_seq: list[tuple[int, int]] = [(sn["midi"], sn["measure"]) for sn in score_notes]

    if len(score_seq) < 4:
        print(f"[dtw_align] score has <4 pitched notes — declining, caller should fall back")
        return []
```

— insert:

```python
    clusters = _cluster_sustained_events(events)
    representatives = [c[0] for c in clusters]
```

Then find the audio-sequence-building loop:

```python
    audio_midis: list[int | None] = []
    for ev in events:
        pitches = ev.get("pitches", [])
        midi = midi_from_name(pitches[0]) if pitches else None
        audio_midis.append(midi)

    n, m_len = len(audio_midis), len(score_seq)
```

Change `for ev in events:` to `for ev in representatives:` — nothing else in this block changes.

Finally, find the result-building loop:

```python
    result = []
    for idx, ev in enumerate(events):
        score_idx = path_audio_to_score[idx]
        sn = score_notes[score_idx]
        result.append({
            **ev,
            "measure":          sn["measure"],
            "score_idx":        score_idx,
            "score_beat":       sn["beat"],
            "score_dur_beats":  sn["dur_beats"],
            "score_abs_beat":   sn["abs_beat"],
            "score_pitch":      sn["pitch"],
            "score_artic":      sn.get("artic") or "",
        })
```

Replace it with:

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

And find the final diagnostic print:

```python
    measures_hit = len({ev["measure"] for ev in result})
    total_score_measures = len(measures)
    print(f"[dtw_align] {n} audio events → {measures_hit}/{total_score_measures} score measures covered")
    return result
```

Add one line right before the `print(...)`:

```python
    print(f"[dtw_align] {len(events)} raw events collapsed to {len(representatives)} "
          f"alignment nodes ({len(events) - len(representatives)} collapsed)")
```

- [ ] **Step 8: Run both new tests to verify they pass, red/green verify, then run the full suite**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A6 "\[183\]\|\[184\]"
```

Expected: all `check()` lines under both pass.

Red/green verification (confirms the tests actually exercise the wiring, not just the clustering function in isolation):

```bash
git stash push --keep-index -- modal_worker/worker.py
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A6 "\[183\]\|\[184\]"
cd ..
git stash pop
```

Expected: with the wiring stashed back out (Task 1/2's committed code stays, since it's in the index — only this task's uncommitted `worker.py` edit gets stashed), `[183]` fails the same way as Step 6 (this is the one with genuine red/green signal). `[184]` is expected to still pass even with the wiring stashed out, for the same reason noted in Step 6 — it's a non-regression guard, not a discriminating test against this repo's current code. After `git stash pop`, re-run once more and confirm both are green again.

Full suite, both environments:

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | tail -4
source /tmp/urmp_venv/bin/activate && python3 test_analysis.py 2>&1 | tail -4
```

Expected: every pre-existing test still passes, plus the new checks from `[183]`/`[184]`.

**Do NOT commit yet.** Proceed to Step 9 with these changes still uncommitted.

- [ ] **Step 9: GATE — real-corpus MusicNet validation, on the uncommitted change**

```bash
cd modal_worker && source /tmp/urmp_venv/bin/activate && python3 validate_alignment_against_musicnet.py --data-dir /tmp/musicnet_data 2>&1 | tail -30
```

Compare against the two recorded baselines:
- Original (pre-either-attempt): 2202 94.9%, 2203 89.1%, 2204 2.3%, 2217 46.2%, 2218 93.5%, 2219 83.1%, 2220 0.5%, 2221 0.8%, 2222 0.1%, 2241 3.2%, 2242 1.5%, 2244 90.9%, 2288 2.3%, 2289 94.0%, 2293 1.9%, 2294 93.2%, 2295 85.0%, 2296 1.2%, 2297 67.8%, 2186 57.8%.
- The spike's results, which this implementation should reproduce closely (not necessarily exactly, since the spike's instrumentation and this implementation differ in incidental ways, but the same shape of result): 8 previously-good pieces each within ~1-2 points of baseline; 2221/2222/2242/2288/2293 substantially improved; 2204/2220/2241/2296/2186/2297 weak or still regressed (the documented residual gap).

**Acceptance bar (from the spec's Global Constraints — this gates the commit):**
- None of the 8 previously-good pieces (2202, 2203, 2218, 2219, 2244, 2289, 2294, 2295) may regress by more than 5 percentage points from the ORIGINAL baseline above.
- At least 5 of the 9 previously-catastrophic pieces must show substantial improvement over the ORIGINAL baseline (the spike found 5: 2221, 2222, 2242, 2288, 2293 — confirm at least that many here too).

**If the bar is met:** proceed to Step 10.

**If the bar is NOT met:** STOP. Do not commit. Do not attempt a quick parameter tweak in place (that is exactly the failure pattern from the first attempt — a plausible-looking adjustment that passes self-written tests but hasn't been re-validated against real data). Revert the uncommitted changes (`git checkout -- modal_worker/worker.py modal_worker/test_analysis.py`, or stash them for inspection), write up what was found in the Obsidian vault (Sessions + Gotchas, following this project's established convention), and report back for a fresh brainstorming pass.

- [ ] **Step 10: Commit (only after Step 9 passes)**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "fix(worker): make dtw_align_to_score robust to spurious oversampling,
without merging real ornaments (second attempt)

Wires the provenance-gated _cluster_sustained_events in. Unlike the
first, reverted attempt, this was validated against the full MusicNet
corpus BEFORE this commit, not after: non-regression confirmed on all
8 previously-good pieces, substantial improvement confirmed on
5+ of 9 previously-catastrophic pieces. A documented, scoped-out
residual gap remains on pieces where onset detection misses the
transient between two real sustained low notes — tracked as a
follow-up, not fixed here.

See docs/superpowers/specs/2026-10-13-dtw-provenance-based-collapse-
design.md."
```

---

## Final Step (not a task — update records after Task 3 commits)

Update the Obsidian vault session note for this attempt (following the
"Sessions/2026-10-12 — DTW sustained-note-collapse attempt, reverted.md"
note's own forward-pointer) and `agent_workspace/CHANGELOG.md` with the
real before/after numbers from Step 9, and note the residual gap
(sustained low-register passages where onset detection misses the
transient between two real notes) as a tracked follow-up in
`agent_workspace/AGENT_TASKS.md`'s Backlog section.
