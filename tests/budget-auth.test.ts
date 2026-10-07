import { afterEach, expect, test } from 'bun:test';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { createWalletClient, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { identityRegistryAbi, type AgentRegistryChain } from '../src/agent-registry.ts';
import { budgetChallengeKey, createBudgetService } from '../src/budget.ts';
import { main as budgetDemo } from '../scripts/budget-demo.ts';
import { createBunDb } from '../src/db-bun.ts';
import type { Db } from '../src/db.ts';
import type { SettlementApp } from '../src/server.ts';
import { createStore } from '../src/store.ts';
import { permit2PaymentKey, type Permit2Facilitator } from '../src/x402/index.ts';
import type { X402PaymentRequirements } from '../src/x402/types.ts';
import {
  AGENT_KEY,
  BUYER_KEY,
  PROFILE,
  buildApp,
  closeAll,
  manualPayload,
  manualUptoPayload,
  mockFacilitator,
  registerProvider,
  req,
  startChain,
} from './m6-harness.ts';

// Signed budget writes (architecture §3). The wallet signature over a
// server-issued challenge is the whole identity: owner ceilings are authorized
// by ownerOf / getAgentWallet read at submit time, a payment wallet may only set
// its own value at or below the ceilings on it, and every successful write lands
// exactly one audit row. These tests pin the message format, the error texts and
// the atomic consume-and-write.

const KEY = 'sk-test-beefapi-secret-value-1234567890';
const CHAIN_ID = 31337;
const DAY_FIXED = Date.parse('2026-10-07T12:00:00.000Z');
const TTL_MS = 300_000;
const GLM = 'llm-glm-5-3';
const ASTRA = 'llm-gpt-6-astra';
const ASTRA_QUOTE = 69_000n;
const GLM_CHARGE = 74n;

// Stub-registry keys: no gas needed, the chain reads are answered from a map.
const O = privateKeyToAccount(`0x${'5'.repeat(64)}` as Hex);
const W = privateKeyToAccount(`0x${'6'.repeat(64)}` as Hex);
const P = privateKeyToAccount(`0x${'7'.repeat(64)}` as Hex);
const O_ADDR = getAddress(O.address);
const W_ADDR = getAddress(W.address);
const P_ADDR = getAddress(P.address);
const ZERO = getAddress('0x0000000000000000000000000000000000000000');

// A funded account, for the cases that must send a real registration or
// setAgentWallet transaction on ganache.
const onChainOwner = privateKeyToAccount(BUYER_KEY);
const onChainOwnerAddr = getAddress(onChainOwner.address);
const newWallet = privateKeyToAccount(`0x${'8'.repeat(64)}` as Hex);

const stubClosers: Array<() => void> = [];
afterEach(async () => {
  while (stubClosers.length) stubClosers.pop()?.();
  await closeAll();
});

// ---- fixtures --------------------------------------------------------------

function stubRegistry(entries: Record<string, { owner: Address; wallet: Address }> = {}) {
  const calls = { ownerOf: 0, agentWallet: 0 };
  const state = new Map(Object.entries(entries));
  const chain: AgentRegistryChain = {
    async getChainId() {
      return CHAIN_ID;
    },
    async getFinalizedReceipt() {
      return null;
    },
    async readOwnerOf(agentId) {
      calls.ownerOf += 1;
      const entry = state.get(String(agentId));
      if (!entry) throw new Error('agent not found');
      return entry.owner;
    },
    async readAgentWallet(agentId) {
      calls.agentWallet += 1;
      const entry = state.get(String(agentId));
      if (!entry) throw new Error('agent not found');
      return entry.wallet;
    },
  };
  return { chain, calls, state };
}

// A service-backed app with a stub registry, so the budget rules are pinned
// without a chain round trip, plus optional clock and budget-max control.
async function setupStub(
  opts: {
    entries?: Record<string, { owner: Address; wallet: Address }>;
    now?: () => number;
    budgetMax?: bigint;
    noRegistry?: boolean;
  } = {},
) {
  const env = await startChain();
  const registry = stubRegistry(opts.entries);
  const built = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiBaseUrl: 'https://llm.example.test',
    llmBeefapiApiKey: KEY,
    identityRegistry: opts.noRegistry ? null : undefined,
    agentRegistryChain: opts.noRegistry ? undefined : registry.chain,
    now: opts.now,
    settlementBudgetMaxAtomic: opts.budgetMax,
  });
  return { env, registry, ...built };
}

// Deterministic BeefAPI stub, only for the cases that let the upstream call run.
function startLlmStub() {
  const state = { usage: { prompt_tokens: 10, completion_tokens: 20 } };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      return Response.json({
        id: 'chatcmpl-test-1',
        choices: [{ message: { role: 'assistant', content: 'Hello from the model.' } }],
        usage: state.usage,
      });
    },
  });
  stubClosers.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}` };
}

// A registered provider agent (#0) on the real ganache registry: owner and
// payment wallet are the same address, exactly like the live agent #0.
async function setupLive(
  opts: { llm?: { url: string }; facilitator?: Permit2Facilitator } = {},
) {
  const env = await startChain();
  const built = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiBaseUrl: opts.llm?.url ?? 'https://llm.example.test',
    llmBeefapiApiKey: KEY,
    permit2Facilitator: opts.facilitator,
  });
  await registerProvider(built.app, env, privateKeyToAccount(AGENT_KEY));
  return { env, ...built };
}

const provider = privateKeyToAccount(AGENT_KEY);
const providerAddress = getAddress(provider.address);

// ---- request helpers -------------------------------------------------------

type ChallengeBody = {
  scope: 'ceiling' | 'wallet';
  wallet: string;
  signer: string;
  agentId?: string;
  dailyLimit: string | null;
};

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

async function challenge(app: SettlementApp, request: ChallengeBody) {
  const res = await req(app, '/api/budgets/challenge', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { message: string; expiresAt: number };
}

async function submit(
  app: SettlementApp,
  account: ReturnType<typeof privateKeyToAccount>,
  request: ChallengeBody,
): Promise<Response> {
  const issued = await challenge(app, request);
  const signature = await account.signMessage({ message: issued.message });
  return req(app, '/api/budgets', {
    method: 'POST',
    body: JSON.stringify({ ...request, signature }),
  });
}

async function summaryOf(app: SettlementApp, address: string) {
  const res = await req(app, `/api/wallets/${address}/summary`);
  expect(res.status).toBe(200);
  return body(res);
}

// Registers an agent through the platform flow and returns its on-chain id.
async function registerAgent(
  app: SettlementApp,
  env: Awaited<ReturnType<typeof startChain>>,
  account: ReturnType<typeof privateKeyToAccount>,
  role: 'buyer' | 'provider' = 'buyer',
): Promise<string> {
  const challengeRes = await req(app, '/api/agents/challenge', {
    method: 'POST',
    body: JSON.stringify({ address: account.address }),
  });
  const { message } = (await challengeRes.json()) as { message: string };
  const signature = await account.signMessage({ message });
  const draftRes = await req(app, '/api/agents/drafts', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, signature, role, profile: PROFILE }),
  });
  expect(draftRes.status).toBe(200);
  const draft = (await draftRes.json()) as { agentURI: string };
  const wallet = createWalletClient({ chain: env.viemChain, account, transport: http(env.url) });
  const gas =
    ((await env.client.estimateContractGas({
      address: env.registry,
      abi: identityRegistryAbi,
      functionName: 'register',
      args: [draft.agentURI],
      account: account.address,
    })) *
      120n) /
    100n;
  const hash = await wallet.writeContract({
    address: env.registry,
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [draft.agentURI],
    gas,
  });
  await env.client.waitForTransactionReceipt({ hash });
  const confirm = await req(app, '/api/agents/confirm', {
    method: 'POST',
    body: JSON.stringify({ txHash: hash }),
  });
  expect(confirm.status).toBe(200);
  const listed = (await body(await req(app, '/api/agents'))).agents as Array<{ agentId: string }>;
  return listed[listed.length - 1]!.agentId;
}

// The new wallet signs the EIP-712 consent; the owner sends setAgentWallet.
async function rotateAgentWallet(
  env: Awaited<ReturnType<typeof startChain>>,
  owner: ReturnType<typeof privateKeyToAccount>,
  agentId: string,
  wallet: ReturnType<typeof privateKeyToAccount>,
): Promise<void> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const signature = await wallet.signTypedData({
    domain: {
      name: 'ERC8004IdentityRegistry',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: env.registry,
    },
    types: {
      AgentWalletSet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'owner', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'AgentWalletSet',
    message: {
      agentId: BigInt(agentId),
      newWallet: wallet.address,
      owner: owner.address,
      deadline,
    },
  });
  const client = createWalletClient({ chain: env.viemChain, account: owner, transport: http(env.url) });
  const hash = await client.writeContract({
    address: env.registry,
    abi: identityRegistryAbi,
    functionName: 'setAgentWallet',
    args: [BigInt(agentId), wallet.address, deadline, signature],
  });
  const receipt = await env.client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
}

async function unsetAgentWallet(
  env: Awaited<ReturnType<typeof startChain>>,
  owner: ReturnType<typeof privateKeyToAccount>,
  agentId: string,
): Promise<void> {
  const client = createWalletClient({ chain: env.viemChain, account: owner, transport: http(env.url) });
  const hash = await client.writeContract({
    address: env.registry,
    abi: identityRegistryAbi,
    functionName: 'unsetAgentWallet',
    args: [BigInt(agentId)],
  });
  expect((await env.client.waitForTransactionReceipt({ hash })).status).toBe('success');
}

// ---- VAL-AUTH-001 / 002: the challenge -------------------------------------

test('budget challenge message carries the full signed intent', async () => {
  const clock = { at: DAY_FIXED };
  const { app } = await setupStub({ now: () => clock.at });

  const ceiling = await challenge(app, {
    scope: 'ceiling',
    wallet: W_ADDR,
    signer: O_ADDR,
    agentId: '7',
    dailyLimit: '50000',
  });
  expect(ceiling.message.startsWith('BF Market daily budget change')).toBe(true);
  const lines = ceiling.message.split('\n');
  expect(lines).toContain('Purpose: wallet-budget');
  expect(lines.some((line) => line.startsWith('Domain: '))).toBe(true);
  expect(lines).toContain(`Address: ${O_ADDR}`);
  expect(lines).toContain('Scope: owner ceiling for agent #7');
  expect(lines).toContain(`Wallet: ${W_ADDR}`);
  expect(lines).toContain('Daily budget: 0.05 USDC (50000)');
  expect(lines.some((line) => /^Nonce: 0x[0-9a-f]+$/.test(line))).toBe(true);
  expect(lines).toContain(`Chain ID: ${CHAIN_ID}`);
  expect(lines.some((line) => line.startsWith('Issued at: '))).toBe(true);
  expect(lines.some((line) => line.startsWith('Expires at: '))).toBe(true);
  const ahead = ceiling.expiresAt - clock.at;
  expect(ahead).toBeGreaterThanOrEqual(290_000);
  expect(ahead).toBeLessThanOrEqual(TTL_MS);

  const own = await challenge(app, {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: null,
  });
  expect(own.message.split('\n')).toContain("Scope: wallet's own budget");
  expect(own.message.split('\n')).toContain('Daily budget: removed');

  const small = await challenge(app, {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '30000',
  });
  expect(small.message.split('\n')).toContain('Daily budget: 0.03 USDC (30000)');
});

test('challenge issuance validates format and range without touching the chain', async () => {
  const { app, registry } = await setupStub();
  const bad = async (request: Record<string, unknown>): Promise<{ error: string }> => {
    const res = await req(app, '/api/budgets/challenge', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    expect(res.status).toBe(400);
    const payload = await body(res);
    expect(payload.message).toBeUndefined();
    expect(payload.error).toBeTruthy();
    expect(/[\u4e00-\u9fff]/.test(payload.error)).toBe(false);
    return payload as { error: string };
  };

  const base = { scope: 'wallet', wallet: W_ADDR, signer: W_ADDR };
  expect(
    (
      await bad({ ...base, wallet: '0xnotanaddress', dailyLimit: '10000' })
    ).error,
  ).toBe('Invalid wallet address.');
  expect((await bad({ ...base, dailyLimit: 'abc' })).error).toBe('Invalid daily budget.');
  expect((await bad({ ...base, dailyLimit: '-1' })).error).toBe('Invalid daily budget.');
  expect((await bad({ ...base, dailyLimit: '5000001' })).error).toBe(
    'The daily budget cannot exceed 5 USDC.',
  );
  await bad({ scope: 'ceiling', wallet: W_ADDR, signer: O_ADDR, dailyLimit: '10000' });
  await bad({ ...base, scope: 'other', dailyLimit: '10000' });

  const accepted = await req(app, '/api/budgets/challenge', {
    method: 'POST',
    body: JSON.stringify({ ...base, dailyLimit: '5000000' }),
  });
  expect(accepted.status).toBe(200);
  const zero = await req(app, '/api/budgets/challenge', {
    method: 'POST',
    body: JSON.stringify({ ...base, dailyLimit: '0' }),
  });
  expect(zero.status).toBe(200);

  // Issuing never reads the chain.
  expect(registry.calls.ownerOf).toBe(0);
  expect(registry.calls.agentWallet).toBe(0);
});

// ---- VAL-AUTH-003 / 004 / 006 / 007: the owner ceiling ---------------------

test('owner sets a ceiling for an agent whose payment wallet differs', async () => {
  const env = await startChain();
  const built = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiBaseUrl: 'https://llm.example.test',
    llmBeefapiApiKey: KEY,
  });
  const agentId = await registerAgent(built.app, env, onChainOwner);
  await rotateAgentWallet(env, onChainOwner, agentId, newWallet);
  const walletAddress = getAddress(newWallet.address);

  const res = await submit(built.app, onChainOwner, {
    scope: 'ceiling',
    wallet: walletAddress,
    signer: onChainOwnerAddr,
    agentId,
    dailyLimit: '50000',
  });
  expect(res.status).toBe(200);
  const payload = await body(res);
  expect(payload.wallet).toBe(walletAddress);
  expect(payload.userBudget.effective).toBe('50000');
  expect(payload.userBudget.source).toBe('ceiling');

  const after = await summaryOf(built.app, walletAddress);
  expect(after.userBudget.effective).toBe('50000');
  expect(after.userBudget.source).toBe('ceiling');
  expect(after.userBudget.ceiling.dailyLimit).toBe('50000');
  expect(after.userBudget.ceiling.agentId).toBe(agentId);
  expect(after.userBudget.ceiling.setBy.toLowerCase()).toBe(onChainOwnerAddr.toLowerCase());
  // The verified chain state was mirrored back into the agent row.
  expect(built.store.getAgent(CHAIN_ID, agentId)!.agentWallet).toBe(walletAddress);
});

test('a ceiling write whose wallet is not the on-chain agent wallet is rejected', async () => {
  const { app, store, registry } = await setupStub({
    entries: { 0: { owner: O_ADDR, wallet: W_ADDR } },
  });
  const before = await summaryOf(app, O_ADDR);
  expect(before.userBudget).toBeNull();

  const res = await submit(app, O, {
    scope: 'ceiling',
    wallet: O_ADDR,
    signer: O_ADDR,
    agentId: '0',
    dailyLimit: '50000',
  });
  expect(res.status).toBe(409);
  const payload = await body(res);
  expect(/refresh/i.test(payload.error)).toBe(true);

  expect(store.getCeiling(CHAIN_ID, '0')).toBeNull();
  expect((await summaryOf(app, O_ADDR)).userBudget).toBeNull();
  expect(registry.calls.ownerOf).toBe(1);
});

test('only the on-chain owner can set a ceiling', async () => {
  const { app, store } = await setupStub({
    entries: { 0: { owner: O_ADDR, wallet: W_ADDR } },
  });
  const request = {
    scope: 'ceiling' as const,
    wallet: W_ADDR,
    agentId: '0',
    dailyLimit: '50000',
  };

  const byWallet = await submit(app, W, { ...request, signer: W_ADDR });
  expect(byWallet.status).toBe(403);
  expect((await body(byWallet)).error).toBe('The signer is not allowed to set this budget.');

  const byStranger = await submit(app, P, { ...request, signer: P_ADDR });
  expect(byStranger.status).toBe(403);
  expect((await body(byStranger)).error).toBe('The signer is not allowed to set this budget.');

  expect(store.getCeiling(CHAIN_ID, '0')).toBeNull();
  expect(store.listBudgetEvents(W_ADDR)).toEqual([]);
});

test('a ceiling for an agent without a payment wallet is rejected', async () => {
  const env = await startChain();
  const built = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiBaseUrl: 'https://llm.example.test',
    llmBeefapiApiKey: KEY,
  });
  const agentId = await registerAgent(built.app, env, onChainOwner);
  await unsetAgentWallet(env, onChainOwner, agentId);
  expect(
    (await env.client.readContract({
      address: env.registry,
      abi: identityRegistryAbi,
      functionName: 'getAgentWallet',
      args: [BigInt(agentId)],
    })) as Address,
  ).toBe(ZERO);

  const res = await submit(built.app, onChainOwner, {
    scope: 'ceiling',
    wallet: onChainOwnerAddr,
    signer: onChainOwnerAddr,
    agentId,
    dailyLimit: '50000',
  });
  expect(res.status).toBe(409);
  expect((await body(res)).error).toBe('This agent has no payment wallet.');
  expect(built.store.getCeiling(CHAIN_ID, agentId)).toBeNull();
});

test('a missing or failing registry returns 503 and writes nothing', async () => {
  // No registry configured at all.
  const bare = await setupStub({ noRegistry: true });
  const unconfigured = await submit(bare.app, O, {
    scope: 'ceiling',
    wallet: W_ADDR,
    signer: O_ADDR,
    agentId: '0',
    dailyLimit: '50000',
  });
  expect(unconfigured.status).toBe(503);
  expect((await body(unconfigured)).error).toBe(
    'No identity registry is configured on this network, so ownership cannot be verified.',
  );
  expect(bare.store.getCeiling(CHAIN_ID, '0')).toBeNull();
  expect(bare.store.listBudgetEvents(W_ADDR)).toEqual([]);

  // Configured, but the read itself fails.
  const failing = await setupStub();
  const res = await submit(failing.app, O, {
    scope: 'ceiling',
    wallet: W_ADDR,
    signer: O_ADDR,
    agentId: '404',
    dailyLimit: '50000',
  });
  expect(res.status).toBe(503);
  expect((await body(res)).error).toBe('Could not read the identity registry. Try again.');
  expect(failing.store.getCeiling(CHAIN_ID, '404')).toBeNull();
  expect(failing.store.listBudgetEvents(W_ADDR)).toEqual([]);
});

// ---- VAL-AUTH-008 .. 011: the wallet's own value ---------------------------

test('a wallet sets its own budget only as itself', async () => {
  const { app } = await setupStub({ entries: { 0: { owner: O_ADDR, wallet: W_ADDR } } });
  await submit(app, O, {
    scope: 'ceiling',
    wallet: W_ADDR,
    signer: O_ADDR,
    agentId: '0',
    dailyLimit: '50000',
  });

  const byOwner = await submit(app, O, {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: O_ADDR,
    dailyLimit: '30000',
  });
  expect(byOwner.status).toBe(403);
  expect((await body(byOwner)).error).toBe('The signer is not allowed to set this budget.');

  const byWallet = await submit(app, W, {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '30000',
  });
  expect(byWallet.status).toBe(200);
  const after = await summaryOf(app, W_ADDR);
  expect(after.userBudget.effective).toBe('30000');
  expect(after.userBudget.source).toBe('own');
});

test("an own budget above the owner's ceiling names the ceiling", async () => {
  const { app } = await setupStub({ entries: { 0: { owner: O_ADDR, wallet: W_ADDR } } });
  const ceilingOf = (dailyLimit: string) =>
    submit(app, O, {
      scope: 'ceiling',
      wallet: W_ADDR,
      signer: O_ADDR,
      agentId: '0',
      dailyLimit,
    });
  expect((await ceilingOf('50000')).status).toBe(200);

  const first = await submit(app, W, {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '100000',
  });
  expect(first.status).toBe(400);
  expect((await body(first)).error).toBe("The daily budget exceeds the owner's limit of 0.05 USDC.");
  expect((await summaryOf(app, W_ADDR)).userBudget.own).toBeNull();

  expect((await ceilingOf('10000')).status).toBe(200);
  const second = await submit(app, W, {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '20000',
  });
  expect(second.status).toBe(400);
  expect((await body(second)).error).toBe("The daily budget exceeds the owner's limit of 0.01 USDC.");
  expect((await summaryOf(app, W_ADDR)).userBudget.own).toBeNull();
});

test('an own budget on an unregistered wallet is bounded by the configured max only', async () => {
  const { app } = await setupStub({ entries: {} });
  const set = (dailyLimit: string | null) =>
    submit(app, P, { scope: 'wallet', wallet: P_ADDR, signer: P_ADDR, dailyLimit });

  expect((await set('5000000')).status).toBe(200);
  const maxed = await summaryOf(app, P_ADDR);
  expect(maxed.userBudget.effective).toBe('5000000');
  expect(maxed.userBudget.source).toBe('own');

  // Above the configured max, even the challenge is refused.
  const over = await req(app, '/api/budgets/challenge', {
    method: 'POST',
    body: JSON.stringify({
      scope: 'wallet',
      wallet: P_ADDR,
      signer: P_ADDR,
      dailyLimit: '5000001',
    }),
  });
  expect(over.status).toBe(400);
  expect((await body(over)).error).toBe('The daily budget cannot exceed 5 USDC.');

  expect((await set('20000')).status).toBe(200);
  expect((await set(null)).status).toBe(200);
  const removed = await summaryOf(app, P_ADDR);
  expect(removed.userBudget).toBeNull();
  expect(removed.remaining.userBudget).toBeNull();
});

test('removing an own budget is always allowed and the ceiling takes over', async () => {
  const { app } = await setupStub({ entries: { 0: { owner: O_ADDR, wallet: W_ADDR } } });
  await submit(app, O, {
    scope: 'ceiling',
    wallet: W_ADDR,
    signer: O_ADDR,
    agentId: '0',
    dailyLimit: '10000',
  });
  await submit(app, W, {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '9000',
  });
  expect((await summaryOf(app, W_ADDR)).userBudget.effective).toBe('9000');

  const removed = await submit(app, W, {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: null,
  });
  expect(removed.status).toBe(200);
  const after = await summaryOf(app, W_ADDR);
  expect(after.userBudget.own).toBeNull();
  expect(after.userBudget.effective).toBe('10000');
  expect(after.userBudget.source).toBe('ceiling');
});

// ---- VAL-AUTH-012 .. 015: binding, replay, reissue, expiry ------------------

test('the submit body must equal the signed intent', async () => {
  const { app, store } = await setupStub({ entries: {} });
  const request: ChallengeBody = {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '30000',
  };
  const issued = await challenge(app, request);
  const signature = await sign(W, issued.message);

  const mismatched = await req(app, '/api/budgets', {
    method: 'POST',
    body: JSON.stringify({ ...request, dailyLimit: '40000', signature }),
  });
  expect(mismatched.status).toBe(400);
  expect((await summaryOf(app, W_ADDR)).userBudget).toBeNull();

  const wrongScope = await req(app, '/api/budgets', {
    method: 'POST',
    body: JSON.stringify({
      scope: 'ceiling',
      wallet: W_ADDR,
      signer: W_ADDR,
      agentId: '0',
      dailyLimit: '30000',
      signature,
    }),
  });
  expect(wrongScope.status).toBe(400);
  expect(store.getCeiling(CHAIN_ID, '0')).toBeNull();

  // The challenge survived the mismatched attempts, so the original body works.
  const ok = await req(app, '/api/budgets', {
    method: 'POST',
    body: JSON.stringify({ ...request, signature }),
  });
  expect(ok.status).toBe(200);
  expect((await summaryOf(app, W_ADDR)).userBudget.effective).toBe('30000');
});

test('a used signature cannot be submitted twice', async () => {
  const { app, store } = await setupStub({ entries: {} });
  const request: ChallengeBody = {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '30000',
  };
  const issued = await challenge(app, request);
  const signature = await sign(W, issued.message);
  const payload = JSON.stringify({ ...request, signature });

  const first = await req(app, '/api/budgets', { method: 'POST', body: payload });
  expect(first.status).toBe(200);
  const events = store.listBudgetEvents(W_ADDR).length;

  const replay = await req(app, '/api/budgets', { method: 'POST', body: payload });
  expect(replay.status).toBe(409);
  expect((await body(replay)).error).toBe('This challenge was already used. Request a new one.');
  expect(store.getWalletBudget(W_ADDR)!.dailyLimit).toBe(30_000n);
  expect(store.listBudgetEvents(W_ADDR).length).toBe(events);
});

test('a reissued challenge replaces the previous one', async () => {
  const { app } = await setupStub({ entries: {} });
  const first = await challenge(app, {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '30000',
  });
  const second = await challenge(app, {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '40000',
  });
  expect(second.message).not.toBe(first.message);

  const stale = await req(app, '/api/budgets', {
    method: 'POST',
    body: JSON.stringify({
      scope: 'wallet',
      wallet: W_ADDR,
      signer: W_ADDR,
      dailyLimit: '30000',
      signature: await sign(W, first.message),
    }),
  });
  expect(stale.status).toBe(400);

  const fresh = await req(app, '/api/budgets', {
    method: 'POST',
    body: JSON.stringify({
      scope: 'wallet',
      wallet: W_ADDR,
      signer: W_ADDR,
      dailyLimit: '40000',
      signature: await sign(W, second.message),
    }),
  });
  expect(fresh.status).toBe(200);
  expect((await summaryOf(app, W_ADDR)).userBudget.effective).toBe('40000');
});

test('a challenge expires after five minutes and rejects another signer', async () => {
  const clock = { at: DAY_FIXED };
  const { app, store } = await setupStub({ entries: {}, now: () => clock.at });
  const request: ChallengeBody = {
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '30000',
  };
  const issued = await challenge(app, request);
  const signature = await sign(W, issued.message);

  clock.at = DAY_FIXED + TTL_MS + 1;
  const expired = await req(app, '/api/budgets', {
    method: 'POST',
    body: JSON.stringify({ ...request, signature }),
  });
  expect(expired.status).toBe(400);
  expect((await body(expired)).error).toBe('This challenge has expired. Request a new one.');
  expect(store.getWalletBudget(W_ADDR)).toBeNull();

  // A fresh challenge inside the window, but signed by a different key.
  clock.at = DAY_FIXED + TTL_MS + 2;
  const fresh = await challenge(app, request);
  const wrongSignature = await sign(P, fresh.message);
  const rejected = await req(app, '/api/budgets', {
    method: 'POST',
    body: JSON.stringify({ ...request, signature: wrongSignature }),
  });
  expect(rejected.status).toBe(400);
  expect((await body(rejected)).error).toBe('Invalid signature.');
  expect(store.getWalletBudget(W_ADDR)).toBeNull();

  clock.at = DAY_FIXED + TTL_MS + 3;
  const ok = await submit(app, W, request);
  expect(ok.status).toBe(200);
});

test('consuming the challenge and writing the budget share one transaction', async () => {
  const built = await setupStub({ entries: { 0: { owner: O_ADDR, wallet: W_ADDR } } });
  const db = createBunDb(':memory:');
  stubClosers.push(() => db.close());
  // A database whose ceiling insert fails after the challenge was consumed.
  const failing: Db = {
    ...db,
    run(query: string, params: readonly unknown[] = []) {
      if (query.includes('INSERT INTO agent_budget_ceilings')) {
        throw new Error('forced budget write failure');
      }
      return db.run(query, params);
    },
  };
  const store = createStore({ path: ':memory:', db: failing });
  const service = createBudgetService({
    store,
    config: built.config,
    registry: built.registry.chain,
    now: () => DAY_FIXED,
    summary: () => ({}),
  });
  const request: ChallengeBody = {
    scope: 'ceiling',
    wallet: W_ADDR,
    signer: O_ADDR,
    agentId: '0',
    dailyLimit: '50000',
  };
  const issued = service.issueChallenge(request, 'http://127.0.0.1:4333');
  const signature = await sign(O, issued.message);

  await expect(
    service.submit({ ...request, signature }, 'http'),
  ).rejects.toThrow('forced budget write failure');

  const key = budgetChallengeKey('ceiling', O_ADDR, W_ADDR);
  expect(store.getChallenge(key)!.consumed).toBe(false);
  expect(store.getCeiling(CHAIN_ID, '0')).toBeNull();
  expect(store.listBudgetEvents(W_ADDR)).toEqual([]);
});

// ---- VAL-AUTH-016 .. 019: ceilings over an own value ------------------------

test('lowering the ceiling keeps the own value and caps the effective budget', async () => {
  const { app } = await setupStub({ entries: { 0: { owner: O_ADDR, wallet: W_ADDR } } });
  const ceilingOf = (dailyLimit: string | null) =>
    submit(app, O, {
      scope: 'ceiling',
      wallet: W_ADDR,
      signer: O_ADDR,
      agentId: '0',
      dailyLimit,
    });

  expect((await ceilingOf('50000')).status).toBe(200);
  expect(
    (await submit(app, W, {
      scope: 'wallet',
      wallet: W_ADDR,
      signer: W_ADDR,
      dailyLimit: '30000',
    })).status,
  ).toBe(200);

  expect((await ceilingOf('10000')).status).toBe(200);
  const capped = await summaryOf(app, W_ADDR);
  expect(capped.userBudget.effective).toBe('10000');
  expect(capped.userBudget.source).toBe('ceiling');
  expect(capped.userBudget.own.dailyLimit).toBe('30000');
  expect(capped.userBudget.own.cappedByCeiling).toBe(true);

  // Removing the ceiling lets the preserved own value apply again, and an equal
  // ceiling reports the combined source.
  expect((await ceilingOf(null)).status).toBe(200);
  const restored = await summaryOf(app, W_ADDR);
  expect(restored.userBudget.effective).toBe('30000');
  expect(restored.userBudget.source).toBe('own');
  expect(restored.userBudget.ceiling).toBeNull();
  expect(restored.userBudget.own.cappedByCeiling).toBe(false);

  expect((await ceilingOf('30000')).status).toBe(200);
  const equal = await summaryOf(app, W_ADDR);
  expect(equal.userBudget.effective).toBe('30000');
  expect(equal.userBudget.source).toBe('ceiling+own');
});

test('a same-address agent accepts both scopes', async () => {
  const { app } = await setupStub({ entries: { 0: { owner: O_ADDR, wallet: O_ADDR } } });

  const ceiling = await submit(app, O, {
    scope: 'ceiling',
    wallet: O_ADDR,
    signer: O_ADDR,
    agentId: '0',
    dailyLimit: '40000',
  });
  expect(ceiling.status).toBe(200);
  const afterCeiling = await summaryOf(app, O_ADDR);
  expect(afterCeiling.userBudget.effective).toBe('40000');
  expect(afterCeiling.userBudget.source).toBe('ceiling');

  const own = await submit(app, O, {
    scope: 'wallet',
    wallet: O_ADDR,
    signer: O_ADDR,
    dailyLimit: '20000',
  });
  expect(own.status).toBe(200);
  const afterOwn = await summaryOf(app, O_ADDR);
  expect(afterOwn.userBudget.effective).toBe('20000');
  expect(afterOwn.userBudget.source).toBe('own');

  const over = await submit(app, O, {
    scope: 'wallet',
    wallet: O_ADDR,
    signer: O_ADDR,
    dailyLimit: '50000',
  });
  expect(over.status).toBe(400);
  expect((await body(over)).error).toBe("The daily budget exceeds the owner's limit of 0.04 USDC.");
});

test('every successful write appends exactly one audit event', async () => {
  const { app, store, config, registry } = await setupStub({
    entries: { 0: { owner: O_ADDR, wallet: W_ADDR } },
    now: () => DAY_FIXED,
  });
  // The MCP route is the same service with via 'mcp'.
  const service = createBudgetService({
    store,
    config,
    registry: registry.chain,
    now: () => DAY_FIXED,
    summary: () => ({}),
  });
  const viaMcp = async (request: ChallengeBody) => {
    const issued = service.issueChallenge(request, 'http://127.0.0.1:4333');
    return service.submit(
      { ...request, signature: await sign(W, issued.message) },
      'mcp',
    );
  };

  const count = () => store.listBudgetEvents(W_ADDR).length;
  expect(count()).toBe(0);

  const ceiling = await submit(app, O, {
    scope: 'ceiling',
    wallet: W_ADDR,
    signer: O_ADDR,
    agentId: '0',
    dailyLimit: '50000',
  });
  expect(ceiling.status).toBe(200);
  expect(count()).toBe(1);

  const own = await viaMcp({
    scope: 'wallet',
    wallet: W_ADDR,
    signer: W_ADDR,
    dailyLimit: '20000',
  });
  expect(own).toBeTruthy();
  expect(count()).toBe(2);

  const removed = await submit(app, O, {
    scope: 'ceiling',
    wallet: W_ADDR,
    signer: O_ADDR,
    agentId: '0',
    dailyLimit: null,
  });
  expect(removed.status).toBe(200);
  expect(count()).toBe(3);

  const [latest, second, first] = store.listBudgetEvents(W_ADDR);
  expect(latest).toMatchObject({ scope: 'ceiling', agentId: '0', dailyLimit: null, via: 'http' });
  expect((latest as { wallet: string }).wallet).toBe(W_ADDR.toLowerCase());
  expect((latest as { signer: string }).signer.toLowerCase()).toBe(O_ADDR.toLowerCase());
  expect(second).toMatchObject({ scope: 'wallet', agentId: null, dailyLimit: 20_000n, via: 'mcp' });
  expect(first).toMatchObject({ scope: 'ceiling', agentId: '0', dailyLimit: 50_000n, via: 'http' });

  // Rejected submits append nothing.
  const before = count();
  const rejected = await submit(app, O, {
    scope: 'ceiling',
    wallet: W_ADDR,
    signer: O_ADDR,
    agentId: '1',
    dailyLimit: '50000',
  });
  expect(rejected.status).toBe(503);
  const forbidden = await submit(app, W, {
    scope: 'ceiling',
    wallet: W_ADDR,
    signer: W_ADDR,
    agentId: '0',
    dailyLimit: '50000',
  });
  expect(forbidden.status).toBe(403);
  expect(count()).toBe(before);
});

test('budgetMax comes from SETTLEMENT_BUDGET_MAX', async () => {
  const { app } = await setupStub({ entries: {}, budgetMax: 3_000_000n });
  const shown = await summaryOf(app, P_ADDR);
  expect(shown.platform.budgetMax).toBe('3000000');
  expect(shown.platform.llmWalletDailyCap).toBe('5000000');

  const over = await req(app, '/api/budgets/challenge', {
    method: 'POST',
    body: JSON.stringify({
      scope: 'wallet',
      wallet: P_ADDR,
      signer: P_ADDR,
      dailyLimit: '3000001',
    }),
  });
  expect(over.status).toBe(400);
  expect((await body(over)).error).toBe('The daily budget cannot exceed 3 USDC.');

  const atMax = await submit(app, P, {
    scope: 'wallet',
    wallet: P_ADDR,
    signer: P_ADDR,
    dailyLimit: '3000000',
  });
  expect(atMax.status).toBe(200);
});

// ---- VAL-AGENT-009: the budget-demo CLI ------------------------------------

test('the budget-demo CLI sets, removes and shows both scopes', async () => {
  const { app } = await setupStub({ entries: { 0: { owner: O_ADDR, wallet: W_ADDR } } });
  const host = new URL(app.origin).host;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      const headers = new Headers(request.headers);
      headers.set('Host', host);
      return app.fetch(new Request(request, { headers }));
    },
  });
  stubClosers.push(() => server.stop(true));
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const env = {
    OWNER_PRIVATE_KEY: `0x${'5'.repeat(64)}`,
    AGENT_PRIVATE_KEY: `0x${'6'.repeat(64)}`,
  };
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const output = () => lines.join('\n');

  const ceiling = await budgetDemo(
    ['set-ceiling', '--base-url', baseUrl, '--agent', '0', '--wallet', W_ADDR, '--amount', '0.05'],
    env,
    log,
  );
  expect(output()).toContain('effective 0.05 USDC (source ceiling)');
  expect((ceiling.summary!.userBudget as { source: string }).source).toBe('ceiling');

  lines.length = 0;
  const own = await budgetDemo(
    ['set-own', '--base-url', baseUrl, '--wallet', W_ADDR, '--amount', '0.03'],
    env,
    log,
  );
  expect(output()).toContain('effective 0.03 USDC (source own)');
  expect((own.summary!.userBudget as { effective: string }).effective).toBe('30000');

  // A rejected write surfaces the server error and never prints a key.
  const rejected = await budgetDemo(
    ['set-own', '--base-url', baseUrl, '--wallet', W_ADDR, '--amount', '0.10'],
    env,
    log,
  ).catch((error: unknown) => error as Error);
  expect(rejected).toBeInstanceOf(Error);
  expect((rejected as Error).message).toBe(
    "The daily budget exceeds the owner's limit of 0.05 USDC.",
  );
  expect(output()).not.toContain(env.AGENT_PRIVATE_KEY);

  const show = await budgetDemo(['show', '--base-url', baseUrl, '--wallet', W_ADDR], env, log);
  expect((show.summary!.userBudget as { effective: string }).effective).toBe('30000');
  expect(show.summary!.wallet).toBe(W_ADDR);
  expect(output()).not.toContain(env.AGENT_PRIVATE_KEY);

  lines.length = 0;
  const removed = await budgetDemo(
    ['remove-ceiling', '--base-url', baseUrl, '--agent', '0', '--wallet', W_ADDR],
    env,
    log,
  );
  expect(output()).toContain('effective 0.03 USDC (source own)');
  expect((removed.summary!.userBudget as { source: string }).source).toBe('own');

  const help = await budgetDemo([], env, log);
  expect(help.command).toBe('help');
  expect(output()).toContain('Usage:');
});

// ---- VAL-AUTH-020 .. 024 / VAL-LEDGER-021: the paid path -------------------


const settleOk = () => Promise.resolve({ ok: true as const, txHash: `0x${'ab'.repeat(32)}` as Hex, blockNumber: 1n });

async function offer(
  app: SettlementApp,
  serviceId: string,
  request: Record<string, unknown>,
): Promise<X402PaymentRequirements> {
  const res = await req(app, `/api/services/${serviceId}/call`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
  expect(res.status).toBe(402);
  const required = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED')!) as {
    accepts: X402PaymentRequirements[];
  };
  return required.accepts[0]!;
}

// Offer → sign as the provider wallet (agent #0, owner == wallet) → call.
async function paidCall(app: SettlementApp, serviceId: string, request: Record<string, unknown>) {
  const requirement = await offer(app, serviceId, request);
  const signed =
    requirement.scheme === 'upto'
      ? await manualUptoPayload({ requirement, account: provider, chainId: CHAIN_ID })
      : await manualPayload({ requirement, account: provider, chainId: CHAIN_ID });
  const res = await req(app, `/api/services/${serviceId}/call`, {
    method: 'POST',
    body: JSON.stringify(request),
    paymentSignature: signed.header,
  });
  return { res, key: permit2PaymentKey({ chainId: CHAIN_ID, payer: providerAddress, nonce: signed.nonce }) };
}

const glmBody = () => ({ messages: [{ role: 'user', content: 'hello world' }] });

async function sign(account: ReturnType<typeof privateKeyToAccount>, message: string): Promise<Hex> {
  return account.signMessage({ message });
}

async function setSameAddressBudget(
  app: SettlementApp,
  request: { dailyLimit: string | null; scope: 'ceiling' | 'wallet' },
) {
  const res = await submit(app, provider, {
    scope: request.scope,
    wallet: providerAddress,
    signer: providerAddress,
    agentId: request.scope === 'ceiling' ? '0' : undefined,
    dailyLimit: request.dailyLimit,
  });
  expect(res.status).toBe(200);
}

test('the owner ceiling rejects a metered call with the owner message', async () => {
  const { app, store } = await setupLive({ facilitator: mockFacilitator(settleOk) });
  await setSameAddressBudget(app, { scope: 'wallet', dailyLimit: '30000' });
  await setSameAddressBudget(app, { scope: 'ceiling', dailyLimit: '10000' });

  const before = await summaryOf(app, providerAddress);
  expect(before.userBudget.effective).toBe('10000');
  expect(before.userBudget.own.cappedByCeiling).toBe(true);

  const { res, key } = await paidCall(app, GLM, glmBody());
  expect(res.status).toBe(429);
  expect((await body(res)).error).toBe('Daily budget set by the agent owner is reached.');
  expect(store.getSpend(key)).toBeNull();
  expect(store.getServicePayment(key)).toBeNull();

  const after = await summaryOf(app, providerAddress);
  expect(after.spent.all.charged).toBe(before.spent.all.charged);
  expect(after.spent.all.pending).toBe(before.spent.all.pending);
});

test('the own budget rejects echo with the wallet message', async () => {
  const { app, store } = await setupLive({ facilitator: mockFacilitator(settleOk) });
  await setSameAddressBudget(app, { scope: 'wallet', dailyLimit: '30000' });

  const { res, key } = await paidCall(app, 'echo', { hello: 'world' });
  expect(res.status).toBe(429);
  expect((await body(res)).error).toBe('Daily budget reached for this wallet.');
  expect(store.getSpend(key)).toBeNull();
  expect(store.getServicePayment(key)).toBeNull();

  const summary = await summaryOf(app, providerAddress);
  expect(summary.spent.all.charged).toBe('0');
  expect(summary.spent.all.pending).toBe('0');
});

test('calls are admitted against the quoted maximum', async () => {
  const llm = startLlmStub();
  const { app, store } = await setupLive({ llm, facilitator: mockFacilitator(settleOk) });
  await setSameAddressBudget(app, { scope: 'wallet', dailyLimit: '30000' });

  // astra quotes 69000, above the 30000 the wallet set for itself.
  const astra = await paidCall(app, ASTRA, glmBody());
  expect(astra.res.status).toBe(429);
  expect(await body(astra.res)).toMatchObject({ error: 'Daily budget reached for this wallet.' });
  expect(store.getSpend(astra.key)).toBeNull();

  const astraOffer = await offer(app, ASTRA, glmBody());
  expect(astraOffer.amount).toBe(ASTRA_QUOTE.toString());

  // glm quotes 19040, so the same wallet can call it; the hold is taken and the
  // actual usage is charged.
  const glm = await paidCall(app, GLM, glmBody());
  expect(glm.res.status).toBe(200);
  const row = store.getSpend(glm.key)!;
  expect(row.scheme).toBe('upto');
  expect(row.state).toBe('charged');
  expect(row.amount).toBe(GLM_CHARGE);
  expect(store.spendFor(providerAddress, row.day).held).toBe(0n);
});

test('a budget of 0 pauses every paid call', async () => {
  const { app } = await setupLive({ facilitator: mockFacilitator(settleOk) });

  // Own value 0: every service answers with the wallet message.
  await setSameAddressBudget(app, { scope: 'wallet', dailyLimit: '0' });
  expect((await summaryOf(app, providerAddress)).remaining.userBudget).toBe('0');
  for (const [serviceId, request] of [
    ['echo', { hello: 'world' }],
    [GLM, glmBody()],
    [ASTRA, glmBody()],
  ] as const) {
    const { res } = await paidCall(app, serviceId, request);
    expect(res.status).toBe(429);
    expect((await body(res)).error).toBe('Daily budget reached for this wallet.');
  }

  // Ceiling 0 with the own value removed: the owner message instead.
  await submit(app, provider, {
    scope: 'wallet',
    wallet: providerAddress,
    signer: providerAddress,
    dailyLimit: null,
  });
  await setSameAddressBudget(app, { scope: 'ceiling', dailyLimit: '0' });
  expect((await summaryOf(app, providerAddress)).remaining.userBudget).toBe('0');
  for (const [serviceId, request] of [
    ['echo', { hello: 'world' }],
    [GLM, glmBody()],
    [ASTRA, glmBody()],
  ] as const) {
    const { res } = await paidCall(app, serviceId, request);
    expect(res.status).toBe(429);
    expect((await body(res)).error).toBe('Daily budget set by the agent owner is reached.');
  }
});

test('a same-address ceiling stops the owner from paying directly', async () => {
  const { app, store } = await setupLive({ facilitator: mockFacilitator(settleOk) });
  await setSameAddressBudget(app, { scope: 'ceiling', dailyLimit: '10000' });

  const { res, key } = await paidCall(app, GLM, glmBody());
  expect(res.status).toBe(429);
  expect((await body(res)).error).toBe('Daily budget set by the agent owner is reached.');
  expect(store.getServicePayment(key)).toBeNull();
  const receipts = (await body(await req(app, `/api/receipts?payer=${providerAddress}`))).receipts;
  expect(receipts).toEqual([]);
});

test('an echo call over a same-address ceiling is rejected before settlement', async () => {
  const { app, store } = await setupLive({ facilitator: mockFacilitator(settleOk) });
  await setSameAddressBudget(app, { scope: 'ceiling', dailyLimit: '50000' });

  const before = await summaryOf(app, providerAddress);
  const { res, key } = await paidCall(app, 'echo', { hello: 'world' });
  expect(res.status).toBe(429);
  expect((await body(res)).error).toBe('Daily budget set by the agent owner is reached.');

  const after = await summaryOf(app, providerAddress);
  expect(after.spent.all.charged).toBe(before.spent.all.charged);
  expect(after.spent.all.pending).toBe(before.spent.all.pending);
  expect(store.getSpend(key)).toBeNull();
  const receipts = (await body(await req(app, `/api/receipts?payer=${providerAddress}`))).receipts;
  expect(receipts).toEqual([]);
});
