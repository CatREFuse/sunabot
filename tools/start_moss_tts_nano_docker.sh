#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOSS_IMAGE="${SUNABOT_MOSS_TTS_NANO_IMAGE:-sunabot-moss-tts-nano:9b1d3eadd5a7}"
MOSS_CONTAINER="${SUNABOT_MOSS_TTS_NANO_CONTAINER:-sunabot-moss-tts-nano}"
MOSS_PORT="${SUNABOT_MOSS_TTS_NANO_PORT:-18083}"
MOSS_CPU_THREADS="${SUNABOT_MOSS_TTS_NANO_CPU_THREADS:-4}"
MOSS_MODEL_DIR="${SUNABOT_MOSS_TTS_NANO_MODEL_DIR:-$PROJECT_ROOT/workspace/runtime/voice/models}"
MOSS_OUTPUT_DIR="${SUNABOT_MOSS_TTS_NANO_OUTPUT_DIR:-$PROJECT_ROOT/workspace/runtime/voice/generated}"
MOSS_CACHE_DIR="${SUNABOT_MOSS_TTS_NANO_CACHE_DIR:-$PROJECT_ROOT/workspace/runtime/voice/cache}"
MOSS_UPLOAD_DIR="${SUNABOT_MOSS_TTS_NANO_UPLOAD_DIR:-$PROJECT_ROOT/workspace/runtime/voice/uploads}"
MOSS_WORKSPACE_ID="${SUNABOT_WORKSPACE_ID:-}"
MOSS_NETWORK="${SUNABOT_DOCKER_NETWORK:-sunabot-runtime}"
RUN_MODE=()

if (( $# > 1 )) || [[ "${1:-}" != "" && "${1:-}" != "--detach" ]]; then
  echo "Usage: tools/start_moss_tts_nano_docker.sh [--detach]" >&2
  exit 2
fi
if [[ "${1:-}" == "--detach" ]]; then
  RUN_MODE=(--detach)
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to start MOSS-TTS-Nano." >&2
  exit 2
fi
if [[ ! "$MOSS_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "SUNABOT_MOSS_TTS_NANO_CONTAINER contains unsupported characters." >&2
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
if [[ ! "$MOSS_NETWORK" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "SUNABOT_DOCKER_NETWORK contains unsupported characters." >&2
  exit 2
fi
if [[ -z "$MOSS_WORKSPACE_ID" ]]; then
  MOSS_WORKSPACE_ID="$(node -e 'const c=require("node:crypto"),p=require("node:path");process.stdout.write(c.createHash("sha256").update(p.resolve(process.argv[1]).normalize("NFC")).digest("hex").slice(0,16))' "$PROJECT_ROOT/workspace")"
fi
if [[ ! "$MOSS_WORKSPACE_ID" =~ ^[a-f0-9]{16}$ ]]; then
  echo "SUNABOT_WORKSPACE_ID must be 16 lowercase hex characters." >&2
  exit 2
fi

mkdir -p "$MOSS_MODEL_DIR" "$MOSS_OUTPUT_DIR" "$MOSS_CACHE_DIR" "$MOSS_UPLOAD_DIR"

MODEL_BOOTSTRAP='from pathlib import Path
from huggingface_hub import snapshot_download

root = Path("/models")
repositories = (
    (
        "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX",
        "MOSS-TTS-Nano-100M-ONNX",
        "f52645cb467506d8e18e746ddd59482685b74e58",
    ),
    (
        "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX",
        "MOSS-Audio-Tokenizer-Nano-ONNX",
        "ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae",
    ),
)
for repository, directory, revision in repositories:
    target = root / directory
    sentinel = target / f".sunabot-download-complete-{revision}"
    if sentinel.is_file():
        continue
    snapshot_download(repo_id=repository, revision=revision, local_dir=target)
    sentinel.touch()
'

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --volume "$MOSS_MODEL_DIR:/models" \
  --entrypoint python \
  "$MOSS_IMAGE" \
  -c "$MODEL_BOOTSTRAP"

exec docker run --rm --init "${RUN_MODE[@]}" \
  --name "$MOSS_CONTAINER" \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --publish "127.0.0.1:$MOSS_PORT:18083" \
  --network "$MOSS_NETWORK" \
  --network-alias sunabot-moss-tts-nano \
  --label io.sunabot.component=voice \
  --label "io.sunabot.voice-workspace-id=$MOSS_WORKSPACE_ID" \
  --volume "$MOSS_MODEL_DIR:/opt/moss-tts-nano/models" \
  --volume "$MOSS_OUTPUT_DIR:/opt/moss-tts-nano/generated_audio" \
  --volume "$MOSS_CACHE_DIR:/opt/moss-tts-nano/.cache" \
  --volume "$MOSS_UPLOAD_DIR:/opt/moss-tts-nano/.app_prompt_uploads" \
  "$MOSS_IMAGE" \
  --host 0.0.0.0 \
  --port 18083 \
  --cpu-threads "$MOSS_CPU_THREADS" \
  --execution-provider cpu \
  --output-dir /opt/moss-tts-nano/generated_audio
