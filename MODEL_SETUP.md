# Model Setup

NANAMI VOICE LABO does not include Irodori-TTS model weights.

The easiest path is:

1. Run `./Setup Irodori.command`.
2. Run `./Start UI.command`.
3. Run `./Start Bridge Lab Only.command`.
4. Generate a short test voice.

On the first generation, the bridge downloads these Hugging Face models automatically:

- `Aratako/Irodori-TTS-600M-v3-VoiceDesign`
- `Aratako/Irodori-TTS-500M-v3`

The download can take several minutes. `Start Bridge Lab Only.command` waits up
to 10 minutes for the first VoiceDesign startup by default. After that, the files
are cached locally.

## Where Irodori-TTS Goes

The setup command clones Irodori-TTS here:

```text
third_party/Irodori-TTS
```

This directory is ignored by Git.

## Manual Model Paths

If you already downloaded `model.safetensors` files, copy `.env.example` to
`.env.local` and edit these values:

```bash
IRODORI_LAB_VOICE_MODEL=/absolute/path/to/Irodori-TTS-600M-v3-VoiceDesign/model.safetensors
IRODORI_FINAL_BASE_CHECKPOINT=/absolute/path/to/Irodori-TTS-500M-v3/model.safetensors
IRODORI_SPEAKER_BASE_CHECKPOINT=/absolute/path/to/Irodori-TTS-500M-v3/model.safetensors
```

Most users should not need this manual path setup.

## Speaker Inversion Python

Speaker Inversion uses `prepare_manifest.py` and `train.py` from Irodori-TTS.
Before starting a job, the bridge verifies that the selected Python can import
`torch`, `pandas`, `datasets`, and the Irodori codec.

If that check fails or hangs in your local `third_party/Irodori-TTS/.venv`, set a
known-good training runtime in `.env.local`:

```bash
IRODORI_SPEAKER_PYTHON=/absolute/path/to/python3.10
IRODORI_SPEAKER_PYTHONPATH=/absolute/path/to/Irodori-TTS/.venv/lib/python3.10/site-packages
IRODORI_SPEAKER_HF_HOME=/absolute/path/to/hf_home
```

This only changes Speaker Inversion. Text-to-voice generation can continue using
the normal lab engine runtime.
