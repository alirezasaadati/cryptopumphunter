// Independent EMA20 pullback LONG engine. Experimental only; not wired into production.
export const EMA20_PULLBACK_LONG_VERSION = "1.0.0";

function num(v) { const n=Number(v); return Number.isFinite(n)?n:null; }
function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k=2/(period+1);
  let current=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  const out=Array(period-1).fill(null);
  out.push(current);
  for(let i=period;i<values.length;i++){ current=values[i]*k+current*(1-k); out.push(current); }
  return out;
}
function atr(candles, period=14) {
  if(candles.length<period+1)return null;
  const tr=[];
  for(let i=1;i<candles.length;i++){
    const h=num(candles[i].high),l=num(candles[i].low),pc=num(candles[i-1].close);
    if([h,l,pc].some(x=>x===null))return null;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  const tail=tr.slice(-period);
  return tail.reduce((a,b)=>a+b,0)/tail.length;
}

/**
 * Analyze only completed 15m candles.
 * candles: symbol OHLCV, oldest -> newest.
 * btcCandles: BTC 15m OHLCV, oldest -> newest.
 */
export function analyzeEma20PullbackLong({
  symbol, candles, btcCandles, options={}
}={}) {
  const cfg={
    touchTolerancePct: options.touchTolerancePct ?? 0.15,
    maxExtensionAtr: options.maxExtensionAtr ?? 0.50,
    maxStopPct: options.maxStopPct ?? 1.50,
    minStopPct: options.minStopPct ?? 0.10,
    stopBufferAtr: options.stopBufferAtr ?? 0.03
  };
  const reject=(reason,diagnostics={})=>({symbol,side:"LONG",engine:EMA20_PULLBACK_LONG_VERSION,eligible:false,rejected:reason,...diagnostics});
  if(!Array.isArray(candles)||candles.length<55)return reject("برای محاسبه EMA20 و EMA50 حداقل ۵۵ کندل ۱۵دقیقه‌ای لازم است");
  if(!Array.isArray(btcCandles)||btcCandles.length<20)return reject("داده کافی ۱۵دقیقه‌ای بیت‌کوین موجود نیست");
  const closes=candles.map(c=>num(c.close));
  const btcCloses=btcCandles.map(c=>num(c.close));
  if(closes.some(x=>x===null||x<=0)||btcCloses.some(x=>x===null||x<=0))return reject("داده قیمت کندل‌ها نامعتبر است");
  const e20s=emaSeries(closes,20),e50s=emaSeries(closes,50),btc20s=emaSeries(btcCloses,20);
  const i=closes.length-1,last=candles[i],previous=candles[i-1];
  const e20=e20s[i],e50=e50s[i],e20Prev=e20s[i-1],e50Prev=e50s[i-1];
  const btcClose=btcCloses.at(-1),btcE20=btc20s.at(-1);
  const price=closes[i],open=num(last.open),low=num(last.low),prevLow=num(previous.low),volatility=atr(candles,14);
  if([e20,e50,e20Prev,e50Prev,btcE20,open,low,prevLow,volatility].some(x=>x===null)||volatility<=0)return reject("محاسبه EMA یا ATR معتبر نیست");
  const trendUp=e20>e50&&e20>e20Prev&&e50>e50Prev&&price>e20&&price>e50;
  if(!trendUp)return reject("روند صعودی تأیید نشد: EMA20 باید بالای EMA50 و هر دو دارای شیب مثبت باشند و قیمت بالای هر دو باشد",{diagnostics:{ema20:e20,ema50:e50,ema20Previous:e20Prev,ema50Previous:e50Prev,close:price}});
  if(!(btcClose>btcE20))return reject("فیلتر بیت‌کوین تأیید نشد: قیمت BTC بالای EMA20 نیست",{diagnostics:{btcClose,btcEma20:btcE20}});
  const bullish=price>open;
  const touchLevel=e20*(1+cfg.touchTolerancePct/100);
  const touched=low<=touchLevel;
  if(!touched||!bullish||price<e20)return reject("برخورد به EMA20 و بسته‌شدن کندل صعودی روی/بالای آن تأیید نشد",{diagnostics:{ema20:e20,low,close:price,open,bullish,touched}});
  const extensionAtr=(price-e20)/volatility;
  if(extensionAtr>cfg.maxExtensionAtr)return reject("قیمت پس از برگشت بیش از حد از EMA20 فاصله گرفته است؛ ورود دیرهنگام ممنوع",{diagnostics:{extensionAtr,maxExtensionAtr:cfg.maxExtensionAtr}});
  // Conservative interpretation: place the stop below both EMA50 and the prior candle low.
  const stop=Math.min(e50,prevLow)-volatility*cfg.stopBufferAtr;
  const risk=price-stop,riskPct=risk/price*100;
  if(!Number.isFinite(riskPct)||riskPct<cfg.minStopPct||riskPct>cfg.maxStopPct)return reject("فاصله حد ضرر خارج از محدوده مجاز ۰٫۱ تا ۱٫۵ درصد است",{diagnostics:{entry:price,stop,riskPct,maxStopPct:cfg.maxStopPct}});
  const target=price+2*risk;
  return {
    symbol,side:"LONG",engine:EMA20_PULLBACK_LONG_VERSION,eligible:true,
    timeframe:"15m",entry:price,price,stop,target,target1:target,
    rewardRisk:2,riskPct,ema20:e20,ema50:e50,btcEma20:btcE20,
    btcClose,atr:volatility,extensionAtr,candleTime:last.time,
    reasons:["EMA20 بالاتر از EMA50 است","شیب EMA20 و EMA50 مثبت است","قیمت بالای هر دو میانگین قرار دارد","کندل صعودی پس از برخورد به EMA20 بسته شده است","BTC بالای EMA20 قرار دارد","حد سود با نسبت ریسک به بازده ۱ به ۲ محاسبه شده است"]
  };
}
