import { afterEach, expect, test } from 'bun:test';
import { migrateSchema, type Db } from '../src/db.ts';
import { createBunDb } from '../src/db-bun.ts';
import { createStore, type Store } from '../src/store.ts';
import { ServiceError } from '../src/types.ts';
import { createEmulatedDo } from './do-adapter.ts';

const FIXED_NOW = 1_700_000_000_000;
const PAYER = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada' as const;
const PROVIDER = '0x2547c1122c9aFD11eA0c4b66bb033552b90B979F' as const;
const TOKEN = '0x75edC9335175Fc0552D51D48439F229c10420fe3' as const;

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

// Both engines build through the same helper so every case can be asserted twice.
function createBunAdapter(): { db: Db; close: () => void } {
  const db = createBunDb(':memory:');
  return { db, close: () => db.close() };
}

const ADAPTERS: Array<[string, () => { db: Db; close: () => void }]> = [
  ['bun', createBunAdapter],
  ['do', createEmulatedDo],
];

function objectNames(db: Db, type: string): string[] {
  return db
    .query(`SELECT name FROM sqlite_master WHERE type = ?`)
    .all(type)
    .map((row) => String(row.name));
}

function columnNames(db: Db, table: string): string[] {
  return db
    .query(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
}

// The schema an already-deployed database has before the budget ledger ships.
// The migration has to extend it in place, not recreate it.
function createLegacyTables(db: Db) {
  db.exec(`
    CREATE TABLE agents (
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
    CREATE TABLE challenges (
      session_id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      nonce TEXT NOT NULL,
      message TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
  `);
}

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

  // Daily budget ledger: the same upserts, occupancy sums and audit rows have to
  // land on both engines.
  store.setOwnBudget({ wallet: PAYER, dailyLimit: 50000n, signer: PAYER, via: 'http' });
  store.setCeiling({
    chainId: 968,
    agentId: '7',
    wallet: PAYER,
    dailyLimit: 20000n,
    signer: PROVIDER,
    via: 'mcp',
  });
  results.ceiling = store.getCeiling(968, '7');
  results.ceilingsForWallet = store.listCeilingsForWallet(PAYER);
  results.walletBudget = store.getWalletBudget(PAYER);
  results.userLimit = store.getUserLimit(PAYER)?.toString();
  results.noUserLimit = store.getUserLimit(PROVIDER) ?? null;

  const holdKey = `0x${'1'.repeat(64)}`;
  results.hold = store.holdSpend({
    paymentKey: holdKey,
    day: '2026-10-06',
    payer: PAYER,
    serviceId: 'echo',
    scheme: 'exact',
    amount: 1000n,
    createdAt: FIXED_NOW,
  });
  results.holdReplay = store.holdSpend({
    paymentKey: holdKey,
    day: '2026-10-06',
    payer: PAYER,
    serviceId: 'echo',
    scheme: 'exact',
    amount: 9999n,
    createdAt: FIXED_NOW,
  });
  store.adjustHold(holdKey, 750n);
  results.spendHeld = store.spendFor(PAYER, '2026-10-06');
  store.chargeSpend(holdKey, 750n);
  results.spendCharged = store.spendFor(PAYER, '2026-10-06');

  const uptoKey = `0x${'2'.repeat(64)}`;
  store.holdSpend({
    paymentKey: uptoKey,
    day: '2026-10-06',
    payer: PROVIDER,
    serviceId: 'llm-glm-5-3',
    scheme: 'upto',
    amount: 19040n,
    createdAt: FIXED_NOW,
  });
  store.releaseSpend(uptoKey);
  results.spendUpto = store.spendFor(PROVIDER, '2026-10-06');

  results.refreshed = store.refreshAgentChainState(968, '7', PROVIDER, PROVIDER, FIXED_NOW);
  results.agentRefreshed = store.getAgent(968, '7');
  results.refreshMissing = store.refreshAgentChainState(968, '999', PROVIDER, PROVIDER, FIXED_NOW);
  results.events = store.listBudgetEvents(PAYER);
  store.removeOwnBudget({ wallet: PAYER, signer: PAYER, via: 'http' });
  store.removeCeiling({ chainId: 968, agentId: '7', signer: PROVIDER, via: 'mcp' });
  results.eventsAfterRemove = store.listBudgetEvents(PAYER);
  results.userLimitAfterRemove = store.getUserLimit(PAYER) ?? null;

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
  // The ledger half of the scenario really did exercise the new paths.
  expect(bunResults.userLimit).toBe('20000');
  expect(bunResults.holdReplay).toEqual(bunResults.hold);
  expect(bunResults.spendHeld).toEqual({
    charged: 0n,
    held: 750n,
    llmCharged: 0n,
    llmHeld: 0n,
  });
  expect(bunResults.spendCharged).toEqual({
    charged: 750n,
    held: 0n,
    llmCharged: 0n,
    llmHeld: 0n,
  });
  expect(bunResults.spendUpto).toEqual({
    charged: 0n,
    held: 0n,
    llmCharged: 0n,
    llmHeld: 0n,
  });
  expect(bunResults.refreshed).toBe(true);
  expect(bunResults.refreshMissing).toBe(false);
  // set + remove for both scopes, newest first, both removals carrying no limit.
  expect(bunResults.eventsAfterRemove).toHaveLength(4);
  expect(bunResults.events).toHaveLength(2);
  expect(bunResults.userLimitAfterRemove).toBeNull();
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

test('migration creates the ledger and budget schema on both adapters', () => {
  for (const [, make] of ADAPTERS) {
    const adapter = make();
    closers.push(adapter.close);
    const db = adapter.db;
    migrateSchema(db);

    for (const table of [
      'agent_budget_ceilings',
      'wallet_budgets',
      'budget_events',
      'wallet_spend',
      'llm_daily_spend',
    ]) {
      expect(objectNames(db, 'table')).toContain(table);
    }
    expect(columnNames(db, 'agent_budget_ceilings')).toEqual([
      'chain_id',
      'agent_id',
      'wallet',
      'daily_limit',
      'set_by',
      'updated_at',
    ]);
    expect(columnNames(db, 'wallet_budgets')).toEqual([
      'wallet',
      'daily_limit',
      'updated_at',
    ]);
    expect(columnNames(db, 'budget_events')).toEqual([
      'id',
      'scope',
      'wallet',
      'agent_id',
      'daily_limit',
      'signer',
      'via',
      'created_at',
    ]);
    expect(columnNames(db, 'wallet_spend')).toEqual([
      'payment_key',
      'day',
      'payer',
      'service_id',
      'scheme',
      'state',
      'amount',
      'created_at',
      'updated_at',
    ]);
    expect(columnNames(db, 'agents')).toContain('refreshed_at');
    expect(columnNames(db, 'challenges')).toContain('intent_json');

    const indexes = objectNames(db, 'index');
    for (const index of [
      'agent_budget_ceilings_wallet',
      'budget_events_wallet',
      'wallet_spend_payer_day',
      'wallet_spend_day_scheme',
      'service_payments_payer',
      'agents_owner',
      'agents_wallet',
    ]) {
      expect(indexes).toContain(index);
    }

    // The ledger only accepts the three payment states.
    const insertSpend = (state: string) =>
      db.run(
        `INSERT INTO wallet_spend
           (payment_key, day, payer, service_id, scheme, state, amount, created_at, updated_at)
         VALUES (?, '2026-10-06', ?, 'echo', 'exact', ?, '1000', 0, 0)`,
        [`0x${state}`, PAYER, state],
      );
    for (const state of ['held', 'charged', 'released']) {
      expect(insertSpend(state).changes).toBe(1);
    }
    expect(() => insertSpend('bogus')).toThrow();

    // The audit trail only accepts the two scopes and the two routes.
    const insertEvent = (scope: string, via: string) =>
      db.run(
        `INSERT INTO budget_events (scope, wallet, agent_id, daily_limit, signer, via, created_at)
         VALUES (?, ?, NULL, NULL, ?, ?, 0)`,
        [scope, PAYER.toLowerCase(), PROVIDER, via],
      );
    expect(insertEvent('ceiling', 'http').changes).toBe(1);
    expect(insertEvent('wallet', 'mcp').changes).toBe(1);
    expect(() => insertEvent('bogus', 'http')).toThrow();
    expect(() => insertEvent('wallet', 'sms')).toThrow();
  }
});

test('migration is idempotent, including on a database that predates it', () => {
  for (const [, make] of ADAPTERS) {
    const adapter = make();
    closers.push(adapter.close);
    const db = adapter.db;
    // A deployed database already has agents and challenges; the new columns and
    // tables are added in place, never twice.
    createLegacyTables(db);
    migrateSchema(db);
    migrateSchema(db);
    expect(columnNames(db, 'agents').filter((c) => c === 'refreshed_at')).toEqual([
      'refreshed_at',
    ]);
    expect(columnNames(db, 'challenges').filter((c) => c === 'intent_json')).toEqual([
      'intent_json',
    ]);
    expect(columnNames(db, 'wallet_spend')).toHaveLength(9);
    expect(columnNames(db, 'budget_events')).toHaveLength(8);
  }
});

test('backfill copies settled spend into wallet_spend and is repeatable', () => {
  for (const [, make] of ADAPTERS) {
    const adapter = make();
    closers.push(adapter.close);
    const db = adapter.db;
    migrateSchema(db);
    const insertPayment = (input: {
      key: string;
      nonce: string;
      status: string;
      amount: string;
      charged: string | null;
    }) =>
      db.run(
        `INSERT INTO service_payments
           (payment_key, service_id, chain_id, payer, pay_to, asset, amount, nonce, scheme, status,
            charged_amount, consumed, usage_json, upstream_request_id, tx_hash, journal, result_json,
            error, created_at, updated_at)
         VALUES (?, 'echo', 968, ?, ?, ?, ?, ?, 'exact', ?, ?, 0, NULL, NULL, NULL, NULL, NULL,
                 NULL, ?, ?)`,
        [
          input.key,
          PAYER,
          PROVIDER,
          TOKEN,
          input.amount,
          input.nonce,
          input.status,
          input.charged,
          FIXED_NOW,
          FIXED_NOW,
        ],
      );

    insertPayment({ key: `0x${'a'.repeat(64)}`, nonce: '1', status: 'settled', amount: '1000', charged: '250' });
    insertPayment({ key: `0x${'b'.repeat(64)}`, nonce: '2', status: 'delivered', amount: '700', charged: null });
    insertPayment({ key: `0x${'c'.repeat(64)}`, nonce: '3', status: 'settling', amount: '900', charged: '42' });
    insertPayment({ key: `0x${'d'.repeat(64)}`, nonce: '4', status: 'settling', amount: '900', charged: null });
    insertPayment({ key: `0x${'5'.repeat(64)}`, nonce: '5', status: 'required', amount: '500', charged: null });
    insertPayment({ key: `0x${'6'.repeat(64)}`, nonce: '6', status: 'verified', amount: '500', charged: null });
    insertPayment({ key: `0x${'7'.repeat(64)}`, nonce: '7', status: 'failed', amount: '500', charged: null });

    migrateSchema(db);
    const rows = db
      .query(`SELECT * FROM wallet_spend ORDER BY payment_key`)
      .all();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => String(row.state))).toEqual(['charged', 'charged', 'charged']);
    // COALESCE(charged_amount, amount), keyed to the UTC day of created_at.
    expect(rows.map((row) => String(row.amount))).toEqual(['250', '700', '42']);
    expect(rows.map((row) => String(row.day))).toEqual([
      '2023-11-14',
      '2023-11-14',
      '2023-11-14',
    ]);

    // Running the migration (and so the backfill) again changes nothing.
    migrateSchema(db);
    expect(
      db
        .query(`SELECT payment_key, day, amount, state FROM wallet_spend ORDER BY payment_key`)
        .all(),
    ).toEqual(rows.map((row) => ({
      payment_key: row.payment_key,
      day: row.day,
      amount: row.amount,
      state: row.state,
    })));
  }
});
