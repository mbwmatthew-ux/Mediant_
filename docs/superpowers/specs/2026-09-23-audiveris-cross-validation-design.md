# Audiveris Cross-Validation Design

## Problem

The score-reading pipeline (`modal_worker/worker.py`, `read_score_notes_claude`)
cross-validates by having Claude read the same page twice, then a third
time on disagreement, and majority-voting the result. This catches
*disagreement* — cases where the photo is genuinely ambiguous to the
model — but it structurally cannot catch a *consistent* mistake: if
Claude misreads the same measure the same wrong way on two or three
independent calls, those calls agree with each other, and the pipeline
treats that agreement as confidence. This is documented in
`read_score_notes_claude`'s own docstring as the reason cross-validation
exists at all ("mirror-image measures, duplicated measures... read as
confident, plausible transcription"), and it is the most likely
explanation for tonight's reported symptom: the user hearing "wrong
note" flags for notes they know they played correctly.

The codebase already has a second-opinion mechanism designed for exactly
this: `fuse_measure_confidence` (`worker.py:5718`) takes an `oemer_measure`
parameter and `_cross_source_measure_match` (`worker.py:5658`) compares it
against Claude's reading. Both were built for `oemer`, a Python OMR
library, which was spiked and rejected earlier this session (0/6 real
row crops produced a usable staffline reading, plus a hard `numpy`
version conflict with this project's pinned stack). Every call site
today passes `oemer_measure=None` — the machinery has never once run
against real second-source data.

Tonight, after fixing two real preprocessing bugs (a mime-type
declaration bug, and a leftover-background-wedge bug in
`_crop_row_background_columns`, committed as `41e5e03`), a throwaway
spike (`spike_audiveris.py`) confirmed that **Audiveris** — a mature,
Java-based OMR engine already installed in this project's pinned Modal
image (see the `apt_install`/`run_commands` block near `worker.py:43`,
and the existing, currently-disabled `convert_visual_score_to_musicxml`
at `worker.py:1337`) — successfully parses a real, cleaned-up row crop
from the user's actual problem photo: correct staff detection, correct
interline measurement, 5 correctly-segmented measures with stems, beams,
slurs, and noteheads, exported as valid MusicXML. This is the same photo
that made Audiveris misread the clef entirely before tonight's
preprocessing fixes existed.

## Goal

Wire Audiveris in as a genuine second, independent read source for every
raster row of a photographed/scanned score page, so that:

1. A measure where Claude's repeated reads *agree* with each other but
   Audiveris *disagrees* is no longer blindly trusted (closes the actual
   gap behind tonight's reported symptom).
2. A measure where Claude's repeated reads *disagree* with each other,
   but Audiveris matches exactly one of the disagreeing candidates, is
   resolved immediately using that candidate — without spending one of
   the limited (`_RESOLUTION_CALL_CAP = 25`) targeted resolution calls.

This benefits both consumers of `read_score_notes_claude` — the main
analysis pipeline's score-read step and `read_score_notes_for_reference_audio`
(`worker.py:5201`) — automatically, since both call the same function and
neither needs its own changes (per that function's own docstring).

## Non-Goals

- **Not a feature flag.** Every failure mode (Audiveris crashes, times
  out, or its row/measure count doesn't line up with Claude's) degrades
  to exactly today's current behavior — `oemer_measure=None` for that
  measure. This is fail-open by construction, so a kill switch adds
  complexity without adding safety. If a real problem shows up in
  production, the fix is a normal redeploy.
- **Not multiple Audiveris runs per row.** Claude is re-read 2-3 times
  because it's a sampling model — the same input can produce different
  output. Audiveris is a deterministic classical algorithm: the same row
  bytes produce the same MusicXML every time. Running it twice would
  cost double the latency for zero new information.
- **Not applied to PDF pages.** `_prepare_score_rows` already gives PDF
  pages `"rows": []` (dewarping/segmentation are image-only, by existing
  design). Audiveris cross-validation only ever has row crops to work
  with, so it is scoped to raster pages only, matching that existing
  boundary exactly.
- **Not a full-page Audiveris run.** Audiveris runs on the same
  already-dewarped, already-background-cropped row crops
  `_prepare_score_rows` produces for Claude — not the raw page. Running
  it on the raw page was already tried (implicitly, via
  `convert_visual_score_to_musicxml`) and is why it misread the clef on
  this exact photo before tonight's row-level fixes existed.

## Architecture

### 1. Per-row Audiveris runner (new)

A new Modal function, `_run_audiveris_on_row(row_bytes: bytes) -> dict`,
runs Audiveris on one row crop and returns a dict shaped like every other
OMR/measure-parse result in this file: `{"measures": [...], "source":
"audiveris", ...}` on success, or `{"error": "...", "measures": []}` on
any failure. It is built by extracting the shared
"run audiveris CLI, find the exported file, parse it" logic out of the
existing `convert_visual_score_to_musicxml` (`worker.py:1337`) into a
helper both functions call — not by duplicating that logic — since the
two functions differ only in their input (a whole score file vs. one row
image) and in `convert_visual_score_to_musicxml`'s two-command fallback
(`-transcribe -export` then `-export` alone), which the row-scoped runner
does not need (a single row has no page-level transcription step to
retry).

Decorated `@app.function(image=image, timeout=150)` — reusing the exact
same `image` object the rest of `worker.py` already builds (Audiveris is
already installed there; this needs no new image or deployment
infrastructure). 150s leaves real margin over the 60-120s observed in
tonight's spike.

Parsing the exported MusicXML reuses `parse_score_document`
(`worker.py:1312`) exactly as `convert_visual_score_to_musicxml` already
does — no new parsing code.

### 2. Parallel dispatch

Audiveris takes 60-120s per row; a real page can have a dozen or more
rows, so running this serially would add many minutes. Immediately after
`_prepare_score_rows(pages)` runs, at the top of `read_score_notes_claude`
(`worker.py:4778`), dispatch one `_run_audiveris_on_row.spawn(...)` call
per raster row across every page, collecting the resulting handles in a
`{(page_idx, row_idx): FunctionCall}` dict — *before* the two sequential
Claude vision calls (`read_a`, `read_b`) begin. Claude's own reads
already take real wall-clock time; by the time both/all three Claude
reads finish, Audiveris's calls are typically already done or close to
it, so its latency is mostly hidden rather than purely additive.
`.get()` (blocking) is called on each handle only once, right before it's
needed, after the Claude reads finish.

### 3. Fixing the actual gap: tie-breaking at reconciliation

This is the part that makes the feature actually address tonight's
symptom, not just the parts of `fuse_measure_confidence` that already
plumb `oemer_measure` through.

**The existing gap:** `fuse_measure_confidence`'s `claude_agreement ==
"disagree"` branch (`worker.py:5764`) returns `needs_resolution:
True` immediately, without ever inspecting `oemer_measure`. By the time
`fuse_measure_confidence` is called at all, the reconciliation loop
inside `read_score_notes_claude` has *already* collapsed `read_a`/`read_b`/
`read_c`'s disagreeing candidates down to one arbitrarily-chosen
"winner" (`max(counts, key=lambda fp: counts[fp])`, which on a genuine
3-way tie — every candidate different, every count 1 — just picks
whichever candidate happened to be checked first). Wiring real Audiveris
data into the existing `oemer_measure` parameter alone would do nothing
for this case: the "disagree" branch never looks at it, and the
"winner" it would be compared against isn't a meaningful pick to begin
with. Given tonight's real photo showed a 46/47-measure disagreement
rate, this is not an edge case — it is the dominant failure mode this
whole feature exists to fix.

**The fix:** in the reconciliation block that builds `reconciled`
(the loop starting `for n in all_numbers:` inside `read_score_notes_claude`,
`worker.py:4896`), the exact insertion point is where `claude_agreement[n]`
and `winner` are currently set (`worker.py:4906-4909`):

```python
claude_agreement[n] = ("agree" if counts[winning_fp] >= 2
                       else "unavailable" if len(candidates) < 2
                       else "disagree")
winner = next(c for c, fp in zip(candidates, fingerprints) if fp == winning_fp)
```

When the `else "disagree"` case is reached (`counts[winning_fp] < 2` and
`len(candidates) >= 2`, i.e. no 2-of-3 Claude majority), check each
surviving candidate against Audiveris's data for *that candidate's own*
reported row (`candidate.get("row")`/`candidate.get("pg")`, present on
every raw measure since `worker.py:4425` — not a single shared row for
the whole measure number, since different candidates can themselves
disagree about which row they came from) via `_cross_source_measure_match`,
before falling through to today's `winner = next(...)` line. Three
outcomes:

- **Exactly one candidate matches Audiveris:** use that candidate as the
  winner (not the arbitrary first-checked one), and record this
  measure's `claude_agreement` as a new state distinct from plain
  `"disagree"` — see below.
- **Zero or more than one candidate matches** (or Audiveris is
  unavailable for this row): fall back to exactly today's behavior —
  arbitrary first-checked winner, `claude_agreement = "disagree"`.

**New `claude_agreement` state:** `fuse_measure_confidence`'s
three-state contract (`"agree"` / `"disagree"` / `"unavailable"`) gains a
fourth: `"disagree_omr_broke_tie"`. This is a genuinely new state, not a
repurposing of an existing one — collapsing it into `"agree"` would
claim two independent Claude reads matched when they didn't, and leaving
it as `"disagree"` reproduces the exact gap this fix exists to close.
`fuse_measure_confidence` treats it as: validator-invalid still wins
(unchanged), otherwise `{"confidence": "high", "needs_resolution":
False, "reasons": ["Claude's own reads disagreed; OMR independently
broke the tie"]}`. Every existing call site and test that only ever
produces `"agree"`/`"disagree"`/`"unavailable"` is unaffected — this is
an additive state, not a change to the other three's behavior.

### 4. Alignment: matching Audiveris's row-local numbering to Claude's global numbering

Audiveris numbers measures `1..N` *within the row it was given* (tonight's
spike: "5 raw measures" for one row). Claude's measures carry global
piece-wide numbers, but each measure the reconciliation loop assigns to a
row is already grouped by `(page_idx, row_idx)` — this exact grouping
already exists for row-scoped resolution crops (`measures_by_row`,
`worker.py:5004` in the *current* file, in the loop just after
reconciliation). For a given row, if Audiveris's returned measure count
equals the count of Claude-measures assigned to that row, zip them by
position (Claude's Nth measure in the row ↔ Audiveris's Nth measure).
**If the counts don't match, do not guess** — that row's Audiveris data
is unavailable for every measure in it, identical to today's
`oemer_measure=None` behavior. This is the same "don't guess" convention
already used throughout this file (`_detect_page_bounds`,
`_whole_page_crop_for_resolution`, `_crop_row_background_columns`, the
row-provenance fallback in the reconciliation loop itself).

### 5. Wiring into the existing per-measure fusion call

The existing, unconditional `oemer_measure = None` at `worker.py:5033`
becomes a real lookup into the per-row Audiveris-measures-by-number map
built in part 4, for the row the current measure belongs to. This is the
"shallow" wiring — it makes the existing `"agree"` + OMR-contradicts and
`"unavailable"` + OMR-corroborates paths in `fuse_measure_confidence`
real for the first time, on top of the "disagree" tie-break fix in part 3.

## Data Flow Summary

```
_prepare_score_rows(pages)
        │
        ├─→ per raster row: _run_audiveris_on_row.spawn(row_bytes)  ─┐
        │                                                             │ (parallel,
read_a = _read_score_notes_claude_once(...)                          │  hidden behind
read_b = _read_score_notes_claude_once(...)                          │  Claude's own
        │                                                             │  latency)
   [disagreement?] → read_c = _read_score_notes_claude_once(...)     │
        │                                                             │
        ▼                                                             ▼
  reconciliation loop (per measure number):                  audiveris_by_row =
    - candidates disagree + Audiveris available               {handle.get() results,
      + exactly one candidate matches  → tie broken,           keyed (page_idx, row_idx)}
      claude_agreement = "disagree_omr_broke_tie"
    - otherwise → today's existing behavior
        │
        ▼
  per-measure loop (existing, worker.py:5024+):
    oemer_measure = audiveris_by_row.get((page_idx, row_idx), {}).get(measure_number)
    fuse_measure_confidence(claude_agreement, measure, oemer_measure, validation, time_sig)
```

## Error Handling

| Failure | Behavior |
|---|---|
| Audiveris process crashes or produces no export | `_run_audiveris_on_row` returns `{"error": ..., "measures": []}`; that row's measures get `oemer_measure = None` |
| Audiveris exceeds the 150s function timeout | Modal raises on `.get()`; caught, treated identically to a crash |
| Audiveris's row measure count ≠ Claude's measure count for that row | No alignment attempted for that row; `oemer_measure = None` for every measure in it |
| A page is a PDF (`prepared_pages[i]["rows"] == []`) | No Audiveris calls dispatched for that page at all |
| Every Audiveris call for a page fails | Identical to today's current behavior for that entire page — zero regression |

## Testing Strategy

Following this file's existing `test_analysis.py` conventions (the
`check()` harness, synthetic fixtures, and — where a real-photo
regression matters — real fixture files under `testdata/`, matching
`real_photo_row_background_wedge.png`'s precedent from tonight's earlier
fix):

1. **`_run_audiveris_on_row` shape test** — with Audiveris's own CLI
   mocked (this file already mocks subprocess calls for
   `convert_visual_score_to_musicxml`'s tests; follow the same pattern),
   confirm success returns `{"measures": [...], "source": "audiveris"}`
   and failure/no-export returns `{"error": ..., "measures": []}`.
2. **Alignment count-mismatch test** — Claude has 4 measures in a row,
   the fake Audiveris result has 5; confirm zero measures in that row
   get real `oemer_measure` data (no silent misalignment).
3. **Alignment success test** — matching counts; confirm positional
   zip produces the right Claude-number → Audiveris-measure mapping.
4. **Tie-break test (the load-bearing one)** — three fake Claude reads
   that all disagree on one measure number, a fake Audiveris measure
   that matches exactly one of the three candidates; confirm that
   candidate wins, `claude_agreement` comes back
   `"disagree_omr_broke_tie"`, and `needs_resolution` is `False`.
5. **Tie-break declines to guess test** — same setup, but the fake
   Audiveris measure matches *none* of the three candidates (or *two*
   of them); confirm today's existing arbitrary-winner/`"disagree"`
   behavior is unchanged.
6. **`fuse_measure_confidence` new-state test** — direct unit test of
   the `"disagree_omr_broke_tie"` branch's confidence/reasons output.
7. **Regression: existing `oemer_measure=None` tests unaffected** — the
   full existing suite (currently 611/611) must stay green; this feature
   is additive.
8. **PDF scope-cut test** — a PDF page dispatches zero Audiveris calls.
9. **Real end-to-end check** (manual, not part of the automated
   suite) — rerun today's actual problem photo end-to-end once the
   feature is wired up, and confirm via logs that Audiveris results are
   actually being consulted and at least some measures are resolved via
   `disagree_omr_broke_tie` rather than falling through to
   `resolve_measure_disagreement` calls.
