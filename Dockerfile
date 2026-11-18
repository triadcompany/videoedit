# ---- compila o whisper.cpp (transcrição local, sem API) ----
FROM node:20-bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.8.7 https://github.com/ggml-org/whisper.cpp /whisper \
    && cd /whisper \
    && cmake -B build -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build -j --config Release --target whisper-cli

# ---- app ----
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates fontconfig libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=whisper /whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY . .
ENV DATA_DIR=/data \
    WHISPER_BIN=/usr/local/bin/whisper-cli \
    WHISPER_MODEL=small \
    PORT=80
VOLUME /data
EXPOSE 80
CMD ["sh", "/app/docker-entrypoint.sh"]
