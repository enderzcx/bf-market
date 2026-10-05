import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ganache from "ganache";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  toHex,
  type Address,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compileErc8004, deploymentSteps } from "../scripts/erc8004-artifacts.ts";
import {
  createRpcAgentRegistryChain,
  identityRegistryAbi,
  type AgentRegistryChain,
} from "../src/agent-registry.ts";
import { challengeMessage } from "../src/auth.ts";
import { runtimeConfig, runtimeFingerprint } from "../src/config.ts";
import { createApp, type SettlementApp } from "../src/server.ts";
import { createSource } from "../src/source.ts";
import { createStore } from "../src/store.ts";
import type { StarterGasChain } from "../src/starter-gas.ts";
import { type Chain, type Payout, type Prepared } from "../src/types.ts";
import { createWorker } from "../src/worker.ts";

const LOCAL_KEY = `0x${"1".padStart(64, "0")}` as Hex;
const OTHER_KEY = `0x${"2".padStart(64, "0")}` as Hex;
const OPS_KEY = `0x${"3".padStart(64, "0")}` as Hex;
const AGENT_KEY = `0x${"4".padStart(64, "0")}` as Hex;
const TOKEN = "0x0000000000000000000000000000000000000001" as Address;
const CONTRACT = "0x0000000000000000000000000000000000000002" as Address;
const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

const bundle = compileErc8004();

class MockPayoutChain implements Chain {
  async prepare(p: Payout): Promise<Prepared> {
    return {
      rawTransaction: keccak256(toHex(`raw:${p.id}`)),
      hash: keccak256(toHex(`hash:${p.id}`)),
    };
  }
  async broadcast() {}
  async inspect() {
    return "confirmed" as const;
  }
  async balances() {
    return { token: "0", gas: "0" };
  }
}

class MockStarterGasChain implements StarterGasChain {
  balance = 0n;
  signed: Array<{ to: Address; amountWei: bigint }> = [];
  broadcasts: Hex[] = [];
  failBroadcast = false;
  inspectResult: "pending" | "confirmed" | "reverted" = "confirmed";
  async getChainId() {
    return 31337;
  }
  async getBalance() {
    return this.balance;
  }
  async signTransfer(input: { to: Address; amountWei: bigint }) {
    this.signed.push(input);
    const tag = `${this.signed.length}:${input.to}`;
    return {
      rawTransaction: keccak256(toHex(`gas-raw:${tag}`)),
      hash: keccak256(toHex(`gas-hash:${tag}`)),
    };
  }
  async broadcast(raw: Hex) {
    this.broadcasts.push(raw);
    if (this.failBroadcast) throw new Error("uncertain broadcast");
  }
  async inspect() {
    return this.inspectResult;
  }
}

const closers: Array<() => void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

type ChainEnv = {
  url: string;
  proxy: Address;
  client: PublicClient;
  viemChain: ViemChain;
  server: { close(): Promise<void> };
};

async function startChain(): Promise<ChainEnv> {
  const server = ganache.server({
    chain: { chainId: 31337, hardfork: "shanghai" },
    wallet: {
      accounts: [LOCAL_KEY, OTHER_KEY, OPS_KEY, AGENT_KEY].map((secretKey) => ({
        secretKey,
        balance: "0x3635c9adc5dea00000",
      })),
    },
    logging: { quiet: true },
  });
  await server.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const viemChain = defineChain({
    id: 31337,
    name: "local only",
    nativeCurrency: { name: "Test", symbol: "TEST", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const client = createPublicClient({ chain: viemChain, transport: http(url), cacheTime: 0 });
  const deployer = privateKeyToAccount(LOCAL_KEY);
  const wallet = createWalletClient({ chain: viemChain, account: deployer, transport: http(url) });
  const steps = deploymentSteps(bundle, deployer.address);
  for (const step of steps) {
    const gas = ((await client.estimateGas({ account: deployer.address, data: step.data, value: 0n })) * 120n) / 100n;
    const receipt = await client.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({ to: step.to, data: step.data, nonce: step.nonce, value: 0n, gas }),
    });
    if (receipt.status !== "success") throw new Error("registry deployment failed");
  }
  closers.push(() => server.close());
  return { url, proxy: steps[1]!.address, client, viemChain, server };
}

function buildApp(
  env: ChainEnv,
  overrides: {
    identityRegistry?: Address | null;
    starterGasEnabled?: boolean;
    opsPrivateKey?: Hex;
    starterGasWei?: bigint;
    starterGasDailyCapWei?: bigint;
    starterGasBalanceThresholdWei?: bigint;
    starterGasChain?: StarterGasChain;
    registryChain?: AgentRegistryChain;
    now?: () => number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "settlement-agent-"));
  const publicDir = join(dir, "public");
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "index.html"), "<html></html>");
  const identityRegistry =
    overrides.identityRegistry === undefined ? env.proxy : overrides.identityRegistry;
  const config = runtimeConfig({
    port: 4311,
    chain: {
      rpcUrl: env.url,
      chainId: 31337,
      contract: CONTRACT,
      token: TOKEN,
      privateKey: LOCAL_KEY,
    },
    publicDir,
    dbPath: join(dir, "db.sqlite"),
    lockPath: join(dir, "lock"),
    minAmount: 1_000_000n,
    maturityMs: 0,
    source: "fixture",
    identityRegistry: identityRegistry ?? undefined,
    starterGasEnabled: overrides.starterGasEnabled ?? false,
    starterGasWei: overrides.starterGasWei,
    starterGasDailyCapWei: overrides.starterGasDailyCapWei,
    starterGasBalanceThresholdWei: overrides.starterGasBalanceThresholdWei,
    opsPrivateKey: overrides.opsPrivateKey,
  });
  const store = createStore({
    path: join(dir, "db.sqlite"),
    now: overrides.now,
    fingerprint: runtimeFingerprint(config),
  });
  closers.push(() => store.close());
  const chain = new MockPayoutChain();
  const source = createSource(store, config);
  const worker = createWorker({ store, chain, source, config, now: overrides.now });
  const starterGasChain =
    overrides.starterGasChain ??
    (overrides.starterGasEnabled ? new MockStarterGasChain() : undefined);
  const app = createApp({
    store,
    worker,
    chain,
    source,
    config,
    publicDir,
    now: overrides.now,
    agentRegistryChain:
      overrides.registryChain ??
      createRpcAgentRegistryChain({ rpcUrl: env.url, chainId: 31337, registry: env.proxy }),
    starterGasChain,
  });
  return { app, store, config, starterGasChain: starterGasChain as MockStarterGasChain | undefined };
}

function req(
  app: SettlementApp,
  path: string,
  init: RequestInit & { host?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("Host", init.host ?? new URL(app.origin).host);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return app.fetch(new Request(`${app.origin}${path}`, { ...init, headers }));
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const PROFILE = {
  name: "Demo Agent",
  description: "M3 test agent",
  services: [{ name: "web", endpoint: "http://127.0.0.1:4311/" }],
  x402Support: true,
  active: true,
};

async function challengeAndSign(
  app: SettlementApp,
  account: ReturnType<typeof privateKeyToAccount>,
  purpose?: string,
) {
  const res = await req(app, "/api/agents/challenge", {
    method: "POST",
    body: JSON.stringify({ address: account.address, ...(purpose ? { purpose } : {}) }),
  });
  expect(res.status).toBe(200);
  const body = await jsonOf<{ message: string }>(res);
  const signature = await account.signMessage({ message: body.message });
  return { message: body.message, signature };
}

async function createDraft(
  app: SettlementApp,
  account: ReturnType<typeof privateKeyToAccount>,
  role = "provider",
) {
  const { signature } = await challengeAndSign(app, account);
  const res = await req(app, "/api/agents/drafts", {
    method: "POST",
    body: JSON.stringify({ address: account.address, signature, role, profile: PROFILE }),
  });
  return res;
}

async function sendRegister(
  env: ChainEnv,
  account: ReturnType<typeof privateKeyToAccount>,
  agentURI: string,
): Promise<Hex> {
  const wallet = createWalletClient({ chain: env.viemChain, account, transport: http(env.url) });
  const gas = ((await env.client.estimateContractGas({
    address: env.proxy,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [agentURI],
    account: account.address,
  })) * 120n) / 100n;
  const hash = await wallet.writeContract({
    address: env.proxy,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [agentURI],
    gas,
  });
  await env.client.waitForTransactionReceipt({ hash });
  return hash;
}

test("full registration flow accepts agentId 0 and serves the document", async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);

  const draftRes = await createDraft(app, agent, "provider");
  expect(draftRes.status).toBe(200);
  const draft = await jsonOf<{
    draftId: string;
    agentURI: string;
    registerTx: { chainId: number; to: Address; data: Hex; value: string };
  }>(draftRes);
  expect(draft.agentURI).toBe(`${app.origin}/registrations/${draft.draftId}.json`);
  expect(draft.registerTx.chainId).toBe(31337);
  expect(draft.registerTx.to.toLowerCase()).toBe(env.proxy.toLowerCase());
  expect(draft.registerTx.value).toBe("0");
  expect(draft.registerTx.data.slice(0, 10)).toBe("0xf2c298be");

  const before = await jsonOf<{ type: string; registrations: unknown[] }>(
    await req(app, `/registrations/${draft.draftId}.json`),
  );
  expect(before.type).toBe(REGISTRATION_TYPE);
  expect(before.registrations).toEqual([]);

  const hash = await sendRegister(env, agent, draft.agentURI);
  const confirmRes = await req(app, "/api/agents/confirm", {
    method: "POST",
    body: JSON.stringify({ txHash: hash }),
  });
  expect(confirmRes.status).toBe(200);
  const confirmed = await jsonOf<{ status: string; agent: { agentId: string; owner: string; listed: string } }>(
    confirmRes,
  );
  expect(confirmed.status).toBe("confirmed");
  expect(confirmed.agent.agentId).toBe("0");
  expect(confirmed.agent.owner.toLowerCase()).toBe(agent.address.toLowerCase());
  expect(confirmed.agent.listed).toBe("pending");

  const after = await jsonOf<{ registrations: Array<{ agentId: string; agentRegistry: string }> }>(
    await req(app, `/registrations/${draft.draftId}.json`),
  );
  expect(after.registrations).toEqual([
    { agentId: "0", agentRegistry: `eip155:31337:${getAddress(env.proxy)}` },
  ]);

  const record = await jsonOf<{ agent: { agentId: string } }>(await req(app, "/api/agents/0"));
  expect(record.agent.agentId).toBe("0");

  const list = await jsonOf<{ agents: unknown[] }>(await req(app, "/api/agents?role=provider"));
  expect(list.agents).toHaveLength(1);

  // Repeated confirmation is idempotent.
  const again = await req(app, "/api/agents/confirm", {
    method: "POST",
    body: JSON.stringify({ txHash: hash }),
  });
  expect(again.status).toBe(200);
  const againBody = await jsonOf<{ agent: { agentId: string } }>(again);
  expect(againBody.agent.agentId).toBe("0");
  const listAfter = await jsonOf<{ agents: unknown[] }>(await req(app, "/api/agents"));
  expect(listAfter.agents).toHaveLength(1);
});

test("draft rejects a wrong signature, an expired challenge, and a cross-purpose replay", async () => {
  const env = await startChain();
  let t = 1_700_000_000_000;
  const { app } = buildApp(env, { now: () => t });
  const agent = privateKeyToAccount(AGENT_KEY);
  const other = privateKeyToAccount(OTHER_KEY);

  // Wrong signature: recovered address does not match.
  const { message } = await challengeAndSign(app, agent);
  const wrongSignature = await other.signMessage({ message });
  const bad = await req(app, "/api/agents/drafts", {
    method: "POST",
    body: JSON.stringify({ address: agent.address, signature: wrongSignature, role: "provider", profile: PROFILE }),
  });
  expect(bad.status).toBe(400);

  // Expired challenge.
  const expired = await challengeAndSign(app, agent);
  t += 5 * 60_000 + 1;
  const stale = await req(app, "/api/agents/drafts", {
    method: "POST",
    body: JSON.stringify({ address: agent.address, signature: expired.signature, role: "provider", profile: PROFILE }),
  });
  expect(stale.status).toBe(400);
  t -= 5 * 60_000 + 1;

  // Cross-purpose replay: a starter-gas challenge cannot create a draft.
  const gasChallenge = await challengeAndSign(app, agent, "starter-gas");
  const crossed = await req(app, "/api/agents/drafts", {
    method: "POST",
    body: JSON.stringify({ address: agent.address, signature: gasChallenge.signature, role: "provider", profile: PROFILE }),
  });
  expect(crossed.status).toBe(400);
});

test("challenges carry a purpose-specific title and reject cross-purpose signatures", async () => {
  const env = await startChain();
  const { app } = buildApp(env, {
    starterGasEnabled: true,
    opsPrivateKey: OPS_KEY,
    starterGasWei: 10n ** 18n,
    starterGasDailyCapWei: 5n * 10n ** 18n,
    starterGasBalanceThresholdWei: 10n ** 18n,
  });
  const agent = privateKeyToAccount(AGENT_KEY);

  const draft = await challengeAndSign(app, agent);
  expect(draft.message.split("\n")[0]).toBe("BF Market agent registration");
  expect(draft.message).toContain("Purpose: agent-draft");

  const gas = await challengeAndSign(app, agent, "starter-gas");
  expect(gas.message.split("\n")[0]).toBe("BF Market starter gas request");
  expect(gas.message).toContain("Purpose: starter-gas");

  // The console wallet-binding challenge keeps its original title and format.
  const binding = challengeMessage({
    domain: app.origin,
    userId: "demo-partner",
    address: agent.address,
    nonce: "0xabc",
    chainId: 31337,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
  });
  expect(binding.split("\n")[0]).toBe("Settlement wallet binding");
  expect(binding).not.toContain("Purpose:");

  // Each signature is rejected by the other flow even though a challenge for
  // that address exists in both flows.
  const draftOnGas = await req(app, "/api/agents/starter-gas", {
    method: "POST",
    body: JSON.stringify({ address: agent.address, signature: draft.signature }),
  });
  expect(draftOnGas.status).toBe(400);
  const gasOnDraft = await req(app, "/api/agents/drafts", {
    method: "POST",
    body: JSON.stringify({
      address: agent.address,
      signature: gas.signature,
      role: "provider",
      profile: PROFILE,
    }),
  });
  expect(gasOnDraft.status).toBe(400);
});

test("open drafts per address are capped", async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  for (let i = 0; i < 5; i += 1) {
    expect((await createDraft(app, agent)).status).toBe(200);
  }
  expect((await createDraft(app, agent)).status).toBe(429);
});

test("confirm rejects a failed transaction, a non-registry transaction, an unknown URI, and an owner mismatch", async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  const other = privateKeyToAccount(OTHER_KEY);
  const wallet = createWalletClient({ chain: env.viemChain, account: agent, transport: http(env.url) });

  // Failed transaction (reverts on the registry).
  const failed = await wallet.sendTransaction({ to: env.proxy, data: "0xdeadbeef", gas: 100000n });
  await env.client.waitForTransactionReceipt({ hash: failed });
  expect((await req(app, "/api/agents/confirm", { method: "POST", body: JSON.stringify({ txHash: failed }) })).status).toBe(400);

  // Transaction to a non-registry address.
  const stray = await wallet.sendTransaction({ to: other.address, value: 1n, gas: 21000n });
  await env.client.waitForTransactionReceipt({ hash: stray });
  expect((await req(app, "/api/agents/confirm", { method: "POST", body: JSON.stringify({ txHash: stray }) })).status).toBe(400);

  // URI that matches no draft.
  const unknownUri = `${app.origin}/registrations/${"0".repeat(32)}.json`;
  const unknownHash = await sendRegister(env, agent, unknownUri);
  expect((await req(app, "/api/agents/confirm", { method: "POST", body: JSON.stringify({ txHash: unknownHash }) })).status).toBe(400);

  // Event owner differs from the draft address.
  const draftRes = await createDraft(app, agent);
  const draft = await jsonOf<{ agentURI: string }>(draftRes);
  const otherWallet = createWalletClient({ chain: env.viemChain, account: other, transport: http(env.url) });
  const gas = ((await env.client.estimateContractGas({
    address: env.proxy,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [draft.agentURI],
    account: other.address,
  })) * 120n) / 100n;
  const ownerMismatch = await otherWallet.writeContract({
    address: env.proxy,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [draft.agentURI],
    gas,
  });
  await env.client.waitForTransactionReceipt({ hash: ownerMismatch });
  expect((await req(app, "/api/agents/confirm", { method: "POST", body: JSON.stringify({ txHash: ownerMismatch }) })).status).toBe(400);
});

test("confirm returns 202 pending until the receipt is final", async () => {
  const env = await startChain();
  const pendingChain: AgentRegistryChain = {
    async getChainId() {
      return 31337;
    },
    async getFinalizedReceipt() {
      return null;
    },
    async readOwnerOf(): Promise<Address> {
      throw new Error("unreachable");
    },
    async readAgentWallet(): Promise<Address> {
      throw new Error("unreachable");
    },
  };
  const { app } = buildApp(env, { registryChain: pendingChain });
  const res = await req(app, "/api/agents/confirm", {
    method: "POST",
    body: JSON.stringify({ txHash: `0x${"ab".repeat(32)}` }),
  });
  expect(res.status).toBe(202);
  expect((await jsonOf<{ status: string }>(res)).status).toBe("pending");
});

test("a network without an identity registry fails closed", async () => {
  const env = await startChain();
  const { app } = buildApp(env, { identityRegistry: null });
  const agent = privateKeyToAccount(AGENT_KEY);
  const res = await req(app, "/api/agents/challenge", {
    method: "POST",
    body: JSON.stringify({ address: agent.address }),
  });
  expect(res.status).toBe(503);
  const list = await req(app, "/api/agents");
  expect(list.status).toBe(503);
});

test("starter gas is disabled by default", async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  const { signature } = await challengeAndSign(app, agent, "starter-gas");
  const res = await req(app, "/api/agents/starter-gas", {
    method: "POST",
    body: JSON.stringify({ address: agent.address, signature }),
  });
  expect(res.status).toBe(403);
});

test("starter gas refuses to enable without every configured value", () => {
  const env = { url: "http://127.0.0.1:8545" };
  const base = {
    port: 4311,
    chain: {
      rpcUrl: env.url,
      chainId: 31337,
      contract: CONTRACT,
      token: TOKEN,
      privateKey: LOCAL_KEY,
    },
    identityRegistry: "0x0000000000000000000000000000000000000009" as Address,
    starterGasEnabled: true,
  };
  expect(() =>
    runtimeConfig({ ...base, starterGasWei: 1n, starterGasDailyCapWei: 2n, starterGasBalanceThresholdWei: 1n }),
  ).toThrow(/SETTLEMENT_OPS_PRIVATE_KEY/);
  expect(() =>
    runtimeConfig({ ...base, opsPrivateKey: OPS_KEY, starterGasDailyCapWei: 2n, starterGasBalanceThresholdWei: 1n }),
  ).toThrow(/SETTLEMENT_STARTER_GAS_WEI/);
  expect(() =>
    runtimeConfig({
      ...base,
      opsPrivateKey: OPS_KEY,
      starterGasWei: 1n,
      starterGasDailyCapWei: 2n,
      starterGasBalanceThresholdWei: 1n,
      identityRegistry: undefined,
    }),
  ).toThrow(/身份注册表/);
});

test("starter gas is granted once per address and only below the balance threshold", async () => {
  const env = await startChain();
  const { app, starterGasChain } = buildApp(env, {
    starterGasEnabled: true,
    opsPrivateKey: OPS_KEY,
    starterGasWei: 10n ** 18n,
    starterGasDailyCapWei: 5n * 10n ** 18n,
    starterGasBalanceThresholdWei: 10n ** 18n,
  });
  const mock = starterGasChain!;
  const agent = privateKeyToAccount(AGENT_KEY);

  const { signature } = await challengeAndSign(app, agent, "starter-gas");
  const res = await req(app, "/api/agents/starter-gas", {
    method: "POST",
    body: JSON.stringify({ address: agent.address, signature }),
  });
  expect(res.status).toBe(200);
  expect((await jsonOf<{ status: string }>(res)).status).toBe("confirmed");
  expect(mock.signed).toHaveLength(1);
  expect(mock.broadcasts).toHaveLength(1);

  // Second attempt is idempotent: no new signature or broadcast.
  const second = await challengeAndSign(app, agent, "starter-gas");
  const again = await req(app, "/api/agents/starter-gas", {
    method: "POST",
    body: JSON.stringify({ address: agent.address, signature: second.signature }),
  });
  expect(again.status).toBe(200);
  expect(mock.signed).toHaveLength(1);
  expect(mock.broadcasts).toHaveLength(1);

  // A funded address is refused without signing.
  const funded = privateKeyToAccount(OTHER_KEY);
  mock.balance = 10n ** 18n;
  const fundedChallenge = await challengeAndSign(app, funded, "starter-gas");
  const refused = await req(app, "/api/agents/starter-gas", {
    method: "POST",
    body: JSON.stringify({ address: funded.address, signature: fundedChallenge.signature }),
  });
  expect(refused.status).toBe(409);
  expect(mock.signed).toHaveLength(1);
});

test("starter gas enforces the daily cap and replays the same transaction on an uncertain broadcast", async () => {
  const env = await startChain();
  const { app, starterGasChain } = buildApp(env, {
    starterGasEnabled: true,
    opsPrivateKey: OPS_KEY,
    starterGasWei: 10n ** 18n,
    starterGasDailyCapWei: 10n ** 18n,
    starterGasBalanceThresholdWei: 10n ** 18n,
  });
  const mock = starterGasChain!;
  const agent = privateKeyToAccount(AGENT_KEY);

  // Uncertain broadcast: keep the signed transfer and replay it verbatim.
  mock.failBroadcast = true;
  const first = await challengeAndSign(app, agent, "starter-gas");
  const failed = await req(app, "/api/agents/starter-gas", {
    method: "POST",
    body: JSON.stringify({ address: agent.address, signature: first.signature }),
  });
  expect(failed.status).toBe(502);
  expect(mock.broadcasts).toHaveLength(1);

  mock.failBroadcast = false;
  const retry = await req(app, "/api/agents/starter-gas", {
    method: "POST",
    body: JSON.stringify({ address: agent.address, signature: first.signature }),
  });
  expect(retry.status).toBe(200);
  expect(mock.signed).toHaveLength(1);
  expect(mock.broadcasts).toHaveLength(2);
  expect(mock.broadcasts[0]).toBe(mock.broadcasts[1]);

  // Daily cap: a second address would exceed the cap.
  const other = privateKeyToAccount(OTHER_KEY);
  const otherChallenge = await challengeAndSign(app, other, "starter-gas");
  const capped = await req(app, "/api/agents/starter-gas", {
    method: "POST",
    body: JSON.stringify({ address: other.address, signature: otherChallenge.signature }),
  });
  expect(capped.status).toBe(429);
  expect(mock.signed).toHaveLength(1);
});
