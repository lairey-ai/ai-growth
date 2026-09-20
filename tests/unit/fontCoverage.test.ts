import { describe, it, expect } from 'vitest';
import {
  classifyCoverage,
  masksEqual,
  CTRL_MISSING,
  CTRL_PRESENT,
  CTRL_PRESENT_CJK,
} from '../../src/device/fontCoverage.js';

/**
 * 这些用例全部用合成位图，不启动 Chrome —— 它们锁的是【判定逻辑】。
 * 真正的端到端字形检查由 scripts/gen-device-assets.mjs 调 checkGlyphCoverage 跑。
 *
 * 关键防回归点：负对照失效时必须报 detectorOk=false，
 * 绝不能因为"没检测到缺字"就返回通过 —— 那会让检查退化成摆设。
 */
function mask(spec: string): Uint8Array {
  // '#' = 有墨，'.' = 无墨；用 4x4 就足够表达"不同形状"
  const m = new Uint8Array(16);
  for (let i = 0; i < 16; i++) m[i] = spec[i] === '#' ? 1 : 0;
  return m;
}

const TOFU = mask('.##.' + '####' + '####' + '.##.');   // 缺字参考（豆腐块）
const LATIN = mask('#...' + '.##.' + '#.#.' + '#..#');
const CJK = mask('####' + '.###' + '##.#' + '####');
const BLANK = mask('....' + '....' + '....' + '....');

function base(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    [CTRL_MISSING, TOFU],
    [CTRL_PRESENT, LATIN],
    [CTRL_PRESENT_CJK, CJK],
  ]);
}

describe('masksEqual', () => {
  it('长度不同直接不相等', () => {
    expect(masksEqual(new Uint8Array([1, 0]), new Uint8Array([1, 0, 0]))).toBe(false);
  });
  it('逐位比较', () => {
    expect(masksEqual(mask('####' + '....' + '....' + '....'), LATIN)).toBe(false);
    expect(masksEqual(LATIN, LATIN)).toBe(true);
  });
});

describe('中文字形覆盖判定', () => {
  it('全部有字形 → 通过', () => {
    const m = base();
    m.set('今', CJK);
    m.set('日', mask('.###' + '##..' + '#.#.' + '.###'));
    const r = classifyCoverage(m);
    expect(r.detectorOk).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.noInk).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(2);
  });

  it('画成豆腐块 → 判为缺字', () => {
    const m = base();
    m.set('龘', TOFU);
    const r = classifyCoverage(m);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['龘']);
  });

  it('非空白字符但完全没墨 → 单独归为 noInk，不算通过', () => {
    const m = base();
    m.set('目', BLANK);
    const r = classifyCoverage(m);
    expect(r.ok).toBe(false);
    expect(r.noInk).toEqual(['目']);
    expect(r.missing).toEqual([]);
    expect(r.message).toContain('无墨迹');
  });

  it('空格不参与判定', () => {
    const m = base();
    m.set(' ', BLANK);
    expect(classifyCoverage(m).ok).toBe(true);
  });

  it('负对照失效（缺字参考与真字形同形）→ detectorOk=false 且 ok=false', () => {
    const m = base();
    m.set(CTRL_MISSING, CJK);            // 参考"缺字"其实画出了字形
    const r = classifyCoverage(m);
    expect(r.detectorOk).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.checked).toBe(0);
    expect(r.message).toContain('不可信');
  });

  it('缺少对照字符 → detectorOk=false，不冒充通过', () => {
    const m = new Map<string, Uint8Array>([['今', CJK]]);
    const r = classifyCoverage(m);
    expect(r.detectorOk).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('message 里带上缺字的样张，便于直接定位', () => {
    const m = base();
    m.set('龘', TOFU);
    expect(classifyCoverage(m).message).toContain('龘');
  });
});
