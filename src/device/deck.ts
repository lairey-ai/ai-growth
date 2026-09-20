/**
 * 设备「今日卡」的牌组模型与二进制载荷编码。
 *
 * 设计要点：
 *   - 牌组由**服务端**决定（几张卡、每张是什么）。设备是纯显示器 + 遥控器，
 *     只按 index 取图，不需要理解"什么是今日主线"。这样设备端逻辑极小、
 *     也不会和电脑产生理解偏差。
 *   - meta 段是小的 JSON（固件用 cJSON 解析），像素段是裸 RGB565 小端，
 *     固件按 band 流式读取、逐段 blit，不需要在 RAM 里装下整张 153KB 图。
 */
import { createHash } from 'node:crypto';
import type { CoreContext } from '../core/context.js';
import { getActiveGoals, getCurrentStage, listStages } from '../core/goals.js';
import { getTodayPlan } from '../core/actions.js';
import { resolveTimezone } from '../core/profile.js';
import type { CardItem, CardSpec, CardState } from './types.js';

export const MAGIC = Buffer.from('AGCD', 'ascii');
export const PAYLOAD_VERSION = 1;
export const PIXEL_FORMAT_RGB565_LE = 1;
export const CARD_W = 240;
export const CARD_H = 320;
export const HEADER_SIZE = 14;

/** "9月20日 周日" —— 一律按配置时区算（铁律 8：绝不按 UTC 截断） */
export function dateLabelIn(tz: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz, month: 'numeric', day: 'numeric', weekday: 'short',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}月${get('day')}日 ${get('weekday')}`;
}

function countRows(ctx: CoreContext, from: string): number {
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${from}`).get() as { n: number }).n;
}

export interface BuildStateOptions {
  battery?: number | null;
  offlineSince?: string;
}

/** 从 Core 汇总出设备卡的展示状态。只读，不改任何状态。 */
export function buildCardState(ctx: CoreContext, opts: BuildStateOptions = {}): CardState {
  const tz = resolveTimezone(ctx);
  const { plan, actions } = getTodayPlan(ctx);
  const goals = getActiveGoals(ctx);
  const primary = goals[0];
  const stages = primary ? listStages(ctx, primary.id) : [];
  const current = primary ? getCurrentStage(ctx, primary.id) : null;

  const items: CardItem[] = actions.map((a) => ({
    id: a.id,
    kind: a.kind,
    title: a.title,
    status: a.status,
    done: a.status === 'COMPLETED',
    minutes: a.estimatedMinutes ?? undefined,
    why: a.whyToday ?? undefined,
    completionCriteria: a.completionCriteria ?? undefined,
  }));

  const doneCount = items.filter((i) => i.done).length;

  return {
    dateLabel: dateLabelIn(tz),
    dateKey: (plan?.dateKey as string | undefined) ?? dateLabelIn(tz),
    stage: current && stages.length ? { title: current.title, order: current.order, total: stages.length } : null,
    items,
    doneCount,
    total: items.length,
    battery: opts.battery ?? null,
    facts: {
      evidence: countRows(ctx, 'evidence'),
      mainDone: countRows(
        ctx,
        `actions WHERE kind='MAIN_QUEST' AND status='COMPLETED' AND deleted_at IS NULL`
      ),
    },
    offlineSince: opts.offlineSince,
  };
}

/** 牌组内容指纹：条目状态变了（比如完成了一件）就换 id，设备据此判断要重取 */
export function deckIdOf(state: CardState): string {
  const key = [state.dateKey, state.items.map((i) => `${i.id}:${i.status}`).join(','), state.total].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * 排牌组。
 * 有任务：总览 → 每条任务各一张 →（全部完成时）完成页
 * 没任务：单张「今天还没排计划」
 */
export function buildDeck(state: CardState): CardSpec[] {
  if (state.items.length === 0) {
    return [{ kind: 'noplan', title: '今天还没排计划' }];
  }
  const cards: CardSpec[] = [{ kind: 'overview', title: '今日总览' }];
  state.items.forEach((it, i) => {
    cards.push({
      kind: 'task',
      itemIndex: i,
      title: `${it.kind === 'MAIN_QUEST' ? '主线' : '小事'}：${it.title}`,
    });
  });
  if (state.doneCount === state.total && state.total > 0) {
    cards.push({ kind: 'alldone', title: '今天做完了' });
  }
  return cards;
}

/** 这张卡上按「确定」应当执行的动作（只有未完成的任务卡有） */
export function actionIdFor(state: CardState, spec: CardSpec): string | null {
  if (spec.kind !== 'task' || spec.itemIndex === undefined) return null;
  const it = state.items[spec.itemIndex];
  if (!it || it.done) return null;
  return it.id;
}

export interface CardMeta {
  v: number;
  deckId: string;
  index: number;
  count: number;
  kind: string;
  actionId: string | null;
  doneCount: number;
  total: number;
  battery: number | null;
  dateKey: string;
  dateLabel: string;
}

export function buildCardMeta(state: CardState, spec: CardSpec, index: number, count: number): CardMeta {
  return {
    v: PAYLOAD_VERSION,
    deckId: deckIdOf(state),
    index,
    count,
    kind: spec.kind,
    actionId: actionIdFor(state, spec),
    doneCount: state.doneCount,
    total: state.total,
    battery: state.battery,
    dateKey: state.dateKey,
    dateLabel: state.dateLabel,
  };
}

/** 头部 + meta JSON + 裸 RGB565 —— 固件流式解析，不需要整图进 RAM */
export function encodeCardPayload(meta: CardMeta, pixels: Buffer): Buffer {
  if (pixels.length !== CARD_W * CARD_H * 2) {
    throw new Error(`CARD_PAYLOAD: 像素长度 ${pixels.length}，期望 ${CARD_W * CARD_H * 2}`);
  }
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  const head = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(head, 0);
  head.writeUInt8(PAYLOAD_VERSION, 4);
  head.writeUInt8(PIXEL_FORMAT_RGB565_LE, 5);
  head.writeUInt16LE(CARD_W, 6);
  head.writeUInt16LE(CARD_H, 8);
  head.writeUInt32LE(metaBuf.length, 10);
  return Buffer.concat([head, metaBuf, pixels]);
}

export interface ParsedCardPayload {
  meta: CardMeta;
  pixels: Buffer;
}

/** 与固件对称的解析实现，用于测试与模拟器 */
export function decodeCardPayload(buf: Buffer): ParsedCardPayload {
  if (buf.length < HEADER_SIZE) throw new Error('CARD_PAYLOAD: 太短');
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('CARD_PAYLOAD: magic 不匹配');
  const version = buf.readUInt8(4);
  if (version !== PAYLOAD_VERSION) throw new Error(`CARD_PAYLOAD: 版本 ${version} 不支持`);
  if (buf.readUInt8(5) !== PIXEL_FORMAT_RGB565_LE) throw new Error('CARD_PAYLOAD: 像素格式不支持');
  const w = buf.readUInt16LE(6);
  const h = buf.readUInt16LE(8);
  const metaLen = buf.readUInt32LE(10);
  if (w !== CARD_W || h !== CARD_H) throw new Error(`CARD_PAYLOAD: 尺寸 ${w}x${h} 不符`);
  const metaEnd = HEADER_SIZE + metaLen;
  if (buf.length < metaEnd) throw new Error('CARD_PAYLOAD: meta 被截断');
  const meta = JSON.parse(buf.toString('utf8', HEADER_SIZE, metaEnd)) as CardMeta;
  const pixels = buf.subarray(metaEnd);
  if (pixels.length !== CARD_W * CARD_H * 2) {
    throw new Error(`CARD_PAYLOAD: 像素段 ${pixels.length} 字节不符`);
  }
  return { meta, pixels: Buffer.from(pixels) };
}
