import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  CIRCLE_FUJI_USDC,
  loadConfig,
  runtimeConfig,
  runtimeFingerprint,
  type RuntimeConfig,
} from '../src/config.ts';
import { acquireProcessLock } from '../src/lock.ts';
import { createSource } from '../src/source.ts';
import { createStore, type Store } from '../src/store.ts';
import {
  type Chain,
  type Payout,
  type Prepared,
  type Source,
  PROVIDER_FAILURE,
  ServiceError,
  sanitizeError,
} from '../src/types.ts';
import { createWorker } from '../src/worker.ts';

const TOKEN = '0x0000000000000000000000000000000000000001' as const;
const CONTRACT = '0x0000000000000000000000000000000000000002' as const;
const RECIPIENT = '0x0000000000000000000000000000000000000003' as const;
const OTHER = '0x0000000000000000000000000000000000000004' as const;
const KEY = `0x${'1'.padStart(64, '0')}` as Hex;

class MockChain implements Chain {
  prepareCalls = 0;
  broadcastCalls: Hex[] = [];
  inspectCalls = 0;
  inspectResult: 'pending' | 'confirmed' | 'reverted' = 'pending';
  failPrepare: string | null = null;
  failBroadcast: string | null = null;
  failInspect: string | null = null;
  nonce = 0n;
  last?: Prepared;

  async prepare(p: Payout): Promise<Prepared> {
    this.prepareCalls += 1;
    if (this.failPrepare) throw new Error(this.failPrepare);
    const prepared = {
      rawTransaction: keccak256(toHex(`raw:${p.id}:${this.nonce}`)),
      hash: keccak256(toHex(`hash:${p.id}:${this.nonce}`)),
    };
    this.nonce += 1n;
    this.last = prepared;
    return prepared;
  }
  async broadcast(raw: Hex) {
    if (this.failBroadcast) throw new Error(this.failBroadcast);
    this.broadcastCalls.push(raw);
  }
  async inspect(_p: Payout, _hash: Hex) {
    this.inspectCalls += 1;
    if (this.failInspect) throw new Error(this.failInspect);
    return this.inspectResult;
  }
  async balances() {
    return { token: '10000000000', gas: '1000000000000000000' };
  }
}

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

function tmp() {
  return mkdtempSync(join(tmpdir(), 'settlement-'));
}

function config(dir: string, extra: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return runtimeConfig({
    port: 4311,
    chain: extra.chain ?? {
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: 31337,
      contract: CONTRACT,
      token: TOKEN,
      privateKey: KEY,
      recipient: RECIPIENT,
    },
    dbPath: join(dir, 'db.sqlite'),
    lockPath: join(dir, 'lock'),
    publicDir: join(dir, 'public'),
    minAmount: 1_000_000n,
    maturityMs: 0,
    source: 'fixture',
    ...extra,
  });
}

function boot(extra: Partial<RuntimeConfig> = {}, sourceFactory?: (store: Store, cfg: RuntimeConfig) => Source) {
  const dir = tmp();
  let t = 1_700_000_000_000;
  const now = () => t;
  const cfg = config(dir, extra);
  const store = createStore({
    path: join(dir, 'db.sqlite'),
    now,
    fingerprint: runtimeFingerprint(cfg),
  });
  closers.push(() => store.close());
  const chain = new MockChain();
  const source = sourceFactory ? sourceFactory(store, cfg) : createSource(store, cfg);
  const worker = createWorker({ store, chain, source, config: cfg, now });
  return {
    dir,
    store,
    chain,
    source,
    worker,
    config: cfg,
    now,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('fixture settlement', () => {
  test('normal path freezes, signs before broadcast, confirms, then completes source', async () => {
    const { store, chain, worker } = boot();
    store.setWallet(RECIPIENT);
    store.setAutoSettle(true);
    const sourceId = store.addCommission(10_000_000n);
    chain.inspectResult = 'confirmed';
    await worker.tick({ force: true });
    const payouts = store.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0].sourceId.startsWith('fixture:agg:')).toBe(true);
    expect(payouts[0].status).toBe('completed');
    expect(payouts[0].recipient).toBe(RECIPIENT);
    expect(payouts[0].id).toBe(keccak256(toHex(`demo-merchant/${payouts[0].sourceId}`)));
    expect(store.listAllocations(payouts[0].id)).toEqual([
      { commissionId: sourceId, amount: 10_000_000n },
    ]);
    expect(payouts[0].rawTransaction).toBe(chain.broadcastCalls[0]);
    expect(chain.prepareCalls).toBe(1);
    expect(chain.broadcastCalls).toHaveLength(1);
    const partner = store.getPartner();
    expect(partner.available).toBe(0n);
    expect(partner.pending).toBe(0n);
    expect(partner.paid).toBe(10_000_000n);
    expect(partner.autoSettle).toBe(true);
  });

  test('does not report completed until receipt matches and source callback succeeds', async () => {
    let fail = true;
    const ctx = boot({}, (store, cfg) => {
      const inner = createSource(store, cfg);
      return {
        ...inner,
        async complete(payout) {
          if (fail) throw new Error('source callback down Bearer secret-token 0x' + 'ab'.repeat(40));
          return inner.complete(payout);
        },
      };
    });
    ctx.store.setWallet(RECIPIENT);
    ctx.store.addCommission(10_000_000n);
    ctx.chain.inspectResult = 'confirmed';
    await ctx.worker.tick({ force: true });
    expect(ctx.store.listPayouts()[0].status).toBe('confirmed');
    expect(ctx.store.listPayouts()[0].error).not.toContain('secret-token');
    expect(ctx.store.listPayouts()[0].error).not.toContain('ab'.repeat(40));
    expect(ctx.chain.prepareCalls).toBe(1);
    fail = false;
    await ctx.worker.tick();
    expect(ctx.store.listPayouts()[0].status).toBe('completed');
    expect(ctx.chain.prepareCalls).toBe(1);
    expect(ctx.chain.broadcastCalls).toHaveLength(1);
  });

  test('duplicate import returns same id; amount or address change is rejected', () => {
    const { store } = boot();
    const first = store.importReservation({
      sourceId: 'beefapi:req-9:9',
      recipient: RECIPIENT,
      amount: 2_000_000n,
      alreadyFrozen: true,
      requestId: 'req-9',
      externalId: 9,
    });
    const again = store.importReservation({
      sourceId: 'beefapi:req-9:9',
      recipient: RECIPIENT,
      amount: 2_000_000n,
      alreadyFrozen: true,
      requestId: 'req-9',
      externalId: 9,
    });
    expect(again.id).toBe(first.id);
    expect(store.listPayouts()).toHaveLength(1);
    expect(() =>
      store.importReservation({
        sourceId: 'beefapi:req-9:9',
        recipient: OTHER,
        amount: 2_000_000n,
        alreadyFrozen: true,
        requestId: 'req-9',
        externalId: 9,
      }),
    ).toThrow(/不能更改/);
    expect(() =>
      store.importReservation({
        sourceId: 'beefapi:req-9:9',
        recipient: RECIPIENT,
        amount: 3_000_000n,
        alreadyFrozen: true,
        requestId: 'req-9',
        externalId: 9,
      }),
    ).toThrow(/不能更改/);
  });

  test('competing transfer and reserve consume available once', async () => {
    const dir = tmp();
    const path = join(dir, 'db.sqlite');
    const fp = runtimeFingerprint(config(dir));
    const a = createStore({ path, fingerprint: fp });
    const b = createStore({ path, fingerprint: fp });
    closers.push(() => a.close(), () => b.close());
    a.setWallet(RECIPIENT);
    a.addCommission(10_000_000n);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => a.transfer(10_000_000n)),
      Promise.resolve().then(() =>
        b.reserveMature({
          recipient: RECIPIENT,
          minAmount: 1_000_000n,
          nowMs: Date.now(),
          maturityMs: 0,
        }),
      ),
    ]);
    const partner = a.getPartner();
    expect(partner.available).toBe(0n);
    expect(partner.pending + partner.consumed).toBe(10_000_000n);
    expect(partner.pending === 10_000_000n || partner.consumed === 10_000_000n).toBe(true);
    expect(Number(partner.pending > 0n) + Number(partner.consumed > 0n)).toBe(1);
  });

  test('signed-before-broadcast crash retries the same raw transaction', async () => {
    const { store, chain, worker, config } = boot();
    store.setWallet(RECIPIENT);
    store.addCommission(10_000_000n);
    chain.failBroadcast = 'rpc timeout';
    await worker.tick({ force: true });
    const frozen = store.listPayouts()[0];
    expect(frozen.status).toBe('prepared');
    expect(frozen.rawTransaction).toBeTruthy();
    expect(frozen.txHash).toBeTruthy();
    expect(chain.prepareCalls).toBe(1);
    expect(chain.broadcastCalls).toHaveLength(0);
    const raw = frozen.rawTransaction;
    const hash = frozen.txHash;
    chain.failBroadcast = null;
    const worker2 = createWorker({
      store,
      chain,
      source: createSource(store, config),
      config,
    });
    chain.inspectResult = 'pending';
    await worker2.tick({ force: true });
    expect(chain.prepareCalls).toBe(1);
    expect(raw).toBeTruthy();
    expect(chain.broadcastCalls).toEqual([raw as Hex]);
    chain.inspectResult = 'confirmed';
    await worker2.tick();
    expect(store.listPayouts()[0].txHash).toBe(hash);
    expect(store.listPayouts()[0].status).toBe('completed');
  });

  test('broadcast timeout later confirms the same hash', async () => {
    const { store, chain, worker } = boot();
    store.setWallet(RECIPIENT);
    store.addCommission(5_000_000n);
    chain.inspectResult = 'pending';
    await worker.tick({ force: true });
    expect(store.listPayouts()[0].status).toBe('broadcast');
    const hash = store.listPayouts()[0].txHash;
    const raw = store.listPayouts()[0].rawTransaction;
    await worker.tick();
    await worker.tick();
    expect(chain.prepareCalls).toBe(1);
    expect(raw).toBeTruthy();
    expect(new Set(chain.broadcastCalls)).toEqual(new Set([raw as Hex]));
    chain.inspectResult = 'confirmed';
    await worker.tick();
    expect(store.listPayouts()[0].status).toBe('completed');
    expect(store.listPayouts()[0].txHash).toBe(hash);
    expect(chain.prepareCalls).toBe(1);
  });

  test('pause stops new signatures but still reconciles a sent payout', async () => {
    const { store, chain, worker } = boot();
    store.setWallet(RECIPIENT);
    store.addCommission(10_000_000n);
    chain.inspectResult = 'pending';
    await worker.tick({ force: true });
    expect(store.listPayouts()[0].status).toBe('broadcast');
    store.setPaused(true);
    store.addCommission(10_000_000n);
    await worker.tick({ force: true });
    expect(store.listPayouts()).toHaveLength(1);
    expect(chain.prepareCalls).toBe(1);
    chain.inspectResult = 'confirmed';
    await worker.tick({ force: true });
    expect(store.listPayouts()[0].status).toBe('completed');
    expect(store.listRemainingCommissions()).toHaveLength(1);
    expect(chain.prepareCalls).toBe(1);
    store.setPaused(false);
    await worker.tick({ force: true });
    expect(store.listPayouts()).toHaveLength(2);
    expect(chain.prepareCalls).toBe(2);
  });

  test('prepare failure stays reserved and is safe to retry', async () => {
    const { store, chain, worker } = boot();
    store.setWallet(RECIPIENT);
    store.addCommission(10_000_000n);
    chain.failPrepare = 'insufficient gas';
    await worker.tick({ force: true });
    expect(store.listPayouts()[0].status).toBe('reserved');
    expect(store.listPayouts()[0].error).toBe(PROVIDER_FAILURE);
    expect(store.listPayouts()[0].error).not.toContain('insufficient gas');
    expect(store.listPayouts()[0].rawTransaction).toBeNull();
    chain.failPrepare = null;
    chain.inspectResult = 'confirmed';
    await worker.tick({ force: true });
    expect(store.listPayouts()[0].status).toBe('completed');
    expect(chain.prepareCalls).toBe(2);
  });

  test('matching reverted receipt blocks without releasing funds', async () => {
    const { store, chain, worker } = boot();
    store.setWallet(RECIPIENT);
    store.addCommission(10_000_000n);
    chain.inspectResult = 'reverted';
    await worker.tick({ force: true });
    expect(store.listPayouts()[0].status).toBe('blocked');
    const partner = store.getPartner();
    expect(partner.available).toBe(0n);
    expect(partner.pending).toBe(10_000_000n);
    expect(partner.paid).toBe(0n);
    await worker.tick({ force: true });
    expect(chain.prepareCalls).toBe(1);
    expect(store.listPayouts()[0].status).toBe('blocked');
  });

  test('rpc uncertainty keeps the same frozen transaction', async () => {
    const { store, chain, worker } = boot();
    store.setWallet(RECIPIENT);
    store.addCommission(10_000_000n);
    chain.inspectResult = 'pending';
    await worker.tick({ force: true });
    const hash = store.listPayouts()[0].txHash;
    chain.failInspect = 'RPC timeout nonce=9 privateKey=oops';
    await worker.tick();
    expect(store.listPayouts()[0].status).toBe('broadcast');
    expect(store.listPayouts()[0].txHash).toBe(hash);
    expect(store.listPayouts()[0].error).not.toContain('privateKey');
    chain.failInspect = null;
    chain.inspectResult = 'confirmed';
    await worker.tick();
    expect(store.listPayouts()[0].status).toBe('completed');
    expect(store.listPayouts()[0].txHash).toBe(hash);
    expect(chain.prepareCalls).toBe(1);
  });

  test('payout recipient is snapshotted when reserved', async () => {
    const { store, chain, worker } = boot();
    store.setWallet(RECIPIENT);
    store.addCommission(10_000_000n);
    chain.inspectResult = 'pending';
    await worker.tick({ force: true });
    store.setWallet(OTHER);
    expect(store.listPayouts()[0].recipient).toBe(RECIPIENT);
    chain.inspectResult = 'confirmed';
    await worker.tick();
    expect(store.listPayouts()[0].recipient).toBe(RECIPIENT);
    expect(store.getPartner().wallet).toBe(OTHER);
  });

  test('autoSettle stays off until a wallet is bound', () => {
    const { store } = boot();
    expect(store.getPartner().autoSettle).toBe(false);
    expect(() => store.setAutoSettle(true)).toThrow(ServiceError);
    store.setWallet(RECIPIENT);
    store.setAutoSettle(true);
    expect(store.getPartner().autoSettle).toBe(true);
  });

  test('maturity holds fixture commissions until due', async () => {
    const { store, chain, worker, advance } = boot({ maturityMs: 60_000 } as Partial<RuntimeConfig>);
    store.setWallet(RECIPIENT);
    store.addCommission(10_000_000n);
    await worker.tick({ force: true });
    expect(store.listPayouts()).toHaveLength(0);
    advance(60_000);
    chain.inspectResult = 'confirmed';
    await worker.tick({ force: true });
    expect(store.listPayouts()[0].status).toBe('completed');
  });
});

describe('beefapi source', () => {
  test('imports reserved payments with source address and completes after confirmation', async () => {
    const reservations = [
      {
        id: 11,
        request_id: 'r1',
        user_id: 7,
        recipient: RECIPIENT,
        amount_usdc: '2500000',
        quota: 1,
        status: 'reserved',
        transaction_hash: '',
        chain_id: 31337,
        token: TOKEN,
        withdrawal_id: 0,
      },
      {
        id: 12,
        user_id: 99,
        recipient: OTHER,
        amount_usdc: '2500000',
        status: 'reserved',
        chain_id: 31337,
        token: TOKEN,
      },
    ];
    let completed = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/settlement-test/reservations' && req.method === 'GET') {
          return Response.json({ success: true, message: '', data: reservations });
        }
        if (url.pathname === '/api/settlement-test/reservations/11/complete') {
          completed += 1;
          const body = (await req.json()) as { transaction_hash: string };
          return Response.json({
            success: true,
            data: {
              ...reservations[0],
              id: 11,
              request_id: 'r1',
              status: 'completed',
              transaction_hash: body.transaction_hash,
              chain_id: 31337,
              token: TOKEN,
              recipient: RECIPIENT,
              amount_usdc: '2500000',
            },
          });
        }
        if (url.pathname === '/api/settlement-test/partners/7') {
          return Response.json({
            success: true,
            data: { available_usdc: '0', pending_usdc: '2500000', paid_usdc: '0' },
          });
        }
        return new Response('no', { status: 404 });
      },
    });
    closers.push(() => server.stop(true));
    const ctx = boot({
      source: 'beefapi',
      beefapiBaseUrl: `http://127.0.0.1:${server.port}`,
      beefapiToken: 't'.repeat(32),
      partnerUserId: 7,
    });
    ctx.chain.inspectResult = 'confirmed';
    await ctx.worker.tick();
    expect(ctx.store.listPayouts()).toHaveLength(1);
    expect(ctx.store.listPayouts()[0].sourceId).toBe('beefapi:r1:11');
    expect(ctx.store.listPayouts()[0].recipient).toBe(RECIPIENT);
    expect(ctx.store.listPayouts()[0].status).toBe('completed');
    expect(ctx.store.getPartner().autoSettle).toBe(false);
    expect(ctx.store.getPartner().wallet).toBe('');
    expect(completed).toBe(1);
    const balances = await ctx.source.balances();
    expect(balances?.available).toBe('0');
  });

  test('missing partner balance is documented as empty instead of invented', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response('no', { status: 404 });
      },
    });
    closers.push(() => server.stop(true));
    const ctx = boot({
      source: 'beefapi',
      beefapiBaseUrl: `http://127.0.0.1:${server.port}`,
      beefapiToken: 't'.repeat(32),
      partnerUserId: 7,
    });
    expect(await ctx.source.balances()).toBeNull();
  });
});

describe('process lock and config', () => {
  test('child process exclusive lock collides and recovers after SIGKILL', async () => {
    const dir = tmp();
    const path = join(dir, 'settlement.lock');
    const child = Bun.spawn({
      cmd: ['bun', join(import.meta.dir, 'lock-child.ts'), path, '20000'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    closers.push(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let out = '';
    while (!out.includes('HELD')) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
    expect(out).toContain('HELD');
    expect(() => acquireProcessLock(path)).toThrow(/占用/);
    child.kill(9);
    await child.exited;
    const recovered = acquireProcessLock(path);
    recovered.release();
  });

  test('corrupt lock file fails closed', () => {
    const dir = tmp();
    const path = join(dir, 'settlement.lock');
    writeFileSync(path, 'not-a-sqlite-database');
    expect(() => acquireProcessLock(path)).toThrow(/无法使用/);
    expect(() => acquireProcessLock(path)).toThrow(/无法使用/);
  });

  test('loadConfig fails cleanly without chain and pins Fuji USDC', () => {
    const dir = tmp();
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/未配置结算链/);
    expect(() =>
      loadConfig({
        cwd: dir,
        env: {
          SETTLEMENT_CHAIN_ID: '43113',
          SETTLEMENT_RPC_URL: 'https://example.invalid',
          SETTLEMENT_CONTRACT: CONTRACT,
          SETTLEMENT_TOKEN: TOKEN,
          SETTLEMENT_PRIVATE_KEY: KEY,
        },
      }),
    ).toThrow(/代币必须固定为 USDC/);
    expect(() =>
      loadConfig({
        cwd: dir,
        env: {
          SETTLEMENT_CHAIN_ID: '43113',
          SETTLEMENT_RPC_URL: 'https://example.invalid',
          SETTLEMENT_CONTRACT: CONTRACT,
          SETTLEMENT_TOKEN: CIRCLE_FUJI_USDC,
        },
      }),
    ).toThrow(/SETTLEMENT_PRIVATE_KEY/);
    writeFileSync(
      join(dir, 'chain.json'),
      JSON.stringify({
        rpcUrl: 'https://example.invalid',
        chainId: 43113,
        contract: CONTRACT,
        token: CIRCLE_FUJI_USDC,
        privateKey: KEY,
      }),
    );
    expect(() =>
      loadConfig({
        cwd: dir,
        env: { SETTLEMENT_CHAIN_CONFIG: join(dir, 'chain.json') },
      }),
    ).toThrow(/SETTLEMENT_PRIVATE_KEY/);
    const fuji = loadConfig({
      cwd: dir,
      env: {
        SETTLEMENT_CHAIN_ID: '43113',
        SETTLEMENT_RPC_URL: 'https://example.invalid',
        SETTLEMENT_CONTRACT: CONTRACT,
        SETTLEMENT_TOKEN: CIRCLE_FUJI_USDC,
        SETTLEMENT_PRIVATE_KEY: KEY,
      },
    });
    expect(fuji.chain.token).toBe(CIRCLE_FUJI_USDC);
    expect(() =>
      loadConfig({
        cwd: dir,
        env: {
          SETTLEMENT_CHAIN_ID: '1',
          SETTLEMENT_RPC_URL: 'https://example.invalid',
          SETTLEMENT_CONTRACT: CONTRACT,
          SETTLEMENT_TOKEN: TOKEN,
          SETTLEMENT_PRIVATE_KEY: KEY,
        },
      }),
    ).toThrow(/31337|43113|未配置/);
  });

  test('wallet challenge is bound to a recoverable address', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { store } = boot();
    const issuedAt = Date.now();
    const message = [
      'Settlement wallet binding',
      'Domain: http://127.0.0.1:4311',
      'User: demo-partner',
      `Address: ${account.address}`,
      'Nonce: 0xabc',
      'Chain ID: 31337',
      `Issued at: ${new Date(issuedAt).toISOString()}`,
      `Expires at: ${new Date(issuedAt + 300000).toISOString()}`,
    ].join('\n');
    const signature = await account.signMessage({ message });
    store.putChallenge({
      sessionId: 's1',
      address: account.address,
      nonce: '0xabc',
      message,
      issuedAt,
      expiresAt: issuedAt + 300000,
    });
    const challenge = store.getChallenge('s1')!;
    const recovered = await (await import('viem')).recoverMessageAddress({
      message: challenge.message,
      signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});

describe('repair regressions', () => {
  test('aggregate mature commissions settle below per-item threshold', async () => {
    const { store, chain, worker } = boot();
    store.setWallet(RECIPIENT);
    store.setAutoSettle(true);
    store.addCommission(600_000n);
    store.addCommission(600_000n);
    expect(store.getPartner().available).toBe(1_200_000n);
    chain.inspectResult = 'confirmed';
    await worker.tick();
    expect(store.listPayouts()).toHaveLength(1);
    expect(store.listPayouts()[0].amount).toBe(1_200_000n);
    expect(store.listPayouts()[0].status).toBe('completed');
    expect(store.listAllocations(store.listPayouts()[0].id)).toHaveLength(2);
  });

  test('partial consumption leaves remaining mature funds settleable', async () => {
    const { store, chain, worker } = boot();
    store.setWallet(RECIPIENT);
    store.setAutoSettle(true);
    const sourceId = store.addCommission(10_000_000n);
    store.transfer(1_000_000n);
    expect(store.getPartner().available).toBe(9_000_000n);
    expect(store.getPartner().consumed).toBe(1_000_000n);
    expect(store.listRemainingCommissions()[0].remaining).toBe(9_000_000n);
    chain.inspectResult = 'confirmed';
    await worker.tick();
    expect(store.listPayouts()).toHaveLength(1);
    expect(store.listPayouts()[0].amount).toBe(9_000_000n);
    expect(store.listPayouts()[0].status).toBe('completed');
    expect(store.listAllocations(store.listPayouts()[0].id)).toEqual([
      { commissionId: sourceId, amount: 9_000_000n },
    ]);
  });

  test('callback 404 keeps confirmed and retries source only', async () => {
    const reservations = [
      {
        id: 11,
        request_id: 'r1',
        user_id: 7,
        recipient: RECIPIENT,
        amount_usdc: '2500000',
        status: 'reserved',
        chain_id: 31337,
        token: TOKEN,
      },
    ];
    let completeMode: '404' | 'ok' = '404';
    let completes = 0;
    const afterIds: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/settlement-test/reservations' && req.method === 'GET') {
          afterIds.push(url.searchParams.get('after_id') ?? '');
          return Response.json({ success: true, data: reservations });
        }
        if (url.pathname === '/api/settlement-test/reservations/11/complete') {
          completes += 1;
          if (completeMode === '404') return new Response('missing', { status: 404 });
          const body = (await req.json()) as { transaction_hash: string };
          return Response.json({
            success: true,
            data: {
              ...reservations[0],
              status: 'completed',
              transaction_hash: body.transaction_hash,
              amount_usdc: '2500000',
            },
          });
        }
        return new Response('no', { status: 404 });
      },
    });
    closers.push(() => server.stop(true));
    const ctx = boot({
      source: 'beefapi',
      beefapiBaseUrl: `http://127.0.0.1:${server.port}`,
      beefapiToken: 't'.repeat(32),
      partnerUserId: 7,
    });
    ctx.chain.inspectResult = 'confirmed';
    await ctx.worker.tick();
    expect(ctx.store.listPayouts()[0].status).toBe('confirmed');
    expect(ctx.chain.prepareCalls).toBe(1);
    expect(completes).toBeGreaterThan(0);
    const afterFirst = completes;
    await ctx.worker.tick();
    expect(ctx.store.listPayouts()[0].status).toBe('confirmed');
    expect(ctx.chain.prepareCalls).toBe(1);
    expect(completes).toBeGreaterThan(afterFirst);
    completeMode = 'ok';
    await ctx.worker.tick();
    expect(ctx.store.listPayouts()[0].status).toBe('completed');
    expect(ctx.chain.prepareCalls).toBe(1);
    expect(ctx.chain.broadcastCalls).toHaveLength(1);
    expect(afterIds.every((id) => id === '0')).toBe(true);
  });

  test('paused prepared payout is inspected and finished without rebroadcast', async () => {
    const { store, chain, worker } = boot();
    store.setWallet(RECIPIENT);
    store.addCommission(10_000_000n);
    chain.failBroadcast = 'rpc timeout';
    chain.inspectResult = 'pending';
    await worker.tick({ force: true });
    expect(store.listPayouts()[0].status).toBe('prepared');
    expect(chain.broadcastCalls).toHaveLength(0);
    store.setPaused(true);
    chain.failBroadcast = null;
    chain.inspectResult = 'confirmed';
    await worker.tick({ force: true });
    expect(store.listPayouts()[0].status).toBe('completed');
    expect(chain.broadcastCalls).toHaveLength(0);
    expect(chain.prepareCalls).toBe(1);
  });

  test('runtime fingerprint refuses a different binding on the same ledger', () => {
    const dir = tmp();
    const path = join(dir, 'db.sqlite');
    const cfg = config(dir);
    const a = createStore({ path, fingerprint: runtimeFingerprint(cfg) });
    a.close();
    const other = runtimeConfig({
      ...cfg,
      chain: { ...cfg.chain, contract: OTHER },
    });
    expect(() => createStore({ path, fingerprint: runtimeFingerprint(other) })).toThrow(
      /拒绝复用/,
    );
  });

  test('sanitizeError copies ServiceError and hides keys, tokens, and credential URLs', () => {
    expect(sanitizeError(new ServiceError(400, '可用收益不足。'))).toBe('可用收益不足。');
    const key = `0x${'11'.repeat(32)}`;
    expect(sanitizeError(new Error(`private key ${key}`))).toBe(PROVIDER_FAILURE);
    expect(sanitizeError(new Error(`Bearer ${'s'.repeat(40)}`))).toBe(PROVIDER_FAILURE);
    expect(
      sanitizeError(new Error('https://user:secret@127.0.0.1:8545/path?api_key=abcd')),
    ).toBe(PROVIDER_FAILURE);
    expect(PROVIDER_FAILURE).not.toContain(key);
  });
});
