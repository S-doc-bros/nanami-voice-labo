#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import gc
import json
import mimetypes
import os
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


WORK_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = WORK_DIR / "config" / "nanami_v1_engine_recommended.json"
DEFAULT_OUTPUT_DIR = WORK_DIR / "outputs" / "local_engine_server"
DEFAULT_IRODORI_REPO = WORK_DIR / "third_party" / "Irodori-TTS"


@dataclass(frozen=True)
class EngineConfig:
    base_checkpoint: str
    ref_embed: Path | None
    work_dir: Path
    model_device: str
    codec_device: str
    num_steps: int
    cfg_guidance_mode: str
    cfg_scale_text: float
    cfg_scale_caption: float
    cfg_scale_speaker: float
    duration_scale: float
    trim_tail: bool
    t_schedule_mode: str
    sway_coeff: float
    context_kv_cache: bool


def resolve_work_path(raw_path: str, work_dir: Path = WORK_DIR) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = work_dir / path
    return path.resolve()


def resolve_checkpoint_path(base_checkpoint: str, work_dir: Path = WORK_DIR) -> str:
    raw_env_checkpoint = os.environ.get("LIFEMATE_NANAMI_IRODORI_CHECKPOINT")
    if raw_env_checkpoint:
        env_checkpoint = Path(raw_env_checkpoint).expanduser()
        if env_checkpoint.is_file():
            return str(env_checkpoint.resolve())

    raw = str(base_checkpoint).strip()
    if raw.endswith(".safetensors") or raw.startswith(("/", "./", "../", "~")):
        candidate = Path(raw).expanduser()
        if not candidate.is_absolute():
            candidate = work_dir / candidate
        if candidate.is_file():
            return str(candidate.resolve())

    repo_leaf = raw.rstrip("/").split("/")[-1] or "Irodori-TTS-500M-v3"
    for candidate in (
        work_dir / "models" / repo_leaf / "model.safetensors",
        work_dir / "models" / raw / "model.safetensors",
    ):
        if candidate.is_file():
            return str(candidate.resolve())

    return raw


def load_engine_config(path: str | Path = DEFAULT_CONFIG) -> EngineConfig:
    config_path = Path(path).expanduser().resolve()
    data = json.loads(config_path.read_text(encoding="utf-8"))
    route = data["route"]
    inference = data["inference"]
    ref_embed = None
    if route.get("ref_embed") not in {None, ""}:
        ref_embed = resolve_work_path(str(route["ref_embed"]), config_path.parent.parent)
        if not ref_embed.is_file():
            raise FileNotFoundError(f"missing ref_embed: {ref_embed}")
    return EngineConfig(
        base_checkpoint=str(route["base_checkpoint"]),
        ref_embed=ref_embed,
        work_dir=config_path.parent.parent,
        model_device=str(inference.get("model_device", "mps")),
        codec_device=str(inference.get("codec_device", "mps")),
        num_steps=int(inference.get("num_steps", 8)),
        cfg_guidance_mode=str(inference.get("cfg_guidance_mode", "joint")),
        cfg_scale_text=float(inference.get("cfg_scale_text", 4.0)),
        cfg_scale_caption=float(inference.get("cfg_scale_caption", 4.0)),
        cfg_scale_speaker=float(inference.get("cfg_scale_speaker", 4.0)),
        duration_scale=float(inference.get("duration_scale", 1.05)),
        trim_tail=bool(inference.get("trim_tail", False)),
        t_schedule_mode=str(inference.get("t_schedule_mode", "sway")),
        sway_coeff=float(inference.get("sway_coeff", -1.0)),
        context_kv_cache=bool(inference.get("context_kv_cache", True)),
    )


def _optional_float(body: dict[str, Any], key: str, default: float | None = None) -> float | None:
    if key not in body or body[key] is None or body[key] == "":
        return default
    return float(body[key])


def _optional_int(body: dict[str, Any], key: str, default: int | None = None) -> int | None:
    if key not in body or body[key] is None or body[key] == "":
        return default
    return int(body[key])


def _optional_bool(body: dict[str, Any], key: str, default: bool) -> bool:
    if key not in body or body[key] is None:
        return default
    value = body[key]
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def build_sampling_payload(body: dict[str, Any], config: EngineConfig) -> dict[str, Any]:
    text = str(body.get("text", "")).strip()
    if not text:
        raise ValueError("text is required")
    num_steps = _optional_int(body, "num_steps", config.num_steps)
    if num_steps is None or num_steps <= 0:
        raise ValueError("num_steps must be > 0")
    duration_scale = _optional_float(body, "duration_scale", config.duration_scale)
    if duration_scale is None or duration_scale <= 0:
        raise ValueError("duration_scale must be > 0")
    seed = _optional_int(body, "seed", None)
    ref_wav = None
    if body.get("ref_wav") not in {None, ""}:
        ref_wav_path = Path(str(body.get("ref_wav"))).expanduser().resolve()
        if not ref_wav_path.is_file():
            raise ValueError(f"ref_wav not found: {ref_wav_path}")
        ref_wav = str(ref_wav_path)
    ref_embed = None
    if body.get("ref_embed") not in {None, ""}:
        ref_embed_path = Path(str(body.get("ref_embed"))).expanduser().resolve()
        if not ref_embed_path.is_file():
            raise ValueError(f"ref_embed not found: {ref_embed_path}")
        ref_embed = str(ref_embed_path)
    no_ref = ref_wav is None and ref_embed is None
    cfg_scale_speaker = 0.0 if no_ref else _optional_float(
        body,
        "cfg_scale_speaker",
        config.cfg_scale_speaker,
    )
    return {
        "text": text,
        "caption": None if body.get("caption") in {None, ""} else str(body.get("caption")),
        "ref_wav": ref_wav,
        "ref_embed": ref_embed,
        "no_ref": no_ref,
        "num_candidates": 1,
        "decode_mode": str(body.get("decode_mode", "sequential")),
        "seconds": _optional_float(body, "seconds", None),
        "max_seconds": _optional_float(body, "max_seconds", 45.0),
        "duration_scale": duration_scale,
        "num_steps": num_steps,
        "cfg_scale_text": _optional_float(body, "cfg_scale_text", config.cfg_scale_text),
        "cfg_scale_caption": _optional_float(body, "cfg_scale_caption", config.cfg_scale_caption),
        "cfg_scale_speaker": cfg_scale_speaker,
        "cfg_guidance_mode": str(body.get("cfg_guidance_mode", config.cfg_guidance_mode)),
        "cfg_scale": None,
        "cfg_min_t": _optional_float(body, "cfg_min_t", 0.5),
        "cfg_max_t": _optional_float(body, "cfg_max_t", 1.0),
        "context_kv_cache": _optional_bool(body, "context_kv_cache", config.context_kv_cache),
        "ref_normalize_db": _optional_float(body, "ref_normalize_db", -16.0),
        "max_ref_seconds": _optional_float(body, "max_ref_seconds", 30.0),
        "seed": seed,
        "t_schedule_mode": str(body.get("t_schedule_mode", config.t_schedule_mode)),
        "sway_coeff": _optional_float(body, "sway_coeff", config.sway_coeff),
        "trim_tail": _optional_bool(body, "trim_tail", config.trim_tail),
        "lora_adapter": None,
    }


def sampling_route(payload: dict[str, Any]) -> str:
    if payload.get("ref_wav"):
        return "ref_wav"
    if payload.get("ref_embed"):
        return "ref_embed"
    return "no_ref"


def safe_output_name() -> str:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    return f"nanami_{stamp}.wav"


def stage_timings_to_json(stage_timings: list[tuple[str, float]]) -> list[dict[str, float | str]]:
    return [{"stage": name, "seconds": seconds} for name, seconds in stage_timings]


class NanamiEngine:
    def __init__(
        self,
        *,
        config: EngineConfig,
        output_dir: Path,
        irodori_repo: Path,
    ) -> None:
        self.config = config
        self.output_dir = output_dir
        self.irodori_repo = irodori_repo
        self.runtime = None
        self._sampling_request_cls = None
        self._save_wav = None
        self._synthesize_lock = threading.Lock()

    def load(self) -> bool:
        if self.runtime is not None:
            return False
        if not (self.irodori_repo / "irodori_tts").is_dir():
            raise FileNotFoundError(f"missing Irodori repo: {self.irodori_repo}")
        sys.path.insert(0, str(self.irodori_repo))
        from huggingface_hub import hf_hub_download
        from irodori_tts.inference_runtime import (
            InferenceRuntime,
            RuntimeKey,
            SamplingRequest,
            save_wav,
        )

        checkpoint_path = resolve_checkpoint_path(self.config.base_checkpoint, self.config.work_dir)
        if not Path(checkpoint_path).is_file():
            checkpoint_path = hf_hub_download(
                repo_id=checkpoint_path,
                filename="model.safetensors",
            )
        model_device = self.config.model_device
        codec_device = self.config.codec_device
        if model_device == "mps" or codec_device == "mps":
            import torch

            if not torch.backends.mps.is_available():
                print("[engine] MPS unavailable; falling back to CPU runtime.", flush=True)
                if model_device == "mps":
                    model_device = "cpu"
                if codec_device == "mps":
                    codec_device = "cpu"
        runtime_key = RuntimeKey(
            checkpoint=checkpoint_path,
            model_device=model_device,
            codec_device=codec_device,
        )
        self.runtime = InferenceRuntime.from_key(runtime_key)
        self._sampling_request_cls = SamplingRequest
        self._save_wav = save_wav
        return True

    def _release_device_cache(self) -> None:
        # PyTorch MPS keeps freed synthesis buffers in its allocator pool.
        # Release per-request work buffers so the shared voice engine returns
        # near its model-resident footprint after each utterance.
        gc.collect()
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            mps = getattr(torch, "mps", None)
            if mps is not None and hasattr(mps, "empty_cache"):
                mps.empty_cache()
        except Exception:
            pass

    def unload(self) -> bool:
        with self._synthesize_lock:
            was_loaded = self.runtime is not None
            self.runtime = None
            self._sampling_request_cls = None
            self._save_wav = None
            self._release_device_cache()
            return was_loaded

    def model_status(self) -> dict[str, Any]:
        model_cfg = getattr(self.runtime, "model_cfg", None) if self.runtime is not None else None
        return {
            "base_checkpoint": self.config.base_checkpoint,
            "loaded": self.runtime is not None,
            "use_caption_condition": (
                None if model_cfg is None else bool(getattr(model_cfg, "use_caption_condition", False))
            ),
            "use_speaker_condition": (
                None if model_cfg is None else bool(getattr(model_cfg, "use_speaker_condition", False))
            ),
        }

    def synthesize(self, body: dict[str, Any]) -> dict[str, Any]:
        with self._synthesize_lock:
            self.load()
            assert self.runtime is not None
            assert self._sampling_request_cls is not None
            assert self._save_wav is not None
            payload = build_sampling_payload(body, self.config)
            output_path = self.output_dir / "generated" / safe_output_name()
            started = time.perf_counter()
            try:
                result = self.runtime.synthesize(self._sampling_request_cls(**payload))
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                saved = self._save_wav(output_path, result.audio, result.sample_rate)
                warmup_only = _optional_bool(body, "warmup", False)
                if warmup_only:
                    try:
                        Path(saved).unlink(missing_ok=True)
                    except Exception as exc:
                        print(f"[engine] warmup cleanup skipped: {exc}", flush=True)
                    return {
                        "ok": True,
                        "warmup": True,
                        "text": payload["text"],
                        "sample_rate": result.sample_rate,
                        "used_seed": result.used_seed,
                        "elapsed_ms": elapsed_ms,
                        "total_to_decode_sec": result.total_to_decode,
                        "stage_timings": stage_timings_to_json(result.stage_timings),
                        "messages": result.messages,
                        "settings": {
                            "route": sampling_route(payload),
                            "num_steps": payload["num_steps"],
                            "duration_scale": payload["duration_scale"],
                            "cfg_scale_speaker": payload["cfg_scale_speaker"],
                            "trim_tail": payload["trim_tail"],
                            "seconds": payload["seconds"],
                            "max_seconds": payload["max_seconds"],
                            "warmup": True,
                        },
                    }
                response = {
                    "ok": True,
                    "text": payload["text"],
                    "output_wav": str(saved),
                    "audio_url": f"/audio/{saved.name}",
                    "audio_mime": "audio/wav",
                    "sample_rate": result.sample_rate,
                    "used_seed": result.used_seed,
                    "elapsed_ms": elapsed_ms,
                    "total_to_decode_sec": result.total_to_decode,
                    "stage_timings": stage_timings_to_json(result.stage_timings),
                    "messages": result.messages,
                    "settings": {
                        "route": sampling_route(payload),
                        "num_steps": payload["num_steps"],
                        "duration_scale": payload["duration_scale"],
                        "cfg_scale_speaker": payload["cfg_scale_speaker"],
                        "trim_tail": payload["trim_tail"],
                        "seconds": payload["seconds"],
                        "max_seconds": payload["max_seconds"],
                    },
                }
                if _optional_bool(body, "include_audio_base64", True):
                    response["audio_base64"] = base64.b64encode(saved.read_bytes()).decode("ascii")
                return response
            finally:
                self._release_device_cache()


INDEX_HTML = """<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nanami Local Engine</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif; background: #f4faf8; color: #1f2a2e; }
    main { width: min(900px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { color: #66767d; line-height: 1.6; }
    section { background: #fff; border: 1px solid #cfdde1; border-radius: 8px; padding: 16px; margin-top: 16px; }
    textarea { width: 100%; min-height: 110px; resize: vertical; padding: 12px; font: inherit; border: 1px solid #cfdde1; border-radius: 8px; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; }
    label { display: flex; gap: 6px; align-items: center; color: #66767d; font-size: 13px; }
    input { width: 84px; padding: 8px; border: 1px solid #cfdde1; border-radius: 8px; font: inherit; }
    button { border: 0; border-radius: 8px; background: #007d78; color: #fff; padding: 10px 14px; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    audio { width: 100%; margin-top: 12px; }
    pre { overflow: auto; background: #f7faf9; border: 1px solid #dce8ea; border-radius: 8px; padding: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>Nanami Local Engine</h1>
    <p>ref-embed V1 / 8 steps / duration_scale 1.05 / trim_tail off</p>
    <section>
      <textarea id="text">今日の流れを一緒に確認しますね。</textarea>
      <div class="row">
        <label>duration_scale <input id="durationScale" type="number" step="0.01" value="1.05"></label>
        <label>seconds <input id="seconds" type="number" step="0.1" placeholder="auto"></label>
        <label>seed <input id="seed" type="number" placeholder="random"></label>
        <button id="synthesize">生成</button>
      </div>
      <audio id="audio" controls></audio>
    </section>
    <section>
      <pre id="log">ready</pre>
    </section>
  </main>
  <script>
    const button = document.getElementById("synthesize");
    const log = document.getElementById("log");
    const audio = document.getElementById("audio");
    button.addEventListener("click", async () => {
      button.disabled = true;
      log.textContent = "generating...";
      try {
        const body = {
          text: document.getElementById("text").value,
          duration_scale: Number(document.getElementById("durationScale").value || 1.05),
        };
        const seconds = document.getElementById("seconds").value;
        const seed = document.getElementById("seed").value;
        if (seconds) body.seconds = Number(seconds);
        if (seed) body.seed = Number(seed);
        const res = await fetch("/synthesize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || res.statusText);
        audio.src = json.audio_url + "?t=" + Date.now();
        audio.play();
        log.textContent = JSON.stringify(json, null, 2);
      } catch (error) {
        log.textContent = String(error);
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>
"""


class NanamiHandler(BaseHTTPRequestHandler):
    engine: NanamiEngine

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_bytes(HTTPStatus.OK, INDEX_HTML.encode("utf-8"), "text/html; charset=utf-8")
            return
        if parsed.path == "/health":
            self._send_json(HTTPStatus.OK, {"ok": True, **self.engine.model_status()})
            return
        if parsed.path == "/config":
            cfg = self.engine.config
            self._send_json(
                HTTPStatus.OK,
                {
                    "base_checkpoint": cfg.base_checkpoint,
                    "ref_embed": None if cfg.ref_embed is None else str(cfg.ref_embed),
                    **self.engine.model_status(),
                    "num_steps": cfg.num_steps,
                    "duration_scale": cfg.duration_scale,
                    "trim_tail": cfg.trim_tail,
                },
            )
            return
        if parsed.path.startswith("/audio/"):
            name = Path(unquote(parsed.path.removeprefix("/audio/"))).name
            audio_path = self.engine.output_dir / "generated" / name
            if not audio_path.is_file():
                self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "audio not found"})
                return
            content_type = mimetypes.guess_type(str(audio_path))[0] or "audio/wav"
            self._send_bytes(HTTPStatus.OK, audio_path.read_bytes(), content_type)
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/synthesize":
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}
            response = self.engine.synthesize(body)
            self._send_json(HTTPStatus.OK, response)
        except Exception as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/model":
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        try:
            unloaded = self.engine.unload()
            self._send_json(
                HTTPStatus.OK,
                {"ok": True, "unloaded": unloaded, "loaded": self.engine.runtime is not None},
            )
        except Exception as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[http] {self.address_string()} - {format % args}")


class NanamiThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False
    request_queue_size = 64


def make_server(engine: NanamiEngine, host: str, port: int) -> ThreadingHTTPServer:
    class BoundHandler(NanamiHandler):
        pass

    BoundHandler.engine = engine
    return NanamiThreadingHTTPServer((host, port), BoundHandler)


def main() -> int:
    parser = argparse.ArgumentParser(description="Nanami V1 local Irodori engine server.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--irodori-repo", default=str(DEFAULT_IRODORI_REPO))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--no-preload", action="store_true")
    args = parser.parse_args()

    config = load_engine_config(args.config)
    engine = NanamiEngine(
        config=config,
        output_dir=Path(args.output_dir).expanduser().resolve(),
        irodori_repo=Path(args.irodori_repo).expanduser().resolve(),
    )
    if not args.no_preload:
        started = time.perf_counter()
        loaded = engine.load()
        elapsed = time.perf_counter() - started
        print(f"[engine] loaded={loaded} elapsed_sec={elapsed:.3f}", flush=True)
    server = make_server(engine, args.host, args.port)
    print(f"[engine] listening http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[engine] stopping", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
