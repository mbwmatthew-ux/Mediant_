# Reference-Audio Recognition Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace same-model-only Claude cross-validation for reference-audio score reading with a multi-signal pipeline (real image-quality gate, local dewarping, measure-level segmentation, an independent OMR recognizer, deterministic music validation, confidence fusion, targeted closed-ended disagreement resolution).

**Architecture:** Seven new, independently-testable functions in `modal_worker/worker.py`, orchestrated by a rewritten `read_score_notes_claude` (the existing shared entry point both the reference-audio and main-analysis pipelines already call — no caller needs to change). A new lightweight Modal endpoint + edge function exposes the image-quality signal to the upload UI.

**Tech Stack:** Python (numpy + PIL, no new imaging dependencies for Day 1), `oemer` (MIT-licensed OMR CLI, Day 2, conditional on a GO decision), existing `anthropic`/Claude vision call pattern, existing Supabase edge function + Modal deployment pipeline.

**Spec:** `docs/superpowers/specs/2026-09-12-reference-audio-recognition-pipeline.md` — read it alongside this plan. Every `[Revision 2]` section in the spec exists because a first draft got something wrong; this plan follows the corrected version throughout.

## Global Constraints

- **3-day budget.** Day 1 tasks require zero Anthropic API calls (pure image processing + deterministic logic, unit-testable with synthetic fixtures). Day 2 starts with a GO/NO-GO decision on `oemer` before any integration code is written. Day 3 wires everything together, ships the UI, and runs the live ground-truth test.
- **`oemer` (MIT license), never `homr` (AGPL-3.0)** without the user's explicit separate sign-off — this is a business/legal decision already made in the spec, not to be revisited by an implementer.
- **Duration-unit consistency is load-bearing.** Claude (via `read_score_notes_claude`'s existing prompt) reports `duration_beats` already in NOTATED BEAT units (its prompt asks for `"d": duration in beats`, e.g. 3 for a full measure of 3/4). `parse_musicxml` (used by both the existing MusicXML path and the new `read_score_notes_oemer`) reports `duration_beats` as `el.duration.quarterLength` — a QUARTERLENGTH, only equal to a notated beat in simple time signatures. Any function that compares or validates `duration_beats` values from an oemer/MusicXML source alongside a Claude source MUST first divide the quarterLength value by `quarter_lengths_per_beat(time_sig)` (already exists at `modal_worker/worker.py:3666`) to convert to notated beats. Getting this backwards silently breaks every compound-time-signature score (this project has been bitten by exactly this class of bug before — see the Gotchas file entry on `dur_beats`/`quarter_lengths_per_beat`).
- **Validator asymmetry.** `validate_measure`'s `invalid` verdict is strong evidence of a real problem; its `valid` verdict is NEVER to be treated as evidence of correctness anywhere in this codebase. No task in this plan may add a code path that accepts a measure as high-confidence on validator-`valid` alone, without also requiring Claude-agreement (see the fusion table in Task 9).
- **Written-range validation, not concert-range.** `validate_measure` checks raw reported (written) pitches against `INSTRUMENT_WRITTEN_RANGE`, BEFORE `transpose_for_instrument` is ever applied. Transposition happens only at MIDI-synthesis time in `generate_reference_audio` (unchanged by this plan).
- **Existing test conventions** (`modal_worker/test_analysis.py`): plain-assert `check(name, ok, detail)` harness (defined at `test_analysis.py:134`), tests numbered sequentially via a `print("\n[N] ...")` header (last number in the file as of this plan's writing is **74** — before adding a task's tests, run `grep -n 'print("\\n\[' modal_worker/test_analysis.py | tail -1` to get the true current max, since earlier tasks in this same plan will have added more), and every test function registered by name in the tuple inside `main()`.

---

## File Structure

- **Modify `modal_worker/worker.py`** — all seven new functions, plus the `INSTRUMENT_WRITTEN_RANGE`/`POLYPHONIC_INSTRUMENTS` tables, plus the rewritten `read_score_notes_claude` orchestration. One file, matching this project's existing convention of keeping all worker logic in one file (already 7,361 lines — large, but splitting it is out of scope for this plan; not this plan's problem to solve).
- **Modify `modal_worker/test_analysis.py`** — all new tests, following the existing single-file convention.
- **Create `supabase/functions/score-quality-check/index.ts`** — new, thin edge function exposing the Day-1 quality gate to the frontend (Task 12).
- **Modify `src/components/NewRecordingModal.jsx`** — upload-flow quality gate UI (Task 12).

---

### Task 1: `compute_row_readability` — real interline measurement

**Files:**
- Modify: `modal_worker/worker.py` — add after `_otsu_threshold` (currently ends at line 3156, immediately before `def split_page_into_rows` at line 3159).
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `_otsu_threshold(values) -> float` (existing, `modal_worker/worker.py:3121`).
- Produces: `compute_row_readability(row_bytes: bytes) -> dict` returning `{"interline_px": float | None, "quality": "good" | "marginal" | "poor", "reasons": list[str]}`. Consumed by Task 2 (dewarp decision), Task 11 (orchestration), and Task 12 (frontend quality gate, via a new endpoint).

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after `test_split_page_into_rows_falls_back_on_undecodable_bytes` (search for that exact function name):

```python
def _make_synthetic_row(interline_px=20, width=800, height=140, blur=False):
    """A single-system row crop with 5 staff lines at a known, controllable
    interline spacing, for testing compute_row_readability's measurement
    against a known-correct answer. `blur` applies a simple box blur to
    simulate a soft/out-of-focus photo, for testing the 'poor' quality path
    without needing a real bad photo."""
    from PIL import Image, ImageDraw, ImageFilter
    import io
    img = Image.new("L", (width, height), color=250)
    draw = ImageDraw.Draw(img)
    top = height // 2 - int(interline_px * 2)
    for line_i in range(5):
        y = top + line_i * interline_px
        draw.line([(20, y), (width - 20, y)], fill=0, width=2)
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(radius=3))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_compute_row_readability_measures_known_interline():
    print("\n[75] readability check measures a known interline spacing correctly")
    row_bytes = _make_synthetic_row(interline_px=24)
    result = w.compute_row_readability(row_bytes)
    check("interline is close to the true 24px spacing",
          result["interline_px"] is not None and abs(result["interline_px"] - 24) <= 2,
          str(result["interline_px"]))
    check("quality is good at 24px", result["quality"] == "good", str(result))


def test_compute_row_readability_flags_low_interline_as_poor():
    print("\n[76] readability check flags a real bad case (8px, matching the actual Audiveris-rejected photo) as poor")
    row_bytes = _make_synthetic_row(interline_px=8, width=400, height=80)
    result = w.compute_row_readability(row_bytes)
    check("quality is poor at 8px (this is the exact measured value from the real problem photo)",
          result["quality"] == "poor", str(result))


def test_compute_row_readability_marginal_band():
    print("\n[77] readability check has a marginal band between good and poor")
    row_bytes = _make_synthetic_row(interline_px=14)
    result = w.compute_row_readability(row_bytes)
    check("14px lands in marginal, not good and not poor",
          result["quality"] == "marginal", str(result))


def test_compute_row_readability_handles_undecodable_bytes():
    print("\n[78] readability check degrades to poor/unknown on bytes it can't decode, does not raise")
    result = w.compute_row_readability(b"\x89PNG-not-a-real-image")
    check("returns poor quality with no interline reading, does not raise",
          result["quality"] == "poor" and result["interline_px"] is None, str(result))
```

Register all four in `main()`'s test tuple, directly after `test_split_page_into_rows_falls_back_on_undecodable_bytes,` (search for that exact line):

```python
              test_split_page_into_rows_falls_back_on_undecodable_bytes,
              test_compute_row_readability_measures_known_interline,
              test_compute_row_readability_flags_low_interline_as_poor,
              test_compute_row_readability_marginal_band,
              test_compute_row_readability_handles_undecodable_bytes,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[75\]\|\[76\]\|\[77\]\|\[78\]"`
Expected: `AttributeError: module 'worker' has no attribute 'compute_row_readability'`.

- [ ] **Step 3: Implement `compute_row_readability`**

Insert immediately before `def split_page_into_rows(page_bytes: bytes) -> list[bytes]:` (line 3159):

```python
# Interline thresholds, calibrated against real evidence, not guesses:
# Audiveris's own algorithm rejected the real problem photo at a measured
# 8px interline as unreliable, and states it wants roughly 300 DPI /
# ~20px interline. 8px is therefore a real, confirmed "poor" data point;
# 20px+ is Audiveris's own stated target for "good". The marginal band
# between them is where degraded-but-not-hopeless recognition happens.
_INTERLINE_POOR_MAX = 11.0
_INTERLINE_GOOD_MIN = 18.0


def compute_row_readability(row_bytes: bytes) -> dict:
    """
    Measures the ACTUAL staff-line spacing (interline) of one row crop —
    not a proxy like raw pixel dimensions — plus local contrast, and
    returns a quality verdict.

    Exists because Audiveris's real, confirmed failure on the actual
    problem photo tonight was driven by interline spacing specifically
    (measured 8px against Audiveris's own stated ~20px target), not a
    generic "low resolution" guess. Reuses the row-wise contrast/Otsu
    technique split_page_into_rows already established, applied at finer
    grain to find the 5 individual staff lines within ONE system crop
    rather than the gaps BETWEEN systems.

    Returns {"interline_px": float|None, "quality": "good"|"marginal"|"poor",
    "reasons": [...]}. Never raises — undecodable bytes or a crop where
    fewer than 2 staff lines can be confidently found come back as
    "poor" with interline_px=None, same no-op-on-failure convention as
    split_page_into_rows.
    """
    try:
        from PIL import Image
        import numpy as np
        import io

        img = Image.open(io.BytesIO(row_bytes)).convert("L")
        arr = np.array(img).astype(np.float64)
        h, w = arr.shape

        threshold = _otsu_threshold(arr.flatten())
        is_ink = arr < threshold

        # A real staff line spans nearly the full crop width. Candidate
        # line-rows are pixel-rows where ink coverage crosses a high bar —
        # far higher than split_page_into_rows' row-vs-gap bar, since here
        # we're distinguishing individual THIN LINES from the surrounding
        # notehead/stem content, not systems from blank gaps.
        row_ink_fraction = is_ink.sum(axis=1) / w
        candidate_rows = np.where(row_ink_fraction > 0.6)[0]

        if len(candidate_rows) < 2:
            return {"interline_px": None, "quality": "poor",
                    "reasons": ["fewer than 2 staff-line candidates found"]}

        # Merge adjacent candidate pixel-rows into single line centers —
        # photo blur/anti-aliasing spreads one physical line across
        # several pixel-rows.
        line_centers = []
        run_start = candidate_rows[0]
        prev = candidate_rows[0]
        for y in candidate_rows[1:]:
            if y - prev > 2:
                line_centers.append((run_start + prev) / 2)
                run_start = y
            prev = y
        line_centers.append((run_start + prev) / 2)

        if len(line_centers) < 2:
            return {"interline_px": None, "quality": "poor",
                    "reasons": ["fewer than 2 distinct staff lines after merging"]}

        spacings = [b - a for a, b in zip(line_centers, line_centers[1:])]
        interline_px = float(np.median(spacings))

        reasons = []
        if interline_px <= _INTERLINE_POOR_MAX:
            quality = "poor"
            reasons.append(f"interline {interline_px:.1f}px at or below the "
                            f"{_INTERLINE_POOR_MAX}px poor threshold")
        elif interline_px >= _INTERLINE_GOOD_MIN:
            quality = "good"
        else:
            quality = "marginal"
            reasons.append(f"interline {interline_px:.1f}px is between "
                            f"{_INTERLINE_POOR_MAX} and {_INTERLINE_GOOD_MIN}")

        return {"interline_px": interline_px, "quality": quality, "reasons": reasons}
    except Exception as e:
        return {"interline_px": None, "quality": "poor",
                "reasons": [f"could not analyze image: {e}"]}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`, no `FAILED:` lines.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add interline-based row readability check"
```

---

### Task 2: `dewarp_row` — local per-row curvature correction

**Files:**
- Modify: `modal_worker/worker.py` — add immediately after `compute_row_readability` (Task 1) and before `split_page_into_rows`.
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `_otsu_threshold` (existing).
- Produces: `dewarp_row(row_bytes: bytes) -> bytes`. Consumed by Task 3 (`split_row_into_measures` operates on dewarped rows), Task 11 (orchestration).

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after Task 1's last test:

```python
def _make_curved_row(width=800, height=160, amplitude=12):
    """A row with 5 staff lines that follow a parabolic curve across the
    width (simulating page warp), for testing dewarp_row against a case
    with a KNOWN correction. amplitude is the peak vertical deviation in
    pixels between the curve's center and its edges."""
    from PIL import Image, ImageDraw
    import io
    img = Image.new("L", (width, height), color=250)
    draw = ImageDraw.Draw(img)
    base_top = height // 2 - 40
    for line_i in range(5):
        base_y = base_top + line_i * 20
        prev_point = None
        for x in range(20, width - 20):
            # Parabola peaking at the center, matching a page curving
            # toward the camera in the middle.
            t = (x - width / 2) / (width / 2)
            y = base_y - amplitude * (1 - t * t)
            point = (x, int(y))
            if prev_point:
                draw.line([prev_point, point], fill=0, width=2)
            prev_point = point
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_dewarp_row_straightens_a_curved_staff():
    print("\n[79] dewarp_row measurably straightens a known-curved synthetic row")
    curved = _make_curved_row(amplitude=12)
    flat = _make_synthetic_row(interline_px=20, width=800, height=160)
    dewarped = w.dewarp_row(curved)
    # Compare readability before and after: the curved original should
    # measure a noisier/less reliable interline than the corrected version,
    # since dewarp_row's job is specifically to make compute_row_readability
    # see a cleaner staff.
    before = w.compute_row_readability(curved)
    after = w.compute_row_readability(dewarped)
    check("dewarp does not make the reading worse",
          (after["interline_px"] or 0) > 0, str(after))
    check("dewarped output is still a valid, decodable image",
          len(dewarped) > 100, f"{len(dewarped)} bytes")


def test_dewarp_row_is_a_noop_on_an_already_flat_row():
    print("\n[80] dewarp_row leaves an already-flat row unchanged (no-op, not a harmful correction)")
    flat = _make_synthetic_row(interline_px=20, width=800, height=160)
    dewarped = w.dewarp_row(flat)
    before = w.compute_row_readability(flat)["interline_px"]
    after = w.compute_row_readability(dewarped)["interline_px"]
    check("interline reading is essentially unchanged on flat input",
          before is not None and after is not None and abs(before - after) < 2,
          f"before={before} after={after}")


def test_dewarp_row_falls_back_on_undecodable_bytes():
    print("\n[81] dewarp_row degrades to a no-op on bytes it can't decode, does not raise")
    garbage = b"\x89PNG-not-a-real-image"
    result = w.dewarp_row(garbage)
    check("returns the original bytes unchanged, does not raise",
          result == garbage, str(result))
```

Register in `main()`'s tuple after Task 1's last test registration:

```python
              test_compute_row_readability_handles_undecodable_bytes,
              test_dewarp_row_straightens_a_curved_staff,
              test_dewarp_row_is_a_noop_on_an_already_flat_row,
              test_dewarp_row_falls_back_on_undecodable_bytes,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[79\]\|\[80\]\|\[81\]"`
Expected: `AttributeError: module 'worker' has no attribute 'dewarp_row'`.

- [ ] **Step 3: Implement `dewarp_row`**

Insert after `compute_row_readability`, before `split_page_into_rows`:

```python
_DEWARP_MIN_CURVATURE_PX = 3.0   # below this, treat the row as already flat


def dewarp_row(row_bytes: bytes) -> bytes:
    """
    Detects this row crop's OWN staff-line curve and applies a local
    vertical unwarp so it's flat before recognition — a much smaller
    problem than full-page perspective correction, since split_page_into_rows
    already isolated one system per crop.

    Exists because the real problem photo investigated tonight has visible
    page curvature, and Audiveris (a real OMR engine) misread its clef
    entirely on that photo — plausibly because Audiveris assumes straight,
    parallel staff lines and this page's aren't. Correcting curvature
    locally, per row, is this project's chosen scope cut versus full-page
    perspective correction (see the spec's Non-goals).

    Algorithm: binarize, sample the row's local "ink center" in vertical
    strips across the width, fit a quadratic to those centers, and shift
    each column vertically by the fitted curve's deviation from the
    center column. No-ops (returns input unchanged) if the fit's
    curvature is negligible (row is already flat) or if the image can't
    be decoded or too few strips produce a usable reading.
    """
    try:
        from PIL import Image
        import numpy as np
        import io

        img = Image.open(io.BytesIO(row_bytes)).convert("L")
        arr = np.array(img).astype(np.float64)
        h, w = arr.shape

        threshold = _otsu_threshold(arr.flatten())
        is_ink = arr < threshold

        n_strips = 12
        strip_w = max(1, w // n_strips)
        xs, ys = [], []
        for i in range(n_strips):
            x0, x1 = i * strip_w, min(w, (i + 1) * strip_w)
            strip = is_ink[:, x0:x1]
            row_weights = strip.sum(axis=1)
            if row_weights.sum() < 5:
                continue  # near-blank strip, not enough signal
            y_center = float(np.average(np.arange(h), weights=row_weights))
            xs.append((x0 + x1) / 2)
            ys.append(y_center)

        if len(xs) < n_strips // 2:
            return row_bytes  # too few reliable strips, don't guess

        coeffs = np.polyfit(xs, ys, deg=2)
        curve = np.poly1d(coeffs)
        center_x = w / 2
        curve_values = curve(np.arange(w))
        peak_deviation = float(np.max(np.abs(curve_values - curve(center_x))))

        if peak_deviation < _DEWARP_MIN_CURVATURE_PX:
            return row_bytes  # already flat enough, don't introduce noise

        shifts = np.round(curve_values - curve(center_x)).astype(int)
        out = np.full_like(arr, 255.0)  # pad with background, not black
        for x in range(w):
            shift = shifts[x]
            col = arr[:, x]
            if shift == 0:
                out[:, x] = col
            elif shift > 0:
                out[:-shift, x] = col[shift:]
            else:
                out[-shift:, x] = col[:shift]

        result_img = Image.fromarray(out.astype(np.uint8), mode="L").convert("RGB")
        buf = io.BytesIO()
        result_img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        print(f"[dewarp_row] failed, using row unchanged: {e}")
        return row_bytes
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add local per-row dewarping"
```

---

### Task 3: `split_row_into_measures` — measure-level segmentation with confidence

**Files:**
- Modify: `modal_worker/worker.py` — add after `dewarp_row`, before `split_page_into_rows`.
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `_otsu_threshold` (existing).
- Produces: `split_row_into_measures(row_bytes: bytes) -> dict` returning `{"measures": list[bytes], "boundaries": list[int], "confidence": float}`. Consumed by Task 8 (`align_claude_to_measure_crops`), Task 11 (orchestration).

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after Task 2's last test:

```python
def _make_row_with_barlines(measure_count=4, width=800, height=140):
    """A row with `measure_count` measures separated by full-height
    vertical barlines, each measure containing notehead-like blobs (not
    just staff lines) so a barline (spans the WHOLE crop height) is
    visually distinguishable from a stem (spans only part of it)."""
    from PIL import Image, ImageDraw
    import random
    import io
    img = Image.new("L", (width, height), color=250)
    draw = ImageDraw.Draw(img)
    top = height // 2 - 40
    for line_i in range(5):
        y = top + line_i * 20
        draw.line([(10, y), (width - 10, y)], fill=0, width=2)
    rng = random.Random(7)
    measure_w = (width - 20) // measure_count
    boundaries = []
    for m in range(measure_count):
        x0 = 10 + m * measure_w
        x1 = x0 + measure_w
        if m > 0:
            draw.line([(x0, top - 5), (x0, top + 85)], fill=0, width=3)
            boundaries.append(x0)
        for x in range(x0 + 15, x1 - 10, 12):
            blob_y = top + rng.randint(-5, 85)
            draw.ellipse([x, blob_y, x + 6, blob_y + 6], fill=0)
        # A stem: a short vertical mark that does NOT span the barline's
        # full height — must not be mistaken for a barline.
        stem_x = x0 + measure_w // 2
        draw.line([(stem_x, top + 20), (stem_x, top + 45)], fill=0, width=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), boundaries


def test_split_row_into_measures_finds_expected_barlines():
    print("\n[82] measure splitter finds the expected number of measures in a synthetic row")
    row_bytes, true_boundaries = _make_row_with_barlines(measure_count=4)
    result = w.split_row_into_measures(row_bytes)
    check("finds 4 measures", len(result["measures"]) == 4, str(len(result["measures"])))
    check("confidence is reasonably high for a clean synthetic row",
          result["confidence"] >= 0.6, str(result["confidence"]))


def test_split_row_into_measures_low_confidence_on_ambiguous_input():
    print("\n[83] measure splitter reports low confidence rather than false certainty on a stem-only row (no real barlines)")
    # A row with note stems but NO real full-height barlines — stems must
    # not be mistaken for barlines, and the function should say so via a
    # low confidence / single-measure result rather than false splits.
    from PIL import Image, ImageDraw
    import io
    img = Image.new("L", (800, 140), color=250)
    draw = ImageDraw.Draw(img)
    top = 30
    for line_i in range(5):
        y = top + line_i * 20
        draw.line([(10, y), (790, y)], fill=0, width=2)
    for x in range(30, 770, 40):
        draw.line([(x, top + 20), (x, top + 45)], fill=0, width=2)  # stems only
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    row_bytes = buf.getvalue()
    result = w.split_row_into_measures(row_bytes)
    check("does not confidently report many measures from stems alone",
          result["confidence"] < 0.6 or len(result["measures"]) <= 1,
          f"measures={len(result['measures'])} confidence={result['confidence']}")


def test_split_row_into_measures_falls_back_on_undecodable_bytes():
    print("\n[84] measure splitter degrades to a single low-confidence unit on bytes it can't decode")
    garbage = b"\x89PNG-not-a-real-image"
    result = w.split_row_into_measures(garbage)
    check("returns the original bytes as one measure, zero confidence, does not raise",
          result["measures"] == [garbage] and result["confidence"] == 0.0, str(result))
```

Register in `main()`'s tuple:

```python
              test_dewarp_row_falls_back_on_undecodable_bytes,
              test_split_row_into_measures_finds_expected_barlines,
              test_split_row_into_measures_low_confidence_on_ambiguous_input,
              test_split_row_into_measures_falls_back_on_undecodable_bytes,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[82\]\|\[83\]\|\[84\]"`
Expected: `AttributeError: module 'worker' has no attribute 'split_row_into_measures'`.

- [ ] **Step 3: Implement `split_row_into_measures`**

Insert after `dewarp_row`, before `split_page_into_rows`:

```python
def split_row_into_measures(row_bytes: bytes) -> dict:
    """
    Detects vertical barlines within an already-dewarped row crop and
    returns per-measure crops in left-to-right order, plus a confidence
    score for the segmentation itself.

    [Revision 2 from the spec]: real notation has plenty of vertical-
    looking things that are NOT ordinary barlines — stems, repeat marks,
    endings brackets, text. A stem spans only part of the staff height;
    a real barline spans the full STAFF height (all 5 lines). That
    height distinction is the primary signal here — measured against the
    staff's own detected span, NOT the crop's total height, since a real
    row crop has padding above/below the staff (see split_page_into_rows'
    own padding) that a barline does not need to cross. Comparing against
    total crop height instead of the staff's own span would make a real
    barline register as spanning a smaller fraction than it should, on
    every padded real-world crop. Confidence is NOT assumed — a caller
    (see align_claude_to_measure_crops) must check it before trusting
    these crops as canonical measure boundaries, and fall back to
    row-level processing when it's low.

    Returns {"measures": [bytes, ...], "boundaries": [x_position, ...],
    "confidence": float in [0,1]}. Never raises — undecodable bytes, or a
    crop where the staff itself can't be found, come back as a
    single-crop, zero-or-full-confidence result (the row itself,
    unsplit), matching split_page_into_rows' no-op-on-failure convention.
    """
    try:
        from PIL import Image
        import numpy as np
        import io

        img = Image.open(io.BytesIO(row_bytes)).convert("L")
        arr = np.array(img).astype(np.float64)
        h, w = arr.shape

        threshold = _otsu_threshold(arr.flatten())
        is_ink = arr < threshold

        # Find the staff's own vertical span (same line-detection approach
        # as compute_row_readability) so barline height is judged against
        # the staff, not the padded crop.
        row_ink_fraction = is_ink.sum(axis=1) / w
        staff_rows = np.where(row_ink_fraction > 0.6)[0]
        if len(staff_rows) < 2:
            return {"measures": [row_bytes], "boundaries": [], "confidence": 0.0}
        staff_top, staff_bottom = int(staff_rows[0]), int(staff_rows[-1])
        staff_height = max(1, staff_bottom - staff_top)

        col_density = is_ink[staff_top:staff_bottom + 1, :].sum(axis=0) / staff_height
        strong = col_density > 0.90   # spans nearly the whole STAFF height
        weak = (col_density > 0.70) & ~strong

        candidate_cols = np.where(strong | weak)[0]
        if len(candidate_cols) == 0:
            return {"measures": [row_bytes], "boundaries": [], "confidence": 1.0}

        # Merge adjacent candidate columns into single barline positions —
        # a real barline has some pixel width from photo blur/line weight.
        groups: list[list[int]] = []
        current = [candidate_cols[0]]
        for x in candidate_cols[1:]:
            if x - current[-1] <= 3:
                current.append(x)
            else:
                groups.append(current)
                current = [x]
        groups.append(current)

        # Drop groups right at the very edges (the crop's own left/right
        # border, or a clef/key-signature vertical stroke) — a real
        # interior barline should not sit in the outer 5% of the width.
        margin = max(5, int(w * 0.05))
        groups = [g for g in groups if margin < (g[0] + g[-1]) / 2 < w - margin]

        if not groups:
            return {"measures": [row_bytes], "boundaries": [], "confidence": 1.0}

        boundaries = [int((g[0] + g[-1]) / 2) for g in groups]
        strong_count = sum(1 for g in groups if any(col_density[x] > 0.90 for x in g))
        confidence = strong_count / len(groups)

        crops = []
        prev_x = 0
        for bx in boundaries:
            crop = Image.open(io.BytesIO(row_bytes)).convert("RGB").crop((prev_x, 0, bx, h))
            buf = io.BytesIO()
            crop.save(buf, format="PNG")
            crops.append(buf.getvalue())
            prev_x = bx
        crop = Image.open(io.BytesIO(row_bytes)).convert("RGB").crop((prev_x, 0, w, h))
        buf = io.BytesIO()
        crop.save(buf, format="PNG")
        crops.append(buf.getvalue())

        return {"measures": crops, "boundaries": boundaries, "confidence": confidence}
    except Exception as e:
        print(f"[split_row_into_measures] failed, returning row unsplit: {e}")
        return {"measures": [row_bytes], "boundaries": [], "confidence": 0.0}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add measure-level segmentation with confidence scoring"
```

---

### Task 4: `INSTRUMENT_WRITTEN_RANGE`, `POLYPHONIC_INSTRUMENTS`, `validate_measure`

**Files:**
- Modify: `modal_worker/worker.py` — add the two tables near `INSTRUMENT_TRANSPOSE` (currently starts at line 3931), and `validate_measure` near `beats_per_measure_from_time_sig` (line 3656) or immediately after the tables — implementer's choice, keep them near each other.
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `midi_from_name(pitch_name: str) -> int | None` (existing, `modal_worker/worker.py:1364`), `beats_per_measure_from_time_sig(time_sig) -> int` (existing, line 3656).
- Produces: `validate_measure(measure: dict, instrument: str, time_sig: str, is_first_measure: bool = False, is_last_measure: bool = False) -> dict` returning `{"valid": bool, "issues": list[str]}`. Consumed by Task 9 (`fuse_measure_confidence`), Task 11 (orchestration).

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after Task 3's last test:

```python
def test_validate_measure_duration_sum():
    print("\n[85] validator catches a duration sum that doesn't match the time signature")
    good = {"number": 5, "notes": [
        {"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0},
        {"pitch": "D4", "is_rest": False, "beat": 2.0, "duration_beats": 1.0},
        {"pitch": "E4", "is_rest": False, "beat": 3.0, "duration_beats": 1.0},
    ]}
    bad = {"number": 5, "notes": [
        {"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0},
        {"pitch": "D4", "is_rest": False, "beat": 2.0, "duration_beats": 1.0},
    ]}
    result_good = w.validate_measure(good, "clarinet", "3/4")
    result_bad = w.validate_measure(bad, "clarinet", "3/4")
    check("a correct 3/4 measure (3 beats) is valid", result_good["valid"], str(result_good))
    check("a short 3/4 measure (2 beats) is invalid", not result_bad["valid"], str(result_bad))
    check("the issue mentions duration", any("duration" in i.lower() for i in result_bad["issues"]), str(result_bad))


def test_validate_measure_skips_duration_check_on_pickup_and_final_measures():
    print("\n[86] validator does not flag a legitimately partial first/last measure")
    partial = {"number": 1, "notes": [
        {"pitch": "C4", "is_rest": False, "beat": 3.0, "duration_beats": 1.0},
    ]}
    result_first = w.validate_measure(partial, "clarinet", "3/4", is_first_measure=True)
    result_last = w.validate_measure(partial, "clarinet", "3/4", is_last_measure=True)
    check("a partial pickup measure is not flagged for duration", result_first["valid"], str(result_first))
    check("a partial final measure is not flagged for duration", result_last["valid"], str(result_last))


def test_validate_measure_written_pitch_range():
    print("\n[87] validator catches a pitch outside the instrument's WRITTEN range, before any transposition")
    too_low = {"number": 5, "notes": [
        {"pitch": "C0", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
    ]}
    ok = {"number": 5, "notes": [
        {"pitch": "G5", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
    ]}
    result_bad = w.validate_measure(too_low, "clarinet (b\u266d)", "3/4")
    result_ok = w.validate_measure(ok, "clarinet (b\u266d)", "3/4")
    check("C0 is well outside a clarinet's written range", not result_bad["valid"], str(result_bad))
    check("the issue mentions range", any("range" in i.lower() for i in result_bad["issues"]), str(result_bad))
    check("G5 is a normal clarinet written pitch", result_ok["valid"], str(result_ok))


def test_validate_measure_unexpected_polyphony():
    print("\n[88] validator catches two simultaneous notes on a monophonic instrument")
    polyphonic = {"number": 5, "notes": [
        {"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
        {"pitch": "E4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
    ]}
    result = w.validate_measure(polyphonic, "clarinet", "3/4")
    check("two notes at the same beat on a monophonic instrument is invalid",
          not result["valid"], str(result))
    check("the issue mentions polyphony/voice",
          any("voice" in i.lower() or "polypho" in i.lower() for i in result["issues"]), str(result))


def test_validate_measure_polyphony_allowed_for_piano():
    print("\n[89] validator allows simultaneous notes for a naturally polyphonic instrument")
    chord = {"number": 5, "notes": [
        {"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
        {"pitch": "E4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
        {"pitch": "G4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
    ]}
    result = w.validate_measure(chord, "piano", "3/4")
    check("a three-note chord on piano is not flagged as invalid polyphony",
          result["valid"], str(result))


def test_validate_measure_unknown_instrument_skips_range_check_gracefully():
    print("\n[90] validator does not penalize an instrument with no tabulated range data")
    measure = {"number": 5, "notes": [
        {"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
    ]}
    result = w.validate_measure(measure, "kazoo", "3/4")
    check("an untabulated instrument is not flagged for range (no data is not evidence of a problem)",
          result["valid"], str(result))
```

Register in `main()`'s tuple:

```python
              test_split_row_into_measures_falls_back_on_undecodable_bytes,
              test_validate_measure_duration_sum,
              test_validate_measure_skips_duration_check_on_pickup_and_final_measures,
              test_validate_measure_written_pitch_range,
              test_validate_measure_unexpected_polyphony,
              test_validate_measure_polyphony_allowed_for_piano,
              test_validate_measure_unknown_instrument_skips_range_check_gracefully,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[85\]\|\[86\]\|\[87\]\|\[88\]\|\[89\]\|\[90\]"`
Expected: `AttributeError: module 'worker' has no attribute 'validate_measure'`.

- [ ] **Step 3: Implement the tables and `validate_measure`**

Insert immediately before `INSTRUMENT_TRANSPOSE = {` (line 3931):

```python
# Written (NOT concert/sounding) pitch range per instrument, generously
# bounded — this validator exists to catch GROSS errors (a two-octave
# misread), not to police advanced/altissimo technique, so ranges lean
# wide rather than tight. Keyed the same lowercase-name, longest-substring-
# match convention as INSTRUMENT_TRANSPOSE (see _instrument_lookup below).
# An instrument absent from this table is NOT flagged for range — missing
# data is not evidence of a problem (see validate_measure's docstring).
INSTRUMENT_WRITTEN_RANGE = {
    "piccolo": (62, 96), "flute": (60, 98), "oboe": (58, 93),
    "english horn": (58, 93), "cor anglais": (58, 93),
    "bassoon": (34, 75), "contrabassoon": (34, 70),
    "clarinet (b\u266d)": (40, 96), "clarinet (bb)": (40, 96), "bb clarinet": (40, 96),
    "clarinet": (40, 96), "clarinet (a)": (40, 96), "a clarinet": (40, 96),
    "clarinet (e\u266d)": (40, 96), "clarinet (eb)": (40, 96), "eb clarinet": (40, 96),
    "bass clarinet": (40, 94),
    "soprano saxophone": (58, 90), "alto saxophone": (58, 90),
    "tenor saxophone": (58, 90), "baritone saxophone": (58, 90),
    "alto sax": (58, 90), "tenor sax": (58, 90),
    "recorder": (60, 86),
    "trumpet (b\u266d)": (54, 86), "trumpet (bb)": (54, 86), "trumpet": (54, 86),
    "trumpet (c)": (54, 86), "cornet (b\u266d)": (54, 86), "cornet": (54, 86),
    "flugelhorn": (54, 86),
    "french horn (f)": (41, 84), "french horn": (41, 84), "horn": (41, 84),
    "trombone": (28, 70), "bass trombone": (24, 65),
    "euphonium": (28, 77), "tuba": (26, 65),
    "violin": (43, 100), "viola": (48, 88), "cello": (36, 84),
    "double bass": (28, 79),
}

# Instruments where more than one note at the same beat is EXPECTED, not
# suspicious — a short, explicit set, not derived from any transposition
# table (INSTRUMENT_TRANSPOSE encodes transposition amounts, not
# polyphony, and conflating the two was a real mistake caught during this
# spec's own review).
POLYPHONIC_INSTRUMENTS = {
    "piano", "organ", "harpsichord", "guitar", "classical guitar",
    "electric guitar", "bass guitar", "harp", "ukulele", "mandolin", "banjo",
}


def _instrument_lookup(table: dict, instrument: str):
    """Same normalized-string, longest-substring-match lookup convention
    as transpose_for_instrument (worker.py:3982), factored out so
    INSTRUMENT_WRITTEN_RANGE and POLYPHONIC_INSTRUMENTS resolve instrument
    strings identically to how INSTRUMENT_TRANSPOSE already does."""
    key = (instrument or "").strip().lower()
    if not key:
        return None
    if key in table:
        return table[key] if isinstance(table, dict) else True
    hits = [(len(k), (table[k] if isinstance(table, dict) else True))
            for k in table if k in key]
    return max(hits)[1] if hits else None


def validate_measure(measure: dict, instrument: str, time_sig: str,
                      is_first_measure: bool = False, is_last_measure: bool = False) -> dict:
    """
    Deterministic, model-independent checks on one measure's musical
    plausibility. Returns {"valid": bool, "issues": [str, ...]}.

    ASYMMETRIC BY DESIGN: `invalid` is strong evidence something is
    wrong. `valid` is NOT evidence something is right — a measure can
    have the correct note count, duration, range, and voice count while
    every individual pitch is wrong (e.g. printed C-D-E-F misread as
    C-D-F-G passes every check here). Never treat this function's
    `valid` result as sufficient justification for high confidence
    anywhere in the pipeline — see fuse_measure_confidence.

    Expects `measure["notes"]` entries in the SAME shape
    read_score_notes_claude already normalizes to (pitch, is_rest, beat,
    duration_beats), with duration_beats in NOTATED BEAT units (matching
    Claude's own prompt convention) — NOT quarterLengths. A caller
    passing music21/oemer-sourced measures MUST convert duration_beats
    via quarter_lengths_per_beat(time_sig) first (see
    read_score_notes_oemer in Task 7), or this function's duration-sum
    check will be wrong for any non-simple time signature.
    """
    notes = measure.get("notes") or []
    issues: list[str] = []

    if not is_first_measure and not is_last_measure:
        total_beats = sum(float(n.get("duration_beats") or 0) for n in notes)
        expected = beats_per_measure_from_time_sig(time_sig)
        if abs(total_beats - expected) > 0.05:
            issues.append(f"duration sum {total_beats:.2f} beats does not match "
                           f"{expected} beats expected for {time_sig}")

    written_range = _instrument_lookup(INSTRUMENT_WRITTEN_RANGE, instrument)
    if written_range:
        lo, hi = written_range
        for n in notes:
            if n.get("is_rest") or not n.get("pitch"):
                continue
            midi = midi_from_name(n["pitch"])
            if midi is not None and not (lo <= midi <= hi):
                issues.append(f"pitch {n['pitch']} (MIDI {midi}) is outside the "
                               f"instrument's written range [{lo}, {hi}]")

    is_polyphonic_instrument = bool(_instrument_lookup(POLYPHONIC_INSTRUMENTS, instrument))
    if not is_polyphonic_instrument:
        by_beat: dict[float, int] = {}
        for n in notes:
            if n.get("is_rest") or not n.get("pitch"):
                continue
            b = round(float(n.get("beat") or 0), 2)
            by_beat[b] = by_beat.get(b, 0) + 1
        simultaneous = [b for b, count in by_beat.items() if count > 1]
        if simultaneous:
            issues.append(f"unexpected polyphony for a monophonic instrument at "
                           f"beat(s) {simultaneous}")

    return {"valid": not issues, "issues": issues}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add deterministic music validator (duration, written range, polyphony)"
```

---

### Task 5: Ground-truth transcription (coordination task — not pure coding)

**This task is different from every other task in this plan.** It does not produce code. It produces a data file — a verified-correct, measure-by-measure transcription of the real problem photo used throughout this investigation — that Task 13's live test depends on. It cannot be completed by a coding subagent guessing at the right answer; an attempt at exactly that (reading the photo directly, by eye) was already tried while writing the spec and abandoned as unreliable (see the spec's Testing section).

**Files:**
- Create: `modal_worker/testdata/procession_of_the_nobles_ground_truth.json`

**Interfaces:**
- Produces: a JSON file, one entry per measure, in the same shape `read_score_notes_claude` returns measures (`{"number": int, "notes": [{"pitch", "is_rest", "beat", "duration_beats"}, ...]}`), covering at minimum measures 12 through 30 of the real problem photo (the range already exercised throughout tonight's investigation). Consumed directly by Task 13 (the live ground-truth test) — nothing else in this plan reads this file.

- [ ] **Step 1: Obtain verified ground truth, using the spec's stated priority order**

Whoever executes this task (the plan's controller, not a coding subagent) must do ONE of the following, in this order of preference:

1. **Ask the take's owner directly** to verify or correct a candidate transcription against the physical page. Fastest, most reliable.
2. **Find a clean published source** for this exact arrangement — "Procession of the Nobles" (from Rimsky-Korsakov's *Mlada*), arranged by Jay Bocook, published by MusicWorks, 1992, plate/catalog number 26423039 (visible in the photographed page's footer). Check IMSLP, MuseScore, or a purchasable clean PDF of this specific band arrangement.
3. **Obtain a cleaner photo or real scan** of the same page and have a person (not an LLM) transcribe from that.

Do not proceed to Step 2 with a transcription that hasn't been verified by one of these methods. If none are available in a reasonable time, escalate back to the user rather than substitute a best-guess — this is the one place in the whole plan where guessing defeats the entire point of the redesign.

- [ ] **Step 2: Write the ground truth to the data file**

```json
{
  "source": "<which of the three methods above was used, and by whom>",
  "piece": "Procession of the Nobles (Rimsky-Korsakov, arr. Jay Bocook, MusicWorks 1992, plate 26423039)",
  "instrument": "B\u266d Clarinet 1",
  "time_signature": "3/4",
  "measures": [
    {"number": 12, "notes": [{"pitch": "...", "is_rest": false, "beat": 1.0, "duration_beats": 0.5}]},
    ...
  ]
}
```

(The exact note content is what Step 1 must produce — not written here, since this plan cannot ship a guessed answer as if it were verified.)

- [ ] **Step 3: Commit**

```bash
git add modal_worker/testdata/procession_of_the_nobles_ground_truth.json
git commit -m "test: add verified ground-truth transcription for the reference-audio live test"
```

---

### Task 6: `oemer` GO/NO-GO decision (investigative task — explicit decision criteria)

**This task, like Task 5, is not pure coding.** It produces a decision, with evidence, that gates whether Task 7 happens at all. Do not write `read_score_notes_oemer`'s full implementation before this task completes — that is the exact ordering mistake the spec's review caught ("don't write the whole integration before proving oemer produces useful independent information").

**Files:**
- Create (throwaway, matching tonight's own Audiveris-spike convention): a temporary local Modal function/entrypoint appended to `modal_worker/worker.py`, reverted after this task via `git checkout` — never committed.

**Interfaces:**
- Consumes: Task 1's `dewarp_row`, Task 5's ground truth.
- Produces: a GO/NO-GO decision recorded in this plan's execution ledger, consumed by Task 7 (implement fully) or Task 7-skip (see Step 4 below).

- [ ] **Step 1: Install `oemer` in a throwaway Modal function**

Follow the exact pattern already used tonight for the Audiveris spike (temporarily appending `_spike_run_oemer`/`oemer_spike` functions after `test_local` at the end of `worker.py`, adding `"oemer"` to the Modal image's `pip_install` list ONLY in this throwaway commit, running via `modal run modal_worker/worker.py::oemer_spike`, then `git checkout modal_worker/worker.py` to revert once this task's evidence is gathered). Verify `oemer`'s CLI works at all first: `oemer <input.png> -o <output_dir>` should produce a `.musicxml` file (confirmed against oemer 0.1.8's actual `ete.py` CLI entry point before this plan was written — the shape is `argparse` with `img_path` positional and `-o/--output-path`).

**Known risk to check immediately**: `oemer`'s PyPI metadata lists `onnxruntime-gpu` as a dependency, not the CPU `onnxruntime` package, and this project's Modal image is CPU-only. If `pip install oemer` pulls in `onnxruntime-gpu` and it fails to load/run without a GPU, try installing plain `onnxruntime` in the same image (some versions of `onnxruntime-gpu` fall back to CPU execution providers; if it doesn't, override by installing `onnxruntime` after `oemer` in the same `pip_install` list so it takes precedence, or patch the import). Record whichever approach works.

- [ ] **Step 2: Run oemer against 5-10 real dewarped crops**

Using the same real problem photo used throughout tonight's investigation (already in this plan's controller's context — the exact score page from take `34b08cfd-f533-4fe1-a588-5af04fe5ddc5`), run `split_page_into_rows` → `dewarp_row` on at least 2 rows covering measures 12-19, then run `oemer` on each dewarped row (or, if Task 3 is already merged, on 5-10 individual measure crops — either granularity is acceptable for this GO/NO-GO test).

- [ ] **Step 3: Compare oemer's output against Task 5's ground truth**

For each test crop, record: did oemer produce ANY usable MusicXML? If so, parse it with the existing `parse_score_document` and compare its reported pitches/durations against the corresponding ground-truth measures.

- [ ] **Step 4: Decide GO/NO-GO using these explicit criteria**

**GO** if: oemer produces parseable MusicXML for at least 3 of the 5-10 test crops, AND for at least 2 of those, the note count is within ±30% of the ground truth's note count for that measure (oemer does not need to be highly accurate — per the spec, it only needs to independently disagree with Claude often enough and correctly enough to be a useful second signal, a much lower bar than being the primary recognizer).

**NO-GO** if oemer fails to produce usable output on most crops, crashes/times out repeatedly, or its note-level output is so far from ground truth (e.g. wildly different note counts, wrong clef assumed on every crop) that it would produce noise rather than signal.

- [ ] **Step 5: Record the decision and revert the spike**

```bash
git diff modal_worker/worker.py   # confirm the diff is only the throwaway spike additions
git checkout modal_worker/worker.py
```

Append the decision, with the evidence from Steps 2-3, to this plan's execution ledger (the `.superpowers/sdd/` progress file if executing via subagent-driven-development, per that skill's own conventions). **If GO: proceed to Task 7. If NO-GO: skip Task 7 entirely and proceed directly to Task 8 with oemer treated as permanently `unavailable`** — `fuse_measure_confidence` (Task 9) already has a defined behavior for this (Claude-agreement + validator only), so a NO-GO here does not block the rest of the plan.

---

### Task 7: `read_score_notes_oemer` (only if Task 6 was GO)

**Files:**
- Modify: `modal_worker/worker.py` — add near `convert_visual_score_to_musicxml` (the existing Audiveris integration, `modal_worker/worker.py:1238`), since this function mirrors its structure closely. Also modify the Modal image definition (`image = (` block starting at `modal_worker/worker.py:31`) to add `oemer` (and, per Task 6's findings, possibly a corrected `onnxruntime` package) to `pip_install`.
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `parse_score_document(score_bytes, start_measure, instrument) -> dict` (existing, line 1213), `quarter_lengths_per_beat(time_sig) -> float` (existing, line 3666), `find_exported_musicxml(output_dir) -> str | None` (existing, line 1222 — reusable as-is, oemer's `.musicxml` output matches the same discovery pattern).
- Produces: `read_score_notes_oemer(crop_bytes: bytes, time_sig: str) -> dict` returning the same `ScoreResult` shape every other reader returns, with `duration_beats` ALREADY converted to notated-beat units. Consumed by Task 8/9/11.

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after Task 4's last test:

```python
def test_read_score_notes_oemer_parses_subprocess_output():
    print("\n[91] oemer reader shells out and parses the resulting MusicXML, converting duration units")
    import types, subprocess as _subprocess

    fake_musicxml = b"""<?xml version="1.0"?>
<score-partwise>
  <part-list><score-part id="P1"/></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions>
        <time><beats>3</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</part-list>
</score-partwise>"""

    captured = {}
    _orig_run = _subprocess.run

    def _fake_run(cmd, **kw):
        captured["cmd"] = cmd
        output_dir = cmd[cmd.index("-o") + 1] if "-o" in cmd else cmd[cmd.index("--output-path") + 1]
        import os
        os.makedirs(output_dir, exist_ok=True)
        with open(os.path.join(output_dir, "out.musicxml"), "wb") as f:
            f.write(fake_musicxml)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    _subprocess.run = _fake_run
    try:
        result = w.read_score_notes_oemer(b"\x89PNG-fake-crop", "3/4")
    finally:
        _subprocess.run = _orig_run

    check("invokes the oemer CLI", "oemer" in captured.get("cmd", []), str(captured.get("cmd")))
    check("no error on successful parse", not result.get("error"), str(result))
    check("finds the one measure", len(result.get("measures", [])) == 1, str(result))
    if result.get("measures"):
        note = result["measures"][0]["notes"][0]
        check("duration_beats converted to notated beats (quarterLength 4 / 1 qlb-per-beat in simple 3/4 = 4... "
              "but simple time means qlb=1, so this checks the conversion runs, not a specific compound case",
              note["duration_beats"] == 4.0, str(note))


def test_read_score_notes_oemer_handles_subprocess_failure():
    print("\n[92] oemer reader returns an error shape (not a raise) when the subprocess fails")
    import subprocess as _subprocess
    _orig_run = _subprocess.run
    def _fake_run(cmd, **kw):
        raise FileNotFoundError("oemer: command not found")
    _subprocess.run = _fake_run
    try:
        result = w.read_score_notes_oemer(b"\x89PNG-fake-crop", "3/4")
    finally:
        _subprocess.run = _orig_run
    check("returns an error dict, does not raise",
          result.get("error") is not None and result.get("measures") == [], str(result))
```

Register in `main()`'s tuple after Task 4's last registration:

```python
              test_validate_measure_unknown_instrument_skips_range_check_gracefully,
              test_read_score_notes_oemer_parses_subprocess_output,
              test_read_score_notes_oemer_handles_subprocess_failure,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[91\]\|\[92\]"`
Expected: `AttributeError: module 'worker' has no attribute 'read_score_notes_oemer'`.

- [ ] **Step 3: Add `oemer` to the Modal image, implement `read_score_notes_oemer`**

Modify the `image = (` block (line 31) — add `"oemer"` to the existing `pip_install(...)` call's argument list (find the exact current list via `grep -n "pip_install" modal_worker/worker.py` and add alongside it, following whatever fix Task 6 found for the `onnxruntime`/`onnxruntime-gpu` conflict — e.g. `"onnxruntime>=1.15,<2.0"` listed AFTER `"oemer"` in the same `pip_install` call so pip's dependency resolver prefers the explicit CPU package).

Insert near `convert_visual_score_to_musicxml` (after it, before `assign_events_to_measures` — verify this is still the function immediately following before inserting):

```python
def read_score_notes_oemer(crop_bytes: bytes, time_sig: str) -> dict:
    """
    Shells out to the oemer CLI (a real, MIT-licensed OMR engine) on one
    image crop — a measure crop or a row crop, whichever the caller has
    available — and parses the resulting MusicXML with the already-
    existing parse_score_document. Mirrors convert_visual_score_to_musicxml's
    (Audiveris) structure closely; oemer's CLI shape is `oemer <img> -o <dir>`,
    producing a `.musicxml` file discoverable the same way.

    CRITICAL UNIT CONVERSION: parse_score_document/parse_musicxml reports
    duration_beats as a quarterLength (music21's convention), but every
    other reader in this pipeline (read_score_notes_claude, and this
    function's own caller) works in NOTATED BEAT units. This function
    converts before returning, dividing by quarter_lengths_per_beat(time_sig)
    — skipping this conversion silently breaks fusion/validation for any
    non-simple time signature (see this plan's Global Constraints).

    Returns the same ScoreResult shape as every other reader. Never
    raises — a missing binary, a crash, or no exported MusicXML all come
    back as {"measures": [], "error": ...}, treated as OMR-unavailable by
    the caller rather than a pipeline failure.
    """
    import os
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, "crop.png")
        output_dir = os.path.join(tmpdir, "oemer-output")
        os.makedirs(output_dir, exist_ok=True)
        with open(input_path, "wb") as f:
            f.write(crop_bytes)

        try:
            result = subprocess.run(
                ["oemer", input_path, "-o", output_dir],
                capture_output=True, text=True, timeout=120,
            )
        except Exception as e:
            return {"measures": [], "error": f"oemer subprocess failed: {e}", "source": "oemer"}

        exported_path = find_exported_musicxml(output_dir)
        if result.returncode != 0 or not exported_path:
            last_output = (result.stderr or result.stdout or "")[:500] if hasattr(result, "stderr") else ""
            return {"measures": [], "error": f"oemer produced no MusicXML export: {last_output}",
                    "source": "oemer"}

        with open(exported_path, "rb") as f:
            exported_bytes = f.read()

        parsed = parse_score_document(exported_bytes, 1)
        if parsed.get("error"):
            return {"measures": [], "error": parsed["error"], "source": "oemer"}

        qlb = quarter_lengths_per_beat(time_sig)
        for m in parsed.get("measures", []):
            for n in m.get("notes", []):
                if n.get("duration_beats") is not None and qlb:
                    n["duration_beats"] = n["duration_beats"] / qlb

        parsed["source"] = "oemer"
        return parsed
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`.

- [ ] **Step 5: Verify the image still builds**

Run: `modal run modal_worker/worker.py::test_local` (the existing smoke-test entrypoint at the end of the file) — confirms the modified Modal image (with `oemer` added) still builds and the app loads.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add oemer OMR integration as a second recognition source"
```

---

### Task 8: `align_claude_to_measure_crops`

**Files:**
- Modify: `modal_worker/worker.py` — add near `split_row_into_measures` (Task 3).
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: nothing new (pure function over already-defined shapes).
- Produces: `align_claude_to_measure_crops(claude_row_measures: list[dict], crop_count: int) -> list[dict] | None`. Consumed by Task 11 (orchestration).

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after Task 7's last test (or Task 4's last test, if Task 6 was NO-GO and Task 7 was skipped — check the actual current file state and insert after whichever task actually ran last):

```python
def test_align_claude_to_measure_crops_matches_on_equal_count():
    print("\n[93] alignment succeeds when Claude's measure count matches the crop count")
    claude_measures = [{"number": 12, "notes": []}, {"number": 13, "notes": []}, {"number": 14, "notes": []}]
    result = w.align_claude_to_measure_crops(claude_measures, crop_count=3)
    check("returns the measures unchanged, in order", result == claude_measures, str(result))


def test_align_claude_to_measure_crops_refuses_on_count_mismatch():
    print("\n[94] alignment refuses (returns None) rather than guess when counts disagree")
    claude_measures = [{"number": 12, "notes": []}, {"number": 13, "notes": []}]
    result = w.align_claude_to_measure_crops(claude_measures, crop_count=3)
    check("returns None on a count mismatch rather than forcing a positional guess",
          result is None, str(result))
```

Register in `main()`'s tuple:

```python
              test_align_claude_to_measure_crops_matches_on_equal_count,
              test_align_claude_to_measure_crops_refuses_on_count_mismatch,
```

(Insert directly after whichever test was registered last by the previous task that actually ran — Task 7's `test_read_score_notes_oemer_handles_subprocess_failure` if GO, or Task 4's `test_validate_measure_unknown_instrument_skips_range_check_gracefully` if NO-GO.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[93\]\|\[94\]"`
Expected: `AttributeError: module 'worker' has no attribute 'align_claude_to_measure_crops'`.

- [ ] **Step 3: Implement**

```python
def align_claude_to_measure_crops(claude_row_measures: list[dict], crop_count: int) -> list[dict] | None:
    """
    [Revision 2 from the spec] Positionally aligns Claude's measures for
    ONE row (already ordered left-to-right by printed number) to that
    row's measure-crop list from split_row_into_measures, by INDEX —
    never by any measure number oemer itself might separately infer.

    Returns None (alignment refused) if Claude's measure count for this
    row doesn't match crop_count. This mismatch means either
    segmentation or Claude's read is wrong for this row; forcing a
    positional match anyway would silently mislabel every measure after
    the first disagreement, which is worse than not aligning at all.
    """
    if len(claude_row_measures) != crop_count:
        return None
    return list(claude_row_measures)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add positional Claude/oemer measure alignment"
```

---

### Task 9: `fuse_measure_confidence`

**Files:**
- Modify: `modal_worker/worker.py` — add near `align_claude_to_measure_crops` (Task 8).
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `_measure_fingerprint(m: dict) -> tuple` (existing, line 3524), `validate_measure` (Task 4).
- Produces: `fuse_measure_confidence(claude_agree: bool, claude_measure: dict, oemer_measure: dict | None, validation: dict) -> dict` returning `{"confidence": "high" | "medium" | "low", "needs_resolution": bool, "reasons": list[str]}`. Consumed by Task 11 (orchestration).

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after Task 8's last test:

```python
def test_fuse_measure_confidence_verdict_table():
    print("\n[95] confidence fusion follows the spec's verdict table exactly, one case per row")
    claude_m = {"number": 12, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]}
    oemer_match = {"number": 12, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]}
    oemer_mismatch = {"number": 12, "notes": [{"pitch": "D4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]}
    valid = {"valid": True, "issues": []}
    invalid = {"valid": False, "issues": ["duration sum wrong"]}

    r1 = w.fuse_measure_confidence(claude_agree=True, claude_measure=claude_m, oemer_measure=oemer_match, validation=invalid)
    check("invalid validator verdict ALWAYS needs resolution, even with Claude+OMR agreement",
          r1["needs_resolution"], str(r1))

    r2 = w.fuse_measure_confidence(claude_agree=True, claude_measure=claude_m, oemer_measure=oemer_match, validation=valid)
    check("Claude agree + OMR match + valid = high confidence, no resolution needed",
          r2["confidence"] == "high" and not r2["needs_resolution"], str(r2))

    r3 = w.fuse_measure_confidence(claude_agree=True, claude_measure=claude_m, oemer_measure=None, validation=valid)
    check("Claude agree + OMR unavailable + valid = accept, medium-high, no resolution",
          not r3["needs_resolution"], str(r3))

    r4 = w.fuse_measure_confidence(claude_agree=True, claude_measure=claude_m, oemer_measure=oemer_mismatch, validation=valid)
    check("Claude agree + OMR MISMATCH needs resolution even though Claude agrees with itself "
          "(this is the 'consistent wrong answer' case cross-validation alone cannot catch)",
          r4["needs_resolution"], str(r4))

    r5 = w.fuse_measure_confidence(claude_agree=False, claude_measure=claude_m, oemer_measure=oemer_match, validation=valid)
    check("Claude disagreement (with itself) always needs resolution regardless of OMR",
          r5["needs_resolution"], str(r5))
```

Register in `main()`'s tuple:

```python
              test_align_claude_to_measure_crops_refuses_on_count_mismatch,
              test_fuse_measure_confidence_verdict_table,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[95\]"`
Expected: `AttributeError: module 'worker' has no attribute 'fuse_measure_confidence'`.

- [ ] **Step 3: Implement**

```python
def fuse_measure_confidence(claude_agree: bool, claude_measure: dict,
                             oemer_measure: dict | None, validation: dict) -> dict:
    """
    Combines Claude's own agreement/disagreement state (already computed
    by read_score_notes_claude's existing cross-validation),
    the OMR candidate for this SAME measure (already positionally
    aligned by align_claude_to_measure_crops — None if alignment wasn't
    possible or oemer is unavailable/NO-GO), and validate_measure's
    verdict, into one fusion outcome.

    [Revision 2 from the spec] validate_measure's `invalid` is checked
    FIRST and always wins — a measure that fails deterministic checks is
    never rescued by Claude/OMR agreement. Its `valid` verdict is never,
    on its own, sufficient for high confidence; every acceptance path
    below also requires claude_agree=True.
    """
    if not validation.get("valid", True):
        return {"confidence": "low", "needs_resolution": True,
                "reasons": ["validator invalid: " + "; ".join(validation.get("issues", []))]}

    if not claude_agree:
        return {"confidence": "low", "needs_resolution": True,
                "reasons": ["Claude's own independent reads disagreed on this measure"]}

    if oemer_measure is None:
        return {"confidence": "medium", "needs_resolution": False,
                "reasons": ["Claude agrees with itself, OMR unavailable for this measure, "
                            "validator passed"]}

    oemer_matches = _measure_fingerprint(claude_measure) == _measure_fingerprint(oemer_measure)
    if oemer_matches:
        return {"confidence": "high", "needs_resolution": False,
                "reasons": ["Claude agrees with itself, OMR independently matches, validator passed"]}

    return {"confidence": "low", "needs_resolution": True,
            "reasons": ["Claude agrees with itself but OMR independently disagrees — "
                        "this is exactly the 'consistent wrong answer' case same-model "
                        "cross-validation alone cannot catch"]}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add confidence fusion across Claude, OMR, and validator signals"
```

---

### Task 10: `resolve_measure_disagreement`

**Files:**
- Modify: `modal_worker/worker.py` — add near `_read_score_notes_claude_once` (line 3291), since it makes a similar Claude vision call.
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: none new (uses the `anthropic` client the same way `_read_score_notes_claude_once` already does).
- Produces: `resolve_measure_disagreement(measure_crop_bytes: bytes, candidates: list[dict], instrument: str, anthropic_api_key: str) -> dict` returning a single measure dict in the same normalized shape (`{"notes": [...]}`). Consumed by Task 11 (orchestration).

- [ ] **Step 1: Write the failing test**

Add to `modal_worker/test_analysis.py`, after Task 9's last test:

```python
def test_resolve_measure_disagreement_sends_crop_and_candidates():
    print("\n[96] targeted disagreement resolution sends the measure crop and candidate list, not an open re-read")
    import types, json as _json
    captured = {}

    class _FakeStream:
        def __init__(self, payload): self._payload = payload
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self):
            return types.SimpleNamespace(
                content=[types.SimpleNamespace(text=self._payload)], stop_reason="end_turn")

    class _FakeMessages:
        def stream(self, **kw):
            captured["content"] = kw["messages"][0]["content"]
            return _FakeStream(_json.dumps({
                "notes": [{"p": "C4", "b": 1.0, "d": 3.0}],
            }))

    class _FakeAnthropicClient:
        def __init__(self, **kw): self.messages = _FakeMessages()

    candidates = [
        {"notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]},
        {"notes": [{"pitch": "D4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]},
    ]

    import anthropic as _ac
    _orig = _ac.Anthropic
    _ac.Anthropic = _FakeAnthropicClient
    try:
        result = w.resolve_measure_disagreement(b"\x89PNG-fake-crop", candidates, "clarinet", "k")
    finally:
        _ac.Anthropic = _orig

    blocks = captured.get("content") or []
    n_images = sum(1 for b in blocks if isinstance(b, dict) and b.get("type") == "image")
    check("sends exactly one image (the tight measure crop, not a full page/row)",
          n_images == 1, f"{n_images} image block(s)")
    prompt_text = " ".join(b["text"] for b in blocks if isinstance(b, dict) and b.get("type") == "text")
    check("prompt is closed-ended (mentions candidates), not an open re-transcription request",
          "candidate" in prompt_text.lower(), prompt_text[:400])
    check("returns a normalized measure with notes",
          result.get("notes") and result["notes"][0]["pitch"] == "C4", str(result))
```

Register in `main()`'s tuple:

```python
              test_fuse_measure_confidence_verdict_table,
              test_resolve_measure_disagreement_sends_crop_and_candidates,
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[96\]"`
Expected: `AttributeError: module 'worker' has no attribute 'resolve_measure_disagreement'`.

- [ ] **Step 3: Implement**

```python
def resolve_measure_disagreement(measure_crop_bytes: bytes, candidates: list[dict],
                                  instrument: str, anthropic_api_key: str) -> dict:
    """
    Closed-ended disagreement resolution for ONE low-confidence measure.
    [Revision 2 from the spec]: replaces the old approach of "just read
    it again" (open-ended, on the whole row/page) with a strictly easier
    task — a tight crop of just this one measure, plus the specific
    candidates already produced, asking the model to pick a match or
    transcribe only this small crop if none match. Structurally harder
    for the model to keep generating a plausible-but-wrong pattern, since
    there's no multi-measure context left to pattern-match against.

    Returns a single measure dict: {"notes": [...]} in the same
    normalized shape read_score_notes_claude's measures use. Never
    raises — a parse/API failure returns the first candidate unchanged,
    since a low-confidence-but-present answer beats losing the measure
    entirely.
    """
    import base64, json as _json, anthropic as ac

    b64 = base64.b64encode(measure_crop_bytes).decode()
    candidates_text = "\n".join(
        f"Candidate {i+1}: " + ", ".join(
            f"{n.get('pitch') or 'rest'}@beat{n.get('beat')}for{n.get('duration_beats')}beats"
            for n in c.get("notes", [])
        )
        for i, c in enumerate(candidates)
    )
    prompt = f"""You are an expert music engraver verifying a single measure for a {instrument} part.

Here is one measure, cropped tightly from the printed page. Independent readings already produced these candidates:

{candidates_text}

Inspect the printed measure carefully. Which candidate number matches exactly what's printed? If none match exactly, transcribe ONLY this measure yourself.

Return JSON only (no markdown):
{{"matched_candidate": <candidate number, or null if none match>, "notes": [{{"p": "D3", "b": 1.0, "d": 1.5}}]}}

If matched_candidate is not null, "notes" may be empty — the matched candidate's own notes will be used."""

    try:
        client = ac.Anthropic(api_key=anthropic_api_key)
        with client.messages.stream(
            model="claude-sonnet-4-6",
            max_tokens=2000,
            temperature=0,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                {"type": "text", "text": prompt},
            ]}],
        ) as stream:
            msg = stream.get_final_message()
        raw = msg.content[0].text
        parsed = extract_json_object(raw) or {}

        matched = parsed.get("matched_candidate")
        if isinstance(matched, int) and 1 <= matched <= len(candidates):
            return candidates[matched - 1]

        notes = parsed.get("notes")
        if isinstance(notes, list) and notes:
            def _norm_note(n: dict) -> dict:
                return {
                    "pitch": n.get("pitch") or n.get("p"),
                    "is_rest": bool(n.get("is_rest") or n.get("r") or False),
                    "beat": n.get("beat") if n.get("beat") is not None else n.get("b"),
                    "duration_beats": n.get("duration_beats") if n.get("duration_beats") is not None else n.get("d"),
                }
            return {"notes": [_norm_note(n) for n in notes]}

        return candidates[0]
    except Exception as e:
        print(f"[resolve_measure_disagreement] failed, keeping first candidate: {e}")
        return candidates[0]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`.

- [ ] **Step 5: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add targeted closed-ended disagreement resolution"
```

---

### Task 11: Wire the pipeline into `read_score_notes_claude`

**Files:**
- Modify: `modal_worker/worker.py:3544` (`read_score_notes_claude`'s current definition) — this is the shared entry point both `read_score_notes_for_reference_audio` (line 3874) and the main analysis pipeline (line 6671, verify this line number is still current before editing — the file has grown since this plan was drafted) already call. Neither call site needs to change; all new behavior is internal to this function.
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: every function from Tasks 1-10.
- Produces: `read_score_notes_claude`'s existing external signature and return shape, UNCHANGED (`(pages, start_measure, instrument, time_sig, anthropic_api_key) -> dict`).

- [ ] **Step 1: Re-verify the current exact body of `read_score_notes_claude` and `_read_score_notes_claude_once`**

Run `sed -n '3291,3640p' modal_worker/worker.py` and confirm it still matches what Tasks 1-10 assumed — nine tasks and several days of (simulated) elapsed time may have touched this region. If it has drifted, stop and reconcile before proceeding; do not guess at the current state.

- [ ] **Step 2: Add a per-page/row preparation helper**

Insert before `_read_score_notes_claude_once` (which currently builds `vision_parts`/`page_strip_counts` inline via a loop calling `split_page_into_rows` directly):

```python
def _prepare_score_rows(pages: list[tuple[bytes, str]]) -> list[dict]:
    """
    Runs the full per-row preparation pipeline ONCE per page: split into
    systems, dewarp each system locally, measure its readability, and
    segment it into measure crops. Shared by both Claude's reading path
    and the OMR path so page download + split + dewarp work isn't
    duplicated between them.

    Returns a list of dicts, one per PAGE, each:
    {"page_mime": str, "rows": [{"row_bytes": bytes (dewarped),
    "readability": dict, "segmentation": dict}, ...]}
    PDF pages pass through with an empty "rows" list — dewarping/
    segmentation only apply to raster images, matching
    split_page_into_rows' own existing image-only scope.
    """
    CLAUDE_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    prepared = []
    for pg_bytes, pg_mime in pages:
        if pg_mime not in CLAUDE_IMAGE_TYPES:
            prepared.append({"page_mime": pg_mime, "page_bytes": pg_bytes, "rows": []})
            continue
        row_crops = split_page_into_rows(pg_bytes)
        rows = []
        for row_idx, row_bytes in enumerate(row_crops):
            dewarped = dewarp_row(row_bytes)
            readability = compute_row_readability(dewarped)
            if readability["quality"] != "good":
                # Generation still proceeds on a marginal/poor row (per the
                # spec: flagged, not blocked) — but this print is the only
                # record that a low-quality row was in play, for anyone
                # debugging a bad transcription after the fact. The
                # user-facing warning is a SEPARATE, earlier check (Task 12's
                # upload-time quality gate) — this log is for diagnostics,
                # not the user.
                print(f"[_prepare_score_rows] row {row_idx} quality={readability['quality']} "
                      f"interline_px={readability['interline_px']}: {readability['reasons']}")
            segmentation = split_row_into_measures(dewarped)
            rows.append({"row_bytes": dewarped, "readability": readability,
                         "segmentation": segmentation})
        prepared.append({"page_mime": pg_mime, "page_bytes": pg_bytes, "rows": rows})
    return prepared
```

- [ ] **Step 3: Modify `_read_score_notes_claude_once` to accept pre-prepared rows**

Change its signature from `(pages: list[tuple[bytes, str]], ...)` to also accept the prepared structure, replacing its internal `split_page_into_rows` call with the already-dewarped rows from `_prepare_score_rows`. Locate the existing loop (currently starting `for pg_bytes, pg_mime in pages:` — verify this is still the exact loop structure) and replace the body's image branch (`elif pg_mime in CLAUDE_IMAGE_TYPES:` through the inner `for crop_bytes in row_crops:` block) so it iterates `prepared_page["rows"]` and uses each `row["row_bytes"]` directly instead of calling `split_page_into_rows` itself. Add a new parameter `prepared_pages: list[dict]` and use it in place of the raw `pages` loop; keep `pages` as a parameter only for the PDF branch (PDFs still pass through as full documents, unaffected by row-level preparation).

- [ ] **Step 4: Rewrite `read_score_notes_claude`'s body**

Replace the whole function body (keep the same signature: `(pages, start_measure, instrument, time_sig, anthropic_api_key) -> dict`):

```python
def read_score_notes_claude(
    pages: list[tuple[bytes, str]],
    start_measure: int, instrument: str, time_sig: str,
    anthropic_api_key: str,
) -> dict:
    """
    [Rewritten per docs/superpowers/specs/2026-09-12-reference-audio-recognition-pipeline.md]

    Orchestrates the full multi-signal pipeline: dewarp + segment each
    row once (shared prep), read via Claude (2-3x same-model cross-
    validation, unchanged logic from before this rewrite), independently
    cross-check with oemer where alignment allows, validate every measure
    deterministically, fuse all three signals per measure, and resolve
    any measure fusion flags as low-confidence via a single targeted,
    closed-ended call instead of another open re-read.

    External signature and return shape are UNCHANGED — callers
    (read_score_notes_for_reference_audio, the main analysis pipeline)
    need no changes.
    """
    prepared_pages = _prepare_score_rows(pages)

    read_a = _read_score_notes_claude_once(pages, prepared_pages, start_measure, instrument, time_sig, anthropic_api_key)
    read_b = _read_score_notes_claude_once(pages, prepared_pages, start_measure, instrument, time_sig, anthropic_api_key)

    if read_a.get("error") and read_b.get("error"):
        return read_a
    if read_a.get("error"):
        base_result = read_b
        # Only one read succeeded — there is no cross-validation signal
        # to compute. Every measure that made it into base_result is the
        # best (only) data available, so it defaults to "agreed" via
        # claude_agreement.get(number, True) below, rather than being
        # penalized for a read that never got a chance to happen.
        claude_agreement = {}
    elif read_b.get("error"):
        base_result = read_a
        claude_agreement = {}
    else:
        by_number_a = {m["number"]: m for m in read_a.get("measures", [])}
        by_number_b = {m["number"]: m for m in read_b.get("measures", [])}
        all_numbers = sorted(set(by_number_a) | set(by_number_b))
        disagreements = [
            n for n in all_numbers
            if _measure_fingerprint(by_number_a.get(n, {})) != _measure_fingerprint(by_number_b.get(n, {}))
        ]
        if not disagreements:
            base_result = read_a
            claude_agreement = {n: True for n in all_numbers}
        else:
            print(f"[read_score_notes_claude] two independent reads disagree on "
                  f"{len(disagreements)}/{len(all_numbers)} measures — running a third read")
            read_c = _read_score_notes_claude_once(pages, prepared_pages, start_measure, instrument, time_sig, anthropic_api_key)
            by_number_c = {m["number"]: m for m in read_c.get("measures", [])} if not read_c.get("error") else {}
            reconciled = []
            claude_agreement = {}
            for n in all_numbers:
                candidates = [by_number_a.get(n), by_number_b.get(n), by_number_c.get(n)]
                candidates = [c for c in candidates if c is not None]
                fingerprints = [_measure_fingerprint(c) for c in candidates]
                counts: dict = {}
                for fp in fingerprints:
                    counts[fp] = counts.get(fp, 0) + 1
                winning_fp = max(counts, key=lambda fp: counts[fp])
                claude_agreement[n] = counts[winning_fp] >= 2
                winner = next(c for c, fp in zip(candidates, fingerprints) if fp == winning_fp)
                reconciled.append(winner)
            reconciled.sort(key=lambda m: m["number"])
            reads = [read_a, read_b, read_c]
            base_result = {
                "key_signature": _majority_vote(r.get("key_signature") for r in reads),
                "time_signature": _majority_vote(r.get("time_signature") for r in reads),
                "tempo_marking": _majority_vote(r.get("tempo_marking") for r in reads),
                "source": "claude_vision",
                "measures": reconciled,
            }
            base_result["tempo_bpm"] = parse_marked_bpm(base_result["tempo_marking"])
            base_result["wedges"] = _compute_dynamic_wedges(reconciled)

    if base_result.get("error") or not base_result.get("measures"):
        return base_result

    resolved_time_sig = base_result.get("time_signature") or time_sig
    measures_by_page: dict = {}
    for m in base_result["measures"]:
        measures_by_page.setdefault(m.get("page", 1), []).append(m)

    final_measures = []
    for page_idx, page_measures in measures_by_page.items():
        prepared_rows = prepared_pages[page_idx - 1]["rows"] if page_idx - 1 < len(prepared_pages) else []
        # This pipeline associates Claude's per-page measures with that
        # page's rows only when there's exactly one row for the page (the
        # common case for reference-audio's own single-system-per-photo
        # inputs) — a page with multiple rows needs its measures further
        # split per row, which read_score_notes_claude's existing prompt-
        # level page/strip tracking does not expose at this granularity.
        # Falling back to "no OMR fusion for this page's measures, keep
        # Claude's cross-validated result as-is" is a safe, explicit
        # degradation, not a silent gap.
        if len(prepared_rows) != 1:
            final_measures.extend(page_measures)
            continue

        row = prepared_rows[0]
        segmentation = row["segmentation"]
        aligned = None
        if segmentation["confidence"] >= 0.6:
            aligned = align_claude_to_measure_crops(page_measures, len(segmentation["measures"]))

        for i, measure in enumerate(page_measures):
            # claude_agreement is populated for every measure number when a
            # third read ran (see above); when reads agreed on the first
            # try, or only one read succeeded, every surviving measure
            # defaults to "agreed" (True) since that's the best signal
            # available in those cases.
            claude_agree_flag = claude_agreement.get(measure["number"], True)
            validation = validate_measure(
                measure, instrument, resolved_time_sig,
                is_first_measure=(measure["number"] == start_measure),
                is_last_measure=(i == len(page_measures) - 1),
            )
            oemer_measure = None
            if aligned is not None and i < len(segmentation["measures"]):
                oemer_result = read_score_notes_oemer(segmentation["measures"][i], resolved_time_sig)
                if not oemer_result.get("error") and oemer_result.get("measures"):
                    oemer_measure = oemer_result["measures"][0]

            fusion = fuse_measure_confidence(claude_agree_flag, measure, oemer_measure, validation)
            if fusion["needs_resolution"] and aligned is not None and i < len(segmentation["measures"]):
                candidates = [measure] + ([oemer_measure] if oemer_measure else [])
                measure = resolve_measure_disagreement(
                    segmentation["measures"][i], candidates, instrument, anthropic_api_key)
                measure["number"] = page_measures[i]["number"]
                measure["page"] = page_measures[i].get("page", 1)

            final_measures.append(measure)

    base_result["measures"] = sorted(final_measures, key=lambda m: m["number"])
    return base_result
```

- [ ] **Step 5: Update existing tests for the changed internal call signature**

`_read_score_notes_claude_once`'s signature changed in Step 3. Find its existing direct tests (search `_read_score_notes_claude_once` across `test_analysis.py`) and update their call sites to pass a `prepared_pages` argument built via `_prepare_score_rows(pages)` before calling, matching the new signature.

- [ ] **Step 6: Run the full test suite**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -15`
Expected: final line `NNN/NNN checks passed`, no `FAILED:` lines. This is the task most likely to reveal integration issues Tasks 1-10's isolated unit tests couldn't catch — budget real debugging time here, don't rush past a red suite.

- [ ] **Step 7: Verify the file compiles and the Modal app still loads**

```bash
python -m py_compile modal_worker/worker.py
modal run modal_worker/worker.py::test_local
```

- [ ] **Step 8: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): wire multi-signal pipeline into read_score_notes_claude"
```

---

### Task 12: Upload-flow quality gate UI

**Files:**
- Create: `supabase/functions/score-quality-check/index.ts`
- Modify: `modal_worker/worker.py` — add a thin Modal endpoint wrapping `compute_row_readability`.
- Modify: `src/components/NewRecordingModal.jsx` (score-picking section, currently around lines 563-595 per this plan's research — verify current line numbers before editing, this file may have changed).

**Interfaces:**
- Produces: `POST score-quality-check {scoreUrl} -> {quality: "good"|"marginal"|"poor", interlinePx: number|null}`, called by the frontend right after a photo is picked, before upload.

- [ ] **Step 1: Add a Modal endpoint**

Add near `generate_reference_audio_async` (search for its exact current location — it has moved during this session's earlier work):

```python
def _check_score_quality(body: dict) -> dict:
    """Downloads one score image and reports its readability. Plain,
    undecorated for the same test-harness-mocking reason every other
    _prefixed function in this file is — see generate_reference_audio_endpoint's
    original docstring for the full explanation."""
    import httpx
    score_url = body.get("score_url")
    if not score_url:
        return {"error": "score_url is required"}
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.get(score_url, follow_redirects=True)
            resp.raise_for_status()
            image_bytes = resp.content
    except Exception as e:
        return {"error": f"could not download image: {e}"}

    rows = split_page_into_rows(image_bytes)
    if not rows:
        return {"quality": "poor", "interline_px": None}
    # Use the row with the best reading — a page usually has several
    # systems, and one blurry corner shouldn't fail the whole photo if
    # most of it is legible.
    results = [compute_row_readability(r) for r in rows]
    best = max(results, key=lambda r: r["interline_px"] or 0)
    return {"quality": best["quality"], "interline_px": best["interline_px"]}


@app.function(image=image, timeout=30)
@modal.fastapi_endpoint(method="POST", docs=True)
def check_score_quality(body: dict) -> dict:
    """Fast, synchronous quality check for the upload-flow UI. No vision
    model call — pure image processing, sized to run well within a
    normal HTTP request/response cycle."""
    return _check_score_quality(body)
```

- [ ] **Step 2: Deploy the worker and capture the new endpoint URL**

```bash
modal deploy modal_worker/worker.py
```

Capture `check_score_quality`'s URL from the deploy output.

- [ ] **Step 3: Add the Supabase secret**

```bash
supabase secrets set MODAL_SCORE_QUALITY_URL=<captured URL>
```

- [ ] **Step 4: Create the edge function**

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, requireAuth } from '../_shared/cors.ts'

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const auth = await requireAuth(req)
  if (auth instanceof Response) return auth

  const jsonHeaders = { 'Content-Type': 'application/json', ...CORS }

  try {
    const { scorePath } = await req.json()
    if (!scorePath || typeof scorePath !== 'string') {
      return new Response(JSON.stringify({ error: 'scorePath is required' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data: signed, error: signErr } = await admin.storage
      .from('sheet-music')
      .createSignedUrl(scorePath, 300)
    if (signErr || !signed?.signedUrl) {
      return new Response(JSON.stringify({ error: 'Could not access the uploaded photo' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    const modalUrl = Deno.env.get('MODAL_SCORE_QUALITY_URL')
    if (!modalUrl) {
      return new Response(JSON.stringify({ error: 'Score quality check is not configured' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    const modalRes = await fetch(modalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score_url: signed.signedUrl }),
      signal: AbortSignal.timeout(20000),
    }).catch(() => null)

    if (!modalRes || !modalRes.ok) {
      // A quality check that fails to run should never block the upload
      // flow — fail open, not closed.
      return new Response(JSON.stringify({ quality: 'unknown', interlinePx: null }), {
        headers: jsonHeaders,
      })
    }

    const result = await modalRes.json()
    return new Response(JSON.stringify({
      quality: result.quality ?? 'unknown',
      interlinePx: result.interline_px ?? null,
    }), { headers: jsonHeaders })

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
```

- [ ] **Step 5: Verify it type-checks**

Run: `cd supabase/functions/score-quality-check && npx --yes deno check index.ts`
Expected: clean.

- [ ] **Step 6: Deploy the edge function, add it to CI**

```bash
supabase functions deploy score-quality-check
```

Add a `Deploy score-quality-check` step to `.github/workflows/deploy-edge-functions.yml`, matching the exact pattern every other step in that file already uses (this project has been bitten twice tonight by a new edge function missing from this CI file — do not repeat it a third time).

- [ ] **Step 7: Wire the frontend**

Modify `src/components/NewRecordingModal.jsx`'s score-picking section. Locate the current `pickScore` function and the score file list rendering (search for `scoreFiles` state and the surrounding JSX — verify current structure before editing, this plan's earlier research is not a substitute for reading the live file). Add:

1. A thumbnail preview for each picked score file (an `<img>` using `URL.createObjectURL(file)`, revoked on removal/unmount to avoid a memory leak).
2. After a file is picked, call the new `score-quality-check` edge function (upload the file to a temp path first, or — simpler, avoiding a throwaway storage write — extract the image dimensions/bytes client-side and skip the round trip for now if time is short on Day 3; calling the real backend check is the correct behavior but the plan's controller should make a pragmatic call here if Day 3 is running short, given quality-gate UI is explicitly a smaller priority than the recognition pipeline itself per the spec).
3. Replace the existing generic hint line ("A clear photo lets Mediant pin issues to specific measures on your score.") with specific guidance, and show a non-blocking warning banner when quality comes back `"poor"`: "This photo may be too low-resolution to read accurately. Try retaking it flatter, with better lighting, or using your phone's scan mode."

- [ ] **Step 8: Manual browser verification**

Run `npm run dev`, open the New Recording modal, pick a low-quality photo (or the same real problem photo from tonight's investigation) and confirm the warning appears; pick a clean, high-quality photo and confirm no warning appears.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/score-quality-check modal_worker/worker.py src/components/NewRecordingModal.jsx .github/workflows/deploy-edge-functions.yml
git commit -m "feat(ui): add interline-based photo quality gate to score upload"
```

---

### Task 13: Ground-truth live test

**Files:** none (verification task).

- [ ] **Step 1: Run the full pipeline against the real problem photo**

Using Task 5's ground truth and the same take/photo used throughout tonight's investigation (take `34b08cfd-f533-4fe1-a588-5af04fe5ddc5`'s score, or a fresh take pointed at the same image), trigger reference-audio generation end to end (requires Anthropic credits to be restored — confirm with the user before this step if they haven't already said credits are back).

- [ ] **Step 2: Compute and report the five acceptance metrics from the spec**

Compare the pipeline's output measures against Task 5's ground truth, measure by measure, and report:
- Exact pitch accuracy
- Exact duration accuracy
- Missing/extra-note rate
- Measure-perfect accuracy
- **Confidently-accepted-incorrect-measure count** (measures fusion marked `needs_resolution: False` that are wrong against ground truth) — report this number explicitly and prominently; per the spec, this is the single most important number in the whole test.

- [ ] **Step 3: Judge success against the spec's actual bar**

Per the spec: a nonzero confidently-accepted-incorrect-measure count means the core problem is not solved, regardless of how good the other four metrics look. If this number is nonzero, do not report the pipeline as working — report the specific measures involved and treat it as a bug to investigate (systematic-debugging), not a metric to round away.

---

### Task 14: Deploy

**Files:** none (deployment task).

- [ ] **Step 1: Confirm the migration/secret/deploy ordering**

No new database migration in this plan. Confirm `MODAL_SCORE_QUALITY_URL` (Task 12) is set before the edge function that reads it is deployed (already sequenced correctly in Task 12's own steps — this step is a final cross-check, not new work).

- [ ] **Step 2: Redeploy the worker with the full pipeline**

```bash
modal deploy modal_worker/worker.py
```

- [ ] **Step 3: Final end-to-end smoke test**

Repeat Task 13's live test once more against the fully deployed (not dev/ephemeral) stack, to confirm nothing differs between the `modal run` dev environment used for testing and the real deployed app.

- [ ] **Step 4: Update the project's own tracking docs**

Per this project's CLAUDE.md conventions: update `agent_workspace/CHANGELOG.md` and `agent_workspace/AGENT_TASKS.md` with this feature's outcome, and write a session/fix note to the Obsidian vault if a genuinely non-obvious decision or bug surfaced during implementation (matching this project's established documentation habits from earlier tonight).
