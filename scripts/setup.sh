#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# load .env if present (safe subset)
if [ -f "$ROOT_DIR/.env" ]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
SETUP_STT=true
SETUP_TTS=false
SETUP_EDGE=false

for arg in "$@"; do
  case "$arg" in
    --tts)  SETUP_TTS=true ;;
    --stt)  SETUP_STT=true ;;
    --edge) SETUP_EDGE=true ;;
    --all)  SETUP_STT=true; SETUP_TTS=true; SETUP_EDGE=true ;;
    -h|--help)
      echo "Usage: npm run setup [--stt] [--tts] [--edge] [--all]"
      echo "  --stt   Install whisper-cpp (default if no flag given)"
      echo "  --tts   Install Piper TTS + download English voice"
      echo "  --edge  Install edge-tts (online fallback voice)"
      echo "  --all   Install everything"
      exit 0 ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# If no flags given, default to STT (backward compatible).
if [ "$SETUP_STT" = false ] && [ "$SETUP_TTS" = false ]; then
  SETUP_STT=true
fi

MODELS_DIR="$ROOT_DIR/models"
mkdir -p "$MODELS_DIR"

# ---------------------------------------------------------------------------
# Whisper (STT)
# ---------------------------------------------------------------------------
if [ "$SETUP_STT" = true ]; then
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

  TARGET="$MODELS_DIR/$FILE"

  if [ -f "$TARGET" ]; then
    echo "==> Model $FILE already present. Nothing to do."
  else
    echo "==> Downloading $MODEL model (~$([ "$MODEL" = "small.en" ] && echo 180 || echo 75) MB)…"
    curl -fL --progress-bar "$URL" -o "$TARGET"
  fi

  echo ""
  echo "Whisper is ready. You can switch STT to Whisper in the app Settings."
fi

# ---------------------------------------------------------------------------
# Piper (TTS)
# ---------------------------------------------------------------------------
if [ "$SETUP_TTS" = true ]; then
  PIPER_VOICE="${PIPER_VOICE:-en_US-amy-medium}"
  PIPER_MODELS_DIR="$MODELS_DIR/piper"
  mkdir -p "$PIPER_MODELS_DIR"

  echo ""
  echo "==> Checking piper…"
  if ! command -v piper >/dev/null 2>&1; then
    echo "piper not found. Installing via pipx (piper-tts)…"
    if ! command -v pipx >/dev/null 2>&1; then
      echo "pipx not found. Installing via Homebrew…"
      brew install pipx
      pipx ensurepath
    fi
    pipx install piper-tts
  else
    echo "piper already installed."
  fi

  # Download voice model files if missing.
  ONNX_FILE="$PIPER_VOICE.onnx"
  JSON_FILE="$PIPER_VOICE.onnx.json"
  ONNX_TARGET="$PIPER_MODELS_DIR/$ONNX_FILE"
  JSON_TARGET="$PIPER_MODELS_DIR/$JSON_FILE"

  case "$PIPER_VOICE" in
    en_US-amy-medium)   HF_VOICE_SUBDIR="en/en_US/amy/medium" ;;
    en_US-amy-low)      HF_VOICE_SUBDIR="en/en_US/amy/low" ;;
    en_US-ryan-medium)  HF_VOICE_SUBDIR="en/en_US/ryan/medium" ;;
    *) echo "Unsupported PIPER_VOICE '$PIPER_VOICE'. Supported: en_US-amy-medium, en_US-amy-low, en_US-ryan-medium."; exit 1 ;;
  esac
  HF_VOICE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/$HF_VOICE_SUBDIR"

  if [ -f "$ONNX_TARGET" ] && [ -f "$JSON_TARGET" ]; then
    echo "==> Voice $PIPER_VOICE already present. Nothing to do."
  else
    echo "==> Downloading Piper voice $PIPER_VOICE (~60 MB)…"
    curl -fL --progress-bar "$HF_VOICE_URL/$ONNX_FILE" -o "$ONNX_TARGET"
    curl -fL --progress-bar "$HF_VOICE_URL/$JSON_FILE" -o "$JSON_TARGET"
  fi

  echo ""
  echo "Piper TTS is ready. The app will use the neural voice automatically."
fi

# ---------------------------------------------------------------------------
# edge-tts (online fallback voice)
# ---------------------------------------------------------------------------
if [ "$SETUP_EDGE" = true ]; then
  echo ""
  echo "==> Checking edge-tts…"
  if ! command -v edge-tts >/dev/null 2>&1; then
    echo "edge-tts not found. Installing via pipx (edge-tts)…"
    if ! command -v pipx >/dev/null 2>&1; then
      echo "pipx not found. Installing via Homebrew…"
      brew install pipx
      pipx ensurepath
    fi
    pipx install edge-tts
  else
    echo "edge-tts already installed."
  fi
  echo ""
  echo "edge-tts is ready. It is used automatically when Piper is not installed (online only)."
fi

echo ""
echo "Done. Start the app with: npm start"
