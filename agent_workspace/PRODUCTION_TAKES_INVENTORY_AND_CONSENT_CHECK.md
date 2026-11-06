# Production Takes Inventory & Consent Check — 2026-11-05

**Status: read-only inventory + consent check. No private recording's
audio/video content was downloaded, opened, played, or exposed. No
individual take was selected or identified. No production data of
any kind is reproduced below beyond aggregate counts.**

---

## Access method (Task 1)

The Supabase CLI in this environment (`/opt/homebrew/bin/supabase`,
v2.98.2) is already authenticated and linked to the production project
(`Mediant-collaboration`, ref `xcutbsggzykegtbbebqo`) — confirmed via
`supabase projects list`. `supabase db query --linked` executes SQL
against the linked project's database through Supabase's Management
API. **This path bypasses Row-Level Security** (it is not using the
app's anon key, which is all that's in this repo's `.env`/`mobile/.env`
— only `VITE_SUPABASE_ANON_KEY` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`, both
subject to RLS and scoped to `auth.uid() = user_id`, meaning neither
could read another user's rows at all). No service-role key or new
credential was set up or used — this is pre-existing, already-
configured tooling, used here strictly for read-only `COUNT`/`GROUP
BY` aggregate queries. No `SELECT *`, no individual row content, no
storage-bucket access of any kind was performed.

**Storage access was NOT attempted and is not available from this
environment without a credential this task explicitly forbids setting
up.** The `recordings` storage bucket's policies
(`supabase/migrations/20260517_create_takes.sql`) only grant read
access to the owning authenticated user (`auth.uid() = (storage.foldername(name))[1]`)
— there is no service-role or admin bypass policy defined for it.
Reading actual file metadata (duration, sample rate) would require
either a service-role key (not set up, per the directive) or signing
in as a specific real user (not done, and not appropriate). This is a
genuine, reportable access limitation, not a workaround.

---

## Inventory findings (counts/metadata only)

Real, current counts from the `takes` table (not the ~199 previously
reported — real growth since the last audit):

| Metric | Count |
|---|---|
| Total takes | **232** |
| Distinct users | **34** |
| `job_status = 'done'` (succeeded) | 204 |
| `job_status = 'failed'` | 23 |
| `job_status = 'processing'` | 5 |
| Has `instrument` set | 152 (131 of the 204 `done`) |
| Has a score (`score_path` or `score_paths`) | 94 (76 of the 204 `done`) |
| Has BOTH instrument AND score, job `done` | **63** |
| Has `duration_seconds` populated in the DB | **0** — this column exists but is never populated in practice; a real, reportable finding, not an assumption |
| Any existing flag of any kind (`flags` non-empty) | 184 — **these are production's own existing, imperfect `find_wrong_note_candidates`-style flags, NOT verified mistakes; per the directive, never to be treated as ground truth** |
| Existing teacher-verified flag annotations (`flag_annotations` table) | **0** — re-confirmed; the 2026-10-11 audit's "zero teacher annotations exist" finding still holds today, even with 232 takes now vs. 199 then |

**File type — a material finding for the risk assessment below:**
by MIME type, 208 of 232 (90%) are **video** (`video/quicktime` 145,
`video/mp4` 63); only 24 (10%) are audio-only (`audio/x-m4a` 14,
`audio/mpeg` 9, `audio/wav` 1). **Most of what exists is video of real
users, not audio-only recordings** — a materially more sensitive
category than anything else touched this investigation.

**Instrument breakdown** (152 takes with instrument set): Cello 68,
Clarinet (B♭) 45, Violin 15, Piano 10, Bassoon 4, Tuba 3, Classical
Guitar 1, Electric Guitar 1, Voice 1, Guitar 1, Trumpet 1, Flute 1,
Snare Drum 1, (null) 80.

**Test/seed data check:** no take title or composer contains "test"
(`ILIKE '%test%'` = 0 hits). 26 takes still carry the schema's literal
default `piece_title = 'Untitled'` and 153 carry the default
`piece_composer = 'Unknown'` — these are column defaults for
user-uploaded pieces lacking metadata, not evidence of seed/test data.
**No DB-level flag distinguishes test from real data at all** — there
is no `is_test` column or equivalent; this inventory cannot rule out
a small number of the 232 being developer test uploads with full
confidence, only that none are obviously labeled as such.

---

## Consent check (the decisive finding) — Task 2 NOT executed

Checked the actual, live consent/privacy copy directly
(`src/pages/Privacy.jsx`) rather than assuming permission. It states:

> "To improve Mediant's analysis accuracy (**aggregate and anonymised
> only**)."

This is real, existing, stated consent — but it is explicitly scoped
to **aggregate, anonymized** use. **A human reviewer individually
listening to a specific, identifiable take and writing down exactly
what mistake occurred, where, is neither aggregate nor anonymized** —
it is per-individual, content-level review of one real person's
actual recording (90% of which are video, often inherently more
identifying than audio alone). No other consent language anywhere in
`Privacy.jsx` or `Terms.jsx` covers individual manual review by a
human for annotation purposes.

**This is a real gap between what users consented to and what Task 2
of this directive asked for.** Per the directive's own instruction
("do not stretch an inventory finding into permission it doesn't
have"), **Task 2 (selecting specific real takes for annotation) was
NOT executed.** No individual take was identified, selected, or
earmarked. The 63-take "viable by metadata" count above is reported
as an inventory fact only — it is not a cleared shortlist.

---

## Task 3 — annotation workflow, specified in the abstract (not run, not blocked on this round's consent gap)

This workflow is written so it is ready to apply WHICHEVER real-data
source eventually becomes available and authorized — the live-
recording plan (which has its own, already-explicit informed consent
built into the protocol, since the performer IS the reviewer), a
third-party musician under a direct agreement, or production takes IF
and when a clear, explicit, informed consent path for individual
review exists (an opt-in flag, an update to the Privacy Policy, or
direct outreach to specific consenting users — none of which this
task was authorized to create).

**Per-take review record (reusing the exact shape already established
this week — `REAL_MISTAKE_RECORDING_PROTOCOL.md`'s manifest and
`inject_audio_mistakes.py`'s own verified-injection fields, same
spirit, applied by a human instead of an automated check):**

| Field | Source |
|---|---|
| `take_id` / `recording_id` | Existing take ID (production) or manifest ID (live recording) |
| `instrument` | Already on the take, or from the manifest |
| `score_reference` | `score_path` (production) or the already-cached MusicXML (live recording) |
| `candidate_timestamp` | **May be auto-suggested** (see below) but is never the label itself |
| `expected_pitch_or_onset` | Read directly off the score at the candidate measure — by the reviewer, looking at the score |
| `actual_audible_pitch_or_onset` | **Only filled in after a human reviewer independently listens** and confirms what was actually played/heard |
| `measure_number` | From the score |
| `verification_status` | `confirmed_error` / `confirmed_correct` / `inconclusive` — never defaults to "confirmed" |
| `reviewer_confidence` | Low / medium / high, the reviewer's own stated confidence |
| `reviewer_notes` | Free text, including any OTHER issue noticed — never silently dropped, same rule as the live-recording manifest |

**Automatic analysis may surface candidates, never supply the
label:** production's own `find_wrong_note_candidates` output and the
Basic Pitch + `AudioToScoreMatcher` adapter's flags (both already
built, both already measured against synthetic data all week) can be
run against a take to generate a short list of `candidate_timestamp`
values worth a reviewer's attention first — this only speeds up WHERE
a human looks, exactly as the directive specifies. The
`verification_status` and `actual_audible_pitch_or_onset` fields are
set ONLY by a human listening, never copied from either detector's
own output — doing otherwise would be the same circularity problem
the whole 2026-11-05 contextual-verification round was built to avoid
(trusting an automatic disagreement as if it were a confirmed label).

**Lightweight local helper (described, not built this round):** a
small script that, given a take's existing `flags` JSON and score, lists
candidate timestamps in a plain text or CSV file a reviewer could page
through while listening — no new web UI, no dashboard, no new
dataset infrastructure, purely a local convenience for whoever
eventually does the listening. Not built this round because there is
currently no authorized data to run it on.

---

## Task 4 — decision

**Recordings exist in a real, non-trivial quantity (63 takes with both
instrument and score metadata present), but they are NOT clearly
authorized for individual human-review annotation under the existing,
published consent terms** (which cover only aggregate/anonymized
analysis-accuracy use). Proceeding to annotate specific real users'
specific takes — 90% of which are video — would exceed what has been
disclosed to those users, regardless of good intent or internal-only
handling.

**Smallest practical fallback, both already available and unblocked
by this finding:**
1. The live-recording plan already written this session
   (`agent_workspace/REAL_MISTAKE_RECORDING_PROTOCOL.md`) — the
   performer IS the consenting party, so no third-party consent gap
   exists. Still needs the owner (or someone they recruit) to actually
   record, as already stated.
2. A third-party musician recorded under a direct, explicit agreement
   for this specific purpose — functionally the same plan, different
   performer.

**Not recommended:** pursuing production takes for this purpose
without first updating the Privacy Policy (or obtaining specific,
informed, opt-in consent from the individual users whose takes would
be reviewed) to explicitly cover individual human review for
evaluation/annotation purposes — a real product/legal decision for the
owner to make deliberately, not something to infer from an inventory
count.

No production code was changed. No private recording's audio/video
content was accessed, downloaded, or exposed. No individual take was
identified or selected.
