# Audiveris Cross-Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Audiveris — a real, independent OMR engine already installed in this project's Modal image — into the score-reading pipeline as a genuine second read source, so a measure Claude reads consistently-but-wrongly (agreement with itself, not with reality) and a measure where Claude's own reads disagree can both be caught, instead of only the disagreement case as today.

**Architecture:** A new per-row Modal function runs Audiveris on the exact same dewarped, background-cropped row crops already produced for Claude, dispatched in parallel (before Claude's own reads) so its 60-120s latency mostly hides behind Claude's existing read time. Its per-row measure numbering is aligned to Claude's global numbering positionally, only when the two counts for a row agree. That alignment feeds two places: a new tie-break step inside the existing reconciliation loop (for when Claude's own reads disagree with each other), and the existing `oemer_measure` parameter of `fuse_measure_confidence` (for when Claude's reads agree with each other, or only one succeeded).

**Tech Stack:** Python 3.11, Modal (`@app.function`, `.spawn()`/`.get()`), Audiveris 5.10.2 CLI (already installed in the pinned image), `music21` (via the existing `parse_score_document`), this project's own `check()`-harness test suite (`modal_worker/test_analysis.py`).

**Spec:** `docs/superpowers/specs/2026-09-23-audiveris-cross-validation-design.md`

## Global Constraints

- No feature flag. Every Audiveris failure mode (crash, timeout, row/measure count mismatch) degrades to exactly today's current behavior (`oemer_measure=None`) — this is a fail-open design invariant, not an incidental property, and every task's tests must prove it, not just its happy path.
- Audiveris runs exactly once per row. Never retried, never re-run — it is a deterministic classical algorithm, not a sampling model.
- PDF pages dispatch zero Audiveris calls (`_prepare_score_rows` already gives PDF pages `"rows": []` — an existing, unchanged scope boundary).
- The new per-row Audiveris function is decorated with the exact same `image` object `worker.py` already builds at module scope (no new Modal image, no new deployment infrastructure).
- The new per-row Audiveris function's own Modal-level timeout is 150 seconds; its internal subprocess timeout is 140 seconds (leaving Modal's own timeout as a backstop, not the primary timeout signal).
- Never guess an alignment. A row's Audiveris measure count must exactly equal Claude's measure count for that row before any measure in that row is aligned; on any mismatch, every measure in that row is left with `oemer_measure=None`, identical to today.

---

### Task 1: Extract a shared Audiveris-invocation helper (no behavior change)

**Files:**
- Modify: `modal_worker/worker.py:1337-1408` (`convert_visual_score_to_musicxml`)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Produces: `_run_audiveris_command(command: list[str], output_dir: str, env: dict, timeout_s: int) -> tuple[bytes | None, str | None, str]` — returns `(exported_bytes, exported_path, diagnostic)`. `exported_bytes` is `None` on any failure (non-zero exit code, no export file found, or a timeout); `exported_path` is the path `find_exported_musicxml` returned (or `None` alongside a `None` `exported_bytes`); `diagnostic` is always a string (subprocess stderr/stdout, or a timeout message), for the caller to log or return as an error detail. Never raises.
- Consumes: the existing `find_exported_musicxml(output_dir: str) -> str | None` (`worker.py:1321`), unchanged.

This task exists because Task 2's new per-row Audiveris runner needs the exact same "run the CLI, find the export, read its bytes" logic that `convert_visual_score_to_musicxml` already has — extracting it now (before Task 2 needs it) means Task 2 calls a tested helper instead of duplicating ~15 lines of subprocess/tempdir plumbing.

- [ ] **Step 1: Write the failing test for the new helper's success path**

Add to `modal_worker/test_analysis.py`, near the top-level test functions (anywhere before `main()`):

```python
def test_run_audiveris_command_returns_export_bytes_on_success():
    print("\n[156] _run_audiveris_command returns the exported file's bytes "
          "when the CLI succeeds and an export is found")
    from unittest.mock import patch, MagicMock
    import os

    with patch("worker.subprocess.run") as mock_run, \
         patch("worker.find_exported_musicxml") as mock_find, \
         patch("builtins.open", create=True) as mock_open:
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
        mock_find.return_value = "/tmp/fake/output/score.mxl"
        mock_open.return_value.__enter__.return_value.read.return_value = b"FAKE_MXL_BYTES"

        exported_bytes, exported_path, diagnostic = w._run_audiveris_command(
            ["audiveris", "-batch"], "/tmp/fake/output", {}, 30)

    check("returns the exported bytes read from the found path",
          exported_bytes == b"FAKE_MXL_BYTES", str(exported_bytes))
    check("returns the path find_exported_musicxml found",
          exported_path == "/tmp/fake/output/score.mxl", str(exported_path))
    check("diagnostic is a string even on success", isinstance(diagnostic, str), str(diagnostic))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -A2 "\[156\]"`
Expected: `AttributeError: module 'worker' has no attribute '_run_audiveris_command'` (surfaced as an ERROR line for `test_run_audiveris_command_returns_export_bytes_on_success` — the test isn't registered in `main()`'s tuple yet, so run it directly first via a one-off `python3 -c "import test_analysis as t; t.test_run_audiveris_command_returns_export_bytes_on_success()"` from the `modal_worker` directory to confirm the failure before wiring it into `main()` in Step 6.)

- [ ] **Step 3: Write the failing test for the helper's failure paths**

```python
def test_run_audiveris_command_returns_none_on_failure_or_timeout():
    print("\n[157] _run_audiveris_command returns None bytes (never raises) on a "
          "non-zero exit code, a missing export, or a timeout")
    from unittest.mock import patch, MagicMock
    import subprocess as real_subprocess

    with patch("worker.subprocess.run") as mock_run, \
         patch("worker.find_exported_musicxml") as mock_find:
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="boom")
        mock_find.return_value = None
        exported_bytes, exported_path, diagnostic = w._run_audiveris_command(
            ["audiveris", "-batch"], "/tmp/fake/output", {}, 30)
    check("non-zero exit code with no export returns None bytes",
          exported_bytes is None, str(exported_bytes))
    check("diagnostic carries the stderr text", "boom" in diagnostic, diagnostic)

    with patch("worker.subprocess.run") as mock_run, \
         patch("worker.find_exported_musicxml") as mock_find:
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
        mock_find.return_value = None
        exported_bytes, exported_path, diagnostic = w._run_audiveris_command(
            ["audiveris", "-batch"], "/tmp/fake/output", {}, 30)
    check("zero exit code but no export file found still returns None bytes",
          exported_bytes is None, str(exported_bytes))

    with patch("worker.subprocess.run") as mock_run:
        mock_run.side_effect = real_subprocess.TimeoutExpired(cmd=["audiveris"], timeout=30)
        exported_bytes, exported_path, diagnostic = w._run_audiveris_command(
            ["audiveris", "-batch"], "/tmp/fake/output", {}, 30)
    check("a subprocess timeout is caught, not raised", exported_bytes is None, str(exported_bytes))
    check("the timeout diagnostic mentions the timeout", "30" in diagnostic, diagnostic)
```

- [ ] **Step 4: Run both tests to verify they fail the same way (missing function)**

Run: `cd modal_worker && python3 -c "import test_analysis as t; t.test_run_audiveris_command_returns_export_bytes_on_success(); t.test_run_audiveris_command_returns_none_on_failure_or_timeout()"`
Expected: `AttributeError: module 'worker' has no attribute '_run_audiveris_command'`

- [ ] **Step 5: Implement `_run_audiveris_command` and refactor `convert_visual_score_to_musicxml` to use it**

Add this new function immediately before `convert_visual_score_to_musicxml` (i.e. right after `find_exported_musicxml` at `worker.py:1321-1335`):

```python
def _run_audiveris_command(command: list[str], output_dir: str, env: dict,
                            timeout_s: int) -> tuple[bytes | None, str | None, str]:
    """
    Runs ONE Audiveris CLI invocation and returns (exported bytes,
    exported path, diagnostic text). `exported_bytes`/`exported_path` are
    both None on any failure (non-zero exit, no export found, or a
    timeout); `diagnostic` is always populated (from stderr/stdout, or a
    timeout message) for the caller to log or return as an error detail.
    Never raises.

    Extracted out of convert_visual_score_to_musicxml so the per-row
    Audiveris cross-validation runner (_run_audiveris_on_row) can reuse
    the exact same "run the CLI, find find_exported_musicxml's output,
    read its bytes" logic without duplicating it — the two callers only
    differ in how many commands they try (convert_visual_score_to_musicxml
    retries a plain -export after -transcribe -export fails; a single row
    crop has no page-level transcription step to retry, so it calls this
    once). See docs/superpowers/specs/2026-09-23-audiveris-cross-validation-design.md.
    """
    import subprocess
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                 timeout=timeout_s, env=env)
    except subprocess.TimeoutExpired:
        return None, None, f"Audiveris timed out after {timeout_s}s"
    diagnostic = (result.stderr or result.stdout or "").strip()
    exported_path = find_exported_musicxml(output_dir)
    if result.returncode != 0 or not exported_path:
        return None, exported_path, diagnostic
    with open(exported_path, "rb") as f:
        return f.read(), exported_path, diagnostic
```

Now replace the body of `convert_visual_score_to_musicxml` (`worker.py:1337-1408`) — specifically its retry loop and the code after it — with:

```python
        last_output = ""
        exported_bytes = None
        exported_path = None
        for idx, command in enumerate(commands, start=1):
            print(f"[audiveris] running OMR conversion attempt {idx}: {' '.join(command[:-1])} <score>")
            exported_bytes, exported_path, last_output = _run_audiveris_command(
                command, output_dir, env, 300)
            if exported_bytes is not None:
                break
            print(f"[audiveris] attempt {idx} did not produce export. output={last_output[:1000]}")

        if exported_bytes is None:
            return {
                "error": f"Audiveris produced no MusicXML export: {last_output[:500] or 'no output'}",
                "measures": [],
                "source": "audiveris",
            }

        print(f"[audiveris] exported {exported_path}")
        parsed = parse_score_document(exported_bytes, start_measure)
        parsed["source"] = "audiveris+music21"
        parsed["omr_export_path"] = os.path.basename(exported_path)
        return parsed
```

Leave everything ABOVE the retry loop in `convert_visual_score_to_musicxml` (the `suffix` check, the `tempfile.TemporaryDirectory()` setup, `commands = [...]`) exactly as it is — only the retry loop's body and the code after it change. The `import subprocess` line already at the top of `convert_visual_score_to_musicxml` can be removed since `_run_audiveris_command` now does its own `import subprocess` internally — but leave `import os` and `import tempfile` there since `convert_visual_score_to_musicxml` still uses them directly.

- [ ] **Step 6: Register both new tests in `main()`'s tuple and run the full suite**

In `modal_worker/test_analysis.py`'s `main()` function, find the line containing `test_unresolved_measure_trims_a_merged_run_instead_of_deleting_it):` (the last entry in the big call tuple) and add the two new tests right before it:

```python
              test_unresolved_measure_trims_a_merged_run_instead_of_deleting_it,
              test_run_audiveris_command_returns_export_bytes_on_success,
              test_run_audiveris_command_returns_none_on_failure_or_timeout):
```

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -n 15`
Expected: `613/613 checks passed` (611 existing + this task's checks — count the exact number of `check(...)` calls added across both new tests and confirm the total matches; do not hardcode 613 if the actual count differs).

- [ ] **Step 7: Commit**

```bash
cd /Users/matthewwu/repos/mediant-ui-shell
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "refactor(worker): extract _run_audiveris_command, no behavior change

Pulls the 'run the CLI, find the export, read its bytes' logic out of
convert_visual_score_to_musicxml so the new per-row Audiveris runner
(next task) can reuse it instead of duplicating it."
```

---

### Task 2: Add the per-row Audiveris runner

**Files:**
- Modify: `modal_worker/worker.py` (new function, placed near `convert_visual_score_to_musicxml`)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `_run_audiveris_command` (Task 1), `parse_score_document` (existing, `worker.py:1312`), the module-level `image` and `app` objects (existing, defined near `worker.py:30-90`).
- Produces two functions, following the EXACT existing split this codebase already uses for `_generate_reference_audio_background` / `generate_reference_audio_background` (`worker.py:9330`, `worker.py:9503-9504`) — a plain, undecorated function holding all the real logic, plus a thin `@app.function`-decorated wrapper Modal actually calls remotely. This split exists because Modal's decorators are blanket-mocked in this test harness (`sys.modules.setdefault("modal", MagicMock())`), which "turns a decorated function into an unrelated MagicMock and makes it untestable directly" (quoting `_generate_reference_audio`'s own docstring, `worker.py:9332-9334`) — a directly-decorated function's real body would never run under test.
  - `_run_audiveris_on_row(row_bytes: bytes) -> dict` — plain function, all the real logic. Returns `{"measures": [...], "source": "audiveris", ...}` on success, or `{"error": "...", "measures": []}` on any failure. Always parses starting at measure 1 (row-local numbering — Task 4 handles aligning this to Claude's global numbering). Tests call this directly.
  - `run_audiveris_on_row(row_bytes: bytes) -> dict` — `@app.function(image=image, timeout=150)`-decorated thin wrapper; its entire body is `return _run_audiveris_on_row(row_bytes)`. Task 4 dispatches this one via `.spawn()`, never the plain one (only a Modal-decorated function has `.spawn()`/`.get()` at all).

- [ ] **Step 1: Write the failing test for the success path**

```python
def test_run_audiveris_on_row_returns_parsed_measures_on_success():
    print("\n[158] _run_audiveris_on_row returns parsed measures tagged "
          "source='audiveris' when Audiveris succeeds on a row crop")
    from unittest.mock import patch

    with patch("worker._run_audiveris_command") as mock_cmd, \
         patch("worker.parse_score_document") as mock_parse:
        mock_cmd.return_value = (b"FAKE_MXL_BYTES", "/tmp/fake/row.mxl", "")
        mock_parse.return_value = {"measures": [{"number": 1, "notes": []}], "source": "music21"}

        result = w._run_audiveris_on_row(b"FAKE_ROW_PNG_BYTES")

    check("parse_score_document was called with the exported bytes, anchored at measure 1",
          mock_parse.call_args[0] == (b"FAKE_MXL_BYTES", 1), str(mock_parse.call_args))
    check("source is overwritten to 'audiveris', not left as 'music21'",
          result.get("source") == "audiveris", str(result))
    check("measures pass through unchanged",
          result.get("measures") == [{"number": 1, "notes": []}], str(result))
```

- [ ] **Step 2: Write the failing test for the failure path**

```python
def test_run_audiveris_on_row_returns_error_on_failure():
    print("\n[159] _run_audiveris_on_row returns an error dict (never raises) "
          "when Audiveris produces no export for a row")
    from unittest.mock import patch

    with patch("worker._run_audiveris_command") as mock_cmd:
        mock_cmd.return_value = (None, None, "no staff lines found")
        result = w._run_audiveris_on_row(b"FAKE_ROW_PNG_BYTES")

    check("returns an error, not a raised exception", "error" in result, str(result))
    check("error message carries the diagnostic",
          "no staff lines found" in result["error"], str(result))
    check("measures is an empty list on error", result.get("measures") == [], str(result))
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd modal_worker && python3 -c "import test_analysis as t; t.test_run_audiveris_on_row_returns_parsed_measures_on_success()"`
Expected: `AttributeError: module 'worker' has no attribute '_run_audiveris_on_row'`

- [ ] **Step 4: Implement `_run_audiveris_on_row` and its thin decorated wrapper**

Add this immediately after `convert_visual_score_to_musicxml` (after `worker.py:1337-1408`, following Task 1's edits):

```python
def _run_audiveris_on_row(row_bytes: bytes) -> dict:
    """
    Runs Audiveris on ONE already-dewarped, already-background-cropped
    row crop (see _prepare_score_rows) and returns the same ScoreResult
    shape as parse_score_document: {"measures": [...], "source":
    "audiveris", ...} on success, or {"error": ..., "measures": []} on
    any failure. Never raises.

    Always anchored at measure 1: Audiveris numbers measures within the
    row it was given, not the piece's global numbering. Aligning that
    row-local numbering to Claude's global numbering is the caller's
    job (read_score_notes_claude), not this function's.

    Runs exactly once per row, unlike Claude's repeated reads — Audiveris
    is a deterministic classical algorithm, so re-running it on the same
    bytes would produce identical output for no new information. See
    docs/superpowers/specs/2026-09-23-audiveris-cross-validation-design.md
    (Non-Goals).

    Kept plain (undecorated) so this test suite can call it directly —
    see run_audiveris_on_row below for the thin Modal-deployable wrapper,
    and _generate_reference_audio's docstring (worker.py:9330-9334) for
    why this split exists in this codebase already.
    """
    import os
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        home_dir = os.path.join(tmpdir, "home")
        input_path = os.path.join(tmpdir, "row.png")
        output_dir = os.path.join(tmpdir, "audiveris-output")
        for path in (home_dir, output_dir):
            os.makedirs(path, exist_ok=True)
        with open(input_path, "wb") as f:
            f.write(row_bytes)

        env = {
            **os.environ,
            "HOME": home_dir,
            "JAVA_TOOL_OPTIONS": "-Djava.awt.headless=true",
        }
        command = ["audiveris", "-batch", "-transcribe", "-export",
                   "-output", output_dir, "--", input_path]
        exported_bytes, _exported_path, diagnostic = _run_audiveris_command(
            command, output_dir, env, 140)

        if exported_bytes is None:
            return {"error": f"Audiveris produced no export for this row: "
                              f"{diagnostic[:500] or 'no output'}",
                    "measures": []}

        parsed = parse_score_document(exported_bytes, 1)
        parsed["source"] = "audiveris"
        return parsed


@app.function(image=image, timeout=150)
def run_audiveris_on_row(row_bytes: bytes) -> dict:
    """
    Modal-deployable wrapper, invoked via .spawn(). See
    _run_audiveris_on_row for the real logic.

    Decorated with the SAME `image` this whole app already builds —
    Audiveris is already installed there (see the apt_install/run_commands
    block near the top of this file) — so this needs no new Modal image
    or deployment infrastructure. The 150s Modal-level timeout leaves
    margin over the 140s internal subprocess timeout _run_audiveris_on_row
    passes to _run_audiveris_command, which itself leaves margin over the
    60-120s Audiveris typically takes on one row crop (confirmed via a
    live spike against a real photo's row, tonight).
    """
    return _run_audiveris_on_row(row_bytes)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd modal_worker && python3 -c "
import test_analysis as t
t.test_run_audiveris_on_row_returns_parsed_measures_on_success()
t.test_run_audiveris_on_row_returns_error_on_failure()
"`
Expected: both print `PASS` lines, no `FAIL`.

- [ ] **Step 6: Register both tests in `main()`'s tuple**

Add `test_run_audiveris_on_row_returns_parsed_measures_on_success,` and `test_run_audiveris_on_row_returns_error_on_failure,` to `main()`'s call tuple, right after Task 1's two new entries.

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -n 15`
Expected: all checks pass (previous total + this task's new checks).

- [ ] **Step 7: Commit**

```bash
cd /Users/matthewwu/repos/mediant-ui-shell
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add _run_audiveris_on_row + run_audiveris_on_row wrapper

Runs Audiveris on one already-cleaned row crop and returns parsed
measures tagged source='audiveris', or an error dict on any failure.
Split into a plain function (real logic, directly testable) and a thin
@app.function-decorated wrapper (Modal-deployable via .spawn()),
matching this codebase's existing _generate_reference_audio_background/
generate_reference_audio_background pattern. Not yet wired into
read_score_notes_claude — that's a later task."
```

---

### Task 3: Add `fuse_measure_confidence`'s new `disagree_omr_broke_tie` state

**Files:**
- Modify: `modal_worker/worker.py:5718` (`fuse_measure_confidence`)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: nothing new — this task only changes `fuse_measure_confidence` itself.
- Produces: `fuse_measure_confidence` now accepts a fourth possible value for its `claude_agreement` parameter: `"disagree_omr_broke_tie"`, alongside the existing `"agree"` / `"disagree"` / `"unavailable"`. This is a genuinely new state (not a repurposing of `"disagree"`), consumed by Task 5's reconciliation-loop change.

This task is independent of Tasks 1-2 and can be done at any point before Task 5, but per the spec, it is the load-bearing piece — it is what makes Audiveris data useful for the disagreement case at all, so it is sequenced early.

- [ ] **Step 1: Write the failing test**

```python
def test_fuse_measure_confidence_disagree_omr_broke_tie():
    print("\n[160] fuse_measure_confidence's new 'disagree_omr_broke_tie' state "
          "resolves with high confidence and needs_resolution=False")
    measure = {"number": 5, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]}
    validation = {"valid": True, "issues": []}

    result = w.fuse_measure_confidence("disagree_omr_broke_tie", measure, None, validation)
    check("needs_resolution is False when OMR broke the tie",
          result["needs_resolution"] is False, str(result))
    check("confidence is high", result["confidence"] == "high", str(result))
    check("reasons mention the tie-break", any("tie" in r.lower() for r in result["reasons"]), str(result))

    invalid_validation = {"valid": False, "issues": ["duration sum wrong"]}
    result_invalid = w.fuse_measure_confidence("disagree_omr_broke_tie", measure, None, invalid_validation)
    check("validator-invalid still wins over the tie-break state",
          result_invalid["needs_resolution"] is True, str(result_invalid))

    check("plain 'disagree' is UNCHANGED by this new state's addition",
          w.fuse_measure_confidence("disagree", measure, None, validation)["needs_resolution"] is True,
          "regression check")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd modal_worker && python3 -c "import test_analysis as t; t.test_fuse_measure_confidence_disagree_omr_broke_tie()"`
Expected: the first `check(...)` reports `FAIL` because today's `fuse_measure_confidence` falls through to its final `return {"confidence": "low", "needs_resolution": True, ...}` for any unrecognized `claude_agreement` string (it does not raise — confirm this by reading `worker.py:5718-5790`'s full body; if it instead raises for an unrecognized state, the test's failure mode is a traceback instead of a FAIL line, which is still an acceptable "verify it fails" outcome).

- [ ] **Step 3: Implement the new branch**

In `fuse_measure_confidence` (`worker.py:5718`), immediately after the existing:

```python
    if not validation.get("valid", False):
        return {"confidence": "low", "needs_resolution": True,
                "reasons": ["validator invalid: " + "; ".join(validation.get("issues", []))]}
```

add:

```python
    if claude_agreement == "disagree_omr_broke_tie":
        return {"confidence": "high", "needs_resolution": False,
                "reasons": ["Claude's own reads disagreed with each other; an "
                            "independent OMR (Audiveris) reading broke the tie"]}
```

Placing it right after the validator check (not before) preserves the "invalid always wins" rule the docstring already documents — a measure with `disagree_omr_broke_tie` that also fails deterministic validation is still routed to resolution, exactly like every other state.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd modal_worker && python3 -c "import test_analysis as t; t.test_fuse_measure_confidence_disagree_omr_broke_tie()"`
Expected: all `check(...)` calls print `PASS`.

- [ ] **Step 5: Register the test and run the full suite**

Add `test_fuse_measure_confidence_disagree_omr_broke_tie,` to `main()`'s call tuple.

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -n 15`
Expected: all checks pass, including every pre-existing `fuse_measure_confidence` test (this change is additive — verify no existing test that calls `fuse_measure_confidence` with `"agree"`/`"disagree"`/`"unavailable"` regressed).

- [ ] **Step 6: Commit**

```bash
cd /Users/matthewwu/repos/mediant-ui-shell
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add disagree_omr_broke_tie state to fuse_measure_confidence

A fourth claude_agreement state, additive to the existing agree/disagree/
unavailable three — used when Claude's own reads disagreed with each
other but an independent Audiveris reading matched exactly one of the
disagreeing candidates. Not yet produced by anything — the reconciliation
loop that will produce it is a later task."
```

---

### Task 4: Dispatch, collect, and align per-row Audiveris results

**Files:**
- Modify: `modal_worker/worker.py:4778` (`read_score_notes_claude`)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `run_audiveris_on_row` (Task 2's decorated wrapper, via `.spawn()`/`.get()` — NOT the plain `_run_audiveris_on_row`, which has no `.spawn()`), `_prepare_score_rows` (existing, unchanged).
- Produces: two new module-level pure functions (no Modal decoration, easily unit-testable):
  - `_group_measure_numbers_by_row(reads: list[dict]) -> dict[tuple[int, int], list[int]]` — for each measure number appearing in any of the given read-dicts (each shaped like a `read_score_notes_claude`-style result: `{"measures": [{"number": int, "page": int, "row": int, ...}, ...]}`), determines its `(page, row)` by strict majority across however many of the reads report that measure; a measure with no strict-majority row is omitted from every row's list (never guessed into row 1).
  - `_align_audiveris_measures(claude_numbers_by_row: dict[tuple[int, int], list[int]], audiveris_by_row: dict[tuple[int, int], dict]) -> dict[int, dict]` — for each row where the count of Claude's own measure numbers equals the count of that row's Audiveris measures, positionally zips them (sorted Claude numbers ↔ Audiveris's own row-local order) into a flat `{measure_number: audiveris_measure}` map; a row with mismatched counts, a missing Audiveris result, or an Audiveris error contributes nothing to the returned map.
  - Inside `read_score_notes_claude`: a new local variable `audiveris_by_row: dict[tuple[int, int], dict]`, populated right after `read_b` (before the existing error/agree/disagree branches), available to later tasks.

- [ ] **Step 1: Write the failing test for `_group_measure_numbers_by_row`**

```python
def test_group_measure_numbers_by_row_majority_vote():
    print("\n[161] _group_measure_numbers_by_row groups by strict-majority row, "
          "never guessing on a tie")
    read_a = {"measures": [
        {"number": 1, "page": 1, "row": 1, "notes": []},
        {"number": 2, "page": 1, "row": 1, "notes": []},
        {"number": 3, "page": 1, "row": 2, "notes": []},
    ]}
    read_b = {"measures": [
        {"number": 1, "page": 1, "row": 1, "notes": []},
        {"number": 2, "page": 1, "row": 2, "notes": []},  # disagrees with read_a on m.2's row
        {"number": 3, "page": 1, "row": 2, "notes": []},
    ]}
    result = w._group_measure_numbers_by_row([read_a, read_b])
    check("m.1: both reads agree it's row 1", result.get((1, 1)) == [1] or 1 in result.get((1, 1), []),
          str(result))
    check("m.3: both reads agree it's row 2", 3 in result.get((1, 2), []), str(result))
    check("m.2: a 1-1 tie between row 1 and row 2 is NOT guessed into either row",
          2 not in result.get((1, 1), []) and 2 not in result.get((1, 2), []), str(result))

    single_read_result = w._group_measure_numbers_by_row([read_a])
    check("a single read's row assignment is trusted outright (trivial majority)",
          single_read_result.get((1, 2)) == [3], str(single_read_result))
```

- [ ] **Step 2: Write the failing test for `_align_audiveris_measures`**

```python
def test_align_audiveris_measures_matches_only_on_equal_counts():
    print("\n[162] _align_audiveris_measures aligns a row's measures positionally "
          "only when Claude's and Audiveris's counts for that row are equal")
    claude_numbers_by_row = {(1, 1): [5, 6, 7], (1, 2): [8, 9]}
    audiveris_by_row = {
        (1, 1): {"measures": [{"number": 1, "notes": [{"pitch": "C4"}]},
                               {"number": 2, "notes": [{"pitch": "D4"}]},
                               {"number": 3, "notes": [{"pitch": "E4"}]}]},
        (1, 2): {"measures": [{"number": 1, "notes": [{"pitch": "F4"}]}]},  # count mismatch: 1 vs 2
    }
    aligned = w._align_audiveris_measures(claude_numbers_by_row, audiveris_by_row)
    check("row (1,1) with matching counts aligns all three measures",
          set(aligned.keys()) >= {5, 6, 7}, str(aligned.keys()))
    check("m.5 (Claude's first in its row) maps to Audiveris's first measure in that row",
          aligned[5]["notes"][0]["pitch"] == "C4", str(aligned.get(5)))
    check("row (1,2) with mismatched counts (2 vs 1) contributes NOTHING",
          8 not in aligned and 9 not in aligned, str(aligned))

    aligned_missing = w._align_audiveris_measures(
        {(1, 3): [10]}, {(1, 3): {"error": "no export", "measures": []}})
    check("a row with an Audiveris error contributes nothing",
          10 not in aligned_missing, str(aligned_missing))

    aligned_no_row = w._align_audiveris_measures({(1, 4): [11]}, {})
    check("a row with no Audiveris result at all contributes nothing",
          11 not in aligned_no_row, str(aligned_no_row))
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd modal_worker && python3 -c "import test_analysis as t; t.test_group_measure_numbers_by_row_majority_vote()"`
Expected: `AttributeError: module 'worker' has no attribute '_group_measure_numbers_by_row'`

- [ ] **Step 4: Implement both functions**

Add these two functions immediately before `read_score_notes_claude` (`worker.py:4778`):

```python
def _group_measure_numbers_by_row(reads: list[dict]) -> dict[tuple[int, int], list[int]]:
    """
    For each measure number appearing in ANY of the given reads,
    determines which (page, row) it belongs to by STRICT majority across
    however many of the reads report that measure at all, and groups
    measure numbers by their winning (page, row).

    Used both BEFORE Claude's own reads are reconciled (fed [read_a,
    read_b, read_c] so the tie-break step in the reconciliation loop
    knows each row's full Claude-side measure count before a winner is
    even picked) and AFTER reconciliation (fed [base_result], a single
    already-final read, for the per-measure loop's oemer_measure lookup)
    — a single-read list trivially satisfies "strict majority" for every
    measure it contains, so the same function serves both call shapes
    with no special-casing.

    A measure whose reads don't strictly majority-agree on its row (e.g.
    a genuine 1-1 tie between two different rows) is left out of EVERY
    row's list entirely — never guessed into row 1 or into whichever row
    happened to be checked first. This mirrors the exact "don't guess on
    ambiguous row provenance" rule read_score_notes_claude's own
    per-measure loop already applies to a single already-reconciled
    measure's row field.
    """
    by_number: dict[int, list[dict]] = {}
    for read in reads:
        if read.get("error"):
            continue
        for m in read.get("measures", []):
            by_number.setdefault(m["number"], []).append(m)

    result: dict[tuple[int, int], list[int]] = {}
    for number, candidates in by_number.items():
        rows = [(c.get("page", 1), c.get("row")) for c in candidates if c.get("row") is not None]
        if not rows:
            continue
        counts: dict[tuple[int, int], int] = {}
        for r in rows:
            counts[r] = counts.get(r, 0) + 1
        best_row, best_count = max(counts.items(), key=lambda kv: kv[1])
        if best_count * 2 <= len(rows):
            continue  # no strict majority — don't guess
        result.setdefault(best_row, []).append(number)
    return result


def _align_audiveris_measures(claude_numbers_by_row: dict[tuple[int, int], list[int]],
                               audiveris_by_row: dict[tuple[int, int], dict]) -> dict[int, dict]:
    """
    Given, for each (page, row), the list of Claude's own global measure
    numbers assigned to that row, and that row's Audiveris parse result
    (or a dict with an "error" key, or absent entirely), returns a flat
    {measure_number: audiveris_measure} map — one entry per measure that
    could be confidently aligned, entirely absent for any row where
    alignment isn't trustworthy.

    Alignment is POSITIONAL and ALL-OR-NOTHING PER ROW: Audiveris numbers
    measures 1..N within the row it was given, not globally (see
    _run_audiveris_on_row), so its Nth measure is assumed to correspond
    to the Nth of Claude's own row-assigned measure numbers (sorted
    ascending) — but ONLY when the two counts are exactly equal. A count
    mismatch means at least one side split/merged that row's content
    differently than the other, and guessing which measures line up
    would silently mismatch content across sources — every measure in
    that row is left OUT of the returned map instead, identical to
    oemer_measure=None for all of them. This is the same "don't guess"
    convention used throughout this file (_detect_page_bounds,
    _crop_row_background_columns, _group_measure_numbers_by_row above).
    """
    aligned: dict[int, dict] = {}
    for row_key, claude_numbers in claude_numbers_by_row.items():
        audiveris_result = audiveris_by_row.get(row_key)
        if not audiveris_result or audiveris_result.get("error"):
            continue
        audiveris_measures = audiveris_result.get("measures") or []
        if len(audiveris_measures) != len(claude_numbers):
            continue
        for claude_number, audiveris_measure in zip(sorted(claude_numbers), audiveris_measures):
            aligned[claude_number] = audiveris_measure
    return aligned
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `cd modal_worker && python3 -c "
import test_analysis as t
t.test_group_measure_numbers_by_row_majority_vote()
t.test_align_audiveris_measures_matches_only_on_equal_counts()
"`
Expected: all `check(...)` calls print `PASS`.

- [ ] **Step 6: Write the failing test for the dispatch/collect wiring inside `read_score_notes_claude`**

```python
def test_read_score_notes_claude_dispatches_audiveris_per_row():
    print("\n[163] read_score_notes_claude dispatches one Audiveris call per raster "
          "row and collects results before the function returns, but never for a PDF page")
    from unittest.mock import patch, MagicMock

    fake_prepared_pages = [
        {"page_mime": "image/jpeg", "page_bytes": b"page1",
         "rows": [{"row_bytes": b"row1a", "readability": {"quality": "good"},
                   "segmentation": {"measures": [], "confidence": 0.0}},
                  {"row_bytes": b"row1b", "readability": {"quality": "good"},
                   "segmentation": {"measures": [], "confidence": 0.0}}]},
        {"page_mime": "application/pdf", "page_bytes": b"pdf1", "rows": []},
    ]
    spawned_row_bytes = []

    def fake_spawn(row_bytes):
        spawned_row_bytes.append(row_bytes)
        handle = MagicMock()
        handle.get.return_value = {"measures": [], "source": "audiveris"}
        return handle

    with patch("worker._prepare_score_rows", return_value=fake_prepared_pages), \
         patch.object(w.run_audiveris_on_row, "spawn", side_effect=fake_spawn), \
         patch("worker._read_score_notes_claude_once",
               return_value={"measures": [], "error": "no measures needed for this test"}):
        w.read_score_notes_claude([(b"page1", "image/jpeg"), (b"pdf1", "application/pdf")],
                                   1, "Clarinet", "4/4", "fake-key")

    check("exactly one Audiveris call was dispatched per raster row (2 rows, not the PDF)",
          spawned_row_bytes == [b"row1a", b"row1b"], str(spawned_row_bytes))
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd modal_worker && python3 -c "import test_analysis as t; t.test_read_score_notes_claude_dispatches_audiveris_per_row()"`
Expected: the `check(...)` reports `FAIL` with `spawned_row_bytes == []` (nothing dispatched yet).

- [ ] **Step 8: Wire dispatch and collection into `read_score_notes_claude`**

Immediately after `prepared_pages = _prepare_score_rows(pages)` (`worker.py:4833` after Task 1-3's edits — re-grep for the exact current line before editing) and before `read_a = _read_score_notes_claude_once(...)`, add:

```python
    # Dispatch Audiveris on every raster row NOW, in parallel, before
    # Claude's own sequential reads begin below — Audiveris takes
    # 60-120s per row, so dispatching it first lets its latency mostly
    # hide behind Claude's own read time instead of stacking on top of
    # it. PDF pages already have "rows": [] from _prepare_score_rows
    # (image-only scope, unchanged), so they dispatch zero calls here.
    audiveris_handles: dict[tuple[int, int], object] = {}
    for page_idx, prepared_page in enumerate(prepared_pages, start=1):
        for row_idx, row in enumerate(prepared_page["rows"], start=1):
            audiveris_handles[(page_idx, row_idx)] = run_audiveris_on_row.spawn(row["row_bytes"])
```

Then, immediately after `read_b = _read_score_notes_claude_once(...)` and before the existing `if read_a.get("error") and read_b.get("error"):` line, add:

```python
    # Collect Audiveris results now — by this point Claude's own two
    # reads have taken real wall-clock time, so most/all Audiveris calls
    # are typically already done. Any failure (crash, timeout) here
    # degrades that row to oemer_measure=None everywhere downstream,
    # identical to today's current behavior — never raises.
    audiveris_by_row: dict[tuple[int, int], dict] = {}
    for row_key, handle in audiveris_handles.items():
        try:
            audiveris_by_row[row_key] = handle.get(timeout=160)
        except Exception as e:
            print(f"[read_score_notes_claude] Audiveris row {row_key} failed or timed out: {e}")
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd modal_worker && python3 -c "import test_analysis as t; t.test_read_score_notes_claude_dispatches_audiveris_per_row()"`
Expected: `PASS`.

- [ ] **Step 10: Register all four new tests and run the full suite**

Add `test_group_measure_numbers_by_row_majority_vote,`, `test_align_audiveris_measures_matches_only_on_equal_counts,`, and `test_read_score_notes_claude_dispatches_audiveris_per_row,` to `main()`'s call tuple.

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -n 15`
Expected: all checks pass, including every pre-existing `read_score_notes_claude` test (this task adds dispatch/collection but does not yet USE `audiveris_by_row` anywhere — later tasks do — so no existing behavior should change).

- [ ] **Step 11: Commit**

```bash
cd /Users/matthewwu/repos/mediant-ui-shell
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): dispatch and collect per-row Audiveris results in parallel

Adds _group_measure_numbers_by_row and _align_audiveris_measures (pure,
independently tested) and wires per-row Audiveris dispatch/collection
into read_score_notes_claude, running in parallel with Claude's own
reads. audiveris_by_row is collected but not yet consulted anywhere —
the tie-break and corroboration-lookup wiring are separate tasks."
```

---

### Task 5: Wire the tie-break into the reconciliation loop

**Files:**
- Modify: `modal_worker/worker.py` (the `for n in all_numbers:` reconciliation loop inside `read_score_notes_claude`, and the code immediately preceding it)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `_group_measure_numbers_by_row`, `_align_audiveris_measures` (Task 4), `_cross_source_measure_match` (existing, `worker.py:5658`, unchanged signature), the `"disagree_omr_broke_tie"` state (Task 3), `audiveris_by_row` (Task 4's collected results).
- Produces: when Claude's own reads disagree on a measure (no 2-of-3 majority) AND Audiveris's aligned measure for that measure number matches exactly one of the disagreeing candidates, that candidate is used as the winner and `claude_agreement[n]` is set to `"disagree_omr_broke_tie"` instead of `"disagree"`. Every other case (Audiveris matches zero or more than one candidate, or has no aligned data for that measure) is byte-for-byte identical to today's existing behavior.

- [ ] **Step 1: Write the failing test — Audiveris breaks a genuine 3-way tie**

```python
def test_read_score_notes_claude_audiveris_breaks_a_genuine_tie():
    print("\n[164] when Claude's three reads all disagree on a measure (no 2-of-3 "
          "majority), an Audiveris reading that matches exactly one candidate "
          "wins, tagged disagree_omr_broke_tie")
    from unittest.mock import patch, MagicMock

    def make_measure(pitch):
        return {"number": 1, "page": 1, "row": 1,
                "notes": [{"pitch": pitch, "is_rest": False, "beat": 1.0, "duration_beats": 4.0}]}

    read_a = {"measures": [make_measure("C4")], "key_signature": None,
              "time_signature": "4/4", "tempo_marking": None}
    read_b = {"measures": [make_measure("D4")], "key_signature": None,
              "time_signature": "4/4", "tempo_marking": None}
    read_c = {"measures": [make_measure("E4")], "key_signature": None,
              "time_signature": "4/4", "tempo_marking": None}

    fake_prepared_pages = [{"page_mime": "image/jpeg", "page_bytes": b"page1",
                             "rows": [{"row_bytes": b"row1", "readability": {"quality": "good"},
                                       "segmentation": {"measures": [], "confidence": 0.0}}]}]
    audiveris_row_result = {"measures": [
        {"number": 1, "notes": [{"pitch": "D4", "is_rest": False, "beat": 1.0, "duration_beats": 4.0}]}
    ], "source": "audiveris"}

    reads = [read_a, read_b, read_c]
    with patch("worker._prepare_score_rows", return_value=fake_prepared_pages), \
         patch.object(w.run_audiveris_on_row, "spawn",
                      return_value=MagicMock(get=MagicMock(return_value=audiveris_row_result))), \
         patch("worker._read_score_notes_claude_once", side_effect=lambda *a, **kw: reads.pop(0)):
        result = w.read_score_notes_claude([(b"page1", "image/jpeg")], 1, "Clarinet", "4/4", "fake-key")

    check("the Audiveris-corroborated candidate (D4) won, not an arbitrary first pick",
          result["measures"][0]["notes"][0]["pitch"] == "D4", str(result["measures"]))
```

- [ ] **Step 2: Write the failing test — Audiveris matches none of the candidates (declines to guess)**

```python
def test_read_score_notes_claude_audiveris_tie_break_declines_when_no_match():
    print("\n[165] when an aligned Audiveris measure matches NONE of the "
          "disagreeing Claude candidates, today's existing arbitrary-winner "
          "behavior is unchanged — the tie-break never guesses")
    from unittest.mock import patch, MagicMock

    def make_measure(pitch):
        return {"number": 1, "page": 1, "row": 1,
                "notes": [{"pitch": pitch, "is_rest": False, "beat": 1.0, "duration_beats": 4.0}]}

    read_a = {"measures": [make_measure("C4")], "key_signature": None,
              "time_signature": "4/4", "tempo_marking": None}
    read_b = {"measures": [make_measure("D4")], "key_signature": None,
              "time_signature": "4/4", "tempo_marking": None}
    read_c = {"measures": [make_measure("E4")], "key_signature": None,
              "time_signature": "4/4", "tempo_marking": None}

    fake_prepared_pages = [{"page_mime": "image/jpeg", "page_bytes": b"page1",
                             "rows": [{"row_bytes": b"row1", "readability": {"quality": "good"},
                                       "segmentation": {"measures": [], "confidence": 0.0}}]}]
    # Audiveris matches NEITHER C4, D4, nor E4.
    audiveris_row_result = {"measures": [
        {"number": 1, "notes": [{"pitch": "G4", "is_rest": False, "beat": 1.0, "duration_beats": 4.0}]}
    ], "source": "audiveris"}

    reads = [read_a, read_b, read_c]
    with patch("worker._prepare_score_rows", return_value=fake_prepared_pages), \
         patch.object(w.run_audiveris_on_row, "spawn",
                      return_value=MagicMock(get=MagicMock(return_value=audiveris_row_result))), \
         patch("worker._read_score_notes_claude_once", side_effect=lambda *a, **kw: reads.pop(0)):
        result = w.read_score_notes_claude([(b"page1", "image/jpeg")], 1, "Clarinet", "4/4", "fake-key")

    check("the measure is still marked unresolved (today's existing disagree path), "
          "not silently accepted", result["measures"][0].get("unresolved") in (True, None),
          str(result["measures"][0]))
    check("the winning pitch is one of the THREE original candidates, never Audiveris's G4",
          result["measures"][0]["notes"][0]["pitch"] in ("C4", "D4", "E4"),
          str(result["measures"][0]))
```

- [ ] **Step 3: Run both tests to verify the first fails and understand the second's current (passing-by-coincidence) state**

Run: `cd modal_worker && python3 -c "
import test_analysis as t
t.test_read_score_notes_claude_audiveris_breaks_a_genuine_tie()
t.test_read_score_notes_claude_audiveris_tie_break_declines_when_no_match()
"`
Expected: the first test's `check(...)` reports `FAIL` (today's code picks an arbitrary first candidate — likely `C4` — not the Audiveris-matched `D4`). The second test may already report `PASS` (today's existing behavior already picks *some* original candidate) — that's fine; it becomes a real regression guard once Step 5 lands, not a newly-introduced behavior.

- [ ] **Step 4: Implement the tie-break**

Immediately after `read_c = _read_score_notes_claude_once(...)` and the existing `by_number_c = {...}` line (inside the `else:` disagreement branch, re-grep for the current exact line before editing — it was `worker.py:4890-4891` before this task's edits), add:

```python
            # Compute the tie-break alignment BEFORE reconciliation picks a
            # winner below — this is why _group_measure_numbers_by_row/
            # _align_audiveris_measures are called here with the raw
            # [read_a, read_b, read_c], not with the not-yet-built
            # reconciled result (see Task 4's docstring on why the same
            # two functions serve both call shapes).
            claude_numbers_by_row_prelim = _group_measure_numbers_by_row([read_a, read_b, read_c])
            aligned_omr_prelim = _align_audiveris_measures(claude_numbers_by_row_prelim, audiveris_by_row)
```

Then, inside the `for n in all_numbers:` loop, replace:

```python
                winning_fp = max(counts, key=lambda fp: counts[fp])
                claude_agreement[n] = ("agree" if counts[winning_fp] >= 2
                                       else "unavailable" if len(candidates) < 2
                                       else "disagree")
                winner = next(c for c, fp in zip(candidates, fingerprints) if fp == winning_fp)
                reconciled.append(winner)
```

with:

```python
                winning_fp = max(counts, key=lambda fp: counts[fp])
                is_disagreement = counts[winning_fp] < 2 and len(candidates) >= 2
                omr_tie_break_winner = None
                if is_disagreement:
                    omr_measure = aligned_omr_prelim.get(n)
                    if omr_measure is not None:
                        omr_matches = [c for c in candidates
                                       if _cross_source_measure_match(c, omr_measure, time_sig)]
                        if len(omr_matches) == 1:
                            omr_tie_break_winner = omr_matches[0]

                if omr_tie_break_winner is not None:
                    claude_agreement[n] = "disagree_omr_broke_tie"
                    winner = omr_tie_break_winner
                else:
                    claude_agreement[n] = ("agree" if counts[winning_fp] >= 2
                                           else "unavailable" if len(candidates) < 2
                                           else "disagree")
                    winner = next(c for c, fp in zip(candidates, fingerprints) if fp == winning_fp)
                reconciled.append(winner)
```

Note: `time_sig` here refers to the `time_sig` PARAMETER of `read_score_notes_claude` (the hinted/declared time signature passed in from the caller), the same variable name already in scope throughout this function — not `resolved_time_sig`, which is computed later, after this block, from `base_result.get("time_signature")`. `_cross_source_measure_match` accepts `time_sig: str | None`, so the raw hint is an acceptable input here even though it may differ from the eventually-resolved value; this mirrors the level of precision `_measure_fingerprint`-based agreement already operates at in this same block.

- [ ] **Step 5: Run both tests to verify they pass**

Run: `cd modal_worker && python3 -c "
import test_analysis as t
t.test_read_score_notes_claude_audiveris_breaks_a_genuine_tie()
t.test_read_score_notes_claude_audiveris_tie_break_declines_when_no_match()
"`
Expected: both print all `PASS` lines.

- [ ] **Step 6: Register both tests and run the full suite**

Add `test_read_score_notes_claude_audiveris_breaks_a_genuine_tie,` and `test_read_score_notes_claude_audiveris_tie_break_declines_when_no_match,` to `main()`'s call tuple.

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -n 15`
Expected: all checks pass, including every pre-existing disagreement/reconciliation test (`test_read_score_notes_claude_*` tests that construct disagreeing reads) — since `audiveris_by_row` is empty (`{}`) whenever those older tests don't mock `run_audiveris_on_row.spawn`, `aligned_omr_prelim` will be empty too, `omr_tie_break_winner` will always be `None`, and the code falls through to today's exact existing `else:` branch unchanged.

- [ ] **Step 7: Commit**

```bash
cd /Users/matthewwu/repos/mediant-ui-shell
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): use Audiveris to break genuine Claude-vs-Claude ties

When Claude's own reads disagree with no 2-of-3 majority, and an aligned
Audiveris reading matches exactly one of the disagreeing candidates,
that candidate wins instead of an arbitrary first pick — tagged
disagree_omr_broke_tie so fuse_measure_confidence treats it as resolved,
not as another needs_resolution case. Matching zero or multiple
candidates leaves today's existing behavior completely unchanged."
```

---

### Task 6: Wire the corroboration lookup into the per-measure loop

**Files:**
- Modify: `modal_worker/worker.py` (the code that builds `base_result` right after the agree/disagree branches, and the per-measure loop's `oemer_measure = None` line)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `_group_measure_numbers_by_row`, `_align_audiveris_measures` (Task 4), `audiveris_by_row` (Task 4).
- Produces: the per-measure loop's `fuse_measure_confidence` calls now receive a real `oemer_measure` (or `None`) instead of an unconditional `None`, for every measure regardless of which agree/disagree branch produced it.

- [ ] **Step 1: Write the failing test — a PDF page dispatches zero calls (scope-cut regression guard)**

```python
def test_read_score_notes_claude_pdf_pages_get_no_audiveris_corroboration():
    print("\n[166] a PDF page (no row crops) never gets real oemer_measure data — "
          "identical to today's oemer_measure=None for every PDF measure")
    from unittest.mock import patch

    fake_prepared_pages = [{"page_mime": "application/pdf", "page_bytes": b"pdf1", "rows": []}]
    pdf_measure = {"number": 1, "page": 1, "row": 1,
                   "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 4.0}]}
    read_a = {"measures": [pdf_measure], "key_signature": None,
              "time_signature": "4/4", "tempo_marking": None}
    read_b = {"measures": [pdf_measure], "key_signature": None,
              "time_signature": "4/4", "tempo_marking": None}

    reads = [read_a, read_b]
    with patch("worker._prepare_score_rows", return_value=fake_prepared_pages), \
         patch("worker._read_score_notes_claude_once", side_effect=lambda *a, **kw: reads.pop(0)):
        result = w.read_score_notes_claude([(b"pdf1", "application/pdf")], 1, "Clarinet", "4/4", "fake-key")

    check("a PDF page's measure resolves via Claude-agreement alone (medium "
          "confidence, no OMR), not via any fabricated corroboration",
          result["measures"][0].get("unresolved") is not True, str(result["measures"][0]))
```

- [ ] **Step 2: Write the failing test — a raster page's agreeing measure gets real corroboration data**

```python
def test_read_score_notes_claude_agree_case_gets_audiveris_corroboration():
    print("\n[167] when Claude's two reads AGREE on a measure, a matching aligned "
          "Audiveris reading now reaches fuse_measure_confidence for real "
          "(this is the actual symptom fix: catches a Claude-agrees-with-itself "
          "measure Audiveris independently CONTRADICTS)")
    from unittest.mock import patch, MagicMock

    agreeing_measure = {"number": 1, "page": 1, "row": 1,
                        "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 4.0}]}
    read_a = {"measures": [agreeing_measure], "key_signature": None,
              "time_signature": "4/4", "tempo_marking": None}
    read_b = {"measures": [agreeing_measure], "key_signature": None,
              "time_signature": "4/4", "tempo_marking": None}

    fake_prepared_pages = [{"page_mime": "image/jpeg", "page_bytes": b"page1",
                             "rows": [{"row_bytes": b"row1", "readability": {"quality": "good"},
                                       "segmentation": {"measures": [], "confidence": 0.0}}]}]
    # Audiveris CONTRADICTS the agreeing Claude reads (G4, not C4).
    audiveris_row_result = {"measures": [
        {"number": 1, "notes": [{"pitch": "G4", "is_rest": False, "beat": 1.0, "duration_beats": 4.0}]}
    ], "source": "audiveris"}

    reads = [read_a, read_b]
    with patch("worker._prepare_score_rows", return_value=fake_prepared_pages), \
         patch.object(w.run_audiveris_on_row, "spawn",
                      return_value=MagicMock(get=MagicMock(return_value=audiveris_row_result))), \
         patch("worker._read_score_notes_claude_once", side_effect=lambda *a, **kw: reads.pop(0)), \
         patch("worker.fuse_measure_confidence", wraps=w.fuse_measure_confidence) as spy_fuse:
        w.read_score_notes_claude([(b"page1", "image/jpeg")], 1, "Clarinet", "4/4", "fake-key")

    oemer_args = [call.args[2] for call in spy_fuse.call_args_list]
    check("fuse_measure_confidence was called with REAL Audiveris data at least once, "
          "not an unconditional None", any(a is not None for a in oemer_args), str(oemer_args))
```

- [ ] **Step 3: Run both tests to verify they fail (or already pass) and understand which**

Run: `cd modal_worker && python3 -c "
import test_analysis as t
t.test_read_score_notes_claude_pdf_pages_get_no_audiveris_corroboration()
t.test_read_score_notes_claude_agree_case_gets_audiveris_corroboration()
"`
Expected: the first test likely already `PASS`es (no behavior change yet needed for the PDF case — this is a regression guard for later, confirm it stays green after Step 5 too). The second test's `check(...)` reports `FAIL` — today's code passes `oemer_measure = None` unconditionally, so `oemer_args` will be `[None]`.

- [ ] **Step 4: Wire the corroboration lookup**

Immediately after the existing `if/elif/else` block that sets `base_result` and `claude_agreement` completes (i.e., right before the existing `if base_result.get("error") or not base_result.get("measures"): return base_result` line — re-grep for its current exact line before editing), add:

```python
    # Final alignment for the corroboration lookup below — uses the
    # single, already-reconciled base_result (not the raw read_a/read_b/
    # read_c candidates the tie-break step used) since a winner has
    # already been picked for every measure by this point.
    claude_numbers_by_row = _group_measure_numbers_by_row([base_result])
    aligned_omr = _align_audiveris_measures(claude_numbers_by_row, audiveris_by_row)
```

Then, in the per-measure loop, replace the existing:

```python
            # OMR is permanently unavailable this iteration (NO-GO, see
            # docstring above) — literally None, never {}, on every path.
            oemer_measure = None
```

with:

```python
            # Real Audiveris corroboration, when this measure's row could
            # be confidently aligned (see _align_audiveris_measures) —
            # None (never {}) for every measure it could not align,
            # identical to the old permanently-unavailable behavior for
            # exactly those measures.
            oemer_measure = aligned_omr.get(measure["number"])
```

Also update `read_score_notes_claude`'s own module-level docstring (`worker.py:4778` area) to remove the now-inaccurate "OMR (oemer) is PERMANENTLY UNAVAILABLE for this iteration" paragraph (the one starting `OMR (oemer) is PERMANENTLY UNAVAILABLE for this iteration — a spike...`) and replace it with a short paragraph pointing at the spec:

```python
    OMR cross-validation is provided by Audiveris (not oemer — oemer was
    spiked and rejected; see docs/superpowers/specs/2026-09-23-audiveris-
    cross-validation-design.md for that history and for this feature's
    full design). Audiveris runs per-row, in parallel with Claude's own
    reads (see the dispatch/collect code near the top of this function),
    and its aligned results feed both the reconciliation loop's tie-break
    step and this function's per-measure fuse_measure_confidence calls.
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `cd modal_worker && python3 -c "
import test_analysis as t
t.test_read_score_notes_claude_pdf_pages_get_no_audiveris_corroboration()
t.test_read_score_notes_claude_agree_case_gets_audiveris_corroboration()
"`
Expected: both print all `PASS` lines.

- [ ] **Step 6: Register both tests and run the FULL suite one final time**

Add `test_read_score_notes_claude_pdf_pages_get_no_audiveris_corroboration,` and `test_read_score_notes_claude_agree_case_gets_audiveris_corroboration,` to `main()`'s call tuple — this should now be the last entry.

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -n 20`
Expected: every check passes — the pre-existing 611, plus every check added across Tasks 1-6. Read the full tail output, not just the final count line, and confirm zero `FAILED:` lines are printed.

- [ ] **Step 7: Commit**

```bash
cd /Users/matthewwu/repos/mediant-ui-shell
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): wire real Audiveris corroboration into fuse_measure_confidence

The per-measure loop's oemer_measure is no longer unconditionally None
— it's a real lookup into the per-row Audiveris alignment, for every
measure whose row could be confidently aligned. This is what makes a
Claude-agrees-with-itself-but-is-wrong measure catchable for the first
time: fuse_measure_confidence's existing 'agree' + OMR-contradicts path
now receives real contradicting data instead of always seeing None.

Also updates read_score_notes_claude's docstring, which previously
documented OMR as permanently unavailable — that's no longer true."
```

---

## Final Manual Verification (not a task — do this after Task 6 lands and is deployed)

1. Deploy: `cd modal_worker && modal deploy worker.py`
2. Start a live log tail with `-f` (NOT without it — a bare `modal app logs mediant-worker` fetches a short backlog and exits; confirmed as a real, previously-wasted-time gotcha earlier this session) and verify with `ps aux` that the tailing process is actually alive before proceeding.
3. Resubmit the same real problem photo used throughout tonight's earlier debugging (either via the app's upload flow, or by re-triggering analysis/reference-audio generation for an existing take that used it).
4. In the logs, confirm:
   - `[read_score_notes_claude] Audiveris row (page, row) ...` collection lines appear for every raster row (no PDF pages in this photo).
   - At least one measure's resolution path shows `disagree_omr_broke_tie` rather than falling through to a `resolve_measure_disagreement` call — this is the direct evidence the tie-break is actually firing on real data, not just passing its unit tests.
   - `unresolved_measure_count` at the end of the read is lower than the `41`/`46`/`47`-out-of-similar-total figures observed earlier tonight on this same photo (exact figures will vary run to run — Claude's reads are not deterministic — so compare against the *range* observed tonight, not a single fixed number).
5. Confirm the take's actual feedback/reference-audio result in the app reflects the improvement (fewer or no false "wrong note" flags on measures the user knows they played correctly; fewer "PARTIAL" reference-audio refusals).

This step is manual, not automated, because it depends on a live photo, live Anthropic API calls, and live Audiveris runs — exactly the kind of real-world variability the rest of this plan's automated tests are deliberately isolated from.
