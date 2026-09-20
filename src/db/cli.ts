import { loadConfig } from '../shared/config.js';
import { openDb, dbPath } from './client.js';
import { mkdirSync } from 'node:fs';

const cmd = process.argv[2] ?? 'migrate';

if (cmd === 'migrate') {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(cfg.dataDir);
  const rows = db.prepare('SELECT version, name, applied_at FROM _migrations ORDER BY version').all();
  console.log(`DB ready at ${dbPath(cfg.dataDir)}`);
  for (const r of rows as { version: number; name: string; applied_at: string }[]) {
    console.log(`  applied V${r.version}__${r.name} at ${r.applied_at}`);
  }
  db.close();
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
