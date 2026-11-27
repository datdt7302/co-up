#!/usr/bin/env node
// Local bridge between the Cờ Úp page and the Pikafish engines (UCI).
//   node server.js            -> http://127.0.0.1:8765
// Two engines:
//   jieqi   (Cờ úp)          pikafish/src/PikaJieQi           (official-pikafish/Pikafish, branch jieqi_old)
//   xiangqi (Cờ tướng thường) pikafish-xiangqi/src/pikafish   (official-pikafish/Pikafish, master + pikafish.nnue)
// Env: PORT, HOST, PIKAFISH (jieqi engine path), PIKAFISH_XQ (xiangqi engine path), THREADS, HASH (MB).
// Endpoints:
//   GET /health                          -> {ok, engine, engines:{jieqi, xiangqi}}
//   GET /analyse?variant=jieqi|xiangqi&fen=...&moves=a0a1 b9c7&ms=3000&multipv=3
//        (Server-Sent Events; moves = recent history so the engine can apply repetition rules)
//        data: {"depth":12,"list":[{"uci":"a3a4","score":208}],"done":false}
//   GET /, /index.html, /engine.js       -> the page itself
// No dependencies beyond Node.js.
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const {spawn}=require('child_process');

const PORT=+process.env.PORT||8765;
const HOST=process.env.HOST||'0.0.0.0';
const THREADS=+process.env.THREADS||Math.max(1,Math.min(16,os.cpus().length-4));
const HASH=+process.env.HASH||256;
// early stop: once the best move has stayed the same for STABLE consecutive depths
const STABLE=5,MIN_DEPTH=12,MIN_MS=300;
const MATE=100000; // must match ENGINE().MATE in engine.js

const PATHS={
  jieqi:process.env.PIKAFISH||path.join(__dirname,'pikafish','src','PikaJieQi'),
  xiangqi:process.env.PIKAFISH_XQ||path.join(__dirname,'pikafish-xiangqi','src','pikafish'),
};
if(!fs.existsSync(PATHS.jieqi))console.error(`Jieqi engine not found: ${PATHS.jieqi}\n  build: cd pikafish/src && make -j build ARCH=x86-64-sse41-popcnt`);
if(!fs.existsSync(PATHS.xiangqi))console.error(`Xiangqi engine not found: ${PATHS.xiangqi}\n  build: cd pikafish-xiangqi/src && make -j build ARCH=x86-64-sse41-popcnt  (downloads pikafish.nnue)`);

function parseInfo(line){
  const t=line.split(/\s+/),o={};
  for(let i=1;i<t.length;i++){
    const k=t[i];
    if(k==='depth'||k==='multipv'||k==='nodes'||k==='time'){o[k]=+t[++i];}
    else if(k==='score'){const kind=t[++i],v=+t[++i];
      o.score=kind==='mate'?(v>0?MATE-v:-MATE-v):v;
      if(t[i+1]==='lowerbound'||t[i+1]==='upperbound'){o.bound=true;i++;}}
    else if(k==='pv'){o.move=t[i+1];break;}
  }
  return o;
}
function emit(res,obj){try{res.write(`data: ${JSON.stringify(obj)}\n\n`);}catch(e){}}
function endStream(res){emit(res,{done:true,aborted:true});try{res.end();}catch(e){}}

// One UCI engine process; one search at a time, a newer request replaces the queued one.
class Engine{
  constructor(file){this.file=file;this.proc=null;this.name=null;this.buf='';this.current=null;this.pending=null;this.busy=false;}
  get available(){return fs.existsSync(this.file);}
  start(){
    if(this.proc)return;
    const p=spawn(this.file,[],{cwd:path.dirname(this.file),stdio:['pipe','pipe','inherit']});
    this.proc=p;this.buf='';this.busy=false;this.current=null;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data',d=>{this.buf+=d;let i;while((i=this.buf.indexOf('\n'))>=0){const l=this.buf.slice(0,i).trim();this.buf=this.buf.slice(i+1);if(l)this.onLine(l);}});
    p.on('exit',code=>{console.error(`${path.basename(this.file)} exited (${code}), restarting`);
      if(this.current&&this.current.res)endStream(this.current.res);
      this.proc=null;setTimeout(()=>this.start(),500);});
    this.send('uci');
    this.send(`setoption name Threads value ${THREADS}`);
    this.send(`setoption name Hash value ${HASH}`);
    this.send('isready');
  }
  send(cmd){if(this.proc)this.proc.stdin.write(cmd+'\n');}
  snapshot(done){
    // lines can come from two neighbouring depths while a depth is in progress; show best first
    const c=this.current;
    const list=[...c.lines.values()].map(v=>({uci:v.move,score:v.score})).sort((a,b)=>b.score-a.score);
    return{depth:c.depth,list,done};
  }
  onLine(line){
    if(line.startsWith('id name '))this.name=line.slice(8);
    const c=this.current;if(!c)return;
    if(line.startsWith('info ')&&line.includes(' pv ')){
      const o=parseInfo(line);
      if(o.bound||!o.move||o.score===undefined)return;
      const mpv=o.multipv||1;
      if(mpv===1&&o.depth>c.depth){
        c.depth=o.depth;c.bests.push(o.move);
        const b=c.bests,el=Date.now()-c.t0;
        const stable=b.length>=STABLE&&b.slice(-STABLE).every(m=>m===o.move);
        if(!c.stopping&&el>=MIN_MS&&((o.depth>=MIN_DEPTH&&stable)||Math.abs(o.score)>MATE-500)){c.stopping=true;this.send('stop');}
      }
      c.lines.set(mpv,{move:o.move,score:o.score});
      if(c.res&&(mpv===c.multipv||Date.now()-c.lastEmit>250)){c.lastEmit=Date.now();emit(c.res,this.snapshot(false));}
    }else if(line.startsWith('bestmove')){
      if(c.res){
        if(!c.lines.size){const mv=line.split(/\s+/)[1];if(mv&&mv!=='(none)')c.lines.set(1,{move:mv,score:0});}
        emit(c.res,this.snapshot(true));try{c.res.end();}catch(e){}
      }
      this.current=null;this.busy=false;
      if(this.pending){const p=this.pending;this.pending=null;this.run(p);}
    }
  }
  run(job){
    this.start();
    if(this.busy){
      if(this.pending&&this.pending.res)endStream(this.pending.res);
      this.pending=job;this.send('stop');return;
    }
    this.busy=true;
    this.current={res:job.res,multipv:job.multipv,lines:new Map(),depth:0,lastEmit:0,bests:[],t0:Date.now(),stopping:false};
    job.engine=this;
    this.send(`setoption name MultiPV value ${job.multipv}`);
    this.send(`position fen ${job.fen}${job.moves?' moves '+job.moves:''}`);
    this.send(`go movetime ${job.ms}`);
  }
  // the client went away or switched to the other engine
  cancel(res){
    if(this.pending&&this.pending.res===res)this.pending=null;
    if(this.current&&this.current.res===res){this.current.res=null;this.send('stop');}
  }
  stopAll(){
    if(this.pending){if(this.pending.res)endStream(this.pending.res);this.pending=null;}
    if(this.current){if(this.current.res)endStream(this.current.res);this.current.res=null;this.send('stop');}
  }
}
const engines={jieqi:new Engine(PATHS.jieqi),xiangqi:new Engine(PATHS.xiangqi)};

// ---- http ----
const STATIC={'/':'index.html','/index.html':'index.html','/engine.js':'engine.js'};
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const FEN_OK=/^[A-Za-z0-9/ -]{10,200}$/;

http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  // allow the page when opened from disk (Origin: null), from localhost, or from another port of the
  // host this server was reached on (e.g. the page served by python http.server on :9999)
  const origin=req.headers.origin;
  const reqHost=(req.headers.host||'').replace(/:\d+$/,'');
  let originHost='';try{originHost=new URL(origin).hostname;}catch(e){}
  if(origin==='null'||originHost==='localhost'||originHost==='127.0.0.1'||(originHost&&originHost===reqHost))res.setHeader('Access-Control-Allow-Origin',origin);

  if(u.pathname==='/health'){
    const info=v=>engines[v].available?(engines[v].name||(v==='jieqi'?'Pikafish Jieqi':'Pikafish')):null;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,engine:info('jieqi'),engines:{jieqi:info('jieqi'),xiangqi:info('xiangqi')}}));return;}

  if(u.pathname==='/analyse'){
    const variant=u.searchParams.get('variant')==='xiangqi'?'xiangqi':'jieqi';
    const eng=engines[variant];
    if(!eng.available){res.writeHead(503);res.end(`${variant} engine not installed`);return;}
    const fen=u.searchParams.get('fen')||'';
    if(!FEN_OK.test(fen)){res.writeHead(400);res.end('bad fen');return;}
    const moves=(u.searchParams.get('moves')||'').trim();
    if(moves&&!/^[a-i][0-9][a-i][0-9]( [a-i][0-9][a-i][0-9]){0,199}$/.test(moves)){res.writeHead(400);res.end('bad moves');return;}
    const ms=Math.max(100,Math.min(60000,+u.searchParams.get('ms')||3000));
    const multipv=Math.max(1,Math.min(10,+u.searchParams.get('multipv')||3));
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    res.write(': start\n\n');
    const job={fen,moves,ms,multipv,res};
    req.on('close',()=>{job.res=null;eng.cancel(res);});
    for(const k in engines)if(engines[k]!==eng)engines[k].stopAll();   // one search at a time
    eng.run(job);
    return;
  }

  const file=STATIC[u.pathname];
  if(file){fs.readFile(path.join(__dirname,file),(err,data)=>{
    if(err){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);});return;}
  res.writeHead(404);res.end('not found');
}).listen(PORT,HOST,()=>{
  if(engines.jieqi.available)engines.jieqi.start();
  if(engines.xiangqi.available)engines.xiangqi.start();   // loads the NNUE net now, not on the first request
  console.log(`Cờ Úp analysis server: http://${HOST}:${PORT}  (threads ${THREADS}, hash ${HASH}MB)\n  jieqi:   ${PATHS.jieqi}${engines.jieqi.available?'':' (missing)'}\n  xiangqi: ${PATHS.xiangqi}${engines.xiangqi.available?'':' (missing)'}`);
});
