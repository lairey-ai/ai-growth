import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface AppConfig {
  dataDir: string;
  timezone: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  apiPort: number;
  passportAdapter: string;
  passportFile: string;
  /**
   * 是否允许 AI Passport 设备从局域网访问 `/api/device/*`。
   * 默认关；开启后所有来源（含 localhost）都必须带正确令牌。
   * 开关放在 ~/.ai-growth/config.env，用户可用 `ai-growth device --lan on` 改。
   */
  deviceLan: string;
}

function loadEnvFile(): void {
  // 依次查找：项目根 .env（开发）、数据目录 config.env
  const candidates = [join(process.cwd(), '.env'), join(homedir(), '.ai-growth', 'config.env')];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      /* ignore malformed env files */
    }
  }
}

function defaultTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  loadEnvFile();
  const dataDir = (
    overrides.dataDir ??
    process.env.AI_GROWTH_DATA_DIR ??
    join(homedir(), '.ai-growth')
  ).replace(/^~(?=\/)/, homedir());
  return {
    dataDir,
    timezone: overrides.timezone ?? process.env.AI_GROWTH_TZ ?? defaultTz(),
    logLevel: (process.env.AI_GROWTH_LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
    apiPort: Number(process.env.AI_GROWTH_API_PORT ?? 4580),
    passportAdapter: process.env.AI_GROWTH_PASSPORT_ADAPTER ?? 'local-json',
    passportFile: process.env.AI_GROWTH_PASSPORT_FILE ?? 'passport.json',
    // ⚠ 默认值必须是空串，不能是 '0'：这个字段用来判断"用户有没有显式设置过环境变量"。
    //   默认值若为 '0'，它就永远非空，于是 isDeviceLanEnabled 永远走环境变量分支，
    //   数据库里持久化过的那个开关再也读不到（"开启局域网"就存不住了）。
    //   语义：'' = 没设，交给设置表；'0'/'1' = 显式指定，环境变量优先。
    deviceLan: process.env.AI_GROWTH_DEVICE_LAN ?? '',
    ...overrides,
  };
}
