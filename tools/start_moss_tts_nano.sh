#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOSS_DIR="${SUNABOT_MOSS_TTS_NANO_DIR:-$PROJECT_ROOT/workspace/runtime/voice/MOSS-TTS-Nano}"
MOSS_ENV="${SUNABOT_MOSS_TTS_NANO_CONDA_ENV:-sunabot-moss-tts-nano}"
MOSS_PORT="${SUNABOT_MOSS_TTS_NANO_PORT:-18083}"
MOSS_CPU_THREADS="${SUNABOT_MOSS_TTS_NANO_CPU_THREADS:-4}"
MOSS_OUTPUT_DIR="${SUNABOT_MOSS_TTS_NANO_OUTPUT_DIR:-$PROJECT_ROOT/workspace/runtime/voice/generated}"

if [[ ! "$MOSS_ENV" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "SUNABOT_MOSS_TTS_NANO_CONDA_ENV contains unsupported characters." >&2
  exit 2
fi
if [[ ! "$MOSS_PORT" =~ ^[0-9]+$ ]] || (( MOSS_PORT < 1 || MOSS_PORT > 65535 )); then
  echo "SUNABOT_MOSS_TTS_NANO_PORT must be between 1 and 65535." >&2
  exit 2
fi
if [[ ! "$MOSS_CPU_THREADS" =~ ^[0-9]+$ ]] || (( MOSS_CPU_THREADS < 1 || MOSS_CPU_THREADS > 64 )); then
  echo "SUNABOT_MOSS_TTS_NANO_CPU_THREADS must be between 1 and 64." >&2
  exit 2
fi
if [[ ! -f "$MOSS_DIR/app_onnx.py" ]]; then
  echo "MOSS-TTS-Nano is not installed at $MOSS_DIR." >&2
  echo "Run tools/install_moss_tts_nano.sh first." >&2
  exit 2
fi
if ! command -v conda >/dev/null 2>&1; then
  echo "conda is required to start MOSS-TTS-Nano." >&2
  exit 2
fi
CONDA_BASE="$(conda info --base)"
if [[ ! -x "$CONDA_BASE/envs/$MOSS_ENV/bin/python" ]]; then
  echo "Conda environment $MOSS_ENV is not installed." >&2
  echo "Run tools/install_moss_tts_nano.sh first." >&2
  exit 2
fi

mkdir -p "$MOSS_OUTPUT_DIR"
MODEL_ARGUMENTS=()
if [[ -n "${SUNABOT_MOSS_TTS_NANO_MODEL_DIR:-}" ]]; then
  MODEL_ARGUMENTS=(--model-dir "$SUNABOT_MOSS_TTS_NANO_MODEL_DIR")
fi

cd "$MOSS_DIR"
exec conda run --no-capture-output -n "$MOSS_ENV" python app_onnx.py \
  --host 127.0.0.1 \
  --port "$MOSS_PORT" \
  --cpu-threads "$MOSS_CPU_THREADS" \
  --execution-provider cpu \
  --output-dir "$MOSS_OUTPUT_DIR" \
  "${MODEL_ARGUMENTS[@]}"
