/**
 * 一条命令把 AI Passport 配好，并**自己确认成功**。
 *
 * 为什么需要它（产品层面的理由）：这仓库要作为「应用」发布到 FoloToy 玩法社区。
 * 如果用户刷完之后还得跑几个脚本、或者让 Agent 一步步读日志排查，那就不是能发布的东西。
 * 所以这里把整条链路收成一个命令，而且**验证也自己做掉** ——
 * 前提是设备固件开机就直接进卡页并自动取卡（见固件 main.c 的 APP_DEMO_INDEX），
 * 于是"配置→重启→取卡"的结论会直接出现在串口日志里，不需要用户按任何键。
 *
 * ⚠ 一个必须知道的前提：**串口控制台是 ASCII 通道**。
 *   ESP-IDF 的 esp_console 在把输入交给命令前会过一条 sanitize()，
 *   它只保留 isprint() 为真的字节，中文（UTF-8 的 0x80~0xFF）会被整段丢掉。
 *   所以凭据含非 ASCII（或空格）时必须走 growth_set_hex，用 hex 把字节送过去。
 *   这里自动判断该走哪条，调用方不用关心。
 */
import { request } from 'node:http';

import { DomainError } from '../shared/result.js';
import { findSerialPorts, SerialSession, type SerialPortInfo } from './serial.js';

/**
 * 本机 apiPort 上有没有服务在跑。
 *
 * 为什么要单独探一下：如果服务没起来，设备**一定**取不到卡，但那种失败要等到
 * 串口日志里出现"取卡失败"才看得出来（几十秒后），而且报出来的原因是 Wi-Fi 层的，
 * 会把人往错方向带。所以在动手之前先问一句，失败就直接说清是服务没跑。
 * 401 也算"活着"——那说明服务在，只是我们没带令牌。
 */
export function probeService(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/device/ping', method: 'GET', timeout: timeoutMs },
      (res) => { res.resume(); resolve(true); }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * 固件侧 esp_console 的命令行上限（对应 growth_config.c 的 max_cmdline_length）。
 *
 * ⚠ 为什么要在宿主侧也拦一次：命令行编辑器**超长是静默丢字符**的 ——
 * 命令照样能被解析，只是末尾少几个字符。最典型的表现是令牌被截断（中文 Wi-Fi 名
 * 走 hex 后一行会明显变长，我们实测刚好 129 字符 > 当时的 128 上限），
 * 于是设备一直回 401，而设备日志里只有"HTTP 401 令牌不对"，完全看不出是被截了。
 * 与其让用户去猜，不如在发出去之前就拦住并说清楚。
 */
export const MAX_DEVICE_CMDLINE = 512;

/** 留出余量：编辑器在临界点上的行为不值得去试 */
export function commandFits(line: string): boolean {
  return line.length <= MAX_DEVICE_CMDLINE - 8;
}

export interface ProvisionInput {
  ssid: string;
  password: string;
  /** 电脑的局域网地址（设备要连的） */
  host: string;
  /** daemon 的端口 */
  apiPort: number;
  token: string;
  /** 指定串口；不指定则自动挑（多个候选会报错，避免配错设备） */
  serialPath?: string;
  /** 跳过后面的"等它取卡并判定"（只写配置就返回） */
  skipVerify?: boolean;
  /** 取卡结论的等待上限 */
  verifyTimeoutMs?: number;
}

export type DeviceVerdict = 'FETCHED' | 'WIFI_FAIL' | 'FETCH_FAIL' | 'NOT_CONFIGURED' | 'UNKNOWN';

export interface ProvisionStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ProvisionResult {
  serialPath: string;
  /** 实际用的是哪条命令（凭据是否 ASCII 决定） */
  usedCommand: 'growth_set' | 'growth_set_hex';
  /** 写配置前设备里已有的 SSID（读得到就报出来） */
  previousSsid: string | null;
  /** 设备自己给出的结论 */
  verdict: DeviceVerdict;
  ok: boolean;
  steps: ProvisionStep[];
  /** 判定依据：从设备日志里摘出的关键行，给人看也给 Agent 判断 */
  evidence: string[];
  /** 没成功时，下一步该干什么 */
  nextAction?: string;
}

/** 串口命令的单个参数：纯 ASCII 且不含空格才能直接传，否则必须走 hex */
function isConsoleSafe(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s) && !s.includes(' ');
}

function toHex(s: string): string {
  return Buffer.from(s, 'utf8').toString('hex');
}

function pickPort(requested?: string): { path: string; candidates: SerialPortInfo[] } {
  const candidates = findSerialPorts();
  if (requested) return { path: requested, candidates };
  if (candidates.length === 0) {
    throw new DomainError(
      'DEVICE_NOT_FOUND',
      '没有找到串口设备。请确认：①设备已开机 ②用的是能传数据的 USB 线（不是仅充电线）③直接插电脑而不是走 hub。'
    );
  }
  if (candidates.length > 1) {
    throw new DomainError(
      'MULTIPLE_DEVICES',
      `找到多个串口：${candidates.map((c) => c.path).join('、')}。用 --port 明确指定要配哪一个，避免配错设备。`
    );
  }
  return { path: candidates[0].path, candidates };
}

/** 从 growth_status 的输出里抽出已经配置好的 ssid（没有则 null） */
function parseSsid(statusText: string): string | null {
  const m = statusText.match(/wifi ssid\s*:\s*(.*)/);
  if (!m) return null;
  const v = m[1].trim();
  return v && v !== '(none)' ? v : null;
}

export async function provisionDevice(input: ProvisionInput): Promise<ProvisionResult> {
  const steps: ProvisionStep[] = [];
  const evidence: string[] = [];
  const { path, candidates } = pickPort(input.serialPath);

  const session = SerialSession.open(path);
  try {
    // ① 开端口会让设备复位（USB-Serial-JTAG），先把可能涌出的启动日志吃掉。
    const boot = await session.drain(1500);
    if (boot) evidence.push(...boot.split('\n').filter((l) => l.trim()).slice(0, 3));
    steps.push({ name: '找到串口并打开', ok: true, detail: `${path}（候选 ${candidates.length} 个）` });

    // ② 读当前配置：判断"是不是已经配过了"，也确认控制台活着
    const status = await session.sendAndWait('growth_status', ['configured :'], 6000);
    if (!status.matched) {
      throw new DomainError(
        'DEVICE_NO_CONSOLE',
        '设备没有回应串口命令。可能是固件不是这一版（缺 AI Growth 页），或者串口被别的程序占着（网页刷机工具/monitor 都会占）。'
      );
    }
    const previousSsid = parseSsid(status.text);
    steps.push({
      name: '读取设备当前配置',
      ok: true,
      detail: previousSsid ? `已配置过：${previousSsid}` : '尚未配置',
    });
    if (/wifi ssid/.test(status.text)) evidence.push(...status.text.split('\n').filter((l) => l.startsWith('wifi ssid')));

    // ③ 写配置。凭据含非 ASCII/空格 → 必须 hex，否则控制台会把字节丢掉
    const needsHex = !isConsoleSafe(input.ssid) || !isConsoleSafe(input.password);
    const usedCommand: ProvisionResult['usedCommand'] = needsHex ? 'growth_set_hex' : 'growth_set';
    const ssidArg = needsHex ? toHex(input.ssid) : input.ssid;
    const passArg = needsHex ? toHex(input.password) : (input.password === '' ? '""' : input.password);
    const line = [
      usedCommand, ssidArg, passArg, input.host, String(input.apiPort), input.token,
    ].join(' ');

    if (!commandFits(line)) {
      throw new DomainError(
        'COMMAND_TOO_LONG',
        `这条配置命令有 ${line.length} 字符，超过设备的串口命令行上限（${MAX_DEVICE_CMDLINE}）。`
        + '超长会被设备**静默截断**（末尾少几个字符，典型后果是令牌不完整 → 设备一直 401）。'
        + '请缩短 Wi-Fi 名，或先 `ai-growth device --rotate` 换一个更短的令牌后重试。'
      );
    }

    const saved = await session.sendAndWait(line, ['saved.', 'error:'], 8000);
    if (saved.matched !== 'saved.') {
      const errLine = (saved.text.match(/error:[^\n]*/) ?? ['设备没有回应写入命令'])[0];
      steps.push({ name: '写入配置', ok: false, detail: errLine });
      throw new DomainError('DEVICE_WRITE_FAILED', `设备拒绝了配置：${errLine}`);
    }
    steps.push({
      name: '写入配置',
      ok: true,
      detail: `${usedCommand}${needsHex ? '（含非 ASCII/空格，已用 hex 编码绕过控制台的 ASCII 限制）' : ''}`,
    });

    if (input.skipVerify) {
      return { serialPath: path, usedCommand, previousSsid, verdict: 'UNKNOWN', ok: true, steps, evidence };
    }

    // ④ 设备会立刻重启、开机直接进卡页并自动取卡 —— 结论就在日志里，不需要用户按键。
    //    这几个 pattern 就是固件自己的结论行。
    const verdictWait = input.verifyTimeoutMs ?? 30000;
    const log = await session.drain(verdictWait);
    const lines = log.split('\n').map((l) => l.trim()).filter(Boolean);

    let verdict: DeviceVerdict = 'UNKNOWN';
    if (/显示第\s*\d+\s*\/\s*\d+\s*张/.test(log)) verdict = 'FETCHED';
    else if (/连不上 Wi-Fi/.test(log)) verdict = 'WIFI_FAIL';
    else if (/取卡失败/.test(log)) verdict = 'FETCH_FAIL';
    else if (/还没配置/.test(log)) verdict = 'NOT_CONFIGURED';

    for (const re of [/显示第.*/, /连不上 Wi-Fi.*/, /取卡失败.*/, /还没配置.*/, /wifi:mode.*/]) {
      const hit = lines.find((l) => re.test(l));
      if (hit) evidence.push(hit);
    }

    const result: ProvisionResult = {
      serialPath: path,
      usedCommand,
      previousSsid,
      verdict,
      ok: verdict === 'FETCHED',
      steps,
      evidence,
    };
    if (verdict === 'FETCHED') {
      steps.push({ name: '设备端确认取卡成功', ok: true, detail: '日志里出现「显示第 N/M 张」' });
    } else {
      steps.push({ name: '设备端确认取卡', ok: false, detail: `结论：${verdict}` });
      result.nextAction = nextActionFor(verdict, input);
    }
    return result;
  } finally {
    session.close();
  }
}

/** 把设备端的失败结论翻译成"下一步该干什么"，让 Agent 不用自己猜 */
function nextActionFor(verdict: DeviceVerdict, input: ProvisionInput): string {
  switch (verdict) {
    case 'WIFI_FAIL':
      return `设备连不上 Wi-Fi「${input.ssid}」。两种最常见原因：`
        + '① 这个网络只有 5GHz —— ESP32-C3 只支持 2.4GHz（很多路由器会用同一个名字同时广播 2.4G/5G，那就没问题，'
        + '先确认名字在 2.4G 上也有）；② 密码不对。改完重跑本命令即可。';
    case 'FETCH_FAIL':
      return `Wi-Fi 通了，但设备够不到电脑（${input.host}:${input.apiPort}）。检查：`
        + '① 服务是否以局域网模式在跑（AI_GROWTH_DEVICE_LAN=1 ai-growth serve；ai-growth device 会显示状态）；'
        + '② 电脑与设备是否在同一个 Wi-Fi/局域网；③ 令牌是否与设备里的一致。';
    case 'NOT_CONFIGURED':
      return '设备仍认为未配置，说明配置没写进去。重跑本命令；仍失败就把串口日志发出来。';
    default:
      return '在等待窗口内没有看到设备的取卡结论。设备可能还在开机或卡在某一步 —— '
        + '再跑一次本命令，或查看串口实时日志定位。';
  }
}
