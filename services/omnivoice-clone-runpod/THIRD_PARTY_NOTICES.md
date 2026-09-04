# Third-party notices and unresolved rights

This image is for a private, internal evaluation only. Technical success does not
authorize publication, customer use, or commercial use.

- OmniVoice source is pinned to `k2-fsa/OmniVoice` commit
  `346bb75330980a236540d61a0808d00767c0973b` and is Apache-2.0. Preserve its
  upstream license and notices.
- The pinned OmniVoice pretrained checkpoint revision
  `c5fdb5ccb189668d56333f77ba2629f4cd7535f4` is described by its official model
  card as CC-BY-NC because of training-data constraints. Commercial use is
  blocked unless the owner grants separate written rights or the checkpoint is
  replaced and requalified.
- OmniVoice embeds the Boson Higgs Audio 2 tokenizer and its Community License.
  Preserve its attribution and acceptable-use terms. Its expanded-license scale
  threshold and all wrapper/asset rights remain legal-release gates.
- Demucs code at `e976d93ecc3865e5757426930257e200846a520a` is MIT. The official
  project materials inspected do not separately state a license for checkpoint
  `955717e8-8726e21a.th`; redistribution and commercial deployment remain blocked
  pending written confirmation.
  Its distribution metadata declares `torchaudio>=0.8,<2.1`; this build applies
  the hash-pinned one-line metadata patch recorded in `SOURCE_MANIFEST.json` and
  installs the otherwise unchanged source against `torch/torchaudio==2.4.1`.
  Runtime compatibility still requires the immutable-image and real GPU/audio gates.
- AudioSeal package 0.2.0, source at
  `e63a8a0e5cdf7bb797159c92ba15961557fe9bd2`, and official generator/detector
  weights at revision `3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba` are MIT. Preserve the
  MIT notice.
- Resemblyzer is Apache-2.0. Librosa is ISC. SciPy is BSD-3-Clause. NumPy is
  BSD-3-Clause. RunPod's SDK and all remaining Python/system dependencies retain
  their own upstream terms as recorded in the complete checked-in source/runtime
  SPDX and hash locks. That SPDX is not the final-image SBOM; Task 6 must generate
  a separate OCI-digest-bound inventory and scan.

The repository's Task 6 license review is authoritative. This notice records
known constraints; it is not legal clearance.
