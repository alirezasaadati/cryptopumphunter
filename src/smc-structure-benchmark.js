// Non-repainting SMC swing-structure state machine.
// Swing points are only admitted after rightBars confirmation; each level is consumed once.
function confirmedPivot(c,i,n,kind){
 const p=i-n;if(p<n)return null;const v=c[p][kind];
 for(let j=p-n;j<=p+n;j++){if(j===p)continue;if(kind==="high"?c[j].high>=v:c[j].low<=v)return null;}
 return {index:p,value:v};
}
export function buildSmcStructure(c,n=10){
 const out=Array(c.length);let hi=null,lo=null,hiBroken=true,loBroken=true,trend=0,lastEvent=-1,lastType=null;
 for(let i=0;i<c.length;i++){
  const h=confirmedPivot(c,i,n,"high"),l=confirmedPivot(c,i,n,"low");
  if(h&&(!hi||h.index>hi.index)){hi=h;hiBroken=false;}
  if(l&&(!lo||l.index>lo.index)){lo=l;loBroken=false;}
  const prev=i?c[i-1].close:null,close=c[i].close;
  const up=!!hi&&!hiBroken&&prev!==null&&prev<=hi.value&&close>hi.value;
  const down=!!lo&&!loBroken&&prev!==null&&prev>=lo.value&&close<lo.value;
  let event=0,type=null;
  if(up!==down){
   event=up?1:-1;type=trend===0||trend===event?"BOS":"CHoCH";
   if(up)hiBroken=true;else loBroken=true;
   trend=event;lastEvent=i;lastType=type;
  } else if(up&&down){hiBroken=true;loBroken=true;}
  out[i]={direction:trend,eventDirection:event,eventType:type,eventAge:lastEvent<0?Infinity:i-lastEvent,lastEventType:lastType};
 }
 return out;
}
