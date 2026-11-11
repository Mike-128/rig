import { deflateSync } from "node:zlib";

/**
 * The tray and window icon, drawn in code so the shell needs no image assets: a rounded square in the
 * accent color with a white "R"-like mark, plus an amber dot when something needs attention.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

type RGBA = [number, number, number, number];

function png(size: number, pixel: (x: number, y: number) => RGBA): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const ACCENT: RGBA = [91, 156, 255, 255];
const WHITE: RGBA = [255, 255, 255, 255];
const AMBER: RGBA = [242, 184, 75, 255];
const CLEAR: RGBA = [0, 0, 0, 0];

/** The icon at `size` pixels; `alert` adds the attention dot. */
export function iconPng(size: number, alert = false): Buffer {
  const s = size / 32;
  const radius = 7 * s;
  const inRounded = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  // A stylized R in a 32-unit grid: stem, bowl, and leg.
  const inMark = (x: number, y: number) => {
    const u = x / s;
    const v = y / s;
    const stem = u >= 10 && u < 14 && v >= 8 && v < 24;
    const bowlOuter = (u - 16) ** 2 + (v - 12.5) ** 2 <= 5.5 ** 2 && u >= 12;
    const bowlInner = (u - 16) ** 2 + (v - 12.5) ** 2 <= 2 ** 2;
    const bar = u >= 10 && u < 16 && ((v >= 8 && v < 11) || (v >= 15 && v < 17));
    const leg = Math.abs(u - 16 - (v - 16) * 0.75) < 2 && v >= 16 && v < 24;
    return stem || (bowlOuter && !bowlInner) || bar || leg;
  };
  const dotR = 6 * s;
  const inDot = (x: number, y: number) => alert && (x - (size - 1 - dotR)) ** 2 + (y - dotR) ** 2 <= dotR ** 2;
  return png(size, (x, y) => (inDot(x, y) ? AMBER : !inRounded(x, y) ? CLEAR : inMark(x, y) ? WHITE : ACCENT));
}
