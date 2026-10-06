import { afterEach, expect, test } from 'bun:test';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decodePaymentRequiredHeader } from '../src/x402/index.ts';
import {
  AGENT_KEY,
  buildApp,
  closeAll,
  PRICE,
  registerProvider,
  req,
  startChain,
} from './m6-harness.ts';

afterEach(async () => {
  await closeAll();
});

type DiscoveryItem = {
  resource: string;
  type: string;
  x402Version: number;
  accepts: Array<Record<string, unknown>>;
  description: string;
  mimeType: string;
  lastUpdated: string;
  extensions: { bazaar?: { info?: { input?: Record<string, unknown> }; schema?: unknown } };
  provider: {
    agentId: string;
    agentRegistry: string | null;
    name: string;
    role: string;
    agentWallet: string;
    agentUri: string;
  };
};

type DiscoveryList = {
  x402Version: number;
  items: DiscoveryItem[];
  pagination: { limit: number; offset: number; total: number };
};

async function offer(app: ReturnType<typeof buildApp>['app']) {
  const res = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
  });
  expect(res.status).toBe(402);
  return decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED')!) as {
    x402Version: number;
    accepts: Array<Record<string, unknown>>;
    extensions?: {
      bazaar?: { info?: { input?: Record<string, unknown> }; schema?: unknown };
    };
  };
}

test('discovery lists available services in the Bazaar format with matching payment terms', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  await registerProvider(app, env, agent);

  const res = await req(app, '/discovery/resources');
  expect(res.status).toBe(200);
  const body = (await res.json()) as DiscoveryList;
  expect(body.x402Version).toBe(2);
  expect(body.pagination).toEqual({ limit: 50, offset: 0, total: 1 });
  expect(body.items).toHaveLength(1);

  const item = body.items[0]!;
  expect(item.resource).toBe(`${app.origin}/api/services/echo/call`);
  expect(item.type).toBe('http');
  expect(item.x402Version).toBe(2);
  expect(item.description).toBe('Echo test service: returns the request body unchanged.');
  expect(item.mimeType).toBe('application/json');
  expect(Number.isNaN(Date.parse(item.lastUpdated))).toBe(false);

  // accepts must equal the 402 offer exactly (same source of truth).
  const { accepts } = await offer(app);
  expect(item.accepts).toEqual(accepts);
  expect(item.accepts[0]!.scheme).toBe('exact');
  expect(item.accepts[0]!.network).toBe('eip155:31337');
  expect(item.accepts[0]!.amount).toBe(PRICE.toString());
  expect(getAddress(String(item.accepts[0]!.asset))).toBe(getAddress(env.token));
  expect(getAddress(String(item.accepts[0]!.payTo))).toBe(getAddress(agent.address));
  expect((item.accepts[0]!.extra as { assetTransferMethod?: string }).assetTransferMethod).toBe(
    'permit2',
  );

  // Bazaar extension: http input with body example and an output example.
  expect(item.extensions.bazaar?.info?.input?.type).toBe('http');
  expect(item.extensions.bazaar?.info?.input?.method).toBe('POST');
  expect(item.extensions.bazaar?.info?.input?.body).toEqual({ hello: 'world' });
  expect(item.extensions.bazaar?.schema).toBeDefined();

  // A delivered result is the HTTP body { result: <output> }, so the output
  // example carries the same envelope an agent will actually read.
  const output = (
    item.extensions.bazaar?.info as { output?: { example?: unknown } } | undefined
  )?.output;
  expect(output?.example).toEqual({
    result: { ok: true, serviceId: 'echo', echo: { hello: 'world' } },
  });

  // Provider metadata. The local ERC-8004 registry assigns agentId 0 to the
  // first registrant, and the echo service is configured for that provider.
  expect(item.provider.agentId).toBe('0');
  expect(item.provider.agentRegistry).toBe(`eip155:31337:${getAddress(env.registry)}`);
  expect(item.provider.name).toBe('Demo Provider');
  expect(item.provider.agentWallet).toBe(getAddress(agent.address));
  expect(item.provider.agentUri).toContain('/registrations/');
});

test('the 402 offer carries the bazaar extension so facilitators can catalog it', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  await registerProvider(app, env, privateKeyToAccount(AGENT_KEY));

  const required = await offer(app);
  const bazaar = required.extensions?.bazaar;
  expect(bazaar).toBeDefined();
  const input = bazaar?.info?.input as Record<string, unknown>;
  expect(input.type).toBe('http');
  expect(input.method).toBe('POST');
  expect(input.bodyType).toBe('json');
  expect(bazaar?.schema).toBeDefined();
});

test('unavailable services are not listed', async () => {
  const env = await startChain();

  // No provider registered at all.
  const missing = buildApp(env);
  const empty = (await (await req(missing.app, '/discovery/resources')).json()) as DiscoveryList;
  expect(empty.items).toHaveLength(0);
  expect(empty.pagination.total).toBe(0);

  // Registered but pending, with approval required.
  const strict = buildApp(env, { servicesRequireApproved: true });
  await registerProvider(strict.app, env, privateKeyToAccount(AGENT_KEY));
  const gated = (await (await req(strict.app, '/discovery/resources')).json()) as DiscoveryList;
  expect(gated.items).toHaveLength(0);
});

test('discovery supports the filter and pagination parameters it understands', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  await registerProvider(app, env, agent);

  const byType = (await (await req(app, '/discovery/resources?type=http')).json()) as DiscoveryList;
  expect(byType.items).toHaveLength(1);
  const wrongType = (await (await req(app, '/discovery/resources?type=mcp')).json()) as DiscoveryList;
  expect(wrongType.items).toHaveLength(0);

  const byPayTo = (await (
    await req(app, `/discovery/resources?payTo=${agent.address}`)
  ).json()) as DiscoveryList;
  expect(byPayTo.items).toHaveLength(1);
  const otherPayTo = (await (
    await req(app, '/discovery/resources?payTo=0x0000000000000000000000000000000000000009')
  ).json()) as DiscoveryList;
  expect(otherPayTo.items).toHaveLength(0);

  const byNetwork = (await (
    await req(app, '/discovery/resources?network=eip155:31337&scheme=exact')
  ).json()) as DiscoveryList;
  expect(byNetwork.items).toHaveLength(1);

  const limited = (await (await req(app, '/discovery/resources?limit=0')).json()) as DiscoveryList;
  expect(limited.items).toHaveLength(0);
  expect(limited.pagination.total).toBe(1);
  const offset = (await (await req(app, '/discovery/resources?offset=1')).json()) as DiscoveryList;
  expect(offset.items).toHaveLength(0);

  const bad = await req(app, '/discovery/resources?limit=-1');
  expect(bad.status).toBe(400);
  const badPayTo = await req(app, '/discovery/resources?payTo=not-an-address');
  expect(badPayTo.status).toBe(400);
});

test('search returns matching catalog entries', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  await registerProvider(app, env, privateKeyToAccount(AGENT_KEY));

  const hit = (await (await req(app, '/discovery/search?query=echo')).json()) as {
    resources: DiscoveryItem[];
  };
  expect(hit.resources).toHaveLength(1);
  expect(hit.resources[0]!.resource).toBe(`${app.origin}/api/services/echo/call`);

  const miss = (await (
    await req(app, '/discovery/search?query=nonexistent-service')
  ).json()) as { resources: DiscoveryItem[] };
  expect(miss.resources).toHaveLength(0);
});
