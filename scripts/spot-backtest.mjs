import { findSpotPairs, selectBestSpotPair, analyzeSpotCandles } from "../src/spot-engine.js";

const BASE = "https://api.kraken.com/0/public";
const COST_PCT = 0.30; // 0.10% fee + 0.05% slippage per side, round trip.
const MIN_CANDLES = 55;
const HORIZON_1H = 24;
const HORIZON_4H = 6;
const MAX_ASSETS = 15;

async function getJson(url, label) {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "CryptoPumpHunter-SpotBacktest/1.0" } });
  const body = await response.json();
  if (!response.ok || body.error?.length) throw new Error(label + ": " + (body.error?.join(", ") || response.status));
  return body.result ?? body;
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { output[index] = await fn(items[index]); }
      catch (error) { output[index] = { ...(items[index] && typeof items[index] === "object" ? items[index] : {}), error: String(error?.message || error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function getCoinUniverse() {
  const pages = await mapLimit([0,100,200,300,400,500,600,700,800,900], 2,
    start => getJson("https://api.coinlore.net/api/tickers/?start=" + start + "&limit=100", "CoinLore"));
  const seen = new Set(), coins = [];
  for (const page of pages) {
    const rows = Array.isArray(page) ? page : page?.data ?? page?.coins ?? [];
    for (const coin of rows) {
      const symbol = String(coin.symbol || "").toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const cap = Number(coin.market_cap_usd), volume = Number(coin.volume24), price = Number(coin.price_usd);
      if (cap >= 1_000_000 && cap <= 5_000_000_000 && volume >= 250_000 && price > 0) coins.push(coin);
    }
  }
  return coins.sort((a,b) => Number(b.volume24)-Number(a.volume24)).slice(0, MAX_ASSETS);
}

function candleRows(result) {
  const key = Object.keys(result).find(name => name !== "last");
  if (!key || !Array.isArray(result[key])) throw new Error("OHLC response has no candle series");
  return result[key].slice(0,-1).map(row => ({
    time:Number(row[0]), open:Number(row[1]), high:Number(row[2]),
    low:Number(row[3]), close:Number(row[4]), volume:Number(row[6])
  })).filter(c => [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open>0 && c.low>0 && c.close>0 && c.high>=Math.max(c.open,c.close) && c.low<=Math.min(c.open,c.close));
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier=2/(period+1);
  let value=values.slice(0,period).reduce((sum,item)=>sum+item,0)/period;
  for(let i=period;i<values.length;i++) value=values[i]*multiplier+value*(1-multiplier);
  return value;
}

function simulate(candles, pair, barsPerDay, profile, btcCandles) {
  const horizon = barsPerDay;
  const split = Math.floor(candles.length * 0.7);
  const trades = [];
  const btcIndexByTime = new Map(btcCandles.map((candle,index)=>[candle.time,index]));
  let lastSignalIndex = -Infinity;
  for (let i = MIN_CANDLES; i + horizon < candles.length; i++) {
    if (i - lastSignalIndex < horizon) continue;
    const history = candles.slice(0,i);
    const current = history.at(-1).close;
    const last24 = history.slice(-barsPerDay);
    if (last24.length < barsPerDay) continue;
    const quoteVolume24 = last24.reduce((sum,c) => sum + c.volume, 0) * current;
    const change24 = history.at(-1).close / history.at(-(barsPerDay + 1)).close - 1;
    const btcIndex=btcIndexByTime.get(history.at(-1).time);
    if (btcIndex === undefined || btcIndex < Math.max(50,barsPerDay)) continue;
    const btcHistory=btcCandles.slice(0,btcIndex+1);
    const btcCloses=btcHistory.map(c=>c.close);
    const btcEma20=ema(btcCloses,20), btcEma50=ema(btcCloses,50);
    const btcCurrent=btcHistory.at(-1).close;
    const btcChange24=(btcCurrent/btcCandles[btcIndex-barsPerDay].close-1)*100;
    const assetChange24=(current/history.at(-(barsPerDay+1)).close-1)*100;
    const coin = {
      symbol: pair.coin.symbol,
      name: pair.coin.name,
      volume24: quoteVolume24,
      percent_change_24h: change24 * 100
    };
    const signal = analyzeSpotCandles(coin, history, {
      pair:pair.pair.wsname,
      quote:pair.quote,
      last:current,
      spreadPct:0.20,
      quoteVolumeUsd:quoteVolume24,
      bidDepthUsd:10_000,
      askDepthUsd:10_000,
      btcTrendUp:btcEma20>btcEma50 && btcCurrent>btcEma50,
      relativeStrength24Pct:assetChange24-btcChange24
    }, profile);
    if (!signal.eligible) continue;

    const future = candles.slice(i,i+horizon);
    const entry = future[0].open;
    if (!(entry > signal.stop && entry < signal.target1)) continue;
    // Exclude large opening gaps: the live alert would no longer be actionable.
    if (Math.abs(entry/current - 1) > 0.005) continue;

    let exitPrice = future[horizon-1].close;
    let exitReason = "24h-time-exit";
    let stopped = false, targeted = false;
    for (const bar of future) {
      const hitStop = bar.low <= signal.stop;
      const hitTarget = bar.high >= signal.target1;
      // Conservative same-candle ambiguity: count the stop first.
      if (hitStop) { exitPrice = Math.min(signal.stop, bar.open); exitReason = "stop"; stopped = true; break; }
      if (hitTarget) { exitPrice = signal.target1; exitReason = "target1"; targeted = true; break; }
    }
    const close24 = future[horizon-1].close;
    const net24hPct = (close24 / entry - 1) * 100 - COST_PCT;
    const exitNetPct = (exitPrice / entry - 1) * 100 - COST_PCT;
    const minLow = Math.min(...future.map(c => c.low));
    const maxHigh = Math.max(...future.map(c => c.high));
    trades.push({
      time:future[0].time,
      split:i+horizon < split ? "in-sample" : i >= split ? "out-of-sample" : "boundary",
      net24hPct,
      exitNetPct,
      exitReason,
      stopped,
      targeted,
      maePct:(minLow/entry-1)*100,
      mfePct:(maxHigh/entry-1)*100
    });
    lastSignalIndex = i;
  }
  return trades.filter(t => t.split !== "boundary");
}

function summarize(trades, includeDrawdown = true) {
  const n = trades.length;
  if (!n) return { signals:0, positive24hRatePct:null, averageNet24hPct:null, exitWinRatePct:null, expectancyExitPct:null, targetHitPct:null, stopHitPct:null, averageMaePct:null, averageMfePct:null, maxDrawdownPct:null };
  const avg = key => trades.reduce((sum,t)=>sum+t[key],0)/n;
  const positive = trades.filter(t=>t.net24hPct>0).length;
  const exitWins = trades.filter(t=>t.exitNetPct>0).length;
  const targets = trades.filter(t=>t.targeted).length;
  const stops = trades.filter(t=>t.stopped).length;
  const wins = trades.filter(t=>t.exitNetPct>0).reduce((sum,t)=>sum+t.exitNetPct,0);
  const losses = trades.filter(t=>t.exitNetPct<0).reduce((sum,t)=>sum+Math.abs(t.exitNetPct),0);
  const ordered = [...trades].sort((a,b)=>a.time-b.time);
  let equity=1, peak=1, maxDrawdown=0;
  for (const trade of ordered) {
    equity *= 1 + trade.exitNetPct/100;
    peak = Math.max(peak,equity);
    maxDrawdown = Math.max(maxDrawdown,(peak-equity)/peak*100);
  }
  return {
    signals:n,
    positive24hRatePct:+(positive/n*100).toFixed(2),
    averageNet24hPct:+avg("net24hPct").toFixed(3),
    exitWinRatePct:+(exitWins/n*100).toFixed(2),
    expectancyExitPct:+avg("exitNetPct").toFixed(3),
    profitFactor:losses ? +(wins/losses).toFixed(2) : wins ? "Infinity" : 0,
    targetHitPct:+(targets/n*100).toFixed(2),
    stopHitPct:+(stops/n*100).toFixed(2),
    averageMaePct:+avg("maePct").toFixed(3),
    averageMfePct:+avg("mfePct").toFixed(3),
    maxDrawdownPct:includeDrawdown ? +maxDrawdown.toFixed(2) : null
  };
}

const started = Date.now();
const coins = await getCoinUniverse();
const pairPayload = await getJson(BASE + "/AssetPairs","Kraken AssetPairs");
const pairs = Object.entries(pairPayload).map(([key,value])=>({key,...value})).filter(p=>p.status==="online"&&p.wsname);
const candidatePairs = coins.flatMap(coin=>findSpotPairs(coin,pairs));
const btcPairs=findSpotPairs({symbol:"BTC"},pairs);
if (!candidatePairs.length || !btcPairs.length) throw new Error("Eligible Kraken asset pairs or BTC/USD-USDT reference pair not found.");
const tickerPairs=[...candidatePairs,...btcPairs];
const tickerPayload = await getJson(BASE + "/Ticker?pair=" + encodeURIComponent([...new Set(tickerPairs.map(p=>p.altname||p.key))].join(",")),"Kraken Ticker");
const btcSelected=selectBestSpotPair(btcPairs,tickerPayload);
if (!btcSelected) throw new Error("Kraken BTC reference ticker unavailable.");
const selected = [];
for (const coin of coins) {
  const pair = selectBestSpotPair(findSpotPairs(coin,pairs),tickerPayload);
  if (pair) selected.push({coin,pair:pair.pair,quote:pair.quote});
}
if (!selected.length) throw new Error("Kraken returned no usable ticker data for the selected Spot universe.");
const btcPairName=encodeURIComponent(btcSelected.pair.altname||btcSelected.pair.key);
const [btc1hPayload,btc4hPayload]=await Promise.all([
  getJson(BASE+"/OHLC?pair="+btcPairName+"&interval=60","Kraken BTC 1H OHLC"),
  getJson(BASE+"/OHLC?pair="+btcPairName+"&interval=240","Kraken BTC 4H OHLC")
]);
const btcCandles1h=candleRows(btc1hPayload), btcCandles4h=candleRows(btc4hPayload);
const downloaded = await mapLimit(selected,3,async item=>{
  const pairName=encodeURIComponent(item.pair.altname||item.pair.key);
  const [oneHourPayload,fourHourPayload]=await Promise.all([
    getJson(BASE+"/OHLC?pair="+pairName+"&interval=60","Kraken 1H OHLC "+item.pair.wsname),
    getJson(BASE+"/OHLC?pair="+pairName+"&interval=240","Kraken 4H OHLC "+item.pair.wsname)
  ]);
  return {...item,candles1h:candleRows(oneHourPayload),candles4h:candleRows(fourHourPayload)};
});
const reports=[];
const aggregate={baseline:{oneHour:[],fourHour:[]},balanced:{oneHour:[],fourHour:[]},strict:{oneHour:[],fourHour:[]}};
for (const item of downloaded) {
  if (item.error || !item.candles1h || item.candles1h.length < MIN_CANDLES+HORIZON_1H+1 ||
      !item.candles4h || item.candles4h.length < MIN_CANDLES+HORIZON_4H+1) {
    reports.push({symbol:item.coin?.symbol,pair:item.pair?.wsname,error:item.error||"Not enough historical candles"});
    continue;
  }
  const base1=simulate(item.candles1h,item,HORIZON_1H,"baseline",btcCandles1h);
  const balanced1=simulate(item.candles1h,item,HORIZON_1H,"balanced",btcCandles1h);
  const strict1=simulate(item.candles1h,item,HORIZON_1H,"strict",btcCandles1h);
  const base4=simulate(item.candles4h,item,HORIZON_4H,"baseline",btcCandles4h);
  const balanced4=simulate(item.candles4h,item,HORIZON_4H,"balanced",btcCandles4h);
  const strict4=simulate(item.candles4h,item,HORIZON_4H,"strict",btcCandles4h);
  aggregate.baseline.oneHour.push(...base1);
  aggregate.balanced.oneHour.push(...balanced1);
  aggregate.strict.oneHour.push(...strict1);
  aggregate.baseline.fourHour.push(...base4);
  aggregate.balanced.fourHour.push(...balanced4);
  aggregate.strict.fourHour.push(...strict4);
  const metrics=trades=>({
    inSample:summarize(trades.filter(t=>t.split==="in-sample")),
    outOfSample:summarize(trades.filter(t=>t.split==="out-of-sample"))
  });
  reports.push({
    symbol:item.coin.symbol,
    pair:item.pair.wsname,
    baseline:{
      oneHour:{candles:item.candles1h.length,historyDays:+(item.candles1h.length/24).toFixed(1),...metrics(base1)},
      fourHour:{candles:item.candles4h.length,historyDays:+(item.candles4h.length*4/24).toFixed(1),...metrics(base4)}
    },
    balanced:{
      oneHour:{candles:item.candles1h.length,historyDays:+(item.candles1h.length/24).toFixed(1),...metrics(balanced1)},
      fourHour:{candles:item.candles4h.length,historyDays:+(item.candles4h.length*4/24).toFixed(1),...metrics(balanced4)}
    },
    strict:{
      oneHour:{candles:item.candles1h.length,historyDays:+(item.candles1h.length/24).toFixed(1),...metrics(strict1)},
      fourHour:{candles:item.candles4h.length,historyDays:+(item.candles4h.length*4/24).toFixed(1),...metrics(strict4)}
    }
  });
}
const output={
  periods:{oneHour:"Up to 720 latest 1h OHLC rows (approximately 30 days)",fourHour:"Up to 720 latest 4h OHLC rows (approximately 120 days)"},
  assetsSelected:selected.length,
  btcReferencePair:btcSelected.pair.wsname,
  costs:"0.30% round trip assumed (0.10% fee + 0.05% slippage each side)",
  profiles:"Baseline has no BTC gate; balanced requires positive 24h relative strength vs BTC; strict additionally requires BTC above its 1H/4H EMA50 with EMA20 above EMA50.",
  liquidity:"Historical order-book depth is unavailable in this OHLC test; spread 0.20% and $10,000 depth per side are assumptions, not observed history.",
  universe:"Current CoinLore market-cap/volume screen; survivorship and current-universe bias apply.",
  aggregate:{
    baseline:{
      oneHour:{inSample:summarize(aggregate.baseline.oneHour.filter(t=>t.split==="in-sample"),false),outOfSample:summarize(aggregate.baseline.oneHour.filter(t=>t.split==="out-of-sample"),false)},
      fourHour:{inSample:summarize(aggregate.baseline.fourHour.filter(t=>t.split==="in-sample"),false),outOfSample:summarize(aggregate.baseline.fourHour.filter(t=>t.split==="out-of-sample"),false)}
    },
    balanced:{
      oneHour:{inSample:summarize(aggregate.balanced.oneHour.filter(t=>t.split==="in-sample"),false),outOfSample:summarize(aggregate.balanced.oneHour.filter(t=>t.split==="out-of-sample"),false)},
      fourHour:{inSample:summarize(aggregate.balanced.fourHour.filter(t=>t.split==="in-sample"),false),outOfSample:summarize(aggregate.balanced.fourHour.filter(t=>t.split==="out-of-sample"),false)}
    },
    strict:{
      oneHour:{inSample:summarize(aggregate.strict.oneHour.filter(t=>t.split==="in-sample"),false),outOfSample:summarize(aggregate.strict.oneHour.filter(t=>t.split==="out-of-sample"),false)},
      fourHour:{inSample:summarize(aggregate.strict.fourHour.filter(t=>t.split==="in-sample"),false),outOfSample:summarize(aggregate.strict.fourHour.filter(t=>t.split==="out-of-sample"),false)}
    }
  },
  markets:reports,
  elapsedSeconds:+((Date.now()-started)/1000).toFixed(1)
};
console.log(JSON.stringify(output,null,2));
