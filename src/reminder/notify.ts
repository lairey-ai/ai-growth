import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NotificationPayload {
  title: string;
  body: string;
}

/** Notification Adapter（§1.3 / §24）— 必须可替换 */
export interface NotificationAdapter {
  readonly name: string;
  notify(payload: NotificationPayload): Promise<void>;
}

/** macOS 本地通知：osascript display notification */
export class MacOsNotificationAdapter implements NotificationAdapter {
  readonly name = 'macos-local';

  async notify(payload: NotificationPayload): Promise<void> {
    const script = `display notification ${appleEscape(payload.body)} with title ${appleEscape(payload.title)}`;
    await execFileAsync('osascript', ['-e', script], { timeout: 10_000 });
  }
}

/** 静默适配器（测试 / 关闭提醒时用） */
export class NullNotificationAdapter implements NotificationAdapter {
  readonly name = 'null';
  async notify(): Promise<void> {}
}

function appleEscape(s: string): string {
  // AppleScript 字符串字面量转义：反斜杠和双引号
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function createNotificationAdapter(kind = 'macos-local'): NotificationAdapter {
  switch (kind) {
    case 'macos-local':
      return new MacOsNotificationAdapter();
    case 'none':
    default:
      return new NullNotificationAdapter();
  }
}
