import { describe, it, expect } from 'vitest';
import { localDateKey, todayKey, addDays } from '../../src/shared/time.js';

describe('timezone 感知的自然日计算（§16）', () => {
  it('同一时刻在不同 timezone 得到不同 date key', () => {
    // 2026-09-18T20:00Z：上海 09-19 04:00，UTC 09-18
    const ts = new Date('2026-09-18T20:00:00Z');
    expect(localDateKey(ts, 'Asia/Shanghai')).toBe('2026-09-19');
    expect(localDateKey(ts, 'UTC')).toBe('2026-09-18');
  });

  it('跨午夜边界：23:30Z 在上海已是次日', () => {
    const ts = new Date('2026-09-18T15:30:00Z'); // 上海 23:30
    expect(localDateKey(ts, 'Asia/Shanghai')).toBe('2026-09-18');
    const ts2 = new Date('2026-09-18T15:31:00Z'); // 上海 23:31... 实际 15:30Z = 23:30 +8
    expect(localDateKey(ts2, 'Asia/Shanghai')).toBe('2026-09-18');
    const ts3 = new Date('2026-09-18T16:01:00Z'); // 上海 00:01 次日
    expect(localDateKey(ts3, 'Asia/Shanghai')).toBe('2026-09-19');
  });

  it('addDays 正确滚动', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('todayKey 返回当天', () => {
    const key = todayKey('Asia/Shanghai');
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
