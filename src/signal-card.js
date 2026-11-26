import { displayEntryPrice } from "./futures-alerts.js";

const LW = 960, LH = 680, SCALE = 7 / 12, WIDTH = 560, HEIGHT = 397;
const COLORS = {
  bg: "#07090D", panel: "#0E1219", gold: "#D6B35A", border: "#6F5727",
  white: "#F4F5F7", muted: "#8B95A3", green: "#35D39A", red: "#FF6570"
};
const PALETTE = [COLORS.bg, COLORS.panel, COLORS.gold, COLORS.border, COLORS.white, COLORS.muted, COLORS.green, COLORS.red];
const COLOR_INDEX = Object.fromEntries(PALETTE.map((color, index) => [color, index]));
const FONT = {
A:["01110","10001","10001","11111","10001","10001","10001"],B:["11110","10001","10001","11110","10001","10001","11110"],C:["01111","10000","10000","10000","10000","10000","01111"],D:["11110","10001","10001","10001","10001","10001","11110"],E:["11111","10000","10000","11110","10000","10000","11111"],F:["11111","10000","10000","11110","10000","10000","10000"],G:["01111","10000","10000","10111","10001","10001","01111"],H:["10001","10001","10001","11111","10001","10001","10001"],I:["11111","00100","00100","00100","00100","00100","11111"],J:["00111","00010","00010","00010","10010","10010","01100"],K:["10001","10010","10100","11000","10100","10010","10001"],L:["10000","10000","10000","10000","10000","10000","11111"],M:["10001","11011","10101","10101","10001","10001","10001"],N:["10001","11001","10101","10011","10001","10001","10001"],O:["01110","10001","10001","10001","10001","10001","01110"],P:["11110","10001","10001","11110","10000","10000","10000"],Q:["01110","10001","10001","10001","10101","10010","01101"],R:["11110","10001","10001","11110","10100","10010","10001"],S:["01111","10000","10000","01110","00001","00001","11110"],T:["11111","00100","00100","00100","00100","00100","00100"],U:["10001","10001","10001","10001","10001","10001","01110"],V:["10001","10001","10001","10001","10001","01010","00100"],W:["10001","10001","10001","10101","10101","10101","01010"],X:["10001","10001","01010","00100","01010","10001","10001"],Y:["10001","10001","01010","00100","00100","00100","00100"],Z:["11111","00001","00010","00100","01000","10000","11111"],
"0":["01110","10001","10011","10101","11001","10001","01110"],"1":["00100","01100","00100","00100","00100","00100","01110"],"2":["01110","10001","00001","00010","00100","01000","11111"],"3":["11110","00001","00001","01110","00001","00001","11110"],"4":["00010","00110","01010","10010","11111","00010","00010"],"5":["11111","10000","10000","11110","00001","00001","11110"],"6":["01110","10000","10000","11110","10001","10001","01110"],"7":["11111","00001","00010","00100","01000","01000","01000"],"8":["01110","10001","10001","01110","10001","10001","01110"],"9":["01110","10001","10001","01111","00001","00001","01110"],
"/":["00001","00010","00010","00100","01000","01000","10000"],".":["00000","00000","00000","00000","00000","00110","00110"],",":["00000","00000","00000","00000","00110","00110","00100"],":":["00000","00110","00110","00000","00110","00110","00000"],"-":["00000","00000","00000","11111","00000","00000","00000"],"+":["00000","00100","00100","11111","00100","00100","00000"],"%":["11001","11010","00100","01000","10110","00110","00000"],"#":["01010","11111","01010","01010","11111","01010","00000"]," ":["00000","00000","00000","00000","00000","00000","00000"]
};
const pixels = new Uint8Array(WIDTH * HEIGHT);

function rect(x, y, width, height, color) {
  x = Math.round(x * SCALE); y = Math.round(y * SCALE);
  width = Math.max(1, Math.round(width * SCALE)); height = Math.max(1, Math.round(height * SCALE));
  const index = COLOR_INDEX[color] ?? 0, x0 = Math.max(0, x), x1 = Math.min(WIDTH, x + width);
  for (let row = Math.max(0, y); row < Math.min(HEIGHT, y + height); row++) {
    pixels.fill(index, row * WIDTH + x0, row * WIDTH + x1);
  }
}
function outline(x, y, width, height, color, thickness = 2) {
  rect(x,y,width,thickness,color); rect(x,y+height-thickness,width,thickness,color);
  rect(x,y,thickness,height-2*thickness,color); rect(x+width-thickness,y+thickness,thickness,height-2*thickness,color);
}
function drawText(value, x, y, scale, color, spacing = scale) {
  let cursor = x;
  for (const char of String(value ?? "—").toUpperCase()) {
    const glyph = FONT[char] || FONT[" "];
    for (let row = 0; row < 7; row++) {
      let run = -1;
      for (let col = 0; col <= 5; col++) {
        const on = glyph[row][col] === "1";
        if (on && run < 0) run = col;
        if ((!on || col === 5) && run >= 0) {
          rect(cursor + run * scale, y + row * scale, (col - run) * scale, scale, color);
          run = -1;
        }
      }
    }
    cursor += 6 * scale + spacing;
  }
  return cursor - x;
}
function drawFitText(value, x, y, maxWidth, desiredScale, color) {
  const label = String(value ?? "—").toUpperCase();
  const scale = Math.max(2, Math.min(desiredScale, Math.floor(maxWidth / (label.length * 7))));
  drawText(label, x, y, scale, color, scale);
}
function formatPrice(value) {
  if (value == null || value === "") return "—";
  const price = Number(value);
  return Number.isFinite(price)
    ? price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })
    : "—";
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function uint32(value) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}
function pngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes); crcInput.set(data, typeBytes.length);
  const chunk = new Uint8Array(12 + data.length);
  chunk.set(uint32(data.length), 0); chunk.set(crcInput, 4); chunk.set(uint32(crc32(crcInput)), 8 + data.length);
  return chunk;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
function zlibStore(bytes) {
  const blockCount = Math.ceil(bytes.length / 65535);
  const output = new Uint8Array(2 + bytes.length + blockCount * 5 + 4);
  output[0] = 0x78; output[1] = 0x01;
  let offset = 2, position = 0;
  while (position < bytes.length) {
    const length = Math.min(65535, bytes.length - position);
    output[offset++] = position + length === bytes.length ? 1 : 0;
    output[offset++] = length & 255; output[offset++] = (length >>> 8) & 255;
    const inverse = (~length) & 65535;
    output[offset++] = inverse & 255; output[offset++] = (inverse >>> 8) & 255;
    output.set(bytes.subarray(position, position + length), offset);
    offset += length; position += length;
  }
  output.set(uint32(adler32(bytes)), offset);
  return output;
}
function encodePng() {
  const packedRowBytes = WIDTH / 2;
  const raw = new Uint8Array(HEIGHT * (packedRowBytes + 1));
  for (let row = 0; row < HEIGHT; row++) {
    const outputOffset = row * (packedRowBytes + 1), inputOffset = row * WIDTH;
    raw[outputOffset] = 0;
    for (let col = 0; col < WIDTH; col += 2) {
      raw[outputOffset + 1 + col / 2] = (pixels[inputOffset + col] << 4) | pixels[inputOffset + col + 1];
    }
  }
  const header = new Uint8Array(13);
  header.set(uint32(WIDTH), 0); header.set(uint32(HEIGHT), 4); header[8] = 4; header[9] = 3;
  const palette = new Uint8Array(PALETTE.length * 3);
  for (let i = 0; i < PALETTE.length; i++) {
    const color = PALETTE[i];
    palette[i*3] = parseInt(color.slice(1,3),16);
    palette[i*3+1] = parseInt(color.slice(3,5),16);
    palette[i*3+2] = parseInt(color.slice(5,7),16);
  }
  const parts = [
    new Uint8Array([137,80,78,71,13,10,26,10]),
    pngChunk("IHDR", header), pngChunk("PLTE", palette), pngChunk("IDAT", zlibStore(raw)), pngChunk("IEND", new Uint8Array())
  ];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function getSignalCardDisplayData(signal) {
  const symbol = String(signal?.symbol || "—").toUpperCase()
    .replace(/^PF_/, "").replace(/\.P$/, "").replace(/[-_/]?(USDT|USD)$/, "").replace(/^XBT$/, "BTC");
  const names = { BTC: "BITCOIN", ETH: "ETHEREUM", SOL: "SOLANA", XRP: "XRP" };
  return {
    symbol, assetName: names[symbol] || symbol,
    side: signal?.side === "LONG" ? "LONG" : "SHORT",
    risk: signal?.riskLevel === "HIGH_RISK" ? "HIGH RISK" : "STANDARD",
    score: signal?.score
  };
}
export function renderSignalCardPng(signal) {
  rect(0,0,LW,LH,COLORS.bg);
  outline(22,22,916,636,COLORS.border,3);
  rect(48,48,5,54,COLORS.gold);
  drawText("PREMIUM SIGNALS",72,54,4,COLORS.gold,3);
  drawText("TRADEYAR",748,62,3,COLORS.white,2);
  rect(48,122,864,2,COLORS.border);

  const isLong = signal?.side === "LONG", accent = isLong ? COLORS.green : COLORS.red;
  rect(50,150,210,70,COLORS.panel); outline(50,150,210,70,accent,2);
  drawText(isLong ? "LONG" : "SHORT",74,174,5,accent,3);

  const { symbol, assetName } = getSignalCardDisplayData(signal);
  drawFitText(`${symbol}/USD`,510,158,380,5,COLORS.white);
  drawFitText(`${assetName} PERPETUAL`,512,198,380,2,COLORS.muted);

  rect(50,250,420,132,COLORS.panel); outline(50,250,420,132,COLORS.border,2);
  rect(490,250,420,132,COLORS.panel); outline(490,250,420,132,COLORS.border,2);
  drawText("STOP LOSS",78,276,3,COLORS.muted,2);
  drawFitText(formatPrice(signal?.stop),78,318,360,5,COLORS.white);
  drawText("ENTRY PRICE",518,276,3,COLORS.muted,2);
  drawFitText(formatPrice(signal?.entry),518,310,360,5,COLORS.gold);
  const entry2 = signal?.entry2 ?? displayEntryPrice(signal?.entry, signal?.side);
  drawFitText(`ENTRY 2 ${formatPrice(entry2)}`,518,354,360,3,COLORS.muted);

  drawText("TAKE PROFIT TARGETS",52,418,3,COLORS.gold,2);
  const targets = [signal?.target1, signal?.target2, signal?.target3];
  const targetX = [50,345,640];
  for (let i = 0; i < targets.length; i++) {
    rect(targetX[i],452,270,92,COLORS.panel);
    outline(targetX[i],452,270,92,COLORS.border,2);
    drawText(`TP${i+1}`,targetX[i]+22,470,3,COLORS.muted,2);
    drawFitText(formatPrice(targets[i]),targetX[i]+22,504,225,4,COLORS.white);
  }

  rect(50,578,860,2,COLORS.border);
  drawText("RISK",54,606,2,COLORS.muted,2);
  drawText(signal?.riskLevel === "HIGH_RISK" ? "HIGH RISK" : "STANDARD",140,600,3,
    signal?.riskLevel === "HIGH_RISK" ? COLORS.red : COLORS.gold,2);
  if (signal?.score != null && signal.score !== "" && Number.isFinite(Number(signal.score))) {
    drawText(`SCORE ${Math.round(Number(signal.score))}/100`,620,600,3,COLORS.white,2);
  }
  return encodePng();
}