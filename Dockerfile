FROM node:22-bookworm-slim AS web-build

ARG VITE_HOSTED_MODE=true
ENV VITE_HOSTED_MODE=${VITE_HOSTED_MODE}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
RUN npm run build

FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CHORDCRAFT_DATA_DIR=/data \
    XDG_CACHE_HOME=/data/cache \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY engine/requirements.txt ./engine/requirements.txt
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        --extra-index-url https://pypi.org/simple \
        "torch==2.11.0" "torchaudio==2.11.0" \
    && grep -v -E '^(torch|torchaudio)==' engine/requirements.txt > /tmp/requirements.txt \
    && python -m pip install --no-cache-dir -r /tmp/requirements.txt \
    && python -m pip install --no-cache-dir --no-deps "basic-pitch[onnx]==0.4.0"

COPY engine ./engine
COPY --from=web-build /app/dist ./dist

CMD ["sh", "-c", "uvicorn engine.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
