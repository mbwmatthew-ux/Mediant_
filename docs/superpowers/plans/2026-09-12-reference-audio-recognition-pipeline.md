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
- **Create `supabase/functions/score-quality-check/index.ts`** — new, thin edge function exposing the Day-1 quality gate to the frontend (Task 13).
- **Modify `src/components/NewRecordingModal.jsx`** — upload-flow quality gate UI (Task 13).

---

### Task 1: `compute_row_readability` — real interline measurement

**Files:**
- Modify: `modal_worker/worker.py` — add after `_otsu_threshold` (currently ends at line 3156, immediately before `def split_page_into_rows` at line 3159).
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `_otsu_threshold(values) -> float` (existing, `modal_worker/worker.py:3121`).
- Produces: `compute_row_readability(row_bytes: bytes) -> dict` returning `{"interline_px": float | None, "sharpness": float | None, "quality": "good" | "marginal" | "poor", "reasons": list[str]}`. Consumed by Task 2 (dewarp decision), Task 11 (orchestration), and Task 13 (frontend quality gate, via a new endpoint).

**Two independent signals, not one.** Interline spacing alone is insufficient: a high-resolution but badly out-of-focus photo can have perfectly detectable staff lines at a healthy 24px interline while every notehead, stem, flag, and accidental has smeared into mush. Resolution and sharpness fail independently, so both are measured, and the worse of the two verdicts wins.

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after `test_split_page_into_rows_falls_back_on_undecodable_bytes` (search for that exact function name):

```python
def _make_synthetic_row(interline_px=20, width=800, height=140, blur=0):
    """A single-system row crop with 5 staff lines at a known, controllable
    interline spacing, PLUS notehead blobs (real notation has symbols, not
    just lines — and the sharpness metric needs edges to measure). `blur`
    is a Gaussian radius in pixels; > 0 simulates an out-of-focus photo,
    for testing the sharpness path independently of resolution."""
    from PIL import Image, ImageDraw, ImageFilter
    import random
    import io
    img = Image.new("L", (width, height), color=250)
    draw = ImageDraw.Draw(img)
    top = height // 2 - int(interline_px * 2)
    staff_h = interline_px * 4
    for line_i in range(5):
        y = top + line_i * interline_px
        draw.line([(20, y), (width - 20, y)], fill=0, width=2)
    rng = random.Random(11)
    blob_r = max(2, interline_px // 2)
    for x in range(40, width - 40, max(8, interline_px)):
        blob_y = top + rng.randint(0, max(1, staff_h))
        draw.ellipse([x, blob_y, x + blob_r, blob_y + blob_r], fill=0)
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(radius=blur))
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


def test_compute_row_readability_flags_a_blurry_but_high_resolution_row():
    print("\n[78] readability check flags a BLURRY row as poor even when its interline spacing is generous")
    sharp = _make_synthetic_row(interline_px=24, blur=0)
    blurry = _make_synthetic_row(interline_px=24, blur=4)
    r_sharp = w.compute_row_readability(sharp)
    r_blurry = w.compute_row_readability(blurry)
    check("the sharp version is good", r_sharp["quality"] == "good", str(r_sharp))
    check("the blurry version measures a LOWER sharpness than the sharp one",
          (r_blurry["sharpness"] or 0) < (r_sharp["sharpness"] or 0),
          f"sharp={r_sharp['sharpness']} blurry={r_blurry['sharpness']}")
    check("the blurry version is NOT rated good, despite a healthy 24px interline "
          "(resolution and focus fail independently)",
          r_blurry["quality"] != "good", str(r_blurry))


def test_compute_row_readability_handles_undecodable_bytes():
    print("\n[79] readability check degrades to poor/unknown on bytes it can't decode, does not raise")
    result = w.compute_row_readability(b"\x89PNG-not-a-real-image")
    check("returns poor quality with no interline reading, does not raise",
          result["quality"] == "poor" and result["interline_px"] is None, str(result))
```

Register all five in `main()`'s test tuple, directly after `test_split_page_into_rows_falls_back_on_undecodable_bytes,` (search for that exact line):

```python
              test_split_page_into_rows_falls_back_on_undecodable_bytes,
              test_compute_row_readability_measures_known_interline,
              test_compute_row_readability_flags_low_interline_as_poor,
              test_compute_row_readability_marginal_band,
              test_compute_row_readability_flags_a_blurry_but_high_resolution_row,
              test_compute_row_readability_handles_undecodable_bytes,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[75\]\|\[76\]\|\[77\]\|\[78\]\|\[79\]"`
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

# Sharpness is the mean absolute horizontal gradient across the staff
# band, normalized to 0-255. A crisply printed staff has hard black/white
# transitions at every line, notehead and stem edge; an out-of-focus photo
# smears those into gradients an order of magnitude softer. These
# thresholds are deliberately loose — this metric exists to catch
# obviously-unusable mush, not to grade photography.
_SHARPNESS_POOR_MAX = 6.0
_SHARPNESS_GOOD_MIN = 14.0


def compute_row_readability(row_bytes: bytes) -> dict:
    """
    Measures TWO independent quality signals for one row crop and returns
    the worse of their verdicts:

      * interline_px — the ACTUAL staff-line spacing, not a proxy like raw
        pixel dimensions.
      * sharpness — mean absolute horizontal gradient over the staff band,
        i.e. how hard the ink/paper edges are.

    Both are needed because they fail INDEPENDENTLY: a photo can be
    high-resolution (generous interline) yet so out of focus that every
    notehead, stem and accidental has smeared together, or perfectly
    sharp yet shot from so far away that nothing is resolvable. Measuring
    only one lets the other through.

    Exists because Audiveris's real, confirmed failure on the actual
    problem photo tonight was driven by interline spacing specifically
    (measured 8px against Audiveris's own stated ~20px target), not a
    generic "low resolution" guess. Reuses the row-wise contrast/Otsu
    technique split_page_into_rows already established, applied at finer
    grain to find the 5 individual staff lines within ONE system crop
    rather than the gaps BETWEEN systems.

    Returns {"interline_px": float|None, "sharpness": float|None,
    "quality": "good"|"marginal"|"poor", "reasons": [...]}. Never raises —
    undecodable bytes or a crop where fewer than 2 staff lines can be
    confidently found come back as "poor" with interline_px=None, same
    no-op-on-failure convention as split_page_into_rows.
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
            return {"interline_px": None, "sharpness": None, "quality": "poor",
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
            return {"interline_px": None, "sharpness": None, "quality": "poor",
                    "reasons": ["fewer than 2 distinct staff lines after merging"]}

        spacings = [b - a for a, b in zip(line_centers, line_centers[1:])]
        interline_px = float(np.median(spacings))

        # Sharpness, measured over the STAFF BAND only — the blank padding
        # above/below a row crop has no edges by definition, and including
        # it would dilute the measurement by however much padding the crop
        # happens to carry.
        staff_top = int(max(0, line_centers[0] - interline_px))
        staff_bottom = int(min(h, line_centers[-1] + interline_px))
        band = arr[staff_top:staff_bottom, :]
        sharpness = float(np.mean(np.abs(np.diff(band, axis=1)))) if band.size else 0.0

        reasons = []
        verdicts = []

        if interline_px <= _INTERLINE_POOR_MAX:
            verdicts.append("poor")
            reasons.append(f"interline {interline_px:.1f}px at or below the "
                            f"{_INTERLINE_POOR_MAX}px poor threshold")
        elif interline_px >= _INTERLINE_GOOD_MIN:
            verdicts.append("good")
        else:
            verdicts.append("marginal")
            reasons.append(f"interline {interline_px:.1f}px is between "
                            f"{_INTERLINE_POOR_MAX} and {_INTERLINE_GOOD_MIN}")

        if sharpness <= _SHARPNESS_POOR_MAX:
            verdicts.append("poor")
            reasons.append(f"sharpness {sharpness:.1f} at or below the "
                            f"{_SHARPNESS_POOR_MAX} poor threshold (photo looks out of focus)")
        elif sharpness >= _SHARPNESS_GOOD_MIN:
            verdicts.append("good")
        else:
            verdicts.append("marginal")
            reasons.append(f"sharpness {sharpness:.1f} is between "
                            f"{_SHARPNESS_POOR_MAX} and {_SHARPNESS_GOOD_MIN}")

        # The WORSE of the two verdicts wins — a row is only as readable as
        # its weakest independent signal.
        quality = ("poor" if "poor" in verdicts
                   else "marginal" if "marginal" in verdicts
                   else "good")

        return {"interline_px": interline_px, "sharpness": sharpness,
                "quality": quality, "reasons": reasons}
    except Exception as e:
        return {"interline_px": None, "sharpness": None, "quality": "poor",
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


def _measure_staff_curvature(row_bytes):
    """Measures how far a row's topmost staff line deviates from straight,
    in pixels — the actual quantity dewarp_row exists to reduce. Returns
    the peak absolute deviation of the detected top-line y-position across
    horizontal strips. A perfectly flat staff returns ~0.

    This is the test's OWN independent measurement, deliberately not
    reusing dewarp_row's internals — a test that measures success using
    the same code path it's testing proves nothing."""
    from PIL import Image
    import numpy as np
    import io
    img = Image.open(io.BytesIO(row_bytes)).convert("L")
    arr = np.array(img).astype(np.float64)
    h, wd = arr.shape
    is_ink = arr < 128
    tops = []
    n_strips = 10
    strip_w = max(1, wd // n_strips)
    for i in range(n_strips):
        x0, x1 = i * strip_w, min(wd, (i + 1) * strip_w)
        strip = is_ink[:, x0:x1]
        rows_with_ink = np.where(strip.sum(axis=1) > (x1 - x0) * 0.5)[0]
        if len(rows_with_ink):
            tops.append(float(rows_with_ink[0]))
    if len(tops) < 3:
        return None
    return float(np.max(np.abs(np.array(tops) - np.median(tops))))


def test_dewarp_row_straightens_a_curved_staff():
    print("\n[80] dewarp_row measurably REDUCES staff curvature on a known-curved row")
    curved = _make_curved_row(amplitude=12)
    dewarped = w.dewarp_row(curved)

    before = _measure_staff_curvature(curved)
    after = _measure_staff_curvature(dewarped)

    check("the synthetic input really is curved to begin with (fixture sanity check)",
          before is not None and before >= 5, f"before={before}")
    check("curvature is measurably reduced after dewarping — this is the actual "
          "property dewarp_row exists to deliver, not merely 'output decodes'",
          after is not None and after < before * 0.6,
          f"before={before} after={after}")


def test_dewarp_row_is_a_noop_on_an_already_flat_row():
    print("\n[81] dewarp_row leaves an already-flat row unchanged (no-op, not a harmful correction)")
    flat = _make_synthetic_row(interline_px=20, width=800, height=160)
    dewarped = w.dewarp_row(flat)
    check("returns the input bytes unchanged (the curvature is below the "
          "correction threshold, so no resampling happens at all)",
          dewarped == flat, f"{len(dewarped)} bytes vs {len(flat)}")


def test_dewarp_row_falls_back_on_undecodable_bytes():
    print("\n[82] dewarp_row degrades to a no-op on bytes it can't decode, does not raise")
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

    Algorithm: binarize, then in each vertical strip find the STAFF LINES
    specifically — pixel-rows where ink spans most of that strip's width —
    and take their centroid. Fit a quadratic to those per-strip staff
    centers, then shift each column vertically by the fitted curve's
    deviation from the center column.

    Tracking staff lines rather than ALL ink is load-bearing: noteheads,
    stems, beams, slurs, dynamics, and rehearsal marks are distributed
    asymmetrically above and below the staff, so an all-ink centroid
    wanders with the music's tessitura rather than with the page's
    geometry — a passage sitting high on the staff would read as
    "curvature" that isn't there, and dewarping would then actively
    introduce distortion into a perfectly flat row. Staff lines are the
    only feature in a system that is supposed to be straight and
    horizontal, which is exactly what makes them the right reference.

    No-ops (returns input unchanged) if the fit's curvature is negligible
    (row is already flat), if the image can't be decoded, or if too few
    strips produce a usable staff reading.
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
            strip_width = max(1, x1 - x0)
            # Staff-line rows only: ink spanning most of this strip's
            # width. A notehead or stem covers a few columns; a staff line
            # covers essentially all of them.
            line_rows = np.where(strip.sum(axis=1) / strip_width > 0.7)[0]
            if len(line_rows) < 2:
                continue  # no reliable staff reading in this strip
            ys.append(float(np.mean(line_rows)))
            xs.append((x0 + x1) / 2)

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
    print("\n[83] measure splitter finds the expected number of measures in a synthetic row")
    row_bytes, true_boundaries = _make_row_with_barlines(measure_count=4)
    result = w.split_row_into_measures(row_bytes)
    check("finds 4 measures", len(result["measures"]) == 4, str(len(result["measures"])))
    check("confidence is reasonably high for a clean synthetic row",
          result["confidence"] >= 0.6, str(result["confidence"]))


def test_split_row_into_measures_low_confidence_on_ambiguous_input():
    print("\n[84] measure splitter reports low confidence rather than false certainty on a stem-only row (no real barlines)")
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
    print("\n[85] measure splitter degrades to a single low-confidence unit on bytes it can't decode")
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
            # Zero barline candidates is AMBIGUOUS, not confident: it means
            # either this row genuinely holds one measure, or the detector
            # failed completely on a multi-measure row. Those are
            # indistinguishable from here, and reporting confidence 1.0
            # would let a total detection failure masquerade as certainty —
            # the caller would then trust per-measure crops that don't
            # correspond to real measures. Report no confidence and let the
            # caller fall back to row-level handling, which is correct in
            # BOTH cases.
            return {"measures": [row_bytes], "boundaries": [], "confidence": 0.0}

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
            # Same ambiguity as the zero-candidates case above — every
            # candidate was an edge artifact, so we learned nothing about
            # where measures actually divide.
            return {"measures": [row_bytes], "boundaries": [], "confidence": 0.0}

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
    print("\n[86] validator catches a duration sum that doesn't match the time signature")
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
    print("\n[87] validator does not flag a legitimately partial first/last measure")
    partial = {"number": 1, "notes": [
        {"pitch": "C4", "is_rest": False, "beat": 3.0, "duration_beats": 1.0},
    ]}
    result_first = w.validate_measure(partial, "clarinet", "3/4", is_first_measure=True)
    result_last = w.validate_measure(partial, "clarinet", "3/4", is_last_measure=True)
    check("a partial pickup measure is not flagged for duration", result_first["valid"], str(result_first))
    check("a partial final measure is not flagged for duration", result_last["valid"], str(result_last))


def test_validate_measure_written_pitch_range():
    print("\n[88] validator catches a pitch outside the instrument's WRITTEN range, before any transposition")
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
    print("\n[89] validator catches two simultaneous notes on a monophonic instrument")
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
    print("\n[90] validator allows simultaneous notes for a naturally polyphonic instrument")
    chord = {"number": 5, "notes": [
        {"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
        {"pitch": "E4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
        {"pitch": "G4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0},
    ]}
    result = w.validate_measure(chord, "piano", "3/4")
    check("a three-note chord on piano is not flagged as invalid polyphony",
          result["valid"], str(result))


def test_validate_measure_unknown_instrument_skips_range_check_gracefully():
    print("\n[91] validator does not penalize an instrument with no tabulated range data")
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

    is_first_measure / is_last_measure exempt a measure from the
    duration-sum check, because a pickup (anacrusis) and a final measure
    are both legitimately partial. These mean first/last **of the whole
    piece**, NOT of a page or system — every system's last measure is an
    ordinary interior measure of the piece and must still be validated.
    Callers computing these from a per-page or per-row slice would
    silently exempt most of the score.

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
    is_polyphonic_instrument = bool(_instrument_lookup(POLYPHONIC_INSTRUMENTS, instrument))

    # Duration-sum validation is MONOPHONIC-ONLY. Summing every note's
    # duration assumes the notes are sequential; on a polyphonic
    # instrument they may be simultaneous, so a single perfectly valid
    # 3-beat triad in 3/4 sums to 9 beats and would be flagged as
    # "impossible" by a naive sum. Proper polyphonic checking needs
    # voice-aware accounting (per-voice duration totals, or temporal
    # coverage of the measure) — real work, deliberately out of scope for
    # this iteration's budget. Skipping the check for polyphonic
    # instruments is the honest option: it forfeits a signal rather than
    # emitting a false one, and forfeiting a signal is safe here because
    # `valid` is never treated as evidence of correctness anyway (see this
    # function's asymmetry note above).
    if not is_first_measure and not is_last_measure and not is_polyphonic_instrument:
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

**This task is different from every other task in this plan.** It does not produce code. It produces a data file — a verified-correct, measure-by-measure transcription of the real problem photo used throughout this investigation — that Task 14's live test depends on. It cannot be completed by a coding subagent guessing at the right answer; an attempt at exactly that (reading the photo directly, by eye) was already tried while writing the spec and abandoned as unreliable (see the spec's Testing section).

**Files:**
- Create: `modal_worker/testdata/procession_of_the_nobles_ground_truth.json`

**Interfaces:**
- Produces: a JSON file, one entry per measure, in the same shape `read_score_notes_claude` returns measures (`{"number": int, "notes": [{"pitch", "is_rest", "beat", "duration_beats"}, ...]}`), covering at minimum measures 12 through 30 of the real problem photo (the range already exercised throughout tonight's investigation). Consumed directly by Task 14 (the live ground-truth test) — nothing else in this plan reads this file.

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

Using the same real problem photo used throughout tonight's investigation (already in this plan's controller's context — the exact score page from take `34b08cfd-f533-4fe1-a588-5af04fe5ddc5`), run `split_page_into_rows` → `dewarp_row` on at least 2 rows covering measures 12-19, then run `oemer` on each dewarped ROW. **Rows only — never individual measure crops.** The final architecture (Task 11) calls oemer per row precisely because a mid-system measure crop carries no clef, key, or time signature, and testing it on a granularity the product will never use would measure the wrong thing — most likely producing a falsely pessimistic NO-GO from wrong-clef guesses that the real pipeline would never provoke.

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
- Produces: `read_score_notes_oemer(crop_bytes: bytes, time_sig: str) -> dict` returning the same `ScoreResult` shape every other reader returns, with `duration_beats` ALREADY converted to notated-beat units. Consumed by Task 11 (orchestration), which calls it **once per system ROW** — never on an isolated measure crop, since a mid-system measure crop carries no clef/key/time signature and would force the OMR engine to guess them (the documented Audiveris wrong-clef failure mode).

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after Task 4's last test:

```python
def test_read_score_notes_oemer_parses_subprocess_output():
    print("\n[92] oemer reader shells out and parses the resulting MusicXML, converting duration units")
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
    print("\n[93] oemer reader returns an error shape (not a raise) when the subprocess fails")
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
    image crop and parses the resulting MusicXML with the already-existing
    parse_score_document. Mirrors convert_visual_score_to_musicxml's
    (Audiveris) structure closely; oemer's CLI shape is `oemer <img> -o <dir>`,
    producing a `.musicxml` file discoverable the same way.

    **Callers must pass a full SYSTEM ROW, not an isolated measure crop.**
    A measure crop taken from the middle of a system contains no clef, no
    key signature, and no time signature, so an OMR engine reading it has
    to guess them — and a wrong-clef guess makes every pitch in that
    measure wrong. That is exactly how Audiveris failed on this project's
    real photo, so feeding an OMR engine clef-less crops would rebuild a
    known failure on purpose. Printed notation restates the clef and key
    at the start of every system, so a row crop always carries the context
    a measure crop lacks. (The function itself does not enforce this —
    it cannot tell what it was handed — which is why it is stated here.)

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
    print("\n[94] alignment succeeds when Claude's measure count matches the crop count")
    claude_measures = [{"number": 12, "notes": []}, {"number": 13, "notes": []}, {"number": 14, "notes": []}]
    result = w.align_claude_to_measure_crops(claude_measures, crop_count=3)
    check("returns the measures unchanged, in order", result == claude_measures, str(result))


def test_align_claude_to_measure_crops_refuses_on_count_mismatch():
    print("\n[95] alignment refuses (returns None) rather than guess when counts disagree")
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
- Produces: `fuse_measure_confidence(claude_agreement: str, claude_measure: dict, oemer_measure: dict | None, validation: dict) -> dict` returning `{"confidence": "high" | "medium" | "low", "needs_resolution": bool, "reasons": list[str]}`. `claude_agreement` is one of `"agree"` / `"disagree"` / `"unavailable"` — **three states, deliberately not a boolean** (see the function's own docstring: collapsing `"unavailable"` into `"agree"` would grant a single uncorroborated read the same confidence as two matching independent reads). Consumed by Task 11 (orchestration).

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after Task 8's last test:

```python
def test_fuse_measure_confidence_verdict_table():
    print("\n[96] confidence fusion follows the spec's verdict table exactly, one case per row")
    claude_m = {"number": 12, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]}
    oemer_match = {"number": 12, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]}
    oemer_mismatch = {"number": 12, "notes": [{"pitch": "D4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]}
    valid = {"valid": True, "issues": []}
    invalid = {"valid": False, "issues": ["duration sum wrong"]}

    r1 = w.fuse_measure_confidence("agree", claude_m, oemer_match, invalid)
    check("invalid validator verdict ALWAYS needs resolution, even with Claude+OMR agreement",
          r1["needs_resolution"], str(r1))

    r2 = w.fuse_measure_confidence("agree", claude_m, oemer_match, valid)
    check("Claude agree + OMR match + valid = high confidence, no resolution needed",
          r2["confidence"] == "high" and not r2["needs_resolution"], str(r2))

    r3 = w.fuse_measure_confidence("agree", claude_m, None, valid)
    check("Claude agree + OMR unavailable + valid = accept, medium, no resolution",
          r3["confidence"] == "medium" and not r3["needs_resolution"], str(r3))

    r4 = w.fuse_measure_confidence("agree", claude_m, oemer_mismatch, valid)
    check("Claude agree + OMR MISMATCH needs resolution even though Claude agrees with itself "
          "(this is the 'consistent wrong answer' case cross-validation alone cannot catch)",
          r4["needs_resolution"], str(r4))

    r5 = w.fuse_measure_confidence("disagree", claude_m, oemer_match, valid)
    check("Claude disagreement (with itself) always needs resolution regardless of OMR",
          r5["needs_resolution"], str(r5))

    r6 = w.fuse_measure_confidence("unavailable", claude_m, None, valid)
    check("a SINGLE Claude read with no OMR corroboration is NOT accepted — one observation "
          "is not agreement, and must not inherit two-matching-reads confidence",
          r6["needs_resolution"], str(r6))

    r7 = w.fuse_measure_confidence("unavailable", claude_m, oemer_match, valid)
    check("a single Claude read DOES become acceptable when an independent OMR read matches it "
          "(two genuinely independent sources agreeing is real corroboration)",
          not r7["needs_resolution"] and r7["confidence"] == "medium", str(r7))

    r8 = w.fuse_measure_confidence("unavailable", claude_m, oemer_mismatch, valid)
    check("a single Claude read contradicted by OMR needs resolution",
          r8["needs_resolution"], str(r8))
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
def fuse_measure_confidence(claude_agreement: str, claude_measure: dict,
                             oemer_measure: dict | None, validation: dict) -> dict:
    """
    Combines three signals into one fusion outcome for a single measure.

    claude_agreement is a THREE-state value, not a boolean:
      * "agree"       — 2+ independent Claude reads produced identical content
      * "disagree"    — independent Claude reads contradicted each other
      * "unavailable" — only ONE Claude read succeeded, so there was no
                        cross-validation at all

    The three-state distinction is load-bearing. A boolean collapses
    "unavailable" into "agree", which would silently grant a lone,
    uncorroborated observation the same confidence as two independent
    reads that matched. One observation is not agreement — it is an
    absence of evidence either way, and it only becomes acceptable when
    some OTHER independent source (OMR) corroborates it.

    [Revision 2 from the spec] validate_measure's `invalid` is checked
    FIRST and always wins — a measure that fails deterministic checks is
    never rescued by Claude/OMR agreement. Its `valid` verdict is never,
    on its own, sufficient for confidence; every acceptance path below
    also requires positive corroboration from at least two independent
    observations.
    """
    if not validation.get("valid", True):
        return {"confidence": "low", "needs_resolution": True,
                "reasons": ["validator invalid: " + "; ".join(validation.get("issues", []))]}

    if claude_agreement == "disagree":
        return {"confidence": "low", "needs_resolution": True,
                "reasons": ["Claude's own independent reads disagreed on this measure"]}

    if claude_agreement == "unavailable":
        if oemer_measure is None:
            return {"confidence": "low", "needs_resolution": True,
                    "reasons": ["only one Claude read succeeded and no OMR reading is "
                                "available — the measure has exactly one uncorroborated "
                                "observation behind it"]}
        if _measure_fingerprint(claude_measure) == _measure_fingerprint(oemer_measure):
            return {"confidence": "medium", "needs_resolution": False,
                    "reasons": ["one Claude read, independently corroborated by OMR"]}
        return {"confidence": "low", "needs_resolution": True,
                "reasons": ["one Claude read, contradicted by OMR"]}

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
- Consumes: `validate_measure(...)` (Task 4) — used to RE-validate the resolved result.
- Produces: `resolve_measure_disagreement(measure_crop_bytes: bytes, candidates: list[dict], instrument: str, time_sig: str, anthropic_api_key: str, is_first_measure: bool = False, is_last_measure: bool = False) -> dict` returning a single measure dict in the same normalized shape (`{"notes": [...]}`), plus `"unresolved": True` and `"issues": [...]` when resolution failed or its result still fails validation. Consumed by Task 11 (orchestration).

- [ ] **Step 1: Write the failing test**

Add to `modal_worker/test_analysis.py`, after Task 9's last test:

```python
def test_resolve_measure_disagreement_sends_crop_and_candidates():
    print("\n[97] targeted disagreement resolution sends the measure crop and candidate list, not an open re-read")
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
        result = w.resolve_measure_disagreement(b"\x89PNG-fake-crop", candidates, "clarinet", "3/4", "k")
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
    check("a resolution that passes revalidation is NOT marked unresolved",
          not result.get("unresolved"), str(result))


def test_resolve_measure_disagreement_marks_unresolved_on_failure():
    print("\n[98] resolution marks a measure unresolved rather than silently returning candidate 1 when the call fails")
    candidates = [
        {"notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]},
    ]

    class _ExplodingClient:
        def __init__(self, **kw):
            raise RuntimeError("simulated API failure")

    import anthropic as _ac
    _orig = _ac.Anthropic
    _ac.Anthropic = _ExplodingClient
    try:
        result = w.resolve_measure_disagreement(b"\x89PNG-fake-crop", candidates, "clarinet", "3/4", "k")
    finally:
        _ac.Anthropic = _orig

    check("the measure is explicitly flagged unresolved, NOT returned as if it were fine "
          "(failing open here is what produces confident-wrong audio)",
          result.get("unresolved") is True, str(result))
    check("the reason is carried with it", result.get("issues"), str(result))


def test_resolve_measure_disagreement_marks_unresolved_when_result_still_invalid():
    print("\n[99] resolution marks a measure unresolved when the resolved answer STILL fails validation")
    import types, json as _json

    class _FakeStream:
        def __init__(self, payload): self._payload = payload
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self):
            return types.SimpleNamespace(
                content=[types.SimpleNamespace(text=self._payload)], stop_reason="end_turn")

    class _FakeMessages:
        def stream(self, **kw):
            # Transcribes a measure that is still impossible in 3/4 (5 beats).
            return _FakeStream(_json.dumps({
                "matched_candidate": None,
                "notes": [{"p": "C4", "b": 1.0, "d": 5.0}],
            }))

    class _FakeAnthropicClient:
        def __init__(self, **kw): self.messages = _FakeMessages()

    candidates = [{"notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]}]

    import anthropic as _ac
    _orig = _ac.Anthropic
    _ac.Anthropic = _FakeAnthropicClient
    try:
        result = w.resolve_measure_disagreement(b"\x89PNG-fake-crop", candidates, "clarinet", "3/4", "k")
    finally:
        _ac.Anthropic = _orig

    check("a still-invalid resolution is flagged unresolved rather than accepted",
          result.get("unresolved") is True, str(result))


def test_resolve_measure_disagreement_accepts_a_legitimate_pickup_measure():
    print("\n[100] resolution does NOT mark a legitimately partial pickup measure unresolved")
    import types, json as _json

    class _FakeStream:
        def __init__(self, payload): self._payload = payload
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self):
            return types.SimpleNamespace(
                content=[types.SimpleNamespace(text=self._payload)], stop_reason="end_turn")

    class _FakeMessages:
        def stream(self, **kw):
            # A correct one-beat pickup in 4/4 — partial BY DESIGN.
            return _FakeStream(_json.dumps({
                "matched_candidate": None,
                "notes": [{"p": "G4", "b": 4.0, "d": 1.0}],
            }))

    class _FakeAnthropicClient:
        def __init__(self, **kw): self.messages = _FakeMessages()

    candidates = [{"notes": [{"pitch": "G4", "is_rest": False, "beat": 4.0, "duration_beats": 1.0}]}]

    import anthropic as _ac
    _orig = _ac.Anthropic
    _ac.Anthropic = _FakeAnthropicClient
    try:
        result = w.resolve_measure_disagreement(
            b"\x89PNG-fake-crop", candidates, "clarinet", "4/4", "k",
            is_first_measure=True)
    finally:
        _ac.Anthropic = _orig

    check("a 1-beat pickup in 4/4 resolved correctly is NOT failed by revalidation "
          "(forgetting to thread is_first_measure through would fail every pickup bar)",
          not result.get("unresolved"), str(result))
```

Register in `main()`'s tuple:

```python
              test_fuse_measure_confidence_verdict_table,
              test_resolve_measure_disagreement_sends_crop_and_candidates,
              test_resolve_measure_disagreement_marks_unresolved_on_failure,
              test_resolve_measure_disagreement_marks_unresolved_when_result_still_invalid,
              test_resolve_measure_disagreement_accepts_a_legitimate_pickup_measure,
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[96\]"`
Expected: `AttributeError: module 'worker' has no attribute 'resolve_measure_disagreement'`.

- [ ] **Step 3: Implement**

```python
def resolve_measure_disagreement(measure_crop_bytes: bytes, candidates: list[dict],
                                  instrument: str, time_sig: str,
                                  anthropic_api_key: str,
                                  is_first_measure: bool = False,
                                  is_last_measure: bool = False) -> dict:
    """
    Closed-ended disagreement resolution for ONE low-confidence measure.
    [Revision 2 from the spec]: replaces the old approach of "just read
    it again" (open-ended, on the whole row/page) with a strictly easier
    task — a tight crop of just this one measure, plus the specific
    candidates already produced, asking the model to pick a match or
    transcribe only this small crop if none match. Structurally harder
    for the model to keep generating a plausible-but-wrong pattern, since
    there's no multi-measure context left to pattern-match against.

    NEVER FAILS OPEN. Every measure reaching this function is here
    because something was already wrong with it — the validator called it
    impossible, or two independent recognizers disagreed. Silently
    returning the first candidate on an API/parse failure would hand back
    exactly the kind of unverified answer that produces confident-wrong
    audio, which is the single failure mode this whole pipeline exists to
    eliminate. So: the resolved result is RE-VALIDATED, and if it still
    doesn't hold up (or the call failed outright), the measure is
    returned marked `"unresolved": True` with its issues attached. The
    caller decides what to do with an unresolved measure; what it must
    NOT do is treat it as confidently correct.

    is_first_measure / is_last_measure MUST be threaded through from the
    caller to the revalidation below. A legitimate one-beat pickup in 4/4
    is exempt from the duration-sum check in the main validation pass; if
    revalidation here forgets that exemption, it re-measures the pickup
    against a full 4 beats, fails it, and marks a CORRECTLY resolved
    measure unresolved — turning the pickup bar of every disputed piece
    into a permanent false alarm.

    Returns a measure dict {"notes": [...]} plus, when resolution
    failed, "unresolved": True and "issues": [...]. Never raises.
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

        resolved = None
        matched = parsed.get("matched_candidate")
        if isinstance(matched, int) and 1 <= matched <= len(candidates):
            resolved = candidates[matched - 1]
        else:
            notes = parsed.get("notes")
            if isinstance(notes, list) and notes:
                def _norm_note(n: dict) -> dict:
                    return {
                        "pitch": n.get("pitch") or n.get("p"),
                        "is_rest": bool(n.get("is_rest") or n.get("r") or False),
                        "beat": n.get("beat") if n.get("beat") is not None else n.get("b"),
                        "duration_beats": n.get("duration_beats") if n.get("duration_beats") is not None else n.get("d"),
                    }
                resolved = {"notes": [_norm_note(n) for n in notes]}

        if resolved is None:
            return {**candidates[0], "unresolved": True,
                    "issues": ["resolution produced neither a candidate match nor a transcription"]}

        # Re-validate: a resolution that still fails deterministic checks
        # has not actually resolved anything, and must not be handed back
        # as if it had. The first/last flags are threaded through so a
        # legitimately partial pickup or final bar isn't failed here for
        # the very property that makes it correct.
        recheck = validate_measure(resolved, instrument, time_sig,
                                    is_first_measure=is_first_measure,
                                    is_last_measure=is_last_measure)
        if not recheck["valid"]:
            return {**resolved, "unresolved": True, "issues": recheck["issues"]}
        return resolved
    except Exception as e:
        print(f"[resolve_measure_disagreement] failed: {e}")
        return {**candidates[0], "unresolved": True,
                "issues": [f"resolution call failed: {e}"]}
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
                # user-facing warning is a SEPARATE, earlier check (Task 13's
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

- [ ] **Step 3b: Have the prompt return a per-measure ROW index — the key to multi-row fusion**

**Why this step exists (do not skip it):** every measure needs to be traceable back to the specific row crop it came from. Without that, a page of N systems gives no way to know which of the N prepared rows a given measure belongs to, and the entire OMR/segmentation half of this pipeline can only run on single-row pages — which the real target input is not (the actual problem photo splits into **12** rows). The existing prompt already asks for `"pg"`; this adds the same idea one level finer.

In `_read_score_notes_claude_once`'s prompt, find the `MULTIPLE PAGES:` paragraph (it currently ends with: `For every measure, also return "pg": the 1-based number of the page you read it from (the first image is page 1).`) and append to that paragraph:

```
Also return "row" for every measure: the 1-based index of the STRIP (within its page) that you read that measure from, counting strips top to bottom. If a page was not split into strips, every measure on it has "row": 1.
```

Then update the JSON example at the end of the prompt so the model sees the field in context — change the `"measures"` example line to:

```
  "measures": [{"number": {start_measure}, "pg": 1, "row": 1, "notes": [{"p": "D3", "b": 1.0, "d": 1.5, "a": null, "dyn": "p"}, {"r": true, "b": 2.5, "d": 1.5}]}]
```

Finally, in the measure-normalization step (the existing list comprehension that builds `measures` with `"page": int(m.get("pg") or m.get("page") or 1)`), add a `row` field alongside `page`:

```python
        def _raw_row(m: dict):
            """The model's reported strip index, or None if it didn't give a
            usable one. Deliberately NOT defaulted to 1 here — on a
            multi-system page "the model didn't say" and "the model said
            row 1" mean very different things, and only the orchestration
            (which knows how many rows the page actually has) can decide
            safely. Collapsing them here would destroy that distinction
            before it reaches the code that needs it."""
            try:
                return int(m.get("row"))
            except (TypeError, ValueError):
                return None

        measures = [
            {**m, "page": int(m.get("pg") or m.get("page") or 1),
             "row": _raw_row(m), "notes": [
                _norm_note(n) for n in m.get("notes", [])
            ]}
            for m in (parsed.get("measures") or [])
            if isinstance(m.get("notes"), list)
        ]
```

Leave the value as whatever the model returned (or absent) — do NOT coerce a missing value to 1 here. Task 11's orchestration decides what a missing/garbled row means, and it can only do that correctly if it can still tell "the model didn't say" apart from "the model said 1" (on a 12-system page those mean very different things).

**Also label each image inline**, which is what makes the model reliably able to report `row` at all. In the same loop that appends image blocks, insert a short text block immediately BEFORE each image:

```python
            for row_idx, row in enumerate(prepared_page["rows"], start=1):
                vision_parts.append({"type": "text",
                                     "text": f"PAGE {pg_num} — ROW {row_idx}"})
                b64 = base64.b64encode(row["row_bytes"]).decode()
                vision_parts.append({"type": "image", "source": {
                    "type": "base64", "media_type": pg_mime, "data": b64}})
```

Asking the model to count strips itself and then recall that count per measure is exactly the kind of implicit bookkeeping vision models drop; labelling each image turns it into copying a value it can see directly next to the notation it's reading.

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

    # claude_agreement maps measure number -> "agree" | "disagree" |
    # "unavailable". Three states, never a boolean — see
    # fuse_measure_confidence's docstring for why collapsing
    # "unavailable" into "agree" is a correctness bug, not a shortcut.
    if read_a.get("error") and read_b.get("error"):
        return read_a
    if read_a.get("error"):
        base_result = read_b
        # Only ONE read succeeded. There is no cross-validation signal at
        # all here — not agreement, not disagreement, just a single
        # uncorroborated observation per measure. Marking these
        # "unavailable" (rather than defaulting them to "agree") is what
        # stops a half-failed read from inheriting the confidence of two
        # matching reads.
        claude_agreement = {m["number"]: "unavailable" for m in read_b.get("measures", [])}
    elif read_b.get("error"):
        base_result = read_a
        claude_agreement = {m["number"]: "unavailable" for m in read_a.get("measures", [])}
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
            claude_agreement = {n: "agree" for n in all_numbers}
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
                claude_agreement[n] = ("agree" if counts[winning_fp] >= 2
                                       else "unavailable" if len(candidates) < 2
                                       else "disagree")
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

    # Group by (page, row) — NOT by page. Grouping by page alone can only
    # fuse single-system pages, and the real target input (the photo this
    # whole redesign exists for) splits into 12 systems. Per-row grouping
    # is what lets the OMR + segmentation half of this pipeline run on
    # dense multi-system pages at all.
    #
    # Row provenance FAILS SAFE, never to row 1. On a 12-system page, a
    # measure whose "row" the model omitted or garbled is not "probably
    # row 1" — it is unknown, and silently calling it row 1 would compare
    # it against a completely unrelated system's OMR output and image
    # crops, manufacturing disagreements (or worse, false agreements) out
    # of a bookkeeping gap. Unknown provenance instead means row=None:
    # that measure keeps its Claude cross-validation and deterministic
    # validation, and simply forgoes the row-scoped signals. Defaulting
    # to 1 is only correct when the page genuinely has one row.
    measures_by_row: dict = {}
    for m in base_result["measures"]:
        page_idx = m.get("page", 1)
        rows_on_page = (len(prepared_pages[page_idx - 1]["rows"])
                        if 0 <= page_idx - 1 < len(prepared_pages) else 0)
        raw_row = m.get("row")
        if rows_on_page <= 1:
            row_key = 1
        elif isinstance(raw_row, int) and 1 <= raw_row <= rows_on_page:
            row_key = raw_row
        else:
            row_key = None   # provenance unavailable — no row-scoped fusion
            print(f"[read_score_notes_claude] m.{m.get('number')} has no usable row "
                  f"provenance (got {raw_row!r}, page has {rows_on_page} rows) — "
                  f"skipping OMR/crop fusion for it rather than guessing row 1")
        measures_by_row.setdefault((page_idx, row_key), []).append(m)

    # The GLOBALLY last measure of the whole score — only this one gets the
    # partial-measure exemption. Using "last of its page/row" instead would
    # exempt every system's final measure from duration validation, which
    # is most of the interior of the piece.
    last_measure_number = max(m["number"] for m in base_result["measures"])

    final_measures = []
    unresolved_count = 0

    # row_key may be None (unknown provenance), which can't be compared to
    # an int — sort those last rather than letting sorted() raise.
    for (page_idx, row_idx), row_measures in sorted(
            measures_by_row.items(),
            key=lambda kv: (kv[0][0], float("inf") if kv[0][1] is None else kv[0][1])):
        row_measures.sort(key=lambda m: m["number"])
        row = None
        if row_idx is not None:
            prepared_rows = (prepared_pages[page_idx - 1]["rows"]
                             if 0 <= page_idx - 1 < len(prepared_pages) else [])
            if 0 <= row_idx - 1 < len(prepared_rows):
                row = prepared_rows[row_idx - 1]

        # --- OMR, at ROW level -------------------------------------------
        # oemer reads the whole dewarped ROW, never an isolated measure
        # crop. A measure crop from the middle of a system contains no
        # clef, key signature, or time signature, so an OMR engine reading
        # one has to GUESS them — and a wrong-clef guess makes every pitch
        # in that measure wrong. Wrong-clef inference is precisely how
        # Audiveris failed on this project's real photo, so handing an OMR
        # engine clef-less crops would be reintroducing a known failure by
        # construction. Printed notation repeats the clef and key at the
        # start of every system, so a ROW always carries the context a
        # measure crop lacks.
        oemer_row_measures: list[dict] = []
        if row is not None:
            oemer_result = read_score_notes_oemer(row["row_bytes"], resolved_time_sig)
            if not oemer_result.get("error"):
                oemer_row_measures = oemer_result.get("measures", [])

        # oemer's measures align to Claude's by POSITION within the row,
        # and only when both found the same number of measures. A count
        # mismatch means at least one of them mis-segmented the row, and a
        # forced positional match would then compare measure N against
        # measure N+1 for the rest of the row — manufacturing false
        # disagreements far worse than simply having no OMR signal.
        omr_aligned = (oemer_row_measures
                       if len(oemer_row_measures) == len(row_measures) else None)
        if oemer_row_measures and omr_aligned is None:
            print(f"[read_score_notes_claude] page {page_idx} row {row_idx}: oemer found "
                  f"{len(oemer_row_measures)} measures vs Claude's {len(row_measures)} — "
                  f"declining to fuse this row rather than risk an off-by-one alignment")

        # --- Measure crops, for dispute resolution only -------------------
        segmentation = row["segmentation"] if row else {"measures": [], "confidence": 0.0}
        crops = None
        if segmentation["confidence"] >= 0.6:
            crops = (segmentation["measures"]
                     if align_claude_to_measure_crops(
                         row_measures, len(segmentation["measures"])) is not None
                     else None)

        for i, measure in enumerate(row_measures):
            is_first = measure["number"] == start_measure
            is_last = measure["number"] == last_measure_number
            validation = validate_measure(
                measure, instrument, resolved_time_sig,
                is_first_measure=is_first, is_last_measure=is_last,
            )
            oemer_measure = omr_aligned[i] if omr_aligned is not None else None
            fusion = fuse_measure_confidence(
                claude_agreement.get(measure["number"], "unavailable"),
                measure, oemer_measure, validation)

            if fusion["needs_resolution"]:
                # Resolve against the tightest image available: this
                # measure's own crop when segmentation was trustworthy,
                # otherwise the whole row. Tight crops are exactly where a
                # closed-ended candidate comparison belongs — the model has
                # no neighbouring measures left to pattern-match against.
                crop_for_resolution = (crops[i] if crops is not None and i < len(crops)
                                       else (row["row_bytes"] if row else None))
                if crop_for_resolution is not None:
                    candidates = [measure] + ([oemer_measure] if oemer_measure else [])
                    resolved = resolve_measure_disagreement(
                        crop_for_resolution, candidates, instrument,
                        resolved_time_sig, anthropic_api_key,
                        is_first_measure=is_first, is_last_measure=is_last)
                    resolved["number"] = measure["number"]
                    resolved["page"] = measure.get("page", 1)
                    resolved["row"] = measure.get("row", 1)
                    measure = resolved
                else:
                    measure = {**measure, "unresolved": True,
                               "issues": fusion["reasons"]}

            if measure.get("unresolved"):
                unresolved_count += 1
                print(f"[read_score_notes_claude] m.{measure['number']} UNRESOLVED: "
                      f"{measure.get('issues')}")

            final_measures.append(measure)

    base_result["measures"] = sorted(final_measures, key=lambda m: m["number"])
    # Surfaced so callers (and the Task 14 ground-truth test) can tell
    # "this measure is known-shaky" apart from "this measure was accepted
    # confidently" — the distinction the whole redesign turns on.
    base_result["unresolved_measure_count"] = unresolved_count
    if unresolved_count:
        print(f"[read_score_notes_claude] {unresolved_count} measure(s) could not be "
              f"resolved confidently out of {len(final_measures)}")
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

### Task 12: Refuse to synthesize reference audio from an uncertain read

**This is the task that converts the whole pipeline into an actual product guarantee.** Tasks 1-11 make uncertainty *visible* (`unresolved: True`, `unresolved_measure_count`). Nothing so far makes it *consequential*: `_generate_reference_audio` still walks the measure list and synthesizes whatever notes are in it, unresolved or not. Without this task, the backend now knows a measure may be wrong and plays it anyway — the original product bug, with better logging.

**Files:**
- Modify: `modal_worker/worker.py` — `_generate_reference_audio` (currently at line 7211-ish; verify with `grep -n "^def _generate_reference_audio" modal_worker/worker.py` before editing, it has moved during this session).
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `read_score_notes_for_reference_audio(...)`'s result, which after Task 11 carries `unresolved_measure_count` (int) and per-measure `unresolved` flags.
- Produces: `_generate_reference_audio` returning `{"error": "score_read_uncertain", "message": ..., "unresolved_measures": [...]}` instead of audio when any measure is unresolved. The existing `{"error": ...}` contract is unchanged in shape, so the webhook/edge-function/frontend error paths built earlier tonight already handle it — the user sees an error message rather than wrong music.

**Design decision, deliberate:** refuse the WHOLE generation, rather than synthesizing the confident measures and skipping the uncertain ones. Partial audio sounds like a performance with holes in it, gives no indication which bars were dropped, and invites the user to trust the parts that played. "We couldn't read this reliably, try a clearer photo" is a worse-feeling but honest outcome, and it is the one that cannot silently teach a student wrong notes. Partial-audio-with-explicit-gaps is a reasonable future iteration; it is not the right default for the first version of a correctness fix.

- [ ] **Step 1: Write the failing tests**

Add to `modal_worker/test_analysis.py`, after Task 10's last test:

```python
def test_generate_reference_audio_refuses_when_measures_are_unresolved():
    print("\n[101] reference audio REFUSES to synthesize when any measure is unresolved")
    called = {"synthesized": False}

    def _fake_reader(score_urls, instrument, key):
        return {
            "time_signature": "3/4",
            "measures": [
                {"number": 12, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]},
                {"number": 13, "unresolved": True, "issues": ["Claude and OMR disagree"],
                 "notes": [{"pitch": "D4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]},
            ],
            "unresolved_measure_count": 1,
        }

    def _fake_synth(score, instrument, bpm):
        called["synthesized"] = True
        return b"RIFFfake", []

    _orig_reader = w.read_score_notes_for_reference_audio
    _orig_synth = w.generate_reference_audio
    w.read_score_notes_for_reference_audio = _fake_reader
    w.generate_reference_audio = _fake_synth
    try:
        result = w._generate_reference_audio({
            "score_urls": ["https://example.test/p1.png"],
            "instrument": "Clarinet (B♭)",
            "bpm": 100,
            "anthropic_api_key": "k",
        })
    finally:
        w.read_score_notes_for_reference_audio = _orig_reader
        w.generate_reference_audio = _orig_synth

    check("returns an error instead of audio", result.get("error") == "score_read_uncertain", str(result))
    check("NO audio was synthesized at all — the point is that questionable notes never reach the user",
          called["synthesized"] is False, str(called))
    check("names which measures were uncertain, so the error is actionable",
          13 in (result.get("unresolved_measures") or []), str(result))
    check("carries a human-readable message", bool(result.get("message")), str(result))


def test_generate_reference_audio_proceeds_when_nothing_is_unresolved():
    print("\n[102] reference audio still generates normally when every measure resolved confidently")
    called = {"synthesized": False}

    def _fake_reader(score_urls, instrument, key):
        return {
            "time_signature": "3/4",
            "measures": [
                {"number": 12, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 3.0}]},
            ],
            "unresolved_measure_count": 0,
        }

    def _fake_synth(score, instrument, bpm):
        called["synthesized"] = True
        return b"RIFFfake", [{"measure": 12, "start_sec": 0.0, "end_sec": 1.8}]

    _orig_reader = w.read_score_notes_for_reference_audio
    _orig_synth = w.generate_reference_audio
    w.read_score_notes_for_reference_audio = _fake_reader
    w.generate_reference_audio = _fake_synth
    try:
        result = w._generate_reference_audio({
            "score_urls": ["https://example.test/p1.png"],
            "instrument": "Clarinet (B♭)",
            "bpm": 100,
            "anthropic_api_key": "k",
        })
    finally:
        w.read_score_notes_for_reference_audio = _orig_reader
        w.generate_reference_audio = _orig_synth

    check("a fully-resolved read is not blocked", not result.get("error"), str(result))
    check("audio was synthesized", called["synthesized"] is True, str(called))
    check("returns base64 audio as before", bool(result.get("audio_base64")), str(result.keys()))
```

Register in `main()`'s tuple:

```python
              test_resolve_measure_disagreement_accepts_a_legitimate_pickup_measure,
              test_generate_reference_audio_refuses_when_measures_are_unresolved,
              test_generate_reference_audio_proceeds_when_nothing_is_unresolved,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[101\]\|\[102\]"`
Expected: `[101]` fails — the current code synthesizes regardless. (`[102]` may already pass; that is fine and expected, it is the regression guard for this change.)

- [ ] **Step 3: Add the refusal gate**

In `_generate_reference_audio`, insert immediately AFTER the existing max-measures check (`if len(score.get("measures", [])) > 500:` and its return) and BEFORE the `bpm` parsing block:

```python
    # Refuse to synthesize anything from a read the pipeline itself does
    # not trust. read_score_notes_claude marks a measure "unresolved" when
    # Claude's independent reads disagreed, an independent OMR read
    # contradicted them, or the measure failed deterministic music
    # validation AND targeted re-reading could not settle it (see
    # resolve_measure_disagreement).
    #
    # Playing those notes anyway is the exact product failure this whole
    # pipeline exists to end: a student hears confident, fluent, WRONG
    # music and has no way to know which bars to distrust. An error they
    # can act on ("take a clearer photo") is worse-feeling and far better
    # than authoritative-sounding wrong notes. Whole-generation refusal
    # rather than partial audio is deliberate — see this task's design
    # note in the plan.
    unresolved = [m.get("number") for m in score.get("measures", []) if m.get("unresolved")]
    if unresolved or score.get("unresolved_measure_count"):
        print(f"[_generate_reference_audio] refusing to synthesize — "
              f"{len(unresolved)} unresolved measure(s): {unresolved[:20]}")
        return {
            "error": "score_read_uncertain",
            "message": ("Some measures on this page could not be read reliably, so "
                        "reference audio was not generated — it would likely play the "
                        "wrong notes. Try a clearer, flatter photo of the page."),
            "unresolved_measures": unresolved,
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`.

- [ ] **Step 5: Verify the error surfaces to the user, rather than looking like a crash**

Trace the new error shape through the async chain built earlier in this project: `_generate_reference_audio` returns `{"error": ...}` → `_generate_reference_audio_background` posts `{"takeId", "error"}` to the webhook → `generate-reference-audio-webhook` writes `reference_audio_job_status='failed'` + `reference_audio_job_error` → the polling `generate-reference-audio` edge function returns `{status:'failed', error}` → `useReferenceAudio`'s poll loop throws with that message. Confirm by reading those files that the `message` field (not just the `error` code) is what reaches the user, and if only `error` propagates, set `error` to the human-readable sentence instead of the `score_read_uncertain` code — an end user must never be shown a raw error code.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): refuse reference-audio synthesis when the score read is uncertain"
```

---

### Task 13: Upload-flow quality gate UI

**Files:**
- Create: `supabase/functions/score-quality-check/index.ts`
- Modify: `modal_worker/worker.py` — add a thin Modal endpoint wrapping `compute_row_readability`.
- Modify: `src/components/NewRecordingModal.jsx` (score-picking section, currently around lines 563-595 per this plan's research — verify current line numbers before editing, this file may have changed).

**Interfaces:**
- Produces: `POST score-quality-check {scorePath} -> {quality: "good"|"marginal"|"poor", interlinePx: number|null}`, called by the frontend from inside `handleSubmit` AFTER the score files have uploaded to the `sheet-music` bucket and BEFORE the analysis/generation request is dispatched. It takes a storage `scorePath` (which only exists post-upload), not a raw file or URL — see Step 7 for the full flow and why there is exactly one.

- [ ] **Step 1: Add a Modal endpoint**

Add near `generate_reference_audio_async` (search for its exact current location — it has moved during this session's earlier work):

```python
def _check_score_quality(body: dict) -> dict:
    """Downloads one score image and reports its readability. Plain,
    undecorated for the same test-harness-mocking reason every other
    _prefixed function in this file is — see generate_reference_audio_endpoint's
    original docstring for the full explanation."""
    import httpx
    from urllib.parse import urlparse

    score_url = body.get("score_url")
    if not score_url:
        return {"error": "score_url is required"}

    # This endpoint is a PUBLIC, unauthenticated Modal URL that fetches a
    # caller-supplied URL, which makes it a server-side request forgery
    # primitive unless the destination is constrained: anyone who finds
    # the URL could otherwise point it at cloud-metadata services
    # (169.254.169.254), internal hosts, or arbitrary third parties and
    # learn from the response whether they resolved. Unlike this app's
    # other Modal endpoints, it needs no API key to do real work, so
    # "useless without your own credentials" does not protect it.
    #
    # The constraint MUST be server-controlled. An earlier draft of this
    # plan took the expected host from the request body, which is
    # self-defeating — an attacker simply sends a matching pair of
    # score_url and expected-host values and the check passes. The
    # allowlist below lives in this deployed function instead, where a
    # caller cannot influence it.
    parsed_url = urlparse(score_url)
    host = (parsed_url.hostname or "").lower()
    if (parsed_url.scheme != "https"
            or not (host == "supabase.co" or host.endswith(".supabase.co"))
            or not parsed_url.path.startswith("/storage/v1/object/")):
        print(f"[_check_score_quality] rejected non-storage URL host={host!r}")
        return {"error": "score_url must be an https Supabase storage object URL"}

    try:
        # follow_redirects=False matters as much as the allowlist: without
        # it, an allowed host that 302s elsewhere would walk the fetch
        # straight past the check above.
        with httpx.Client(timeout=30) as client:
            resp = client.get(score_url, follow_redirects=False)
            resp.raise_for_status()
            image_bytes = resp.content
    except Exception as e:
        return {"error": f"could not download image: {e}"}

    rows = split_page_into_rows(image_bytes)
    if not rows:
        return {"quality": "poor", "interline_px": None}

    results = [compute_row_readability(r) for r in rows]

    # Aggregate by the WORST row, not the best. Reference audio is
    # generated from the WHOLE page — one unreadable system means wrong
    # notes for that whole section, and picking the best row would let a
    # single sharp system vouch for a page whose other eleven are mush.
    # The user needs to know the page has a problem, not that some of it
    # happens to be fine.
    qualities = [r["quality"] for r in results]
    overall = ("poor" if "poor" in qualities
               else "marginal" if "marginal" in qualities
               else "good")
    worst = min(results, key=lambda r: r["interline_px"] or 0)
    return {"quality": overall, "interline_px": worst["interline_px"],
            "rows_checked": len(results),
            "poor_rows": sum(1 for q in qualities if q == "poor")}


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
      // Only the URL is sent. The worker enforces its own server-side
      // allowlist on the destination (see _check_score_quality) — a host
      // restriction supplied by the caller would be no restriction at
      // all, since a direct caller of that public endpoint controls both
      // halves of the comparison.
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

Modify `src/components/NewRecordingModal.jsx`'s score-picking section. Locate the current `pickScore` function and the score file list rendering (search for `scoreFiles` state and the surrounding JSX — verify current structure before editing, this plan's earlier research is not a substitute for reading the live file).

**The flow is exactly this — one architecture, no alternatives.** The score files already upload to the `sheet-music` bucket inside `handleSubmit` (the existing code path; this plan does not move that). The quality check runs **immediately after those uploads succeed and before the analysis/generation request is dispatched**, using the `scorePath` values the upload just produced. This is the only option that matches the edge function written in Step 4, which takes a `scorePath` and signs it — there is no throwaway temp upload and no client-only dimension check. (An earlier draft of this plan offered those as alternatives; that was a plan defect. Two materially different architectures presented as interchangeable is not a decision an implementer should be making mid-task.)

Concretely:

1. **Thumbnail preview at pick time** (no network): for each picked score file, render an `<img>` whose `src` comes from `URL.createObjectURL(file)`, and call `URL.revokeObjectURL` when that file is removed and on unmount, so the object URLs don't leak. This alone is most of the value — it is the first time the user actually sees the photo they just chose.
2. **Quality check after upload, before dispatch**, inside `handleSubmit`: once the score `scorePath`s exist, `POST` each to `score-quality-check`. If any returns `quality: "poor"`, do not silently continue and do not hard-block — surface the warning (item 3) and let the user choose to proceed anyway or go back and replace the photo. A check that errors or returns `"unknown"` proceeds silently: a broken quality check must never prevent an upload.
3. **Copy**: replace the existing generic hint line ("A clear photo lets Mediant pin issues to specific measures on your score.") with specific, actionable guidance — lay the page flat, fill the frame with just the music, avoid glare and shadow, and prefer a phone scanning app if available. On a `"poor"` result, show a non-blocking warning: "This photo may be too low-resolution or blurry to read accurately, so the reference audio could come out wrong. Try retaking it flatter and closer, or use your phone's scan mode."

- [ ] **Step 8: Manual browser verification**

Run `npm run dev`, open the New Recording modal, pick a low-quality photo (or the same real problem photo from tonight's investigation) and confirm the warning appears; pick a clean, high-quality photo and confirm no warning appears.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/score-quality-check modal_worker/worker.py src/components/NewRecordingModal.jsx .github/workflows/deploy-edge-functions.yml
git commit -m "feat(ui): add interline-based photo quality gate to score upload"
```

---

### Task 14: Ground-truth live test

**Files:** none (verification task).

- [ ] **Step 1: Run the full pipeline against the real problem photo**

Using Task 5's ground truth and the same take/photo used throughout tonight's investigation (take `34b08cfd-f533-4fe1-a588-5af04fe5ddc5`'s score, or a fresh take pointed at the same image), trigger reference-audio generation end to end (requires Anthropic credits to be restored — confirm with the user before this step if they haven't already said credits are back).

- [ ] **Step 2: Compute and report the acceptance metrics from the spec**

Compare the pipeline's output measures against Task 5's ground truth, measure by measure, and report:
- Exact pitch accuracy
- Exact duration accuracy
- Missing/extra-note rate
- Measure-perfect accuracy
- **Confidently-accepted-incorrect-measure count** — measures the pipeline did NOT mark `unresolved` (i.e. fusion accepted them, `needs_resolution: False`) that are nonetheless wrong against ground truth. Report this explicitly and prominently; per the spec, it is the single most important number in the whole test.
- Unresolved-measure count (`unresolved_measure_count` on the result) — reported alongside, as context for the number above, NOT as a failure in itself. A measure the pipeline openly flagged as uncertain is the system working correctly; the whole point of the redesign is to convert silent wrongness into visible uncertainty.

Also verify the multi-row path actually ran, rather than assuming it did: the real photo splits into ~12 systems, so the logs should show per-row activity across many rows. If `_prepare_score_rows` reports one row, or OMR fusion is skipped on every row, the pipeline silently degraded to the old Claude-only behavior and the metrics above are measuring the wrong thing.

- [ ] **Step 3: Judge success against the spec's actual bar**

Per the spec: a nonzero confidently-accepted-incorrect-measure count means the core problem is not solved, regardless of how good the other metrics look. If this number is nonzero, do not report the pipeline as working — report the specific measures involved and treat it as a bug to investigate (systematic-debugging), not a metric to round away.

Note the asymmetry when judging: a measure that is wrong AND flagged unresolved is a partial success (the system knew it didn't know). A measure that is wrong and confidently accepted is the original bug, still present.

---

### Task 15: Deploy

**Files:** none (deployment task).

- [ ] **Step 1: Confirm the migration/secret/deploy ordering**

No new database migration in this plan. Confirm `MODAL_SCORE_QUALITY_URL` (Task 13) is set before the edge function that reads it is deployed (already sequenced correctly in Task 13's own steps — this step is a final cross-check, not new work).

- [ ] **Step 2: Redeploy the worker with the full pipeline**

```bash
modal deploy modal_worker/worker.py
```

- [ ] **Step 3: Final end-to-end smoke test**

Repeat Task 14's live test once more against the fully deployed (not dev/ephemeral) stack, to confirm nothing differs between the `modal run` dev environment used for testing and the real deployed app.

- [ ] **Step 4: Update the project's own tracking docs**

Per this project's CLAUDE.md conventions: update `agent_workspace/CHANGELOG.md` and `agent_workspace/AGENT_TASKS.md` with this feature's outcome, and write a session/fix note to the Obsidian vault if a genuinely non-obvious decision or bug surfaced during implementation (matching this project's established documentation habits from earlier tonight).
