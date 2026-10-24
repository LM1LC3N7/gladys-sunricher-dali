// Generates cover.png (800x534) for gladys-sunricher-dali: plain Node, no
// dependency. A gateway box with its status lights, a DALI bus line to three
// pendant lights glowing at different levels, and a push button panel, on a
// dusk gradient (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W) * 0.4 + (y / H) * 0.6;
    set(x, y, [30 + 30 * t, 34 + 20 * t, 70 + 40 * t]);
  }
}
const white = [255, 255, 255];
const dark = [24, 28, 48];
const warm = [255, 210, 120];
const green = [90, 210, 130];
const grey = [190, 196, 210];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

// The DALI bus: two wires along the ceiling.
line(40, 120, 760, 120, 6, grey);
line(40, 136, 760, 136, 6, grey);

// Three pendant lights, glowing at 100 %, 60 % and 25 %.
[
  [250, 1],
  [430, 0.6],
  [610, 0.25],
].forEach(([x, level]) => {
  line(x, 136, x, 230, 5, grey);
  disc(x, 300, 150, warm, 0.12 * level);
  disc(x, 300, 95, warm, 0.18 * level);
  // The shade: a trapezoid drawn as stacked lines.
  for (let k = 0; k < 40; k += 1) line(x - 30 - k, 230 + k, x + 30 + k, 230 + k, 2, white);
  disc(x, 278, 22, warm, 0.4 + 0.6 * level);
});

// The gateway: a DIN rail box with a cable up to the bus and status lights.
box(60, 300, 170, 470, 14, white);
box(78, 320, 152, 360, 6, dark);
disc(92, 390, 8, green);
disc(116, 390, 8, green);
disc(140, 390, 8, warm);
for (let k = 0; k < 3; k += 1) line(80, 420 + k * 16, 150, 420 + k * 16, 5, grey);
line(115, 300, 115, 136, 5, grey);

// A push button panel with four keys.
box(670, 330, 760, 470, 14, white);
for (let r = 0; r < 2; r += 1) {
  for (let c = 0; c < 2; c += 1) {
    box(684 + c * 40, 346 + r * 60, 714 + c * 40, 394 + r * 60, 6, grey);
  }
}
line(715, 330, 715, 136, 5, grey);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
