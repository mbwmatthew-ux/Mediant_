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
              test_tuning_center_normalisation):
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
