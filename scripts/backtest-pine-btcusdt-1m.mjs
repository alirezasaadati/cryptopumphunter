import { mkdir, writeFile } from "node:fs/promises";
const API="https://api.bybit.com/v5/market/kline", MIN=60000, FIFTEEN=900000, DAYS=30;
const END=Date.now(), START=END-DAYS*86400000, WARMUP=START-20*86400000;
const FEE=Number(process.env.FEE_RATE??0.00055), SLIP=Number(process.env.SLIPPAGE??0.0002), INITIAL=10000, SIZE=0.10;
async function page(endTime){
 const u=new URL(API); for(const [k,v] of Object.entries({category:"linear",symbol:"BTCUSDT",interval:"1",startTime:String(WARMUP),endTime:String(endTime),limit:"1000"}))u.searchParams.set(k,v);
 const r=await fetch(u,{signal:AbortSignal.timeout(30000)}),t=await r.text(); if(!r.ok)throw Error("Bybit HTTP "+r.status+" "+t.slice(0,160));
 const j=JSON.parse(t);if(j.retCode!==0)throw Error("Bybit "+j.retCode+" "+j.retMsg);
 return (j.result.list||[]).map(x=>({time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5]})).filter(c=>c.time+MIN<=END).sort((a,b)=>a.time-b.time);
}
async function load(){
 const m=new Map();let cursor=END,pages=0,oldest=END;
 while(cursor>WARMUP&&pages<100){const a=await page(cursor);if(!a.length)break;for(const c of a)m.set(c.time,c);oldest=a[0].time;pages++;if(oldest<=WARMUP)break;if(oldest-1>=cursor)throw Error("Pagination stalled");cursor=oldest-1;await new Promise(r=>setTimeout(r,120));}
 const rows=[...m.values()].sort((a,b)=>a.time-b.time);
 if(rows.length<45000)throw Error("Insufficient history: "+rows.length+" candles");
 return {rows,pages};
}
function ema(a,n){const o=Array(a.length).fill(null);if(a.length<n)return o;let v=a.slice(0,n).reduce((x,y)=>x+y,0)/n;o[n-1]=v;const k=2/(n+1);for(let i=n;i<a.length;i++){v=a[i]*k+a[i-1]*0+0;v=a[i]*k+o[i-1]*(1-k);o[i]=v;}return o;}
function sma(a,n){const o=Array(a.length).fill(null);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=n)s-=a[i-n];if(i>=n-1)o[i]=s/n;}return o;}
function pivots(a,n){const hi=Array(a.length).fill(null),lo=Array(a.length).fill(null);for(let i=2*n;i<a.length;i++){const j=i-n,h=a[j].high,l=a[j].low;let H=true,L=true;for(let k=j-n;k<=j+n;k++){if(k===j)continue;if(a[k].high>=h)H=false;if(a[k].low<=l)L=false;}if(H)hi[i]=h;if(L)lo[i]=l;}return {hi,lo};}
function agg15(a){const m=new Map();for(const c of a){const t=Math.floor(c.time/FIFTEEN)*FIFTEEN;let x=m.get(t);if(!x){x={time:t,close:c.close,count:0};m.set(t,x);}x.close=c.close;x.count++;}return [...m.values()].filter(x=>x.count===15).sort((a,b)=>a.time-b.time);}
function stats(ts){let eq=INITIAL,peak=INITIAL,dd=0,gw=0,gl=0;for(const t of ts){eq+=t.net;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak);if(t.net>0)gw+=t.net;else gl-=t.net;}const w=ts.filter(t=>t.net>0).length;return {trades:ts.length,wins:w,losses:ts.length-w,winRate:ts.length?w/ts.length*100:0,profitFactor:gl?gw/gl:(gw?null:0),netPnl:eq-INITIAL,returnPct:(eq/INITIAL-1)*100,maxDrawdownPct:dd*100,endingEquity:eq};}
function test(a,improved){
 const e=ema(a.map(x=>x.close),20),v=sma(a.map(x=>x.volume),20),p=pivots(a,10),f=agg15(a),e50=ema(f.map(x=>x.close),50);
 let r=null,s=null,fi=-1,pos=null;const ts=[],first=a.findIndex(x=>x.time>=START);
 function exit(c,raw,why){const q=pos,entry=q.entry*(q.side==="LONG"?1+SLIP:1-SLIP),out=raw*(q.side==="LONG"?1-SLIP:1+SLIP),qty=q.equity*SIZE/q.entry;
 const gross=q.side==="LONG"?(out-entry)*qty:(entry-out)*qty,fees=(entry+out)*qty*FEE;
 ts.push({side:q.side,signalTime:q.signalTime,entryTime:q.entryTime,exitTime:c.time,entry:q.entry,exit:raw,stop:q.stop,target:q.target,reason:why,gross,fees,net:gross-fees});pos=null;}
 for(let i=0;i<a.length;i++){const c=a[i];while(fi+1<f.length&&f[fi+1].time+FIFTEEN<=c.time+MIN)fi++;if(p.hi[i]!==null)r=p.hi[i];if(p.lo[i]!==null)s=p.lo[i];
 if(pos){const sh=pos.side==="LONG"?c.low<=pos.stop:c.high>=pos.stop,th=pos.side==="LONG"?c.high>=pos.target:c.low<=pos.target;
 if(sh){const gap=pos.side==="LONG"?c.open<=pos.stop:c.open>=pos.stop;exit(c,gap?c.open:pos.stop,"STOP");}else if(th){const gap=pos.side==="LONG"?c.open>=pos.target:c.open<=pos.target;exit(c,gap?c.open:pos.target,"TARGET");}}
 if(i<first||i>=a.length-1||pos||e[i]===null||v[i]===null||fi<0||e50[fi]===null)continue;
 const htf=e50[fi],range=c.high-c.low,body=c.close-c.open,vol=c.volume>v[i]*(improved?2:1.5);
 const bull=body>0&&c.close>e[i]&&body>range*.6,bear=body<0&&c.close<e[i]&&-body>range*.6;
 const nl=s!==null&&c.low<=s*1.001&&c.close>s,nr=r!==null&&c.high>=r*.999&&c.close<r;
 const L=nl&&c.close>e[i]&&(!improved||c.close>htf)&&bull&&vol;
 const S=nr&&c.close<e[i]&&(!improved||c.close<htf)&&bear&&vol;
 const buf=improved?.002:.001,rr=improved?2.5:2,next=a[i+1];
 if(L){const stop=s*(1-buf),risk=c.close-stop;if(risk>0)pos={side:"LONG",signalTime:c.time+MIN,entryTime:next.time,entry:next.open,stop,target:c.close+risk*rr,equity:stats(ts).endingEquity};}
 else if(S){const stop=r*(1+buf),risk=stop-c.close;if(risk>0)pos={side:"SHORT",signalTime:c.time+MIN,entryTime:next.time,entry:next.open,stop,target:c.close-risk*rr,equity:stats(ts).endingEquity};}
 }
 if(pos)exit(a[a.length-1],a[a.length-1].close,"END_OF_DATA");
 return {combined:stats(ts),long:stats(ts.filter(x=>x.side==="LONG")),short:stats(ts.filter(x=>x.side==="SHORT")),trades:ts};
}
async function main(){
 const loaded=await load(),a=loaded.rows,base=test(a,false),imp=test(a,true),period={from:new Date(START).toISOString(),to:new Date(END).toISOString(),days:DAYS};
 const report={venue:"Bybit USDT linear perpetual",symbol:"BTCUSDT",timeframe:"1m",period,data:{candles:a.filter(x=>x.time>=START).length,totalWithWarmup:a.length,pages:loaded.pages},
 assumptions:{entry:"next 1m open",stopTarget:"calculated from signal close",sizing:"10% equity notional",feePerSide:FEE,slippagePerSide:SLIP,funding:"excluded",intrabar:"stop-first when both stop and target touched",htf:"latest fully closed 15m EMA50; no lookahead"},
 baseline:{settings:{volumeMultiplier:1.5,rr:2,slBuffer:.001,htf:false},combined:base.combined,long:base.long,short:base.short},
 improved:{settings:{volumeMultiplier:2,rr:2.5,slBuffer:.002,htf:"15m EMA50"},combined:imp.combined,long:imp.long,short:imp.short,breakEven:"not implemented in supplied code"},
 trades:{baseline:base.trades,improved:imp.trades}};
 await mkdir("artifacts",{recursive:true});await writeFile("artifacts/pine-btcusdt-1m-improved-30d.json",JSON.stringify(report,null,2));
 const lines=["# BTCUSDT 1m Pine backtest: baseline vs improved","", "Period: "+period.from+" to "+period.to,"Candles in test window: "+report.data.candles,"Fees/slippage included as stated assumptions; funding excluded. Stop-first intrabar assumption.","Break-even excluded because it is not implemented in the supplied Pine code.","","| Variant | Side | Trades | Win rate | PF | Net PnL | Return | Max DD |","|---|---|---:|---:|---:|---:|---:|---:|"];
 for(const v of ["baseline","improved"])for(const side of ["combined","long","short"]){const x=report[v][side];lines.push("| "+v+" | "+side+" | "+x.trades+" | "+x.winRate.toFixed(2)+"% | "+(x.profitFactor===null?"∞":x.profitFactor.toFixed(3))+" | $"+x.netPnl.toFixed(2)+" | "+x.returnPct.toFixed(3)+"% | "+x.maxDrawdownPct.toFixed(3)+"% |");}
 lines.push("","Baseline: volume 1.5x, RR 2, SL 0.1%; improved: volume 2x, RR 2.5, SL 0.2%, 15m EMA50 filter.");
 await writeFile("artifacts/pine-btcusdt-1m-improved-30d.md",lines.join("\n"));
 console.log(JSON.stringify({ok:true,period,data:report.data,baseline:{combined:base.combined,long:base.long,short:base.short},improved:{combined:imp.combined,long:imp.long,short:imp.short}},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});