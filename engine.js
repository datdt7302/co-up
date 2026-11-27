// Cờ Úp (Jieqi) analysis engine.
// Self-contained: the page also turns ENGINE.toString() into a Web Worker, so nothing outside
// this function may be referenced.
//
// Search: iterative deepening PVS alpha-beta, transposition table (Zobrist), null-move pruning,
// late-move reductions, killer/history ordering, check extension, quiescence with delta pruning.
// Hidden pieces: a flip is a chance node (expectimax over the remaining hidden-piece pool,
// Star1-style bounds), so the engine sees what each possible reveal can do next.
// Evaluation: material (hidden = pool average), piece-square tables, mobility, hanging pieces,
// pressure on the king's palace.
function ENGINE(){
  'use strict';
  // ---- constants ----
  const TYPES=['R','H','C','A','E','P'];
  const VAL={K:0,A:200,E:200,H:400,R:900,C:450,P:100};
  const KIND={K:1,A:2,E:3,H:4,R:5,C:6,P:7};
  const KCH=['X','K','A','E','H','R','C','P'];
  const VALK=[0,0,200,200,400,900,450,100];
  const MOBW=[0,0,1,1,8,4,3,1];
  const MATE=100000,INF=1000000,VMAX=4000,MATE_BOUND=MATE-1000;
  // piece code: kind(1..7) | HID (face down) | BLK (black) | XF (flipped inside the search but type unknown:
  // valued at the pool average and moved like its starting-square kind, so it can still defend and recapture)
  const HID=8,BLK=16,XF=32;
  const MAXPLY=64,MAXM=160;
  // a flip inside the tree is expanded into every possible reveal only near the root (ply <= CHANCE_PLY)
  // and with enough depth left; deeper flips become "unknown" pieces valued at the pool average.
  let CHANCE_DEPTH=3,CHANCE_PLY=1;
  // risk aversion for root flips: score = mean - RISK * downside deviation
  let RISK=0.5;
  // variant: Cờ úp (revealed advisors/elephants roam freely) or standard Xiangqi (palace / own half)
  let XQ=false;

  const FILE=new Int8Array(90),RANK=new Int8Array(90);
  for(let s=0;s<90;s++){FILE[s]=s%9;RANK[s]=(s/9)|0;}
  const DIRS=[[1,0],[-1,0],[0,1],[0,-1]];
  const DIAG=[[1,1],[1,-1],[-1,1],[-1,-1]];
  // horse: [leg df, leg dr, df, dr]
  const HJ=[[0,1,1,2],[0,1,-1,2],[0,-1,1,-2],[0,-1,-1,-2],[1,0,2,1],[1,0,2,-1],[-1,0,-2,1],[-1,0,-2,-1]];
  const inB=(f,r)=>f>=0&&f<9&&r>=0&&r<10;
  const inPal=(c,f,r)=>f>=3&&f<=5&&(c===0?r>=0&&r<=2:r>=7&&r<=9);
  const ownHalf=(c,r)=>c===0?r<=4:r>=5;
  const colorOf=p=>(p>>4)&1;

  // ---- piece-square tables (index: color*90+square) ----
  const PST=[];for(let k=0;k<8;k++)PST.push(new Int16Array(180));
  const HR=[-15,-5,5,10,15,25,30,30,20,0], RR=[0,5,0,5,5,10,15,15,10,5], PR=[0,0,0,0,10,50,60,70,60,20];
  for(let c=0;c<2;c++)for(let s=0;s<90;s++){
    const f=FILE[s],r=RANK[s],rr=c===0?r:9-r,i=c*90+s,cf=4-Math.abs(f-4);
    PST[1][i]=(rr===0?10:rr===1?0:-10)+(f===4?5:0);
    PST[2][i]=inPal(c,f,r)?15:ownHalf(c,r)?5:0;
    PST[3][i]=ownHalf(c,r)?10:0;
    PST[4][i]=cf*5+HR[rr];
    PST[5][i]=RR[rr]+(f===0||f===8?-5:0);
    PST[6][i]=(f===4&&rr<=4?10:0)+(rr>=8?10:0);
    PST[7][i]=PR[rr]+(rr>=5&&f>=3&&f<=5?15:0);
  }

  // ---- zobrist ----
  let seed=0x9e3779b9;
  const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed|0;};
  const ZL=new Int32Array(64*90),ZH=new Int32Array(64*90);
  for(let i=0;i<64*90;i++){ZL[i]=rnd();ZH[i]=rnd();}
  const SIDE_L=rnd(),SIDE_H=rnd();

  // ---- state ----
  const B=new Int8Array(90);
  const kingSq=new Int16Array(2);
  const poolCnt=[new Int16Array(8),new Int16Array(8)];
  const poolN=new Int16Array(2),poolSum=new Int32Array(2),evC=new Int32Array(2);
  let hLo=0,hHi=0;
  const recalcEv=c=>{evC[c]=poolN[c]?Math.round(poolSum[c]/poolN[c]):300;};

  // undo stack
  const U_FR=new Int16Array(MAXPLY*2),U_TO=new Int16Array(MAXPLY*2),U_P=new Int8Array(MAXPLY*2),U_CAP=new Int8Array(MAXPLY*2),U_FL=new Int8Array(MAXPLY*2),U_HL=new Int32Array(MAXPLY*2),U_HH=new Int32Array(MAXPLY*2);
  let usp=0;

  function make(m,flip){
    const fr=(m/90)|0,to=m-fr*90,p=B[fr],cap=B[to];
    U_FR[usp]=fr;U_TO[usp]=to;U_P[usp]=p;U_CAP[usp]=cap;U_FL[usp]=flip;U_HL[usp]=hLo;U_HH[usp]=hHi;usp++;
    let np=p;
    if(p&HID){
      const c=colorOf(p);
      if(flip){np=(p&BLK)|flip;poolCnt[c][flip]--;poolN[c]--;poolSum[c]-=VALK[flip];recalcEv(c);}
      else np=(p&BLK)|XF|(p&7);
    }
    hLo^=ZL[p*90+fr]^ZL[np*90+to]^SIDE_L;hHi^=ZH[p*90+fr]^ZH[np*90+to]^SIDE_H;
    if(cap){hLo^=ZL[cap*90+to];hHi^=ZH[cap*90+to];}
    B[to]=np;B[fr]=0;
    if((np&7)===1&&!(np&(HID|XF)))kingSq[colorOf(np)]=to;
    if(cap&&(cap&7)===1&&!(cap&(HID|XF)))kingSq[colorOf(cap)]=-1;
  }
  function unmake(){
    usp--;
    const fr=U_FR[usp],to=U_TO[usp],p=U_P[usp],cap=U_CAP[usp],flip=U_FL[usp];
    B[fr]=p;B[to]=cap;hLo=U_HL[usp];hHi=U_HH[usp];
    if((p&HID)&&flip){const c=colorOf(p);poolCnt[c][flip]++;poolN[c]++;poolSum[c]+=VALK[flip];recalcEv(c);}
    if((p&7)===1&&!(p&(HID|XF)))kingSq[colorOf(p)]=fr;
    if(cap&&(cap&7)===1&&!(cap&(HID|XF)))kingSq[colorOf(cap)]=to;
  }
  function makeNull(){hLo^=SIDE_L;hHi^=SIDE_H;}

  // ---- move generation (precomputed geometry, no closures: this is the hot path) ----
  const PAL=new Uint8Array(180),OWN=new Uint8Array(180);
  for(let c=0;c<2;c++)for(let s=0;s<90;s++){PAL[c*90+s]=inPal(c,FILE[s],RANK[s])?1:0;OWN[c*90+s]=ownHalf(c,RANK[s])?1:0;}
  const RAY=new Int8Array(360*10),RAYN=new Int8Array(360);       // [s*4+d] squares along direction d (DIRS order)
  const KN=new Int8Array(360),KNN=new Int8Array(90);               // orthogonal neighbours
  const AN=new Int8Array(360),ANN=new Int8Array(90);               // diagonal neighbours
  const EN=new Int8Array(360),EEYE=new Int8Array(360),ENN=new Int8Array(90); // elephant targets + eye
  const HN=new Int8Array(720),HLEG=new Int8Array(720),HNN=new Int8Array(90); // horse targets + leg
  const HRN=new Int8Array(720),HRLEG=new Int8Array(720),HRNN=new Int8Array(90); // squares a horse attacks FROM + leg
  for(let s=0;s<90;s++){const f=FILE[s],r=RANK[s];
    for(let d=0;d<4;d++){let ff=f+DIRS[d][0],rr=r+DIRS[d][1],n=0;while(inB(ff,rr)){RAY[(s*4+d)*10+n++]=rr*9+ff;ff+=DIRS[d][0];rr+=DIRS[d][1];}RAYN[s*4+d]=n;
      if(inB(f+DIRS[d][0],r+DIRS[d][1]))KN[s*4+KNN[s]++]=(r+DIRS[d][1])*9+f+DIRS[d][0];}
    for(const d of DIAG){
      if(inB(f+d[0],r+d[1]))AN[s*4+ANN[s]++]=(r+d[1])*9+f+d[0];
      if(inB(f+2*d[0],r+2*d[1])){EN[s*4+ENN[s]]=(r+2*d[1])*9+f+2*d[0];EEYE[s*4+ENN[s]++]=(r+d[1])*9+f+d[0];}}
    for(const h of HJ){
      if(inB(f+h[2],r+h[3])){HN[s*8+HNN[s]]=(r+h[3])*9+f+h[2];HLEG[s*8+HNN[s]++]=(r+h[1])*9+f+h[0];}
      const hf=f-h[2],hr=r-h[3];
      if(inB(hf,hr)){HRN[s*8+HRNN[s]]=hr*9+hf;HRLEG[s*8+HRNN[s]++]=(hr+h[1])*9+hf+h[0];}}
  }
  const isKing=q=>(q&15)===1; // revealed king (kings are never face down, so never XF)

  // mode 0: all moves, 1: captures only, 2: attacked squares (incl. own pieces; cannon only past the screen)
  function genPiece(s,out,n,mode){
    const p=B[s];if(!p)return n;
    const c=(p>>4)&1,hid=p&HID,k=p&7,base=s*90,co=c*90;
    let t,q,i,L,o;
    switch(k){
      case 1:
        for(i=0,L=KNN[s];i<L;i++){t=KN[s*4+i];if(!PAL[co+t])continue;q=B[t];
          if(mode===2)out[n++]=t;else if(!q){if(mode===0)out[n++]=base+t;}else if(((q>>4)&1)!==c)out[n++]=base+t;}
        if(mode!==2){o=(s*4+(c===0?2:3));
          for(i=0,L=RAYN[o];i<L;i++){t=RAY[o*10+i];q=B[t];if(q){if(isKing(q)&&((q>>4)&1)!==c)out[n++]=base+t;break;}}}
        break;
      case 2:
        for(i=0,L=ANN[s];i<L;i++){t=AN[s*4+i];if((hid||XQ)&&!PAL[co+t])continue;q=B[t];
          if(mode===2)out[n++]=t;else if(!q){if(mode===0)out[n++]=base+t;}else if(((q>>4)&1)!==c)out[n++]=base+t;}
        break;
      case 3:
        for(i=0,L=ENN[s];i<L;i++){t=EN[s*4+i];if((hid||XQ)&&!OWN[co+t])continue;if(B[EEYE[s*4+i]])continue;q=B[t];
          if(mode===2)out[n++]=t;else if(!q){if(mode===0)out[n++]=base+t;}else if(((q>>4)&1)!==c)out[n++]=base+t;}
        break;
      case 4:
        for(i=0,L=HNN[s];i<L;i++){if(B[HLEG[s*8+i]])continue;t=HN[s*8+i];q=B[t];
          if(mode===2)out[n++]=t;else if(!q){if(mode===0)out[n++]=base+t;}else if(((q>>4)&1)!==c)out[n++]=base+t;}
        break;
      case 5:
        for(let d=0;d<4;d++){o=s*4+d;
          for(i=0,L=RAYN[o];i<L;i++){t=RAY[o*10+i];q=B[t];
            if(mode===2)out[n++]=t;else if(!q){if(mode===0)out[n++]=base+t;}else if(((q>>4)&1)!==c)out[n++]=base+t;
            if(q)break;}}
        break;
      case 6:
        for(let d=0;d<4;d++){o=s*4+d;i=0;L=RAYN[o];
          for(;i<L;i++){t=RAY[o*10+i];if(B[t])break;if(mode===0)out[n++]=base+t;}
          for(i++;i<L;i++){t=RAY[o*10+i];q=B[t];if(q){if(mode===2)out[n++]=t;else if(((q>>4)&1)!==c)out[n++]=base+t;break;}}}
        break;
      case 7:{
        t=c===0?s+9:s-9;
        if(t>=0&&t<90){q=B[t];if(mode===2)out[n++]=t;else if(!q){if(mode===0)out[n++]=base+t;}else if(((q>>4)&1)!==c)out[n++]=base+t;}
        if(!OWN[co+s]){const f=FILE[s];
          if(f>0){t=s-1;q=B[t];if(mode===2)out[n++]=t;else if(!q){if(mode===0)out[n++]=base+t;}else if(((q>>4)&1)!==c)out[n++]=base+t;}
          if(f<8){t=s+1;q=B[t];if(mode===2)out[n++]=t;else if(!q){if(mode===0)out[n++]=base+t;}else if(((q>>4)&1)!==c)out[n++]=base+t;}}
        break;}
    }
    return n;
  }
  function genAllInto(c,out,n,mode){for(let s=0;s<90;s++){const p=B[s];if(p&&((p>>4)&1)===c)n=genPiece(s,out,n,mode);}return n;}

  // is square sq attacked by color `by`?
  function attacked(sq,by){
    const target=B[sq],bo=by*90;
    for(let d=0;d<4;d++){const o=sq*4+d,L=RAYN[o];let i=0,q=0;
      for(;i<L;i++){q=B[RAY[o*10+i]];if(q)break;}
      if(i>=L)continue;
      if(((q>>4)&1)===by){
        const k=q&7;
        if(k===5)return true;
        if(k===1&&!(q&HID)){
          if(i===0&&PAL[bo+sq])return true;
          if(d>=2&&isKing(target))return true;
        }
        if(k===7&&i===0){
          if(d===(by===0?3:2))return true;              // pawn directly behind (from its view: in front)
          if(d<2&&!OWN[bo+RAY[o*10]])return true;      // crossed pawn beside
        }
      }
      for(i++;i<L;i++){q=B[RAY[o*10+i]];if(q){if(((q>>4)&1)===by&&(q&7)===6)return true;break;}}
    }
    for(let i=0,L=HRNN[sq];i<L;i++){const q=B[HRN[sq*8+i]];
      if(q&&((q>>4)&1)===by&&(q&7)===4&&!B[HRLEG[sq*8+i]])return true;}
    for(let i=0,L=ANN[sq];i<L;i++){const q=B[AN[sq*4+i]];
      if(q&&((q>>4)&1)===by&&(q&7)===2&&((!(q&HID)&&!XQ)||PAL[bo+sq]))return true;}
    for(let i=0,L=ENN[sq];i<L;i++){const q=B[EN[sq*4+i]];
      if(q&&((q>>4)&1)===by&&(q&7)===3&&!B[EEYE[sq*4+i]]&&((!(q&HID)&&!XQ)||OWN[bo+sq]))return true;}
    return false;
  }
  function inCheckC(c){const k=kingSq[c];if(k<0)return true;return attacked(k,1-c);}

  // ---- evaluation ----
  const attCnt=new Int8Array(180),minAtt=new Int16Array(180),tgt=new Int16Array(64);
  function pieceVal(p){return (p&(HID|XF))?evC[colorOf(p)]:VALK[p&7];}
  function evaluate(c){
    attCnt.fill(0);minAtt.fill(30000);
    let s0=0,s1=0;
    for(let s=0;s<90;s++){const p=B[s];if(!p)continue;
      const col=colorOf(p),k=p&7,unk=p&(HID|XF);
      let v=unk?evC[col]:VALK[k]+PST[k][col*90+s];
      const n=genPiece(s,tgt,0,2);
      const av=k===1&&!unk?2000:(unk?evC[col]:VALK[k]),o=col*90;
      for(let i=0;i<n;i++){const t=o+tgt[i];attCnt[t]++;if(av<minAtt[t])minAtt[t]=av;}
      if(!unk)v+=MOBW[k]*n;
      if(col===0)s0+=v;else s1+=v;
    }
    // hanging pieces and king-palace pressure
    let hang0a=0,hang0b=0,hang1a=0,hang1b=0;
    for(let s=0;s<90;s++){const p=B[s];if(!p)continue;
      const col=colorOf(p),en=1-col;if((p&7)===1&&!(p&(HID|XF)))continue;
      if(!attCnt[en*90+s])continue;
      const v=pieceVal(p);
      const loss=attCnt[col*90+s]?Math.max(0,v-minAtt[en*90+s]):v;
      if(col===0){if(loss>hang0a){hang0b=hang0a;hang0a=loss;}else if(loss>hang0b)hang0b=loss;}
      else{if(loss>hang1a){hang1b=hang1a;hang1a=loss;}else if(loss>hang1b)hang1b=loss;}
    }
    let kz0=0,kz1=0;
    for(let r=0;r<3;r++)for(let f=3;f<6;f++){kz0+=attCnt[90+r*9+f];kz1+=attCnt[(9-r)*9+f];}
    s0-=kz0*10+kz0*kz0*2;s1-=kz1*10+kz1*kz1*2;
    let sc=c===0?s0-s1:s1-s0;
    // side to move can save one hanging piece; a second one is likely lost
    if(c===0)sc+=-(hang0b*0.7)+hang1a*0.1;else sc+=-(hang1b*0.7)+hang0a*0.1;
    return sc+10;
  }

  // ---- search ----
  const TT_SIZE=1<<20,TT_MASK=TT_SIZE-1;
  const ttLo=new Int32Array(TT_SIZE),ttHi=new Int32Array(TT_SIZE),ttMove=new Int16Array(TT_SIZE),ttDepth=new Int8Array(TT_SIZE),ttFlag=new Int8Array(TT_SIZE),ttScore=new Int32Array(TT_SIZE);
  const EXACT=1,LOWER=2,UPPER=3;
  const killers=new Int16Array(MAXPLY*2),history=new Int32Array(2*8100);
  const MV=new Int32Array(MAXPLY*MAXM),MS=new Float64Array(MAXPLY*MAXM);
  let nodes=0,deadline=Infinity,stop=false;
  const tick=()=>{if((++nodes&2047)===0&&Date.now()>deadline)stop=true;};

  function ttStore(depth,flag,score,move,ply){
    const i=hLo&TT_MASK;
    if(ttLo[i]===hLo&&ttHi[i]===hHi&&ttDepth[i]>depth&&flag!==EXACT)return;
    let sc=Math.round(score);if(sc>MATE_BOUND)sc+=ply;else if(sc<-MATE_BOUND)sc-=ply;
    ttLo[i]=hLo;ttHi[i]=hHi;ttDepth[i]=depth;ttFlag[i]=flag;ttScore[i]=sc;ttMove[i]=move;
  }

  function orderScore(m,ttm,ply,c){
    if(m===ttm)return 1e7;
    const fr=(m/90)|0,to=m-fr*90,q=B[to];
    if(q){const vv=(q&7)===1&&!(q&(HID|XF))?10000:pieceVal(q);return 1e6+vv*16-pieceVal(B[fr])/16;}
    if(m===killers[ply*2])return 9e5;
    if(m===killers[ply*2+1])return 8e5;
    return history[c*8100+m];
  }
  function pick(base,i,n){
    let bi=i,bs=MS[base+i];
    for(let j=i+1;j<n;j++)if(MS[base+j]>bs){bs=MS[base+j];bi=j;}
    if(bi!==i){const tm=MV[base+i];MV[base+i]=MV[base+bi];MV[base+bi]=tm;MS[base+bi]=MS[base+i];MS[base+i]=bs;}
    return MV[base+i];
  }

  // expected value (for side c, who makes flip move m) over every piece the flip could reveal
  function chance(m,depth,alpha,beta,ply,c){
    const pc=poolCnt[c],tot=poolN[c];
    const kinds=[],probs=[];
    for(let k=2;k<=7;k++)if(pc[k]>0){kinds.push(k);probs.push(pc[k]/tot);}
    const idx=kinds.map((_,i)=>i).sort((a,b)=>probs[b]-probs[a]);
    let sum=0,rem=1;
    for(const i of idx){
      const p=probs[i];rem-=p;if(rem<1e-9)rem=0;
      let a=(alpha-sum-VMAX*rem)/p,b=(beta-sum+VMAX*rem)/p;
      if(a<-VMAX)a=-VMAX-1;if(b>VMAX)b=VMAX+1;
      make(m,kinds[i]);
      let v=-search(depth,-b,-a,ply+1,1-c,true);
      unmake();
      if(stop)return 0;
      if(v>VMAX)v=VMAX;else if(v<-VMAX)v=-VMAX;
      sum+=p*v;
      if(sum-VMAX*rem>=beta)return sum-VMAX*rem;
      if(sum+VMAX*rem<=alpha)return sum+VMAX*rem;
    }
    return sum;
  }

  function qs(alpha,beta,ply,c,qd){
    tick();if(stop)return 0;
    const stand=evaluate(c);
    if(stand>=beta)return stand;
    if(stand>alpha)alpha=stand;
    if(qd>=8||ply>=MAXPLY-1)return stand;
    const base=ply*MAXM;
    const n=genAllInto(c,MV,base,1)-base;
    for(let i=0;i<n;i++)MS[base+i]=orderScore(MV[base+i],-1,ply,c);
    for(let i=0;i<n;i++){
      const m=pick(base,i,n),fr=(m/90)|0,to=m-fr*90,q=B[to];
      if((q&7)===1&&!(q&(HID|XF)))return MATE-ply;
      const vv=pieceVal(q),av=pieceVal(B[fr]);
      if(stand+vv+200<=alpha)continue;
      if(av>vv+50&&attacked(to,1-c))continue;
      make(m,0);
      const sc=-qs(-beta,-alpha,ply+1,1-c,qd+1);
      unmake();
      if(stop)return 0;
      if(sc>=beta)return sc;
      if(sc>alpha)alpha=sc;
    }
    return alpha;
  }

  // ---- repetition (Xiangqi rule: perpetual check loses, other repetitions are a draw) ----
  // seq holds the game history before the root (0..histN-1), the root (histN) and the current search path.
  const SEQ=256+MAXPLY,seqLo=new Int32Array(SEQ),seqHi=new Int32Array(SEQ),seqChk=new Uint8Array(SEQ);
  let histN=0;
  const REP=3000;
  function repetition(n){
    for(let j=n-4;j>=0&&j>=n-80;j-=2){
      if(seqLo[j]!==seqLo[n]||seqHi[j]!==seqHi[n])continue;
      let weChecked=true,theyChecked=true;   // in check at every turn of that side inside the cycle
      for(let k=j;k<=n;k+=2)if(!seqChk[k]){weChecked=false;break;}
      for(let k=j+1;k<n;k+=2)if(!seqChk[k]){theyChecked=false;break;}
      if(weChecked&&!theyChecked)return REP;   // opponent is checking perpetually: they lose
      if(theyChecked&&!weChecked)return -REP;  // we are checking perpetually: we lose
      return 0;
    }
    return null;
  }

  function search(depth,alpha,beta,ply,c,allowNull){
    tick();if(stop)return 0;
    if(ply>=MAXPLY-2)return evaluate(c);
    const inChk=inCheckC(c);
    {const n=histN+ply;seqLo[n]=hLo;seqHi[n]=hHi;seqChk[n]=inChk?1:0;
      if(ply>0){const rv=repetition(n);if(rv!==null)return rv;}}
    if(inChk)depth++;
    if(depth<=0)return qs(alpha,beta,ply,c,0);
    // transposition table
    const ti=hLo&TT_MASK;let ttm=-1;
    if(ttLo[ti]===hLo&&ttHi[ti]===hHi){
      ttm=ttMove[ti];
      if(ttDepth[ti]>=depth){
        let sc=ttScore[ti];if(sc>MATE_BOUND)sc-=ply;else if(sc<-MATE_BOUND)sc+=ply;
        const fl=ttFlag[ti];
        if(fl===EXACT||(fl===LOWER&&sc>=beta)||(fl===UPPER&&sc<=alpha))return sc;
      }
    }
    // null move
    if(allowNull&&!inChk&&depth>=3&&beta<MATE_BOUND&&beta>-MATE_BOUND){
      makeNull();
      const sc=-search(depth-3,-beta,-beta+1,ply+1,1-c,false);
      makeNull();
      if(stop)return 0;
      if(sc>=beta)return beta;
    }
    const base=ply*MAXM;
    const n=genAllInto(c,MV,base,0)-base;
    if(!n)return -MATE+ply;
    for(let i=0;i<n;i++)MS[base+i]=orderScore(MV[base+i],ttm,ply,c);
    const a0=alpha;let best=-INF,bestM=0;
    for(let i=0;i<n;i++){
      const m=pick(base,i,n),fr=(m/90)|0,to=m-fr*90,q=B[to];
      if(q&&(q&7)===1&&!(q&(HID|XF)))return MATE-ply;
      const flip=B[fr]&HID;
      let sc;
      if(flip&&depth>=CHANCE_DEPTH&&ply<=CHANCE_PLY&&poolN[c]>0){
        sc=chance(m,depth-1,alpha,beta,ply,c);
      }else{
        make(m,0);
        if(i===0)sc=-search(depth-1,-beta,-alpha,ply+1,1-c,true);
        else{
          let red=0;
          if(i>=4&&depth>=3&&!q&&!inChk&&!flip&&m!==killers[ply*2]&&m!==killers[ply*2+1])red=i>=12&&depth>=5?2:1;
          sc=-search(depth-1-red,-alpha-1,-alpha,ply+1,1-c,true);
          if(!stop&&sc>alpha&&red)sc=-search(depth-1,-alpha-1,-alpha,ply+1,1-c,true);
          if(!stop&&sc>alpha&&sc<beta)sc=-search(depth-1,-beta,-alpha,ply+1,1-c,true);
        }
        unmake();
      }
      if(stop)return 0;
      if(sc>best){best=sc;bestM=m;
        if(sc>alpha){alpha=sc;
          if(alpha>=beta){
            if(!q){
              if(killers[ply*2]!==m){killers[ply*2+1]=killers[ply*2];killers[ply*2]=m;}
              const hi=c*8100+m;history[hi]+=depth*depth;
              if(history[hi]>500000)for(let j=0;j<history.length;j++)history[j]>>=1;
            }
            break;
          }
        }
      }
    }
    ttStore(depth,best>=beta?LOWER:best>a0?EXACT:UPPER,best,bestM,ply);
    return best;
  }

  // ---- interface (boards are the page's {c,t,o} objects) ----
  function load(Bobj,pool,side){
    hLo=0;hHi=0;kingSq[0]=kingSq[1]=-1;
    for(let s=0;s<90;s++){const p=Bobj[s];let v=0;
      if(p){const col=p.c==='b'?BLK:0;
        if(p.t==='?')v=col|HID|KIND[p.o];
        else if(p.t==='X')v=col|XF|KIND[p.o];
        else v=col|KIND[p.t];
        if(p.t==='K')kingSq[col?1:0]=s;
        hLo^=ZL[v*90+s];hHi^=ZH[v*90+s];}
      B[s]=v;}
    for(let c=0;c<2;c++){poolCnt[c].fill(0);poolN[c]=0;poolSum[c]=0;
      const pc=pool?pool[c===0?'r':'b']:null;
      if(pc)for(const t of TYPES){const k=KIND[t],n=pc[t]|0;poolCnt[c][k]=n;poolN[c]+=n;poolSum[c]+=n*VALK[k];}
      recalcEv(c);}
    if(side===1){hLo^=SIDE_L;hHi^=SIDE_H;}   // hash includes side to move (make() toggles it)
    usp=0;
  }
  const cIdx=c=>c==='b'?1:0;
  function legalRoot(c){
    const n=genAllInto(c,MV,0,0),out=[];
    for(let i=0;i<n;i++){const m=MV[i];make(m,0);if(!inCheckC(c))out.push(m);unmake();}
    return out;
  }
  function legalMoves(Bobj,cs){load(Bobj,null);return legalRoot(cIdx(cs));}
  function inCheck(Bobj,cs){load(Bobj,null);return inCheckC(cIdx(cs));}
  function genAll(Bobj,cs){load(Bobj,null);const n=genAllInto(cIdx(cs),MV,0,0);return Array.from(MV.subarray(0,n));}
  function expVal(pc){let n=0,s=0;for(const t of TYPES){n+=pc[t];s+=pc[t]*VAL[t];}return n?s/n:300;}

  // gameHist: earlier positions of this game, oldest first, as [{B, turn}] (only needed back to the
  // last move that involved a face-down piece; earlier positions cannot repeat)
  function analyse(Bobj,cs,pool,timeMs,onDepth,gameHist){
    const c=cIdx(cs);
    histN=0;
    if(gameHist)for(const h of gameHist.slice(-200)){
      const hc=cIdx(h.turn);load(h.B,null,hc);
      seqLo[histN]=hLo;seqHi[histN]=hHi;seqChk[histN]=inCheckC(hc)?1:0;histN++;}
    load(Bobj,pool,c);
    seqLo[histN]=hLo;seqHi[histN]=hHi;seqChk[histN]=inCheckC(c)?1:0;
    let root=legalRoot(c);
    if(!root.length)return{depth:0,list:[],none:true};
    ttLo.fill(0);ttHi.fill(0);ttDepth.fill(0);killers.fill(0);history.fill(0);
    nodes=0;stop=false;deadline=Infinity;
    const t0=Date.now();
    // initial order: captures first
    root.sort((a,b)=>orderScore(b,-1,0,c)-orderScore(a,-1,0,c));
    let result=null;
    for(let d=1;d<=40;d++){
      const res=[],top=[];
      for(const m of root){
        const floor=top.length>=5?top[4]-1:-INF;
        const fr=(m/90)|0,q=B[m%90];let sc;
        if(q&&(q&7)===1&&!(q&(HID|XF)))sc=MATE;
        else if((B[fr]&HID)&&poolN[c]>0){
          // root flip: search every possible reveal exactly, then penalise the downside
          // (a flip that loses a Xe 1 time in 7 is worse than its average says)
          const pc=poolCnt[c],tot=poolN[c],outs=[];let mean=0;
          for(let k=2;k<=7;k++){if(!pc[k])continue;const p=pc[k]/tot;
            make(m,k);const v=Math.max(-VMAX,Math.min(VMAX,-search(d-1,-INF,INF,1,1-c,true)));unmake();
            if(stop)break;outs.push({t:KCH[k],p,score:Math.round(v)});mean+=p*v;}
          if(stop)break;
          let down=0;for(const o of outs)if(o.score<mean)down+=o.p*(mean-o.score)*(mean-o.score);
          const worst=outs.reduce((a,o)=>o.score<a.score?o:a,outs[0]);
          sc=mean-RISK*Math.sqrt(down);
          res.push({m,score:Math.round(sc),mean:Math.round(mean),worst,outs});top.push(sc);top.sort((a,b)=>b-a);
          continue;
        }
        else{make(m,0);sc=-search(d-1,-INF,-floor,1,1-c,true);unmake();}
        if(stop)break;
        res.push({m,score:Math.round(sc)});top.push(sc);top.sort((a,b)=>b-a);
      }
      if(stop)break;
      res.sort((a,b)=>b.score-a.score);
      result={depth:d,list:res,nodes,ms:Date.now()-t0};
      if(onDepth)onDepth(result);
      root=res.map(x=>x.m);
      if(d===1)deadline=t0+timeMs;
      if(Date.now()>deadline||Math.abs(res[0].score)>MATE_BOUND)break;
      // the next depth costs several times this one; don't start what cannot finish
      if(d>=3&&(Date.now()-t0)*2.5>timeMs)break;
    }
    return result;
  }

  return{_tune:(cd,cp)=>{CHANCE_DEPTH=cd;CHANCE_PLY=cp;},setRisk:r=>{RISK=r;},setVariant:v=>{XQ=v==='xiangqi';},VAL,TYPES,MATE,genAll,legalMoves,inCheck,analyse,opp:c=>c==='r'?'b':'r',expVal};
}
if(typeof module!=='undefined')module.exports=ENGINE;
