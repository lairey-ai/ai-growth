import { describe, it, expect } from 'vitest';
import { pickSerialPorts } from '../../src/device/serial.js';

/**
 * 串口挑选规则。
 *
 * 为什么单独锁：macOS 会给**同一个物理设备**两个节点 /dev/cu.usbmodem*（拨出）
 * 和 /dev/tty.usbmodem*（拨入）。最初两个都收，于是 findSerialPorts 永远返回 2 个，
 * 而 setup 遇到多个候选会直接拒绝 —— 结果是 `device setup` **在所有 macOS 上必然失败**，
 * 报的还是"找到多个串口"这种看起来像环境问题的话。属于典型的静默功能失效，必须钉住。
 */
const MAC_DEV = [
  'cu.usbmodem21201', 'tty.usbmodem21201', 'cu.Bluetooth-Incoming-Port',
  'tty.Bluetooth-Incoming-Port', 'cu.debug-console',
  // USB-UART 桥在 macOS 上同样有 cu/tty 两个节点
  'cu.usbserial-1234', 'tty.usbserial-1234',
];

const LINUX_DEV = ['ttyACM0', 'ttyUSB0', 'ttyS0', 'ttyACM1'];

describe('串口挑选', () => {
  it('macOS：只收 cu.*，不能把同一个设备的 tty.* 孪生节点也算进来', () => {
    const ports = pickSerialPorts(MAC_DEV, 'darwin');
    expect(ports.map((p) => p.path)).toEqual(['/dev/cu.usbmodem21201', '/dev/cu.usbserial-1234']);
  });

  it('macOS：排除蓝牙等虚拟串口', () => {
    const ports = pickSerialPorts(MAC_DEV, 'darwin');
    expect(ports.some((p) => /Bluetooth|debug-console/.test(p.path))).toBe(false);
  });

  it('Linux：收 ttyACM*/ttyUSB*（那边没有 cu.* 孪生节点的问题）', () => {
    const ports = pickSerialPorts(LINUX_DEV, 'linux');
    expect(ports.map((p) => p.path)).toEqual(['/dev/ttyACM0', '/dev/ttyACM1', '/dev/ttyUSB0']);
    expect(ports.some((p) => p.path === '/dev/ttyS0')).toBe(false);
  });

  it('原生 USB-Serial-JTAG 排在 USB-UART 桥前面', () => {
    const ports = pickSerialPorts(['cu.usbserial-A1', 'cu.usbmodem2101'], 'darwin');
    expect(ports[0].kind).toBe('usbmodem');
  });

  it('没有任何候选时返回空数组（而不是抛错）', () => {
    expect(pickSerialPorts([], 'darwin')).toEqual([]);
  });
});
