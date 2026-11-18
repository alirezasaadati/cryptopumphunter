const finite = Number.isFinite;
const adversePrice = (price, side, action, bps) => {
  const slip=bps/10_000;
  const direction=side==="LONG"?1:-1;
  return action==="entry" ? price*(1+direction*slip) : price*(1-direction*slip);
};

/**
 * Conservative OHLC paper simulator for one signal.
 * The caller supplies targetWeights explicitly; no unverified exit allocation
 * is silently assumed. Candles must begin strictly after signal.candleTime.
 */
export function simulatePaperTrade({signal,candles,entryNotional,targetWeights,
  feeRate=0.0005,slippageBps=2,maxBars=500}) {
  if(!signal || !["LONG","SHORT"].includes(signal.side) ||
    !finite(signal.entry) || signal.entry<=0 || !finite(signal.stop) ||
    !Array.isArray(signal.targets) || !signal.targets.length ||
    !Array.isArray(targetWeights) || targetWeights.length!==signal.targets.length ||
    targetWeights.some(w=>!finite(w)||w<=0) ||
    Math.abs(targetWeights.reduce((a,b)=>a+b,0)-1)>1e-9 ||
    !finite(entryNotional)||entryNotional<=0 ||
    !finite(feeRate)||feeRate<0 || !finite(slippageBps)||slippageBps<0 ||
    !Array.isArray(candles)) return {status:"invalid_input"};
  const side=signal.side, sign=side==="LONG"?1:-1;
  const later=candles.filter(c=>c && finite(c.time) && c.time>signal.candleTime).slice(0,maxBars);
  if(!later.length) return {status:"no_future_candles"};
  const entry2=signal.entry2 ?? signal.context?.entry2 ?? null;
  if(entry2!==null && (!finite(entry2)||entry2<=0)) return {status:"invalid_input"};
  let qty=0, deployed=0, fees=0, funding=0, realized=0, entry1Filled=false;
  let entry2Filled=false, entry2Cancelled=false, nextTarget=0, remainingWeights=1;
  const fills=[], exits=[];
  const stopHit=c=>side==="LONG"?c.low<=signal.stop:c.high>=signal.stop;
  const targetHit=(c,p)=>side==="LONG"?c.high>=p:c.low<=p;
  const validCandle=c=>[c.open,c.high,c.low,c.close].every(finite) &&
    c.low>0 && c.high>=Math.max(c.open,c.close) && c.low<=Math.min(c.open,c.close);
  const closeQty=(amount,rawPrice,reason)=>{
    const q=Math.min(qty,amount);
    if(q<=0)return;
    const px=adversePrice(rawPrice,side,"exit",slippageBps);
    const pnl=(px-averageEntry())*q*sign;
    const fee=Math.abs(px*q)*feeRate;
    realized+=pnl; fees+=fee; qty-=q;
    exits.push({reason,price:px,quantity:q,grossPnl:pnl,fee});
  };
  const averageEntry=()=>fills.reduce((s,f)=>s+f.price*f.quantity,0)/(fills.reduce((s,f)=>s+f.quantity,0)||1);
  for(const c of later){
    if(!validCandle(c)) return {status:"invalid_data",fills,exits};
    if(!entry1Filled){
      const px=adversePrice(c.open,side,"entry",slippageBps);
      const q=entryNotional/px;
      fills.push({leg:1,price:px,quantity:q}); qty+=q; deployed+=entryNotional;
      fees+=entryNotional*feeRate; entry1Filled=true;
    }
    if(qty<=0) break;

    // Conservative OHLC ordering: stop wins over all targets and entry-2.
    if(stopHit(c)){
      closeQty(qty,signal.stop,"stop");
      break;
    }

    // If TP1 and the resting entry-2 are both touched in one OHLC bar,
    // assume TP1 happened first and cancel entry-2 (unknown intrabar order).
    const firstTargetTouched=nextTarget===0 && targetHit(c,signal.targets[0]);
    if(!entry2Filled && !entry2Cancelled && entry2!==null && !firstTargetTouched){
      const touched=side==="LONG"?c.low<=entry2:c.high>=entry2;
      if(touched){
        const q=entryNotional/entry2;
        fills.push({leg:2,price:entry2,quantity:q}); qty+=q; deployed+=entryNotional;
        fees+=entryNotional*feeRate; entry2Filled=true;
      }
    } else if(!entry2Filled && firstTargetTouched){
      entry2Cancelled=true;
    }

    while(nextTarget<signal.targets.length && qty>0 && targetHit(c,signal.targets[nextTarget])){
      const weight=targetWeights[nextTarget];
      const amount=nextTarget===signal.targets.length-1?qty:
        Math.min(qty,(fills.reduce((s,f)=>s+f.quantity,0))*weight);
      closeQty(amount,signal.targets[nextTarget],`target_${nextTarget+1}`);
      remainingWeights-=weight; nextTarget++;
    }
    if(qty>0 && finite(c.fundingRate)){
      // Positive funding means longs pay and shorts receive.
      funding+=sign*c.close*qty*c.fundingRate;
    }
  }
  const status=qty<=1e-12?"closed":"open";
  const mark= later.at(-1).close;
  const unrealized=status==="open"?(mark-averageEntry())*qty*sign:0;
  const grossPnl=realized+unrealized;
  const netPnl=grossPnl-fees-funding;
  return {status,side,entry1Filled,entry2Filled,entry2Cancelled,fills,exits,
    averageEntry:averageEntry(),remainingQuantity:qty,deployedNotional:deployed,
    grossPnl,fees,funding,unrealized,netPnl,
    returnPct:deployed?netPnl/deployed*100:0,
    barsObserved:later.length,nextTargetIndex:nextTarget};
}
