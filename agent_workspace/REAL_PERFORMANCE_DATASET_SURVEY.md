# Real-Performance Dataset Survey — Research Only, Nothing Downloaded in Bulk

**Status: SURVEY. No new model experiments ran. No production code
touched. No dataset was bulk-downloaded — only public documentation,
one small paper PDF (356KB, already cached by the fetch), and page
text were read to verify the claims below.**

**Goal:** check whether a public dataset already has real performances
with real, confirmed mistake labels, which would avoid needing to
recruit a musician for the live-recording plan
(`REAL_MISTAKE_RECORDING_PROTOCOL.md`, 2026-11-05). Four sources
checked, in the given priority order.

---

## Summary verdict, stated first

**None of the four sources provide Tier 1 (reliable, confirmed
mistake labels) in a usable, structured form.** The closest thing —
one dataset's free-text evaluator comments that occasionally use the
phrase "a wrong note was played" — is unstructured prose with no
timestamp or measure location, and the dataset's own design was
explicitly built to AVOID containing many real mistakes in the first
place (performers re-recorded until satisfied). This is confirmed
directly from the dataset's own published paper, not inferred. The
live-recording plan from the prior round remains necessary; this
survey did not find a way to avoid it, though it surfaces one small,
optional, cheap lead worth a bounded manual pass in parallel (see
Section 5).

---

## 1. Expert and Novice Piano Performances (Zenodo 8392772)

**Source:** Jiang, "Expert and Novice Evaluations of Piano
Performances: Criteria for Computer-Aided Feedback," ISMIR 2023.
https://zenodo.org/records/8392772 (data), paper read in full:
https://archives.ismir.net/ismir2023/paper/000043.pdf

- **Content:** 83 real WAV recordings, 21 amateur pianists, 7
  beginner-level pieces, 803 evaluations (4 professional instructors +
  17 peer players per performance).
- **License (data release):** CC BY-NC-SA 4.0 — non-commercial,
  ShareAlike. Usable for internal, non-commercial R&D/evaluation; would
  need separate clearance before any commercial redistribution or
  shipping a derivative inside the paid product.
- **Scores:** 7 real MusicXML scores, already in the correct format
  this project uses everywhere.
- **Alignment:** 83 audio-to-score alignment files, one per
  recording — produced by Raphael's HMM score-follower (a real,
  published algorithm, not a hand-wave), **"with occasional manual
  corrections."** This is genuine Tier 2 material (real audio + real,
  partially human-checked, note-level timing).
- **Mistake labels — checked directly against the paper, not
  assumed:** Evaluators gave a 1-5 rating plus free-text comments. The
  comments were later coded into an annotation model with categories
  including "Note Accuracy" (sub-terms: correct note / wrong note /
  missed note / wrong octave). A real example quoted in the paper:
  *"The player didn't play the staccato notes in the left hand. No
  dynamic changes. A wrong note was played."* **This is prose, not a
  structured label** — no measure, beat, or timestamp is attached to
  "a wrong note was played" anywhere in the data as released; a human
  would have to re-listen to the specific recording to find where.
- **The decisive finding, from the paper's own text, not inferred:**
  performers "were allowed to re-record multiple times until satisfied
  with their own playing (e.g., with the preponderance of notes played
  correctly)," and the paper states explicitly: *"in this paper we
  focus on analyzing performances that are relatively 'correct' in
  terms of wrong notes."* **The dataset was deliberately curated AWAY
  from containing real mistakes.** Any "wrong note" comments that do
  exist are the exception the curation process didn't fully filter
  out, not a representative mistake corpus.
- **Tier: 2** (real audio + real, partially-verified alignment), with
  a small number of UNSTRUCTURED, low-precision Tier-1-adjacent hints
  buried in free text that would need manual extraction to use at all.

## 2. GAPS (Guitar-Aligned Performance Scores)

**Source:** https://huggingface.co/datasets/xavriley/GAPS, paper
https://arxiv.org/abs/2408.08653

- **Content:** ~300 solo classical guitar performances, 200+
  performers, ~14 hours of audio, with MIDI and MusicXML scores and
  "high-resolution note-level MIDI alignments."
- **License — CONTRADICTORY, NOT RESOLVED, do not trust either claim
  without direct clarification:** the Hugging Face dataset card shows
  an **MIT** license tag; the paper's own abstract page shows a **CC
  BY-NC-SA 4.0** badge. These are materially different (MIT permits
  commercial use freely; CC BY-NC-SA does not). Checked both pages
  directly — this is a real discrepancy in the source material, not a
  reading error on this end. **Do not rely on this dataset for
  anything until the maintainer or paper authors confirm which license
  actually applies.**
- **Mistake labels:** none mentioned anywhere in the dataset card or
  the paper abstract page. The dataset's stated purpose is alignment/
  transcription ground truth, not performance-error annotation.
- **Alignment provenance:** not stated whether automatic, manual, or
  both, and not stated how (or whether) it was verified — could not
  confirm this is even reliable Tier 2 material without reading the
  full paper (not done, since the license question already disqualifies
  it from further consideration this round without clarification).
- **Instrument:** guitar — a genuinely different family from this
  project's existing Violin/Cello/Flute, but moot given the above.
- **Tier: 2 at best, unconfirmed** — no mistake labels, license
  blocking, alignment-verification method unknown.

## 3. URMP (University of Rochester Multi-Modal Music Performance)

**Source:** https://labsites.rochester.edu/air/projects/URMP.html

- **Content:** 44 classical chamber pieces (11 duets, 12 trios, 14
  quartets, 7 quintets), each part recorded separately by a real
  player following a conducting video, then synchronized and mixed.
- **License: NOT STATED anywhere on the official page.** No license
  badge, no terms, only an NSF funding acknowledgment. Absence of a
  stated license is not permission — without an explicit grant, this
  should be treated as NOT usable without directly contacting the
  authors for permission, even for internal research use.
- **Access:** sample piece + documentation download directly; the
  full 12.5GB package requires a Google Form request — a real
  registration step, not immediate access.
- **Scores:** MIDI only (no MusicXML confirmed).
- **Mistake labels:** none. Annotations are plain pitch/note ground
  truth "for transcription, alignment, and performance analysis" —
  explicitly Tier 2 territory, and the recording METHOD itself (synced
  studio takes of parts recorded separately, following a conductor
  video) strongly suggests these are curated, largely correct
  performances by design, not a source of real mistakes at all.
- **Tier: 2 at best** (plain alignment ground truth) — and blocked
  from use here regardless, pending an explicit license grant that
  doesn't currently exist on the public page.

## 4. ASAP (Aligned Scores and Performances)

**Source:** https://github.com/fosfrancesco/asap-dataset, README read
in full.

- **Content:** ~222 piano scores by ~15 composers (Bach, Beethoven,
  Chopin, Liszt, Schubert, etc.), ~1067 performances (MIDI; ~519 also
  have audio via a separate MAESTRO v2.0.0 download + build script —
  **audio is not included directly**, an extra real step).
- **License:** CC BY-NC-SA 4.0 — same non-commercial/ShareAlike
  constraint as the Piano Evaluations dataset above.
- **Scores:** real MusicXML + MIDI, already in usable formats.
- **The one candidate error signal, checked directly and ruled out as
  Tier 1:** the `score_and_performance_aligned` flag, False for
  29-31 performances. **Confirmed from the README: this is defined
  mechanically — "True if the MIDI score and the performance have the
  same number of annotations"** — a count comparison, not a human or
  process confirming a specific mistake occurred. The README's own
  attribution ("performers skipped beats due to a mistake or
  incomplete performance") is the documentation's post-hoc
  EXPLANATION for why counts might differ, not a verified record of
  what the mistake was or where. **This is exactly the trap the
  directive warned against: a score-vs-performance disagreement from
  an automatic process, not a confirmed real mistake label.**
- **No other note-level error or mistake label exists anywhere in the
  dataset**, confirmed from the README.
- **Tier: 3** (score alignment only) — confirmed explicitly, not
  assumed.

---

## 5. Deliverable: smallest useful subset — none qualifies as a
   live-recording substitute; one small optional lead named

No source across all four meets the bar for Tier 1, structured,
confirmed mistake labels. **No dataset subset is selected as a
replacement for the live-recording plan** — none exists in usable
form at the quality this project has held itself to all week (the
same standard that ruled out treating ASAP's alignment flag, or any
automatic CREPE/DTW disagreement in this project's own prior work, as
a valid error label).

**One small, optional, near-zero-cost lead, named for completeness
but NOT a substitute:** the Expert/Novice Piano dataset's 803
evaluation comments (a 90.1KB CSV, not yet downloaded — small enough
to inspect without violating "don't bulk-download" if this lead is
pursued) likely contain a handful of comments using the literal phrase
"wrong note" or similar (the paper confirms this category exists and
gives one verbatim example). **If pursued:** download only that small
CSV, search for comments mentioning note-accuracy problems, and for
each hit, manually re-listen to the specific recording to locate the
actual mistake — the same verification discipline already specified
for live recordings. This is piano-only (no multi-instrument
coverage — nothing else surveyed here qualifies at any tier well
enough to combine with it), yields an unknown and likely small number
of usable examples (the dataset was curated away from mistakes), and
still requires real manual listening work — it does not avoid the
need for human verification, only the need to recruit a performer.

**Bottom line: the live-recording plan stands.** This survey
strengthens rather than weakens that conclusion — real, reliably
labeled mistake data is not available off-the-shelf at a quality bar
this project would trust, consistent with every other finding this
week about the gap between automatically-flagged disagreements and
genuine, confirmed performance errors.
