import { afterEach, expect, test } from 'bun:test';
import { createWalletClient, getAddress, http, parseAbi, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader as decodeOfficialRequired,
  decodePaymentResponseHeader as decodeOfficialResponse,
  x402HTTPClient,
} from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { PERMIT2_ADDRESS, uptoPermit2WitnessTypes } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { permit2PaymentKey, UPTO_PERMIT2_PROXY } from '../src/x402/index.ts';
import type { X402PaymentRequirements } from '../src/x402/types.ts';
import {
  AGENT_KEY,
  BUYER_KEY,
  OPS_KEY,
  balanceOf,
  buildApp,
  closeAll,
  createMcpClient,
  mintUsdt,
  registerProvider,
  req,
  startChain,
} from './m6-harness.ts';

const stubClosers: Array<() => void> = [];
afterEach(async () => {
  while (stubClosers.length) stubClosers.pop()?.();
  await closeAll();
});

const SERVICE = 'llm-glm-5-3';
const PATH = `/api/services/${SERVICE}/call`;
const KEY = 'sk-test-beefapi-secret-value-1234567890';
const opsAddress = getAddress(privateKeyToAccount(OPS_KEY).address);
const approveAbi = parseAbi(['function approve(address,uint256) returns (bool)']);

type ChainEnv = Awaited<ReturnType<typeof startChain>>;
type Stub = ReturnType<typeof startStub>;

// Deterministic stub for the BeefAPI chat endpoint. Records every request so a
// test can assert the upstream was called exactly once and inspect the body.
function startStub() {
  const state = {
    status: 200,
    delayMs: 0,
    usage: { prompt_tokens: 10, completion_tokens: 20 },
    content: 'Hello from the model.',
    id: 'chatcmpl-test-1',
  };
  const calls: Array<{
    authorization: string | null;
    body: Record<string, unknown>;
  }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ authorization: request.headers.get('authorization'), body });
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (state.status !== 200) {
        return new Response(JSON.stringify({ error: 'upstream boom' }), {
          status: state.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return Response.json({
        id: state.id,
        choices: [{ message: { role: 'assistant', content: state.content } }],
        usage: state.usage,
      });
    },
  });
  const stub = {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    state,
  };
  stubClosers.push(() => server.stop(true));
  return stub;
}

async function setup(opts: {
  stub: Stub;
  llmServicesEnabled?: boolean;
  llmBeefapiApiKey?: string;
  llmPayerDailyCapAtomic?: bigint;
  llmGlobalDailyCapAtomic?: bigint;
  llmRequestTimeoutMs?: number;
}) {
  const env = await startChain();
  const built = buildApp(env, {
    llmServicesEnabled: opts.llmServicesEnabled ?? true,
    llmBeefapiBaseUrl: opts.stub.url,
    llmBeefapiApiKey: opts.llmBeefapiApiKey ?? KEY,
    llmPayerDailyCapAtomic: opts.llmPayerDailyCapAtomic,
    llmGlobalDailyCapAtomic: opts.llmGlobalDailyCapAtomic,
    llmRequestTimeoutMs: opts.llmRequestTimeoutMs,
  });
  await registerProvider(built.app, env, privateKeyToAccount(AGENT_KEY));
  return { env, ...built };
}

function bodyFor(content = 'hello world', maxTokens?: number): Record<string, unknown> {
  const body: Record<string, unknown> = { messages: [{ role: 'user', content }] };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  return body;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// Mirrors src/llm.ts: ceil(chars/2) prompt tokens, integer retail prices, and a
// 10% output headroom on the completion allowance in the quoted upper bound.
function expectedUpperBound(content: string, maxTokens: number): bigint {
  const inputTokens = BigInt(Math.ceil(content.length / 2));
  const outputTokens = ceilDiv(BigInt(maxTokens) * 11n, 10n);
  return ceilDiv(inputTokens * 1_000_000n, 1_000_000n) + ceilDiv(outputTokens * 3_200_000n, 1_000_000n);
}

function expectedCharge(prompt: number, completion: number): bigint {
  return ceilDiv(BigInt(prompt) * 1_000_000n, 1_000_000n) + ceilDiv(BigInt(completion) * 3_200_000n, 1_000_000n);
}

async function fetchOffer(app: ReturnType<typeof buildApp>['app'], body: Record<string, unknown>) {
  const res = await req(app, PATH, { method: 'POST', body: JSON.stringify(body) });
  expect(res.status).toBe(402);
  const required = decodeOfficialRequired(res.headers.get('PAYMENT-REQUIRED')!) as {
    x402Version: number;
    accepts: X402PaymentRequirements[];
    extensions?: { bazaar?: { info?: { input?: Record<string, unknown> } } };
  };
  const upto = required.accepts.find((a) => a.scheme === 'upto')!;
  const exact = required.accepts.find((a) => a.scheme === 'exact')!;
  return { res, required, upto, exact };
}

// Manual upto payload so negative cases can tweak one field at a time.
async function manualUptoPayload(input: {
  requirement: X402PaymentRequirements;
  account: ReturnType<typeof privateKeyToAccount>;
  chainId: number;
  amount?: string;
  payTo?: Address;
  facilitator?: Address;
  spender?: Address;
  deadline?: string;
  validAfter?: string;
  nonce?: string;
  signWith?: ReturnType<typeof privateKeyToAccount>;
}) {
  const now = Math.floor(Date.now() / 1000);
  const nonce =
    input.nonce ??
    BigInt(
      `0x${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`,
    ).toString();
  const auth = {
    from: getAddress(input.account.address),
    permitted: {
      token: getAddress(input.requirement.asset),
      amount: input.amount ?? input.requirement.amount,
    },
    spender: getAddress(input.spender ?? UPTO_PERMIT2_PROXY),
    nonce,
    deadline: input.deadline ?? String(now + input.requirement.maxTimeoutSeconds),
    witness: {
      to: getAddress(input.payTo ?? input.requirement.payTo),
      facilitator: getAddress(
        input.facilitator ?? (input.requirement.extra.facilitatorAddress as string),
      ),
      validAfter: input.validAfter ?? '0',
    },
  };
  const signer = input.signWith ?? input.account;
  const signature = await signer.signTypedData({
    domain: { name: 'Permit2', chainId: input.chainId, verifyingContract: getAddress(PERMIT2_ADDRESS) },
    types: uptoPermit2WitnessTypes,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: getAddress(auth.permitted.token), amount: BigInt(auth.permitted.amount) },
      spender: getAddress(auth.spender),
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      witness: {
        to: getAddress(auth.witness.to),
        facilitator: getAddress(auth.witness.facilitator),
        validAfter: BigInt(auth.witness.validAfter),
      },
    },
  });
  const payload = {
    x402Version: 2,
    accepted: { ...input.requirement },
    payload: { signature, permit2Authorization: auth },
  };
  return {
    payload,
    header: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    nonce,
    payer: getAddress(input.account.address),
  };
}

async function approvePermit2(
  env: ChainEnv,
  account: ReturnType<typeof privateKeyToAccount>,
  amount: bigint,
) {
  const wallet = createWalletClient({ chain: env.viemChain, account, transport: http(env.url) });
  await env.client.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address: env.token,
      abi: approveAbi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, amount],
    }),
  });
}

async function fundAndApprove(
  env: ChainEnv,
  account: ReturnType<typeof privateKeyToAccount>,
  amount: bigint,
) {
  await mintUsdt(env, account.address, amount);
  await approvePermit2(env, account, amount);
}

test('the metered 402 quotes an upper bound with upto and exact options', async () => {
  const stub = startStub();
  const { app } = await setup({ stub });
  const { required, upto, exact } = await fetchOffer(app, bodyFor('hello world'));

  const upper = expectedUpperBound('hello world', 1000);
  // 6 input tokens (11 chars / 2) + ceil(1000 * 1.1) = 1100 output tokens.
  expect(upper).toBe(3526n);

  expect(required.x402Version).toBe(2);
  expect(required.accepts).toHaveLength(2);
  expect(upto.scheme).toBe('upto');
  expect(upto.amount).toBe(upper.toString());
  expect(exact.scheme).toBe('exact');
  expect(exact.amount).toBe(upper.toString());
  expect((upto.extra as { facilitatorAddress?: string }).facilitatorAddress).toBe(opsAddress);
  expect((upto.extra as { assetTransferMethod?: string }).assetTransferMethod).toBe('permit2');
  expect(getAddress(String(upto.payTo))).toBe(getAddress(privateKeyToAccount(AGENT_KEY).address));
  // Bazaar discovery advertises the request schema for the body.
  const schema = required.extensions?.bazaar?.info?.input?.inputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  expect(schema?.properties?.messages).toBeDefined();
  expect(stub.calls).toHaveLength(0);
});

test('upto settles the actual token cost and delivers once', async () => {
  const stub = startStub();
  const { env, app, store } = await setup({ stub });
  const buyer = privateKeyToAccount(BUYER_KEY);
  await fundAndApprove(env, buyer, 10_000_000n);

  const body = bodyFor('hello world');
  const { required } = await fetchOffer(app, body);
  const core = new x402Client()
    .setSpendControls(false)
    .register('eip155:31337', new UptoEvmScheme(buyer));
  const client = new x402HTTPClient(core);
  const payload = await client.createPaymentPayload(required as unknown as PaymentRequired);
  const encoded = client.encodePaymentSignatureHeader(payload);

  const opsBefore = await env.client.getTransactionCount({ address: opsAddress });
  const payToBefore = await balanceOf(env, privateKeyToAccount(AGENT_KEY).address);

  const paid = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: encoded['PAYMENT-SIGNATURE']!,
  });
  expect(paid.status).toBe(200);
  const result = (await paid.json()) as {
    result: { content: string; charged: string; usage: Record<string, number> };
  };
  const charge = expectedCharge(10, 20);
  expect(charge).toBe(74n);
  expect(result.result.content).toBe('Hello from the model.');
  expect(result.result.charged).toBe(charge.toString());
  expect(result.result.usage.prompt_tokens).toBe(10);
  expect(result.result.usage.completion_tokens).toBe(20);

  const settle = decodeOfficialResponse(paid.headers.get('PAYMENT-RESPONSE')!);
  expect(settle.success).toBe(true);
  expect(settle.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect((settle as { amount?: string }).amount).toBe(charge.toString());

  // Exactly the actual charge moved, which is below the quoted upper bound.
  const payToAfter = await balanceOf(env, privateKeyToAccount(AGENT_KEY).address);
  expect(payToAfter - payToBefore).toBe(charge);
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore + 1);
  expect(stub.calls).toHaveLength(1);
  expect(stub.calls[0]!.authorization).toBe(`Bearer ${KEY}`);
  expect(stub.calls[0]!.body.user).toBe(buyer.address.toLowerCase());
  expect(stub.calls[0]!.body.stream).toBe(false);

  // Replaying the same payload returns the same result without re-calling the
  // model or settling again.
  const again = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: encoded['PAYMENT-SIGNATURE']!,
  });
  expect(again.status).toBe(200);
  expect(((await again.json()) as { result: unknown }).result).toEqual(result.result);
  expect(stub.calls).toHaveLength(1);
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore + 1);
  const record = store.getServicePayment(
    permit2PaymentKey({
      chainId: 31337,
      payer: buyer.address,
      nonce: (payload.payload as { permit2Authorization: { nonce: string } }).permit2Authorization
        .nonce,
    }),
  );
  expect(record?.status).toBe('delivered');
  expect(record?.consumed).toBe(true);
  expect(record?.chargedAmount).toBe(charge.toString());
});

test('a zero usage charge sends no transaction and cannot be settled later', async () => {
  const stub = startStub();
  stub.state.usage = { prompt_tokens: 0, completion_tokens: 0 };
  const { env, app, store } = await setup({ stub });
  const buyer = privateKeyToAccount(BUYER_KEY);
  await fundAndApprove(env, buyer, 10_000_000n);

  const body = bodyFor('hello world');
  const { required } = await fetchOffer(app, body);
  const core = new x402Client()
    .setSpendControls(false)
    .register('eip155:31337', new UptoEvmScheme(buyer));
  const client = new x402HTTPClient(core);
  const payload = await client.createPaymentPayload(required as unknown as PaymentRequired);
  const encoded = client.encodePaymentSignatureHeader(payload);

  const opsBefore = await env.client.getTransactionCount({ address: opsAddress });
  const payToBefore = await balanceOf(env, privateKeyToAccount(AGENT_KEY).address);

  const paid = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: encoded['PAYMENT-SIGNATURE']!,
  });
  expect(paid.status).toBe(200);
  const result = (await paid.json()) as { result: { charged: string } };
  expect(result.result.charged).toBe('0');
  const settle = decodeOfficialResponse(paid.headers.get('PAYMENT-RESPONSE')!);
  expect(settle.transaction).toBe('');
  expect((settle as { amount?: string }).amount).toBe('0');

  // No on-chain transfer and no ops transaction.
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore);
  expect(await balanceOf(env, privateKeyToAccount(AGENT_KEY).address)).toBe(payToBefore);

  const nonce = (payload.payload as { permit2Authorization: { nonce: string } })
    .permit2Authorization.nonce;
  const record = store.getServicePayment(
    permit2PaymentKey({ chainId: 31337, payer: buyer.address, nonce }),
  );
  expect(record?.consumed).toBe(true);

  // The payload is consumed, so a later submission returns the cached result
  // and still cannot be settled.
  const again = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: encoded['PAYMENT-SIGNATURE']!,
  });
  expect(again.status).toBe(200);
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore);
});

test('an unsettled failure can retry the same payload until the deadline', async () => {
  const stub = startStub();
  stub.state.status = 500;
  const { env, app } = await setup({ stub });
  const buyer = privateKeyToAccount(BUYER_KEY);
  await fundAndApprove(env, buyer, 10_000_000n);

  const body = bodyFor('hello world');
  const { upto } = await fetchOffer(app, body);
  const signed = await manualUptoPayload({ requirement: upto, account: buyer, chainId: 31337 });

  const failed = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(failed.status).toBe(502);
  expect(stub.calls).toHaveLength(1);

  // The signature was not consumed, so the same payload may retry and now settle.
  stub.state.status = 200;
  const retried = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(retried.status).toBe(200);
  const result = (await retried.json()) as { result: { charged: string } };
  expect(result.result.charged).toBe(expectedCharge(10, 20).toString());
  expect(stub.calls).toHaveLength(2);
  const settle = decodeOfficialResponse(retried.headers.get('PAYMENT-RESPONSE')!);
  expect(settle.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
});

test('an upstream error settles nothing and returns 502', async () => {  const stub = startStub();
  stub.state.status = 500;
  const { env, app, store } = await setup({ stub });
  const buyer = privateKeyToAccount(BUYER_KEY);
  await fundAndApprove(env, buyer, 10_000_000n);

  const body = bodyFor('hello world');
  const { upto } = await fetchOffer(app, body);
  const signed = await manualUptoPayload({ requirement: upto, account: buyer, chainId: 31337 });
  const opsBefore = await env.client.getTransactionCount({ address: opsAddress });

  const res = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(502);
  const error = (await res.json()) as { error: string };
  expect(error.error).not.toContain(KEY);
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore);
  const record = store.getServicePayment(
    permit2PaymentKey({ chainId: 31337, payer: signed.payer, nonce: signed.nonce }),
  );
  expect(record?.status).toBe('failed');
  expect(record?.consumed).toBe(false);
});

test('an upstream timeout settles nothing', async () => {
  const stub = startStub();
  stub.state.delayMs = 400;
  const { env, app } = await setup({ stub, llmRequestTimeoutMs: 100 });
  const buyer = privateKeyToAccount(BUYER_KEY);
  await fundAndApprove(env, buyer, 10_000_000n);

  const body = bodyFor('hello world');
  const { upto } = await fetchOffer(app, body);
  const signed = await manualUptoPayload({ requirement: upto, account: buyer, chainId: 31337 });
  const opsBefore = await env.client.getTransactionCount({ address: opsAddress });

  const res = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(502);
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore);
});

test('a permitted amount that does not match the quote is rejected', async () => {
  const stub = startStub();
  const { env, app } = await setup({ stub });
  const buyer = privateKeyToAccount(BUYER_KEY);
  await fundAndApprove(env, buyer, 10_000_000n);

  const body = bodyFor('hello world');
  const { upto } = await fetchOffer(app, body);
  const signed = await manualUptoPayload({
    requirement: upto,
    account: buyer,
    chainId: 31337,
    amount: (BigInt(upto.amount) - 1n).toString(),
  });
  const res = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(402);
  expect(stub.calls).toHaveLength(0);
});

test('the exact option on a metered service charges the full upper bound', async () => {
  const stub = startStub();
  const { env, app } = await setup({ stub });
  const buyer = privateKeyToAccount(BUYER_KEY);
  await fundAndApprove(env, buyer, 10_000_000n);

  const body = bodyFor('hello world');
  const { required, exact } = await fetchOffer(app, body);
  const core = new x402Client()
    .setSpendControls(false)
    .register('eip155:31337', new ExactEvmScheme(buyer));
  const client = new x402HTTPClient(core);
  const payload = await client.createPaymentPayload(required as unknown as PaymentRequired);
  const encoded = client.encodePaymentSignatureHeader(payload);

  const payToBefore = await balanceOf(env, privateKeyToAccount(AGENT_KEY).address);
  const paid = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: encoded['PAYMENT-SIGNATURE']!,
  });
  expect(paid.status).toBe(200);
  const result = (await paid.json()) as { result: { charged: string } };
  expect(result.result.charged).toBe(exact.amount);
  const payToAfter = await balanceOf(env, privateKeyToAccount(AGENT_KEY).address);
  expect(payToAfter - payToBefore).toBe(BigInt(exact.amount));
});

test('streaming, oversized input and bad max_tokens are rejected before payment', async () => {
  const stub = startStub();
  const { app } = await setup({ stub });

  const streaming = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify({ ...bodyFor('hi'), stream: true }),
  });
  expect(streaming.status).toBe(400);

  const tooLong = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(bodyFor('x'.repeat(8001))),
  });
  expect(tooLong.status).toBe(400);

  const tooMany = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(bodyFor('hi', 2001)),
  });
  expect(tooMany.status).toBe(400);
  expect(stub.calls).toHaveLength(0);
});

test('the daily payer cap rejects before the upstream is called', async () => {
  const stub = startStub();
  const { env, app } = await setup({ stub, llmPayerDailyCapAtomic: 100n });
  const buyer = privateKeyToAccount(BUYER_KEY);
  await fundAndApprove(env, buyer, 10_000_000n);

  const body = bodyFor('hello world');
  const { upto } = await fetchOffer(app, body);
  const signed = await manualUptoPayload({ requirement: upto, account: buyer, chainId: 31337 });
  const res = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(429);
  expect(stub.calls).toHaveLength(0);
});

test('insufficient balance or allowance is rejected before the upstream is called', async () => {
  const stub = startStub();
  const { app } = await setup({ stub });
  const buyer = privateKeyToAccount(BUYER_KEY);

  const body = bodyFor('hello world');
  const { upto } = await fetchOffer(app, body);
  const signed = await manualUptoPayload({ requirement: upto, account: buyer, chainId: 31337 });
  const res = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(402);
  expect(stub.calls).toHaveLength(0);
});

test('metered services are not listed without the BeefAPI key', async () => {
  const stub = startStub();
  const env = await startChain();
  const built = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiBaseUrl: stub.url,
    llmBeefapiApiKey: '',
  });
  await registerProvider(built.app, env, privateKeyToAccount(AGENT_KEY));

  const services = (await (await req(built.app, '/api/services')).json()) as {
    services: Array<{ serviceId: string }>;
  };
  expect(services.services.map((s) => s.serviceId)).toEqual(['echo']);

  const call = await req(built.app, PATH, {
    method: 'POST',
    body: JSON.stringify(bodyFor('hi')),
  });
  expect(call.status).toBe(404);

  const discovery = (await (await req(built.app, '/discovery/resources')).json()) as {
    items: Array<{ resource: string }>;
  };
  expect(discovery.items.some((item) => item.resource.includes('llm-'))).toBe(false);
});

test('the upstream request never leaks the key into the client response', async () => {
  const stub = startStub();
  stub.state.status = 400;
  const { env, app } = await setup({ stub });
  const buyer = privateKeyToAccount(BUYER_KEY);
  await fundAndApprove(env, buyer, 10_000_000n);

  const body = bodyFor('hello world');
  const { upto } = await fetchOffer(app, body);
  const signed = await manualUptoPayload({ requirement: upto, account: buyer, chainId: 31337 });
  const res = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  const text = await res.text();
  expect(text).not.toContain(KEY);
  for (const value of res.headers.values()) {
    expect(value).not.toContain(KEY);
  }
  expect(res.status).toBe(502);
});

test('the service listing and discovery expose the metered pricing mode', async () => {
  const stub = startStub();
  const { app } = await setup({ stub });

  const services = (await (await req(app, '/api/services')).json()) as {
    services: Array<{ serviceId: string; pricing: string; modelId?: string }>;
  };
  const metered = services.services.find((s) => s.serviceId === SERVICE)!;
  expect(metered.pricing).toBe('metered');
  expect(metered.modelId).toBe('glm-5.3');

  const discovery = (await (await req(app, '/discovery/resources')).json()) as {
    items: Array<{
      resource: string;
      accepts: X402PaymentRequirements[];
      extensions: { bazaar?: { info?: { input?: { inputSchema?: unknown } } } };
    }>;
  };
  const item = discovery.items.find((i) => i.resource.includes(SERVICE))!;
  expect(item.accepts.map((a) => a.scheme).sort()).toEqual(['exact', 'upto']);
  expect(item.extensions.bazaar?.info?.input?.inputSchema).toBeDefined();
});

test('MCP search, get and call expose the metered quote', async () => {
  const stub = startStub();
  const { app } = await setup({ stub });
  const mcp = createMcpClient(app);
  await mcp.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  });

  const search = (await mcp.call('search_services', { query: 'glm' })).result as {
    structuredContent: { services: Array<{ resource: string }> };
  };
  expect(search.structuredContent.services.some((s) => s.resource.includes(SERVICE))).toBe(true);

  const get = (await mcp.call('get_service', { serviceId: SERVICE })).result as {
    structuredContent: { accepts: X402PaymentRequirements[] };
  };
  expect(get.structuredContent.accepts.map((a) => a.scheme).sort()).toEqual(['exact', 'upto']);

  // call_service carries the body, so the metered quote can be priced.
  const call = (await mcp.call('call_service', {
    serviceId: SERVICE,
    body: bodyFor('hello world'),
  })).result as {
    isError?: boolean;
    structuredContent: { accepts: X402PaymentRequirements[]; error?: string };
  };
  expect(call.isError).toBe(true);
  const upto = call.structuredContent.accepts.find((a) => a.scheme === 'upto')!;
  expect(upto.amount).toBe(expectedUpperBound('hello world', 1000).toString());
  expect(stub.calls).toHaveLength(0);
});
