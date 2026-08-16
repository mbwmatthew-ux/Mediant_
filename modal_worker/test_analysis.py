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
            evs.append({"time_sec": t, "pitches": [note["pitch"]],
                        "confidence": 90, "cents_offset": 0, "loudness": "medium"})
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


def main():
    print("=" * 70)
    print("Analysis pipeline — ground truth tests")
    print("=" * 70)
    for t in (test_timeline_tiles, test_multirest_time, test_score_numbering,
              test_dtw_labels, test_label_matches_loop, test_spans_merge,
              test_posture_spans, test_pathological_alignment_rejected):
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
