# Cờ Úp / Cờ Tướng analysis

Analysis page for Cờ Úp (Jieqi) and standard Xiangqi, backed by Pikafish.

- `index.html`, `engine.js`: the page and its JS fallback engine
- `server.js`: Node bridge to the Pikafish engines (SSE `/analyse`)
- `Dockerfile`: builds both engines from upstream Pikafish (GPLv3, https://github.com/official-pikafish/Pikafish) and runs the server
- `render.yaml`: Render.com blueprint (free web service)

Run locally without Docker: build the engines (see comments in `server.js`), then `node server.js` and open http://127.0.0.1:8765.
