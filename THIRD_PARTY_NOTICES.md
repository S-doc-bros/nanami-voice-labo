# Third-Party Notices

NANAMI VOICE LABO is a local workflow tool for creating and testing voice
materials with Irodori-TTS-related runtimes. The license in this repository
applies only to the NANAMI VOICE LABO source code and bundled sample files that
are intentionally included in this repository.

## Irodori-TTS

NANAMI VOICE LABO is not Irodori-TTS and does not bundle Irodori-TTS source code
or model weights. The setup script can clone Irodori-TTS into
`third_party/Irodori-TTS`, which is ignored by Git.

When using Irodori-TTS, follow the upstream repository license and attribution
requirements.

## Model Weights

This repository does not include Irodori model weights. The default setup points
to Hugging Face model ids so the runtime can download model files locally on the
user's machine.

Model weights are governed by their own licenses and terms from their original
publishers. The MIT License for NANAMI VOICE LABO does not grant any additional
rights to those model weights.

## Voice And Audio Material

Users are responsible for using voice recordings, generated audio, references,
datasets, and final speaker artifacts that they have the right to use.

Generated wav files, private reference voices, local caches, and runtime outputs
are intentionally excluded from this repository by `.gitignore`.

## Bundled Sample Final Artifacts

This repository includes only the reviewed sample final artifacts under
`assets/final/`. Do not add additional generated artifacts unless they have been
reviewed for licensing, privacy, content, source material, and local path leaks.
