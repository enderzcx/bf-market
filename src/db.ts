import { MAX_AMOUNT, MAX_LEDGER } from './money.ts';

// Minimal synchronous SQL surface shared by the Bun entry (bun:sqlite) and the
// Durable Object entry (ctx.storage.sql). The store is written against this
// interface so the same schema and queries run on both engines.
export type DbRow = Record<string, unknown>;

export interface DbStatement {
  get(...params: unknown[]): DbRow | null;
  all(...params: unknown[]): DbRow[];
  run(...params: unknown[]): { changes: number };
}

export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: readonly unknown[]): { changes: number };
  query(sql: string): DbStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
}

// Structural subset of the Durable Object `SqlStorage` API used by createDoDb.
// Kept free of worker types so the adapter can be exercised under bun:sqlite.
export interface SqlCursorLike {
  toArray(): DbRow[];
  rowsWritten: number;
}

export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

export type TransactionSyncLike = <T>(fn: () => T) => T;

// Shared schema and in-place migrations. Both engines run this identical DDL;
// engine-specific configuration (WAL, synchronous, ...) lives in the Bun
// implementation because the Durable Object owns its own journaling.
export function migrateSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS partner (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      wallet TEXT NOT NULL DEFAULT '',
      auto_settle INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0 AND available <= ${MAX_LEDGER.toString()}),
      pending INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0 AND pending <= ${MAX_LEDGER.toString()}),
      paid INTEGER NOT NULL DEFAULT 0 CHECK (paid >= 0 AND paid <= ${MAX_LEDGER.toString()}),
      consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0 AND consumed <= ${MAX_LEDGER.toString()})
    );
    CREATE TABLE IF NOT EXISTS service (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runtime (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fingerprint TEXT NOT NULL,
      bound_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commissions (
      source_id TEXT PRIMARY KEY,
      amount INTEGER NOT NULL CHECK (amount > 0 AND amount <= ${MAX_AMOUNT.toString()}),
      remaining INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= ${MAX_AMOUNT.toString()}),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL UNIQUE,
      recipient TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0 AND amount <= ${MAX_AMOUNT.toString()}),
      status TEXT NOT NULL,
      tx_hash TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      raw_transaction TEXT,
      already_frozen INTEGER NOT NULL DEFAULT 0,
      request_id TEXT,
      external_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS payouts_status ON payouts(status);
    CREATE TABLE IF NOT EXISTS allocations (
      payout_id TEXT NOT NULL,
      commission_source_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      PRIMARY KEY (payout_id, commission_source_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('merchant', 'promoter')),
      credential_fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS challenges (
      session_id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      nonce TEXT NOT NULL,
      message TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS order_snapshots (
      request_id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      reservation_request_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS x402_orders (
      request_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      pay_to TEXT NOT NULL,
      asset TEXT NOT NULL,
      amount TEXT NOT NULL,
      commission_rate TEXT NOT NULL,
      payer TEXT,
      nonce TEXT,
      tx_hash TEXT,
      error TEXT,
      scan_from_block TEXT,
      scan_to_block TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS x402_authorizations (
      request_id TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      payer TEXT NOT NULL,
      nonce TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (chain_id, token, payer, nonce)
    );
    CREATE TABLE IF NOT EXISTS agent_drafts (
      draft_id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('provider', 'buyer')),
      profile_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      registered_agent_id TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_drafts_address ON agent_drafts(address);
    CREATE TABLE IF NOT EXISTS agents (
      chain_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      agent_wallet TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('provider', 'buyer')),
      listed TEXT NOT NULL CHECK (listed IN ('pending', 'approved', 'rejected')),
      agent_uri TEXT NOT NULL,
      register_tx TEXT NOT NULL,
      block_number TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (chain_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS agents_listed ON agents(listed);
    CREATE TABLE IF NOT EXISTS starter_gas_grants (
      address TEXT PRIMARY KEY,
      amount_wei TEXT NOT NULL,
      tx_hash TEXT,
      journal TEXT,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'signed', 'broadcast', 'confirmed', 'blocked')),
      day TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS starter_gas_grants_day ON starter_gas_grants(day);
    CREATE TABLE IF NOT EXISTS service_payments (
      payment_key TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      payer TEXT NOT NULL,
      pay_to TEXT NOT NULL,
      asset TEXT NOT NULL,
      amount TEXT NOT NULL,
      nonce TEXT NOT NULL,
      scheme TEXT NOT NULL DEFAULT 'exact',
      status TEXT NOT NULL CHECK (status IN ('required', 'verified', 'settling', 'settled', 'delivered', 'failed')),
      charged_amount TEXT,
      consumed INTEGER NOT NULL DEFAULT 0,
      usage_json TEXT,
      upstream_request_id TEXT,
      tx_hash TEXT,
      journal TEXT,
      result_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (chain_id, payer, nonce)
    );
    CREATE INDEX IF NOT EXISTS service_payments_service ON service_payments(service_id);
    CREATE TABLE IF NOT EXISTS llm_daily_spend (
      day TEXT NOT NULL,
      payer TEXT NOT NULL,
      charged TEXT NOT NULL,
      PRIMARY KEY (day, payer)
    );
  `);
  // Older local databases predate the metered columns; add them in place so a
  // running instance keeps its payment history.
  const servicePaymentColumns = new Set(
    db.query(`PRAGMA table_info(service_payments)`).all().map((row) => String(row.name)),
  );
  for (const [name, ddl] of [
    ['scheme', `TEXT NOT NULL DEFAULT 'exact'`],
    ['charged_amount', 'TEXT'],
    ['consumed', 'INTEGER NOT NULL DEFAULT 0'],
    ['usage_json', 'TEXT'],
    ['upstream_request_id', 'TEXT'],
  ] as const) {
    if (!servicePaymentColumns.has(name)) {
      db.exec(`ALTER TABLE service_payments ADD COLUMN ${name} ${ddl}`);
    }
  }
}

// Durable Object implementation. Each exec() is an implicit transaction; the
// store's multi-statement unit is wrapped with ctx.storage.transactionSync.
// `SELECT changes()` reports the rows modified by the previous statement, which
// matches bun:sqlite's `.changes` (rowsWritten also counts index rows, so it
// cannot stand in for a compare-and-swap check).
export function createDoDb(sql: SqlLike, transactionSync: TransactionSyncLike): Db {
  const lastChanges = (): number => {
    const row = sql.exec('SELECT changes() AS changes').toArray()[0];
    return row ? Number(row.changes) : 0;
  };
  const runStatement = (query: string, params: readonly unknown[]): { changes: number } => {
    sql.exec(query, ...params);
    return { changes: lastChanges() };
  };
  return {
    exec(query) {
      sql.exec(query);
    },
    run(query, params = []) {
      return runStatement(query, params);
    },
    query(query) {
      return {
        get(...params) {
          const rows = sql.exec(query, ...params).toArray();
          return rows[0] ?? null;
        },
        all(...params) {
          return sql.exec(query, ...params).toArray();
        },
        run(...params) {
          return runStatement(query, params);
        },
      };
    },
    transaction(fn) {
      return transactionSync(fn);
    },
    close() {
      /* the Durable Object owns the database lifetime */
    },
  };
}
