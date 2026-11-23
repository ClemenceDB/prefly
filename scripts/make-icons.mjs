import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const SIZE = 1024;
const INK = [0x11, 0x11, 0x10, 255];
const PAPER = [0xf5, 0xf4, 0xf0, 255];
const ACCENT = [0xe2, 0x3d, 0x16, 255];

function createCanvas(size) {
  const data = Buffer.alloc(size * size * 4);
  return { size, data };
}

function setPixel(canvas, x, y, color) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const index = (y * canvas.size + x) * 4;
  canvas.data[index] = color[0];
  canvas.data[index + 1] = color[1];
  canvas.data[index + 2] = color[2];
  canvas.data[index + 3] = color[3];
}

function fillRect(canvas, x, y, w, h, color) {
  for (let py = Math.round(y); py < Math.round(y + h); py += 1) {
    for (let px = Math.round(x); px < Math.round(x + w); px += 1) setPixel(canvas, px, py, color);
  }
}

function fillRoundRect(canvas, x, y, w, h, radius, color) {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const x1 = Math.round(x + w);
  const y1 = Math.round(y + h);
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const dx = Math.max(x0 + radius - px, px - (x1 - 1 - radius), 0);
      const dy = Math.max(y0 + radius - py, py - (y1 - 1 - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) setPixel(canvas, px, py, color);
    }
  }
}

function downscale(canvas, size) {
  const out = createCanvas(size);
  const ratio = canvas.size / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      const sx = Math.floor(x * ratio);
      const sy = Math.floor(y * ratio);
      const step = Math.max(1, Math.floor(ratio));
      for (let oy = 0; oy < step; oy += 1) {
        for (let ox = 0; ox < step; ox += 1) {
          const px = Math.min(canvas.size - 1, sx + ox);
          const py = Math.min(canvas.size - 1, sy + oy);
          const index = (py * canvas.size + px) * 4;
          r += canvas.data[index];
          g += canvas.data[index + 1];
          b += canvas.data[index + 2];
          a += canvas.data[index + 3];
          count += 1;
        }
      }
      const index = (y * size + x) * 4;
      out.data[index] = Math.round(r / count);
      out.data[index + 1] = Math.round(g / count);
      out.data[index + 2] = Math.round(b / count);
      out.data[index + 3] = Math.round(a / count);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    data.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, png } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((item) => item.png)]);
}

function drawIcon() {
  const canvas = createCanvas(SIZE);
  fillRoundRect(canvas, 0, 0, SIZE, SIZE, 232, INK);
  // "P" constructed from registration rectangles.
  fillRect(canvas, 320, 268, 88, 488, PAPER);
  fillRoundRect(canvas, 408, 268, 296, 244, 94, PAPER);
  fillRect(canvas, 472, 332, 168, 116, INK);
  // Accent square: the "preflight" marker.
  fillRect(canvas, 632, 668, 76, 76, ACCENT);
  return canvas;
}

const master = drawIcon();
const buildDir = path.join(process.cwd(), 'build');
const landingAssets = path.join(process.cwd(), 'landing');
mkdirSync(buildDir, { recursive: true });
mkdirSync(landingAssets, { recursive: true });
mkdirSync(path.join(process.cwd(), 'public'), { recursive: true });

const png1024 = encodePng(master);
writeFileSync(path.join(buildDir, 'icon.png'), png1024);
writeFileSync(path.join(landingAssets, 'icon.png'), png1024);
writeFileSync(path.join(process.cwd(), 'public', 'icon.png'), png1024);

const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, png: encodePng(downscale(master, size)) }));
writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(pngs));

// macOS .icns when iconutil is available (best quality, optional).
try {
  const iconset = path.join(buildDir, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), encodePng(downscale(master, size)));
    writeFileSync(
      path.join(iconset, `icon_${size}x${size}@2x.png`),
      encodePng(downscale(master, Math.min(SIZE, size * 2))),
    );
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')], {
    stdio: 'ignore',
  });
  rmSync(iconset, { recursive: true, force: true });
  console.log('icon.icns generated');
} catch {
  rmSync(path.join(buildDir, 'icon.iconset'), { recursive: true, force: true });
  console.log('iconutil unavailable — electron-builder will derive icns from icon.png');
}

if (!existsSync(path.join(buildDir, 'icon.png'))) {
  throw new Error('icon generation failed');
}
console.log('icons: build/icon.png, build/icon.ico' + (existsSync(path.join(buildDir, 'icon.icns')) ? ', build/icon.icns' : ''));
