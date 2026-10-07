import { Database } from 'bun:sqlite';
import {
  createDoDb,
  type Db,
  type DbRow,
  type SqlLike,
  type TransactionSyncLike,
} from '../src/db.ts';

// A Durable Object cannot be instantiated under `bun test`, so the DO adapter is
// exercised against a bun:sqlite-backed emulation of `ctx.storage.sql`: one
// connection, `exec(query, ...bindings)` returning a cursor with `toArray()` and
// `rowsWritten`, and `transactionSync(fn)` running `fn` inside a transaction.
// Shared by every test that has to prove a schema or query works on both storage
// backends.
export function createEmulatedDo(): {
  db: Db;
  raw: Database;
  close: () => void;
} {
  const raw = new Database(':memory:');
  const sql: SqlLike = {
    exec(query: string, ...bindings: unknown[]) {
      const trimmed = query.trim();
      const isRead = /^(select|pragma|with)\b/i.test(trimmed);
      if (isRead) {
        const rows = raw.query(query).all(...(bindings as never[])) as DbRow[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      if (bindings.length === 0) {
        raw.exec(query);
        return { toArray: () => [] as DbRow[], rowsWritten: 0 };
      }
      const result = raw.run(query, bindings as never[]);
      return { toArray: () => [] as DbRow[], rowsWritten: result.changes };
    },
  };
  const transactionSync: TransactionSyncLike = (fn) => raw.transaction(fn)();
  return { db: createDoDb(sql, transactionSync), raw, close: () => raw.close() };
}
