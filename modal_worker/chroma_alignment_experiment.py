"""
Task 2 feasibility experiment ("MEDIANT -- Audio Recovery: Measurement
Fix + New Architecture Feasibility", 2026-10-31): chroma/CQT-based
continuous-feature score-to-audio alignment, as a genuinely different
formulation vs the production pitch-SEQUENCE DTW (dtw_align_to_score),
which depends on CREPE's discrete event extraction.

NOT wired into the production pipeline. A standalone experiment script,
same category as validate_alignment_against_musicnet.py /
inject_audio_mistakes.py -- needs the same isolated real-audio-stack
venv, not part of the Modal image.

Builds a synthetic chroma "template" from the symbolic score (one frame
per FRAME_HOP_SEC, pitch-class energy from whichever note is sounding,
at a nominal average tempo derived from the real audio's duration), and
extracts real chroma_cqt from the real MusicNet audio. The two are
aligned with librosa.sequence.dtw (continuous DTW over feature
matrices, not over discrete note events -- CREPE's pitch/onset
extraction is bypassed entirely). Each ground-truth note's own onset is
then looked up through the resulting warping path to get a predicted
measure, scored with the exact same classify_alignment() the production
validator (validate_alignment_against_musicnet.py) uses, for a direct
apples-to-apples comparison.

Instrument transposition (written vs sounding pitch) is applied via
transpose_for_instrument(), the same production helper
find_wrong_note_candidates uses, even though every test piece here
(Violin/Cello) is non-transposing -- for correctness and so this script
generalizes to transposing instruments.

Measured result (2026-10-31, real audio, real MusicNet data):
current pipeline (CREPE events + dtw_align_to_score) vs this approach,
measure-localization accuracy, same 5 pieces:

  piece  instrument  current   chroma-DTW
  2220   Cello        0.4%      66.8%
  2242   Violin       49.8%     78.3%
  2296   Cello        2.0%      80.1%
  2293   Cello        82.5%     88.7%
  2295   Cello        83.2%     85.3%

2220/2242/2296 are the three pieces where the prior sprint's diagnostic
(real CREPE events vs MusicNet's own ground-truth events, both fed
through the UNCHANGED dtw_align_to_score) found the current DTW
algorithm itself defective independent of input quality (7.4%/6.8%/9.0%
even with perfect events). This experiment shows those same three
pieces align dramatically better under a continuous-feature formulation
-- strong evidence the defect is in the discrete pitch-SEQUENCE DTW
formulation itself, not fixable by improving CREPE's event extraction.
2293/2295 (where the current approach already does reasonably) show a
small additional gain, not a regression.

Also notable: this approach's "unmatched" rate (no measure assigned to
a real ground-truth note at all) is near-zero on 4/5 pieces, vs the
current approach's 2.3%-41.5% -- every audio frame gets SOME alignment
by construction, so every ground-truth note gets a prediction, right or
wrong. The current discrete-event approach can simply fail to produce
any aligned event near a given ground-truth note at all; this one can't.

What this does NOT demonstrate (see the owning directive's own
constraint: "do not confuse improved alignment with demonstrated
mistake-detection accuracy"): whether find_wrong_note_candidates (or an
equivalent) can be adapted to consume this chroma-DTW's continuous
alignment output and produce reliable wrong-note flags. That is a
separate, unbuilt, unverified step -- this script only tests the
ALIGNMENT stage.

Usage:
    python chroma_alignment_experiment.py
(piece IDs/instruments are hardcoded in PIECES below; data expected at
/Users/matthewwu/.cache/mediant_validation/data/{midis,audio,labels}/)
"""
import sys
import time
from pathlib import Path

import librosa
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402
from validate_alignment_against_musicnet import (  # noqa: E402
    midi_score_to_dict, load_ground_truth, calibrate_assumptions,
    classify_alignment, pct,
)

DATA_DIR = Path("/Users/matthewwu/.cache/mediant_validation/data")
FRAME_HOP_SEC = 0.10
N_CHROMA = 12
MUSICNET_SR = 44100

PIECES = {
    "2220": "Cello",   # current pipeline fails even with perfect ground-truth events
    "2242": "Violin",  # current pipeline fails even with perfect ground-truth events
    "2296": "Cello",   # current pipeline fails even with perfect ground-truth events
    "2293": "Cello",   # current pipeline already works reasonably -- regression check
    "2295": "Cello",   # current pipeline already works reasonably -- regression check
}


def build_score_events(score: dict, beats_per_measure: int, transpose_semitones: int):
    """Flatten score into (onset_beat, duration_beats, pitch_class, measure)
    tuples, in beat units, SOUNDING pitch (transposition applied)."""
    events = []
    cur_beat_base = 0.0
    for m in score["measures"]:
        for n in m.get("notes", []):
            if n.get("is_rest") or not n.get("pitch"):
                continue
            midi = w.midi_from_name(n["pitch"])
            if midi is None:
                continue
            sounding_pc = (midi + transpose_semitones) % 12
            onset_beat = cur_beat_base + (n.get("beat", 1.0) - 1.0)
            dur_beats = max(n.get("duration_beats", 1.0), 0.1)
            events.append((onset_beat, dur_beats, sounding_pc, m["number"]))
        cur_beat_base += beats_per_measure
    events.sort(key=lambda e: e[0])
    return events


def render_template(score_events, total_beats: float, sec_per_beat: float):
    """One chroma column per FRAME_HOP_SEC across the score's nominal
    render timeline (average tempo). Returns (template[12,T], measure_per_frame[T])."""
    total_sec = total_beats * sec_per_beat
    n_frames = max(int(total_sec / FRAME_HOP_SEC) + 1, 1)
    template = np.zeros((N_CHROMA, n_frames), dtype=np.float64)
    measure_per_frame: list[int | None] = [None] * n_frames

    for onset_beat, dur_beats, pc, measure_num in score_events:
        onset_sec = onset_beat * sec_per_beat
        end_sec = (onset_beat + dur_beats) * sec_per_beat
        f0 = int(onset_sec / FRAME_HOP_SEC)
        f1 = min(int(end_sec / FRAME_HOP_SEC) + 1, n_frames)
        for f in range(max(f0, 0), f1):
            template[pc, f] = 1.0
            measure_per_frame[f] = measure_num

    # Rests/gaps: carry the previous measure forward (a real ground-truth
    # onset can still land here via the warping path) and give silence a
    # small uniform floor rather than a literal zero column, which is
    # degenerate for a euclidean-distance DTW.
    last_measure = None
    for f in range(n_frames):
        if template[:, f].sum() == 0:
            template[:, f] = 0.05
        if measure_per_frame[f] is not None:
            last_measure = measure_per_frame[f]
        else:
            measure_per_frame[f] = last_measure
    return template, measure_per_frame


def run_one_piece(piece_id: str, instrument: str) -> dict:
    midi_path = DATA_DIR / "midis" / f"{piece_id}.mid"
    wav_path = DATA_DIR / "audio" / f"{piece_id}.wav"
    label_path = DATA_DIR / "labels" / f"{piece_id}.csv"

    score = midi_score_to_dict(midi_path)
    beats_per_measure = w.beats_per_measure_from_time_sig(score["time_signature"])
    ground_truth = load_ground_truth(label_path)
    if not calibrate_assumptions(score, ground_truth, beats_per_measure, piece_id):
        return {"piece": piece_id, "error": "calibration failed"}

    transpose = w.transpose_for_instrument(instrument) or 0
    score_events = build_score_events(score, beats_per_measure, transpose)
    if not score_events:
        return {"piece": piece_id, "error": "no pitched notes in score"}

    y, sr = librosa.load(str(wav_path), sr=MUSICNET_SR, mono=True)
    audio_duration_sec = len(y) / sr

    last_onset_beat, last_dur, _, _ = score_events[-1]
    total_beats = last_onset_beat + last_dur
    sec_per_beat = audio_duration_sec / total_beats  # nominal, piece-average tempo

    template, measure_per_frame = render_template(score_events, total_beats, sec_per_beat)

    hop_length = int(round(sr * FRAME_HOP_SEC))
    audio_chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
    audio_n_frames = audio_chroma.shape[1]

    t0 = time.time()
    D, wp = librosa.sequence.dtw(X=template, Y=audio_chroma, metric="euclidean")
    dtw_elapsed = time.time() - t0

    wp_sorted = wp[::-1]  # librosa returns end -> start
    audio_to_template: dict[int, int] = {}
    for t_idx, a_idx in wp_sorted:
        audio_to_template.setdefault(a_idx, t_idx)

    outcomes = []
    for g in ground_truth:
        true_measure = int(g["start_beat"] // beats_per_measure) + 1
        a_idx = max(0, min(int(g["onset_sec"] / FRAME_HOP_SEC), audio_n_frames - 1))
        t_idx = audio_to_template.get(a_idx)
        if t_idx is None:
            nearest = min(audio_to_template.keys(), key=lambda k: abs(k - a_idx))
            t_idx = audio_to_template[nearest]
        predicted_measure = measure_per_frame[min(t_idx, len(measure_per_frame) - 1)]
        outcomes.append(classify_alignment(predicted_measure, true_measure))

    counts = {k: outcomes.count(k) for k in ("correct", "off_by_one", "wrong", "unmatched")}
    return {
        "piece": piece_id, "instrument": instrument, "n_notes": len(outcomes),
        "counts": counts, "correct_pct": pct(counts, "correct"),
        "dtw_elapsed_sec": dtw_elapsed, "sec_per_beat": sec_per_beat,
    }


if __name__ == "__main__":
    for piece_id, instrument in PIECES.items():
        t0 = time.time()
        try:
            r = run_one_piece(piece_id, instrument)
        except Exception as e:
            r = {"piece": piece_id, "error": f"{type(e).__name__}: {e}"}
        r["wall_sec"] = time.time() - t0
        print(r)
