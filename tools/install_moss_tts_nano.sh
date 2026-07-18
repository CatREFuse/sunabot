#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOSS_DIR="${SUNABOT_MOSS_TTS_NANO_DIR:-$PROJECT_ROOT/workspace/runtime/voice/MOSS-TTS-Nano}"
MOSS_ENV="${SUNABOT_MOSS_TTS_NANO_CONDA_ENV:-sunabot-moss-tts-nano}"
MOSS_REVISION="9b1d3eadd5a72436fcaa9568351266f154db49a2"
MOSS_REPOSITORY="https://github.com/OpenMOSS/MOSS-TTS-Nano.git"

if [[ ! "$MOSS_ENV" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "SUNABOT_MOSS_TTS_NANO_CONDA_ENV contains unsupported characters." >&2
  exit 2
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required to install MOSS-TTS-Nano." >&2
  exit 2
fi
if ! command -v conda >/dev/null 2>&1; then
  echo "conda is required to install MOSS-TTS-Nano." >&2
  exit 2
fi
CONDA_BASE="$(conda info --base)"

mkdir -p "$(dirname "$MOSS_DIR")"
if [[ ! -e "$MOSS_DIR" ]]; then
  git clone --filter=blob:none "$MOSS_REPOSITORY" "$MOSS_DIR"
elif [[ ! -d "$MOSS_DIR/.git" ]]; then
  echo "SUNABOT_MOSS_TTS_NANO_DIR is not an MOSS-TTS-Nano Git checkout: $MOSS_DIR" >&2
  exit 2
fi

ORIGIN_URL="$(git -C "$MOSS_DIR" remote get-url origin)"
if [[ "$ORIGIN_URL" != "$MOSS_REPOSITORY" && "$ORIGIN_URL" != "git@github.com:OpenMOSS/MOSS-TTS-Nano.git" ]]; then
  echo "Refusing an unexpected MOSS-TTS-Nano origin: $ORIGIN_URL" >&2
  exit 2
fi
if [[ -n "$(git -C "$MOSS_DIR" status --porcelain)" ]]; then
  echo "Refusing to change a modified MOSS-TTS-Nano checkout: $MOSS_DIR" >&2
  exit 2
fi

git -C "$MOSS_DIR" fetch --depth 1 origin "$MOSS_REVISION"
git -C "$MOSS_DIR" checkout --detach "$MOSS_REVISION"

if [[ ! -x "$CONDA_BASE/envs/$MOSS_ENV/bin/python" ]]; then
  conda create -n "$MOSS_ENV" python=3.12 -y
fi
conda install -n "$MOSS_ENV" -c conda-forge pynini=2.1.6.post1 -y
conda run -n "$MOSS_ENV" python -m pip install --disable-pip-version-check -r "$MOSS_DIR/requirements.txt"
conda run -n "$MOSS_ENV" python -m pip install --disable-pip-version-check -e "$MOSS_DIR"

echo "MOSS-TTS-Nano installed at $MOSS_DIR"
echo "Start it with: tools/start_moss_tts_nano.sh"
