import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import {
  createDoDb,
  migrateSchema,
  type Db,
  type DbRow,
  type SqlLike,
  type TransactionSyncLike,
} from '../src/db.ts';
import { createBunDb } from '../src/db-bun.ts';
import { createStore, type Store } from '../src/store.ts';
import { ServiceError } from '../src/types.ts';

// A Durable Object cannot be instantiated under `bun test`, so the DO adapter is
// exercised against a bun:sqlite-backed emulation of `ctx.storage.sql`: one
// connection, `exec(query, ...bindings)` returning a cursor with `toArray()` and
// `rowsWritten`, and `transactionSync(fn)` running `fn` inside a transaction.
// Both adapters then run the identical store scenario and must agree.
function createEmulatedDo(): {
  db: Db;
  close: () => void;
} {
  const db = new Database(':memory:');
  const sql: SqlLike = {
    exec(query: string, ...bindings: unknown[]) {
      const trimmed = query.trim();
      const isRead = /^(select|pragma|with)\b/i.test(trimmed);
      if (isRead) {
        const rows = db.query(query).all(...(bindings as never[])) as DbRow[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      if (bindings.length === 0) {
        db.exec(query);
        return { toArray: () => [] as DbRow[], rowsWritten: 0 };
      }
      const result = db.run(query, bindings as never[]);
      return { toArray: () => [] as DbRow[], rowsWritten: result.changes };
    },
  };
  const transactionSync: TransactionSyncLike = (fn) => db.transaction(fn)();
  return { db: createDoDb(sql, transactionSync), close: () => db.close() };
}

const FIXED_NOW = 1_700_000_000_000;
const PAYER = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada' as const;
const PROVIDER = '0x2547c1122c9aFD11eA0c4b66bb033552b90B979F' as const;
const TOKEN = '0x75edC9335175Fc0552D51D48439F229c10420fe3' as const;

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

// Exercises every Db surface the store uses: run/query/get/all, transactions,
// compare-and-swap updates, JSON columns and PRAGMA reads.
function runScenario(store: Store) {
  const results: Record<string, unknown> = {};

  store.setWallet(PROVIDER);
  store.setAutoSettle(true);
  results.partner0 = store.getPartner();
  results.paused0 = store.isPaused();
  store.setPaused(true);
  results.paused1 = store.isPaused();

  store.putChallenge({
    sessionId: 'agent-draft:p1',
    address: PROVIDER,
    nonce: '0x01',
    message: 'm1',
    issuedAt: FIXED_NOW,
    expiresAt: FIXED_NOW + 1000,
  });
  results.challenge = store.getChallenge('agent-draft:p1');
  store.consumeChallenge('agent-draft:p1');
  results.challengeConsumed = store.getChallenge('agent-draft:p1');
  let secondConsume: string | null = null;
  try {
    store.consumeChallenge('agent-draft:p1');
  } catch (err) {
    secondConsume = err instanceof ServiceError ? `ServiceError:${err.status}` : 'other';
  }
  results.secondConsume = secondConsume;

  const draft = store.createAgentDraft({
    draftId: 'a'.repeat(32),
    address: PROVIDER,
    role: 'provider',
    profile: { name: 'Probe', services: [{ name: 'Echo', endpoint: 'https://e.test/e' }] },
    createdAt: FIXED_NOW,
  });
  results.draft = draft;
  results.openDrafts = store.countOpenAgentDrafts(PROVIDER);
  store.setDraftRegistered('a'.repeat(32), '7');
  results.draftRegistered = store.getAgentDraft('a'.repeat(32));

  const agent = store.upsertAgent({
    chainId: 968,
    agentId: '7',
    owner: PROVIDER,
    agentWallet: PROVIDER,
    role: 'provider',
    listed: 'approved',
    agentUri: 'https://market.bflabs.app/registrations/' + 'a'.repeat(32) + '.json',
    registerTx: `0x${'b'.repeat(64)}`,
    blockNumber: '100',
    createdAt: FIXED_NOW,
  });
  results.agent = agent;
  results.agents = store.listAgents({ listed: 'approved' });

  const payment = store.upsertServicePayment({
    paymentKey: `0x${'c'.repeat(64)}`,
    serviceId: 'echo',
    chainId: 968,
    payer: PAYER,
    payTo: PROVIDER,
    asset: TOKEN,
    amount: '1000',
    nonce: '1',
    createdAt: FIXED_NOW,
  });
  results.payment0 = payment;
  store.setServicePaymentStatus(payment.paymentKey, 'settled', {
    txHash: `0x${'d'.repeat(64)}`,
    chargedAmount: '250',
  });
  results.payment1 = store.getServicePayment(payment.paymentKey);
  results.byPayer = store.listServicePaymentsByPayer(PAYER, 10);
  results.stats = store.publicServiceStats();

  store.reserveStarterGas({ address: PAYER, amountWei: 5n, day: '2026-10-06', createdAt: FIXED_NOW });
  store.markStarterGasSigned(PAYER, `0x${'e'.repeat(64)}`, `0x${'f'.repeat(64)}`);
  results.starterGas = store.getStarterGas(PAYER);
  results.starterGasDay = store.sumStarterGasForDay('2026-10-06').toString();

  store.addLlmSpend('2026-10-06', PAYER, 42n);
  store.addLlmSpend('2026-10-06', PAYER, 8n);
  results.llmPayer = store.llmSpendFor('2026-10-06', PAYER).toString();
  results.llmTotal = store.llmSpendTotal('2026-10-06').toString();

  results.missing = store.getAgent(968, '999');
  return results;
}

function buildStores() {
  const bun = createBunDb(':memory:');
  migrateSchema(bun);
  const bunStore = createStore({ path: ':memory:', db: bun, now: () => FIXED_NOW });
  closers.push(() => bunStore.close());

  const emulated = createEmulatedDo();
  migrateSchema(emulated.db);
  const doStore = createStore({ path: ':memory:', db: emulated.db, now: () => FIXED_NOW });
  closers.push(() => {
    doStore.close();
    emulated.close();
  });

  return { bunStore, doStore };
}

test('DO adapter and Bun adapter run the same SQL scenario identically', () => {
  const { bunStore, doStore } = buildStores();
  const bunResults = runScenario(bunStore);
  const doResults = runScenario(doStore);
  expect(doResults).toEqual(bunResults);
  // Guard against a scenario that silently returns nothing on both sides.
  expect((bunResults.agents as unknown[]).length).toBe(1);
  expect(bunResults.secondConsume).toBe('ServiceError:409');
  expect(bunResults.missing).toBeNull();
});

test('DO adapter reports changes=0 for a no-op compare-and-swap update', () => {
  const emulated = createEmulatedDo();
  closers.push(() => emulated.close());
  migrateSchema(emulated.db);
  const insert = emulated.db.run(
    `INSERT INTO sessions (id, created_at) VALUES (?, ?)`,
    ['s1', FIXED_NOW],
  );
  expect(insert.changes).toBe(1);
  const hit = emulated.db.run(`DELETE FROM sessions WHERE id = ?`, ['s1']);
  expect(hit.changes).toBe(1);
  const miss = emulated.db.run(`DELETE FROM sessions WHERE id = ?`, ['s1']);
  expect(miss.changes).toBe(0);
});

test('DO adapter wraps multi-statement DDL and transactions', () => {
  const emulated = createEmulatedDo();
  closers.push(() => emulated.close());
  emulated.db.exec(`
    CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, v INTEGER NOT NULL);
    INSERT INTO t (id, v) VALUES ('a', 1);
  `);
  expect(emulated.db.query(`SELECT v FROM t WHERE id = ?`).get('a')).toEqual({ v: 1 });
  emulated.db.transaction(() => {
    emulated.db.run(`UPDATE t SET v = v + ? WHERE id = ?`, [4, 'a']);
  });
  expect(emulated.db.query(`SELECT v FROM t`).get()).toEqual({ v: 5 });
  // A throwing transaction rolls back on both adapters.
  expect(() =>
    emulated.db.transaction(() => {
      emulated.db.run(`UPDATE t SET v = 99 WHERE id = ?`, ['a']);
      throw new Error('rollback');
    }),
  ).toThrow('rollback');
  expect(emulated.db.query(`SELECT v FROM t`).get()).toEqual({ v: 5 });
});
