#!/bin/zsh
set -e

cd "$(dirname "$0")"

for ENV_FILE in "$PWD/.env" "$PWD/.env.local"; do
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    source "$ENV_FILE"
    set +a
  fi
done

echo "NANAMI VOICE LABO bridge"
echo "Runtime: Irodori-TTS-Lite"
echo "API: http://localhost:8088/v1"
echo "Health: http://localhost:8088/health"
echo
echo "Press Control-C to stop."
echo

python3 irodori_openai_bridge.py
