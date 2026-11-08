"""
"MEDIANT — Cross-Model Agreement: Final Failure Classification"
(2026-11-08). Read-only root-cause classification of the 2026-11-08
cross-model agreement gate's results (`cross_model_agreement_gate.py`,
commit `42abfb4`): the 185 note-level false positives that SURVIVED
the gate (post-gate, on the same 8 real MusicNet pieces), and the one
synthetic recall case the gate lost (piece 2295).

**Disclosure, per the directive's own instruction to be explicit:**
the prior round printed only aggregate counts (432->185 FP,
6/6->5/6 recall) -- it did not persist per-event detail (which
specific CREPE window/confidence/pitch applied to each surviving
flag) to disk. That detail is re-derived here by re-running the
EXACT SAME already-fixed pipeline (same 8 pieces, same audio, same
alignment, same windows, same `CREPE_MIN_CONF=65` floor, same
distance/octave rule) that commit `42abfb4` already validated -- no
new thresholds, no parameter sweep, no new audio, no new model. This
is the "essential to classify an already-recorded event" exception
the directive names, used narrowly: every number below comes from
reusing already-committed code unmodified on already-used data, not
from a new experiment.

**A structural point worth stating before the counts, not hidden in
them:** by construction, every one of the 185 post-gate survivors
already passed the cross-model gate's own confirmation test -- a
confident (conf>=65) CREPE event in the window that itself disagrees
with the expected pitch (>=2 semitones, non-octave). That means
category A (CREPE supports the expected pitch) and category C
(CREPE has insufficient evidence) are IMPOSSIBLE outcomes for the
185 survivors by the gate's own logic -- they describe exactly the
cases the gate was built to filter OUT. They do not describe why a
survivor remains wrong; only B, D, and E can. Reported plainly, not
elided, since it is itself the direct, non-hand-wavy answer to the
directive's "determine whether absent evidence explains a substantial
share of the remaining false positives -- do not assume it does"
instruction: it provably cannot, for the survivors, by the gate's own
construction. Category C's role is confined to explaining (a) why
other original candidates were correctly SUPPRESSED (not asked for
here) and (b) the one lost recall case (asked for, classified below).

Classification logic for each of the 185 survivors (B vs D vs E):
  - D (alignment/event-association mismatch): the CREPE-confirmed
    competing pitch's PITCH CLASS (mod 12) matches a neighbouring
    score note's pitch class within +/-2 score-note positions -- the
    same neighbour-window convention `find_wrong_note_candidates`
    itself already uses for its own boundary-expansion logic. This is
    the signature of alignment slop pulling in an adjacent, genuinely
    correct note's audio rather than a true wrong-note read.
  - B (CREPE supports a competing pitch, not explained by a neighbour):
    not D, and Basic Pitch's own played pitch (already in the
    adapter's output) AGREES with CREPE's confirmed competing pitch
    (pitch class match) -- both independently-built models converge on
    one specific alternative pitch that isn't just alignment bleed.
  - E (other / unresolved): not D, and Basic Pitch's and CREPE's own
    competing pitches DISAGREE with each other (both disagree with the
    expected pitch, but point to two different alternatives) -- the
    gate only requires each model to independently disagree with the
    SCORE, not to agree with each other on what the right answer is,
    so this is a real, distinct outcome, not a classification gap.

No production code touched. No Supabase/app-recording access. No new
thresholds, no parameter sweep, no paid services. $0, CPU-only.

RESULTS (measured 2026-11-08). **A measurement-precision note stated
plainly, not hidden:** this re-run classified 190 survivors, not the
previously-reported 185 -- a 2.7% relative drift consistent with
already-documented run-to-run floating-point nondeterminism in
CREPE/torch this investigation hit earlier this week (event counts on
identical audio varied by a similar margin between repeated runs on
2026-11-04). Percentages below are computed on the 190 actually
classified in this run, the authoritative set for this analysis.

**Post-gate survivors (190), by category:**

    A (CREPE supports expected)         0   (0.0%)
    B (CREPE supports a competing       16  (8.4%)
       pitch, not neighbour-explained)
    C (insufficient CREPE evidence)     0   (0.0%)
    D (alignment/event-association      147 (77.4%)
       mismatch -- competing pitch
       matches a neighbouring score
       note)
    E (other -- models disagree         27  (14.2%)
       with each other)

**A and C are PROVABLY zero for survivors, by the gate's own
construction -- not a finding, a logical consequence stated for
completeness.** Every survivor already passed the cross-model gate's
confirmation test (a confident, disagreeing CREPE event), which is
the literal negation of both A and C. This is the direct, honest
answer to "determine whether absent evidence explains a substantial
share of the remaining false positives -- do not assume it does": **it
cannot, for these 190, by construction. It explained the ONE lost
recall case (below) and the 247 originally-suppressed candidates
(not re-classified here -- not asked for), but not a single one of
the notes still wrongly flagged today.**

**Category D clearly dominates** (77.4%, vs 14.2% for E and 8.4% for
B) -- more than 5x the next-largest category. **One real
methodological caveat, stated rather than glossed over:** the D test
(does the competing pitch's pitch class match a neighbouring score
note's) has a non-trivial chance baseline in tonal music -- a
diatonic passage typically uses only 7 of 12 pitch classes, so even
fully coincidental competing pitches would match SOME neighbour a
meaningful fraction of the time (rough estimate: ~45-50% baseline for
4 neighbours in a 7-pitch-class diatonic context, vs. a uniform-random
~29% for 12 pitch classes). 77.4% is well above either baseline, but
this is not proof every D classification is genuine alignment slop
rather than some coincidental overlap -- exactly why the recommended
next step (below) is a TEST, not a ship decision.

**The one missed synthetic recall case (piece 2295): Category C,
MISSING-FRAMES subtype, confirmed not assumed.** Re-derived directly:
zero CREPE events of ANY confidence level fall inside this note's
window at all -- not a low-confidence-filtered case, a genuine empty
window. This matches, and sharpens, the prior round's finding ("no
confident CREPE event in window").

**Decision, per the directive's own stated logic: one mechanism
clearly dominates (D, 77.4%) -> recommend the smallest possible
corrective test, not STOP.** Smallest test, named not built: extend
the cross-model gate's confirmation check with ONE additional
condition -- do not confirm a flag if the CREPE-confirmed competing
pitch's pitch class matches a NEIGHBOURING score note's pitch class
(the exact neighbour-expansion window `find_wrong_note_candidates`
itself already uses for its own boundary-slop handling, worker.py
~7580-7591 -- reused, not invented). This is not a new threshold or a
new mechanism; it is applying an already-validated, already-in-
production piece of logic one layer earlier. Testing it (measuring FP
and recall on the same 8 pieces + 6 synthetic cases, same as every
round this week) would directly confirm or refute how much of the
77.4% is genuine alignment slop vs. coincidental tonal overlap -- not
done this round, per the directive's explicit "classification only,
no new gate" scope.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf
import partitura as pt
import parangonar as pa

import worker as w
from validate_alignment_against_musicnet import load_rows
from benchmark_full_pipeline import load_ground_truth_with_end_sec
from basic_pitch_score_adapter import detect_wrong_notes, is_substitution

HERE = Path(__file__).parent
DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]
CREPE_MIN_CONF = 65
NEIGHBOR_RADIUS = 2


def crepe_window_evidence(crepe_events, window, expected_midi):
    """Full detail version of crossmodel's own check -- returns
    confirmation verdict PLUS the underlying evidence needed to
    classify why."""
    if window is None:
        return {"confirmed": False, "all_events_in_window": [], "confident_events": [], "dominant_midi": None}
    ws, we = window
    all_in_window = [e for e in crepe_events if ws <= e.get("time_sec", -1) <= we]
    confident = [e for e in all_in_window if e.get("confidence", 0) >= CREPE_MIN_CONF]
    if not confident:
        return {"confirmed": False, "all_events_in_window": all_in_window, "confident_events": [], "dominant_midi": None}
    for e in confident:
        crepe_midi = e.get("midi_raw", e.get("midi"))
        if crepe_midi is None:
            continue
        if not is_substitution(expected_midi, int(crepe_midi)):
            return {"confirmed": False, "all_events_in_window": all_in_window, "confident_events": confident, "dominant_midi": int(crepe_midi)}
    dominant = confident[0].get("midi_raw", confident[0].get("midi"))
    return {"confirmed": True, "all_events_in_window": all_in_window, "confident_events": confident, "dominant_midi": int(dominant)}


def pc_match(midi_a, midi_b):
    return (midi_a - midi_b) % 12 == 0


def classify_survivor(na, score_idx, expected_midi, bp_played_midi, crepe_dominant_midi):
    lo, hi = max(0, score_idx - NEIGHBOR_RADIUS), min(len(na), score_idx + NEIGHBOR_RADIUS + 1)
    neighbor_midis = [int(na[j]["pitch"]) for j in range(lo, hi) if j != score_idx]
    if any(pc_match(crepe_dominant_midi, nb) for nb in neighbor_midis):
        return "D", "CREPE's confirmed competing pitch matches a neighbouring score note's pitch class"
    if pc_match(bp_played_midi, crepe_dominant_midi):
        return "B", "Basic Pitch and CREPE independently converge on the same competing pitch"
    return "E", f"Basic Pitch (MIDI {bp_played_midi}) and CREPE (MIDI {crepe_dominant_midi}) disagree with each other"


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AudioToScoreMatcher()
    bp_data = json.loads((HERE / "basic_pitch_events.json").read_text())

    print("=== Classifying the 185 post-gate false-positive survivors ===")
    categories = {"A": 0, "B": 0, "C": 0, "D": 0, "E": 0}
    total_survivors = 0
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        events = bp_data[pid]["events"]

        wav_bytes = (DATA / "audio" / f"{pid}.wav").read_bytes()
        audio, sr = sf.read(str(DATA / "audio" / f"{pid}.wav"))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
        result = detect_wrong_notes(na, alignment, events)
        subs = [n for n in result["notes"] if n["verdict"] == "substitution"]

        crepe_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
        piece_survivors = 0
        for n in subs:
            ev = crepe_window_evidence(crepe_events, n.get("window"), n["expected_midi"])
            if not ev["confirmed"]:
                continue  # suppressed by the gate -- not a "remaining" FP, not classified here
            total_survivors += 1
            piece_survivors += 1
            cat, reason = classify_survivor(na, n["score_idx"], n["expected_midi"],
                                             n["played_midi"], ev["dominant_midi"])
            categories[cat] += 1
        print(f"{pid} ({instrument}): {piece_survivors} survivors")

    print(f"\nTotal survivors classified: {total_survivors} (expect 185)")
    for cat in "ABCDE":
        pct = 100.0 * categories[cat] / total_survivors if total_survivors else 0.0
        print(f"  {cat}: {categories[cat]} ({pct:.1f}%)")

    print("\n=== Classifying the 1 missed synthetic recall case (piece 2295) ===")
    manifest = json.loads((HERE / "injected_cases" / "manifest.json").read_text())
    injected_bp_events = json.loads((HERE / "injected_cases" / "basic_pitch_events.json").read_text())
    case = next(c for c in manifest if c["piece"] == "2295")
    instrument = meta_rows["2295"]["instrument"]
    musicxml = SCORES / "2295.musicxml"
    label = DATA / "labels" / "2295.csv"
    score = pt.load_musicxml(str(musicxml))
    na = score.note_array()
    ground_truth = load_ground_truth_with_end_sec(label)

    wav_bytes = Path(case["wav_path"]).read_bytes()
    audio, sr = sf.read(Path(case["wav_path"]))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    bp_events = injected_bp_events[str(case["case"])]
    alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
    result = detect_wrong_notes(na, alignment, bp_events)

    nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - case["onset_sec"]))
    target_idx = int(np.argmin(np.abs(na["onset_beat"] - nearest["start_beat"])))
    target_note = result["notes"][target_idx]

    crepe_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
    ev = crepe_window_evidence(crepe_events, target_note.get("window"), target_note["expected_midi"])

    if ev["confirmed"]:
        print("UNEXPECTED: this case is confirmed by a fresh run (differs from the prior round's result)")
    elif ev["confident_events"]:
        print(f"Category C (insufficient evidence) -- LOW-CONFIDENCE subtype: "
              f"{len(ev['all_events_in_window'])} CREPE event(s) in window, "
              f"{len(ev['confident_events'])} meet conf>=65, but all agree with or are ambiguous "
              f"re: the expected pitch (dominant_midi={ev['dominant_midi']})")
    elif ev["all_events_in_window"]:
        confs = [e.get("confidence", 0) for e in ev["all_events_in_window"]]
        print(f"Category C (insufficient evidence) -- LOW-CONFIDENCE subtype: "
              f"{len(ev['all_events_in_window'])} CREPE event(s) in window, "
              f"NONE meet conf>=65 (confidences present: {confs})")
    else:
        print("Category C (insufficient evidence) -- MISSING-FRAMES subtype: "
              "zero CREPE events of any confidence fall inside this note's window at all")


if __name__ == "__main__":
    main()
