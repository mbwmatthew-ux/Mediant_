"""
Validates dtw_align_to_score / flatten_score_notes — the production
score-alignment logic that maps a detected audio note to the measure it
belongs to — against MusicNet (Zenodo doi:10.5281/zenodo.5120004): real
classical recordings whose note-level labels (pitch, onset/offset time,
beat position) were built by DTW-aligning scores to audio and
musician-verified to ~4% error.

Why this exists: validate_pitch_against_tinysol.py validated pitch
DETECTION in isolation (isolated notes, no score) and explicitly could
not validate score-ALIGNMENT, because TinySOL's notes are never played
against a score. This is that missing half — see the Session note
"2026-10-11 — TinySOL pitch-detection validation" for why URMP (which
would also cover this) stayed inaccessible, and the follow-up session
note for why MusicNet was picked over Bach10/ASAP as the accessible
alternative.

Scope, deliberately narrow: restricted to MusicNet's three truly solo
(unaccompanied, monophonic) categories — Solo Violin, Solo Cello, Solo
Flute. run_pitch_tracking is a monophonic CREPE-based detector; every
other MusicNet ensemble category (string quartet, wind quintet,
accompanied violin, piano trio, ...) is polyphonic audio it was never
designed to read, and feeding it those would measure the detector
failing at a task it doesn't claim to do, not the alignment logic this
script exists to check. All 24 solo pieces turn out to be unaccompanied
Bach (violin partitas/sonatas, cello suites, the A-minor flute
partita) — real single-line recordings, the same shape of thing this
app actually analyzes.

Method, per piece:
  1. Parse the REFERENCE MIDI (musicnet_midis/ — "the reference MIDI
     files used to construct the MusicNet labels", i.e. literally the
     score the ground truth itself derives from) into the same
     {"measures": [...]} shape parse_musicxml produces (worker.py:1166),
     via music21 — so dtw_align_to_score and flatten_score_notes run
     completely unmodified, on the exact shape they were built for.
  2. Run the REAL audio (from musicnet.tar.gz) through the REAL,
     unmodified run_pitch_tracking.
  3. Run dtw_align_to_score on those detected events against that score.
  4. For each detected event, find the closest ground-truth note by
     onset TIME (from the label CSV) and check whether the measure DTW
     assigned matches the measure that note's start_beat falls in.

Ground truth's start_beat -> measure number: MusicNet's label CSVs give
beat position but not a measure number directly (confirmed against the
pytorch_musicnet reference loader). measure = floor(start_beat /
beats_per_measure) + 1, using the SAME beats_per_measure_from_time_sig
helper (worker.py:5835) production code uses. This assumes a constant
time signature across the piece and that MusicNet's "beat" is the
notated beat (matching music21's el.beat) rather than a quarterLength —
calibrate_assumptions() below checks both before any piece is scored,
since quarter_lengths_per_beat's own docstring (worker.py:5845) is a
specific warning that these two units silently diverge in compound time.

Not part of the Modal image — same category as replay.py /
validate_pitch_against_tinysol.py. Needs the same torch/torchcrepe/
librosa/soundfile/scipy/music21 stack as the TinySOL script, in the
same kind of isolated venv (see that script's docstring for why).

Usage:
    python validate_alignment_against_musicnet.py --data-dir /tmp/musicnet_data [--limit N]

Expects --data-dir to contain:
    midis/{id}.mid    (musicnet_midis.tar.gz, pre-extracted per id)
    audio/{id}.wav    (musicnet.tar.gz train_data or test_data, per id)
    labels/{id}.csv   (musicnet.tar.gz train_labels or test_labels, per id)
"""
import argparse
import csv
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402

# MusicNet's "ensemble" column -> this app's own canonical instrument
# string (src/lib/instruments.js INSTRUMENTS). Only the three genuinely
# monophonic solo categories are mapped — see module docstring.
INSTRUMENT_MAP = {
    "Solo Violin": "Violin",
    "Solo Cello": "Cello",
    "Solo Flute": "Flute",
}

# MusicNet's label CSVs give start_time/end_time as sample indices at
# the dataset's fixed audio sample rate (44.1 kHz PCM .wav throughout).
MUSICNET_SR = 44100


def load_rows(metadata_csv: Path) -> list[dict]:
    rows = []
    with open(metadata_csv, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            mapped = INSTRUMENT_MAP.get(row["ensemble"])
            if mapped is None:
                continue
            rows.append({
                "id":          row["id"],
                "instrument":  mapped,
                "composer":    row["composer"],
                "composition": row["composition"],
                "movement":    row["movement"],
            })
    return rows


def midi_score_to_dict(midi_path: Path) -> dict:
    """
    Builds the same {"measures": [{"number", "notes": [...]}],
    "time_signature"} shape parse_musicxml produces, from a MIDI file
    instead of MusicXML. Only the fields dtw_align_to_score and
    flatten_score_notes actually read (pitch, beat, duration_beats,
    is_rest) — parse_musicxml's dynamics/wedges/key/articulation are
    MusicXML-only features this alignment check has no use for.
    """
    import music21 as m21

    score = m21.converter.parse(str(midi_path))
    parts = score.parts
    if not parts:
        return {"measures": [], "time_signature": None}

    # A genuinely solo piece should have exactly one pitched part, but
    # MIDI import sometimes splits a track in two (e.g. a near-empty
    # control track) — take whichever has the most notes, same
    # tie-break parse_musicxml uses for picking the student's part.
    playable = [p for p in parts if len(p.flatten().notes) > 0] or list(parts)
    part = max(playable, key=lambda p: len(p.flatten().notes))

    time_sig_str = None
    for el in part.flatten().recurse():
        if isinstance(el, m21.meter.TimeSignature):
            time_sig_str = el.ratioString
            break

    measures_out = []
    for m in part.getElementsByClass(m21.stream.Measure):
        notes_out = []
        for el in m.flatten().notesAndRests:
            if isinstance(el, m21.note.Rest):
                notes_out.append({
                    "pitch": None, "is_rest": True,
                    "beat": float(el.beat),
                    "duration_beats": float(el.duration.quarterLength),
                })
            elif isinstance(el, m21.note.Note):
                notes_out.append({
                    "pitch": el.pitch.nameWithOctave, "is_rest": False,
                    "beat": float(el.beat),
                    "duration_beats": float(el.duration.quarterLength),
                })
            elif isinstance(el, m21.chord.Chord):
                for n in el.notes:
                    notes_out.append({
                        "pitch": n.pitch.nameWithOctave, "is_rest": False,
                        "beat": float(el.beat),
                        "duration_beats": float(el.duration.quarterLength),
                    })
        measures_out.append({"number": m.number, "notes": notes_out})

    return {"measures": measures_out, "time_signature": time_sig_str}


def load_ground_truth(label_csv_path: Path) -> list[dict]:
    """Ground-truth notes, sorted by onset time in seconds."""
    rows = []
    with open(label_csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append({
                "onset_sec":  int(row["start_time"]) / MUSICNET_SR,
                "note":       int(row["note"]),
                "start_beat": float(row["start_beat"]),
            })
    rows.sort(key=lambda r: r["onset_sec"])
    return rows


def calibrate_assumptions(score: dict, ground_truth: list[dict], beats_per_measure: int,
                           piece_label: str) -> bool:
    """
    Sanity-checks the start_beat -> measure formula BEFORE trusting it to
    score anything, rather than silently producing confident nonsense
    (the exact failure mode the has_repeats check in parse_musicxml
    exists to avoid for a different reason). Compares the measure count
    implied by the ground truth's last note against the measure count
    music21 actually parsed from the same piece's reference MIDI. A
    piece more than ~10% off is flagged and excluded rather than scored.
    """
    if not ground_truth or not score.get("measures"):
        return False
    implied_last_measure = int(ground_truth[-1]["start_beat"] // beats_per_measure) + 1
    actual_last_measure = score["measures"][-1]["number"]
    if actual_last_measure <= 0:
        return False
    ratio = implied_last_measure / actual_last_measure
    ok = 0.85 <= ratio <= 1.15
    print(f"  [calibrate] {piece_label}: ground-truth implies {implied_last_measure} "
          f"measures, MIDI parse has {actual_last_measure} -> "
          f"{'OK' if ok else 'MISMATCH, excluding this piece'}")
    return ok


def classify_alignment(predicted_measure: int | None, true_measure: int | None) -> str:
    if predicted_measure is None or true_measure is None:
        return "unmatched"
    diff = abs(predicted_measure - true_measure)
    if diff == 0:
        return "correct"
    if diff == 1:
        return "off_by_one"
    return "wrong"


# A detected event is only matched to a ground-truth note if one exists
# within this window of its onset — otherwise it's an event with nothing
# real nearby to compare against, which is a detection-side question
# (already covered by validate_pitch_against_tinysol.py), not an
# alignment-side one.
_MATCH_WINDOW_SEC = 0.25


def nearest_ground_truth_measure(event_time_sec: float, ground_truth: list[dict],
                                  beats_per_measure: int) -> int | None:
    best = min(ground_truth, key=lambda g: abs(g["onset_sec"] - event_time_sec))
    if abs(best["onset_sec"] - event_time_sec) > _MATCH_WINDOW_SEC:
        return None
    return int(best["start_beat"] // beats_per_measure) + 1


def pct(counts: dict, key: str) -> float:
    total = sum(counts.values())
    return 100.0 * counts.get(key, 0) / total if total else 0.0


def print_breakdown(title: str, grouped: dict):
    print(f"\n{title}")
    for key in sorted(grouped):
        c = grouped[key]
        total = sum(c.values())
        print(f"  {key:40s} n={total:4d}  correct={pct(c,'correct'):5.1f}%  "
              f"off_by_one={pct(c,'off_by_one'):5.1f}%  wrong={pct(c,'wrong'):5.1f}%  "
              f"unmatched={pct(c,'unmatched'):5.1f}%")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True,
                     help="directory containing midis/, audio/, labels/ subfolders")
    ap.add_argument("--limit", type=int, default=None,
                     help="cap the number of pieces processed, for a quick smoke run")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    metadata_csv = data_dir / "musicnet_metadata.csv"
    rows = load_rows(metadata_csv)
    if args.limit:
        rows = rows[:args.limit]

    print(f"[validate] {len(rows)} solo pieces to process")

    results = []
    t_start = time.time()
    for i, row in enumerate(rows):
        piece_label = f"{row['id']} ({row['composer']} {row['composition']} - {row['movement']})"
        midi_path = data_dir / "midis" / f"{row['id']}.mid"
        wav_path = data_dir / "audio" / f"{row['id']}.wav"
        label_path = data_dir / "labels" / f"{row['id']}.csv"
        if not (midi_path.exists() and wav_path.exists() and label_path.exists()):
            print(f"  MISSING FILES for {piece_label}")
            continue

        try:
            score = midi_score_to_dict(midi_path)
            beats_per_measure = w.beats_per_measure_from_time_sig(score["time_signature"])
            ground_truth = load_ground_truth(label_path)

            if not calibrate_assumptions(score, ground_truth, beats_per_measure, piece_label):
                continue

            wav_bytes = wav_path.read_bytes()
            events = w.run_pitch_tracking(wav_bytes, instrument=row["instrument"])
            aligned = w.dtw_align_to_score(
                events, score, start_measure=1, beats_per_measure=beats_per_measure,
                end_measure=None,
            )
            if not aligned:
                print(f"  DTW DECLINED on {piece_label} (score has <4 pitched notes?)")
                continue

            for ev in aligned:
                true_measure = nearest_ground_truth_measure(
                    ev["time_sec"], ground_truth, beats_per_measure)
                outcome = classify_alignment(ev["measure"], true_measure)
                results.append({
                    **row, "piece_label": piece_label, "outcome": outcome,
                    "predicted_measure": ev["measure"], "true_measure": true_measure,
                    "time_sec": ev["time_sec"],
                })
        except Exception as e:
            print(f"  ERROR on {piece_label}: {type(e).__name__}: {e}")
            continue

        elapsed = time.time() - t_start
        print(f"  ...{i + 1}/{len(rows)} pieces  ({elapsed:.0f}s elapsed)")

    by_instrument = defaultdict(lambda: defaultdict(int))
    by_piece       = defaultdict(lambda: defaultdict(int))
    overall        = defaultdict(int)
    for r in results:
        by_instrument[r["instrument"]][r["outcome"]] += 1
        by_piece[r["piece_label"]][r["outcome"]] += 1
        overall[r["outcome"]] += 1

    print("\n" + "=" * 70)
    print(f"OVERALL  (n={len(results)} notes, {time.time() - t_start:.0f}s total)")
    for k in ("correct", "off_by_one", "wrong", "unmatched"):
        print(f"  {k:14s} {overall.get(k, 0):5d}  ({pct(overall, k):.1f}%)")

    print_breakdown("BY INSTRUMENT", by_instrument)
    print_breakdown("BY PIECE", by_piece)
    print("=" * 70)

    misses_path = Path(__file__).parent / "musicnet_alignment_misses.csv"
    with open(misses_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "id", "instrument", "piece_label", "outcome",
            "predicted_measure", "true_measure", "time_sec",
        ])
        writer.writeheader()
        for r in results:
            if r["outcome"] != "correct":
                writer.writerow({k: r[k] for k in writer.fieldnames})
    print(f"\nNon-correct cases written to {misses_path}")


if __name__ == "__main__":
    main()
