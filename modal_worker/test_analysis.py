"""
Ground-truth tests for the analysis pipeline.

Run:  python3 modal_worker/test_analysis.py

Why this exists
---------------
Every measure-numbering bug in this pipeline was found by a user, reported as a
vague symptom ("the numbers are wrong"), and then diagnosed by hand against a
production take. That is slow and it kept missing regressions — two separate
fixes each introduced a new off-by-one that a test would have caught in seconds.

These tests build a synthetic performance where the correct answer is known
exactly, then assert the invariants the UI depends on. They need no audio, no
API keys and no network: the heavy imports are stubbed, so they run anywhere.

The invariants are the contract:
  1. measure spans tile the timeline  — contiguous, non-overlapping, ascending
  2. label and Loop agree             — every flag's timestamp lies inside the
                                        Loop window of its own measure
  3. Loop covers the whole measure    — including its final note, and never
                                        spills past the labelled measure's end
  4. measure numbers are the score's  — printed numbering survives, multirests
                                        consume their bars
  5. continuous issues merge          — a run of same-type/same-direction
                                        measures becomes one span; unlike or
                                        non-adjacent issues do not merge
"""
import sys, os, types, json, re
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

for _n in ["modal", "torch", "torchcrepe", "librosa", "soundfile", "music21",
           "requests", "scipy", "scipy.signal", "pretty_midi", "mido", "httpx"]:
    sys.modules.setdefault(_n, MagicMock())
import numpy as np                                    # noqa: E402
sys.modules["numpy"] = np


class _FakeMessages:
    """Return one coaching entry per issue index, so nothing is dropped."""
    def create(self, **kw):
        prompt = kw["messages"][0]["content"]
        idxs = [int(x) for x in re.findall(r'^\[(\d+)\] ', prompt, re.M)]
        return types.SimpleNamespace(content=[types.SimpleNamespace(
            text=json.dumps({"coaching": [
                {"i": i, "title": f"Title {i}", "body": "A. B. C."} for i in idxs]}))])


class _FakeAnthropic:
    def __init__(self, **kw):
        self.messages = _FakeMessages()


_anth = types.ModuleType("anthropic")
_anth.Anthropic = _FakeAnthropic
sys.modules["anthropic"] = _anth

import importlib.util                                  # noqa: E402
_spec = importlib.util.spec_from_file_location(
    "worker", os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.py"))
w = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(w)


# ── synthetic score + performance ──────────────────────────────────────────
# Shaped like the real clarinet part: printed numbering starts at 12 (an 11-bar
# multirest precedes it) and there is a 2-bar multirest between 37 and 40.
SCALE = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"]
MEASURE_NUMBERS = list(range(12, 38)) + list(range(40, 51))
BEATS_PER_MEASURE = 3          # 3/4
SEC_PER_BEAT = 0.5             # 120 bpm
START, END = 20, 37


def make_score():
    return {"time_signature": "3/4", "measures": [
        {"number": n, "notes": [
            {"pitch": SCALE[(n * 3 + b) % 8], "beat": float(b + 1), "duration_beats": 1.0}
            for b in range(BEATS_PER_MEASURE)]}
        for n in MEASURE_NUMBERS]}


def make_performance(score, warp=None):
    """Events for measures START..END, laid out at a steady tempo."""
    played = [m for m in score["measures"] if START <= m["number"] <= END]
    evs = []
    for mi, m in enumerate(played):
        for bi, note in enumerate(m["notes"]):
            t = (mi * BEATS_PER_MEASURE + bi) * SEC_PER_BEAT
            if warp:
                t = warp(m["number"], bi, t)
            # Real events carry end_sec (the next onset) and cents_spread; the
            # wrong-note gates read both, so the fixture must have them or it
            # exercises a path production never takes.
            evs.append({"time_sec": t, "end_sec": t + SEC_PER_BEAT,
                        "pitches": [note["pitch"]], "confidence": 90,
                        "cents_offset": 0, "cents_spread": 8, "loudness": "medium"})
    return played, evs


EMPTY_GEMINI = {k: [] for k in (
    "rhythm_issues", "intonation_issues", "wrong_notes_cracks", "dynamics_issues",
    "tone_issues", "posture_issues", "technique_issues")}


def run_pipeline(score, aligned, gemini=None):
    acc = {}
    for e in aligned:
        m, t = e["measure"], e["time_sec"]
        r = acc.setdefault(m, {"start": t, "end": t})
        r["start"], r["end"] = min(r["start"], t), max(r["end"], t)
    items = sorted(acc.items())
    spm = BEATS_PER_MEASURE * SEC_PER_BEAT
    ranges = []
    for i, (m, r) in enumerate(items):
        nxt = items[i + 1] if i + 1 < len(items) else None
        end = (nxt[1]["start"] if nxt[0] == m + 1 else min(nxt[1]["start"], r["start"] + spm)) \
            if nxt else max(r["end"] + spm / BEATS_PER_MEASURE, r["start"] + spm)
        ranges.append({"measure": m, "start": r["start"], "end": max(end, r["start"] + 0.25)})
    return w.compare_and_coach_claude(
        score=score, aligned=aligned, alignment_ranges=ranges, tempo={"bpm": 120},
        piece_title="Test", composer="X", instrument="clarinet",
        gemini_assessment=gemini or dict(EMPTY_GEMINI), anthropic_api_key="k",
        beats_per_measure=BEATS_PER_MEASURE, start_measure=START, end_measure=END,
        dtw_verified=True)


# ── tests ──────────────────────────────────────────────────────────────────
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    return ok


def test_timeline_tiles():
    print("\n[1] measure spans tile the timeline")
    for label, anchors in [
        ("dense",       {m: (m - 20) * 1.5 for m in range(20, 38)}),
        ("sparse",      {20: 0.0, 25: 7.5, 31: 16.5, 37: 25.5}),
        ("single",      {20: 0.0}),
        ("none",        {}),
        ("inverted",    {20: 0.0, 21: 5.0, 22: 1.0, 23: 6.0}),
    ]:
        tl = w.build_measure_timeline(20, 37, anchors, 1.5, last_event_time=27.0, piece_len=33.0)
        ms = [r["measure"] for r in tl]
        check(f"{label}: covers 20..37", ms == list(range(20, 38)))
        check(f"{label}: contiguous", all(abs(a["end"] - b["start"]) < 1e-6 for a, b in zip(tl, tl[1:])))
        check(f"{label}: positive length", all(r["end"] > r["start"] for r in tl))


def test_multirest_time():
    print("\n[2] multirests consume real time")
    tl = w.build_measure_timeline(35, 42, {35: 0.0, 37: 3.0, 40: 7.5, 42: 10.5}, 1.5)
    idx = {r["measure"]: r for r in tl}
    gap = idx[40]["start"] - idx[37]["start"]
    check("m.37 -> m.40 spans 3 measures of time", abs(gap - 4.5) < 0.3, f"{gap:.2f}s")


def test_score_numbering():
    print("\n[3] printed numbering survives, multirest gap intact")
    score = make_score()
    notes = w.flatten_score_notes(score, START, END, BEATS_PER_MEASURE)
    check("window respects start/end measure",
          notes[0]["measure"] == START and notes[-1]["measure"] == END,
          f"m.{notes[0]['measure']}-{notes[-1]['measure']}")
    wide = w.flatten_score_notes(score, 20, 50, BEATS_PER_MEASURE)
    by = {}
    for n in wide:
        by.setdefault(n["measure"], []).append(n["abs_beat"])
    gap = min(by[40]) - min(by[37])
    check("abs_beat crosses the 2-bar rest", abs(gap - 3 * BEATS_PER_MEASURE) < 1e-6, f"{gap} beats")


def test_dtw_labels():
    print("\n[4] DTW labels the played window, not the whole score")
    score = make_score()
    played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    truth = [m["number"] for m in played for _ in m["notes"]]
    got = [e["measure"] for e in aligned]
    exact = sum(1 for a, b in zip(got, truth) if a == b)
    check("every event labelled with its true measure", exact == len(truth), f"{exact}/{len(truth)}")
    check("labels stay inside the played window", min(got) >= START and max(got) <= END,
          f"m.{min(got)}-{max(got)}")


def test_label_matches_loop():
    print("\n[5] label and Loop window agree (the reported bug)")
    score = make_score()
    played, evs = make_performance(score, warp=lambda m, b, t: t + 0.25 if m == 30 else t)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    for e in aligned:
        if e["measure"] in (25, 26, 27):
            e["cents_offset"] = 30
    flags = run_pipeline(score, aligned)
    check("produced flags", len(flags) > 0, f"{len(flags)} flags")

    # Rebuild the same canonical timeline the worker used, and require that each
    # flag's Loop window lies inside the span of the measures it is labelled with.
    # This is the invariant the user was reporting as broken: the clip that plays
    # must be the measure printed on the flag.
    anchors = {}
    for e in aligned:
        m, t = e["measure"], e["time_sec"]
        if m not in anchors or t < anchors[m]:
            anchors[m] = t
    last_t = max(e["time_sec"] for e in aligned)
    tl = w.build_measure_timeline(min(anchors), max(anchors), anchors,
                                  BEATS_PER_MEASURE * SEC_PER_BEAT,
                                  last_event_time=last_t)
    span = {r["measure"]: r for r in tl}

    outside, empty, spill = [], [], []
    for f in flags:
        ts, te = f.get("timestamp_start"), f.get("timestamp_end")
        m0 = f["measure"]
        m1 = f.get("measure_end") or m0
        if ts is None or te is None:
            continue
        if te <= ts:
            empty.append(m0)
            continue
        if m0 not in span:
            continue
        lo, hi = span[m0]["start"], span[m1]["end"] if m1 in span else span[m0]["end"]
        EPS = 0.35                       # tolerance for the anti-bleed margin
        if not (lo - EPS <= ts <= hi + EPS):
            outside.append((m0, round(ts, 2), round(lo, 2), round(hi, 2)))
        if te > hi + EPS:
            spill.append((m0, round(te, 2), round(hi, 2)))

    check("every Loop window is non-empty", not empty, str(empty[:3]))
    check("Loop start lies inside its own measure span", not outside, str(outside[:3]))
    check("Loop does not spill past the labelled measure", not spill, str(spill[:3]))
    check("flag measures inside the played range",
          all(START <= f["measure"] <= END for f in flags),
          str(sorted({f["measure"] for f in flags})))


def test_spans_merge():
    print("\n[6] continuous issues merge; unlike/non-adjacent do not")
    score = make_score()
    played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    # sharp through a consecutive run, plus one isolated sharp measure far away
    for e in aligned:
        if e["measure"] in (24, 25, 26):
            e["cents_offset"] = 32
        elif e["measure"] == 33:
            e["cents_offset"] = 30
    flags = run_pipeline(score, aligned)
    inton = [f for f in flags if f["type"] == "intonation"]
    spans = [(f["measure"], f.get("measure_end")) for f in inton]
    merged_run = any(a == 24 and b == 26 for a, b in spans)
    isolated_kept = any(a == 33 and not b for a, b in spans)
    check("consecutive run 24-26 merged into one span", merged_run, str(spans))
    check("isolated m.33 kept separate", isolated_kept, str(spans))


def test_posture_spans():
    print("\n[7] posture spans the passage instead of one arbitrary measure")
    score = make_score()
    played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    gem = dict(EMPTY_GEMINI)
    gem["posture_issues"] = ["Right shoulder raised throughout the passage"]
    flags = run_pipeline(score, aligned, gemini=gem)
    p = [f for f in flags if f["type"] == "posture"]
    check("posture flag exists", len(p) == 1, f"{len(p)}")
    if p:
        check("posture spans multiple measures",
              (p[0].get("measure_end") or p[0]["measure"]) > p[0]["measure"],
              f"m.{p[0]['measure']}-{p[0].get('measure_end')}")



def test_pathological_alignment_rejected():
    print("\n[8] a lopsided timeline is rejected (the 17-second measure)")
    # Reproduces the shape seen in a real take: a bad score read made DTW dump
    # most of the audio onto m.20, which rendered as one measure spanning
    # 2.0s-19.3s while every other measure was about a second.
    anchors = {20: 2.0, 21: 19.53, 22: 20.04, 23: 20.50, 24: 21.0, 25: 21.5}
    tl = w.build_measure_timeline(20, 25, anchors, 1.5, last_event_time=22.0)
    durs = sorted(r["end"] - r["start"] for r in tl)
    med, worst = durs[len(durs) // 2], durs[-1]
    check("raw builder faithfully reproduces the lopsided input",
          worst > med * 4, f"worst {worst:.1f}s vs median {med:.1f}s")
    # The gate lives in the worker closure; assert the rule it applies.
    span_t = 22.0
    even = {m: (m - 20) * (span_t / 6) for m in range(20, 26)}
    fixed = w.build_measure_timeline(20, 25, even, span_t / 6, last_event_time=span_t)
    fdurs = sorted(r["end"] - r["start"] for r in fixed)
    check("even fallback has no runaway measure",
          fdurs[-1] <= (fdurs[len(fdurs) // 2]) * 4,
          f"worst {fdurs[-1]:.1f}s vs median {fdurs[len(fdurs)//2]:.1f}s")
    check("even fallback still tiles the timeline",
          all(abs(a["end"] - b["start"]) < 1e-6 for a, b in zip(fixed, fixed[1:])))



def test_leading_silence_trimmed():
    print("\n[9] the first measure starts at the music, not the run-up")
    score = make_score()
    played, evs = make_performance(score)
    # 3 seconds of settling before the first note: low-confidence noise, plus one
    # isolated confident click (a key/stand knock) that must not open the piece.
    noise = [{"time_sec": 0.2, "pitches": ["C4"], "confidence": 12, "cents_offset": 0},
             {"time_sec": 0.9, "pitches": ["D4"], "confidence": 18, "cents_offset": 0},
             {"time_sec": 1.4, "pitches": ["E4"], "confidence": 66, "cents_offset": 0}]
    shifted = [{**e, "time_sec": e["time_sec"] + 3.0} for e in evs]
    aligned = w.dtw_align_to_score(noise + shifted, score, START, BEATS_PER_MEASURE, end_measure=END)
    flags = run_pipeline(score, aligned)
    first_note_t = min(e["time_sec"] for e in shifted)
    starts = [f["timestamp_start"] for f in flags if f.get("timestamp_start") is not None]
    check("no flag window opens before the music",
          all(t >= first_note_t - 0.6 for t in starts) if starts else True,
          f"earliest {min(starts):.2f}s vs first note {first_note_t:.2f}s" if starts else "no flags")


def test_measure_from_notes():
    print("\n[10] measure comes from the notes, not elapsed time")
    score = make_score()
    played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    # Every event should report the measure of the score note it was matched to.
    truth = [m["number"] for m in played for _ in m["notes"]]
    got = [e["measure"] for e in aligned]
    check("each event carries its matched note's measure",
          got == truth, f"{sum(1 for a,b in zip(got,truth) if a==b)}/{len(truth)}")
    # After a big hesitation, elapsed time and note content disagree; the note wins.
    warped = w.dtw_align_to_score(
        [{**e, "time_sec": e["time_sec"] + (2.5 if e["time_sec"] > 9.0 else 0.0)} for e in evs],
        score, START, BEATS_PER_MEASURE, end_measure=END)
    late = [e for e in warped if e["time_sec"] > 12.0]
    check("notes after a hesitation keep their true measures",
          all(START <= e["measure"] <= END for e in late), f"{len(late)} events")



def test_loop_always_plays_the_flagged_measure():
    print("\n[11] HARD INVARIANT: Loop plays the measure on the flag")
    score = make_score()
    played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    for e in aligned:
        if e["measure"] in (24, 25, 31):
            e["cents_offset"] = 33

    # Adversarial: Gemini reports measures that are nonsense (way out of range,
    # zero, and one just past the end). These used to resolve to the FIRST
    # measure's window while keeping their bogus label.
    gem = dict(EMPTY_GEMINI)
    gem["rhythm_issues"] = [
        {"measure": 999, "time": "0:05", "description": "rushed"},
        {"measure": 0,   "time": "0:11", "description": "dragged"},
        {"measure": 41,  "time": "0:17", "description": "hesitated"},
    ]
    gem["tone_issues"] = [{"measure": 12345, "time": "0:20", "description": "thin tone"}]
    flags = run_pipeline(score, aligned, gemini=gem)
    check("still produced flags", len(flags) > 0, f"{len(flags)}")

    # Rebuild the canonical timeline exactly as the worker does, then require
    # that the window on every flag really is the measure(s) it claims.
    anchors = {}
    for e in aligned:
        m, t2 = e["measure"], e["time_sec"]
        if e.get("confidence", 100) >= 50 and (m not in anchors or t2 < anchors[m]):
            anchors[m] = t2
    tl = w.build_measure_timeline(min(anchors), max(anchors), anchors,
                                  BEATS_PER_MEASURE * SEC_PER_BEAT,
                                  last_event_time=max(e["time_sec"] for e in aligned))

    def measure_at(t):
        if t < tl[0]["start"]:
            return tl[0]["measure"]
        for r in tl:
            if r["start"] <= t < r["end"]:
                return r["measure"]
        return tl[-1]["measure"]

    mismatches = []
    for f in flags:
        ts, te = f.get("timestamp_start"), f.get("timestamp_end")
        if ts is None or te is None:
            continue
        probe = ts + min(0.05, max(0.0, (te - ts) * 0.1))
        actual = measure_at(probe)
        lo, hi = f["measure"], f.get("measure_end") or f["measure"]
        if not (lo <= actual <= hi):
            mismatches.append((lo, hi, actual, round(ts, 2), round(te, 2)))
    check("EVERY flag's loop plays its own measure", not mismatches,
          f"{len(mismatches)} mismatch(es): {mismatches[:4]}")
    check("no flag escaped the played range",
          all(START <= f["measure"] <= END for f in flags),
          str(sorted({f["measure"] for f in flags})))



def test_runup_excluded_even_when_alignment_rejected():
    print("\n[12] run-up excluded EVEN when the alignment is rejected")
    # The exact production shape: a bad score read made DTW lopsided (spans
    # 0.35s-15.12s), the sanity gate rejected it, and the even fallback then
    # spread measures from t=0 — putting the whole run-up inside m.20's loop.
    score = make_score()
    played, evs = make_performance(score)
    RUNUP = 3.0
    noise = [{"time_sec": 0.3, "pitches": ["C4"], "confidence": 15, "cents_offset": 0},
             {"time_sec": 1.1, "pitches": ["D4"], "confidence": 20, "cents_offset": 0}]
    shifted = [{**e, "time_sec": e["time_sec"] + RUNUP} for e in evs]
    aligned = w.dtw_align_to_score(noise + shifted, score, START, BEATS_PER_MEASURE, end_measure=END)
    # Force the lopsided shape the gate rejects.
    for e in aligned:
        if e["time_sec"] < RUNUP:
            e["measure"] = START
    # Give it something to actually flag, including in the FIRST measure — that is
    # the flag whose loop used to open on the run-up.
    for e in aligned:
        if e["measure"] in (START, 26, 27):
            e["cents_offset"] = 34
    flags = run_pipeline(score, aligned)
    first_note = min(e["time_sec"] for e in shifted)
    starts = [f["timestamp_start"] for f in flags if f.get("timestamp_start") is not None]
    check("produced flags", len(flags) > 0, f"{len(flags)}")
    check("no loop begins before the first note",
          all(t2 >= first_note - 0.6 for t2 in starts) if starts else True,
          f"earliest {min(starts):.2f}s vs first note {first_note:.2f}s" if starts else "none")


def test_measure_starts_on_a_note_not_noise():
    print("\n[13] a measure's loop starts on its note, not a blip inside it")
    score = make_score()
    played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    # Insert a low-confidence blip early inside m.27, before its first real note.
    m27 = [e for e in aligned if e["measure"] == 27]
    blip_t = min(e["time_sec"] for e in m27) - 0.4
    aligned.append({**m27[0], "time_sec": blip_t, "confidence": 12})
    anchors = {}
    for e in aligned:
        if e.get("confidence", 0) >= 50:
            m = e["measure"]
            if m not in anchors or e["time_sec"] < anchors[m]:
                anchors[m] = e["time_sec"]
    tl = w.build_measure_timeline(min(anchors), max(anchors), anchors,
                                  BEATS_PER_MEASURE * SEC_PER_BEAT,
                                  last_event_time=max(e["time_sec"] for e in aligned))
    start27 = [r for r in tl if r["measure"] == 27][0]["start"]
    check("m.27 starts on its note, not the blip",
          start27 > blip_t + 0.2, f"start {start27:.2f}s vs blip {blip_t:.2f}s")



def test_transposing_instrument_not_flagged_as_wrong_notes():
    print("\n[14] a transposing part is not reported as wrong notes")
    score = make_score()
    played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    # A Bb clarinet sounds a major 2nd BELOW the written pitch. Everything is
    # played correctly; only the written/sounding convention differs.
    for e in aligned:
        base = w.midi_from_name(e["pitches"][0])
        e["midi_raw"] = e["midi"] = base - 2
        e["confidence"] = 90
    cands = w.find_wrong_note_candidates(aligned, score)
    check("correct playing on a transposing part yields no wrong notes",
          len(cands) == 0, f"{len(cands)} candidate(s)")

    # Genuine wrong notes must still be caught: shift only a few, scattered.
    for e in aligned:
        if e["measure"] in (26, 31):
            e["midi_raw"] = e["midi"] = e["midi"] + 5
    cands2 = w.find_wrong_note_candidates(aligned, score)
    check("genuinely wrong notes are still caught", len(cands2) > 0, f"{len(cands2)} candidate(s)")


def test_wrong_notes_reject_false_positives():
    print("\n[18] wrong-note flags: the ways they used to be wrong")
    score = make_score()

    def perf():
        played, evs = make_performance(score)
        al = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
        for e in al:
            e["midi_raw"] = e["midi"] = w.midi_from_name(e["pitches"][0])
            e["confidence"] = 90
            e["cents_spread"] = 8
        return al

    base = perf()
    check("clean playing produces no wrong notes at all",
          len(w.find_wrong_note_candidates(base, score)) == 0)

    # A low-confidence reading is CREPE failing to track, not a wrong note.
    al = perf()
    for e in al:
        if e["measure"] == 26:
            e["midi_raw"] = e["midi"] = e["midi"] + 5
            e["confidence"] = 40
    check("a low-confidence reading is not called a wrong note",
          len(w.find_wrong_note_candidates(al, score)) == 0)

    # A blip: right measure, wildly wrong pitch, but 30ms long. Key click, bow
    # scrape, page turn — not a note the student played.
    al = perf()
    for e in al:
        if e["measure"] == 26:
            e["midi_raw"] = e["midi"] = e["midi"] + 5
            e["end_sec"] = e["time_sec"] + 0.03
    check("a 30ms blip is not called a wrong note",
          len(w.find_wrong_note_candidates(al, score)) == 0)

    # A sliding / unstable pitch has no single pitch to judge as wrong.
    al = perf()
    for e in al:
        if e["measure"] == 26:
            e["midi_raw"] = e["midi"] = e["midi"] + 5
            e["cents_spread"] = 120
    check("an unstable pitch reading is not called a wrong note",
          len(w.find_wrong_note_candidates(al, score)) == 0)

    # Octave displacement is a different mistake, not a wrong note.
    al = perf()
    for e in al:
        if e["measure"] == 26:
            e["midi_raw"] = e["midi"] = e["midi"] + 12
    check("an octave displacement is not called a wrong note",
          len(w.find_wrong_note_candidates(al, score)) == 0)

    # A uniform offset is absorbed by the transposition guard before anything
    # is judged wrong (this is the transposing-instrument case from [14]).
    al = perf()
    for e in al:
        e["midi_raw"] = e["midi"] = e["midi"] + 5
    check("a uniform offset is read as transposition, not wrong notes",
          len(w.find_wrong_note_candidates(al, score)) == 0)

    # THE headline guard, and the one the user actually hit. A misread score or
    # a bad alignment scatters mismatches with NO consistent interval, so the
    # transposition guard cannot absorb them and every one looks like a wrong
    # note. Report nothing rather than a page of confident false accusations.
    #
    # Built on a purpose-made sparse score rather than the shared scale fixture:
    # on diatonic scale writing a shifted note usually lands on another scale
    # tone in the same bar, so corrupting half the notes only makes ~15% of them
    # LOOK wrong and the gate correctly does not fire. Measuring that is what
    # showed the shared fixture was the wrong vehicle for this test.
    sparse = {"time_signature": "4/4", "measures": [
        {"number": m, "notes": [{"pitch": "C4", "beat": 1.0, "duration_beats": 2.0},
                                {"pitch": "G4", "beat": 3.0, "duration_beats": 2.0}]}
        for m in range(1, 21)]}

    def sparse_perf(corrupt_every=0):
        evs, t = [], 0.0
        for i, m in enumerate(sparse["measures"]):
            for j, n in enumerate(m["notes"]):
                midi = w.midi_from_name(n["pitch"])
                if corrupt_every and (i * 2 + j) % corrupt_every == 0:
                    # Varied, with no common interval (so the transposition
                    # guard cannot absorb them), and each ≥2 semitones from BOTH
                    # C4 and G4 — a note 1 semitone off is intonation, not a
                    # wrong note, and is deliberately not flagged as one.
                    midi += (3, 10, 4, 9)[(i + j) % 4]
                evs.append({"measure": m["number"], "time_sec": t, "end_sec": t + 1.0,
                            "midi_raw": midi, "midi": midi, "confidence": 90,
                            "cents_spread": 8, "pitch_hz": 440.0})
                t += 1.0
        return evs

    check("the sparse fixture is clean when uncorrupted",
          len(w.find_wrong_note_candidates(sparse_perf(), sparse)) == 0)
    cands = w.find_wrong_note_candidates(sparse_perf(corrupt_every=2), sparse)
    check("a scattered broken read is suppressed, not reported as many wrong notes",
          len(cands) == 0, f"{len(cands)} candidate(s)")
    # One genuine mistake in twenty bars is well under the gate and must survive.
    cands = w.find_wrong_note_candidates(sparse_perf(corrupt_every=40), sparse)
    check("an isolated wrong note survives the sanity gate",
          len(cands) == 1, f"{len(cands)} candidate(s)")

    # ...but suppression must not swallow a realistic number of real mistakes.
    al = perf()
    for e in al:
        if e["measure"] in (26, 31):
            e["midi_raw"] = e["midi"] = e["midi"] + 5
    cands = w.find_wrong_note_candidates(al, score)
    check("a few real wrong notes still get through",
          len(cands) > 0, f"{len(cands)} candidate(s)")
    check("output stays small enough to be believable", len(cands) <= 6)
    check("evidence names both what was played and what was written",
          all("score has" in c and "CREPE detected" in c for c in cands))


def test_bflat_clarinet_transposition():
    print("\n[19] a B-flat clarinet part is never reported as wrong notes")
    score = make_score()
    played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    # Correct playing: a Bb clarinet SOUNDS a major 2nd below the written pitch.
    for e in aligned:
        e["midi_raw"] = e["midi"] = w.midi_from_name(e["pitches"][0]) - 2
        e["confidence"] = 90
        e["cents_spread"] = 8

    # The exact string the form stores and the DB holds.
    for name in ("Clarinet (B\u266d)", "clarinet", "Bb Clarinet", "Clarinet (Bb)"):
        check(f"{name!r} resolves to -2 semitones",
              w.transpose_for_instrument(name) == -2)

    for name in ("Clarinet (B\u266d)", "clarinet", ""):
        cands = w.find_wrong_note_candidates(aligned, score, name)
        check(f"correct Bb playing yields no wrong notes (instrument={name!r})",
              len(cands) == 0, f"{len(cands)} candidate(s)")

    # The decision must be visible on the take, not a guess.
    w.find_wrong_note_candidates(aligned, score, "Clarinet (B\u266d)")
    check("the transposition decision is recorded for pipeline_debug",
          "applied=-2" in w._LAST_TRANSPOSE_DEBUG, w._LAST_TRANSPOSE_DEBUG)

    # Declared and measured disagreeing means we cannot tell which reading is
    # right. Accusing the student either way is worse than staying silent.
    concert = []
    for e in aligned:
        c = dict(e)
        c["midi_raw"] = c["midi"] = w.midi_from_name(e["pitches"][0])  # sounds as written
        concert.append(c)
    cands = w.find_wrong_note_candidates(concert, score, "Clarinet (B\u266d)")
    check("a declared/measured conflict suppresses wrong notes entirely",
          len(cands) == 0, f"{len(cands)} candidate(s)")
    check("the conflict is recorded for pipeline_debug",
          "CONFLICT" in w._LAST_TRANSPOSE_DEBUG, w._LAST_TRANSPOSE_DEBUG)

    # A real mistake on a declared Bb clarinet must still be caught.
    for e in aligned:
        if e["measure"] in (26, 31):
            e["midi_raw"] = e["midi"] = e["midi"] + 5
    cands = w.find_wrong_note_candidates(aligned, score, "Clarinet (B\u266d)")
    check("a real wrong note on a Bb part is still caught",
          len(cands) > 0, f"{len(cands)} candidate(s)")


def test_form_time_signature_wins():
    print("\n[15] the form's time signature beats the vision read")
    # beats_per_measure drives the whole beat axis; 3/4 must yield 3, not the
    # 2 a misread page produced.
    check("3/4 -> 3 beats", w.beats_per_measure_from_time_sig("3/4") == 3)
    check("2/4 -> 2 beats", w.beats_per_measure_from_time_sig("2/4") == 2)
    check("6/8 compound -> 2 beats", w.beats_per_measure_from_time_sig("6/8") == 2)
    score = make_score()
    notes3 = w.flatten_score_notes(score, START, END, 3)
    notes2 = w.flatten_score_notes(score, START, END, 2)
    b3 = [n["abs_beat"] for n in notes3 if n["measure"] == START + 1][0]
    b2 = [n["abs_beat"] for n in notes2 if n["measure"] == START + 1][0]
    check("beats-per-measure changes the beat axis (so a misread corrupts it)",
          b3 != b2, f"3/4 -> {b3}, 2/4 -> {b2}")



def test_pitch_measurement_is_unbiased():
    print("\n[16] pitch reading: vibrato must not read sharp, attacks must not read flat")
    import numpy as np
    A4 = 440.0

    # A perfectly centred vibrato, ±40¢ at A440. The true pitch is A440 exactly.
    # Averaging in Hz lands sharp of centre (pitch is logarithmic in frequency),
    # but measured: only ~0.2¢ at this depth. Asserting the DIRECTION and the
    # smallness on purpose — an earlier draft of this comment claimed the Hz
    # bias was inventing sharp flags, and that was simply not true. The wins
    # below (core trimming, median) are the ones that carry real weight.
    t   = np.linspace(0, 4 * np.pi, 60)
    vib = A4 * 2.0 ** ((40.0 * np.sin(t)) / 1200.0)
    conf = np.full(60, 0.9)

    naive_hz    = float(np.average(vib, weights=conf))
    naive_cents = 1200.0 * np.log2(naive_hz / A4)
    midi, hz, spread = w.measure_note_pitch(vib, conf)
    ours_cents  = 1200.0 * np.log2(hz / A4)

    check("Hz-averaging bias is sharp but negligible, not a flag source",
          0 < naive_cents < 1.0, f"{naive_cents:+.2f}¢ — below any threshold")
    check("log-domain median centres the vibrato",
          abs(ours_cents) < 3.0, f"{ours_cents:+.1f}¢")
    check("wide vibrato is reported as a wide spread, so it won't be flagged",
          spread > 35, f"{spread:.0f}¢ spread")

    # A note that scoops in 60¢ flat and settles: the sustained pitch is the
    # true one. Including the attack drags the reading flat and would flag a
    # note the listener hears as in tune.
    scoop = np.concatenate([
        A4 * 2.0 ** (np.linspace(-60, 0, 10) / 1200.0),   # attack scoop
        np.full(40, A4),                                   # sustained core
    ])
    conf_s = np.full(50, 0.9)
    naive_scoop = 1200.0 * np.log2(float(np.average(scoop, weights=conf_s)) / A4)
    _, hz_s, _  = w.measure_note_pitch(scoop, conf_s)
    ours_scoop  = 1200.0 * np.log2(hz_s / A4)
    check("a scooped attack does not drag the reading flat",
          abs(ours_scoop) < 2.0, f"{ours_scoop:+.1f}¢ (whole-window {naive_scoop:+.1f}¢)")

    # One octave-jump frame (CREPE's classic failure) must not move the note.
    # This is where the median genuinely earns its place: a mean would drag the
    # reading by tens of cents, straight through the flag threshold.
    octave_err = np.full(40, A4); octave_err[17] = A4 / 2
    conf_o = np.full(40, 0.9)
    mean_err = 1200.0 * np.log2(float(np.average(octave_err, weights=conf_o)) / A4)
    _, hz_o, _ = w.measure_note_pitch(octave_err, conf_o)
    check("a single octave-error frame does not move the note",
          abs(1200.0 * np.log2(hz_o / A4)) < 2.0,
          f"median {1200.0 * np.log2(hz_o / A4):+.1f}¢ vs mean {mean_err:+.1f}¢")


def test_tuning_center_normalisation():
    print("\n[17] a sharp-tuned instrument is one tuning note, not a flag per bar")
    # Every note 14¢ sharp of A=440 but perfectly in tune with itself — a player
    # tuned to ~A=443. Previously this flagged every single measure.
    evs = [{"cents_offset": 14, "confidence": 90, "cents_spread": 5}
           for _ in range(20)]
    center = w.apply_tuning_center(evs)
    check("the tuning centre is detected", abs(center - 14) < 1.0, f"{center:+.1f}¢")
    check("consistently-tuned notes read as in tune with themselves",
          all(abs(e["cents_offset"]) <= 2 for e in evs),
          f"max {max(abs(e['cents_offset']) for e in evs)}¢")
    check("the raw offset is preserved for the global tuning note",
          all(e["cents_raw"] == 14 for e in evs))

    # Same player, but one note genuinely 30¢ sharper than the rest. That note
    # must still be caught — normalisation must not launder real problems.
    evs2 = [{"cents_offset": 14, "confidence": 90, "cents_spread": 5}
            for _ in range(20)]
    evs2[7]["cents_offset"] = 44
    w.apply_tuning_center(evs2)
    check("a genuinely out-of-tune note still stands out",
          evs2[7]["cents_offset"] >= 25, f"{evs2[7]['cents_offset']}¢ relative")

    # Too few notes to establish a reference: leave the readings alone rather
    # than inventing a centre from three samples.
    evs3 = [{"cents_offset": 20, "confidence": 90, "cents_spread": 5}
            for _ in range(3)]
    check("no centre is inferred from too few notes",
          w.apply_tuning_center(evs3) == 0.0)

    # Unstable / low-confidence notes must not define the reference.
    evs4 = ([{"cents_offset": 2,  "confidence": 90, "cents_spread": 5} for _ in range(12)]
            + [{"cents_offset": 45, "confidence": 20, "cents_spread": 90} for _ in range(12)])
    c4 = w.apply_tuning_center(evs4)
    check("junk frames do not define the tuning reference",
          abs(c4 - 2) < 2.0, f"{c4:+.1f}¢")


def test_pause_before_playing_is_not_a_late_downbeat():
    print("\n[20] the pause before the first note is not a late downbeat")
    score = make_score()
    played, evs = make_performance(score)

    # The player settles, breathes, then plays perfectly in tempo. The silence
    # before the first note must not be scored at all.
    LEAD = 2.4
    for e in evs:
        e["time_sec"] += LEAD
        e["end_sec"] = e["time_sec"] + SEC_PER_BEAT
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    rep = w.analyze_timing_vs_score(aligned, score, BEATS_PER_MEASURE)
    check("timing analysis runs", rep.get("ok") is not False, rep.get("reason", ""))
    late = {m: p for m, p in (rep.get("placement") or {}).items() if p["direction"] == "late"}
    check("a clean take after a long pause has no late measures",
          not late, f"{late}")

    # Same take, but a stray click 1.2s before the real entry. It must not
    # become the downbeat and make every real note look late.
    played2, evs2 = make_performance(score)
    for e in evs2:
        e["time_sec"] += LEAD
        e["end_sec"] = e["time_sec"] + SEC_PER_BEAT
    evs2.insert(0, {"time_sec": LEAD - 1.2, "end_sec": LEAD - 1.1,
                    "pitches": ["C4"], "confidence": 80, "cents_offset": 0,
                    "cents_spread": 8, "loudness": "soft"})
    aligned2 = w.dtw_align_to_score(evs2, score, START, BEATS_PER_MEASURE, end_measure=END)
    rep2 = w.analyze_timing_vs_score(aligned2, score, BEATS_PER_MEASURE)
    late2 = {m: p for m, p in (rep2.get("placement") or {}).items() if p["direction"] == "late"}
    check("a stray click before the entry does not create late measures",
          not late2, f"{late2}")

    # A REAL late entry mid-piece must still be caught, or the guard has just
    # disabled the finding.
    played3, evs3 = make_performance(
        score, warp=lambda m, bi, t: t + (0.42 if m == 29 else 0.0))
    for e in evs3:
        e["end_sec"] = e["time_sec"] + SEC_PER_BEAT
    aligned3 = w.dtw_align_to_score(evs3, score, START, BEATS_PER_MEASURE, end_measure=END)
    rep3 = w.analyze_timing_vs_score(aligned3, score, BEATS_PER_MEASURE)
    late3 = {m: p for m, p in (rep3.get("placement") or {}).items() if p["direction"] == "late"}
    check("a genuinely late measure mid-piece is still flagged",
          29 in late3, f"late measures: {sorted(late3)}")


def test_timeline_starts_on_the_first_matched_note():
    print("\n[21] the measure timeline opens on the first note, not the run-up")
    score = make_score()
    played, evs = make_performance(score)
    LEAD = 3.0
    for e in evs:
        e["time_sec"] += LEAD
        e["end_sec"] = e["time_sec"] + SEC_PER_BEAT
    # noise before the entry: confident, but matches nothing in the score
    evs.insert(0, {"time_sec": 0.6, "end_sec": 0.7, "pitches": ["C4"],
                   "confidence": 90, "cents_offset": 0, "cents_spread": 8})
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    flags = run_pipeline(score, aligned)
    starts = [f["timestamp_start"] for f in flags if f.get("timestamp_start") is not None]
    first_note = min(e["time_sec"] for e in aligned if e.get("score_idx") is not None)
    check("no loop window opens before the first matched note",
          all(s >= first_note - 0.3 for s in starts),
          f"earliest {min(starts):.2f}s vs first note {first_note:.2f}s" if starts else "no flags")


def _timed_score(time_sig, notes_per_measure, ql_per_note, bpm_measure, n_measures=10):
    """A score whose notes all share one written value, in a given metre."""
    return {"time_signature": time_sig, "measures": [
        {"number": 1 + i, "notes": [
            {"pitch": SCALE[(i * notes_per_measure + b) % 8],
             "beat": 1.0 + b * (bpm_measure / notes_per_measure),
             "duration_beats": ql_per_note}
            for b in range(notes_per_measure)]}
        for i in range(n_measures)]}


def _play(score, bpm_measure, sec_per_beat, hold=None):
    """Perform the score exactly in tempo, on the notated beat axis."""
    evs = []
    for m in score["measures"]:
        for n in m["notes"]:
            abs_beat = (m["number"] - 1) * bpm_measure + (n["beat"] - 1.0)
            t = abs_beat * sec_per_beat
            evs.append({"time_sec": t, "end_sec": t + sec_per_beat,
                        "pitches": [n["pitch"]], "confidence": 90,
                        "cents_offset": 0, "cents_spread": 8})
    if hold:
        evs = hold(evs)
    return evs


def test_note_values_and_rests():
    print("\n[22] note values: rests, compound metre and cut time")

    def durations_for(score, bpm_measure, spb, warp=None):
        evs = _play(score, bpm_measure, spb, warp)
        al = w.dtw_align_to_score(evs, score, 1, bpm_measure,
                                  end_measure=score["measures"][-1]["number"])
        rep = w.analyze_timing_vs_score(al, score, bpm_measure)
        return rep, (rep.get("durations") or {})

    # 1. A quarter followed by a quarter REST. parse_musicxml drops rests, so the
    #    gap is 2 beats against a 1-beat value — this used to read as "held twice
    #    as long" on a perfectly played bar.
    rest_score = {"time_signature": "4/4", "measures": [
        {"number": 1 + i, "notes": [
            {"pitch": SCALE[(i * 2) % 8],     "beat": 1.0, "duration_beats": 1.0},
            {"pitch": SCALE[(i * 2 + 1) % 8], "beat": 3.0, "duration_beats": 1.0},
        ]} for i in range(10)]}
    rep, dur = durations_for(rest_score, 4, 0.5)
    check("a note followed by a rest is not called 'held too long'",
          not dur, f"{ {m: d['direction'] for m, d in dur.items()} }")

    # 2. Compound metre. A dotted-quarter beat is 1.5 quarterLengths, so treating
    #    duration_beats as beats made every 6/8 note look ~33% short.
    rep, dur = durations_for(_timed_score("6/8", 2, 1.5, 2), 2, 0.6)
    check("6/8 dotted-quarter beats are not called 'too short'",
          not dur, f"{ {m: d['direction'] for m, d in dur.items()} }")

    # 3. Cut time. A half-note beat is 2 quarterLengths -> everything looked 2x long.
    rep, dur = durations_for(_timed_score("2/2", 2, 2.0, 2), 2, 0.9)
    check("2/2 half-note beats are not called 'too long'",
          not dur, f"{ {m: d['direction'] for m, d in dur.items()} }")

    # 4. A REAL over-hold must still be caught, or the fix has just muted the finding.
    def stretch(evs):
        # delay everything from the 7th note on, so note 6 gets far too much time
        return [dict(e, time_sec=e["time_sec"] + (0.55 if i >= 6 else 0.0))
                for i, e in enumerate(evs)]
    rep, dur = durations_for(_timed_score("4/4", 4, 1.0, 4), 4, 0.5, warp=stretch)
    longs = [m for m, d in dur.items() if d["direction"] == "long"]
    check("a note genuinely given too much time is still flagged",
          longs, f"durations={ {m: d['direction'] for m, d in dur.items()} }")
    if longs:
        d = dur[longs[0]]
        check("the flag names the written value and its beat count",
              d.get("value") and d.get("beats_written"),
              f"{d.get('value')!r}, written {d.get('beats_written')} beats")


def test_note_value_naming():
    print("\n[23] written values are named correctly")
    for ql, name in [(4.0, 'whole note'), (3.0, 'dotted half note'), (2.0, 'half note'),
                     (1.5, 'dotted quarter note'), (1.0, 'quarter note'),
                     (0.75, 'dotted eighth note'), (0.5, 'eighth note'),
                     (0.25, 'sixteenth note')]:
        check(f"{ql:g} quarterLengths -> {name}", w.note_value_name(ql) == name,
              w.note_value_name(ql))
    check("an unrecognised value names nothing rather than guessing",
          w.note_value_name(1.234) == "")
    for ts, expect in [('4/4', 1.0), ('3/4', 1.0), ('2/2', 2.0),
                       ('6/8', 1.5), ('12/8', 1.5), ('3/8', 0.5)]:
        check(f"{ts} -> {expect:g} quarterLengths per beat",
              abs(w.quarter_lengths_per_beat(ts) - expect) < 1e-9,
              str(w.quarter_lengths_per_beat(ts)))
    # a measure's beats x quarterLengths-per-beat must equal its total length
    for ts, total in [('4/4', 4.0), ('3/4', 3.0), ('2/2', 4.0), ('6/8', 3.0), ('12/8', 6.0)]:
        got = w.beats_per_measure_from_time_sig(ts) * w.quarter_lengths_per_beat(ts)
        check(f"{ts} measure totals {total:g} quarterLengths", abs(got - total) < 1e-9, str(got))


def test_hold_length_is_measured_not_inferred():
    print("\n[24] duration measures the HOLD, not the gap to the next note")
    score = _timed_score("4/4", 4, 1.0, 4)          # all quarter notes
    SPB = 0.5

    def run(mut):
        evs = _play(score, 4, SPB)
        for e in evs:
            e["sound_end"] = e["time_sec"] + SPB     # held its full value
        mut(evs)
        al = w.dtw_align_to_score(evs, score, 1, 4,
                                  end_measure=score["measures"][-1]["number"])
        rep = w.analyze_timing_vs_score(al, score, 4)
        return rep.get("durations") or {}

    check("evenly held quarters produce no duration flags", not run(lambda e: None))

    # Clipped: released a third of the way through, but the NEXT note still
    # arrives on time. Invisible to a gap-based check by construction.
    def clip(evs):
        evs[5]["sound_end"] = evs[5]["time_sec"] + SPB * 0.3
    d = run(clip)
    check("a note clipped short is caught even when the next note is on time",
          any(v["direction"] == "short" for v in d.values()),
          f"{ {m: v['direction'] for m, v in d.items()} }")
    if d:
        v = next(iter(d.values()))
        check("the finding says it measured the hold", v.get("measured") == "held",
              str(v.get("measured")))

    # Over-held. On a monophonic instrument you cannot sound past the next
    # attack, so over-holding physically shows up as the NEXT note arriving
    # late — the note keeps sounding right up to it. Modelling it any other way
    # describes something a clarinet cannot do.
    def overhold(evs):
        for e in evs[10:]:
            e["time_sec"] += SPB * 0.9
            e["sound_end"] += SPB * 0.9
        evs[9]["sound_end"] = evs[10]["time_sec"]      # sounds until the next attack
    d = run(overhold)
    check("a note held past its value is caught (the next note is displaced late)",
          any(v["direction"] == "long" for v in d.values()),
          f"{ {m: v['direction'] for m, v in d.items()} }")

    # A note cannot sound past the next attack on a monophonic instrument.
    def impossible(evs):
        for e in evs:
            e["sound_end"] = e["time_sec"] + SPB * 8
    d = run(impossible)
    check("a release running past the next attack is clamped, not reported as 8x",
          all(v["ratio"] <= 2.2 for v in d.values()),
          f"ratios={sorted(v['ratio'] for v in d.values())[-3:]}")


def test_staccato_is_not_clipped():
    print("\n[25] staccato is written short on purpose")
    score = _timed_score("4/4", 4, 1.0, 4)
    for m in score["measures"]:
        for n in m["notes"]:
            n["articulation"] = "staccato"
    SPB = 0.5
    evs = _play(score, 4, SPB)
    for e in evs:
        e["sound_end"] = e["time_sec"] + SPB * 0.35   # correct staccato
    al = w.dtw_align_to_score(evs, score, 1, 4, end_measure=score["measures"][-1]["number"])
    d = (w.analyze_timing_vs_score(al, score, 4).get("durations") or {})
    check("correctly played staccato is not called 'too short'",
          not any(v["direction"] == "short" for v in d.values()),
          f"{ {m: v['direction'] for m, v in d.items()} }")


def test_placement_threshold_scales_with_tempo():
    print("\n[26] lateness is judged against the beat, not a fixed 110ms")
    score = _timed_score("4/4", 4, 1.0, 4)

    def late_measures(spb, shift):
        evs = _play(score, 4, spb)
        for e in evs:
            e["sound_end"] = e["time_sec"] + spb
        # push one whole measure late
        for e in evs:
            if 12 <= (e["time_sec"] / spb) < 16:
                e["time_sec"] += shift
                e["sound_end"] += shift
        al = w.dtw_align_to_score(evs, score, 1, 4, end_measure=score["measures"][-1]["number"])
        rep = w.analyze_timing_vs_score(al, score, 4)
        return {m for m, p in (rep.get("placement") or {}).items() if p["direction"] == "late"}

    # 60bpm: 130ms is under a fifth of a beat — inaudible, and used to flag.
    check("at a slow tempo a 130ms shift is not called late",
          not late_measures(1.0, 0.13), "flagged")
    # Same 130ms at 200bpm is nearly half a beat — that must still be caught.
    check("at a fast tempo the same shift IS caught",
          late_measures(0.3, 0.13), "not flagged")


def test_note_ordinals_are_corrected():
    print("\n[27] 'first note' is corrected to the note that actually sounded")
    score = make_score()
    played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    # Gemini claims the crack is on the first note of m.26; the timestamp lands
    # on the third note of that bar.
    third = sorted({(e["time_sec"], e["score_idx"]) for e in aligned
                    if e["measure"] == 26 and e.get("score_idx") is not None})
    seen, order = set(), []
    for t, si in third:
        if si in seen: continue
        seen.add(si); order.append(t)
    gemini = dict(EMPTY_GEMINI)
    gemini["wrong_notes_cracks"] = [{
        "measure": 26, "timestamp": f"0:{int(order[2]):02d}",
        "detail": "A reed crack on the first note of the phrase.",
    }]
    flags = run_pipeline(score, aligned, gemini)
    texts = " ".join((f.get("detail") or "") + " " + (f.get("raw_detail") or "")
                     for f in flags)
    check("the wrong ordinal does not survive into the flag text",
          "first note" not in texts.lower(),
          [t for t in texts.split('.') if 'note' in t.lower()][:2])


def test_no_undefined_names():
    print("\n[0] static check: no undefined names in worker.py")
    # A NameError in a branch the tests do not execute still reaches production.
    # `name 'time_sig_hint' is not defined` shipped exactly that way — the name
    # belonged to a different function, syntax was valid, and every test passed
    # because none of them run run_full_analysis (it needs audio and API keys).
    # pyflakes reads the whole module, including code no test touches.
    import subprocess
    worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.py")
    try:
        out = subprocess.run([sys.executable, "-m", "pyflakes", worker],
                             capture_output=True, text=True, timeout=120)
    except Exception as e:                                        # noqa: BLE001
        check("pyflakes available", False, f"{type(e).__name__}: {e}")
        return
    if "No module named" in (out.stderr or ""):
        check("pyflakes installed (pip install pyflakes)", False, out.stderr.strip()[:80])
        return
    undefined = [ln for ln in (out.stdout or "").splitlines() if "undefined name" in ln]
    check("no undefined names anywhere in worker.py", not undefined,
          "; ".join(u.split("worker.py:")[-1] for u in undefined[:4]))


def test_squeaks_separated_from_leaps_by_timbre():
    print("\n[28] squeaks are told from written leaps by TIMBRE, not pitch alone")

    def line(**overrides):
        """Eight steady C4s in m.20; index 4 is the event under test."""
        evs = [{"measure": 20, "time_sec": i * 0.5, "midi_raw": 60, "midi": 60,
                "held_sec": 0.45, "cents_spread": 6, "confidence": 95,
                "flatness": 0.010} for i in range(8)]
        evs[4].update(overrides)
        return evs

    # A real squeak: a 12th up, brief, pitch will not hold still, noisy spectrum.
    got = w.find_crack_candidates(line(midi_raw=79, midi=79, held_sec=0.15,
                                       cents_spread=60, confidence=40, flatness=0.055))
    check("a real squeak is still detected", len(got) == 1 and "measure 20" in got[0],
          str(got))

    # Same pitch geometry, clean tone — a WRITTEN brief leap. This is the case
    # the old pitch-only detector called a crack.
    got = w.find_crack_candidates(line(midi_raw=79, midi=79, held_sec=0.20,
                                       cents_spread=5, confidence=96, flatness=0.010))
    check("a clean brief leap is NOT called a squeak", got == [], str(got))

    # Timbre unmeasurable — the geometric evidence must still stand alone. This
    # guards the failure mode where a missing field silently disables a detector.
    evs = line(midi_raw=79, midi=79, held_sec=0.15)
    for e in evs:
        for k in ("cents_spread", "confidence", "flatness"):
            e.pop(k, None)
    check("with no timbre data the geometric test still fires (not muted)",
          len(w.find_crack_candidates(evs)) == 1, str(w.find_crack_candidates(evs)))

    # A split/airy note that never leaves its own pitch — invisible to every
    # pitch-based test there is.
    got = w.find_crack_candidates(line(held_sec=0.20, confidence=40, flatness=0.040))
    check("an airy note with no pitch jump is caught",
          len(got) == 1 and "airy" in got[0], str(got))

    check("a clean line produces no crack flags", w.find_crack_candidates(line()) == [],
          str(w.find_crack_candidates(line())))

    # Unknown must stay distinguishable from a real negative.
    check("looks_like_squeak returns None (not False) when unmeasurable",
          w.looks_like_squeak({"held_sec": 0.15}, None) is None)
    check("a sustained note is never a squeak, however unstable",
          w.looks_like_squeak({"held_sec": 1.2, "cents_spread": 99, "confidence": 10},
                              None) is False)
    check("flatness baseline requires enough notes to be meaningful",
          w.take_flatness_median([{"flatness": 0.01}] * 3) is None)


def test_crack_routing_ignores_gemini_wording():
    print("\n[29] crack confirmation does not depend on Gemini's word choice")
    score = make_score()
    _played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    for e in aligned:
        e.setdefault("flatness", 0.010)
        if e.get("midi_raw") is None:
            e["midi_raw"] = w.midi_from_name(e["pitches"][0])

    # Plant one unmistakable squeak in m.25.
    for e in aligned:
        if e["measure"] == 25:
            e.update({"midi_raw": (e["midi_raw"] or 60) + 19, "held_sec": 0.15,
                      "cents_spread": 60, "confidence": 40, "flatness": 0.060})
            break
    check("the planted squeak is visible to the detector",
          any("measure 25" in c for c in w.find_crack_candidates(aligned)),
          str(w.find_crack_candidates(aligned))[:120])

    # Gemini describes it without using any of the old keyword list, and makes a
    # SPECIFIC pitch claim that no pitch detector corroborates.
    gem = dict(EMPTY_GEMINI)
    gem["wrong_notes_cracks"] = [
        {"measure": 25, "description": "GEMINI_PROSE the tone splinters, you played F not E",
         "timestamp": "0:07"}]
    flags = run_pipeline(score, aligned, gem)
    check("the measure is still reported (the finding is not lost)",
          any(f.get("measure") == 25 for f in flags),
          f"measures={[f.get('measure') for f in flags][:8]}")

    # …but it must be reported with CREPE's evidence, not Gemini's uncorroborated
    # pitch claim. Crack evidence says a note broke; it says nothing about WHICH
    # pitch was played, and the flag ships to the student at confidence 92.
    prose = [f for f in flags if "GEMINI_PROSE" in str(f.get("raw_detail") or "")]
    check("Gemini's uncorroborated pitch claim is NOT surfaced", not prose,
          str([f.get("raw_detail") for f in prose])[:120])
    crepe = [f for f in flags if str(f.get("raw_detail") or "").startswith("crack |")]
    check("CREPE's own crack evidence is what the student sees", bool(crepe),
          str([f.get("raw_detail") for f in flags])[:120])


def test_loudness_measures_the_note_not_the_attack():
    print("\n[30] loudness is measured over the note BODY, not the attack transient")
    SR = 22050
    N = SR * 10

    # A long note: window must skip the attack and sit inside the note.
    s, e = w.note_body_window(1.0, 3.0, 3.0, SR, N)
    check("long note: attack is excluded", s >= int(1.030 * SR), f"s={s / SR:.3f}s")
    check("long note: window stays inside the note", e <= int(3.0 * SR), f"e={e / SR:.3f}s")
    check("long note: window is capped, not the whole note",
          (e - s) <= int(0.51 * SR), f"len={(e - s) / SR:.3f}s")
    check("long note: window sits in the middle of the body",
          s > int(1.5 * SR), f"s={s / SR:.3f}s")

    # A very short note has no body separable from its attack — measure anyway.
    s, e = w.note_body_window(1.0, 1.08, 1.5, SR, N)
    check("short note still yields a usable window", e > s and (e - s) >= int(0.04 * SR),
          f"len={(e - s) / SR:.3f}s")

    # Never bleed into the next attack.
    s, e = w.note_body_window(1.0, 5.0, 1.4, SR, N)
    check("window never runs past the next onset", e <= int(1.4 * SR), f"e={e / SR:.3f}s")

    # Missing release data must not produce an empty window.
    s, e = w.note_body_window(1.0, None, None, SR, N)
    check("missing sound_end still yields a non-empty window", e > s, f"{s}..{e}")

    # Clamped to the buffer at the very end of a take — and still long enough to
    # mean something. A one-sample RMS is a garbage dB value that would feed
    # straight into the dynamics comparison.
    s, e = w.note_body_window(9.99, 12.0, None, SR, N)
    check("window is clamped to the audio buffer", e <= N and s >= 0, f"{s}..{e} of {N}")
    check("clamped window is still a usable length", (e - s) >= int(0.049 * SR),
          f"len={(e - s) / SR:.3f}s")

    # ── The defect itself, demonstrated ────────────────────────────────────
    # Note A is marked p but hard-tongued: big attack, quiet body.
    # Note B is marked f but slurred:      soft attack, loud body.
    def note(attack_amp, body_amp, at):
        y = np.zeros(N, dtype=float)
        a0 = int(at * SR)
        y[a0:a0 + int(0.10 * SR)] = attack_amp
        y[a0 + int(0.10 * SR):a0 + int(1.50 * SR)] = body_amp
        return y

    yA, yB = note(0.60, 0.05, 1.0), note(0.10, 0.30, 4.0)

    def rms(y, s, e):
        return float(np.sqrt(np.mean(y[s:e] ** 2)))

    # Old behaviour: fixed 100 ms from the onset — measures the attack.
    oldA = rms(yA, int(1.0 * SR), int(1.0 * SR) + SR // 10)
    oldB = rms(yB, int(4.0 * SR), int(4.0 * SR) + SR // 10)
    check("the OLD attack window ranks them backwards (the bug)", oldA > oldB,
          f"p-note {oldA:.3f} > f-note {oldB:.3f}")

    newA = rms(yA, *w.note_body_window(1.0, 2.5, 2.5, SR, N))
    newB = rms(yB, *w.note_body_window(4.0, 5.5, 5.5, SR, N))
    check("the BODY window ranks them correctly", newB > newA,
          f"f-note {newB:.3f} > p-note {newA:.3f}")


def test_music21_accidental_spellings_parse():
    print("\n[31] music21 pitch spellings parse to the right MIDI number")
    # music21's `nameWithOctave` writes a FLAT as "-", not "b": B-flat 4 is
    # "B-4". The old regex treated "-4" as the OCTAVE and returned -25 for a
    # note whose real MIDI is 70 — a 95-semitone error on every flat note in
    # every MusicXML score, which is most notes in clarinet repertoire.
    #
    # Verified against real music21 9.1.0:
    #   Pitch('B-4').nameWithOctave == 'B-4', .midi == 70
    cases = [
        ("B-4",  70),   # B flat   — music21 spelling
        ("Bb4",  70),   # B flat   — conventional spelling
        ("E-5",  75),
        ("A-4",  68),
        ("D-4",  61),
        ("C4",   60),
        ("C#4",  61),
        ("G#4",  68),
        ("F##4", 67),   # double sharp — previously returned None and was DROPPED
        ("C--4", 58),   # double flat
        ("B--3", 57),
    ]
    bad = []
    for name, want in cases:
        got = w.midi_from_name(name)
        if got != want:
            bad.append(f"{name}: got {got}, want {want}")
    check("every music21 spelling parses to the correct MIDI", not bad, "; ".join(bad[:4]))

    # Round-tripping must not silently invent a plausible-looking wrong note:
    # midi_to_scientific(-25) used to render as "A-4", which reads as A-flat.
    rt = []
    for name, want in cases:
        s = w.midi_to_scientific(want)
        if w.midi_from_name(s) != want:
            rt.append(f"{s} -> {w.midi_from_name(s)} != {want}")
    check("midi_to_scientific output re-parses to the same MIDI", not rt, "; ".join(rt[:4]))

    # Garbage must still be rejected rather than silently producing a number.
    junk = [w.midi_from_name(x) for x in ("", "H4", "4", "Cx4", "C")]
    check("unparseable names still return None", all(v is None for v in junk), str(junk))


def test_median_is_not_biased_upward():
    print("\n[32] median() is a true median, not the upper element")
    # `sorted(v)[len(v)//2]` takes the UPPER element on even-length lists. The
    # placement rule admits as few as TWO notes, so it returned max(v1, v2) —
    # exactly the single worst onset the "two notes must agree" guard exists to
    # exclude. Asymmetric: over-reports "late", under-reports "early".
    cases = [([40.0, 120.0], 80.0), ([-100.0, -120.0], -110.0),
             ([30, 50, 90, 130], 70.0), ([1.0, 2.0, 3.0], 2.0), ([5.0], 5.0)]
    bad = [f"{v} -> {w.median(v)} want {want}" for v, want in cases
           if abs(w.median(v) - want) > 1e-9]
    check("median() matches the true median", not bad, "; ".join(bad))
    check("empty input returns None", w.median([]) is None)

    # The two flagging asymmetries, stated as the user experiences them.
    THRESH = 110.0
    check("a bar of [40,120] ms is NOT called late (true median 80)",
          abs(w.median([40.0, 120.0])) < THRESH, f"{w.median([40.0, 120.0])}")
    check("a bar of [-100,-120] ms IS called early (true median -110)",
          abs(w.median([-100.0, -120.0])) >= THRESH, f"{w.median([-100.0, -120.0])}")


def test_squeaks_are_never_reported_as_wrong_notes():
    print("\n[33] a squeak is never reported as a WRONG NOTE")
    # Regression from 2026-08-22: once clarinet register-break events stopped
    # being deleted, an event kept on TIMBRE alone can still be confidently
    # tracked and stable in pitch — clearing every wrong-note gate (conf>=65,
    # dur>=0.08, spread<=40). To that detector it looks exactly like a
    # deliberately played note a 12th above the written one.
    score = make_score()
    _played, evs = make_performance(score)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    for e in aligned:
        e.setdefault("flatness", 0.010)
        if e.get("midi_raw") is None:
            e["midi_raw"] = w.midi_from_name(e["pitches"][0])

    # Put the squeak on a MIDDLE onset of the bar, not its first or last. The
    # first/last onset triggers the neighbour-measure expansion, and with a
    # scalar passage the neighbours supply every diatonic pitch-class — so
    # `min_pc_dist >= 2` can never hold and the detector is inert there. The
    # assertion would then pass for the wrong reason (it did, until red-green).
    _m27 = sorted((e for e in aligned if e["measure"] == 27), key=lambda e: e["time_sec"])
    assert len(_m27) >= 3, "fixture needs an interior onset in m.27"
    _sq = _m27[1]
    _sq.update({"midi_raw": (_sq["midi_raw"] or 60) + 19,
                "held_sec": 0.20, "end_sec": _sq["time_sec"] + 0.20,
                "cents_spread": 10,    # stable  -> clears MAX_SPREAD
                "confidence": 92,      # certain -> clears MIN_CONF
                "flatness": 0.060})    # noisy   -> this alone marks it a squeak

    # NOTE: a transposing instrument is deliberately NOT used here. With
    # "clarinet" the declared -2 disagrees with the measured +0 on this fixture
    # and the whole detector self-suppresses, so the assertion below would pass
    # for the wrong reason — it did, until a red-green check caught it.
    cands = w.find_wrong_note_candidates(aligned, score, "flute")
    m27 = [c for c in cands if "measure 27" in c]
    check("the timbre-only squeak is NOT called a wrong note", not m27, str(m27)[:140])
    # And it is still visible to the detector that should own it.
    cracks = [c for c in w.find_crack_candidates(aligned) if "measure 27" in c]
    check("the crack detector still reports it", bool(cracks), str(cracks)[:120])


def test_no_flag_ever_asserts_a_rest():
    print("\n[34] no flag text asserts a rest (the pipeline has no rest data)")
    # parse_musicxml discards rests deliberately, so `gap_beats - written_beats`
    # is only "distance to the next note we could READ" — equally produced by a
    # note the score reader dropped. It used to be rendered as "plus the N-beat
    # rest after it", asserting a rest in passages containing none.
    # The score must contain a HOLE — a beat position with no readable note —
    # because that is what manufactures the phantom rest. Here every measure's
    # middle beat is missing, exactly as it would be if the vision reader
    # returned "p": null for an unreadable notehead. Without a hole,
    # gap_after_beats is 0, the old text was empty anyway, and the test passes
    # for the wrong reason (it did, until a red-green check caught it).
    score = make_score()
    for m in score["measures"]:
        m["notes"] = [n for n in m["notes"] if n["beat"] != 2.0]

    played = [m for m in score["measures"] if START <= m["number"] <= END]
    evs = []
    for mi, m in enumerate(played):
        for note in m["notes"]:
            t = (mi * BEATS_PER_MEASURE + (note["beat"] - 1.0)) * SEC_PER_BEAT
            evs.append({"time_sec": t, "end_sec": t + SEC_PER_BEAT,
                        "pitches": [note["pitch"]], "confidence": 90,
                        "cents_offset": 0, "cents_spread": 8,
                        "held_sec": 0.45, "sound_end": t + 0.45,
                        "loudness": "medium"})
    # Hold one note far past its written value so a duration finding fires.
    evs[6]["held_sec"] = 2.2
    evs[6]["sound_end"] = evs[6]["time_sec"] + 2.2

    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    flags = run_pipeline(score, aligned)
    blob = " ".join(f"{f.get('title','')} {f.get('detail','')} {f.get('raw_detail','')}"
                    for f in flags).lower()
    check("no flag mentions a rest", "rest" not in blob,
          [s for s in blob.split(".") if "rest" in s][:2])


def test_a_grid_that_does_not_fit_produces_no_timing_flags():
    print("\n[35] a tempo fit that does not describe the performance is rejected")
    score = make_score()

    # Coherent: one note held long displaces everything after it. Half the piece
    # sits off the line, but the grid is sound and this IS the finding — the
    # gate's first draft used spread and threw exactly these takes away.
    _p, evs = make_performance(score, warp=lambda m, b, t: t + 0.45 if m >= 30 else t)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    rep = w.analyze_timing_vs_score(aligned, score, BEATS_PER_MEASURE)
    check("a coherent displacement still yields a usable timing report",
          isinstance(rep, dict) and rep.get("ok") is not False,
          str(rep.get("reason") if isinstance(rep, dict) else rep))

    # Incoherent: every note independently scattered. The line means nothing.
    import random
    random.seed(7)
    _p, evs = make_performance(
        score, warp=lambda m, b, t: t + random.uniform(-0.30, 0.30))
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    rep = w.analyze_timing_vs_score(aligned, score, BEATS_PER_MEASURE)
    check("a scattered performance produces NO timing flags",
          isinstance(rep, dict) and rep.get("ok") is False,
          str(rep.get("reason") if isinstance(rep, dict) else rep))


# A flat-key scale written the way music21 spells it: "-" for a flat, NOT "b".
# `parse_musicxml` emits `el.pitch.nameWithOctave`, so these are the exact
# strings the real pipeline receives from a MusicXML score. Every other fixture
# in this file is naturals-only, which is precisely why a parser that turned
# every flat into a large negative MIDI number passed 121/121 for months.
FLAT_SCALE = ["B-3", "C4", "D4", "E-4", "F4", "G4", "A-4", "B-4"]


def make_flat_score():
    return {"time_signature": "3/4", "measures": [
        {"number": n, "notes": [
            {"pitch": FLAT_SCALE[(n * 3 + b) % 8], "beat": float(b + 1),
             "duration_beats": 1.0}
            for b in range(BEATS_PER_MEASURE)]}
        for n in MEASURE_NUMBERS]}


def test_flat_key_score_survives_the_whole_pipeline():
    print("\n[36] a flat-key score (music21 '-' spelling) works end to end")
    score = make_flat_score()

    # 1. Every pitch parses to a sane instrument-range MIDI number.
    midis = [w.midi_from_name(n["pitch"])
             for m in score["measures"] for n in m["notes"]]
    check("no pitch parses to a negative/absurd MIDI",
          all(m is not None and 21 <= m <= 108 for m in midis),
          f"min={min(m for m in midis if m is not None)}")

    # 2. A correct performance of it aligns to the right measures.
    played = [m for m in score["measures"] if START <= m["number"] <= END]
    evs = []
    for mi, m in enumerate(played):
        for bi, note in enumerate(m["notes"]):
            t = (mi * BEATS_PER_MEASURE + bi) * SEC_PER_BEAT
            evs.append({"time_sec": t, "end_sec": t + SEC_PER_BEAT,
                        "pitches": [note["pitch"]], "confidence": 90,
                        "cents_offset": 0, "cents_spread": 8,
                        "held_sec": 0.45, "sound_end": t + 0.45,
                        "loudness": "medium", "_truth": m["number"],
                        "midi_raw": w.midi_from_name(note["pitch"])})
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    wrong_label = [(e["_truth"], e.get("measure")) for e in aligned
                   if "_truth" in e and e.get("measure") != e["_truth"]]
    check("DTW labels every note with its true measure", not wrong_label,
          str(wrong_label[:4]))

    # 3. A correct performance of a flat-key piece reports NO wrong notes.
    #    This is the end-to-end symptom the user reported.
    cands = w.find_wrong_note_candidates(aligned, score, "flute")
    check("a correctly played flat-key passage reports no wrong notes",
          not cands, str(cands[:3])[:200])

    # 4. And a genuinely wrong note in that passage is still caught, so the
    #    check above is not passing because the detector is inert.
    bad = [dict(e) for e in aligned]
    _bar = sorted((e for e in bad if e["measure"] == 27), key=lambda e: e["time_sec"])
    _bar[1]["midi_raw"] = (_bar[1]["midi_raw"] or 60) + 6   # a tritone off
    _bar[1]["pitches"] = [w.midi_to_scientific(_bar[1]["midi_raw"])]
    cands2 = w.find_wrong_note_candidates(bad, score, "flute")
    check("a real wrong note in the same passage IS caught", bool(cands2),
          str(cands2[:2])[:160])

    # The printed distance must match the note that is printed beside it. This
    # is arithmetic the student can check against the page, and it was wrong:
    # "detected G#4 ... score has D4 (5 semitones away)" — G#4 to D4 is 6.
    bad_math = []
    for c in cands2:
        mm = re.search(r"detected ([A-G][#b\-]?\d).*score has ([A-G][#b\-]?\d) "
                       r"\((\d+) semitones away\)", c)
        if not mm:
            continue
        played, expected, stated = (w.midi_from_name(mm.group(1)),
                                    w.midi_from_name(mm.group(2)),
                                    int(mm.group(3)))
        if played is None or expected is None or abs(played - expected) != stated:
            bad_math.append(f"{mm.group(1)}->{mm.group(2)} says {stated}, "
                            f"really {abs((played or 0) - (expected or 0))}")
    check("the stated semitone distance matches the named notes", not bad_math,
          "; ".join(bad_math[:3]))


def test_rhythm_corroboration_needs_real_signal():
    print("\n[37] a Gemini rhythm claim is corroborated only by real unevenness")

    def take(shift_ms):
        """Swing alternate notes of m.27 by `shift_ms`."""
        score = make_score()
        _p, evs = make_performance(score)
        for i, e in enumerate(evs):
            m_idx = int(e["time_sec"] / (SEC_PER_BEAT * BEATS_PER_MEASURE))
            if m_idx == 7 and i % 2 == 1:          # m.27 (START=20 + 7)
                e["time_sec"] += shift_ms / 1000.0
                e["end_sec"] += shift_ms / 1000.0
        aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE,
                                       end_measure=END)
        gem = dict(EMPTY_GEMINI)
        gem["rhythm_issues"] = [{"measure": 27, "description": "Eighths uneven.",
                                 "time": "0:11"}]   # m.27 spans 10.5-12.0s
        return run_pipeline(score, aligned, gem)

    # Real unevenness — clearly above the onset noise floor.
    loud = [f for f in take(75) if f.get("type") == "timing"]
    check("a 75 ms swing IS corroborated", bool(loud),
          f"flags={[(f.get('measure'), f.get('type')) for f in take(75)][:4]}")

    # Noise-level jitter: 23 ms onset grid, 50 ms dedupe. Nothing here is
    # measurable, so Gemini saying so must NOT be treated as confirmed fact.
    quiet = [f for f in take(20) if f.get("type") == "timing"]
    check("a 20 ms jitter is NOT corroborated", not quiet,
          f"flags={[(f.get('measure'), f.get('type')) for f in quiet][:4]}")


def test_compound_articulation_is_short_by_design():
    print("\n[38] a note marked accent+staccato is not called 'too short'")
    # parse_musicxml used to read only `el.articulations[0]` and recognise only
    # three classes, so accent+staccato reported "accent" and lost the staccato.
    # It now joins ALL articulation class names, e.g. "accent/staccato".
    # The duration check's exemption list also tested for "marcato"/"wedge"/
    # "portato", which that parser could never emit — dead strings that read as
    # coverage.
    for artic in ("accent/staccato", "staccatissimo", "marcato", "accent/spiccato"):
        score = make_score()
        for m in score["measures"]:
            for n in m["notes"]:
                n["articulation"] = artic
        _p, evs = make_performance(score)
        for e in evs:                       # play everything crisply short
            e["held_sec"] = 0.10
            e["sound_end"] = e["time_sec"] + 0.10
        aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE,
                                       end_measure=END)
        rep = w.analyze_timing_vs_score(aligned, score, BEATS_PER_MEASURE)
        durs = (rep or {}).get("durations") or {}
        short = {m: d for m, d in durs.items() if d.get("direction") == "short"}
        check(f"{artic!r} is exempt from the 'too short' reading", not short,
              str(list(short.items())[:2])[:120])

    # A note with NO short-by-design marking played that short IS still caught,
    # so the exemption is not simply switching the detector off.
    score = make_score()
    _p, evs = make_performance(score)
    for e in evs:
        e["held_sec"] = 0.10
        e["sound_end"] = e["time_sec"] + 0.10
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    rep = w.analyze_timing_vs_score(aligned, score, BEATS_PER_MEASURE)
    durs = (rep or {}).get("durations") or {}
    check("an unmarked note played that short IS still flagged",
          any(d.get("direction") == "short" for d in durs.values()),
          str(list(durs.items())[:1])[:120])


def test_ambiguous_instrument_does_not_guess_a_transposition():
    print("\n[39] an ambiguous instrument name yields no declared transposition")
    # The profile instrument list offers a plain "Saxophone". It used to resolve
    # to -9 (alto), so a tenor player (-14) choosing it got a 5-semitone error on
    # every note — a whole score of wrong-note flags on correct playing. With no
    # entry, `declared` is None and the measured offset is used instead.
    check("bare 'Saxophone' declares nothing", w.transpose_for_instrument("Saxophone") is None)
    exact = {"Alto Saxophone": -9, "Tenor Saxophone": -14,
             "Baritone Saxophone": -21, "Soprano Saxophone": -2}
    bad = [f"{k}->{w.transpose_for_instrument(k)}" for k, v in exact.items()
           if w.transpose_for_instrument(k) != v]
    check("named saxophones still resolve exactly", not bad, "; ".join(bad))
    # Unambiguous defaults must not regress.
    common = {"Clarinet": -2, "clarinet (b♭)": -2, "Flute": 0, "Trumpet": -2}
    bad2 = [f"{k}->{w.transpose_for_instrument(k)}" for k, v in common.items()
            if w.transpose_for_instrument(k) != v]
    check("common instruments keep their transposition", not bad2, "; ".join(bad2))


def test_squeak_survives_the_release_tolerance():
    print("\n[40] an unstable squeak is still brief for squeak purposes")
    # `held_sec` answers "how long did this note SOUND", and after the release
    # walk gained a 2-frame tolerance (so vibrato/slurs stop truncating a held
    # note) an unstable event rides through its own dropouts and measures LONG.
    #
    # Both squeak tests are brevity limits — find_crack_candidates' dur <= 0.28
    # and looks_like_squeak's 0.30 — so a squeak full of dropouts measured 0.32
    # and was rejected as "not brief", then deleted by the clarinet suppressor.
    # `stable_sec` (the strict, contiguous-stable span) is the right measure for
    # "was this brief and unstable"; held_sec stays the right one for duration.
    ev = {"time_sec": 3.0, "held_sec": 0.32, "stable_sec": 0.12,
          "cents_spread": 70, "confidence": 45, "flatness": 0.060}
    check("an unstable event is judged brief by stable_sec, not held_sec",
          w.looks_like_squeak(ev, 0.010) is True, str(w.looks_like_squeak(ev, 0.010)))

    # A genuinely SUSTAINED note is still not a squeak — the tolerance must not
    # become a way for long notes to be called cracks.
    sustained = {"time_sec": 3.0, "held_sec": 1.20, "stable_sec": 1.15,
                 "cents_spread": 70, "confidence": 45, "flatness": 0.060}
    check("a sustained note is still not a squeak",
          w.looks_like_squeak(sustained, 0.010) is False)

    # And the crack detector must see it through the full path.
    line = [{"measure": 20, "time_sec": i * 0.5, "midi_raw": 60, "midi": 60,
             "held_sec": 0.45, "stable_sec": 0.45, "cents_spread": 6,
             "confidence": 95, "flatness": 0.010} for i in range(8)]
    line[4].update({"midi_raw": 79, "midi": 79, "held_sec": 0.32,
                    "stable_sec": 0.12, "cents_spread": 70,
                    "confidence": 45, "flatness": 0.060})
    got = w.find_crack_candidates(line)
    check("the crack detector reports it", len(got) == 1 and "measure 20" in got[0],
          str(got))


def test_flag_keys_are_stable_and_unique():
    print("\n[41] flags carry a stable, unique key")
    flags = [
        {"type": "intonation", "measure": 20},
        {"type": "timing",     "measure": 20},
        {"type": "intonation", "measure": 21},
    ]
    w.assign_flag_keys(flags)
    keys = [f["flag_key"] for f in flags]
    check("keys are unique", len(set(keys)) == 3, str(keys))
    check("key names the type and measure",
          keys[0] == "intonation:20" and keys[1] == "timing:20", str(keys))

    # Reordering the array must not change any flag's key — that is the whole
    # point: annotations survive a re-analysis that reorders flags.
    shuffled = [flags[2], flags[0], flags[1]]
    for f in shuffled:
        f.pop("flag_key")
    w.assign_flag_keys(shuffled)
    check("key is independent of array position",
          shuffled[1]["flag_key"] == "intonation:20", shuffled[1]["flag_key"])

    # A collision (two same-type flags relabelled onto one measure) must still
    # produce distinct keys rather than silently merging two annotations.
    collide = [{"type": "timing", "measure": 30}, {"type": "timing", "measure": 30}]
    w.assign_flag_keys(collide)
    check("collisions get distinct keys",
          collide[0]["flag_key"] != collide[1]["flag_key"],
          f'{collide[0]["flag_key"]} vs {collide[1]["flag_key"]}')


def test_evidence_reset_survives_container_reuse():
    print("\n[42] a warm container does not leak one take's evidence into the next")
    # Modal reuses warm containers across invocations. The FIRST call here is a
    # normal take that produces real flags, so worker._LAST_EVIDENCE ends up
    # non-empty. The SECOND call is a pathological take (empty score, no
    # aligned events, no Gemini assessment) that hits
    # compare_and_coach_claude's very FIRST early return
    # (`if not played_measures and not gemini_assessment: return []`) before
    # ever reaching the evidence-bundle build. If the reset at the top of the
    # function were removed, wrapped in a branch, moved after that return, or
    # lost its `global`, the second take's webhook would still post the FIRST
    # take's measurements as its own — silently mislabelling one student's
    # analysis with another's numbers.
    score = make_score()
    played, evs = make_performance(score, warp=lambda m, b, t: t + 0.25 if m == 30 else t)
    aligned = w.dtw_align_to_score(evs, score, START, BEATS_PER_MEASURE, end_measure=END)
    for e in aligned:
        if e["measure"] in (25, 26, 27):
            e["cents_offset"] = 30
    flags = run_pipeline(score, aligned)
    check("first take produced flags", len(flags) > 0, f"{len(flags)} flags")
    check("first take populated _LAST_EVIDENCE",
          bool(w._LAST_EVIDENCE) and bool(w._LAST_EVIDENCE.get("flags")),
          str(sorted(w._LAST_EVIDENCE.keys())))

    second = w.compare_and_coach_claude(
        score={"measures": []}, aligned=[], alignment_ranges=[], tempo={"bpm": 120},
        piece_title="Empty", composer="X", instrument="clarinet",
        gemini_assessment={}, anthropic_api_key="k",
        beats_per_measure=BEATS_PER_MEASURE, start_measure=1, end_measure=1,
        dtw_verified=True)
    check("second (pathological) take hits the early return",
          second == [], str(second))
    check("second take's early return does not inherit the first take's evidence",
          w._LAST_EVIDENCE == {}, str(w._LAST_EVIDENCE))


def test_score_reader_sends_every_page():
    print("\n[43] the score reader receives every uploaded page")
    import types, json as _json

    captured = {}

    class _FakeStream:
        def __init__(self, payload): self._payload = payload
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self):
            return types.SimpleNamespace(
                content=[types.SimpleNamespace(text=self._payload)],
                stop_reason="end_turn")

    class _FakeMessages:
        def stream(self, **kw):
            captured["content"] = kw["messages"][0]["content"]
            return _FakeStream(_json.dumps({
                "key_signature": "C major", "time_signature": "4/4",
                "tempo_marking": None,
                "measures": [
                    {"number": 1, "pg": 1, "notes": [{"p": "C4", "b": 1.0, "d": 1.0}]},
                    {"number": 9, "pg": 2, "notes": [{"p": "G4", "b": 1.0, "d": 1.0}]},
                ]}))

    class _FakeClient:
        def __init__(self, **kw): self.messages = _FakeMessages()

    pages = [(b"\x89PNG-page-one", "image/png"), (b"\x89PNG-page-two", "image/png")]
    import anthropic as _ac
    _orig = _ac.Anthropic
    _ac.Anthropic = _FakeClient
    try:
        res = w.read_score_notes_claude(pages, 1, "clarinet", "4/4", "k")
    finally:
        _ac.Anthropic = _orig

    blocks = captured.get("content") or []
    n_media = sum(1 for b in blocks if isinstance(b, dict) and b.get("type") in ("image", "document"))
    check("both pages reach the model", n_media == 2, f"{n_media} media block(s)")
    check("prompt still present", any(b.get("type") == "text" for b in blocks))
    nums = [m["number"] for m in res.get("measures", [])]
    check("printed numbering preserved across pages", nums == [1, 9], str(nums))
    pgs = [m.get("page") for m in res.get("measures", [])]
    check("each measure records its page", pgs == [1, 2], str(pgs))


def test_coverage_declares_what_was_not_analysed():
    print("\n[44] coverage declares partial analysis instead of implying completeness")
    score_two_pages = {"measures": [{"number": n, "notes": [{"pitch": "C4"}]}
                                     for n in range(1, 9)]}
    evs = [{"time_sec": i * 0.5} for i in range(12)]
    aligned = [{"measure": 1 + i // 3, "time_sec": i * 0.5} for i in range(12)]
    ranges = [{"measure": m, "start": 0.0, "end": 1.0} for m in range(1, 5)]

    # Every page read, no repeat → nothing to declare.
    q = w.assess_quality(score_two_pages, evs, aligned, ranges,
                         pages_read=3, pages_total=3,
                         has_repeats=False, first_repeat_measure=None)
    check("clean take declares no caveats", q["coverage"]["caveats"] == [],
          str(q["coverage"]["caveats"]))
    check("pages recorded", q["coverage"]["pages_analysed"] == 3)

    # One page of three unread → must say so.
    q2 = w.assess_quality(score_two_pages, evs, aligned, ranges,
                          pages_read=1, pages_total=3,
                          has_repeats=False, first_repeat_measure=None)
    txt = " ".join(q2["coverage"]["caveats"]).lower()
    check("unread pages are declared", len(q2["coverage"]["caveats"]) >= 1, txt[:90])
    check("the caveat names how many pages", "1" in txt and "3" in txt, txt[:90])

    # A repeat → must name the measure, and must NOT claim pages are missing.
    q3 = w.assess_quality(score_two_pages, evs, aligned, ranges,
                          pages_read=1, pages_total=1,
                          has_repeats=True, first_repeat_measure=17)
    rtxt = " ".join(q3["coverage"]["caveats"]).lower()
    check("repeat is declared", "repeat" in rtxt, rtxt[:90])
    check("repeat caveat names the measure", "17" in rtxt, rtxt[:90])
    check("no page caveat when all pages read",
          "page" not in rtxt, rtxt[:90])

    # Measure range comes from what was actually aligned.
    check("measure range reported", q["coverage"]["measures_analysed"] == [1, 4],
          str(q["coverage"]["measures_analysed"]))

    # A repeat can sit in an unnumbered measure — has_repeats is still True but
    # first_repeat_measure is None. The caveat must still fire, and must not
    # degrade into the literal word "None" or an empty measure reference — that
    # is the failure a student would actually see.
    q4 = w.assess_quality(score_two_pages, evs, aligned, ranges,
                          pages_read=1, pages_total=1,
                          has_repeats=True, first_repeat_measure=None)
    r4txt = " ".join(q4["coverage"]["caveats"]).lower()
    check("repeat with no measure number is still declared", "repeat" in r4txt, r4txt[:90])
    check("unnumbered repeat caveat does not say 'none'", "none" not in r4txt, r4txt[:90])


def test_coverage_pages_read_reflects_pages_covered_not_downloaded():
    print("\n[45] cache-hit coverage uses pages actually parsed, not files downloaded")
    # A cache hit downloads nothing, but if every page's measures made it into the
    # cached score dict, coverage must not read as "0 of 3 pages" — the bug this
    # guards against is pages_read defined as files-downloaded (always 0 on a cache
    # hit) instead of pages actually represented in the parsed measures.
    cached_score = {"measures": [
        {"number": n, "page": p, "notes": [{"pitch": "C4"}]}
        for p in (1, 2, 3) for n in range((p - 1) * 4 + 1, p * 4 + 1)
    ]}
    pages_read = w._pages_covered(cached_score)
    check("pages_covered counts distinct pages from parsed measures",
          pages_read == 3, str(pages_read))

    evs = [{"time_sec": i * 0.5} for i in range(12)]
    aligned = [{"measure": 1 + i // 3, "time_sec": i * 0.5} for i in range(12)]
    ranges = [{"measure": m, "start": 0.0, "end": 1.0} for m in range(1, 5)]

    q = w.assess_quality(cached_score, evs, aligned, ranges,
                         pages_read=pages_read, pages_total=3,
                         has_repeats=False, first_repeat_measure=None)
    check("fully-covered cache hit produces no page caveat",
          q["coverage"]["caveats"] == [], str(q["coverage"]["caveats"]))


def test_score_pipeline_returns_derive_pages_read_from_helper():
    print("\n[46] every _score_pipeline return site derives pages_read from _pages_covered")
    # [45] proves _pages_covered and assess_quality cooperate correctly, but it
    # calls both by hand — it never goes through _score_pipeline itself. That
    # closure lives nested inside run_full_analysis and cannot be invoked from a
    # test (it needs audio bytes, API keys, a live payload). If a cache-hit return
    # site were ever reverted to a hardcoded `pages_read = 0`, [45] would keep
    # passing while the false "covers 0 of N pages" caveat came straight back.
    # This is a source-level guard in the same spirit as test_no_undefined_names:
    # inspect the text of _score_pipeline and require every one of its `return`
    # statements to derive its third value from _pages_covered(...), so a
    # regression to a literal trips this test even though nothing can call the
    # closure directly.
    worker_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.py")
    with open(worker_path) as f:
        lines = f.readlines()

    start = next(i for i, ln in enumerate(lines)
                 if ln.lstrip().startswith("def _score_pipeline("))
    def_indent = len(lines[start]) - len(lines[start].lstrip())
    end = len(lines)
    for i in range(start + 1, len(lines)):
        stripped = lines[i].strip()
        if not stripped:
            continue
        indent = len(lines[i]) - len(lines[i].lstrip())
        if indent <= def_indent:
            end = i
            break

    body = lines[start:end]
    returns = [ln.strip() for ln in body if ln.strip().startswith("return ")]
    check("_score_pipeline has exactly 4 return statements", len(returns) == 4,
          f"found {len(returns)}: {returns}")
    bad = [r for r in returns if "_pages_covered(" not in r]
    check("every _score_pipeline return derives pages_read from _pages_covered",
          not bad, "offending line(s): " + "; ".join(bad) if bad else "")


def _worker_source_lines():
    """worker.py as a line list — shared by the source-level guards below."""
    worker_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.py")
    with open(worker_path) as f:
        return f.readlines()


def _function_body(lines, header_prefix):
    """The lines of the def whose header starts with header_prefix, at any indent."""
    start = next(i for i, ln in enumerate(lines) if ln.lstrip().startswith(header_prefix))
    def_indent = len(lines[start]) - len(lines[start].lstrip())
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if not lines[i].strip():
            continue
        if len(lines[i]) - len(lines[i].lstrip()) <= def_indent:
            end = i
            break
    return lines[start:end]


def test_zero_pages_read_is_still_declared():
    print("\n[47] reading ZERO pages is declared, not treated as 'unknown'")
    # `if pages_total and pages_read and ...` silenced the caveat for pages_read=0,
    # because 0 is falsy. That is the WORST coverage producing the QUIETEST output:
    # a score read that fails outright returns no measures, _pages_covered() gives 0,
    # the run continues on synthesized skeleton measures and emits flags anyway, and
    # nothing in src/ renders `reasons` — only coverage.caveats.
    score_empty = {"measures": []}
    evs = [{"time_sec": i * 0.5} for i in range(12)]
    aligned = [{"measure": 1 + i // 3, "time_sec": i * 0.5} for i in range(12)]
    ranges = [{"measure": m, "start": 0.0, "end": 1.0} for m in range(1, 5)]

    q = w.assess_quality(score_empty, evs, aligned, ranges,
                         pages_read=0, pages_total=3,
                         has_repeats=False, first_repeat_measure=None)
    txt = " ".join(q["coverage"]["caveats"]).lower()
    check("a total score-read failure still produces a caveat",
          len(q["coverage"]["caveats"]) >= 1, str(q["coverage"]["caveats"]))
    check("the caveat says 0 of 3", "0" in txt and "3" in txt, txt[:100])

    # Genuinely unknown (no pages field at all) must still stay silent — the caveat
    # may only fire on a number we actually have.
    q2 = w.assess_quality(score_empty, evs, aligned, ranges,
                          pages_read=None, pages_total=3,
                          has_repeats=False, first_repeat_measure=None)
    check("unknown page count declares nothing", q2["coverage"]["caveats"] == [],
          str(q2["coverage"]["caveats"]))


def test_each_page_declares_its_own_mime():
    print("\n[48] every score page's media type comes from its own download")
    # score_mime is the FIRST uploaded file's type. Sending N pages under it means a
    # mixed upload (JPEG photo + PNG screenshot, PDF + photos) mislabels every later
    # page: a PNG declared image/jpeg is a decode error and JPEG bytes in a `document`
    # block is a hard 400 — either kills the whole vision call.
    check("a page's real type wins over the first file's",
          w.page_mime_from_response("image/png", "image/jpeg") == "image/png")
    check("charset parameters are stripped",
          w.page_mime_from_response("image/png; charset=binary", "image/jpeg") == "image/png")
    check("case and padding are normalised",
          w.page_mime_from_response("  IMAGE/PNG ", "image/jpeg") == "image/png")
    check("image/jpg is normalised to image/jpeg",
          w.page_mime_from_response("image/jpg", "application/pdf") == "image/jpeg")
    check("PDF pages keep application/pdf",
          w.page_mime_from_response("application/pdf", "image/jpeg") == "application/pdf")
    # Implausible / missing headers must fall back rather than be forwarded: storage
    # can answer application/octet-stream, and an expired URL answers with HTML.
    for bad in (None, "", "application/octet-stream", "text/html", "binary/octet-stream"):
        check(f"implausible content-type {bad!r} falls back",
              w.page_mime_from_response(bad, "image/jpeg") == "image/jpeg")

    body = _function_body(_worker_source_lines(), "def _score_pipeline(")
    appends = [ln.strip() for ln in body if "pages.append(" in ln]
    check("_score_pipeline appends exactly one page tuple", len(appends) == 1,
          f"found {len(appends)}: {appends}")
    check("the reader derives each page's mime from its own response",
          all("page_mime_from_response(" in a for a in appends),
          "offending: " + "; ".join(appends))


def test_gemini_sees_every_page_not_just_the_first():
    print("\n[49] the flag author (Gemini) receives every score page, in order")
    # Gemini AUTHORS the flags. While it saw page 1 only, pages_read (from Claude's
    # reader) could report 3 of 3 and the banner stayed silent — a coverage claim
    # broader than the evidence, one layer below the defect this branch fixes.
    captured = {}

    def _fake_post(url, **kw):
        captured["parts"] = kw["json"]["contents"][0]["parts"]
        raise RuntimeError("stop after capturing the request")

    class _FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, url, **kw): return _fake_post(url, **kw)

    _httpx = sys.modules["httpx"]
    _orig = _httpx.Client
    _httpx.Client = _FakeClient
    try:
        w.evaluate_with_gemini(
            "files/x", "video/mp4", "clarinet", "Piece", "Composer", 1, None, "key",
            score_pages=[(b"\x89PNG\r\n\x1a\n1", "image/png"),
                         (b"\xff\xd8\xff2", "image/jpeg"),
                         (b"%PDF-1.4 3", "application/pdf")],
        )
    except Exception:
        pass
    finally:
        _httpx.Client = _orig

    parts = captured.get("parts") or []
    inline = [p["inlineData"] for p in parts if isinstance(p, dict) and "inlineData" in p]
    check("all three pages are inlined", len(inline) == 3, f"{len(inline)} inlineData part(s)")
    check("each page keeps its own media type",
          [p["mimeType"] for p in inline] == ["image/png", "image/jpeg", "application/pdf"],
          str([p.get("mimeType") for p in inline]))
    import base64 as _b64
    check("pages are inlined in upload order",
          [_b64.b64decode(p["data"])[-1:] for p in inline] == [b"1", b"2", b"3"],
          str([_b64.b64decode(p["data"])[-1:] for p in inline]))
    check("the recording is still attached",
          any("fileData" in p for p in parts if isinstance(p, dict)))
    prompt = " ".join(p["text"] for p in parts if isinstance(p, dict) and "text" in p)
    check("multi-page numbering is explained to the model",
          "MULTIPLE PAGES" in prompt and "page 2" in prompt, prompt[:0])

    # The single-page callers' contract is unchanged.
    captured.clear()
    _httpx.Client = _FakeClient
    try:
        w.evaluate_with_gemini(
            "files/x", "video/mp4", "clarinet", "Piece", "Composer", 1, None, "key",
            score_bytes=b"\x89PNG\r\n\x1a\n", score_mime="image/png",
        )
    except Exception:
        pass
    finally:
        _httpx.Client = _orig
    one = [p for p in (captured.get("parts") or []) if isinstance(p, dict) and "inlineData" in p]
    check("legacy score_bytes/score_mime still inlines one page", len(one) == 1, str(len(one)))
    oneprompt = " ".join(p["text"] for p in (captured.get("parts") or [])
                         if isinstance(p, dict) and "text" in p)
    check("a single page gets no multi-page instructions",
          "MULTIPLE PAGES" not in oneprompt)

    # Byte cap: keep as many as fit, in order, and REPORT the shortfall.
    pages = [(b"x" * 5, "image/png"), (b"y" * 5, "image/png"), (b"z" * 5, "image/png")]
    kept, dropped = w.cap_inlined_pages(pages, cap=12)
    check("the cap keeps as many whole pages as fit", len(kept) == 2, str(len(kept)))
    check("the cap reports what it dropped", dropped == 1, str(dropped))
    check("kept pages stay in order", kept == pages[:2])
    kept2, dropped2 = w.cap_inlined_pages([(b"x" * 99, "image/png")], cap=10)
    check("one oversized page is still sent rather than nothing",
          len(kept2) == 1 and dropped2 == 0, f"{len(kept2)}/{dropped2}")
    kept3, dropped3 = w.cap_inlined_pages(pages, cap=10_000)
    check("an ample cap drops nothing", kept3 == pages and dropped3 == 0)

    # A truncated (or failed) listening pass must reach the student, and must not be
    # able to hide behind a complete reader page count.
    score = {"measures": [{"number": n, "notes": []} for n in range(1, 9)]}
    evs = [{"time_sec": i * 0.5} for i in range(12)]
    aligned = [{"measure": 1 + i // 3, "time_sec": i * 0.5} for i in range(12)]
    ranges = [{"measure": m, "start": 0.0, "end": 1.0} for m in range(1, 5)]
    q = w.assess_quality(score, evs, aligned, ranges,
                         pages_read=3, pages_total=3, listening_pages_read=1)
    txt = " ".join(q["coverage"]["caveats"]).lower()
    check("a partial listening pass is declared even when the reader read everything",
          len(q["coverage"]["caveats"]) == 1, str(q["coverage"]["caveats"]))
    check("that caveat names 1 of 3", "1 of 3" in txt, txt[:120])
    q2 = w.assess_quality(score, evs, aligned, ranges,
                          pages_read=3, pages_total=3, listening_pages_read=3)
    check("a complete listening pass declares nothing", q2["coverage"]["caveats"] == [],
          str(q2["coverage"]["caveats"]))
    q3 = w.assess_quality(score, evs, aligned, ranges,
                          pages_read=3, pages_total=3, listening_pages_read=None)
    check("a non-visual score (nothing inlined by design) declares nothing",
          q3["coverage"]["caveats"] == [], str(q3["coverage"]["caveats"]))

    # Source-level guard: _gemini_pipeline is a closure nested inside
    # run_full_analysis and cannot be invoked from a test (it needs video bytes,
    # a Gemini upload and live keys). Guard its shape instead — the regression to
    # protect against is it going back to downloading score_url alone.
    body = _function_body(_worker_source_lines(), "def _gemini_pipeline(")
    src = "".join(body)
    check("_gemini_pipeline reads the full ordered page set",
          'payload.get("score_urls")' in src, "score_urls lookup missing")
    check("_gemini_pipeline passes every page to evaluate_with_gemini",
          "score_pages=" in src, "score_pages= missing")
    check("_gemini_pipeline no longer passes a lone score_bytes",
          "score_bytes=" not in src, "score_bytes= still present")
    check("_gemini_pipeline still gates inlining on a visual score",
          'kind == "visual"' in src and "sniff_score_kind(" in src,
          "visual-only gate missing")
    check("_gemini_pipeline caps inlined bytes and records the shortfall",
          "cap_inlined_pages(" in src and "listening_pages_read" in src,
          "cap/record missing")


def test_partial_runs_declare_the_true_page_total_and_do_not_poison_the_cache():
    print("\n[50] a degraded run reports the true page total and is never cached")
    lines = _worker_source_lines()
    src = "".join(lines)
    # Both of these live in run_full_analysis's body, which no test can call (it
    # needs audio, network and API keys), so they are guarded at source level in
    # the same spirit as [46].
    check("pages_total prefers the dispatch's own score_pages_total field",
          'payload.get("score_pages_total")' in src,
          "score_pages_total not read from the payload")
    check("the legacy derivation is kept only as a fallback",
          src.count('len(payload.get("score_urls") or ([score_url] if score_url else []))') == 1,
          "expected exactly one fallback expression")
    check("a degraded run suppresses the cached parse",
          '"parsedScoreNotes":  None if _degraded else parsed_score_notes,' in src,
          "parsedScoreNotes is not gated on _degraded")
    check("the suppression explains itself to a later reader",
          "poisons it permanently" in src, "missing the why-comment")

    # The edge function must send the field the worker now prefers, and must send
    # the count of PATHS (not of successfully signed URLs).
    ts_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "..", "supabase", "functions", "analyze-performance", "index.ts")
    with open(ts_path) as f:
        ts = f.read()
    check("the dispatch sends score_pages_total",
          "score_pages_total:" in ts, "field missing from the Modal dispatch")
    check("score_pages_total counts uploaded paths, not signed URLs",
          "score_pages_total:    safeScorePaths.length || (scorePath ? 1 : 0)," in ts,
          "unexpected expression for score_pages_total")
    check("the stale 'only scorePaths[0] is fed to the pipeline' claim is gone",
          "Only scorePaths[0] is actually fed" not in ts, "stale comment still present")


def test_one_file_keeps_flat_positions_even_when_it_has_many_pages():
    print("\n[51] a lone multi-page PDF keeps its measure positions")
    # One uploaded FILE can still hold many pages. Claude reads them all and stamps
    # pg=1,2,3, but the position call sees one document and returns one flat map with
    # no page dimension. Keying that map by page matched only the pg=1 measures and
    # left the rest with no x_pct/y_pct — after which Analysis.jsx takes its
    # exact-positions branch, drops them, and snaps their flags onto page 1.
    body = "".join(_function_body(_worker_source_lines(), "def _score_pipeline("))
    check("the merge branches on the number of FILES",
          "len(pages) == 1" in body, "no single-file branch in the position merge")
    check("the single-file branch applies positions to every measure regardless of page",
          "positions.get(m[\"number\"])" in body,
          "expected a flat positions.get(m['number']) lookup")
    check("the multi-file branch still keys by page",
          'positions_by_page.get(m.get("page", 1), {})' in body,
          "per-page keying lost")
    check("the comment explains why files, not pages, decide",
          "count of FILES" in body.replace("The count of FILES", "count of FILES"),
          "missing rationale comment")

    # The consumer side: Analysis.jsx must draw only the visible page's measures,
    # and must keep rendering pre-branch measures that carry no page at all.
    jsx = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "src", "pages", "Analysis.jsx")
    with open(jsx) as f:
        ui = f.read()
    check("layoutMeasures is filtered to the page on screen",
          "lm.page === currentScorePage + 1" in ui, "no page filter on layoutMeasures")
    check("measures with no page still render",
          "lm.page == null || lm.page === currentScorePage + 1" in ui,
          "the null-page escape hatch is missing")


def main():
    print("=" * 70)
    print("Analysis pipeline — ground truth tests")
    print("=" * 70)
    for t in (test_no_undefined_names, test_timeline_tiles, test_multirest_time, test_score_numbering,
              test_dtw_labels, test_label_matches_loop, test_spans_merge,
              test_posture_spans, test_pathological_alignment_rejected,
              test_leading_silence_trimmed, test_measure_from_notes,
              test_loop_always_plays_the_flagged_measure,
              test_runup_excluded_even_when_alignment_rejected,
              test_measure_starts_on_a_note_not_noise,
              test_transposing_instrument_not_flagged_as_wrong_notes,
              test_form_time_signature_wins,
              test_pitch_measurement_is_unbiased,
              test_tuning_center_normalisation,
              test_wrong_notes_reject_false_positives,
              test_bflat_clarinet_transposition,
              test_pause_before_playing_is_not_a_late_downbeat,
              test_timeline_starts_on_the_first_matched_note,
              test_note_values_and_rests,
              test_note_value_naming,
              test_hold_length_is_measured_not_inferred,
              test_staccato_is_not_clipped,
              test_placement_threshold_scales_with_tempo,
              test_note_ordinals_are_corrected,
              test_squeaks_separated_from_leaps_by_timbre,
              test_crack_routing_ignores_gemini_wording,
              test_loudness_measures_the_note_not_the_attack,
              test_music21_accidental_spellings_parse,
              test_median_is_not_biased_upward,
              test_squeaks_are_never_reported_as_wrong_notes,
              test_no_flag_ever_asserts_a_rest,
              test_a_grid_that_does_not_fit_produces_no_timing_flags,
              test_flat_key_score_survives_the_whole_pipeline,
              test_rhythm_corroboration_needs_real_signal,
              test_compound_articulation_is_short_by_design,
              test_ambiguous_instrument_does_not_guess_a_transposition,
              test_squeak_survives_the_release_tolerance,
              test_flag_keys_are_stable_and_unique,
              test_evidence_reset_survives_container_reuse,
              test_score_reader_sends_every_page,
              test_coverage_declares_what_was_not_analysed,
              test_coverage_pages_read_reflects_pages_covered_not_downloaded,
              test_score_pipeline_returns_derive_pages_read_from_helper,
              test_zero_pages_read_is_still_declared,
              test_each_page_declares_its_own_mime,
              test_gemini_sees_every_page_not_just_the_first,
              test_partial_runs_declare_the_true_page_total_and_do_not_poison_the_cache,
              test_one_file_keeps_flat_positions_even_when_it_has_many_pages):
        try:
            t()
        except Exception as e:                                  # noqa: BLE001
            import traceback
            RESULTS.append((t.__name__, False, f"{type(e).__name__}: {e}"))
            print(f"  ERROR {t.__name__}: {type(e).__name__}: {e}")
            traceback.print_exc()
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print("\n" + "=" * 70)
    print(f"{passed}/{len(RESULTS)} checks passed")
    failed = [(n, d) for n, ok, d in RESULTS if not ok]
    for n, d in failed:
        print(f"  FAILED: {n}  {d}")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
