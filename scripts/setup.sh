#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# load .env if present (safe subset)
if [ -f "$ROOT_DIR/.env" ]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

MODEL="${WHISPER_MODEL:-small.en}"

case "$MODEL" in
  tiny.en|base.en|small.en|medium.en) ;;
  *) echo "Unsupported model '$MODEL'. Use tiny.en, base.en, small.en or medium.en."; exit 1 ;;
esac

FILE="ggml-$MODEL.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$FILE"

echo "==> Checking whisper-cli…"
if ! command -v whisper-cli >/dev/null 2>&1 && ! command -v whisper >/dev/null 2>&1; then
  echo "whisper-cli not found. Installing via Homebrew (whisper-cpp)…"
  brew install whisper-cpp
else
  echo "whisper-cli already installed."
fi

MODELS_DIR="$ROOT_DIR/models"
mkdir -p "$MODELS_DIR"
TARGET="$MODELS_DIR/$FILE"

if [ -f "$TARGET" ]; then
  echo "==> Model $FILE already present. Nothing to do."
else
  echo "==> Downloading $MODEL model (~$([ "$MODEL" = "small.en" ] && echo 180 || echo 75) MB)…"
  curl -fL --progress-bar "$URL" -o "$TARGET"
fi

echo ""
echo "Done. Whisper is ready. You can switch STT to Whisper in the app Settings."
echo "Start the app with: npm start"