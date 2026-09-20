import { randomUUID } from 'node:crypto';
import { nowIso } from '../shared/time.js';

export function newId(): string {
  return randomUUID();
}

export function ts(): string {
  return nowIso();
}

export function j<T>(v: T): string {
  return JSON.stringify(v);
}

export function pj<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
