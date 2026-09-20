import { describe, it, expect } from 'vitest';
import { commandFits, MAX_DEVICE_CMDLINE } from '../../src/device/provision.js';

/**
 * 串口命令行长度闸门。
 *
 * 为什么锁这个：固件的命令行编辑器超长是**静默丢字符**的 —— 命令照样解析，
 * 只是末尾少几个字符。真机上就是这么踩的：中文 Wi-Fi 名走 hex 后整行 129 字符，
 * 而当时的上限是 128，于是**令牌最后一位被吃掉**，设备一直回 HTTP 401，
 * 日志里只有"令牌不对"，看几小时也看不出是被截断。
 * 宿主侧主动拦住，才能把这种"静默"变成"明说"。
 */
describe('设备串口命令行长度闸门', () => {
  it('中文 SSID 走 hex 的真实长度必须在闸门内（回归守卫）', () => {
    // 复现真机那条命令的形状（用等长的占位数据，避免把个人 Wi-Fi 信息写进仓库）：growth_set_hex <ssid_hex> <pass_hex> <host> <port> <token>
    const ssidHex = Buffer.from('示例无线网_Wi-Fi5', 'utf8').toString('hex');   // 22 字节 → 44 字符
    const passHex = Buffer.from('example12', 'utf8').toString('hex');            // 9 字节 → 18 字符
    const token = 'a'.repeat(32);
    const line = ['growth_set_hex', ssidHex, passHex, '192.168.1.10', '4580', token].join(' ');
    expect(line.length).toBe(129);            // 这条当年就是被 128 的上限截掉的
    expect(commandFits(line)).toBe(true);     // 上限提到 512 后必须放得下
  });

  it('ASCII 凭据走 growth_set 时更短，当然也放得下', () => {
    const line = ['growth_set', 'mywifi', 'pass1234', '192.168.1.10', '4580', 'a'.repeat(32)].join(' ');
    expect(commandFits(line)).toBe(true);
  });

  it('超长要被拦下（而不是发出去让设备静默截断）', () => {
    const line = ['growth_set_hex', 'x'.repeat(MAX_DEVICE_CMDLINE)].join(' ');
    expect(commandFits(line)).toBe(false);
  });

  it('临界点留了余量，不贴着上限', () => {
    expect(commandFits('x'.repeat(MAX_DEVICE_CMDLINE - 8))).toBe(true);
    expect(commandFits('x'.repeat(MAX_DEVICE_CMDLINE - 7))).toBe(false);
  });
});
