# DTW Sustained-Note Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dtw_align_to_score` robust to spurious same-pitch events caused by vibrato/bow-noise/dynamic-swell re-sampling of one sustained note, by clustering them into one alignment node before DTW runs, then propagating the match back onto every original event.

**Architecture:** One new pure function, `_cluster_sustained_events`, groups events by pitch continuity + `sound_end` continuity (no new heuristic — reuses the release-walk signal `run_pitch_tracking` already computes). `dtw_align_to_score` runs its existing, unmodified DTW algorithm on the cluster representatives instead of the raw events, then expands the result back out. Zero signature or interface changes anywhere.

**Tech Stack:** Python, `modal_worker/worker.py` (production code), `modal_worker/test_analysis.py` (the project's own `check()`-based test harness — no pytest, run via `python3 modal_worker/test_analysis.py`).

**Spec:** `docs/superpowers/specs/2026-10-12-dtw-sustained-note-collapse-design.md`

## Global Constraints

- No feature flag — every edge case degrades to today's exact behavior for the affected event(s).
- Zero signature/interface changes to `dtw_align_to_score` or `run_pitch_tracking`.
- `_cluster_sustained_events` must not assume any event field is present beyond what it needs, and must degrade safely (never crash) when `midi_raw`/`sound_end` are absent — see Task 1's design note; this is what lets existing test fixtures that predate this feature keep working untouched.
- The semitone tolerance for same-pitch clustering is exactly 1 (`abs(diff) <= 1`), matching the tolerance already used in this file's own release-walk continuity check.
- Clustering compares each candidate against the **previous** event already in the cluster (chained), never a fixed first-event anchor — this is the bug the spec review caught and fixed before any code was written.

---

### Task 1: `_cluster_sustained_events` helper, standalone and unit-tested

**Files:**
- Modify: `modal_worker/worker.py` — insert new function immediately before `dtw_align_to_score` (currently at line 1840; grep for `^def dtw_align_to_score` to confirm the current line before inserting, since earlier edits in this session may have shifted it).
- Test: `modal_worker/test_analysis.py` — new test function, registered in `main()`'s tuple.

**Interfaces:**
- Produces: `_cluster_sustained_events(events: list[dict]) -> list[list[dict]]`. Input must already be sorted by `time_sec` (true of every real caller). Output is a list of non-empty clusters, same overall order, each cluster a list of the original event dicts (same objects, not copies) in time order. Task 2 consumes this directly.

**Design note — defensive field access, not strict requirement:**

The spec's pseudocode reads `ev["midi_raw"]` and `ev["sound_end"]` directly. Checking the existing test suite surfaced a real compatibility problem with that: `test_analysis.py`'s shared fixture builder (`make_performance`, line 123) and at least half a dozen other hand-built event literals scattered through the file (e.g. lines 350-352, 816, 846) feed `dtw_align_to_score` directly and carry neither field — only `time_sec`, `pitches`, `confidence`, `cents_offset`, and sometimes `end_sec`/`cents_spread`/`loudness`. A strict `ev["midi_raw"]` lookup would raise `KeyError` on every one of those existing tests the moment this function gets wired into `dtw_align_to_score` in Task 2.

Rather than hunt down and edit every one of those call sites (high risk of missing one, and it inflates this change's blast radius for no real benefit), `_cluster_sustained_events` reads both fields defensively with safe fallbacks that are exactly equivalent to "never cluster this event with anything":

- `midi_raw` missing → derive from `pitches[0]` via `midi_from_name` if present, else `None`. Two events where either side's midi is `None` never count as `same_pitch`.
- `sound_end` missing → defaults to the event's own `time_sec`. Since the next event's `time_sec` is always strictly greater (events are time-sorted, no two real or fixture events share an identical timestamp in this codebase), `no_release_yet` is then always `False` for that event, so it can never pull a neighbor into its cluster.

This means every existing test fixture that lacks these fields keeps behaving exactly as it does today — zero fixtures need to change for Task 1 or Task 2 to work. (`make_performance` itself still gets real values added in Task 2, because the new regression test needs to construct realistic oversampling scenarios on top of it — see Task 2.)

- [ ] **Step 1: Write the failing test**

Add to `modal_worker/test_analysis.py`, directly after `test_run_pitch_tracking_still_rejects_true_silence` (the current last test function in the file):

```python
def test_cluster_sustained_events():
    print("\n[181] _cluster_sustained_events groups spurious same-pitch re-sampling")

    def ev(t, midi, sound_end):
        return {"time_sec": t, "midi_raw": midi, "sound_end": sound_end}

    # Two events, same pitch, no release between them -> one cluster of two.
    clusters = w._cluster_sustained_events([ev(0.0, 60, 0.30), ev(0.20, 60, 0.50)])
    check("same pitch + no release -> one cluster",
          len(clusters) == 1 and len(clusters[0]) == 2, f"{[len(c) for c in clusters]}")

    # Same pitch, but a real release (next onset is AFTER sound_end) -> two clusters.
    clusters = w._cluster_sustained_events([ev(0.0, 60, 0.10), ev(0.20, 60, 0.50)])
    check("same pitch + real release -> two clusters",
          len(clusters) == 2 and all(len(c) == 1 for c in clusters), f"{[len(c) for c in clusters]}")

    # Pitch differs by 2+ semitones -> two clusters, even with no detected release.
    clusters = w._cluster_sustained_events([ev(0.0, 60, 0.30), ev(0.20, 62, 0.50)])
    check("pitch differs by 2+ -> two clusters even without a release",
          len(clusters) == 2, f"{[len(c) for c in clusters]}")

    # Pitch differs by exactly 1 (the tolerance boundary), no release -> one cluster.
    clusters = w._cluster_sustained_events([ev(0.0, 60, 0.30), ev(0.20, 61, 0.50)])
    check("pitch differs by exactly 1 -> one cluster (boundary is inclusive)",
          len(clusters) == 1 and len(clusters[0]) == 2, f"{[len(c) for c in clusters]}")

    # Three events chaining together (1-2 joins, 2-3 joins) -> one cluster of three.
    clusters = w._cluster_sustained_events(
        [ev(0.0, 60, 0.30), ev(0.20, 60, 0.50), ev(0.40, 60, 0.70)])
    check("a chain of three same-pitch events -> one cluster of three",
          len(clusters) == 1 and len(clusters[0]) == 3, f"{[len(c) for c in clusters]}")

    # Gradual drift: 60 -> 61 -> 62. Each STEP is within tolerance (diff 1), but the
    # total drift (60 to 62) is 2 semitones. No release anywhere. Chaining against
    # the PREVIOUS event (not a fixed first-event anchor) must keep these together —
    # this is the exact bug the spec review caught before any code was written.
    clusters = w._cluster_sustained_events(
        [ev(0.0, 60, 0.30), ev(0.20, 61, 0.50), ev(0.40, 62, 0.70)])
    check("gradual drift across a continuous sustain stays one cluster",
          len(clusters) == 1 and len(clusters[0]) == 3, f"{[len(c) for c in clusters]}")

    # Empty input -> empty output.
    check("empty input -> empty output", w._cluster_sustained_events([]) == [])

    # Single event -> one cluster of one.
    clusters = w._cluster_sustained_events([ev(0.0, 60, 0.30)])
    check("single event -> one cluster of one",
          len(clusters) == 1 and len(clusters[0]) == 1, f"{[len(c) for c in clusters]}")

    # Missing midi_raw/sound_end entirely (matches real ad-hoc test fixtures
    # elsewhere in this file) must not crash, and must never cluster — see
    # Task 1's design note on defensive field access.
    bare = [{"time_sec": 0.0, "pitches": ["C4"]}, {"time_sec": 0.05, "pitches": ["C4"]}]
    clusters = w._cluster_sustained_events(bare)
    check("events missing midi_raw/sound_end never crash and never cluster",
          len(clusters) == 2, f"{[len(c) for c in clusters]}")
```

Register it in `main()`: add `test_cluster_sustained_events,` as a new line right before the closing `):` of the big test tuple (currently ending with `test_run_pitch_tracking_still_rejects_true_silence):`).

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A2 "\[181\]"
```

Expected: `AttributeError: module 'worker' has no attribute '_cluster_sustained_events'` (printed as an ERROR line for `test_cluster_sustained_events`, since the function doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Insert into `modal_worker/worker.py`, immediately before `dtw_align_to_score`:

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
        first event) — using `midi_raw`, the unclamped value already
        used for wrong-note comparison elsewhere in this file;
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

    Otherwise it starts a new cluster. A genuinely re-articulated note of
    the same pitch (a real tongued repeat, not a vibrato artifact) can
    also satisfy both conditions, since the release-walk's own tolerance
    for brief interruptions is deliberately generous — an accepted,
    scoped trade-off: every event in the cluster still gets stamped with
    the one measure DTW assigns the cluster, which is correct for all of
    them regardless (they are, by definition, at the same pitch in close
    succession). The only information lost is positional resolution
    WITHIN that one measure, which this function does not claim to
    improve.

    `midi_raw`/`sound_end` are read defensively, not required: a `pitches`-
    only event (no `midi_raw`) derives a pitch via `midi_from_name`; an
    event with no `sound_end` is treated as having no measured sustain at
    all, so it can never pull a later event into its cluster. This keeps
    every pre-existing event shape in this codebase behaving exactly as
    it did before this function existed.

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
        same_pitch = (prev_midi is not None and this_midi is not None
                      and abs(this_midi - prev_midi) <= 1)
        no_release_yet = ev["time_sec"] <= cluster_sound_end
        if same_pitch and no_release_yet:
            clusters[-1].append(ev)
            cluster_sound_end = max(cluster_sound_end, _sound_end(ev))
        else:
            clusters.append([ev])
            cluster_sound_end = _sound_end(ev)
    return clusters
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A10 "\[181\]"
```

Expected: all 9 `check()` lines under `[181]` print `PASS`.

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | tail -5
```

Expected: the pass count increases by exactly 9 (the new checks) over the pre-Task-1 baseline, zero failures.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add _cluster_sustained_events, standalone and unit-tested

Not wired into dtw_align_to_score yet (Task 2). Groups spurious
same-pitch re-sampling of one sustained note using each event's own
sound_end, chained against the previous event in the cluster (not a
fixed anchor) so gradual pitch drift across one continuous sustain
doesn't get wrongly split. See docs/superpowers/specs/2026-10-12-dtw-
sustained-note-collapse-design.md."
```

---

### Task 2: Wire the collapse into `dtw_align_to_score`, with a real regression test

**Files:**
- Modify: `modal_worker/worker.py` — `dtw_align_to_score` (currently starting at line 1840; re-grep `^def dtw_align_to_score` before editing, since Task 1 added lines above it).
- Modify: `modal_worker/test_analysis.py` — `make_performance` (line 123) gains two fields; new regression test function.

**Interfaces:**
- Consumes: `_cluster_sustained_events(events) -> list[list[dict]]` from Task 1.
- Produces: no change to `dtw_align_to_score`'s public signature or return shape — still `list[dict]`, same length and field set as its input `events`, now with correct `measure`/`score_*` fields on previously-miscounted sustained-note runs.

- [ ] **Step 1: Give `make_performance` real `midi_raw`/`sound_end` values**

Open `modal_worker/test_analysis.py` and find `make_performance` (line 123). Change the `evs.append(...)` call from:

```python
            evs.append({"time_sec": t, "end_sec": t + SEC_PER_BEAT,
                        "pitches": [note["pitch"]], "confidence": 90,
                        "cents_offset": 0, "cents_spread": 8, "loudness": "medium"})
```

to:

```python
            # midi_raw/sound_end: real events always carry both once
            # _cluster_sustained_events reads them (see that function's
            # own docstring). sound_end == time_sec here deliberately —
            # this fixture's notes are short and non-legato by design, so
            # "no measured sustain" is the honest value, and it guarantees
            # these events never cluster with each other (every event's
            # time_sec is strictly greater than the previous one's
            # sound_end), which is required for the dozens of existing
            # tests built on this fixture to keep behaving identically.
            evs.append({"time_sec": t, "end_sec": t + SEC_PER_BEAT,
                        "pitches": [note["pitch"]], "midi_raw": w.midi_from_name(note["pitch"]),
                        "sound_end": t, "confidence": 90,
                        "cents_offset": 0, "cents_spread": 8, "loudness": "medium"})
```

- [ ] **Step 2: Run the full suite to confirm this alone changes nothing**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | tail -5
```

Expected: identical pass count to the end of Task 1, zero failures. (This step has no new assertions of its own — it's verifying the fixture change is inert on its own, before the real behavior change in Step 4.)

- [ ] **Step 3: Write the failing regression test**

Add to `modal_worker/test_analysis.py`, after `test_cluster_sustained_events`:

```python
def test_dtw_align_to_score_collapses_spurious_same_pitch_oversampling():
    print("\n[182] dtw_align_to_score collapses spurious same-pitch oversampling "
          "before aligning, instead of being misled by it")
    score = make_score()
    played, evs = make_performance(score)

    # Simulate run_pitch_tracking over-sampling ONE sustained note (the
    # measured real-world failure mode — a slow movement's held note picks
    # up extra spurious events from vibrato/bow-noise/dynamic swells).
    # Replace the single event for measure START's first note with 5
    # events at the same pitch, each one's sound_end overlapping the
    # next's onset (no detected release between any of them), spanning
    # the same short window the one real event would have occupied.
    target = evs[0]
    spurious = []
    for i in range(5):
        t = target["time_sec"] + i * 0.05
        spurious.append({**target, "time_sec": t, "sound_end": t + 0.08})
    oversampled = spurious + evs[1:]

    aligned = w.dtw_align_to_score(oversampled, score, START, BEATS_PER_MEASURE, end_measure=END)

    check("output has one entry per input event (shape unchanged)",
          len(aligned) == len(oversampled), f"{len(aligned)} vs {len(oversampled)}")

    true_measure = played[0]["number"]
    spurious_measures = {e["measure"] for e in aligned[:5]}
    check("all 5 spurious same-pitch events land on the SAME, correct measure",
          spurious_measures == {true_measure}, f"got {spurious_measures}, want {{{true_measure}}}")

    # The rest of the piece must still align correctly — the fix must not
    # have thrown off everything downstream of the oversampled note.
    truth = [m["number"] for m in played for _ in m["notes"]][1:]
    got = [e["measure"] for e in aligned[5:]]
    exact = sum(1 for a, b in zip(got, truth) if a == b)
    check("the rest of the piece still aligns correctly",
          exact == len(truth), f"{exact}/{len(truth)}")
```

Register it in `main()`: add `test_dtw_align_to_score_collapses_spurious_same_pitch_oversampling,` right after `test_cluster_sustained_events,`.

- [ ] **Step 4: Run it to verify it fails against the OLD `dtw_align_to_score`**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A5 "\[182\]"
```

Expected: `FAIL` on "all 5 spurious same-pitch events land on the SAME, correct measure" (the old per-event loop maps each of the 5 spurious events to 5 different, mostly-wrong nearby score notes, since nothing collapses them first).

- [ ] **Step 5: Modify `dtw_align_to_score` to use clusters**

In `modal_worker/worker.py`, inside `dtw_align_to_score` (find it via `^def dtw_align_to_score`):

After the existing two early-return guards —

```python
    measures = score.get("measures", [])
    if not measures or not events:
        return events

    # Only the measures the student actually played — see flatten_score_notes.
    score_notes = flatten_score_notes(score, start_measure, end_measure, beats_per_measure)
    score_seq: list[tuple[int, int]] = [(sn["midi"], sn["measure"]) for sn in score_notes]

    if len(score_seq) < 4:
        print(f"[dtw_align] score has <4 pitched notes — declining, caller should fall back")
        return []
```

— insert:

```python
    # Collapse spurious same-pitch re-sampling of one sustained note (vibrato,
    # bow noise, dynamic swells) into one representative per real sound BEFORE
    # building the audio pitch sequence, so DTW aligns against how many notes
    # were actually PLAYED, not how many times run_pitch_tracking happened to
    # sample one of them. See _cluster_sustained_events and the design spec.
    clusters = _cluster_sustained_events(events)
    representatives = [c[0] for c in clusters]
```

Then find the existing audio-sequence-building loop:

```python
    # Build audio sequence: MIDI pitch per event (use the primary pitch)
    audio_midis: list[int | None] = []
    for ev in events:
        pitches = ev.get("pitches", [])
        midi = midi_from_name(pitches[0]) if pitches else None
        audio_midis.append(midi)

    n, m_len = len(audio_midis), len(score_seq)
```

and change `for ev in events:` to `for ev in representatives:`, and nothing else in this block (the variable names `audio_midis`, `n`, `m_len` stay the same — only what they're built from changes).

Everything from the cost-matrix construction through the Sakoe-Chiba band and the traceback is unchanged — it already only reads `n`, `m_len`, `audio_midis`, and `score_midis`, none of which need further edits now that `n`/`audio_midis` come from `representatives`.

Finally, find the existing result-building loop:

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

and replace it with:

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

(`clusters` is built from time-sorted `events` and preserves that order both across and within clusters, so `result` is already time-sorted — no additional sort needed.)

Immediately after that loop, find the existing diagnostic print:

```python
    # Sanity check: count how many distinct measures were assigned
    measures_hit = len({ev["measure"] for ev in result})
    total_score_measures = len(measures)
    print(f"[dtw_align] {n} audio events → {measures_hit}/{total_score_measures} score measures covered")
    return result
```

and add one line right before the `print(...)`:

```python
    print(f"[dtw_align] {len(events)} raw events collapsed to {len(representatives)} "
          f"alignment nodes ({len(events) - len(representatives)} collapsed)")
```

- [ ] **Step 6: Run the regression test to verify it now passes**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A5 "\[182\]"
```

Expected: both `check()` lines under `[182]` print `PASS`.

- [ ] **Step 7: Red/green verification — confirm the test actually exercises the fix**

```bash
git stash push --keep-index -- modal_worker/worker.py
cd modal_worker && python3 test_analysis.py 2>&1 | grep -A5 "\[182\]"
cd ..
git stash pop
```

Expected: with `worker.py` stashed back to its pre-Task-2 state (test file changes stay, since they're staged — `--keep-index` preserves the index), `[182]`'s first `check()` prints `FAIL`. After `git stash pop` restores the fix, re-run once more and confirm both checks are back to `PASS`.

- [ ] **Step 8: Run the full suite**

```bash
cd modal_worker && python3 test_analysis.py 2>&1 | tail -5
```

Expected: every pre-existing test still passes (same count as end of Task 1, plus the 2 new `[182]` checks — 665 + 9 (Task 1) + 2 = 676 total without the real audio stack, or 679 with it, matching whatever the actual baseline was; read the printed total rather than assuming a specific number, since other work may have landed in this file since the breath-noise gate fix's 665/668 baseline).

- [ ] **Step 9: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "fix(worker): make dtw_align_to_score robust to spurious same-pitch
oversampling of sustained notes

Wires _cluster_sustained_events in: DTW now runs on one representative
per real sound instead of every raw event, then the match is
propagated back onto all original events. Fixes the dominant failure
mode found by the MusicNet validation (event-count ratio >=1.37 ->
0-3% correct measure-alignment on 9 of 20 real pieces) without
changing dtw_align_to_score's signature, run_pitch_tracking's output,
or any caller. Verified red/green via git stash.

See docs/superpowers/specs/2026-10-12-dtw-sustained-note-collapse-
design.md."
```

---

## Final Manual Verification (not a task — run after both tasks are committed)

Re-run the real-corpus validation this fix was scoped against, and compare to the pre-fix numbers already recorded in the Obsidian vault's "2026-10-11 (2) — MusicNet score-alignment validation" session note:

```bash
source /tmp/urmp_venv/bin/activate   # the isolated venv with the real audio stack
cd modal_worker
python3 validate_alignment_against_musicnet.py --data-dir /tmp/musicnet_data
```

Acceptance bar (from the spec's Testing Strategy, item 4):
- Every one of the 9 pieces currently at 0-3% correct (2204, 2220, 2221, 2222, 2241, 2242, 2288, 2293, 2296) must show a measurable improvement. The specific achievable number isn't fixed in advance — this fix targets event-count inflation specifically, not every failure mode in those pieces.
- None of the 8 pieces currently at 83-95% correct (2202, 2203, 2218, 2219, 2244, 2289, 2294, 2295) may regress by more than 5 percentage points.
- The new `[dtw_align] N raw events collapsed to M alignment nodes` log line should show near-zero collapsing on the already-good pieces and substantial collapsing on the previously-catastrophic ones — a direct sanity check that the mechanism is doing what the spec claims, not just that the scores moved.

Update the Obsidian session note and `agent_workspace/CHANGELOG.md` with the before/after numbers once this runs, following this session's established convention for the breath-noise-gate fix and the first MusicNet validation pass.
