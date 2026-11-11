"""
Held-out generalization check for candidate F (sequence_matcher_gated_
benchmark.py's suppress_neighbor_pitch_class), run against this
project's frozen 6-piece set (2204/Flute, 2218/Cello, 2222/Cello,
2297/Cello, 2244/Violin, 2289/Violin) -- never opened for any
recall/FP tuning decision until this exact check, same discipline
this project applied to chroma-DTW and Parangonar before any GO
decision ("stop tuning on the dev set, validate on the frozen set
before declaring a win").

False-positive rate only (no recall check possible here -- this
project's 6 verified synthetic injections are all drawn from the 8 DEV
pieces; the frozen 6 have no injected-mistake cases of their own).
This is the generalization check the dev-set result in
sequence_matcher_gated_benchmark.py's own docstring/output needs before
it can be called a real finding rather than an in-sample result.

Reuses, unmodified: `sequence_matcher_benchmark.run_candidate_D`,
`sequence_matcher_gated_benchmark.gate_candidate_D`/
`suppress_neighbor_pitch_class`. No new thresholds. No production code
touched.
"""
import json
from pathlib import Path

import numpy as np
import soundfile as sf
import partitura as pt
import parangonar as pa

import worker as w
from validate_alignment_against_musicnet import load_rows
from sequence_matcher_benchmark import run_candidate_D, build_performed_events
from sequence_matcher_gated_benchmark import gate_candidate_D, suppress_neighbor_pitch_class

HERE = Path(__file__).parent
DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
FROZEN_PIECES = ["2204", "2218", "2222", "2297", "2244", "2289"]


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AudioToScoreMatcher()
    bp_data = json.loads((HERE / "basic_pitch_events_frozen6.json").read_text())

    print("=== Frozen 6-piece held-out FP check: D vs E vs F ===")
    totals = {k: {"fp": 0, "pieces_flagged": 0} for k in "DEF"}
    notes_total = 0
    by_instrument = {k: {} for k in "DEF"}

    for pid in FROZEN_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        events = bp_data[pid]["events"]

        wav_bytes = (DATA / "audio" / f"{pid}.wav").read_bytes()
        audio, sr = sf.read(str(DATA / "audio" / f"{pid}.wav"))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        crepe_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)

        d_result = run_candidate_D(na, alignment, events, beats_per_measure)
        performed_events = build_performed_events(events)
        e_confirmed = gate_candidate_D(d_result, performed_events, crepe_events)
        f_kept = suppress_neighbor_pitch_class(d_result, na)

        totals["D"]["fp"] += len(d_result["substitutions"])
        totals["D"]["pieces_flagged"] += 1 if d_result["substitutions"] else 0
        totals["E"]["fp"] += len(e_confirmed)
        totals["E"]["pieces_flagged"] += 1 if e_confirmed else 0
        totals["F"]["fp"] += len(f_kept)
        totals["F"]["pieces_flagged"] += 1 if f_kept else 0

        notes_total += len(na)
        for k, fp in (("D", len(d_result["substitutions"])), ("E", len(e_confirmed)), ("F", len(f_kept))):
            by_instrument[k].setdefault(instrument, {"fp": 0, "notes": 0})
            by_instrument[k][instrument]["fp"] += fp
            by_instrument[k][instrument]["notes"] += len(na)

        print(f"{pid} ({instrument}): D_sub={len(d_result['substitutions'])} "
              f"E_confirmed={len(e_confirmed)} F_kept={len(f_kept)} / {len(na)} notes")

    print(f"\n=== Summary (frozen 6 pieces, {notes_total} notes) ===")
    for k in "DEF":
        fp = totals[k]["fp"]
        pct = 100.0 * fp / notes_total
        print(f"{k}: {totals[k]['pieces_flagged']}/6 pieces flagged, {fp}/{notes_total} notes ({pct:.2f}%)")

    print("\n=== Per-instrument ===")
    for k in "DEF":
        for instr, d in by_instrument[k].items():
            pct = 100.0 * d["fp"] / d["notes"] if d["notes"] else 0.0
            print(f"{k} {instr}: {d['fp']}/{d['notes']} ({pct:.2f}%)")


if __name__ == "__main__":
    main()
