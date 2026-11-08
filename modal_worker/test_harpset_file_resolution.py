"""
Regression tests for HARPSET file resolution in harpset_evaluation.py
(2026-11-08 integrity fix).

Background: metadata.csv omits (13, N) and lists a phantom (12, N) whose
files do not exist on disk. The evaluation must resolve performances from
the naming convention checked against disk, not from metadata.csv.

Deterministic and fast: file-existence checks and partitura score diffing
only. No model inference, no network, no GPU.

Run:  pytest modal_worker/test_harpset_file_resolution.py -q
(requires the validation venv: /Users/matthewwu/.cache/mediant_validation/venv)
"""
import csv
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import harpset_evaluation as he

EXPECTED_N_PIECES = ["01", "02", "03", "04", "05", "06", "09", "13"]
ABSENT_N_PIECES = ["07", "08", "10", "11", "12"]
EXPECTED_N_TOTAL = 26


def _n_ground_truth(pid: str):
    if not he.performance_exists(pid, "N"):
        return None
    return he.ground_truth_pitch_errors(pid, "N")


@pytest.fixture(scope="module")
def manifest():
    return he.build_manifest()


def test_n_variant_resolves_to_exactly_expected_pieces(manifest):
    pieces = [r["piece"] for r in manifest
              if r["variant"] == "N" and r["gt"]]
    assert pieces == EXPECTED_N_PIECES


def test_total_n_variant_deviations_is_26(manifest):
    total = sum(len(r["gt"]) for r in manifest
                if r["variant"] == "N" and r["gt"])
    assert total == EXPECTED_N_TOTAL


@pytest.mark.parametrize("pid", ABSENT_N_PIECES)
def test_absent_n_variants_are_excluded(pid):
    assert not he.performance_exists(pid, "N")
    assert _n_ground_truth(pid) is None


def test_piece_12_n_is_absent_despite_metadata_row():
    # Proves the fix does not "fix" the wrong gap: metadata.csv still lists
    # (12, N), but neither file exists, so file-existence must say absent.
    rows = list(csv.DictReader(open(he.HARPSET / "metadata" / "metadata.csv")))
    assert any(r["piece_id"] == "12" and r["variant"] == "N" for r in rows)
    assert not he.score_file("12", "N").exists()
    assert not he.audio_file("12", "N").exists()
    assert not he.performance_exists("12", "N")


def test_piece_13_n_is_included_with_real_deviation_count():
    # metadata.csv has no (13, N) row; the files exist on disk and the
    # score diff against O yields 4 pitch deviations.
    rows = list(csv.DictReader(open(he.HARPSET / "metadata" / "metadata.csv")))
    assert not any(r["piece_id"] == "13" and r["variant"] == "N" for r in rows)
    assert he.performance_exists("13", "N")
    gt = _n_ground_truth("13")
    assert gt is not None and len(gt) == 4


def test_all_original_performances_present():
    for pid in he.ALL_PIECES:
        assert he.performance_exists(pid, "O"), pid
