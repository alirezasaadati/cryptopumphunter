const CFG = Object.freeze({
  MIN_CAP: 1_000_000,
  MAX_CAP: 5_000_000_000,
  MIN_MARKET_VOLUME_USD: 250_000,
  MIN_PAIR_VOLUME_USD: 50_000,
  MIN_BOOK_DEPTH_USD: 5_000,
  MAX_SPREAD_PCT: 0.8,
  MAX_CANDIDATES: 15,
  MAX_RESULTS: 8,
  CONCURRENCY: 3,
  MIN_SCORE: 75,
  MIN_RR: 1.8,
  INTERVAL: 60,
  MIN_CANDLES: 55,
  PAGES: [0,100,200,300,400,500,600,700,800,900]
});

const json = async (url, label) => {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "CryptoPumpHunter/spot-v4" } });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(label + ": پاسخ JSON معتبر نیست؛ HTTP " + response.status); }
  if (!response.ok) throw new Error(label + ": HTTP " + response.status);
  return data;
};

function extract(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.coins)) return payload.coins;
  if (Array.isArray(payload?.data?.coins)) return payload.data.coins;
  return [];
}

async function fetchCoinLore(start) {
  const payload = await json("https://api.coinlore.net/api/tickers/?start=" + start + "&limit=100", "CoinLore");
  const coins = extract(payload);
  if (!coins.length) throw new Error("CoinLore صفحه " + start + " داده قابل استفاده ندارد.");
  return coins;
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { output[index] = await fn(items[index]); }
      catch (error) { output[index] = { rejected: String(error?.message || error || "خطای ناشناخته"), coin: items[index] }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function getCoins() {
  const pages = await mapLimit(CFG.PAGES, 2, async start => {
    try { return { coins: await fetchCoinLore(start) }; }
    catch (error) { return { coins: [], error: String(error?.message || error) }; }
  });
  const coins = [], seen = new Set(), errors = [];
  for (const page of pages) {
    if (page.error) errors.push(page.error);
    for (const coin of page.coins) {
      const id = norm(coin.symbol);
      if (id && !seen.has(id)) { seen.add(id); coins.push(coin); }
    }
  }
  return { coins, errors };
}

async function getPairs() {
  const payload = await json("https://api.kraken.com/0/public/AssetPairs", "Kraken AssetPairs");
  if (payload.error?.length) throw new Error(payload.error.join(", "));
  return Object.entries(payload.result || {}).map(([key, value]) => ({ key, ...value }))
    .filter(pair => pair.status === "online" && pair.wsname);
}

function norm(value) {
  let result = String(value || "").toUpperCase().trim();
  if (result === "BTC") result = "XBT";
  return result.replace(/[^A-Z0-9]/g, "");
}

function canonicalAsset(value) {
  const result = norm(value);
  if (result.startsWith("XX") && result.length > 3) return result.slice(1);
  return result;
}

function pairQuote(pair) {
  const parts = String(pair.wsname || "").toUpperCase().split("/");
  return parts.length === 2 ? parts[1] : "";
}

function pairMatchesCoin(pair, coin) {
  const parts = String(pair.wsname || "").toUpperCase().split("/");
  if (parts.length !== 2 || !["USD", "USDT"].includes(parts[1])) return false;
  return canonicalAsset(parts[0]) === canonicalAsset(coin.symbol);
}

export function findSpotPairs(coin, pairs) {
  return (Array.isArray(pairs) ? pairs : []).filter(pair => pairMatchesCoin(pair, coin));
}

function pairRequestName(pair) {
  return pair.altname || pair.key;
}

function tickerForPair(pair, tickerResult) {
  const aliases = [pair.key, pair.altname, String(pair.wsname || "").replace("/", "")].map(norm).filter(Boolean);
  for (const [key, ticker] of Object.entries(tickerResult || {})) {
    const normalized = norm(key);
    if (aliases.includes(normalized)) return ticker;
    const quote = norm(pairQuote(pair));
    if (quote && normalized.endsWith(quote)) {
      const returnedBase = canonicalAsset(normalized.slice(0, -quote.length));
      const expectedBase = canonicalAsset(String(pair.wsname).split("/")[0]);
      if (returnedBase === expectedBase) return ticker;
    }
  }
  return null;
}

export function selectBestSpotPair(pairs, tickerResult) {
  const candidates = [];
  for (const pair of pairs || []) {
    const ticker = tickerForPair(pair, tickerResult);
    if (!ticker) continue;
    const bid = Number(ticker.b?.[0]), ask = Number(ticker.a?.[0]), last = Number(ticker.c?.[0]);
    const baseVolume = Number(ticker.v?.[1]);
    if (![bid, ask, last, baseVolume].every(Number.isFinite) || bid <= 0 || ask <= bid || last <= 0 || baseVolume <= 0) continue;
    const spreadPct = ((ask - bid) / ((ask + bid) / 2)) * 100;
    const quoteVolumeUsd = baseVolume * last;
    if (spreadPct > CFG.MAX_SPREAD_PCT || quoteVolumeUsd < CFG.MIN_PAIR_VOLUME_USD) continue;
    candidates.push({
      pair, ticker, quote: pairQuote(pair), bid, ask, last, spreadPct, quoteVolumeUsd,
      liquidityScore: Math.log10(quoteVolumeUsd + 1) * 10 - spreadPct * 20
    });
  }
  return candidates.sort((a, b) => b.liquidityScore - a.liquidityScore)[0] || null;
}

async function fetchTickers(pairs) {
  if (!pairs.length) return {};
  const names = [...new Set(pairs.map(pairRequestName))];
  const payload = await json("https://api.kraken.com/0/public/Ticker?pair=" + encodeURIComponent(names.join(",")), "Kraken Ticker");
  if (payload.error?.length) throw new Error(payload.error.join(", "));
  return payload.result || {};
}

async function fetchOrderBook(pair) {
  const payload = await json("https://api.kraken.com/0/public/Depth?pair=" + encodeURIComponent(pairRequestName(pair)) + "&count=20", "Kraken Order Book");
  if (payload.error?.length) throw new Error(payload.error.join(", "));
  const result = payload.result || {};
  const key = Object.keys(result).find(name => name !== "last");
  const book = key ? result[key] : null;
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) throw new Error("دفتر سفارش Kraken ناقص است.");
  return book;
}

function calculateDepth(book, mid) {
  const thresholdBid = mid * 0.99, thresholdAsk = mid * 1.01;
  const bidUsd = book.bids.reduce((sum, level) => Number(level[0]) >= thresholdBid ? sum + Number(level[0]) * Number(level[1]) : sum, 0);
  const askUsd = book.asks.reduce((sum, level) => Number(level[0]) <= thresholdAsk ? sum + Number(level[0]) * Number(level[1]) : sum, 0);
  return { bidUsd, askUsd };
}

async function fetchCandles(pair) {
  const payload = await json("https://api.kraken.com/0/public/OHLC?pair=" + encodeURIComponent(pairRequestName(pair)) + "&interval=" + CFG.INTERVAL, "Kraken OHLC");
  if (payload.error?.length) throw new Error(payload.error.join(", "));
  const result = payload.result || {};
  const key = Object.keys(result).find(name => name !== "last");
  if (!key || !Array.isArray(result[key])) throw new Error("کندل‌های Kraken موجود نیستند.");
  return result[key].slice(0, -1).map(row => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
    low: Number(row[3]), close: Number(row[4]), volume: Number(row[6])
  })).filter(c => [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) &&
    c.open > 0 && c.low > 0 && c.close > 0 && c.high >= Math.max(c.open,c.close) &&
    c.low <= Math.min(c.open,c.close));
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * multiplier + value * (1 - multiplier);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0); losses += Math.max(-change, 0);
  }
  let averageGain = gains / period, averageLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function formatSpotPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 1000) return number.toFixed(2);
  if (number >= 1) return number.toFixed(4);
  if (number >= 0.01) return number.toFixed(5);
  if (number >= 0.0001) return number.toFixed(7);
  return number.toExponential(3);
}

function buildBtcContext(candles, currentPrice) {
  if (!Array.isArray(candles) || candles.length < 55) throw new Error("داده کندلی کافی برای تشخیص روند بیت‌کوین وجود ندارد.");
  const closes = candles.map(candle => candle.close);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50);
  const current = Number(currentPrice || candles.at(-1).close);
  const previousDayClose = candles.at(-25)?.close;
  if (![ema20, ema50, current, previousDayClose].every(Number.isFinite) || previousDayClose <= 0) {
    throw new Error("محاسبه وضعیت بازار بیت‌کوین ناموفق بود.");
  }
  return {
    btcTrendUp: ema20 > ema50 && current > ema50,
    btcChange24Pct: (current / previousDayClose - 1) * 100
  };
}

function analyze(coin, candles, market, profile = "strict") {
  const baseline = profile === "baseline";
  const strict = profile === "strict";
  const minScore = baseline ? 65 : strict ? CFG.MIN_SCORE : 70;
  const minRewardRisk = baseline ? 1.5 : strict ? CFG.MIN_RR : 1.5;
  if (candles.length < CFG.MIN_CANDLES) throw new Error("تعداد کندل بسته‌شده کافی نیست.");
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1], previous = candles[candles.length - 2];
  const current = Number(market?.last || last.close);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), rsiValue = rsi(closes);
  if ([ema20, ema50, rsiValue, current].some(value => !Number.isFinite(value))) throw new Error("محاسبه اندیکاتورها ناموفق بود.");
  const recent = candles.slice(-31, -1);
  if (recent.length < 10) throw new Error("کندل کافی برای حمایت و مقاومت وجود ندارد.");
  const support = Math.min(...recent.map(c => c.low));
  const resistance = Math.max(...recent.map(c => c.high));
  const averageVolume = average(candles.slice(-21, -1).map(c => c.volume));
  const volumeRatio = averageVolume > 0 ? last.volume / averageVolume : 0;
  const trendUp = ema20 > ema50;
  const above20 = current > ema20, above50 = current > ema50;
  const dailyVolume = Number(coin.volume24) || 0;
  const dailyChange = Number(coin.percent_change_24h) || 0;
  let score = 0;
  const reasons = [];
  if (trendUp) score += 25; else reasons.push("EMA20 بالاتر از EMA50 نیست");
  if (rsiValue >= 45 && rsiValue <= 68) score += 15;
  else if (rsiValue > 68 && rsiValue <= 75) { score += 7; reasons.push("RSI بالا است؛ احتمال ورود دیرهنگام"); }
  else if (rsiValue > 75) reasons.push("RSI بیش از حد بالا است");
  else reasons.push("قدرت RSI کافی نیست");
  if (volumeRatio >= 1.5) score += 20;
  else if (volumeRatio >= 1.1) score += 15;
  else if (volumeRatio >= 0.9) score += 10;
  else reasons.push("حجم کندل اخیر پایین است");
  if (dailyVolume >= 1_000_000) score += 10;
  else if (dailyVolume >= 500_000) score += 7;
  else score += 4;
  if (dailyChange > 0 && dailyChange < 12) score += 10;
  else if (dailyChange >= 12) { score += 5; reasons.push("رشد روزانه زیاد است"); }
  else reasons.push("تغییرات روزانه مثبت نیست");
  if (above20 && above50) score += 20;
  else if (above20 || above50) score += 10;
  else reasons.push("قیمت زیر EMA20 و EMA50 است");
  score = Math.min(100, score);

  let setup = "بدون ستاپ";
  const breakout = current > resistance * 1.002 && previous.close <= resistance * 1.005 && volumeRatio >= 1.1 && trendUp;
  const pullback = trendUp && current > ema20 && last.low <= ema20 * 1.01 && current > last.open;
  const bounce = last.low <= support * 1.015 && current > support * 1.01 && current > last.open;
  if (breakout) setup = "شکست مقاومت";
  else if (pullback) setup = "پولبک به EMA20";
  else if (bounce) setup = "واکنش به حمایت";

  const recentLow = Math.min(...candles.slice(-8, -1).map(c => c.low));
  const stop = setup === "شکست مقاومت" ? Math.min(resistance * 0.99, recentLow * 0.995) :
    setup === "پولبک به EMA20" ? Math.min(ema20 * 0.985, recentLow * 0.995) :
    setup === "واکنش به حمایت" ? Math.min(support * 0.985, recentLow * 0.995) :
    Math.min(support * 0.99, recentLow * 0.995);
  const risk = current - stop;
  const validRisk = Number.isFinite(risk) && risk > 0;
  const structuralTarget = setup === "شکست مقاومت"
    ? current + Math.max(resistance - support, current * 0.01)
    : resistance;
  const target1 = validRisk
    ? Math.max(current + risk * 1.5, Math.min(structuralTarget, current + risk * 2.5))
    : 0;
  const target2 = validRisk ? Math.max(current + risk * 2.5, target1 + risk * 0.5) : 0;
  const target3 = validRisk ? Math.max(current + risk * 3.5, target2 + risk * 0.5) : 0;
  const rewardRisk = validRisk ? (target1 - current) / risk : 0;
  if (!validRisk) reasons.push("حد ضرر معتبر محاسبه نشد");
  if (setup === "بدون ستاپ") reasons.push("الگوی ورود مشخصی وجود ندارد");
  if (rewardRisk < minRewardRisk) reasons.push("نسبت سود به ریسک کمتر از حداقل تعیین‌شده است");
  if (score < minScore) reasons.push("امتیاز کمتر از " + minScore + " است");
  if (!baseline && market.btcTrendUp !== true) reasons.push("روند بیت‌کوین تأیید صعودی نمی‌دهد");
  if (!baseline && !(Number(market.relativeStrength24Pct) > 0)) reasons.push("قدرت نسبی ارز نسبت به بیت‌کوین مثبت نیست");

  return {
    coin, pair: market.pair, quote: market.quote, current, score, rsi: rsiValue,
    support, resistance, volumeRatio, trend: trendUp ? "صعودی" : "خنثی یا نزولی",
    setup, entry: current, stop, target1, target2, target3, rewardRisk,
    spreadPct: market.spreadPct, quoteVolumeUsd: market.quoteVolumeUsd,
    bidDepthUsd: market.bidDepthUsd, askDepthUsd: market.askDepthUsd,
    eligible: (baseline
      ? score >= minScore && setup !== "بدون ستاپ" && volumeRatio >= 0.9 &&
        validRisk && rewardRisk >= minRewardRisk
      : strict
        ? score >= minScore && ["شکست مقاومت", "پولبک به EMA20"].includes(setup) &&
          trendUp && above20 && above50 && market.btcTrendUp === true &&
          Number(market.relativeStrength24Pct) > 0 && rsiValue >= 50 && rsiValue <= 68 &&
          volumeRatio >= 1.1 && dailyChange >= 0 && dailyChange <= 10 &&
          validRisk && rewardRisk >= minRewardRisk
        : score >= minScore && setup !== "بدون ستاپ" && trendUp && above20 &&
          Number(market.relativeStrength24Pct) > 0 &&
          rsiValue >= 45 && rsiValue <= 68 && volumeRatio >= 1.0 &&
          dailyChange >= 0 && dailyChange <= 12 && validRisk &&
          rewardRisk >= minRewardRisk) &&
      market.spreadPct <= CFG.MAX_SPREAD_PCT &&
      market.bidDepthUsd >= CFG.MIN_BOOK_DEPTH_USD &&
      market.askDepthUsd >= CFG.MIN_BOOK_DEPTH_USD,
    reasons
  };
}

export function analyzeSpotCandles(coin, candles, market, profile = "strict") {
  return analyze(coin, candles, market, profile);
}

function formatTargetReturn(entry, target) {
  const base = Number(entry), price = Number(target);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(price) || price <= 0) return "—";
  return "+" + ((price / base - 1) * 100).toFixed(2) + "%";
}

function formatCoin(item) {
  return "📊 <b>سیگنال اسپات | " + item.coin.name + " (" + item.coin.symbol + ")</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "💱 جفت معاملاتی: <b>" + item.pair + "</b>\n" +
    "💵 قیمت فعلی: <b>" + formatSpotPrice(item.current) + " " + item.quote + "</b>\n" +
    "🎯 نقطه ورود: <b>" + formatSpotPrice(item.entry) + " " + item.quote + "</b>\n" +
    "🛑 حد ضرر: <b>" + formatSpotPrice(item.stop) + " " + item.quote + "</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "🥇 تارگت اول: <b>" + formatSpotPrice(item.target1) + " " + item.quote + "</b>  ( " + formatTargetReturn(item.entry, item.target1) + " )\n" +
    "🥈 تارگت دوم: <b>" + formatSpotPrice(item.target2) + " " + item.quote + "</b>  ( " + formatTargetReturn(item.entry, item.target2) + " )\n" +
    "🥉 تارگت سوم: <b>" + formatSpotPrice(item.target3) + " " + item.quote + "</b>  ( " + formatTargetReturn(item.entry, item.target3) + " )\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "📈 روند: " + item.trend + "\n" +
    "🧩 ساختار ورود: " + item.setup + "\n" +
    "⭐ امتیاز کیفیت: " + item.score + "/100\n" +
    "📊 RSI: " + item.rsi.toFixed(1) + " | قدرت حجم: " + item.volumeRatio.toFixed(2) + "x\n" +
    "🟢 حمایت: " + formatSpotPrice(item.support) + " " + item.quote + "\n" +
    "🔴 مقاومت: " + formatSpotPrice(item.resistance) + " " + item.quote + "\n" +
    "↔️ اسپرد: " + item.spreadPct.toFixed(3) + "%\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    (item.eligible
      ? "✅ شرایط فنی و نقدینگی در زمان بررسی برقرار است."
      : "⚠️ شرایط ورود کامل نیست؛ فعلاً صرفاً گزارش تحلیلی است.\nدلایل: " + item.reasons.join("، ")) +
    "\n⏱ افق بررسی: ۲۴ ساعت آینده؛ بدون تضمین نتیجه.";
}

async function analyzeCoinOnBestPair(coin, pairs, tickerResult, btcContext) {
  const matching = findSpotPairs(coin, pairs);
  if (!matching.length) throw new Error("جفت USD یا USDT در Kraken پیدا نشد.");
  const selected = selectBestSpotPair(matching, tickerResult);
  if (!selected) throw new Error("جفت USD/USDT با حجم و اسپرد قابل قبول پیدا نشد.");
  const book = await fetchOrderBook(selected.pair);
  const depth = calculateDepth(book, (selected.bid + selected.ask) / 2);
  const candles = await fetchCandles(selected.pair);
  if (candles.length < 25) throw new Error("برای محاسبه تغییر ۲۴ ساعته، حداقل ۲۵ کندل لازم است.");
  const assetChange24Pct = (selected.last / candles.at(-25).close - 1) * 100;
  const normalizedCoin = { ...coin, percent_change_24h: assetChange24Pct };
  return analyze(normalizedCoin, candles, {
    ...selected, pair: selected.pair.wsname,
    bidDepthUsd: depth.bidUsd, askDepthUsd: depth.askUsd,
    btcTrendUp: btcContext.btcTrendUp,
    relativeStrength24Pct: assetChange24Pct - btcContext.btcChange24Pct
  });
}

export async function testSpotDataSources() {
  const coinPage=await fetchCoinLore(0),pairs=await getPairs();
  const btcPairs=findSpotPairs({symbol:"BTC"},pairs);
  if(!btcPairs.length)throw new Error("جفت BTC/USD یا BTC/USDT در Kraken Spot پیدا نشد.");
  const tickers=await fetchTickers(btcPairs),selected=selectBestSpotPair(btcPairs,tickers);
  if(!selected)throw new Error("Ticker جفت مرجع BTC در Kraken Spot قابل استفاده نیست.");
  const [candles,book]=await Promise.all([fetchCandles(selected.pair),fetchOrderBook(selected.pair)]);
  const mid=(selected.bid+selected.ask)/2,depth=calculateDepth(book,mid);
  const btcContext=buildBtcContext(candles,selected.last);
  return {ok:true,coinLore:{ok:coinPage.length>0,rows:coinPage.length},krakenSpot:{ok:pairs.length>0,onlinePairs:pairs.length},btcReference:selected.pair.wsname,closedCandles:candles.length,bidDepthUsd:depth.bidUsd,askDepthUsd:depth.askUsd,btcTrendUp:btcContext.btcTrendUp};
}

export async function runSpotScan() {
  const started = Date.now();
  const coinResult = await getCoins();
  if (!coinResult.coins.length) {
    return { report: "❌ دریافت فهرست بازار از CoinLore ناموفق بود.\n" + coinResult.errors.slice(0, 5).join("\n"), opportunities: [], diagnostics: { dataFailures: 0 } };
  }
  const candidates = coinResult.coins.filter(coin => {
    const cap = Number(coin.market_cap_usd), volume = Number(coin.volume24), price = Number(coin.price_usd);
    return Number.isFinite(cap) && Number.isFinite(volume) && Number.isFinite(price) &&
      cap >= CFG.MIN_CAP && cap <= CFG.MAX_CAP && volume >= CFG.MIN_MARKET_VOLUME_USD && price > 0;
  }).sort((a, b) => Number(b.volume24) - Number(a.volume24)).slice(0, CFG.MAX_CANDIDATES);
  if (!candidates.length) return { report: "⚠️ هیچ ارزی با فیلترهای اولیه ارزش بازار و حجم مطابقت نداشت.", opportunities: [], diagnostics: { dataFailures: 0 } };

  let pairs;
  try { pairs = await getPairs(); }
  catch (error) { return { report: "❌ دریافت جفت‌ارزهای Kraken ناموفق بود:\n" + String(error.message || error), opportunities: [], diagnostics: { dataFailures: 0 } }; }

  const candidatePairs = candidates.flatMap(coin => findSpotPairs(coin, pairs));
  const btcPairs = findSpotPairs({ symbol: "BTC" }, pairs);
  const allTickerPairs = [...candidatePairs, ...btcPairs];
  let tickerResult;
  try { tickerResult = await fetchTickers(allTickerPairs); }
  catch (error) { return { report: "❌ دریافت Tickerهای Kraken ناموفق بود:\n" + String(error.message || error), opportunities: [], diagnostics: { dataFailures: 0 } }; }
  const btcSelected = selectBestSpotPair(btcPairs, tickerResult);
  if (!btcSelected) return { report: "⚠️ جفت BTC/USD یا BTC/USDT برای فیلتر روند بازار در دسترس نیست؛ برای جلوگیری از سیگنال‌های خلاف جهت بازار، اسکن متوقف شد.", opportunities: [], diagnostics: { dataFailures: 0 } };
  let btcContext;
  try { btcContext = buildBtcContext(await fetchCandles(btcSelected.pair), btcSelected.last); }
  catch (error) { return { report: "⚠️ دریافت/تحلیل روند بیت‌کوین ناموفق بود؛ اسکن اسپات بدون فیلتر بازار اجرا نمی‌شود.\n" + String(error.message || error), opportunities: [], diagnostics: { dataFailures: 0 } }; }

  const analyzed = await mapLimit(candidates, CFG.CONCURRENCY, async coin => analyzeCoinOnBestPair(coin, pairs, tickerResult, btcContext));
  const dataFailures=analyzed.filter(item=>item?.rejected);
  const evaluated=analyzed.filter(item=>item&&!item.rejected);
  const ruleRejected=evaluated.filter(item=>!item.eligible);
  const opportunities=evaluated.filter(item=>item.eligible)
    .sort((a,b)=>b.score-a.score||b.rewardRisk-a.rewardRisk).slice(0,CFG.MAX_RESULTS);
  if (!opportunities.length) {
    return {
      report: "🔎 در حال حاضر فرصت سرمایه‌گذاری مناسبی شناسایی نشد.\n\nبرای بررسی فرصت‌های جدید، لطفاً در زمان دیگری مجدداً از همین بخش اقدام کنید.",
      opportunities,
      diagnostics: { selected:candidates.length, evaluated:evaluated.length, dataFailures:dataFailures.length, ruleRejected:ruleRejected.length, coinLorePageErrors:coinResult.errors.length, failedAssets:dataFailures.map(item=>({symbol:item.coin?.symbol||null,error:item.rejected})) }
    };
  }

  const report=[
    "📊 اسکن دستی بازار اسپات Kraken",
    "━━━━━━━━━━━━━━━━━━",
    "ارزهای انتخاب‌شده: "+candidates.length,
    "ارزهای تحلیل‌شده با موفقیت: "+evaluated.length,
    "خطاهای دریافت داده/تحلیل: "+dataFailures.length,
    "ردشده به‌علت شروط فنی/نقدینگی: "+ruleRejected.length,
    "خطاهای صفحات CoinLore: "+coinResult.errors.length,
    "جفت‌های معاملاتی بررسی‌شده: "+candidatePairs.length+" (USD و USDT)",
    "دارای شرایط ورود و نقدینگی: "+opportunities.length,
    "حداکثر اسپرد: " + CFG.MAX_SPREAD_PCT + "% | حداقل عمق هر سمت دفتر سفارش: " + CFG.MIN_BOOK_DEPTH_USD.toLocaleString("en-US") + " USD",
    "فیلتر بازار: BTC صعودی و قدرت نسبی ارز در برابر BTC مثبت",
    "",
    opportunities.length ? "فرصت‌های واجد شرایط برای بررسی:" :
      "فعلاً سیگنال اسپات معتبر نداریم؛ هیچ نمادی همه شروط ورود و نقدینگی را هم‌زمان پاس نکرد.",
    ...opportunities.map((item, index) => (index + 1) + ". " + item.coin.name + " (" + item.coin.symbol + ") | " +
      item.pair + " | امتیاز " + item.score + " | قیمت " + formatSpotPrice(item.current) + " " + item.quote),
    "",
    ...(dataFailures.length?["","خطاهای داده (نمادها): "+dataFailures.slice(0,5).map(item=>item.coin?.symbol||"نامشخص").join("، ")]:[]),
    ...(coinResult.errors.length?["","هشدار CoinLore: "+coinResult.errors.slice(0,3).join(" | ")]:[]),
    "زمان اسکن: "+Math.round((Date.now()-started)/1000)+" ثانیه",
    "⚠️ این رتبه‌بندی احتمال‌محور است و تضمین رشد یا سود ۲۴ ساعته نیست."
  ].join("\n");
  return {report,opportunities,diagnostics:{selected:candidates.length,evaluated:evaluated.length,dataFailures:dataFailures.length,ruleRejected:ruleRejected.length,coinLorePageErrors:coinResult.errors.length,failedAssets:dataFailures.map(item=>({symbol:item.coin?.symbol||null,error:item.rejected}))}};
}

export async function runSpotAssetDetail(symbol, quote) {
  const normalizedSymbol = norm(symbol), normalizedQuote = norm(quote);
  if (!normalizedSymbol || !["USD", "USDT"].includes(normalizedQuote)) throw new Error("نماد یا ارز مظنه نامعتبر است.");
  const pairs = await getPairs();
  const coin = { symbol: normalizedSymbol, name: normalizedSymbol, volume24: 0, percent_change_24h: 0 };
  const pair = pairs.find(item => pairMatchesCoin(item, coin) && pairQuote(item) === normalizedQuote);
  if (!pair) throw new Error("جفت انتخاب‌شده دیگر در Kraken در دسترس نیست.");
  const btcPairs = findSpotPairs({ symbol: "BTC" }, pairs);
  const tickerResult = await fetchTickers([pair, ...btcPairs]);
  const selected = selectBestSpotPair([pair], tickerResult);
  const btcSelected = selectBestSpotPair(btcPairs, tickerResult);
  if (!selected) throw new Error("نقدینگی یا اسپرد جفت انتخاب‌شده دیگر قابل قبول نیست.");
  if (!btcSelected) throw new Error("جفت BTC/USD یا BTC/USDT برای فیلتر روند بازار در دسترس نیست.");
  coin.volume24 = selected.quoteVolumeUsd;
  const [book, candles, btcCandles] = await Promise.all([
    fetchOrderBook(pair), fetchCandles(pair), fetchCandles(btcSelected.pair)
  ]);
  const depth = calculateDepth(book, (selected.bid + selected.ask) / 2);
  const btcContext = buildBtcContext(btcCandles, btcSelected.last);
  if (candles.length < 25) throw new Error("برای محاسبه تغییر ۲۴ ساعته، حداقل ۲۵ کندل لازم است.");
  const assetChange24Pct = (selected.last / candles.at(-25).close - 1) * 100;
  coin.percent_change_24h = assetChange24Pct;
  const item = analyze(coin, candles, {
    ...selected, pair: pair.wsname, bidDepthUsd: depth.bidUsd, askDepthUsd: depth.askUsd,
    btcTrendUp: btcContext.btcTrendUp,
    relativeStrength24Pct: assetChange24Pct - btcContext.btcChange24Pct
  });
  const detail = formatCoin(item) + "\n\n" +
    (item.eligible ? "✅ شرایط فنی و نقدینگی در زمان بررسی برقرار است." :
      "⚠️ این نماد اکنون تمام شروط ورود را ندارد؛ از ورود صرفاً بر اساس این گزارش خودداری کن.\nدلایل: " + item.reasons.join("، ")) +
    "\n\n⏱ افق بررسی: ۲۴ ساعت آینده؛ بدون تضمین نتیجه.";
  return { item, detail };
}
