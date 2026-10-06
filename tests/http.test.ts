import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CIRCLE_FUJI_USDC, runtimeConfig, runtimeFingerprint, type RuntimeConfig } from '../src/config.ts';
import { createApp, type SettlementApp } from '../src/server.ts';
import { createSource } from '../src/source.ts';
import { createStore } from '../src/store.ts';
import { type Chain, type Payout, type Prepared } from '../src/types.ts';
import { createWorker } from '../src/worker.ts';

const TOKEN = '0x0000000000000000000000000000000000000001' as const;
const CONTRACT = '0x0000000000000000000000000000000000000002' as const;
const RECIPIENT = '0x0000000000000000000000000000000000000003' as const;
const KEY = `0x${'1'.padStart(64, '0')}` as Hex;

class MockChain implements Chain {
  prepareCalls = 0;
  broadcastCalls: Hex[] = [];
  inspectResult: 'pending' | 'confirmed' | 'reverted' = 'confirmed';
  failBalances: string | null = null;
  nonce = 0n;
  async prepare(p: Payout): Promise<Prepared> {
    this.prepareCalls += 1;
    return {
      rawTransaction: keccak256(toHex(`raw:${p.id}:${this.nonce++}`)),
      hash: keccak256(toHex(`hash:${p.id}:${this.nonce}`)),
    };
  }
  async broadcast(raw: Hex) {
    this.broadcastCalls.push(raw);
  }
  async inspect() {
    return this.inspectResult;
  }
  async balances() {
    if (this.failBalances) throw new Error(this.failBalances);
    return { token: '42', gas: '99' };
  }
}

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

function harness(extra: Partial<RuntimeConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'settlement-http-'));
  const publicDir = join(dir, 'public');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'index.html'), '<html><body>ok</body></html>');
  writeFileSync(join(publicDir, 'app.js'), 'window.__settlement=1;');
  writeFileSync(join(publicDir, 'style.css'), 'body{margin:0}');
  let t = 1_700_000_000_000;
  const now = () => t;
  const chain = new MockChain();
  const config = runtimeConfig({
    port: 4311,
    chain: extra.chain ?? {
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: 31337,
      contract: CONTRACT,
      token: TOKEN,
      privateKey: KEY,
      recipient: RECIPIENT,
    },
    publicDir,
    dbPath: join(dir, 'db.sqlite'),
    lockPath: join(dir, 'lock'),
    minAmount: 1_000_000n,
    maturityMs: 0,
    source: extra.source ?? 'fixture',
    beefapiBaseUrl: extra.beefapiBaseUrl ?? '',
    beefapiToken: extra.beefapiToken ?? '',
    partnerUserId: extra.partnerUserId ?? 1,
    ...extra,
  });
  const store = createStore({
    path: join(dir, 'db.sqlite'),
    now,
    fingerprint: runtimeFingerprint(config),
  });
  closers.push(() => store.close());
  const source = createSource(store, config);
  const worker = createWorker({ store, chain, source, config, now });
  const app = createApp({ store, worker, chain, source, config, publicDir, now });
  return {
    app,
    store,
    chain,
    config,
    now,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function host(app: SettlementApp) {
  return new URL(app.origin).host;
}

async function open(app: SettlementApp) {
  const res = await app.fetch(
    new Request(`${app.origin}/`, { headers: { Host: host(app) } }),
  );
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  if (!sid) throw new Error('missing session cookie');
  return { res, sid };
}

function req(
  app: SettlementApp,
  path: string,
  init: RequestInit & { sid?: string; origin?: string | null; host?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set('Host', init.host ?? host(app));
  if (init.sid) headers.set('Cookie', `sid=${init.sid}`);
  if (init.origin !== null && (init.method === 'POST' || init.origin)) {
    headers.set('Origin', init.origin ?? app.origin);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return app.fetch(new Request(`${app.origin}${path}`, { ...init, headers }));
}

test('static allowlist, CSP, session cookie, and loopback host checks', async () => {
  const { app } = harness();
  const { res, sid } = await open(app);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(res.headers.get('content-security-policy')).not.toContain('unsafe-inline');
  expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  expect(res.headers.get('set-cookie')).toContain('SameSite=Strict');
  expect(await (await req(app, '/app.js', { sid })).text()).toContain('window.__settlement');
  expect((await req(app, '/style.css', { sid })).headers.get('content-type')).toContain('text/css');
  expect((await req(app, '/secret.js', { sid })).status).toBe(404);
  expect((await req(app, '/api/state', { host: 'evil.example' })).status).toBe(403);
  expect((await req(app, '/api/state')).status).toBe(401);
  const state = await req(app, '/api/state', { sid });
  expect(state.status).toBe(200);
  const body = await state.json();
  expect(body.source).toBe('fixture');
  expect(body.orderDemo).toBe(false);
  expect(body.orders).toBeUndefined();
  expect(body.minAmount).toBe('1000000');
  expect(body.wallet.token).toBe('42');
  expect(JSON.stringify(body)).not.toContain('rawTransaction');
  expect(JSON.stringify(body)).not.toContain(KEY);
});

test('React deep links and generated assets keep host, CSP and API boundaries', async () => {
  const { app, config } = harness();
  mkdirSync(join(config.publicDir, 'assets'));
  writeFileSync(join(config.publicDir, 'assets', 'index-abc123.js'), 'export const ready = true;');
  writeFileSync(join(config.publicDir, 'assets', 'index-abc123.css'), 'body{color:black}');
  const { sid } = await open(app);
  for (const route of ['/login', '/console/orders', '/console/settlements', '/console/wallet', '/docs']) {
    const response = await req(app, route, { sid });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
  }
  const asset = await req(app, '/assets/index-abc123.js', { sid });
  expect(asset.status).toBe(200);
  expect(asset.headers.get('content-type')).toContain('javascript');
  expect(await asset.text()).toContain('ready');
  expect((await req(app, '/assets/index-abc123.css', { sid })).headers.get('content-type')).toContain('text/css');
  expect((await req(app, '/assets/missing.js', { sid })).status).toBe(404);
  expect((await req(app, '/assets/index-abc123.js.map', { sid })).status).toBe(404);
  expect((await req(app, '/api/unknown', { sid })).headers.get('content-type')).toContain('application/json');
  expect((await req(app, '/assets/index-abc123.js', { host: 'evil.example' })).status).toBe(403);
});

test('mutations require same-origin JSON cookie; demo commission and run settle', async () => {
  const { app, store, chain } = harness();
  const { sid } = await open(app);
  expect(
    (await req(app, '/api/demo/commission', { sid, method: 'POST', body: '{"amount":"10000000"}', origin: null }))
      .status,
  ).toBe(403);
  expect(
    (
      await req(app, '/api/demo/commission', {
        sid,
        method: 'POST',
        body: '{"amount":"10000000"}',
        origin: 'http://example.com',
      })
    ).status,
  ).toBe(403);
  expect(
    (await req(app, '/api/demo/commission', { method: 'POST', body: '{"amount":"10000000"}' })).status,
  ).toBe(401);
  const added = await req(app, '/api/demo/commission', {
    sid,
    method: 'POST',
    body: JSON.stringify({ amount: '10000000' }),
  });
  expect(added.status).toBe(200);
  expect(store.getPartner().available).toBe(10_000_000n);
  const wallet = await req(app, '/api/demo/wallet', { sid, method: 'POST', body: '{}' });
  expect(wallet.status).toBe(200);
  const auto = await req(app, '/api/partner/auto', {
    sid,
    method: 'POST',
    body: JSON.stringify({ enabled: true }),
  });
  expect(auto.status).toBe(200);
  chain.inspectResult = 'confirmed';
  const run = await req(app, '/api/admin/run', { sid, method: 'POST', body: '{}' });
  expect(run.status).toBe(200);
  const state = await (await req(app, '/api/state', { sid })).json();
  expect(state.payouts[0].status).toBe('completed');
  expect(state.payouts[0].amount).toBe('10000000');
  expect(state.partner.paid).toBe('10000000');
  expect(state.partner.available).toBe('0');
});

test('wallet challenge rejects expired, replayed, and mismatched signatures', async () => {
  const { app, store, advance } = harness();
  const { sid } = await open(app);
  const account = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const challenged = await req(app, '/api/partner/wallet/challenge', {
    sid,
    method: 'POST',
    body: JSON.stringify({ address: account.address }),
  });
  expect(challenged.status).toBe(200);
  const { message } = (await challenged.json()) as { message: string };
  expect(message).toContain('Domain: http://127.0.0.1:4311');
  expect(message).toContain('User: demo-partner');
  expect(message).toContain('Chain ID: 31337');
  const signature = await account.signMessage({ message });
  const replayed = await other.signMessage({ message });
  expect(
    (
      await req(app, '/api/partner/wallet/verify', {
        sid,
        method: 'POST',
        body: JSON.stringify({ address: account.address, signature: replayed }),
      })
    ).status,
  ).toBe(400);
  const ok = await req(app, '/api/partner/wallet/verify', {
    sid,
    method: 'POST',
    body: JSON.stringify({ address: account.address, signature }),
  });
  expect(ok.status).toBe(200);
  expect(store.getPartner().wallet).toBe(account.address);
  expect(
    (
      await req(app, '/api/partner/wallet/verify', {
        sid,
        method: 'POST',
        body: JSON.stringify({ address: account.address, signature }),
      })
    ).status,
  ).toBe(409);
  const again = await req(app, '/api/partner/wallet/challenge', {
    sid,
    method: 'POST',
    body: JSON.stringify({ address: account.address }),
  });
  const second = (await again.json()) as { message: string };
  advance(5 * 60_000 + 1);
  const expiredSig = await account.signMessage({ message: second.message });
  expect(
    (
      await req(app, '/api/partner/wallet/verify', {
        sid,
        method: 'POST',
        body: JSON.stringify({ address: account.address, signature: expiredSig }),
      })
    ).status,
  ).toBe(400);
});

test('demo wallet is local-only; beefapi rejects fixture generation and transfer', async () => {
  const fuji = harness({
    chain: {
      rpcUrl: 'https://example.invalid',
      chainId: 43113,
      contract: CONTRACT,
      token: CIRCLE_FUJI_USDC,
      privateKey: KEY,
    },
  });
  const { sid } = await open(fuji.app);
  expect((await req(fuji.app, '/api/demo/wallet', { sid, method: 'POST', body: '{}' })).status).toBe(
    403,
  );

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return Response.json({ success: true, data: [] });
    },
  });
  closers.push(() => server.stop(true));
  const beef = harness({
    source: 'beefapi',
    beefapiBaseUrl: `http://127.0.0.1:${server.port}`,
    beefapiToken: 'x'.repeat(32),
    partnerUserId: 1,
  });
  const session = await open(beef.app);
  expect(
    (
      await req(beef.app, '/api/demo/commission', {
        sid: session.sid,
        method: 'POST',
        body: JSON.stringify({ amount: '10000000' }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await req(beef.app, '/api/partner/transfer', {
        sid: session.sid,
        method: 'POST',
        body: JSON.stringify({ amount: '1000000' }),
      })
    ).status,
  ).toBe(403);
  const state = await (await req(beef.app, '/api/state', { sid: session.sid })).json();
  expect(state.source).toBe('beefapi');
  expect(state.partner.available).toBe('');
  expect(state.partner.pending).toBe('');
  expect(state.partner.paid).toBe('');
  expect(state.partner.consumed).toBe('');
  expect(state.partner.available).not.toBe('0');
});

test('pause, transfer, oversized body, and admin run do not leak raw transactions', async () => {
  const { app, store, chain } = harness();
  const { sid } = await open(app);
  await req(app, '/api/demo/commission', {
    sid,
    method: 'POST',
    body: JSON.stringify({ amount: '1000000' }),
  });
  await req(app, '/api/partner/transfer', {
    sid,
    method: 'POST',
    body: JSON.stringify({ amount: '1000000' }),
  });
  expect(store.getPartner().consumed).toBe(1_000_000n);
  expect(store.getPartner().available).toBe(0n);
  await req(app, '/api/demo/commission', {
    sid,
    method: 'POST',
    body: JSON.stringify({ amount: '10000000' }),
  });
  await req(app, '/api/demo/wallet', { sid, method: 'POST', body: '{}' });
  chain.inspectResult = 'pending';
  await req(app, '/api/admin/run', { sid, method: 'POST', body: '{}' });
  const pending = await (await req(app, '/api/state', { sid })).json();
  expect(pending.payouts[0].status).toBe('broadcast');
  expect(pending.payouts[0].status).not.toBe('completed');
  expect(JSON.stringify(pending)).not.toContain('rawTransaction');
  await req(app, '/api/admin/pause', {
    sid,
    method: 'POST',
    body: JSON.stringify({ paused: true }),
  });
  await req(app, '/api/demo/commission', {
    sid,
    method: 'POST',
    body: JSON.stringify({ amount: '2000000' }),
  });
  await req(app, '/api/admin/run', { sid, method: 'POST', body: '{}' });
  expect(store.listPayouts()).toHaveLength(1);
  const huge = await req(app, '/api/demo/commission', {
    sid,
    method: 'POST',
    body: JSON.stringify({ amount: '1'.repeat(20_000) }),
  });
  expect(huge.status).toBe(413);
});

test('unsupported methods on public routes return an English 405', async () => {
  const { app } = harness();
  const unsupportedMethod = await req(app, '/api/stats', { method: 'PUT' });
  expect(unsupportedMethod.status).toBe(405);
  expect(await unsupportedMethod.json()).toEqual({ error: 'Method not allowed.' });
  const unknownGet = await req(app, '/api/stats');
  expect(unknownGet.status).toBe(405);
  expect(await unknownGet.json()).toEqual({ error: 'Method not allowed.' });
});

test('mutations require JSON content type; chain unreadiness is explicit', async () => {
  const { app, chain } = harness();
  const { sid } = await open(app);
  const headers = new Headers();
  headers.set('Host', host(app));
  headers.set('Cookie', `sid=${sid}`);
  headers.set('Origin', app.origin);
  const missingType = await app.fetch(
    new Request(`${app.origin}/api/admin/run`, { method: 'POST', headers, body: '{}' }),
  );
  expect(missingType.status).toBe(415);
  chain.failBalances = 'https://user:secret@127.0.0.1/rpc?api_key=abcd';
  const state = await (await req(app, '/api/state', { sid })).json();
  expect(state.network.configured).toBe(false);
  expect(state.network.error).toBeTruthy();
  expect(JSON.stringify(state)).not.toContain('secret');
  expect(JSON.stringify(state)).not.toContain('api_key');
  expect(state.wallet.token).toBe('');
  expect(state.wallet.gas).toBe('');
  expect(state.wallet.token).not.toBe('0');
});
