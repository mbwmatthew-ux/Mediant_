#!/usr/bin/env python3
"""
Coverage diagnostic for the analysis pipeline.

Run:  python3 modal_worker/diagnose_coverage.py

Every test in test_analysis.py checks one mechanism. This asks a different and
blunter question: **if a student makes mistake X, does a flag about X come out
the other end?** — and, just as important, **if they play cleanly, does nothing
come out?**

It drives the real `compare_and_coach_claude` with synthetic performances that
contain one deliberate defect each, and prints a matrix. No audio, no API keys.
"""
import sys, os, types, json, re
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
for _n in ["modal", "torch", "torchcrepe", "librosa", "soundfile", "music21",
           "requests", "scipy", "scipy.signal", "pretty_midi", "mido", "httpx"]:
    sys.modules.setdefault(_n, MagicMock())
import numpy as np                                     # noqa: E402
sys.modules["numpy"] = np


class _FakeMessages:
    """Echo one coaching entry per issue so nothing is dropped in transit."""
    def create(self, **kw):
        prompt = kw["messages"][0]["content"]
        idxs = [int(x) for x in re.findall(r'^\[(\d+)\] ', prompt, re.M)]
        return types.SimpleNamespace(content=[types.SimpleNamespace(
            text=json.dumps({"coaching": [
                {"i": i, "title": f"T{i}", "body": "A. B."} for i in idxs]}))])


class _FakeAnthropic:
    def __init__(self, **kw): self.messages = _FakeMessages()


_anth = types.ModuleType("anthropic"); _anth.Anthropic = _FakeAnthropic
sys.modules["anthropic"] = _anth

import importlib.util                                  # noqa: E402
_spec = importlib.util.spec_from_file_location(
    "worker", os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.py"))
w = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(w)

SCALE = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"]
BPM_M, SPB, START, END = 4, 0.5, 1, 12

EMPTY_GEMINI = {k: [] for k in (
    "rhythm_issues", "intonation_issues", "wrong_notes_cracks", "dynamics_issues",
    "tone_issues", "posture_issues", "technique_issues")}


def make_score(artic=None):
    return {"time_signature": "4/4", "measures": [
        {"number": m, "notes": [
            {"pitch": SCALE[(m * BPM_M + b) % 8], "beat": 1.0 + b,
             "duration_beats": 1.0, "articulation": artic}
            for b in range(BPM_M)]}
        for m in range(START, END + 1)]}


def perform(score):
    """A clean, in-tempo, in-tune performance holding every note fully."""
    evs = []
    for m in score["measures"]:
        for n in m["notes"]:
            ab = (m["number"] - START) * BPM_M + (n["beat"] - 1.0)
            t = ab * SPB
            evs.append({
                "time_sec": t, "end_sec": t + SPB, "sound_end": t + SPB,
                "held_sec": SPB, "pitches": [n["pitch"]],
                "midi": w.midi_from_name(n["pitch"]),
                "midi_raw": w.midi_from_name(n["pitch"]),
                "pitch_hz": 440.0, "cents_offset": 0, "cents_spread": 6,
                "confidence": 92, "loudness": "medium",
            })
    return evs


def run(evs, score, gemini=None, instrument="clarinet"):
    aligned = w.dtw_align_to_score(evs, score, START, BPM_M, end_measure=END)
    acc = {}
    for e in aligned:
        r = acc.setdefault(e["measure"], {"start": e["time_sec"], "end": e["time_sec"]})
        r["start"] = min(r["start"], e["time_sec"]); r["end"] = max(r["end"], e["time_sec"])
    items = sorted(acc.items())
    spm = BPM_M * SPB
    ranges = [{"measure": m, "start": r["start"],
               "end": (items[i + 1][1]["start"] if i + 1 < len(items) else r["end"] + SPB)}
              for i, (m, r) in enumerate(items)]
    return w.compare_and_coach_claude(
        score=score, aligned=aligned, alignment_ranges=ranges, tempo={"bpm": 120},
        piece_title="Diag", composer="X", instrument=instrument,
        gemini_assessment=gemini or dict(EMPTY_GEMINI), anthropic_api_key="k",
        beats_per_measure=BPM_M, start_measure=START, end_measure=END,
        dtw_verified=True)


def kinds(flags):
    out = {}
    for f in flags:
        txt = ((f.get("detail") or "") + " " + (f.get("raw_detail") or "")).lower()
        out.setdefault(f.get("type"), []).append(txt)
    return out


ROWS = []


def case(name, expect_type, evs, score, gemini=None, expect_text=None, instrument="clarinet"):
    flags = run(evs, score, gemini, instrument)
    k = kinds(flags)
    got = expect_type in k
    detail = ""
    if got and expect_text:
        got = any(expect_text in t for t in k[expect_type])
        detail = "" if got else f"type present but text lacks {expect_text!r}"
    if not got and not detail:
        detail = f"types seen: {sorted(k) or 'none'}"
    ROWS.append((name, expect_type, got, detail))
    return flags


def negative(name, evs, score, gemini=None):
    """A clean take must produce nothing."""
    flags = run(evs, score, gemini)
    noisy = [f["type"] for f in flags]
    ROWS.append((name, "(silence)", not noisy, f"got {sorted(set(noisy))}" if noisy else ""))


def main():
    sc = make_score()

    # ── the baseline: clean playing must be silent ──
    negative("clean take produces no flags at all", perform(sc), sc)

    # ── pitch: a wrong note ──
    e = perform(sc)
    for x in e[18:20]:
        x["midi"] = x["midi_raw"] = x["midi_raw"] + 5
    case("wrong note (pitch error)", "error", e, sc, instrument="piano")

    # ── pitch: flat / sharp ──
    e = perform(sc)
    for x in e[16:20]:
        x["cents_offset"] = -34
    case("playing flat", "intonation", e, sc, expect_text="flat")
    e = perform(sc)
    for x in e[16:20]:
        x["cents_offset"] = 34
    case("playing sharp", "intonation", e, sc, expect_text="sharp")

    # ── hold time ──
    e = perform(sc)
    e[13]["sound_end"] = e[13]["time_sec"] + SPB * 0.25
    e[13]["held_sec"] = SPB * 0.25
    case("note clipped short (hold)", "timing", e, sc, expect_text="short")

    e = perform(sc)
    for x in e[14:]:
        x["time_sec"] += SPB * 0.95; x["end_sec"] += SPB * 0.95; x["sound_end"] += SPB * 0.95
    e[13]["sound_end"] = e[14]["time_sec"]
    case("note held too long", "timing", e, sc, expect_text="long")

    # ── timing: a late entry ──
    e = perform(sc)
    for x in e:
        if 20 <= x["time_sec"] / SPB < 24:
            x["time_sec"] += 0.3; x["end_sec"] += 0.3; x["sound_end"] += 0.3
    case("late entry (placement)", "timing", e, sc)

    # ── timing: rushing ──
    e = perform(sc)
    for i, x in enumerate(e):
        if i >= 24:
            sh = (i - 24) * SPB * 0.22
            x["time_sec"] -= sh; x["end_sec"] -= sh; x["sound_end"] -= sh
    case("rushing / tempo drift", "timing", e, sc)

    # ── Gemini-authored categories ──
    g = dict(EMPTY_GEMINI)
    g["tone_issues"] = [{"measure": 5, "time": "0:08", "description": "Airy, unfocused tone."}]
    case("tone glitch", "tone", perform(sc), sc, g)

    # ── dynamics, now measured rather than believed ──
    def dyn_score():
        """First half marked p, second half marked f."""
        d = make_score()
        for m in d["measures"]:
            for n in m["notes"]:
                n["dynamic"] = "p" if m["number"] <= 6 else "f"
        return d

    def dyn_perform(d, soft_db, loud_db):
        e = perform(d)
        for x in e:
            m = int(x["time_sec"] / (BPM_M * SPB)) + 1
            x["db"] = soft_db if m <= 6 else loud_db
        return e

    ds = dyn_score()
    g = dict(EMPTY_GEMINI)
    g["dynamics_issues"] = [{"measure": 6, "time": "0:10", "description": "No contrast at the piano marking."}]
    # played at one volume throughout -> no contrast
    case("dynamics: no contrast between p and f", "dynamics",
         dyn_perform(ds, -20.0, -19.4), ds, g, expect_text="same volume")

    # played with real contrast -> nothing to report, and Gemini's claim is
    # rejected because the audio contradicts it
    negative("dynamics: real contrast is silent (and rejects a false claim)",
             dyn_perform(ds, -30.0, -14.0), ds, g)

    # the f section played softer than the p section -> inverted
    case("dynamics: markings played the wrong way round", "dynamics",
         dyn_perform(ds, -14.0, -26.0), ds, None, expect_text="wrong way round")

    # A photo-parsed score marks `dyn` only where the marking is PRINTED; every
    # later note is null. Dynamics must still work, or it silently does nothing
    # for exactly the scores most users upload.
    ps = make_score()
    for m in ps["measures"]:
        for n in m["notes"]:
            n["dynamic"] = None
    ps["measures"][0]["notes"][0]["dynamic"] = "p"
    ps["measures"][6]["notes"][0]["dynamic"] = "f"
    case("dynamics: works on a photo-parsed score (marking printed once)",
         "dynamics", dyn_perform(ps, -20.0, -19.4), ps, None,
         expect_text="same volume")

    # no markings in the score -> Gemini is believed, since we cannot check it
    case("dynamics: believed when the score has no markings", "dynamics",
         perform(sc), sc, g)

    g = dict(EMPTY_GEMINI)
    g["posture_issues"] = ["Right shoulder raised throughout."]
    case("posture", "posture", perform(sc), sc, g)

    g = dict(EMPTY_GEMINI)
    g["technique_issues"] = ["Fingers lifting far off the keys."]
    case("technique / embouchure / airflow", "technique", perform(sc), sc, g)

    g = dict(EMPTY_GEMINI)
    g["wrong_notes_cracks"] = [{"measure": 7, "time": "0:12", "description": "A squeak breaks the line."}]
    e = perform(sc)
    sq_i = next(i for i, x in enumerate(e) if x["time_sec"] >= 12.0)
    e.insert(sq_i, {**e[sq_i], "time_sec": e[sq_i]["time_sec"] + 0.02,
                    "end_sec": e[sq_i]["time_sec"] + 0.14,
                    "sound_end": e[sq_i]["time_sec"] + 0.14, "held_sec": 0.12,
                    "midi": e[sq_i]["midi"] + 19, "midi_raw": e[sq_i]["midi_raw"] + 19,
                    "cents_spread": 70, "confidence": 62})
    f = case("squeak / crack", "error", e, sc, g)
    sq = [x for x in f if x["type"] == "error"]
    ROWS.append(("  squeak flag is CONFIRMED (not hedged)", "confirmed",
                 bool(sq) and all(x.get("confirmed") for x in sq),
                 "" if not sq else f"confirmed={[x.get('confirmed') for x in sq]}"))

    g = dict(EMPTY_GEMINI)
    g["rhythm_issues"] = [{"measure": 8, "time": "0:14", "description": "Eighths uneven."}]
    e = perform(sc)
    for x in e:                     # swing the notes inside m.8 only
        if 28 <= x["time_sec"] / SPB < 32 and int(x["time_sec"] / SPB) % 2 == 1:
            x["time_sec"] += 0.075; x["end_sec"] += 0.075; x["sound_end"] += 0.075
    f = case("Gemini rhythm observation", "timing", e, sc, g)
    rh = [x for x in f if x["type"] == "timing"]
    ROWS.append(("  rhythm flag is CONFIRMED (not hedged)", "confirmed",
                 bool(rh) and all(x.get("confirmed") for x in rh),
                 "" if not rh else f"confirmed={[x.get('confirmed') for x in rh]}"))

    # ── the score read fails in production; the audio findings must survive ──
    e = perform(sc)
    for x in e:
        x["cents_offset"] = -34
    aligned = w.dtw_align_to_score(e, sc, START, BPM_M, end_measure=END)
    for a in aligned:                     # simulate a failed score read
        a.pop("score_idx", None); a.pop("score_pitch", None); a.pop("score_abs_beat", None)
    ranges = [{"measure": m, "start": (m - 1) * 2.0, "end": m * 2.0} for m in range(1, 13)]
    flags = w.compare_and_coach_claude(
        score=sc, aligned=aligned, alignment_ranges=ranges, tempo={"bpm": 120},
        piece_title="d", composer="x", instrument="clarinet",
        gemini_assessment=dict(EMPTY_GEMINI), anthropic_api_key="k",
        beats_per_measure=BPM_M, start_measure=START, end_measure=END,
        dtw_verified=False)
    ROWS.append(("intonation survives a failed score read", "intonation",
                 any(f["type"] == "intonation" for f in flags),
                 f"got {sorted({f['type'] for f in flags}) or 'none'}"))

    # ── staccato must not be reported as clipped ──
    st = make_score(artic="staccato")
    e = perform(st)
    for x in e:
        x["sound_end"] = x["time_sec"] + SPB * 0.3; x["held_sec"] = SPB * 0.3
    negative("correct staccato is silent", e, st)

    # ── every evidence source must survive ALONE ─────────────────────────
    # The bug this guards against: an early bail-out that listed its evidence
    # sources by hand, so a take whose ONLY problem was a newly added detector
    # returned nothing. Each source below is exercised in isolation, with every
    # other source clean, so a re-introduced short-circuit fails loudly here
    # instead of silently deleting a whole category.
    ds = dyn_score()

    def only(name, evs, score, gemini=None, instrument="clarinet"):
        flags = run(evs, score, gemini, instrument)
        ROWS.append((f"ALONE: {name}", "some flag", bool(flags),
                     "returned nothing" if not flags else ""))

    e = perform(sc)
    for x in e[18:20]:
        x["midi"] = x["midi_raw"] = x["midi_raw"] + 5
    only("wrong notes only", e, sc, None, "piano")

    e = perform(sc)
    sq = next(i for i, x in enumerate(e) if x["time_sec"] >= 12.0)
    e.insert(sq, {**e[sq], "time_sec": e[sq]["time_sec"] + 0.02,
                  "end_sec": e[sq]["time_sec"] + 0.14,
                  "sound_end": e[sq]["time_sec"] + 0.14, "held_sec": 0.12,
                  "midi": e[sq]["midi"] + 19, "midi_raw": e[sq]["midi_raw"] + 19,
                  "cents_spread": 70, "confidence": 62})
    only("cracks only", e, sc)

    only("dynamics only", dyn_perform(ds, -20.0, -19.4), ds)

    e = perform(sc)
    for x in e[16:20]:
        x["cents_offset"] = -34
    only("intonation only", e, sc)

    e = perform(sc)
    e[13]["sound_end"] = e[13]["time_sec"] + SPB * 0.25
    e[13]["held_sec"] = SPB * 0.25
    only("timing only", e, sc)

    g = dict(EMPTY_GEMINI)
    g["posture_issues"] = ["Shoulders raised."]
    only("Gemini only", perform(sc), sc, g)

    # ── report ──
    width = max(len(r[0]) for r in ROWS) + 2
    print("\n" + "=" * (width + 34))
    print("ANALYSIS COVERAGE".ljust(width) + "EXPECTED".ljust(14) + "RESULT")
    print("=" * (width + 34))
    bad = 0
    for name, exp, ok, detail in ROWS:
        mark = "ok  " if ok else "MISS"
        if not ok:
            bad += 1
        print(f"{name.ljust(width)}{str(exp).ljust(14)}{mark}  {detail}")
    print("=" * (width + 34))
    print(f"{len(ROWS) - bad}/{len(ROWS)} behaviours present")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
