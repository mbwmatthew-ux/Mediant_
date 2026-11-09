"""
Tests for assess_score_completeness in local_e2e_integration_harness.py.

Run:  /Users/matthewwu/.cache/mediant_validation/venv/bin/python -m pytest \\
          modal_worker/test_score_completeness.py -v

Exercises the completeness check directly against two real cached MusicNet
fixtures, not the full OMR / Basic Pitch / Parangonar chain:
  - 2289 (Violin Partita 1 Sarabande): single-voice MIDI, label CSV present
    -> must report complete.
  - 2220 (Cello Suite 3 Sarabande): 4-track MIDI whose extra tracks hold real
    chord voices -> must report incomplete.

Each assessment runs in a fresh interpreter. test_analysis.py replaces music21
with a MagicMock in sys.modules at import time (setdefault), so when the full
suite runs it first, an in-process music21 import here would silently get the
mock and produce empty parts. A subprocess keeps this file independent of
import order.
"""
import json
import subprocess
import sys
from pathlib import Path

HARNESS_DIR = Path(__file__).resolve().parent

FIX_ROOT = Path("/Users/matthewwu/.cache/mediant_validation/musicnet_raw")
MIDI_2289 = FIX_ROOT / "musicnet_midis/Bach/2289_vs2_3.mid"
LABELS_2289 = FIX_ROOT / "musicnet/train_labels/2289.csv"
MIDI_2220 = FIX_ROOT / "musicnet_midis/Bach/2220_cs3-4sar.mid"
LABELS_2220 = FIX_ROOT / "musicnet/train_labels/2220.csv"

INCOMPLETE = "incomplete - unsuitable for complete-performance grading"

_CHILD = (
    "import json, sys\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "from pathlib import Path\n"
    "from local_e2e_integration_harness import assess_score_completeness as a\n"
    "label = None if sys.argv[3] == '-' else Path(sys.argv[3])\n"
    "print('RESULT ' + json.dumps(a(Path(sys.argv[2]), label)))\n"
)


def assess(midi_path, label_csv_path=None) -> dict:
    proc = subprocess.run(
        [sys.executable, "-c", _CHILD, str(HARNESS_DIR), str(midi_path),
         str(label_csv_path) if label_csv_path else "-"],
        capture_output=True, text=True, timeout=600,
    )
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT ")]
    assert proc.returncode == 0 and lines, f"child failed rc={proc.returncode}: {proc.stderr[-2000:]}"
    return json.loads(lines[-1][len("RESULT "):])


def test_positive_complete_fixture():
    res = assess(MIDI_2289, LABELS_2289)
    assert res["status"] == "complete", res
    assert res["omitted_voices_detected"] is False, res


def test_negative_incomplete_fixture():
    res = assess(MIDI_2220, LABELS_2220)
    assert res["status"] == INCOMPLETE, res
    assert res["omitted_voices_detected"] is True, res
    assert res["other_tracks_genuine_omission_count"] > 0, res


def test_no_reference_never_fabricates_coverage():
    res = assess(MIDI_2220, None)
    assert res["coverage_fraction"] is None, res
    assert res["reference_note_count"] is None, res
    assert res["coverage_source"].startswith("unavailable"), res
    # Binary fallback still applies without a reference.
    assert res["omitted_voices_detected"] is True, res
    assert res["status"] == INCOMPLETE, res
