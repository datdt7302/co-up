// Web Worker that runs the Cờ Úp engine (Pikafish jieqi_old, built by wasm/build.sh) in the browser.
// It answers the same way as server.js /analyse, so the page can use either:
//   page -> worker  {type:'analyse', id, fen, moves, ms, multipv}   |  {type:'cancel'}
//   worker -> page  {type:'ready', name}  |  {type:'error', message}
//                   {type:'data', id, data:{depth, list:[{uci, score}], done, aborted?}}
// The engine's search threads are pthreads; Emscripten starts them by loading this same file
// with the worker name "em-pthread", so everything below the importScripts is skipped there.
'use strict';
importScripts('pikafish-jieqi.js');

if (self.name !== 'em-pthread') {
  // Must match server.js: early stop once the best move has been stable, and the mate scale.
  const STABLE = 5, MIN_DEPTH = 12, MIN_MS = 300;
  const MATE = 100000;
  const CORES = self.navigator.hardwareConcurrency || 4;
  // keep one core for the page; the pthread pool in build.sh holds min(cores, 8) + 1 workers
  const THREADS = Math.max(1, Math.min(8, CORES - 1));
  const HASH = 64;

  let send = null, name = null, current = null, pending = null, busy = false;

  function parseInfo(line) {
    const t = line.split(/\s+/), o = {};
    for (let i = 1; i < t.length; i++) {
      const k = t[i];
      if (k === 'depth' || k === 'multipv' || k === 'nodes' || k === 'time') o[k] = +t[++i];
      else if (k === 'score') {
        const kind = t[++i], v = +t[++i];
        o.score = kind === 'mate' ? (v > 0 ? MATE - v : -MATE - v) : v;
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') { o.bound = true; i++; }
      } else if (k === 'pv') { o.move = t[i + 1]; break; }
    }
    return o;
  }

  function emit(id, data) { postMessage({ type: 'data', id, data }); }

  function snapshot(done) {
    const c = current;
    const list = [...c.lines.values()].map(v => ({ uci: v.move, score: v.score })).sort((a, b) => b.score - a.score);
    return { depth: c.depth, list, done };
  }

  function onLine(line) {
    if (line.startsWith('id name ')) name = line.slice(8);
    const c = current; if (!c) return;
    if (line.startsWith('info ') && line.includes(' pv ')) {
      const o = parseInfo(line);
      if (o.bound || !o.move || o.score === undefined) return;
      const mpv = o.multipv || 1;
      if (mpv === 1 && o.depth > c.depth) {
        c.depth = o.depth; c.bests.push(o.move);
        const b = c.bests, el = Date.now() - c.t0;
        const stable = b.length >= STABLE && b.slice(-STABLE).every(m => m === o.move);
        if (!c.stopping && el >= MIN_MS && ((o.depth >= MIN_DEPTH && stable) || Math.abs(o.score) > MATE - 500)) {
          c.stopping = true; send('stop');
        }
      }
      c.lines.set(mpv, { move: o.move, score: o.score });
      if (c.id !== null && (mpv === c.multipv || Date.now() - c.lastEmit > 250)) { c.lastEmit = Date.now(); emit(c.id, snapshot(false)); }
    } else if (line.startsWith('bestmove')) {
      if (c.id !== null) {
        if (!c.lines.size) { const mv = line.split(/\s+/)[1]; if (mv && mv !== '(none)') c.lines.set(1, { move: mv, score: 0 }); }
        emit(c.id, snapshot(true));
      }
      current = null; busy = false;
      // Not run() directly: this line is printed by the search thread, which waits until this
      // callback returns, while a new "go" waits for that search thread to finish.
      if (pending) setTimeout(() => { if (pending && !busy) { const p = pending; pending = null; run(p); } }, 0);
    }
  }

  // One search at a time. The engine must not get a new "go" before the previous search has
  // printed bestmove (its output is proxied through this thread, which would then be blocked).
  function run(job) {
    if (busy) {
      if (pending) emit(pending.id, { done: true, aborted: true });
      pending = job;
      if (current) { if (current.id !== null) emit(current.id, { done: true, aborted: true }); current.id = null; }
      send('stop'); return;
    }
    busy = true;
    current = { id: job.id, multipv: job.multipv, lines: new Map(), depth: 0, lastEmit: 0, bests: [], t0: Date.now(), stopping: false };
    send(`setoption name MultiPV value ${job.multipv}`);
    send(`position fen ${job.fen}${job.moves ? ' moves ' + job.moves : ''}`);
    send(`go movetime ${job.ms}`);
  }

  function cancel() {
    if (pending) { emit(pending.id, { done: true, aborted: true }); pending = null; }
    if (current && current.id !== null) { emit(current.id, { done: true, aborted: true }); current.id = null; send('stop'); }
  }

  const queue = [];   // messages that arrive while the engine is still loading
  self.onmessage = e => queue.push(e.data);

  function handle(m) {
    if (!m) return;
    if (m.type === 'analyse') {
      if (!/^[A-Za-z0-9/ -]{10,200}$/.test(m.fen || '')) { emit(m.id, { done: true, aborted: true }); return; }
      const moves = (m.moves || '').trim();
      if (moves && !/^[a-i][0-9][a-i][0-9]( [a-i][0-9][a-i][0-9]){0,199}$/.test(moves)) { emit(m.id, { done: true, aborted: true }); return; }
      run({
        id: m.id, fen: m.fen, moves,
        ms: Math.max(100, Math.min(60000, +m.ms || 3000)),
        multipv: Math.max(1, Math.min(10, +m.multipv || 3)),
      });
    } else if (m.type === 'cancel') cancel();
  }

  PikafishJieqi({
    print: text => { for (const l of String(text).split('\n')) { const s = l.trim(); if (s) onLine(s); } },
    printErr: text => console.warn('[pikafish]', text),
  }).then(Module => {
    send = cmd => Module.ccall('uci_command', null, ['string'], [cmd]);
    send('uci');
    send(`setoption name Threads value ${THREADS}`);
    send(`setoption name Hash value ${HASH}`);
    send('isready');
    postMessage({ type: 'ready', name: name || 'Pikafish Jieqi', threads: THREADS });
    self.onmessage = e => handle(e.data);
    queue.splice(0).forEach(handle);
  }, err => postMessage({ type: 'error', message: String(err && err.message || err) }));
}
