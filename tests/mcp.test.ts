import { afterEach, expect, test } from 'bun:test';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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
    'platform_info',
    'register_agent_info',
    'search_services',
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
