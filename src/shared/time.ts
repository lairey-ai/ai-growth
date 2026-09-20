/**
 * 时间处理。核心规则：
 * - DB 存 ISO timestamp（UTC）。
 * - "哪一天" 的判断必须基于配置的本地 timezone，不能按 UTC 截断。
 */

const dateKeyFormatterCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = dateKeyFormatterCache.get(tz);
  if (!f) {
    // en-CA gives YYYY-MM-DD shape
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateKeyFormatterCache.set(tz, f);
  }
  return f;
}

/** 本地自然日 key：YYYY-MM-DD（按 tz） */
export function localDateKey(date: Date = new Date(), tz = 'Asia/Shanghai'): string {
  return fmt(tz).format(date);
}

/** 当前 ISO timestamp */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 该时刻在 tz 下的偏移量（毫秒）。东八区为 +8h，纽约夏令时为 -4h */
function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // 把"该 tz 的墙上时间"当成 UTC 读出来，与实际 UTC 的差就是 offset
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asIfUtc - at.getTime();
}

/**
 * 把 "YYYY-MM-DD" + tz 解析为该自然日起始时刻的 UTC Date。
 * 用 offset 反解，而不是"迭代加天"——后者对负偏移时区（美洲）会直接失败。
 * 二次校正用于跨越 DST 边界的情况。
 */
export function startOfDateKey(dateKey: string, tz: string): Date {
  const guess = new Date(`${dateKey}T00:00:00Z`);
  const offset = tzOffsetMs(guess, tz);
  const candidate = new Date(guess.getTime() - offset);
  // DST 边界：候选时刻的 offset 可能与 guess 时刻不同，需要用正确的 offset 再解一次
  const candidateOffset = tzOffsetMs(candidate, tz);
  if (candidateOffset !== offset) {
    return new Date(guess.getTime() - candidateOffset);
  }
  return candidate;
}

/** 给定 ISO timestamp 在指定 tz 是否早于某自然日（严格） */
export function isBeforeDateKey(iso: string, dateKey: string, tz: string): boolean {
  return localDateKey(new Date(iso), tz) < dateKey;
}

/** 加/减自然日，返回新 key */
export function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 今天在 tz 下的 key */
export function todayKey(tz: string): string {
  return localDateKey(new Date(), tz);
}
