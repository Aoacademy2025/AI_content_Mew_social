# Hero Voice clone license gate

Date: 2026-09-04 (final image evidence refreshed 2026-09-05)
Decision: **NO-GO for candidate execution, public distribution, customer use, or commercial use**

This is an engineering release gate, not legal advice. A component is marked
clear only when the pinned source and the exact bundled weights/assets have an
applicable grant and their notice obligations are captured. Technical tests do
not cure a missing or incompatible license.

Mew later narrowed the requested execution to a private, non-commercial
personal evaluation. That removes commercial release from the immediate test
purpose, but it does not create rights for unlicensed wrapper material or an
unverified checkpoint, permit public image distribution, or clear provider
handling of the reference voice. A private, commit-addressed GHCR image now
exists only as a gated CI/inspection artifact and has not been executed. The
overall gate therefore remains NO-GO.

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
| Resemblyzer, Librosa, SciPy, NumPy, RunPod SDK and remaining packages | Exact package inventory is in `SBOM.spdx.json` and the hash locks. The final OCI has a digest-bound SPDX attestation whose exact statement digest is recorded in the Task 6 readback. Trivy 0.74.0 scanned the authenticated OCI layout directly. | The final scan has zero critical/high vulnerabilities, but restricted-license identifiers still require package-level review. Individual notices and the generated SBOM are recorded; **final license clearance remains blocked.** |
| CER evaluator Whisper model and Linux/arm64 dependency closure | Runtime lock deliberately records missing base, wheel, FFmpeg, model, and non-emulation evidence. | **Blocked; no canonical image may be built or claimed.** |
| Mew reference and generated outputs | No audio is in Git. Mew authorized private, non-commercial personal evaluation; the Drive source was hash/transcript/duration validated and canonicalized to an owner-only local WAV under the Task 4 deletion authority. | **Blocked from provider submission** until the remaining human-data/DPA/retention gate passes. |

## Independent immutable-image scan

On 2026-09-05, Trivy 0.74.0 scanned the final locally authenticated OCI layout
for index
`sha256:c40fa76893fe1e0deab29fd8664d6ec32999496e57ce7b08becf5aba7edd7abc`
and Linux/amd64 manifest
`sha256:5b46143871655d4613b2ed5dff0cd414aba9d8994abbf2918addea00b99adffd`.
After upgrading to the pinned PyTorch 2.6.0/CUDA 12.4 base, removing vulnerable
base packages, and updating vendored build tooling, the final scan found zero
critical and zero high vulnerabilities. It reported 151 medium and 57 low
vulnerabilities. This clears the plan's zero-unresolved-critical/high technical
scan threshold; it does not waive medium/low triage or any license gate.

The license scan produced 754 observations: 300 high, 7 medium, 312 low, and
135 unknown under Trivy's license policy. The high items are restricted-license
classifications rather than CVEs and are not by themselves a legal conclusion.
Each affected runtime package and its distribution obligations must still be
reviewed before clearance. The owner-only raw JSON evidence is mode `0600`,
SHA-256
`8707313c9a1867ebb9af13946c490010271815e28f691b550a77f4f303e0017d`, and
is intentionally outside Git. The final SPDX statement is
`sha256:2a35cfa2a3348044bf139c51ebe5d163675ed62ccf72752dc8482c36831729e9`;
its subject matches the exact Linux/amd64 manifest.

The vulnerability sub-gate is now technically clear. The overall license gate
remains **NO-GO** because component rights and written approvals below are
independent requirements.

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
4. Complete package-level review of all restricted/unknown license observations and retain the final zero-critical/high OCI scan as immutable evidence. Requalify model/runtime parity on real GPU hardware; no suppression or exception may be treated as clearance without evidence-backed independent review.
5. The binding RunPod DPA and the written retention, backup-deletion, access, and data-center answers required by the separate human-data gate.

Until all five items are evidenced, the repository must retain the
`internal-evaluation-only` label and must not publish or execute the candidate
image with real human audio.
