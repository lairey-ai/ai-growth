/** 设备卡的数据契约。固件按这套字段解析（meta 段为 JSON）。 */

export type CardKind =
  | 'overview'   // 今日总览
  | 'task'       // 单条任务
  | 'alldone'    // 全部完成
  | 'noplan'     // 今天还没排计划
  | 'offline'    // 连不上电脑（固件内置）
  | 'booting'    // 正在连接（固件内置）
  | 'setup';     // 未配置（固件内置）

export interface CardSpec {
  kind: CardKind;
  /** kind === 'task' 时，指向 state.items 的下标 */
  itemIndex?: number;
  /** 给日志和测试用的可读标题 */
  title: string;
}

export interface CardItem {
  id: string;
  kind: 'MAIN_QUEST' | 'DAILY';
  title: string;
  status: string;
  done: boolean;
  minutes?: number;
  why?: string;
  completionCriteria?: string;
}

export interface CardState {
  /** "9月20日 周日" —— 由服务端按配置时区算，固件绝不自己截 ISO 串 */
  dateLabel: string;
  dateKey: string;
  stage: { title: string; order: number; total: number } | null;
  items: CardItem[];
  doneCount: number;
  total: number;
  /** -1 或 null = 读不到电量，固件会画成空电池 */
  battery: number | null;
  facts?: { evidence: number; mainDone: number };
  offlineSince?: string;
}

/** 设备上报的操作 */
export type DeviceOp = 'complete' | 'skip' | 'delay';

export interface DeviceReportInput {
  actionId: string;
  op: DeviceOp;
  reason?: string;
  /** 设备自认为的日期。⚠ 设备无备电 RTC，时钟不可信，仅用于校验、不作为时间戳 */
  deviceDateKey?: string;
  /**
   * 若设备曾离线暂存该操作，这里是它当时认为的日期。
   * 服务端据此判断"是不是跨天了"，跨天则降级为迟记。
   */
  occurredDateKey?: string;
}

export type DeviceReportOutcome =
  | 'COMPLETED'        // 正常完成
  | 'SKIPPED'          // 正常跳过
  | 'DELAYED'          // 正常顺延
  | 'ALREADY_IN_STATE' // 幂等：已经是目标状态
  | 'LATE_RECORDED'    // 跨天降级为迟记（写进展，动作状态不动）
  | 'CONFLICT';        // 设备视图已过期（别处已改了状态，或那一天已经过去）
