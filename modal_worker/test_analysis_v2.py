"""
Exercises the ACTUAL staging request handler for the MEDIANT_ANALYSIS_V2_ENABLED
feature flag (worker.py's run_full_analysis -> _run_analysis_v2), not just a
direct call to an inner helper.

run_full_analysis is a real @app.function/@modal.fastapi_endpoint-decorated
Modal function, called here via run_full_analysis.local(payload) -- Modal's
documented in-process call that runs the real decorated function body with
no container, no network to Modal, and no billing. Only httpx (video/score
download + webhook POST) is faked, to local fixture bytes instead of the
network.

Each case runs in a FRESH interpreter subprocess, not in-process. Reason,
confirmed directly: test_analysis.py (collected earlier in the same pytest
session, alphabetically before this file) blanket-mocks `modal` in
sys.modules at import time. Because `import modal` inside worker.py then
resolves to that same mock, `app.function`/`modal.fastapi_endpoint` decorate
a MagicMock instead of the real Modal SDK, and run_full_analysis.local(...)
silently does nothing (confirmed: webhook_capture stayed empty) instead of
running the real function body. A subprocess keeps this file independent of
collection order, same fix as test_score_completeness.py applied to music21.

Run:
    /Users/matthewwu/.cache/mediant_validation/venv/bin/python -m pytest \
        modal_worker/test_analysis_v2.py -v
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent

FIX_ROOT = Path("/Users/matthewwu/.cache/mediant_validation/musicnet_raw")
WAV_2220 = FIX_ROOT / "musicnet/train_data/2220.wav"
WAV_2186 = FIX_ROOT / "musicnet/train_data/2186.wav"       # wrong piece, for case C
MIDI_2220 = FIX_ROOT / "musicnet_midis/Bach/2220_cs3-4sar.mid"
WAV_2289 = FIX_ROOT / "musicnet/train_data/2289.wav"        # genuinely 3 pages
MIDI_2289 = FIX_ROOT / "musicnet_midis/Bach/2289_vs2_3.mid"

pytestmark = pytest.mark.skipif(
    not WAV_2220.exists(), reason="MusicNet fixture cache not present on this machine"
)

# The child process: renders the real page-omr fixture, fakes httpx (GET for
# video/score, POST for the webhook), imports worker.py fresh (`modal` is
# real in a clean interpreter), calls run_full_analysis.local(payload), and
# prints the captured webhook body as one JSON line prefixed "RESULT ".
_CHILD = r"""
import csv, json, os, sys, types
from pathlib import Path
sys.path.insert(0, sys.argv[1])

scenario = json.loads(sys.argv[2])

import build_visual_validation_corpus as bvc
import httpx

FIX_ROOT = Path("/Users/matthewwu/.cache/mediant_validation/musicnet_raw")
METADATA = FIX_ROOT / "musicnet_metadata.csv"
VIDEO_URL = "https://fixture.invalid/video"
SCORE_URL = "https://fixture.invalid/score"          # page 1 / legacy single-page field
SCORE_URL_TMPL = "https://fixture.invalid/score_page{}"
WEBHOOK_URL = "https://fixture.invalid/webhook"

if scenario.get("v2_enabled"):
    os.environ["MEDIANT_ANALYSIS_V2_ENABLED"] = "1"
else:
    os.environ.pop("MEDIANT_ANALYSIS_V2_ENABLED", None)

url_to_bytes = {}
n_pages = 1
score_urls = []
if scenario.get("video_path"):
    url_to_bytes[VIDEO_URL] = Path(scenario["video_path"]).read_bytes()
if scenario.get("render_score_from_midi"):
    with open(METADATA) as f:
        row = next(r for r in csv.DictReader(f) if r["id"] == scenario["score_piece_id"])
    out_dir = Path(sys.argv[3])
    entry = bvc.build_corpus_entry(scenario["score_piece_id"], scenario["render_score_from_midi"], row, out_dir)
    assert entry is not None
    n_pages = entry["n_pages"]
    expected_pages = scenario.get("expected_n_pages")
    assert expected_pages is None or n_pages == expected_pages, f"n_pages={n_pages} expected={expected_pages}"
    corrupt_page = scenario.get("corrupt_page")
    for n in range(1, n_pages + 1):
        page_path = out_dir / f"{scenario['score_piece_id']}_page{n}.png"
        page_bytes = b"not a real image" if n == corrupt_page else page_path.read_bytes()
        url = SCORE_URL if n == 1 else SCORE_URL_TMPL.format(n)
        url_to_bytes[url] = page_bytes
        score_urls.append(url)

webhook_capture = []

class _FakeResponse:
    def __init__(self, content, status_code=200, content_type="image/png"):
        self.content = content
        self.status_code = status_code
        self.text = ""
        self.headers = {"content-type": content_type}
    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("fixture error", request=None, response=self)
    def json(self):
        return {}

class _FakeClient:
    def __init__(self, *a, **kw): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get(self, url, follow_redirects=True):
        if url in url_to_bytes:
            return _FakeResponse(url_to_bytes[url])
        raise RuntimeError(f"test fixture has no GET response for {url!r}")
    def post(self, url, json=None, headers=None):
        webhook_capture.append(json)
        return _FakeResponse(b"{}", status_code=200)

httpx.Client = _FakeClient

_anth = types.ModuleType("anthropic")
class _FakeAnthropic:
    def __init__(self, **kw):
        raise AssertionError("V2 must never construct an Anthropic client")
_anth.Anthropic = _FakeAnthropic
sys.modules["anthropic"] = _anth

import importlib.util
spec = importlib.util.spec_from_file_location("worker_v2_under_test", str(Path(sys.argv[1]) / "worker.py"))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

payload = {
    "take_id": "test-take-v2",
    "webhook_url": WEBHOOK_URL, "webhook_secret": None, "webhook_anon_key": None,
    "video_url": VIDEO_URL if scenario.get("video_path") else None,
    "video_mime_type": "audio/wav",
    "score_url": SCORE_URL if scenario.get("render_score_from_midi") else None,
    "score_urls": score_urls if scenario.get("render_score_from_midi") else None,
    "score_mime_type": "image/png", "score_path": "test/score.png",
    "instrument": "Cello", "piece_title": "Cello Suite 3, 4. Sarabande",
    "composer": "Bach", "time_sig": "3/4", "start_measure": 1,
    "gemini_api_key": scenario.get("gemini_api_key"),
    "anthropic_api_key": scenario.get("anthropic_api_key"),
}
w.run_full_analysis.local(payload)
print("N_PAGES " + str(n_pages))
print("RESULT " + json.dumps(webhook_capture))
"""


def _run_scenario(scenario: dict, tmp_path: Path) -> list:
    capture, _n_pages = _run_scenario_with_pages(scenario, tmp_path)
    return capture


def _run_scenario_with_pages(scenario: dict, tmp_path: Path) -> tuple[list, int]:
    proc = subprocess.run(
        [sys.executable, "-c", _CHILD, str(HERE), json.dumps(scenario), str(tmp_path)],
        capture_output=True, text=True, timeout=600,
    )
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT ")]
    n_pages_lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("N_PAGES ")]
    assert proc.returncode == 0 and lines, f"child failed rc={proc.returncode}: {proc.stderr[-3000:]}"
    n_pages = int(n_pages_lines[-1][len("N_PAGES "):]) if n_pages_lines else 1
    return json.loads(lines[-1][len("RESULT "):]), n_pages


def test_flag_on_complete_fixture_runs_v2_and_reports_unavailable(tmp_path):
    """Case A: a verified, single-page score/audio pair succeeds through the
    real handler. The result MUST still be performanceErrorAssessment.status
    == "unavailable" (no validated detector exists), not a crash and not
    "passed"."""
    capture = _run_scenario({
        "v2_enabled": True, "video_path": str(WAV_2220),
        "render_score_from_midi": str(MIDI_2220), "score_piece_id": "2220",
    }, tmp_path)
    assert len(capture) == 1, capture
    body = capture[0]
    assert body["flags"] == [], "V2 must never emit flags -- no validated detector exists"
    assert body["performanceErrorAssessment"]["status"] == "unavailable", body["performanceErrorAssessment"]
    assert body["scoreCompleteness"]["pages_total"] == 1
    assert body["measureLayout"] is not None and body["measureLayout"]["measures"], \
        "score reading must have produced measures"
    assert "v2_page_omr" in " ".join(body["pipelineDebug"])


def test_flag_on_known_incomplete_score_is_never_treated_as_complete(tmp_path):
    """Case B: MusicNet 2220's rendered page is independently known (this
    round's completeness work) to cover only ~45% of the reference's real
    notes. V2's completeness signal for a REAL upload has no ground truth to
    compare against (by design -- see Task 1, "do not pretend real uploads
    have ground-truth note counts"), so this asserts the only thing that IS
    true for a real upload: coverage is never fabricated as a numeric
    ground-truth fraction, and the result is never upgraded to a pass/fail
    performance grade."""
    capture = _run_scenario({
        "v2_enabled": True, "video_path": str(WAV_2220),
        "render_score_from_midi": str(MIDI_2220), "score_piece_id": "2220",
    }, tmp_path)
    body = capture[0]
    completeness = body["scoreCompleteness"]
    assert completeness["coverage_fraction"] is None, completeness
    assert completeness["coverage_source"].startswith("unavailable"), completeness
    assert body["performanceErrorAssessment"]["status"] == "unavailable"
    assert body["performanceErrorAssessment"]["status"] != "passed"


def test_flag_on_mismatched_audio_rejected_for_performance_assessment(tmp_path):
    """Case C: 2220's score paired with a DIFFERENT piece's audio (2186) must
    not be treated as a valid performance assessment. The hard requirement is
    that status is never "passed" and alignment is never silently "accepted"
    on mismatched input."""
    if not WAV_2186.exists():
        pytest.skip("2186.wav fixture not cached on this machine")
    capture = _run_scenario({
        "v2_enabled": True, "video_path": str(WAV_2186),
        "render_score_from_midi": str(MIDI_2220), "score_piece_id": "2220",
    }, tmp_path)
    body = capture[0]
    assert body["performanceErrorAssessment"]["status"] != "passed"
    assert body["flags"] == []
    if body["alignmentStatus"] == "accepted":
        pytest.fail(f"mismatched audio must not be accepted for alignment: {body}")


def test_multipage_score_processes_every_page_in_order(tmp_path):
    """MEDIANT -- Engineering Directive: Multi-Page Score Recognition.
    Fixture 2289 genuinely renders to 3 pages (confirmed directly, not
    assumed). All 3 must be processed, measures must be numbered
    continuously and in strictly ascending page order across the page
    boundaries, and the alignment stage (which needs a note_array spanning
    every page, not just page 1) must actually run -- this is the exact
    thing the old single-page-only bridge could not do."""
    if not WAV_2289.exists() or not MIDI_2289.exists():
        pytest.skip("2289 fixtures not cached on this machine")
    capture, n_pages = _run_scenario_with_pages({
        "v2_enabled": True, "video_path": str(WAV_2289),
        "render_score_from_midi": str(MIDI_2289), "score_piece_id": "2289",
        "expected_n_pages": 3,
    }, tmp_path)
    assert n_pages == 3, "fixture 2289 must still render to 3 pages for this test to mean anything"
    body = capture[0]
    completeness = body["scoreCompleteness"]
    assert completeness["pages_total"] == 3, completeness
    assert completeness["pages_processed"] == 3, completeness
    assert completeness["status"].startswith("complete"), completeness

    measures = body["measureLayout"]["measures"]
    assert len(measures) > 0, "no measures recognized at all"
    numbers = [m["number"] for m in measures]
    assert numbers == sorted(numbers) and len(set(numbers)) == len(numbers), \
        f"measure numbers must be strictly ascending with no duplicates: {numbers}"
    pages_seen = [m["page"] for m in measures]
    assert pages_seen == sorted(pages_seen), \
        f"measures must stay in page-ascending order across page boundaries: {pages_seen}"
    assert set(pages_seen) == {1, 2, 3}, \
        f"all 3 pages must contribute measures, not just page 1: {set(pages_seen)}"

    debug_joined = " ".join(body["pipelineDebug"])
    assert "v2_note_array" in debug_joined, body["pipelineDebug"]
    assert "v2_alignment" in debug_joined, (
        "alignment must actually run against the COMBINED multi-page score, "
        "not silently stop after page 1", body["pipelineDebug"])
    assert body["performanceErrorAssessment"]["status"] == "unavailable", body["performanceErrorAssessment"]
    assert body["flags"] == []


def test_multipage_score_with_one_failed_page_reports_incomplete_and_identifies_it(tmp_path):
    """Deliberately-failed-page scenario (directive section 3): corrupting
    one of 2289's 3 real pages must not silently drop it, must not crash
    the whole analysis, and must mark the result incomplete while still
    processing the pages that ARE readable."""
    if not WAV_2289.exists() or not MIDI_2289.exists():
        pytest.skip("2289 fixtures not cached on this machine")
    capture, n_pages = _run_scenario_with_pages({
        "v2_enabled": True, "video_path": str(WAV_2289),
        "render_score_from_midi": str(MIDI_2289), "score_piece_id": "2289",
        "expected_n_pages": 3, "corrupt_page": 2,
    }, tmp_path)
    assert n_pages == 3
    body = capture[0]
    completeness = body["scoreCompleteness"]
    assert completeness["pages_total"] == 3, completeness
    assert completeness["pages_processed"] == 2, completeness
    assert completeness["status"].startswith("incomplete"), completeness
    assert "2" in (completeness.get("partial_error") or ""), completeness

    measures = body["measureLayout"]["measures"]
    pages_seen = {m["page"] for m in measures}
    assert pages_seen == {1, 3}, f"the two good pages' measures must still be present: {pages_seen}"
    assert body["performanceErrorAssessment"]["status"] == "unavailable", body["performanceErrorAssessment"]
    assert body["flags"] == []


def test_flag_off_preserves_existing_v1_entry_path(tmp_path):
    """Case E: with the flag unset, run_full_analysis must take the existing
    V1 path, not V2 -- proven here by hitting V1's own pre-existing, already
    documented early guard (raises if GOOGLE_AI_API_KEY/gemini_api_key is
    missing) rather than anything V2-shaped. If V2 were wrongly entered
    instead, this would fail on a missing score/video fixture setup, not on
    the Gemini-key guard."""
    capture = _run_scenario({
        "v2_enabled": False, "video_path": str(WAV_2220),
        "gemini_api_key": None, "anthropic_api_key": None,
    }, tmp_path)
    assert len(capture) == 1, capture
    body = capture[0]
    assert "error" in body, body
    assert "GOOGLE_AI_API_KEY" in body["error"], body
    assert "performanceErrorAssessment" not in body, "V1's error path must not carry any V2 field"
