# Launch Accuracy — Plan B: The Three Blind Spots

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three error categories the analyser is structurally unable to see — playing through a rest, playing at the wrong tempo, and a crescendo that never arrives.

**Architecture:** Each is a measurement the pipeline already has the raw data for but throws away before it can be used. Rests are dropped by both score parsers; the marked tempo is parsed into a string and never read; dynamic wedges are never parsed at all. Each task restores one input, adds one detector beside the existing ones in `compare_and_coach_claude`, and stamps `rule`/`measured` through the `_add()` pathway that already carries provenance.

**Tech Stack:** Python 3.11 (Modal worker), `music21` for score parsing.

**Spec:** `docs/superpowers/specs/2026-08-29-launch-accuracy-design.md` — Parts 3, 4 and 5.

## Global Constraints

- Python 3.11. No new dependencies. `music21==9.1.0` is pinned.
- The suites run with **no network, no API keys, no audio** — heavy imports are `MagicMock`-stubbed. **`music21` is stubbed, so `parse_musicxml` cannot be executed by any test.** Parser changes are verified by reading; detectors are tested directly with synthetic inputs. State that limit rather than implying coverage.
- Tests use the plain-assert `check(name, ok, detail="")` harness. **No pytest.**
- Starting tallies: `test_analysis.py` **200/200**, `diagnose_coverage.py` **30/30**, `test_evidence.py` **61/61**. The last must stay unchanged. Run `rm -rf modal_worker/__pycache__` before any run you report.
- Every new detector is emitted through the existing `_add(...)` closure with `rule=` and `measured=` set, so `evidence.py` can trace it. Do not invent a parallel emission path.
- **Precision beats recall.** A false accusation costs more trust than a missed error. Every gate below is deliberately strict, and a detector that cannot be shown silent on clean playing does not ship.
- No flag without a measure and a timestamp range (PD-005).
- `npx` is broken in this checkout. Use npm scripts.

---

## File Structure

**Modified:**
- `modal_worker/worker.py` — rest retention, rest windows, three detectors, wedge parsing, numeric tempo
- `modal_worker/test_analysis.py` — unit tests per detector
- `modal_worker/diagnose_coverage.py` — behaviour rows
- `agent_workspace/AGENT_TASKS.md`, `CHANGELOG.md`

No new files: each detector belongs beside the ones it sits with, and `worker.py` already owns this responsibility.

---

## Task 1: Keep rests in the score model

Rests are dropped by every path. Until they survive parsing, no rest detector is possible.

**Files:** Modify `modal_worker/worker.py`; Test `modal_worker/test_analysis.py`

**Interfaces:**
- Produces: rest entries in `parse_musicxml`'s measure `notes` lists shaped `{"is_rest": True, "beat": float, "duration_beats": float, "pitch": None}`.
- Produces: `collect_rest_windows(score, beats_per_measure) -> list[dict]` with keys `measure`, `start_beat` (1-based within the measure), `end_beat`, `beats` (duration).
- Consumed by: Task 2.

- [ ] **Step 1: Write the failing test**

```python
def test_rest_windows_are_collected_from_the_score():
    print("\n[47] rests survive the score model and become windows")
    score = {"time_signature": "4/4", "measures": [
        {"number": 5, "notes": [
            {"pitch": "C4", "beat": 1.0, "duration_beats": 1.0},
            {"is_rest": True, "pitch": None, "beat": 2.0, "duration_beats": 2.0},
            {"pitch": "D4", "beat": 4.0, "duration_beats": 1.0}]},
        {"number": 6, "notes": [
            {"pitch": "E4", "beat": 1.0, "duration_beats": 4.0}]},
    ]}
    wins = w.collect_rest_windows(score, 4)
    check("one rest window found", len(wins) == 1, str(len(wins)))
    if wins:
        r = wins[0]
        check("window names its measure", r["measure"] == 5, str(r["measure"]))
        check("window spans beats 2->4", (r["start_beat"], r["end_beat"]) == (2.0, 4.0),
              f'{r["start_beat"]}->{r["end_beat"]}')
    # A pitched note must never be mistaken for a rest.
    only_notes = {"time_signature": "4/4", "measures": [
        {"number": 1, "notes": [{"pitch": "C4", "beat": 1.0, "duration_beats": 4.0}]}]}
    check("no rests means no windows", w.collect_rest_windows(only_notes, 4) == [])

    # Sub-beat rests are inside articulation noise and must be excluded, or every
    # staccato passage becomes a rest violation.
    short = {"time_signature": "4/4", "measures": [
        {"number": 2, "notes": [
            {"is_rest": True, "pitch": None, "beat": 2.0, "duration_beats": 0.5}]}]}
    check("sub-beat rests are excluded", w.collect_rest_windows(short, 4) == [],
          str(w.collect_rest_windows(short, 4)))
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `rm -rf modal_worker/__pycache__ && python3 modal_worker/test_analysis.py`
Expected: FAIL — `module 'worker' has no attribute 'collect_rest_windows'`

- [ ] **Step 3: Stop dropping rests in `parse_musicxml`**

At the `isinstance(el, m21.note.Rest)` branch (~line 996), which currently `continue`s, emit an entry instead. Keep the existing comment's warning about false rest detection and extend it to say the risk is now managed by the detector's gates rather than by blindness:

```python
                if isinstance(el, m21.note.Rest):
                    # Rests used to be dropped outright, on the reasoning that
                    # "false rest detection creates bad coaching". That was right
                    # about the risk and wrong about the remedy: a student playing
                    # through a written rest is a real, common mistake nobody was
                    # ever told about. They are kept here; the strictness lives in
                    # find_rest_violations, not in refusing to look.
                    notes_out.append({
                        "pitch": None,
                        "is_rest": True,
                        "beat": float(el.beat),
                        "duration_beats": float(el.duration.quarterLength),
                        "articulation": None,
                        "dynamic": cur_dynamic,
                    })
                    continue
```

- [ ] **Step 4: Confirm rests cannot leak into pitched-note paths**

`flatten_score_notes` skips entries whose `pitch` is falsy, so a rest is already excluded from DTW — **verify this by reading and say so in your report.** If any other consumer iterates `m["notes"]` assuming a pitch, guard it. Grep for `.get("pitch")` and `["notes"]` to check.

- [ ] **Step 5: Ask the vision reader for rests**

In `read_score_notes_claude`'s prompt, the instruction currently says to skip rests. Change it to return them, with a `"r": true` marker plus beat and duration, and add `"r"` to the field list and JSON example. Update `_norm_note` to carry `is_rest` from `r`, and remove the filter that drops entries whose pitch reads `"rest"`.

- [ ] **Step 6: Implement `collect_rest_windows`**

Place it next to `flatten_score_notes`:

```python
_REST_MIN_BEATS = 1.0   # shorter rests sit inside articulation noise


def collect_rest_windows(score: dict, beats_per_measure: int) -> list[dict]:
    """
    Written rests long enough to be worth checking, as beat spans.

    Deliberately NOT part of flatten_score_notes: that list feeds DTW, which
    matches pitch sequences, and a rest has no pitch. Rests travel separately.

    Rests under one beat are excluded. A staccato passage is full of sub-beat
    silence that the player is correct to leave, and flagging it would recreate
    the "false rest detection creates bad coaching" problem that caused rests to
    be dropped in the first place.
    """
    out: list[dict] = []
    for m in score.get("measures", []):
        num = m.get("number")
        if not isinstance(num, int):
            continue
        for n in m.get("notes", []):
            if not n.get("is_rest"):
                continue
            try:
                beat = float(n.get("beat") or 1.0)
                dur = float(n.get("duration_beats") or 0.0)
            except (TypeError, ValueError):
                continue
            if dur < _REST_MIN_BEATS:
                continue
            out.append({"measure": num, "start_beat": beat,
                        "end_beat": beat + dur, "beats": dur})
    return out
```

- [ ] **Step 7: Run every suite**

Run: `rm -rf modal_worker/__pycache__ && python3 modal_worker/test_analysis.py && python3 modal_worker/diagnose_coverage.py && python3 modal_worker/test_evidence.py`
Expected: `205/205` (200 + 5), `30/30`, `61/61`.

- [ ] **Step 8: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(analysis): keep rests in the score model

Both parsers dropped every rest, so playing through one was undetectable. They
are kept now; strictness moves into the detector's gates rather than blindness.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Detect playing through a rest

**The highest-risk task in this plan.** It accuses a student of playing where they believe they were silent. Its gates are as strict as the wrong-note detector's, and if it cannot be shown silent on a note decaying into a rest, it does not ship.

**Files:** Modify `modal_worker/worker.py`; Test `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `collect_rest_windows` (Task 1).
- Produces: `find_rest_violations(aligned, rest_windows, measure_span_fn, beats_per_measure) -> list[str]` — evidence strings shaped like the other detectors', one per violated rest, capped at 6. `measure_span_fn(measure) -> (start_sec, end_sec) | None` lets the caller supply the canonical timeline without this function importing it.

- [ ] **Step 1: Write the failing test**

```python
def test_rest_violations_need_real_playing_not_decay():
    print("\n[48] rest violations fire on playing, not on a note ringing out")
    wins = [{"measure": 5, "start_beat": 2.0, "end_beat": 4.0, "beats": 2.0}]
    # m.5 runs 10.0-12.0s at 4 beats -> 0.5s per beat; the rest spans 10.5-11.5s.
    span = lambda m: (10.0, 12.0) if m == 5 else None

    def ev(t, **kw):
        base = {"time_sec": t, "measure": 5, "confidence": 90,
                "cents_spread": 10, "held_sec": 0.6}
        base.update(kw)
        return [base]

    # A note that started BEFORE the rest and rings into it is a release.
    check("decay into a rest does not flag",
          w.find_rest_violations(ev(10.2), wins, span, 4) == [],
          str(w.find_rest_violations(ev(10.2), wins, span, 4)))
    # An onset just inside the boundary is still decay, not a new note.
    check("an onset on the boundary does not flag",
          w.find_rest_violations(ev(10.55), wins, span, 4) == [])
    # Sustained, confident playing in the middle of the rest IS the finding.
    hit = w.find_rest_violations(ev(11.0), wins, span, 4)
    check("sustained playing inside a rest flags", len(hit) == 1, str(hit))
    check("the evidence names the measure",
          bool(hit) and "measure 5" in hit[0], str(hit))
    # Low confidence is noise, not playing.
    check("low-confidence events do not flag",
          w.find_rest_violations(ev(11.0, confidence=40), wins, span, 4) == [])
    # A brief blip is a key click or a breath.
    check("brief events do not flag",
          w.find_rest_violations(ev(11.0, held_sec=0.05), wins, span, 4) == [])
    # An unstable pitch has no note to speak of.
    check("unstable pitch does not flag",
          w.find_rest_violations(ev(11.0, cents_spread=90), wins, span, 4) == [])
    # No timeline for the measure means we cannot place the rest at all.
    check("no span means no flag",
          w.find_rest_violations(ev(11.0), wins, lambda m: None, 4) == [])
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `rm -rf modal_worker/__pycache__ && python3 modal_worker/test_analysis.py`
Expected: FAIL — `no attribute 'find_rest_violations'`

- [ ] **Step 3: Implement the detector**

Place it beside `find_crack_candidates`:

```python
_REST_ONSET_GRACE   = 0.15   # s after the rest starts before an onset counts
_REST_MIN_CONF      = 65     # same bar as the wrong-note detector
_REST_MAX_SPREAD    = 40     # cents; a sliding reading is not a held note
_REST_MIN_HELD      = 0.15   # s of actual sound


def find_rest_violations(aligned, rest_windows, measure_span_fn,
                         beats_per_measure) -> list[str]:
    """
    Sustained playing where the score is silent.

    This accuses a student of playing where they believe they rested, so the bar
    is deliberately the wrong-note detector's, not something looser. A note
    RINGING INTO a rest is correct playing — that is release, not sound — so an
    onset must start meaningfully after the rest begins to count at all.
    """
    if not aligned or not rest_windows:
        return []
    bpm_m = max(1, int(beats_per_measure or 4))
    out: list[str] = []
    for win in rest_windows:
        span = measure_span_fn(win["measure"])
        if not span:
            continue                     # cannot place this rest in time
        m_start, m_end = span
        m_dur = max(0.01, m_end - m_start)
        spb = m_dur / bpm_m
        r_start = m_start + (win["start_beat"] - 1.0) * spb
        r_end = min(m_end, m_start + (win["end_beat"] - 1.0) * spb)
        if r_end - r_start <= 0:
            continue
        for ev in aligned:
            t = ev.get("time_sec")
            if t is None:
                continue
            # Must START inside the rest, past the grace window — anything
            # earlier is the previous note still sounding.
            if not (r_start + _REST_ONSET_GRACE <= float(t) < r_end):
                continue
            if ev.get("confidence", 0) < _REST_MIN_CONF:
                continue
            if ev.get("cents_spread", 0) > _REST_MAX_SPREAD:
                continue
            if float(ev.get("held_sec") or 0.0) < _REST_MIN_HELD:
                continue
            out.append(
                f"rest_violation | measure {win['measure']} | "
                f"a {win['beats']:g}-beat rest is written here but a note sounds "
                f"for {float(ev.get('held_sec') or 0):.2f}s at t={float(t):.2f}s")
            break                        # one per rest window
    return out[:6]
```

- [ ] **Step 4: Wire it into the coaching pass**

In `compare_and_coach_claude`, beside the existing detector calls (`wrong_note_candidates`, `crack_candidates`, `dynamics_report`), add the rest pass. It needs the canonical timeline, so it must run **after** `_timeline()` is available — place it with the timing block, and pass a span function reading `_timeline_cache["idx"]`:

```python
    rest_candidates: list[str] = []
    try:
        _rest_wins = collect_rest_windows(score, bpm)
        if _rest_wins:
            _tl_idx = {r["measure"]: r for r in _timeline()}
            def _span(m):
                r = _tl_idx.get(int(m))
                return (r["start"], r["end"]) if r else None
            rest_candidates = find_rest_violations(aligned, _rest_wins, _span, bpm)
    except Exception as e:                # never fail an analysis over a detector
        print(f"[compare_and_coach_claude] rest detection error: {e}")
```

Then emit them alongside the crack candidates, confirmed by construction:

```python
    for cand in rest_candidates:
        mm = re.search(r'measure (\d+)', cand)
        if mm:
            _t = re.search(r't=([\d.]+)s', cand)
            _add(int(mm.group(1)), "timing", cand,
                 float(_t.group(1)) if _t else None, confirmed=True,
                 rule="rest_violation", measured=None)
```

- [ ] **Step 5: Narrow Gemini's instruction**

`evaluate_with_gemini`'s prompt says *"Do NOT flag anything heard during rests"*, which was written to stop it hallucinating over silence but now also blocks the true positive. Narrow it to forbid flagging **ambient noise, breathing or room sound** during rests while permitting a report of **sustained playing** where the score is silent. Change both the score and no-score variants of that instruction.

- [ ] **Step 6: Add `rest_violation` to the provenance map**

In `modal_worker/evidence.py`, add `"rest_violation"` to `_DETECTOR_BY_TYPE` mapped to `("find_rest_violations", "measured")` so the flag is traceable rather than falling through to `("unknown", "unverifiable")`.

- [ ] **Step 7: Run every suite**

Expected: `213/213` (205 + 8), `30/30`, `61/61`.

- [ ] **Step 8: Commit**

```bash
git add modal_worker/worker.py modal_worker/evidence.py modal_worker/test_analysis.py
git commit -m "feat(analysis): detect playing through a written rest

Gated as strictly as the wrong-note detector: an onset must start past a 150ms
grace after the rest begins, be confidently tracked, pitch-stable and sustained.
A note ringing into a rest is release, not playing, and must never flag.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Tempo against the marked tempo

**Files:** Modify `modal_worker/worker.py`; Test `modal_worker/test_analysis.py`

**Interfaces:**
- Produces: `tempo_bpm: float | None` on the score dict from `parse_musicxml` and `read_score_notes_claude`.
- Produces: `check_tempo_vs_marking(fitted_bpm, marked_bpm) -> dict | None` with keys `pct`, `direction`, `fitted`, `marked`.

- [ ] **Step 1: Write the failing test**

```python
def test_tempo_vs_marking_reports_fact_not_fault():
    print("\n[49] played tempo is compared to the marked tempo")
    check("15% slower is reported",
          (w.check_tempo_vs_marking(84.0, 120.0) or {}).get("direction") == "slower")
    check("the percentage is real",
          abs((w.check_tempo_vs_marking(84.0, 120.0) or {})["pct"] - 30.0) < 0.6,
          str(w.check_tempo_vs_marking(84.0, 120.0)))
    check("faster is reported too",
          (w.check_tempo_vs_marking(138.0, 120.0) or {}).get("direction") == "faster")
    # Inside tolerance is not a finding — musicians are not metronomes.
    check("a close tempo is silent", w.check_tempo_vs_marking(126.0, 120.0) is None,
          str(w.check_tempo_vs_marking(126.0, 120.0)))
    # No marked tempo means nothing to compare against. "Allegro" is not a number
    # and inventing one for it would be fabrication.
    check("no marking means no finding", w.check_tempo_vs_marking(84.0, None) is None)
    check("zero marking is rejected", w.check_tempo_vs_marking(84.0, 0.0) is None)
    check("parses a numeric marking", w.parse_marked_bpm("♩ = 120") == 120.0,
          str(w.parse_marked_bpm("♩ = 120")))
    check("a tempo word yields nothing", w.parse_marked_bpm("Allegro") is None,
          str(w.parse_marked_bpm("Allegro")))
```

- [ ] **Step 2: Run and confirm it fails**

- [ ] **Step 3: Implement both helpers**

```python
_TEMPO_MARK_PCT = 15.0   # below this, a performance is simply not a metronome


def parse_marked_bpm(marking) -> float | None:
    """
    A number from a tempo marking, or None.

    "Allegro" is a tempo WORD, not a tempo. Mapping words to BPM ranges would be
    inventing a number the page does not carry, which is the kind of fabrication
    this pipeline exists to avoid.
    """
    if marking is None:
        return None
    if isinstance(marking, (int, float)):
        return float(marking) if 20 <= float(marking) <= 300 else None
    import re as _re
    m = _re.search(r'(\d{2,3})(?:\.\d+)?', str(marking))
    if not m:
        return None
    val = float(m.group(1))
    return val if 20 <= val <= 300 else None


def check_tempo_vs_marking(fitted_bpm, marked_bpm) -> dict | None:
    """
    How the played tempo compares with the printed one.

    Reported as FACT, not fault. A student practising deliberately slowly has
    made no mistake, and nothing here can tell practice from error — so the
    wording names both numbers and judges neither. Inferring intent from the
    student's note would be exactly the LLM-vocabulary gating this pipeline has
    already been bitten by.
    """
    try:
        f = float(fitted_bpm or 0.0)
        m = float(marked_bpm or 0.0)
    except (TypeError, ValueError):
        return None
    if f <= 0 or m <= 0:
        return None
    pct = (f - m) / m * 100.0
    if abs(pct) < _TEMPO_MARK_PCT:
        return None
    return {"pct": round(abs(pct), 1),
            "direction": "faster" if pct > 0 else "slower",
            "fitted": round(f, 1), "marked": round(m, 1)}
```

- [ ] **Step 4: Capture the number at parse time**

In `parse_musicxml`, the `MetronomeMark` branch currently stores `str(el)`. Keep that for display and additionally store `tempo_bpm` from `getattr(el, "number", None)`. In `read_score_notes_claude`, run its free-text `tempo_marking` through `parse_marked_bpm` and store `tempo_bpm`.

- [ ] **Step 5: Emit the flag**

In `compare_and_coach_claude`, after the `timing_report` block, when `timing_report.get("ok")` and a marked BPM exists:

```python
        _marked = parse_marked_bpm(score.get("tempo_bpm") or score.get("tempo_marking"))
        _tm = check_tempo_vs_marking(timing_report.get("bpm"), _marked)
        if _tm:
            _add(measure_lo, "timing",
                 f"you played this at about {_tm['fitted']:.0f} BPM against a marked "
                 f"{_tm['marked']:.0f} BPM ({_tm['pct']}% {_tm['direction']}). If that "
                 f"was deliberate practice tempo, ignore this",
                 None, confirmed=True, is_global=True, priority=2,
                 measure_end=measure_hi if measure_hi > measure_lo else None,
                 rule="tempo_vs_marking", measured=_tm["pct"])
```

Add `"tempo_vs_marking"` to `_DETECTOR_BY_TYPE` in `evidence.py` as `("check_tempo_vs_marking", "measured")`.

- [ ] **Step 6: Run every suite**

Expected: `221/221` (213 + 8), `30/30`, `61/61`.

- [ ] **Step 7: Commit**

```bash
git add modal_worker/worker.py modal_worker/evidence.py modal_worker/test_analysis.py
git commit -m "feat(analysis): compare the played tempo with the marked tempo

tempo_marking was parsed and never read, so playing at 84 against a printed 120
drew nothing. Reported as fact rather than fault: deliberate slow practice is
indistinguishable from error here, so the wording names both numbers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Crescendos that never arrive

**Files:** Modify `modal_worker/worker.py`; Test `modal_worker/test_analysis.py`

**Interfaces:**
- Produces: `wedges: list[dict]` on the score dict, each `{"kind": "cresc"|"dim", "start_measure", "end_measure"}`.
- Produces: `analyze_wedges(aligned, wedges) -> list[dict]` with `kind`, `start_measure`, `end_measure`, `delta_db`.

- [ ] **Step 1: Write the failing test**

```python
def test_crescendo_that_never_arrives_is_flagged():
    print("\n[50] a crescendo must actually get louder")
    wedges = [{"kind": "cresc", "start_measure": 3, "end_measure": 6}]

    def evs(dbs):
        return [{"measure": 3 + i // 2, "time_sec": i * 0.5,
                 "db": d, "confidence": 90, "score_idx": i}
                for i, d in enumerate(dbs)]

    flat = w.analyze_wedges(evs([-30, -30, -29.5, -30, -29.8, -30, -30, -29.9]), wedges)
    check("a flat crescendo is flagged", len(flat) == 1, str(flat))
    real = w.analyze_wedges(evs([-34, -32, -30, -28, -26, -24, -22, -20]), wedges)
    check("a real crescendo is silent", real == [], str(real))
    backwards = w.analyze_wedges(evs([-20, -22, -24, -26, -28, -30, -32, -34]), wedges)
    check("a crescendo played backwards is flagged", len(backwards) == 1, str(backwards))
    check("the finding carries a dB number",
          bool(flat) and isinstance(flat[0].get("delta_db"), (int, float)), str(flat))
    # Too few notes to fit a slope through.
    check("a short span is silent", w.analyze_wedges(evs([-30, -29]), wedges) == [])
    # A diminuendo is the mirror image.
    dim = [{"kind": "dim", "start_measure": 3, "end_measure": 6}]
    check("a diminuendo that gets louder is flagged",
          len(w.analyze_wedges(evs([-34, -32, -30, -28, -26, -24, -22, -20]), dim)) == 1)
    check("a real diminuendo is silent",
          w.analyze_wedges(evs([-20, -22, -24, -26, -28, -30, -32, -34]), dim) == [])
```

- [ ] **Step 2: Run and confirm it fails**

- [ ] **Step 3: Implement `analyze_wedges`**

```python
_WEDGE_MIN_NOTES = 6     # a slope through fewer points is noise
_WEDGE_MIN_DB    = 1.5   # dB the loudness must move across the whole span


def analyze_wedges(aligned: list[dict], wedges: list[dict]) -> list[dict]:
    """
    Does a written crescendo or diminuendo actually happen?

    Uses the per-note `db` already measured over the note BODY (the window that
    was fixed so articulation stops leaking into dynamics). Relative within the
    take only — absolute dBFS is a fact about mic placement, not playing.
    """
    if not aligned or not wedges:
        return []
    out: list[dict] = []
    for wd in wedges:
        try:
            lo, hi = int(wd["start_measure"]), int(wd["end_measure"])
        except (KeyError, TypeError, ValueError):
            continue
        pts = sorted(
            ((float(e["time_sec"]), float(e["db"])) for e in aligned
             if e.get("db") is not None and e.get("time_sec") is not None
             and e.get("measure") is not None and lo <= int(e["measure"]) <= hi
             and e.get("confidence", 0) >= 50),
            key=lambda p: p[0])
        if len(pts) < _WEDGE_MIN_NOTES:
            continue
        # Compare the two halves rather than fitting a line: a wedge is a
        # direction, and the halves' medians are robust to one loud note.
        half = len(pts) // 2
        first = median([d for _, d in pts[:half]]) or 0.0
        last = median([d for _, d in pts[-half:]]) or 0.0
        delta = last - first
        wants_louder = str(wd.get("kind", "cresc")).startswith("cresc")
        achieved = delta >= _WEDGE_MIN_DB if wants_louder else delta <= -_WEDGE_MIN_DB
        if not achieved:
            out.append({"kind": "cresc" if wants_louder else "dim",
                        "start_measure": lo, "end_measure": hi,
                        "delta_db": round(delta, 1)})
    return out
```

- [ ] **Step 4: Parse the wedges**

In `parse_musicxml`, collect `m21.dynamics.Crescendo` / `Diminuendo` (both `DynamicWedge` subclasses) from the part, reading each one's first and last measure number, and return them as `wedges` on the score dict. Guard the whole block in `try/except` — an unusual score must not fail the parse. For the vision reader, convert a run of consecutive measures whose notes carry `dyn` of `"cresc"`/`"dim"` into one span.

- [ ] **Step 5: Emit the flags**

Beside the dynamics block in `compare_and_coach_claude`:

```python
    for _wd in analyze_wedges(aligned, score.get("wedges") or []):
        _word = "crescendo" if _wd["kind"] == "cresc" else "diminuendo"
        _dirn = "louder" if _wd["kind"] == "cresc" else "softer"
        _add(_wd["start_measure"], "dynamics",
             f"the {_word} here does not arrive — the passage ends "
             f"{abs(_wd['delta_db']):.1f} dB "
             f"{'louder' if _wd['delta_db'] > 0 else 'softer'} than it began, where "
             f"it should get noticeably {_dirn}",
             None, confirmed=True, priority=2,
             measure_end=_wd["end_measure"] if _wd["end_measure"] > _wd["start_measure"] else None,
             rule="wedge", measured=_wd["delta_db"])
```

Add `"wedge"` to `_DETECTOR_BY_TYPE` in `evidence.py` as `("analyze_wedges", "measured")`.

- [ ] **Step 6: Run every suite**

Expected: `228/228` (221 + 7), `30/30`, `61/61`.

- [ ] **Step 7: Commit**

```bash
git add modal_worker/worker.py modal_worker/evidence.py modal_worker/test_analysis.py
git commit -m "feat(analysis): flag a crescendo that never arrives

Dynamic wedges were never parsed at all, and the vision reader's cresc/dim
values were discarded by _DYNAMIC_RANK. A wedge is now checked against the
per-note loudness already measured over the note body.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Behaviour rows and boards

**Files:** Modify `modal_worker/diagnose_coverage.py`, `agent_workspace/AGENT_TASKS.md`, `agent_workspace/CHANGELOG.md`

- [ ] **Step 1: Add six rows — three defects, three clean**

Match the file's existing style. For each new detector, one row proving it fires on a synthetic defect and one proving it is **silent on correct playing**:

- "playing through a rest" / "a note decaying into a rest is silent"
- "playing well under the marked tempo" / "playing at the marked tempo is silent"
- "a crescendo that never arrives" / "a real crescendo is silent"

The silent rows are the ones that constrain the implementation; a detector that fired unconditionally would pass the defect rows alone.

- [ ] **Step 2: Run it**

Expected: `36/36 behaviours present`.

- [ ] **Step 3: Update the boards**

State what shipped and, plainly, what it cannot do: the rest detector needs a score that carries rests, so it does nothing on a take whose score failed to parse; the tempo check needs a **numeric** marking, so "Allegro" alone yields nothing; the wedge check needs at least six notes in the span. Add a `Backlog` note that none of these thresholds is corpus-calibrated yet — they are conservative first guesses and Phase 2's corpus work should revisit every one.

- [ ] **Step 4: Commit**

---

## Self-review

**Spec coverage.** Part 3 (rests) → Tasks 1, 2. Part 4 (tempo vs marking) → Task 3. Part 5 (wedges) → Task 4. Verification → Task 5 plus per-task tests. Nothing in Parts 3-5 is unassigned.

**Placeholder scan.** No TBDs. Tasks 1, 3 and 4 each touch `parse_musicxml`, which cannot be executed under the `MagicMock` stub — each says so and tests the consumer instead. Declared, not hidden.

**Type consistency.** `collect_rest_windows` returns `measure`/`start_beat`/`end_beat`/`beats` and `find_rest_violations` consumes exactly those. `parse_marked_bpm` returns `float | None`, consumed by `check_tempo_vs_marking(fitted, marked)`. `analyze_wedges` consumes `kind`/`start_measure`/`end_measure` from the score's `wedges` and returns those plus `delta_db`, consumed by the `_add` block. Every new rule string (`rest_violation`, `tempo_vs_marking`, `wedge`) is added to `_DETECTOR_BY_TYPE` in the task that introduces it.

**Cumulative tallies.** 200 → 205 → 213 → 221 → 228, and coverage 30 → 36. Each task states its own arithmetic.

**Known risk, stated.** The rest detector is the one that can hurt: it accuses a student of playing where they believe they were silent. Its test asserts silence on decay, on a boundary onset, on low confidence, on brevity and on instability — five negative cases against one positive, deliberately.
