# Cờ Úp / Cờ Tướng analysis

Analysis page for Cờ Úp (Jieqi) and standard Xiangqi, backed by Pikafish.

- `index.html`, `engine.js`: the page and its JS fallback engine
- `server.js`: Node bridge to the Pikafish engines (SSE `/analyse`)
- `wasm/`: the Cờ Úp engine compiled to WebAssembly, so the page works as a static site (see below)
- `coi-serviceworker.js`: adds the COOP/COEP headers that the WebAssembly engine needs on hosts that cannot set them (MIT, https://github.com/gzuidhof/coi-serviceworker, v0.1.7)
- `Dockerfile`: builds both engines from upstream Pikafish (GPLv3, https://github.com/official-pikafish/Pikafish) and runs the server
- `render.yaml`: Render.com blueprint (free web service)

Run locally without Docker: build the engines (see comments in `server.js`), then `node server.js` and open http://127.0.0.1:8765.

## Engine choice

The page uses the first engine that works:

1. `server.js` (native Pikafish, both variants), if reachable
2. Pikafish in the browser (WebAssembly, **Cờ Úp only**), if the browser supports threads in WebAssembly (cross-origin isolation)
3. the JS fallback engine in `engine.js` (weak)

## Static hosting (GitHub Pages)

The repo root is a complete static site for Cờ Úp: Settings → Pages → Deploy from branch `main`, folder `/`.
The service worker reloads the page once on the first visit to turn on cross-origin isolation.
The site must be served over HTTPS (or from localhost).

## Rebuilding the WebAssembly engine

`wasm/pikafish-jieqi.js` and `wasm/pikafish-jieqi.wasm` are committed build outputs. To rebuild:

```
git clone --branch jieqi_old https://github.com/official-pikafish/Pikafish.git pikafish
git -C pikafish checkout 23b9466
source <emsdk>/emsdk_env.sh        # Emscripten, https://emscripten.org
wasm/build.sh                      # applies wasm/pikafish-jieqi-wasm.patch, then compiles
```

The patch adds a `uci_command()` entry point (one UCI command per call, instead of reading stdin)
and clears the hash table on one thread (the pthread pool has a fixed size).
`wasm/jieqi-worker.js` wraps the engine in a Web Worker and answers like `server.js /analyse`.
