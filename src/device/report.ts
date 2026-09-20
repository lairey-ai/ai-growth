/**
 * 设备上报的处理：幂等 + 跨天降级为「迟记」。
 *
 * 为什么需要这一层（都是实测出来的，不是设计洁癖）：
 *
 * 1) 幂等：`completeAction` 对已 COMPLETED 的动作会抛
 *    `INVALID_STATE: COMPLETED → COMPLETED`。设备会丢包重试、用户会连按两下，
 *    所以对设备路径必须"已是目标状态即视为成功"。这正是本项目已有的
 *    「action 级幂等」惯例（rollover 就是这么做的）。
 *
 * 2) 跨天：设备离线暂存的操作，等连上 Wi-Fi 时 daemon 的 rollover 可能已经跑过，
 *    此时 `EXPIRED → COMPLETED / IN_PROGRESS / DELAYED` 全是非法转换（实测），
 *    操作会永久丢失。根因是铁律 3（Daily 当天有效、次日作废、绝不跨天）——
 *    这条不能改，所以改为**降级为迟记**：不重写过去的动作状态，
 *    只补一条带真实日期的进展（evidence + growth event），符合铁律 6（只记可核对事实）。
 *
 * 3) 设备时钟不可信：ESP32-C3 没有备电 RTC，开机到 NTP 同步前时间就是错的，
 *    而 `createGrowthEvent` 对 dateKey 不做任何范围校验。因此
 *    **时间戳一律由服务端打**，设备给的日期只用于校验。
 */
import type { CoreContext } from '../core/context.js';
import { writeAudit } from '../core/context.js';
import { DomainError, ErrorCodes } from '../shared/result.js';
import { getAction, completeAction, skipAction, delayAction } from '../core/actions.js';
import { addEvidence, createGrowthEvent } from '../core/evidence.js';
import { getSystemState, setSystemState, todayIn } from '../core/profile.js';
import { nowIso } from '../shared/time.js';
import type { Action } from '../core/types.js';
import type { DeviceOp, DeviceReportInput, DeviceReportOutcome } from './types.js';

const TARGET: Record<DeviceOp, string> = {
  complete: 'COMPLETED',
  skip: 'SKIPPED',
  delay: 'DELAYED',
};

/** 已经走到头、不可能再变成目标状态的动作状态 */
const TERMINAL = new Set(['COMPLETED', 'SKIPPED', 'CANCELLED', 'EXPIRED']);

export interface DeviceReportResult {
  outcome: DeviceReportOutcome;
  actionId: string;
  actionTitle: string;
  actionDateKey: string;
  status: string;
  today: string;
  /** true = 这次是重复上报，没有产生新副作用 */
  duplicate?: boolean;
  evidenceId?: string;
  growthEventId?: string;
  note?: string;
}

export function applyDeviceReport(ctx: CoreContext, input: DeviceReportInput): DeviceReportResult {
  if (!input?.actionId) throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'actionId is required');
  if (!Object.prototype.hasOwnProperty.call(TARGET, input.op)) {
    throw new DomainError(ErrorCodes.VALIDATION_ERROR, `unknown op: ${String(input.op)}`);
  }

  const today = todayIn(ctx);
  const action = getAction(ctx, input.actionId);
  if (!action) throw new DomainError(ErrorCodes.NOT_FOUND, `unknown action: ${input.actionId}`);

  const base = {
    actionId: action.id,
    actionTitle: action.title,
    actionDateKey: action.dateKey,
    today,
  };

  // 设备给的日期只做校验，绝不当时间戳用
  const occurred = input.occurredDateKey;
  if (occurred && (occurred > today || occurred < action.dateKey)) {
    writeAudit(ctx, {
      entityType: 'action',
      entityId: action.id,
      after: { occurredDateKey: occurred, today, actionDateKey: action.dateKey },
      reason: 'device reported an out-of-range occurred date; rejected',
    });
    throw new DomainError(
      ErrorCodes.VALIDATION_ERROR,
      `occurredDateKey ${occurred} 不在 [${action.dateKey}, ${today}] 区间内`
    );
  }

  // 该动作所属的自然日已经过去 → 状态不可再改（铁律 3）
  if (today > action.dateKey) {
    if (input.op !== 'complete') {
      return {
        ...base,
        outcome: 'CONFLICT',
        status: action.status,
        note: `${action.dateKey} 已经过去，${input.op} 无处可施`,
      };
    }
    return lateRecord(ctx, action, today);
  }

  const target = TARGET[input.op];
  if (action.status === target) {
    return { ...base, outcome: 'ALREADY_IN_STATE', status: action.status, duplicate: true };
  }
  if (TERMINAL.has(action.status)) {
    return {
      ...base,
      outcome: 'CONFLICT',
      status: action.status,
      note: `当前状态是 ${action.status}，设备视图已过期，刷新即可`,
    };
  }

  try {
    const updated =
      input.op === 'complete'
        ? completeAction(ctx, action.id)
        : input.op === 'skip'
          ? skipAction(ctx, action.id, input.reason ?? '设备跳过')
          : delayAction(ctx, action.id, input.reason ?? '设备顺延');
    const outcome: DeviceReportOutcome =
      input.op === 'complete' ? 'COMPLETED' : input.op === 'skip' ? 'SKIPPED' : 'DELAYED';
    return { ...base, outcome, status: updated.status };
  } catch (e) {
    if (e instanceof DomainError && e.code === ErrorCodes.INVALID_STATE) {
      const after = getAction(ctx, action.id);
      if (after && after.status === target) {
        return { ...base, outcome: 'ALREADY_IN_STATE', status: after.status, duplicate: true };
      }
      return {
        ...base,
        outcome: 'CONFLICT',
        status: after?.status ?? action.status,
        note: e.message,
      };
    }
    throw e;
  }
}

/** 跨天提交：补一条带真实日期的进展，动作状态一动不动 */
function lateRecord(ctx: CoreContext, action: Action, today: string): DeviceReportResult {
  const key = `late_record:${action.id}`;
  const base = {
    actionId: action.id,
    actionTitle: action.title,
    actionDateKey: action.dateKey,
    status: action.status,
    today,
  };

  const prev = getSystemState(ctx, key);
  if (prev) {
    const parsed = JSON.parse(prev) as { evidenceId?: string; growthEventId?: string };
    return {
      ...base,
      outcome: 'LATE_RECORDED',
      duplicate: true,
      evidenceId: parsed.evidenceId,
      growthEventId: parsed.growthEventId,
      note: '此前已经补记过，未重复写入',
    };
  }

  const ev = addEvidence(ctx, {
    actionId: action.id,
    type: 'TEXT',
    strength: 'USER_CONFIRMED',
    content: `[设备] ${action.dateKey} 完成「${action.title}」，${today} 同步`,
    metadata: {
      source: 'ai-passport-device',
      actionId: action.id,
      actionDateKey: action.dateKey,
      syncedAt: nowIso(),
    },
  });

  const ge = createGrowthEvent(ctx, {
    title: action.title,
    domain: action.domain,
    evidenceIds: [ev.id],
    dateKey: action.dateKey,
    goalId: action.basisGoalId,
    stageId: action.basisStageId,
  });

  setSystemState(ctx, key, JSON.stringify({ evidenceId: ev.id, growthEventId: ge.id, recordedAt: nowIso() }));

  writeAudit(ctx, {
    entityType: 'action',
    entityId: action.id,
    after: { evidenceId: ev.id, growthEventId: ge.id, dateKey: action.dateKey, status: action.status },
    reason: 'device reported completion after the action day expired; recorded as a dated growth event instead of mutating state',
  });

  return {
    ...base,
    outcome: 'LATE_RECORDED',
    evidenceId: ev.id,
    growthEventId: ge.id,
    note: '跨天提交，已降级为迟记：动作状态保持不变，只补一条带真实日期的进展',
  };
}
