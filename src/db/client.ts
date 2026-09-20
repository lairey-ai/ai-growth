import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from './migrate.js';

export type DB = Database.Database;

let _db: DB | null = null;

export function openDb(dataDir: string, inMemory = false): DB {
  if (_db) return _db;
  if (!inMemory) mkdirSync(dataDir, { recursive: true });
  const db = new Database(inMemory ? ':memory:' : join(dataDir, 'growth.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  _db = db;
  return db;
}

/** 测试用：独立于全局单例打开内存库 */
export function openTestDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function dbPath(dataDir: string): string {
  return join(dataDir, 'growth.db');
}

export function dataDirExists(p: string): boolean {
  return existsSync(join(p, 'growth.db'));
}
