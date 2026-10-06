import { afterEach, expect, test } from 'bun:test';
import { runtimeConfig } from '../src/config.ts';
import { createBunDb } from '../src/db-bun.ts';
import { migrateSchema } from '../src/db.ts';
import { createStore } from '../src/store.ts';
import { createSeedHandler } from '../worker/seed.ts';

const TOKEN = 'seed-token-for-tests';
const CHAIN_ID = 968;
const TOKEN_ADDRESS = '0x75edC9335175Fc0552D51D48439F229c10420fe3';
const OWNER = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada';
const DRAFT_ID = 'eeca2761506b1446354a5b5ab313527b';
const AGENT_URI = `https://market.bflabs.app/registrations/${DRAFT_ID}.json`;
const TX = `0x${'a'.repeat(64)}` as `0x${string}`;

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

function build() {
  const db = createBunDb(':memory:');
  migrateSchema(db);
  const store = createStore({ path: ':memory:', db });
  closers.push(() => store.close());
  const config = runtimeConfig({
    port: 4311,
    chain: {
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: CHAIN_ID,
      token: TOKEN_ADDRESS,
    },
  });
  return { store, config };
}

function payload(): {
  agents: Array<Record<string, unknown>>;
  drafts: Array<Record<string, unknown>>;
} {
  return {
    agents: [
      {
        chainId: CHAIN_ID,
        agentId: '0',
        owner: OWNER,
        agentWallet: OWNER,
        role: 'buyer',
        listed: 'approved',
        agentUri: AGENT_URI,
        registerTx: TX,
        blockNumber: '25797002',
        createdAt: 1791207238793,
      },
    ],
    drafts: [
      {
        draftId: DRAFT_ID,
        address: OWNER,
        role: 'buyer',
        profile: {
          name: 'BF Market Demo Buyer',
          services: [{ name: 'web', endpoint: 'https://market.bflabs.app/' }],
          description: 'Demo buyer',
          x402Support: false,
          active: true,
        },
        createdAt: 1791207233780,
        registeredAgentId: '0',
      },
    ],
  };
}

function request(body: unknown, token: string | null = TOKEN): Request {
  return new Request('http://127.0.0.1:8787/internal/seed', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token == null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('rejects a missing or wrong token with 401', async () => {
  const { store, config } = build();
  const handler = createSeedHandler({ store, config, token: TOKEN });
  expect((await handler(request(payload(), null))).status).toBe(401);
  expect((await handler(request(payload(), 'nope'))).status).toBe(401);
  expect(store.seedState()).toEqual({ seeded: false, agents: 0, drafts: 0 });
});

test('answers 404 when no seed token is configured', async () => {
  const { store, config } = build();
  const handler = createSeedHandler({ store, config, token: undefined });
  expect((await handler(request(payload()))).status).toBe(404);
});

test('refuses to seed a non-empty ledger with 409', async () => {
  const { store, config } = build();
  store.upsertAgent({
    chainId: CHAIN_ID,
    agentId: '9',
    owner: OWNER,
    agentWallet: OWNER,
    role: 'buyer',
    listed: 'approved',
    agentUri: AGENT_URI,
    registerTx: TX,
  });
  const handler = createSeedHandler({ store, config, token: TOKEN });
  expect((await handler(request(payload()))).status).toBe(409);
  expect(store.seedState()).toEqual({ seeded: false, agents: 1, drafts: 0 });
});

test('imports agents and drafts in one transaction', async () => {
  const { store, config } = build();
  const handler = createSeedHandler({ store, config, token: TOKEN });
  const res = await handler(request(payload()));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, agents: 1, drafts: 1 });
  expect(store.getAgent(CHAIN_ID, '0')?.agentUri).toBe(AGENT_URI);
  expect(store.getAgentDraft(DRAFT_ID)?.registeredAgentId).toBe('0');
  expect(store.seedState()).toEqual({ seeded: true, agents: 1, drafts: 1 });
});

test('answers 410 after a successful import', async () => {
  const { store, config } = build();
  const handler = createSeedHandler({ store, config, token: TOKEN });
  expect((await handler(request(payload()))).status).toBe(200);
  expect((await handler(request(payload()))).status).toBe(410);
});

test('rejects an invalid body with 400 and writes nothing', async () => {
  const { store, config } = build();
  const handler = createSeedHandler({ store, config, token: TOKEN });
  expect((await handler(request('not json'))).status).toBe(400);
  const badOwner = payload();
  badOwner.agents[0]!.owner = 'not-an-address';
  expect((await handler(request(badOwner))).status).toBe(400);
  const badRole = payload();
  badRole.drafts[0]!.role = 'seller';
  expect((await handler(request(badRole))).status).toBe(400);
  expect(store.seedState()).toEqual({ seeded: false, agents: 0, drafts: 0 });
});

test('rejects an agent whose chainId is not the current network', async () => {
  const { store, config } = build();
  const handler = createSeedHandler({ store, config, token: TOKEN });
  const bad = payload();
  bad.agents[0]!.chainId = 1;
  expect((await handler(request(bad))).status).toBe(400);
  expect(store.seedState()).toEqual({ seeded: false, agents: 0, drafts: 0 });
});

test('rolls back every row when the import fails mid-transaction', async () => {
  const { store, config } = build();
  const handler = createSeedHandler({ store, config, token: TOKEN });
  const conflicting = payload();
  conflicting.agents.push({
    ...conflicting.agents[0]!,
    owner: '0x9Fb2A80007047d249F5926960d870cD8aB5E7A4A',
  });
  const res = await handler(request(conflicting));
  expect(res.status).toBe(409);
  expect(store.seedState()).toEqual({ seeded: false, agents: 0, drafts: 0 });
});
