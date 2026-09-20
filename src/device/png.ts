/**
 * 极简 PNG 解码器 —— 只为解 Chrome headless 的 `--screenshot` 输出。
 *
 * 为什么自己写：设备卡是**服务端渲染**的（固件不碰中文字体），渲染管线是
 * Chrome 截图 → PNG → RGB565。为这一个用途引入 native 依赖不值得，
 * 而 PNG 解码所需的 inflate 是 Node 内置 zlib 就有的。
 *
 * 支持范围（正好覆盖 Chrome 的截图输出，实测为色彩类型 2/6、位深 8、非隔行）：
 *   - 色彩类型 2（RGB）、6（RGBA）
 *   - 位深 8
 *   - 非隔行（interlace = 0）
 *   - 全部 5 种扫描线滤波器
 * 超出范围一律抛错，不做"尽力而为"的静默降级。
 */
import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** 每像素通道数：3 = RGB，6 = RGBA */
  channels: 3 | 4;
  /** 紧密排列的像素数据，长度 = width * height * channels */
  data: Uint8Array;
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buf: Uint8Array): DecodedPng {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 8 + 25) throw new Error('PNG_DECODE: buffer too small');
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new Error('PNG_DECODE: bad signature');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  let off = 8;
  let sawIhdr = false;
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const body = off + 8;
    if (body + len + 4 > b.length) throw new Error('PNG_DECODE: truncated chunk');
    if (type === 'IHDR') {
      if (len !== 13) throw new Error('PNG_DECODE: bad IHDR length');
      width = b.readUInt32BE(body);
      height = b.readUInt32BE(body + 4);
      bitDepth = b[body + 8];
      colorType = b[body + 9];
      interlace = b[body + 12];
      sawIhdr = true;
    } else if (type === 'IDAT') {
      idat.push(b.subarray(body, body + len));
    } else if (type === 'IEND') {
      break;
    }
    off = body + len + 4;
  }

  if (!sawIhdr) throw new Error('PNG_DECODE: no IHDR');
  if (!idat.length) throw new Error('PNG_DECODE: no IDAT');
  if (interlace !== 0) throw new Error('PNG_DECODE: interlaced PNG unsupported');
  if (bitDepth !== 8) throw new Error(`PNG_DECODE: bit depth ${bitDepth} unsupported (need 8)`);
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`PNG_DECODE: color type ${colorType} unsupported (need 2 or 6)`);
  }
  if (width <= 0 || height <= 0) throw new Error('PNG_DECODE: zero-sized image');

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new Error(`PNG_DECODE: inflated ${raw.length} bytes, expected ${expected}`);
  }

  const out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const bb = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += bb;
      else if (ft === 3) v += (a + bb) >> 1;
      else if (ft === 4) v += paeth(a, bb, c);
      else if (ft !== 0) throw new Error(`PNG_DECODE: unknown filter type ${ft} on row ${y}`);
      cur[x] = v & 0xff;
    }
    prev = cur;
  }

  return { width, height, channels, data: out };
}
