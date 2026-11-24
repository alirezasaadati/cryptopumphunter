const CFG = Object.freeze({
  MIN_CAP: 1_000_000,
  MAX_CAP: 500_000_000,
  MIN_MARKET_VOLUME_USD: 250_000,
  MIN_PAIR_VOLUME_USD: 50_000,
  MIN_BOOK_DEPTH_USD: 5_000,
  MAX_SPREAD_PCT: 0.8,
  MAX_CANDIDATES: 15,
  MAX_RESULTS: 8,
  CONCURRENCY: 3,
  MIN_SCORE: 65,
  MIN_RR: 1.5,
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
      catch (error) { output[index] = { rejected: String(error?.message || error || "خطای ناشناخته") }; }
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

function analyze(coin, candles, market) {
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
  let target1 = resistance;
  if (setup === "شکست مقاومت") target1 = current + Math.max(resistance - support, current * 0.01);
  if (validRisk && target1 <= current) target1 = current + risk * 1.5;
  const rewardRisk = validRisk ? (target1 - current) / risk : 0;
  const target2 = validRisk ? current + risk * 2.5 : 0;
  const target3 = validRisk ? current + risk * 3.5 : 0;
  if (!validRisk) reasons.push("حد ضرر معتبر محاسبه نشد");
  if (setup === "بدون ستاپ") reasons.push("الگوی ورود مشخصی وجود ندارد");
  if (rewardRisk < CFG.MIN_RR) reasons.push("نسبت سود به ریسک کمتر از حداقل تعیین‌شده است");
  if (score < CFG.MIN_SCORE) reasons.push("امتیاز کمتر از " + CFG.MIN_SCORE + " است");

  return {
    coin, pair: market.pair, quote: market.quote, current, score, rsi: rsiValue,
    support, resistance, volumeRatio, trend: trendUp ? "صعودی" : "خنثی یا نزولی",
    setup, entry: current, stop, target1, target2, target3, rewardRisk,
    spreadPct: market.spreadPct, quoteVolumeUsd: market.quoteVolumeUsd,
    bidDepthUsd: market.bidDepthUsd, askDepthUsd: market.askDepthUsd,
    eligible: score >= CFG.MIN_SCORE && setup !== "بدون ستاپ" && volumeRatio >= 0.9 &&
      validRisk && rewardRisk >= CFG.MIN_RR &&
      market.spreadPct <= CFG.MAX_SPREAD_PCT &&
      market.bidDepthUsd >= CFG.MIN_BOOK_DEPTH_USD &&
      market.askDepthUsd >= CFG.MIN_BOOK_DEPTH_USD,
    reasons
  };
}

function formatCoin(item) {
  return "🪙 " + item.coin.name + " (" + item.coin.symbol + ")\n" +
    "جفت منتخب: " + item.pair + "\n" +
    "⭐ امتیاز: " + item.score + "/100\n" +
    "💵 قیمت بررسی: " + formatSpotPrice(item.current) + " " + item.quote + "\n" +
    "📈 روند: " + item.trend + "\n" +
    "📊 RSI: " + item.rsi.toFixed(1) + " | حجم کندل: " + item.volumeRatio.toFixed(2) + "x\n" +
    "🧩 الگو: " + item.setup + "\n" +
    "🟢 حمایت: " + formatSpotPrice(item.support) + " " + item.quote + "\n" +
    "🔴 مقاومت: " + formatSpotPrice(item.resistance) + " " + item.quote + "\n" +
    "↔️ اسپرد: " + item.spreadPct.toFixed(3) + "% | عمق bid/ask: " +
    Math.round(item.bidDepthUsd).toLocaleString("en-US") + "/" +
    Math.round(item.askDepthUsd).toLocaleString("en-US") + " USD\n" +
    "🎯 ورود: " + formatSpotPrice(item.entry) + " " + item.quote + "\n" +
    "🛑 حد ضرر: " + formatSpotPrice(item.stop) + " " + item.quote + "\n" +
    "🥇 هدف ۱: " + formatSpotPrice(item.target1) + " " + item.quote + "\n" +
    "🥈 هدف ۲: " + formatSpotPrice(item.target2) + " " + item.quote + "\n" +
    "🥉 هدف ۳: " + formatSpotPrice(item.target3) + " " + item.quote + "\n" +
    "⚖️ نسبت سود به ریسک: " + item.rewardRisk.toFixed(2) + "R";
}

async function analyzeCoinOnBestPair(coin, pairs, tickerResult) {
  const matching = findSpotPairs(coin, pairs);
  if (!matching.length) throw new Error("جفت USD یا USDT در Kraken پیدا نشد.");
  const selected = selectBestSpotPair(matching, tickerResult);
  if (!selected) throw new Error("جفت USD/USDT با حجم و اسپرد قابل قبول پیدا نشد.");
  const book = await fetchOrderBook(selected.pair);
  const depth = calculateDepth(book, (selected.bid + selected.ask) / 2);
  const candles = await fetchCandles(selected.pair);
  return analyze(coin, candles, {
    ...selected, pair: selected.pair.wsname,
    bidDepthUsd: depth.bidUsd, askDepthUsd: depth.askUsd
  });
}

export async function runSpotScan() {
  const started = Date.now();
  const coinResult = await getCoins();
  if (!coinResult.coins.length) {
    return { report: "❌ دریافت فهرست بازار از CoinLore ناموفق بود.\n" + coinResult.errors.slice(0, 5).join("\n"), opportunities: [], diagnostics: [] };
  }
  const candidates = coinResult.coins.filter(coin => {
    const cap = Number(coin.market_cap_usd), volume = Number(coin.volume24), price = Number(coin.price_usd);
    return Number.isFinite(cap) && Number.isFinite(volume) && Number.isFinite(price) &&
      cap >= CFG.MIN_CAP && cap <= CFG.MAX_CAP && volume >= CFG.MIN_MARKET_VOLUME_USD && price > 0;
  }).sort((a, b) => Number(b.volume24) - Number(a.volume24)).slice(0, CFG.MAX_CANDIDATES);
  if (!candidates.length) return { report: "⚠️ هیچ ارزی با فیلترهای اولیه ارزش بازار و حجم مطابقت نداشت.", opportunities: [], diagnostics: [] };

  let pairs;
  try { pairs = await getPairs(); }
  catch (error) { return { report: "❌ دریافت جفت‌ارزهای Kraken ناموفق بود:\n" + String(error.message || error), opportunities: [], diagnostics: [] }; }

  const candidatePairs = candidates.flatMap(coin => findSpotPairs(coin, pairs));
  let tickerResult;
  try { tickerResult = await fetchTickers(candidatePairs); }
  catch (error) { return { report: "❌ دریافت Tickerهای Kraken ناموفق بود:\n" + String(error.message || error), opportunities: [], diagnostics: [] }; }

  const analyzed = await mapLimit(candidates, CFG.CONCURRENCY, async coin => analyzeCoinOnBestPair(coin, pairs, tickerResult));
  const opportunities = analyzed.filter(item => item && item.eligible)
    .sort((a, b) => b.score - a.score || b.rewardRisk - a.rewardRisk)
    .slice(0, CFG.MAX_RESULTS);
  const report = [
    "📊 اسکن دستی بازار اسپات Kraken",
    "━━━━━━━━━━━━━━━━━━",
    "ارزهای بررسی‌شده: " + candidates.length,
    "جفت‌های معاملاتی بررسی‌شده: " + candidatePairs.length + " (USD و USDT)",
    "دارای شرایط ورود و نقدینگی: " + opportunities.length,
    "حداکثر اسپرد: " + CFG.MAX_SPREAD_PCT + "% | حداقل عمق هر سمت دفتر سفارش: " + CFG.MIN_BOOK_DEPTH_USD.toLocaleString("en-US") + " USD",
    "",
    opportunities.length ? "فرصت‌های واجد شرایط برای بررسی:" :
      "فعلاً سیگنال اسپات معتبر نداریم؛ هیچ نمادی همه شروط ورود و نقدینگی را هم‌زمان پاس نکرد.",
    ...opportunities.map((item, index) => (index + 1) + ". " + item.coin.name + " (" + item.coin.symbol + ") | " +
      item.pair + " | امتیاز " + item.score + " | قیمت " + formatSpotPrice(item.current) + " " + item.quote),
    "",
    "زمان اسکن: " + Math.round((Date.now() - started) / 1000) + " ثانیه",
    "⚠️ این رتبه‌بندی احتمال‌محور است و تضمین رشد یا سود ۲۴ ساعته نیست."
  ].join("\n");
  return { report, opportunities };
}

export async function runSpotAssetDetail(symbol, quote) {
  const normalizedSymbol = norm(symbol), normalizedQuote = norm(quote);
  if (!normalizedSymbol || !["USD", "USDT"].includes(normalizedQuote)) throw new Error("نماد یا ارز مظنه نامعتبر است.");
  const pairs = await getPairs();
  const coin = { symbol: normalizedSymbol, name: normalizedSymbol, volume24: 0, percent_change_24h: 0 };
  const pair = pairs.find(item => pairMatchesCoin(item, coin) && pairQuote(item) === normalizedQuote);
  if (!pair) throw new Error("جفت انتخاب‌شده دیگر در Kraken در دسترس نیست.");
  const tickerResult = await fetchTickers([pair]);
  const selected = selectBestSpotPair([pair], tickerResult);
  if (!selected) throw new Error("نقدینگی یا اسپرد جفت انتخاب‌شده دیگر قابل قبول نیست.");
  coin.volume24 = selected.quoteVolumeUsd;
  const dayOpen = Number(selected.ticker.o);
  coin.percent_change_24h = dayOpen > 0 ? (selected.last / dayOpen - 1) * 100 : 0;
  const book = await fetchOrderBook(pair);
  const depth = calculateDepth(book, (selected.bid + selected.ask) / 2);
  const candles = await fetchCandles(pair);
  const item = analyze(coin, candles, {
    ...selected, pair: pair.wsname, bidDepthUsd: depth.bidUsd, askDepthUsd: depth.askUsd
  });
  const detail = formatCoin(item) + "\n\n" +
    (item.eligible ? "✅ شرایط فنی و نقدینگی در زمان بررسی برقرار است." :
      "⚠️ این نماد اکنون تمام شروط ورود را ندارد؛ از ورود صرفاً بر اساس این گزارش خودداری کن.\nدلایل: " + item.reasons.join("، ")) +
    "\n\n⏱ افق بررسی: ۲۴ ساعت آینده؛ بدون تضمین نتیجه.";
  return { item, detail };
}
