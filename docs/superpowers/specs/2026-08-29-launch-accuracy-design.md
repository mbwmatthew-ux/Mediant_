# Launch Accuracy — Design

**Date:** 2026-08-29
**Status:** approved (scope C + coverage banner)
**Follows:** `docs/superpowers/plans/2026-08-28-measured-analysis-accuracy.md` (Phase 1, merged locally)

---

## Goal

> Before launch, the analyzer must never present incomplete or misaligned analysis
> as complete — and where it can analyze, it should catch the error categories a
> teacher would.

Success is not a precision percentage; that needs a corpus which does not exist yet
and is calendar-bound. Success here is: **every known gap is either closed, or
declared to the student.** No silent wrongness.

This is deliberately a *different* claim from Phase 1's. Phase 1 built the machinery
to measure accuracy. This phase improves accuracy itself, and verifies the
improvement the only way available without a corpus — synthetic fixtures through the
existing coverage matrix, which asks: *if a student makes mistake X, does a flag
about X come out the other end, and if they play cleanly, does nothing?*

## Why these five things

Each is a defect I confirmed in the code this session, not a speculative improvement.

| # | Gap | Evidence it is real |
|---|-----|---------------------|
| 1 | Multi-page scores analyse page 1 only, silently | `grep score_paths modal_worker/worker.py` → no match. The edge function forwards the field; the worker drops it. The UI paginates all pages. |
| 2 | Repeats misalign everything after them, silently | `has_repeats` is set in the parse result and read by nothing. Its only effect is a `print` to a Modal log. |
| 3 | Playing through a rest is undetectable | `parse_musicxml` `continue`s past every `Rest`; the vision prompt says "skip rests"; the Gemini prompt says "do NOT flag anything heard during rests". Three layers, all blind. |
| 4 | Playing at the wrong tempo is undetectable | `tempo_marking` is parsed, stored, and never read by any analysis. Rushing/dragging are measured only against the player's own opening. |
| 5 | Crescendo / diminuendo are discarded | The vision reader is told it may return `"cresc"` / `"dim"`; `_DYNAMIC_RANK` has no entry for either, so `if d in _DYNAMIC_RANK` drops them. |

Gaps 1 and 2 are **precision** failures — they make the analyzer confidently wrong,
which is the trust-killer at launch. Gaps 3-5 are **recall** failures — real mistakes
nobody is told about. Precision first.

---

## Part 1 — Multi-page scores (real fix)

### The gap is narrower than "multi-page", and that matters

`read_score_notes_claude` branches on mime type: a PDF becomes a Claude `document`
block, an image becomes an `image` block. A `document` block reads **every page of the
PDF**. So:

| Upload | Today |
|---|---|
| One multi-page PDF | **Already fully read.** Do not change this path. |
| Several image files (phone photos of each page) | **Only file 0 is read.** |
| Several PDFs | Only file 0 is read. |

The upload accepts `image/jpeg, image/png, image/webp, image/heic, application/pdf`
and allows multiple files (`NewRecordingModal.jsx`, whose own comment reads *"Only the
FIRST page is read by the AI"*). So the real defect is **multiple uploaded files**, and
the common broken case is a student photographing three pages — which this project's own
notes say is the usual upload, not MusicXML.

Framing it as "multi-page is broken" would invite an implementer to rework the PDF path
that already works. It must not be touched.

### Current flow

`analyze-performance` signs **one** URL (page 0) as `score_url` and separately passes
the raw `score_paths` array. `_score_pipeline` in the worker downloads `score_url`,
reads it, and never looks at `score_paths`.

### Design

**Edge function.** Sign every entry of `safeScorePaths` and pass an ordered
`score_urls: string[]`. Keep `score_url` unchanged so nothing else breaks.

**Worker `_score_pipeline`.** When `score_urls` has more than one entry, download all
of them and hand the whole ordered list to the score reader in **one** vision call.
Claude accepts multiple images in a single message; sending them together is what lets
the model carry measure numbering across a page break, which is exactly where
numbering goes wrong.

**`read_score_notes_claude`.** Take `pages: list[tuple[bytes, str]]` instead of a
single `(bytes, mime)`. Add one instruction to the prompt: measure numbering runs
continuously **across** pages — the first measure of page 2 is not measure 1 — and each
measure must carry the 1-based `page` it was read from. Emit `"pg"` per measure
alongside the existing compact fields.

**`measure_layout`.** Each measure gains `page`. The Analysis page already tracks
`currentScorePage`; this is what will eventually let a highlight land on the right
sheet. Storing it now costs nothing and unblocks that later.

**`score_cache`.** Keyed on `score_path` (a single TEXT primary key). A two-page score
must not collide with its own page 1. Key on the ordered array joined with `|`. No
migration: the column is an opaque TEXT key and stays one. A comment must say so,
because a reader will otherwise assume it is a storage path.

**Gemini.** `evaluate_with_gemini` inlines one score image; inline all pages in order.
`get_measure_positions_gemini` runs per page, and its results merge with the page index
attached.

### Coverage declaration

If any page fails to parse, the take declares the measure range actually covered rather
than implying the whole piece was analysed. See Part 6.

---

## Part 2 — Repeats (honest degradation)

### Why not expand

`music21.expandRepeats()` preserves printed measure numbers (verified previously), so
flags would still name what the student sees. The blocker is structural: after
expansion a measure number appears **twice at different times**, and
`build_measure_timeline` plus every Loop window assume a measure number maps to exactly
one span. That single-timeline invariant is the thing this codebase has already paid to
fix across several rounds, and re-breaking it before launch is a bad trade.

### Design

`parse_musicxml` already computes `has_repeats`. Extend it to also record
`first_repeat_measure` — the measure number of the earliest repeat barline or
`RepeatExpression`. Both travel on the score dict, into `analysis_quality`, and into the
coverage declaration.

**Flags are not suppressed.** We cannot tell whether the student actually took the
repeat, and deleting good analysis on a maybe would trade one silent wrong for another.
What ships instead is a declaration naming the measure: *if you played the repeat,
measure numbers after m.N may be offset.* The student knows whether they took it; we do
not. Giving them the fact they need to judge is more honest than either guessing.

Repeat expansion stays in the backlog with its blocker written down.

---

## Part 3 — Playing through a rest

The gap that made the original author write *"false rest detection creates bad
coaching"* and drop rests entirely. That instinct was right about the risk and wrong
about the remedy: the answer is a strict detector, not blindness.

### Design

**Keep rests in the score model.** `parse_musicxml` emits rests as
`{"is_rest": True, "beat", "duration_beats"}` instead of skipping them.
`read_score_notes_claude`'s prompt changes from "skip rests" to emitting `"r": true`
entries with beat and duration.

**Keep them out of DTW.** `flatten_score_notes` continues to yield only pitched notes —
DTW matches pitch sequences and a rest has no pitch. Rests are carried separately, as
`(measure, start_beat, end_beat)` windows.

**The detector.** `find_rest_violations(aligned, rest_windows, timeline)`: convert each
rest window to a time span via the canonical timeline, then look for confident pitched
events **inside** it.

**The gates, which are the whole design.** A naive version would fire on every note's
decay. All of these must hold:

- the event starts at least 150 ms **after** the rest begins — a note ringing into a
  rest is release, not playing
- `confidence >= 65` and `cents_spread <= 40` — the same bar as the wrong-note detector,
  because this is an equally strong accusation
- the event sustains at least 150 ms inside the window (`held_sec`)
- the rest is at least one full beat long — sub-beat rests are inside articulation noise
- at most one flag per rest window, and a global cap

**Gemini's instruction must change.** Its prompt currently says *"Do NOT flag anything
heard during rests."* That was written to stop it hallucinating over silence. It now
also blocks the one true positive we want. Narrow it: do not flag *ambient noise or
breathing* during rests, but do report *sustained playing* where the score is silent.

**Corroboration.** CREPE owns this outright, like intonation — the flag is confirmed by
construction because it rests on a measured event inside a measured window.

---

## Part 4 — Tempo against the marked tempo

### Design

**Get a number, not a string.** `tempo_marking` is currently `str(el)` of a music21
`MetronomeMark`, e.g. `"<music21.tempo.MetronomeMark Quarter=120>"`. Read `el.number`
instead and store `tempo_bpm: float | None` beside the existing text. The vision reader
returns free text like `"Allegro"` or `"♩ = 120"`; parse a leading number when one is
present, and store `None` otherwise.

**The check.** Compare `timing_report["bpm"]` (the fitted tempo, which already exists)
against the marked BPM. Report when they differ by **≥ 15 %**, once, as a global flag.

**Wording is the design decision here.** A student practising deliberately slowly has
not made a mistake, and the pipeline cannot tell practice from error. So this reports
the **fact** and does not scold: *"you played this at about 84 BPM against a marked 120."*
It is `confirmed=True` because both numbers are measured, and it is deliberately
neutral. Attempting to infer intent — string-matching the student's note for the word
"slow" — is exactly the LLM-vocabulary gating this project has already been bitten by
and must not be reintroduced.

**Gate.** Only when a numeric marked tempo exists AND `timing_report["ok"]` is true.
`"Allegro"` alone yields nothing: a tempo word is not a number, and inventing a BPM for
it would be fabrication.

---

## Part 5 — Crescendo and diminuendo

### Design

**Parse the wedges.** `parse_musicxml` currently reads `m21.dynamics.Dynamic` (static
marks). Crescendos are `m21.dynamics.Crescendo` / `Diminuendo` (`DynamicWedge`), which
carry a span. Record them as `{"kind": "cresc"|"dim", "start_measure", "end_measure"}`.
The vision reader already may return `"cresc"`/`"dim"` per note; convert a run of those
into a span rather than discarding them.

**The check.** For each wedge span, take the per-note `db` values already on the aligned
events, ordered by time, and fit a slope. A crescendo whose measured slope is flat or
negative is the finding: *the crescendo does not arrive.*

**Gates.** At least 6 notes in the span (a slope over 3 points is noise); the span covers
at least 2 measures; the flag fires when the slope is below **+1.5 dB across the whole
span** for a crescendo, mirrored for a diminuendo. Relative within the take only, exactly
as `analyze_dynamics_vs_score` already is, because absolute dBFS is a fact about mic
placement.

**Reuses the existing note-body loudness window** — the one that was fixed so
articulation stops leaking into dynamics. No new measurement primitive.

---

## Part 6 — The coverage declaration

One mechanism serving Parts 1 and 2, and anything later that cannot cover the whole
piece.

**Backend.** `analysis_quality` gains `coverage`:

```
{
  "measures_analysed": [lo, hi] | null,
  "pages_analysed":    n | null,
  "pages_total":       n | null,
  "caveats":           ["..."]      # human-readable, student-facing
}
```

**Frontend.** The gold banner built in the previous phase already renders a
`{label, text}` pair on the Analysis page and is driven by `analysis_quality`.
It gains one more case: when `coverage.caveats` is non-empty, show them. The label is
`Partial`, styled identically to the existing `Reduced` / `Video only` cases.

This is also the first thing in the product that makes `analysis_quality` do real
user-facing work beyond the fallback banner — which the Phase 1 final review correctly
graded as "not yet delivered" against the terminal-state criterion *everything
unverifiable is marked*.

---

## Verification

No corpus exists, so every claim is verified by construction:

**Coverage matrix** (`modal_worker/diagnose_coverage.py`) gains a row per new detector,
each asserting **both** directions — fires on a synthetic defect, silent on clean
playing. The silent-on-clean half is the one that matters: a detector that fires on
everything would pass a fires-on-defect test alone.

**Unit checks** (`modal_worker/test_analysis.py`) for each gate boundary, including the
false-positive cases each detector is most likely to invent:

- a note ringing into a rest must NOT flag; sustained playing in a rest must
- a repeat-free score must produce no repeat caveat
- a two-page score must number page 2 continuously, not restart at 1
- `"Allegro"` with no number must produce no tempo flag
- a real crescendo must be silent; a flat one must flag

**Falsification.** For each new threshold, one test must fail if the comparison is
inverted — the practice that caught the `contrast` gap in Phase 1.

---

## Decomposition — two plans, not one

The self-review flagged this spec as covering two separable subsystems, so it becomes
two implementation plans. Each produces working, independently testable software and
can ship on its own.

**Plan A — Precision and honesty** (Parts 1, 2, 6). Stops the analyzer being
confidently wrong: multiple score files are read, repeats are declared, and the coverage
banner tells the student what was actually examined. Ships first, because a wrong flag
costs more trust than a missing one, and because Part 6 is the mechanism Plan B would
also use if a detector ever needs to declare a limit.

**Plan B — New detectors** (Parts 3, 4, 5). Closes the three blind spots: rests, tempo
against the marking, and unrealised crescendos. Depends on Plan A only for the coverage
mechanism, and otherwise stands alone.

## Explicitly out of scope

- Repeat **expansion** (blocker documented above; stays in Backlog)
- K-weighted loudness — needs real audio to validate, already backlogged
- Polyphonic / chord-aware analysis — CREPE is monophonic; a different project
- OMR (Audiveris is installed and uncalled; either wire it up or drop it — separate)
- Any change to precision/recall *targets*; those need the corpus

---

## Risks

**The rest detector is the one that can hurt.** It is a new accusation aimed at a
moment the student believes they were silent, and the original author dropped rests
precisely to avoid it. The gates above are deliberately as strict as the wrong-note
detector's. If the coverage matrix cannot show it silent on clean playing with a decaying
note into a rest, it does not ship.

**Multi-page reading may degrade.** More images in one vision call is more to get wrong.
The mitigation is the page-continuity assertion and the coverage declaration: if page 2
does not parse, the take says so instead of pretending.

**Tempo-vs-marking will fire on deliberate slow practice.** Accepted, and the reason the
wording is neutral fact rather than correction. Revisit once the corpus can say how often
teachers reject it.
