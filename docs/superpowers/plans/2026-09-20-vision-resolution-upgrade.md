# Vision Resolution Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the vision read pipeline from silently discarding resolution: upgrade from a legacy standard-resolution-tier Claude model to a current high-resolution-tier one, and defend against Anthropic's stricter 20-image-per-request cap.

**Architecture:** Three independent changes to `modal_worker/worker.py`: (1) swap the hardcoded model string at all three vision call sites, verified live against Anthropic's actual token-accounting behavior, not just documentation; (2) a pre-resize helper that computes and applies the model's exact target image size ourselves, using Anthropic's published reference algorithm, before base64-encoding; (3) a request-splitting layer inside `_read_score_notes_claude_once` that keeps every request at ≤20 image blocks, reusing the existing cross-page numbering-continuation prompt pattern across the new request boundary.

**Tech Stack:** Python (Modal worker), `anthropic` SDK, Pillow (image resize), existing `test_analysis.py` synthetic-fixture test harness.

**Spec:** `docs/superpowers/specs/2026-09-20-vision-resolution-upgrade-design.md`

## Global Constraints

- Target model for all three call sites: `claude-sonnet-5` (current, high-resolution tier per spec).
- High-resolution tier limits (Anthropic Vision docs, quoted in spec): max long edge 2576px, max visual tokens 4784 (`⌈width/28⌉ × ⌈height/28⌉`).
- Standard tier limits (for comparison/tests): max long edge 1568px, max visual tokens 1568.
- Hard cap: no single vision request may contain more than 20 image content blocks (PDF `document` blocks count as 1 each; each row image counts as 1) — exceeding this forces a stricter 2000px-per-image cap onto every image in that request, per Anthropic's docs.
- Do not touch: the deterministic validator, fusion/disagreement-resolution logic, the D1/D2 confidence-aware and strict-refusal policies, or any code outside the three call sites and the request-building/resize paths named in this plan.
- Do not build measure-level primary reads (Part 4 in the spec) — explicitly deferred.

---

### Task 1: Upgrade the vision model at all three call sites, with live verification

**Files:**
- Modify: `modal_worker/worker.py:4249` (inside `_read_score_notes_claude_once`)
- Modify: `modal_worker/worker.py:5493` (inside `resolve_measure_disagreement`)
- Modify: `modal_worker/worker.py:6606` (`CLAUDE_MODEL` inside `compare_and_coach_claude`)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the model string `"claude-sonnet-5"` used at all three sites — later tasks (2, 3) build request-shaping logic that assumes this model's high-resolution-tier limits (2576px / 4784 tokens), so this task must land first and be verified correct before Task 3 (request splitting) is built, per the spec's explicit ordering requirement.

- [ ] **Step 1: Write the failing regression test**

Add to `modal_worker/test_analysis.py`, after the last existing test function (currently `test_split_page_into_rows_benefits_from_page_bounds_crop`, test `[142]`):

```python
def test_vision_call_sites_use_current_high_res_model():
    print("\n[143] all three vision call sites use claude-sonnet-5 (current, "
          "high-resolution tier — 2576px/4784 tokens), not a legacy standard-tier "
          "model, which silently downscales every image above 1568px/1568 tokens "
          "regardless of source photo quality (see the 2026-09-20 vision-resolution "
          "spec). Reads the source file directly rather than importing constants, "
          "so it catches the model string wherever it's written, including inline "
          "literals that never get their own named constant.")
    import re
    worker_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.py")
    with open(worker_path) as f:
        src = f.read()

    legacy_hits = re.findall(r'"claude-sonnet-4-6"', src)
    check("no remaining references to the legacy standard-tier model",
          len(legacy_hits) == 0, f"found {len(legacy_hits)} occurrence(s)")

    # Every vision-facing model= or CLAUDE_MODEL = literal must be the
    # upgraded model. This intentionally checks the source text, not a
    # runtime import, because two of the three sites (the score-read and
    # measure-resolution calls) set the model inline at the call site
    # rather than through a shared constant.
    current_model_hits = len(re.findall(r'"claude-sonnet-5"', src))
    check("claude-sonnet-5 appears at least 3 times (the three call sites)",
          current_model_hits >= 3, f"found {current_model_hits} occurrence(s)")
```

Register it in `main()`'s call list, immediately after `test_split_page_into_rows_benefits_from_page_bounds_crop,`:

```python
              test_split_page_into_rows_benefits_from_page_bounds_crop,
              test_vision_call_sites_use_current_high_res_model,
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | grep -A3 '\[143\]'`
Expected: FAIL on both checks — the source still contains `"claude-sonnet-4-6"` three times and zero occurrences of `"claude-sonnet-5"`.

- [ ] **Step 3: Swap the model string at all three call sites**

In `modal_worker/worker.py`:

Line 4249 (inside `_read_score_notes_claude_once`, the primary score-read call):
```python
        with client.messages.stream(
            model="claude-sonnet-5",
```

Line 5493 (inside `resolve_measure_disagreement`):
```python
        with client.messages.stream(
            model="claude-sonnet-5",
```

Line 6606 (inside `compare_and_coach_claude`):
```python
    CLAUDE_MODEL = "claude-sonnet-5"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -5`
Expected: `578/578 checks passed` (577 existing + this task's 1 new check-pair test, which contributes 2 checks — verify the exact new total printed and use that number, since other tasks in this plan add more).

- [ ] **Step 5: Live-verify the resolution-tier change empirically**

This step does NOT run through the automated suite — it is a one-time manual verification that the model swap actually changes Claude's resolution handling for this workload, not just that the string changed. The spec requires this because "claude-sonnet-5 is high-resolution tier" is inferred from Anthropic's docs (Sonnet 5 postdates the "4.7 and later" cutoff per their models page) rather than an explicit per-model tier table — cheap to confirm directly rather than trust the inference alone.

First, check whether an Anthropic API key is available:

```bash
echo "${ANTHROPIC_API_KEY:+SET}${ANTHROPIC_API_KEY:-UNSET}"
```

**If UNSET:** stop and escalate — report back BLOCKED with "no ANTHROPIC_API_KEY available in this environment to run the live verification" rather than skipping this step or guessing at the result. Do not mark this task complete without either a real verification run or an explicit, ledgered decision from the controller to defer it.

**If SET**, run this comparison using the committed real-photo fixture (`modal_worker/testdata/real_photo_row.png`, a real phone-photo crop already checked into the repo) against Anthropic's token-counting endpoint, which reports the exact visual-token cost an image would incur without running a full inference call:

```bash
cd modal_worker
python3 - <<'EOF'
import base64, json, urllib.request

with open("testdata/real_photo_row.png", "rb") as f:
    b64 = base64.b64encode(f.read()).decode()

def count_tokens(model):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
            {"type": "text", "text": "describe"},
        ]}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages/count_tokens",
        data=body,
        headers={
            "content-type": "application/json",
            "x-api-key": __import__("os").environ["ANTHROPIC_API_KEY"],
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)

legacy = count_tokens("claude-sonnet-4-6")
current = count_tokens("claude-sonnet-5")
print("claude-sonnet-4-6 (legacy, expect standard tier):", legacy)
print("claude-sonnet-5 (expect high-res tier):", current)
EOF
```

Expected: the real photo fixture is 1230x96px (well under both tiers' limits at this small size, so token counts may be IDENTICAL for this specific fixture — that alone does not prove the tier difference, since a small image never gets downscaled on either tier). To actually distinguish the tiers, repeat the comparison using a synthetic image at 2200x2200px (above the standard tier's 1568px edge limit, within the high-resolution tier's 2576px limit):

```python
from PIL import Image
import io
big = Image.new("RGB", (2200, 2200), "white")
buf = io.BytesIO()
big.save(buf, format="PNG")
b64 = base64.b64encode(buf.getvalue()).decode()
# re-run count_tokens("claude-sonnet-4-6") and count_tokens("claude-sonnet-5") with this b64
```

Expected result confirming the tier difference: `claude-sonnet-4-6`'s reported `input_tokens` reflects a downscaled ~1568px-edge image (fewer visual tokens), while `claude-sonnet-5`'s reflects the image at or near its native 2200px size (more visual tokens, since 2200 < 2576 means no downscale needed on the high-res tier). If both models report the same token count for the 2200x2200 test image, the tier assumption in the spec is WRONG — stop, do not proceed to Task 3, and report this back as a finding that changes the plan (Task 3's necessity and the whole premise of Part 1 depend on this result).

Record the actual numbers observed in the task report — this is the acceptance evidence for Task 1, not just the passing regression test.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "fix(worker): upgrade vision calls from legacy claude-sonnet-4-6 to claude-sonnet-5

Sonnet 4.6 is standard resolution tier (1568px/1568 visual tokens);
Sonnet 5 is high-resolution tier (2576px/4784 tokens) per Anthropic's
current Vision docs, confirmed live via the token-counting endpoint.
Row crops sent to the score-read call are routinely 2000px+ wide, so
every read has been silently downscaled ~25-30% regardless of source
photo quality."
```

---

### Task 2: Pre-resize helper using Anthropic's documented target-size algorithm

**Files:**
- Modify: `modal_worker/worker.py` (new function, placed near `compute_row_readability` / other image-processing helpers)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent per the spec), but uses the same tier constants (`max_edge=2576, max_tokens=4784`) Task 1 verified apply to `claude-sonnet-5`.
- Produces: `_claude_target_size(width: int, height: int, max_edge: int = 2576, max_tokens: int = 4784) -> tuple[int, int]` and `_resize_for_claude(image_bytes: bytes, mime: str) -> bytes` — Task 3 (request-splitting) does not consume this directly, but the row-image-encoding step both tasks touch should call `_resize_for_claude` before base64-encoding (see Task 3 Step 3's note).

- [ ] **Step 1: Write the failing test against Anthropic's own documented worked example**

Add to `modal_worker/test_analysis.py`, after `test_vision_call_sites_use_current_high_res_model`:

```python
def test_claude_target_size_matches_documented_example():
    print("\n[144] _claude_target_size reproduces Anthropic's own documented worked "
          "example exactly — an A4 page scanned at 130 DPI (1075x1520px) resizes to "
          "924x1307 on the standard tier (1568 edge / 1568 tokens), per the Vision "
          "docs' 'How Claude resizes and pads images' section. Verified against a "
          "published example rather than only checked for internal consistency.")
    result = w._claude_target_size(1075, 1520, max_edge=1568, max_tokens=1568)
    check("matches Anthropic's documented example exactly",
          result == (924, 1307), str(result))


def test_claude_target_size_high_res_tier_no_resize_needed():
    print("\n[145] _claude_target_size leaves an image unchanged when it already "
          "fits the high-resolution tier's limits — the same 1075x1520 scan that "
          "needed resizing on the standard tier fits the high-res tier's 4784-token "
          "budget untouched (39x55=2145 visual tokens, per Anthropic's own worked "
          "arithmetic in the same doc section, well under 4784)")
    result = w._claude_target_size(1075, 1520, max_edge=2576, max_tokens=4784)
    check("no resize needed — image already fits the high-resolution tier",
          result == (1075, 1520), str(result))


def test_claude_target_size_noop_when_already_within_limits():
    print("\n[146] _claude_target_size is a no-op on an image already within limits "
          "on either tier (small images, e.g. a single measure crop, must never be "
          "upscaled — only downscaled when oversized)")
    result = w._claude_target_size(200, 200, max_edge=1568, max_tokens=1568)
    check("small image returned unchanged, not upscaled", result == (200, 200), str(result))


def test_resize_for_claude_produces_target_dimensions():
    print("\n[147] _resize_for_claude actually resizes an oversized row-crop-shaped "
          "image to the computed target size, using a high-quality resample filter")
    from PIL import Image
    import io
    oversized = Image.new("L", (2200, 150), color=250)
    buf = io.BytesIO()
    oversized.save(buf, format="PNG")
    resized_bytes = w._resize_for_claude(buf.getvalue(), "image/png")
    resized_img = Image.open(io.BytesIO(resized_bytes))
    expected = w._claude_target_size(2200, 150)
    check("resized to the computed target dimensions", resized_img.size == expected,
          f"got {resized_img.size}, expected {expected}")


def test_resize_for_claude_noop_bytes_identical_when_already_within_limits():
    print("\n[148] _resize_for_claude returns the ORIGINAL bytes unchanged (not just "
          "same-dimensions-but-re-encoded) when no resize is needed — avoids a "
          "pointless re-encode/quality-loss round trip on images that already fit")
    from PIL import Image
    import io
    small = Image.new("L", (400, 100), color=250)
    buf = io.BytesIO()
    small.save(buf, format="PNG")
    original_bytes = buf.getvalue()
    result_bytes = w._resize_for_claude(original_bytes, "image/png")
    check("bytes are unchanged, not re-encoded", result_bytes == original_bytes,
          f"{len(result_bytes)} bytes vs original {len(original_bytes)} bytes")
```

Register all five in `main()`'s call list, after `test_vision_call_sites_use_current_high_res_model,`:

```python
              test_vision_call_sites_use_current_high_res_model,
              test_claude_target_size_matches_documented_example,
              test_claude_target_size_high_res_tier_no_resize_needed,
              test_claude_target_size_noop_when_already_within_limits,
              test_resize_for_claude_produces_target_dimensions,
              test_resize_for_claude_noop_bytes_identical_when_already_within_limits,
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | grep -B1 "AttributeError\|FAIL"`
Expected: FAIL — `w._claude_target_size` and `w._resize_for_claude` do not exist yet (`AttributeError: module 'worker' has no attribute '_claude_target_size'`).

- [ ] **Step 3: Implement `_claude_target_size` and `_resize_for_claude`**

Add to `modal_worker/worker.py`, near `compute_row_readability` (the other image-processing helpers live in that section of the file):

```python
def _claude_target_size(width: int, height: int, max_edge: int = 2576,
                          max_tokens: int = 4784) -> tuple[int, int]:
    """
    The exact size Claude resizes an image to before padding, computed
    ourselves rather than left to Claude's internal (undocumented-algorithm)
    resize — so we control the resampling quality on notation, which is
    fragile to blurring, and never send more bytes than the model will
    actually use.

    Reference implementation from Anthropic's Vision/Coordinates docs
    ("Resize your image before uploading"), ported as-is. Defaults are the
    high-resolution tier's limits (2576px edge / 4784 visual tokens); pass
    max_edge=1568, max_tokens=1568 for the standard tier. An image already
    within both limits is returned unchanged — this function only ever
    downscales, never upscales.
    """
    import math

    def count_tokens(w: int, h: int) -> int:
        return math.ceil(w / 28) * math.ceil(h / 28)

    def fits(w: int, h: int) -> bool:
        return (math.ceil(w / 28) * 28 <= max_edge
                and math.ceil(h / 28) * 28 <= max_edge
                and count_tokens(w, h) <= max_tokens)

    if fits(width, height):
        return (width, height)
    if height > width:
        resized_h, resized_w = _claude_target_size(height, width, max_edge, max_tokens)
        return (resized_w, resized_h)

    aspect_ratio = width / height
    lo, hi = 1, width  # lo always fits; hi never fits
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if fits(mid, max(round(mid / aspect_ratio), 1)):
            lo = mid
        else:
            hi = mid
    return (lo, max(round(lo / aspect_ratio), 1))


def _resize_for_claude(image_bytes: bytes, mime: str) -> bytes:
    """
    Resizes an image to the exact size Claude's high-resolution tier will
    use, with a high-quality resample filter (Lanczos) — rather than
    sending an oversized image and trusting Claude's own internal resize,
    whose exact algorithm Anthropic does not publish. A no-op (returns the
    ORIGINAL bytes, not a re-encode) when the image already fits, so an
    already-small crop (e.g. a single measure) never pays a pointless
    re-encode cost or quality loss.

    Never raises — undecodable bytes come back unchanged, same
    no-op-on-failure convention as split_page_into_rows and
    compute_row_readability.
    """
    try:
        from PIL import Image
        import io

        img = Image.open(io.BytesIO(image_bytes))
        w, h = img.size
        target_w, target_h = _claude_target_size(w, h)
        if (target_w, target_h) == (w, h):
            return image_bytes

        resized = img.resize((target_w, target_h), Image.LANCZOS)
        buf = io.BytesIO()
        save_format = "PNG" if mime == "image/png" else "JPEG"
        resized.convert("RGB" if save_format == "JPEG" else img.mode).save(buf, format=save_format)
        return buf.getvalue()
    except Exception as e:
        print(f"[_resize_for_claude] failed, sending original bytes: {e}")
        return image_bytes
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -5`
Expected: all checks passing (previous total + 5 new tests' checks — read the exact printed total).

- [ ] **Step 5: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): add _resize_for_claude, pre-resizing crops ourselves

Computes the exact target size Claude's high-resolution tier will use
(Anthropic's own documented reference algorithm) and resizes with
Lanczos before base64-encoding, rather than trusting Claude's internal
(undocumented) resize. No-op on images already within limits."
```

---

### Task 3: Cap every vision request at ≤20 images, splitting and re-merging when needed

**Files:**
- Modify: `modal_worker/worker.py:4134-4176` (inside `_read_score_notes_claude_once`)
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `_resize_for_claude` from Task 2 (call it on each row's bytes before appending to `vision_parts`, so every image sent is both correctly sized AND request-count-safe).
- Produces: `_read_score_notes_claude_once` keeps its existing external signature and return shape (`{"key_signature", "time_signature", "tempo_marking", "measures"}`) — callers (`read_score_notes_claude`, which calls this function up to 3 times per read) are unaffected; the splitting happens entirely inside this function.

**Context on the existing continuation pattern this task reuses:** `_read_score_notes_claude_once` already tells Claude to continue measure numbering across MULTIPLE PAGES within one request (the `strip_note` block, built from `page_strip_counts`) and takes a `start_measure` parameter that anchors where numbering begins for the whole call. When one call's images must be split across multiple API requests (this task), each sub-request after the first must tell Claude to continue from the LAST measure number the previous sub-request actually returned — the same shape as the existing "don't restart numbering on a new page" instruction, just reused at a request boundary instead of a page boundary.

- [ ] **Step 1: Write the failing test**

Add to `modal_worker/test_analysis.py`, after `test_resize_for_claude_noop_bytes_identical_when_already_within_limits`. This test needs a fake Claude client that counts how many separate `stream()` calls it received and returns a distinct, verifiable measure range per call — extend the existing `_fake_claude_read_stream` pattern (used throughout this file, e.g. in `probe.py`-style tests and the PDF/healthy-score tests referenced in this session) rather than inventing a new mocking approach:

```python
def test_read_score_notes_claude_once_splits_requests_over_20_images():
    print("\n[149] _read_score_notes_claude_once splits into multiple API requests "
          "when a page's row crops would exceed 20 images in one message, and "
          "merges the results back into one continuous measure list — the exact "
          "mechanism behind the real 'many-image requests...2000 pixels' 400 error "
          "hit in production tonight, which this task closes")
    import types

    # 25 synthetic rows on one page -> 25 image blocks, over the 20-image cap.
    fake_page_bytes, _ = _make_synthetic_page(system_count=25, width=800, height=3000)
    rows = w.split_page_into_rows(fake_page_bytes)
    check("fixture setup produced more than 20 rows to split across", len(rows) > 20,
          f"got {len(rows)} rows")

    prepared_pages = [{
        "page_mime": "image/png",
        "page_bytes": fake_page_bytes,
        "rows": [{"row_bytes": r, "readability": {"quality": "good", "interline_px": 24.0,
                                                    "sharpness": 0.5, "reasons": []},
                   "segmentation": {"measures": [r], "boundaries": [], "confidence": 1.0}}
                  for r in rows],
    }]

    calls = []

    class _FakeStream:
        def __init__(self, batch_number, start_measure):
            self._batch = batch_number
            self._start = start_measure
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def get_final_message(self):
            # Each fake batch "reads" 5 fresh measures starting from whatever
            # start_measure this call was given, proving continuity: batch 2
            # must have been called with a start_measure past batch 1's last
            # returned measure, not restarted at the original start_measure.
            numbers = list(range(self._start, self._start + 5))
            measures_json = ", ".join(
                f'{{"number": {n}, "pg": 1, "row": 1, "notes": '
                f'[{{"p": "C4", "b": 1.0, "d": 1.0}}]}}' for n in numbers)
            text = ('{"key_signature": "C", "time_signature": "4/4", '
                    f'"tempo_marking": null, "measures": [{measures_json}]}}')
            block = types.SimpleNamespace(type="text", text=text)
            return types.SimpleNamespace(content=[block])

    class _FakeMessages:
        def stream(self, model, max_tokens, temperature, messages):
            image_count = sum(1 for part in messages[0]["content"] if part.get("type") == "image")
            calls.append(image_count)
            check(f"request {len(calls)} has at most 20 images", image_count <= 20,
                  f"request {len(calls)} had {image_count} images")
            # start_measure is read back out of the prompt text this task
            # must include (see Step 3) — the fake client can't see the
            # real function's internal variable, so it infers continuity
            # from call ORDER instead: first call starts fresh, every
            # later call must be a fresh, larger batch.
            start = 12 if len(calls) == 1 else 12 + (len(calls) - 1) * 5
            return _FakeStream(len(calls), start)

    class _FakeClient:
        def __init__(self, api_key=None):
            self.messages = _FakeMessages()

    import anthropic as _ac
    orig_anthropic = _ac.Anthropic
    _ac.Anthropic = _FakeClient
    try:
        result = w._read_score_notes_claude_once(
            [(fake_page_bytes, "image/png")], prepared_pages, 12, "clarinet", "4/4", "fake-key")
    finally:
        _ac.Anthropic = orig_anthropic

    check("split into more than one API request", len(calls) > 1, str(calls))
    check("every individual request stayed at or under the 20-image cap",
          all(c <= 20 for c in calls), str(calls))
    numbers_returned = sorted(m["number"] for m in result["measures"])
    check("measure numbers from every sub-request are merged, in order, no duplicates",
          numbers_returned == sorted(set(numbers_returned)) and len(numbers_returned) > 5,
          str(numbers_returned))
```

Register it in `main()`'s call list, after `test_resize_for_claude_noop_bytes_identical_when_already_within_limits,`:

```python
              test_resize_for_claude_noop_bytes_identical_when_already_within_limits,
              test_read_score_notes_claude_once_splits_requests_over_20_images,
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | grep -A5 '\[149\]'`
Expected: FAIL — `_read_score_notes_claude_once` currently sends all 25 images in one request (`len(calls) == 1`), and the first check inside `_FakeMessages.stream` (`request 1 has at most 20 images`) fails since it receives 25.

- [ ] **Step 3: Implement the request-splitting via an extract-method refactor, not a reimplementation**

**Read this first.** `_read_score_notes_claude_once` (currently `modal_worker/worker.py:4134-4382`) is NOT the simple stream-call-then-parse function it might look like from its opening lines. After the `client.messages.stream(...)` call it contains: `extract_json_object` parsing with a truncation-aware partial-extraction regex fallback, a `_norm_note` field normalizer, a `_raw_row` page/row-index extractor, a critical anti-renumbering repair pass that enforces strictly-increasing measure numbers (with a detailed comment explaining a real bug this fixed), dynamic-wedge computation, extensive diagnostic logging (including the numbering-gap diagnostic), and a `source: "claude_vision"` tag that a DIFFERENT downstream system (DTW eligibility in `run_full_analysis`) depends on. **Do not retype or reimplement any of this from memory or from this plan's prose — transcribing ~150 lines of intricate parsing/repair logic by hand risks a silent regression far worse than the bug this task fixes.**

The correct refactor is **extract method, verbatim**: move the existing body — everything from the `try:` that wraps `client = ac.Anthropic(...)` (right after the `prompt = f"""..."""` block) through the final `except Exception as e: ... return {...}` at the end of the function — into a new, separate function that takes the already-built `vision_parts` and `prompt` as parameters instead of building them itself. Change NOTHING else in that moved body. The new function's signature:

```python
def _call_claude_score_batch(vision_parts: list, prompt: str, anthropic_api_key: str) -> dict:
    """
    Sends one already-built vision_parts + prompt to Claude and parses the
    response — the single-request body extracted verbatim out of
    _read_score_notes_claude_once so it can be called once per batch when
    a read's images exceed the 20-image-per-request cap (see
    _read_score_notes_claude_once). Returns the exact same dict shape
    _read_score_notes_claude_once used to return directly: on success,
    {"key_signature", "time_signature", "tempo_marking", "tempo_bpm",
    "wedges", "measures", "source": "claude_vision"}; on a parse failure,
    {"key_signature", "time_signature", "tempo_marking", "measures": [],
    "source": "claude_vision_partial"} or the fully-empty shape; on an
    exception, {"key_signature": None, ..., "measures": [], "error": ...}.
    """
    import anthropic as ac  # the moved body's ac.Anthropic(...) call needs this --
                             # it was part of the original function's opening
                             # "import base64, anthropic as ac" line; base64 stays
                             # in _read_score_notes_claude_once (it b64-encodes the
                             # batch's images before this function is ever called),
                             # anthropic moves here since only the moved body uses it.
    # PASTE THE EXTRACTED BODY HERE, UNCHANGED — the try/stream/parse/
    # normalize/repair/wedge/log/return logic currently at worker.py
    # lines ~4247-4382 (verify the exact current range before extracting;
    # this file has changed repeatedly tonight). The ONLY edits inside
    # this moved body: replace every reference to the OLD function's
    # local `vision_parts` and `prompt` variables with this function's
    # own parameters of the same names (they already ARE named
    # `vision_parts` and `prompt` in the original, so in most cases no
    # edit is needed at all — confirm this by diffing before/after).
```

Then rewrite `_read_score_notes_claude_once` itself as a thin wrapper: build `units` (as shown below), split into batches of ≤20 image-slots, build each batch's `vision_parts` and prompt (reusing the existing prompt template text and `strip_note` logic, both UNCHANGED from the original — only the `batch_note` continuation addition below is new), call `_call_claude_score_batch` once per batch, and merge the results:

```python
def _read_score_notes_claude_once(
    pages: list[tuple[bytes, str]],
    prepared_pages: list[dict],
    start_measure: int, instrument: str, time_sig: str,
    anthropic_api_key: str,
) -> dict:
    import base64
    CLAUDE_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    MAX_IMAGES_PER_REQUEST = 20

    # Each unit becomes one image-slot: either a PDF document block or one
    # (label, image) row pair. Building this flat list first, then batching
    # it below, keeps the existing page/row iteration untouched and adds
    # splitting as a separate, later pass over the same data.
    units: list[dict] = []
    page_strip_counts: list[int] = []
    for pg_num, prepared_page in enumerate(prepared_pages, start=1):
        pg_mime = prepared_page["page_mime"]
        pg_bytes = prepared_page["page_bytes"]
        if pg_mime == "application/pdf":
            units.append({"kind": "pdf", "pg_bytes": pg_bytes})
            page_strip_counts.append(1)
        elif pg_mime in CLAUDE_IMAGE_TYPES:
            page_strip_counts.append(len(prepared_page["rows"]))
            for row_idx, row in enumerate(prepared_page["rows"], start=1):
                resized_bytes = _resize_for_claude(row["row_bytes"], pg_mime)
                units.append({"kind": "row", "pg_num": pg_num, "row_idx": row_idx,
                              "mime": pg_mime, "row_bytes": resized_bytes})
        else:
            print(f"[read_score_notes_claude] skipping unsupported mime: {pg_mime}")
            page_strip_counts.append(0)
    if not units:
        return {"key_signature": None, "time_signature": None,
                "tempo_marking": None, "measures": []}

    # UNCHANGED from the original function: builds strip_note from
    # page_strip_counts exactly as before. (Paste the existing
    # strip_note-building block here verbatim — worker.py's current
    # lines ~4180-4202.)
    strip_note = ""
    if any(c > 1 for c in page_strip_counts):
        # ... existing ranges/strip_note logic, unchanged ...
        pass  # implementer: paste the existing block, do not retype from scratch

    batches: list[list[dict]] = []
    current: list[dict] = []
    for unit in units:
        if len(current) >= MAX_IMAGES_PER_REQUEST:
            batches.append(current)
            current = []
        current.append(unit)
    if current:
        batches.append(current)

    batch_results: list[dict] = []
    next_start_measure = start_measure
    for batch_idx, batch in enumerate(batches):
        vision_parts: list = []
        for unit in batch:
            if unit["kind"] == "pdf":
                b64 = base64.b64encode(unit["pg_bytes"]).decode()
                vision_parts.append({"type": "document", "source": {
                    "type": "base64", "media_type": "application/pdf", "data": b64}})
            else:
                vision_parts.append({"type": "text",
                                     "text": f"PAGE {unit['pg_num']} — ROW {unit['row_idx']}"})
                b64 = base64.b64encode(unit["row_bytes"]).decode()
                vision_parts.append({"type": "image", "source": {
                    "type": "base64", "media_type": unit["mime"], "data": b64}})

        batch_note = strip_note
        if batch_idx > 0:
            # A batch after the first is a CONTINUATION of the same read,
            # not a fresh one — the same "don't restart numbering" contract
            # the existing strip_note already gives Claude across pages
            # within one request, reused here across a REQUEST boundary.
            batch_note += (
                f"\n\nCONTINUATION: this is a continuation of the same page(s) you "
                f"were already reading. Measure numbering continues from where the "
                f"previous batch of images left off — the first measure you see "
                f"here is NOT measure 1 and is NOT necessarily {start_measure}; "
                f"continue counting forward from measure {next_start_measure}."
            )

        # UNCHANGED prompt template from the original function, with
        # {strip_note} replaced by {batch_note} and the opening example
        # measure number in the trailing JSON schema example replaced by
        # {next_start_measure} instead of {start_measure} — paste the
        # existing prompt f-string here (worker.py's current lines
        # ~4203-4247) with exactly those two substitutions.
        prompt = f"""...(existing prompt text, unchanged except the two substitutions above)..."""

        batch_result = _call_claude_score_batch(vision_parts, prompt, anthropic_api_key)
        batch_results.append(batch_result)
        batch_measures = batch_result.get("measures") or []
        if batch_measures:
            next_start_measure = max(m["number"] for m in batch_measures) + 1

    # Merge: measures concatenate in batch order (each batch's numbers are
    # already absolute and correct — the repair pass inside
    # _call_claude_score_batch anchors each batch's own start_measure
    # correctly since next_start_measure was threaded into that batch's
    # prompt). Page-level facts (key/time signature) and wedges are
    # recomputed from the FIRST batch that has them, since these describe
    # the whole read, not a single batch — a single-batch read (the common
    # case, ≤20 images) behaves EXACTLY as before this task, byte-for-byte.
    all_measures: list[dict] = []
    key_signature = time_signature = tempo_marking = tempo_bpm = None
    source = None
    error = None
    for batch_result in batch_results:
        all_measures.extend(batch_result.get("measures") or [])
        if key_signature is None:
            key_signature = batch_result.get("key_signature")
        if time_signature is None:
            time_signature = batch_result.get("time_signature")
        if tempo_marking is None:
            tempo_marking = batch_result.get("tempo_marking")
        if tempo_bpm is None:
            tempo_bpm = batch_result.get("tempo_bpm")
        if batch_result.get("source") == "claude_vision":
            source = "claude_vision"
        elif source is None:
            source = batch_result.get("source")
        if error is None:
            error = batch_result.get("error")

    result = {
        "key_signature": key_signature, "time_signature": time_signature,
        "tempo_marking": tempo_marking, "tempo_bpm": tempo_bpm,
        "wedges": _compute_dynamic_wedges(all_measures),
        "measures": all_measures,
    }
    if source:
        result["source"] = source
    if error and not all_measures:
        result["error"] = error
    return result
```

**Implementer note on the two `pass`/ellipsis placeholders above** (the `strip_note` block and the `prompt` f-string): these are marked exactly where existing, unchanged code must be pasted in — use the Read tool on the current `worker.py` to get the exact current text of those two blocks (they have not changed in this plan's other tasks), and paste them verbatim. This is a mechanical move, not new logic to design.

```python
def _read_score_notes_claude_once(
    pages: list[tuple[bytes, str]],
    prepared_pages: list[dict],
    start_measure: int, instrument: str, time_sig: str,
    anthropic_api_key: str,
) -> dict:
    import base64, anthropic as ac
    CLAUDE_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    MAX_IMAGES_PER_REQUEST = 20

    # Each entry is one (kind, payload) unit that will become either one
    # {"type": "document", ...} block (kind="pdf", counts as 1 image-slot)
    # or a {label, image} pair (kind="row", counts as 1 image-slot — the
    # text label does not count against Anthropic's image-block limit).
    # Building this flat unit list FIRST, then batching it below, keeps
    # the existing page/row iteration logic unchanged and adds splitting
    # as a separate, later pass over the same data.
    units: list[dict] = []
    page_strip_counts: list[int] = []
    for pg_num, prepared_page in enumerate(prepared_pages, start=1):
        pg_mime = prepared_page["page_mime"]
        pg_bytes = prepared_page["page_bytes"]
        if pg_mime == "application/pdf":
            units.append({"kind": "pdf", "pg_bytes": pg_bytes})
            page_strip_counts.append(1)
        elif pg_mime in CLAUDE_IMAGE_TYPES:
            page_strip_counts.append(len(prepared_page["rows"]))
            for row_idx, row in enumerate(prepared_page["rows"], start=1):
                resized_bytes = _resize_for_claude(row["row_bytes"], pg_mime)
                units.append({"kind": "row", "pg_num": pg_num, "row_idx": row_idx,
                              "mime": pg_mime, "row_bytes": resized_bytes})
        else:
            print(f"[read_score_notes_claude] skipping unsupported mime: {pg_mime}")
            page_strip_counts.append(0)
    if not units:
        return {"key_signature": None, "time_signature": None,
                "tempo_marking": None, "measures": []}

    strip_note = ""
    if any(c > 1 for c in page_strip_counts):
        ranges = []
        idx = 1
        for pg_num, count in enumerate(page_strip_counts, start=1):
            if count == 0:
                continue
            if count == 1:
                ranges.append(f"image {idx} is page {pg_num}")
            else:
                ranges.append(f"images {idx}-{idx + count - 1} are all horizontal strips of page {pg_num}, top to bottom")
            idx += count
        strip_note = (
            "\n\nSOME PAGES ARE SPLIT INTO STRIPS: to make dense systems easier to "
            "read accurately, one or more pages above have been cut into horizontal "
            "strips instead of sent as one image. " + "; ".join(ranges) + ". Strips "
            "of the SAME page are NOT separate pages — give every measure from those "
            "strips the SAME \"pg\" number, and continue measure numbering across "
            "strips exactly as you would within an unsplit page. Only advance \"pg\" "
            "and reset your reading context at an ACTUAL boundary between two "
            "different pages."
        )

    # Split `units` into batches of at most MAX_IMAGES_PER_REQUEST image-slots
    # each — every unit (pdf or row) occupies exactly one image-slot.
    batches: list[list[dict]] = []
    current: list[dict] = []
    for unit in units:
        if len(current) >= MAX_IMAGES_PER_REQUEST:
            batches.append(current)
            current = []
        current.append(unit)
    if current:
        batches.append(current)

    all_measures: list[dict] = []
    key_signature = time_signature = tempo_marking = None
    next_start_measure = start_measure

    for batch_idx, batch in enumerate(batches):
        vision_parts: list = []
        for unit in batch:
            if unit["kind"] == "pdf":
                b64 = base64.b64encode(unit["pg_bytes"]).decode()
                vision_parts.append({"type": "document", "source": {
                    "type": "base64", "media_type": "application/pdf", "data": b64}})
            else:
                vision_parts.append({"type": "text",
                                     "text": f"PAGE {unit['pg_num']} — ROW {unit['row_idx']}"})
                b64 = base64.b64encode(unit["row_bytes"]).decode()
                vision_parts.append({"type": "image", "source": {
                    "type": "base64", "media_type": unit["mime"], "data": b64}})

        # A batch after the first is a CONTINUATION of the same read, not a
        # fresh one — same "don't restart numbering" contract the existing
        # strip_note already gives Claude across pages within one request,
        # reused here across a REQUEST boundary. next_start_measure carries
        # forward the highest measure number actually returned so far.
        batch_note = strip_note
        if batch_idx > 0:
            batch_note += (
                f"\n\nCONTINUATION: this is a continuation of the same page(s) you "
                f"were already reading. Measure numbering continues from where the "
                f"previous batch of images left off — the first measure you see "
                f"here is NOT measure 1 and is NOT necessarily {start_measure}; "
                f"continue counting forward from measure {next_start_measure}."
            )

        prompt = f"""You are an expert music engraver reading sheet music for a {instrument} student.

MEASURE NUMBERING — THE MOST IMPORTANT PART OF THIS TASK. Get this wrong and every piece of feedback points at the wrong bar.

1. The printed numbers on the page are the ONLY source of truth. These are the small boxed numbers above the staff (e.g. 12, 20, 38, 50, 58). Assign them exactly as printed.
2. MULTIRESTS CONSUME MEASURE NUMBERS. A bar drawn as a thick horizontal block with a number over it (e.g. "11", "4", "2") is that many WHOLE MEASURES of rest, not one measure. If a multirest of 11 sits before the bar printed "12", then those 11 rest measures are measures 1-11. After a multirest of N, the next measure number is (current + N). Skipping a multirest without advancing the count is the single most common way to get this wrong.
3. Number every measure continuously across the whole line, including measures that contain only rests. You will NOT output the rest measures (see below) — but they must still consume their numbers, so the measures you DO output carry their true printed numbers.
4. Therefore the "number" values you output will normally have GAPS in them (e.g. ... 37, then 40 ...). That is correct and expected. A perfectly consecutive 1,2,3,4... run is almost always a sign you renumbered — do not do that.
5. Do NOT start counting from the student's starting measure, and do not renumber to make the first measure you see come out as any particular value. Only if the page shows no printed numbers anywhere should you count barlines, and in that case the FIRST measure in the image is measure 1.

MULTIPLE PAGES: You may be given several images. They are consecutive pages of ONE part, in order. Measure numbering runs continuously ACROSS them — the first measure of page 2 is NOT measure 1, it continues from where page 1 ended. Do not restart numbering on a new page. For every measure, also return "pg": the 1-based number of the page you read it from (the first image is page 1). Also return "row" for every measure: the 1-based index of the STRIP (within its page) that you read that measure from, counting strips top to bottom. If a page was not split into strips, every measure on it has "row": 1.
{batch_note}
Time signature hint: {time_sig}. Use what you see in the image if different.

Return every measure that CONTAINS AT LEAST ONE SOUNDED NOTE, in order. Omit measures that are entirely rest (including multirests) — but per the numbering rules above, they still consume their measure numbers. For each sounded note:
- "p": pitch in scientific notation ("D3", "F#4") — null only if notehead present but pitch unreadable
- "b": beat position in measure (1.0 = downbeat)
- "d": duration in beats
- "a": articulation — "staccato", "tenuto", "accent", or null
- "dyn": dynamic marking at this note — "pp","p","mp","mf","f","ff","cresc","dim", or null

Also return written rests of a beat or longer (do NOT report a multirest as a rest entry — those are already handled by the numbering rule above):
- "r": true, and no "p" (omit or leave null)
- "b": beat position where the rest begins
- "d": duration in beats

Use short field names to keep the JSON compact. Return JSON only (no markdown):
{{
  "key_signature": "...",
  "time_signature": "...",
  "tempo_marking": "...",
  "measures": [{{"number": {next_start_measure}, "pg": 1, "row": 1, "notes": [{{"p": "D3", "b": 1.0, "d": 1.5, "a": null, "dyn": "p"}}, {{"r": true, "b": 2.5, "d": 1.5}}]}}]
}}"""

        try:
            client = ac.Anthropic(api_key=anthropic_api_key)
            with client.messages.stream(
                model="claude-sonnet-5",
                max_tokens=32000,
                temperature=0,
                messages=[{"role": "user", "content": [*vision_parts, {"type": "text", "text": prompt}]}],
            ) as stream:
                msg = stream.get_final_message()
        except Exception as e:
            print(f"[read_score_notes_claude] error on batch {batch_idx + 1}/{len(batches)}: {e}")
            continue

        text = "".join(block.text for block in msg.content if block.type == "text")
        try:
            import json as _json
            parsed = _json.loads(text)
        except Exception as e:
            print(f"[read_score_notes_claude] failed to parse batch {batch_idx + 1}/{len(batches)}: {e}")
            continue

        if batch_idx == 0:
            key_signature = parsed.get("key_signature")
            time_signature = parsed.get("time_signature")
            tempo_marking = parsed.get("tempo_marking")

        batch_measures = parsed.get("measures", [])
        all_measures.extend(batch_measures)
        if batch_measures:
            next_start_measure = max(m["number"] for m in batch_measures) + 1

    return {"key_signature": key_signature, "time_signature": time_signature,
            "tempo_marking": tempo_marking, "measures": all_measures}
```

**Note on the existing streaming/JSON-parsing code this replaces:** the original function's exact streaming call, `max_tokens=32000`, `temperature=0`, and final-message text-extraction/JSON-parsing logic (previously written once, after the single `client.messages.stream(...)` block) must be preserved verbatim inside this new per-batch loop — the snippet above inlines that existing logic into the loop body rather than describing it abstractly. Before replacing the function, read the current lines after 4249 (the streaming call) through wherever the function returns, to confirm this plan's inlined version matches the existing error-handling and parsing behavior exactly (same `try/except` shape around the stream call, same JSON-parse failure handling) — do not silently drop or change existing error-handling semantics while doing this refactor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -10`
Expected: all checks passing, including `[149]`'s three checks (split into >1 request, every request ≤20 images, merged measures continuous with no duplicates).

- [ ] **Step 5: Run the full suite once to confirm no regressions**

Run: `cd modal_worker && python3 test_analysis.py 2>&1 | tail -5`
Expected: `N/N checks passed` with zero failures — this task touches `_read_score_notes_claude_once`, which is exercised by several existing tests (the PDF-page and healthy-score tests referenced elsewhere in this file); confirm none of them broke.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "fix(worker): cap vision requests at 20 images, splitting and merging as needed

_read_score_notes_claude_once now batches its row/page images into
requests of at most 20 image blocks, reusing the existing cross-page
numbering-continuation prompt pattern across the new request boundary.
Closes the 'many-image requests...2000 pixels' 400 error confirmed in
production tonight, which forced every image in an over-20-image
request down to a stricter cap regardless of model tier."
```

---

## Explicitly deferred (not part of this plan)

Per the spec's Part 4: moving primary reads from row-level to measure-level crops is deferred pending live measurement of Tasks 1-3's effect on the real problem photos (take `34b08cfd`'s screenshot and the fresh iPhone photo used throughout tonight's investigation). Do not build it as part of this plan. After Task 3 ships, the next action outside this plan's scope is re-running the real-photo comparison and deciding, with real numbers, whether Part 4 is still needed.
