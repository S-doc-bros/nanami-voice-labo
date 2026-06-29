#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.machinery
import os
import sys
from pathlib import Path
from types import ModuleType


def triton_available() -> bool:
  try:
    import triton  # noqa: F401
    import triton.language  # noqa: F401

    return True
  except Exception:
    sys.modules.pop("triton.language", None)
    sys.modules.pop("triton", None)
    return False


def install_triton_import_stub() -> None:
  triton_module = ModuleType("triton")
  language_module = ModuleType("triton.language")
  triton_module.__spec__ = importlib.machinery.ModuleSpec("triton", loader=None)
  language_module.__spec__ = importlib.machinery.ModuleSpec("triton.language", loader=None)
  triton_module.jit = lambda fn=None, **_kwargs: (lambda f: f) if fn is None else fn
  triton_module.cdiv = lambda a, b: (int(a) + int(b) - 1) // int(b)
  triton_module.language = language_module
  language_module.constexpr = int
  language_module.float32 = object()
  sys.modules["triton"] = triton_module
  sys.modules["triton.language"] = language_module


def warm_transformers_imports() -> None:
  # Irodori-TTS-Lite patches the inference stack before the tokenizer is loaded.
  # On macOS without Triton, importing Transformers lazily after the Triton stub
  # can leave transformers.generation half-initialized.  Warming these imports
  # first keeps AutoTokenizer available when infer.py reaches tokenization.
  try:
    import transformers  # noqa: F401
    import transformers.generation  # noqa: F401
    from transformers import AutoTokenizer  # noqa: F401
  except Exception as exc:
    print(f"[lite] transformers warm import failed: {exc}", flush=True)


def estimated_seconds(text: str) -> float:
  raw = str(text or "").strip()
  if not raw:
    return 2.0
  try:
    import pyopenjtalk

    phonemes = pyopenjtalk.g2p(raw, kana=False).split()
    return max(2.0, len(phonemes) / 11.0 + 0.6)
  except Exception:
    # Fallback for environments where pyopenjtalk is not installed yet.
    return max(2.0, min(18.0, len(raw) / 7.0 + 0.8))


def main() -> int:
  os.environ.setdefault("CUDA_VISIBLE_DEVICES", "0")
  cwd = str(Path.cwd())
  if cwd not in sys.path:
    sys.path.insert(0, cwd)

  parser = argparse.ArgumentParser(description="Run Irodori-TTS through Irodori-TTS-Lite.")
  parser.add_argument(
    "--checkpoint",
    default=None,
    help="Local path or hf://org/repo/file. Omit to use Irodori-TTS-Lite default int4 checkpoint.",
  )
  parser.add_argument("--text", required=True)
  parser.add_argument("--output-wav", required=True)
  parser.add_argument("--seconds", type=float, default=None)
  parser.add_argument("--no-ref", action="store_true")
  parser.add_argument("--no-fused", action="store_true")
  parser.add_argument("--no-eager-dequant", action="store_true")
  parser.add_argument("--no-fp16", dest="fp16", action="store_false")
  parser.add_argument("--codec-int4", action="store_true")
  parser.add_argument("--pack-rtn-extras", action="store_true")
  parser.add_argument("--duration-donor", default=None)
  parser.set_defaults(fp16=True)
  args, infer_argv = parser.parse_known_args()

  warm_transformers_imports()
  has_triton = triton_available()
  if not has_triton:
    install_triton_import_stub()
  use_fused = (not args.no_fused) and has_triton
  if not has_triton:
    print("[lite] triton is not available; using eager-dequant fallback.", flush=True)

  import irodori_tts_lite

  irodori_tts_lite.configure(
    use_fused=use_fused,
    force_fp16=bool(args.fp16),
    disable_eager=bool(args.no_eager_dequant),
    codec_int4=bool(args.codec_int4),
    pack_rtn_extras=bool(args.pack_rtn_extras),
    duration_donor=args.duration_donor,
  )
  irodori_tts_lite.patch()

  checkpoint_path = irodori_tts_lite.resolve_checkpoint(args.checkpoint)
  seconds = float(args.seconds) if args.seconds is not None else estimated_seconds(args.text)
  print(f"[lite] checkpoint: {checkpoint_path}", flush=True)
  print(f"[lite] seconds: {seconds:.2f}", flush=True)

  # Import infer only after patch() so InferenceRuntime is replaced before use.
  import infer

  infer.FIXED_SECONDS = seconds
  sys.argv = [
    sys.argv[0],
    "--checkpoint",
    str(Path(checkpoint_path).expanduser()),
    "--text",
    str(args.text),
    "--output-wav",
    str(args.output_wav),
  ]
  if args.no_ref:
    sys.argv.append("--no-ref")
  sys.argv.extend(infer_argv)
  infer.main()
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
