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

The download can take several minutes. After that, the files are cached locally.

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
