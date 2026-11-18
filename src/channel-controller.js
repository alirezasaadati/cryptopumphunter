// Experimental channel-style manager: two equal entries, five staged targets.
export const CHANNEL_TARGET_PCTS = [0.01, 0.03, 0.06, 0.10, 0.14];
export const CHANNEL_ENTRY2_PCT = 0.028;
export const EXIT_ALLOCATIONS = {
  front_loaded: [0.40, 0.25, 0.15, 0.10, 0.10],
  equal: [0.20, 0.20, 0.20, 0.20, 0.20],
  back_loaded: [0.10, 0.15, 0.20, 0.25, 0.30],
};
function direction(side) {
  if (side === "LONG") return 1;
  if (side === "SHORT") return -1;
  throw new Error("side must be LONG or SHORT");
}
export function createChannelPosition(signal, allocation = "front_loaded", options = {}) {
  const dir = direction(signal.side), entry = Number(signal.entry), stop = Number(signal.stop);
  const weights = Array.isArray(allocation) ? allocation : EXIT_ALLOCATIONS[allocation];
  const targetPcts = options.targetPcts || CHANNEL_TARGET_PCTS;
  if (!(entry > 0) || !(stop > 0) || (dir === 1 ? stop >= entry : stop <= entry)) throw new Error("invalid entry/stop levels");
  if (!weights || weights.length !== 5 || Math.abs(weights.reduce((a,b)=>a+b,0)-1) > 1e-8) throw new Error("five exit weights must sum to 1");
  return {
    symbol: signal.symbol, side: signal.side, dir, entry1: entry, entry2: null,
    entry2Trigger: entry * (1 - dir * (options.entry2Pct ?? CHANNEL_ENTRY2_PCT)),
    averageEntry: entry, stop, initialStop: stop, targetPcts: [...targetPcts],
    targets: targetPcts.map(p => entry * (1 + dir * p)), weights: [...weights],
    remaining: 1, realizedPnl: 0, realizedQty: 0, targetHits: [],
    entry2Cancelled: false, status: "OPEN", entryTime: signal.entryTime ?? null,
    exitReason: null, exitTime: null, fills: [{kind:"ENTRY",price:entry,qty:1}],
    moveStopToBreakeven: options.moveStopToBreakeven === true,
  };
}
// OHLC ambiguity is resolved conservatively: stop first; if TP1 and entry2
// are both touched in one candle, assume TP1 came first and cancel entry2.
export function processChannelCandle(p, candle) {
  if (p.status !== "OPEN") return p;
  const dir=p.dir, high=Number(candle.high), low=Number(candle.low);
  const stopHit=dir===1?low<=p.stop:high>=p.stop;
  const entry2Hit=p.entry2===null&&!p.entry2Cancelled&&(dir===1?low<=p.entry2Trigger:high>=p.entry2Trigger);
  if (stopHit) {
    p.fills.push({kind:"EXIT",price:p.stop,qty:p.remaining,reason:"STOP"});
    p.realizedPnl+=p.remaining*dir*(p.stop-p.averageEntry);p.realizedQty+=p.remaining;p.remaining=0;
    p.status="CLOSED";p.exitReason="STOP";p.exitTime=candle.time;return p;
  }
  const tp1Hit=dir===1?high>=p.targets[0]:low<=p.targets[0];
  if(entry2Hit&&tp1Hit)p.entry2Cancelled=true;
  if(entry2Hit&&!p.entry2Cancelled){
    const trigger=dir===1?Math.min(p.entry2Trigger,Number(candle.open)||p.entry2Trigger):Math.max(p.entry2Trigger,Number(candle.open)||p.entry2Trigger);
    p.entry2=trigger;p.fills.push({kind:"ENTRY",price:trigger,qty:1});
    p.averageEntry=(p.entry1+p.entry2)/2;p.remaining=2;
    p.targets=p.targetPcts.map(x=>p.averageEntry*(1+dir*x));
  }
  for(let i=0;i<5&&p.remaining>1e-9;i++){
    if(p.targetHits.includes(i+1))continue;
    const hit=dir===1?high>=p.targets[i]:low<=p.targets[i];
    if(!hit)break;
    const qty=Math.min(p.remaining,(p.entry2===null?1:2)*p.weights[i]);
    p.fills.push({kind:"EXIT",price:p.targets[i],qty,reason:"TP"+(i+1)});
    p.realizedPnl+=qty*dir*(p.targets[i]-p.averageEntry);p.realizedQty+=qty;p.remaining-=qty;p.targetHits.push(i+1);
    if(i===0&&p.entry2===null)p.entry2Cancelled=true;
    if(i===0&&p.moveStopToBreakeven)p.stop=p.averageEntry;
  }
  if(p.remaining<=1e-9){p.remaining=0;p.status="CLOSED";p.exitReason="ALL_TARGETS";p.exitTime=candle.time;}
  return p;
}
export function closeChannelPosition(p,price,time,reason="TIME_EXIT"){
  if(p.status!=="OPEN")return p;
  const px=Number(price);
  p.fills.push({kind:"EXIT",price:px,qty:p.remaining,reason});
  p.realizedPnl+=p.remaining*p.dir*(px-p.averageEntry);p.realizedQty+=p.remaining;p.remaining=0;
  p.status="CLOSED";p.exitReason=reason;p.exitTime=time;return p;
}
