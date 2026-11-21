import { FUTURES_CONFIG, calculateAtr, evaluateFuturesEntryFilters, findLatestConfirmed15mPivot } from "./index.js";
export const MIRROR_LONG_ENGINE_VERSION = "1.0.0";
function ema(v,p){if(v.length<p)return null;const k=2/(p+1);let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<v.length;i++)x=v[i]*k+x*(1-k);return x;}
function rsi(v,p=14){if(v.length<=p)return null;let g=0,l=0;for(let i=1;i<=p;i++){const d=v[i]-v[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}let ag=g/p,al=l/p;for(let i=p+1;i<v.length;i++){const d=v[i]-v[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;}if(al===0)return 100;if(ag===0)return 0;return 100-100/(1+ag/al);}
const avg=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
/** Independent mathematical mirror of the existing SHORT branch. Does not alter or invoke its decision path. */
export function analyzeMirrorLongSymbol(ticker,candles1h,candles4h,candles15m,options={}){
 if(!Array.isArray(candles1h)||!Array.isArray(candles4h)||candles1h.length<FUTURES_CONFIG.MIN_CANDLES||candles4h.length<FUTURES_CONFIG.MIN_CANDLES)return{symbol:ticker?.symbol,side:"LONG",rejected:"تعداد کندل بسته‌شده کافی نیست"};
 const c1=candles1h.map(c=>Number(c.close)),c4=candles4h.map(c=>Number(c.close)),last=candles1h.at(-1),price=Number(last.close);
 const e20=ema(c1,20),e50=ema(c1,50),e204=ema(c4,20),e504=ema(c4,50),rv=rsi(c1,14),atr=calculateAtr(candles1h,14);
 if([e20,e50,e204,e504,rv,atr].some(x=>!Number.isFinite(x))||atr<=0)return{symbol:ticker.symbol,side:"LONG",rejected:"محاسبه اندیکاتورها معتبر نیست"};
 const volumeAvg=avg(candles1h.slice(-21,-1).map(c=>Number(c.volume))),volumeRatio=volumeAvg>0?Number(last.volume)/volumeAvg:0;
 const up1h=e20>e50&&price>e20,up4h=e204>e504;
 // Inverted SHORT RSI windows: 31..52 -> 48..69; 25..60 -> 40..75.
 const strict=up1h&&up4h&&rv>=48&&rv<=69,relaxed=up1h&&e204>=e504&&rv>=40&&rv<=75;
 if(!strict&&!relaxed)return{symbol:ticker.symbol,side:"LONG",rejected:"شرایط قرینه روند و RSI تأیید نشد"};
 let score=strict?45:40;const reasons=[strict?"قرینه شورت: روند ۱ساعته و ۴ساعته صعودی است":"قرینه شورت: روند ۱ساعته صعودی و روند ۴ساعته مخالف نیست","قیمت بالای EMA20 قرار دارد"];
 // Reflected SHORT RSI score band 35..48 -> 52..65.
 score+=rv>=52&&rv<=65?15:9;
 if(volumeRatio>=1.5){score+=18;reasons.push("حجم بالاتر از میانگین است");}else if(volumeRatio>=1){score+=12;reasons.push("حجم نزدیک یا بالاتر از میانگین است");}else{score+=4;reasons.push("حجم کمتر از میانگین است");}
 const change=Number(ticker.priceChangePercent)||0;score+=change>0?8:3;
 const funding=Number(ticker.premium?.lastFundingRate);
 if(Number.isFinite(funding)){if(funding>0.001){score-=5;reasons.push("فاندینگ مثبت و نسبتاً بالا؛ ریسک ازدحام لانگ");}else reasons.push("فاندینگ در محدوده افراطی نیست");}else reasons.push("داده فاندینگ در دسترس نبود");
 const entryFilters=options.skipEntryFilters?{ok:true,skippedForBaseline:true}:evaluateFuturesEntryFilters({ticker,candles1h,candles15m,side:"LONG",referencePrice:price,ema20:e20,atr});
 if(!entryFilters.ok)return{symbol:ticker.symbol,side:"LONG",score:Math.max(0,Math.min(100,Math.round(score))),rejected:entryFilters.rejected,entryDiagnostics:entryFilters};
 if(!options.skipBreakoutFilter){const pivot=findLatestConfirmed15mPivot(candles15m,"LONG",3,3);if(!pivot)return{symbol:ticker.symbol,side:"LONG",rejected:"پیوت شکست معتبر ۱۵دقیقه‌ای در دسترس نیست"};const distance=(Number(ticker.last)-pivot.price)/pivot.price*100;if(!Number.isFinite(distance)||distance<0||distance>FUTURES_CONFIG.MAX_BREAKOUT_DISTANCE_PCT)return{symbol:ticker.symbol,side:"LONG",rejected:"فاصله ورود تا سطح شکست خارج از محدوده مجاز است",breakoutDiagnostics:{pivot,signedDistancePct:distance,maxDistancePct:FUTURES_CONFIG.MAX_BREAKOUT_DISTANCE_PCT}};reasons.push("فاصله قیمت از پیوت شکست ۱۵دقیقه‌ای در محدوده مجاز است");}
 const entry=options.skipEntryFilters?price:Number(ticker.last),swing=candles1h.slice(-8,-1),swingLow=Math.min(...swing.map(c=>Number(c.low))),stop=Math.min(swingLow,entry-atr*1.5),risk=entry-stop,riskPct=risk/entry;
 if(!Number.isFinite(risk)||risk<=0||riskPct<.002||riskPct>.08)return{symbol:ticker.symbol,side:"LONG",rejected:"فاصله حد ضرر غیرمنطقی است؛ سیگنال صادر نشد"};
 const target1=entry+risk*1.5,target2=entry+risk*2.2,target3=entry+risk*3;score=Math.max(0,Math.min(100,Math.round(score)));
 const eligible=strict&&score>=FUTURES_CONFIG.MIN_SCORE&&volumeRatio>=.75;
 return{symbol:ticker.symbol,side:"LONG",score,price:entry,entry,stop,target1,target2,target3,rewardRisk:1.5,rsi:rv,ema20:e20,ema50:e50,atr,volumeRatio,funding:Number.isFinite(funding)?funding:null,quoteVolume:Number(ticker.quoteVolume)||0,change24h:change,candleTime:last.time,reasons,entryDiagnostics:entryFilters,eligible};
}