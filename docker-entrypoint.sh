#!/bin/sh
# baixa o modelo do Whisper na primeira execução (fica salvo no volume /data)
set -e
MODEL_DIR="${DATA_DIR:-/data}/models"
MODEL_FILE="$MODEL_DIR/ggml-${WHISPER_MODEL:-small}.bin"
mkdir -p "$MODEL_DIR"
if [ ! -s "$MODEL_FILE" ]; then
  echo "Baixando modelo Whisper (${WHISPER_MODEL:-small})..."
  curl -fL --retry 3 -o "$MODEL_FILE.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL:-small}.bin"
  mv "$MODEL_FILE.part" "$MODEL_FILE"
fi
exec node server.js
