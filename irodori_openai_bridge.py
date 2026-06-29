from __future__ import annotations

from email import policy
from email.parser import BytesParser
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
import urllib.request


HOST = os.environ.get("IRODORI_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("IRODORI_BRIDGE_PORT", "8088"))
BASE_DIR = Path(__file__).resolve().parent
RUNTIME_DIR = BASE_DIR / ".runtime"
REFERENCE_DIR = RUNTIME_DIR / "reference_voices"
OUTPUT_DIR = RUNTIME_DIR / "outputs"
AUDIO_PROCESS_DIR = RUNTIME_DIR / "audio_process"
SPEAKER_INVERSION_JOB_DIR = RUNTIME_DIR / "speaker_inversion_jobs"
GENERATED_FINAL_DIR = RUNTIME_DIR / "final_artifacts"
ASSET_REFERENCE_DIR = BASE_DIR / "assets" / "reference"
ASSET_FINAL_DIR = BASE_DIR / "assets" / "final"
BUNDLED_NANAMI_SAMPLE = ASSET_REFERENCE_DIR / "nanami_voice_sample.wav"
BUNDLED_NANAMI_FINAL_DIR = ASSET_FINAL_DIR / "nanami-v1"
BUNDLED_NANAMI_FINAL_EMBED = BUNDLED_NANAMI_FINAL_DIR / "checkpoint_final.speaker.safetensors"
BUNDLED_NANAMI_FINAL_MANIFEST = BUNDLED_NANAMI_FINAL_DIR / "manifest.json"
NANAMI_REFERENCE_IDS = {"nanami", "nanami_standard_voice", "nanami_voice_sample"}
NANAMI_FINAL_ARTIFACT_ID = "nanami-v1-final"
INCLUDE_BUNDLED_REFERENCE_VOICES = False
INCLUDE_BUNDLED_FINAL_ARTIFACTS = False
VOICE_ENGINE_HOME = Path(
  os.environ.get(
    "NANAMI_VOICE_ENGINE_HOME",
    RUNTIME_DIR / "voice_engine",
  )
).resolve()
NANAMI_VOICE_PRESET_DIR = Path(
  os.environ.get(
    "NANAMI_VOICE_PRESET_DIR",
    RUNTIME_DIR / "lab-only-nanami-voice",
  )
).resolve()
IRODORI_REPO_DIR = Path(
  os.environ.get(
    "IRODORI_REPO_DIR",
    BASE_DIR / "third_party" / "Irodori-TTS",
  )
).resolve()
IRODORI_LITE_ENABLED = os.environ.get("IRODORI_LITE_ENABLED", "1").strip().lower() not in {
  "0",
  "false",
  "no",
  "off",
}
IRODORI_LITE_RUNNER = BASE_DIR / "irodori_lite_runner.py"
UV_COMMAND = os.environ.get("IRODORI_UV", "uv")
IRODORI_PYTHON = os.environ.get("IRODORI_PYTHON", "").strip()
IRODORI_SPEAKER_PYTHONPATH = os.environ.get("IRODORI_SPEAKER_PYTHONPATH", "").strip()
FFMPEG_COMMAND = os.environ.get("IRODORI_FFMPEG", "ffmpeg")
DEEP_FILTER_COMMAND = os.environ.get("DEEP_FILTER_COMMAND", shutil.which("deep-filter") or str(Path.home() / ".local" / "bin" / "deep-filter"))
TIMEOUT_SECONDS = int(os.environ.get("IRODORI_TIMEOUT_SECONDS", "360"))
SYNTH_LOCK = threading.Lock()
DEFAULT_MODEL = os.environ.get("IRODORI_DEFAULT_MODEL", "irodori-lite-auto")
LOCAL_ENGINE_ENDPOINT = os.environ.get("IRODORI_LOCAL_ENGINE_ENDPOINT", "").strip().rstrip("/")
FINAL_ENGINE_ENDPOINT = os.environ.get("IRODORI_FINAL_ENGINE_ENDPOINT", LOCAL_ENGINE_ENDPOINT).strip().rstrip("/")
DEFAULT_SPEAKER_BASE_CHECKPOINT = VOICE_ENGINE_HOME / "models" / "Irodori-TTS-500M-v3" / "model.safetensors"
SPEAKER_INVERSION_BASE_CHECKPOINT = os.environ.get(
  "IRODORI_SPEAKER_BASE_CHECKPOINT",
  str(DEFAULT_SPEAKER_BASE_CHECKPOINT if DEFAULT_SPEAKER_BASE_CHECKPOINT.is_file() else "Aratako/Irodori-TTS-500M-v3"),
).strip()
SPEAKER_INVERSION_CONFIG = IRODORI_REPO_DIR / "configs" / "train_500m_v3_speaker_inversion.yaml"
SPEAKER_INVERSION_FINAL_NAME = "checkpoint_final.speaker.safetensors"
SPEAKER_HF_HOME = Path(
  os.environ.get(
    "IRODORI_SPEAKER_HF_HOME",
    VOICE_ENGINE_HOME / "hf_home",
  )
).expanduser()
if not SPEAKER_HF_HOME.exists():
  SPEAKER_HF_HOME = RUNTIME_DIR / "huggingface"
SPEAKER_UPLOAD_MAX_BYTES = int(os.environ.get("IRODORI_SPEAKER_UPLOAD_MAX_BYTES", str(640 * 1024 * 1024)))
SPEAKER_UPLOAD_MAX_FILE_BYTES = int(os.environ.get("IRODORI_SPEAKER_UPLOAD_MAX_FILE_BYTES", str(64 * 1024 * 1024)))
SPEAKER_UPLOAD_MAX_CLIPS = int(os.environ.get("IRODORI_SPEAKER_UPLOAD_MAX_CLIPS", "240"))
SPEAKER_PREPARE_TIMEOUT_SECONDS_DEFAULT = 3600
SPEAKER_PREPARE_TIMEOUT_SECONDS_PER_CLIP = int(os.environ.get("IRODORI_SPEAKER_PREPARE_TIMEOUT_SECONDS_PER_CLIP", "20"))
SPEAKER_PREPARE_TIMEOUT_SECONDS_MAX = int(os.environ.get("IRODORI_SPEAKER_PREPARE_TIMEOUT_SECONDS_MAX", "7200"))
SPEAKER_JOB_PROCESSES: dict[str, subprocess.Popen[Any]] = {}
SPEAKER_JOB_LOCK = threading.Lock()
SPEAKER_PYTHON_DEPENDENCY_CACHE: dict[str, Any] | None = None
SCRIPTWRITER_ENDPOINT = os.environ.get("IRODORI_SCRIPTWRITER_ENDPOINT", "http://127.0.0.1:8080/v1").strip().rstrip("/")
SCRIPTWRITER_MODEL = os.environ.get(
  "IRODORI_SCRIPTWRITER_MODEL",
  "HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M",
).strip()

AUDIO_TYPES = {
  "wav": "audio/wav",
  "mp3": "audio/mpeg",
  "flac": "audio/flac",
  "opus": "audio/ogg",
  "aac": "audio/aac",
}

SCRIPT_LENGTHS = {
  "short": {
    "label": "短い",
    "target": "10〜40字",
    "max_tokens": 90,
    "instruction": "短く、即座に発声できる一息のセリフ。",
  },
  "medium": {
    "label": "標準",
    "target": "120〜180字",
    "max_tokens": 300,
    "instruction": "約160字。数呼吸で読める、感情の流れがわかる標準のセリフ。",
  },
  "long": {
    "label": "長い",
    "target": "360〜440字",
    "max_tokens": 820,
    "instruction": "約400字。短い独白として、恐怖・迷い・叫び・息切れなどの感情変化を段階的に入れる長いセリフ。",
  },
}

MODEL_PRESETS = {
  "irodori-nanami-final-500m": {
    "label": "ななみ最終音声 500M",
    "checkpoint": SPEAKER_INVERSION_BASE_CHECKPOINT,
    "mode": "speaker-inversion",
    "runtime": "final-engine",
    "caption": False,
    "speaker_embedding": True,
  },
  "irodori-speaker-inversion-500m-v3": {
    "label": "500M v3 Speaker Inversion",
    "checkpoint": SPEAKER_INVERSION_BASE_CHECKPOINT,
    "mode": "speaker-inversion",
    "runtime": "classic",
    "caption": False,
    "speaker_embedding": True,
  },
  "irodori-v3-lab-engine": {
    "label": "Nanami Labo 600M v3 VoiceDesign",
    "checkpoint": None,
    "mode": "voice-design",
    "runtime": "local-engine",
  },
  "irodori-voice-design-600m-v3": {
    "label": "600M v3 VoiceDesign",
    "checkpoint": "Aratako/Irodori-TTS-600M-v3-VoiceDesign",
    "mode": "voice-design",
    "runtime": "classic",
    "caption": True,
    "reference_optional": True,
  },
  "irodori-lite-auto": {
    "label": "Lite 自動",
    "checkpoint": None,
    "clone_checkpoint": "hf://kizuna-intelligence/Irodori-TTS-500M-v3-int4/model.safetensors",
    "mode": "auto",
    "runtime": "lite",
  },
  "irodori-lite-voice-design": {
    "label": "Lite VoiceDesign INT4",
    "checkpoint": None,
    "mode": "voice-design",
    "runtime": "lite",
  },
  "irodori-lite-v3-int4": {
    "label": "Lite 500M v3 INT4",
    "checkpoint": "hf://kizuna-intelligence/Irodori-TTS-500M-v3-int4/model.safetensors",
    "mode": "voice-design",
    "runtime": "lite",
  },
  "irodori-auto": {
    "label": "旧: 自動",
    "checkpoint": "Aratako/Irodori-TTS-500M-v2-VoiceDesign",
    "clone_checkpoint": "Aratako/Irodori-TTS-500M-v2",
    "mode": "auto",
    "runtime": "classic",
  },
  "irodori-voice-design-500m-v2": {
    "label": "旧: 声デザイン 500M v2",
    "checkpoint": "Aratako/Irodori-TTS-500M-v2-VoiceDesign",
    "mode": "voice-design",
    "runtime": "classic",
  },
  "irodori-clone-500m-v2": {
    "label": "旧: 参照音声クローン 500M v2",
    "checkpoint": "Aratako/Irodori-TTS-500M-v2",
    "mode": "reference",
    "runtime": "classic",
  },
  "irodori-tts": {
    "label": "互換: irodori-tts",
    "checkpoint": None,
    "clone_checkpoint": "hf://kizuna-intelligence/Irodori-TTS-500M-v3-int4/model.safetensors",
    "mode": "auto",
    "runtime": "lite",
  },
}


class BridgeError(RuntimeError):
  def __init__(self, message: str, status: int = 500) -> None:
    super().__init__(message)
    self.status = status


def ensure_dirs() -> None:
  REFERENCE_DIR.mkdir(parents=True, exist_ok=True)
  OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
  AUDIO_PROCESS_DIR.mkdir(parents=True, exist_ok=True)
  SPEAKER_INVERSION_JOB_DIR.mkdir(parents=True, exist_ok=True)
  GENERATED_FINAL_DIR.mkdir(parents=True, exist_ok=True)
  NANAMI_VOICE_PRESET_DIR.mkdir(parents=True, exist_ok=True)


def ready_state() -> dict[str, Any]:
  problems = []
  local_engine = probe_local_engine() if LOCAL_ENGINE_ENDPOINT else None
  final_engine = probe_local_engine(FINAL_ENGINE_ENDPOINT) if FINAL_ENGINE_ENDPOINT else None
  scriptwriter = probe_scriptwriter()
  if LOCAL_ENGINE_ENDPOINT and not local_engine["online"]:
    problems.append(f"local Irodori v3 engine is not reachable: {LOCAL_ENGINE_ENDPOINT}")
  if FINAL_ENGINE_ENDPOINT and not final_engine["online"]:
    problems.append(f"final Nanami engine is not reachable: {FINAL_ENGINE_ENDPOINT}")
  if not IRODORI_REPO_DIR.exists():
    problems.append(f"Irodori repo not found: {IRODORI_REPO_DIR}")
  if not (IRODORI_REPO_DIR / "infer.py").exists():
    problems.append("infer.py not found")
  if IRODORI_LITE_ENABLED and not IRODORI_LITE_RUNNER.exists():
    problems.append("irodori_lite_runner.py not found")
  if not shutil.which(UV_COMMAND):
    problems.append(f"uv command not found: {UV_COMMAND}")
  ffmpeg_ready = bool(shutil.which(FFMPEG_COMMAND))
  deep_filter_path = shutil.which(DEEP_FILTER_COMMAND) or (DEEP_FILTER_COMMAND if Path(DEEP_FILTER_COMMAND).is_file() else "")
  ready = not problems
  models = [
    model_id
    for model_id, config in MODEL_PRESETS.items()
    if IRODORI_LITE_ENABLED or config.get("runtime") not in {"lite"}
  ]
  return {
    "ok": ready,
    "ready": ready,
    "engine": "irodori-openai-bridge-local-v3" if LOCAL_ENGINE_ENDPOINT else (
      "irodori-openai-bridge-lite" if IRODORI_LITE_ENABLED else "irodori-openai-bridge"
    ),
    "defaultModel": DEFAULT_MODEL,
    "localEngineEndpoint": LOCAL_ENGINE_ENDPOINT,
    "localEngine": local_engine,
    "finalEngineEndpoint": FINAL_ENGINE_ENDPOINT,
    "finalEngine": final_engine,
    "scriptwriterEndpoint": SCRIPTWRITER_ENDPOINT,
    "scriptwriterModel": SCRIPTWRITER_MODEL,
    "scriptwriter": scriptwriter,
    "repoDir": str(IRODORI_REPO_DIR),
    "liteEnabled": IRODORI_LITE_ENABLED,
    "liteRunner": str(IRODORI_LITE_RUNNER),
    "uvCommand": UV_COMMAND,
    "uvReady": bool(shutil.which(UV_COMMAND)),
    "ffmpegReady": ffmpeg_ready,
    "deepFilterReady": bool(deep_filter_path),
    "deepFilterCommand": deep_filter_path or DEEP_FILTER_COMMAND,
    "modelDevice": os.environ.get("IRODORI_MODEL_DEVICE", ""),
    "codecDevice": os.environ.get("IRODORI_CODEC_DEVICE", ""),
    "cacheDir": str(RUNTIME_DIR),
    "hfHome": str(RUNTIME_DIR / "huggingface"),
    "speakerInversion": speaker_inversion_ready_state(),
    "timeoutSeconds": TIMEOUT_SECONDS,
    "models": models,
    "finalArtifacts": list_final_artifacts(),
    "problems": problems,
    "message": "ready" if not problems else " / ".join(problems),
  }


def probe_local_engine(endpoint: str | None = None, timeout: float = 0.75) -> dict[str, Any]:
  target = (endpoint if endpoint is not None else LOCAL_ENGINE_ENDPOINT).strip().rstrip("/")
  if not target:
    return {"online": False, "skipped": True}
  try:
    with urllib.request.urlopen(f"{target}/health", timeout=timeout) as response:
      body = response.read().decode("utf-8", "replace")
    payload = json.loads(body) if body else {}
    return {"online": True, "health": payload}
  except Exception as error:
    return {"online": False, "error": str(error)}


def probe_scriptwriter(timeout: float = 0.75) -> dict[str, Any]:
  if not SCRIPTWRITER_ENDPOINT:
    return {"online": False, "skipped": True}
  try:
    with urllib.request.urlopen(f"{SCRIPTWRITER_ENDPOINT}/models", timeout=timeout) as response:
      body = response.read().decode("utf-8", "replace")
    payload = json.loads(body) if body else {}
    return {"online": True, "models": payload}
  except Exception as error:
    return {"online": False, "error": str(error)}


def unload_local_engine(endpoint: str | None = None, timeout: float = 2.0) -> dict[str, Any]:
  target = (endpoint if endpoint is not None else LOCAL_ENGINE_ENDPOINT).strip().rstrip("/")
  if not target:
    return {"ok": True, "skipped": True}
  request = urllib.request.Request(f"{target}/model", method="DELETE")
  try:
    with urllib.request.urlopen(request, timeout=timeout) as response:
      body = response.read().decode("utf-8", "replace")
    payload = json.loads(body) if body else {}
    if isinstance(payload, dict):
      return payload
    return {"ok": False, "error": "unexpected local engine unload response"}
  except Exception as error:
    return {"ok": False, "error": str(error)}


def normalize_script_length(value: Any) -> str:
  length = str(value or "medium").strip().lower()
  return length if length in SCRIPT_LENGTHS else "medium"


def scriptwriter_chat_url() -> str:
  if not SCRIPTWRITER_ENDPOINT:
    raise BridgeError("scriptwriter endpoint is not configured", status=503)
  if SCRIPTWRITER_ENDPOINT.endswith("/chat/completions"):
    return SCRIPTWRITER_ENDPOINT
  return f"{SCRIPTWRITER_ENDPOINT}/chat/completions"


def clean_script_line(value: str, limit: int = 560) -> str:
  text = value.replace("\r", "\n").strip()
  for fence in ("```", "「", "」", '"', "'", "“", "”"):
    text = text.replace(fence, "")
  lines = [
    line.strip(" -・*：:\t")
    for line in text.splitlines()
    if line.strip() and not line.strip().startswith(("#", "{", "["))
  ]
  text = " ".join(lines) if lines else text
  for prefix in ("セリフ:", "セリフ：", "台詞:", "台詞：", "出力:", "出力："):
    if text.startswith(prefix):
      text = text[len(prefix):].strip()
  text = " ".join(text.split())
  return text[:limit].strip()


def extract_script_text(message: dict[str, Any]) -> str:
  content = str(message.get("content") or "").strip()
  if content:
    return clean_script_line(content)
  reasoning = str(message.get("reasoning_content") or "").strip()
  if not reasoning:
    return ""
  quoted = re.findall(r"「([^」]{2,560})」", reasoning)
  if quoted:
    return clean_script_line(quoted[-1])
  return clean_script_line(reasoning)


def script_variant_number(value: Any) -> int:
  if value in (None, ""):
    return time.time_ns()
  try:
    return int(value)
  except (TypeError, ValueError):
    text = str(value)
    return sum((index + 1) * ord(char) for index, char in enumerate(text))


def detect_script_tone(scenario: str) -> str:
  text = scenario.lower()
  if any(word in text for word in ("怖", "恐怖", "追", "逃", "襲", "ジェイソン", "行き止まり", "殺", "幽霊", "叫")):
    return "horror"
  if any(word in text for word in ("急", "危", "助", "落ち", "閉じ込", "迷子", "痛")):
    return "panic"
  if any(word in text for word in ("泣", "悲", "別れ", "さみ", "寂", "失")):
    return "sad"
  if any(word in text for word in ("嬉", "喜", "好き", "会え", "成功", "ありがとう")):
    return "happy"
  return "neutral"


def rotated(items: list[str], variant: int) -> list[str]:
  if not items:
    return items
  offset = variant % len(items)
  return items[offset:] + items[:offset]


def fit_fallback_line_length(line: str, length_key: str, tone: str, variant: int) -> str:
  floors = {"medium": 145, "long": 390}
  floor = floors.get(length_key)
  if floor is None:
    return line
  additions = {
    "horror": [
      "息がうまく吸えなくて、声が震えて、誰の名前を呼べばいいのかもわからない。",
      "近づいてくるたびに胸が締めつけられて、足が床に貼りついたみたいに動かない。",
      "お願い、誰か返事をして。暗い廊下の向こうでも、階段の上でもいいから、私の声に気づいて。",
      "もう強がれない。怖い、怖いよ。涙で前が見えないのに、あの影だけははっきり見えてしまう。",
    ],
    "panic": [
      "頭では落ち着けってわかっているのに、心臓の音ばかり大きくなって、言葉がばらばらになる。",
      "でも諦めたくない。まだできることがあるなら、震えていてもいいから手を伸ばしたい。",
      "お願い、今だけは私を見て。何度でも呼ぶから、声が枯れても呼ぶから、どうか止まって。",
    ],
    "sad": [
      "思い出すほど胸が苦しくて、言えなかった言葉ばかりが今さらあふれてくる。",
      "ちゃんと笑いたいのに、声の端が震えて、涙をこらえるだけで精一杯なの。",
      "それでも忘れたくない。痛くても、悲しくても、この気持ちは大切に持っていたい。",
    ],
    "happy": [
      "胸の奥が明るくなって、少し息を吸うだけで笑ってしまいそうになる。",
      "今まで黙っていた分まで、ちゃんと伝えたい。ありがとう、ほんとうにありがとう。",
      "この瞬間を録音して、何度でも聞き返したいくらい、今の私は幸せだよ。",
    ],
    "neutral": [
      "言葉を選ぼうとするほど胸がいっぱいになって、指先まで熱くなっていく。",
      "でも逃げずに言いたい。少し不器用でも、今の私の声でちゃんと届けたい。",
      "だから待って。最後まで聞いて。これは、今ここでしか言えない気持ちだから。",
    ],
  }
  for addition in rotated(additions.get(tone, additions["neutral"]), variant):
    if len(line) >= floor:
      break
    separator = " " if line.endswith(("！", "？", "!", "?", "…", "」")) else "。"
    line = f"{line}{separator}{addition}"
  return line


def scriptwriter_fallback_line(scenario: str, length_key: str, variant: int) -> str:
  tone = detect_script_tone(scenario)

  if tone == "horror":
    lines = {
      "short": [
        "こ、来ないで……いや、いやあっ！お願い、来ないで！",
        "やだ……足音が近い。お願い、こっちに来ないで！",
        "待って、無理……いや、見ないで、近づかないで！",
      ],
      "medium": [
        (
          "こ、来ないで……お願い、そこから動かないで。もう後ろは壁なの、逃げ道なんてどこにもないの。"
          "ねえ、聞こえてる？私、何もしてない。ただ帰りたいだけなの。いや、近づかないで、お願い、誰か、誰か助けて！"
        ),
        (
          "やだ……足音が近い。さっきまで遠くにいたのに、もう目の前にいる。お願い、そこで止まって。"
          "息が詰まって声が出ないの。違う、来ないで。私を見ないで。誰か、お願い、ここから出して！"
        ),
        (
          "待って、無理……ここ、行き止まりなの？後ろに下がれない、手が冷たい、膝が震えて立っていられない。"
          "お願い、やめて。そんな顔で近づかないで。いや、いやあっ、誰か助けて！"
        ),
      ],
      "long": [
        (
          "こ、来ないで……お願い、そこから一歩も動かないで。後ろは壁で、横にも出口がなくて、もう逃げ道なんてどこにもないの。"
          "足が震えて、息がうまく吸えない。さっきまで聞こえていた声も、全部遠くなって、あなたの足音だけが近づいてくる。"
          "ねえ、聞こえてる？私、何もしてない。ただ帰りたいだけなの。お願いだから、そんなふうに見ないで。"
          "いや、いやだ、近づかないで。手を伸ばさないで。やめて、お願い、ここから出して。誰か、誰かいないの？"
          "声が出ない、でも叫ばなきゃ。いやあっ、来ないで、来ないで、来ないで！お願い、誰か助けて！"
        ),
        (
          "やだ……足音が近い。さっきまでは角の向こうだったのに、もう目の前にいる。どうして、どうしてこっちに来るの。"
          "後ろを探しても壁しかない。手を伸ばしても冷たいコンクリートに触れるだけで、出口なんてどこにもない。"
          "お願い、そこで止まって。私、何も見てない。誰にも言わない。だからもう放っておいて。"
          "声が震えて、自分の息の音まで怖い。近づかないで、見ないで、笑わないで。"
          "いや、だめ、来ないで。お願い、お願いだから、誰か気づいて。ここにいるの、助けて、助けて！"
        ),
        (
          "待って、無理……ここ、行き止まりなの？さっき開いていた扉も閉まってる。鍵の音がして、廊下が急に静かになった。"
          "あなたの影だけが長く伸びて、足元まで届いて、逃げなきゃって思うのに体が動かない。"
          "お願い、そんなふうに近づかないで。私を見ないで。名前も呼ばないで。"
          "喉が痛い、叫びたいのに声が引っかかる。いや、いやだ、手を伸ばさないで。"
          "誰か、誰か返事して。ここにいる、ここにいるの。お願い、私を置いていかないで！"
        ),
      ],
    }
  elif tone == "panic":
    lines = {
      "short": "待って、だめ……お願い、今すぐ止まって！",
      "medium": (
        "待って、だめ……このままじゃ間に合わない。息が追いつかなくて、手も震えてるけど、まだ止められるはずなの。"
        "お願い、今すぐ止まって。こっちを見て、私の声を聞いて。大丈夫、まだ間に合うから！"
      ),
      "long": (
        "待って、だめ……このままじゃ間に合わない。足がもつれて、息が喉に引っかかって、ちゃんと声が出ない。"
        "でも止まらなきゃ、止めなきゃ、今ここで叫ばなきゃ全部終わってしまう。お願い、こっちを見て。"
        "私の声、聞こえてるよね？まだ間に合う。怖いけど、逃げたいけど、ここで目をそらしたら後悔する。"
        "だからお願い、今すぐ止まって。手を伸ばして。大丈夫、大丈夫って言って。私もちゃんと立つから、最後まで諦めないから！"
      ),
    }
  elif tone == "sad":
    lines = {
      "short": "やだ……まだ、さよならなんて言いたくないよ。",
      "medium": (
        "やだ……まだ、さよならなんて言いたくないよ。ちゃんと笑って見送りたいのに、声が震えてしまうの。"
        "もう少しだけ、ここにいて。何も言わなくていいから、最後にもう一度だけ、私の名前を呼んで。"
      ),
      "long": (
        "やだ……まだ、さよならなんて言いたくないよ。ちゃんと笑って見送りたいのに、声が震えて、胸の奥がぎゅっと痛いの。"
        "ありがとうって言わなきゃいけないのに、言葉にしたら本当に終わってしまいそうで怖い。"
        "もう少しだけ、ここにいて。何も言わなくていいから、最後にもう一度だけ、私の名前を呼んで。"
        "泣かないって決めたのに、だめだね。涙が止まらない。でも忘れないよ。今日のことも、その声も、全部ちゃんと覚えているから。"
      ),
    }
  elif tone == "happy":
    lines = {
      "short": "ほんとに？うれしい……今、すごく幸せだよ。",
      "medium": (
        "ほんとに？うれしい……胸がふわっとして、今、すごく幸せだよ。"
        "ずっと言葉にできなかったけど、やっと言える。私、この瞬間を忘れたくない。ねえ、もう一回だけ笑って見せて。"
      ),
      "long": (
        "ほんとに？うれしい……胸がふわっとして、体の奥まであたたかくなる。"
        "ずっと言葉にできなかったけど、今なら言える。私、この瞬間をずっと待っていたのかもしれない。"
        "ねえ、もう一回だけ笑って見せて。その顔を見たら、今まで我慢していた気持ちが全部こぼれてしまいそう。"
        "ありがとう。そばにいてくれて、見つけてくれて、ちゃんと聞いてくれて。私、今、すごく幸せだよ。"
      ),
    }
  else:
    lines = {
      "short": "え……待って。今の気持ち、ちゃんと言葉にしたい。",
      "medium": (
        "え……待って。今の気持ち、ちゃんと言葉にしたいのに、胸がいっぱいでうまく言えない。"
        "少しだけ時間をちょうだい。逃げずに、目をそらさずに、今度こそ私の声で伝えたいの。"
      ),
      "long": (
        "え……待って。今の気持ち、ちゃんと言葉にしたいのに、胸がいっぱいでうまく言えない。"
        "さっきまで平気なふりをしていたのに、あなたの顔を見たら、全部ほどけてしまいそう。"
        "少しだけ時間をちょうだい。逃げずに、目をそらさずに、今度こそ私の声で伝えたいの。"
        "怖いけど、黙ったまま終わらせたくない。だから聞いて。今ここにいる私の言葉を、最後までちゃんと聞いて。"
      ),
    }
  candidates = lines.get(length_key, lines["short"])
  if isinstance(candidates, list):
    line = candidates[variant % len(candidates)]
  else:
    line = candidates
  return fit_fallback_line_length(line, length_key, tone, variant)


def fallback_script_response(scenario: str, length_key: str, reason: str, variant: int) -> dict[str, Any]:
  length = SCRIPT_LENGTHS[length_key]
  return {
    "ok": True,
    "text": scriptwriter_fallback_line(scenario, length_key, variant),
    "length": length_key,
    "target": length["target"],
    "model": "local-script-fallback",
    "endpoint": SCRIPTWRITER_ENDPOINT,
    "source": "local-fallback",
    "variant": variant,
    "warning": f"Gemma脚本生成が使えなかったため、ラボ内の簡易生成で作りました。{reason}",
  }


def generate_script_line(payload: dict[str, Any]) -> dict[str, Any]:
  scenario = str(payload.get("scenario") or "").strip()
  if not scenario:
    raise BridgeError("scenario is required", status=400)
  length_key = normalize_script_length(payload.get("length"))
  length = SCRIPT_LENGTHS[length_key]
  variant = script_variant_number(payload.get("variant"))
  model = str(payload.get("model") or SCRIPTWRITER_MODEL).strip() or SCRIPTWRITER_MODEL

  system_prompt = (
    "あなたは日本語の脚本家、女性声優、そして『ななみ』役の演技ディレクターです。"
    "声質は常にななみ固定で、ユーザーが指定する場面に合わせて演技のセリフだけを作ります。"
    "TTSに渡すためのセリフ本文だけを作ります。"
    "説明、箇条書き、引用符、話者名、ト書き、メタコメントは出さず、"
    "生成する音声で実際に読ませる日本語のセリフだけを1案返してください。"
    "叫び、息切れ、泣き、震え、詰まり、言い直しは文字として読める範囲で自然に入れて構いません。"
  )
  user_prompt = (
    f"場面: {scenario}\n"
    f"再生成ID: {variant}\n"
    f"文字数の目安: {length['target']}\n"
    f"長さの指示: {length['instruction']}\n"
    "出力条件: 日本語。セリフ本文のみ。1案だけ。"
    "同じ場面でも再生成IDが違う時は、前回と違う言い回し、間、感情の揺れを使ってください。"
  )
  chat_payload = {
    "model": model,
    "messages": [
      {"role": "system", "content": system_prompt},
      {"role": "user", "content": user_prompt},
    ],
    "temperature": float(payload.get("temperature") or 0.8),
    "top_p": float(payload.get("top_p") or 0.9),
    "max_tokens": int(length["max_tokens"]),
    "seed": variant & 0xFFFFFFFF,
    "stream": False,
  }
  request = urllib.request.Request(
    scriptwriter_chat_url(),
    data=json.dumps(chat_payload, ensure_ascii=False).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
  )
  try:
    with urllib.request.urlopen(request, timeout=90) as response:
      body = response.read().decode("utf-8", "replace")
  except Exception as error:
    return fallback_script_response(scenario, length_key, str(error), variant)
  result = json.loads(body) if body else {}
  choices = result.get("choices") if isinstance(result, dict) else None
  if not choices:
    return fallback_script_response(scenario, length_key, "LLM returned no choices.", variant)
  message = choices[0].get("message") if isinstance(choices[0], dict) else {}
  line = extract_script_text(message)
  if not line:
    return fallback_script_response(scenario, length_key, "LLM returned an empty line.", variant)
  line = fit_fallback_line_length(line, length_key, detect_script_tone(scenario), variant)
  return {
    "ok": True,
    "text": line,
    "length": length_key,
    "target": length["target"],
    "model": model,
    "endpoint": SCRIPTWRITER_ENDPOINT,
    "source": "llm",
    "variant": variant,
  }


def sanitize_id(value: str) -> str:
  cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "-" for ch in value.strip())
  return cleaned.strip(".-_")[:80] or f"voice-{uuid.uuid4().hex[:10]}"


def utc_now() -> str:
  return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def parse_bool(value: Any, default: bool = False) -> bool:
  if value in (None, ""):
    return default
  if isinstance(value, bool):
    return value
  return str(value).strip().lower() in {"1", "true", "yes", "on", "y"}


def default_speaker_train_device() -> str:
  configured = os.environ.get("IRODORI_SPEAKER_DEVICE") or os.environ.get("IRODORI_TRAIN_DEVICE")
  if configured:
    return configured
  # App-launched macOS sessions can report MPS as built but unavailable. Default
  # Speaker Inversion to CPU unless the user explicitly opts into MPS/CUDA.
  if sys.platform == "darwin":
    return "cpu"
  return "cuda" if os.environ.get("CUDA_VISIBLE_DEVICES") else "cpu"


def irodori_python_command() -> list[str]:
  if IRODORI_PYTHON:
    return [IRODORI_PYTHON]
  venv_python = IRODORI_REPO_DIR / ".venv" / "bin" / "python"
  if venv_python.is_file():
    return [str(venv_python)]
  return [UV_COMMAND, "run", "python"]


def irodori_python_ready() -> tuple[bool, str]:
  command = irodori_python_command()
  if len(command) == 1:
    path = Path(command[0]).expanduser()
    if path.is_file() or shutil.which(command[0]):
      return True, command[0]
    return False, command[0]
  if shutil.which(UV_COMMAND):
    return True, " ".join(command)
  return False, " ".join(command)


def merge_pythonpath(base_env: dict[str, str], extra_pythonpath: str) -> dict[str, str]:
  paths = [path for path in extra_pythonpath.split(os.pathsep) if path.strip()]
  current = base_env.get("PYTHONPATH", "")
  if current:
    paths.extend(path for path in current.split(os.pathsep) if path.strip())
  if paths:
    base_env["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(paths))
  return base_env


def speaker_python_dependency_state() -> dict[str, Any]:
  global SPEAKER_PYTHON_DEPENDENCY_CACHE
  if SPEAKER_PYTHON_DEPENDENCY_CACHE is not None:
    return SPEAKER_PYTHON_DEPENDENCY_CACHE
  command = irodori_python_command()
  python_ready, python_command = irodori_python_ready()
  if not python_ready:
    SPEAKER_PYTHON_DEPENDENCY_CACHE = {
      "ok": False,
      "pythonCommand": python_command,
      "error": f"Irodori python command not found: {python_command}",
    }
    return SPEAKER_PYTHON_DEPENDENCY_CACHE
  env = speaker_job_env()
  try:
    result = subprocess.run(
      [
        *command,
        "-c",
        "import torch; print(getattr(torch, '__version__', 'unknown'))",
      ],
      cwd=IRODORI_REPO_DIR if IRODORI_REPO_DIR.is_dir() else BASE_DIR,
      env=env,
      text=True,
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
      timeout=30,
      check=False,
    )
  except Exception as error:
    SPEAKER_PYTHON_DEPENDENCY_CACHE = {
      "ok": False,
      "pythonCommand": python_command,
      "pythonPath": env.get("PYTHONPATH", ""),
      "error": str(error),
    }
    return SPEAKER_PYTHON_DEPENDENCY_CACHE
  output = (result.stdout or "").strip()
  SPEAKER_PYTHON_DEPENDENCY_CACHE = {
    "ok": result.returncode == 0,
    "pythonCommand": python_command,
    "pythonPath": env.get("PYTHONPATH", ""),
    "torch": output if result.returncode == 0 else "",
    "error": "" if result.returncode == 0 else output or f"torch import failed with exit code {result.returncode}",
  }
  return SPEAKER_PYTHON_DEPENDENCY_CACHE


def speaker_inversion_ready_state() -> dict[str, Any]:
  base_path = Path(SPEAKER_INVERSION_BASE_CHECKPOINT).expanduser()
  active_jobs = [job for job in list_speaker_jobs() if job.get("status") in {"queued", "preparing", "training", "registering", "cancelling"}]
  python_ready, python_command = irodori_python_ready()
  dependency_state = speaker_python_dependency_state()
  problems = []
  if not IRODORI_REPO_DIR.is_dir():
    problems.append(f"Irodori repo not found: {IRODORI_REPO_DIR}")
  for filename in ("prepare_manifest.py", "train.py"):
    if not (IRODORI_REPO_DIR / filename).is_file():
      problems.append(f"{filename} not found")
  if not SPEAKER_INVERSION_CONFIG.is_file():
    problems.append(f"speaker inversion config not found: {SPEAKER_INVERSION_CONFIG}")
  if not base_path.is_file():
    problems.append(f"base checkpoint not found: {SPEAKER_INVERSION_BASE_CHECKPOINT}")
  if not python_ready:
    problems.append(f"Irodori python command not found: {python_command}")
  if not dependency_state.get("ok"):
    problems.append(f"speaker inversion python cannot import torch: {dependency_state.get('error') or 'unknown error'}")
  return {
    "ok": not problems,
    "ready": not problems,
    "repoDir": str(IRODORI_REPO_DIR),
    "config": str(SPEAKER_INVERSION_CONFIG),
    "baseCheckpoint": SPEAKER_INVERSION_BASE_CHECKPOINT,
    "baseCheckpointExists": base_path.is_file(),
    "hfHome": str(SPEAKER_HF_HOME),
    "pythonCommand": python_command,
    "pythonPath": dependency_state.get("pythonPath", ""),
    "torch": dependency_state.get("torch", ""),
    "jobsDir": str(SPEAKER_INVERSION_JOB_DIR),
    "finalArtifactsDir": str(GENERATED_FINAL_DIR),
    "deviceDefault": default_speaker_train_device(),
    "activeJobs": active_jobs,
    "problems": problems,
  }


def speaker_job_path(job_id: str) -> Path:
  return SPEAKER_INVERSION_JOB_DIR / sanitize_id(job_id)


def speaker_job_state_path(job_id: str) -> Path:
  return speaker_job_path(job_id) / "job.json"


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
  tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
  os.replace(tmp, path)


def load_speaker_job(job_id: str) -> dict[str, Any] | None:
  path = speaker_job_state_path(job_id)
  if not path.is_file():
    return None
  try:
    data = json.loads(path.read_text(encoding="utf-8"))
  except (OSError, json.JSONDecodeError):
    return None
  return data if isinstance(data, dict) else None


def save_speaker_job(job: dict[str, Any]) -> dict[str, Any]:
  job["updated_at"] = utc_now()
  write_json_atomic(speaker_job_state_path(str(job["job_id"])), job)
  return job


def update_speaker_job(job_id: str, **updates: Any) -> dict[str, Any]:
  job = load_speaker_job(job_id)
  if job is None:
    raise BridgeError(f"speaker inversion job not found: {job_id}", status=404)
  job.update(updates)
  return save_speaker_job(job)


def append_speaker_job_log(job: dict[str, Any], message: str) -> None:
  log_path = Path(str(job.get("log_path") or speaker_job_path(str(job["job_id"])) / "job.log"))
  log_path.parent.mkdir(parents=True, exist_ok=True)
  with log_path.open("a", encoding="utf-8") as output:
    output.write(f"[{utc_now()}] {message}\n")


def speaker_job_log_tail(job: dict[str, Any], max_chars: int = 16_000) -> str:
  log_path = Path(str(job.get("log_path") or ""))
  if not log_path.is_file():
    return ""
  try:
    data = log_path.read_text(encoding="utf-8", errors="replace")
  except OSError:
    return ""
  return data[-max_chars:]


def public_speaker_job(job: dict[str, Any], *, include_log: bool = True) -> dict[str, Any]:
  public = {key: value for key, value in job.items() if key not in {"source_items"}}
  public["running"] = public.get("status") in {"queued", "preparing", "training", "registering", "cancelling"}
  if include_log:
    public["logTail"] = speaker_job_log_tail(job)
  return public


def list_speaker_jobs() -> list[dict[str, Any]]:
  jobs: list[dict[str, Any]] = []
  if SPEAKER_INVERSION_JOB_DIR.exists():
    for job_file in SPEAKER_INVERSION_JOB_DIR.glob("*/job.json"):
      job = load_speaker_job(job_file.parent.name)
      if job:
        jobs.append(public_speaker_job(job, include_log=False))
  jobs.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
  return jobs


def active_speaker_jobs() -> list[dict[str, Any]]:
  return [job for job in list_speaker_jobs() if job.get("status") in {"queued", "preparing", "training", "registering", "cancelling"}]


def process_group_alive(pid: int) -> bool:
  if pid <= 0:
    return False
  try:
    os.killpg(pid, 0)
    return True
  except ProcessLookupError:
    return False
  except PermissionError:
    return True


def terminate_process_group(pid: int, process: subprocess.Popen[Any] | None = None) -> None:
  if pid <= 0:
    return
  try:
    os.killpg(pid, signal.SIGTERM)
  except ProcessLookupError:
    return
  for _ in range(20):
    if process is not None:
      if process.poll() is not None:
        return
    elif not process_group_alive(pid):
      return
    time.sleep(0.1)
  try:
    os.killpg(pid, signal.SIGKILL)
  except ProcessLookupError:
    pass


def validate_safetensors_file(path: Path) -> tuple[bool, str]:
  if not path.is_file():
    return False, "checkpoint_final.speaker.safetensors が見つかりません。"
  try:
    size = path.stat().st_size
  except OSError as error:
    return False, str(error)
  if size <= 8:
    return False, "checkpoint_final.speaker.safetensors が0バイトまたは壊れています。"
  try:
    with path.open("rb") as input_file:
      header_size = int.from_bytes(input_file.read(8), "little")
      if header_size <= 0 or header_size > size - 8 or header_size > 64 * 1024 * 1024:
        return False, "safetensorsヘッダーが不正です。"
      header = json.loads(input_file.read(header_size).decode("utf-8"))
      tensor_keys = [key for key in header.keys() if key != "__metadata__"]
      if not tensor_keys:
        return False, "safetensors内にテンソルがありません。"
      data_size = size - 8 - header_size
      for key in tensor_keys:
        entry = header.get(key)
        if not isinstance(entry, dict):
          return False, f"safetensorsテンソル情報が不正です: {key}"
        offsets = entry.get("data_offsets")
        if (
          not isinstance(offsets, list)
          or len(offsets) != 2
          or not all(isinstance(value, int) for value in offsets)
        ):
          return False, f"safetensors data_offsets が不正です: {key}"
        start, end = offsets
        if start < 0 or end <= start or end > data_size:
          return False, f"safetensors data_offsets がファイルサイズと一致しません: {key}"
  except Exception as error:
    return False, f"safetensors検証に失敗しました: {error}"
  return True, "ok"


def speaker_job_env() -> dict[str, str]:
  env = {
    **os.environ,
    "UV_CACHE_DIR": str(RUNTIME_DIR / "uv-cache"),
    "HF_HOME": str(SPEAKER_HF_HOME),
    "PYTHONUNBUFFERED": "1",
    "TOKENIZERS_PARALLELISM": "false",
  }
  merge_pythonpath(env, IRODORI_SPEAKER_PYTHONPATH)
  if os.environ.get("IRODORI_SPEAKER_OFFLINE", "1").strip().lower() not in {"0", "false", "no", "off"}:
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
  return env


def speaker_process_timeout(job: dict[str, Any], phase: str) -> int:
  env_key = {
    "prepare_manifest": "IRODORI_SPEAKER_PREPARE_TIMEOUT_SECONDS",
    "train": "IRODORI_SPEAKER_TRAIN_TIMEOUT_SECONDS",
  }.get(phase, "IRODORI_SPEAKER_PROCESS_TIMEOUT_SECONDS")
  raw = os.environ.get(env_key)
  if raw:
    try:
      return max(0, int(raw))
    except ValueError:
      return 0
  if phase == "prepare_manifest":
    if parse_bool(job.get("smoke"), False):
      return 180
    clip_count = int(job.get("sample_count") or job.get("clip_count") or 0)
    per_clip_timeout = clip_count * SPEAKER_PREPARE_TIMEOUT_SECONDS_PER_CLIP
    scaled_timeout = max(SPEAKER_PREPARE_TIMEOUT_SECONDS_DEFAULT, per_clip_timeout)
    return min(SPEAKER_PREPARE_TIMEOUT_SECONDS_MAX, scaled_timeout)
  if phase == "train" and parse_bool(job.get("smoke"), False):
    return 900
  return 0


def run_speaker_process(job_id: str, phase: str, command: list[str]) -> bool:
  job = load_speaker_job(job_id)
  if job is None:
    return False
  append_speaker_job_log(job, f"{phase}: {' '.join(command)}")
  log_path = Path(str(job["log_path"]))
  with log_path.open("a", encoding="utf-8", errors="replace") as log_file:
    process = subprocess.Popen(
      command,
      cwd=IRODORI_REPO_DIR,
      stdout=log_file,
      stderr=subprocess.STDOUT,
      text=True,
      env=speaker_job_env(),
      start_new_session=True,
    )
    with SPEAKER_JOB_LOCK:
      SPEAKER_JOB_PROCESSES[job_id] = process
    update_speaker_job(job_id, pid=process.pid, phase=phase)
    timeout_seconds = speaker_process_timeout(job, phase)
    append_speaker_job_log(job, f"{phase} timeout limit: {timeout_seconds} seconds.")
    try:
      return_code = process.wait(timeout=timeout_seconds if timeout_seconds > 0 else None)
    except subprocess.TimeoutExpired:
      append_speaker_job_log(job, f"{phase} timed out after {timeout_seconds} seconds.")
      terminate_process_group(process.pid, process)
      with SPEAKER_JOB_LOCK:
        SPEAKER_JOB_PROCESSES.pop(job_id, None)
      update_speaker_job(
        job_id,
        status="failed",
        phase=phase,
        pid=None,
        error=f"{phase} timed out after {timeout_seconds} seconds",
      )
      return False
  with SPEAKER_JOB_LOCK:
    SPEAKER_JOB_PROCESSES.pop(job_id, None)
  latest = load_speaker_job(job_id) or {}
  if latest.get("status") in {"cancelling", "cancelled"}:
    save_speaker_job({**latest, "status": "cancelled", "phase": phase, "pid": None})
    return False
  if return_code != 0:
    update_speaker_job(
      job_id,
      status="failed",
      phase=phase,
      pid=None,
      error=f"{phase} failed with exit code {return_code}",
    )
    return False
  update_speaker_job(job_id, pid=None)
  return True


def register_speaker_artifact(job_id: str) -> dict[str, Any]:
  job = load_speaker_job(job_id)
  if job is None:
    raise BridgeError(f"speaker inversion job not found: {job_id}", status=404)
  artifact_id = sanitize_id(str(job["artifact_id"]))
  output_dir = Path(str(job["train_output_dir"]))
  final_src = output_dir / SPEAKER_INVERSION_FINAL_NAME
  ok, detail = validate_safetensors_file(final_src)
  if not ok:
    update_speaker_job(job_id, status="failed", phase="artifact_invalid", error=detail)
    raise BridgeError(detail, status=500)

  final_dir = GENERATED_FINAL_DIR / artifact_id
  if final_dir.exists():
    update_speaker_job(job_id, status="failed", phase="registering", error=f"artifact already exists: {artifact_id}")
    raise BridgeError(f"artifact already exists: {artifact_id}", status=409)
  tmp_dir = GENERATED_FINAL_DIR / f".{artifact_id}.tmp-{job_id}"
  if tmp_dir.exists():
    shutil.rmtree(tmp_dir)
  tmp_dir.mkdir(parents=True, exist_ok=True)
  shutil.copy2(final_src, tmp_dir / SPEAKER_INVERSION_FINAL_NAME)
  created_at = utc_now()
  config = {
    "schema_version": 1,
    "artifact_id": artifact_id,
    "model": "irodori-nanami-final-500m",
    "mode": "speaker-inversion",
    "speaker_embedding": SPEAKER_INVERSION_FINAL_NAME,
    "base_checkpoint": SPEAKER_INVERSION_BASE_CHECKPOINT,
    "source_job": job_id,
  }
  manifest = {
    "schema_version": 1,
    "artifact_id": artifact_id,
    "display_name": str(job.get("display_name") or artifact_id),
    "description": str(job.get("description") or "NANAMI VOICE LABOで作成したSpeaker Inversion成果物です。"),
    "model": "irodori-nanami-final-500m",
    "speaker_embedding": SPEAKER_INVERSION_FINAL_NAME,
    "source": "nanami-voice-labo-speaker-inversion",
    "job_id": job_id,
    "sample_count": int(job.get("sample_count") or 0),
    "base_checkpoint": SPEAKER_INVERSION_BASE_CHECKPOINT,
    "created_at": created_at,
    "notes": [
      f"mode={job.get('mode') or 'standard'}",
      f"max_steps={job.get('max_steps') or 'config-default'}",
    ],
  }
  write_json_atomic(tmp_dir / "config.json", config)
  write_json_atomic(tmp_dir / "manifest.json", manifest)
  os.replace(tmp_dir, final_dir)
  artifact = next((item for item in list_final_artifacts() if sanitize_id(str(item.get("artifact_id"))) == artifact_id), None)
  if artifact is None:
    raise BridgeError("registered artifact did not appear in final artifact list", status=500)
  return artifact


def run_speaker_inversion_job(job_id: str) -> None:
  try:
    job = update_speaker_job(job_id, status="preparing", phase="prepare_manifest")
    append_speaker_job_log(job, "Speaker Inversion prepare started.")
    source_dataset = Path(str(job["dataset_path"]))
    prepared_manifest = Path(str(job["prepared_manifest_path"]))
    latent_dir = Path(str(job["latent_dir"]))
    device = str(job.get("device") or default_speaker_train_device())
    prepare_cmd = [
      *irodori_python_command(),
      "prepare_manifest.py",
      "--dataset",
      "json",
      "--data-files",
      f"train={source_dataset}",
      "--split",
      "train",
      "--audio-column",
      "audio",
      "--text-column",
      "text",
      "--caption-column",
      "caption",
      "--output-manifest",
      str(prepared_manifest),
      "--latent-dir",
      str(latent_dir),
      "--device",
      device,
      "--cache-dir",
      str(SPEAKER_HF_HOME),
      "--normalize-db",
      "-16",
      "--log-every",
      "1",
      "--flush-every",
      "1",
    ]
    if parse_bool(job.get("smoke"), False):
      prepare_cmd.extend(["--max-samples", "2", "--max-seconds", "3"])
    if not run_speaker_process(job_id, "prepare_manifest", prepare_cmd):
      return
    if not prepared_manifest.is_file() or prepared_manifest.stat().st_size <= 0:
      update_speaker_job(job_id, status="failed", phase="prepare_manifest", error="prepare_manifest produced no rows.")
      return

    job = update_speaker_job(job_id, status="training", phase="train")
    append_speaker_job_log(job, "Speaker Inversion training started.")
    train_cmd = [
      *irodori_python_command(),
      "train.py",
      "--config",
      str(SPEAKER_INVERSION_CONFIG),
      "--manifest",
      str(prepared_manifest),
      "--init-checkpoint",
      SPEAKER_INVERSION_BASE_CHECKPOINT,
      "--output-dir",
      str(job["train_output_dir"]),
      "--speaker-inversion",
      "--device",
      device,
      "--precision",
      str(job.get("precision") or "fp32"),
      "--batch-size",
      str(int(job.get("batch_size") or 1)),
      "--num-workers",
      str(int(job.get("num_workers") or 0)),
      "--log-every",
      "1",
      "--save-every",
      "250",
      "--no-progress",
      "--no-wandb",
    ]
    max_steps = job.get("max_steps")
    if max_steps not in (None, ""):
      train_cmd.extend(["--max-steps", str(int(max_steps))])
    if not run_speaker_process(job_id, "train", train_cmd):
      return

    update_speaker_job(job_id, status="registering", phase="registering")
    artifact = register_speaker_artifact(job_id)
    update_speaker_job(job_id, status="completed", phase="completed", artifact=artifact, error="")
    append_speaker_job_log(load_speaker_job(job_id) or {"job_id": job_id}, "Speaker Inversion completed and artifact registered.")
  except Exception as error:
    try:
      update_speaker_job(job_id, status="failed", phase="failed", error=str(error))
      append_speaker_job_log(load_speaker_job(job_id) or {"job_id": job_id}, f"ERROR: {error}")
    except Exception:
      pass


def cancel_speaker_job(job_id: str) -> dict[str, Any]:
  job = load_speaker_job(job_id)
  if job is None:
    raise BridgeError(f"speaker inversion job not found: {job_id}", status=404)
  update_speaker_job(job_id, status="cancelling", phase="cancelling")
  with SPEAKER_JOB_LOCK:
    process = SPEAKER_JOB_PROCESSES.get(job_id)
  pid = process.pid if process is not None else int(job.get("pid") or 0)
  if (process and process.poll() is None) or process_group_alive(pid):
    terminate_process_group(pid, process)
  job = update_speaker_job(job_id, status="cancelled", phase="cancelled", pid=None)
  append_speaker_job_log(job, "Speaker Inversion job cancelled.")
  return job


def find_reference_voice(voice_id: str) -> Path | None:
  if not voice_id or voice_id == "none":
    return None
  if INCLUDE_BUNDLED_REFERENCE_VOICES and voice_id in NANAMI_REFERENCE_IDS:
    if BUNDLED_NANAMI_SAMPLE.is_file():
      return BUNDLED_NANAMI_SAMPLE
    preset_sample = NANAMI_VOICE_PRESET_DIR / "nanami_voice_sample.wav"
    if preset_sample.is_file():
      return preset_sample
  for path in REFERENCE_DIR.glob(f"{sanitize_id(voice_id)}.*"):
    if path.is_file():
      return path
  return None


def list_reference_voices() -> list[dict[str, Any]]:
  voices: list[dict[str, Any]] = []
  if INCLUDE_BUNDLED_REFERENCE_VOICES and BUNDLED_NANAMI_SAMPLE.is_file():
    try:
      stat = BUNDLED_NANAMI_SAMPLE.stat()
      voices.append({
        "voice_id": "nanami",
        "display_name": "Base Nanami",
        "filename": BUNDLED_NANAMI_SAMPLE.name,
        "path": str(BUNDLED_NANAMI_SAMPLE),
        "bytes": stat.st_size,
        "updated_at": stat.st_mtime,
        "builtin": True,
      })
    except OSError:
      pass
  for path in sorted(REFERENCE_DIR.glob("*.wav"), key=lambda item: item.stat().st_mtime, reverse=True):
    if not path.is_file():
      continue
    try:
      stat = path.stat()
    except OSError:
      continue
    voices.append({
      "voice_id": path.stem,
      "display_name": path.stem,
      "filename": path.name,
      "path": str(path),
      "bytes": stat.st_size,
      "updated_at": stat.st_mtime,
    })
  return voices


def list_final_artifacts() -> list[dict[str, Any]]:
  artifacts: list[dict[str, Any]] = []
  seen_ids: set[str] = set()
  bundled_ok, _bundled_detail = validate_safetensors_file(BUNDLED_NANAMI_FINAL_EMBED)
  if INCLUDE_BUNDLED_FINAL_ARTIFACTS and bundled_ok:
    try:
      stat = BUNDLED_NANAMI_FINAL_EMBED.stat()
      manifest = {}
      if BUNDLED_NANAMI_FINAL_MANIFEST.is_file():
        manifest = json.loads(BUNDLED_NANAMI_FINAL_MANIFEST.read_text(encoding="utf-8"))
      artifact_id = str(manifest.get("artifact_id") or NANAMI_FINAL_ARTIFACT_ID)
      seen_ids.add(sanitize_id(artifact_id))
      artifacts.append({
        "artifact_id": artifact_id,
        "display_name": str(manifest.get("display_name") or "ななみ v1 最終音声"),
        "description": str(manifest.get("description") or "同梱のななみ最終音声サンプルです。500M v3 の Speaker Inversion 成果物としてテスト生成します。"),
        "model": str(manifest.get("model") or "irodori-nanami-final-500m"),
        "speaker_embedding": BUNDLED_NANAMI_FINAL_EMBED.name,
        "path": str(BUNDLED_NANAMI_FINAL_EMBED),
        "bytes": stat.st_size,
        "updated_at": stat.st_mtime,
        "builtin": True,
        "sample_reference_voice": "nanami",
        "sample_reference_wav": str(BUNDLED_NANAMI_SAMPLE) if BUNDLED_NANAMI_SAMPLE.is_file() else "",
        "base_checkpoint": SPEAKER_INVERSION_BASE_CHECKPOINT,
        "base_checkpoint_exists": Path(SPEAKER_INVERSION_BASE_CHECKPOINT).expanduser().is_file(),
        "notes": manifest.get("notes") if isinstance(manifest.get("notes"), list) else [],
      })
    except (OSError, json.JSONDecodeError):
      pass
  for root in (GENERATED_FINAL_DIR, ASSET_FINAL_DIR):
    if not root.exists():
      continue
    for artifact_dir in sorted(root.glob("*"), key=lambda item: item.stat().st_mtime if item.exists() else 0, reverse=True):
      if not artifact_dir.is_dir() or artifact_dir == BUNDLED_NANAMI_FINAL_DIR:
        continue
      manifest_path = artifact_dir / "manifest.json"
      embed_path = artifact_dir / SPEAKER_INVERSION_FINAL_NAME
      if not manifest_path.is_file() or not embed_path.is_file():
        continue
      try:
        stat = embed_path.stat()
        if stat.st_size <= 0:
          continue
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
      except (OSError, json.JSONDecodeError):
        continue
      ok, _detail = validate_safetensors_file(embed_path)
      if not ok:
        continue
      artifact_id = str(manifest.get("artifact_id") or artifact_dir.name)
      safe_id = sanitize_id(artifact_id)
      if safe_id in seen_ids:
        continue
      seen_ids.add(safe_id)
      artifacts.append({
        "artifact_id": artifact_id,
        "display_name": str(manifest.get("display_name") or artifact_id),
        "description": str(manifest.get("description") or "NANAMI VOICE LABOで作成したSpeaker Inversion成果物です。"),
        "model": str(manifest.get("model") or "irodori-nanami-final-500m"),
        "speaker_embedding": str(manifest.get("speaker_embedding") or SPEAKER_INVERSION_FINAL_NAME),
        "path": str(embed_path),
        "bytes": stat.st_size,
        "updated_at": stat.st_mtime,
        "builtin": False,
        "runtime": is_under_path(artifact_dir, GENERATED_FINAL_DIR),
        "sample_reference_voice": str(manifest.get("sample_reference_voice") or "expression-set"),
        "sample_count": int(manifest.get("sample_count") or 0),
        "job_id": str(manifest.get("job_id") or ""),
        "created_at": str(manifest.get("created_at") or ""),
        "base_checkpoint": str(manifest.get("base_checkpoint") or SPEAKER_INVERSION_BASE_CHECKPOINT),
        "base_checkpoint_exists": Path(str(manifest.get("base_checkpoint") or SPEAKER_INVERSION_BASE_CHECKPOINT)).expanduser().is_file(),
        "download_url": f"/v1/lab/final-artifacts/{safe_id}/checkpoint",
        "notes": manifest.get("notes") if isinstance(manifest.get("notes"), list) else [],
      })
  return artifacts


def find_final_artifact_embedding(artifact_id: str) -> Path | None:
  if not artifact_id:
    return None
  safe_id = sanitize_id(artifact_id)
  bundled_ok, _bundled_detail = validate_safetensors_file(BUNDLED_NANAMI_FINAL_EMBED)
  if safe_id == NANAMI_FINAL_ARTIFACT_ID and bundled_ok:
    return BUNDLED_NANAMI_FINAL_EMBED
  for root in (GENERATED_FINAL_DIR, ASSET_FINAL_DIR):
    if not root.exists():
      continue
    for artifact_dir in root.glob("*"):
      if not artifact_dir.is_dir():
        continue
      manifest_path = artifact_dir / "manifest.json"
      manifest_id = artifact_dir.name
      embed_name = SPEAKER_INVERSION_FINAL_NAME
      if manifest_path.is_file():
        try:
          manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
          manifest_id = str(manifest.get("artifact_id") or manifest_id)
          embed_name = str(manifest.get("speaker_embedding") or embed_name)
        except json.JSONDecodeError:
          pass
      if sanitize_id(manifest_id) == safe_id:
        candidate = (artifact_dir / embed_name).resolve()
        if not is_under_path(candidate, artifact_dir):
          continue
        ok, _detail = validate_safetensors_file(candidate)
        if ok:
          return candidate
  return None


def delete_final_artifact(artifact_id: str) -> dict[str, Any]:
  safe_id = sanitize_id(artifact_id)
  if not safe_id:
    raise BridgeError("final artifact id is required", status=400)
  for root in (GENERATED_FINAL_DIR, ASSET_FINAL_DIR):
    if not root.exists():
      continue
    for artifact_dir in root.glob("*"):
      if artifact_dir == BUNDLED_NANAMI_FINAL_DIR:
        continue
      if not artifact_dir.is_dir():
        continue
      manifest_path = artifact_dir / "manifest.json"
      manifest_id = artifact_dir.name
      if manifest_path.is_file():
        try:
          manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
          manifest_id = str(manifest.get("artifact_id") or manifest_id)
        except json.JSONDecodeError:
          pass
      if sanitize_id(manifest_id) != safe_id:
        continue
      resolved_dir = artifact_dir.resolve()
      resolved_root = root.resolve()
      if not is_under_path(resolved_dir, resolved_root):
        raise BridgeError("refusing to delete artifact outside known final artifact directory", status=400)
      shutil.rmtree(resolved_dir)
      return {"artifact_id": safe_id, "deleted": True, "path": str(resolved_dir), "runtime": root == GENERATED_FINAL_DIR}
  raise BridgeError(f"final artifact not found: {safe_id}", status=404)


def delete_reference_voice(voice_id: str) -> bool:
  safe_id = sanitize_id(voice_id)
  deleted = False
  for path in REFERENCE_DIR.glob(f"{safe_id}.*"):
    if path.is_file():
      path.unlink()
      deleted = True
  return deleted


def is_under_path(path: Path, root: Path) -> bool:
  try:
    resolved = path.expanduser().resolve()
    resolved_root = root.expanduser().resolve()
  except OSError:
    return False
  return resolved == resolved_root or resolved_root in resolved.parents


def delete_transient_file(path: Path) -> bool:
  transient_roots = (
    OUTPUT_DIR,
    RUNTIME_DIR / "lab-v3-engine-output" / "generated",
    RUNTIME_DIR / "nanami-final-engine-output" / "generated",
  )
  if not path.is_file() or not any(is_under_path(path, root) for root in transient_roots):
    return False
  try:
    path.unlink(missing_ok=True)
    return True
  except OSError:
    return False


def clear_transient_audio_cache() -> dict[str, Any]:
  transient_roots = (
    OUTPUT_DIR,
    RUNTIME_DIR / "lab-v3-engine-output" / "generated",
    RUNTIME_DIR / "nanami-final-engine-output" / "generated",
  )
  deleted = 0
  bytes_deleted = 0
  for root in transient_roots:
    if not root.exists():
      continue
    for path in root.rglob("*"):
      if not path.is_file():
        continue
      try:
        size = path.stat().st_size
      except OSError:
        size = 0
      if delete_transient_file(path):
        deleted += 1
        bytes_deleted += size
  return {
    "ok": True,
    "deleted": deleted,
    "bytes": bytes_deleted,
    "preserved": {
      "referenceVoices": str(REFERENCE_DIR),
      "modelCaches": [
        str(RUNTIME_DIR / "huggingface"),
        str(RUNTIME_DIR / "uv-cache"),
      ],
    },
  }


def close_lab_session() -> dict[str, Any]:
  cleanup = clear_transient_audio_cache()
  return {
    "ok": bool(cleanup.get("ok", False)),
    "cache": cleanup,
    "localEngine": unload_local_engine(),
    "finalEngine": unload_local_engine(FINAL_ENGINE_ENDPOINT)
    if FINAL_ENGINE_ENDPOINT and FINAL_ENGINE_ENDPOINT != LOCAL_ENGINE_ENDPOINT
    else {"ok": True, "skipped": True},
  }


def model_config(model_id: str) -> dict[str, str]:
  if model_id not in MODEL_PRESETS:
    raise BridgeError(f"unknown model: {model_id}", status=400)
  config = MODEL_PRESETS[model_id]
  if config.get("runtime") == "lite" and not IRODORI_LITE_ENABLED:
    raise BridgeError(
      f"{model_id} requires Irodori-TTS-Lite. Enable Lite or select a classic comparison model.",
      status=503,
    )
  return config


def bounded_float(value: Any, default: float, *, name: str, minimum: float, maximum: float) -> float:
  try:
    parsed = float(value if value not in (None, "") else default)
  except (TypeError, ValueError):
    raise BridgeError(f"{name} must be a number.", status=400) from None
  if not math.isfinite(parsed):
    raise BridgeError(f"{name} must be finite.", status=400)
  if parsed < minimum or parsed > maximum:
    raise BridgeError(f"{name} must be between {minimum} and {maximum}.", status=400)
  return parsed


def probe_audio_sample_rate(input_path: Path) -> int | None:
  ffprobe = shutil.which("ffprobe")
  if not ffprobe:
    return None
  completed = subprocess.run(
    [
      ffprobe,
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=sample_rate",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      str(input_path),
    ],
    capture_output=True,
    text=True,
    timeout=30,
  )
  if completed.returncode != 0:
    return None
  try:
    sample_rate = int((completed.stdout or "").strip().splitlines()[0])
  except (IndexError, ValueError):
    return None
  return sample_rate if sample_rate > 0 else None


def atempo_filters(tempo: float) -> list[str]:
  if abs(tempo - 1.0) <= 0.001:
    return []
  factors = []
  remaining = tempo
  while remaining < 0.5:
    factors.append(0.5)
    remaining /= 0.5
  while remaining > 2.0:
    factors.append(2.0)
    remaining /= 2.0
  if abs(remaining - 1.0) > 0.001:
    factors.append(remaining)
  return [f"atempo={factor:.6f}" for factor in factors]


def convert_audio(input_path: Path, output_format: str, speed: float = 1.0, pitch: float = 0.0) -> tuple[Path, str]:
  output_format = output_format.lower()
  if output_format not in AUDIO_TYPES:
    raise BridgeError(f"unsupported response_format: {output_format}", status=400)
  if output_format != "wav" or abs(speed - 1.0) > 0.001 or abs(pitch) > 0.001:
    if not shutil.which(FFMPEG_COMMAND):
      raise BridgeError("ffmpeg is required for this output format or speed/pitch processing.", status=503)
    output_path = OUTPUT_DIR / f"{uuid.uuid4().hex}.{output_format}"
    filters = []
    pitch_factor = 2 ** (pitch / 12)
    if abs(pitch) > 0.001:
      sample_rate = probe_audio_sample_rate(input_path) or 24000
      filters.append(f"asetrate={sample_rate}*{pitch_factor:.6f}")
      filters.append(f"aresample={sample_rate}")
    tempo = speed / pitch_factor if abs(pitch) > 0.001 else speed
    filters.extend(atempo_filters(tempo))
    command = [FFMPEG_COMMAND, "-y", "-i", str(input_path)]
    if filters:
      command.extend(["-af", ",".join(filters)])
    command.append(str(output_path))
    completed = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if completed.returncode != 0 or not output_path.exists():
      detail = (completed.stderr or completed.stdout or "").strip()
      raise BridgeError(detail or "ffmpeg conversion failed", status=503)
    return output_path, AUDIO_TYPES[output_format]
  return input_path, AUDIO_TYPES["wav"]


def convert_reference_to_wav(source_path: Path, target_path: Path) -> None:
  if shutil.which(FFMPEG_COMMAND):
    completed = subprocess.run(
      [FFMPEG_COMMAND, "-y", "-i", str(source_path), "-ac", "1", str(target_path)],
      capture_output=True,
      text=True,
      timeout=120,
    )
    if completed.returncode == 0 and target_path.exists():
      return
    detail = (completed.stderr or completed.stdout or "").strip()
    if source_path.suffix.lower() != ".wav":
      raise BridgeError(detail or "reference voice conversion failed", status=503)
  if source_path.suffix.lower() == ".wav":
    shutil.copyfile(source_path, target_path)
    return
  raise BridgeError("ffmpeg is required to convert this reference audio to wav.", status=503)


def deep_filter_command_path() -> str:
  command = shutil.which(DEEP_FILTER_COMMAND)
  if command:
    return command
  path = Path(DEEP_FILTER_COMMAND)
  if path.is_file():
    return str(path)
  raise BridgeError("DeepFilterNet command not found. Install deep-filter or set DEEP_FILTER_COMMAND.", status=503)


def run_deep_filter(input_path: Path, mode: str) -> Path:
  normalized = mode.strip().lower()
  if normalized not in {"light", "strong"}:
    raise BridgeError(f"unsupported DeepFilterNet mode: {mode}", status=400)
  output_dir = AUDIO_PROCESS_DIR / f"df-{uuid.uuid4().hex}"
  output_dir.mkdir(parents=True, exist_ok=True)
  command = [deep_filter_command_path(), "-D", "-o", str(output_dir)]
  if normalized == "light":
    command.extend(["--atten-lim-db", "12"])
  else:
    command.extend(["--pf", "--pf-beta", "0.05", "--atten-lim-db", "100"])
  command.append(str(input_path))
  completed = subprocess.run(command, capture_output=True, text=True, timeout=180)
  candidates = [
    path
    for path in output_dir.glob("*.wav")
    if path.is_file() and path.stat().st_size > 44
  ]
  if completed.returncode != 0 or not candidates:
    detail = (completed.stderr or completed.stdout or "").strip()
    raise BridgeError(detail or "DeepFilterNet processing failed", status=503)
  return sorted(candidates, key=lambda path: path.stat().st_mtime, reverse=True)[0]


def synthesize_with_local_engine(
  *,
  text: str,
  response_format: str,
  speed: float,
  pitch: float,
  irodori: dict[str, Any],
  caption: str,
  reference_path: Path | None = None,
  ref_embed_path: Path | None = None,
  endpoint: str | None = None,
) -> tuple[bytes, str]:
  target_endpoint = (endpoint or LOCAL_ENGINE_ENDPOINT).strip().rstrip("/")
  if not target_endpoint:
    raise BridgeError("local engine endpoint is not configured", status=503)
  request_payload: dict[str, Any] = {
    "text": text,
    "include_audio_base64": False,
  }
  if caption:
    request_payload["caption"] = caption
  if reference_path is not None:
    request_payload["ref_wav"] = str(reference_path)
  if ref_embed_path is not None:
    request_payload["ref_embed"] = str(ref_embed_path)
  for key in (
    "num_steps",
    "cfg_scale_text",
    "cfg_scale_caption",
    "cfg_scale_speaker",
    "seed",
    "t_schedule_mode",
    "sway_coeff",
    "duration_scale",
    "max_seconds",
    "cfg_guidance_mode",
    "seconds",
    "trim_tail",
  ):
    value = irodori.get(key)
    if value not in (None, ""):
      request_payload[key] = value

  request = urllib.request.Request(
    f"{target_endpoint}/synthesize",
    data=json.dumps(request_payload, ensure_ascii=False).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
  )
  try:
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
      body = response.read().decode("utf-8", "replace")
  except Exception as error:
    raise BridgeError(f"local Irodori engine request failed: {error}", status=503) from error
  result = json.loads(body) if body else {}
  if not result.get("ok"):
    raise BridgeError(str(result.get("error") or "local Irodori v3 engine failed"), status=503)
  output_wav = Path(str(result.get("output_wav") or "")).expanduser()
  if not output_wav.is_file():
    raise BridgeError("local Irodori v3 engine did not return an output wav.", status=503)
  final_path, content_type = convert_audio(output_wav, response_format, speed=speed, pitch=pitch)
  audio = final_path.read_bytes()
  delete_transient_file(final_path)
  delete_transient_file(output_wav)
  print(
    "[bridge] generated via local engine "
    f"{len(audio)} bytes endpoint={target_endpoint} "
    f"schedule={irodori.get('t_schedule_mode') or 'default'} "
    f"sway={irodori.get('sway_coeff') if irodori.get('sway_coeff') not in (None, '') else 'default'}"
  )
  return audio, content_type


def checkpoint_args(checkpoint: str) -> list[str]:
  raw = str(checkpoint or "").strip()
  candidate = Path(raw).expanduser()
  if raw.endswith((".pt", ".safetensors")) or candidate.is_file():
    return ["--checkpoint", str(candidate if candidate.is_absolute() else candidate.resolve())]
  return ["--hf-checkpoint", raw]


def synthesize(payload: dict[str, Any]) -> tuple[bytes, str]:
  text = str(payload.get("input") or payload.get("text") or "").strip()
  if not text:
    raise BridgeError("input is empty", status=400)

  model_id = str(payload.get("model") or DEFAULT_MODEL)
  voice = str(payload.get("voice") or "none")
  response_format = str(payload.get("response_format") or payload.get("format") or "wav").lower()
  if response_format not in AUDIO_TYPES:
    raise BridgeError(f"unsupported response_format: {response_format}", status=400)
  speed = bounded_float(payload.get("speed"), 1.0, name="speed", minimum=0.25, maximum=4.0)
  pitch = bounded_float(payload.get("pitch"), 0.0, name="pitch", minimum=-24.0, maximum=24.0)
  irodori = payload.get("irodori") if isinstance(payload.get("irodori"), dict) else {}
  caption = str(irodori.get("caption") or payload.get("caption") or "").strip()
  config = model_config(model_id)
  final_artifact_id = str(irodori.get("final_artifact_id") or irodori.get("ref_embed_id") or "").strip()
  ref_embed_path = find_final_artifact_embedding(final_artifact_id)
  if final_artifact_id and ref_embed_path is None:
    raise BridgeError(f"final artifact not found: {final_artifact_id}", status=400)
  if ref_embed_path is not None and FINAL_ENGINE_ENDPOINT and config.get("runtime") == "final-engine":
    final_probe = probe_local_engine(FINAL_ENGINE_ENDPOINT, timeout=2.0)
    if not final_probe.get("online"):
      raise BridgeError(f"final Nanami engine is not reachable: {FINAL_ENGINE_ENDPOINT}", status=503)
    return synthesize_with_local_engine(
      text=text,
      response_format=response_format,
      speed=speed,
      pitch=pitch,
      irodori=irodori,
      caption="",
      reference_path=None,
      ref_embed_path=ref_embed_path,
      endpoint=FINAL_ENGINE_ENDPOINT,
    )
  if LOCAL_ENGINE_ENDPOINT and config.get("runtime") == "local-engine":
    reference_path = find_reference_voice(voice)
    if voice not in {"", "none"} and reference_path is None:
      raise BridgeError(f"reference voice not found: {voice}", status=400)
    local_probe = probe_local_engine(LOCAL_ENGINE_ENDPOINT, timeout=2.0)
    if not local_probe.get("online"):
      raise BridgeError(f"local Irodori v3 engine is not reachable: {LOCAL_ENGINE_ENDPOINT}", status=503)
    return synthesize_with_local_engine(
      text=text,
      response_format=response_format,
      speed=speed,
      pitch=pitch,
      irodori=irodori,
      caption=caption,
      reference_path=reference_path,
      ref_embed_path=ref_embed_path,
    )

  state = ready_state()
  if not state["ready"]:
    if ref_embed_path is not None and config.get("runtime") == "final-engine" and not FINAL_ENGINE_ENDPOINT:
      raise BridgeError("final engine endpoint is not configured. Start the bridge with Start Bridge Lab Only.command.", status=503)
    if config.get("runtime") == "local-engine" and not LOCAL_ENGINE_ENDPOINT:
      raise BridgeError("local engine endpoint is not configured. Start the bridge with Start Bridge Lab Only.command.", status=503)
    raise BridgeError(state["message"], status=503)

  reference_path = None if ref_embed_path is not None else find_reference_voice(voice)
  if voice not in {"", "none"} and reference_path is None:
    raise BridgeError(f"reference voice not found: {voice}", status=400)
  use_reference = (
    config["mode"] == "reference"
    or (config["mode"] == "auto" and reference_path is not None)
    or (bool(config.get("reference_optional")) and reference_path is not None)
  )

  if use_reference and reference_path is None:
    raise BridgeError("reference voice is required for this model. Upload a reference audio first, or select VoiceDesign.", status=400)

  checkpoint = config.get("clone_checkpoint") if use_reference and config.get("clone_checkpoint") else config["checkpoint"]
  output_path = OUTPUT_DIR / f"{uuid.uuid4().hex}.wav"
  use_lite_runtime = IRODORI_LITE_ENABLED and config.get("runtime") == "lite"
  if use_lite_runtime:
    command = [
      UV_COMMAND,
      "run",
      "python",
      str(IRODORI_LITE_RUNNER),
      "--text",
      text,
      "--output-wav",
      str(output_path),
      "--num-candidates",
      "1",
    ]
    if checkpoint:
      command.extend(["--checkpoint", checkpoint])
    if os.environ.get("IRODORI_LITE_CODEC_INT4", "1").strip().lower() not in {"0", "false", "no", "off"}:
      command.append("--codec-int4")
    if os.environ.get("IRODORI_LITE_PACK_RTN_EXTRAS", "0").strip().lower() in {"1", "true", "yes", "on"}:
      command.append("--pack-rtn-extras")
    duration_donor = os.environ.get("IRODORI_LITE_DURATION_DONOR", "").strip()
    if duration_donor:
      command.extend(["--duration-donor", duration_donor])
  else:
    command = [
      UV_COMMAND,
      "run",
      "python",
      "infer.py",
      "--text",
      text,
      "--output-wav",
      str(output_path),
      "--num-candidates",
      "1",
    ]
    command.extend(checkpoint_args(str(checkpoint)))
  if ref_embed_path is not None:
    command.extend(["--ref-embed", str(ref_embed_path)])
  elif use_reference and reference_path:
    command.extend(["--ref-wav", str(reference_path)])
  else:
    command.append("--no-ref")
  if caption and bool(config.get("caption", config["mode"] == "voice-design")):
    command.extend(["--caption", caption])

  optional_args = [
    ("num_steps", "--num-steps"),
    ("cfg_scale_text", "--cfg-scale-text"),
    ("cfg_scale_caption", "--cfg-scale-caption"),
    ("cfg_scale_speaker", "--cfg-scale-speaker"),
    ("seed", "--seed"),
    ("t_schedule_mode", "--t-schedule-mode"),
    ("sway_coeff", "--sway-coeff"),
    ("duration_scale", "--duration-scale"),
    ("max_seconds", "--max-seconds"),
    ("cfg_guidance_mode", "--cfg-guidance-mode"),
    ("speaker_kv_scale", "--speaker-kv-scale"),
    ("speaker_kv_min_t", "--speaker-kv-min-t"),
    ("speaker_kv_max_layers", "--speaker-kv-max-layers"),
  ]
  for key, flag in optional_args:
    value = irodori.get(key)
    if value not in (None, ""):
      command.extend([flag, str(value)])

  model_device = os.environ.get("IRODORI_MODEL_DEVICE")
  codec_device = os.environ.get("IRODORI_CODEC_DEVICE")
  if model_device:
    command.extend(["--model-device", model_device])
  if codec_device:
    command.extend(["--codec-device", codec_device])

  if not SYNTH_LOCK.acquire(blocking=False):
    raise BridgeError("TTS generation is already running. Please wait and try again.", status=409)
  try:
    started = time.perf_counter()
    completed = subprocess.run(
      command,
      cwd=IRODORI_REPO_DIR,
      capture_output=True,
      text=True,
      timeout=TIMEOUT_SECONDS,
      env={
        **os.environ,
        "UV_CACHE_DIR": str(RUNTIME_DIR / "uv-cache"),
        "HF_HOME": str(RUNTIME_DIR / "huggingface"),
      },
    )
    if completed.returncode != 0:
      detail = (completed.stderr or completed.stdout or "").strip()
      raise BridgeError(detail or f"Irodori exited with code {completed.returncode}", status=503)
    if not output_path.exists():
      raise BridgeError("Irodori did not create an output wav.", status=503)

    final_path, content_type = convert_audio(output_path, response_format, speed=speed, pitch=pitch)
    audio = final_path.read_bytes()
    for path in {output_path, final_path}:
      try:
        path.unlink(missing_ok=True)
      except OSError:
        pass

    print(
      "[bridge] generated "
      f"{len(audio)} bytes in {int((time.perf_counter() - started) * 1000)}ms "
      f"model={model_id} voice={voice} use_reference={use_reference} "
      f"final_artifact={final_artifact_id or '-'} "
      f"schedule={irodori.get('t_schedule_mode') or 'default'} "
      f"sway={irodori.get('sway_coeff') if irodori.get('sway_coeff') not in (None, '') else 'default'}"
    )
    return audio, content_type
  finally:
    SYNTH_LOCK.release()


class Handler(BaseHTTPRequestHandler):
  server_version = "IrodoriOpenAIBridge/0.1"

  def do_OPTIONS(self) -> None:
    self.send_response(204)
    self.add_cors_headers()
    self.end_headers()

  def do_GET(self) -> None:
    parsed_url = urlparse(self.path)
    path = parsed_url.path.rstrip("/")
    if path == "/health":
      self.send_json(ready_state())
      return
    if path == "/v1/models":
      self.send_json({
        "object": "list",
        "data": [
          {
            "id": model_id,
            "object": "model",
            "owned_by": "local",
            "label": config["label"],
            "mode": config["mode"],
          }
          for model_id, config in MODEL_PRESETS.items()
          if IRODORI_LITE_ENABLED or config.get("runtime") != "lite"
        ],
      })
      return
    if path == "/v1/audio/voices":
      self.send_json({"object": "list", "data": list_reference_voices()})
      return
    if path.startswith("/v1/audio/voices/") and path.endswith("/download"):
      voice_id = path.split("/")[-2]
      reference_path = find_reference_voice(voice_id)
      if reference_path is None:
        self.send_json({"error": {"message": "reference voice not found"}}, status=404)
        return
      self.send_file(reference_path, "audio/wav", f"{sanitize_id(voice_id)}.wav")
      return
    if path == "/v1/lab/final-artifacts":
      self.send_json({"object": "list", "data": list_final_artifacts()})
      return
    if path.startswith("/v1/lab/final-artifacts/") and path.endswith("/checkpoint"):
      artifact_id = path.split("/")[-2]
      artifact_path = find_final_artifact_embedding(artifact_id)
      if artifact_path is None:
        self.send_json({"error": {"message": "final artifact not found"}}, status=404)
        return
      self.send_file(artifact_path, "application/octet-stream", SPEAKER_INVERSION_FINAL_NAME)
      return
    if path == "/v1/lab/speaker-inversion/jobs":
      self.send_json({"object": "list", "data": list_speaker_jobs()})
      return
    if path.startswith("/v1/lab/speaker-inversion/jobs/"):
      parts = path.split("/")
      job_id = parts[5] if len(parts) >= 6 else ""
      job = load_speaker_job(job_id)
      if job is None:
        self.send_json({"error": {"message": "speaker inversion job not found"}}, status=404)
        return
      if len(parts) >= 7 and parts[6] == "log":
        self.send_json({"job_id": sanitize_id(job_id), "log": speaker_job_log_tail(job, max_chars=64_000)})
        return
      self.send_json(public_speaker_job(job))
      return
    self.send_json({"error": {"message": "not_found"}}, status=404)

  def do_DELETE(self) -> None:
    parsed_url = urlparse(self.path)
    path = parsed_url.path.rstrip("/")
    if path == "/v1/lab/cache":
      self.send_json(clear_transient_audio_cache())
      return
    if path.startswith("/v1/lab/final-artifacts/"):
      artifact_id = path.rsplit("/", 1)[-1]
      try:
        self.send_json(delete_final_artifact(artifact_id))
      except BridgeError as error:
        self.send_json({"error": {"message": str(error)}}, status=error.status)
      return
    if path == "/v1/lab/session":
      if active_speaker_jobs() and "cancel_training=1" not in parsed_url.query:
        self.send_json({
          "error": {"message": "active speaker inversion job is running. Cancel it explicitly before closing the lab session."},
          "activeJobs": active_speaker_jobs(),
        }, status=409)
        return
      self.send_json(close_lab_session())
      return
    if path.startswith("/v1/lab/speaker-inversion/jobs/"):
      job_id = path.rsplit("/", 1)[-1]
      try:
        self.send_json(public_speaker_job(cancel_speaker_job(job_id)))
      except BridgeError as error:
        self.send_json({"error": {"message": str(error)}}, status=error.status)
      return
    if path.startswith("/v1/audio/voices/"):
      voice_id = path.rsplit("/", 1)[-1]
      deleted = delete_reference_voice(voice_id)
      self.send_json({"voice_id": sanitize_id(voice_id), "deleted": deleted})
      return
    self.send_json({"error": {"message": "not_found"}}, status=404)

  def do_POST(self) -> None:
    path = urlparse(self.path).path.rstrip("/")
    try:
      if path == "/v1/audio/speech":
        audio, content_type = synthesize(self.read_json())
        self.send_audio(audio, content_type)
        return
      if path == "/v1/speak":
        payload = self.read_json()
        audio, content_type = synthesize({
          "model": payload.get("model") or DEFAULT_MODEL,
          "input": payload.get("text") or payload.get("rawText") or payload.get("input") or "",
          "voice": payload.get("voice") or "none",
          "response_format": "wav",
          "irodori": payload.get("irodori") if isinstance(payload.get("irodori"), dict) else {},
        })
        self.send_audio(audio, content_type)
        return
      if path == "/v1/audio/voices":
        self.handle_voice_upload()
        return
      if path == "/v1/voice-presets/nanami-standard":
        self.handle_nanami_standard_voice_preset()
        return
      if path == "/v1/lab/script":
        self.send_json(generate_script_line(self.read_json()))
        return
      if path == "/v1/lab/audio/process":
        self.handle_audio_process()
        return
      if path == "/v1/lab/speaker-inversion/jobs":
        self.handle_speaker_inversion_job_create()
        return
      self.send_json({"error": {"message": "not_found"}}, status=404)
    except BridgeError as error:
      self.send_json({"error": {"message": str(error)}}, status=error.status)
    except subprocess.TimeoutExpired:
      self.send_json({"error": {"message": f"Irodori timed out after {TIMEOUT_SECONDS}s"}}, status=504)
    except Exception as error:
      self.send_json({"error": {"message": str(error)}}, status=500)

  def read_json(self) -> dict[str, Any]:
    length = int(self.headers.get("Content-Length", "0"))
    body = self.rfile.read(length).decode("utf-8") if length else "{}"
    parsed = json.loads(body or "{}")
    if not isinstance(parsed, dict):
      raise BridgeError("JSON object is required", status=400)
    return parsed

  def handle_voice_upload(self) -> None:
    length = int(self.headers.get("Content-Length", "0"))
    content_type = self.headers.get("Content-Type", "")
    body = self.rfile.read(length)
    message = BytesParser(policy=policy.default).parsebytes(
      b"Content-Type: " + content_type.encode("utf-8") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    fields: dict[str, str] = {}
    file_payload: bytes | None = None
    filename = ""
    for part in message.iter_parts():
      name = part.get_param("name", header="content-disposition")
      if not name:
        continue
      if name == "file":
        file_payload = part.get_payload(decode=True)
        filename = part.get_filename() or ""
      else:
        fields[name] = part.get_content().strip()

    voice_id = sanitize_id(str(fields.get("voice_id") or fields.get("voiceId") or "voice"))
    if not file_payload:
      raise BridgeError("file is required", status=400)
    filename = sanitize_id(filename or f"{voice_id}.wav")
    upload_path = REFERENCE_DIR / f"_upload-{uuid.uuid4().hex}{Path(filename).suffix or '.audio'}"
    target = REFERENCE_DIR / f"{voice_id}.wav"
    for old_path in REFERENCE_DIR.glob(f"{voice_id}.*"):
      try:
        old_path.unlink()
      except OSError:
        pass
    with upload_path.open("wb") as output:
      output.write(file_payload)
    try:
      convert_reference_to_wav(upload_path, target)
    finally:
      try:
        upload_path.unlink(missing_ok=True)
      except OSError:
        pass
    self.send_json({
      "voice_id": voice_id,
      "path": str(target),
      "message": "reference voice uploaded",
    })

  def read_multipart(self, max_bytes: int = SPEAKER_UPLOAD_MAX_BYTES) -> tuple[dict[str, list[str]], list[dict[str, Any]]]:
    length = int(self.headers.get("Content-Length", "0"))
    if length <= 0:
      raise BridgeError("multipart body is required", status=400)
    if length > max_bytes:
      raise BridgeError(f"upload is too large: {length} bytes", status=413)
    content_type = self.headers.get("Content-Type", "")
    body = self.rfile.read(length)
    message = BytesParser(policy=policy.default).parsebytes(
      b"Content-Type: " + content_type.encode("utf-8") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    fields: dict[str, list[str]] = {}
    files: list[dict[str, Any]] = []
    for part in message.iter_parts():
      name = part.get_param("name", header="content-disposition")
      if not name:
        continue
      filename = part.get_filename()
      if filename:
        payload = part.get_payload(decode=True) or b""
        files.append({
          "field": name,
          "filename": filename,
          "content_type": part.get_content_type() or "application/octet-stream",
          "payload": payload,
        })
      else:
        payload = part.get_payload(decode=True)
        if payload is not None:
          charset = part.get_content_charset() or "utf-8"
          value = payload.decode(charset, errors="replace")
        else:
          value = part.get_content()
        fields.setdefault(name, []).append(str(value).strip())
    return fields, files

  def handle_audio_process(self) -> None:
    fields, files = self.read_multipart(max_bytes=64 * 1024 * 1024)
    audio_files = [item for item in files if item["field"] in {"file", "audio"}]
    if not audio_files:
      raise BridgeError("audio file is required", status=400)
    upload = audio_files[0]
    payload = upload["payload"]
    if not payload:
      raise BridgeError("audio file is empty", status=400)
    source_name = sanitize_id(upload["filename"] or "audio.wav")
    suffix = Path(source_name).suffix or ".audio"
    upload_path = AUDIO_PROCESS_DIR / f"_upload-{uuid.uuid4().hex}{suffix}"
    input_wav = AUDIO_PROCESS_DIR / f"input-{uuid.uuid4().hex}.wav"
    processed_path = input_wav
    deep_filtered_path: Path | None = None
    upload_path.write_bytes(payload)
    try:
      convert_reference_to_wav(upload_path, input_wav)
      mode = str((fields.get("deep_filter_mode") or fields.get("mode") or ["off"])[0] or "off").strip().lower()
      if mode not in {"off", "light", "strong"}:
        raise BridgeError(f"unsupported audio process mode: {mode}", status=400)
      if mode != "off":
        processed_path = run_deep_filter(input_wav, mode)
        deep_filtered_path = processed_path
      audio = processed_path.read_bytes()
      self.send_audio(audio, AUDIO_TYPES["wav"])
    finally:
      for path in {upload_path, input_wav}:
        try:
          path.unlink(missing_ok=True)
        except OSError:
          pass
      if deep_filtered_path is not None:
        try:
          shutil.rmtree(deep_filtered_path.parent, ignore_errors=True)
        except OSError:
          pass

  def handle_speaker_inversion_job_create(self) -> None:
    active_jobs = active_speaker_jobs()
    if active_jobs:
      self.send_json({
        "error": {"message": "another speaker inversion job is already running"},
        "activeJobs": active_jobs,
      }, status=409)
      return

    ready = speaker_inversion_ready_state()
    if not ready["ready"]:
      self.send_json({"error": {"message": " / ".join(ready["problems"])}, "speakerInversion": ready}, status=503)
      return

    fields, files = self.read_multipart()
    audio_files = [item for item in files if item["field"].startswith("audio") or item["field"].startswith("file")]
    if not audio_files:
      raise BridgeError("accepted wav files are required", status=400)
    if len(audio_files) > SPEAKER_UPLOAD_MAX_CLIPS:
      raise BridgeError(f"too many clips: {len(audio_files)}", status=400)

    raw_items = fields.get("items", ["[]"])[0]
    try:
      items = json.loads(raw_items)
    except json.JSONDecodeError as error:
      raise BridgeError(f"items JSON is invalid: {error}", status=400) from error
    if not isinstance(items, list):
      raise BridgeError("items JSON must be an array", status=400)
    items_by_field = {
      str(item.get("field") or ""): item
      for item in items
      if isinstance(item, dict) and str(item.get("field") or "")
    }
    items_by_filename = {
      str(item.get("filename") or ""): item
      for item in items
      if isinstance(item, dict) and str(item.get("filename") or "")
    }

    mode = str((fields.get("mode") or ["production"])[0] or "production").strip().lower()
    smoke = parse_bool((fields.get("smoke") or [""])[0], False) or mode == "smoke"
    dry_run = parse_bool((fields.get("dry_run") or [""])[0], False)
    max_steps_raw = (fields.get("max_steps") or [""])[0]
    if smoke:
      max_steps = 1
    elif max_steps_raw:
      try:
        max_steps = max(1, min(20_000, int(max_steps_raw)))
      except ValueError:
        raise BridgeError("max_steps must be an integer", status=400) from None
    elif mode == "standard":
      max_steps = 800
    else:
      max_steps = 3000

    artifact_id = sanitize_id((fields.get("artifact_id") or [f"speaker-{uuid.uuid4().hex[:12]}"])[0])
    if find_final_artifact_embedding(artifact_id) is not None or (GENERATED_FINAL_DIR / artifact_id).exists():
      raise BridgeError(f"final artifact already exists: {artifact_id}", status=409)
    display_name = str((fields.get("display_name") or [artifact_id])[0]).strip() or artifact_id
    description = str((fields.get("description") or ["NANAMI VOICE LABOで作成したSpeaker Inversion成果物です。"])[0]).strip()
    device = str((fields.get("device") or [default_speaker_train_device()])[0]).strip() or default_speaker_train_device()

    job_id = f"si-{uuid.uuid4().hex[:16]}"
    job_dir = speaker_job_path(job_id)
    audio_dir = job_dir / "audio"
    latent_dir = job_dir / "latents"
    train_output_dir = job_dir / "train"
    for directory in (audio_dir, latent_dir, train_output_dir):
      directory.mkdir(parents=True, exist_ok=True)

    dataset_rows = []
    staged_items = []
    for index, upload in enumerate(audio_files):
      payload = upload["payload"]
      if not payload:
        raise BridgeError(f"audio file is empty: {upload['filename']}", status=400)
      if len(payload) > SPEAKER_UPLOAD_MAX_FILE_BYTES:
        raise BridgeError(f"audio file is too large: {upload['filename']}", status=413)
      source_name = str(upload["filename"])
      if Path(source_name).suffix.lower() != ".wav" and upload["content_type"] not in {"audio/wav", "audio/x-wav"}:
        raise BridgeError(f"wav only for speaker inversion material: {source_name}", status=400)
      item = items_by_field.get(str(upload["field"])) or items_by_filename.get(source_name) or (items[index] if index < len(items) and isinstance(items[index], dict) else {})
      text = str(item.get("text") or "").strip()
      if not text:
        raise BridgeError(f"text is required for uploaded audio #{index + 1}", status=400)
      caption = str(item.get("caption") or "").strip()
      category = str(item.get("category") or "").strip()
      target = audio_dir / f"{index + 1:06d}.wav"
      target.write_bytes(payload)
      sample_rate = probe_audio_sample_rate(target)
      if sample_rate is not None and sample_rate < 8000:
        raise BridgeError(f"sample rate is too low for {source_name}: {sample_rate}", status=400)
      row = {"audio": str(target), "text": text, "caption": caption}
      dataset_rows.append(row)
      staged_items.append({
        "order": index + 1,
        "field": upload["field"],
        "filename": source_name,
        "staged_wav": str(target),
        "bytes": len(payload),
        "sample_rate": sample_rate,
        "text": text,
        "caption": caption,
        "category": category,
      })

    if len(dataset_rows) < 2:
      raise BridgeError("at least two accepted wav clips are required", status=400)

    dataset_path = job_dir / "source_dataset.jsonl"
    with dataset_path.open("w", encoding="utf-8") as output:
      for row in dataset_rows:
        output.write(json.dumps(row, ensure_ascii=False) + "\n")
    manifest_json = {}
    raw_manifest = (fields.get("manifest") or ["{}"])[0]
    try:
      manifest_json = json.loads(raw_manifest)
    except json.JSONDecodeError:
      manifest_json = {}
    write_json_atomic(job_dir / "source_manifest.json", manifest_json if isinstance(manifest_json, dict) else {})

    now = utc_now()
    job = {
      "job_id": job_id,
      "artifact_id": artifact_id,
      "display_name": display_name,
      "description": description,
      "mode": mode,
      "smoke": smoke,
      "dry_run": dry_run,
      "status": "dry_run" if dry_run else "queued",
      "phase": "dry_run" if dry_run else "queued",
      "created_at": now,
      "updated_at": now,
      "sample_count": len(dataset_rows),
      "max_steps": max_steps,
      "device": device,
      "precision": "fp32",
      "batch_size": 1,
      "num_workers": 0,
      "base_checkpoint": SPEAKER_INVERSION_BASE_CHECKPOINT,
      "job_dir": str(job_dir),
      "dataset_path": str(dataset_path),
      "prepared_manifest_path": str(job_dir / "prepared_manifest.jsonl"),
      "latent_dir": str(latent_dir),
      "train_output_dir": str(train_output_dir),
      "log_path": str(job_dir / "job.log"),
      "final_artifact_dir": str(GENERATED_FINAL_DIR / artifact_id),
      "source_items": staged_items,
      "error": "",
      "pid": None,
    }
    with SPEAKER_JOB_LOCK:
      late_active_jobs = active_speaker_jobs()
      if late_active_jobs:
        shutil.rmtree(job_dir, ignore_errors=True)
        self.send_json({
          "error": {"message": "another speaker inversion job is already running"},
          "activeJobs": late_active_jobs,
        }, status=409)
        return
      if find_final_artifact_embedding(artifact_id) is not None or (GENERATED_FINAL_DIR / artifact_id).exists():
        shutil.rmtree(job_dir, ignore_errors=True)
        raise BridgeError(f"final artifact already exists: {artifact_id}", status=409)
      save_speaker_job(job)
      append_speaker_job_log(job, f"Created Speaker Inversion job with {len(dataset_rows)} clips. mode={mode} max_steps={max_steps} dry_run={dry_run}")
    if not dry_run:
      thread = threading.Thread(target=run_speaker_inversion_job, args=(job_id,), daemon=True)
      thread.start()
      self.send_json(public_speaker_job(load_speaker_job(job_id) or job), status=202)
      return
    self.send_json(public_speaker_job(job), status=201)

  def handle_nanami_standard_voice_preset(self) -> None:
    length = int(self.headers.get("Content-Length", "0"))
    content_type = self.headers.get("Content-Type", "")
    body = self.rfile.read(length)
    message = BytesParser(policy=policy.default).parsebytes(
      b"Content-Type: " + content_type.encode("utf-8") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    fields: dict[str, str] = {}
    audio_payload: bytes | None = None
    audio_filename = "nanami_voice_sample.wav"
    audio_content_type = "audio/wav"
    for part in message.iter_parts():
      name = part.get_param("name", header="content-disposition")
      if not name:
        continue
      if name == "audio":
        audio_payload = part.get_payload(decode=True)
        audio_filename = sanitize_id(part.get_filename() or audio_filename)
        audio_content_type = part.get_content_type() or audio_content_type
      else:
        fields[name] = part.get_content().strip()

    if not audio_payload:
      raise BridgeError("audio is required", status=400)
    raw_card = fields.get("card") or "{}"
    try:
      card = json.loads(raw_card)
    except json.JSONDecodeError as error:
      raise BridgeError(f"card JSON is invalid: {error}", status=400) from error
    if not isinstance(card, dict):
      raise BridgeError("card JSON object is required", status=400)

    format_name = str(card.get("format") or Path(audio_filename).suffix.lstrip(".") or "wav").lower()
    if format_name not in AUDIO_TYPES:
      format_name = "wav"
    sample_filename = f"nanami_voice_sample.{format_name}"
    preset_filename = "nanami_voice_preset.json"
    manifest_filename = "nanami_voice_manifest.json"
    sample_path = NANAMI_VOICE_PRESET_DIR / sample_filename
    preset_path = NANAMI_VOICE_PRESET_DIR / preset_filename
    manifest_path = NANAMI_VOICE_PRESET_DIR / manifest_filename

    with sample_path.open("wb") as output:
      output.write(audio_payload)

    exported_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    preset = {
      "schema_version": 1,
      "preset_id": "nanami_standard_voice",
      "label": "ななみ標準声",
      "exported_at": exported_at,
      "source": "nanami-voice-labo",
      "audio": {
        "filename": sample_filename,
        "content_type": audio_content_type,
        "bytes": len(audio_payload),
      },
      "card": card,
    }
    with preset_path.open("w", encoding="utf-8") as output:
      json.dump(preset, output, ensure_ascii=False, indent=2)
      output.write("\n")

    manifest = {
      "schema_version": 1,
      "active_preset": preset_filename,
      "active_audio": sample_filename,
      "updated_at": exported_at,
      "directory": str(NANAMI_VOICE_PRESET_DIR),
    }
    with manifest_path.open("w", encoding="utf-8") as output:
      json.dump(manifest, output, ensure_ascii=False, indent=2)
      output.write("\n")

    self.send_json({
      "message": "nanami standard voice preset saved",
      "directory": str(NANAMI_VOICE_PRESET_DIR),
      "preset_path": str(preset_path),
      "audio_path": str(sample_path),
      "manifest_path": str(manifest_path),
    })

  def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.add_cors_headers()
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def send_audio(self, audio: bytes, content_type: str) -> None:
    self.send_response(200)
    self.add_cors_headers()
    self.send_header("Content-Type", content_type)
    self.send_header("Cache-Control", "no-store")
    self.send_header("Content-Length", str(len(audio)))
    self.end_headers()
    self.wfile.write(audio)

  def send_file(self, path: Path, content_type: str, filename: str) -> None:
    data = path.read_bytes()
    self.send_response(200)
    self.add_cors_headers()
    self.send_header("Content-Type", content_type)
    self.send_header("Cache-Control", "no-store")
    self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
    self.send_header("Content-Length", str(len(data)))
    self.end_headers()
    self.wfile.write(data)

  def add_cors_headers(self) -> None:
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    self.send_header("Access-Control-Expose-Headers", "Content-Disposition")

  def log_message(self, fmt: str, *args: Any) -> None:
    print(f"[bridge] {self.address_string()} - {fmt % args}")


def main() -> None:
  ensure_dirs()
  server = ThreadingHTTPServer((HOST, PORT), Handler)
  print(f"NANAMI VOICE LABO bridge: http://{HOST}:{PORT}/v1")
  print(f"health: http://{HOST}:{PORT}/health")
  print(f"repo: {IRODORI_REPO_DIR}")
  server.serve_forever()


if __name__ == "__main__":
  main()
