import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { budgetMax, effectiveBudget, utcDay } from '../src/budget.ts';
import {
  DEFAULT_SETTLEMENT_BUDGET_MAX_ATOMIC,
  loadConfig,
} from '../src/config.ts';
import { type Db } from '../src/db.ts';
import { createBunDb } from '../src/db-bun.ts';
import { createStore, type Store } from '../src/store.ts';
import { ServiceError, type Address } from '../src/types.ts';
import { createEmulatedDo } from './do-adapter.ts';

// Every behaviour here runs twice: once on bun:sqlite (local) and once on the
// Durable Object SQL adapter (production). Both engines must agree.
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = '2026-10-07';
const NEXT_DAY = '2026-10-08';
const PAYER: Address = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada';
const OWNER: Address = '0x9Fb2A80007047d249F5926960d870cD8aB5E7A4A';
const OTHER: Address = '0x2547c1122c9aFD11eA0c4b66bb033552b90B979F';
const KEY_A = `0x${'a'.repeat(64)}`;
const KEY_B = `0x${'b'.repeat(64)}`;
const KEY_C = `0x${'c'.repeat(64)}`;
const KEY_D = `0x${'d'.repeat(64)}`;
const ECHO = 1_000_000n;
const GLM_QUOTE = 19_040n;

type Adapter = { db: Db; close: () => void };
type Case = { store: Store; db: Db; setNow: (at: number) => void };

const ADAPTERS: Array<[string, () => Adapter]> = [
  ['bun', () => {
    const db = createBunDb(':memory:');
    return { db, close: () => db.close() };
  }],
  ['do', createEmulatedDo],
];

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

function eachBackend(
  opts: { caps?: { payer?: bigint; global?: bigint } } | ((ctx: Case) => void),
  run?: (ctx: Case) => void,
): void {
  const body = typeof opts === 'function' ? opts : (run ?? (() => {}));
  const caps = typeof opts === 'function' ? {} : opts.caps ?? {};
  for (const [, make] of ADAPTERS) {
    const adapter = make();
    closers.push(adapter.close);
    const clock = { at: NOW };
    const store = createStore({
      path: ':memory:',
      db: adapter.db,
      now: () => clock.at,
      llmPayerDailyCapAtomic: caps.payer,
      llmGlobalDailyCapAtomic: caps.global,
    });
    body({ store, db: adapter.db, setNow: (at: number) => { clock.at = at; } });
  }
}

function rejection(fn: () => unknown): ServiceError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ServiceError) return err;
    throw err;
  }
  throw new Error('expected the call to be rejected');
}

function expectRejection(fn: () => unknown, status: number, message: string): void {
  const err = rejection(fn);
  expect(err.status).toBe(status);
  expect(err.message).toBe(message);
}

test('utcDay and budgetMax come from the shared budget core', () => {
  expect(utcDay(Date.UTC(2026, 9, 7, 23, 59, 59, 999))).toBe(DAY);
  expect(utcDay(Date.UTC(2026, 9, 8, 0, 0, 0, 0))).toBe(NEXT_DAY);
  expect(budgetMax({})).toBe(5_000_000n);
  expect(budgetMax({ settlementBudgetMaxAtomic: 1n })).toBe(1n);
});

test('SETTLEMENT_BUDGET_MAX defaults to 5000000 and accepts an override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settlement-budget-config-'));
  const env = { SETTLEMENT_NETWORK: 'botchain-testnet' };
  expect(DEFAULT_SETTLEMENT_BUDGET_MAX_ATOMIC).toBe(5_000_000n);
  expect(loadConfig({ cwd: dir, env }).settlementBudgetMaxAtomic).toBe(5_000_000n);
  expect(
    loadConfig({ cwd: dir, env: { ...env, SETTLEMENT_BUDGET_MAX: '2500000' } })
      .settlementBudgetMaxAtomic,
  ).toBe(2_500_000n);
  expect(() =>
    loadConfig({ cwd: dir, env: { ...env, SETTLEMENT_BUDGET_MAX: '5 USDT' } }),
  ).toThrow(/SETTLEMENT_BUDGET_MAX/);
});

test('effectiveBudget takes the smallest ceiling and the own value', () => {
  expect(effectiveBudget({ ceilings: [], own: null })).toBeNull();
  expect(effectiveBudget({ ceilings: [50_000n], own: null })).toEqual({
    limit: 50_000n,
    source: 'ceiling',
  });
  expect(effectiveBudget({ ceilings: [], own: 30_000n })).toEqual({
    limit: 30_000n,
    source: 'own',
  });
  expect(effectiveBudget({ ceilings: [50_000n], own: 30_000n })).toEqual({
    limit: 30_000n,
    source: 'own',
  });
  expect(effectiveBudget({ ceilings: [10_000n], own: 30_000n })).toEqual({
    limit: 10_000n,
    source: 'ceiling',
  });
  expect(effectiveBudget({ ceilings: [50_000n, 20_000n], own: null })).toEqual({
    limit: 20_000n,
    source: 'ceiling',
  });
  expect(effectiveBudget({ ceilings: [50_000n], own: 50_000n })).toEqual({
    limit: 50_000n,
    source: 'ceiling+own',
  });
});

test('getUserLimit follows ceilings, own value and the minimum of both', () => {
  eachBackend(({ store, db }) => {
    // A ceiling whose agent has no payment wallet applies to nobody.
    db.run(
      `INSERT INTO agent_budget_ceilings (chain_id, agent_id, wallet, daily_limit, set_by, updated_at)
       VALUES (968, '3', '', '40000', ?, ?)`,
      [OWNER, NOW],
    );
    expect(store.getUserLimit(PAYER)).toBeUndefined();
    expect(store.listCeilingsForWallet(PAYER)).toHaveLength(0);

    store.setCeiling({ chainId: 968, agentId: '7', wallet: PAYER, dailyLimit: 50_000n, signer: OWNER, via: 'http' });
    expect(store.getUserLimit(PAYER)).toBe(50_000n);

    store.setOwnBudget({ wallet: PAYER, dailyLimit: 30_000n, signer: PAYER, via: 'http' });
    // The smaller of the two, and the ceiling itself is untouched.
    expect(store.getUserLimit(PAYER)).toBe(30_000n);
    expect(store.getCeiling(968, '7')?.dailyLimit).toBe(50_000n);

    // The owner lowers the ceiling below the agent's stored value: the stored
    // value survives, so raising the ceiling again brings it back.
    store.setCeiling({ chainId: 968, agentId: '7', wallet: PAYER, dailyLimit: 10_000n, signer: OWNER, via: 'http' });
    expect(store.getUserLimit(PAYER)).toBe(10_000n);
    expect(store.getWalletBudget(PAYER)?.dailyLimit).toBe(30_000n);

    // A second agent sharing the same wallet: the minimum of both ceilings wins.
    store.setCeiling({ chainId: 968, agentId: '8', wallet: PAYER, dailyLimit: 20_000n, signer: OTHER, via: 'mcp' });
    expect(store.getUserLimit(PAYER)).toBe(10_000n);
    store.removeCeiling({ chainId: 968, agentId: '7', signer: OWNER, via: 'http' });
    expect(store.getUserLimit(PAYER)).toBe(20_000n);

    // Removing every ceiling leaves the own value in charge.
    store.removeCeiling({ chainId: 968, agentId: '8', signer: OTHER, via: 'mcp' });
    expect(store.getUserLimit(PAYER)).toBe(30_000n);
    store.removeOwnBudget({ wallet: PAYER, signer: PAYER, via: 'http' });
    expect(store.getUserLimit(PAYER)).toBeUndefined();

    // Ceilings only: 20000 and 50000 give 20000.
    store.setCeiling({ chainId: 968, agentId: '7', wallet: PAYER, dailyLimit: 50_000n, signer: OWNER, via: 'http' });
    store.setCeiling({ chainId: 968, agentId: '8', wallet: PAYER, dailyLimit: 20_000n, signer: OTHER, via: 'mcp' });
    expect(store.getUserLimit(PAYER)).toBe(20_000n);
    expect(store.listCeilingsForWallet(PAYER)).toHaveLength(2);
  });
});

test('holdSpend is idempotent per paymentKey and never re-checks limits', () => {
  eachBackend(({ store, db }) => {
    store.setOwnBudget({ wallet: PAYER, dailyLimit: 10_000n, signer: PAYER, via: 'http' });
    const first = store.holdSpend({
      paymentKey: KEY_A,
      day: DAY,
      payer: PAYER,
      serviceId: 'echo',
      scheme: 'exact',
      amount: 10_000n,
    });
    expect(first.state).toBe('held');
    expect(first.amount).toBe(10_000n);

    // Same key, larger amount: the retry gets the row it already owns, and the
    // limits are not evaluated again even though a new hold would be rejected.
    const replay = store.holdSpend({
      paymentKey: KEY_A,
      day: DAY,
      payer: PAYER,
      serviceId: 'echo',
      scheme: 'exact',
      amount: 40_000n,
    });
    expect(replay).toEqual(first);
    expect(db.query(`SELECT COUNT(*) AS n FROM wallet_spend`).get()).toEqual({ n: 1 });
    expect(store.spendFor(PAYER, DAY)).toEqual({
      charged: 0n,
      held: 10_000n,
      llmCharged: 0n,
      llmHeld: 0n,
    });

    expectRejection(
      () =>
        store.holdSpend({
          paymentKey: KEY_B,
          day: DAY,
          payer: PAYER,
          serviceId: 'echo',
          scheme: 'exact',
          amount: 1n,
        }),
      429,
      'Daily budget reached for this wallet.',
    );
  });
});

test('hold lifecycle: adjust, charge, release, and released rows stop counting', () => {
  eachBackend(({ store }) => {
    const held = store.holdSpend({
      paymentKey: KEY_A,
      day: DAY,
      payer: PAYER,
      serviceId: 'llm-glm-5-3',
      scheme: 'upto',
      amount: GLM_QUOTE,
    });
    expect(held.state).toBe('held');
    expect(held.amount).toBe(GLM_QUOTE);

    const adjusted = store.adjustHold(KEY_A, 8_123n);
    expect(adjusted.state).toBe('held');
    expect(adjusted.amount).toBe(8_123n);
    expect(store.spendFor(PAYER, DAY)).toEqual({
      charged: 0n,
      held: 8_123n,
      llmCharged: 0n,
      llmHeld: 8_123n,
    });

    const charged = store.chargeSpend(KEY_A, 8_123n);
    expect(charged.state).toBe('charged');
    expect(charged.amount).toBe(8_123n);
    expect(store.spendFor(PAYER, DAY)).toEqual({
      charged: 8_123n,
      held: 0n,
      llmCharged: 8_123n,
      llmHeld: 0n,
    });

    const released = store.releaseSpend(
      store.holdSpend({
        paymentKey: KEY_B,
        day: DAY,
        payer: PAYER,
        serviceId: 'echo',
        scheme: 'exact',
        amount: 5_000n,
      }).paymentKey,
    );
    expect(released.state).toBe('released');
    // The released row is excluded from the occupancy sums, and releasing twice
    // is a no-op rather than an error.
    expect(store.spendFor(PAYER, DAY)).toEqual({
      charged: 8_123n,
      held: 0n,
      llmCharged: 8_123n,
      llmHeld: 0n,
    });
    expect(store.releaseSpend(KEY_B).state).toBe('released');

    // It also frees the budget: charging one atomic over the limit is rejected,
    // charging exactly the limit is admitted.
    store.setOwnBudget({ wallet: PAYER, dailyLimit: 13_123n, signer: PAYER, via: 'http' });
    expect(
      store.holdSpend({
        paymentKey: KEY_C,
        day: DAY,
        payer: PAYER,
        serviceId: 'echo',
        scheme: 'exact',
        amount: 5_000n,
      }).state,
    ).toBe('held');
    expectRejection(
      () =>
        store.holdSpend({
          paymentKey: KEY_D,
          day: DAY,
          payer: PAYER,
          serviceId: 'echo',
          scheme: 'exact',
          amount: 1n,
        }),
      429,
      'Daily budget reached for this wallet.',
    );
  });
});

test('spendFor counts every service for the user budget and only upto for the caps', () => {
  eachBackend(({ store }) => {
    const exact = store.holdSpend({
      paymentKey: KEY_A,
      day: DAY,
      payer: PAYER,
      serviceId: 'echo',
      scheme: 'exact',
      amount: ECHO,
    });
    store.chargeSpend(exact.paymentKey, ECHO);
    const upto = store.holdSpend({
      paymentKey: KEY_B,
      day: DAY,
      payer: PAYER,
      serviceId: 'llm-glm-5-3',
      scheme: 'upto',
      amount: GLM_QUOTE,
    });
    store.chargeSpend(upto.paymentKey, GLM_QUOTE);

    expect(store.spendFor(PAYER, DAY)).toEqual({
      charged: ECHO + GLM_QUOTE,
      held: 0n,
      llmCharged: GLM_QUOTE,
      llmHeld: 0n,
    });
    // Nothing carries over to the next UTC day.
    expect(store.spendFor(PAYER, NEXT_DAY)).toEqual({
      charged: 0n,
      held: 0n,
      llmCharged: 0n,
      llmHeld: 0n,
    });
  });
});

test('user budget admits exactly the limit and reports the binding limit', () => {
  eachBackend(({ store }) => {
    store.setOwnBudget({ wallet: PAYER, dailyLimit: GLM_QUOTE, signer: PAYER, via: 'http' });
    expect(
      store.holdSpend({
        paymentKey: KEY_A,
        day: DAY,
        payer: PAYER,
        serviceId: 'llm-glm-5-3',
        scheme: 'upto',
        amount: GLM_QUOTE,
      }).state,
    ).toBe('held');
    expectRejection(
      () =>
        store.holdSpend({
          paymentKey: KEY_B,
          day: DAY,
          payer: PAYER,
          serviceId: 'llm-glm-5-3',
          scheme: 'upto',
          amount: 1n,
        }),
      429,
      'Daily budget reached for this wallet.',
    );
  });

  eachBackend(({ store }) => {
    // Ceiling binds: the error names the owner's limit, not the wallet's own.
    store.setCeiling({ chainId: 968, agentId: '7', wallet: PAYER, dailyLimit: 15_000n, signer: OWNER, via: 'http' });
    store.setOwnBudget({ wallet: PAYER, dailyLimit: 30_000n, signer: PAYER, via: 'http' });
    expect(store.getUserLimit(PAYER)).toBe(15_000n);
    expect(
      store.holdSpend({
        paymentKey: KEY_A,
        day: DAY,
        payer: PAYER,
        serviceId: 'llm-glm-5-3',
        scheme: 'upto',
        amount: 15_000n,
      }).state,
    ).toBe('held');
    expectRejection(
      () =>
        store.holdSpend({
          paymentKey: KEY_B,
          day: DAY,
          payer: PAYER,
          serviceId: 'llm-glm-5-3',
          scheme: 'upto',
          amount: 1n,
        }),
      429,
      'Daily budget set by the agent owner is reached.',
    );
    // The wallet's own value is still stored at its old amount.
    expect(store.getWalletBudget(PAYER)?.dailyLimit).toBe(30_000n);
  });
});

test('platform caps count metered spend only', () => {
  // exact (echo) spend does not consume the metered cap.
  eachBackend(({ store }) => {
    // Five echo calls: 5 USDT of exact spend, which would exhaust the metered
    // per-wallet cap if exact payments counted towards it.
    for (const key of [KEY_A, KEY_B, KEY_C, KEY_D, `0x${'e'.repeat(64)}`]) {
      const call = store.holdSpend({
        paymentKey: key,
        day: DAY,
        payer: PAYER,
        serviceId: 'echo',
        scheme: 'exact',
        amount: ECHO,
      });
      store.chargeSpend(call.paymentKey, ECHO);
    }
    expect(store.spendFor(PAYER, DAY).charged).toBe(5n * ECHO);
    expect(store.spendFor(PAYER, DAY).llmCharged).toBe(0n);
    expect(
      store.holdSpend({
        paymentKey: `0x${'f'.repeat(64)}`,
        day: DAY,
        payer: PAYER,
        serviceId: 'llm-glm-5-3',
        scheme: 'upto',
        amount: GLM_QUOTE,
      }).state,
    ).toBe('held');
  });

  // A payer already at the metered cap is rejected with the existing text.
  eachBackend(({ store }) => {
    const first = store.holdSpend({
      paymentKey: KEY_A,
      day: DAY,
      payer: PAYER,
      serviceId: 'llm-glm-5-3',
      scheme: 'upto',
      amount: 4_990_000n,
    });
    store.chargeSpend(first.paymentKey, 4_990_000n);
    expectRejection(
      () =>
        store.holdSpend({
          paymentKey: KEY_B,
          day: DAY,
          payer: PAYER,
          serviceId: 'llm-glm-5-3',
          scheme: 'upto',
          amount: GLM_QUOTE,
        }),
      429,
      'Daily spending limit reached for this payer.',
    );
  });

  // The global cap is checked after the per-payer cap.
  eachBackend({ caps: { global: 1_000n } }, ({ store }) => {
    expectRejection(
      () =>
        store.holdSpend({
          paymentKey: KEY_A,
          day: DAY,
          payer: PAYER,
          serviceId: 'llm-glm-5-3',
          scheme: 'upto',
          amount: 1_001n,
        }),
      429,
      'The daily model budget is exhausted.',
    );
  });

  // With the platform switched off, echo still works: no user budget means no
  // limit at all for exact payments.
  eachBackend({ caps: { payer: 0n, global: 0n } }, ({ store }) => {
    expect(
      store.holdSpend({
        paymentKey: KEY_A,
        day: DAY,
        payer: PAYER,
        serviceId: 'echo',
        scheme: 'exact',
        amount: 100_000_000n,
      }).state,
    ).toBe('held');
    expectRejection(
      () =>
        store.holdSpend({
          paymentKey: KEY_B,
          day: DAY,
          payer: PAYER,
          serviceId: 'llm-glm-5-3',
          scheme: 'upto',
          amount: GLM_QUOTE,
        }),
      429,
      'Daily spending limit reached for this payer.',
    );
  });
});

test('a stale hold counts today and stops counting the next UTC day', () => {
  eachBackend(({ store, setNow }) => {
    store.setOwnBudget({ wallet: PAYER, dailyLimit: 50_000n, signer: PAYER, via: 'http' });
    // An abandoned 202: the client was admitted but never came back.
    const stale = store.holdSpend({
      paymentKey: KEY_A,
      day: DAY,
      payer: PAYER,
      serviceId: 'llm-glm-5-3',
      scheme: 'upto',
      amount: GLM_QUOTE,
    });
    expect(stale.state).toBe('held');
    expect(store.spendFor(PAYER, DAY)).toEqual({
      charged: 0n,
      held: GLM_QUOTE,
      llmCharged: 0n,
      llmHeld: GLM_QUOTE,
    });
    expectRejection(
      () =>
        store.holdSpend({
          paymentKey: KEY_B,
          day: DAY,
          payer: PAYER,
          serviceId: 'echo',
          scheme: 'exact',
          amount: 31_000n,
        }),
      429,
      'Daily budget reached for this wallet.',
    );

    // Past UTC midnight the stale hold is out of the new day...
    setNow(NOW + 86_400_000);
    expect(utcDay(NOW + 86_400_000)).toBe(NEXT_DAY);
    expect(store.spendFor(PAYER, NEXT_DAY)).toEqual({
      charged: 0n,
      held: 0n,
      llmCharged: 0n,
      llmHeld: 0n,
    });
    expect(
      store.holdSpend({
        paymentKey: KEY_C,
        day: NEXT_DAY,
        payer: PAYER,
        serviceId: 'echo',
        scheme: 'exact',
        amount: 31_000n,
      }).state,
    ).toBe('held');
    // ...but it still occupies the day it was held on.
    expect(store.spendFor(PAYER, DAY).held).toBe(GLM_QUOTE);
  });
});

test('every budget write appends one audit event, removals carry no limit', () => {
  eachBackend(({ store }) => {
    expect(store.listBudgetEvents(PAYER)).toEqual([]);
    store.setCeiling({ chainId: 968, agentId: '7', wallet: PAYER, dailyLimit: 20_000n, signer: OWNER, via: 'http' });
    expect(store.listBudgetEvents(PAYER)).toEqual([
      {
        id: 1,
        scope: 'ceiling',
        wallet: PAYER.toLowerCase(),
        agentId: '7',
        dailyLimit: 20_000n,
        signer: OWNER,
        via: 'http',
        createdAt: NOW,
      },
    ]);
    store.setOwnBudget({ wallet: PAYER, dailyLimit: 30_000n, signer: PAYER, via: 'mcp' });
    store.removeOwnBudget({ wallet: PAYER, signer: PAYER, via: 'mcp' });
    store.removeCeiling({ chainId: 968, agentId: '7', signer: OWNER, via: 'http' });

    expect(
      store.listBudgetEvents(PAYER).map((event) => [
        event.scope,
        event.agentId,
        event.dailyLimit,
        event.via,
      ]),
    ).toEqual([
      ['ceiling', '7', null, 'http'],
      ['wallet', null, null, 'mcp'],
      ['wallet', null, 30_000n, 'mcp'],
      ['ceiling', '7', 20_000n, 'http'],
    ]);

    // Removing what is not there writes nothing and reports nothing removed.
    expect(store.removeCeiling({ chainId: 968, agentId: '7', signer: OWNER, via: 'http' })).toBeNull();
    expect(store.removeOwnBudget({ wallet: PAYER, signer: PAYER, via: 'http' })).toBeNull();
    expect(store.listBudgetEvents(PAYER)).toHaveLength(4);
  });
});

test('refreshAgentChainState updates an existing agent and never inserts', () => {
  eachBackend(({ store }) => {
    store.upsertAgent({
      chainId: 968,
      agentId: '7',
      owner: OWNER,
      agentWallet: OWNER,
      role: 'buyer',
      listed: 'approved',
      agentUri: 'https://market.bflabs.app/registrations/a.json',
      registerTx: `0x${'b'.repeat(64)}`,
      blockNumber: '100',
      createdAt: NOW - 1_000,
    });
    expect(store.getAgent(968, '7')?.refreshedAt).toBeNull();

    expect(store.refreshAgentChainState(968, '7', PAYER, PAYER, NOW)).toBe(true);
    const refreshed = store.getAgent(968, '7');
    expect(refreshed?.owner).toBe(PAYER);
    expect(refreshed?.agentWallet).toBe(PAYER);
    expect(refreshed?.refreshedAt).toBe(NOW);
    // Clearing the agent wallet is a valid chain state.
    expect(store.refreshAgentChainState(968, '7', PAYER, '', NOW + 1)).toBe(true);
    expect(String(store.getAgent(968, '7')?.agentWallet)).toBe('');

    // An agent registered outside the platform has no row to refresh.
    expect(store.refreshAgentChainState(968, '999', PAYER, PAYER, NOW)).toBe(false);
    expect(store.getAgent(968, '999')).toBeNull();
  });
});
