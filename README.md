# NANAMI VOICE LABO

NANAMI VOICE LABO is a local voice laboratory for Irodori-TTS / Irodori-TTS-Lite.
It helps you create seed wav files, generate expression datasets, review clips by ear,
run Speaker Inversion, and test the resulting `checkpoint_final.speaker.safetensors`.

The repository is source-first by default. It bundles only two small, reviewed public
sample final artifacts for the `成果物テスト` screen. It does not bundle private
reference voices, generated wav files, model weights, local caches, or runtime outputs.

## What It Does

- Generate a seed wav from a voice design prompt and text.
- Import your own reference wav and compare generated results.
- Create expression sets for laughter, breath, coughing, swallowing, panic, crying,
  strong shouts, and other hard-to-capture vocal textures.
- Review generated clips manually and mark them as accepted, audio-only accepted,
  held, recorded, or rejected.
- Export accepted wav files and metadata as a dataset.
- Run a local Speaker Inversion job and register the resulting safetensors artifact.
- Test completed artifacts from the final test tab.

## What Is Not Included

The following files are intentionally excluded from the public repository:

- Reference voice wav files.
- Generated wav files.
- Additional or private `checkpoint_final.speaker.safetensors` artifacts, except the two curated public samples in `assets/final/`.
- Irodori model weights.
- GGUF scriptwriter models.
- `.runtime/` logs, caches, job outputs, and local review data.

Use your own licensed voice material and model files.

## Requirements

- Python 3.10+ recommended for the bridge and engine runtime.
- `ffmpeg` for audio conversion and processing.
- An Irodori-TTS checkout, supplied with `IRODORI_REPO_DIR`.
- Optional Irodori-TTS-Lite dependencies for Lite inference.
- Optional local OpenAI-compatible scriptwriter endpoint for prompt-assisted text generation.

## Quick Start For Beginners

Run the setup once:

```bash
cd /path/to/nanami-voice-labo
./Setup\ Irodori.command
```

Then start the UI:

```bash
./Start\ UI.command
```

Open:

```text
http://localhost:5190
```

In another terminal, start the full local lab bridge:

```bash
./Start\ Bridge\ Lab\ Only.command
```

The first generation may take several minutes because the Irodori model files are
downloaded from Hugging Face automatically:

- `Aratako/Irodori-TTS-600M-v3-VoiceDesign`
- `Aratako/Irodori-TTS-500M-v3`

`Start Bridge Lab Only.command` waits up to 10 minutes for the VoiceDesign engine
on first startup. After the first download, the models are cached locally and
startup is much faster.

See [MODEL_SETUP.md](MODEL_SETUP.md) if you want to use manually downloaded
`model.safetensors` files.

## Manual Start

```bash
cd /path/to/nanami-voice-labo
./Start\ UI.command
```

Open:

```text
http://localhost:5190
```

Start the bridge after setting paths for your local runtime:

```bash
cd /path/to/nanami-voice-labo
export IRODORI_REPO_DIR=/path/to/Irodori-TTS
export IRODORI_LAB_VOICE_MODEL=Aratako/Irodori-TTS-600M-v3-VoiceDesign
export IRODORI_FINAL_BASE_CHECKPOINT=Aratako/Irodori-TTS-500M-v3
./Start\ Bridge\ Lab\ Only.command
```

The default API URL in the UI is:

```text
http://localhost:8088/v1
```

## Useful Environment Variables

- `IRODORI_REPO_DIR`: path to your local Irodori-TTS checkout.
- `NANAMI_VOICE_ENGINE_HOME`: directory containing local model files, config, and Hugging Face cache.
- `IRODORI_LAB_VOICE_MODEL`: VoiceDesign checkpoint path or Hugging Face model id. Default: `Aratako/Irodori-TTS-600M-v3-VoiceDesign`.
- `IRODORI_FINAL_BASE_CHECKPOINT`: final artifact test base checkpoint path or Hugging Face model id. Default: `Aratako/Irodori-TTS-500M-v3`.
- `IRODORI_FINAL_ENGINE_CONFIG`: optional final-engine config JSON path. Leave unset to use the generated default config.
- `IRODORI_PYTHON`: Python executable for Irodori / Speaker Inversion.
- `IRODORI_SPEAKER_PYTHON`: optional Python executable used only for Speaker Inversion `prepare_manifest.py` and `train.py`.
- `IRODORI_SPEAKER_PYTHONPATH`: optional site-packages path for Speaker Inversion.
- `IRODORI_SPEAKER_BASE_CHECKPOINT`: base checkpoint for Speaker Inversion.
- `IRODORI_SPEAKER_HF_HOME`: Hugging Face cache used by Speaker Inversion.
- `IRODORI_SCRIPTWRITER_ENDPOINT`: optional OpenAI-compatible scriptwriter endpoint.
- `IRODORI_SCRIPTWRITER_AUTOSTART=0`: disable local scriptwriter autostart.
- `IRODORI_LAB_ENGINE_START_TIMEOUT`: seconds to wait for the VoiceDesign engine. Default: `600`.
- `IRODORI_FINAL_ENGINE_START_TIMEOUT`: seconds to wait for the final test engine. Default: `300`.

## Irodori-TTS Dependency

NANAMI VOICE LABO is not Irodori-TTS itself. It uses Irodori-TTS as the speech
runtime. The setup command clones Irodori-TTS into:

```text
third_party/Irodori-TTS
```

This directory is ignored by Git. Keep Irodori-TTS and its license attribution
separate when redistributing this lab.

## Speaker Inversion Runtime Check

The bridge checks the Speaker Inversion runtime before starting a job. It imports
`torch`, `pandas`, `datasets`, and the Irodori codec with the same Python and
`PYTHONPATH` that will run `prepare_manifest.py`.

If the health screen says `speaker prepare dependency check failed`, the selected
Python environment is not usable for Speaker Inversion. Copy `.env.example` to
`.env.local` and set:

```bash
IRODORI_SPEAKER_PYTHON=/absolute/path/to/python3.10
IRODORI_SPEAKER_PYTHONPATH=/absolute/path/to/Irodori-TTS/.venv/lib/python3.10/site-packages
IRODORI_SPEAKER_HF_HOME=/absolute/path/to/hf_home
```

Use this when your default `third_party/Irodori-TTS/.venv` stalls while importing
`pandas` or `datasets`, or when you keep a known-good training runtime elsewhere.

## Workflow

1. In `テキストから生成`, design or import a voice and generate a seed wav.
2. In `表現音セット`, create a small test set first, then larger candidate sets.
3. In `人間チェック`, listen and decide which clips are worth keeping.
4. In `調整から成果物`, build a Speaker Inversion artifact from accepted material.
5. In `成果物テスト`, select a completed artifact and generate test speech.

## Storage

Runtime data is written under:

```text
.runtime/
```

This directory is ignored by Git. It may contain generated audio, local logs,
Speaker Inversion jobs, Hugging Face caches, and final artifacts.

Final artifacts created by the lab are stored under:

```text
.runtime/final_artifacts/
```

Export only the files you intentionally want to share.

The public repository intentionally includes only these reviewed sample final artifacts:

```text
assets/final/sample-voice-01-01-mqxvg6zm/
assets/final/seed-voice-02-reference-mqx15gvj/
```

Do not add other generated artifacts to Git unless they have been reviewed for
licensing, content, private paths, and source material.

## Publishing Notes

Before publishing or tagging a release, check that:

- `.runtime/` is not included.
- `assets/reference/` contains no private wav files.
- `assets/final/` contains only the two reviewed public sample safetensors artifacts.
- No local absolute paths, API keys, tokens, or generated model files are staged.

The included `.gitignore` is intentionally conservative and excludes common audio,
model, log, cache, and export artifacts.

## License

NANAMI VOICE LABO is released under the MIT License. See [LICENSE](LICENSE).

This license applies to the NANAMI VOICE LABO source code and the reviewed sample
files intentionally included in this repository. It does not grant rights to
Irodori-TTS, Irodori model weights, third-party dependencies, private voice
recordings, generated datasets, or user-created speaker artifacts.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency, model, and
audio-material notes.
