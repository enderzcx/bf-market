import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PERMIT2_ADDRESS } from '@x402/evm';
import { runtimeConfig, runtimeFingerprint } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import { createSource } from '../src/source.ts';
import { createStore } from '../src/store.ts';
import type { Chain, Payout, Prepared } from '../src/types.ts';
import { createWorker } from '../src/worker.ts';
import { UPTO_PERMIT2_PROXY } from '../src/x402/index.ts';
import {
  AGENT_KEY,
  BUYER_KEY,
  LOCAL_KEY,
  OPS_KEY,
  PRICE,
  approvePermit2,
  buildApp,
  closeAll,
  manualPayload,
  mintUsdt,
  registerProvider,
  req,
  startChain,
} from './m6-harness.ts';

const BOTCHAIN_USDT = '0x75edC9335175Fc0552D51D48439F229c10420fe3' as Address;
const BEEFAPI_KEY = 'sk-test-beefapi-secret-value-1234567890';

const extraClosers: Array<() => void> = [];
afterEach(async () => {
  while (extraClosers.length) extraClosers.pop()?.();
  await closeAll();
});

// Minimal botchain-configured app: no paid services are wired, but the public
// receipt and stats endpoints must still render a correct explorer link.
function buildBotchainApp() {
  const dir = mkdtempSync(join(tmpdir(), 'settlement-skill-'));
  const publicDir = join(dir, 'public');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'index.html'), '<html></html>');
  const config = runtimeConfig({
    port: 4311,
    chain: { rpcUrl: 'https://rpc.bohr.life', chainId: 968, token: BOTCHAIN_USDT },
    publicDir,
    dbPath: join(dir, 'db.sqlite'),
    lockPath: join(dir, 'lock'),
    source: 'fixture',
    agentOrigin: 'https://market.example',
  });
  const store = createStore({
    path: join(dir, 'db.sqlite'),
    fingerprint: runtimeFingerprint(config),
  });
  extraClosers.push(() => store.close());
  const chain: Chain = {
    async prepare(p: Payout): Promise<Prepared> {
      return { rawTransaction: keccak256(toHex(`raw:${p.id}`)), hash: keccak256(toHex(`h:${p.id}`)) };
    },
    async broadcast() {},
    async inspect() {
      return 'confirmed' as const;
    },
    async balances() {
      return { token: '0', gas: '0' };
    },
  };
  const source = createSource(store, config);
  const worker = createWorker({ store, chain, source, config });
  const app = createApp({ store, worker, chain, source, config, publicDir });
  return { app, store, config };
}

test('skill.md is generated from the live network config and catalog', async () => {
  const env = await startChain();
  const { app } = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiApiKey: BEEFAPI_KEY,
  });
  await registerProvider(app, env, privateKeyToAccount(AGENT_KEY));

  const res = await req(app, '/skill.md');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/markdown');
  const md = await res.text();

  // Copyable prompt at the top points at this origin's skill.md.
  expect(md).toContain(`Read ${app.origin}/skill.md and use BF Market`);
  expect(md).toContain('# BF Market');

  // Current network parameters.
  expect(md).toContain('chain 31337');
  expect(md).toContain('eip155:31337');
  expect(md).toContain(getAddress(env.token));
  expect(md).toContain(PERMIT2_ADDRESS);
  expect(md).toContain(UPTO_PERMIT2_PROXY);
  expect(md).toContain(getAddress(env.registry));

  // Every listed service appears, with its model and id.
  for (const id of ['echo', 'llm-glm-5-3', 'llm-claude-opus-5-5', 'llm-gpt-6-astra']) {
    expect(md).toContain(id);
  }
  expect(md).toContain('glm-5.3');
  expect(md).toContain('claude-opus-5-5');

  // Each row states the limits of its own input shape.
  const rowOf = (id: string) => md.split('\n').find((line) => line.startsWith(`| \`${id}\` |`)) ?? '';
  expect(rowOf('llm-glm-5-3')).toContain('total input <= 8000 chars');
  const videoRow = rowOf('video-gemini-3-8-flash');
  expect(videoRow).toContain('video_url: public https mp4, mov or webm, <= 20 MB; prompt <= 4000 chars');
  expect(videoRow).toContain('quote assumes 64000 input tokens');
  expect(videoRow).not.toContain('8000 chars');

  // The minimal example is runnable and never asks for a shared key.
  expect(md).toContain("from '@x402/core/client'");
  expect(md).toContain("from '@x402/evm/upto/client'");
  expect(md).toContain('AGENT_PRIVATE_KEY');
  expect(md).toContain('Never share this key');

  // No secrets, no internal paths, no implementation names.
  const dump = md;
  expect(dump).not.toContain(BEEFAPI_KEY);
  expect(dump).not.toContain(LOCAL_KEY.slice(2));
  expect(dump).not.toContain(OPS_KEY.slice(2));
  expect(dump).not.toContain('opsPrivateKey');
  expect(dump).not.toContain('SETTLEMENT_OPS_PRIVATE_KEY');
  expect(dump).not.toContain('journal');
  expect(dump).not.toContain('/Volumes/');
  expect(dump).not.toContain('.local');
  expect(dump).not.toContain('process.cwd');
  // The local network has no public faucet, so none is advertised.
  expect(dump).not.toContain('faucet.botchain.ai');
});

test('skill.md points new wallets at the BOT Chain faucet', async () => {
  const { app, config } = buildBotchainApp();
  const faucet = 'https://faucet.botchain.ai/basic';
  expect(config.network.faucetUrl).toBe(faucet);

  const md = await (await req(app, '/skill.md')).text();
  expect(md).toContain(`| Faucet (test tBOT and USDT) | ${faucet} (human verification required) |`);
  expect(md).toContain(`Test tBOT and test USDT both come from the faucet at ${faucet}.`);
  expect(md).toContain(`top up the buyer wallet with testnet USDT from ${faucet}.`);
});

test('skill.md is precise about results, schemes, approvals and charges', async () => {
  const env = await startChain();
  const { app } = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiApiKey: BEEFAPI_KEY,
  });
  await registerProvider(app, env, privateKeyToAccount(AGENT_KEY));

  const md = await (await req(app, '/skill.md')).text();

  // A delivered body is { result: <output> }, not the bare output object.
  expect(md).toContain('{ "result": <output> }');
  expect(md).toContain('read `json.result`');

  // Metered services offer upto only; fixed-price services offer exact.
  expect(md).toContain('A metered service offers one option, `upto`');
  expect(md).toContain('A fixed-price service offers `exact`');

  // The ERC-20 approve spender is Permit2 itself, never a proxy.
  expect(md).toContain('The ERC-20 `approve` target is Permit2 itself');
  expect(md).toContain(`(${'`'}${PERMIT2_ADDRESS}${'`'})`);
  expect(md).toContain('not approve targets');

  // The call URL is in the prose, and discovery.resource is authoritative.
  expect(md).toContain(`${app.origin}/api/services/{serviceId}/call`);
  expect(md).toContain('`resource` field of `/discovery/resources` is the authoritative URL');

  // The example checks the status and names 502 as uncharged.
  expect(md).toContain('if (paid.status !== 200)');
  expect(md).toContain('you were not charged');

  // The actual charge is shown from the settlement header and the body.
  expect(md).toContain('settle.amount');
  expect(md).toContain('result.charged');
  expect(md).toContain('/api/receipts');

  // The metered quote is fixed, and the daily limits come from config.
  expect(md).toContain('Quote per call (max)');
  expect(md).toContain('the same fixed maximum for every request');
  expect(md).toContain('at most 5.00 USDC per wallet and 50.00 USDC platform-wide');

  // Install command and the tested client versions.
  expect(md).toContain('bun add viem @x402/core @x402/evm');
  expect(md).toContain('2.26.0 and 2.28.0');

  // MCP passes the same payload in the documented _meta key.
  expect(md).toContain('_meta["x402/payment"]');
});

test('the service table follows the catalog', async () => {
  const env = await startChain();

  // No provider registered: nothing is listed.
  const empty = buildApp(env, { llmServicesEnabled: true, llmBeefapiApiKey: BEEFAPI_KEY });
  const emptyMd = await (await req(empty.app, '/skill.md')).text();
  expect(emptyMd).toContain('No service is listed right now.');

  // Provider registered: the echo service appears.
  await registerProvider(empty.app, env, privateKeyToAccount(AGENT_KEY));
  const md = await (await req(empty.app, '/skill.md')).text();
  expect(md).toContain('| `echo` |');
  expect(md).not.toContain('No service is listed right now.');
});

test('skill.md, llms.txt and the catalog use the configured public origin', async () => {
  const env = await startChain();
  const { app } = buildApp(env, { agentOrigin: 'https://market.example' });
  await registerProvider(app, env, privateKeyToAccount(AGENT_KEY));

  const md = await (await req(app, '/skill.md')).text();
  expect(md).toContain('Read https://market.example/skill.md and use BF Market');
  expect(md).toContain('https://market.example/api/agents/challenge');
  expect(md).not.toContain(app.origin);

  const llms = await req(app, '/llms.txt');
  expect(llms.status).toBe(200);
  expect(llms.headers.get('content-type')).toContain('text/plain');
  const txt = await llms.text();
  expect(txt).toContain('https://market.example/skill.md');
  expect(txt).toContain('https://market.example/discovery/resources');
  expect(txt).toContain('https://market.example/mcp');
  // The summary line names the network this deployment actually settles on.
  expect(txt).toContain('Agent commerce platform on Local testnet.');

  const catalog = (await (await req(app, '/discovery/resources')).json()) as {
    items: Array<{ resource: string }>;
  };
  expect(catalog.items[0]!.resource).toBe(
    'https://market.example/api/services/echo/call',
  );
});

test('receipts list is payer-scoped, redacted, and requires the payer', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  const buyer = privateKeyToAccount(BUYER_KEY);
  await registerProvider(app, env, agent);
  await mintUsdt(env, buyer.address, 10n * PRICE);
  await approvePermit2(env, buyer, 10n * PRICE);

  const offer = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
  });
  const requirement = ((await offer.json()) as { accepts: Array<Record<string, unknown>> })
    .accepts[0] as never;
  const signed = await manualPayload({ requirement, account: buyer, chainId: 31337 });
  const paid = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
    paymentSignature: signed.header,
  });
  expect(paid.status).toBe(200);

  const list = await req(app, `/api/receipts?payer=${buyer.address}`);
  expect(list.status).toBe(200);
  const { receipts } = (await list.json()) as { receipts: Array<Record<string, unknown>> };
  expect(receipts).toHaveLength(1);
  const receipt = receipts[0]!;
  expect(receipt.serviceId).toBe('echo');
  expect(receipt.status).toBe('delivered');
  expect(receipt.amount).toBe(PRICE.toString());
  expect(receipt.charged).toBe(PRICE.toString());
  expect(receipt.providerAgentId).toBe('0');
  expect(receipt.usage).toBeNull();
  expect(receipt.network).toBe('eip155:31337');
  const settlement = receipt.settlement as { txHash: string; explorerUrl: string | null };
  expect(settlement.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  // The local profile has no explorer.
  expect(settlement.explorerUrl).toBeNull();

  // Redaction: no signature, journal, result payload, upstream detail or error.
  const dump = JSON.stringify(receipts);
  for (const forbidden of ['journal', 'resultJson', 'upstream', 'signature', '"error"']) {
    expect(dump).not.toContain(forbidden);
  }

  // The payer is mandatory and must be a valid address.
  expect((await req(app, '/api/receipts')).status).toBe(400);
  expect((await req(app, '/api/receipts?payer=')).status).toBe(400);
  expect((await req(app, '/api/receipts?payer=not-an-address')).status).toBe(400);

  // Another address sees nothing; the limit is honored and validated.
  const other = await req(
    app,
    '/api/receipts?payer=0x0000000000000000000000000000000000000009',
  );
  expect(((await other.json()) as { receipts: unknown[] }).receipts).toHaveLength(0);
  const zero = await req(app, `/api/receipts?payer=${buyer.address}&limit=0`);
  expect(((await zero.json()) as { receipts: unknown[] }).receipts).toHaveLength(0);
  expect((await req(app, `/api/receipts?payer=${buyer.address}&limit=-1`)).status).toBe(400);
  expect((await req(app, `/api/receipts?payer=${buyer.address}&limit=x`)).status).toBe(400);

  // Single receipt by key.
  const key = String(receipt.paymentKey);
  const one = await req(app, `/api/receipts/${key}`);
  expect(one.status).toBe(200);
  expect(((await one.json()) as { receipt: { paymentKey: string } }).receipt.paymentKey).toBe(key);
  expect((await req(app, `/api/receipts/0x${'0'.repeat(64)}`)).status).toBe(404);
  expect((await req(app, '/api/receipts/not-a-key')).status).toBe(400);
});

test('receipts report only money that actually moved', async () => {
  const { app, store } = buildBotchainApp();
  const payer = '0x00000000000000000000000000000000000000cc' as Address;
  const payTo = '0x00000000000000000000000000000000000000dd' as Address;
  const seed = (label: string, amount: string, scheme: string) =>
    store.upsertServicePayment({
      paymentKey: keccak256(toHex(label)) as Hex,
      serviceId: 'echo',
      chainId: 968,
      payer,
      payTo,
      asset: BOTCHAIN_USDT,
      amount,
      nonce: label,
      scheme,
    });

  // Failed: the upstream call failed and nothing settled, so the receipt must
  // not report the signed upper bound as a charge.
  const failed = seed('receipt-failed', '719', 'upto');
  store.setServicePaymentStatus(failed.paymentKey, 'failed', {
    error: 'The model provider call failed. You were not charged.',
  });

  // Delivered metered call: the actual usage charge is reported.
  const metered = seed('receipt-metered', '719', 'upto');
  store.setServicePaymentStatus(metered.paymentKey, 'settled', {
    txHash: `0x${'11'.repeat(32)}` as Hex,
    chargedAmount: '26',
  });
  store.markServicePaymentDelivered(metered.paymentKey, JSON.stringify({ ok: true }), {
    chargedAmount: '26',
    consumed: true,
  });

  // Delivered exact call: no chargedAmount, so the fixed price is the charge.
  const exact = seed('receipt-exact', '500', 'exact');
  store.setServicePaymentStatus(exact.paymentKey, 'settled', {
    txHash: `0x${'22'.repeat(32)}` as Hex,
  });
  store.markServicePaymentDelivered(exact.paymentKey, JSON.stringify({ ok: true }), {
    consumed: true,
  });

  // In-flight: nothing settled yet, so the charge is unknown, not zero.
  const settling = seed('receipt-settling', '719', 'upto');
  store.setServicePaymentStatus(settling.paymentKey, 'settling', {
    txHash: `0x${'33'.repeat(32)}` as Hex,
    journal: `0x${'44'.repeat(32)}` as Hex,
  });

  const res = await req(app, `/api/receipts?payer=${payer}`);
  expect(res.status).toBe(200);
  const { receipts } = (await res.json()) as {
    receipts: Array<{ paymentKey: string; status: string; charged: string | null }>;
  };
  const byKey = new Map(receipts.map((receipt) => [receipt.paymentKey, receipt]));
  expect(byKey.get(failed.paymentKey)!.status).toBe('failed');
  expect(byKey.get(failed.paymentKey)!.charged).toBe('0');
  expect(byKey.get(metered.paymentKey)!.charged).toBe('26');
  expect(byKey.get(exact.paymentKey)!.charged).toBe('500');
  expect(byKey.get(settling.paymentKey)!.status).toBe('settling');
  expect(byKey.get(settling.paymentKey)!.charged).toBeNull();

  // The single-receipt route shares the same projection.
  const one = await req(app, `/api/receipts/${failed.paymentKey}`);
  expect(one.status).toBe(200);
  expect(((await one.json()) as { receipt: { charged: string } }).receipt.charged).toBe('0');
});

test('public stats count paid calls, settled USDT, payers and agents', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  const buyer = privateKeyToAccount(BUYER_KEY);
  await registerProvider(app, env, agent);

  const before = (await (await req(app, '/api/stats/public')).json()) as Record<string, unknown>;
  expect(before).toEqual({ calls: 0, settledUsdt: '0', payers: 0, agents: 1 });

  await mintUsdt(env, buyer.address, 10n * PRICE);
  await approvePermit2(env, buyer, 10n * PRICE);
  const offer = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
  });
  const requirement = ((await offer.json()) as { accepts: Array<Record<string, unknown>> })
    .accepts[0] as never;
  const signed = await manualPayload({ requirement, account: buyer, chainId: 31337 });
  await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
    paymentSignature: signed.header,
  });

  const after = (await (await req(app, '/api/stats/public')).json()) as Record<string, unknown>;
  expect(after).toEqual({ calls: 1, settledUsdt: PRICE.toString(), payers: 1, agents: 1 });
  // The stats response never lists addresses.
  expect(JSON.stringify(after)).not.toContain(buyer.address);
});

test('receipts expose a block explorer link when the network has one', async () => {
  const { app, store } = buildBotchainApp();
  const payer = '0x00000000000000000000000000000000000000aa' as Address;
  const payTo = '0x00000000000000000000000000000000000000bb' as Address;
  const paymentKey = keccak256(toHex('botchain-receipt')) as Hex;
  const txHash = `0x${'ab'.repeat(32)}` as Hex;

  store.upsertServicePayment({
    paymentKey,
    serviceId: 'echo',
    chainId: 968,
    payer,
    payTo,
    asset: BOTCHAIN_USDT,
    amount: '1000000',
    nonce: '1',
  });
  store.setServicePaymentStatus(paymentKey, 'settled', { txHash, chargedAmount: '1000000' });
  store.markServicePaymentDelivered(paymentKey, JSON.stringify({ ok: true }), {
    chargedAmount: '1000000',
    consumed: true,
  });

  const res = await req(app, `/api/receipts?payer=${payer}`);
  expect(res.status).toBe(200);
  const { receipts } = (await res.json()) as {
    receipts: Array<{ settlement: { txHash: string; explorerUrl: string | null } }>;
  };
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.settlement.txHash).toBe(txHash);
  expect(receipts[0]!.settlement.explorerUrl).toBe(`https://scan.bohr.life/tx/${txHash}`);

  // The skill text uses the configured public origin on this network too.
  const md = await (await req(app, '/skill.md')).text();
  expect(md).toContain('https://market.example/skill.md');
  expect(md).toContain('chain 968');
  expect(md).toContain(BOTCHAIN_USDT);
});

test('skill.md explains the daily budget and the two-step signing flow', async () => {
  const env = await startChain();
  const { app } = buildApp(env, { llmServicesEnabled: true, llmBeefapiApiKey: BEEFAPI_KEY });
  await registerProvider(app, env, privateKeyToAccount(AGENT_KEY));

  const md = await (await req(app, '/skill.md')).text();

  // A section titled "Daily budget".
  expect(md).toMatch(/^## \d+\. Daily budget$/m);

  // Effective value: the smaller of the owner ceiling and the wallet's value.
  expect(md).toContain('is the smaller of two values');
  expect(md).toContain("the owner's ceiling");
  expect(md).toContain("the wallet's own value");

  // It covers every paid service, including echo.
  expect(md).toContain('every paid service, including `echo`');

  // The payment wallet may only set a value at or below the owner's ceiling.
  expect(md).toContain("at or below the owner's ceiling");

  // Admission uses the quoted maximum per call.
  expect(md).toContain('quoted maximum per call');

  // Two-step signing, both over HTTP and over MCP.
  expect(md).toContain(`${app.origin}/api/budgets/challenge`);
  expect(md).toContain(`${app.origin}/api/budgets`);
  expect(md).toContain('set_wallet_budget');
  expect(md).toContain('personal_sign');

  // Reading the current state.
  expect(md).toContain(`${app.origin}/api/wallets/{address}/summary`);

  // Both new 429 texts, and the existing two stay verbatim.
  expect(md).toContain('Daily budget set by the agent owner is reached.');
  expect(md).toContain('Daily budget reached for this wallet.');
  expect(md).toContain('Daily spending limit reached for this payer.');
  expect(md).toContain('The daily model budget is exhausted.');

  // The MCP tool list carries both budget tools.
  expect(md).toContain('`get_wallet_summary`');
  expect(md).toContain('`set_wallet_budget`');

  // Every word the agent reads stays English.
  expect(md).not.toMatch(/[\u4e00-\u9fff]/);
});

test('skill.md scopes the platform daily limits to LLM services only', async () => {
  const env = await startChain();
  const { app } = buildApp(env, { llmServicesEnabled: true, llmBeefapiApiKey: BEEFAPI_KEY });
  await registerProvider(app, env, privateKeyToAccount(AGENT_KEY));

  const md = await (await req(app, '/skill.md')).text();

  expect(md).toContain('apply to LLM (metered) services only');
  expect(md).toContain('at most 5.00 USDC per wallet and 50.00 USDC platform-wide');
  // Echo is never described as covered by the platform caps.
  expect(md).not.toMatch(/echo[^.]*platform(-| )wide/i);
});

test('llms.txt lists the daily budget entry points', async () => {
  const env = await startChain();
  const { app } = buildApp(env, { agentOrigin: 'https://market.example' });

  const res = await req(app, '/llms.txt');
  expect(res.status).toBe(200);
  const txt = await res.text();

  expect(txt).toContain('https://market.example/api/wallets/{address}/summary');
  expect(txt).toContain('https://market.example/api/budgets');
  // The existing lines stay.
  expect(txt).toContain('https://market.example/skill.md');
  expect(txt).toContain('https://market.example/discovery/resources');
  expect(txt).toContain('https://market.example/mcp');
  expect(txt).toContain('https://market.example/api/receipts?payer=0x...');
  expect(txt).toContain('https://market.example/api/stats/public');
});

