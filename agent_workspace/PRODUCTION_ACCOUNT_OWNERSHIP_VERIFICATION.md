# Production Account Ownership Verification — 2026-11-05

**Status: verification only. No audio/video content was accessed,
downloaded, or exposed — this round found it couldn't be, for reasons
below. No PII beyond what's needed to state the conclusion is
reproduced here; no raw query output (emails, names) is committed to
this file or anywhere in the repo.**

**Leading with the Task 1 finding, per the directive, because it
overturns the round's own opening premise.**

---

## Task 1 — account ownership, verified with real evidence, not assumed

Queried `auth.users` joined to `takes` and `profiles` (read-only,
`supabase db query --linked`, same already-authenticated tooling as
every prior round this week) for the 34 accounts that own at least one
take, compared against the owner's known email (`mbwmatthew@gmail.com`).

**Result: these are overwhelmingly NOT internal test accounts.**

- **1 of 34 accounts** (92 takes) is the owner's own
  (`mbwmatthew@gmail.com`) — confirmed by exact email match.
- **1 of 34 accounts** (84 takes) has no display name and an email
  that is neither the owner's address nor an obvious `test+N@...`
  pattern. **It cannot be confirmed either way from available data and
  is explicitly NOT cleared** — per the directive's own instruction,
  this is flagged and stopped on, not assumed to be the owner's
  alternate account.
- **The remaining 32 accounts** (56 takes) have distinct, real-looking
  individual names and email addresses — different people, different
  email providers, and several on real institutional domains
  (including a US private school and schools in two other countries).
  **These are clearly real third-party users, not the owner's own
  test accounts.** No `test+N@`, no internal/dev domain, no pattern
  suggesting otherwise appears anywhere among them.

**Second check, as the directive required: account ownership ≠ who is
playing.** `teacher_students` (the only schema mechanism that could
link one account's upload to another person) has **zero rows in the
entire production database** — no shared-take or student-upload
mechanism is in use at all, for any account, confirmed directly. For
the one confirmed-owner account specifically, its 92 takes show a
consistent pattern — single instrument (Clarinet) across only 4
distinct piece titles, with many repeated takes of the same few
pieces — the shape expected of a developer repeatedly re-testing their
own pipeline on their own playing, not of varied third-party content
funneled through one account. This is circumstantial, metadata-level
support, not proof (nothing short of listening could be literal
proof, and that's exactly the content-access line this task does not
cross except where explicitly cleared) — reported as such, not
overstated.

**Conclusion: only the 92 takes under the confirmed owner account are
cleared. The 84 under the unresolved account, and all 56 under the
32 clearly-third-party accounts — 140 of 232 takes (60%) — remain
exactly where the prior round left them: real users' private
recordings, not authorized for content review under the current
Privacy Policy.** The consent-policy-drafting work from immediately
before this directive is superseded by this one per the coordinator's
instruction, and is left uncommitted — it may still be useful later if
the owner decides to pursue broader review, but nothing in it is
adopted or needed for what follows, which touches only the
owner's own confirmed data.

---

## Task 2 — inventory of the 92 Task-1-cleared takes (metadata only)

| | Count |
|---|---|
| Total (owner-confirmed account) | 92 |
| `job_status = 'done'` | 84 |
| `job_status = 'failed'` | 8 |
| Format | **100% `video/quicktime`** — zero audio-only takes on this account |
| Has a score (`score_path`/`score_paths`) | 55 of 92 (53 of the 84 `done`) |
| `done` + has score (the clean candidate pool) | **53** |
| Instrument labeled | 43 (all Clarinet (B♭)); 49 have no instrument set (mostly older takes predating that column, or score-less) |
| `done` + has score + instrument labeled | **40, all Clarinet** |

**A real, material limitation found here, not a workaround attempted:**
Task 2 asked for actual duration and audio-quality inspection on
cleared takes. **`duration_seconds` is a real DB column that is never
populated (0/92, same as the whole table)**, and **no credential
available in this environment can reach Storage** (the actual video
bytes) — the Supabase CLI's `--linked` access (used for every query
above) reaches the Postgres database via the Management API; it does
not reach Storage objects, which require a service-role key or a
signed URL. Checked directly: no service-role key exists anywhere in
this environment's env vars or `.env` files (only the public anon key,
which is RLS-scoped to `auth.uid()` and couldn't read another user's
row let alone a file), and no existing script or tool in this repo
already holds one. **This was not worked around — per both this
round's and last round's standing rule, no new production credential
was created.** The right, already-existing tool for whenever file
access IS available is confirmed and named, not reinvented:
`extract_audio_from_video` (`modal_worker/worker.py:557`, ffmpeg-based,
already used live at lines 3417 and 10203) — this is exactly what Task
2 asked to reuse, and nothing new was built in its place.

**Consequence: even for the 92 Task-1-cleared, policy-and-ownership-
authorized takes, actual audio-quality inspection, selection by
"readable audio," and any direct evaluation are blocked by a tooling/
access gap, not a policy gap.** This is the same category of limit
flagged in the 2026-11-05 inventory round, now confirmed to persist
even after ownership clears — it is an environment capability
question for the owner, not something resolvable by trying harder
within this sandbox.

---

## Task 3 — selection: not performed, and explained why

The directive's selection criteria ("diverse, readable audio") cannot
be met even in principle from the cleared pool: **all 53 clean
candidates are one instrument (Clarinet) on one account**, and
"readable audio" cannot be assessed without the file-access this
environment doesn't have. Selecting a subset without being able to
confirm either diversity or audio readability would not meet the
directive's own bar — naming a list of take IDs here would not be a
real selection, just a guess dressed as one. **Not done, rather than
done badly.**

---

## Task 4 — not started, per the directive's own fallback instruction

"Do not start any new model experiment before labels are actually
ready — if labeling isn't realistically finishable this round, say so
and stop at Task 3's output instead of rushing Task 4." Labeling isn't
reachable this round (Task 3 didn't produce a subset, for the reasons
above) — stopping here, as instructed, rather than fabricating an
evaluation.

---

## Summary

- **60% of the inventoried takes (140/232) are confirmed or
  unresolved third-party user data** — not touched, not inspected,
  not cleared, consistent with every privacy-related finding this
  week.
- **40% (92/232) are confirmed the owner's own** — but 100% video,
  single-instrument, and currently inaccessible at the file level from
  this environment regardless of ownership, because no storage
  credential is configured here.
- **No audio or video content was opened, played, or exposed at any
  point this round.**
- **One exact next action for the owner**, not more agent work this
  round: either (a) provide a way for this environment to read the
  owner's own confirmed Storage files specifically (e.g., a scoped
  service-role credential, or the owner downloading/forwarding a
  handful of their own 53 clean Clarinet takes directly) so Task 2's
  quality inspection and Task 3's selection can actually run, or
  (b) treat the already-written live-recording plan
  (`agent_workspace/REAL_MISTAKE_RECORDING_PROTOCOL.md`) as the
  faster path, since it was never blocked by either the consent gap
  or this file-access gap.
