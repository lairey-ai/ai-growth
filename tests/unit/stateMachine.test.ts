import { describe, it, expect } from 'vitest';
import { assertActionTransition, assertGoalTransition, canActionTransition } from '../../src/core/stateMachine.js';
import { DomainError } from '../../src/shared/result.js';

describe('Action 状态机（附录 B）', () => {
  it('DRAFT → PLANNED 合法', () => {
    expect(() => assertActionTransition('DRAFT', 'PLANNED', 'MAIN_QUEST')).not.toThrow();
  });

  it('PLANNED → COMPLETED 合法（IN_PROGRESS 是可选中间态，允许一句话完成）', () => {
    expect(canActionTransition('PLANNED', 'COMPLETED', 'DAILY')).toBe(true);
    expect(canActionTransition('PLANNED', 'COMPLETED', 'MAIN_QUEST')).toBe(true);
  });

  it('IN_PROGRESS → COMPLETED 合法', () => {
    expect(() => assertActionTransition('IN_PROGRESS', 'COMPLETED', 'MAIN_QUEST')).not.toThrow();
  });

  it('DRAFT → COMPLETED 非法（草稿必须先进入计划）', () => {
    expect(canActionTransition('DRAFT', 'COMPLETED', 'DAILY')).toBe(false);
  });

  it('EXPIRED 仅 DAILY：MAIN_QUEST → EXPIRED 非法', () => {
    expect(() => assertActionTransition('PLANNED', 'EXPIRED', 'MAIN_QUEST')).toThrow(/EXPIRED is only valid for DAILY/);
    expect(() => assertActionTransition('PLANNED', 'EXPIRED', 'DAILY')).not.toThrow();
  });

  it('PENDING_REPLAN → PLANNED（replan 后 re-arm）合法', () => {
    expect(canActionTransition('PENDING_REPLAN', 'PLANNED', 'MAIN_QUEST')).toBe(true);
  });

  it('终态不可再转换', () => {
    for (const terminal of ['COMPLETED', 'SKIPPED', 'EXPIRED', 'CANCELLED'] as const) {
      expect(canActionTransition(terminal, 'PLANNED', 'DAILY')).toBe(false);
      expect(canActionTransition(terminal, 'COMPLETED', 'DAILY')).toBe(false);
    }
  });

  it('COMPLETED → IN_PROGRESS 非法（不可复活）', () => {
    expect(canActionTransition('COMPLETED', 'IN_PROGRESS', 'DAILY')).toBe(false);
  });
});

describe('Goal 状态机', () => {
  it('DRAFT → CONFIRMED → ACTIVE 合法路径', () => {
    expect(() => assertGoalTransition('DRAFT', 'CONFIRMED')).not.toThrow();
    expect(() => assertGoalTransition('CONFIRMED', 'ACTIVE')).not.toThrow();
  });

  it('DRAFT → ACTIVE 非法（跳过确认）', () => {
    expect(() => assertGoalTransition('DRAFT', 'ACTIVE')).toThrow(DomainError);
  });

  it('PAUSED ↔ ACTIVE 合法', () => {
    expect(() => assertGoalTransition('ACTIVE', 'PAUSED')).not.toThrow();
    expect(() => assertGoalTransition('PAUSED', 'ACTIVE')).not.toThrow();
  });

  it('COMPLETED 是终态', () => {
    expect(() => assertGoalTransition('COMPLETED', 'ACTIVE')).toThrow(DomainError);
  });
});
