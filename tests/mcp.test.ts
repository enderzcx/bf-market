import { afterEach, expect, test } from 'bun:test';
import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AgentRegistryChain } from '../src/agent-registry.ts';
import type { SettlementApp } from '../src/server.ts';
import { decodePaymentRequiredHeader } from '../src/x402/index.ts';
import {
  AGENT_KEY,
  BUYER_KEY,
  approvePermit2,
  balanceOf,
  buildApp,
  closeAll,
  createMcpClient,
  LOCAL_KEY,
  manualPayload,
  mintUsdt,
  OPS_KEY,
  PRICE,
  registerProvider,
  req,
  startChain,
} from './m6-harness.ts';

afterEach(async () => {
  await closeAll();
});

type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: string; required?: string[]; properties?: Record<string, unknown> };
};

type ToolResult = {
  content?: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

async function listTools(client: ReturnType<typeof createMcpClient>): Promise<ToolDef[]> {
  const res = await client.rpc('tools/list');
  return (res.result as { tools: ToolDef[] }).tools;
}

// A stub registry keeps the budget-tool tests off a chain round trip while
// still exercising the owner/wallet identity rules the real registry enforces.
function stubRegistry(entries: Record<string, { owner: Address; wallet: Address }> = {}) {
  const state = new Map(Object.entries(entries));
  const chain: AgentRegistryChain = {
    async getChainId() {
      return 31337;
    },
    async getFinalizedReceipt() {
      return null;
    },
    async readOwnerOf(agentId) {
      const entry = state.get(String(agentId));
      if (!entry) throw new Error('agent not found');
      return entry.owner;
    },
    async readAgentWallet(agentId) {
      const entry = state.get(String(agentId));
      if (!entry) throw new Error('agent not found');
      return entry.wallet;
    },
  };
  return chain;
}

const walletSummaryOf = async (app: SettlementApp, address: string) =>
  (await (await req(app, `/api/wallets/${address}/summary`)).json()) as Record<string, any>;

test('initialize and tools/list expose the tool set and schemas', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const client = createMcpClient(app);

  const init = await client.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  });
  const result = init.result as {
    protocolVersion: string;
    capabilities: { tools?: unknown };
    serverInfo: { name: string };
  };
  expect(result.protocolVersion).toBe('2025-06-18');
  expect(result.capabilities.tools).toBeDefined();
  expect(result.serverInfo.name).toBe('bf-market');
  expect(typeof client.session()).toBe('string');

  const tools = await listTools(client);
  expect(tools.map((t) => t.name).sort()).toEqual([
    'call_service',
    'get_service',
    'get_wallet_summary',
    'platform_info',
    'register_agent_info',
    'search_services',
    'set_wallet_budget',
  ]);
  for (const tool of tools) {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema.type).toBe('object');
  }
  const call = tools.find((t) => t.name === 'call_service')!;
  expect(call.inputSchema.required).toEqual(['serviceId']);
  expect(call.inputSchema.properties?.serviceId).toBeDefined();
  const get = tools.find((t) => t.name === 'get_service')!;
  expect(get.inputSchema.required).toEqual(['serviceId']);

  // The two budget tools: the summary reader takes a wallet, and the writer
  // takes the intent plus the two-step signature.
  const summaryTool = tools.find((t) => t.name === 'get_wallet_summary')!;
  expect(summaryTool.inputSchema.required).toEqual(['wallet']);
  expect(summaryTool.inputSchema.properties?.wallet).toBeDefined();
  const budgetTool = tools.find((t) => t.name === 'set_wallet_budget')!;
  expect(budgetTool.inputSchema.required).toEqual(['wallet', 'dailyLimit']);
  for (const name of ['wallet', 'dailyLimit', 'scope', 'agentId', 'signer', 'signature']) {
    expect(budgetTool.inputSchema.properties?.[name]).toBeDefined();
  }

  // Streamable HTTP: GET is not supported, DELETE terminates the session.
  const getRes = await req(app, '/mcp', { method: 'GET' });
  expect(getRes.status).toBe(405);
  const deleteRes = await req(app, '/mcp', { method: 'DELETE' });
  expect(deleteRes.status).toBe(204);
});

test('platform_info and register_agent_info return guidance without private key material', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const client = createMcpClient(app);

  const info = (await client.call('platform_info', {})).result as ToolResult;
  expect(info.isError).toBeUndefined();
  expect(info.content?.[0]?.text).toContain('BF Market');
  expect(info.content?.[0]?.text).toContain('x402');
  expect(info.content?.[0]?.text).toContain('ERC-8004');
  expect(info.content?.[0]?.text).toContain('Permit2');
  // Metered pricing is explained with the upto scheme alongside exact.
  expect(info.content?.[0]?.text).toContain('Metered services');
  expect(info.content?.[0]?.text).toContain('upto');
  expect(info.content?.[0]?.text).toContain('exact');
  const structured = info.structuredContent as {
    networks: Array<{ chainId: number; caip2: string }>;
    registry: string;
    payment: { transferMethod: string; schemes: string[] };
  };
  expect(structured.networks[0]!.chainId).toBe(31337);
  expect(structured.networks[0]!.caip2).toBe('eip155:31337');
  expect(structured.registry).toBe(getAddress(env.registry));
  expect(structured.payment.transferMethod).toBe('permit2');
  expect(structured.payment.schemes).toEqual(['exact', 'upto']);

  const reg = (await client.call('register_agent_info', {})).result as ToolResult;
  const regStructured = reg.structuredContent as {
    chainId: number;
    registry: string;
    endpoints: Record<string, string>;
  };
  expect(regStructured.chainId).toBe(31337);
  expect(regStructured.endpoints.challenge).toBe(`${app.origin}/api/agents/challenge`);
  expect(regStructured.endpoints.drafts).toBe(`${app.origin}/api/agents/drafts`);
  expect(regStructured.endpoints.confirm).toBe(`${app.origin}/api/agents/confirm`);

  // The MCP surface must never leak key material or the ops key configuration.
  const tools = await listTools(client);
  const dump = JSON.stringify({ tools, info, reg });
  expect(dump).not.toContain('privateKey');
  expect(dump).not.toContain('PRIVATE_KEY');
  expect(dump).not.toContain('opsPrivateKey');
  expect(dump).not.toContain(LOCAL_KEY.slice(2));
  expect(dump).not.toContain(OPS_KEY.slice(2));
  // Every word an agent reads from the MCP surface is English.
  expect(dump).not.toMatch(/[\u4e00-\u9fff]/);
});

test('search_services and get_service agree with the discovery catalog', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  await registerProvider(app, env, agent);
  const client = createMcpClient(app);

  const search = (await client.call('search_services', { query: 'echo' })).result as ToolResult;
  const services = (search.structuredContent as { services: Array<{ resource: string }> }).services;
  expect(services).toHaveLength(1);

  const detail = (await client.call('get_service', { serviceId: 'echo' })).result as ToolResult;
  const item = detail.structuredContent as { resource: string; accepts: unknown[] };

  const catalog = (await (await req(app, '/discovery/resources')).json()) as {
    items: Array<{ resource: string; accepts: unknown[] }>;
  };
  expect(item.resource).toBe(catalog.items[0]!.resource);
  expect(item.accepts).toEqual(catalog.items[0]!.accepts);

  const filtered = (await client.call('search_services', { query: 'echo', maxPrice: '1' })).result as ToolResult;
  expect((filtered.structuredContent as { services: unknown[] }).services).toHaveLength(0);
});

test('call_service without payment returns the payment requirements with the mcp bazaar extension', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  await registerProvider(app, env, agent);
  const client = createMcpClient(app);

  const first = (await client.call('call_service', { serviceId: 'echo', body: { hello: 'world' } }))
    .result as ToolResult;
  expect(first.isError).toBe(true);
  const required = first.structuredContent as {
    x402Version: number;
    accepts: Array<Record<string, unknown>>;
    extensions?: { bazaar?: { info?: { input?: Record<string, unknown> } } };
  };
  expect(required.x402Version).toBe(2);
  expect(required.accepts).toHaveLength(1);
  expect(required.accepts[0]!.amount).toBe(PRICE.toString());
  expect(getAddress(String(required.accepts[0]!.payTo))).toBe(getAddress(agent.address));
  const input = required.extensions?.bazaar?.info?.input as Record<string, unknown>;
  expect(input.type).toBe('mcp');
  expect(input.toolName).toBe('call_service');
  expect(input.inputSchema).toBeDefined();
  // MCP delivers the bare output as structuredContent, so its example has no
  // HTTP `{ result }` envelope.
  const output = required.extensions?.bazaar?.info as { output?: { example?: unknown } };
  expect(output.output?.example).toEqual({ ok: true, serviceId: 'echo', echo: { hello: 'world' } });
  // content text mirrors structuredContent, per the transport spec.
  expect(first.content?.[0]?.text).toBe(JSON.stringify(required));

  const unknown = (await client.call('get_service', { serviceId: 'nope' })).result as ToolResult;
  expect(unknown.isError).toBe(true);
});

test('a paid MCP call settles, delivers, and a repeat does not settle again', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  const buyer = privateKeyToAccount(BUYER_KEY);
  await registerProvider(app, env, agent);
  await mintUsdt(env, buyer.address, 10n * PRICE);
  await approvePermit2(env, buyer, 10n * PRICE);
  const client = createMcpClient(app);

  const offer = (await client.call('call_service', { serviceId: 'echo', body: { hello: 'world' } }))
    .result as ToolResult;
  const requirement = (offer.structuredContent as { accepts: Array<Record<string, unknown>> })
    .accepts[0]! as never;
  const signed = await manualPayload({ requirement, account: buyer, chainId: 31337 });

  const opsAddress = privateKeyToAccount(OPS_KEY).address;
  const opsBefore = await env.client.getTransactionCount({ address: opsAddress });
  const payToBefore = await balanceOf(env, agent.address);

  const paid = (
    await client.call(
      'call_service',
      { serviceId: 'echo', body: { hello: 'world' } },
      { 'x402/payment': signed.payload },
    )
  ).result as ToolResult;
  expect(paid.isError).toBeUndefined();
  expect(paid.structuredContent).toEqual({ ok: true, serviceId: 'echo', echo: { hello: 'world' } });
  expect(paid.content?.[0]?.text).toBe(JSON.stringify(paid.structuredContent));
  const settle = paid._meta?.['x402/payment-response'] as { success: boolean; transaction: string };
  expect(settle.success).toBe(true);
  expect(settle.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect(await balanceOf(env, agent.address)).toBe(payToBefore + PRICE);
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore + 1);

  const repeat = (
    await client.call(
      'call_service',
      { serviceId: 'echo', body: { hello: 'world' } },
      { 'x402/payment': signed.payload },
    )
  ).result as ToolResult;
  expect(repeat.structuredContent).toEqual(paid.structuredContent);
  expect((repeat._meta?.['x402/payment-response'] as { transaction: string }).transaction).toBe(
    settle.transaction,
  );
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore + 1);
  expect(await balanceOf(env, agent.address)).toBe(payToBefore + PRICE);
});

test('the same payment over HTTP and MCP settles and delivers only once', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  const buyer = privateKeyToAccount(BUYER_KEY);
  await registerProvider(app, env, agent);
  await mintUsdt(env, buyer.address, 10n * PRICE);
  await approvePermit2(env, buyer, 10n * PRICE);
  const client = createMcpClient(app);

  const httpOffer = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
  });
  const required = decodePaymentRequiredHeader(httpOffer.headers.get('PAYMENT-REQUIRED')!) as {
    accepts: Array<Record<string, unknown>>;
  };
  const signed = await manualPayload({
    requirement: required.accepts[0] as never,
    account: buyer,
    chainId: 31337,
  });

  const opsAddress = privateKeyToAccount(OPS_KEY).address;
  const opsBefore = await env.client.getTransactionCount({ address: opsAddress });
  const payToBefore = await balanceOf(env, agent.address);

  const httpPaid = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
    paymentSignature: signed.header,
  });
  expect(httpPaid.status).toBe(200);
  const httpBody = (await httpPaid.json()) as { result: unknown };
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore + 1);

  // Replaying the same signed payment through MCP must reuse the delivered
  // result, not settle again.
  const mcpPaid = (
    await client.call(
      'call_service',
      { serviceId: 'echo', body: { hello: 'world' } },
      { 'x402/payment': signed.payload },
    )
  ).result as ToolResult;
  expect(mcpPaid.structuredContent).toEqual(httpBody.result);
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore + 1);
  expect(await balanceOf(env, agent.address)).toBe(payToBefore + PRICE);
});

// ---- Budget tools (VAL-AGENT-001..005) -------------------------------------

const budgetOwner = privateKeyToAccount(`0x${'c'.repeat(64)}` as Hex);
const budgetWallet = privateKeyToAccount(`0x${'d'.repeat(64)}` as Hex);

test('get_wallet_summary matches the HTTP wallet summary', async () => {
  const env = await startChain();
  const { app } = buildApp(env, { agentRegistryChain: stubRegistry() });
  const client = createMcpClient(app);
  const wallet = getAddress(`0x${'a'.repeat(40)}`);

  const tool = (await client.call('get_wallet_summary', { wallet })).result as ToolResult;
  expect(tool.isError).toBeUndefined();
  const viaTool = tool.structuredContent as Record<string, unknown>;
  const http = await walletSummaryOf(app, wallet);
  for (const key of ['wallet', 'day', 'userBudget', 'platform', 'spent', 'remaining']) {
    expect(viaTool[key]).toEqual(http[key]);
  }
  // content mirrors structuredContent, per the transport spec.
  expect(tool.content?.[0]?.text).toBe(JSON.stringify(viaTool));

  const bad = (await client.call('get_wallet_summary', { wallet: '0x123' })).result as ToolResult;
  expect(bad.isError).toBe(true);
  expect(bad.content?.[0]?.text).toContain('Invalid wallet address.');
  expect(JSON.stringify(bad)).not.toMatch(/[\u4e00-\u9fff]/);
});

test('set_wallet_budget without a signature returns a challenge and changes nothing', async () => {
  const env = await startChain();
  const { app } = buildApp(env, { agentRegistryChain: stubRegistry() });
  const client = createMcpClient(app);
  const wallet = getAddress(budgetWallet.address);
  expect((await walletSummaryOf(app, wallet)).userBudget).toBeNull();

  const issued = (
    await client.call('set_wallet_budget', { wallet, dailyLimit: '20000' })
  ).result as ToolResult;
  expect(issued.isError).toBeUndefined();
  const challenge = issued.structuredContent as { message: string; expiresAt: number };
  expect(challenge.message).toContain("Scope: wallet's own budget");
  expect(challenge.message).toContain('Daily budget: 0.02 USDC (20000)');
  expect(typeof challenge.expiresAt).toBe('number');

  // Issuing a challenge writes no budget row.
  expect((await walletSummaryOf(app, wallet)).userBudget).toBeNull();
});

test('set_wallet_budget submits a signed change and matches HTTP', async () => {
  const env = await startChain();
  const { app, store } = buildApp(env, { agentRegistryChain: stubRegistry() });
  const client = createMcpClient(app);
  const wallet = getAddress(budgetWallet.address);

  const issued = (
    await client.call('set_wallet_budget', { wallet, dailyLimit: '20000' })
  ).result as ToolResult;
  const { message } = issued.structuredContent as { message: string };

  const submitted = (
    await client.call('set_wallet_budget', {
      wallet,
      dailyLimit: '20000',
      signer: wallet,
      signature: await budgetWallet.signMessage({ message }),
    })
  ).result as ToolResult;
  expect(submitted.isError).toBeUndefined();
  const viaTool = submitted.structuredContent as Record<string, any>;
  expect(viaTool.userBudget.own.dailyLimit).toBe('20000');
  expect(viaTool.userBudget.effective).toBe('20000');
  expect(viaTool.userBudget.source).toBe('own');

  const http = await walletSummaryOf(app, wallet);
  expect(viaTool.userBudget).toEqual(http.userBudget);

  // The audit trail records the MCP transport.
  const event = store.listBudgetEvents(wallet)[0]!;
  expect(event.via).toBe('mcp');
  expect(event.scope).toBe('wallet');
  expect(event.dailyLimit).toBe(20000n);
});

test('set_wallet_budget drives the owner ceiling flow over MCP', async () => {
  const env = await startChain();
  const wallet = getAddress(budgetWallet.address);
  const owner = getAddress(budgetOwner.address);
  const { app, store } = buildApp(env, {
    agentRegistryChain: stubRegistry({ 7: { owner, wallet } }),
  });
  const client = createMcpClient(app);
  const args = {
    wallet,
    dailyLimit: '50000',
    scope: 'ceiling',
    agentId: '7',
    signer: owner,
  };

  const issued = (await client.call('set_wallet_budget', args)).result as ToolResult;
  const { message } = issued.structuredContent as { message: string };
  expect(message).toContain('Scope: owner ceiling for agent #7');

  const submitted = (
    await client.call('set_wallet_budget', {
      ...args,
      signature: await budgetOwner.signMessage({ message }),
    })
  ).result as ToolResult;
  expect(submitted.isError).toBeUndefined();
  const summary = submitted.structuredContent as Record<string, any>;
  expect(summary.userBudget.effective).toBe('50000');
  expect(summary.userBudget.source).toBe('ceiling');
  expect(summary.userBudget.ceiling.agentId).toBe('7');

  const event = store.listBudgetEvents(wallet)[0]!;
  expect(event.scope).toBe('ceiling');
  expect(event.via).toBe('mcp');
  expect(event.agentId).toBe('7');

  // The HTTP surface reads the same row.
  expect((await walletSummaryOf(app, wallet)).userBudget.effective).toBe('50000');
});

test('set_wallet_budget returns the same English errors as HTTP', async () => {
  const env = await startChain();
  const wallet = getAddress(budgetWallet.address);
  const owner = getAddress(budgetOwner.address);
  const { app } = buildApp(env, {
    agentRegistryChain: stubRegistry({ 7: { owner, wallet } }),
  });
  const client = createMcpClient(app);
  const ceilingArgs = {
    wallet,
    dailyLimit: '50000',
    scope: 'ceiling',
    agentId: '7',
    signer: owner,
  };

  // Ceiling 50000 first, then W tries to set its own value above it.
  const ceilingIssued = (await client.call('set_wallet_budget', ceilingArgs)).result as ToolResult;
  const ceilingMessage = (ceilingIssued.structuredContent as { message: string }).message;
  await client.call('set_wallet_budget', {
    ...ceilingArgs,
    signature: await budgetOwner.signMessage({ message: ceilingMessage }),
  });

  const overIssued = (
    await client.call('set_wallet_budget', { wallet, dailyLimit: '100000' })
  ).result as ToolResult;
  const overMessage = (overIssued.structuredContent as { message: string }).message;
  const over = (
    await client.call('set_wallet_budget', {
      wallet,
      dailyLimit: '100000',
      signer: wallet,
      signature: await budgetWallet.signMessage({ message: overMessage }),
    })
  ).result as ToolResult;
  expect(over.isError).toBe(true);
  expect(over.content?.[0]?.text).toBe(
    "The daily budget exceeds the owner's limit of 0.05 USDC.",
  );

  // The owner cannot sign for the wallet's own budget.
  const foreignIssued = (
    await client.call('set_wallet_budget', { wallet, dailyLimit: '30000', signer: owner })
  ).result as ToolResult;
  const foreignMessage = (foreignIssued.structuredContent as { message: string }).message;
  const foreign = (
    await client.call('set_wallet_budget', {
      wallet,
      dailyLimit: '30000',
      signer: owner,
      signature: await budgetOwner.signMessage({ message: foreignMessage }),
    })
  ).result as ToolResult;
  expect(foreign.isError).toBe(true);
  expect(foreign.content?.[0]?.text).toBe('The signer is not allowed to set this budget.');

  // A used signature cannot be submitted twice.
  const ownIssued = (
    await client.call('set_wallet_budget', { wallet, dailyLimit: '30000' })
  ).result as ToolResult;
  const ownMessage = (ownIssued.structuredContent as { message: string }).message;
  const ownSignature = await budgetWallet.signMessage({ message: ownMessage });
  const ownBody = { wallet, dailyLimit: '30000', signer: wallet, signature: ownSignature };
  const first = (await client.call('set_wallet_budget', ownBody)).result as ToolResult;
  expect(first.isError).toBeUndefined();
  const replay = (await client.call('set_wallet_budget', ownBody)).result as ToolResult;
  expect(replay.isError).toBe(true);
  expect(replay.content?.[0]?.text).toContain('This challenge was already used.');
});

