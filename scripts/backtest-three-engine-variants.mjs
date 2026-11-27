import { mkdir, writeFile } from "node:fs/promises";
import { analyzeFuturesSymbol, FUTURES_CONFIG } from "../src/index.js";
import { evaluateStagedTradeCandle, FUTURES_TRADE_LEVERAGE } from "../src/futures-trade-lifecycle.js";

const BASE = "https://futures.kraken.com";
const MS = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const DAYS = Math.max(30, Math.min(90, Number(process.env.BACKTEST_DAYS || 60)));
const SYMBOL_LIMIT = Math.max(3, Math.min(12, Number(process.env.BACKTEST_SYMBOLS || 10)));
const WARMUP_DAYS = 20;
const END_OFFSET_DAYS = Math.max(0, Math.min(180, Number(process.env.BACKTEST_END_OFFSET_DAYS || 0)));
const REPORT_TAG = String(process.env.BACKTEST_REPORT_TAG || "three-engine-backtest").replace(/[^a-z0-9_-]/gi, "-");
const LEVERAGE = FUTURES_TRADE_LEVERAGE;
const FEE = Math.max(0, Number(process.env.BACKTEST_FEE_PER_SIDE || 0.0005));
const SLIPPAGE = Math.max(0, Number(process.env.BACKTEST_SLIPPAGE_PER_SIDE || 0.0003));
const MAX_MARGIN_LOSS_PCT = 10;
const COMBINED_MIN_QUALITY = 40;

async function getJson(url, attempt = 0) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) {
    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 160));
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Invalid JSON from " + url); }
  if (data?.result === "error" || (Array.isArray(data?.errors) && data.errors.length)) throw new Error("Kraken API error: " + JSON.stringify(data.errors || data.error));
  return data;
}

function normalizeCandles(rows, intervalMs) {
  if (!Array.isArray(rows)) throw new Error("Kraken candles array missing");
  const seen = new Set();
  return rows.map(row => ({
    time: Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time),
    open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume)
  })).filter(c =>
    Number.isFinite(c.time) && [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.high >= c.low && c.volume >= 0 &&
    c.time + intervalMs <= Date.now()
  ).sort((a,b)=>a.time-b.time).filter(c => {
    if (seen.has(c.time)) return false;
    seen.add(c.time); return true;
  });
}

async function fetchHistoricalCandles(symbol, resolution, fromMs, toMs) {
  const intervalMs = MS[resolution], chunkMs = intervalMs * 1700, combined = [];
  for (let start = fromMs; start < toMs; start += chunkMs) {
    const end = Math.min(toMs, start + chunkMs);
    const url = new URL(BASE + "/api/charts/v1/trade/" + encodeURIComponent(symbol) + "/" + resolution);
    url.searchParams.set("from", String(Math.floor(start / 1000)));
    url.searchParams.set("to", String(Math.floor(end / 1000)));
    url.searchParams.set("count", "1800");
    const data = await getJson(url);
    if (data.more_candles === true) throw new Error(symbol + " " + resolution + ": incomplete chunk from Kraken");
    combined.push(...normalizeCandles(data.candles, intervalMs));
  }
  const byTime = new Map(combined.map(c => [c.time,c]));
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

function lowerBound(rows, time) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo;
}
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i=period;i<values.length;i++) value = values[i] * k + value * (1-k);
  return value;
}
function historicalChange(rows, index) {
  const old = rows[index - 24], now = rows[index];
  return !old || old.close <= 0 ? 0 : (now.close / old.close - 1) * 100;
}
function futuresRegimeFromCandles(rows) {
  if (!Array.isArray(rows) || rows.length < 55) return "UNKNOWN";
  const closes = rows.map(c=>c.close), e20=ema(closes,20), e50=ema(closes,50), p=closes.at(-1);
  if (![e20,e50,p].every(Number.isFinite)) return "UNKNOWN";
  if (p > e50 && e20 > e50) return "BULL";
  if (p < e50 && e20 < e50) return "BEAR";
  return "NEUTRAL";
}
function roomToNearestLevelR(side, candles4h, entry, risk) {
  const rows = candles4h.slice(-40);
  let nearest = null;
  for (let i=2;i<rows.length-2;i++) {
    if (side === "LONG") {
      const h=rows[i].high;
      const pivot=h>=rows[i-1].high&&h>=rows[i-2].high&&h>=rows[i+1].high&&h>=rows[i+2].high;
      if (pivot&&h>entry*1.001&&(nearest===null||h<nearest)) nearest=h;
    } else {
      const l=rows[i].low;
      const pivot=l<=rows[i-1].low&&l<=rows[i-2].low&&l<=rows[i+1].low&&l<=rows[i+2].low;
      if (pivot&&l<entry*0.999&&(nearest===null||l>nearest)) nearest=l;
    }
  }
  return nearest===null?Infinity:Math.abs(nearest-entry)/risk;
}
function computeFileQuality({side,candles1h,candles4h,last,entry,risk,atr,e20,rsiValue,volumeRatio,change,strictSetup,regime}) {
  const isLong=side==="LONG", notes=[];
  let q=0;
  if (strictSetup) q+=20; else { q+=5; notes.push("4h trend not aligned"); }
  const aligned=(isLong&&regime==="BULL")||(!isLong&&regime==="BEAR");
  const opposed=(isLong&&regime==="BEAR")||(!isLong&&regime==="BULL");
  if(aligned)q+=15; else if(!opposed)q+=7;
  else notes.push(isLong?"BTC regime bearish against LONG":"BTC regime bullish against SHORT");
  const ext=(isLong?entry-e20:e20-entry)/atr;
  if(ext<=1)q+=15; else if(ext<=2)q+=8; else if(ext<=3)q+=3; else notes.push("late entry / extended from EMA20");
  const range=last.high-last.low, pos=range>0?(last.close-last.low)/range:0.5, directionalPos=isLong?pos:1-pos;
  if(directionalPos>=0.7)q+=10; else if(directionalPos>=0.5)q+=5; else notes.push("weak signal candle close");
  if(volumeRatio>=1.5)q+=10; else if(volumeRatio>=1)q+=6; else if(volumeRatio>=0.75)q+=3;
  const ref=candles1h.slice(-21,-1);
  const brokeOut=isLong?last.close>Math.max(...ref.map(c=>c.high)):last.close<Math.min(...ref.map(c=>c.low));
  const breakout=brokeOut&&volumeRatio>=1.3;
  const pullback=candles1h.slice(-4).some(c=>isLong?c.low<=e20+0.3*atr:c.high>=e20-0.3*atr)&&
    (isLong?last.close>last.open:last.close<last.open);
  if(breakout||pullback)q+=10; else notes.push("no volume breakout or confirmed pullback");
  const room=roomToNearestLevelR(side,candles4h,entry,risk);
  if(room>=2)q+=10; else if(room>=1.5)q+=6; else if(room>=1)q+=2;
  else notes.push(isLong?"near 4h resistance":"near 4h support");
  if(isLong){if(change>8)notes.push("24h pump >8%; reversal risk");else if(change>=-3&&change<=6)q+=5;else q+=2;}
  else {if(change< -8)notes.push("24h dump <-8%; reversal risk");else if(change<=3&&change>=-6)q+=5;else q+=2;}
  if(isLong?(rsiValue>=52&&rsiValue<=65):(rsiValue>=35&&rsiValue<=48))q+=5;
  q=Math.max(0,Math.min(100,Math.round(q)));
  return {quality:q,opposed,notes,roomR:Number.isFinite(room)?Number(room.toFixed(2)):null,breakout,pullback};
}

function applyFileLogic(candidate,candles1h,candles4h,regime) {
  const side=candidate.side, last=candles1h.at(-1), entry=Number(candidate.entry), atr=Number(candidate.atr);
  let stop=Number(candidate.stop);
  if(side==="LONG"){
    const structLow=Math.min(...candles1h.slice(-13,-1).map(c=>c.low));
    const widened=Math.min(stop,structLow-atr*0.15);
    if((entry-widened)/entry<=0.08)stop=widened;
  }
  const risk=side==="LONG"?entry-stop:stop-entry, riskPct=risk/entry;
  if(!(risk>0)||riskPct<0.002||riskPct>0.08)return {...candidate,eligible:false,rejected:"file structural stop outside allowed risk"};
  const closes4h=candles4h.map(c=>c.close), e20_4h=ema(closes4h,20), e50_4h=ema(closes4h,50);
  const e20=Number(candidate.ema20), e50=Number(candidate.ema50), rsiValue=Number(candidate.rsi);
  const up1h=e20>e50&&last.close>e20, down1h=e20<e50&&last.close<e20;
  const up4h=e20_4h>e50_4h, down4h=e20_4h<e50_4h;
  const strictSetup=side==="LONG"
    ? up1h&&up4h&&rsiValue>=48&&rsiValue<=69
    : down1h&&down4h&&rsiValue>=31&&rsiValue<=52;
  const q=computeFileQuality({side,candles1h,candles4h,last,entry,risk,atr,e20,rsiValue,
    volumeRatio:Number(candidate.volumeRatio)||0,change:Number(candidate.change24h)||0,strictSetup,regime});
  const direction=side==="LONG"?1:-1;
  return {...candidate,stop,target1:entry+direction*risk*1.5,target2:entry+direction*risk*2.5,
    target3:entry+direction*risk*3.5,quality:q.quality,qualityNotes:q.notes,qualityOpposed:q.opposed,
    roomR:q.roomR,breakout:q.breakout,pullback:q.pullback,regime,
    fileTier:q.opposed||q.quality<40?"HIGH_RISK":q.quality>=70?"STRONG":"NORMAL"};
}

function estimatedMarginLossPct(entry,stop) {
  const riskPct=Math.abs(entry-stop)/entry;
  const roundTripCostFraction=(FEE+SLIPPAGE)*(entry+stop)/entry;
  return (riskPct+roundTripCostFraction)*LEVERAGE*100;
}
function priceReturnMarginPct(side,entry,exit) {
  const dir=side==="LONG"?1:-1;
  return dir*(exit-entry)/entry*100*LEVERAGE;
}
function executionNetForFill(side,entry,exit,fraction) {
  const gross=fraction*priceReturnMarginPct(side,entry,exit);
  const costs=fraction*((FEE+SLIPPAGE)*(entry+exit)/entry)*LEVERAGE*100;
  return {gross,costs,net:gross-costs};
}

function simulateTrade(candidate,fiveMinute,signalCloseTime,toMs) {
  const entry=Number(candidate.entry), stop=Number(candidate.stop), side=candidate.side;
  const dir=side==="LONG"?1:-1, risk=Math.abs(entry-stop);
  const targets=[1.5,2.5,3.5].map(r=>entry+dir*risk*r);
  const trade={status:"OPEN",side,entry,actualEntry:entry,initialStop:stop,currentStop:stop,
    tpHits:[],remainingFraction:1,realizedMarginReturnPct:0};
  let net=0,gross=0,ambiguous=0,closed=false;
  let index=lowerBound(fiveMinute,signalCloseTime);
  for(;index<fiveMinute.length&&fiveMinute[index].time<toMs;index++){
    const bar=fiveMinute[index], before={...trade,tpHits:[...trade.tpHits]};
    const stop=Number(trade.initialStop), pending=targets.filter((t,i)=>!before.tpHits.includes("TP"+(i+1)));
    const stopHit=side==="LONG"?bar.low<=stop:bar.high>=stop;
    const profitHit=pending.some(t=>side==="LONG"?bar.high>=t:bar.low<=t);
    const stopAtOpen=side==="LONG"?bar.open<=stop:bar.open>=stop;
    const profitAtOpen=pending.some(t=>side==="LONG"?bar.open>=t:bar.open<=t);
    if(stopHit&&profitHit&&!stopAtOpen&&!profitAtOpen)ambiguous++;
    const result=evaluateStagedTradeCandle(trade,{...bar,time:bar.time+MS["5m"]});
    const next=result.trade||trade;
    const newHits=(next.tpHits||[]).filter(x=>!before.tpHits.includes(x));
    let remaining=Number(before.remainingFraction??1);
    for(const name of newHits){
      const i=Number(name.replace("TP",""))-1, target=targets[i];
      const favorableGap=side==="LONG"?bar.open>=target:bar.open<=target;
      const fill=favorableGap?bar.open:target;
      const fraction=i<2?1/3:remaining;
      const f=executionNetForFill(side,entry,fill,fraction);net+=f.net;gross+=f.gross;
      remaining=Math.max(0,remaining-fraction);
    }
    if(result.closed&&result.reason==="CLOSED_STOP"){
      const fraction=Number(before.remainingFraction??1),exit=Number(next.exitPrice);
      const f=executionNetForFill(side,entry,exit,fraction);net+=f.net;gross+=f.gross;
    }
    Object.assign(trade,next);
    if(result.closed){
      trade.status=result.reason;
      trade.closedAtMs=bar.time+MS["5m"];
      trade.marginReturnPercent=net;
      trade.grossMarginReturnPct=gross;
      trade.ambiguousCandles=ambiguous;
      closed=true;break;
    }
  }
  if(!closed){
    const mark=fiveMinute.at(-1)?.close??entry,remaining=Number(trade.remainingFraction??1);
    const f=executionNetForFill(side,entry,mark,remaining);
    trade.status="OPEN_AT_BACKTEST_END";
    trade.lastMark=mark;
    trade.unrealizedRemainingMarginReturnPct=f.net;
    trade.marginReturnAtMarkPct=net+f.net;
    trade.marginReturnPercent=net+f.net;
    trade.grossMarginReturnPct=gross+f.gross;
    trade.closedAtMs=toMs;
    trade.ambiguousCandles=ambiguous;
  }
  trade.netMarginReturnPct=trade.marginReturnPercent;
  trade.estimatedStopLossMarginPct=estimatedMarginLossPct(entry,stop);
  trade.signalCloseTime=signalCloseTime;
  return trade;
}

function summarize(trades) {
  const resolved=trades.filter(t=>t.status==="CLOSED_PROFIT"||t.status==="CLOSED_STOP");
  const wins=resolved.filter(t=>t.marginReturnPercent>0),losses=resolved.filter(t=>t.marginReturnPercent<0);
  const grossWin=wins.reduce((s,t)=>s+t.marginReturnPercent,0);
  const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.marginReturnPercent,0));
  let equity=0,peak=0,maxDrawdown=0;
  for(const t of [...resolved].sort((a,b)=>a.closedAtMs-b.closedAtMs)){equity+=t.marginReturnPercent;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);}
  const side=key=>{const xs=resolved.filter(t=>t.side===key),w=xs.filter(t=>t.marginReturnPercent>0),l=xs.filter(t=>t.marginReturnPercent<0);
    return {trades:xs.length,wins:w.length,losses:l.length,winRatePct:xs.length?w.length/xs.length*100:0,
      netMarginReturnPct:xs.reduce((s,t)=>s+t.marginReturnPercent,0),
      averageMarginReturnPct:xs.length?xs.reduce((s,t)=>s+t.marginReturnPercent,0)/xs.length:0,
      stopCloses:xs.filter(t=>t.status==="CLOSED_STOP").length,
      lossesOver10PctMargin:l.filter(t=>Math.abs(t.marginReturnPercent)>10).length};};
  return {tradesStarted:trades.length,closedTrades:resolved.length,openAtEnd:trades.length-resolved.length,
    wins:wins.length,losses:losses.length,winRatePct:resolved.length?wins.length/resolved.length*100:0,
    netMarginReturnPct:resolved.reduce((s,t)=>s+t.marginReturnPercent,0),
    averageMarginReturnPct:resolved.length?resolved.reduce((s,t)=>s+t.marginReturnPercent,0)/resolved.length:0,
    averageLossPct:losses.length?losses.reduce((s,t)=>s+t.marginReturnPercent,0)/losses.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:grossWin?null:0,maxDrawdownMarginPct:maxDrawdown,
    lossesOver10PctMargin:losses.filter(t=>Math.abs(t.marginReturnPercent)>10).length,
    bySide:{LONG:side("LONG"),SHORT:side("SHORT")}};
}

function simulatePortfolio(trades,initialCapital=100,marginPerTrade=10) {
  const events=[];
  for(const t of trades){events.push({time:t.signalCloseTime,type:"ENTRY",trade:t});if(t.status!=="OPEN_AT_BACKTEST_END")events.push({time:t.closedAtMs,type:"EXIT",trade:t});}
  events.sort((a,b)=>a.time-b.time||(a.type===b.type?0:a.type==="EXIT"?-1:1));
  let free=initialCapital,used=0,peak=initialCapital,maxDD=0,realized=0,accepted=0,skipped=0,maxConcurrent=0;
  const active=new Map();
  for(const e of events){const t=e.trade;if(e.type==="ENTRY"){if(free+1e-9<marginPerTrade){skipped++;continue;}free-=marginPerTrade;used+=marginPerTrade;active.set(t, t);accepted++;maxConcurrent=Math.max(maxConcurrent,active.size);}
    else if(active.has(t)){const pnl=marginPerTrade*t.marginReturnPercent/100;free+=marginPerTrade+pnl;used-=marginPerTrade;realized+=pnl;active.delete(t);const eq=free+used;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq);}}
  let openPnl=0;for(const t of active.keys())openPnl+=marginPerTrade*Number(t.marginReturnAtMarkPct||0)/100;
  return {initialCapitalUSD:initialCapital,marginPerTradeUSD:marginPerTrade,leverage:LEVERAGE,acceptedTrades:accepted,
    skippedForInsufficientMargin:skipped,maxConcurrentPositions:maxConcurrent,realizedNetPnlUSD:realized,
    openMarkToMarketPnlUSD:openPnl,endingEquityUSD:free+used+openPnl,netReturnPct:((free+used+openPnl)/initialCapital-1)*100,
    maxDrawdownUSD:maxDD,openPositions:active.size};
}

async function backtestSymbol(ticker,btc4h,fromMs,toMs) {
  const [h1,h4,m15,m5]=await Promise.all([
    fetchHistoricalCandles(ticker.symbol,"1h",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"4h",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"15m",fromMs,toMs),
    fetchHistoricalCandles(ticker.symbol,"5m",fromMs,toMs)
  ]);
  if(h1.length<100||h4.length<FUTURES_CONFIG.MIN_CANDLES||m15.length<120||m5.length<1000)
    throw new Error("insufficient candles: 1h="+h1.length+", 4h="+h4.length+", 15m="+m15.length+", 5m="+m5.length);
  const modes={};
  for(const name of ["current","file","combined"])for(const cap of ["uncapped","cap10"]){
    modes[name+"_"+cap]={name,cap,signals:0,qualityRejected:0,qualityRejectedLong:0,qualityRejectedShort:0,riskCapRejected:0,riskCapRejectedLong:0,riskCapRejectedShort:0,skippedByLock:0,rejected:0,trades:[],lockUntil:new Map()};
  }
  let h4Index=0,m15Index=0,btcIndex=0;
  const testStart=toMs-DAYS*86400000;
  for(let i=60;i<h1.length-1;i++){
    const signalBar=h1[i],signalCloseTime=signalBar.time+MS["1h"];
    if(signalCloseTime<testStart||signalCloseTime>=toMs)continue;
    while(h4Index<h4.length&&h4[h4Index].time+MS["4h"]<=signalCloseTime)h4Index++;
    while(m15Index<m15.length&&m15[m15Index].time+MS["15m"]<=signalCloseTime)m15Index++;
    while(btcIndex<btc4h.length&&btc4h[btcIndex].time+MS["4h"]<=signalCloseTime)btcIndex++;
    const closed4h=h4.slice(0,h4Index),closed15=m15.slice(Math.max(0,m15Index-120),m15Index),closedBtc=btc4h.slice(0,btcIndex);
    if(closed4h.length<FUTURES_CONFIG.MIN_CANDLES||closed15.length<40)continue;
    const next=h1[i+1],tickerAtSignal={symbol:ticker.symbol,last:next.open,quoteVolume:Number(ticker.volumeQuote)||0,
      priceChangePercent:historicalChange(h1,i),premium:{lastFundingRate:null}};
    let base;
    try{base=analyzeFuturesSymbol(tickerAtSignal,h1.slice(0,i+1),closed4h,closed15);}
    catch{for(const m of Object.values(modes))m.rejected++;continue;}
    if(!base||base.eligible!==true||!["LONG","SHORT"].includes(base.side)){for(const m of Object.values(modes))m.rejected++;continue;}
    const regime=futuresRegimeFromCandles(closedBtc);
    const fileCandidate=applyFileLogic(base,h1.slice(0,i+1),closed4h,regime);
    const candidates={current:base,file:fileCandidate,combined:fileCandidate};
    for(const name of ["current","file","combined"]){
      const c=candidates[name];
      for(const cap of ["uncapped","cap10"]){
        const state=modes[name+"_"+cap];
        if(name==="combined"&&(c.quality<COMBINED_MIN_QUALITY||c.qualityOpposed)){state.qualityRejected++;if(c.side==="LONG")state.qualityRejectedLong++;else state.qualityRejectedShort++;continue;}
        if(c.eligible!==true){state.rejected++;continue;}
        state.signals++;
        if(cap==="cap10"&&estimatedMarginLossPct(c.entry,c.stop)>MAX_MARGIN_LOSS_PCT){state.riskCapRejected++;if(c.side==="LONG")state.riskCapRejectedLong++;else state.riskCapRejectedShort++;continue;}
        const lockKey=ticker.symbol+"|"+c.side;
        if((state.lockUntil.get(lockKey)||0)>signalCloseTime){state.skippedByLock++;continue;}
        const trade=simulateTrade(c,m5,signalCloseTime,toMs);
        trade.id=ticker.symbol+":"+c.side+":"+signalCloseTime;
        trade.symbol=ticker.symbol;trade.side=c.side;trade.score=c.score;trade.quality=c.quality??null;
        trade.regime=regime;trade.riskPct=Math.abs(c.entry-c.stop)/c.entry*100;
        trade.entryTime=signalCloseTime;
        state.trades.push(trade);
        state.lockUntil.set(lockKey,trade.status==="OPEN_AT_BACKTEST_END"?toMs:trade.closedAtMs);
      }
    }
  }
  const output={symbol:ticker.symbol,candles:{h1:h1.length,h4:h4.length,m15:m15.length,m5:m5.length}};
  for(const key of Object.keys(modes)){
    const s=modes[key];
    output[key]={signals:s.signals,qualityRejected:s.qualityRejected,qualityRejectedLong:s.qualityRejectedLong,qualityRejectedShort:s.qualityRejectedShort,riskCapRejected:s.riskCapRejected,riskCapRejectedLong:s.riskCapRejectedLong,riskCapRejectedShort:s.riskCapRejectedShort,
      skippedByLock:s.skippedByLock,rejected:s.rejected,metrics:summarize(s.trades),portfolio:simulatePortfolio(s.trades),
      trades:s.trades};
  }
  return output;
}

async function main(){
  const endMs=Number(process.env.BACKTEST_END_MS|| (Date.now()-END_OFFSET_DAYS*86400000)),startMs=endMs-DAYS*86400000,fromMs=startMs-WARMUP_DAYS*86400000;
  const tickersData=await getJson(BASE+"/derivatives/api/v3/tickers");
  if(!Array.isArray(tickersData?.tickers))throw new Error("Kraken tickers response invalid");
  const eligible=tickersData.tickers.filter(t=>t?.tag==="perpetual"&&t.suspended!==true&&/^(PI|PF)_[A-Z0-9]+USD$/.test(String(t.symbol||""))&&Number(t.volumeQuote)>=FUTURES_CONFIG.MIN_QUOTE_VOLUME&&Number(t.last)>0);
  const btc=eligible.find(t=>t.symbol==="PF_XBTUSD")||eligible.find(t=>t.symbol==="PI_XBTUSD");
  if(!btc)throw new Error("Kraken BTC perpetual unavailable for market-regime filter");
  const universe=String(process.env.BACKTEST_SYMBOLS_LIST||"").split(",").map(s=>s.trim()).filter(Boolean).length
    ? String(process.env.BACKTEST_SYMBOLS_LIST).split(",").map(s=>eligible.find(t=>t.symbol===s.trim())).filter(Boolean)
    : eligible.sort((a,b)=>Number(b.volumeQuote)-Number(a.volumeQuote)).slice(0,SYMBOL_LIMIT);
  if(!universe.length)throw new Error("No eligible Kraken perpetual contracts found");
  const btc4h=await fetchHistoricalCandles(btc.symbol,"4h",fromMs,endMs);
  const results=[];
  for(const ticker of universe){
    try{results.push(await backtestSymbol(ticker,btc4h,fromMs,endMs));}
    catch(error){results.push({symbol:ticker.symbol,error:String(error?.message||error)});}
  }
  const variants={};
  for(const key of ["current_uncapped","file_uncapped","combined_uncapped","current_cap10","file_cap10","combined_cap10"]){
    const trades=results.filter(r=>!r.error).flatMap(r=>r[key].trades).sort((a,b)=>a.signalCloseTime-b.signalCloseTime);
    variants[key]={signals:results.reduce((n,r)=>n+Number(r[key]?.signals||0),0),
      qualityRejected:results.reduce((n,r)=>n+Number(r[key]?.qualityRejected||0),0),
      qualityRejectedLong:results.reduce((n,r)=>n+Number(r[key]?.qualityRejectedLong||0),0),
      qualityRejectedShort:results.reduce((n,r)=>n+Number(r[key]?.qualityRejectedShort||0),0),
      riskCapRejected:results.reduce((n,r)=>n+Number(r[key]?.riskCapRejected||0),0),
      riskCapRejectedLong:results.reduce((n,r)=>n+Number(r[key]?.riskCapRejectedLong||0),0),
      riskCapRejectedShort:results.reduce((n,r)=>n+Number(r[key]?.riskCapRejectedShort||0),0),
      skippedByLock:results.reduce((n,r)=>n+Number(r[key]?.skippedByLock||0),0),
      metrics:summarize(trades),portfolio:simulatePortfolio(trades)};
  }
  const report={generatedAt:new Date().toISOString(),venue:"Kraken Futures historical OHLC",
    period:{from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),days:DAYS,endOffsetDays:END_OFFSET_DAYS,warmupDays:WARMUP_DAYS},
    settings:{symbolsRequested:universe.length,symbolsTested:results.filter(r=>!r.error).length,leverage:LEVERAGE,
      feePerSidePct:FEE*100,slippagePerSidePct:SLIPPAGE*100,maxPlannedLossOnMarginPct:MAX_MARGIN_LOSS_PCT,
      combinedQualityFloor:COMBINED_MIN_QUALITY,execution:"closed 1h/4h/15m signal; next 1h open; 5m staged exits at 1.5R/2.5R/3.5R; 1/3,1/3,remainder",
      lifecycle:"uses production evaluateStagedTradeCandle; no automatic break-even movement",
      stopTargetAmbiguity:"stop first on same 5m candle unless gap at open proves otherwise",
      funding:"excluded; fee and slippage are assumptions, not account-specific exchange rates",
      universe:"top current Kraken perpetuals by current quote volume; survivorship bias applies",
      fileLogic:"attached pasted source: LONG structural low over 12 prior 1h candles minus 0.15 ATR; quality score weights and BTC 4h regime",
      combinedLogic:"file logic plus hard gate quality >= 40 and no BTC regime opposition",
      riskCapLogic:"at 10x, planned stop loss including estimated round-trip fee/slippage must be <=10% of used margin; otherwise signal excluded"},
    variants,symbols:results.map(r=>{if(r.error)return r;const x={symbol:r.symbol,candles:r.candles};for(const k of ["current_uncapped","file_uncapped","combined_uncapped","current_cap10","file_cap10","combined_cap10"]){const {trades,...summary}=r[k];x[k]=summary;}return x;})};
  await mkdir("artifacts",{recursive:true});
  await writeFile("artifacts/"+REPORT_TAG+".json",JSON.stringify(report,null,2));
  const keys=["current_uncapped","file_uncapped","combined_uncapped","current_cap10","file_cap10","combined_cap10"];
  const lines=["# Three-way Kraken Futures signal-engine backtest","",
    "Period: "+report.period.from+" to "+report.period.to+" ("+DAYS+" days)",
    "Symbols tested: "+report.settings.symbolsTested+"/"+report.settings.symbolsRequested,
    "Leverage: "+LEVERAGE+"x; fee/side: "+(FEE*100)+"%; slippage/side: "+(SLIPPAGE*100)+"%; funding excluded.",
    "The capped rows require planned stop loss plus estimated round-trip costs <=10% of used margin.","",
    "| Variant | Signals | Risk-cap rejects | Trades | Win % | Net margin % points | Avg/trade | Avg loss | PF | Max DD | LONG net | SHORT net |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for(const k of keys){const v=variants[k],m=v.metrics;lines.push("| "+k+" | "+v.signals+" | "+v.riskCapRejected+" | "+m.closedTrades+" | "+m.winRatePct.toFixed(1)+" | "+m.netMarginReturnPct.toFixed(2)+" | "+m.averageMarginReturnPct.toFixed(2)+" | "+m.averageLossPct.toFixed(2)+" | "+(m.profitFactor===null?"n/a":m.profitFactor.toFixed(2))+" | "+m.maxDrawdownMarginPct.toFixed(2)+" | "+m.bySide.LONG.netMarginReturnPct.toFixed(2)+" | "+m.bySide.SHORT.netMarginReturnPct.toFixed(2)+" |");}
  lines.push("","## Data and execution caveats","- Kraken current liquid perpetual universe; survivorship/universe bias applies.",
    "- Historical funding is unavailable in this run and excluded.",
    "- 5m OHLC cannot reveal exact intrabar path; conservative stop-first rule is used.",
    "- Fees and slippage are explicit assumptions and actual fills can exceed the planned 10% margin-loss cap.",
    "- The file-as-is variant labels quality but does not reject low-quality/opposed signals; the combined variant turns the file's weak-quality boundary (40) and BTC opposition into a hard gate.",
    "- This is a historical simulation, not a live-performance guarantee.");
  await writeFile("artifacts/"+REPORT_TAG+".md",lines.join("\n"));
  console.log(JSON.stringify({ok:results.some(r=>!r.error),period:report.period,settings:report.settings,variants,symbolErrors:results.filter(r=>r.error).map(r=>({symbol:r.symbol,error:r.error}))},null,2));
  if(!results.some(r=>!r.error))process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
