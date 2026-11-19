const BASE = "https://futures.kraken.com/api/charts/v1";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function fetchKrakenFuturesCandles({symbol,resolution="5m",days=90,endTime=Date.now(),fetchImpl=fetch,requestDelayMs=150}){
 if(!/^(PF|PI)_[A-Z0-9]+$/.test(symbol))throw new Error("Expected Kraken Futures perpetual symbol");
 if(resolution!=="5m")throw new Error("Only 5m candles are supported");
 if(!Number.isInteger(days)||days<1||days>180)throw new Error("days must be between 1 and 180");
 const intervalMs=300000,startMs=endTime-days*86400000,endSec=Math.floor(endTime/1000);
 let cursor=Math.floor(startMs/1000),previousLast=0;const rows=[];
 while(cursor<endSec){
  const url=new URL(`/trade/${encodeURIComponent(symbol)}/${resolution}`,BASE);
  url.searchParams.set("from",String(cursor));url.searchParams.set("to",String(endSec));
  const response=await fetchImpl(url,{headers:{accept:"application/json"}});
  if(response.status===429){const retry=Number(response.headers.get("retry-after"));await sleep(Number.isFinite(retry)&&retry>0?retry*1000:2000);continue;}
  if(!response.ok)throw new Error(`Kraken Futures candles HTTP ${response.status} for ${symbol}`);
  const body=await response.json();if(!Array.isArray(body.candles))throw new Error(`Malformed Kraken Futures candles response for ${symbol}`);
  if(!body.candles.length)break;
  const page=body.candles.map(c=>({openTime:Number(c.time),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume)})).filter(c=>Number.isFinite(c.openTime)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)).sort((a,b)=>a.openTime-b.openTime);
  if(!page.length)throw new Error(`No valid Kraken candles for ${symbol}`);
  for(const c of page)if(c.openTime>=startMs&&c.openTime+intervalMs<=endTime)rows.push({...c,closeTime:c.openTime+intervalMs-1});
  const last=page[page.length-1].openTime;if(last<=previousLast||last<cursor*1000)throw new Error(`Kraken candle pagination stalled for ${symbol}`);
  previousLast=last;if(!body.more_candles||last+intervalMs>=endTime)break;
  cursor=Math.floor((last+intervalMs)/1000);await sleep(requestDelayMs);
 }
 const unique=new Map(rows.map(c=>[c.openTime,c]));return [...unique.values()].sort((a,b)=>a.openTime-b.openTime);
}
