// Pure Price Action engine. No indicators are used for signal decisions.
export const PA_CONFIG = Object.freeze({
  MIN_CANDLES_4H: 30,
  MIN_CANDLES_1H: 40,
  MIN_CANDLES_15M: 40,
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  LEVEL_TOLERANCE_PCT: 0.0018,
  MIN_RISK_PCT: 0.0015,
  MAX_RISK_PCT: 0.06,
  MIN_REWARD_RISK: 1.5,
  TARGET_R_MULTIPLES: [1.5, 2.2, 3],
  MIN_SCORE: 80
});

const finite = n => Number.isFinite(Number(n));
const median = values => {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function validateCandles(candles, min = 1) {
  if (!Array.isArray(candles) || candles.length < min) return false;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || ![c.open,c.high,c.low,c.close,c.time].every(finite) ||
        Number(c.open) <= 0 || Number(c.low) <= 0 ||
        Number(c.high) < Math.max(Number(c.open), Number(c.close)) ||
        Number(c.low) > Math.min(Number(c.open), Number(c.close))) return false;
    if (i > 0 && Number(c.time) <= Number(candles[i - 1].time)) return false;
  }
  return true;
}

export function findSwings(candles, left = PA_CONFIG.PIVOT_LEFT, right = PA_CONFIG.PIVOT_RIGHT) {
  if (!validateCandles(candles, left + right + 3)) return { highs: [], lows: [] };
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    const before = candles.slice(i-left, i);
    const after = candles.slice(i+1, i+right+1);
    if (before.every(x => c.high > x.high) && after.every(x => c.high >= x.high))
      highs.push({ index:i, time:c.time, price:c.high });
    if (before.every(x => c.low < x.low) && after.every(x => c.low <= x.low))
      lows.push({ index:i, time:c.time, price:c.low });
  }
  return { highs, lows };
}

export function describeStructure(candles) {
  const swings = findSwings(candles);
  const h = swings.highs.slice(-3), l = swings.lows.slice(-3);
  if (h.length < 2 || l.length < 2) return { direction:"UNKNOWN", swings };
  const higherHigh = h.at(-1).price > h.at(-2).price;
  const higherLow = l.at(-1).price > l.at(-2).price;
  const lowerHigh = h.at(-1).price < h.at(-2).price;
  const lowerLow = l.at(-1).price < l.at(-2).price;
  const direction = higherHigh && higherLow ? "BULLISH" :
    lowerHigh && lowerLow ? "BEARISH" : "RANGE";
  return { direction, higherHigh, higherLow, lowerHigh, lowerLow, swings };
}

function candleDirection(c) { return c.close > c.open ? "LONG" : c.close < c.open ? "SHORT" : null; }
function body(c) { return Math.abs(c.close-c.open); }
function range(c) { return c.high-c.low; }
function lowerWick(c) { return Math.min(c.open,c.close)-c.low; }
function upperWick(c) { return c.high-Math.max(c.open,c.close); }
function near(price, level) {
  return Math.abs(price-level)/level <= PA_CONFIG.LEVEL_TOLERANCE_PCT;
}
function recentMedianRange(candles) {
  return median(candles.slice(-20).map(range).filter(x=>x>0));
}
function levelBuffer(candles, entry) {
  return Math.max(recentMedianRange(candles)*0.18, entry*0.0005);
}
function makePlan({symbol, side, strategyId, strategyName, score, reason, entry, invalidation, context}) {
  if (![entry,invalidation].every(finite) || entry<=0) return null;
  const risk = side==="LONG" ? entry-invalidation : invalidation-entry;
  const riskPct = risk/entry;
  if (!(risk>0) || riskPct<PA_CONFIG.MIN_RISK_PCT || riskPct>PA_CONFIG.MAX_RISK_PCT) return null;
  const direction = side==="LONG" ? 1 : -1;
  const targets = PA_CONFIG.TARGET_R_MULTIPLES.map(r=>entry+direction*risk*r);
  return {
    symbol, side, strategyId, strategyName, score,
    entry, stop:invalidation, target1:targets[0], target2:targets[1], target3:targets[2],
    rewardRisk:PA_CONFIG.MIN_REWARD_RISK, reason, context,
    timeframes:["4h","1h","15m"], setupTime:context.triggerTime
  };
}
function bestSwing(swings, side, beforeIndex=Infinity) {
  const list = side==="LONG" ? swings.lows : swings.highs;
  return [...list].reverse().find(x=>x.index<beforeIndex) || null;
}
function lastClosed(candles) { return candles[candles.length-1]; }
function scoreBase(...checks) { return Math.min(95, 50+checks.filter(Boolean).length*15); }

function structureStrategy({symbol, oneHour, fourHour, fifteenMin}) {
  const s1=describeStructure(oneHour), s4=describeStructure(fourHour);
  const swings=findSwings(oneHour), prev=oneHour.at(-2), last=lastClosed(oneHour), trigger=lastClosed(fifteenMin);
  const high=swings.highs.at(-1), low=swings.lows.at(-1);
  let side=null, evidence="";
  if (high && last.close>high.price && prev.close<=high.price && candleDirection(trigger)==="LONG") {
    side="LONG"; evidence="شکست صعودی سقف نوسانی در 1H و تأیید کندل 15M";
  } else if (low && last.close<low.price && prev.close>=low.price && candleDirection(trigger)==="SHORT") {
    side="SHORT"; evidence="شکست نزولی کف نوسانی در 1H و تأیید کندل 15M";
  }
  if (!side) return null;
  const swing=bestSwing(swings,side,oneHour.length-1);
  if (!swing) return null;
  return makePlan({symbol,side,strategyId:"market_structure",strategyName:"ساختار بازار",score:scoreBase(body(trigger)/Math.max(range(trigger),Number.EPSILON)>=0.45,sideMatchesStructure(s1.direction,side),sideMatchesStructure(s4.direction,side)),reason:evidence,entry:trigger.close,invalidation:side==="LONG"?swing.price-levelBuffer(fifteenMin,trigger.close):swing.price+levelBuffer(fifteenMin,trigger.close),context:{oneHourStructure:s1.direction,fourHourStructure:s4.direction,triggerTime:trigger.time}});
}

function rejectionStrategy({symbol, oneHour, fourHour, fifteenMin}) {
  const swings=findSwings(oneHour), c=lastClosed(fifteenMin), prev=fifteenMin.at(-2);
  const s1=describeStructure(oneHour).direction,s4=describeStructure(fourHour).direction;
  const candidates=[
    ...swings.lows.map(x=>({side:"LONG",level:x.price,index:x.index})),
    ...swings.highs.map(x=>({side:"SHORT",level:x.price,index:x.index}))
  ].filter(x=>x.index<oneHour.length-2 && oneHour.length-1-x.index<=48);
  const touched=candidates.filter(x=>x.side==="LONG"
    ? c.low<=x.level*(1+PA_CONFIG.LEVEL_TOLERANCE_PCT) && c.close>x.level
    : c.high>=x.level*(1-PA_CONFIG.LEVEL_TOLERANCE_PCT) && c.close<x.level);
  const hit=touched.sort((a,b)=>Math.abs((a.side==="LONG"?c.low:c.high)-a.level)-
    Math.abs((b.side==="LONG"?c.low:c.high)-b.level))[0];
  if (!hit) return null;
  const bullish=hit.side==="LONG" && lowerWick(c)>body(c)*1.5 && c.close>c.open;
  const bearish=hit.side==="SHORT" && upperWick(c)>body(c)*1.5 && c.close<c.open;
  if (!(bullish||bearish)) return null;
  const pad=levelBuffer(fifteenMin,c.close);
  return makePlan({symbol,side:hit.side,strategyId:"sr_rejection",strategyName:"برگشت از حمایت/مقاومت",score:scoreBase((hit.side==="LONG"?lowerWick(c):upperWick(c))>=body(c)*2,sideMatchesStructure(s1,hit.side),sideMatchesStructure(s4,hit.side),candleDirection(prev)===hit.side),reason:"واکنش و سایه رد قیمت در سطح ساختاری 1H همراه با بسته‌شدن تأییدی 15M",entry:c.close,invalidation:hit.side==="LONG"?Math.min(c.low,hit.level)-pad:Math.max(c.high,hit.level)+pad,context:{level:hit.level,triggerTime:c.time}});
}

function breakoutRetestStrategy({symbol, oneHour, fourHour, fifteenMin}) {
  const swings=findSwings(oneHour), c=lastClosed(fifteenMin), h=swings.highs.at(-1), l=swings.lows.at(-1);
  if (!h||!l||oneHour.length<3) return null;
  const last=lastClosed(oneHour), prev=oneHour.at(-2);
  let side=null, level=null;
  if (prev.close<=h.price && last.close>h.price &&
      c.low<=h.price*(1+PA_CONFIG.LEVEL_TOLERANCE_PCT) &&
      c.close>h.price && candleDirection(c)==="LONG") {side="LONG";level=h.price;}
  else if (prev.close>=l.price && last.close<l.price &&
      c.high>=l.price*(1-PA_CONFIG.LEVEL_TOLERANCE_PCT) &&
      c.close<l.price && candleDirection(c)==="SHORT") {side="SHORT";level=l.price;}
  if (!side) return null;
  const pad=levelBuffer(fifteenMin,c.close);
  return makePlan({symbol,side,strategyId:"breakout_retest",strategyName:"شکست و پولبک",score:scoreBase(sideMatchesStructure(describeStructure(oneHour).direction,side),Math.abs(c.close-level)/level<=0.005,body(c)/Math.max(range(c),Number.EPSILON)>=0.35),reason:"شکست تثبیت‌شده سطح 1H، بازآزمایی سطح و بسته‌شدن 15M در جهت شکست",entry:c.close,invalidation:side==="LONG"?Math.min(c.low,level)-pad:Math.max(c.high,level)+pad,context:{level,triggerTime:c.time}});
}

function candlestickStrategy({symbol, oneHour, fourHour, fifteenMin}) {
  const swings=findSwings(oneHour), c=lastClosed(fifteenMin), p=fifteenMin.at(-2);
  const support=swings.lows.at(-1), resistance=swings.highs.at(-1);
  const bullEngulf=c.close>c.open && p.close<p.open && c.open<=p.close && c.close>=p.open;
  const bearEngulf=c.close<c.open && p.close>p.open && c.open>=p.close && c.close<=p.open;
  const bullPin=lowerWick(c)>body(c)*2 && upperWick(c)<=body(c) && c.close>c.open;
  const bearPin=upperWick(c)>body(c)*2 && lowerWick(c)<=body(c) && c.close<c.open;
  let side=null, anchor=null, pattern="";
  if ((bullEngulf||bullPin)&&support&&near(c.low,support.price)) {side="LONG";anchor=support.price;pattern=bullEngulf?"Bullish Engulfing":"Bullish Pin Bar";}
  if ((bearEngulf||bearPin)&&resistance&&near(c.high,resistance.price)) {side="SHORT";anchor=resistance.price;pattern=bearEngulf?"Bearish Engulfing":"Bearish Pin Bar";}
  if (!side) return null;
  const pad=levelBuffer(fifteenMin,c.close);
  return makePlan({symbol,side,strategyId:"candlestick",strategyName:"الگوهای کندلی",score:scoreBase((bullEngulf||bearEngulf)?body(c)/Math.max(range(c),Number.EPSILON)>=0.35:(bullPin||bearPin),Math.abs((side==="LONG"?c.low:c.high)-anchor)/anchor<=PA_CONFIG.LEVEL_TOLERANCE_PCT,sideMatchesStructure(describeStructure(oneHour).direction,side),sideMatchesStructure(describeStructure(fourHour).direction,side)),reason:pattern+" در مجاورت سطح ساختاری 1H",entry:c.close,invalidation:side==="LONG"?Math.min(c.low,anchor)-pad:Math.max(c.high,anchor)+pad,context:{pattern,level:anchor,triggerTime:c.time}});
}

const STRATEGIES=[
  {id:"market_structure",name:"ساختار بازار",fn:structureStrategy},
  {id:"sr_rejection",name:"برگشت از حمایت/مقاومت",fn:rejectionStrategy},
  {id:"breakout_retest",name:"شکست و پولبک",fn:breakoutRetestStrategy},
  {id:"candlestick",name:"الگوهای کندلی",fn:candlestickStrategy}
];
const STRATEGY_STATUS_LABELS = Object.freeze({
  no_setup:"ستاپی پیدا نشد",
  candidate:"ستاپ اولیه پیدا شد",
  below_score:"رد به‌دلیل امتیاز ناکافی",
  late_entry:"رد به‌دلیل فاصله قیمت از ورود",
  conflict:"رد به‌دلیل تعارض جهت",
  accepted:"تأیید نهایی",
  direction_conflict:"رد به‌دلیل تعارض روند تایم‌فریم‌ها",
  strategy_error:"خطای داخلی استراتژی",
  invalid_data:"داده کندلی نامعتبر/ناکافی"
});
export function resolvePriceActionSignals(results, livePrice) {
  const price=Number(livePrice);
  const qualified=(Array.isArray(results)?results:[]).filter(x =>
    x && x.score>=PA_CONFIG.MIN_SCORE && finite(x.entry) && x.entry>0
  );
  const valid=qualified.filter(x =>
    finite(price) && price>0 && Math.abs(price-x.entry)/x.entry*100<=0.35
  );
  if (!valid.length && qualified.length && finite(price) && price>0) return {
    signals:[],conflict:false,
    rejected:"ورود دیرهنگام: قیمت لحظه‌ای بیش از 0.35٪ از نقطه ورود ستاپ فاصله گرفته است."
  };
  const sides=new Set(valid.map(x=>x.side));
  if(sides.size>1) return {
    signals:[],conflict:true,
    rejected:"دو استراتژی مستقل جهت‌های متضاد صادر کرده‌اند؛ برای این نماد سیگنال صادر نشد.",
    candidates:valid
  };
  return {signals:valid.sort((a,b)=>b.score-a.score),conflict:false};
}
function sideMatchesStructure(direction, side) {
  return (side==="LONG" && direction==="BULLISH") ||
    (side==="SHORT" && direction==="BEARISH");
}

function directionalRejection(candidate, oneHourStructure, fourHourStructure) {
  const oneHourAligned=sideMatchesStructure(oneHourStructure,candidate.side);
  const fourHourAligned=sideMatchesStructure(fourHourStructure,candidate.side);
  const fourHourOpposes=sideMatchesStructure(fourHourStructure,candidate.side==="LONG"?"SHORT":"LONG");
  // A setup must be supported by the 1H structure or by the 4H trend.
  if (!oneHourAligned && !fourHourAligned) {
    return "ساختار 1H و روند 4H هیچ‌کدام جهت این معامله را تأیید نمی‌کنند.";
  }
  // Counter-trend entries are reserved for strong, confirmed reversal patterns.
  if (fourHourOpposes) {
    const reversalSetup=["sr_rejection","candlestick"].includes(candidate.strategyId);
    if (!oneHourAligned || !reversalSetup || candidate.score<90) {
      return "روند 4H مخالف است؛ فقط برگشت قوی با تأیید ساختار 1H و امتیاز حداقل 90 پذیرفته می‌شود.";
    }
  }
  // Do not take a lower-timeframe signal directly against a confirmed 1H structure.
  if (!oneHourAligned && sideMatchesStructure(oneHourStructure,candidate.side==="LONG"?"SHORT":"LONG")) {
    return "جهت سیگنال با ساختار تأییدشده 1H مخالف است.";
  }
  return null;
}

export function analyzePriceAction({symbol, oneHour, fourHour, fifteenMin, livePrice}) {
  if (!validateCandles(oneHour,PA_CONFIG.MIN_CANDLES_1H) ||
      !validateCandles(fourHour,PA_CONFIG.MIN_CANDLES_4H) ||
      !validateCandles(fifteenMin,PA_CONFIG.MIN_CANDLES_15M)) {
    return {
      signals:[],
      rejected:"تعداد یا ساختار کندل‌های بسته‌شده کافی/معتبر نیست.",
      diagnostics:STRATEGIES.map(s=>({
        strategyId:s.id,strategyName:s.name,status:"invalid_data",
        statusLabel:STRATEGY_STATUS_LABELS.invalid_data,
        reason:"داده ورودی برای اجرای معتبر استراتژی کافی نیست."
      }))
    };
  }
  const oneHourStructure=describeStructure(oneHour).direction;
  const fourHourStructure=describeStructure(fourHour).direction;
  const evaluated=STRATEGIES.map(strategy=>{
    try {
      const candidate=strategy.fn({symbol,oneHour,fourHour,fifteenMin});
      if(candidate) candidate.context={
        ...(candidate.context||{}),oneHourStructure,fourHourStructure
      };
      return {strategy,candidate,error:null};
    } catch(error) {
      return {strategy,candidate:null,error:String(error?.message||error||"خطای ناشناخته")};
    }
  });
  const candidates=evaluated.filter(x=>x.candidate).map(x=>x.candidate);
  const qualified=candidates.filter(x=>x.score>=PA_CONFIG.MIN_SCORE);
  const directionalChecks=new Map(qualified.map(candidate=>[
    candidate,directionalRejection(candidate,oneHourStructure,fourHourStructure)
  ]));
  const directionallyValid=qualified.filter(candidate=>!directionalChecks.get(candidate));
  const resolution=resolvePriceActionSignals(directionallyValid,livePrice);
  const diagnostics=evaluated.map(({strategy,candidate,error})=>{
    let status="no_setup",reason="شرایط لازم این استراتژی در کندل‌های بررسی‌شده هم‌زمان برقرار نبود.";
    if(error) {
      status="strategy_error";reason=error;
    } else if(candidate) {
      reason=candidate.reason||"ستاپ اولیه شناسایی شد.";
      if(candidate.score<PA_CONFIG.MIN_SCORE) {
        status="below_score";
        reason += ` | امتیاز ${candidate.score} کمتر از حداقل ${PA_CONFIG.MIN_SCORE}`;
      } else if(directionalChecks.has(candidate) && directionalChecks.get(candidate)) {
        status="direction_conflict";reason=directionalChecks.get(candidate);
      } else if(resolution.conflict && (resolution.candidates||[]).includes(candidate)) {
        status="conflict";reason=resolution.rejected;
      } else if(resolution.rejected?.startsWith("ورود دیرهنگام")) {
        status="late_entry";reason=resolution.rejected;
      } else if(resolution.signals?.includes(candidate)) {
        status="accepted";
      } else {
        status="candidate";
      }
    }
    return {
      strategyId:strategy.id,strategyName:strategy.name,status,
      statusLabel:STRATEGY_STATUS_LABELS[status],
      score:candidate?.score ?? null,side:candidate?.side ?? null,reason
    };
  });
  const rejectedDirection=diagnostics.find(x=>x.status==="direction_conflict");
  return {
    ...resolution,
    rejected:resolution.rejected || (rejectedDirection ? rejectedDirection.reason : undefined),
    diagnostics
  };
}
