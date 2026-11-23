// Rabbit: counter-trend SHORT engine for temporary corrections during strong bull markets.
// Pure analysis only: no exchange calls, order execution, or mutation of Kraken/V4.8 logic.

const DEFAULTS = Object.freeze({
  minBullTrendBars: 60, surgeLookback: 8, minSurgePct: 2.2, minSurgeAtr: 2.6,
  minExtensionAtr: 1.35, minRsi15m: 68, minVolumeRatio: 0.75,
  stopBufferAtr: 0.2, minRiskPct: 0.2, maxRiskPct: 5.0,
  maxEntryDriftPct: 0.8, minScore: 70
});
function finitePositive(value) { const n=Number(value); return Number.isFinite(n)&&n>0; }
function ema(values,period) {
  if(!Array.isArray(values)||values.length<period)return null;
  const k=2/(period+1);let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++)v=values[i]*k+v*(1-k);return v;
}
function rsi(values,period=14) {
  if(!Array.isArray(values)||values.length<=period)return null;
  let gains=0,losses=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gains+=Math.max(d,0);losses+=Math.max(-d,0);}
  let ag=gains/period,al=losses/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}
  if(ag===0&&al===0)return 50;if(al===0)return 100;if(ag===0)return 0;return 100-100/(1+ag/al);
}
function atr(candles,period=14) {
  if(!Array.isArray(candles)||candles.length<=period)return null;
  const ranges=[];for(let i=1;i<candles.length;i++){const c=candles[i],p=Number(candles[i-1].close);ranges.push(Math.max(Number(c.high)-Number(c.low),Math.abs(Number(c.high)-p),Math.abs(Number(c.low)-p)));}
  const xs=ranges.slice(-period);return xs.reduce((a,b)=>a+b,0)/xs.length;
}
function reject(reason,diagnostics={}){return {eligible:false,engine:"Rabbit",side:"SHORT",rejected:reason,diagnostics};}

export function analyzeRabbitCorrection(input={},overrides={}) {
  const cfg={...DEFAULTS,...overrides},one=input.candles1h,four=input.candles4h,fifteen=input.candles15m;
  if(![one,four,fifteen].every(Array.isArray)||one.length<cfg.minBullTrendBars||four.length<cfg.minBullTrendBars||fifteen.length<40)
    return reject("داده بسته‌شده ۱ساعته، ۴ساعته یا ۱۵دقیقه‌ای کافی نیست");
  const c1=one.map(c=>Number(c.close)),c4=four.map(c=>Number(c.close)),c15=fifteen.map(c=>Number(c.close));
  if(![...c1,...c4,...c15].every(finitePositive))return reject("داده قیمت نامعتبر است");
  const last1=one.at(-1),last4=four.at(-1),last15=fifteen.at(-1);
  const e20_1=ema(c1,20),e50_1=ema(c1,50),e20_4=ema(c4,20),e50_4=ema(c4,50);
  if(![e20_1,e50_1,e20_4,e50_4].every(Number.isFinite))return reject("محاسبه روند بالادستی معتبر نیست");
  const bullish1h=e20_1>e50_1&&last1.close>e20_1,bullish4h=e20_4>e50_4&&last4.close>e20_4;
  if(!bullish1h||!bullish4h)return reject("Rabbit فقط در روند صعودی هم‌جهت ۱ساعته و ۴ساعته فعال می‌شود",{bullish1h,bullish4h,e20_1h:e20_1,e50_1h:e50_1,e20_4h:e20_4,e50_4h:e50_4});
  const atr15=atr(fifteen,14),e9=ema(c15,9),e20=ema(c15,20),rsi15=rsi(c15,14);
  if(![atr15,e9,e20,rsi15].every(Number.isFinite)||atr15<=0)return reject("اندیکاتورهای ۱۵دقیقه‌ای معتبر نیستند");
  const lookback=cfg.surgeLookback,surgeBars=fifteen.slice(-(lookback+1),-1);
  if(surgeBars.length<lookback)return reject("تعداد کندل برای سنجش جهش کافی نیست");
  const surgeStart=Number(surgeBars[0].open),surgeHigh=Math.max(...surgeBars.map(c=>Number(c.high)));
  const surgePct=(surgeHigh/surgeStart-1)*100,surgeAtr=(surgeHigh-surgeStart)/atr15,extensionAtr=(surgeHigh-e20)/atr15;
  if(surgePct<cfg.minSurgePct||surgeAtr<cfg.minSurgeAtr||extensionAtr<cfg.minExtensionAtr)
    return reject("جهش صعودی هنوز به محدوده بیش‌ازحد کشیده‌شده نرسیده است",{surgePct,surgeAtr,extensionAtr,requiredSurgePct:cfg.minSurgePct,requiredSurgeAtr:cfg.minSurgeAtr,requiredExtensionAtr:cfg.minExtensionAtr});
  const prior=fifteen.slice(-3,-1),priorLow=Math.min(...prior.map(c=>Number(c.low)));
  const avgVolume=fifteen.slice(-21,-1).reduce((s,c)=>s+Number(c.volume||0),0)/20;
  const volumeRatio=avgVolume>0?Number(last15.volume||0)/avgVolume:0;
  const bearish=Number(last15.close)<Number(last15.open),breakdown=Number(last15.close)<priorLow&&Number(last15.close)<e9;
  if(!bearish||!breakdown)return reject("شروع اصلاح هنوز تأیید نشده؛ شکست کف کوتاه‌مدت و بسته‌شدن زیر EMA9 لازم است",{bearishCandle:bearish,breakdown,priorLow,close15m:last15.close,ema9_15m:e9,rsi15});
  if(rsi15<cfg.minRsi15m)return reject("شتاب صعودی/اشباع خرید برای ستاپ Rabbit کافی نیست",{rsi15,requiredRsi:cfg.minRsi15m});
  if(volumeRatio<cfg.minVolumeRatio)return reject("حجم کندل تأیید اصلاح پایین‌تر از حداقل است",{volumeRatio,requiredVolumeRatio:cfg.minVolumeRatio});
  const entry=Number(input.price??input.ticker?.last??last15.close);
  if(!finitePositive(entry))return reject("قیمت ورود معتبر نیست");
  const driftPct=Math.abs(entry-Number(last15.close))/Number(last15.close)*100;
  if(driftPct>cfg.maxEntryDriftPct)return reject("قیمت از کندل تأیید بیش از حد فاصله گرفته است",{driftPct});
  const swingHigh=Math.max(...fifteen.slice(-lookback-1).map(c=>Number(c.high))),stop=swingHigh+atr15*cfg.stopBufferAtr;
  const risk=stop-entry,riskPct=risk/entry*100;
  if(!(risk>0)||riskPct<cfg.minRiskPct||riskPct>cfg.maxRiskPct)return reject("فاصله حد ضرر برای Rabbit خارج از محدوده ایمنی است",{riskPct,stop,entry});
  const score=Math.min(100,Math.round(35+Math.min(20,(surgePct/cfg.minSurgePct)*8)+Math.min(15,(extensionAtr/cfg.minExtensionAtr)*5)+Math.min(15,Math.max(0,rsi15-cfg.minRsi15m)*1.5)+Math.min(10,volumeRatio*5)+10));
  if(score<cfg.minScore)return reject("امتیاز ستاپ Rabbit به حداقل لازم نرسید",{score});
  return {eligible:true,engine:"Rabbit",side:"SHORT",strategy:"BULL_RALLY_CORRECTION",score,riskLevel:"EXPERIMENTAL",
    entry,price:entry,stop,target1:entry-risk,target2:entry-risk*1.5,target3:entry-risk*2,rewardRisk:1,
    riskPct,rsi15m:rsi15,atr15m:atr15,surgePct,surgeAtr,extensionAtr,volumeRatio,ema9_15m:e9,ema20_15m:e20,
    reasons:["روند ۱ساعته و ۴ساعته هر دو صعودی است","جهش صعودی کوتاه‌مدت و فاصله غیرعادی از EMA20 شناسایی شد","کندل ۱۵دقیقه‌ای نزولی، کف دو کندل قبلی را شکست و زیر EMA9 بسته شد","RSI و حجم، برگشت کوتاه‌مدت را تأیید کردند"]};
}
export const RABBIT_DEFAULTS=DEFAULTS;
export {ema as rabbitEma,rsi as rabbitRsi,atr as rabbitAtr};
