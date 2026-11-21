/* global console, Buffer */
/** Writes the PWA icons as real PNG files with no dependencies: three candles on the app background. */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const BG = [10, 12, 15], UP = [61, 214, 140], DOWN = [255, 107, 107];
// x center, wick top, body top, body bottom, wick bottom (unit square), colour
const CANDLES = [[0.27, 0.44, 0.52, 0.72, 0.8, UP], [0.5, 0.3, 0.36, 0.6, 0.7, DOWN], [0.73, 0.18, 0.26, 0.5, 0.58, UP]];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `scale` shrinks the glyph toward the center; maskable icons keep it inside the safe zone. */
function png(size, scale) {
  const px = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) px.set(BG, i * 3);
  const at = (u) => Math.round((0.5 + (u - 0.5) * scale) * size);
  const rect = (x0, y0, x1, y1, color) => {
    for (let y = at(y0); y < at(y1); y++) for (let x = at(x0); x < at(x1); x++) px.set(color, (y * size + x) * 3);
  };
  for (const [cx, wickTop, bodyTop, bodyBottom, wickBottom, color] of CANDLES) {
    rect(cx - 0.014, wickTop, cx + 0.014, wickBottom, color);
    rect(cx - 0.075, bodyTop, cx + 0.075, bodyBottom, color);
  }
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size, scale] of [['icon-192.png', 192, 0.9], ['icon-512.png', 512, 0.9], ['icon-maskable-512.png', 512, 0.6], ['apple-touch-icon.png', 180, 0.82]]) {
  writeFileSync(join(OUT, name), png(size, scale));
  console.log(`wrote public/icons/${name} (${size}x${size})`);
}
