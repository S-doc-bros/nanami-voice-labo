#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

for ENV_FILE in "$SCRIPT_DIR/.env" "$SCRIPT_DIR/.env.local"; do
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    source "$ENV_FILE"
    set +a
  fi
done

PYTHON="${PYTHON:-$(command -v python3 || true)}"
if [[ -z "$PYTHON" ]]; then
  echo "python3 was not found." >&2
  exit 1
fi

RUNTIME_DIR="$SCRIPT_DIR/.runtime"
LAB_PRESET_DIR="$RUNTIME_DIR/lab-only-voice"
LAB_ENGINE_OUTPUT_DIR="$RUNTIME_DIR/lab-v3-engine-output"
FINAL_ENGINE_OUTPUT_DIR="$RUNTIME_DIR/final-engine-output"
LAB_ENGINE_LOG="$RUNTIME_DIR/lab-v3-engine.log"
FINAL_ENGINE_LOG="$RUNTIME_DIR/final-engine.log"
LAB_SCRIPTWRITER_LOG="$RUNTIME_DIR/lab-scriptwriter.log"
mkdir -p "$LAB_PRESET_DIR" "$LAB_ENGINE_OUTPUT_DIR" "$FINAL_ENGINE_OUTPUT_DIR"

export IRODORI_BRIDGE_HOST="${IRODORI_BRIDGE_HOST:-127.0.0.1}"
export IRODORI_BRIDGE_PORT="${IRODORI_BRIDGE_PORT:-8088}"
export IRODORI_LAB_ENGINE_HOST="${IRODORI_LAB_ENGINE_HOST:-127.0.0.1}"
export IRODORI_LAB_ENGINE_PORT="${IRODORI_LAB_ENGINE_PORT:-8089}"
export IRODORI_LOCAL_ENGINE_ENDPOINT="http://$IRODORI_LAB_ENGINE_HOST:$IRODORI_LAB_ENGINE_PORT"
export IRODORI_FINAL_ENGINE_HOST="${IRODORI_FINAL_ENGINE_HOST:-127.0.0.1}"
export IRODORI_FINAL_ENGINE_PORT="${IRODORI_FINAL_ENGINE_PORT:-8090}"
export IRODORI_FINAL_ENGINE_ENDPOINT="http://$IRODORI_FINAL_ENGINE_HOST:$IRODORI_FINAL_ENGINE_PORT"
export IRODORI_DEFAULT_MODEL="${IRODORI_DEFAULT_MODEL:-irodori-v3-lab-engine}"
export NANAMI_VOICE_PRESET_DIR="$LAB_PRESET_DIR"
export IRODORI_VOICE_LAB_ONLY="1"
export IRODORI_SCRIPTWRITER_HOST="${IRODORI_SCRIPTWRITER_HOST:-127.0.0.1}"
export IRODORI_SCRIPTWRITER_PORT="${IRODORI_SCRIPTWRITER_PORT:-8080}"
export IRODORI_SCRIPTWRITER_ENDPOINT="${IRODORI_SCRIPTWRITER_ENDPOINT:-http://$IRODORI_SCRIPTWRITER_HOST:$IRODORI_SCRIPTWRITER_PORT/v1}"
export IRODORI_SCRIPTWRITER_MODEL="${IRODORI_SCRIPTWRITER_MODEL:-irodori-scriptwriter}"
export IRODORI_SCRIPTWRITER_AUTOSTART="${IRODORI_SCRIPTWRITER_AUTOSTART:-0}"
export IRODORI_SPEAKER_DEVICE="${IRODORI_SPEAKER_DEVICE:-cpu}"

VOICE_ENGINE_HOME="${NANAMI_VOICE_ENGINE_HOME:-$RUNTIME_DIR/voice_engine}"
LAB_ENGINE_SERVER="$SCRIPT_DIR/lab_v3_engine_server.py"
LAB_ENGINE_IRODORI_REPO="${IRODORI_REPO_DIR:-$SCRIPT_DIR/third_party/Irodori-TTS}"
FINAL_ENGINE_IRODORI_REPO="${IRODORI_FINAL_REPO_DIR:-$LAB_ENGINE_IRODORI_REPO}"
LAB_ENGINE_PY="${NANAMI_VOICE_ENGINE_PYTHON:-${IRODORI_PYTHON:-$PYTHON}}"
if [[ -z "${NANAMI_VOICE_ENGINE_PYTHON:-}" && -z "${IRODORI_PYTHON:-}" && -x "$LAB_ENGINE_IRODORI_REPO/.venv/bin/python" ]]; then
  LAB_ENGINE_PY="$LAB_ENGINE_IRODORI_REPO/.venv/bin/python"
fi
LAB_VOICE_MODEL="${IRODORI_LAB_VOICE_MODEL:-Aratako/Irodori-TTS-600M-v3-VoiceDesign}"
FINAL_BASE_CHECKPOINT="${IRODORI_FINAL_BASE_CHECKPOINT:-Aratako/Irodori-TTS-500M-v3}"
if [[ -n "${IRODORI_FINAL_ENGINE_CONFIG:-}" ]]; then
  FINAL_ENGINE_CONFIG="$IRODORI_FINAL_ENGINE_CONFIG"
  FINAL_ENGINE_CONFIG_AUTO=0
else
  FINAL_ENGINE_CONFIG="$RUNTIME_DIR/final-engine-500m.json"
  FINAL_ENGINE_CONFIG_AUTO=1
fi
LAB_ENGINE_SITE_PACKAGES="${NANAMI_VOICE_ENGINE_SITE_PACKAGES:-$FINAL_ENGINE_IRODORI_REPO/.venv/lib/python3.10/site-packages}"
VOICE_ENGINE_HF_HOME="${IRODORI_HF_HOME:-$VOICE_ENGINE_HOME/hf_home}"
SCRIPTWRITER_LLAMA_SERVER="${IRODORI_SCRIPTWRITER_LLAMA_SERVER:-$(command -v llama-server || true)}"
SCRIPTWRITER_GGUF="${IRODORI_SCRIPTWRITER_GGUF:-}"

is_local_model_ref() {
  [[ "$1" == *.safetensors || "$1" == /* || "$1" == ./* || "$1" == ../* || "$1" == "~"* ]]
}

if [[ ! -x "$LAB_ENGINE_PY" ]]; then
  echo "Voice engine Python was not found or is not executable." >&2
  echo "Set NANAMI_VOICE_ENGINE_PYTHON or IRODORI_PYTHON." >&2
  echo "Current: $LAB_ENGINE_PY" >&2
  exit 1
fi

if [[ ! -f "$LAB_ENGINE_SERVER" || ! -d "$LAB_ENGINE_IRODORI_REPO" || ! -d "$FINAL_ENGINE_IRODORI_REPO" ]]; then
  echo "Required local voice resources were not found." >&2
  echo "Run ./Setup Irodori.command first, or set IRODORI_REPO_DIR for your machine." >&2
  echo "Python: $LAB_ENGINE_PY" >&2
  echo "Server: $LAB_ENGINE_SERVER" >&2
  echo "VoiceDesign model: $LAB_VOICE_MODEL" >&2
  echo "Final engine config: $FINAL_ENGINE_CONFIG" >&2
  echo "Irodori repo: $LAB_ENGINE_IRODORI_REPO" >&2
  echo "Final engine repo: $FINAL_ENGINE_IRODORI_REPO" >&2
  exit 1
fi

if is_local_model_ref "$LAB_VOICE_MODEL" && [[ ! -f "${LAB_VOICE_MODEL/#\~/$HOME}" ]]; then
  echo "VoiceDesign model file was not found: $LAB_VOICE_MODEL" >&2
  echo "Use the Hugging Face model id Aratako/Irodori-TTS-600M-v3-VoiceDesign, or set IRODORI_LAB_VOICE_MODEL to an existing model.safetensors file." >&2
  exit 1
fi

if [[ "$FINAL_ENGINE_CONFIG_AUTO" == "1" ]]; then
  mkdir -p "$(dirname "$FINAL_ENGINE_CONFIG")"
  cat > "$FINAL_ENGINE_CONFIG" <<JSON
{
  "status": "nanami_voice_labo_final_500m",
  "route": {
    "name": "speaker_inversion_500m",
    "base_checkpoint": "$FINAL_BASE_CHECKPOINT",
    "ref_embed": ""
  },
  "inference": {
    "model_device": "mps",
    "codec_device": "mps",
    "num_steps": 24,
    "cfg_guidance_mode": "independent",
    "cfg_scale_text": 1.0,
    "cfg_scale_caption": 1.0,
    "cfg_scale_speaker": 1.0,
    "duration_scale": 1.0,
    "trim_tail": true,
    "t_schedule_mode": "linear",
    "sway_coeff": -1.0,
    "context_kv_cache": true
  }
}
JSON
elif [[ ! -f "$FINAL_ENGINE_CONFIG" ]]; then
  echo "Final engine config file was not found: $FINAL_ENGINE_CONFIG" >&2
  echo "Unset IRODORI_FINAL_ENGINE_CONFIG to use the generated default config." >&2
  exit 1
fi

export IRODORI_PYTHON="${IRODORI_PYTHON:-$LAB_ENGINE_PY}"
if [[ -d "$LAB_ENGINE_SITE_PACKAGES" ]]; then
  export IRODORI_SPEAKER_PYTHONPATH="${IRODORI_SPEAKER_PYTHONPATH:-$LAB_ENGINE_SITE_PACKAGES}"
  export PYTHONPATH="$LAB_ENGINE_SITE_PACKAGES${PYTHONPATH:+:$PYTHONPATH}"
fi

LAB_ENGINE_CONFIG="$RUNTIME_DIR/lab-voice-design-600m.json"
cat > "$LAB_ENGINE_CONFIG" <<JSON
{
  "status": "nanami_voice_labo_600m_voicedesign",
  "route": {
    "name": "voice_design_600m",
    "base_checkpoint": "$LAB_VOICE_MODEL",
    "ref_embed": ""
  },
  "inference": {
    "model_device": "mps",
    "codec_device": "mps",
    "num_steps": 24,
    "cfg_guidance_mode": "independent",
    "cfg_scale_text": 1.0,
    "cfg_scale_caption": 1.0,
    "cfg_scale_speaker": 1.0,
    "duration_scale": 1.0,
    "trim_tail": false,
    "t_schedule_mode": "sway",
    "sway_coeff": -1.0,
    "context_kv_cache": true
  }
}
JSON

if ! curl -fsS --max-time 2 "$IRODORI_LOCAL_ENGINE_ENDPOINT/health" >/dev/null 2>&1; then
  echo "Starting VoiceDesign engine: $IRODORI_LOCAL_ENGINE_ENDPOINT"
  export HF_HOME="$VOICE_ENGINE_HF_HOME"
  "$LAB_ENGINE_PY" "$LAB_ENGINE_SERVER" \
    --host "$IRODORI_LAB_ENGINE_HOST" \
    --port "$IRODORI_LAB_ENGINE_PORT" \
    --config "$LAB_ENGINE_CONFIG" \
    --output-dir "$LAB_ENGINE_OUTPUT_DIR" \
    --irodori-repo "$LAB_ENGINE_IRODORI_REPO" \
    > "$LAB_ENGINE_LOG" 2>&1 &

  for _ in {1..90}; do
    if curl -fsS --max-time 2 "$IRODORI_LOCAL_ENGINE_ENDPOINT/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! curl -fsS --max-time 2 "$IRODORI_LOCAL_ENGINE_ENDPOINT/health" >/dev/null 2>&1; then
  echo "VoiceDesign engine did not become ready. Log: $LAB_ENGINE_LOG" >&2
  tail -n 80 "$LAB_ENGINE_LOG" >&2 || true
  exit 1
fi

if ! curl -fsS --max-time 2 "$IRODORI_FINAL_ENGINE_ENDPOINT/health" >/dev/null 2>&1; then
  echo "Starting final voice engine: $IRODORI_FINAL_ENGINE_ENDPOINT"
  export HF_HOME="$VOICE_ENGINE_HF_HOME"
  "$LAB_ENGINE_PY" "$LAB_ENGINE_SERVER" \
    --host "$IRODORI_FINAL_ENGINE_HOST" \
    --port "$IRODORI_FINAL_ENGINE_PORT" \
    --config "$FINAL_ENGINE_CONFIG" \
    --output-dir "$FINAL_ENGINE_OUTPUT_DIR" \
    --irodori-repo "$FINAL_ENGINE_IRODORI_REPO" \
    --no-preload \
    > "$FINAL_ENGINE_LOG" 2>&1 &

  for _ in {1..30}; do
    if curl -fsS --max-time 2 "$IRODORI_FINAL_ENGINE_ENDPOINT/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! curl -fsS --max-time 2 "$IRODORI_FINAL_ENGINE_ENDPOINT/health" >/dev/null 2>&1; then
  echo "Final voice engine did not become ready. Log: $FINAL_ENGINE_LOG" >&2
  tail -n 80 "$FINAL_ENGINE_LOG" >&2 || true
  exit 1
fi

scriptwriter_ready() {
  curl -fsS --max-time 2 "$IRODORI_SCRIPTWRITER_ENDPOINT/models" >/dev/null 2>&1
}

if [[ "$IRODORI_SCRIPTWRITER_AUTOSTART" != "0" ]] && ! scriptwriter_ready; then
  if [[ -x "$SCRIPTWRITER_LLAMA_SERVER" && -n "$SCRIPTWRITER_GGUF" && -s "$SCRIPTWRITER_GGUF" ]]; then
    echo "Starting scriptwriter model: $IRODORI_SCRIPTWRITER_ENDPOINT"
    "$SCRIPTWRITER_LLAMA_SERVER" \
      --model "$SCRIPTWRITER_GGUF" \
      --alias "$IRODORI_SCRIPTWRITER_MODEL" \
      --host "$IRODORI_SCRIPTWRITER_HOST" \
      --port "$IRODORI_SCRIPTWRITER_PORT" \
      --ctx-size "${IRODORI_SCRIPTWRITER_CTX:-4096}" \
      --gpu-layers "${IRODORI_SCRIPTWRITER_GPU_LAYERS:-99}" \
      > "$LAB_SCRIPTWRITER_LOG" 2>&1 &

    for _ in {1..180}; do
      if scriptwriter_ready; then
        break
      fi
      sleep 1
    done
  else
    echo "Scriptwriter resources were not found; local fallback text generation remains enabled." >&2
  fi
fi

echo "Starting NANAMI VOICE LABO bridge"
echo "API: http://$IRODORI_BRIDGE_HOST:$IRODORI_BRIDGE_PORT/v1"
echo "VoiceDesign engine: $IRODORI_LOCAL_ENGINE_ENDPOINT"
echo "Final voice engine: $IRODORI_FINAL_ENGINE_ENDPOINT"
echo "Scriptwriter endpoint: $IRODORI_SCRIPTWRITER_ENDPOINT"
echo "Irodori repo: $LAB_ENGINE_IRODORI_REPO"
echo ""

exec "$PYTHON" irodori_openai_bridge.py
