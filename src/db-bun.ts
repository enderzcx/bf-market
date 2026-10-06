import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db, DbRow, DbStatement } from './db.ts';

// Bun entry implementation of the shared Db surface. Engine-level pragmas live
// here because they configure the local SQLite file; the Durable Object owns its
// own journaling and rejects them.
export function createBunDb(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = FULL;');

  return {
    exec(sql: string) {
      db.exec(sql);
    },
    run(sql: string, params: readonly unknown[] = []) {
      const result = db.run(sql, params as never[]);
      return { changes: result.changes };
    },
    query(sql: string): DbStatement {
      const stmt = db.query(sql);
      return {
        get(...params: unknown[]): DbRow | null {
          return (stmt.get(...(params as never[])) as DbRow | null) ?? null;
        },
        all(...params: unknown[]): DbRow[] {
          return stmt.all(...(params as never[])) as DbRow[];
        },
        run(...params: unknown[]) {
          return { changes: stmt.run(...(params as never[])).changes };
        },
      };
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
    close() {
      db.close();
    },
  };
}
