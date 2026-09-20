import { describe, it, expect } from 'vitest';
import { parseBattery } from '../../src/device/http.js';

/**
 * 设备上报电量的量化规则。
 *
 * 为什么锁这个：卡片是现场用无头 Chrome 渲染的（1.1~1.2 秒），而缓存键是
 * `sha256(卡片 HTML)` —— 电量画在卡片页脚里，所以**电量一变整张卡就重渲一次**。
 * 实测同一张卡：`bat=88` 命中缓存 1ms，`bat=87` 变成 1091ms。
 * 而设备每次取卡都上报电量、读数还有 ±1~2% 抖动 → 几乎每次按上下键都在踩重渲，
 * 用户感觉就是"切换要等一两秒"。量化到 10% 一档把抖动吸收掉。
 * 这条规则一旦被改回"保留原始百分比"，那个卡顿会静默回来。
 */
describe('设备电量量化（防渲染抖动）', () => {
  it('同一档内的抖动必须映射到同一个值（这正是它存在的理由）', () => {
    const a = [86, 87, 88, 89].map((n) => parseBattery(String(n)));
    expect(new Set(a).size).toBe(1);
    expect(a[0]).toBe(90);
  });

  it('跨档才变，且落在最近的 10 上', () => {
    expect(parseBattery('84')).toBe(80);
    expect(parseBattery('85')).toBe(90);   // 四舍五入
    expect(parseBattery('74')).toBe(70);
    expect(parseBattery('100')).toBe(100);
    expect(parseBattery('0')).toBe(0);
  });

  it('-1（读不到电量）原样保留，不能被量化成 0', () => {
    expect(parseBattery('-1')).toBe(-1);
  });

  it('空值/非法值 → null（卡片画成灰色电池，不是 0%）', () => {
    expect(parseBattery(null)).toBeNull();
    expect(parseBattery('')).toBeNull();
    expect(parseBattery('abc')).toBeNull();
  });

  it('越界输入被夹住，不会把宽度撑出卡片', () => {
    expect(parseBattery('999')).toBe(100);
    expect(parseBattery('-50')).toBe(-1);
  });
});
