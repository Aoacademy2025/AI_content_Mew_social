# OmniVoice: emotion / prosody / naturalness levers (upstream primary-source audit)

Date: 2026-07-24
Scope: `k2-fsa/OmniVoice` upstream repository ONLY — README, `docs/`, source code in `omnivoice/`, and the linked paper abstract (arXiv:2604.00688). No blog posts or third-party write-ups. All citations pin to commit `468e927ba3716cd8dd86421148dfb3046e9f9d7b` (2026-07-18, `master`) unless the linked doc is versionless (e.g. HF model card, which mirrors the README).

Context for this audit: HERO AI runs OmniVoice via voice-cloning mode (48 cloned Thai voices from 3–10s reference WAVs, 32 diffusion steps, `language_id="th"`) on RunPod, and customers report the Thai output sounds flat/no emotion.

---

## Executive summary (ranked by expected emotion impact, per upstream evidence)

1. **Reference audio prosody, in clone mode** — upstream states the model "will most likely follow the style of the reference audio," and separately warns longer/degraded reference clips hurt cloning quality. This is the single strongest documented lever: a flat/monotone 3–10s reference WAV upstream-predicts flat/monotone output. [tips.md]
2. **`instruct` combined with `ref_audio` (clone + design hybrid)** — upstream explicitly supports layering an `instruct` string on top of voice cloning ("Combination of `ref_audio` and `instruct`"), which can "improve cloning stability" for the attributes it describes. But the only attributes upstream defines are gender/age/**pitch**/whisper/accent/dialect — no emotion category. [tips.md, voice-design.md]
3. **Non-verbal tags (`[laughter]`, `[sigh]`, etc.)** — inline, sentence-local paralinguistic injections upstream explicitly ships. Real but narrow: 13 fixed tags, not a general emotion controller. [README.md, omnivoice.py:1651-1655]
4. **`class_temperature` / `position_temperature`** — the only documented sampling-stochasticity knobs; upstream frames them purely as randomness controls (0 = greedy/deterministic), not as expressiveness controls. Raising them is the only upstream-sanctioned way to get output variance across regenerations. [generation-parameters.md]
5. **`guidance_scale` (CFG), `num_step`, `t_shift`** — documented as quality/fidelity/speed knobs, not prosody knobs; no upstream text ties any of them to expressiveness.
6. **Long-text chunking (`audio_chunk_duration`/`audio_chunk_threshold`)** — every ~15s chunk is generated independently, each re-conditioned on the *same fixed reference audio* rather than on the preceding chunk's output. Upstream doesn't call this out as a prosody issue, but the mechanism itself resets prosodic momentum every chunk. [generation-parameters.md, omnivoice.py:913-1022]

Bottom line per upstream's own documentation: **there is no emotion/expressiveness parameter in OmniVoice.** The only upstream-sanctioned levers are (a) the reference audio's own delivery in clone mode, (b) `instruct` pitch/whisper attributes, and (c) the 13 fixed non-verbal tags.

---

## 1. Generation parameters — full list, and what upstream says affects prosody/expressiveness

Source of truth: `docs/generation-parameters.md`, cross-checked byte-for-byte against the `OmniVoiceGenerationConfig` dataclass in source.

- README, Generation Parameters section: https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/README.md#L234-L247
- Full parameter tables: https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/docs/generation-parameters.md
- Dataclass definition (confirms the doc table is exhaustive — no undocumented fields): https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/models/omnivoice.py#L176-L189

```python
class OmniVoiceGenerationConfig:
    num_step: int = 32
    guidance_scale: float = 2.0
    t_shift: float = 0.1
    layer_penalty_factor: float = 5.0
    position_temperature: float = 5.0
    class_temperature: float = 0.0
    denoise: bool = True
    preprocess_prompt: bool = True
    postprocess_output: bool = True
    audio_chunk_duration: float = 15.0
    audio_chunk_threshold: float = 30.0
    pad_duration: float = 0.1
    fade_duration: float = 0.1
```

**Decoding:**
| Parameter | Default | Upstream description |
|---|---|---|
| `num_step` | 32 | "Number of iterative unmasking steps. Higher values improve quality but slow down generation. Use 16 for faster inference." |
| `denoise` | True | "Prepend the `<|denoise|>` token to the input, which signals the model to produce cleaner speech." |
| `guidance_scale` | 2.0 | "Classifier-free guidance scale." (no further elaboration) |
| `t_shift` | 0.1 | "Time-step shift for the noise schedule. Smaller values emphasise earlier steps in decoding." |

**Sampling:**
| Parameter | Default | Upstream description |
|---|---|---|
| `position_temperature` | 5.0 | "Temperature for mask-position selection. 0 = greedy (deterministic). Higher values increase randomness." |
| `class_temperature` | 0.0 | "Temperature for token sampling at each step. 0 = greedy (deterministic). Higher values increase randomness." |
| `layer_penalty_factor` | 5.0 | "Penalty applied to deeper codebook layers, encouraging earlier (lower) layers to unmask first." |

Note HERO's worker default is `class_temperature=0.0` (upstream default) — i.e. **greedy/deterministic token sampling**, per this table's own definition. That is a concrete, upstream-documented reason every generation for the same voice+text would come out nearly identical and non-varying: greedy sampling is explicitly "0 = greedy (deterministic)."

**Duration & speed:**
| Parameter | Default | Upstream description |
|---|---|---|
| `duration` | None | "Fixed output duration in seconds. Overrides `speed` when set." |
| `speed` | None | "Speed factor. Values > 1.0 produce shorter audio (faster); values < 1.0 produce longer audio (slower)." |

**Pre/post-processing:** `preprocess_prompt`, `postprocess_output`, `pad_duration`, `fade_duration` — silence trimming/fade cosmetics, no prosody claim.

**What upstream does NOT say:** none of the doc's descriptions for `guidance_scale`, `num_step`, `t_shift`, or `layer_penalty_factor` mention emotion, expressiveness, or prosody. Only the two temperature parameters are framed (by upstream) as controlling anything resembling output *variety*, and even then only as "randomness," not "expressiveness."

There is **no `seed` parameter** in `generate()` or `OmniVoiceGenerationConfig` — confirmed by grepping the entire `omnivoice/` package; `seed` only appears in the **training** config (`omnivoice/training/config.py:63`, default 42) and in dataset-shuffling code, never in inference. https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/training/config.py#L63

---

## 2. Voice cloning mode: how much does the reference audio determine prosody/emotion?

Primary claim, from the tips doc (this is the closest upstream comes to stating "reference audio drives emotion"):

> "Combination of `ref_audio` and `instruct`: When both `ref_audio` and `instruct` are provided and they **conflict**, the model will most likely follow the style of the reference audio. When the two are **consistent**, `instruct` can improve cloning stability for the attributes it describes."
> — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/docs/tips.md#L3-L4

This directly implies the reference audio carries "style" that the model defers to over an explicit instruction — i.e., the reference audio's delivery (including its emotional/prosodic character) is a dominant signal in clone mode. Upstream does not use the word "emotion" anywhere in the repo (confirmed by an exhaustive `grep -rni emotion` across all `.py`/`.md` files — zero hits), but "style" is the closest analogous term upstream uses, and it is explicitly reference-audio-driven.

**Reference audio requirements**, from README:
> "Use a 3–10 seconds reference audio clip. Longer audio slows down inference and may degrade cloning quality."
> "For standard pronunciation, use a reference audio in the **same language** as the target speech. In cross-lingual voice cloning ... the generated speech will carry an accent from the reference audio's language."
> — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/README.md#L191-L194

Source code enforces/warns on this at generation time:
```python
ref_duration = ref_wav.shape[-1] / self.sampling_rate
if ref_duration > 20.0:
    logger.warning(
        "Reference audio is %.1fs long (>20s). This may cause slower "
        "generation, higher memory usage, and degraded voice cloning "
        "quality. We recommend trimming it to 3-10s.",
        ref_duration,
    )
```
https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/models/omnivoice.py#L799-L806

No length-quality claim beyond "3–10s good, >20s degraded" — upstream gives no guidance on *expressiveness* of the reference clip specifically, only duration and language-match. **There is no upstream statement that "a more expressive reference produces more expressive output,"** but it is a direct logical consequence of the "follows the style of the reference audio" claim in tips.md, combined with the complete absence of any other prosody-injection parameter in clone mode.

Other clone-mode reference-audio handling found in source (not documented in prose, but load-bearing):
- Silence trimming + RMS-based volume normalization applied to reference audio when `preprocess_prompt=True` (default). https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/models/omnivoice.py#L774-L797
- `ref_text` is auto-transcribed via Whisper ASR if omitted; auto-punctuation is appended to `ref_text` if missing. README: https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/README.md#L164-L168, code: https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/models/omnivoice.py#L826

---

## 3. Voice design / instruct mode: can it control emotion? Is it usable in clone mode? Which languages is it stable in?

**Supported instruct attribute categories** (comma-separated, freely combinable across categories, one value per category): **gender** (male/female), **age** (child → elderly), **pitch** (very low → very high), **style** (whisper only), **English accent** (10 accents, English-text-only), **Chinese dialect** (12 dialects, Chinese-text-only).
https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/docs/voice-design.md#L34-L104

**There is no emotion category.** No "excited," "cheerful," "sad," "angry," or any affect-word attribute exists in the documented attribute table, and a full-repo grep for `emotion` returns zero hits. The `style` category has exactly one member: `whisper`.

**Is `instruct` supported in CLONE mode, not just design mode?** Yes — confirmed two ways:
1. Prose: docs/tips.md's "Combination of `ref_audio` and `instruct`" section (quoted in §2 above) and its worked example — "provide both dialect reference audio and a matching dialect instruct (e.g., `ref_audio="sichuan.wav", instruct="四川话"`)" — is explicitly a clone-mode + instruct combination. https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/docs/tips.md#L3-L4
2. Code: `generate()`'s signature accepts `ref_audio`/`ref_text`/`voice_clone_prompt` and `instruct` as independent, non-mutually-exclusive parameters (no assertion that they're exclusive). https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/models/omnivoice.py#L584-L604
3. UI: the Gradio demo's "Voice Clone" tab includes its own `vc_instruct = gr.Textbox(label="Instruct", ...)` field, separate from the "Voice Design" tab. https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/cli/demo.py#L341

**Which languages is voice design stable in?**
> "The model is primarily trained on the voice cloning task, so voice cloning is the most stable mode. Voice design is trained on Chinese and English data only. It can generalize to other languages, but may produce unstable results for some low-resource languages or edge cases."
> — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/README.md#L221

Read literally, **Thai is neither Chinese nor English**, so upstream's own stability guarantee for voice design (and by extension the accent/dialect attributes, which are explicitly gated to "only effective when the synthesis text is in English/Chinese") does not cover Thai. Upstream does not say whether the gender/age/pitch/whisper attributes are similarly degraded for non-Chinese/English text, only that voice design overall "can generalize ... but may produce unstable results" outside its two training languages. This is a caveat, not a blanket "doesn't work" — but it means HERO cannot rely on upstream's stability claims if layering `instruct` onto Thai clone-mode generations; it would be untested territory relative to upstream's own documentation.

---

## 4. Explicit emotion/style tags, paralinguistic tokens, or SSML-like markup in the input text

**Non-verbal symbols** — 13 fixed inline tags, inserted directly in the input text:

`[laughter]`, `[sigh]`, `[confirmation-en]`, `[question-en]`, `[question-ah]`, `[question-oh]`, `[question-ei]`, `[question-yi]`, `[surprise-ah]`, `[surprise-oh]`, `[surprise-wa]`, `[surprise-yo]`, `[dissatisfaction-hnn]`

README example: `audio = model.generate(text="[laughter] You really got me. I didn't see that coming at all.")`
https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/README.md#L249-L259

Exact regex from source (confirms the README list is complete and unmodified):
```python
_NONVERBAL_PATTERN = re.compile(
    r"\[(laughter|sigh|confirmation-en|question-en|question-ah|question-oh|"
    r"question-ei|question-yi|surprise-ah|surprise-oh|surprise-wa|"
    r"surprise-yo|dissatisfaction-hnn)\]"
)
```
https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/models/omnivoice.py#L1651-L1655

These tags are tokenized as standalone units "to guarantee consistent token IDs regardless of surrounding language context (Chinese, English, etc.)" — the code comment implies they're intended to work across languages, but upstream never states which languages they were *trained* on, and several tag names (`-en` suffix on two tags vs. Chinese-onomatopoeia-shaped suffixes like `-ah`/`-oh`/`-wa`/`-yo`/`-hnn` on the others) suggest a Chinese/English training origin. This is an inference from naming convention, not an explicit upstream statement — flagging it as such rather than as documented fact.
https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/models/omnivoice.py#L1658-L1667

**Pronunciation control** (not emotion, but the other documented inline markup):
- Chinese: pinyin + tone digit in uppercase, e.g. `ZHE2` — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/README.md#L261-L264
- English: CMU pronouncing-dictionary phoneme codes in brackets, e.g. `[B EY1 S]` — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/README.md#L267-L270

**SSML**: a full-repo `grep -rni ssml` across every `.py` and `.md` file returns **zero hits**. There is no SSML or SSML-like markup (no `<break>`, `<emphasis>`, `<prosody>` tags, or anything analogous) anywhere in the upstream repo.

---

## 5. Does punctuation affect prosody? How is long text chunked, and is there a recommended max length?

**Punctuation → chunk/sentence boundaries** (confirmed in source, `omnivoice/utils/text.py`):
- `chunk_text_punctuation()` splits text into model-fed chunks at sentence-ending punctuation (`.,;:!?。，；：！？`), with abbreviation-aware exceptions (won't split on "Mr.", "No.", etc.) — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/utils/text.py#L125-L210
- `add_punctuation()` appends a full stop (`.` or `。`) to reference text if the reference transcript doesn't already end in punctuation — applied automatically to `ref_text` when `preprocess_prompt=True` (default). https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/utils/text.py#L213-L225, called at https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/models/omnivoice.py#L826

Upstream doesn't state in prose that punctuation density/placement shapes *within-sentence* prosody (e.g. commas → pauses); the only documented function of punctuation is as the split-point for chunking and as a required reference-text terminator. There is no explicit "add more commas for better pacing" guidance anywhere in the docs.

**Long-form chunking mechanism** (this is real chunking, described in `docs/generation-parameters.md`):
> "To support stable long-form speech generation with low VRAM consumption, the text is automatically split into smaller segments when the estimated duration of the generated speech exceeds `audio_chunk_duration` [default 15.0s], with each segment producing approximately `audio_chunk_duration` seconds of audio. ... This approach allows the model to accept arbitrarily long text and generate arbitrarily long speech with near-constant VRAM consumption."
> — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/docs/generation-parameters.md#L63-L70

Defaults: `audio_chunk_duration=15.0` (target chunk size), `audio_chunk_threshold=30.0` (chunking only activates once **estimated** total duration exceeds this). So a single `generate()` call for text under ~30s of estimated speech is generated in one pass; anything longer is auto-split.

Source confirms the mechanism, and — importantly — that in **clone mode**, every chunk is conditioned on the *same, original* `ref_audio`/`ref_text` (not on the audio generated for the previous chunk):
```python
if all(has_ref):
    # All items have reference audio.
    # We still sequentially generate chunks within each item, but we
    # batch across items for the same chunk index. ...
    for ci in range(max_num_chunks):
        ...
        _run_batch(
            indices,
            texts=[all_chunks[i][ci] for i in indices],
            ref_audios=[task.ref_audio_tokens[i] for i in indices],   # same ref every chunk
            ref_texts=[task.ref_texts[i] for i in indices],
        )
```
https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/omnivoice/models/omnivoice.py#L983-L997 (full method: L913-L1022)

(For **no-reference / auto-voice** mode only, chunk 0's *generated* output is reused as the reference for subsequent chunks, to keep voice identity consistent — L998-L1020 — but this path is irrelevant to HERO's clone-mode usage.)

**Upstream does not recommend a specific max text length for best prosody.** The only documented number is the chunking trigger (`audio_chunk_threshold`, ~30s of estimated speech) and target chunk size (`audio_chunk_duration`, ~15s) — these are framed purely as a VRAM/stability mechanism, not a prosody-quality recommendation. The practical implication (not stated by upstream, but a direct reading of the code) is that each ~15s chunk is prosodically generated fresh from the fixed reference clip, with no explicit information passed from one chunk's realized delivery to the next — i.e. long-form clone-mode narration is stitched from independently-generated segments rather than continuously modeled.

---

## 6. Fine-tuning: data/GPU requirements, Thai-specific guidance

Upstream ships a documented fine-tuning path (`examples/run_finetune.sh`, `docs/training.md`), but with **no GPU count or VRAM figure specified** and **no Thai-specific guidance anywhere in the repo**.

**Data format** — same JSONL manifest as training-from-scratch:
```jsonl
{"id": "sample_001", "audio_path": "/data/audio/001.wav", "text": "Hello world", "language_id": "en"}
```
`id`, `audio_path`, `text` mandatory; `language_id` optional. https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/examples/README.md#L56-L65

**Fine-tune vs. from-scratch config differences** (only documented delta):
| Parameter | From scratch (Emilia) | Fine-tune | Why |
|---|---|---|---|
| `init_from_checkpoint` | `null` | `"k2-fsa/OmniVoice"` | Load pretrained weights |
| `steps` | 300,000 | 5,000 | "Fewer steps for fine-tuning, can be tuned according to your data/task" |
| `learning_rate` | 1e-4 | 5e-5 | "Lower LR for fine-tuning, can be tuned according to your data/task" |

https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/examples/README.md#L89-L97

**GPU requirements**: the fine-tune script's example config comment says `GPU_IDS="0,1"` / `NUM_GPUS=2`, presented as an editable example, not a stated minimum/requirement. https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/examples/README.md#L67-L77. The training doc separately notes `flex_attention` (the default attention backend) "requires PyTorch ≥ 2.5 and a compatible GPU (e.g. NVIDIA Ampere or newer)," with an `sdpa` fallback config for broader hardware compatibility. https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/docs/training.md#L26-L39. No minimum VRAM number is stated anywhere in the repo.

**Thai-specific guidance**: none. A full-repo search for Thai-related fine-tuning content, and a review of `docs/community-projects.md` (16 community projects: ComfyUI node, vLLM serving, C++ inference, video-dubbing tool, MLX ports, realtime-TTS wrapper, web UIs, OpenAI-compatible servers, Rust/TensorRT deployments, audiobook tools) — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/docs/community-projects.md — turned up **no Thai-specific community finetune or Thai-language guidance**. Thai does have a large training-data allocation in the base model (10,499.77 hours; see §7), but that's pretraining data, not a fine-tuning pointer.

---

## 7. Model versions: newer/larger checkpoint or successor mentioned in the repo?

The repo (as of the audited commit) ships a single model, `k2-fsa/OmniVoice`, referenced consistently throughout the README, CLI examples, and Colab notebook. There is no mention in the README, `docs/`, or `pyproject.toml` of a second/larger/newer checkpoint, a "v2," or a named successor model.

Training data scale is documented once, in aggregate: **646 languages, 581k hours total** — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/docs/languages.md#L1-L3. Thai specifically: **10,499.77 hours**, OmniVoice ID `th`, ISO 639-3 `tha` — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/docs/languages.md#L572 (row 563 of the language table). For scale reference in the same table: English 206,061 h, Chinese 111,343 h, Japanese 36,914 h — so Thai is mid-tier by training-hour volume, not a low-resource outlier, but far below the top two languages.

The paper (arXiv:2604.00688, "OmniVoice: Towards Omnilingual Zero-Shot Text-to-Speech with Diffusion Language Models," Zhu et al., 2026) is linked from the README as the model's citation/reference paper, not as a separate/successor model — https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/README.md#L366-L373. Its abstract describes the same "diffusion language model-style discrete non-autoregressive architecture" as the shipped model, with no reference to a different or upgraded checkpoint.

---

## 8. Best-of-N: is generation stochastic per run? Any upstream guidance on candidate selection/re-ranking?

**Stochasticity**: yes, generation is stochastic by architecture — `class_temperature` (default 0.0) and `position_temperature` (default 5.0) are documented sampling-temperature parameters, and there is no `seed` parameter to pin outputs. With HERO's worker running upstream defaults, `class_temperature=0.0` means **greedy/deterministic token sampling** per the doc's own wording ("0 = greedy (deterministic)"), so per-run variance is constrained to whatever `position_temperature=5.0` (default, "Temperature for mask-position selection") contributes. https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/docs/generation-parameters.md#L25-L31

**Best-of-N / candidate selection / re-ranking**: **not supported.** An exhaustive repo-wide grep (`grep -rni "rerank|candidate|best.of.n|best_of"` across every `.py` and `.md` file) returns **zero hits**. There is no batch-of-candidates-then-pick-best workflow, no scoring/re-ranking utility, and no upstream guidance on generating multiple takes and selecting one. `omnivoice-infer-batch` exists, but it's for throughput (parallelizing many *different* items across GPUs), not for generating N variants of the *same* item — confirmed by its JSONL schema (`id`, `text`, `ref_audio`, etc., one row per distinct output). https://github.com/k2-fsa/OmniVoice/blob/468e927ba3716cd8dd86421148dfb3046e9f9d7b/README.md#L318-L336

---

## What upstream does NOT support (explicit absence list — don't plan around these)

- **No emotion/affect parameter or attribute of any kind.** No "excited," "sad," "angry," "cheerful," etc. Confirmed by an exhaustive `grep -rni emotion` returning zero hits across the entire repo, and by the voice-design attribute table only containing gender/age/pitch/whisper/accent/dialect.
- **No SSML or SSML-like markup.** `grep -rni ssml` returns zero hits.
- **No emotion/style tags beyond the 13 fixed non-verbal tags**, which are discrete interjection-like insertions (laughter, sigh, a handful of confirmation/question/surprise/dissatisfaction sounds), not a general prosody/emotion controller applicable to arbitrary text.
- **No `seed` parameter for inference** — can't pin/reproduce a specific generation, and can't do targeted "try again with a different seed" regeneration; the only knobs are the two temperature parameters.
- **No best-of-N / candidate re-ranking workflow** of any kind.
- **No explicit prosody-strength or expressiveness-strength control.** `guidance_scale` (CFG) is documented only as "classifier-free guidance scale" with no elaboration connecting it to expressiveness, warmth, or emotional intensity.
- **No documented stability guarantee for Thai in voice-design/instruct mode.** Upstream states voice design is trained on Chinese and English only ("may produce unstable results for some low-resource languages or edge cases" elsewhere); Thai is not covered by name.
- **No per-word/per-phrase timing or emphasis markup** (no `<emphasis>`, no manual pause-insertion syntax beyond relying on punctuation-triggered chunk boundaries).
- **No stated recommendation for reference-audio expressiveness.** Upstream gives duration (3–10s) and language-match guidance for the reference clip, but never explicitly instructs users to pick an expressive/emotive reference clip for expressive output — that's an inference from the "follows the style of the reference audio" statement, not a direct instruction.
- **No newer/larger/successor checkpoint** referenced anywhere in the repo as of the audited commit.
- **No cross-chunk prosodic continuity in clone mode** — confirmed by source: each long-form chunk is conditioned on the same fixed reference audio, not on the previously generated audio, so there's no mechanism for building emotional momentum across a long script.

---

## Primary sources consulted

- Repository: https://github.com/k2-fsa/OmniVoice (cloned locally at commit `468e927ba3716cd8dd86421148dfb3046e9f9d7b`, 2026-07-18)
- `README.md`
- `docs/generation-parameters.md`
- `docs/voice-design.md`
- `docs/tips.md`
- `docs/languages.md`
- `docs/training.md`
- `docs/evaluation.md`
- `docs/data_preparation.md`
- `docs/data_preparation_advanced.md`
- `docs/community-projects.md`
- `examples/README.md`
- `omnivoice/models/omnivoice.py` (generate(), OmniVoiceGenerationConfig, _generate_chunked, non-verbal tag regex, reference-audio handling)
- `omnivoice/utils/text.py` (chunk_text_punctuation, add_punctuation)
- `omnivoice/cli/demo.py` (Gradio UI parameter exposure — confirms no hidden emotion controls)
- `omnivoice/training/config.py` (confirms `seed` is training-only)
- Hugging Face model card: https://huggingface.co/k2-fsa/OmniVoice (mirrors README content; no additional generation-parameter or emotion detail beyond the repo)
- Paper abstract: https://arxiv.org/abs/2604.00688 (Zhu et al., "OmniVoice: Towards Omnilingual Zero-Shot Text-to-Speech with Diffusion Language Models," arXiv:2604.00688, 2026) — architecture description only; no prosody/emotion-specific claims beyond what's in the repo docs.
