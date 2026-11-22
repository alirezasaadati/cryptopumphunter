import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://futures.kraken.com";
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const FEE = 0.0005;
const SLIPPAGE = 0.0003;
const SYMBOLS = [
  "PF_XBTUSD","PF_ETHUSD","PF_SOLUSD","PF_XRPUSD","PF_DOGEUSD",
  "PF_ADAUSD","PF_LINKUSD","PF_LTCUSD","PF_BCHUSD","PF_AVAXUSD"
];
const PERIODS = [
  { name: "strong_bullish", label: "بازار صعودی قوی", from: "2024-10-01T00:00:00Z", to: "2024-10-31T00:00:00Z" },
  { name: "sideways_bullish", label: "بازار خنثی متمایل به صعودی", from: "2024-07-01T00:00:00Z", to: "2024-07-31T00:00:00Z" }
];
const CFG = { MIN_CANDLES:100, TARGET_1_R:2, TARGET_2_R:3.5, STOP_BUFFER_ATR:0.2, MAX_RISK_PCT:3, SWING_LOOKBACK:3 };

async function getJson(url) {
  const r = await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(30000)});
  const t=await r.text();
  if(!r.ok) throw new Error("HTTP "+r.status+" "+url+" "+t.slice(0,200));
  const j=JSON.parse(t);
  if(!Array.isArray(j?.candles)) throw new Error("Kraken candles missing: "+url+" "+t.slice(0,200));
  return j;
}
async function candlesFor(symbol,fromMs,toMs) {
  const url=new URL(BASE+"/api/charts/v1/trade/"+encodeURIComponent(symbol)+"/4h");
  url.searchParams.set("from",String(Math.floor(fromMs/1000)));
  url.searchParams.set("to",String(Math.floor(toMs/1000)));
  url.searchParams.set("count","1900");
  const data=await getJson(url);
  const byTime=new Map();
  for(const x of data.candles){
    const time=Number(x.time)<1e12?Number(x.time)*1000:Number(x.time);
    const c={time,open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)};
    if(Number.isFinite(time)&&c.open>0&&c.close>0&&c.low>0&&c.high>=c.low&&time+FOUR_HOURS<=Date.now()) byTime.set(time,c);
  }
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}
function average(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:0;}
function atr(cs,p=14){
  if(cs.length<=p)return null;
  const ranges=[];
  for(let i=1;i<cs.length;i++){const c=cs[i],pc=cs[i-1].close;ranges.push(Math.max(c.high-c.low,Math.abs(c.high-pc),Math.abs(c.low-pc)));}
  return average(ranges.slice(-p));
}
function swings(cs,lookback=3){
  const highs=[],lows=[];
  for(let i=lookback;i<cs.length-lookback;i++){
    let hi=true,lo=true;
    for(let j=i-lookback;j<=i+lookback;j++){if(i===j)continue;if(cs[j].high>=cs[i].high)hi=false;if(cs[j].low<=cs[i].low)lo=false;}
    if(hi)highs.push({index:i,price:cs[i].high});
    if(lo)lows.push({index:i,price:cs[i].low});
  }
  return {highs,lows};
}
function analyze(cs,entryOpen){
  if(cs.length<CFG.MIN_CANDLES)return null;
  const last=cs[cs.length-1],a=atr(cs,14);
  if(!a)return null;
  const {highs,lows}=swings(cs,CFG.SWING_LOOKBACK);
  if(highs.length<2||lows.length<2)return null;
  const lh=highs.at(-1),ph=highs.at(-2),ll=lows.at(-1),pl=lows.at(-2);
  if(!(lh.price>ph.price&&ll.price>pl.price))return null;
  if(lh.index<ll.index)return null;
  const range=lh.price-ll.price;
  const fib50=lh.price-range*0.5,fib618=lh.price-range*0.618;
  if(last.close>fib50||last.close<fib618)return null;
  if(last.close<=last.open)return null;
  const entry=entryOpen;
  const stop=ll.price-a*CFG.STOP_BUFFER_ATR;
  const risk=entry-stop,riskPct=risk/entry*100;
  if(!(risk>0)||riskPct>CFG.MAX_RISK_PCT)return null;
  return {entry,stop,risk,riskPct,target1:entry+risk*CFG.TARGET_1_R,target2:entry+risk*CFG.TARGET_2_R,score:85};
}
function closeResult(entryFill,exitRaw,risk,reason,time,gap=false){
  const exitFill=exitRaw*(1-SLIPPAGE);
  const gross=(exitFill-entryFill)/risk;
  const feeR=FEE*(entryFill+exitFill)/risk;
  return {netR:gross-feeR,reason,exitTime:time,exitPrice:exitRaw,entryFill};
}
function simulate(cs,entryIndex,signal){
  const entryFill=signal.entry*(1+SLIPPAGE);
  const risk=entryFill-signal.stop;
  if(!(risk>0))return null;
  const t1=entryFill+CFG.TARGET_1_R*risk,t2=entryFill+CFG.TARGET_2_R*risk;
  let armed=false;
  for(let i=entryIndex;i<cs.length;i++){
    const b=cs[i];
    if(!armed){
      if(b.open<=signal.stop||b.low<=signal.stop){
        const px=b.open<=signal.stop?b.open:signal.stop;
        return closeResult(entryFill,px,risk,"STOP_BEFORE_T1",b.time);
      }
      if(b.high>=t1){
        armed=true;
        // Conservative ambiguity: after T1, if breakeven and T2 both touched in the same 4h bar, count breakeven.
        if(b.low<=entryFill)return closeResult(entryFill,entryFill,risk,"BREAKEVEN_AFTER_T1",b.time);
        if(b.high>=t2)return closeResult(entryFill,t2,risk,"TP2",b.time);
      }
    }else{
      if(b.open<=entryFill||b.low<=entryFill){
        const px=b.open<=entryFill?b.open:entryFill;
        return closeResult(entryFill,px,risk,"BREAKEVEN_AFTER_T1",b.time);
      }
      if(b.high>=t2)return closeResult(entryFill,t2,risk,"TP2",b.time);
    }
  }
  const last=cs.at(-1);
  const exitFill=last.close*(1-SLIPPAGE);
  const gross=(exitFill-entryFill)/risk,feeR=FEE*(entryFill+exitFill)/risk;
  return {netR:gross-feeR,reason:"OPEN_MARKED_TO_MARKET",exitTime:last.time,exitPrice:last.close,entryFill,open:true,hadT1:armed};
}
function metrics(trades){
  const wins=trades.filter(t=>t.netR>0),loss=trades.filter(t=>t.netR<0),be=trades.filter(t=>Math.abs(t.netR)<1e-9);
  const gw=wins.reduce((s,t)=>s+t.netR,0),gl=Math.abs(loss.reduce((s,t)=>s+t.netR,0));
  let eq=0,peak=0,dd=0;
  for(const t of [...trades].sort((a,b)=>a.entryTime-b.entryTime)){eq+=t.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  return {trades:trades.length,closed:trades.filter(t=>!t.open).length,open:trades.filter(t=>t.open).length,wins:wins.length,losses:loss.length,breakeven:be.length,winRatePct:trades.length?wins.length/trades.length*100:0,netR:trades.reduce((s,t)=>s+t.netR,0),expectancyR:trades.length?trades.reduce((s,t)=>s+t.netR,0)/trades.length:0,profitFactor:gl?gw/gl:gw?null:0,maxDrawdownR:dd,TP2:trades.filter(t=>t.reason==="TP2").length,stopBeforeT1:trades.filter(t=>t.reason==="STOP_BEFORE_T1").length,breakevenAfterT1:trades.filter(t=>t.reason==="BREAKEVEN_AFTER_T1").length};
}
async function testPeriod(period){
  const from=Date.parse(period.from),to=Date.parse(period.to),fetchFrom=from-35*24*3600000;
  const results=[],all=[];
  for(const symbol of SYMBOLS){
    try{
      const cs=await candlesFor(symbol,fetchFrom,to);
      if(cs.length<CFG.MIN_CANDLES+20)throw new Error("insufficient candles "+cs.length);
      const trades=[];let nextAvailable=0;
      for(let i=CFG.MIN_CANDLES-1;i<cs.length-1;i++){
        const bar=cs[i],signalClose=bar.time+FOUR_HOURS;
        if(signalClose<from||signalClose>=to||i<nextAvailable)continue;
        const sig=analyze(cs.slice(0,i+1),cs[i+1].open);
        if(!sig)continue;
        const tr=simulate(cs,i+1,sig);
        if(!tr)continue;
        tr.symbol=symbol;tr.entryTime=cs[i+1].time;tr.signalTime=bar.time;tr.riskPct=sig.riskPct;
        trades.push(tr);all.push(tr);
        if(!tr.open){const exitIndex=cs.findIndex(c=>c.time===tr.exitTime);nextAvailable=Math.max(i+1,exitIndex+1);}
        else nextAvailable=cs.length;
      }
      results.push({symbol,candles:cs.length,metrics:metrics(trades),trades});
    }catch(e){results.push({symbol,error:e.message,metrics:metrics([]),trades:[]});}
  }
  const btc=results.find(x=>x.symbol==="PF_XBTUSD");
  const btcCs=btc?.trades?null:null;
  const btcCandles=await candlesFor("PF_XBTUSD",from,to);
  const first=btcCandles.find(c=>c.time>=from),last=[...btcCandles].reverse().find(c=>c.time+FOUR_HOURS<=to);
  const btcReturnPct=first&&last?(last.close/first.open-1)*100:null;
  return {name:period.name,label:period.label,period:{from:period.from,to:period.to},btcReturnPct,universe:SYMBOLS,metrics:metrics(all),symbols:results.map(({trades,...x})=>x),trades:all};
}
async function main(){
  const reports=[];
  for(const p of PERIODS)reports.push(await testPeriod(p));
  await mkdir("artifacts",{recursive:true});
  const report={version:"8.0.0 LONG 4H Structure + Fib",generatedAt:new Date().toISOString(),exchange:"Kraken Futures",timeframe:"4h",rules:{entry:"next 4h candle open after a fully closed signal candle",swingConfirmation:"swing points require 3 candles on both sides; only confirmed points are available at signal time",stop:"last confirmed swing low minus 0.2 ATR",TP1:"2R triggers stop move to breakeven; no partial take-profit was specified in user code, so position remains full size",TP2:"3.5R closes full position",sameCandle:"conservative stop/breakeven-first ambiguity",fees:"0.05% each side",slippage:"0.03% adverse each side",funding:"excluded",overlap:"one open trade per symbol; open trades at period end marked to market"},periods:reports};
  await writeFile("artifacts/v800-long-4h-report.json",JSON.stringify(report,null,2));
  const lines=["# v8.0.0 LONG 4H Structure + Fibonacci — Historical Backtest","","Universe: 10 liquid USD perpetual contracts. Signal timeframe: 4h.","Fees 0.05%/side; adverse slippage 0.03%/side; funding excluded.","Entry at next 4h open. TP1 at 2R moves stop to breakeven; no partial close was specified, so full size remains until breakeven or TP2 at 3.5R.",""];
  for(const p of reports){
    const m=p.metrics;
    lines.push("## "+p.label,"","Period: "+p.period.from+" to "+p.period.to,"BTC change: "+(p.btcReturnPct===null?"n/a":p.btcReturnPct.toFixed(2)+"%"),"",
      "| Metric | Result |","|---|---:|",
      "| Trades | "+m.trades+" |","| Closed / open | "+m.closed+" / "+m.open+" |","| Wins / losses / breakeven | "+m.wins+" / "+m.losses+" / "+m.breakeven+" |","| Win rate | "+m.winRatePct.toFixed(2)+"% |","| Net result | "+m.netR.toFixed(2)+"R |","| Expectancy | "+m.expectancyR.toFixed(3)+"R |","| Profit factor | "+(m.profitFactor===null?"n/a":m.profitFactor.toFixed(2))+" |","| Max drawdown | "+m.maxDrawdownR.toFixed(2)+"R |","| TP2 / stop before T1 / breakeven after T1 | "+m.TP2+" / "+m.stopBeforeT1+" / "+m.breakevenAfterT1+" |","",
      "| Symbol | Trades | Wins | Losses | Net R | PF |","|---|---:|---:|---:|---:|---:|",
      ...p.symbols.map(s=>"| "+s.symbol+" | "+s.metrics.trades+" | "+s.metrics.wins+" | "+s.metrics.losses+" | "+s.metrics.netR.toFixed(2)+" | "+(s.metrics.profitFactor===null?"n/a":s.metrics.profitFactor.toFixed(2))+" |"),"");
  }
  await writeFile("artifacts/v800-long-4h-report.md",lines.join("\n"));
  console.log(JSON.stringify(reports.map(p=>({name:p.name,btcReturnPct:p.btcReturnPct,metrics:p.metrics,symbols:p.symbols})),null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

