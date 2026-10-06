// Bundle-time stand-in for `bun:sqlite`, wired through the `alias` entry in
// wrangler.jsonc. The Durable Object never constructs a bun Database (it injects
// a ctx.storage.sql-backed Db into createStore), so this module must never be
// reached at runtime.
export class Database {
  constructor() {
    throw new Error(
      'bun:sqlite is not available in Workers; the Durable Object uses ctx.storage.sql.',
    );
  }
}

export type Statement = never;
