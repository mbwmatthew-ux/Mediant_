#!/usr/bin/env python3
"""
Recover images the USER pasted into a Claude Code session.

Pasted images are visible to the model in-conversation but are not files on
disk, so they cannot be measured, colour-picked or diffed against a running
page. They ARE stored as base64 in the session transcript, so this pulls them
back out into real files.

Only images attached to *user* turns are extracted; images arriving as
tool_result blocks are the agent's own screenshots and are skipped.

Usage:
    python3 agent_workspace/extract_pasted_images.py [outdir]
"""
import base64, glob, json, os, sys, hashlib

PROJECT_DIR = os.path.expanduser(
    "~/.claude/projects/-Users-matthewwu-repos-mediant-ui-shell")
outdir = sys.argv[1] if len(sys.argv) > 1 else "agent_workspace/reference"
os.makedirs(outdir, exist_ok=True)

def images_in(content):
    """Yield image source dicts from a message content list."""
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict):
            continue
        # Agent screenshots come back inside tool_result — not what we want.
        if block.get("type") == "tool_result":
            continue
        if block.get("type") == "image":
            src = block.get("source") or {}
            if src.get("type") == "base64" and src.get("data"):
                yield src

seen, saved = set(), 0
for path in sorted(glob.glob(os.path.join(PROJECT_DIR, "*.jsonl"))):
    with open(path, errors="ignore") as fh:
        for line in fh:
            if '"image"' not in line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            msg = rec.get("message") or {}
            if msg.get("role") != "user":
                continue
            for src in images_in(msg.get("content")):
                raw = base64.b64decode(src["data"])
                digest = hashlib.sha1(raw).hexdigest()[:10]
                if digest in seen:
                    continue
                seen.add(digest)
                ext = (src.get("media_type") or "image/png").split("/")[-1]
                name = os.path.join(outdir, f"pasted-{digest}.{ext}")
                with open(name, "wb") as out:
                    out.write(raw)
                print(f"{name}  ({len(raw)/1024:.0f} KB)")
                saved += 1

print(f"\n{saved} pasted image(s) → {outdir}/")
