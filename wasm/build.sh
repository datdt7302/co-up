#!/usr/bin/env bash
# Build the Cờ Úp engine (Pikafish branch jieqi_old) to WebAssembly.
#
# Needs Emscripten (https://emscripten.org): source <emsdk>/emsdk_env.sh first.
# Usage: wasm/build.sh [path-to-pikafish-src]   (default: ./pikafish/src)
# Output: wasm/pikafish-jieqi.js + pikafish-jieqi.wasm (loaded by wasm/jieqi-worker.js)
#
# The engine source must have wasm/pikafish-jieqi-wasm.patch applied
# (adds the uci_command() entry point). This script applies it if needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$(cd "${1:-$ROOT/pikafish/src}" && pwd)"
OUT="$ROOT/wasm"
PATCH="$ROOT/wasm/pikafish-jieqi-wasm.patch"

if ! grep -q "uci_command" "$SRC/main.cpp"; then
  git -C "$SRC/.." apply "$PATCH"
fi

mkdir -p "$OUT"

SRCS=(benchmark.cpp bitboard.cpp evaluate.cpp main.cpp material.cpp misc.cpp
      movegen.cpp movepick.cpp position.cpp psqt.cpp search.cpp thread.cpp
      timeman.cpp tt.cpp uci.cpp ucioption.cpp tune.cpp
      nnue/evaluate_nnue.cpp nnue/features/half_ka_v2_hm.cpp
      compression/zip.cpp)

# Search threads run as pthreads (needs SharedArrayBuffer, i.e. COOP/COEP headers).
# PTHREAD_POOL_SIZE: workers are created up front, because the engine blocks while
# a new search thread starts and a lazily created worker would never get to run.
# Stack: deep search recursion needs far more than Emscripten's 64 KB default.
cd "$SRC"
em++ -std=c++17 -O3 -DNDEBUG -DIS_64BIT -DUSE_POPCNT -msimd128 \
  -pthread -flto \
  "${SRCS[@]}" \
  -o "$OUT/pikafish-jieqi.js" \
  -sENVIRONMENT=web,worker \
  -sMODULARIZE=1 -sEXPORT_NAME=PikafishJieqi \
  -sEXPORTED_FUNCTIONS=_main,_uci_command \
  -sEXPORTED_RUNTIME_METHODS=ccall \
  -sPTHREAD_POOL_SIZE='Math.min(navigator.hardwareConcurrency||4,8)+1' \
  -sDEFAULT_PTHREAD_STACK_SIZE=8MB -sSTACK_SIZE=8MB \
  -sINITIAL_MEMORY=128MB -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB \
  -sEXIT_RUNTIME=0

ls -la "$OUT"
