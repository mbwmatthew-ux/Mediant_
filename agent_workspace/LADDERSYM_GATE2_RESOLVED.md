# LadderSym Gate 2 — RESOLVED. Transformers bump unblocks the environment; real checkpoint loads and runs on CPU.

2026-10-30. Per the owner's "Gate 2 Recovery and Launch-Readiness Directive,"
Track A (timeboxed ~2hr, actual time ~10 minutes). All work stayed inside
the isolated venv from Gate 2
(`/private/tmp/.../scratchpad/laddersym_eval/`); no production code,
dependencies, or architecture were touched. No Rosetta, no extensive
reconstruction.

## What was done, in the order the directive specified

**1-2. Inspected exact imports.** `models/laddersym_t5.py` (the model
actually used by the `coco_prompted` checkpoint) imports from `transformers`:
`T5Config`, `T5PreTrainedModel` (top-level), and `Seq2SeqLMOutput`,
`BaseModelOutput`, `BaseModelOutputWithPastAndCrossAttentions`,
`T5LayerNorm`, `T5Block` (from `transformers.models.t5.modeling_t5`). The
file's own header says it's "Copy from .../modeling_t5.py" — confirming
the earlier Gate 2 finding that this is a vendored T5 reimplementation, not
a thin subclass. Only the **decoder** uses `T5Stack`/`T5Block` — the
encoder is a separate vision-transformer backbone
(`laddersym_base_patch16_224`), unaffected by `transformers` version at all.

**3. Smallest viable dependency adjustment.** Checked PyPI's actual file
listing (not assumed): `tokenizers==0.13.3` is the oldest version with an
arm64 macOS wheel for Python 3.11 (`cp311-macosx_12_0_arm64` and a
`universal2` build). Checked which `transformers` versions allow that
tokenizers version: `4.18.0` requires `tokenizers<0.13` (the original
blocker); `4.24.0` relaxes this to `tokenizers<0.14,>=0.11.1`, which
`0.13.3` satisfies. A `pip install --dry-run` of the full `requirements.txt`
with ONLY `transformers` bumped `4.18.0 -> 4.24.0` (everything else
untouched) resolved every other package — including `huggingface_hub`,
`numpy`, `torch==2.3.0` — at their **original pinned versions**, with zero
source builds. Installed for real: 30 seconds, all wheels.

**4. Tested model construction + forward WITHOUT the checkpoint.** Built
the real `T5Config` from `config/model/laddersym_prompt_MT3Net.yaml`'s
actual hyperparameters (`d_model=512, num_heads=6, num_layers=8,
vocab_size=1536`, etc.), constructed `T5ForConditionalGeneration`, and ran
one decoder forward pass with dummy-shaped tensors. This specifically
exercises `T5Stack.forward()`'s direct call into `T5Block(...)` with the
**old (pre-refactor) calling convention** — tuple-based `past_key_value`,
positional-tuple outputs — which is exactly the cross-version risk Gate 2
flagged (HuggingFace has since migrated many models to `Cache`-object-based
attention). **Result: passed cleanly under `transformers==4.24.0`** — no
signature mismatch. (One unrelated `TypeError` surfaced first, from
LadderSym's own `use_prompt` code path requiring an explicit
`initial_prompt_lengths` list — not a `transformers` compatibility issue,
fixed by passing `[0] * batch_size`.)

**5. No architecture/shape/numerical changes made.** Confirmed — only the
`transformers` pin changed; `models/laddersym_t5.py` is untouched.

**6-7. Checkpoint-loading mechanism + one CPU smoke test.** Downloaded
*only* the single already-approved file — `ben2002chou/laddersym-checkpoints`
on Hugging Face Hub, `checkpoints/cocochorales/prompted/model.ckpt` (2.07GB,
matches the size reported in the original feasibility report) — via
`hf_hub_download`, not a full snapshot. (First attempt used the wrong
`repo_id`, `ben2002chou/CocoChorales-E` — that's the *dataset* repo; the
checkpoints live in a separate `ben2002chou/laddersym-checkpoints` repo,
found by reading `setup_laddersym_assets.py`'s own download logic.)

`torch.load`'d the raw PyTorch Lightning checkpoint and compared its
740-key `state_dict` directly against the freshly-constructed model's own
state dict (prefixed `model.` to match the Lightning wrapper's
`self.model` attribute, read from `tasks/laddersym_mt3_net.py`):

- **Keys in model but not in checkpoint: 0**
- **Keys in checkpoint but not in model: 0**
- `load_state_dict(strict=True)` succeeded with 0 missing, 0 unexpected keys.

This is the strongest possible evidence against the cross-version risk Gate
2 raised — not just "it probably still matches," but an exact 740/740 key
match, loaded strictly, with the checkpoint trained against whatever
`transformers` version LadderSym's original authors used.

Ran one CPU forward pass through the now-real-weight-loaded decoder (dummy
input shapes — this is a load+forward functionality check, not the Gate 3
real-audio pilot, which is separately scoped and not run here): completed
in 23ms, correct output shape `(1, 6, 1536)`.

## Resource usage (full run: checkpoint load + strict weight load + forward)

- Wall time: 5.2s total (0.6s `torch.load`, 0.25s `load_state_dict`, 0.02s
  forward — the rest is Python/import/vision-backbone-construction overhead).
- Peak memory footprint: ~3.08GB (`/usr/bin/time -l`), consistent with a
  ~2GB fp32 checkpoint plus a second in-memory copy during load.
- CPU-only throughout (`torch.cuda.is_available()` was never queried as
  true in this environment) — confirms the earlier feasibility report's
  note that CPU inference is a supported fallback path, not merely
  theoretical.
- Disk: checkpoint file at
  `/private/tmp/.../scratchpad/laddersym_eval/checkpoint_download/` (2.07GB,
  outside the Mediant repo and outside git).

## Exact versions (for reproducibility)

- Python 3.11.18 (Homebrew), isolated venv from Gate 2.
- `transformers==4.24.0` (bumped from the repo's pinned `4.18.0`).
- `tokenizers==0.13.3` (auto-resolved; not manually pinned).
- Every other dependency installed at its exact `requirements.txt`-pinned
  version: `torch==2.3.0`, `torchaudio==2.3.0`, `huggingface_hub==0.23.0`,
  `numpy==1.26.4`, `pytorch-lightning==2.2.3`, `librosa==0.9.1`, etc.
- Patched requirements file (not committed to the repo — lives in the
  scratchpad): `requirements_patched.txt`, a one-line diff from the
  original (`transformers==4.18.0` -> `transformers==4.24.0`).

## What this does and does not mean

**Resolved:** the dependency-reconstruction blocker from
`LADDERSYM_GATE2_FINDINGS.md`. A one-line version bump — not Rosetta, not
relaxed/loosened pins across the board, not a rewrite — gets a real,
isolated environment that installs cleanly on Apple Silicon, constructs the
exact model architecture, and loads the exact official checkpoint with a
byte-for-byt key match.

**Not yet done, and not authorized by this directive:** Gate 3's actual
12-case inference pilot (real audio, real score-conditioned mistake
detection, comparing output against the 4 injected-mistake conditions) —
that requires wiring up the full input pipeline (mel-spectrogram extraction,
vocabulary encoding, prompt construction) this smoke test deliberately
skipped in favor of dummy-shaped tensors. This document reports
environment + checkpoint compatibility only — it says nothing about
LadderSym's actual detection accuracy on real Mediant-style mistakes.
