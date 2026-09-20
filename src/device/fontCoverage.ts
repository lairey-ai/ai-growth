/**
 * 中文字形覆盖检查（宿主侧）。
 *
 * 为什么设备端的字体问题要在宿主侧解决：
 *   AI Passport 固件里能用的中文字体是「子集」——官方文档 lvgl-chinese-fonts.md 明确说
 *   内置的 Source Han Sans 只是部分字形，而默认 Montserrat 一个汉字都没有。
 *   我们的做法是让【卡片的每一个字都变成像素】（服务端 Chrome 出图 → RGB565 → 设备直写屏幕），
 *   设备端不调用任何文本绘制。于是「字体覆盖」这件事整体搬到了宿主：
 *   只要宿主渲染时没画出豆腐块，设备上就不可能出现豆腐块。
 *
 * 这个文件就是那条保证的检查器。它不用任何新依赖：直接让同一套 Chrome 渲染一张
 * 「每格一个字符」的网格图，再把每格与【已知缺字】的参考格做位图比对。
 *
 * 方法边界（必须说清，不要夸大）：
 *   - 它检测的是「宿主实际画出来的结果」，不是字体 cmap。缺字在 Chrome 里会落成
 *     .notdef（豆腐块）或者空白，这两种都能被抓到；但如果某个 fallback 字体把缺字
 *     画成了另一个形状，本检查会漏判。
 *   - 所以内置了一个【负对照】：U+E010（私用区，任何字体都没有映射）必须被判为缺字，
 *     并且与已知存在的 'A' 必须判为不同。负对照不成立就直接报 detector 失效，
 *     而不是「全部通过」——否则这个检查就是摆设。
 */
import { decodePng } from './png.js';
import { screenshotPng } from './render.js';

/** 单元格边长。28px 字号的中文在这个尺寸里不会贴边，留出抗锯齿余量。 */
export const CELL = 40;
const FONT_SIZE = 28;
const COLS = 16;
/** 单次渲染的最大行数：再高就分批，避免一张巨图。 */
const MAX_ROWS = 24;

/** 私用区码点，任何常见字体都不提供映射 —— 用它当"缺字长相"的参考。 */
export const CTRL_MISSING = '\uE010';
/** 已知存在的中文字（"爱"）与拉丁字母，用来确认检查器确实能区分"有字形"。 */
export const CTRL_PRESENT = 'A';
export const CTRL_PRESENT_CJK = '\u7231';

const FONT_STACK =
  '"PingFang SC","Hiragino Sans GB","Heiti SC","Microsoft YaHei",sans-serif';

/** 位图完全一致（含长度）*/
export function masksEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hasInk(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i]) return true;
  return false;
}

export interface CoverageResult {
  /** 检查是否通过（无缺字、无空白异常、且负对照成立）*/
  ok: boolean;
  /** 被判为缺字（画出来与参考豆腐块一致，或有墨但为空）*/
  missing: string[];
  /** 非空白字符却一个像素都没画出来 */
  noInk: string[];
  /** 检查器自身是否可信（负对照与正对照都符合预期）*/
  detectorOk: boolean;
  checked: number;
  /** 一句话结论，直接进验证报告 */
  message: string;
}

/**
 * 纯函数：给定「字符 → 单元格墨迹位图」，判定哪些字符缺字形。
 * 与 Chrome 解耦，因此可以在单元测试里用合成位图覆盖（含负对照失效的分支）。
 */
export function classifyCoverage(masks: Map<string, Uint8Array>): CoverageResult {
  const refMissing = masks.get(CTRL_MISSING);
  const refLatin = masks.get(CTRL_PRESENT);
  const refCjk = masks.get(CTRL_PRESENT_CJK);

  // 负对照必须三个方向都比：参考"缺字"要区别于拉丁真字形、也要区别于中文真字形，
  // 并且两个真字形彼此可区分。少比 refMissing↔refCjk 这一条，就会出现
  // 「参考缺字其实画的是中文真字形」而检查照样"通过"的假阳性 —— 那样整个检查就是摆设。
  const detectorOk =
    !!refMissing && !!refLatin && !!refCjk &&
    !masksEqual(refMissing, refLatin) &&
    !masksEqual(refMissing, refCjk) &&
    !masksEqual(refLatin, refCjk);

  // 对照不成立就一个字符都不判：宁可报"检查无效"，也不给出一份不可信的结论。
  if (!detectorOk) {
    return {
      ok: false,
      missing: [],
      noInk: [],
      detectorOk: false,
      checked: 0,
      message:
        `字形覆盖检查不可信：负对照失效（U+E010 与 'A'/爱 的渲染结果相同或缺失），未判定任何字符`,
    };
  }

  const missing: string[] = [];
  const noInk: string[] = [];
  let checked = 0;

  for (const [ch, mask] of masks) {
    if (ch === CTRL_MISSING || ch === CTRL_PRESENT || ch === CTRL_PRESENT_CJK) continue;
    if (/^\s$/.test(ch)) continue;          // 空格不参与判定
    checked++;
    if (!hasInk(mask)) {
      noInk.push(ch);
      continue;
    }
    // 与参考豆腐块位图一致 = 这个字符没有字形
    if (refMissing && masksEqual(mask, refMissing)) missing.push(ch);
  }

  const ok = missing.length === 0 && noInk.length === 0;
  const message = ok
    ? `字形覆盖：${checked} 个字符全部有字形（负对照有效）`
    : `字形覆盖失败：缺字形 ${missing.length} 个${missing.length ? `（${missing.slice(0, 20).join('')}）` : ''}` +
      `${noInk.length ? `，无墨迹 ${noInk.length} 个（${noInk.slice(0, 20).join('')}）` : ''}`;

  return { ok, missing, noInk, detectorOk, checked, message };
}

function escapeHtmlChar(ch: string): string {
  const c = ch.codePointAt(0) ?? 0;
  return `&#x${c.toString(16).toUpperCase()};`;
}

/** 生成一屏绝对定位的字符网格；绝对定位是为了让单元格与像素坐标严格对齐。 */
function buildGridHtml(chars: string[]): { html: string; width: number; height: number } {
  const rows = Math.ceil(chars.length / COLS);
  const width = COLS * CELL;
  const height = rows * CELL;
  const cells = chars.map((ch, i) => {
    const x = (i % COLS) * CELL;
    const y = Math.floor(i / COLS) * CELL;
    return `<span style="position:absolute;left:${x}px;top:${y}px;width:${CELL}px;height:${CELL}px;` +
      `line-height:${CELL}px;text-align:center;font-size:${FONT_SIZE}px;overflow:hidden">${escapeHtmlChar(ch)}</span>`;
  }).join('');
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;background:#ffffff;overflow:hidden;
  font-family:${FONT_STACK};-webkit-font-smoothing:antialiased;color:#000000}
</style></head><body>${cells}</body></html>`;
  return { html, width, height };
}

/**
 * 渲染网格并抽出每个字符的墨迹位图。
 * 返回的 Map 一定包含三个对照字符，调用方不必自己补。
 */
export async function renderGlyphMasks(text: string): Promise<Map<string, Uint8Array>> {
  const uniq = [...new Set([...text])].filter((c) => c !== '\n' && c !== '\r' && c !== '\t');
  // 只保留「可打印」字符？不：把全部字符都测一遍更保险，制表符等已在上面剔除。
  const all = [CTRL_MISSING, CTRL_PRESENT, CTRL_PRESENT_CJK, ...uniq];

  const masks = new Map<string, Uint8Array>();
  for (let start = 0; start < all.length; start += COLS * MAX_ROWS) {
    const batch = all.slice(start, start + COLS * MAX_ROWS);
    const { html, width, height } = buildGridHtml(batch);
    const png = await screenshotPng(html, { width, height });
    const img = decodePng(png);
    if (img.width !== width || img.height !== height) {
      throw new Error(
        `FONT_COVERAGE_SIZE: 网格渲染出 ${img.width}x${img.height}，期望 ${width}x${height}`
      );
    }
    for (let i = 0; i < batch.length; i++) {
      const cx = (i % COLS) * CELL;
      const cy = Math.floor(i / COLS) * CELL;
      const mask = new Uint8Array(CELL * CELL);
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          // cell 内坐标 (x, y) → 图像坐标
          const px = cx + x;
          const py = cy + y;
          const s = (py * img.width + px) * img.channels;
          const lum = (img.data[s] * 299 + img.data[s + 1] * 587 + img.data[s + 2] * 114) / 1000;
          mask[y * CELL + x] = lum < 160 ? 1 : 0;
        }
      }
      masks.set(batch[i], mask);
    }
  }
  return masks;
}

/** 端到端：给一段文本，返回覆盖检查结论。 */
export async function checkGlyphCoverage(text: string): Promise<CoverageResult> {
  return classifyCoverage(await renderGlyphMasks(text));
}
