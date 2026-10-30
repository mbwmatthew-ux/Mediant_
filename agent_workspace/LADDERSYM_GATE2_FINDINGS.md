# LadderSym Gate 2 — checkpoint setup: BLOCKED on dependency reconstruction

2026-10-30. Per the owner's explicit stop condition ("If significant
dependency reconstruction or impractical memory requirements arise, stop
and report before proceeding"), **this report stops before downloading
the checkpoint.** Gate 3 has not started.

## What was verified before hitting the blocker

- **Repo identity**: cloned `github.com/ben2002chou/LadderSYM` at commit
  `381179754cf6bcb435f9decf0d5e24eada6c68ec` (2026-07-26), matching the
  repo already inspected for Gates 1/1B.
- **License**: confirmed MIT again directly from the cloned `LICENSE` file.
- **Disk space**: 562GiB available — not a constraint.
- **Isolated environment**: created a dedicated venv
  (`/private/tmp/.../scratchpad/laddersym_eval/venv`) using Python 3.11
  (matching the repo's documented requirement; this machine only had 3.13
  previously, installed 3.11 via Homebrew alongside it — does not touch
  or replace any existing Python installation or production dependency).

## The blocker

`pip install -r requirements.txt` fails building `tokenizers` (required by
the pinned `transformers==4.18.0`, which needs `tokenizers>=0.11.1,<0.13,
!=0.11.3`). Root-caused, not just observed as a generic failure:

1. **No prebuilt wheel exists for this `tokenizers` version range on any
   Apple Silicon (arm64) macOS target, for any Python version.** Checked
   PyPI's actual file listing for `tokenizers==0.12.1` (the newest version
   in the allowed range) directly: wheels exist for macOS only up through
   `cp39`, and only as `x86_64` — never `arm64`. This library predates
   wide Apple Silicon wheel support.
2. **Compiling it from source fails** on this machine's current Rust
   toolchain: `error: casting &T to &mut T is undefined behavior... deny
   (invalid_reference_casting) on by default`. This is a strict lint that
   a modern `rustc` treats as a hard error; the `tokenizers` crate's
   source at this old version predates that lint being enforced this
   strictly.

## Why the two obvious workarounds are not "just try it" fixes

- **Relax the `transformers`/`tokenizers` version pins to something with
  modern wheels**: checked what `transformers` is actually used for in
  the model code before assessing this, not assumed low-risk. The custom
  model (`models/laddersym_t5.py`) is a heavily modified, vendored copy of
  HuggingFace's own `modeling_t5.py` from that era (confirmed — the file's
  own header comment says "Copy from
  .../transformers/.../modeling_t5.py") — most of the T5 forward-pass
  logic is self-contained, which reduces cross-version risk somewhat. But
  it still imports `T5Config` and `T5PreTrainedModel` live from whichever
  `transformers` version is installed, and the released checkpoint's
  state-dict was saved against transformers 4.18.0-era base-class
  behavior. PyTorch Lightning's `load_from_checkpoint` does strict
  state-dict key matching by default — a version bump risks a real load
  failure or, worse, a load that silently succeeds with subtly different
  base-class behavior. This is untested, not merely theoretical.
- **Run an x86_64 (Rosetta-emulated) Python instead of native arm64**,
  since x86_64 wheels do exist for this old `tokenizers` range: this
  would use the exact pinned versions unmodified (lower correctness risk
  than relaxing pins), but means standing up a second, emulated Python
  toolchain side by side with the native one — a real, separate piece of
  environment construction, and inference would run slower under
  emulation (relevant to the resource-usage report Gate 2 itself asks
  for).

Both cross the line the owner drew. Neither was attempted further without
approval.

## Options

1. **Approve relaxing the transformers/tokenizers pins** to modern
   versions with native arm64 wheels, accepting the checkpoint-loading
   risk above as something to test empirically (it may just work, or may
   fail cleanly at `load_from_checkpoint` — either outcome is itself
   informative and cheap to find out) before trusting any downstream
   result.
2. **Approve setting up an x86_64/Rosetta Python environment** instead —
   lower correctness risk, more environment-construction and ongoing
   performance cost.
3. **Stop here.**

No checkpoint has been downloaded. No model has been loaded. No
production code or dependencies were touched — only a new, isolated venv
outside the Mediant repo.
