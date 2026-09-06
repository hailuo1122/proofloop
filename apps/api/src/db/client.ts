import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let _raw: DatabaseSync | null = null;
let _rawPath: string | null = null;

export function getSqlitePath(databaseUrl = process.env.DATABASE_URL ?? 'file:./.data/proofloop.db') {
  const file = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl;
  return resolve(process.cwd(), file);
}

export function getDb(databaseUrl?: string) {
  if (_raw) {
    // A different file was requested than the one backing the singleton —
    // fail loudly instead of silently returning the wrong database.
    if (databaseUrl && _rawPath && getSqlitePath(databaseUrl) !== _rawPath) {
      throw new Error(
        `sqlite_single_instance: getDb("${databaseUrl}") conflicts with already-open "${_rawPath}"`,
      );
    }
    return _raw;
  }
  const abs = getSqlitePath(databaseUrl);
  mkdirSync(dirname(abs), { recursive: true });
  _raw = new DatabaseSync(abs);
  _rawPath = abs;
  try {
    _raw.exec('PRAGMA journal_mode = WAL');
    _raw.exec('PRAGMA busy_timeout = 5000');
    _raw.exec('PRAGMA foreign_keys = ON');
  } catch {
    // ignore pragma failures on exotic builds
  }
  return _raw;
}

/** Run `fn` inside a single SQLite transaction (BEGIN IMMEDIATE). */
export function withTransaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // already rolled back / no txn
    }
    throw err;
  }
}

export function resetDbForTests() {
  _raw?.close();
  _raw = null;
  _rawPath = null;
}
