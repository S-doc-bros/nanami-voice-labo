#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "NANAMI VOICE LABO setup"
echo

if ! command -v git >/dev/null 2>&1; then
  echo "git was not found. Install Xcode Command Line Tools first:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv was not found. Install uv first:" >&2
  echo "  brew install uv" >&2
  echo "or see: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg was not found. Install it first:" >&2
  echo "  brew install ffmpeg" >&2
  exit 1
fi

mkdir -p third_party

if [[ ! -d third_party/Irodori-TTS/.git ]]; then
  echo "Cloning Irodori-TTS..."
  git clone https://github.com/Aratako/Irodori-TTS.git third_party/Irodori-TTS
else
  echo "Irodori-TTS already exists. Updating..."
  git -C third_party/Irodori-TTS pull --ff-only
fi

echo
echo "Installing Irodori-TTS dependencies with uv..."
(
  cd third_party/Irodori-TTS
  uv sync --extra cpu
)

if [[ ! -f .env.local ]]; then
  cp .env.example .env.local
  echo "Created .env.local from .env.example"
else
  echo ".env.local already exists; leaving it unchanged."
fi

cat <<'TEXT'

Setup complete.

Next:
  1. Run ./Start UI.command
  2. Run ./Start Bridge Lab Only.command
  3. Open http://localhost:5190

The first generation may take a while because the Irodori models are downloaded
from Hugging Face automatically:
  - Aratako/Irodori-TTS-600M-v3-VoiceDesign
  - Aratako/Irodori-TTS-500M-v3

TEXT
