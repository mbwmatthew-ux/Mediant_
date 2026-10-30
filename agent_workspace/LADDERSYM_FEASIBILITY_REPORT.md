# LadderSym feasibility and benchmark-preparation report

Prepared 2026-10-30, read-only research per owner request. No model weights
downloaded, no inference run, no production code touched, no fine-tuning,
no CREPE/DTW changes. This report ends at a go/no-go request — nothing
below has been executed.

## 1-2. Inputs — confirmed directly from the real inference code

Fetched and read `laddersym_test_inference.py` and `inference_error.py`
(the real `InferenceHandler.inference()` implementation) from
`github.com/ben2002chou/LadderSYM`, not inferred from the README summary.

| Input | Format | Confirmed from |
|---|---|---|
| `mistake_audio` (the take being checked) | WAV, loaded via `librosa.load(path, sr=16000)` — **16kHz mono** | `laddersym_test_inference.py:load_audio`, `InferenceHandler.SAMPLE_RATE = 16000` |
| `score_audio` | WAV, same 16kHz mono load | same — variable/parameter naming (`score_audio`, default filename `score.wav`) indicates **rendered/sonified audio of the score**, not a human reference performance |
| `prompt_file` (symbolic score) | MIDI file, default filename `score.mid`, read via `note_seq` | `laddersym_test_inference.py` default `prompt_filename`; only consumed when `cfg.use_prompt=True` |
| `mistake_midi_path` (optional) | MIDI file, default-located alongside `mistake_audio` as `mistake.mid` | used only to copy a tempo map onto the output — **not required** for inference to run |
| **Segmentation** | ~2.048s windows (256 mel frames × 8ms hop, 125 fps @ 16kHz/hop_width=128), auto-windowed across the full clip by `_split_token_into_length`/`_batching` — **the caller does not need to pre-chunk audio**, confirmed by reading `_preprocess`/`_batching` directly, not assumed from the paper's "2.145s segments" claim | `contrib/spectrograms.py`, `inference_error.py` |
| **Output labels** | 3-track MIDI, note-level classes `{"Correct": 0, "Missing": 1, "Extra": 2}` — **there is no separate "wrong pitch" class.** A wrong-pitch mistake surfaces as a co-located Missing (expected note) + Extra (played note) pair, not a unified label | `contrib/preprocessor.py: ERROR_CLASSES` |
| **Compute path** | `model.cuda()` if `torch.cuda.is_available()`, else CPU — **CPU inference is a real, supported fallback**, not assumed | `laddersym_test_inference.py:main()` |

## 3. Can Mediant's existing assets satisfy this contract?

**Mostly yes, with one real gap — stated explicitly, not silently substituted.**

- **`mistake_audio`:** Yes. Track B's existing held-out MusicNet audio
  (real or `inject_audio_mistakes.py`-injected) satisfies this after a
  sample-rate conversion (MusicNet is 44.1kHz; LadderSym wants 16kHz mono).
  Resampling doesn't alter mistake timing/identity, consistent with "no
  ground-truth change."
- **`prompt_file` (MIDI score):** Yes, directly. Track B already has the
  real reference MIDI for every held-out piece
  (`/Users/matthewwu/.cache/mediant_validation/data/midis/*.mid`) — no new
  asset needed.
- **`score_audio` (rendered score sonification): the one real gap.**
  Track B's existing pipeline has never generated a sonified/rendered audio
  of the MIDI score — it only has the real MusicNet recordings (used as
  both ground truth and injection source). Mediant's own "AI reference
  audio" feature (deployed, uses `pyFluidSynth`) is the natural production
  analog, but I have not confirmed it against this exact input contract
  (sample rate, mono/stereo, loudness normalization) — that would need a
  direct read of its code before relying on it, which I have not done here.
  **Smallest viable solution for this benchmark specifically:** use each
  held-out piece's own original, unmodified MusicNet recording (already
  in hand, pre-injection) as `score_audio`, resampled to 16kHz mono. It is
  a real, correct performance of the piece — arguably more faithful than a
  synthetic MIDI sonification — and needs zero new tooling. **This is a
  substitution, stated here explicitly, not a silent one:** it is not what
  Mediant's real production reference-audio feature would supply (a
  synthesized rendering, not a second real recording), so a result based
  on it should be read as "does LadderSym work given a real reference
  performance," not "does it work given Mediant's actual synthesized
  reference audio." If the benchmark result is promising, confirming
  compatibility with Mediant's actual synthesized reference-audio output
  would be a follow-up before any further commitment, not before this
  benchmark.

## 4. Checkpoint sizes — confirmed without downloading

Checked via `HEAD` request to Hugging Face's resolve endpoint
(`x-linked-size` header reports the real backing-store size without
transferring the file):

| Checkpoint | Size |
|---|---|
| `checkpoints/cocochorales/prompted/model.ckpt` | **2,070,131,837 bytes ≈ 1.93 GiB** |
| `checkpoints/maestro/prompted/model.ckpt` | **2,070,132,220 bytes ≈ 1.93 GiB** |

Both checkpoints are ~2GB — large enough to need explicit approval before
downloading (per the owner's constraint), but not an unusually large
download by model-weight standards. Caveat: `modelcheckpoint.save_weights_only: False`
in the published training configs — if the released checkpoint carries full
Lightning training state (optimizer, scheduler) rather than a stripped
inference-only `state_dict`, the real inference-time memory footprint could
be smaller than 2GB suggests. This can't be confirmed without loading the
file, which has not been done.

## 5. Which checkpoint — do not assume MAESTRO generalizes

**Recommended: `checkpoints/cocochorales/prompted/model.ckpt`, not MAESTRO.**

Confirmed directly from the repo's own config defaults, not assumed:
`config/config_coco_prompt.yaml` sets `use_prompt: True` and
`defaults: - dataset: CocoChorales`. CocoChorales-E is the dataset covering
13 non-piano instruments including flute, violin, and cello (confirmed
earlier from the paper); MAESTRO-E is piano-only. Using the MAESTRO
checkpoint for violin/cello/flute would be testing the model on
instruments it was never trained to detect errors in — not a fair or
meaningful test of LadderSym's real capability for Mediant's instruments.
"Prompted" (not "unprompted") is the right variant because it's the one
that actually uses the symbolic MIDI score — the input Mediant can supply
from its own ground truth — and matches LadderSym's own stated
architectural improvement over Polytune (interleaved score prompting).

## 6-7. Proposed minimal offline benchmark

Reuses Track B's existing infrastructure end to end — no new ground truth,
no CocoChorales-E/MAESTRO-E download (not needed; Mediant's own held-out
MusicNet pieces serve as an independent test set the model was never
trained on).

**Procedure:**
1. Select a small subset of Track B's already-validated held-out pieces
   restricted to flute/violin/cello (the in-coverage instruments) — e.g.
   the same 3 pieces reused across Task 4A/4B for direct comparability,
   plus a few more for a slightly broader read.
2. For each piece: `mistake_audio` = real or injected recording (resampled
   16kHz mono); `score_audio` = that piece's own original unmodified
   recording (resampled 16kHz mono, per the Section 3 substitution,
   stated explicitly); `prompt_file` = the existing reference `.mid`.
3. Download the one recommended checkpoint (pending separate approval).
4. Run LadderSym's own `laddersym_test_inference.py` locally, CPU first.
5. Parse the output 3-track MIDI and score against ground truth.

**Metrics (all computable from the output MIDI vs. known ground truth):**
- **Exact-match mistake-type and measure-localization accuracy** — for
  `deleted_note`/injected omissions, a direct hit against the "Missing"
  track; for `wrong_pitch`, scored as a hit only if BOTH a "Missing" (at
  the original pitch/time) AND an "Extra" (at the new pitch/same time) are
  present, since LadderSym has no unified "wrong note" class (Section 2) —
  scoring it as a single-flag hit would overstate accuracy relative to
  what the model actually outputs.
- **Missing-note F1 and Extra-note F1**, computed directly against the
  known injected ground truth, the same metric family the paper itself
  reports (so results are comparable to the published 56.3%/86.4% numbers).
- **Unsupported-flag rate on unmodified controls** — any Missing/Extra
  flag on a control piece, directly comparable to Track B's existing
  100%-control-false-positive CREPE+DTW number and Task 4A/4B's Gemini
  numbers.
- **Runtime** — wall-clock per piece, CPU first, GPU only if CPU proves
  impractically slow.
- **Resource usage** — peak RAM during checkpoint load + inference, and
  GPU VRAM if a GPU run is needed.

## 8. Licensing — commercial compatibility

- **Code** (`github.com/ben2002chou/LadderSYM`): plain **MIT**, confirmed
  by reading the actual `LICENSE` file content (no additional restriction
  clauses beyond standard MIT).
- **Checkpoints** (`huggingface.co/ben2002chou/laddersym-checkpoints`):
  **MIT**, confirmed via the Hugging Face model card metadata
  (`license: mit`).
- **Datasets** (CocoChorales-E, MAESTRO-E): **CC BY 4.0** (attribution
  required), confirmed via Hugging Face dataset card metadata. **Not
  needed for this benchmark** — Mediant's own MusicNet-derived data is the
  test set — but relevant if CocoChorales-E/MAESTRO-E were ever used for
  anything downstream (e.g. future fine-tuning, which is out of scope
  here).

All clean for commercial use. No GPL/non-commercial/research-only terms
anywhere in this chain.

## Integration/dependency complexity — a real, concrete risk

`requirements.txt` pins old, specific versions:
`transformers==4.18.0`, `torch==2.3.0`, `librosa==0.9.1`,
`pytorch-lightning==2.2.3`, among others. This environment already has
`librosa` at a newer version (0.10.2, installed for Task 4A/4B) and no
`torch`/`transformers`/`pytorch-lightning` at all. Running LadderSym's
inference script as published would need an **isolated environment**
(venv/conda), not the bare system Python already used for the Gemini
pilots, to avoid breaking anything already installed. This is a real
but bounded setup cost, not a blocker.

## Expected compute cost

- **Local (this machine, CPU):** No API cost. Real wall-clock cost is
  unmeasured — the benchmark's own runtime metric (Section 7) is the way
  to get a real number rather than guess one.
- **Modal, if escalated to GPU:** Mediant's production worker currently
  runs **no GPU functions at all** (confirmed by grepping `worker.py` for
  GPU declarations — none found) — a GPU run would be a genuinely new cost
  line item, not something that shares existing GPU spend. Current Modal
  list pricing (checked 2026-10-30): **T4 ≈ $0.59/hr, A10G ≈ $1.10/hr**,
  billed per-second with no idle charge. A T4 (16GB VRAM) is very likely
  sufficient for a ~2GB-checkpoint transformer's inference; a handful of
  held-out pieces at a few minutes of GPU time each would cost well under
  $1 total if a GPU run is even needed. CPU-only Modal pricing could not be
  confirmed from available sources and should be checked directly at
  `modal.com/pricing` before relying on a specific number.

## Go/no-go criteria for approval to proceed

**Requesting approval for exactly one next step: download the
`cocochorales/prompted` checkpoint (~2GB) and run the benchmark described
in Section 6-7, locally, CPU first.** Nothing else.

**Go** (worth continuing past this benchmark) if, on the held-out
flute/violin/cello set:
- Missing/Extra-note F1 and measure-localization accuracy clear a
  meaningfully higher bar than CREPE+DTW's current 57.7% localization, and
- Unsupported-flag rate on controls is substantially below CREPE+DTW's
  current 100%, and
- CPU (or, if needed, a cheap GPU tier) runtime stays in a plausible range
  for Mediant's real per-take latency budget.

**No-go** if:
- Accuracy isn't clearly better than the existing baseline on this
  independent test set, or
- The `score_audio` substitution (Section 3) turns out to matter enough
  that the benchmark isn't informative about Mediant's real production
  shape, or
- Resource requirements make self-hosting impractical on Mediant's actual
  infrastructure.

A "go" here authorizes only the benchmark run itself — not a replacement
deployment, not production integration, not fine-tuning. Those would need
their own separate proposal and approval.
