/**
 * 渲染入口：把「第 N 张设备卡」变成可以直接推给设备的二进制载荷。
 *
 * 同一条路径被三处复用，保证设备上看到的东西永远只有一种画法：
 *   1. daemon 的 `/api/device/card`
 *   2. 构建固件内置兜底卡的脚本（tools/gen_device_assets.ts）
 *   3. 测试
 */
import type { CoreContext } from '../core/context.js';
import {
  buildCardState,
  buildDeck,
  buildCardMeta,
  encodeCardPayload,
  type CardMeta,
} from './deck.js';
import { buildCardHtml } from './card.js';
import { renderCardCached } from './render.js';
import type { CardSpec, CardState } from './types.js';

export interface RenderedCardPayload {
  payload: Buffer;
  meta: CardMeta;
  pixels: Buffer;
  html: string;
  cached: boolean;
}

export interface RenderOptions {
  battery?: number | null;
  offlineSince?: string;
}

/** 用给定的状态与卡规格渲染（构建期生成兜底卡走这条） */
export async function renderSpec(
  state: CardState,
  spec: CardSpec,
  index: number,
  count: number,
  dataDir: string
): Promise<RenderedCardPayload> {
  const meta = buildCardMeta(state, spec, index, count);
  const html = buildCardHtml(state, spec);
  const rendered = await renderCardCached(html, meta.deckId, dataDir);
  return {
    payload: encodeCardPayload(meta, rendered.pixels),
    meta,
    pixels: rendered.pixels,
    html,
    cached: rendered.cached,
  };
}

/**
 * 读取 Core 当前状态，渲染第 index 张卡。
 * 越界返回 null（由 HTTP 层翻成 404），不抛错。
 */
export async function renderCardAt(
  ctx: CoreContext,
  index: number,
  dataDir: string,
  opts: RenderOptions = {}
): Promise<RenderedCardPayload | null> {
  const state = buildCardState(ctx, { battery: opts.battery ?? null, offlineSince: opts.offlineSince });
  const cards = buildDeck(state);
  if (!Number.isInteger(index) || index < 0 || index >= cards.length) return null;
  return renderSpec(state, cards[index], index, cards.length, dataDir);
}

export interface DeckSummary {
  deckId: string;
  count: number;
  cards: Array<{ index: number; kind: string; title: string; actionId: string | null }>;
  today: string;
  dateLabel: string;
  doneCount: number;
  total: number;
  stage: CardState['stage'];
  items: CardState['items'];
}

/** 给模拟器/调试用的牌组摘要（不是设备必需的，设备只看每张卡的 meta） */
export function deckSummary(ctx: CoreContext, opts: RenderOptions = {}): DeckSummary {
  const state = buildCardState(ctx, { battery: opts.battery ?? null });
  const cards = buildDeck(state);
  return {
    deckId: buildCardMeta(state, cards[0], 0, cards.length).deckId,
    count: cards.length,
    cards: cards.map((c, i) => ({
      index: i,
      kind: c.kind,
      title: c.title,
      actionId: buildCardMeta(state, c, i, cards.length).actionId,
    })),
    today: state.dateKey,
    dateLabel: state.dateLabel,
    doneCount: state.doneCount,
    total: state.total,
    stage: state.stage,
    items: state.items,
  };
}
