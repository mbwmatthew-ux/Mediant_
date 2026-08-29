"""
Precision and recall per flag type, measured against teacher annotations.

`flag_annotations` has existed since 2026-06-30 and its own migration says
"These rows ARE the training data" — but nothing ever computed anything from
them. This is that computation.

Counting rules, fixed deliberately:
  approve / edit -> true positive. An edit means the finding was REAL and the
                    wording was wrong. That is a writing problem, and folding it
                    into the detection score would hide both.
  reject         -> false positive.
  add            -> false negative: something real that was never reported.
  unlabelled     -> excluded from both. Never counted as correct — treating
                    silence as approval is how a precision number flatters
                    itself, and most flags will be unlabelled early on.

Three wrinkles on top of that, all forced by how flag_annotations actually
looks in production rather than in the idealised one-row-per-flag case:

  dedup       -- 20260829000003 deliberately dropped the UNIQUE index on
                 (take_id, teacher_id, flag_key): re-analysing a take and
                 re-annotating the same issue can legitimately leave two rows
                 sharing one flag_key. Counting both would double-count a
                 single teacher judgement and skew whichever verdict happened
                 twice. We keep only the most recent row per flag_key (latest
                 updated_at wins; see _dedup_by_flag_key for the tie-break).

  disagreed   -- the dedup above also collapses a case that isn't a duplicate
                 at all: two DIFFERENT teachers grading the same flag_key, one
                 approve and one reject. Keeping "the latest" is still the
                 right call for scoring, but silently picking a side would
                 hide a genuine split behind an artifact of who happened to
                 grade later. Every flag_key whose collapsed rows disagree on
                 `action` is counted in disagreed, same principle as
                 legacy_matched: show how much of the number rests on a
                 judgement call rather than a clean read.

  legacy      -- rows written before flag_key existed have flag_key = NULL but
                 a valid flag_index (the flag's array position at annotation
                 time). That position is only correct if the take has not
                 been re-analysed since — exactly the fragility flag_key was
                 added to fix. We don't drop these rows (that would
                 understate the corpus) and we don't silently trust them
                 either: every legacy match is tallied separately as
                 legacy_matched so a reader can see how much of a
                 precision/recall number rests on positional matching versus
                 the reliable flag_key path.
"""

_EMPTY = {"tp": 0, "fp": 0, "fn": 0, "legacy_matched": 0, "disagreed": 0}


def _apply_action(row: dict, action: str) -> None:
    if action in ("approve", "edit"):
        row["tp"] += 1
    elif action == "reject":
        row["fp"] += 1


def _dedup_by_flag_key(annotations: list[dict]) -> tuple[dict, set]:
    """Keep one annotation per non-null flag_key: the one with the latest
    updated_at. If updated_at is missing on either side, or the two are
    equal, there is no reliable signal to order by — the tie-break is then
    the last row encountered in iteration order, made explicit here rather
    than falling out accidentally from a naive string comparison.

    Also returns the set of flag_keys where the collapsed rows disagreed on
    `action` — i.e. this wasn't one teacher's re-annotation, it was two
    different verdicts and we kept one of them. Rows that all agree are not
    disagreement, even if there are several of them.

    A row with a missing or empty `action` contributes NOTHING to that set. It
    is not a verdict, so it cannot disagree with one: counting its absent action
    as a distinct value would let a single malformed row push a flag_key into
    `disagreed` on its own. `action` is NOT NULL in the schema so this cannot
    come from the database, but ACCURACY_BASELINE.md Step 2 documents feeding
    this scorer hand-assembled rows, and `disagreed` is the column that exists
    to keep the headline number honest — inflating it corrupts exactly that.
    Such rows are already ignored for tp/fp (`_apply_action` matches none of the
    known actions), so ignoring them here makes the two consistent."""
    keyed: dict[str, dict] = {}
    actions_seen: dict[str, set] = {}
    for a in annotations:
        key = a.get("flag_key")
        if not key:
            continue
        action = a.get("action")
        if action:
            actions_seen.setdefault(key, set()).add(action)
        existing = keyed.get(key)
        if existing is None:
            keyed[key] = a
            continue
        a_ts, e_ts = a.get("updated_at"), existing.get("updated_at")
        if not a_ts or not e_ts or a_ts == e_ts:
            keyed[key] = a                 # missing/tied -> last one wins
        elif a_ts > e_ts:
            keyed[key] = a                 # strictly newer -> it wins
        # else: existing is strictly newer than a; keep existing
    disagreed = {key for key, acts in actions_seen.items() if len(acts) > 1}
    return keyed, disagreed


def score_take(flags: list[dict], annotations: list[dict]) -> dict:
    """Per-type tp/fp/fn/legacy_matched/disagreed for one take."""
    keyed, disagreed_keys = _dedup_by_flag_key(annotations)
    type_of = {f.get("flag_key"): f.get("type", "unknown") for f in flags}
    out: dict[str, dict] = {}

    # Reliable path: match on flag_key.
    for f in flags:
        fkey = f.get("flag_key")
        ann = keyed.get(fkey)
        if ann is None:
            continue                       # unlabelled — not evidence either way
        row = out.setdefault(type_of[fkey], dict(_EMPTY))
        _apply_action(row, ann.get("action"))
        if fkey in disagreed_keys:
            row["disagreed"] += 1

    # Legacy fallback: flag_key absent, so match by the flag's array
    # position instead. Only annotations that actually target a shipped
    # flag qualify — 'add' rows have no AI original (flag_index is NULL by
    # convention for them, but the action check is the authoritative guard).
    for a in annotations:
        if a.get("flag_key") or a.get("action") == "add":
            continue
        idx = a.get("flag_index")
        if idx is None or not (0 <= idx < len(flags)):
            continue
        f = flags[idx]
        row = out.setdefault(f.get("type", "unknown"), dict(_EMPTY))
        _apply_action(row, a.get("action"))
        row["legacy_matched"] += 1

    # Teacher-added flags: something real the analyzer never reported.
    for a in annotations:
        if a.get("action") != "add":
            continue
        added = a.get("edited_flag") or {}
        row = out.setdefault(str(added.get("type") or "unknown"), dict(_EMPTY))
        row["fn"] += 1

    return out


def aggregate(per_take: list[dict]) -> dict:
    """Sum per-take counts and derive precision/recall per type."""
    totals: dict[str, dict] = {}
    for r in per_take:
        for ftype, row in r.items():
            acc = totals.setdefault(ftype, dict(_EMPTY))
            for k in ("tp", "fp", "fn", "legacy_matched", "disagreed"):
                acc[k] += row[k]

    for ftype, row in totals.items():
        shipped = row["tp"] + row["fp"]
        real    = row["tp"] + row["fn"]
        row["precision"] = (row["tp"] / shipped) if shipped else None
        row["recall"]    = (row["tp"] / real) if real else None
        row["n_labelled"] = shipped
    return totals


def format_report(totals: dict) -> str:
    """Fixed-width report, same shape as diagnose_coverage.py's matrix."""
    def pct(v):
        return "  n/a" if v is None else f"{v * 100:5.1f}%"

    width = 98
    lines = ["=" * width,
             f"{'FLAG TYPE':<18}{'PRECISION':>11}{'RECALL':>10}"
             f"{'TP':>6}{'FP':>6}{'FN':>6}{'LABELLED':>11}{'LEGACY':>9}{'DISAGREED':>11}",
             "=" * width]
    for ftype in sorted(totals):
        r = totals[ftype]
        lines.append(f"{ftype:<18}{pct(r['precision']):>11}{pct(r['recall']):>10}"
                     f"{r['tp']:>6}{r['fp']:>6}{r['fn']:>6}{r['n_labelled']:>11}"
                     f"{r['legacy_matched']:>9}{r['disagreed']:>11}")
    lines.append("=" * width)
    return "\n".join(lines)
