/**
 * 设备卡渲染管线：HTML → Chrome headless 截图 → PNG → RGB565 → 磁盘缓存。
 *
 * 为什么走「服务端出图」而不是让设备自己画：
 * AI Passport 默认的 Montserrat 字体没有中文字形，而目标标题是用户自由输入的
 * 任意汉字（官方文档把这种情形定义为"动态内容需明确的字符契约"的高危场景）。
 * 服务端把整张卡渲染成像素，固件就完全不必碰字库/字形覆盖。
 *
 * 安全边界说明：Chrome 只读一个临时 HTML、只写一个临时 PNG，两个路径都在
 * 系统临时目录，不涉及用户的 Desktop/Documents/Downloads。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodePng } from './png.js';

export const CARD_WIDTH = 240;
export const CARD_HEIGHT = 320;

/** 单张卡的渲染上限。Chrome 冷启动 + 字体加载实测 1~2 秒，留足余量后硬超时。 */
const RENDER_TIMEOUT_MS = Number(process.env.AI_GROWTH_RENDER_TIMEOUT_MS ?? 20000);

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

export function findChrome(): string | null {
  const override = process.env.AI_GROWTH_CHROME;
  if (override && existsSync(override)) return override;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/** RGBA/RGB 像素 → RGB565 小端字节流（面板原生格式） */
export function toRgb565(
  png: { width: number; height: number; channels: 3 | 4; data: Uint8Array }
): Buffer {
  const { width, height, channels, data } = png;
  const out = Buffer.allocUnsafe(width * height * 2);
  let o = 0;
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const r = data[s];
    const g = data[s + 1];
    const b = data[s + 2];
    const v = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
    out[o++] = v & 0xff;
    out[o++] = (v >> 8) & 0xff;
  }
  return out;
}

/**
 * 用 Chrome headless 把一段 HTML 渲染成 PNG。
 * 每张卡一次进程调用（约 1 秒）；上层按内容哈希做磁盘缓存，所以只会付一次。
 *
 * size 默认是设备卡的 240×320；字形覆盖检查要渲染更大的网格，所以开放出来。
 * 调用方必须保证 HTML 的布局尺寸与这里一致（否则截出来的图会被裁掉）。
 */
export function screenshotPng(
  html: string,
  size: { width: number; height: number } = { width: CARD_WIDTH, height: CARD_HEIGHT }
): Promise<Buffer> {
  const chrome = findChrome();
  if (!chrome) {
    return Promise.reject(
      new Error(
        'CHROME_NOT_FOUND: 渲染设备卡需要 Chrome/Chromium。可用 AI_GROWTH_CHROME 指定可执行文件路径。'
      )
    );
  }
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const htmlPath = join(tmpdir(), `aig-card-${stamp}.html`);
  const pngPath = join(tmpdir(), `aig-card-${stamp}.png`);
  const profileDir = join(tmpdir(), `aig-chrome-${stamp}`);
  writeFileSync(htmlPath, html, 'utf8');

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profileDir}`,
    `--window-size=${size.width},${size.height}`,
    // 给字体加载与首帧留出确定的时间预算，避免截到空白帧
    '--virtual-time-budget=1500',
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ];

  return new Promise<Buffer>((resolve, reject) => {
    // detached：Chrome 出图后不一定自己退出（实测会一直挂着），
    // 所以不能等 close 事件，必须轮询截图文件并在拿到后主动杀整个进程组。
    const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let err = '';
    child.stderr?.on('data', (d) => { err += String(d); });
    let settled = false;

    const cleanup = () => {
      try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* 已退出 */ }
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      for (const p of [htmlPath, pngPath]) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const done = (buf: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buf);
    };

    child.on('error', (e) => fail(e));

    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    let lastSize = -1;
    let stable = 0;
    const poll = () => {
      if (settled) return;
      if (Date.now() > deadline) {
        fail(new Error(`CHROME_TIMEOUT: ${RENDER_TIMEOUT_MS}ms 内没拿到截图。${err.slice(-300)}`));
        return;
      }
      try {
        if (existsSync(pngPath)) {
          const size = statSync(pngPath).size;
          // 连续两次大小一致才认为写完了（避免读到半个文件）
          if (size > 0 && size === lastSize) stable++; else stable = 0;
          lastSize = size;
          if (stable >= 2) {
            done(readFileSync(pngPath));
            return;
          }
        }
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      setTimeout(poll, 80);
    };
    poll();
  });
}

export interface RenderedCard {
  /** 紧密排列的 RGB565 小端像素，长度 = 240*320*2 */
  pixels: Buffer;
  width: number;
  height: number;
  /** 是否命中磁盘缓存（未真正调用 Chrome） */
  cached: boolean;
}

function cacheDir(dataDir: string): string {
  const d = join(dataDir, 'device-cache');
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 渲染一张卡并落到磁盘缓存。key 由调用方按「内容 + 状态」算好，
 * 所以同一张卡（哪怕同一天多次看）只会真正渲染一次。
 */
export async function renderCardCached(
  html: string,
  key: string,
  dataDir: string
): Promise<RenderedCard> {
  const hash = createHash('sha256').update(html).digest('hex').slice(0, 24);
  const file = join(cacheDir(dataDir), `${hash}.rgb565`);
  if (existsSync(file)) {
    const pixels = readFileSync(file);
    if (pixels.length === CARD_WIDTH * CARD_HEIGHT * 2) {
      return { pixels, width: CARD_WIDTH, height: CARD_HEIGHT, cached: true };
    }
    // 尺寸不对说明缓存来自旧版本，丢掉重渲
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
  }
  const png = await screenshotPng(html);
  const decoded = decodePng(png);
  if (decoded.width !== CARD_WIDTH || decoded.height !== CARD_HEIGHT) {
    throw new Error(
      `CARD_SIZE_MISMATCH: 渲染出 ${decoded.width}x${decoded.height}，期望 ${CARD_WIDTH}x${CARD_HEIGHT}`
    );
  }
  const pixels = toRgb565(decoded);
  writeFileSync(file, pixels);
  void key;
  return { pixels, width: CARD_WIDTH, height: CARD_HEIGHT, cached: false };
}
