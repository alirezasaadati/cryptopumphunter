import { mkdir, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const BASE = "https://data.binance.vision";
const SYMBOL = "BTCUSDT";
const DAYS = 30;
const INITIAL_EQUITY = 10000;
const POSITION_PCT = 0.10;
const EMA_LEN = 20;
const PIVOT_LEN = 10;
const VOL_MULT = 1.5;
const RR = 2.0;
const SL_BUFFER = 0.001;
const MINUTE = 60_000;
const DAY = 86400_000;

function unzipFirstFile(buffer) {
  let eocd=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65558);i--) {
    if(buffer.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  }
  if(eocd<0) throw new Error("Invalid ZIP: end-of-central-directory not found");
  const entries=buffer.readUInt16LE(eocd+10), cdOffset=buffer.readUInt32LE(eocd+16);
  let p=cdOffset;
  for(let n=0;n<entries;n++) {
    if(buffer.readUInt32LE(p)!==0x02014b50) throw new Error("Invalid ZIP central directory");
    const method=buffer.readUInt16LE(p+10), compressed=buffer.readUInt32LE(p+20);
    const nameLen=buffer.readUInt16LE(p+28), extraLen=buffer.readUInt16LE(p+30), commentLen=buffer.readUInt16LE(p+32);
    const localOffset=buffer.readUInt32LE(p+42);
    const name=buffer.toString("utf8",p+46,p+46+nameLen);
    if(!name.endsWith("/")) {
      const localNameLen=buffer.readUInt16LE(localOffset+26), localExtraLen=buffer.readUInt16LE(localOffset+28);
      const dataStart=localOffset+30+localNameLen+localExtraLen;
      const compressedData=buffer.subarray(dataStart,dataStart+compressed);
      if(method===0) return compressedData.toString("utf8");
      if(method===8) return inflateRawSync(compressedData).toString("utf8");
      throw new Error("Unsupported ZIP compression method "+method);
    }
    p+=46+nameLen+extraLen+commentLen;
  }
  throw new Error("ZIP contains no data file");
}

async function loadCandles() {
  // Use the last 30 complete UTC days; the current partial UTC day is excluded.
  const end=Math.floor(Date.now()/DAY)*DAY;
  const start=end-DAYS*DAY;
  const warmupStart=start-300*MINUTE;
  const firstDay=Math.floor(warmupStart/DAY)*DAY;
  const rows=[];
  for(let day=firstDay;day<end;day+=DAY) {
    const date=new Date(day).toISOString().slice(0,10);
    const url=BASE+"/data/futures/um/daily/klines/"+SYMBOL+"/1m/"+SYMBOL+"-1m-"+date+".zip";
    const response=await fetch(url,{headers:{accept:"application/zip"},signal:AbortSignal.timeout(30000)});
    if(!response.ok) {
      if(response.status===404) throw new Error("Binance public archive not yet available for UTC date "+date+" (HTTP 404)");
      throw new Error("Binance public archive HTTP "+response.status+" for "+date);
    }
    const csv=unzipFirstFile(Buffer.from(await response.arrayBuffer()));
    for(const line of csv.trim().split(/\\r?\\n/)) {
      if(!line) continue;
      const r=line.split(",");
      const c={time:Number(r[0]),open:+r[1],high:+r[2],low:+r[3],close:+r[4],volume:+r[5],closeTime:Number(r[6])};
      if(c.time>=warmupStart&&c.time<end&&[c.time,c.open,c.high,c.low,c.close,c.volume,c.closeTime].every(Number.isFinite)) rows.push(c);
    }
  }
  const unique=new Map(rows.map(c=>[c.time,c]));
  const candles=[...unique.values()].sort((a,b)=>a.time-b.time);
  return {candles,start,end,warmupStart};
}

