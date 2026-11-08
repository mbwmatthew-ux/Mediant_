"""
"MEDIANT — Immediate Development Directive" (2026-11-08).

Genuinely different from everything tried so far this investigation
(all of which gated on a SINGLE model's own confidence/duration/
context): a CROSS-MODEL evidence check. The Basic Pitch +
`AudioToScoreMatcher` adapter (commit `21e3f41`) gets the best recall
yet (6/6 on verified synthetic injections) but a false-positive rate
54x production's (5.99%, traced in the 2026-11-05 rounds specifically
to Basic Pitch's OWN extraction noise, not to alignment error or a
matcher bug — both already ruled out). Single-model confidence/
duration gating on that same noise (commit `0a63494`) and contextual/
relational gating (commit `83218aa`) both found no usable separation
and were correctly abandoned.

This does something mechanistically different: for each wrong-note
candidate the Basic Pitch adapter flags, independently check CREPE's
OWN pitch trace (`worker.run_pitch_tracking`, already validated, not
modified, no new model) over that same note's time window. Basic
Pitch and CREPE are structurally different models (different
architecture, different training data, different known failure
modes — Basic Pitch's over-detection noise vs. CREPE's own
documented issues this investigation already characterized,
squeak-filter false-kills and injection-noise artifacts). **Only
count a flag as confirmed if CREPE's independent read ALSO disagrees
with the expected score pitch** — agreement from a second,
differently-built model is a qualitatively different kind of evidence
than either model's own self-reported confidence.

Tolerance, justified not invented: reuses the EXACT distance/octave
rule already used throughout this investigation (`is_substitution` in
`basic_pitch_score_adapter.py`, `find_wrong_note_candidates` in
`worker.py`) — >=2 semitones from the expected pitch AND not an
octave displacement. CREPE events are additionally required to clear
`worker.find_wrong_note_candidates`'s own `MIN_CONF=65` confidence
floor before being trusted as corroborating evidence — a noisy,
low-confidence CREPE read should not count as independent
confirmation, any more than it would be trusted as production's own
evidence.

**Design decision on missing CREPE evidence, stated explicitly:** if
CREPE has NO confident event at all in the note's window, the flag is
NOT confirmed (suppressed) — absence of CREPE evidence is not treated
as corroboration, only a POSITIVE disagreeing CREPE read confirms a
flag. This follows the same "do not flag on weak/absent evidence
alone" principle this investigation has held to since the frame-level
verifier work (2026-11-01).

Measured two ways, both $0, both reusing already-existing data:
  1. Recall preservation on the 6 verified synthetic injections
     already on disk (`injected_cases/`, built 2026-11-05) — does the
     cross-check still catch them?
  2. False-positive rate on REAL (unmodified, non-synthetic) MusicNet
     audio — the same 8 real dev pieces already used for the
     adapter's own FP baseline this week
     (`basic_pitch_adapter_eval.py`, commit `21e3f41`: 8/8 pieces,
     432/7211 notes, 5.99%), reused here for a direct, same-sample
     before/after comparison rather than switching to a different
     piece set.

**Explicit scope limit, per the directive's own warning:** this
measures FP rate on real (though MusicNet, not Mediant-user) audio,
and recall ONLY on synthetic injections. Recall on genuinely real
mistakes remains unmeasured by this or any prior round this
investigation — synthetic injection recall is not being oversold as
real-world accuracy.

No Supabase access of any kind. No production code touched. No paid
API/GPU spend. $0, CPU-only throughout.

RESULTS (measured 2026-11-08) -- a real, partial, mechanistically
explained effect, not a clean win and not a clean failure:

**Recall (synthetic injections, n=6): 6/6 -> 5/6.** Case 6 (piece
2295) lost NOT because CREPE disagreed with Basic Pitch's flag, but
because CREPE had no confident event at all in that note's window --
exactly the "absence of evidence does not confirm" case this gate was
explicitly designed to treat conservatively (see the design-decision
note above). This is a real, small recall cost, not a collapse, and
it is explainable: CREPE's own known event-generation gaps (documented
earlier this investigation) can miss a note Basic Pitch catches.

**False positives (real MusicNet audio, 8 pieces, 7211 notes):
5.99% -> 2.57%** -- a genuine, substantial reduction (more than
halved), the largest of any gating approach tried this investigation
(the confidence/duration gate and the contextual-property gate both
found essentially zero separation). **But piece-level FP did NOT
improve at all -- 8/8 pieces still have at least one false flag**,
same as before the gate. Per-piece note-level counts all dropped
(e.g. piece 2288: 14->2, piece 2221: 46->14), but every single piece
would still produce at least one false "wrong note" accusation using
this gate alone.

**Comparison to production** (same 8 pieces): 3/8 pieces flagged, 8
total flags / ~7211 notes (~0.11%). Even at 2.57%, this gate's
note-level FP rate remains roughly 23x production's -- real
improvement, not yet production-viable.

**Explicit scope limit, as instructed:** FP rate is measured on real
(MusicNet) audio; recall is measured ONLY on synthetic injections.
Recall on genuinely real mistakes remains unmeasured here, as
everywhere else this investigation.

**Verdict: PARTIAL, REAL improvement -- the first gating approach
this investigation has found that produces more than a wash.** Not
forced into a positive frame (piece-level FP is unchanged, the
remaining note-level rate is still far from production's own bar) nor
a negative one (treating a 57% FP reduction with a 1/6 recall cost as
"no help" would understate what was actually found). Not shippable as
a standalone gate; the mechanism (cross-model agreement) is validated
as directionally sound in a way nothing else tried this week was.
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

CREPE_MIN_CONF = 65  # same floor as worker.find_wrong_note_candidates' MIN_CONF


def crepe_cross_check(crepe_events: list[dict], window: tuple[float, float],
                       expected_midi: int) -> dict:
    """
    Independent CREPE read over the SAME window the Basic Pitch
    adapter used for this note. Returns whether CREPE's own evidence
    CONFIRMS a disagreement with the expected pitch -- never confirms
    from absence of evidence alone.
    """
    if window is None:
        return {"confirmed": False, "reason": "no window (deletion case)"}
    window_start, window_end = window
    in_window = [e for e in crepe_events
                 if window_start <= e.get("time_sec", -1) <= window_end
                 and e.get("confidence", 0) >= CREPE_MIN_CONF]
    if not in_window:
        return {"confirmed": False, "reason": "no confident CREPE event in window"}

    for e in in_window:
        crepe_midi = e.get("midi_raw", e.get("midi"))
        if crepe_midi is None:
            continue
        if not is_substitution(expected_midi, int(crepe_midi)):
            # CREPE agrees with (or is ambiguous about) the expected
            # pitch -- does not corroborate Basic Pitch's flag.
            return {"confirmed": False, "reason": f"CREPE agrees (MIDI {crepe_midi})"}

    # Every confident CREPE event in the window disagrees with the
    # expected pitch too -- independent corroboration.
    dominant = in_window[0].get("midi_raw", in_window[0].get("midi"))
    return {"confirmed": True, "reason": f"CREPE independently disagrees (MIDI {dominant})"}


def run_recall_check():
    print("=== Recall preservation: 6 verified synthetic injections ===")
    manifest = json.loads((HERE / "injected_cases" / "manifest.json").read_text())
    injected_bp_events = json.loads((HERE / "injected_cases" / "basic_pitch_events.json").read_text())
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AudioToScoreMatcher()

    before, after = 0, 0
    for case in manifest:
        pid = case["piece"]
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        label = DATA / "labels" / f"{pid}.csv"
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
        was_flagged = target_note["verdict"] == "substitution"
        if was_flagged:
            before += 1

        crepe_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
        cross = crepe_cross_check(crepe_events, target_note.get("window"), target_note["expected_midi"])
        still_flagged = was_flagged and cross["confirmed"]
        if still_flagged:
            after += 1

        print(f"case {case['case']} (piece {pid}): before={was_flagged} "
              f"cross_check={cross['confirmed']} ({cross['reason']}) after={still_flagged}")

    print(f"\nRecall: {before}/6 (adapter alone) -> {after}/6 (with cross-model gate)")
    return before, after


def run_fp_check():
    print("\n=== False positives: 8 real (unmodified) MusicNet dev pieces ===")
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AudioToScoreMatcher()
    bp_data = json.loads((HERE / "basic_pitch_events.json").read_text())

    before_total, after_total, notes_total = 0, 0, 0
    pieces_before, pieces_after = 0, 0
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
        confirmed = []
        for n in subs:
            cross = crepe_cross_check(crepe_events, n.get("window"), n["expected_midi"])
            if cross["confirmed"]:
                confirmed.append(n)

        before_total += len(subs)
        after_total += len(confirmed)
        notes_total += len(na)
        if subs:
            pieces_before += 1
        if confirmed:
            pieces_after += 1

        print(f"{pid} ({instrument}): before={len(subs)} after={len(confirmed)} / {len(na)} notes")

    print(f"\nFP summary BEFORE cross-check: {pieces_before}/8 pieces, "
          f"{before_total}/{notes_total} notes ({100.0*before_total/notes_total:.2f}%)")
    print(f"FP summary AFTER cross-check:  {pieces_after}/8 pieces, "
          f"{after_total}/{notes_total} notes ({100.0*after_total/notes_total:.2f}%)")
    return before_total, after_total, notes_total


def main():
    recall_before, recall_after = run_recall_check()
    fp_before, fp_after, notes_total = run_fp_check()

    print("\n=== Summary ===")
    print(f"Recall: {recall_before}/6 -> {recall_after}/6")
    print(f"FP (note-level): {100.0*fp_before/notes_total:.2f}% -> {100.0*fp_after/notes_total:.2f}%")
    print("Production reference (same 8 pieces, 2026-11-01/11-05 measurements): "
          "3/8 pieces flagged, 8 total flags / ~7211 notes (~0.11%)")


if __name__ == "__main__":
    main()
