import { FUTURES_CONFIG, calculateAtr, evaluateFuturesEntryFilters, findLatestConfirmed15mPivot } from "../src/index.js";
function ema(values, period) { if (values.length < period) return null; const k=2/(period+1); let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period; for(let i=period;i<values.length;i++) v=values[i]*k+v*(1-k); return v; }
function rsi(values, period=14) { if(values.length<=period)return null; let g=0,l=0; for(let i=1;i<=period;i++){const d=values[i]-values[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);} let ag=g/period,al=l/period; for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;} if(al===0)return 100;if(ag===0)return 0;return 100-100/(1+ag/al); }
function average(values){return values.length?values.reduce((a,b)=>a+b,0)/values.length:0;}
function analyzeFuturesSymbol(ticker, candles1h, candles4h, candles15m, options = {}) {
  if (candles1h.length < FUTURES_CONFIG.MIN_CANDLES || candles4h.length < FUTURES_CONFIG.MIN_CANDLES) throw new Error("تعداد کندل بسته‌شده برای تحلیل ۱ساعته/۴ساعته کافی نیست.");
  const closes1h=candles1h.map(c=>c.close), closes4h=candles4h.map(c=>c.close), last=candles1h[candles1h.length-1], referencePrice=last.close;
  const e20=ema(closes1h,20),e50=ema(closes1h,50),e20_4h=ema(closes4h,20),e50_4h=ema(closes4h,50),rsiValue=rsi(closes1h,14),atr=calculateAtr(candles1h,14);
  if([e20,e50,e20_4h,e50_4h,rsiValue,atr].some(v=>!Number.isFinite(v))||atr<=0)throw new Error("محاسبه اندیکاتورها معتبر نیست.");
  const avgVol=average(candles1h.slice(-21,-1).map(c=>c.volume)),volumeRatio=avgVol>0?last.volume/avgVol:0,buffer=0.001;
  const up1h=e20>e50&&referencePrice>e20*(1+buffer),down1h=e20<e50&&referencePrice<e20*(1-buffer),up4h=e20_4h>e50_4h,down4h=e20_4h<e50_4h;
  let side=null,score=0,isStrict=false;const reasons=[];
  const strictLong=up1h&&up4h&&rsiValue>=45&&rsiValue<=68,strictShort=down1h&&down4h&&rsiValue>=32&&rsiValue<=55;
  const relaxedLong=up1h&&!down4h&&rsiValue>=40&&rsiValue<=75,relaxedShort=down1h&&!up4h&&rsiValue>=25&&rsiValue<=60,strictSetup=strictLong||strictShort;
  if(strictLong){side="LONG";isStrict=true;score=45;reasons.push("روند ۱ساعته و ۴ساعته صعودی است","قیمت بالای EMA20 قرار دارد");score+=rsiValue>=50&&rsiValue<=65?15:9;}
  else if(strictShort){side="SHORT";isStrict=true;score=45;reasons.push("روند ۱ساعته و ۴ساعته نزولی است","قیمت زیر EMA20 قرار دارد");score+=rsiValue>=35&&rsiValue<=50?15:9;}
  else if(relaxedLong){side="LONG";isStrict=false;score=40;reasons.push("ستاپ منعطف: روند ۱ساعته صعودی و ۴ساعته مخالف نیست","قیمت بالای EMA20 قرار دارد");score+=rsiValue>=48&&rsiValue<=68?12:7;}
  else if(relaxedShort){side="SHORT";isStrict=false;score=40;reasons.push("ستاپ منعطف: روند ۱ساعته نزولی و ۴ساعته مخالف نیست","قیمت زیر EMA20 قرار دارد");score+=rsiValue>=32&&rsiValue<=52?12:7;}
  else return {symbol:ticker.symbol,rejected:"حتی شرایط منعطف آزمایشی روند و RSI نیز تأیید نشد"};
  if(volumeRatio>=1.5){score+=18;reasons.push("حجم بالاتر از میانگین است");}else if(volumeRatio>=1){score+=12;reasons.push("حجم نزدیک یا بالاتر از میانگین است");}else{score+=4;reasons.push("حجم کمتر از میانگین است");}
  const change=Number(ticker.priceChangePercent)||0,alignedWithDirection=(side==="LONG"&&change>0)||(side==="SHORT"&&change<0);
  if(alignedWithDirection&&Math.abs(change)>=1)score+=8;else if(alignedWithDirection)score+=5;else score+=3;
  const funding=Number(ticker.premium?.lastFundingRate);
  if(Number.isFinite(funding)){if(side==="LONG"&&funding>0.001){score-=5;reasons.push("فاندینگ مثبت و نسبتاً بالا؛ ریسک ازدحام لانگ");}else if(side==="SHORT"&&funding< -0.001){score-=5;reasons.push("فاندینگ منفی و نسبتاً پایین؛ ریسک ازدحام شورت");}else reasons.push("فاندینگ در محدوده افراطی نیست");}else reasons.push("داده فاندینگ در دسترس نبود");
  const entryFilters=options.skipEntryFilters?{ok:true,skippedForBaseline:true}:evaluateFuturesEntryFilters({ticker,candles1h,candles15m,side,referencePrice,ema20:e20,atr});
  if(!entryFilters.ok)return {symbol:ticker.symbol,side,score:Math.max(0,Math.min(100,Math.round(score))),rejected:entryFilters.rejected,entryDiagnostics:entryFilters};
  if(!options.skipBreakoutFilter){
    const breakoutPivot=findLatestConfirmed15mPivot(candles15m,side,3,3);
    if(!breakoutPivot){
      const fallbackPivot=findLatestConfirmed15mPivot(candles15m,side==="LONG"?"SHORT":"LONG",3,3);
      if(!fallbackPivot)return {symbol:ticker.symbol,side,rejected:"پیوت شکست معتبر ۱۵دقیقه‌ای در دسترس نیست"};
      const fallbackEntry=Number(ticker.last),fallbackDistancePct=side==="LONG"?(fallbackEntry-fallbackPivot.price)/fallbackPivot.price*100:(fallbackPivot.price-fallbackEntry)/fallbackPivot.price*100;
      if(!Number.isFinite(fallbackDistancePct)||fallbackDistancePct<0||fallbackDistancePct>FUTURES_CONFIG.MAX_BREAKOUT_DISTANCE_PCT*3)return {symbol:ticker.symbol,side,rejected:"فاصله ورود تا سطح پیوت بازگشتی خارج از محدوده مجاز است",breakoutDiagnostics:{pivot:fallbackPivot,signedDistancePct:fallbackDistancePct,maxDistancePct:FUTURES_CONFIG.MAX_BREAKOUT_DISTANCE_PCT*3,path:"fallback"}};
      reasons.push("فاصله قیمت از پیوت بازگشتی ۱۵دقیقه‌ای در محدوده مجاز است");
    }else{
      const breakoutEntryPrice=Number(ticker.last),breakoutDistancePct=side==="LONG"?(breakoutEntryPrice-breakoutPivot.price)/breakoutPivot.price*100:(breakoutPivot.price-breakoutEntryPrice)/breakoutPivot.price*100;
      if(!Number.isFinite(breakoutDistancePct)||breakoutDistancePct<0||breakoutDistancePct>FUTURES_CONFIG.MAX_BREAKOUT_DISTANCE_PCT)return {symbol:ticker.symbol,side,rejected:"فاصله ورود تا سطح شکست خارج از محدوده مجاز است",breakoutDiagnostics:{pivot:breakoutPivot,signedDistancePct:breakoutDistancePct,maxDistancePct:FUTURES_CONFIG.MAX_BREAKOUT_DISTANCE_PCT}};
      reasons.push("فاصله قیمت از پیوت شکست ۱۵دقیقه‌ای حداکثر ۰٫۳٪ است");
    }
  }
  reasons.push("قیمت لحظه‌ای در محدوده مجاز قیمت تحلیلی است","فاصله قیمت از EMA20 برای ورود قابل‌قبول است");
  if(entryFilters.momentumConfirmed&&entryFilters.pullbackConfirmed)reasons.push("مومنتوم و پولبک ۱۵دقیقه‌ای تأیید شدند");else reasons.push("تأیید ۱۵دقیقه‌ای کامل نبود؛ سیگنال به‌دلیل آن حذف نشد");
  const entry=options.skipEntryFilters?referencePrice:Number(ticker.last),swing=candles1h.slice(-8,-1),swingLow=Math.min(...swing.map(c=>c.low)),swingHigh=Math.max(...swing.map(c=>c.high));
  const stop=side==="LONG"?Math.min(swingLow,entry-atr*1.5):Math.max(swingHigh,entry+atr*1.5),risk=side==="LONG"?entry-stop:stop-entry,riskPct=risk/entry;
  if(!Number.isFinite(risk)||risk<=0||riskPct<0.002||riskPct>0.08)return {symbol:ticker.symbol,rejected:"فاصله حد ضرر غیرمنطقی است؛ سیگنال صادر نشد"};
  const direction=side==="LONG"?1:-1,target1=entry+direction*risk*1.5,target2=entry+direction*risk*2.2,target3=entry+direction*risk*3;
  score=Math.max(0,Math.min(100,Math.round(score)));
  const eligible=isStrict?strictSetup&&score>=FUTURES_CONFIG.MIN_SCORE&&volumeRatio>=0.75:score>=FUTURES_CONFIG.MIN_SCORE+8&&volumeRatio>=0.9;
  return {symbol:ticker.symbol,side,score,price:entry,entry,stop,target1,target2,target3,rewardRisk:1.5,rsi:rsiValue,ema20:e20,ema50:e50,atr,volumeRatio,funding:Number.isFinite(funding)?funding:null,quoteVolume:Number(ticker.quoteVolume)||0,change24h:change,candleTime:last.time,reasons,entryDiagnostics:entryFilters,tier:isStrict?"STANDARD":"RELAXED",eligible};
}
export { analyzeFuturesSymbol };
