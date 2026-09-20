/**
 * 串口控制台会话（AI Passport 的 USB-Serial-JTAG）。
 *
 * 为什么不用 npm 的 serialport：它是**原生模块**，用户机器上装它就要编译工具链；
 * 而这件事只需要「以 raw 打开一个字符设备、写一行、读一段」三件事，
 * Node 自带的 fs / child_process 就够 —— 装完软件就能用，不要额外依赖。
 *
 * ⚠ 三个现实问题，全部在下面处理掉了（都是实测踩出来的）：
 *
 * 1. **Node 没有 termios**，不能自己把 tty 设成 raw，只能借系统的 `stty`。
 *    不设 raw，主机的行规程会改写字节（\n → \r\n、回显、流控），设备端解析会乱。
 *    macOS 用 `stty -f`，Linux 用 `stty -F`，两边都要试。
 *
 * 2. **打开端口会让设备复位**（USB-Serial-JTAG 的行为），于是会先涌出一整段启动日志，
 *    这期间写进去的命令会被**直接丢掉**。所以判断"能不能发"的唯一可靠依据是
 *    **响应本身**，而不是等某个提示符 —— 不复位时提示符根本不会重新打印，
 *    等它必然误判成"没就绪"。
 *
 * 3. 读数必须用 StringDecoder：UTF-8 汉字可能被切在两个 chunk 之间，
 *    直接按 chunk 解码会得到乱码（而设备的中文日志正是我们判断成败的依据）。
 */
import { execFileSync } from 'node:child_process';
import { closeSync, createReadStream, existsSync, openSync, readdirSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';

export interface SerialPortInfo {
  path: string;
  /** usbmodem = ESP32 原生 USB-Serial-JTAG；其余是外置 USB-UART 桥 */
  kind: 'usbmodem' | 'acm' | 'usbserial';
}

/**
 * 列出可能是 AI Passport 的串口。
 *
 * 只看这几类名字：设备走原生 USB-Serial-JTAG（macOS 是 /dev/cu.usbmodem*，
 * Linux 是 /dev/ttyACM*）；也带上常见的 USB-UART 桥（ch34x/cp210x/ftdi），
 * 免得个别批次用了外置桥就找不到设备。
 * ⚠ 不返回 /dev/cu.Bluetooth-* 之类：那是蓝牙虚拟口，连上去只会浪费时间。
 */
/**
 * 从设备名列表里挑出可能是 AI Passport 的串口（**纯函数，便于单测**）。
 *
 * 只看这几类名字：设备走原生 USB-Serial-JTAG（macOS 是 /dev/cu.usbmodem*，
 * Linux 是 /dev/ttyACM*）；也带上常见的 USB-UART 桥（ch34x/cp210x/ftdi），
 * 免得个别批次用了外置桥就找不到设备。
 *
 * ⚠ macOS 会给同一个物理设备**两个**节点：/dev/cu.*（拨出，callout）和
 *   /dev/tty.*（拨入，dialin）。只收 cu.*，否则永远会"找到多个串口"而走不下去 ——
 *   这个 bug 会让 device setup 在所有 macOS 上直接失败。Linux 那边只有 ttyACM
 *   和 ttyUSB 系列，没有这种孪生节点。
 * ⚠ 不返回 /dev/cu.Bluetooth-* 之类：那是蓝牙虚拟口，连上去只会浪费时间。
 * ⚠ 注释里别出现"星号紧跟斜杠"的字符序列：它会把块注释提前闭合（我已经踩过两次）。
 */
export function pickSerialPorts(names: string[], platform: NodeJS.Platform): SerialPortInfo[] {
  const out: SerialPortInfo[] = [];
  const isDarwin = platform === 'darwin';
  for (const name of names) {
    if (/^cu\.usbmodem/.test(name)) out.push({ path: `/dev/${name}`, kind: 'usbmodem' });
    else if (/^cu\.(usbserial|wchusbserial|SLAB_USBtoUART)/.test(name)) out.push({ path: `/dev/${name}`, kind: 'usbserial' });
    else if (!isDarwin && /^ttyACM\d+$/.test(name)) out.push({ path: `/dev/${name}`, kind: 'acm' });
    else if (!isDarwin && /^ttyUSB\d+$/.test(name)) out.push({ path: `/dev/${name}`, kind: 'usbserial' });
  }
  // 原生 USB-Serial-JTAG 优先；其余按路径排序保证稳定
  const rank: Record<SerialPortInfo['kind'], number> = { usbmodem: 0, acm: 1, usbserial: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path));
}

/** 列出本机上可能是 AI Passport 的串口（pickSerialPorts 的 io 外壳）。 */
export function findSerialPorts(): SerialPortInfo[] {
  if (!existsSync('/dev')) return [];
  try { return pickSerialPorts(readdirSync('/dev'), process.platform); } catch { return []; }
}

/** 把 tty 设成 raw 且关回显。macOS/Linux 的参数名不同，都试一遍。 */
function makeRaw(path: string): void {
  const attempts: string[][] = process.platform === 'darwin'
    ? [['-f', path, 'raw', '-echo'], ['-F', path, 'raw', '-echo']]
    : [['-F', path, 'raw', '-echo'], ['-f', path, 'raw', '-echo']];
  let lastErr: unknown = null;
  for (const args of attempts) {
    try {
      execFileSync('stty', args, { stdio: 'ignore' });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`stty 无法把 ${path} 设为 raw 模式：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export interface WaitResult {
  /** 命中到的 pattern；超时则为 null */
  matched: string | null;
  /** 从**上次 clear/上次命中之后**到现在读到的全部文本 */
  text: string;
}

export class SerialSession {
  private fd: number;
  private stream: ReturnType<typeof createReadStream>;
  private decoder = new StringDecoder('utf8');
  private buf = '';
  private waiter: { patterns: string[]; resolve: (r: WaitResult) => void; timer: NodeJS.Timeout } | null = null;

  private constructor(public readonly path: string) {
    makeRaw(path);
    this.fd = openSync(path, 'r+');
    this.stream = createReadStream(path, { fd: this.fd, autoClose: false });
    this.stream.on('data', (chunk: Buffer | string) => {
      this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      this.checkWaiter();
    });
    // 串口读不到 EOF；出错时别抛到全局（例如设备被拔掉）
    this.stream.on('error', () => { /* 交给 waitFor 超时处理 */ });
  }

  static open(path: string): SerialSession {
    return new SerialSession(path);
  }

  private checkWaiter(): void {
    const w = this.waiter;
    if (!w) return;
    for (const p of w.patterns) {
      if (this.buf.includes(p)) {
        this.waiter = null;
        clearTimeout(w.timer);
        const text = this.buf;
        this.buf = '';
        w.resolve({ matched: p, text });
        return;
      }
    }
  }

  /** 写一行（自动补 \n，UTF-8 编码）。命令本身是 ASCII，无需转义。 */
  writeLine(line: string): void {
    writeSync(this.fd, Buffer.from(line + '\n', 'utf8'));
  }

  /** 等到出现任一 pattern 或超时。同一时刻只允许一个等待者。 */
  waitFor(patterns: string[], timeoutMs: number): Promise<WaitResult> {
    const hit = patterns.find((p) => this.buf.includes(p));
    if (hit) {
      const text = this.buf;
      this.buf = '';
      return Promise.resolve({ matched: hit, text });
    }
    return new Promise<WaitResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter?.timer === timer) this.waiter = null;
        const text = this.buf;
        this.buf = '';
        resolve({ matched: null, text });
      }, timeoutMs);
      this.waiter = { patterns, resolve, timer };
    });
  }

  /** 丢弃当前累积的读取内容（例如启动日志），只保留"从现在起"的输出 */
  clear(): void {
    this.buf = '';
  }

  /**
   * 发一条命令并等响应。返回是否命中，以及这次读到的文本。
   * 为什么要重试：开端口会复位设备，头一两条命令可能正好落在启动过程中被丢掉。
   */
  async sendAndWait(line: string, patterns: string[], timeoutMs: number, tries = 3): Promise<WaitResult & { tries: number }> {
    for (let i = 1; i <= tries; i++) {
      this.clear();
      this.writeLine(line);
      const r = await this.waitFor(patterns, timeoutMs);
      if (r.matched) return { ...r, tries: i };
    }
    return { matched: null, text: this.buf, tries };
  }

  /**
   * 只读地收集一段时间。用在**没有终止标记**的输出上（启动日志、取卡结论）——
   * 这类只能按时间收，不能等某个关键词。
   * ⚠ 不要与 waitFor 同时用：两者都会消费内部缓冲。
   */
  drain(ms: number): Promise<string> {
    this.clear();
    return new Promise<string>((resolve) => {
      setTimeout(() => {
        const text = this.buf;
        this.buf = '';
        resolve(text);
      }, ms);
    });
  }

  async sleep(ms: number): Promise<void> { await delay(ms); }

  close(): void {
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter = null; }
    try { this.stream.destroy(); } catch { /* ignore */ }
    try { closeSync(this.fd); } catch { /* ignore */ }
  }
}
