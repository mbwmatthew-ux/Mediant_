# Vision Resolution Upgrade — Design Spec

**Date:** 2026-09-20
**Status:** Approved for planning
**Owner decision:** User approved the 4-part plan below in chat on 2026-09-20; this spec writes it up for implementation.

## Problem

Tonight's investigation of a stuck reference-audio generation (take `34b08cfd`, later a fresh take on the same photo) traced a `two independent reads disagree on 42/46 measures` result down through several layers:

1. Confirmed NOT a numbering/comparison bug — 36 of 42 disagreements were genuine content disagreements between two independent Claude reads of the same crops (diagnostic added to `read_score_notes_claude`, `worker.py`).
2. Confirmed NOT primarily a source-photo-quality problem — a from-scratch iPhone 16 Pro photo (2160×2880, no compression artifacts, page filling the frame) still measured only ~13-14px staff-line interline, and the math checks out: ~230 DPI on the page is a real, physically plausible number for a phone photo at a normal working distance, not a measurement bug.
3. Confirmed a genuine (if modest, ~9-11%) resolution recovery is available by cropping out background before measurement (shipped tonight as `_detect_page_bounds`), but it alone does not rescue either real photo tested.
4. **Root cause of item 2's downstream impact, confirmed via Anthropic's current API docs (fetched live, not recalled):** this pipeline's vision calls are hardcoded to `claude-sonnet-4-6` (`worker.py:4249`, `5493`, `6606`), which Anthropic's models page lists as a **legacy** model. Per the current Vision docs, legacy/pre-4.7 models are **standard resolution tier**: images are capped at 1568px long edge and 1568 visual tokens (`⌈w/28⌉×⌈h/28⌉`), and anything larger is silently downscaled before the model ever sees it. Our row crops are routinely 2000-2160px wide. **Every vision read tonight has been downscaled by ~25-30% by Claude's own preprocessing, independent of source photo quality** — a photo that measures "good" on our own quality gate gets flattened to the same ceiling as one that measures "poor".

Separately, tonight's investigation also hit a live production error:
```
messages.0.content.1.image.source.base64.data: At least one of the image dimensions
exceed max allowed size for many-image requests: 2000 pixels
```
Per the same Vision docs: **any request with more than 20 image content blocks** triggers a much stricter per-image cap of 2000px, applied to *every* image in that request regardless of model tier. `_read_score_notes_claude_once` sends one text label + one image per row, in a single message — a multi-row, multi-page read can exceed 20 images without anyone having sized a crop wrong.

## Goal

Make the vision read pipeline use the resolution budget Claude actually offers, and stop accidentally forcing the stricter many-image cap — without loosening the deterministic quality gate, the D1/D2 confidence-aware and strict-refusal policies, or the disagreement/resolution logic. This is a capability upgrade to the read path, not a change to what happens after a read comes back.

## Non-goals

- Changing the deterministic validator, fusion, or disagreement-resolution logic.
- Changing the D2 "refuse rather than guess" reference-audio policy.
- Image super-resolution / learned upscaling (hallucination risk on notation is unacceptable — inventing a plausible-looking note that isn't there is worse than refusing).
- Moving primary reads to measure-level granularity (held in reserve; see Part 4).

## Design

### Part 1 — Upgrade the vision model (highest leverage, lowest risk)

Replace the hardcoded `"claude-sonnet-4-6"` with `"claude-sonnet-5"` at all three call sites:

- `worker.py:4249` — `_read_score_notes_claude_once`, the primary score-read call. This is the one that matters most: every row crop sent here gains the high-resolution tier's 2576px/4784-token budget (vs. 1568px/1568), roughly 3x the effective detail.
- `worker.py:5493` — `resolve_measure_disagreement`'s single-measure verification call. Lower stakes (a single tightly-cropped measure rarely needs the extra budget) but should stay consistent with the primary read model, and gets the same accuracy-generation improvements Sonnet 5 carries over Sonnet 4.6.
- `worker.py:6606` — `CLAUDE_MODEL` in `compare_and_coach_claude`. Not a dense-notation read, but keeping the whole pipeline on one current model avoids a confusing three-model split for no reason.

Per Anthropic's current pricing page, Sonnet 5 is priced at $2/$10 per MTok (input/output) against Sonnet 4.6's higher legacy rate — this is not a cost-for-quality tradeoff, it is a strict improvement on the numbers available today.

**Verification requirement:** before rollout, re-run `_detect_page_bounds` + `split_page_into_rows` + a live read against both real photos from tonight (the 1252×1606 screenshot and the 2160×2880 iPhone photo) and confirm the images are no longer downscaled — i.e., confirm empirically, not just by citation, that `claude-sonnet-5` is high-resolution tier for this workload. The plan should not treat the model-naming inference as sufficient on its own when a live check is cheap.

### Part 2 — Enforce a hard cap of ≤20 images per vision request

`_read_score_notes_claude_once` builds `vision_parts` as a flat list of `{text label, image}` pairs, one pair per row, across all pages, with no upper bound. A page that splits into many rows (18 rows was observed tonight on one page) plus a second page can exceed 20 image blocks in a single message, silently downgrading every image in that request to the stricter 2000px cap — regardless of model tier. This is the exact, already-confirmed mechanism behind tonight's `many-image requests` 400 error.

**Fix:** in `_read_score_notes_claude_once`, count image blocks as `vision_parts` is built (PDF document blocks count as 1 per Anthropic's rule; each row image counts as 1). If the total would exceed 20:
- Split into multiple sequential requests, each ≤20 images, preserving page/row order.
- Each request's prompt must carry enough context (the existing numbering rules, the running "continue numbering from where the last request left off" state) to stay consistent — the *last successfully parsed measure number* from the previous request becomes the new request's `start_measure` context, mirroring how the existing prompt already tells the model to continue numbering across pages within one request.
- Merge the parsed `measures` lists from each sub-request in order before returning, exactly as if they'd come from one call.

This raises a real design question the plan must answer concretely: how the multi-page "continue numbering" prompt logic (`strip_note` block) composes across a request boundary, not just a page boundary. The implementer should treat a request split exactly like today's existing page-strip split — same continuation contract, just at a different granularity — and this needs its own test.

### Part 3 — Pre-resize crops to the model's exact target size ourselves

Rather than relying on Claude's internal resize (whose exact resampling algorithm isn't published), compute the target size using Anthropic's documented reference algorithm (`resized_size(width, height, max_edge=2576, max_tokens=4784)` for the high-resolution tier — exact formula and reference Python implementation are in Anthropic's Vision/Coordinates docs) and resize each row crop to that exact size ourselves with a high-quality filter (Lanczos, via Pillow's `Image.resize(..., Image.LANCZOS)`) before base64-encoding.

This is lower-priority polish, not a correctness fix — Claude will resize correctly either way — but removes one unknown (their resize quality/algorithm) in exchange for one we control and can tune, and guarantees we never accidentally send an image so large it silently costs more tokens than intended.

### Part 4 — Measure-level primary reads (held in reserve, not built now)

If Parts 1-3, measured against the real problem photos, still leave meaningful content disagreement, the next lever is switching primary reads from row-level to measure-level crops (`split_row_into_measures` already exists and is used for targeted disagreement resolution). A single measure crop is narrow enough to essentially never approach either tier's cap, guaranteeing full native resolution regardless of model — at the cost of many more, smaller requests (latency and request-count go up substantially, and Part 2's ≤20-image batching becomes load-bearing rather than an edge case).

**Do not build this now.** The plan should end with Parts 1-3, and Part 4 should be evaluated against real measurement after Parts 1-3 ship — not built speculatively.

## Testing strategy

- `worker.py:test_analysis.py` unit tests for the request-splitting logic in Part 2: a fake page set producing >20 row images must produce >1 API call, with measure numbering continuous across the split (mirroring the existing page-strip continuity tests).
- A regression test asserting the model string is `claude-sonnet-5` at all three call sites (prevents silent regression back to a legacy model).
- Part 3's resize helper gets a unit test against Anthropic's own documented example (1075×1520 → 924×1307 at standard tier numbers, adjusted for the high-resolution tier's 2576/4784 limits) so the arithmetic is verified against a known-correct case, not just internal consistency.
- Manual/live verification step (not an automated test): re-run the real photo pipeline end-to-end against take `34b08cfd`'s photo and the fresh iPhone photo, and record the before/after disagreement rate. This is the actual acceptance bar for whether Parts 1-3 were sufficient, and it directly informs the Part 4 go/no-go.

## Rollout order

Parts 1 and 2 are independent of each other and can ship in either order, but Part 1 should be verified live (per its Verification requirement) before Part 2 is built, since Part 2's necessity and shape depend on confirming Part 1 actually changes the resolution ceiling. Part 3 is independent and can be built alongside either. Part 4 is explicitly out of scope for this implementation pass.
