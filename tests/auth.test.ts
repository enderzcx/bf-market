import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashSessionToken, LOGIN_FAILED } from "../src/auth.ts";
import {
  assertSupportedPasswordHash,
  CIRCLE_FUJI_USDC,
  loadConfig,
  parsePublicOrigin,
  runtimeConfig,
  runtimeFingerprint,
  type RuntimeConfig,
} from "../src/config.ts";
import { createApp, type SettlementApp } from "../src/server.ts";
import { createSource } from "../src/source.ts";
import { createStore } from "../src/store.ts";
import {
  type Chain,
  type Payout,
  type Prepared,
  type Source,
  type SourceOrder,
} from "../src/types.ts";
import { createWorker } from "../src/worker.ts";

const TOKEN = "0x0000000000000000000000000000000000000001" as const;
const CONTRACT = "0x0000000000000000000000000000000000000002" as const;
const RECIPIENT = "0x0000000000000000000000000000000000000003" as const;
const KEY = `0x${"1".padStart(64, "0")}` as Hex;
const PUBLIC_ORIGIN = "https://demo.example.test";
const PUBLIC_HOST = "demo.example.test";
const MERCHANT_PASSWORD = "merchant-test-pass-a1";
const PROMOTER_PASSWORD = "promoter-test-pass-b2";

class MockChain implements Chain {
  failBalances: string | null = null;
  nonce = 0n;
  async prepare(p: Payout): Promise<Prepared> {
    return {
      rawTransaction: keccak256(toHex(`raw:${p.id}:${this.nonce++}`)),
      hash: keccak256(toHex(`hash:${p.id}:${this.nonce}`)),
    };
  }
  async broadcast() {}
  async inspect() {
    return "confirmed" as const;
  }
  async balances() {
    if (this.failBalances) throw new Error(this.failBalances);
    return { token: "42", gas: "99" };
  }
}

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

let merchantHash = "";
let promoterHash = "";
let bcryptPromoterHash = "";

beforeAll(async () => {
  merchantHash = await Bun.password.hash(MERCHANT_PASSWORD, "argon2id");
  promoterHash = await Bun.password.hash(PROMOTER_PASSWORD, "argon2id");
  bcryptPromoterHash = await Bun.password.hash(PROMOTER_PASSWORD, {
    algorithm: "bcrypt",
  });
});

function mockOrderSource(): Source & { orders: Map<string, SourceOrder> } {
  const orders = new Map<string, SourceOrder>();
  return {
    kind: "beefapi",
    orders,
    async pull() {
      return [];
    },
    async complete() {},
    async balances() {
      return {
        available: "1000000",
        pending: "0",
        paid: "0",
        consumed: "0",
        commissionRate: "0.1",
        commissionRateSource: "default",
      };
    },
    async listOrders() {
      return [...orders.values()];
    },
    async createOrder(input) {
      const order: SourceOrder = {
        requestId: input.requestId,
        tradeNo: "T-" + input.requestId.slice(0, 8),
        paymentAmountMinor: input.paymentAmountMinor,
        commissionRate: "0.1",
        commissionUsdc: "0",
        status: "pending",
      };
      orders.set(order.requestId, order);
      return order;
    },
    async payOrder(requestId) {
      const current = orders.get(requestId);
      if (!current) throw new Error("missing order");
      const paid = { ...current, status: "paid" as const, commissionUsdc: "1000000" };
      orders.set(requestId, paid);
      return paid;
    },
    async reserveFrozen() {
      return {
        sourceId: "beefapi:reserved",
        recipient: RECIPIENT,
        amount: 1_000_000n,
        createdAt: Date.now(),
        alreadyFrozen: true,
      };
    },
  };
}

function harness(
  extra: Partial<RuntimeConfig> = {},
  source?: Source,
) {
  const dir = mkdtempSync(join(tmpdir(), "settlement-auth-"));
  const publicDir = join(dir, "public");
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "index.html"), "<html><body>ok</body></html>");
  writeFileSync(join(publicDir, "app.js"), "window.__settlement=1;");
  writeFileSync(join(publicDir, "style.css"), "body{margin:0}");
  let t = 1_700_000_000_000;
  const now = () => t;
  const chain = new MockChain();
  const config = runtimeConfig({
    port: 4311,
    chain: extra.chain ?? {
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contract: CONTRACT,
      token: TOKEN,
      privateKey: KEY,
      recipient: RECIPIENT,
    },
    publicDir,
    dbPath: join(dir, "db.sqlite"),
    lockPath: join(dir, "lock"),
    minAmount: 1_000_000n,
    maturityMs: 0,
    source: extra.source ?? "fixture",
    beefapiBaseUrl: extra.beefapiBaseUrl ?? "http://127.0.0.1:9",
    beefapiToken: extra.beefapiToken ?? "t".repeat(32),
    partnerUserId: extra.partnerUserId ?? 1,
    authEnabled: extra.authEnabled ?? true,
    merchantPasswordHash: extra.merchantPasswordHash ?? merchantHash,
    promoterPasswordHash: extra.promoterPasswordHash ?? promoterHash,
    ...extra,
  });
  const store = createStore({
    path: join(dir, "db.sqlite"),
    now,
    fingerprint: runtimeFingerprint(config),
  });
  closers.push(() => store.close());
  const src = source ?? createSource(store, config);
  const worker = createWorker({ store, chain, source: src, config, now });
  const app = createApp({
    store,
    worker,
    chain,
    source: src,
    config,
    publicDir,
    now,
  });
  return {
    app,
    store,
    chain,
    config,
    now,
    dir,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function publicHarness(source?: Source) {
  return harness(
    {
      source: "beefapi",
      orderDemo: true,
      publicOrigin: PUBLIC_ORIGIN,
      chain: {
        rpcUrl: "https://example.invalid",
        chainId: 43113,
        contract: CONTRACT,
        token: CIRCLE_FUJI_USDC,
        privateKey: KEY,
      },
    },
    source ?? mockOrderSource(),
  );
}

function hostOf(app: SettlementApp) {
  return new URL(app.origin).host;
}

function cookieSid(res: Response) {
  return /(?:^|;\s*)sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
}

function req(
  app: SettlementApp,
  path: string,
  init: RequestInit & {
    sid?: string;
    origin?: string | null;
    host?: string;
  } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("Host", init.host ?? hostOf(app));
  if (init.sid) headers.set("Cookie", `sid=${init.sid}`);
  if (init.origin !== null && (init.method === "POST" || init.origin)) {
    headers.set("Origin", init.origin ?? app.origin);
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return app.fetch(new Request(`${app.origin}${path}`, { ...init, headers }));
}

async function login(
  app: SettlementApp,
  username: string,
  password: string,
  extra: { origin?: string | null; host?: string; sid?: string } = {},
) {
  const res = await req(app, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
    ...extra,
  });
  return { res, sid: cookieSid(res), body: await res.json() };
}

test("auth hashes must be supported, distinct, and required when enabled", async () => {
  expect(() => assertSupportedPasswordHash("password", "x")).toThrow(/哈希/);
  expect(() => assertSupportedPasswordHash("$2b$10$short", "x")).toThrow(/哈希/);
  expect(assertSupportedPasswordHash(merchantHash, "x")).toBe(merchantHash);
  expect(assertSupportedPasswordHash(bcryptPromoterHash, "x")).toBe(
    bcryptPromoterHash,
  );
  expect(() =>
    runtimeConfig({
      chain: {
        rpcUrl: "http://127.0.0.1:8545",
        chainId: 31337,
        contract: CONTRACT,
        token: TOKEN,
        privateKey: KEY,
      },
      authEnabled: true,
    }),
  ).toThrow(/哈希/);
  expect(() =>
    runtimeConfig({
      chain: {
        rpcUrl: "http://127.0.0.1:8545",
        chainId: 31337,
        contract: CONTRACT,
        token: TOKEN,
        privateKey: KEY,
      },
      authEnabled: true,
      merchantPasswordHash: merchantHash,
      promoterPasswordHash: merchantHash,
    }),
  ).toThrow(/不同的凭据/);
  const ok = runtimeConfig({
    chain: {
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contract: CONTRACT,
      token: TOKEN,
      privateKey: KEY,
    },
    authEnabled: true,
    merchantPasswordHash: merchantHash,
    promoterPasswordHash: bcryptPromoterHash,
  });
  expect(ok.authEnabled).toBe(true);
  expect(await Bun.password.verify(MERCHANT_PASSWORD, ok.merchantPasswordHash)).toBe(
    true,
  );
  expect(await Bun.password.verify(PROMOTER_PASSWORD, ok.promoterPasswordHash)).toBe(
    true,
  );
});

test("public origin rejects insecure combinations", () => {
  expect(() => parsePublicOrigin("http://demo.example.test")).toThrow(/HTTPS/);
  expect(() => parsePublicOrigin("https://demo.example.test/app")).toThrow(
    /来源/,
  );
  expect(() => parsePublicOrigin("https://demo.example.test?q=1")).toThrow(
    /来源/,
  );
  expect(() => parsePublicOrigin("https://user:pass@demo.example.test")).toThrow(
    /来源/,
  );
  const chain = {
    rpcUrl: "https://example.invalid",
    chainId: 43113 as const,
    contract: CONTRACT,
    token: CIRCLE_FUJI_USDC,
    privateKey: KEY,
  };
  expect(() =>
    runtimeConfig({
      chain,
      publicOrigin: PUBLIC_ORIGIN,
      authEnabled: false,
    }),
  ).toThrow(/认证/);
  expect(() =>
    runtimeConfig({
      chain: { ...chain, chainId: 31337, token: TOKEN, rpcUrl: "http://127.0.0.1:8545" },
      authEnabled: true,
      publicOrigin: PUBLIC_ORIGIN,
      merchantPasswordHash: merchantHash,
      promoterPasswordHash: promoterHash,
      source: "beefapi",
      orderDemo: true,
      beefapiBaseUrl: "http://127.0.0.1:9",
      beefapiToken: "t".repeat(32),
    }),
  ).toThrow(/Fuji/);
  expect(() =>
    runtimeConfig({
      chain,
      authEnabled: true,
      publicOrigin: PUBLIC_ORIGIN,
      merchantPasswordHash: merchantHash,
      promoterPasswordHash: promoterHash,
      source: "fixture",
      orderDemo: false,
    }),
  ).toThrow(/订单演示/);
});

test("loadConfig auth flags come from env, not default passwords", () => {
  const dir = mkdtempSync(join(tmpdir(), "settlement-auth-cfg-"));
  writeFileSync(
    join(dir, "chain.json"),
    JSON.stringify({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contract: CONTRACT,
      token: TOKEN,
      privateKey: KEY,
    }),
  );
  const off = loadConfig({
    cwd: dir,
    env: { SETTLEMENT_CHAIN_CONFIG: join(dir, "chain.json") },
  });
  expect(off.authEnabled).toBe(false);
  expect(off.publicOrigin).toBeNull();
  expect(() =>
    loadConfig({
      cwd: dir,
      env: {
        SETTLEMENT_CHAIN_CONFIG: join(dir, "chain.json"),
        SETTLEMENT_AUTH_ENABLED: "true",
      },
    }),
  ).toThrow(/哈希/);
  const on = loadConfig({
    cwd: dir,
    env: {
      SETTLEMENT_CHAIN_CONFIG: join(dir, "chain.json"),
      SETTLEMENT_AUTH_ENABLED: "true",
      SETTLEMENT_MERCHANT_PASSWORD_HASH: merchantHash,
      SETTLEMENT_PROMOTER_PASSWORD_HASH: promoterHash,
    },
  });
  expect(on.authEnabled).toBe(true);
});

test("login denial is generic and does not leak usernames", async () => {
  const { app } = harness();
  const home = await req(app, "/");
  expect(home.status).toBe(200);
  expect(home.headers.get("set-cookie")).toBeNull();
  const session = await (await req(app, "/api/auth/session")).json();
  expect(session).toEqual({
    authenticated: false,
    role: null,
    authEnabled: true,
  });
  expect((await req(app, "/api/state")).status).toBe(401);
  const missing = await login(app, "", "");
  expect(missing.res.status).toBe(400);
  expect(missing.body.error).toBe("请填写账号和密码。");
  const unknown = await login(app, "admin", "nope");
  const wrong = await login(app, "merchant", "nope");
  expect(unknown.res.status).toBe(401);
  expect(wrong.res.status).toBe(401);
  expect(unknown.body.error).toBe(LOGIN_FAILED);
  expect(wrong.body.error).toBe(LOGIN_FAILED);
  expect(unknown.body.error).toBe(wrong.body.error);
  expect(JSON.stringify(unknown.body)).not.toContain("merchant");
  expect(JSON.stringify(wrong.body)).not.toContain(merchantHash);
});

test("valid login verifies hash, sets hashed session, and isolates legacy cookies", async () => {
  const { app, store } = harness();
  const legacy = store.createSession();
  expect(
    (await req(app, "/api/state", { sid: legacy })).status,
  ).toBe(401);
  const planted = await login(app, "merchant", MERCHANT_PASSWORD, {
    sid: legacy,
  });
  expect(planted.res.status).toBe(200);
  expect(planted.body).toEqual({ ok: true, role: "merchant" });
  expect(planted.sid).toBeTruthy();
  expect(planted.sid).not.toBe(legacy);
  const cookie = planted.res.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).not.toContain("Secure");
  expect(cookie).toContain("Max-Age=28800");
  expect(store.hasSession(planted.sid!)).toBe(false);
  expect(store.getAuthSession(planted.sid!)).toBeNull();
  expect(store.getAuthSession(hashSessionToken(planted.sid!))?.role).toBe(
    "merchant",
  );
  const authed = await (
    await req(app, "/api/auth/session", { sid: planted.sid })
  ).json();
  expect(authed).toEqual({
    authenticated: true,
    role: "merchant",
    authEnabled: true,
  });
  const state = await req(app, "/api/state", { sid: planted.sid });
  expect(state.status).toBe(200);
  const body = await state.json();
  expect(body.role).toBe("merchant");
  expect(body.authEnabled).toBe(true);
  expect(JSON.stringify(body)).not.toContain(merchantHash);
  expect(JSON.stringify(body)).not.toContain(promoterHash);
  expect(
    (await req(app, "/api/state", { sid: legacy })).status,
  ).toBe(401);
});

test("logout, expiry, and password rotation invalidate sessions", async () => {
  const first = harness();
  const merchant = await login(first.app, "merchant", MERCHANT_PASSWORD);
  expect(
    (await req(first.app, "/api/state", { sid: merchant.sid })).status,
  ).toBe(200);
  const out = await req(first.app, "/api/auth/logout", {
    method: "POST",
    body: "{}",
    sid: merchant.sid,
  });
  expect(out.status).toBe(200);
  expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    (await req(first.app, "/api/state", { sid: merchant.sid })).status,
  ).toBe(401);

  const timed = harness();
  const live = await login(timed.app, "promoter", PROMOTER_PASSWORD);
  timed.advance(8 * 60 * 60 * 1000 + 1);
  expect((await req(timed.app, "/api/state", { sid: live.sid })).status).toBe(
    401,
  );
  const session = await (
    await req(timed.app, "/api/auth/session", { sid: live.sid })
  ).json();
  expect(session.authenticated).toBe(false);

  const rotated = harness();
  const old = await login(rotated.app, "merchant", MERCHANT_PASSWORD);
  const nextHash = await Bun.password.hash("merchant-rotated-pass", "argon2id");
  const again = harness({
    merchantPasswordHash: nextHash,
    promoterPasswordHash: promoterHash,
  });
  const reused = createApp({
    store: rotated.store,
    worker: createWorker({
      store: rotated.store,
      chain: new MockChain(),
      source: createSource(rotated.store, again.config),
      config: again.config,
      now: rotated.now,
    }),
    chain: new MockChain(),
    source: createSource(rotated.store, again.config),
    config: again.config,
    publicDir: again.config.publicDir,
    now: rotated.now,
  });
  expect((await req(reused, "/api/state", { sid: old.sid })).status).toBe(401);
  const relogin = await login(reused, "merchant", "merchant-rotated-pass");
  expect(relogin.res.status).toBe(200);
});

test("session fixation cannot keep a pre-set cookie", async () => {
  const { app } = harness();
  const attacker = "attacker-fixed-id";
  const first = await login(app, "merchant", MERCHANT_PASSWORD, {
    sid: attacker,
  });
  expect(first.sid).toBeTruthy();
  expect(first.sid).not.toBe(attacker);
  expect((await req(app, "/api/state", { sid: attacker })).status).toBe(401);
  expect((await req(app, "/api/state", { sid: first.sid })).status).toBe(200);
  const second = await login(app, "promoter", PROMOTER_PASSWORD, {
    sid: first.sid,
  });
  expect(second.sid).not.toBe(first.sid);
  expect((await req(app, "/api/state", { sid: first.sid })).status).toBe(401);
  const state = await (await req(app, "/api/state", { sid: second.sid })).json();
  expect(state.role).toBe("promoter");
});

test("role permission matrix and promoter state projection", async () => {
  const source = mockOrderSource();
  const { app, store } = harness(
    { source: "beefapi", orderDemo: true },
    source,
  );
  const merchant = await login(app, "merchant", MERCHANT_PASSWORD);
  const promoter = await login(app, "promoter", PROMOTER_PASSWORD);
  const m = merchant.sid!;
  const p = promoter.sid!;

  expect(
    (
      await req(app, "/api/demo/commission", {
        sid: m,
        method: "POST",
        body: JSON.stringify({ amount: "1000000" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await req(app, "/api/demo/wallet", {
        sid: m,
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await req(app, "/api/partner/transfer", {
        sid: p,
        method: "POST",
        body: JSON.stringify({ amount: "1000000" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await req(app, "/api/partner/auto", {
        sid: p,
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      })
    ).status,
  ).toBe(403);

  const created = await req(app, "/api/demo/orders", {
    sid: m,
    method: "POST",
    body: "{}",
  });
  expect(created.status).toBe(200);
  expect(
    (
      await req(app, "/api/demo/orders", {
        sid: p,
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await req(app, "/api/admin/run", {
        sid: p,
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await req(app, "/api/admin/pause", {
        sid: p,
        method: "POST",
        body: JSON.stringify({ paused: true }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await req(app, "/api/admin/pause", {
        sid: m,
        method: "POST",
        body: JSON.stringify({ paused: true }),
      })
    ).status,
  ).toBe(200);

  const account = privateKeyToAccount(generatePrivateKey());
  expect(
    (
      await req(app, "/api/partner/wallet/challenge", {
        sid: m,
        method: "POST",
        body: JSON.stringify({ address: account.address }),
      })
    ).status,
  ).toBe(403);
  const challenge = await req(app, "/api/partner/wallet/challenge", {
    sid: p,
    method: "POST",
    body: JSON.stringify({ address: account.address }),
  });
  expect(challenge.status).toBe(200);
  expect(store.getChallenge(hashSessionToken(p!))).not.toBeNull();
  expect(store.getChallenge(p!)).toBeNull();
  const { message } = (await challenge.json()) as { message: string };
  expect(message.split("\n")[0]).toBe("Settlement wallet binding");
  expect(message).not.toContain("Purpose:");
  expect(message).toContain("Domain: http://127.0.0.1:4311");
  const signature = await account.signMessage({ message });
  expect(
    (
      await req(app, "/api/partner/wallet/verify", {
        sid: m,
        method: "POST",
        body: JSON.stringify({ address: account.address, signature }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await req(app, "/api/partner/wallet/verify", {
        sid: p,
        method: "POST",
        body: JSON.stringify({ address: account.address, signature }),
      })
    ).status,
  ).toBe(200);
  expect(store.getPartner().wallet).toBe(account.address);

  store.setPaused(true);
  const merchantState = await (await req(app, "/api/state", { sid: m })).json();
  const promoterState = await (await req(app, "/api/state", { sid: p })).json();
  expect(merchantState.wallet.token).toBe("42");
  expect(merchantState.paused).toBe(true);
  expect(Array.isArray(merchantState.orders)).toBe(true);
  expect(promoterState.wallet.token).toBe("");
  expect(promoterState.wallet.gas).toBe("");
  expect(promoterState.wallet.token).not.toBe("0");
  expect(promoterState.orders).toBeUndefined();
  expect(promoterState.paused).toBe(true);
  expect(promoterState.sourceError).toBeUndefined();
  expect(promoterState.partner.available).toBe("1000000");
  expect(promoterState.wallet).toEqual({ token: "", gas: "" });
});

test("canonical Host and Origin are required; forwarded headers are ignored", async () => {
  const { app } = publicHarness();
  expect((await req(app, "/api/auth/session")).status).toBe(403);
  expect(
    (await req(app, "/api/auth/session", { host: PUBLIC_HOST })).status,
  ).toBe(200);
  const spoofed = await req(app, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "merchant", password: MERCHANT_PASSWORD }),
    host: "evil.example",
    origin: PUBLIC_ORIGIN,
    headers: { "X-Forwarded-Host": PUBLIC_HOST, "X-Forwarded-Proto": "https" },
  });
  expect(spoofed.status).toBe(403);
  const wrongOrigin = await login(app, "merchant", MERCHANT_PASSWORD, {
    host: PUBLIC_HOST,
    origin: "https://evil.example",
  });
  expect(wrongOrigin.res.status).toBe(403);
  const missingOrigin = await login(app, "merchant", MERCHANT_PASSWORD, {
    host: PUBLIC_HOST,
    origin: null,
  });
  expect(missingOrigin.res.status).toBe(403);
  const ok = await login(app, "merchant", MERCHANT_PASSWORD, {
    host: PUBLIC_HOST,
    origin: PUBLIC_ORIGIN,
  });
  expect(ok.res.status).toBe(200);
  expect(ok.res.headers.get("set-cookie")).toContain("Secure");
  const loopbackState = await req(app, "/api/state", { sid: ok.sid });
  expect(loopbackState.status).toBe(403);
  const state = await req(app, "/api/state", {
    sid: ok.sid,
    host: PUBLIC_HOST,
  });
  expect(state.status).toBe(200);

  const promoter = await login(app, "promoter", PROMOTER_PASSWORD, {
    host: PUBLIC_HOST,
    origin: PUBLIC_ORIGIN,
  });
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await req(app, "/api/partner/wallet/challenge", {
    sid: promoter.sid,
    host: PUBLIC_HOST,
    origin: PUBLIC_ORIGIN,
    method: "POST",
    body: JSON.stringify({ address: account.address }),
  });
  expect(challenge.status).toBe(200);
  const { message } = (await challenge.json()) as { message: string };
  expect(message).toContain(`Domain: ${PUBLIC_ORIGIN}`);
  expect(message).not.toContain("127.0.0.1");
});

test("healthz is non-sensitive liveness and allows loopback under public origin", async () => {
  const { app, config } = publicHarness();
  const loopback = await req(app, "/healthz");
  expect(loopback.status).toBe(200);
  expect(await loopback.json()).toEqual({ ok: true });
  expect(loopback.headers.get("set-cookie")).toBeNull();
  const publicOk = await req(app, "/healthz", { host: PUBLIC_HOST });
  expect(publicOk.status).toBe(200);
  expect(JSON.stringify(await publicOk.json())).not.toContain(config.merchantPasswordHash);
  expect((await req(app, "/healthz", { host: "evil.example" })).status).toBe(
    403,
  );
});

test("bounded login limiter does not distinguish unknown accounts", async () => {
  const { app } = harness();
  for (let i = 0; i < 8; i++) {
    const res = await login(app, "merchant", "wrong");
    expect(res.res.status).toBe(401);
    expect(res.body.error).toBe(LOGIN_FAILED);
  }
  const locked = await login(app, "merchant", MERCHANT_PASSWORD);
  expect(locked.res.status).toBe(401);
  expect(locked.body.error).toBe(LOGIN_FAILED);
  for (let i = 0; i < 20; i++) {
    const res = await login(app, "nobody", "wrong");
    expect(res.body.error).toBe(LOGIN_FAILED);
  }
  const unknownLocked = await login(app, "nobody", "wrong");
  expect(unknownLocked.res.status).toBe(401);
  expect(unknownLocked.body.error).toBe(LOGIN_FAILED);
});


test("parallel password checks are bounded and unknown mutations deny by default", async () => {
  const {app} = harness();
  const batch = await Promise.all(Array.from({length:12},()=>login(app,"merchant",MERCHANT_PASSWORD)));
  expect(batch.filter(x=>x.res.status===429).length).toBeGreaterThan(0);
  expect(batch.filter(x=>x.res.status===200).length).toBeLessThanOrEqual(4);
  const valid = batch.find(x=>x.sid)!;
  expect((await req(app,"/api/future-mutation",{sid:valid.sid,method:"POST",body:"{}"})).status).toBe(403);
});
