# Hero Voice clone license gate

Date: 2026-09-04
Decision: **NO-GO for image publication, paid execution, customer use, or commercial use**

This is an engineering release gate, not legal advice. A component is marked
clear only when the pinned source and the exact bundled weights/assets have an
applicable grant and their notice obligations are captured. Technical tests do
not cure a missing or incompatible license.

Mew later narrowed the requested execution to a private, non-commercial
personal evaluation. That removes commercial release from the immediate test
purpose, but it does not create rights for unlicensed wrapper material or an
unverified checkpoint, permit public image distribution, or clear provider
handling of the reference voice. The overall gate therefore remains NO-GO.

## Component decisions

| Component | Pinned evidence | Decision |
|---|---|---|
| OmniVoice source | `k2-fsa/OmniVoice@346bb75330980a236540d61a0808d00767c0973b`; upstream source headers and license are Apache-2.0. | Source-code use is conditionally clear with Apache notices. |
| OmniVoice pretrained model | Hugging Face revision `c5fdb5ccb189668d56333f77ba2629f4cd7535f4`; the official model card states CC-BY-NC because of training-data constraints. | **Commercial/paid use blocked.** Private internal evaluation still requires counsel to confirm scope and attribution. |
| Embedded Boson Higgs Audio 2 tokenizer | Exact files and hashes are in `MODEL_MANIFEST.json`; the bundled upstream license has attribution, acceptable-use, and scale terms. | **Blocked pending written legal approval** of the exact tokenizer use and obligations. |
| Hero-Voice-Ai wrapper material | Audited source has no repository license grant. The clone worker is a selective clean boundary, but its parity behavior derives from the audited wrapper. | **Blocked pending written owner permission or documented clean-room provenance** for every carried expression. |
| Demucs source | `facebookresearch/demucs@e976d93ecc3865e5757426930257e200846a520a`; code license is MIT. | Code notice is clear; runtime is still technically blocked. |
| Demucs `955717e8` checkpoint | SHA-256 `8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`; no separate checkpoint grant was established. | **Redistribution/publication blocked pending written weight rights.** |
| AudioSeal source and official weights | Source `e63a8a0e5cdf7bb797159c92ba15961557fe9bd2`, weights revision `3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba`; upstream states MIT includes model weights. | Conditionally clear with the MIT notice and exact-hash readback. |
| Resemblyzer, Librosa, SciPy, NumPy, RunPod SDK and remaining packages | Exact package inventory is in `SBOM.spdx.json` and the two hash locks. | Individual notices are recorded, but **final clearance remains blocked** until an OCI-digest-bound SBOM and vulnerability/license scan exist. |
| CER evaluator Whisper model and Linux/arm64 dependency closure | Runtime lock deliberately records missing base, wheel, FFmpeg, model, and non-emulation evidence. | **Blocked; no canonical image may be built or claimed.** |
| Mew reference and generated outputs | No audio is in Git. Mew authorized private, non-commercial personal evaluation; the Drive source was hash/transcript/duration validated and canonicalized to an owner-only local WAV under the Task 4 deletion authority. | **Blocked from provider submission** until the remaining human-data/DPA/retention gate passes. |

## Primary evidence

- [OmniVoice official model card](https://huggingface.co/k2-fsa/OmniVoice) — Apache-2.0 code and CC-BY-NC pretrained model.
- [Pinned OmniVoice code license](https://github.com/k2-fsa/OmniVoice/blob/346bb75330980a236540d61a0808d00767c0973b/LICENSE).
- [Pinned Boson tokenizer license](https://huggingface.co/k2-fsa/OmniVoice/blob/c5fdb5ccb189668d56333f77ba2629f4cd7535f4/audio_tokenizer/LICENSE).
- [Pinned Demucs license](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/LICENSE).
- [AudioSeal official license statement](https://github.com/facebookresearch/audioseal/blob/main/README.md#license), including its statement that the MIT grant covers model weights.
- [Hero-Voice-Ai audited license endpoint](https://api.github.com/repos/Aoacademy2025/Hero-Voice-Ai/license).
- Local immutable inventory: `services/omnivoice-clone-runpod/{SOURCE_MANIFEST.json,MODEL_MANIFEST.json,RUNTIME_MANIFEST.json,SBOM.spdx.json,THIRD_PARTY_NOTICES.md}`.

## Required evidence to change NO-GO

1. Written commercial/internal-evaluation rights for the OmniVoice checkpoint and Boson tokenizer, or replacement components followed by full requalification.
2. Written wrapper provenance/permission and Demucs checkpoint redistribution/use rights.
3. Counsel sign-off on all notice, acceptable-use, consent, biometric-style, and provider-processing obligations.
4. A built immutable OCI digest with its own generated SBOM, license scan, and zero unresolved critical/high vulnerability findings.
5. The binding RunPod DPA and the written retention, backup-deletion, access, and data-center answers required by the separate human-data gate.

Until all five items are evidenced, the repository must retain the
`internal-evaluation-only` label and must not publish or execute the candidate
image with real human audio.
