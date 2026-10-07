import { afterEach, expect, test } from 'bun:test';
import { createWalletClient, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { identityRegistryAbi, type AgentRegistryChain } from '../src/agent-registry.ts';
import { utcDay } from '../src/budget.ts';
import { profileForChainId } from '../src/network.ts';
import type { SettlementApp } from '../src/server.ts';
import type { Store } from '../src/store.ts';
import type { SpendScheme } from '../src/types.ts';
import {
  AGENT_KEY,
  buildApp,
  closeAll,
  registerProvider,
  req,
  startChain,
} from './m6-harness.ts';

// Public read surface (architecture §4): the wallet summary, the owner console
// list, the agent refresh and the provider catalog. These endpoints are the only
// window an unauthenticated caller has into the budget ledger, so the tests pin
// their exact JSON shape, their arithmetic and their chain-refresh rules.

const CHAIN_ID = 31337;
const DAY_FIXED = Date.parse('2026-10-07T12:00:00.000Z');
const OWNER = getAddress('0x00000000000000000000000000000000000000aa');
const FRESH = getAddress('0x1111111111111111111111111111111111111111');
const W = getAddress('0x2222222222222222222222222222222222222222');
const W2 = getAddress('0x3333333333333333333333333333333333333333');
const ZERO = getAddress('0x0000000000000000000000000000000000000000');
const provider = privateKeyToAccount(AGENT_KEY);
const providerAddress = getAddress(provider.address);
const GLM_QUOTE = 19_040n;

afterEach(async () => {
  await closeAll();
});

// A registry stub with call counters, so the staleness and throttle rules can be
// asserted without touching ganache.
function stubRegistry(entries: Record<string, { owner: Address; wallet: Address }>) {
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

async function setup(opts: {
  registry?: AgentRegistryChain;
  now?: () => number;
  withProvider?: boolean;
  payerCap?: bigint;
  globalCap?: bigint;
} = {}) {
  const env = await startChain();
  const built = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiBaseUrl: 'https://llm.example.test',
    llmBeefapiApiKey: 'sk-test-beefapi-secret-value-1234567890',
    agentRegistryChain: opts.registry,
    now: opts.now,
    llmPayerDailyCapAtomic: opts.payerCap,
    llmGlobalDailyCapAtomic: opts.globalCap,
  });
  if (opts.withProvider) await registerProvider(built.app, env, provider);
  return { env, ...built };
}

async function summary(app: SettlementApp, address: string, query = '') {
  const res = await req(app, `/api/wallets/${address}/summary${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

// Writes an occupancy row the way a settled or in-flight payment would have left
// it, without going through the admission checks.
function seedSpend(
  store: Store,
  input: { key: Hex; payer: Address; day: string; scheme: SpendScheme; amount: bigint; state: 'held' | 'charged' },
): void {
  store.holdSpend({
    paymentKey: input.key,
    day: input.day,
    payer: input.payer,
    serviceId: input.scheme === 'upto' ? 'llm-glm-5-3' : 'echo',
    scheme: input.scheme,
    amount: 1n,
  });
  if (input.state === 'charged') store.chargeSpend(input.key, input.amount);
  else store.adjustHold(input.key, input.amount);
}

function keyOf(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}` as Hex;
}

function registerTx(n: number): Hex {
  return `0x${n.toString(16).padStart(64, 'ab')}` as Hex;
}

// ---- VAL-READ-001 / 005: shape and the empty wallet ------------------------

test('summary returns the documented shape and null budget fields without any budget', async () => {
  const { app, env } = await setup();
  const res = await req(app, `/api/wallets/${FRESH}/summary`);
  expect(res.status).toBe(200);
  const payload = await body(res);

  expect(Object.keys(payload).sort()).toEqual(
    [
      'agents',
      'asset',
      'day',
      'explorerUrl',
      'network',
      'platform',
      'recentReceipts',
      'remaining',
      'resetsAt',
      'spent',
      'userBudget',
      'wallet',
    ].sort(),
  );
  expect(payload.wallet).toBe(FRESH);
  expect(payload.network).toBe('eip155:31337');
  // The console builds receipt links from this instead of hard-coding a chain.
  expect(payload.explorerUrl).toBe('');
  // The asset is the configured network asset, the same one /api/services reports.
  expect(payload.asset).toEqual({
    address: profileForChainId(CHAIN_ID)!.asset.address,
    symbol: 'USDC',
    decimals: 6,
  });
  expect(payload.userBudget).toBeNull();
  expect(payload.remaining.userBudget).toBeNull();
  expect(payload.spent).toEqual({
    all: { charged: '0', pending: '0' },
    llm: { charged: '0', pending: '0' },
  });
  expect(payload.platform).toMatchObject({
    llmWalletDailyCap: '5000000',
    llmGlobalDailyCap: '50000000',
    budgetMax: '5000000',
  });
  expect(typeof payload.platform.llmGlobalRemaining).toBe('string');
  expect(payload.remaining.llm).toBe('5000000');
  expect(payload.agents).toEqual([]);
  expect(payload.recentReceipts).toEqual([]);
});

// ---- VAL-READ-006: budget sources ------------------------------------------

test('summary reports each budget source with the ceiling that binds', async () => {
  const { app, store } = await setup();
  const ceiling = (dailyLimit: bigint) =>
    store.setCeiling({
      chainId: CHAIN_ID,
      agentId: '7',
      wallet: FRESH,
      dailyLimit,
      signer: OWNER,
      via: 'http',
      at: DAY_FIXED,
    });

  ceiling(50_000n);
  let userBudget = (await summary(app, FRESH)).userBudget;
  expect(userBudget).toMatchObject({
    effective: '50000',
    source: 'ceiling',
    own: null,
    ceiling: { dailyLimit: '50000', agentId: '7', setBy: OWNER, updatedAt: DAY_FIXED },
  });

  store.removeCeiling({ chainId: CHAIN_ID, agentId: '7', signer: OWNER, via: 'http' });
  store.setOwnBudget({ wallet: FRESH, dailyLimit: 30_000n, signer: FRESH, via: 'http' });
  userBudget = (await summary(app, FRESH)).userBudget;
  expect(userBudget).toMatchObject({ effective: '30000', source: 'own', ceiling: null });
  expect(userBudget.own).toMatchObject({ dailyLimit: '30000', cappedByCeiling: false });

  // Own below the ceiling is not capped...
  ceiling(50_000n);
  userBudget = (await summary(app, FRESH)).userBudget;
  expect(userBudget).toMatchObject({ effective: '30000', source: 'own' });
  expect(userBudget.own.cappedByCeiling).toBe(false);

  // ...but an owner ceiling below the stored own value wins without rewriting it.
  ceiling(10_000n);
  userBudget = (await summary(app, FRESH)).userBudget;
  expect(userBudget).toMatchObject({ effective: '10000', source: 'ceiling', ceiling: { dailyLimit: '10000' } });
  expect(userBudget.own).toMatchObject({ dailyLimit: '30000', cappedByCeiling: true });
  expect(store.getWalletBudget(FRESH)!.dailyLimit).toBe(30_000n);

  // Equal values are reported as both, with the ceiling checked first.
  ceiling(30_000n);
  userBudget = (await summary(app, FRESH)).userBudget;
  expect(userBudget).toMatchObject({ effective: '30000', source: 'ceiling+own' });
});

// ---- VAL-READ-007: remaining math ------------------------------------------

test('summary remaining subtracts charged and pending and never goes negative', async () => {
  const { app, store } = await setup();
  const day = utcDay();
  store.setCeiling({
    chainId: CHAIN_ID,
    agentId: '7',
    wallet: FRESH,
    dailyLimit: 50_000n,
    signer: OWNER,
    via: 'http',
  });
  // 12000 charged (echo) and 19040 still held (a stale metered call).
  seedSpend(store, { key: keyOf(1), payer: FRESH, day, scheme: 'exact', amount: 12_000n, state: 'charged' });
  seedSpend(store, { key: keyOf(2), payer: FRESH, day, scheme: 'upto', amount: GLM_QUOTE, state: 'held' });

  let payload = await summary(app, FRESH);
  expect(payload.spent).toEqual({
    all: { charged: '12000', pending: '19040' },
    llm: { charged: '0', pending: '19040' },
  });
  expect(payload.remaining.userBudget).toBe('18960');
  // min(5000000 - 19040, user 18960, global) — the user budget binds.
  expect(payload.remaining.llm).toBe('18960');

  // Lowering the ceiling below today's spend clamps at zero.
  store.setCeiling({
    chainId: CHAIN_ID,
    agentId: '7',
    wallet: FRESH,
    dailyLimit: 10_000n,
    signer: OWNER,
    via: 'http',
  });
  payload = await summary(app, FRESH);
  expect(payload.remaining.userBudget).toBe('0');
  expect(payload.remaining.llm).toBe('0');

  // Without a user budget the LLM remainder is the platform cap minus usage,
  // bounded by what is left in the global metered budget.
  store.removeCeiling({ chainId: CHAIN_ID, agentId: '7', signer: OWNER, via: 'http' });
  seedSpend(store, { key: keyOf(3), payer: FRESH, day, scheme: 'upto', amount: 4_000_000n, state: 'charged' });
  payload = await summary(app, FRESH);
  expect(payload.userBudget).toBeNull();
  expect(payload.remaining.userBudget).toBeNull();
  // 5000000 - (4000000 + 19040) = 980960, and the global budget has room left.
  expect(payload.remaining.llm).toBe('980960');
  expect(payload.platform.llmGlobalRemaining).toBe('45980960');
});

test('echo spend counts toward the all-spent total but not toward the LLM total', async () => {
  const { app, store } = await setup();
  const day = utcDay();
  seedSpend(store, { key: keyOf(4), payer: FRESH, day, scheme: 'exact', amount: 1_000_000n, state: 'charged' });
  const payload = await summary(app, FRESH);
  expect(payload.spent.all.charged).toBe('1000000');
  expect(payload.spent.llm.charged).toBe('0');
  expect(payload.remaining.llm).toBe('5000000');
});

// ---- VAL-READ-008: day and resetsAt ---------------------------------------

test('day and resetsAt come from the shared UTC day helper at the day boundary', async () => {
  let clock = Date.parse('2026-10-07T23:59:59.999Z');
  const { app, store } = await setup({ now: () => clock });

  const before = await summary(app, FRESH);
  expect(before.day).toBe('2026-10-07');
  expect(before.resetsAt).toBe(Date.parse('2026-10-08T00:00:00Z'));
  expect(before.resetsAt - Date.parse(`${before.day}T00:00:00Z`)).toBe(86_400_000);

  // A hold taken just before midnight belongs to the day the summary reported.
  store.holdSpend({
    paymentKey: keyOf(5),
    day: utcDay(clock),
    payer: FRESH,
    serviceId: 'echo',
    scheme: 'exact',
    amount: 1_000n,
  });
  expect(store.spendFor(FRESH, before.day).held).toBe(1_000n);

  clock = Date.parse('2026-10-08T00:00:00.000Z');
  const after = await summary(app, FRESH);
  expect(after.day).toBe('2026-10-08');
  expect(after.resetsAt).toBe(Date.parse('2026-10-09T00:00:00Z'));
  // Yesterday's hold no longer counts toward today.
  expect(after.spent.all.pending).toBe('0');
});

// ---- VAL-READ-002 / 003 / 004: address handling and the receipt limit -------

test('summary rejects a malformed address with an English 400', async () => {
  const { app } = await setup();
  for (const address of ['0x123', 'not-an-address', `0x${'a'.repeat(41)}`]) {
    const res = await req(app, `/api/wallets/${address}/summary`);
    expect(res.status).toBe(400);
    const payload = await body(res);
    expect(payload.error).toBe('Invalid wallet address.');
    expect(/[\u3400-\u9fff]/.test(JSON.stringify(payload))).toBe(false);
  }
});

test('lowercase and checksummed addresses resolve to the same summary', async () => {
  const { app, store } = await setup();
  const day = utcDay();
  seedSpend(store, { key: keyOf(6), payer: FRESH, day, scheme: 'upto', amount: 1_000n, state: 'charged' });
  const checksummed = await summary(app, FRESH);
  const lowered = await summary(app, FRESH.toLowerCase());
  expect(checksummed.wallet).toBe(FRESH);
  expect(lowered.wallet).toBe(FRESH);
  expect(lowered.spent).toEqual(checksummed.spent);
  expect(lowered.recentReceipts).toEqual(checksummed.recentReceipts);
});

test('recentReceipts honours ?limit and defaults to 10', async () => {
  const { app, store, env } = await setup();
  for (let i = 0; i < 12; i += 1) {
    const key = keyOf(100 + i);
    store.upsertServicePayment({
      paymentKey: key,
      serviceId: 'echo',
      chainId: CHAIN_ID,
      payer: FRESH,
      payTo: providerAddress,
      asset: env.token,
      amount: '1000000',
      nonce: String(i),
      scheme: 'exact',
      createdAt: DAY_FIXED + i,
    });
    store.setServicePaymentStatus(key, 'settled', { txHash: registerTx(i + 1) });
  }

  const defaulted = await summary(app, FRESH);
  expect(defaulted.recentReceipts.length).toBe(10);
  const one = await summary(app, FRESH, '?limit=1');
  expect(one.recentReceipts.length).toBe(1);
  // Newest first, the same field set as /api/receipts.
  expect(one.recentReceipts[0].paymentKey).toBe(keyOf(111));
  const receiptKeys = await req(app, `/api/receipts?payer=${FRESH}&limit=1`);
  const receiptsPayload = await body(receiptKeys);
  expect(Object.keys(one.recentReceipts[0]).sort()).toEqual(
    Object.keys(receiptsPayload.receipts[0]).sort(),
  );

  expect((await summary(app, FRESH, '?limit=0')).recentReceipts).toEqual([]);
  const big = await summary(app, FRESH, '?limit=999');
  expect(big.recentReceipts.length).toBe(12);

  for (const bad of ['abc', '-1']) {
    const res = await req(app, `/api/wallets/${FRESH}/summary?limit=${bad}`);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('Invalid limit.');
  }
});

// ---- VAL-READ-009: the agents hint ----------------------------------------

test('summary lists the database agents that use this wallet as a hint', async () => {
  const { app } = await setup({ withProvider: true });
  const listed = await summary(app, providerAddress);
  expect(listed.agents).toEqual([
    { agentId: '0', owner: providerAddress, verifiedAt: expect.any(Number) },
  ]);
  expect((await summary(app, FRESH)).agents).toEqual([]);
});

// ---- VAL-READ-010: the owner list -----------------------------------------

test('owner agents list returns chain-owned agents and rejects bad input', async () => {
  const { app } = await setup({ withProvider: true });
  const res = await req(app, `/api/owners/${providerAddress}/agents`);
  expect(res.status).toBe(200);
  const payload = await body(res);
  expect(payload.owner).toBe(providerAddress);
  expect(payload.transferredAway).toEqual([]);
  expect(payload.agents.length).toBe(1);
  const [agent] = payload.agents;
  expect(agent.agentId).toBe('0');
  expect(agent.role).toBe('provider');
  expect(agent.agentWallet).toBe(providerAddress);
  expect(typeof agent.refreshedAt).toBe('number');
  expect(agent.ceiling).toBeNull();
  expect(agent.own).toBeNull();
  expect(agent.effective).toBeNull();
  expect(agent.spentToday).toBe('0');
  expect(agent.pendingToday).toBe('0');

  const bad = await req(app, '/api/owners/0x123/agents');
  expect(bad.status).toBe(400);
  expect((await body(bad)).error).toBe('Invalid wallet address.');

  const empty = await req(app, `/api/owners/${OWNER}/agents`);
  expect(await body(empty)).toEqual({ owner: OWNER, agents: [], transferredAway: [] });
});

test('owner list reports an agent that moved away in transferredAway', async () => {
  const env = await startChain();
  const built = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiBaseUrl: 'https://llm.example.test',
    llmBeefapiApiKey: 'sk-test-beefapi-secret-value-1234567890',
  });
  // Two agents for one owner, so one can be transferred away.
  await registerProvider(built.app, env, provider);
  await registerProvider(built.app, env, provider);

  const agents = (await body(await req(built.app, '/api/agents'))).agents as Array<{ agentId: string }>;
  expect(agents.map((agent) => agent.agentId).sort()).toEqual(['0', '1']);
  // The owner holds a ceiling on the agent that is about to move away.
  built.store.setCeiling({
    chainId: CHAIN_ID,
    agentId: '1',
    wallet: providerAddress,
    dailyLimit: 20_000n,
    signer: providerAddress,
    via: 'http',
  });

  const newOwner = getAddress('0x00000000000000000000000000000000000000bb');
  const walletClient = createWalletClient({ chain: env.viemChain, account: provider, transport: http(env.url) });
  const hash = await walletClient.writeContract({
    address: env.registry,
    abi: identityRegistryAbi,
    functionName: 'transferFrom',
    args: [providerAddress, newOwner, 1n],
  });
  const receipt = await env.client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  const onChainOwner = await env.client.readContract({
    address: env.registry,
    abi: identityRegistryAbi,
    functionName: 'ownerOf',
    args: [1n],
  });
  expect(getAddress(onChainOwner)).toBe(newOwner);

  // The new owner has no candidate yet: the database still says the old owner,
  // so the agent is invisible until a refresh writes the chain truth back.
  expect((await body(await req(built.app, `/api/owners/${newOwner}/agents`))).agents).toEqual([]);

  const listed = await body(await req(built.app, `/api/owners/${providerAddress}/agents`));
  expect(listed.agents.map((agent: { agentId: string }) => agent.agentId)).toEqual(['0']);
  expect(listed.transferredAway).toEqual([{ agentId: '1', ceiling: '20000' }]);

  // That read was the refresh: the transfer cleared the payment wallet, the row
  // moved to the new owner, and the old owner's ceiling followed to ''.
  const afterRefresh = await body(await req(built.app, `/api/owners/${newOwner}/agents`));
  expect(afterRefresh.agents.map((agent: { agentId: string }) => agent.agentId)).toEqual(['1']);
  expect(afterRefresh.agents[0].agentWallet).toBe('');
  expect(built.store.getAgent(CHAIN_ID, '1')!.owner).toBe(newOwner);
  expect(built.store.getCeiling(CHAIN_ID, '1')!.wallet).toBe('');

  // The refresh endpoint answers from the row inside the 30 s throttle window.
  const refreshed = await req(built.app, '/api/agents/1/refresh', { method: 'POST' });
  expect(refreshed.status).toBe(200);
  const refreshedBody = await body(refreshed);
  expect(refreshedBody.agent.agentId).toBe('1');
  expect(refreshedBody.agent.agentWallet).toBe('');
  expect(typeof refreshedBody.agent.refreshedAt).toBe('number');
});

test('refresh reports a payment wallet set by the owner through setAgentWallet', async () => {
  const env = await startChain();
  const built = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiBaseUrl: 'https://llm.example.test',
    llmBeefapiApiKey: 'sk-test-beefapi-secret-value-1234567890',
  });
  await registerProvider(built.app, env, provider);

  const newWallet = privateKeyToAccount(`0x${'6'.repeat(64)}` as Hex);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const signature = await newWallet.signTypedData({
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
    message: { agentId: 0n, newWallet: newWallet.address, owner: providerAddress, deadline },
  });
  const client = createWalletClient({ chain: env.viemChain, account: provider, transport: http(env.url) });
  const hash = await client.writeContract({
    address: env.registry,
    abi: identityRegistryAbi,
    functionName: 'setAgentWallet',
    args: [0n, newWallet.address, deadline, signature],
  });
  expect((await env.client.waitForTransactionReceipt({ hash })).status).toBe('success');

  const res = await req(built.app, '/api/agents/0/refresh', { method: 'POST' });
  expect(res.status).toBe(200);
  const agent = (await body(res)).agent;
  expect(agent.agentWallet).toBe(getAddress(newWallet.address));
  // The summary of the new wallet then lists the agent as a hint.
  const hint = await summary(built.app, getAddress(newWallet.address));
  expect(hint.agents.map((entry: { agentId: string }) => entry.agentId)).toEqual(['0']);
});

// ---- VAL-READ-012: staleness, the 20-candidate cap and wallet follow -------

test('owner list re-checks at most 20 stale candidates and follows wallet changes', async () => {
  let clock = DAY_FIXED;
  const registry = stubRegistry({});
  const { app, store } = await setup({ registry: registry.chain, now: () => clock });
  for (let i = 1; i <= 25; i += 1) {
    store.upsertAgent({
      chainId: CHAIN_ID,
      agentId: String(i),
      owner: OWNER,
      agentWallet: W,
      role: 'provider',
      listed: 'pending',
      agentUri: `https://example.test/agent/${i}`,
      registerTx: registerTx(i),
    });
    registry.state.set(String(i), { owner: OWNER, wallet: W });
  }
  // Every candidate is stale on the first pass, but only 20 are re-checked.
  const first = await body(await req(app, `/api/owners/${OWNER}/agents`));
  expect(first.agents.length).toBe(25);
  expect(registry.calls.ownerOf).toBe(20);
  expect(registry.calls.agentWallet).toBe(20);

  // The freshly checked 20 are skipped; only the remaining 5 are re-read.
  const second = await body(await req(app, `/api/owners/${OWNER}/agents`));
  expect(second.agents.length).toBe(25);
  expect(registry.calls.ownerOf).toBe(25);

  // A wallet rotation moves the agent row and its ceiling to the new wallet.
  store.setCeiling({
    chainId: CHAIN_ID,
    agentId: '3',
    wallet: W,
    dailyLimit: 40_000n,
    signer: OWNER,
    via: 'http',
  });
  registry.state.set('3', { owner: OWNER, wallet: W2 });
  clock = DAY_FIXED + 61_000;
  const third = await body(await req(app, `/api/owners/${OWNER}/agents`));
  const moved = third.agents.find((agent: { agentId: string }) => agent.agentId === '3')!;
  expect(moved.agentWallet).toBe(W2);
  expect(moved.ceiling).toBe('40000');
  expect(store.getAgent(CHAIN_ID, '3')!.agentWallet).toBe(W2);
  expect(store.getCeiling(CHAIN_ID, '3')!.wallet).toBe(W2);

  // A cleared wallet detaches the ceiling from every wallet.
  registry.state.set('3', { owner: OWNER, wallet: ZERO });
  clock = DAY_FIXED + 122_000;
  await req(app, `/api/owners/${OWNER}/agents`);
  expect(store.getCeiling(CHAIN_ID, '3')!.wallet).toBe('');
  expect((await summary(app, W2)).userBudget).toBeNull();
});

test('owner list keeps an agent out of the owned list when the chain read fails', async () => {
  const registry = stubRegistry({});
  const { app, store } = await setup({ registry: registry.chain });
  store.upsertAgent({
    chainId: CHAIN_ID,
    agentId: '9',
    owner: OWNER,
    agentWallet: W,
    role: 'buyer',
    listed: 'pending',
    agentUri: 'https://example.test/agent/9',
    registerTx: registerTx(9),
  });
  // The stub has no entry for agent 9, so both reads throw: the row is left
  // alone and the agent is not claimed as owned.
  registry.state.set('10', { owner: OWNER, wallet: W });
  const payload = await body(await req(app, `/api/owners/${OWNER}/agents`));
  expect(payload.agents).toEqual([]);
  expect(payload.transferredAway).toEqual([{ agentId: '9', ceiling: null }]);
  expect(store.getAgent(CHAIN_ID, '9')!.refreshedAt).toBeNull();
});

// ---- VAL-READ-013 / 014 / 015: the refresh endpoint ------------------------

test('refresh mirrors the chain wallet into the database and is throttled per agent', async () => {
  let clock = DAY_FIXED;
  const registry = stubRegistry({
    '0': { owner: OWNER, wallet: W },
    '1': { owner: OWNER, wallet: W },
  });
  const { app, store } = await setup({ registry: registry.chain, now: () => clock });
  for (const id of ['0', '1']) {
    store.upsertAgent({
      chainId: CHAIN_ID,
      agentId: id,
      owner: OWNER,
      agentWallet: W,
      role: 'buyer',
      listed: 'pending',
      agentUri: `https://example.test/agent/${id}`,
      registerTx: registerTx(Number(id)),
    });
  }

  // The ceiling was written against the stale DB wallet; the refresh drags it
  // to the wallet the chain reports.
  store.setCeiling({ chainId: CHAIN_ID, agentId: '0', wallet: W, dailyLimit: 5_000n, signer: OWNER, via: 'http' });
  registry.state.set('0', { owner: OWNER, wallet: W2 });
  const first = await req(app, '/api/agents/0/refresh', { method: 'POST' });
  expect(first.status).toBe(200);
  const firstBody = await body(first);
  expect(firstBody.agent.agentId).toBe('0');
  expect(firstBody.agent.agentWallet).toBe(W2);
  expect(firstBody.agent.refreshedAt).toBe(DAY_FIXED);
  expect(registry.calls.ownerOf).toBe(1);
  expect(store.getCeiling(CHAIN_ID, '0')!.wallet).toBe(W2);
  expect((await summary(app, W2)).userBudget!.ceiling.dailyLimit).toBe('5000');

  // Inside 30 s the throttle answers from the database: same refreshedAt, no RPC.
  clock = DAY_FIXED + 29_000;
  const throttled = await body(await req(app, '/api/agents/0/refresh', { method: 'POST' }));
  expect(throttled.agent.refreshedAt).toBe(DAY_FIXED);
  expect(registry.calls.ownerOf).toBe(1);

  // The throttle is per agent: agent 1 was never refreshed.
  const other = await body(await req(app, '/api/agents/1/refresh', { method: 'POST' }));
  expect(other.agent.refreshedAt).toBe(clock);
  expect(registry.calls.ownerOf).toBe(2);

  // Past 30 s the next refresh reads the chain again and moves the timestamp.
  clock = DAY_FIXED + 31_000;
  registry.state.set('0', { owner: OWNER, wallet: W });
  const third = await body(await req(app, '/api/agents/0/refresh', { method: 'POST' }));
  expect(third.agent.refreshedAt).toBe(clock);
  expect(third.agent.agentWallet).toBe(W);
  expect(registry.calls.ownerOf).toBe(3);
  // The ceiling moved back to the wallet the chain now reports.
  expect(store.getCeiling(CHAIN_ID, '0')!.wallet).toBe(W);
});

test('refresh of an unknown or malformed agent is an English 4xx and inserts nothing', async () => {
  const { app, store } = await setup({ withProvider: true });
  const before = store.listAgents().length;

  const unknown = await req(app, '/api/agents/999999/refresh', { method: 'POST' });
  expect(unknown.status).toBe(404);
  expect((await body(unknown)).error).toBe('Agent not found.');

  const malformed = await req(app, '/api/agents/abc/refresh', { method: 'POST' });
  expect([400, 404]).toContain(malformed.status);
  expect(/[\u3400-\u9fff]/.test(JSON.stringify(await body(malformed)))).toBe(false);

  expect(store.listAgents().length).toBe(before);
});

test('refresh reports a 503 when the registry cannot be read', async () => {
  const registry = stubRegistry({});
  const { app, store } = await setup({ registry: registry.chain });
  store.upsertAgent({
    chainId: CHAIN_ID,
    agentId: '4',
    owner: OWNER,
    agentWallet: W,
    role: 'buyer',
    listed: 'pending',
    agentUri: 'https://example.test/agent/4',
    registerTx: registerTx(4),
  });
  const res = await req(app, '/api/agents/4/refresh', { method: 'POST' });
  expect(res.status).toBe(503);
  expect((await body(res)).error).toBe('Could not read the identity registry. Try again.');
  expect(store.getAgent(CHAIN_ID, '4')!.refreshedAt).toBeNull();
});

// ---- VAL-READ-016: the provider catalog -----------------------------------

test('providers groups the catalog by provider agent with draft profile fields', async () => {
  const { app } = await setup({ withProvider: true });
  const res = await req(app, '/api/providers');
  expect(res.status).toBe(200);
  const payload = await body(res);
  expect(payload.providers.length).toBe(1);
  const [entry] = payload.providers;
  expect(Object.keys(entry).sort()).toEqual([
    'agentId',
    'agentWallet',
    'description',
    'image',
    'listed',
    'name',
    'services',
  ]);
  expect(entry.agentId).toBe('0');
  expect(entry.name).toBe('Demo Provider');
  expect(entry.image).toBeNull();
  expect(entry.agentWallet).toBe(providerAddress);
  expect(entry.listed).toBe('pending');

  const services = entry.services as Array<Record<string, unknown>>;
  expect(services.map((service) => service.serviceId)).toEqual([
    'echo',
    'llm-glm-5-3',
    'llm-claude-opus-5-5',
    'llm-gpt-6-astra',
    'video-gemini-3-8-flash',
  ]);
  expect(services[0]).toMatchObject({ pricing: 'exact', price: '1000000' });
  expect(services.slice(1).map((service) => service.quoteMax)).toEqual([
    '19040',
    '36800',
    '69000',
    '38600',
  ]);
  for (const service of services.slice(1)) {
    expect(service.pricing).toBe('metered');
    expect(typeof service.modelId).toBe('string');
    expect(Object.keys(service).sort()).toEqual([
      'description',
      'modelId',
      'pricing',
      'quoteMax',
      'serviceId',
    ]);
  }
  // No two provider entries share an agentId.
  expect(new Set(payload.providers.map((p: { agentId: string }) => p.agentId)).size).toBe(1);
});

test('providers never exposes draft-only fields', async () => {
  const { app } = await setup({ withProvider: true });
  const res = await req(app, '/api/providers');
  const payload = await body(res);
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain('profile_json');
  expect(serialized).not.toContain('contact');
  expect(serialized).not.toContain('draftId');
  expect(payload.providers[0].description).toBeNull();
  expect(payload.providers[0].image).toBeNull();
});
