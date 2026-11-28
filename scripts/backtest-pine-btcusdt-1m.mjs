import { mkdir, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const SYMBOL="BTCUSDT", DAYS=30, MINUTE=60000, DAY=86400000;
const INITIAL=10000, SIZE=0.10, EMA_N=20, PIVOT=10, VOL_MULT=1.5, RR=2, SL_BUFFER=0.001;

function unzip(buffer) {
  let e=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65558);i--) if(buffer.readUInt32LE(i)===0x06054b50){e=i;break;}
  if(e<0) throw new Error("Bad ZIP: EOCD missing");
  let p=buffer.readUInt32LE(e+16), count=buffer.readUInt16LE(e+10);
  for(let n=0;n<count;n++){
    if(buffer.readUInt32LE(p)!==0x02014b50) throw new Error("Bad ZIP directory");
    const method=buffer.readUInt16LE(p+10), size=buffer.readUInt32LE(p+20);
    const nl=buffer.readUInt16LE(p+28), el=buffer.readUInt16LE(p+30), cl=buffer.readUInt16LE(p+32), off=buffer.readUInt32LE(p+42);
    const name=buffer.toString("utf8",p+46,p+46+nl);
    if(!name.endsWith("/")){
      const data=off+30+buffer.readUInt16LE(off+26)+buffer.readUInt16LE(off+28);
      const z=buffer.subarray(data,data+size);
      if(method===0)return z.toString("utf8");
      if(method===8)return inflateRawSync(z).toString("utf8");
      throw new Error("Unsupported ZIP method "+method);
    }
    p+=46+nl+el+cl;
  }
  throw new Error("No CSV in ZIP");
}
async function load(){
  const end=Math.floor(Date.now()/DAY)*DAY-2*DAY, start=end-DAYS*DAY, warm=start-300*MINUTE;
  const rows=[];
  for(let day=Math.floor(warm/DAY)*DAY;day<end;day+=DAY){
    const date=new Date(day).toISOString().slice(0,10);
    const url="https://data.binance.vision/data/futures/um/daily/klines/BTCUSDT/1m/BTCUSDT-1m-"+date+".zip";
    const res=await fetch(url,{signal:AbortSignal.timeout(30000)});
    if(!res.ok)throw new Error("Binance archive HTTP "+res.status+" for "+date);
    const csv=unzip(Buffer.from(await res.arrayBuffer()));
    for(const line of csv.trim().split(/\r?\n/)){
      if(!line)continue;const r=line.split(",");
      const c={t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]};
      if(c.t>=warm&&c.t<end&&[c.t,c.o,c.h,c.l,c.c,c.v].every(Number.isFinite))rows.push(c);
    }
  }
  const m=new Map(rows.map(x=>[x.t,x])), candles=[...m.values()].sort((a,b)=>a.t-b.t);
  if(candles.length<30000)throw new Error("Insufficient data: "+candles.length+" 1m candles");
  return {candles,start,end,warm};
}
function pivotAt(c,j,type){
  if(j< PIVOT || j+PIVOT>=c.length)return null;
  const x=type==="H"?c[j].h:c[j].l;
  for(let k=j-PIVOT;k<=j+PIVOT;k++){
    if(k===j)continue;
    if(type==="H" ? c[k].h>=x : c[k].l<=x)return null;
  }
  return x;
}
function exitAt(p,b){
  const path=Math.abs(b.o-b.h)<Math.abs(b.o-b.l)?[b.o,b.h,b.l,b.c]:[b.o,b.l,b.h,b.c];
  if(p.side==="LONG"){
    if(b.o<=p.sl)return {px:b.o,why:"STOP_GAP"}; if(b.o>=p.tp)return {px:b.o,why:"TARGET_GAP"};
    for(let k=1;k<4;k++){const a=path[k-1],z=path[k];if(z<a&&p.sl>=z&&p.sl<=a)return {px:p.sl,why:"STOP"};if(z>a&&p.tp>=a&&p.tp<=z)return {px:p.tp,why:"TARGET"};}
  }else{
    if(b.o>=p.sl)return {px:b.o,why:"STOP_GAP"}; if(b.o<=p.tp)return {px:b.o,why:"TARGET_GAP"};
    for(let k=1;k<4;k++){const a=path[k-1],z=path[k];if(z>a&&p.sl>=a&&p.sl<=z)return {px:p.sl,why:"STOP"};if(z<a&&p.tp<=a&&p.tp>=z)return {px:p.tp,why:"TARGET"};}
  }
  return null;
}
function metrics(ts){
  const w=ts.filter(x=>x.pnl>0),l=ts.filter(x=>x.pnl<0),gp=w.reduce((s,x)=>s+x.pnl,0),gl=-l.reduce((s,x)=>s+x.pnl,0);
  let eq=INITIAL,peak=INITIAL,dd=0;for(const t of ts){eq+=t.pnl;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:ts.length,wins:w.length,losses:l.length,winRatePct:ts.length?100*w.length/ts.length:0,grossProfitUSD:gp,grossLossUSD:gl,profitFactor:gl?gp/gl:gp?null:0,netPnLUSD:eq-INITIAL,returnPct:100*(eq/INITIAL-1),endingEquityUSD:eq,maxDrawdownUSD:dd,maxDrawdownPct:100*dd/peak,expectancyUSD:ts.length?(eq-INITIAL)/ts.length:0};
}
function backtest(c,start){
  const ema=[],avgVol=[];let e=null,sum=0;
  for(let i=0;i<c.length;i++){e=e===null?c[i].c:(2/21)*c[i].c+(19/21)*e;ema[i]=e;sum+=c[i].v;if(i>=20)sum-=c[i-20].v;avgVol[i]=i>=19?sum/20:null;}
  let sup=null,res=null,pos=null,pending=null,eq=INITIAL;const trades=[];
  for(let i=0;i<c.length;i++){
    const b=c[i],occupied=!!pos||!!pending;
    if(pending&&pending.entryIndex===i){const entry=b.o;pos={...pending,entry,qty:eq*SIZE/entry,entryTime:b.t};pending=null;}
    if(pos){const ex=exitAt(pos,b);if(ex){const pnl=(pos.side==="LONG"?ex.px-pos.entry:pos.entry-ex.px)*pos.qty;eq+=pnl;trades.push({side:pos.side,signalTime:pos.signalTime,entryTime:pos.entryTime,exitTime:b.t,signalClose:pos.signalClose,entry:pos.entry,stop:pos.sl,target:pos.tp,exit:ex.px,reason:ex.why,qty:pos.qty,pnl,equity:eq});pos=null;}}
    if(i>=2*PIVOT){const j=i-PIVOT,ph=pivotAt(c,j,"H"),pl=pivotAt(c,j,"L");if(ph!==null)res=ph;if(pl!==null)sup=pl;}
    if(b.t<start||i>=c.length-1||occupied||pos||pending||sup===null||res===null||avgVol[i]===null)continue;
    const range=b.h-b.l;if(range<=0)continue;
    const hv=b.v>avgVol[i]*VOL_MULT;
    const bull=b.c>b.o&&b.c>ema[i]&&(b.c-b.o)>range*.6;
    const bear=b.c<b.o&&b.c<ema[i]&&(b.o-b.c)>range*.6;
    const nearS=b.l<=sup*1.001&&b.c>sup,nearR=b.h>=res*.999&&b.c<res;
    if(nearS&&b.c>ema[i]&&bull&&hv){const sl=sup*(1-SL_BUFFER),risk=b.c-sl;if(risk>0)pending={side:"LONG",signalTime:b.t,signalClose:b.c,sl,tp:b.c+risk*RR,entryIndex:i+1};}
    else if(nearR&&b.c<ema[i]&&bear&&hv){const sl=res*(1+SL_BUFFER),risk=sl-b.c;if(risk>0)pending={side:"SHORT",signalTime:b.t,signalClose:b.c,sl,tp:b.c-risk*RR,entryIndex:i+1};}
  }
  return trades;
}
async function main(){
  const d=await load(),ts=backtest(d.candles,d.start),long=ts.filter(x=>x.side==="LONG"),short=ts.filter(x=>x.side==="SHORT");
  const report={venue:"Binance USDⓈ-M Futures public archive",symbol:"BTCUSDT",timeframe:"1m",period:{from:new Date(d.start).toISOString(),to:new Date(d.end).toISOString(),days:DAYS},data:{candles:d.candles.length,warmupCandles:d.candles.filter(x=>x.t<d.start).length},settings:{ema:20,pivot:10,volumeMultiplier:1.5,rr:2,slBufferPct:.1,positionSizePct:10,initialCapital:INITIAL,fees:0,slippage:0,funding:"excluded"},execution:"Signal at candle close, market entry at next candle open; SL/TP calculated from signal close; TradingView-style OHLC path assumption; zero costs as Pine code specifies.",combined:metrics(ts),long:metrics(long),short:metrics(short),trades:ts};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/pine-btcusdt-1m-30d.json",JSON.stringify(report,null,2));
  const lines=["# Pine BTCUSDT 1m — 30-day backtest","",report.period.from+" → "+report.period.to,"Candles: "+report.data.candles,"","| Metric | Combined | LONG | SHORT |","|---|---:|---:|---:|",...["trades","winRatePct","profitFactor","netPnLUSD","returnPct","maxDrawdownUSD","maxDrawdownPct","expectancyUSD"].map(k=>"| "+k+" | "+[report.combined,report.long,report.short].map(x=>typeof x[k]==="number"?x[k].toFixed(3):x[k]).join(" | ")+" |"),"","Fees/slippage/funding excluded to match the supplied Pine strategy defaults."];
  await writeFile("artifacts/pine-btcusdt-1m-30d.md",lines.join("\n"));
  console.log(JSON.stringify({ok:true,market:report.symbol,timeframe:report.timeframe,period:report.period,data:report.data,combined:report.combined,long:report.long,short:report.short},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
