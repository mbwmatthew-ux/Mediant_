# Audio Pipeline Audit — Baseline (2026-10-30)

Read-only audit for docs/superpowers/plans/2026-10-30-audio-pipeline-benchmark.md.
Compiles already-measured results; nothing here was re-run.

---

## 2026-11-08 (continued): neighbor-aware cross-model gate — STOP, and an honest discrepancy worth remembering

Direct follow-up to the same-day failure classification (Category D,
alignment/neighbor mismatch, 77.4% of survivors). Built the named
corrective test: adapted `worker.py`'s own neighbor-expansion logic
(`worker.py:7580-7591`, read not modified) into the isolated
`cross_model_neighbor_gate.py` — suppress a cross-model-confirmed flag
only when the note is boundary-eligible (first/last note of a measure,
production's own deliberately narrow rule, not a looser radius) and
the confirmed competing pitch matches a neighboring measure's pitch
class.

**Real results, same 8 pieces + 6 synthetic cases:** FP note-level
191/7211 (2.65%) → 161/7211 (2.23%), only 30/191 (15.7%) suppressed —
a ~16% relative reduction. Piece-level FP unchanged, 8/8 → 8/8. Recall
held 5/6, no genuine mistake suppressed (though none of the 6 cases
were boundary-eligible, so this wasn't stress-tested by a hard case).
Overhead negligible.

**The important, honestly-stated finding:** this is far smaller than
the classification round's 77.4% implied. That round used a looser
±2-score-note radius for diagnosis; production's real rule restricts
eligibility to boundary notes only (deliberately — "every note was far
too permissive... nothing can ever be called wrong," the existing
code's own reasoning), so most flagged notes were never eligible for
this properly-scoped fix at all. The diagnostic tool and the real
corrective mechanism are not interchangeable — a genuine methodological
lesson, not a bug, and not glossed over in the report.

**Decision: STOP**, per the directive's own bar (FP must decrease
substantially — 16% relative with zero pieces cleared does not),
despite credible recall preservation and no instrument-specific
regression. Full detail: `modal_worker/cross_model_neighbor_gate.py`.

No production code touched. No new thresholds. No parameter sweep.
Regression suite green (212/212). $0 cost, CPU-only.

---

## 2026-11-08 (continued): cross-model gate failure classification — one dominant mechanism found (77.4%), GO on a named (not built) corrective test

Direct follow-up to the same-day cross-model agreement gate round
(5.99%→2.57% FP, 6/6→5/6 recall). Read-only classification of the
185-190 post-gate false-positive survivors (small run-to-run count
drift is known CREPE/torch nondeterminism) and the one lost recall
case into A-E, using the exact already-validated pipeline re-run on
the same 8 pieces — no new thresholds, no sweep, disclosed explicitly
as a narrow re-derivation of already-recorded-event detail that
wasn't persisted the first time, not a new experiment.

**A and C are provably 0% for survivors, by the gate's own logic** —
every survivor already passed a test (a confident, disagreeing CREPE
event) that is the literal negation of both. This directly answers
the directive's "determine whether absent evidence explains a
substantial share — do not assume it does": it cannot, for these 190.
Absent evidence explained the one lost recall case (confirmed
Category C, missing-frames subtype — zero CREPE events of any
confidence in the window) and the 247 originally-suppressed
candidates (not re-classified here, not asked for), but not a single
remaining false positive.

**Category D (alignment/event-association mismatch) dominates at
77.4% (147/190)** — the confirmed competing pitch matches a
neighboring score note's pitch class, the signature of alignment slop
pulling in an adjacent correct note rather than a genuine wrong-note
read. More than 5x category E (models disagree with each other,
14.2%) and category B (genuine competing-pitch convergence, 8.4%). A
real caveat stated plainly: D's test has a non-trivial chance baseline
in tonal music (diatonic passages use few pitch classes, so some
coincidental matches are expected even with zero real alignment
slop) — 77.4% is well above that rough baseline but not proof every D
case is genuine.

**Decision: one mechanism clearly dominates → GO on the smallest
corrective test, per the directive's own stated logic.** Named, not
built: suppress a cross-model-confirmed flag when its competing pitch
matches a neighboring score note — reusing
`find_wrong_note_candidates`'s own existing neighbor-expansion window
(worker.py ~7580-7591), not a new mechanism. Full detail:
`modal_worker/cross_model_fp_classification.py`.

No production code touched. No Supabase/app-recording access. No new
thresholds. No parameter sweep. Regression suite green (212/212). $0
cost, CPU-only.

---

## 2026-11-08: cross-model agreement gate — real partial FP reduction, first gate this investigation to beat "no separation found"

Owner directive permanently closed the recording-retrieval/account-
ownership/consent workstream (no Supabase access, no reopening those
topics) and redirected to a genuinely different wrong-note
verification mechanism: cross-model agreement, not another single-
model confidence/duration/context gate (both already tried, both
found ~zero separation and were correctly abandoned).

**Mechanism:** for each wrong-note candidate the Basic Pitch +
`AudioToScoreMatcher` adapter flags, independently check CREPE's own
pitch trace (`worker.run_pitch_tracking`, unmodified) over the same
time window. Only confirm the flag if CREPE's independent read ALSO
disagrees with the expected pitch — reusing the exact distance/octave
rule already used throughout this investigation, plus production's
own `MIN_CONF=65` floor on the CREPE evidence. Absence of CREPE
evidence in the window does NOT confirm a flag (only a positive
disagreeing read does) — a deliberate, conservative design choice,
consistent with the "don't flag on weak/absent evidence alone"
principle this investigation has held since the 2026-11-01
frame-level verifier work.

**Results, measured directly, $0, CPU-only:**

    metric                              before gate   after gate
    recall (6 verified synthetic cases)      6/6           5/6
    FP, note-level (8 real MusicNet pieces)  5.99%         2.57%
    FP, piece-level (same 8 pieces)          8/8           8/8

The lost recall case (piece 2295) failed on absent CREPE evidence in
the window, not CREPE disagreement — an explainable, not catastrophic,
cost. The FP reduction (more than halved) is the largest found by any
gating approach this investigation has tried. **But piece-level FP is
completely unchanged — every one of the 8 pieces would still produce
at least one false "wrong note" accusation** — and the note-level rate
(2.57%) remains roughly 23x production's own (~0.11%, same 8 pieces,
already measured this week).

**Verdict: a real, partial improvement — not forced into either a
positive or negative frame, per the directive's own explicit
instruction.** Not shippable as a standalone gate. The mechanism
(independent cross-model corroboration, as opposed to any single
model's own self-reported confidence) is validated as directionally
sound in a way nothing else attempted this investigation was. Explicit
scope limit: FP is measured on real (MusicNet) audio; recall is
measured only on synthetic injections; recall on genuinely real
mistakes remains unmeasured by this or any prior round. Full detail
and design justification: `modal_worker/cross_model_agreement_gate.py`.

No production code touched. No Supabase access of any kind this
round, per the directive permanently closing that workstream.
Regression suite green (212/212).

---

## 2026-11-05: authorized Storage access confirmed for the owner's own 92 takes — the tooling gap closes, pending the owner's own login

Direct follow-up to the account-ownership round, which found no
Storage-level credential existed in this environment to actually read
file content even for the 92 confirmed-owner takes. This round checked
whether the APP ITSELF already provides an authorized route — it does.

`src/pages/Analysis.jsx:947-950` already calls
`supabase.storage.from('recordings').createSignedUrl(take.video_path, 7200)`
under the viewing user's own session to play their recording back.
The live RLS policy behind it (`"Users can read own recordings"`,
checked directly against production via `pg_policies`, not just the
migration source) is active and unchanged: `bucket_id='recordings'
AND (storage.foldername(name))[1] = auth.uid()::text`. This grants the
account owner full, already-working, RLS-respecting access to their
own files — no service-role key, no bypass, nothing new to build.

Wrote `modal_worker/export_owner_clarinet_takes.py`: signs in with the
owner's own credentials (local prompt only, never seen by this
agent), queries only their own takes, downloads via the same signed-
URL call the app already uses, and runs the existing, unmodified
`worker.extract_audio_from_video` to produce local WAVs. Dependencies
verified directly (ffmpeg present locally, `requests` and the
`worker.py` import both confirmed in the existing venv); the
interactive sign-in was not exercised, since it needs the owner's own
password. 53 eligible takes re-confirmed (40 labeled Clarinet).

**The Storage-access gap is resolved as a matter of WHO can act, not
WHAT access exists** — the owner, not this agent, needs to run the
script with their own login before any of the 53 takes can actually
be inspected, labeled, or evaluated. Full detail:
`agent_workspace/OWNER_CLARINET_RECOVERY_ACCESS.md`.

No production code changed. No service-role key created or used. No
RLS bypass. No recording content accessed by the agent. No
third-party take queried.

---

## 2026-11-05: production account ownership verification — overturns its own premise, confirms the consent gap with account-level evidence

Direct replacement for the consent-policy-drafting round, premised on
checking whether the 34 take-owning accounts might be internal test
accounts (which would have made a consent mechanism moot). **Checked
with real evidence instead of assuming: they are not, mostly.**

Of 34 accounts: 1 (92 takes) confirmed the owner's own by exact email
match; 1 (84 takes) explicitly unresolved and NOT cleared (no display
name, not a test-pattern address, not provably the owner); the
remaining 32 (56 takes) are clearly distinct real individuals,
including real school-domain accounts in three different countries.
`teacher_students` is empty production-wide, ruling out a
shared-upload explanation. **140/232 takes (60%) remain real users'
private data**, confirming rather than contradicting the immediately
prior round's consent-gap finding.

For the 92 cleared takes: all video, single-instrument (Clarinet),
and blocked from further inspection by a genuine tooling gap, not a
policy one — no Storage-level credential exists anywhere in this
environment, checked directly, none created. The existing
`extract_audio_from_video` (`modal_worker/worker.py:557`) is named as
the correct reuse target once file access exists. Selection (Task 3)
and evaluation (Task 4) were explicitly not attempted, per the
directive's own instruction to stop rather than rush past unready
labeling. Full detail:
`agent_workspace/PRODUCTION_ACCOUNT_OWNERSHIP_VERIFICATION.md`.

No audio/video content accessed. No new credentials created. No
production changes.

**Same-day update:** the owner recalled signing into the flagged
84-take account via Google. Checked directly against `auth.identities`
— that account has only an `email`-provider identity (no Google
identity at all), and a full sweep of every `provider='google'` row in
production shows exactly one account mapping to the owner's email
under any provider, already the confirmed 92-take one. **The owner's
recollection does not hold for this account; it stays unresolved and
not cleared. Owner-owned total unchanged at 92.**

---

## 2026-11-05: production takes inventory + consent check — real data exists, real consent gap found, not used

Third real-data attempt the same day (after the live-recording plan
and the public-dataset survey, both of which concluded no usable
substitute existed). This one checks the project's OWN production
data, with the highest privacy bar of anything touched this week.

**Access**: the Supabase CLI already authenticated in this
environment (`supabase db query --linked`, Management API) was used
for read-only aggregate queries only — `COUNT`/`GROUP BY`, never a row
or a file. No service-role key or new credential was created. Storage
access (actual audio/video bytes) was not attempted and is not
reachable from here without a credential this task explicitly forbade
setting up — a real, reportable access limit, not a workaround.

**Real counts**: 232 total takes (34 distinct users, up from the
~199 previously reported), 204 succeeded, 63 have both instrument and
score metadata present. `duration_seconds` exists as a column but is
populated in exactly 0 of 232 rows. `flag_annotations` (teacher-
verified human labels) is still 0 — the 2026-10-11 audit's finding
holds even after 33 more takes. **90% of all takes (208/232) are
video, not audio** — more identifying than anything else this
investigation has worked with.

**The decisive finding**: `src/pages/Privacy.jsx`'s actual stated
consent covers use "to improve Mediant's analysis accuracy (aggregate
and anonymised only)." A human reviewer individually annotating one
specific, identifiable (often video) take is neither aggregate nor
anonymized — that use case is not covered by what users were told.
Per the directive, this inventory finding was NOT stretched into
permission to select or review individual takes — Task 2 did not run.

**Decision**: do not use production takes for individual-review
annotation without an explicit Privacy Policy update or specific
informed consent — a deliberate product/legal call for the owner, not
an engineering one. The live-recording plan
(`agent_workspace/REAL_MISTAKE_RECORDING_PROTOCOL.md`) remains the
smallest practical path with no such consent gap, since the performer
is the consenting party. Full detail:
`agent_workspace/PRODUCTION_TAKES_INVENTORY_AND_CONSENT_CHECK.md`.

No production code touched. No private recording content accessed,
downloaded, or exposed.

---

## 2026-11-05: real-performance dataset survey — no public substitute found for the live-recording plan

Direct follow-up to the same day's recording-protocol round. Checked
four public datasets (Expert and Novice Piano Performances/Zenodo
8392772, GAPS, URMP, ASAP) against this project's own standard for a
valid mistake label — the same standard already applied all week to
this project's own synthetic injections and to production's detector:
a human or process must have actually CONFIRMED a specific mistake,
not merely flagged a disagreement between recording and score.

**None qualify.** Expert/Novice Piano's own ISMIR paper states
directly that performers re-recorded "until satisfied... with the
preponderance of notes played correctly" and that the paper analyzes
performances "relatively correct in terms of wrong notes" — the
dataset was built to AVOID mistakes, not capture them. Its free-text
comments occasionally mention a wrong note in prose, with no
timestamp — Tier 2 (real audio, real partially-corrected alignment),
not Tier 1. ASAP's one candidate signal
(`score_and_performance_aligned=False`) was confirmed, from its own
README, to be a mechanical count comparison — not a confirmed
mistake — Tier 3. GAPS has an unresolved license contradiction (MIT
vs. CC BY-NC-SA 4.0) and no mistake labels. URMP has no stated license
at all and no mistake labels.

Full detail, including per-source access/license/annotation findings:
`agent_workspace/REAL_PERFORMANCE_DATASET_SURVEY.md`. No code written,
no bulk downloads, no production impact. The live-recording plan
(`agent_workspace/REAL_MISTAKE_RECORDING_PROTOCOL.md`) remains the
smallest justified path to real, trustworthy mistake-labeled data.

---

## 2026-11-05: real-mistake recording protocol — plan only, no measurement to report

Direct follow-up to the same day's contextual-verification round,
which recommended collecting real, labeled performance errors before
any further model development (the synthetic injection methodology was
confirmed to bake in at least one real confound — injected notes can
never be octave-equivalent to nearby context, by the gate's own
construction). This entry is a pointer, not a results section: the
full plan — selected pieces (2288 Violin, 2202 Flute; polyphonic Piano
checked and found not currently feasible with existing tooling),
12-recording protocol, manifest schema, storage location, and the
exact reuse plan for evaluating real recordings against production's
`find_wrong_note_candidates` and the Basic Pitch + `AudioToScoreMatcher`
adapter once they exist — lives in
`agent_workspace/REAL_MISTAKE_RECORDING_PROTOCOL.md`. No code was
written, no audio was recorded, no experiment ran. Nothing here
changes any measured result above; it specifies what would need to
happen before the picture built this week could be checked against
real (not synthetic) mistakes.

---

## 2026-11-05 (read-only): contextual verification feasibility — a real confound caught, no concrete signal, recommend real labeled data

Direct follow-up to the same day's confidence/duration gate round
(STOP, no credible separation on amplitude or duration). This round
asks a different question on the same 6 TP / 432 FP events: does
CONTEXT — neighboring notes, overlapping pitch activity, harmonic
relationships, temporal consistency — separate genuine substitutions
from Basic Pitch's own extraction noise? Explicitly read-only; the
directive forbade implementing anything this round regardless of
outcome.

**Disclosure on data provenance, as the directive required.** The
confidence/duration round persisted only aggregate statistics and the
6 individual true-positive printouts — the 432 false positives' own
per-event identity (which score note each one attaches to) was never
written to disk. Examining context required knowing that identity.
Recovered it by re-running the exact same deterministic, already-
twice-executed alignment + adapter pass (`AudioToScoreMatcher` +
`basic_pitch_score_adapter.detect_wrong_notes`) over already-stored
raw data — no new Basic Pitch extraction, no new audio processing, no
new injections, $0 cost. Stated here rather than done quietly, per the
directive's explicit instruction.

**Three contextual properties examined, computed directly from
already-stored data (no further re-inference for any of these):**

**1. Overlapping (simultaneous) pitch activity** — does more than one
Basic Pitch pitch sound at the same time as the flagged event, in
Basic Pitch's own output. **FP: 364/432 (84.3%). TP: 3/6 (50%).** A
real directional difference, but not clean — half the genuine
substitutions studied here ALSO show overlapping activity, so this
property alone could not gate out the bulk of false positives without
losing a large fraction of true positives even in this tiny sample.

**2. Harmonic relation to a nearby expected pitch** (octave or
fifth/fourth) — the starkest-looking number, but a real confound was
caught before trusting it. **FP: `{'fifth/fourth': 219, 'none': 149,
'octave': 64}` (283/432 = 65.5% show some relation). TP: 0/6 show any.**
Checked `inject_audio_mistakes.verify_injection`'s source directly: its
own "unambiguous" validity gate
(`_expected_pitch_classes_for_measure`) REJECTS any candidate injection
whose substitute pitch CLASS already matches one expected nearby —
which includes octave-equivalent substitutes by construction (same
pitch class, mod 12). **The 6 true positives are therefore guaranteed,
by the injection methodology's own design, to never show the octave
relation — this is not independent evidence about genuine wrong notes
in general, and is disclosed as a confound rather than reported at
face value.** The fifth/fourth component (219/432 = 50.7% of FPs) is
NOT excluded by that gate (it only tests exact pitch-class equality,
not a fifth/fourth interval) and so IS a genuine, if extremely
small-sample (n=6), directional observation: none of the 6 real
substitutions examined landed a fifth/fourth from a nearby expected
pitch, while half of all false positives do.

**3. Temporal consistency** (gap in seconds to the nearest neighboring
Basic Pitch event, before/after) — **no separation.** FP gaps range
-1.313s to +1.220s (mean -0.06s; 473 of 856 measured gaps are
NEGATIVE, meaning the neighboring event actually overlaps in time —
itself a sign of a messy local detection, consistent with finding #1).
TP gaps range -0.39s to +0.12s, sitting entirely INSIDE the FP range.
No distinguishing pattern.

**Combined candidate, one hypothesis as the directive asked for:**
false positives more often coincide with COMPETING pitch evidence near
the flagged note — either literally simultaneous (finding #1) or
harmonically adjacent (the unconfounded half of finding #2) — than the
6 genuine substitutions examined do. This is directionally present
across two largely-independent signals, but it is **not concrete**:
50% of true positives still show overlapping activity, and n=6 — with
one real construction confound already found and set aside — is
nowhere near enough to fit, validate, or trust a rule built on it.

**Decision: do not prototype from this data.** Per the directive,
propose the smallest justified next action rather than inventing a
mechanism to keep the thread alive: **collect a small set of real,
labeled performance errors (actual musicians' actual mistakes, not
synthetic pitch-shift injections) before any further contextual-
verification model development.** The synthetic injection methodology
itself is now confirmed, directly, to bake in at least one property
(no octave-adjacent substitutes) that would make a model trained or
validated only on it blind to an entire class of real wrong notes.
That is a structural limitation of the test data available in this
investigation, not a limitation of any detector design tried so far.

No production code touched; `worker.py` unaffected. Regression suites
green (212/212). $0 cost throughout.

---

## 2026-11-05: confidence/duration gate feasibility — STOP, no credible separation found

Direct follow-up to the 2026-11-04 second round, which found the
Basic Pitch + `AudioToScoreMatcher` adapter got 6/6 recall (vs
production's 0/6) but at 5.99% false-positive rate (432/7211 notes,
8/8 control pieces), and named a confidence/duration gate on Basic
Pitch's own note events as the specific next step — not built that
round. This round tests exactly that, nothing more.

**Task 1 — pull apart the actual TP/FP evidence, verify field
semantics, don't assume.** Checked Basic Pitch's "amplitude" field
directly against its source (`basic_pitch/note_creation.py`): it is
computed as `np.mean(frames[note_start_idx:i, freq_idx])` — the MEAN
of the model's own per-frame note-activation probability (0-1) over
the detected note's duration, at its pitch's frequency bin. Confirmed
NOT loudness/velocity, and NOT on CREPE's periodicity-based confidence
scale (0-100) — a genuinely different quantity, checked rather than
assumed compatible.

Re-extracted Basic Pitch events (both the 8 control pieces and the 6
injected cases) to capture this field, which the prior round's
extraction discarded. Extended `basic_pitch_score_adapter.py`'s
`detect_wrong_notes` additively (new output fields only:
`played_perf_idx`, `played_amplitude`, `played_duration_sec`,
`played_onset_sec`, `pitch_distance_semitones`) to expose this
information per note — `worker.py` untouched throughout.

**Duplicate check, explicitly asked for: answered cleanly.** Grouped
all 432 false-positive flags by `(piece, played_perf_idx)`. **All 432
correspond to 432 DISTINCT underlying Basic Pitch events — zero
duplicates, zero score notes independently nominating the same
performed event.** The prior round's "54x production's rate" finding
is confirmed real, not an artifact of double-counting one noisy event
multiple times.

**Task 2 — feasibility check on DEVELOPMENT data only, n=6 TPs vs
n=432 FPs. No credible separation on either axis:**

    metric       TP (n=6) range      FP (n=432) 10th / 50th / 90th pct
    amplitude    [0.513, 0.674]      0.367 / 0.521 / 0.669
    duration(s)  [0.152, 0.534]      0.151 / 0.232 / 0.510

The TP range sits almost entirely INSIDE the FP distribution's middle
80% on BOTH axes. TP amplitude's own minimum (0.513) is below the FP
population's median (0.521) — more than half of all false positives
have HIGHER amplitude than the weakest true positive. TP duration's
minimum (0.152s) sits right at the FP's 10th percentile (0.151s), and
its maximum (0.534s) exceeds the FP's 90th percentile (0.510s). **No
single threshold on either field could meaningfully reduce the 432
false positives without also cutting several of the 6 true
positives.** Per-instrument FP breakdown (for context, not a gate
candidate): Flute n=82 (amplitude mean 0.556), Cello n=336 (0.506),
Violin n=14 (0.590) — amplitude doesn't cleanly separate by instrument
either; Cello carries the overwhelming majority of false positives in
absolute count, consistent with it being the dominant instrument in
this 8-piece dev set (5 of 8 pieces), not evidence of an
instrument-specific confidence difference.

**Decision: STOP, per the directive's own explicit instruction** ("if
there's no credible separation, STOP here — do not implement a filter
just because you built this far"). **No gate was implemented.** Tasks
3 (implementation + re-validation) and 4 (GO/STOP on an integrated
gate) were not executed, because there was nothing credible to
implement or validate — proceeding would have meant fitting a
threshold to 6 data points with no real separation, i.e. overfitting
exactly as the directive warned against.

Dev/control piece disclosure (asked for, answered even though Task 3
didn't run): the 8 dev pieces used here (2202/2203/2217/2221/2288/
2293/2294/2295) do NOT overlap with the frozen 6-piece set
(2204/2218/2222/2297/2244/2289) opened in an earlier round — no
held-out integrity concern applies to this round's (non-)result.

No production code touched; `worker.py` unaffected. Regression suites
green (212/212). $0 cost, CPU-only throughout.

---

## 2026-11-04 (second round): Basic Pitch + AudioToScoreMatcher wrong-note adapter — the bug from round one, fixed; real progress, not yet a GO

Direct follow-up to the same day's first round (Basic Pitch extraction
GO, wrong-note detection NO-GO via `AutomaticNoteMatcher`'s deletion-
before-distance-check behavior). This round builds the exact fix that
finding named as unbuilt.

**Task 1 — verify the mechanism with code, not assumption.** Read
Parangonar's actual source rather than re-testing blindly.
`AutomaticNoteMatcher`'s fine-grained stage
(`SequenceAugmentedGreedyMatcher.__call__`, `matchers.py:139-146`)
groups BOTH the score and performance note arrays by EXACT PITCH VALUE
before any matching happens at all:
```python
score_pitches = np.unique(score_note_array["pitch"])
for pitch in score_pitches:
    score_notes = score_note_array[pitch == score_note_array["pitch"]]
    performance_notes = performance_note_array[pitch == performance_note_array["pitch"]]
```
Matching then only ever happens WITHIN a pitch bucket, by nearest onset
order. A performance note of a different pitch than its true score
counterpart is therefore invisible to it by construction — it surfaces
as an "insertion" wherever a score note of ITS OWN pitch happens to
exist nearby (or not at all), while the true score note becomes a
"deletion," always, regardless of timing. This is the exact, now
source-confirmed mechanism behind round one's 0/6 recall.

`AudioToScoreMatcher` (verified via `audio_matchers.py::_path_to_alignment`,
lines 340-350) is the opposite in exactly the needed way:
```python
for note in score_note_array:
    sid = note["id"]
    s_onset = note["onset_beat"]
    p_time = float(predicted_stime_to_ptime_map(s_onset))
    alignment.append({"label": "match", "score_id": sid, "performance_time": p_time})
```
Every score note, unconditionally, gets a `performance_time` from pure
time-interpolation over the DP's backtracked path — pitch is never
read in this step. Confirmed: this is exactly the pitch-independent
timing localization the adapter needs.

**Task 2 — adapter built, `worker.py` untouched.**
`modal_worker/basic_pitch_score_adapter.py`. Pipeline: `AudioToScoreMatcher`
gives timing only; for each score note, the nearest-in-TIME Basic
Pitch event (selection is by time proximity ONLY, never by pitch) is
located inside a window bounded by the neighbouring score notes' own
predicted times (capped at 0.5s); the distance/octave gate — same rule
`find_wrong_note_candidates` uses (>=2 semitones, non-octave), reused
verbatim rather than duplicated, since that function's own signature
assumes CREPE-specific confidence/spread/duration fields Basic Pitch's
notes don't carry in the same form — is applied only AFTER association,
never as a precondition for it. Score notes with no Basic Pitch event
in their window are classified `"deletion"` and reported, never
dropped; Basic Pitch events claimed by no window are classified
`"insertion"` and reported, never dropped.

**Task 3 — real measurement, same cases as round one, nothing
manufactured.** `modal_worker/basic_pitch_adapter_eval.py`. Per the
directive: raw counts only, n=6 positive / n=8 control, too small to
extrapolate a percentage from.

Negative/control cases (8 unmodified pieces, 7211 notes):

    condition                 pieces flagged   note-level FP
    non-oracle (real align)   8/8              432/7211 (5.99%)
    oracle (diagnostic only)  8/8              470/7211 (6.52%)
    production (same 8)       3/8              8/~7211 (~0.11%)

Oracle and non-oracle are CLOSE (5.99% vs 6.52%) — a meaningfully
different signal from round one's frame-level verifier, where oracle
timing nearly DOUBLED the false-positive rate. Here, the false
positives are not primarily an alignment-timing artifact; they trace
mostly to genuine Basic Pitch extraction noise inside each note's
search window — consistent with Basic Pitch's own measured note
precision of 0.796 (the extraction round's own number: ~20% of its
notes are wrong before any detection logic ever runs). 1542 Basic Pitch
events across the 8 pieces were never claimed by any window
("insertions") — reported, not dropped.

Positive cases (6 verified `wrong_pitch` injections, RAW COUNTS):

    recall (non-oracle, the GO/STOP number):   6/6
    recall (oracle, diagnostic only):           6/6
    production's recall, SAME 6 cases (fresh):  0/6
    measure localization among detections:      6/6 (by construction)

Every one of the 6 detections also carried 14-82 OTHER substitution
flags in the SAME take — the true positive is real but never isolated;
it arrives inside genuine noise, consistent with the ~6% note-level FP
rate above. Latency: alignment ~0.9-6.1s/piece (Parangonar's own
spectrogram+DP cost, already known from round one), detection logic
~3ms/piece (pure numpy). Peak traced memory, one representative piece:
351MB.

**Task 4 — decision: real progress, NOT YET a GO.** The recall result
(0/6→6/6, with production at 0/6 on the identical cases) is the
strongest wrong-note-detection result this entire investigation has
produced. But the false-positive rate (5.99%, ~54x production's own
~0.11%) is still too high against this exact feature's own deliberately
strict design bar (`find_wrong_note_candidates`'s own stated principle:
a false "wrong note" accusation against correct playing costs more
trust than a missed one). **Specific remaining mechanism, confirmed not
guessed:** the oracle≈non-oracle FP parity rules out alignment error
and rules out the matcher-design bug (both already eliminated as
causes, this round and last) — the bottleneck is Basic Pitch's own
per-note noise inside the search window. **Recommendation, named not
built, per "do not build a fallback algorithm or start a new model
search regardless of outcome":** add a confidence/duration gate on
Basic Pitch's own note events (analogous to production's existing
`MIN_CONF`/`MIN_DUR_SEC` gates on CREPE events, which this adapter does
not yet apply) to filter weak Basic Pitch detections before the
distance gate runs, before any further integration attempt. Not built.
No production code touched across Tasks 1-4; `worker.py` unaffected.
Regression suites green (212/212).

---

## 2026-11-04: Basic Pitch note-extraction feasibility — extraction wins decisively, wrong-note detection hits a specific, confirmed stop condition

New owner directive, bounded: does Spotify's Basic Pitch fix CREPE's
diagnosed dense-passage over-generation bottleneck (e.g. piece 2241:
912 CREPE events vs 608 real notes, confirmed dominant on 9/12 dev
pieces)? Not a repeat of the benchmark-repair or alignment-diagnosis
work (already done) — a genuinely new tool test, one bounded pass,
stop immediately on either failure condition.

**Setup, a real compatibility note worth keeping.** `pip install
basic-pitch` into the main validation venv (Python 3.13) failed:
basic-pitch requires `tensorflow-macos<2.15.1` on macOS with
Python>3.11, and that constraint has no wheel for 3.13 (pip tried to
build numpy from source and hit a Python-3.13-incompatible
`pkgutil.ImpImporter` reference and failed). Created a sibling
isolated venv, `venv_basic_pitch` (Python 3.11, via Homebrew), still
fully separate from production. On THAT exact Python version,
basic-pitch's own dependency markers skip the TensorFlow requirement
entirely and it uses its CoreML backend instead — no TensorFlow
install was actually needed, and inference is on-device, CPU/Neural-
Engine only. $0 cost confirmed, no GPU, no API calls, throughout.

**Stop condition 1 (note extraction) — cleared decisively.** Compared
Basic Pitch against CREPE (`worker.run_pitch_tracking`, unmodified) on
identical audio, the same 8 real MusicNet dev pieces, 7387 real notes,
scored via `note_sequence_evaluator.align_note_sequences` (unmodified).
**A real bug was caught and fixed before trusting any number**: Basic
Pitch's raw `note_events` output is NOT returned in time order
(verified directly — confirmed real, not assumed); the DP evaluator
requires monotonic input, so an unsorted feed silently produced
near-zero onset scores and badly wrong precision/recall on the first
run. Explicit sort by `time_sec` fixed it.

    metric                  Basic Pitch   CREPE
    note precision          0.796         0.531
    note recall             0.843         0.706
    event over-generation   1.059x        1.329x   <- the diagnosed bottleneck
    octave errors           135           289
    wrong_pitch             442           1615
    deletions               583           269
    insertions              1016          2700
    latency/piece           1.1-2.2s      3.1-6.2s

Basic Pitch wins on every headline metric. The one metric where CREPE
"wins" (fewer raw deletions) is explained, not contradictory: CREPE's
over-generation means it plants a candidate near almost every real
note, but a much larger share of what it finds carries the wrong pitch
(26.7% of CREPE's matched pairs vs 8.5% of Basic Pitch's) — the
wrong-pitch penalty dominates, so Basic Pitch's overall recall still
comes out higher. **Per-instrument, Basic Pitch wins precision AND
recall on all three** (Flute 0.884/0.829 vs 0.655/0.784; Cello
0.757/0.827 vs 0.477/0.645; Violin 0.850/0.976 vs 0.584/0.887) — not a
single-instrument fluke.

**Step 7 (alignment) — Basic Pitch's notes beat CREPE's through the
same matcher, but both trail raw audio.** Task 1's
`pa.AudioToScoreMatcher` (2026-11-01) takes RAW AUDIO — it computes its
own spectrogram internally and cannot consume a pre-extracted note
list, so it is not the right reuse target for "feed Basic Pitch's
OUTPUT into Parangonar." `pa.AutomaticNoteMatcher` is parangonar's
symbolic score-note-to-performance-note matcher, built for exactly
this input shape — verified its exact field requirements directly
against its source rather than guessing (partitura's own
`note_array()` returns the literal string `"None"` for every note's
`id`, which would silently break the matcher's id-based bookkeeping —
unique ids assigned before calling it). Scored with the SAME
`classify_alignment`/`nearest_ground_truth_measure` convention every
other alignment candidate in this investigation used:

    piece   instr    BP %correct   CREPE %correct
    2202    Flute    89.5%         86.1%
    2203    Flute    77.2%         79.5%   <- only piece CREPE wins
    2217    Cello    78.0%         51.7%
    2221    Cello    93.1%         76.8%
    2288    Violin   97.5%         91.1%
    2293    Cello    91.3%         73.9%
    2294    Cello    81.5%         76.3%
    2295    Cello    82.0%         71.6%
    AVERAGE          86.3%         75.9%

Basic Pitch wins 7/8 pieces, often by a wide margin (2217: +26.3pt;
2293: +17.4pt), confirming the extraction-quality gap translates into a
real alignment-quality gap. **But both still trail Task 1's raw-audio
result on these same pieces (~95.6%).** Working directly on the
continuous audio signal remains more robust for alignment than any
discrete-note symbolic matcher, regardless of which extraction
front-end feeds it — a real, useful negative result in its own right.

**Stop condition 2 (wrong-note detection) — triggered, a specific,
confirmed mechanism, not a vague "didn't work."** Tested ONLY the 6
verified `wrong_pitch` injections that actually exist (2 from
2026-11-01 + 4 from 2026-11-04's expansion) as positive cases, and the
8 unmodified pieces as negative controls — nothing manufactured, per
the directive. Detection logic: since `AutomaticNoteMatcher` already
gives an explicit 1:1 score-note-to-performance-note pairing, a "wrong
note" should just be a matched pair whose pitch distance is >=2
semitones and non-octave (the same distance/octave rule
`find_wrong_note_candidates` uses, applied directly since no
measure-level ambiguity exists once a direct pairing exists).

**Result: 0/6 detected, 0/8 pieces false-flagged — zero flags of any
kind on BOTH sides.** That is not "perfectly clean" — it is the
signature of a detector that can never fire. Confirmed directly by
inspecting the raw alignment for case 1 (piece 2288, score index 41,
true pitch 69, injected to 65): `AutomaticNoteMatcher` labels that
score note `"deletion"` — the EXACT SAME label it would give a note the
performer never played at all. **The matcher's own internal
pitch-aware cost function refuses to produce a "match" when pitch
distance is large, routing a genuinely-wrong-pitch performance note
into the same bucket as a missing note before any distance-gate logic
downstream ever sees it.** This is a structural property of a matcher
built for expressive-performance alignment (assumes the performance is
mostly pitch-correct), not a threshold that tuning could fix.

Not the same failure mode as the 2026-11-01/11-04 frame-level verifier
(which anchors on `AudioToScoreMatcher`'s raw-audio TIME alignment,
independent of pitch matching, and failed on CREPE's own frame-level
continuity artifacts). Basic Pitch's discrete note+pitch-bend output
isn't a drop-in substitute for CREPE's per-frame pitch/confidence
surface that architecture needs, so that approach can't be reused here
without building something new either.

**Recommendation, named not built, per "do not automatically try more
variations":** a wrong-note detector built on Basic Pitch's notes would
need either (a) `AudioToScoreMatcher`'s time-based alignment paired
with a separate distance-gate against Basic Pitch's own per-note pitch
at each aligned time (bypassing `AutomaticNoteMatcher` entirely), or
(b) explicit insertion/deletion-pair inference (a deleted score note
and an unrelated inserted performance note at the same time, inferred
as one wrong note rather than two separate errors). Neither attempted.

**Overall verdict: extraction is a real, reusable, strong finding —
Basic Pitch is a materially better note-extraction front-end than CREPE
on every axis measured (precision, recall, over-generation, octave
errors, speed). Wrong-note detection via the one bounded mechanism
tested here is NO-GO, for a specific, named, structural reason, not a
noise/threshold problem.** No production code touched; `worker.py`
unaffected throughout. Regression suites green (212/212).

---

## Task 1 (2026-11-01, "Score-Conditioned Audio Verification Feasibility"): Parangonar — the strongest alignment result in this entire investigation, with two real caveats

Tested a third audio-to-score alignment candidate: Parangonar
(`AudioToScoreMatcher`, Apache-2.0, CPJKU/Silvan Peter — verified
directly: installed version 3.4.1, license file matches GitHub,
installed into the isolated validation venv only, zero production
dependency change). Unlike the prior sprint's chroma/CQT experiment
(chroma-folded, loses octave information), Parangonar's elastic DP runs
over an 88-bin full-pitch-resolution log-frequency spectrogram — a
materially different internal representation, not just a different
cost function on the same folded features.

**Real MusicNet audio+score, 13 pieces (9 prior dev pieces + the 4
directive-named failure cases), scored with the SAME
`classify_alignment`/`nearest_ground_truth_measure` machinery already
used for the other two candidates:**

```
piece  instr   current(DTW)  chroma-DTW              parangonar
2293   Cello    82.5%         88.7%                   94.6%
2295   Cello    83.2%         85.3%                   95.9%
2220   Cello     0.4%         66.8%                    2.0%  <- still broken
2242   Violin   49.8%         78.3%                   92.7%
2296   Cello     2.0%         80.1%                   54.6%
2244   Violin   89.6%         47.1% (chroma REGRESSED) 96.4%  <- fixes exactly what broke chroma
(7 more dev pieces, no prior individual baseline)       95.9%/94.6%/97.0%/95.9%/1.6%/99.2%/95.9%
```

**10 of 13 pieces land at 92.7-99.2% — the largest, most consistent
alignment improvement found in this whole investigation**, including
2244, the exact piece where the chroma/CQT experiment regressed
severely — Parangonar's failure mode there is independent of both
known prior defects (discrete-event DTW's algorithm defect, and
chroma's fixed-tempo-resolution desync).

**Two real, uninvestigated problems remain, reported honestly rather
than smoothed over:**
1. **2220 (2.0%) and 2296 (54.6%)** — better than the current pipeline,
   but worse than chroma-DTW on these two specific pieces. Not chased.
2. **2241 (1.6%) — a NEW catastrophic failure, not seen in either prior
   candidate.** 314/498 notes classified "wrong" (not "unmatched") —
   the dominance of "wrong" over "unmatched" suggests a global desync
   rather than local difficulty (plausible, unconfirmed mechanism: a
   repeat MusicNet's real performance omits or adds, which the elastic
   DP's bounded stretch parameter can't recover from). 2241 was one of
   the 9 pieces that reached 90-100% under the prior sprint's
   perfect-ground-truth-input diagnostic — this is a genuinely new
   problem, not a recurrence of an already-known one.

**Held-out test integrity — a real constraint found this task, not
worked around.** Checked directly against MusicNet's own metadata:
this project has already downloaded and used **every one of the 24
monophonic solo Violin/Cello/Flute pieces in the entire MusicNet
corpus** — the 18 held-out, the 4 excluded-by-sanity-check, and 2
designated dev/tuning pieces (`2186`/`2219`) used throughout this
project's history. **No genuinely fresh monophonic piece remains** to
serve as a new frozen subset for Task 3's final confirmation; the only
unused MusicNet pieces are 156 Solo Piano recordings — a different,
polyphonic instrument class, not a drop-in substitute, out of scope to
introduce without separate authorization. A real fresh frozen set would
require downloading additional MusicNet audio beyond the local cache
(free, same public dataset, just more of it) — not done this round.

Committed: `modal_worker/parangonar_alignment_experiment.py`. No
production code touched — `worker.py` unaffected. Regression confirmed
clean: `test_analysis.py` 727/727. $0 spend, CPU-only (parangonar's
elastic DP runs ~1-16s/piece on CPU, no GPU).

## Task 2 (2026-11-01, "Score-Conditioned Audio Verification Feasibility"): frame-level verifier — NOT a GO, false positives worse than production

Prototyped a verifier that works from raw CREPE frame-level evidence
inside a time window anchored by Task 1's Parangonar alignment, instead
of requiring a clean discrete CREPE event sequence first (the thing
that has failed repeatedly this session — CREPE over-generates events
on dense passages, already tried and abandoned 4 ways). For each
expected score note: gather confident (periodicity >= 0.45, same bar as
production's `CONF_THRESHOLD`) CREPE frames inside the window; check for
sustained (>= 0.08s, same floor as production's `MIN_DUR_SEC`) evidence
for the expected pitch; if absent, check for sustained confident
evidence for some OTHER specific pitch (excluding octaves of the
expected one, reported separately as "unverifiable" per the directive's
hard constraint against flagging on weak-expected-evidence alone).
Built as `modal_worker/score_conditioned_verification_prototype.py`
(commit `09b8039`), reusing `worker._instrument_pitch_bounds` and the
production CREPE parameters (16kHz, 40ms hop, model="tiny",
weighted_argmax) for frame extraction, and the already-repaired
`inject_mistake_verified` for ground-truth mistake injection — `worker.py`
itself not modified.

**Test set**: 8 dev pieces where Task 1 measured Parangonar alignment at
92.7-99.2% (2202, 2203, 2217, 2221, 2288, 2293, 2294, 2295) — deliberately
excludes 2220/2242/2296/2244/2241 (Parangonar's own alignment is weak or
broken there, so a detection failure would conflate alignment error with
verification error) and the frozen 6 (already opened, non-blind).

**Recall**: of 8 pieces, only 2 (2288, 2294) produced any `wrong_pitch`
injection the existing `inject_mistake_verified` gate accepts as valid
(acoustically recognizable + musically unambiguous) within 8 attempts
each — the other 6 fail the same "not acoustically recognizable" gate
already documented in the P0 sprint's Task 3, a known limitation of the
pitch-shift injection methodology itself, not a new finding this round.
Of the 2 valid cases: **2/2 detected (100%)**, a real improvement over
production's already-measured 0/18 — but n=2, far too small to
generalize from, drawn from exactly the subset the injection methodology
happens to tolerate.

**False positives** (all score notes, unmodified correct audio, 8 pieces,
7211 total notes): **8/8 pieces had at least one false "wrong_note" flag
— WORSE than production's already-measured 9/18 (50%)** at the same
piece-level granularity. Note-level false-flag rate with a fixed
+/-0.2s evidence window: 18.78% (1354/7211).

**One decisive diagnostic, not a tuning cycle.** The fixed-window
false-positive rate looked attributable to window bleed into
neighboring notes on dense passages — average inter-note spacing on
these pieces is close to 0.2s, so a fixed +/-0.2s window routinely
captures the ADJACENT correct note's own frames. The same shape of bug
as the chroma/CQT sprint's fixed-frame-resolution regression on fast
pieces. Tested the obvious, principled fix: bound each note's evidence
window by its neighbors' own aligned times instead of a fixed radius
(`note_window` in the committed file). **Result: the false-positive rate
got WORSE, not better** — note-level FP rose to 28.57% (2060/7211);
piece-level stayed 8/8. This disproves the neighbor-bleed hypothesis and
points to something deeper: CREPE's own per-frame pitch continuity
produces transition-region frames right at note boundaries (the
tracker's smoothing lags across the real attack), and tightening the
window concentrates evidence on exactly those transition frames while
leaving the correct pitch too few frames to reach the duration floor —
making the problem worse. No window-radius parameter fixes this; it
would need either an onset-anchored exclusion margin or a different
confidence/continuity signal entirely, out of scope here per "no
unbounded architecture search" / "do not start an uncontrolled sequence
of replacements." Stopped after this one diagnostic, as instructed.

**Conclusion: this frame-level verifier, as prototyped, is NOT a GO.**
The false-positive regression is specific to this verification logic,
not to the Parangonar alignment it anchors on (which remains strong on
these 8 pieces per Task 1 — not conflating alignment quality with
detection accuracy, the exact mistake the chroma/CQT sprint made and was
called out for). The recall signal (2/2) is real but on too small and
too biased a sample to call a win on its own. No production code
touched; `worker.py` unaffected.

## Task 3 & 4 (2026-11-01, "Score-Conditioned Audio Verification Feasibility"): oracle timing makes false positives WORSE, not better — decision: STOP

Built `modal_worker/task3_end_to_end_comparison.py` (commit `b93445f`)
to answer the question Task 2 left open: is the frame-level verifier's
false-positive problem caused by Parangonar's alignment error, or is it
intrinsic to the verifier itself? Ran three conditions on the exact same
8 dev pieces (2202/2203/2217/2221/2288/2293/2294/2295):

  A. **Production** — the real `find_wrong_note_candidates`, fed by the
     real `run_pitch_tracking` -> `dtw_align_to_score` chain, run fresh
     on these same 8 pieces (not reused from the older 18-piece figure,
     so this is a genuine same-sample baseline).
  B. **Non-oracle** — Task 2's frame-level verifier, anchored by Task 1's
     real Parangonar alignment (numbers reused from Task 2's own commit,
     not rerun).
  C. **Oracle** — the identical verifier code (`verify_note`/`note_window`,
     imported unchanged), anchored instead by MusicNet's own ground-truth
     note timing — perfect alignment, by construction. Score-note <->
     ground-truth-note correspondence is by nearest `onset_beat`/
     `start_beat` (not list index — a real check found index counts
     differ on 7/8 pieces, e.g. 2217: 928 score notes vs 1007
     ground-truth notes, almost certainly ties/ornaments).

**False positives, unmodified correct audio:**

    condition               pieces flagged     note-level FP
    production              3/8 (37.5%)        8 total flags / ~7200-7400 notes (~0.1%)
    non-oracle verifier     8/8 (100%)         2060/7211 (28.57%)
    oracle verifier         8/8 (100%)         4085/7387 (55.30%)

Production is dramatically cleaner than either verifier condition on
this same sample. **The oracle condition is WORSE than non-oracle, not
better — the key finding of this task.** Giving the verifier PERFECT
ground-truth timing nearly doubled its false-positive rate instead of
fixing it. This rules out "Parangonar's alignment error" as the cause of
Task 2's false positives and confirms Task 2's own diagnosis: the
problem is intrinsic to the frame-level verification method, not the
alignment anchoring it. Plausible mechanism (not confirmed further,
per "no unbounded architecture search"): MusicNet's ground-truth onset
lands exactly at a note's nominal start — right at the attack transient
/ legato overlap with the previous note, precisely where CREPE's own
pitch-tracking continuity is least reliable (the mechanism Task 2
already identified). Parangonar's imperfect alignment, being fit to
acoustic stability in the real audio, may incidentally land closer to a
note's stable sustain than the mathematically "correct" onset instant
does — accidentally dodging some of the boundary noise that oracle
timing walks straight into.

**Recall, same 2 verified `wrong_pitch` injections as Task 2 (2288, 2294):**
production 0/2, non-oracle verifier 2/2, oracle verifier 2/2. Production
misses both cases the frame-level verifier catches under either
condition — consistent with, not new evidence beyond, this session's
already-established 0/18 production recall finding. The frame-level
approach has a genuine, real detection-capability advantage in
principle, at a false-positive cost between ~280x (non-oracle) and
~550x (oracle) production's own false-positive rate, measured on the
exact same audio.

**Task 4 decision: STOP — not a GO.** The recall advantage is real and
reproducible, but it is not an alignment or integration problem that a
"smallest isolated integration plan" could fix: Task 3's oracle result
proves the false-positive mechanism is intrinsic to frame-level
CREPE-continuity artifacts at note boundaries, and perfect timing makes
it worse, not better. More annotated data would not fix this on its own
— it is a systematic artifact of CREPE's frame-level behavior, not
noise more examples would average out. A real fix would need either a
substantially more sophisticated learned classifier over frame-level
features (a "substantial learning-based architecture" in the
directive's own words), or a fundamentally different evidence-extraction
approach with an onset-transient exclusion margin independent of the
timing-anchor source — both untested, named here as a recommendation for
future work, not built, per the directive's "do not start additional
model experiments automatically." No production code touched across
Tasks 1-4; `worker.py` unaffected throughout.

## 2026-11-04 targeted follow-up: reuse evidence, one prototype (transition-frame exclusion), immediate verdict — STOP, confirmed again

New owner directive, explicitly narrower than the 2026-11-01 round:
no broad surveys, reuse what exists, one targeted prototype, stop
immediately if it fails. Two tasks, both real, both committed
(`34719da`).

**Task 1 — injection coverage, no new infrastructure.** Task 2's
2026-11-01 recall number (2/2) rested on only 2/8 pieces producing any
verified `wrong_pitch` injection in 8 attempts. Tried 32 MORE attempts
per piece on the exact same, unmodified `inject_mistake_verified` gate
(`modal_worker/task1_expand_injection_coverage.py`) — no new dataset,
no new pipeline, just more seeds on the same 8 pieces.

    piece   new valid cases (32 extra attempts)
    2202    0   (40 total attempts, 0 successes)
    2203    0   (40 total attempts, 0 successes)
    2217    0   (40 total attempts, 0 successes)
    2221    0   (40 total attempts, 0 successes)
    2288    +1
    2293    +2
    2294    (already had 1 from the original run)
    2295    +1

**Coverage: 2/8 pieces → 4/8 pieces; 2 valid cases → 6 valid cases.**
Real, cheap, zero-new-infrastructure progress — exactly what the
directive asked to check first. But NOT a full fix, and the shape of
the remainder is itself informative: **both Flute pieces produce zero
valid cases at any attempt count tested (40 each)**, and 2 of 5 Cello
pieces (2217, 2221) are the same — a real, instrument/piece-correlated
limitation of the pitch-shift injection methodology, not sparse-sample
bad luck (0/40 is a strong null result). Not investigated further —
out of scope for "the smallest additional ground truth."

**Task 2 — transition-frame exclusion, mechanically distinct from the
already-failed window resize.** Modified
`modal_worker/score_conditioned_verification_prototype.py` in place
(not rewritten): added `compute_transition_mask`, which flags individual
CREPE frames as "transition" when the frame-to-frame pitch jump exceeds
0.75 semitones in one 40ms hop (a proxy for "still mid-attack/
portamento, not settled"), computed once per piece over the full frame
array — independent of any note's window. `verify_note` excludes these
frames from BOTH the expected-pitch-evidence and competing-pitch-
evidence computations. This is mechanically different from the
2026-11-01 `note_window` fix: that changed which frames a window
*includes*, based on NEIGHBOR TIMING; this changes which already-
included frames *count*, based on the frame's OWN local pitch
stability — confirmed distinct before building it, per the directive's
explicit ask.

Same 8 dev pieces, 7211 notes:

    condition (non-oracle, Parangonar-anchored — the GO/STOP number)   note-level FP
    fixed window, no exclusion (2026-11-01 original)                  18.78% (1354/7211)
    neighbor-bound, no exclusion (2026-11-01 diagnostic)               28.57% (2060/7211)
    fixed window, WITH transition exclusion (new)                     29.87% (2154/7211)  <- WORSE

    condition (oracle timing — diagnostic only, not the GO/STOP number)
    oracle, no exclusion (2026-11-01)                                  55.30% (4085/7387)
    oracle, WITH transition exclusion (new)                            34.25% (2530/7387)  <- improved, still bad

The oracle-only improvement (55.30%→34.25%) confirms transition frames
really are *part* of why oracle timing was so bad — but the condition
that actually matters (non-oracle, directly comparable to production)
got WORSE, not better, so the verdict doesn't change. **Precision**
(the metric this round's directive specifically asked for, since recall
alone hid how bad the false-positive problem is): full-piece sweep on
the injected audio for the 2 original verified cases — 2288: 1 true
positive / 87 total flags (1.15%); 2294: 1 true positive / 321 total
flags (0.31%). **Combined: 2/408 = 0.49% precision.** Recall unchanged
at 2/2 (100%) — the real wrong notes are still caught, just buried in
overwhelming noise.

**Per-instrument breakdown** (transition-exclusion verifier vs.
production, same 8 pieces): Flute 33.98% vs. 0%, Cello 31.08% vs.
0.18%, Violin 12.35% vs. 0%. **Latency**: production
`run_pitch_tracking`+`dtw_align_to_score`+`find_wrong_note_candidates`
≈9.8s/piece (measured directly); verifier
`crepe_frames`+Parangonar-align+transition-mask ≈9-10s/piece (crepe_frames
≈3.6s, Parangonar align ≈5.4s, transition-mask computation <0.1s,
vectorized) — roughly comparable cost, not a differentiator either way.
**Measure-localization**: 100% by construction for the verifier (it is
anchored directly to the score's own note index, with no DTW
event-to-measure step that could mis-localize, unlike production) — a
real structural property, moot given the accuracy result.

**Decision: STOP, confirmed again.** Per the directive's own stop
condition ("if this candidate fails... STOP — do not automatically try
more variations"): the false-positive rate on the condition that
matters got WORSE, and precision is catastrophic (0.49%) regardless of
which window/exclusion configuration is used. This is now the THIRD
diagnostic across two rounds (neighbor-bound window, oracle timing,
transition-frame exclusion) to either fail to fix the false-positive
problem or make it worse. Not attempting a fourth variant (e.g.
confidence-dip-based or spectral-flux-based transition detection)
without new, explicit authorization. No production code touched;
`worker.py` unaffected throughout both rounds.

## CRITICAL (2026-10-31): the real wrong-note detector has ~0% true recall and ~50% false-positive rate — prior "96.3% detection" number was measuring a different, degenerate thing

Found during Phase 2 of "MEDIANT — Continue Pipeline Validation and
Prepare Coaching Evaluation." This revises what every prior round
believed about the project's actual mistake-detection capability and
should be read before trusting any earlier "detection" percentage in
this file or in AGENT_TASKS.md's Track B entry.

**What the prior "96.3% detection / 57.7% localization / 100% control
false-positive" numbers (Track B, `agent_workspace/AGENT_TASKS.md`)
actually measured:** whether `dtw_align_to_score` aligns *something*
within 0.3s of a reference timestamp on the injected-mistake condition
vs. the untouched control. DTW aligns continuously across an entire
piece by construction, so this is true on nearly every piece regardless
of whether a mistake was injected — it is not, and never was, a measure
of mistake-detection. Confirmed by re-running it fresh this round:
identical 100%/100%/100% degenerate pattern on every piece, including
controls.

**What the ACTUAL production detector does, measured for the first time
this round:** called `find_wrong_note_candidates` — the real function
`run_full_analysis` uses to generate wrong-note flags — on the same 18
held-out MusicNet pieces' `wrong_pitch` and `control` conditions (real
audio, synthetic pitch-substitution injection via the existing
`inject_audio_mistakes.py`, zero paid API calls).

- **True wrong-pitch recall: 0/18 = 0.0%.** The detector never once
  located the actual injected wrong note, on any of the 18 pieces.
- **True false-positive rate on unmodified, correct audio: 9/18 = 50.0%.**
  Half the time, the real detector flags something as a wrong note on a
  performance that has no mistake in it at all.
- In nearly every piece, the flag set produced for `wrong_pitch` and for
  `control` is almost identical — strong evidence the detector is firing
  on fixed, pre-existing CREPE/alignment artifacts specific to that
  recording, not responding to the actual injected mistake at all.
- Two pieces (2220, 2296, both Cello) tripped the detector's own
  "more than 25% of notes look wrong" sanity gate and got fully
  suppressed (51-54% of notes flagged) — a separate, piece-specific
  breakdown.
- **Plausible but UNVERIFIED hypothesis, not confirmed, flagged for
  follow-up only:** hundreds of events per piece (374-769) may be
  getting classified as "squeak-shaped" and routed away from the
  wrong-note comparator before it ever sees them — which could be
  silently swallowing the injected note. This has not been traced to a
  confirmed root cause.

**Also confirmed this round: there is no missing-note or extra-note
detector in production at all.** The only three detectors are
`find_wrong_note_candidates`, `find_crack_candidates`, and
`find_rest_violations`; the last only fires for notes played during a
*written* rest, which none of the injected test cases are. No
precision/recall number exists for missing/extra notes because the
capability itself doesn't exist yet to measure.

**What this is NOT (yet) known to be:** whether this is a fixable
software bug (e.g. the "squeak-shaped" routing hypothesis, an
off-by-something in which audio/score window gets compared, a threshold
set wrong) or a genuine, harder accuracy limitation of CREPE+DTW's
precision. 0% recall across 18 pieces (not just "low," literally zero)
is suspicious enough to suggest a systematic bug rather than pure
imprecision, but this has NOT been root-caused — only the symptom has
been measured, rigorously, for the first time.

**Status: this finding is more launch-critical than anything else in
this file.** It directly contradicts the product's core promise
("measure-level feedback on pitch, rhythm, dynamics, articulation") and
was previously masked by a measurement that looked like a strong real
number (96.3%) but wasn't measuring the right thing. Root-caused below —
read that section before treating "0% recall" as the final word on
real-world performance.

### Root cause of the 0% recall / 50% FP (2026-10-31, same day, confirmed via direct instrumentation on 4 real pieces — 2293, 2217, 2242, 2220)

**Not one mechanism — three, two of which are measurement artifacts and
one of which is a real, confirmed detector design issue.**

1. **Confirmed real design issue (piece 2220, cleanest case): the squeak
   filter kills an exact-pitch-match injected event even though nothing
   about it is unstable.** Traced the actual injected event: `midi_raw`
   matches the injected wrong note exactly, confidence 70, **cents
   spread 0 (perfectly stable)**, duration 0.302s — passes every one of
   `find_wrong_note_candidates`'s own gates (conf≥65, dur≥0.08,
   spread≤40). It never reaches those gates: `looks_like_squeak`
   (worker.py:792) kills it upstream purely because
   `conf(70) <= _SQUEAK_CONF(70)` — one branch of an OR, with zero
   instability evidence (spread=0 directly contradicts the function's
   own stated definition, "pitch that will not hold still"). Same
   pattern confirmed on piece 2293. **Nothing about this mechanism is
   specific to synthetic injection — a real wrong note played with
   confidence exactly at this threshold and a stable pitch would be
   killed the same way.** Not fixed this round: `looks_like_squeak` has
   its own validated history protecting real clarinet squeak/crack
   detection (worker.py:7542-7551's own comment references a prior
   incident from narrowing this exact logic) — a blind tighten-the-OR
   fix validated on 4 pieces risks regressing that already-shipped
   behavior. Needs full-corpus validation against both this benchmark
   AND existing squeak/crack test coverage before any change — not a
   one-line fix to take on faith.
2. **Confirmed measurement artifact (piece 2242): `librosa.effects.pitch_shift`'s
   own phase-vocoder artifacts depress CREPE's confidence below the
   detector's bar.** The event matching the injected note measured
   confidence 60 — below `MIN_CONF=65` — independent of the squeak
   filter. This means the "0% recall" number **understates** real-world
   recall; it does not prove the detector would miss an authentically-played
   wrong note with clean, confident pitch tracking.
3. **Confirmed measurement artifact (piece 2217): a very short injected
   note (0.139s) produced no distinct CREPE event at the substituted
   pitch at all** — same category, a limitation of the injection
   methodology's short-window case, not the detector.

**Separate, still-unexplained finding: every traced piece has
pre-existing "wrong note" false-positive candidates at measures
unrelated to the injection** (2293: 1, 2217: 6, 2242: 6) — confirms the
"flag set is nearly identical between `wrong_pitch` and `control`"
observation directly. These are present regardless of injection, so
they are not synthetic-injection artifacts, but no root cause was traced
to a specific line this round — that is the real driver of the 50%
false-positive-on-correct-audio rate and remains open.

### Task 1 (2026-10-31, same day): benchmark validity repaired across the FULL 18-piece set — overturns the earlier 4-piece sample's headline conclusion

The earlier root-cause pass (4 sample pieces: 2293, 2217, 2242, 2220)
suggested roughly half the misses were synthetic-injection-methodology
artifacts (librosa pitch_shift confidence depression, short-note
non-events) rather than real detector failures. **That was correct as
far as it went, but underpowered — the full 18-piece set shows the
opposite balance.**

- **Recall across all 18 intended `wrong_pitch` injections: 0/18 = 0%.**
- **Recall conditional on independently-verified-observable injections
  (confirmed via direct inspection of real `run_pitch_tracking` output,
  not inferred): 0/15 = 0%.** 15 of the 18 injected mistakes produced a
  real CREPE event matching the intended wrong pitch within 1 semitone
  — genuinely clean, correctly-pitched, observable audio. The real
  production detector never flagged the correct measure on ANY of them.
- **Only 3/18 (17%) are non-observable** (methodology limitations): one
  (2204, Flute) landed 18 semitones off — a different measurement issue
  entirely — and two (2217, 2297, both Cello) landed exactly 2 semitones
  short of the intended shift, a specific, repeatable
  `librosa.effects.pitch_shift` under-shoot pattern on those two cases.
- **Per instrument: recall is 0% in Violin (5/5 observable), Cello (9/11
  observable), and Flute (2/3 observable) alike — the detector-logic
  miss is universal across instrument, not instrument-specific.**
- `deleted_note`/`duplicated_note` were also measured across all 18
  pieces for completeness, but `find_wrong_note_candidates` was never
  designed to catch either (a duplicated note is the CORRECT pitch
  played twice; a deleted note is an absence) — 0/18 on both is expected
  by design, not new evidence of failure, and there remains no
  missing/extra-note detector in production at all (confirmed
  separately, unchanged).

**Revised conclusion: the problem is overwhelmingly in the detector's
own logic, not the benchmark.** 15 of 18 real, clean, correctly-pitched
injected mistakes were never flagged. This makes the squeak-filter
mechanism found on the 4-piece sample (worker.py:792's
`conf <= _SQUEAK_CONF` branch with no instability requirement) far more
consequential than it looked on that smaller sample — it is plausibly
the dominant mechanism across most of these 15 misses, though that has
not yet been traced at this full scale (Task 3 does that next).

### Task 2 (2026-10-31, same day): false-positive root cause — resolved, and it's good news for the comparator specifically

Re-ran `find_wrong_note_candidates` against all 18 held-out pieces' real,
unmodified audio (no detector changes). Confirmed the recording-level
incidence exactly: **9/18 pieces, 36 total false-positive flags**
(2204:6, 2217:6, 2222:6, 2241:1, 2242:6, 2289:3, 2293:1, 2295:1, 2297:6).

Classified every one of the 36 flags against MusicNet's own ground truth:
- **Alignment/measure-mismatch: 15/36 (41.7%)** — CREPE's pitch is
  exactly right; `dtw_align_to_score` put the event in the wrong
  measure, so the comparator checked it against the wrong measure's
  expected notes. This is the single largest cause.
- **CREPE misread: 14/36 (38.9%)** — the detected pitch genuinely
  doesn't match ground truth at that timestamp.
- **Unclear: 7/36 (19.4%)** — ground-truth onset too far (>0.15s) from
  the flagged timestamp to attribute confidently without manual review.
- **Filter gap, comparator logic, genuine performance/notation
  difference: 0/36 each.**

**None of the 36 false positives trace to `find_wrong_note_candidates`'s
own logic** (squeak filter, semitone-distance gates, transposition
guard). The comparator is faithfully reporting what upstream DTW
alignment and CREPE pitch tracking hand it. The 50% false-positive rate
is driven almost entirely by two already-known, already-documented
limitation classes in this project (the standing ~65% DTW measure-
localization accuracy, and CREPE's own pitch-tracking error rate) — not
a new comparator defect. This reframes the FP problem: it isn't
"the wrong-note detector has a bug," it's "the wrong-note detector
correctly amplifies pre-existing alignment/pitch-tracking error into a
confident, student-facing false accusation." Fixing it for real means
improving alignment/pitch-tracking accuracy (the already-"stop tuning"
DTW mechanism and the CREPE pipeline), not a comparator-logic patch.

**Bottom line, updated after Task 1's full 18-piece measurement:**
recall is genuinely ~0% on real, cleanly-observable, correctly-pitched
injected mistakes (0/15 conditional recall) — this is NOT mostly a
measurement artifact; only 3/18 (17%) of injections were non-observable.
The detector-logic failure (most plausibly the squeak filter, per the
4-piece trace, now needing full-scale confirmation) is real and
dominant. The 50% false-positive rate on correct playing is separately
resolved (Task 2): 80.6% of it (41.7% alignment + 38.9% CREPE) traces to
two already-known upstream limitation classes, not to the comparator's
own logic (0/36). No fix was implemented this round for the recall
side — per the systematic-debugging skill's Iron Law, none of the three
recall mechanisms had a fix that could be safely validated within this
turn's scope; that validation is exactly what Task 3 does next.

---

### The four failure categories, and what already has a real number

**1. Score-reading failures (Claude vision transcribing a photographed/PDF score into notes)**
Real, measured this session on piece 2243 (12/8 Violin): 0/20 exact-measure accuracy, but 30.7% pitch accuracy / 21.6% rhythm accuracy at note level (`modal_worker/score_detailed_metrics.py`, scored from `modal_worker/probe_result_2243.json`). A real bug (compound-meter beat convention) was found and fixed (commit `0b7889d`, deployed). Separate, ongoing investigation — out of scope for THIS plan, which is audio-side only. See `agent_workspace/AGENT_TASKS.md`'s "Track A" entry.

**2. Audio-transcription failures (CREPE pitch detection, in isolation from any score)**
Already measured and fixed. `modal_worker/validate_pitch_against_tinysol.py` ran the real `run_pitch_tracking` against TinySOL (Cella et al. 2020, CC-BY 4.0) — 2,224 real isolated, individually-labeled notes across 13 orchestral instruments. Round 1 (before fix): 60.7% correct, 37.0% missed, concentrated in quiet (pp) dynamics and specifically Violin/Viola. Root cause: the breath-noise gate used an absolute amplitude threshold instead of a per-take-relative one (see Obsidian `Fixes/Fix — Breath-noise gate was an absolute amplitude threshold.md`). After the fix: **95.6% correct overall, pp 96.2%, Violin 94.7%, Viola 96.8%, precision-when-detected 96.4% (unchanged — this was always a recall problem, never a wrong-pitch problem).**
Real, open gap this corpus explicitly cannot cover: TinySOL's notes are isolated, not played against a score — it validates pitch detection, not alignment (next section), and it has no corpus for the false-positive side of the breath-noise gate (admitting real noise as a note).

**3. Alignment failures (DTW matching a detected audio event to the right score measure)**
Already measured and substantially improved, with a documented, explicit "stop tuning" decision on what's left. `modal_worker/validate_alignment_against_musicnet.py` runs the real `run_pitch_tracking` + `dtw_align_to_score` against MusicNet (Zenodo doi:10.5281/zenodo.5120004) — 20 scored solo Violin/Cello/Flute Bach pieces (4 of 24 excluded by `calibrate_assumptions()`'s own sanity check), 22,095 note-events. Original baseline: 46.7% correct, sharply bimodal (83-95% on 8 pieces, 0-3% on 9 pieces). Root cause, confirmed via detected/true event-count ratio: catastrophic failures are slow/legato passages where CREPE's onset detector fires spurious extra onsets within one sustained note (vibrato, bow noise), breaking the pitch-only DTW cost function's warping path. Three shipped fixes since (rest-anchored segmentation, within-segment pitch-jump detection, local-outlier rejection) moved the real 20-piece number **46.7% → 55.7% → 63.7% → 65.4%** (current, as of 2026-10-22). Five further tuning attempts on the remaining over-counting pieces (2220, 2241, 2296, 2204, parts of 2242) were each tried and reverted — a 2026-10-15 decision in `agent_workspace/AGENT_TASKS.md` explicitly says **stop tuning this mechanism; the remaining gap needs either a new idea or a real VAD/onset model, not another threshold variant.** Owner's target is 80%+ on most/all pieces — not yet reached, and not this plan's job to chase further (see Task 3's scope note).

**4. Final feedback-generation failures (Gemini's `evaluate_with_gemini` authoring flags from audio+video+score; Claude's `compare_and_coach_claude` fusing those with CREPE/DTW evidence into the student-facing flags)**
**No existing harness measures this against ground truth at all.** `modal_worker/score_against_annotations.py` computes precision/recall from real teacher annotations, but `agent_workspace/ACCURACY_BASELINE.md` confirms zero teacher annotations exist on any of 199 real production takes, and this environment has no service-role DB access to harvest them even if they existed — that path is fully blocked, independent of this plan. This is the real, unaddressed gap, and the one new thing this plan builds toward.

---

### Execution-path diagram (score → audio → flags)

```
photo/PDF score ──> read_score_notes_claude (3x Claude vision + Audiveris + resolution)
                     -> score {"measures": [...], "time_signature": ...}
                     (score-reading: see category 1 above, separate plan)
recording (wav) ──> run_pitch_tracking(wav_bytes, guide_times, instrument)
                     -> events: [{"pitches": [...], "time_sec": ..., ...}, ...]
                     (category 2 above)
events + score ───> dtw_align_to_score(events, score, start_measure, beats_per_measure, end_measure)
                     -> aligned: [{..., "measure": N, "time_sec": ...}, ...]
                     (category 3 above; flatten_score_notes supplies DTW's score_seq)
video/audio + score ─> evaluate_with_gemini(file_uri, mime_type, instrument, ..., score_pages=[...])
                     -> gemini_assessment: {"intonation_issues": [...], "rhythm_issues": [...], ...}
                     (category 4, Gemini half)
aligned + gemini_assessment + score ─> compare_and_coach_claude(score, aligned, alignment_ranges,
                     tempo, ..., gemini_assessment, anthropic_api_key, ...)
                     -> list[dict] flags (final, student-facing)
                     (category 4, Claude fusion half; unresolved score measures are suppressed
                     here via NON_SCORE_DEPENDENT_TYPES, not dropped from DTW's input)
```

Confirmed directly in `modal_worker/worker.py`: `run_pitch_tracking` (:884), `dtw_align_to_score` (:2289), `flatten_score_notes` (:1899), `evaluate_with_gemini` (:3669), `compare_and_coach_claude` (:8121, unresolved-measure suppression at :8143-8154).

---

### What this plan will NOT re-attempt

Per the "stop tuning" decision above, this plan does not propose a sixth variant of the rest-anchor/pitch-jump DTW tuning mechanism. If Task 3's new benchmark reproduces the same bimodal, event-count-ratio-correlated failure on its injected cases, that confirms the existing root cause rather than discovering a new one — report it as confirmation, not as license to start tuning thresholds again.

---

## Results — Task 3: free-leg (CREPE+DTW) chained benchmark against injected mistakes (2026-10-30)

Real run against real MusicNet data (not mocked, not synthetic beyond the
deliberate mistake injection itself). Full methodology, design notes, and the
corrected cross-validation discussion are in
`.superpowers/sdd/2026-10-30-audio-pipeline-benchmark/task-3-report.md`
(gitignored scratch location — this section is the durable, committed copy of
its headline numbers and key finding). Built by `modal_worker/benchmark_full_pipeline.py`
(`run_free_legs`) and `modal_worker/run_task3_benchmark.py` (real-data
aggregation layer). Zero paid API calls made — only the free CREPE+DTW half of
the pipeline was exercised.

**Held-out set:** 18 of the 24 real MusicNet solo pieces (3 Flute, 10 Cello,
5 Violin) — Bach, unaccompanied. Same 4 exclusions as the earlier
`validate_alignment_against_musicnet.py` session (`2191`, `2243`, `2298`,
`2659`, all excluded by that script's own `calibrate_assumptions()` sanity
check). 2 further pieces (`2186`, `2219`) were a mechanical dev/sanity set,
run but never included in these scored numbers.

**Headline numbers (72 total runs: 54 injected + 18 control):**

```
Detection accuracy    (injected, n=54): 52/54 = 96.3%
Localization accuracy (of detected, n=52): 30/52 = 57.7%
False-positive rate   (control, n=18): 18/18 = 100.0%
  Of those false-positive detections, mislocalized vs ground truth: 8/18 = 44.4%
```

**By mistake type:**

| mistake_type | detection | localization (of detected) |
|---|---|---|
| wrong_pitch | 18/18 (100.0%) | 10/18 (55.6%) |
| deleted_note | 16/18 (88.9%) | 10/16 (62.5%) |
| duplicated_note | 18/18 (100.0%) | 10/18 (55.6%) |

(False-positive rate is identical — 18/18, 100% — across all 3 mistake types
by construction: the control condition is run once per piece, since
`inject_mistake`'s target-note draw is the same for all 3 types at
`rng_seed=0`, so there's nothing to vary across mistake types.)

**By instrument:**

| instrument | n_pieces | detection | localization (of detected) | FP |
|---|---|---|---|---|
| Cello | 10 | 29/30 (96.7%) | 18/29 (62.1%) | 10/10 (100.0%) |
| Flute | 3 | 9/9 (100.0%) | 3/9 (33.3%) | 3/3 (100.0%) |
| Violin | 5 | 14/15 (93.3%) | 9/14 (64.3%) | 5/5 (100.0%) |

Flute's 33.3% localization rests on only 3 pieces (1 of 3 landed correctly) —
not enough n to call this an instrument-level trend on its own.

**Key methodological finding:** "detection," as defined here (any DTW-aligned
event lands within 0.3s of the probed timestamp), fires on **ordinary,
uninjected control audio just as readily as on injected audio** — the 100%
control false-positive rate is not the pipeline hallucinating mistakes; it's
that `run_pitch_tracking` emits dense enough event streams that something
almost always lands in the 0.3s window regardless of whether anything is
actually wrong there. Detection as defined mostly measures audio event
density, not mistake-specific anomaly detection. **Localization accuracy is
the metric with real discriminative signal** — it reflects whether DTW
landed on the correct measure, independent of whether a mistake occurred
there. This matters directly for Task 4 planning: a paid-leg gate built on
"did the free legs detect something" would gate out almost nothing (96-100%
detection regardless of condition); a gate should use localization instead.

**Sample-size caveat:** one probe (one injected/control location) per piece,
n=18 pieces — 18 independent sample points, not a dense per-piece sample.
Every held-out piece's `localization_correct` value is identical across all 4
of its conditions (confirms the already-known finding that alignment
correctness is a property of the piece/passage, not of what's injected
there) — but also means a different `rng_seed` landing on a different measure
within the same piece could flip that piece's result. Piece-level results
here should be read as noisy, not as settled per-piece verdicts.

**Corrected cross-validation against the earlier large MusicNet validation
session** (`Sessions/2026-10-11 (2) — MusicNet score-alignment validation.md`):
10 pieces localized correctly on all 4 of their conditions here
(`2203, 2218, 2221, 2244, 2288, 2289, 2293, 2294, 2295, 2297`). Checking that
session's own per-piece buckets directly: only **6** of those 10
(`2203, 2218, 2244, 2289, 2294, 2295`) are actually in that session's
83-95%-correct bucket — genuine agreement between the two runs. The other
**4** (`2221, 2293, 2288` — actually in that session's 0-3%-correct bucket,
i.e. near-total alignment failure across the whole piece; `2297` — actually
in the 46-68%-correct mixed bucket) are **not independent confirmation**: a
single lucky probe can land correctly inside an overall-bad or mixed piece
precisely because this benchmark samples only one location per piece. The
6-piece agreement is the real cross-validation signal; the other 4 are
"not contradicted by sample-size noise," not corroboration.

---

## Priority 3 category audit (2026-10-31): where rhythm/alignment errors
## actually come from, and why no new DTW change ships this round

Per "MEDIANT — Finish Visual Integration and Improve Audio Accuracy,"
Priority 3 asks whether the largest alignment errors are false onsets,
missed repeated notes, sustained/legato transitions, tempo variation, or
incorrect score-to-performance mapping — and explicitly says not to
resume open-ended DTW tuning without direct evidence, implementing at
most one targeted fix.

**No code was changed for this priority.** The evidence below is drawn
from `modal_worker/musicnet_alignment_misses.csv` (753KB, the real
per-event miss list from the validation run that produced the current
65.4% baseline) and `agent_workspace/AGENT_TASKS.md`'s Backlog entry
"Score-alignment residual gap" — both confirmed, not assumed, to still
describe the live code: `git log --oneline --since=2026-10-22
--until=2026-10-31 -- modal_worker/worker.py` shows every commit since
that CSV was generated touched either instrumentation/logging, the
score-reading *prompt* (compound-meter fix, visual-path only), or the
page-omr staging work — **zero commits touched `run_pitch_tracking` or
`dtw_align_to_score`**. The CSV is a valid frozen baseline for today's
code, not stale data.

**Fresh per-piece category breakdown** (counted directly from the CSV's
`outcome` column — `off_by_one` / `unmatched` / `wrong`, for the pieces
the Backlog already names as the remaining weak set):

| piece | off_by_one | unmatched | wrong | known mechanism (from prior sessions' real investigation) |
|---|---|---|---|---|
| 2186 | 106 | 14 | 294 | bariolage under-detection — real notes 40-80ms, shorter than every detector's sustain requirement |
| 2217 | 67 | 60 | 420 | DTW drift — zero rest-anchor checkpoints, one unbounded path for the whole piece |
| 2241 | 108 | 424 | 770 | over-counting — vibrato/pitch noise exceeds the 1-semitone merge tolerance |
| 2220 | 11 | 454 | 714 | over-counting, same mechanism as 2241 |
| 2296 | 25 | 478 | 626 | over-counting, same mechanism |
| 2204 | 63 | 105 | 263 | over-counting, same mechanism (smaller-scale) |
| 2242 | 365 | 39 | 446 | rest-anchor "no real silence" problem — distinct from the over-counting pieces, mostly one-measure-off drift |
| 2222 | 114 | 18 | 630 | accepted regression from the legato-step fix (fast scale run satisfies the "kept moving" check without a real hold) |
| 2297 | 112 | 56 | 416 | DTW drift, same mechanism as 2217 (3 rest-anchor checkpoints, still insufficient) |
| 2293 | 115 | 78 | 40 | resolved — genuine attack-transient misread, local-outlier fix already shipped; low "wrong" count confirms this is not a catastrophic piece |

**Mapping onto the five categories the directive asks about:**

1. **False onset detections** — the dominant driver on 2241/2220/2296/2204
   (`unmatched`+`wrong` far outweighing `off_by_one`): CREPE registers
   spurious extra onsets from vibrato/bow noise within what is really one
   sustained note. **Five independent fixes already tried and abandoned**
   specifically for this (3 frame-level heuristics, 1 global penalized-
   segmentation/changepoint detector, 2 finer-CREPE-hop variants) — each
   validated against the real 20-piece corpus, each traded one piece's
   gain for another's regression rather than converging. Explicit
   decision already on record (2026-10-15): "stop tuning
   `_find_rest_anchor_checkpoints` for the over-counting pieces."
2. **Missed repeated/rapid notes** — the dominant driver on 2186
   (bariolage: real notes shorter than every detector's frame-sustain
   floor). Same exhaustive-attempt history as above; the global
   changepoint detector that targeted this specifically regressed the
   corpus overall by -8.9pt and was reverted.
3. **Sustained/legato transitions** — **already fixed**, not an open
   gap: `_detect_within_segment_pitch_jumps` (shipped 2026-10-15/21) is
   exactly this fix, and moved the corpus 60.1%→65.3%. The one named,
   accepted side effect (2222, a fast scale run) was investigated with
   three separate discriminators, all of which found the "good" and
   "bad" candidate distributions genuinely overlap — no clean signal
   separates them with a per-candidate scalar.
4. **Tempo variation** — **investigated and ruled out as a driver**, not
   untested: a direct check of local-vs-global tempo ratio against real
   MusicNet ground truth (2026-10-15) found it stays within 0.89-1.13
   across all sampled windows on the specific weak pieces checked — global
   tempo estimation was never the problem.
5. **Incorrect score-to-performance mapping** — the dominant driver on
   2217/2297 (DTW drift: a steadily growing measure offset across the
   whole piece, not scattered independent mistakes). A time-anchor cost
   term was tried **twice**, at two different weights, across three
   variants each time (2026-10-13, re-tested 2026-10-21 after pitch
   detection got materially cleaner) — same failure both times: the
   mechanism reinforces pass-1's own drifted correspondence rather than
   correcting it. Explicitly closed: "do not re-attempt a global/path-
   derived linear tempo model for this... without a genuinely different
   algorithm."

**Conclusion: no new DTW change ships this round.** All five categories
the directive asks about already have a specific, real-data-backed
mechanism identified, and for every category except #3 (already fixed),
the directive's own instruction — "preserve the existing DTW mechanism
unless there is direct evidence supporting a specific replacement...
do not resume open-ended DTW tuning" — points the same direction the
2026-10-15 architecture-level stop-tuning decision already reached: **13
distinct mechanisms have been tried across these failure modes this
investigation; two shipped, eleven were reverted on real-corpus
evidence.** Nothing examined this round constitutes new evidence that
would justify a 14th attempt. This is the direct answer to "stop if the
evidence doesn't support the proposed corrections" — the evidence here
supports *not* touching the DTW mechanism again right now, not a new
fix.

---

## Priority 4 (2026-10-31): end-to-end coaching — confirmation, not new work

Priority 4 asks to verify corrected score/audio observations still
produce accurate measure-specific coaching, keep Claude's coaching
capability without unsupported assertions, and explicitly not restore
the already-rejected Gemini-only error-detection experiment or
LadderSym.

**Nothing in this round touches the coaching path, so this is a
confirmation, not an investigation.** The only code change made this
round (Priority 1's image-build reordering) is scoped entirely to the
`modal.Image` build chain (`worker.py` lines ~45-165) — a build-script
change, not a change to any function body `compare_and_coach_claude`,
`evaluate_with_gemini`, or the DTW/CREPE code paths call. Confirmed by
inspection of the diff (`git diff -- modal_worker/worker.py` touches only
the `image = (...)` assignment and the one `if _STAGING_BUILD_SCORE_ENGINE`
block) and by the full regression suite staying green across every test
file in `modal_worker/` (719/719 `test_analysis.py`, plus
`test_coaching_models.py` 8/8, `test_gemini_crosscheck.py` 8/8,
`test_smt_inference.py` 12/12, `test_smt_cropped_input.py` 12/12,
`test_visual_validation.py` 100/100, `test_page_omr_adapter.py` 16/16,
and `test_benchmark_full_pipeline.py` / `test_inject_audio_mistakes.py` /
`test_generate_timing_accurate_reference_audio.py` all exit 0 clean).

**No new DTW change (Priority 3) or pitch change (Priority 2, pending
its own evidence) landed either**, so there is nothing new flowing into
`compare_and_coach_claude`'s inputs this round to re-verify downstream.

**Explicitly not done, per the directive's own prohibition**: no attempt
was made to restore Gemini-only error detection (rejected per Task 4A/4B,
2026-10-30: "score image + short clips don't fix it") or LadderSym
(rejected per Gate 3, 2026-10-30: inconsistent in both directions across
instruments, 0% missing-note recall). Both remain exactly as rejected.

---

### Task 3 (2026-10-31, same day): squeak-filter correction — NO-SHIP, and here's exactly why

Before writing or validating any fix, built a full gate-by-gate trace of
all 15 of Task 1's real observable misses (not a sample) and ran a
"ceiling" check: even with the squeak filter's confidence-alone
over-triggering (confirmed real — it independently fires on 8/15
candidates, including the exact piece-2220 case found earlier,
confidence=70 and perfectly stable spread=0) completely removed, would
ANY of the 15 misses actually flip to a correct flag? **Answer: no, zero
of 15.** Every one of the 8 squeak-filtered candidates also has at
least one other, fully independent blocking reason:

- **6/15** fail the comparator's OWN quality gates for reasons unrelated
  to the squeak filter (`cents_spread` up to 1076, confidence as low as
  58, duration as short as 0.065s) — `librosa.effects.pitch_shift`
  splice artifacts producing audio that genuinely IS unstable/noisy/too
  brief. A synthetic-injection-methodology limitation.
- **5/15** get assigned to the wrong measure entirely by DTW alignment
  (off by 1-6 measures) — the same pre-existing, already-"stop tuning"
  alignment-accuracy limitation that drives 41.7% of Task 2's false
  positives. Same root problem, different symptom.
- **4/15** have a randomly-chosen substitute pitch that coincidentally
  equals a pitch already legitimately expected elsewhere in that same
  measure (dense/scalar passages) — the distance gate is correctly,
  conservatively declining to call it wrong. A real gap in
  `inject_audio_mistakes.py`'s own methodology (it never checks whether
  its random 2-7 semitone substitute happens to be contextually
  plausible), not a comparator defect.

**No correction was proposed, written, or validated** — the ceiling
check, done first and from real data, proved a squeak-filter fix could
not move measured recall at all on this benchmark, so running the full
4-way validation plan would have validated something with a provable
zero benefit. `looks_like_squeak`'s confidence-alone branch remains a
real, latent design issue worth fixing on its own merits someday, but
it is demonstrably NOT the bottleneck for this problem.

**This closes out the recall investigation with three identified,
independent root causes, none of them safely or usefully fixable within
this sprint's constraints:** (1) the synthetic mistake-injection
methodology itself produces audio artifacts that don't always survive
as clean "mistakes," (2) DTW alignment accuracy — already a known,
already-"stop tuning" limitation — misplaces notes into the wrong
measure, and (3) the injection methodology doesn't check whether its
random substitute pitch happens to already belong in that measure. Any
real improvement to wrong-note recall routes through fixing (1)/(3) in
the benchmark itself, or improving (2) DTW alignment — a materially
different, larger effort than "one minimal correction."

### Phase A+B (2026-10-31, "Accelerated Audio Accuracy Recovery Sprint"): benchmark repaired, and the dominant failure is finally isolated with hard evidence

**Phase A — benchmark repair.** Added a verification gate to
`inject_audio_mistakes.py` (`verify_injection`, `inject_mistake_verified`
— commit `73d9484`) that only counts a `wrong_pitch` injection as a
valid test case if it survives as a clean, confident, stable,
musically-unambiguous event — checked against the real post-DTW
aligned-event pool `find_wrong_note_candidates` actually sees (an
earlier, tighter pre-alignment check gave an implausible 2/12 result
and was corrected mid-task). **Major new finding: 9 of 12 development
pieces produced NO valid injection in 8 attempts each** — the synthetic
injection methodology is considerably less reliable than Task 3's
looser definition suggested. Of the 3 pieces that did validate: **recall
1/3 = 33.3%** — the first non-zero, properly-gated recall number in this
whole investigation, though the sample is too small to call it a settled
rate. A frozen, untouched 6-piece subset (2204, 2218, 2222, 2297, 2244,
2289) was set aside before any of this repair work and committed
(`modal_worker/p0_sprint_frozen_eval_manifest.json`) — reserved
exclusively for a later final validation, never used to develop or tune
anything.

**Phase B — the decisive diagnostic experiment.** Fed `dtw_align_to_score`
two ways on the same 12 dev pieces, same score, same algorithm: (A) real
CREPE-extracted events (today's production path), (B) MusicNet's own
independently-annotated ground-truth note events, reformatted into the
same input shape, CREPE bypassed entirely.

- **Condition A: 60.8% correct. Condition B: 76.2% correct. Gap: +15.4pt.**
- **Sharply bimodal, settling the "which stage" question with hard
  numbers for the first time:** 9/12 pieces reach 90-100% under
  Condition B — for these, CREPE pitch/onset extraction is the clearly
  dominant failure, since near-perfect input localizes almost
  perfectly. **3/12 pieces (2220: 7.4%, 2242: 6.8%, 2296: 9.0%) stay in
  single digits even with PERFECT ground-truth input** — DTW's own
  algorithm has a defect independent of input quality on these specific
  pieces. These are exactly the same pieces already identified in this
  project's standing backlog as "over-counting" cases with an explicit
  2026-10-15 "stop tuning" decision (vibrato/pitch noise exceeding DTW's
  1-semitone merge tolerance) — not a new problem, confirms the old one.
- **Anomaly, flagged not chased:** piece 2242's Condition B (6.8%) is
  WORSE than its Condition A (49.8%) — possibly an artifact of how the
  synthetic ground-truth event sequence was built for that one piece.
  Needs its own look before drawing conclusions specifically about 2242.
- **Engineering-target decision: CREPE pitch/onset extraction/event-
  consolidation quality — dominant on 9/12 (75%) of pieces by count.**
  The 3-piece DTW-defect subset stays explicitly out of scope, matching
  the project's own standing decision.

Full regression confirmed clean throughout: `test_analysis.py` 727/727,
`test_page_omr_adapter.py` 16/16, new `test_inject_audio_mistakes.py`
6/6. $0 spend, CPU-only. No detector/alignment code touched this round
— only the injection benchmark itself.

### Phase C/D/E (2026-10-31): STOP — confirms an existing, already-abandoned problem; no fix implemented

Diagnosed the exact CREPE-vs-ground-truth divergence on all 9
CREPE-bound dev pieces via an order-respecting sequence diff (a first,
looser nearest-time matcher gave an implausible 44.9% wrong-pitch rate
and was caught and corrected mid-task — crossing matches in dense
passages). Corrected totals across 7,995 real ground-truth notes: 19.0%
missing, 2285 extra (beyond the real note count), 30.6% wrong_pitch,
3.1% octave_error, 47.3% matched_correct. CREPE substantially
over-generates candidate events relative to real notes on every one of
the 9 pieces (e.g. piece 2241: 912 CREPE events vs. 608 real notes).

**Decision: STOP, no fix implemented, no branch, no commit.** Two
reasons: (1) the extra/missing pattern is the exact shape of the
rapid/dense-passage event over/under-detection problem this project has
already tried four separate ways (three frame heuristics, one global DP
segmentation, two finer-hop variants) and reverted from the real corpus
every time — this diagnostic confirms the same already-abandoned
problem, not a new one. (2) The wrong_pitch number itself is not
trustworthy enough to act on — two different matching methodologies on
the same data gave materially different answers (3268 vs. 2447), a red
flag that the measurement is sensitive to matching-window/ordering
choices rather than cleanly isolating a real defect. Per the Iron Law, a
methodology-sensitive signal is not a confirmed root cause worth
building a fix on.

Phase D's frozen 6-piece set (2204, 2218, 2222, 2297, 2244, 2289) was
never opened — correctly, since no correction existed to validate.
**This closes out the sprint's search for a quick, safe, single
correction with a clear negative result: none exists within the
sprint's constraints.** A methodology-robust note-level sequence
alignment (proper DP between the two event streams, not a two-pointer
approximation) would be needed before any future attempt could even
get a trustworthy wrong-pitch-rate number to work from — flagged, not
built, out of scope here.

### Task 2 (2026-10-31, "Audio Recovery: Measurement Fix + New Architecture Feasibility"): a genuinely different alignment formulation — large, consistent, real gains, no regression on any of 5 tested pieces

Built `modal_worker/chroma_alignment_experiment.py`: a continuous
chroma/CQT-feature DTW (`librosa.sequence.dtw` over `chroma_cqt`
features, a classical MIR score-alignment technique) replacing the
production pipeline's discrete-pitch-event DTW for the alignment stage
only — CREPE's event extraction is bypassed entirely. A synthetic
chroma template is rendered from the symbolic score (sounding pitch,
transposition applied via the same `transpose_for_instrument` the
production comparator uses) at a nominal average tempo derived from the
real audio's duration; real `chroma_cqt` features come from the real
MusicNet audio. Scored with the exact same `classify_alignment` the
production validator uses, for a direct comparison.

**Measured, real audio, same 5 pieces, current pipeline vs this approach:**

| piece | instrument | current (real CREPE) | chroma-DTW |
|---|---|---|---|
| 2220 | Cello  | 0.4%  | **66.8%** |
| 2242 | Violin | 49.8% | **78.3%** |
| 2296 | Cello  | 2.0%  | **80.1%** |
| 2293 | Cello  | 82.5% | 88.7% |
| 2295 | Cello  | 83.2% | 85.3% |

2220/2242/2296 are exactly the three pieces where the prior fork's
diagnostic found the current DTW algorithm defective INDEPENDENT of
input quality (7.4%/6.8%/9.0% even with perfect ground-truth events fed
into the unchanged discrete-event DTW). Those same three pieces align
60-80 points better under a continuous-feature formulation — strong
evidence the defect lives in the discrete pitch-SEQUENCE DTW
formulation itself, not fixable by improving CREPE's event extraction
quality. 2293/2295 (where the current approach already performs
reasonably) show a small additional gain, not a regression — no piece
tested got worse.

**Also notable:** this approach's "unmatched" rate (no measure
assigned to a ground-truth note at all) is 0% on 4/5 pieces (0.9% on
the 5th), vs. the current approach's 2.3%-41.5% — every audio frame
gets some alignment by construction, so every ground-truth note gets a
prediction, right or wrong; the current discrete-event approach can
simply produce no aligned event anywhere near a given note at all.

**Runtime:** the DTW step itself is 0.08-0.3s per piece (310s of audio)
— fast, CPU-only, no GPU, no new model (chroma_cqt and
`librosa.sequence.dtw` are standard, already-installed DSP library
functions).

**What this does NOT demonstrate** (per the owning directive's own
constraint — do not confuse improved alignment with demonstrated
mistake-detection accuracy): whether `find_wrong_note_candidates` (or
an equivalent) can be adapted to consume this continuous alignment's
output and produce reliable wrong-note flags. That adaptation is a
separate, unbuilt, unverified step — only the alignment stage was
tested here. Not wired into production; no production code touched.

### Task 3/4 (2026-10-31): frozen-set validation — real, meaningful gains, but NOT a clean win; a specific, fixable weakness identified, not a fundamental flaw

Ran the same chroma-DTW experiment once against the frozen 6-piece set
(2204, 2218, 2222, 2244, 2289, 2297 — untouched until this exact
moment) alongside the real current-pipeline baseline on the same
pieces:

| piece | instrument | current (real CREPE) | chroma-DTW | delta |
|---|---|---|---|---|
| 2204 | Flute  | 31.7% | 81.1% | **+49.4** |
| 2218 | Cello  | 92.3% | 93.3% | +1.0 |
| 2222 | Cello  | 30.2% | 36.1% | +5.9 |
| 2244 | Violin | 89.7% | 47.1% | **-42.6** |
| 2289 | Violin | 92.4% | 85.4% | -7.0 |
| 2297 | Cello  | 57.7% | 87.3% | **+29.6** |

**Not a clean win.** Three pieces improve substantially, one is flat,
but **2244 regresses badly (-42.6pt) and 2289 regresses moderately
(-7.0pt)**. Both regressions are on pieces where the CURRENT pipeline
already performs very well (89.7%, 92.4%) — unlike the dev-set pieces,
where every gain came from pieces the current approach was already bad
on.

**Root cause of the regression, identified not just observed:** 2244
("4. Presto") and 2222 ("6. Gigue") are both unusually fast
(`sec_per_beat` 0.26 and 0.31 — the lowest of any piece tested, vs.
0.42-2.1 elsewhere). This prototype's chroma template uses a FIXED
`FRAME_HOP_SEC=0.10` regardless of piece tempo — too coarse to resolve
individual notes in a genuinely fast passage, where several real notes
can fall inside one 100ms template frame. 2222 (also fast) still shows
a small net gain because the current pipeline was already badly broken
there (30.2%) — less of a working baseline to lose. 2244 had an
excellent working baseline (89.7%, likely benefiting from this
project's existing within-segment pitch-jump detection, which is
specifically tuned for fast passages) and the coarse chroma template
can't match that bar. **This is a specific, explainable, plausibly
fixable implementation-parameter issue (adaptive/tempo-aware frame
resolution) in this prototype — not evidence that the continuous-
feature concept itself is unsound.**

**Decision: NOT a GO for blanket integration as-is.** The regression on
2244 is real and large enough that replacing the production DTW input
wholesale would make at least one currently-good case meaningfully
worse — unacceptable per "retain only if benefit outweighs regression."
**But this is also not a dead end requiring a restart**: the underlying
architectural idea (continuous-feature alignment, bypassing CREPE's
discrete event extraction) has now been shown, on real audio, to
substantially fix the exact pieces this project already identified as
DTW-algorithm-defective independent of input quality — a real, useful,
narrowing result. Per Task 4's own A/B/C/D framing: the remaining
problem for the CURRENT production pipeline is confirmed, again, to be
**(B) score alignment** (not audio representation, not musical-error
detection) — this experiment's own residual gap is a parameter/
resolution issue within the alternative formulation, not a new
category of problem.

**Recommended next step, not done here (would need its own validation
round):** make the chroma template's frame resolution tempo-adaptive
(e.g. proportional to the piece's locally-estimated tempo rather than a
global constant) and re-run the SAME frozen set once more before any
integration decision — this is a narrow, targeted fix to a known,
explained weakness, not a new broad investigation.

### Task 3/4 (2026-10-31, authoritative — supersedes Task 2's own preliminary self-check above): chroma-DTW does NOT generalize — NO-GO, classified as a combination problem

Ran the frozen 6-piece set (2204/Flute, 2218/Cello, 2222/Cello,
2297/Cello, 2244/Violin, 2289/Violin — opened for the first and only
time) through three conditions: (A) current pipeline, (B) chroma/CQT
alignment alone, (C) a minimal hybrid — real CREPE events, but measure
assignment via chroma-DTW's warping path instead of
`dtw_align_to_score`.

**Localization (correct %, A/B/C):** 2204: 31.8/**81.1**/70.8. 2218:
92.2/93.3/91.4. 2222: 32.2/36.1/36.2. 2297: 57.4/**87.3**/84.3. **2244:
89.6/47.1/47.3 — a severe, previously-unseen 42-point regression.**
2289: 92.5/85.4/86.5. The dev-set's two regression-check pieces (2293,
2295) were both Cello — no Violin piece with 2244's profile was tested
before now, and Violin is exactly where this breaks (avg 91.0%→66.3%
across the 2 frozen Violin pieces). Likely mechanism, not fully traced:
the chroma template uses one nominal piece-average tempo; a piece with
real local tempo variation desyncs a single global warping path.

**The metric that actually matters — wrong-pitch detection via the
verified-injection benchmark:** only 1 of 6 frozen pieces produced a
valid injection in 8 attempts (independently reproducing the dev-set's
benchmark-reliability finding on fresh data). On the one testable case,
**both the current pipeline and the hybrid missed it — zero
improvement.** n=1, but it's the only real evidence available, and
raw localization gains (B's 81.1%/87.3% above) did **not** translate
into better actual mistake detection on the one case that could be
checked — exactly the conflation the parent directive warned against.

**False positives:** improves on 2 pieces, ties on 3, **regresses on
2244 (0→6 new false flags)** — same piece as the localization collapse.

**Decision: NO-GO.** No production code touched (`worker.py`
unaffected throughout this whole investigation branch).

**Classification: (D) — a combination requiring larger architectural
changes**, not a single fixable component: (A) CREPE event-extraction
over-generation is real and confirmed dominant on 9/12 dev pieces; (B)
the alignment algorithm has TWO distinct, piece-dependent failure
modes — discrete pitch-DTW fails on some pieces, chroma-DTW fails on
others — no single formulation is uniformly correct; (C) the one
testable recall case shows the comparator/gate stage still blocks
detection even where alignment localizes reasonably. No single-
component fix addresses all three. An ensemble/per-piece-adaptive
approach is a plausible future direction, but is itself a larger
architectural change, not a minimal integration — not recommended here.

**This closes out the "Audio Recovery: Measurement Fix + New
Architecture Feasibility" directive.** Three real deliverables survive
it regardless of the NO-GO: a validated DP note-sequence evaluator
(`note_sequence_evaluator.py`), a working chroma/CQT alignment
experiment with genuine (if non-generalizing) gains on specific pieces
(`chroma_alignment_experiment.py`), and a frozen-set validation harness
(`p0_frozen_validation.py`) — all committed, all reusable for whoever
picks up the (D)-classified combination problem next.

## Priority 2 (2026-10-31): octave errors are the dominant remaining
## pitch-extraction failure post-breath-noise-fix — no safe fix found

Re-ran the full real `validate_pitch_against_tinysol.py` corpus (2,224
real isolated notes, 13 instruments; TinySOL re-downloaded fresh — the
prior round's dataset and per-clip miss list weren't retained, both
noted as regenerable scratch at the time) with a per-clip CSV dump
(`octave_error_analysis.py`, scratch, not committed — reuses
`load_rows`/`classify`/`run_pitch_tracking` unchanged) to see which
error TYPE dominates now that the breath-noise fix closed most of the
"missed" bucket.

**Real result: 2,134/2,224 correct (95.9%, consistent with the prior
95.6%), but of the 90 non-correct clips, `octave_error` is now the
single largest category — 45 clips (2.0%), more than `wrong` (27, 1.2%)
and `missed` (18, 0.8%) combined.** This directly answers what Priority
2 asked to separate out: pitch-extraction octave confusion, not score
alignment (TinySOL has no score — alignment is Priority 3's separate
MusicNet-based data) and not a missed-detection problem (the breath-noise
fix already addressed that).

**Two real, distinct, fully-explained clusters — not one problem:**

1. **Register-floor "missing fundamental," Double Bass/Tuba (13 of 45,
   all "up" by exactly one octave).** Rate is dramatic right at the
   bottom of the instrument's own declared range: 12/33 (36%) of Double
   Bass clips at true octave 1 (F#1-B1, ~46-62 Hz) are detected a full
   octave high, across all three dynamics tested. This is the textbook
   missing-fundamental failure mode — at these frequencies the
   fundamental's energy is weak relative to the 2nd harmonic, and
   CREPE's own salience function favors the harmonic even though
   `_instrument_pitch_bounds` already restricts its search window to
   [41, 524] Hz for Double Bass (worker.py:625) — the wrongly-detected
   octave-up frequency (~92-123 Hz) is itself still inside that window,
   so the existing fmin/fmax constraint cannot prevent this specific
   error.
2. **CREPE ceiling, Violin/Viola/Flute (17 of 45, all "down" by exactly
   one octave), at true octave 7 — an already-disclosed, deliberate gap,
   not a new bug.** `_instrument_pitch_bounds`'s own comment
   (worker.py:616-617) already states "CREPE tops out around 1975 Hz
   internally; violin's high E (2637 Hz) is above that — Gemini's audio
   evaluation handles the high register for violin." The TinySOL octave-7
   notes that error here (C7=2093Hz through D#7=2489Hz) are at or above
   that documented ceiling; CREPE, constrained to search only up to its
   own working limit, has nowhere to put the true pitch except an octave
   down. This is CREPE's own architectural range limit, not a
   post-processing bug — "fixing" it would mean replacing or extending
   the pitch-tracking model itself, which the directive's own
   constraints rule out ("no new model search").
3. **A third, smaller cluster (Bassoon 6, Cello 3) that does NOT fit
   either pattern** — Bassoon's errors (A3/A#3/B3/D#4, all "up") sit in
   the *middle* of its declared range (58-698 Hz), nowhere near either
   edge; Cello's (D#2, ~78 Hz) sit near its floor like the Double Bass
   case. Checked directly, not assumed: this looks like a genuine,
   known acoustic quirk (certain notes on bassoon have an unusually weak
   fundamental relative to their 2nd harmonic for bore-geometry reasons
   around that part of its range) rather than a generic "distance from
   fmin" rule.

**No fix implemented — the evidence argues against one, not for one.**
Before writing any correction, checked directly whether a "prefer the
lower octave when halving the detected frequency stays within the
instrument's bounds and the note sits low in its range" heuristic could
work: it cannot be discriminated from a case that's already correct.
Concretely, a genuinely correct Double Bass detection at A2 (110 Hz)
looks, by final pitch value alone, identical to the wrongly-doubled
A1→A2 cases above — both are "110 Hz, low in Double Bass's range, halving
stays in-bounds." Applying the heuristic would silently convert some
currently-correct low notes into new octave errors while fixing others,
with no way to tell the two apart from the decoded pitch alone. This is
the same shape of failure this investigation has already hit repeatedly
on a different problem (DTW-context pitch-jump detection, Priority 3
above): "the real-note and glitch populations overlap," confirmed there
by three separate discriminators. A real fix would need the raw CREPE
per-frame activation/periodicity surface at the candidate octave below
the decoded pitch (not exposed by a single fmin/fmax-constrained
`predict()` call) to independently confirm which octave the audio
actually supports — a materially bigger, model-internals-level change
than "one low-risk correction," and the Bassoon cluster shows the
problem isn't even uniformly "near the floor" to begin with.

**Recommendation**: do not implement an octave-correction heuristic this
round. Record as a precisely-diagnosed backlog item (added to
`agent_workspace/AGENT_TASKS.md`) rather than attempt a fix that this
round's own evidence shows cannot be safely validated with the
information a standard CREPE call exposes.
