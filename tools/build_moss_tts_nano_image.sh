#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOSS_IMAGE="${SUNABOT_MOSS_TTS_NANO_IMAGE:-sunabot-moss-tts-nano:9b1d3eadd5a7}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build the MOSS-TTS-Nano image." >&2
  exit 2
fi

exec docker build \
  --file "$PROJECT_ROOT/deploy/docker/Dockerfile.voice" \
  --tag "$MOSS_IMAGE" \
  "$PROJECT_ROOT"
