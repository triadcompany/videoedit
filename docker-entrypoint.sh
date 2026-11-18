#!/bin/sh
# O painel sobe na hora; o modelo do Whisper baixa em segundo plano na primeira execução
# (fica salvo no volume /data). Se o download falhar, o painel continua no ar.
MODEL_NAME="${WHISPER_MODEL:-small}"
MODEL_DIR="${DATA_DIR:-/data}/models"
MODEL_FILE="$MODEL_DIR/ggml-${MODEL_NAME}.bin"
mkdir -p "$MODEL_DIR"

if [ ! -s "$MODEL_FILE" ]; then
  (
    echo "[whisper] baixando modelo ${MODEL_NAME}..."
    if curl -fL --retry 5 --retry-delay 5 -o "$MODEL_FILE.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin"; then
      mv "$MODEL_FILE.part" "$MODEL_FILE"
      echo "[whisper] modelo ${MODEL_NAME} pronto."
    else
      rm -f "$MODEL_FILE.part"
      echo "[whisper] FALHOU o download do modelo ${MODEL_NAME}. A transcricao nao vai funcionar ate baixar."
    fi
  ) &
fi

exec node server.js
