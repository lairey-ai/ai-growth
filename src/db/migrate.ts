import type { DB } from './client.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// SQL 文件与编译产物同目录：src/db/migrations ↔ dist/db/migrations
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

function loadMigrations(): MigrationFile[] {
  // 构建后：SQL 文件已被复制到 dist/db/migrations/
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((f) => {
    const m = f.match(/^V(\d+)__(.+)\.sql$/);
    if (!m) throw new Error(`Bad migration filename: ${f}`);
    return { version: Number(m[1]), name: m[2].replace(/\.sql$/, ''), sql: readFileSync(join(migrationsDir, f), 'utf8') };
  });
}

export function runMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map((r) => r.version)
  );
  for (const m of loadMigrations()) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version, m.name, new Date().toISOString()
      );
    });
    tx();
  }
}
