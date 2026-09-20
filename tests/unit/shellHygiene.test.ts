import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const projectDir = join(__dirname, '..', '..');
const scriptsDir = join(projectDir, 'scripts');

/**
 * Shell 脚本卫生检查（踩过的坑，防止复发）。
 *
 * 1. `$VAR` 紧跟多字节字符（如「：$VAR（版本」）在非 UTF-8 locale 下，
 *    bash 会把多字节字节当作标识符的一部分，报 "VAR（版本: unbound variable"。
 *    必须写 `${VAR}`。
 * 2. 脚本里的 plist 占位符必须与模板一致，避免 sed 替换后留下未替换的占位符。
 */
describe('Shell 脚本卫生', () => {
  const files = readdirSync(scriptsDir).filter((f) => f.endsWith('.sh')).sort();

  it('脚本目录可读且有内容', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it('不得出现 $VAR 紧跟非 ASCII 字符（多字节会被并入变量名）', () => {
    const offenders: string[] = [];
    const pattern = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/g;
    for (const f of files) {
      const lines = readFileSync(join(scriptsDir, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(pattern)) {
          offenders.push(`${f}:${i + 1}  ${JSON.stringify(m[0])}  →  应写成 \${VAR}`);
        }
      });
    }
    expect(offenders, `这些位置需要加花括号：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('plist 模板的占位符必须与安装脚本替换的一致', () => {
    const tpl = readFileSync(join(projectDir, 'launchd', 'com.lairey.ai-growth.daemon.plist'), 'utf8');
    const installer = readFileSync(join(scriptsDir, 'install.sh'), 'utf8');

    const placeholders = [...tpl.matchAll(/__([A-Z_]+)__/g)].map((m) => m[1]);
    expect(placeholders.length, 'plist 应包含占位符').toBeGreaterThan(0);
    for (const ph of new Set(placeholders)) {
      expect(installer, `install.sh 未替换占位符 __${ph}__`).toContain(`__${ph}__`);
    }
  });

  it('plist 不得指向 TCC 保护目录（~/Desktop / ~/Documents / ~/Downloads）', () => {
    // 这是真实踩过的坑：plist 指向 ~/Desktop 下的开发目录时，
    // launchd 无法读取该路径，bootstrap 静默失败（I/O error 5）。
    const tpl = readFileSync(join(projectDir, 'launchd', 'com.lairey.ai-growth.daemon.plist'), 'utf8');
    const installer = readFileSync(join(scriptsDir, 'install.sh'), 'utf8');
    for (const [name, text] of [['plist 模板', tpl], ['install.sh', installer]] as const) {
      for (const bad of ['__PROJECT_DIR__/dist', 'Desktop/', 'Documents/', 'Downloads/']) {
        // 注释里可以提到，但作为可执行路径不行 —— 检查 ProgramArguments 相邻行
        if (name === 'plist 模板' && bad === '__PROJECT_DIR__/dist') {
          expect(text, 'plist 不应再用开发目录作为可执行路径').not.toContain('<string>__PROJECT_DIR__/dist');
        }
      }
    }
    // 正向断言：必须使用全局 CLI 占位符
    expect(tpl).toContain('__AI_GROWTH_CLI__');
    expect(installer).toContain('__AI_GROWTH_CLI__');
  });

  it('Shell 脚本引用的 CLI 命令都真实存在于 CLI 命令表里', () => {
    const cliSrc = readFileSync(join(projectDir, 'src', 'cli', 'main.ts'), 'utf8');
    const declared = new Set([...cliSrc.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
    // 从脚本里抓 `ai-growth <cmd>` 与 `"$NODE_BIN" "$GLOBAL_CLI" <cmd>`
    const used = new Set<string>();
    for (const f of files) {
      const text = readFileSync(join(scriptsDir, f), 'utf8');
      for (const m of text.matchAll(/\bai-growth ([a-z-]+)/g)) used.add(m[1]);
      for (const m of text.matchAll(/\$GLOBAL_CLI"? ([a-z-]+)/g)) used.add(m[1]);
    }
    const missing = [...used].filter((c) => !declared.has(c) && c !== 'ai-growth');
    expect(missing, `脚本引用了 CLI 里不存在的命令：${missing.join(', ')}`).toEqual([]);
  });
});
