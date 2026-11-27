# Cờ Úp analysis page + Pikafish engines, for Render.com (free web service, Docker runtime).
# Engines are cloned from upstream at the exact commits used locally, so they are not stored in this repo.

# ---- build the two engines ----
FROM node:20-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      g++ make git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ARG PIKAFISH_REPO=https://github.com/official-pikafish/Pikafish.git
# jieqi (Cờ úp): branch jieqi_old, NNUE disabled
ARG JIEQI_COMMIT=23b9466
# xiangqi (Cờ tướng thường): master + pikafish.nnue (downloaded by `make build`)
ARG XIANGQI_COMMIT=8d8db92
# sse41-popcnt runs on any x86-64 host; change to x86-64-avx2 for more speed if the host supports it
ARG ARCH=x86-64-sse41-popcnt

WORKDIR /src
RUN git clone --branch jieqi_old "$PIKAFISH_REPO" pikafish \
    && git -C pikafish checkout "$JIEQI_COMMIT" \
    && make -C pikafish/src -j"$(nproc)" build ARCH="$ARCH"
RUN git clone "$PIKAFISH_REPO" pikafish-xiangqi \
    && git -C pikafish-xiangqi checkout "$XIANGQI_COMMIT" \
    && make -C pikafish-xiangqi/src -j"$(nproc)" build ARCH="$ARCH"

# ---- runtime ----
FROM node:20-bookworm-slim
WORKDIR /app
# same layout as the local folder, so server.js finds the engines at its default paths
COPY --from=build /src/pikafish/src/PikaJieQi            pikafish/src/PikaJieQi
COPY --from=build /src/pikafish-xiangqi/src/pikafish     pikafish-xiangqi/src/pikafish
COPY --from=build /src/pikafish-xiangqi/src/pikafish.nnue pikafish-xiangqi/src/pikafish.nnue
COPY server.js index.html engine.js ./

# Render's free tier: 0.1 CPU, 512 MB RAM -> one thread and small hash tables.
# Render sets PORT itself (default 10000); 10000 is used here too so it also works without it.
ENV PORT=10000 HOST=0.0.0.0 THREADS=1 HASH=16
EXPOSE 10000
USER node
CMD ["node", "server.js"]
