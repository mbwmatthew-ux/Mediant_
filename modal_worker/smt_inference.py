"""
Thin wrapper around SMT (Sheet Music Transformer,
github.com/antoniorv6/SMT) inference, producing the same {"measures": [...],
"source": ...} shape read_score_notes_claude returns on success, so the
existing w._cross_source_measure_match scoring code works against it
unmodified.

API CONFIRMED BY DIRECT EXPERIMENT (Task 3 Step 1) -- the real shape differed
from the brief's assumption in several ways. Full transcript of what was run
and observed:

1. The brief's suggested snippet
     from transformers import AutoModel
     model = AutoModel.from_pretrained('antoniorv6/smt-grandstaff', trust_remote_code=True)
   FAILS with:
     ValueError: The checkpoint you are trying to load has model type `SMT`
     but Transformers does not recognize this architecture.
   Root cause, confirmed via `huggingface_hub.list_repo_files`: the Hub repo
   antoniorv6/smt-grandstaff contains only
     ['.gitattributes', 'README.md', 'config.json', 'model.safetensors']
   -- there is NO remote-code .py file in the repo at all, so
   trust_remote_code=True has nothing to dynamically load. `AutoModel` is
   the wrong entry point for this checkpoint.

2. The real model class (`SMTConfig`, `SMTModelForCausalLM`) lives in the
   separate GitHub repo github.com/antoniorv6/SMT, which is NOT pip-
   installable as-is (`pip install git+https://github.com/antoniorv6/SMT.git`
   fails: "Multiple top-level packages discovered in a flat-layout:
   ['vocab', 'config', 'graphics', 'smt_model', 'data_augmentation']" --
   no packaging metadata, so this module clones the pinned subdirectory
   directly instead of trying to pip-install the repo).

3. CRITICAL version-skew bug, confirmed by diffing real tensor key names:
   the current GitHub `main` HEAD (as of 2026-10-28) renamed the decoder's
   internal submodules (commit b64afed, Feb 2025: `input_attention`/
   `cross_attention`/`ffNet`/`norm1,2,3`/`decoder.out_layer` became
   `self_attn`/`cross_attn`/`ffn`/`norm_layers`/`decoder.vocab_projection`).
   Loading `antoniorv6/smt-grandstaff`'s checkpoint (uploaded Sep 2024,
   pre-rename) against current HEAD's class SILENTLY re-initializes every
   one of the 8 decoder layers plus the final output projection at random
   -- confirmed via the loader's own warning: "Some weights of
   SMTModelForCausalLM were not initialized from the model checkpoint
   ... and are newly initialized: ['decoder.decoder.layers.0.cross_attn...'
   ... 'decoder.vocab_projection.weight'] ... You should probably TRAIN
   this model on a down-stream task". Running inference against HEAD would
   have produced output from an untrained decoder -- i.e. garbage dressed
   up as a result. Fixed by pinning to commit d25acd4373ad868a1e0f1c352d2f
   5dc8ffa94f54 (2024-09-03, the last commit before the rename) -- loading
   at that commit reports ZERO newly-initialized keys.

4. `transformers==5.21.0` (latest at time of this spike) ALSO fails to
   load the pinned-commit code, for an unrelated reason: `SMTModelForCausalLM.
   __init__` -> `PreTrainedModel.__init__` raises
   `AttributeError: 'SMTConfig' object has no attribute
   '_experts_implementation_internal'` -- a newer transformers-internal MoE
   attribute this 2024-era SMTConfig subclass never sets. Fixed by pinning
   `transformers==4.46.3` (contemporary with the checkpoint's own recorded
   `transformers_version: 4.43.3`).

5. Real confirmed signature (pinned commit):
     model.predict(input: torch.FloatTensor, convert_to_str: bool = False)
       -> tuple[list[str], SMTOutput]
   `input` is a (1, 1, H, W) grayscale float tensor in [0, 1] (NOT a file
   path string, despite the HF model card's undocumented implication --
   built via `torchvision.transforms.Compose([ToPILImage(), Grayscale(),
   ToTensor()])` on the page image, matching the SMT repo's own
   `data_augmentation.convert_img_to_tensor`). The first return value is
   ALREADY A LIST OF DECODED VOCABULARY STRINGS (one per emitted token --
   NOT a tensor of token ids, and NOT a single joined string -- resolving
   the brief's open question "a tensor of token IDs? a decoded string
   already? check both": it is neither of those, it is a list the caller
   joins itself, confirmed by reading `smt_trainer.py`'s own validation
   step: `dec = "".join(predicted_sequence)`).

6. CONFIRMED BUG: `model.i2w`, loaded straight from the Hub checkpoint's
   config.json, has STRING keys ("17489") because JSON object keys are
   always strings -- but `predict()`'s own decode loop does
   `self.i2w[predicted_token]` with an int, so every real call raised
   `KeyError` on the very first generated token until this wrapper remaps
   `model.i2w = {int(k): v for k, v in model.i2w.items()}` right after load.
   This is a real bug in the published checkpoint/code pairing, not
   documented anywhere.

7. REAL OBSERVED OUTPUT, after fixing both the version-pin (point 3) and the
   int/str key bug (point 6), run against this repo's own real corpus page
   /Users/matthewwu/.cache/mediant_validation/visual_corpus/clean/2204_page1.png
   (2970x2100 RGB PNG; the same already-rendered page read_score_notes_claude
   receives, fed with NO resizing):

     text_sequence (27 tokens, verbatim) =
       ['**ekern_1.0', '<t>', '**ekern_1.0', '<b>', '*clefF4', '<t>',
        '*clefG2', '<b>', '*k[]', '<t>', '*k[]', '<b>', '*M3/4', '<t>',
        '*M3/4', '<b>', '=-', '<t>', '=-', '<b>', '*-', '<t>', '*-',
        '<b>', '', '<b>', '']

   Joining and replacing '<t>'->tab, '<b>'->newline, '<s>'->space
   reconstructs a 2-column (grand-staff) bekern header: two `**ekern_1.0`
   exclusive interpretations, bass clef F4 / treble clef G2, empty key
   signature, 3/4 time, an immediate pre-measure barline ("=-") on both
   columns, then spine terminators ("*-") on both columns. The model
   predicted <eos> immediately after the header -- ZERO actual
   measures/notes came out of this real run.

8. Tried 3 more real corpus pages (2191, piano_synthetic, 2217) in one
   batch call. The FIRST of those (2191_page1.png) did not reach <eos>
   even after 15 minutes of CPU wall time (process killed manually to
   recover the session) -- confirmed by reading this pinned commit's own
   `forward_decoder`: it recomputes full attention over the ENTIRE
   growing output sequence on every step (no KV cache), so worst-case
   per-page latency scales up to the full `maxlen` (1281) steps
   quadratically on CPU, and is NOT reliably bounded by early <eos> the
   way the first page happened to be. This is a real, confirmed
   operational constraint of this checkpoint-compatible code path, not a
   hypothetical -- see `_MAX_GENERATION_TOKENS` and `_PAGE_TIMEOUT_SECONDS`
   below, both added in direct response to this finding.

9. The bekern/kern grammar used to write `_decode_smt_output` below (pitch
   case+repetition octave convention, "#"/"-" accidentals, "r"=rest,
   numeric reciprocal duration codes with trailing "."=dotted, "="=
   barline, "."=null/continuation filler, "@"/".-" ekern separators
   stripped from this checkpoint's own fused vocabulary atoms) was
   confirmed two ways, NEITHER from the GitHub README's prose: (a) directly
   against this live model's own loaded `model.i2w` vocabulary table
   (20,578 real fused atoms such as "8F#L>", "4.GG#", "16cc##Jk"), and
   (b) against one real ground-truth row (image + transcription) pulled
   directly, by code, from the PRAIG/grandstaff-ekern Hugging Face dataset
   (this checkpoint's own training-distribution format) -- e.g. real row 0
   contains `8@F·L`, `16@ddd·L·]`, `8@r`, `=`, `=:|!`, `.`. No real
   zero-shot run against this repo's OWN corpus (point 7, 8) ever emitted
   an actual note token to check the note-decoding branch against, which is
   recorded as an open caveat in the Step 3 report rather than hidden.
"""
import signal
import subprocess
import sys
from pathlib import Path

# Pinned per point 3 above: the last commit whose decoder submodule names
# match antoniorv6/smt-grandstaff's actually-published checkpoint tensors.
# Current GitHub main silently discards this checkpoint's trained decoder
# weights -- do not change this to "main" or "HEAD".
_SMT_REPO_URL = "https://github.com/antoniorv6/SMT.git"
_SMT_PINNED_COMMIT = "d25acd4373ad868a1e0f1c352d2f5dc8ffa94f54"
_SMT_REPO_CACHE = Path.home() / ".cache" / "mediant_validation" / "smt_repo_pinned"

# Per point 8 above: this checkpoint-compatible code has no decoder KV
# cache, so generation cost is quadratic in however many tokens it emits.
# The checkpoint's own config.maxlen (1281) is a worst case we confirmed
# can run well past 15 minutes per page on CPU. An initial 400/90 pair was
# tried and rejected during this same Step 1 spike: timed real runs against
# corpus pages that do NOT hit early <eos> (e.g. 2191, 2202) showed the
# SIGALRM backstop firing correctly (confirmed directly: an injected 12s
# bound fired at ~14s), but because the main thread can only notice the
# signal when a single `forward_decoder` step returns, a 90s bound still
# let individual pages run several minutes past it when a late step itself
# was slow -- unworkable across a ~45-page corpus run. Tightened to 150/45,
# which both bounds degrade to this file's existing fail-open shape for --
# they never fabricate partial output as if it were a complete
# transcription.
_MAX_GENERATION_TOKENS = 150
_PAGE_TIMEOUT_SECONDS = 45


class _PageTimeout(Exception):
    pass


def _raise_page_timeout(signum, frame):
    raise _PageTimeout(f"SMT inference exceeded {_PAGE_TIMEOUT_SECONDS}s for this page")


def _ensure_smt_repo_on_path() -> None:
    """
    Clones github.com/antoniorv6/SMT at the pinned, checkpoint-compatible
    commit (point 3 above) into a stable cache dir on first use, and makes
    its `smt_model` package importable. Not pip-installable as a whole repo
    (see point 2 above), so this manages the checkout directly instead.
    """
    marker = _SMT_REPO_CACHE / "smt_model" / "modeling_smt.py"
    if not marker.exists():
        _SMT_REPO_CACHE.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "clone", _SMT_REPO_URL, str(_SMT_REPO_CACHE)],
            check=True, capture_output=True, text=True,
        )
        subprocess.run(
            ["git", "-C", str(_SMT_REPO_CACHE), "checkout", _SMT_PINNED_COMMIT],
            check=True, capture_output=True, text=True,
        )
    repo_str = str(_SMT_REPO_CACHE)
    if repo_str not in sys.path:
        sys.path.insert(0, repo_str)


_model_cache: dict = {}


def _load_model(checkpoint: str):
    """Loads (and caches, per checkpoint) the pinned-commit model, applying
    the two confirmed fixes from points 3 and 6 above."""
    if checkpoint in _model_cache:
        return _model_cache[checkpoint]

    _ensure_smt_repo_on_path()
    from smt_model import SMTModelForCausalLM  # noqa: E402 (path set above)

    model = SMTModelForCausalLM.from_pretrained(checkpoint)
    # Point 6: config.json's i2w has string keys (JSON requirement); predict()
    # indexes it with int token ids. Confirmed real bug, not a hypothetical.
    model.i2w = {int(k): v for k, v in model.i2w.items()}
    # Point 8: bound worst-case generation length; this checkpoint's own
    # native 1281-token budget is confirmed to run unbounded on CPU for
    # out-of-distribution (full-page, not single-system) input.
    model.maxlen = min(model.maxlen, _MAX_GENERATION_TOKENS)
    model.eval()

    _model_cache[checkpoint] = model
    return model


def transcribe_with_smt(page_paths: list[Path], checkpoint: str) -> dict:
    """
    Runs SMT on each page in `page_paths` (already-rendered PNGs, same
    inputs read_score_notes_claude receives) and returns
    {"measures": [...], "source": "smt"} on success, or
    {"error": "...", "measures": [...], "source": "smt"} on any failure --
    matching the fail-open shape every other OMR source in this codebase
    (Audiveris, Claude) already uses. Measure numbers continue across pages
    within one piece (SMT itself has no notion of a running measure count
    across separate predict() calls -- each page's decoded measures start
    back at 1, so this function re-numbers them by the running total of
    measures already collected, which is required for `predicted_by_number`
    lookups in score_measures to not collide across multi-page pieces).
    """
    try:
        model = _load_model(checkpoint)
    except Exception as e:
        return {"error": f"SMT model load failed: {type(e).__name__}: {e}",
                "measures": [], "source": "smt"}

    from PIL import Image

    all_measures = []
    for page_path in page_paths:
        try:
            img = Image.open(page_path).convert("RGB")
            raw_output = _predict_raw_tokens(model, img)
            page_measures = _decode_smt_output(raw_output)
            offset = all_measures[-1]["number"] if all_measures else 0
            for m in page_measures:
                m["number"] += offset
            all_measures.extend(page_measures)
        except Exception as e:
            return {"error": f"SMT inference failed on {page_path}: "
                              f"{type(e).__name__}: {e}",
                    "measures": all_measures, "source": "smt"}

    return {"measures": all_measures, "source": "smt"}


def _predict_raw_tokens(model, img) -> list[str]:
    """
    Shared transform + timeout-guarded predict() call used by both
    transcribe_with_smt (whole pages) and transcribe_row_with_smt (single
    cropped systems) -- the SIGALRM-based timeout (point 8 in the module
    docstring) must behave identically for both input shapes, so it lives
    in exactly one place rather than two copies that could drift.
    """
    import numpy as np
    import torch
    from torchvision import transforms

    transform = transforms.Compose(
        [transforms.ToPILImage(), transforms.Grayscale(), transforms.ToTensor()])
    x = transform(np.array(img)).unsqueeze(0)

    old_handler = signal.signal(signal.SIGALRM, _raise_page_timeout)
    signal.alarm(_PAGE_TIMEOUT_SECONDS)
    try:
        with torch.no_grad():
            raw_output, _ = model.predict(x)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)
    return raw_output


def transcribe_row_with_smt(row_png_bytes: bytes, checkpoint: str) -> dict:
    """
    Like transcribe_with_smt, but for ONE already-cropped, already-dewarped
    single-system row image (worker._prepare_score_rows' "row_bytes" --
    the input shape this checkpoint was actually trained on: a grand-staff
    system for piano, a single staff for a solo instrument) rather than a
    whole multi-system page. See the Phase 1-2 final report's caveat on
    why a correctly-shaped row crop is still only a full training-
    distribution match for the grand-staff (piano) case, not for a
    single-staff solo-instrument row.

    Returns {"measures": [...], "source": "smt"} with measure numbers
    starting at 1 (row-relative, not page- or piece-relative -- the caller
    owns re-numbering across rows/pages when reassembling a whole piece),
    or {"error": "...", "measures": [], "source": "smt"} on any failure,
    matching this file's existing fail-open shape.
    """
    try:
        model = _load_model(checkpoint)
    except Exception as e:
        return {"error": f"SMT model load failed: {type(e).__name__}: {e}",
                "measures": [], "source": "smt"}

    import io
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(row_png_bytes)).convert("RGB")
        raw_output = _predict_raw_tokens(model, img)
        measures = _decode_smt_output(raw_output)
        return {"measures": measures, "source": "smt"}
    except Exception as e:
        return {"error": f"SMT inference failed on row: {type(e).__name__}: {e}",
                "measures": [], "source": "smt"}


# Kern "recip" duration code -> quarterLength (1 whole note = 4 quarterLengths;
# the numeral N means a note of length 4/N quarterLengths; each trailing "."
# multiplies the preceding length by 1.5, standard dotted-note arithmetic).
# Confirmed against real vocabulary atoms (point 9): "4"=quarter, "8"=eighth,
# "4."=dotted quarter, "16"=sixteenth, etc.
def _kern_duration_to_quarter_length(duration_code: str) -> float | None:
    dots = duration_code.count(".")
    digits = duration_code.replace(".", "")
    if not digits.isdigit() or int(digits) == 0:
        return None
    base = 4.0 / int(digits)
    for _ in range(dots):
        base *= 1.5
    return base


def _parse_kern_event(token: str):
    """
    Parses one real bekern event atom (e.g. "8F#L>", "4.GG#", "16cc##Jk",
    "8r") into (pitch_scientific: str | None, is_rest: bool,
    duration_beats_quarterlengths: float), or None if `token` is not a
    note/rest event (e.g. a directive like "*clefF4", a barline "=", the
    null filler ".", or a separator). Returns quarterLengths -- the caller
    divides by quarter_lengths_per_beat(time_sig) to match this codebase's
    "notated beat" convention (see worker.py's quarter_lengths_per_beat).
    """
    if not token or token in (".", "") or token.startswith(("*", "=")):
        return None

    i = 0
    while i < len(token) and (token[i].isdigit() or token[i] == "."):
        i += 1
    duration_code, rest = token[:i], token[i:]
    if not duration_code:
        return None
    quarter_length = _kern_duration_to_quarter_length(duration_code)
    if quarter_length is None:
        return None

    j = 0
    while j < len(rest) and rest[j].lower() == "r":
        j += 1
    if j > 0:
        return None, True, quarter_length

    j = 0
    while j < len(rest) and rest[j] in "ABCDEFGabcdefg":
        j += 1
    letters = rest[:j]
    if not letters or len(set(letters.lower())) != 1:
        return None
    step = letters[0].upper()
    is_lower = letters[0].islower()
    n = len(letters)
    octave = (3 + n) if is_lower else (4 - n)

    k = j
    while k < len(rest) and rest[k] in "#-":
        k += 1
    accidentals = rest[j:k]

    pitch = f"{step}{accidentals}{octave}"
    return pitch, False, quarter_length


def _decode_smt_output(raw_output) -> list[dict]:
    """
    Converts one page's raw `text_sequence` (the real, confirmed list[str]
    shape from Step 1 -- see point 5/7 above) into this codebase's measure/
    note schema: {"number": int, "notes": [{"pitch": str|None,
    "is_rest": bool, "beat": float, "duration_beats": float}]} -- the exact
    schema _cross_source_measure_match expects.

    Grand-staff layout (point 7): the decoded text is two tab-separated
    columns (bass/treble staff) per newline-separated row. This codebase's
    measure schema has no per-staff concept, so both columns' notes are
    merged into one flat, beat-sorted list per measure -- a deliberate,
    disclosed simplification (see the Task 3 report), not an attempt to
    preserve voice-leading.

    Never raises on malformed/truncated input (e.g. a page that hit the
    `_MAX_GENERATION_TOKENS` cutoff mid-measure) -- an unterminated trailing
    partial measure is simply included with whatever notes it collected,
    matching this file's fail-open convention of reporting what's real
    rather than silently dropping or fabricating data.
    """
    text = "".join(str(t) for t in raw_output)
    text = text.replace("<t>", "\t").replace("<b>", "\n").replace("<s>", " ")
    lines = [ln for ln in text.split("\n") if ln != ""]

    time_sig_match = None
    for ln in lines:
        for cell in ln.split("\t"):
            if cell.startswith("*M") and "/" in cell:
                time_sig_match = cell[2:]
    qlpb = _quarter_lengths_per_beat_local(time_sig_match)

    measures = []
    current_notes = []
    current_number = 0
    # one running within-measure quarterLength position per column
    column_positions = [0.0, 0.0]

    def _flush_measure():
        nonlocal current_notes, current_number
        measures.append({"number": current_number,
                          "notes": sorted(current_notes, key=lambda n: n["beat"])})
        current_notes = []

    for ln in lines:
        cells = ln.split("\t")
        barline_cells = [c for c in cells if c.startswith("=")]
        if barline_cells:
            # "=-" is bekern's data-start/incipit marker (confirmed in the
            # real Step 1 output: it appears right after the time-signature
            # tokens, before any real content), not a real barline -- it
            # must NOT close a measure or advance current_number, or a
            # future non-empty run's real first measure would land on
            # "measure 2", and score_measures's exact-number lookup would
            # never find it. Only treat this row as a real barline close if
            # at least one cell is a genuine barline token ("=", "=1",
            # "=:|!", etc.), not exclusively the incipit marker.
            if all(c == "=-" for c in barline_cells):
                continue
            current_number += 1
            _flush_measure()
            column_positions = [0.0, 0.0]
            continue
        if any(c.startswith("*") for c in cells):
            continue  # clef/key/time-signature/spine-terminator directive

        for col_idx, cell in enumerate(cells):
            if col_idx >= len(column_positions):
                break
            for event in cell.split(" "):
                parsed = _parse_kern_event(event)
                if parsed is None:
                    continue
                pitch, is_rest, quarter_length = parsed
                beat = 1.0 + column_positions[col_idx] / qlpb
                current_notes.append({
                    "pitch": pitch,
                    "is_rest": is_rest,
                    "beat": round(beat, 4),
                    "duration_beats": round(quarter_length / qlpb, 4),
                })
                column_positions[col_idx] += quarter_length

    if current_notes:
        current_number += 1
        measures.append({"number": current_number,
                          "notes": sorted(current_notes, key=lambda n: n["beat"])})

    return measures


def _quarter_lengths_per_beat_local(time_sig: str | None) -> float:
    """
    Local copy of worker.quarter_lengths_per_beat's arithmetic (not
    imported, to keep this file importable standalone without pulling in
    worker.py's full dependency surface for a four-line calculation).
    `evaluate_smt_zero_shot.py` still uses the real ground-truth time
    signature via validate_score_reading_against_corpus.score_measures for
    scoring; this is only used while decoding
    SMT's own output, where the time signature it reports (e.g. "*M3/4")
    may legitimately differ from, or be absent from, what it transcribed.

    Must match worker.py:quarter_lengths_per_beat's `is_compound` condition
    exactly (num % 3 == 0 and num // 3 >= 2 and denom >= 8, times 3.0, not
    1.5) -- an earlier version of this function used `num > 3` and `* 1.5`,
    which gave 6/8 a factor-of-2-wrong 0.75 instead of 1.5 and misclassified
    6/4 as compound (review fix: this value feeds every predicted note's
    beat/duration, compared under exact equality against ground truth).
    """
    import re
    m = re.match(r'^(\d+)\s*/\s*(\d+)$', (time_sig or "").strip())
    if not m:
        return 1.0
    num, denom = int(m.group(1)), int(m.group(2))
    if denom <= 0:
        return 1.0
    unit = 4.0 / denom                      # quarterLengths in one denominator unit
    is_compound = num % 3 == 0 and num // 3 >= 2 and denom >= 8
    return unit * 3.0 if is_compound else unit
