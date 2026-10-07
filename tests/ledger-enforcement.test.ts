import { afterEach, expect, test } from 'bun:test';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { utcDay } from '../src/budget.ts';
import type { SettlementApp } from '../src/server.ts';
import type { Store } from '../src/store.ts';
import type { SpendScheme } from '../src/types.ts';
import {
  permit2PaymentKey,
  type Permit2Facilitator,
  type Permit2ReceiptResult,
} from '../src/x402/index.ts';
import type { X402PaymentRequirements } from '../src/x402/types.ts';
import {
  AGENT_KEY,
  BUYER_KEY,
  buildApp,
  closeAll,
  createMcpClient,
  manualPayload,
  manualUptoPayload,
  mockFacilitator,
  registerProvider,
  req,
  startChain,
} from './m6-harness.ts';

// The reservation ledger at the paid path (architecture §2): echo holds its
// price, a metered LLM call holds its quote and shrinks to the actual usage, and
// every terminal branch either charges or releases. The user budget covers both
// schemes; the platform caps cover metered spend only.

const KEY = 'sk-test-beefapi-secret-value-1234567890';
const CHAIN_ID = 31337;
const SETTLE_TX = `0x${'ab'.repeat(32)}` as Hex;
const ECHO = 1_000_000n;
const GLM = 'llm-glm-5-3';
const OPUS = 'llm-claude-opus-5-5';
const ASTRA = 'llm-gpt-6-astra';
const GLM_QUOTE = 19_040n;
const OPUS_QUOTE = 36_800n;
const ASTRA_QUOTE = 69_000n;
// The stub reports 10 prompt and 20 completion tokens, which charges 74 atomic.
const GLM_CHARGE = 74n;

const buyer = privateKeyToAccount(BUYER_KEY);
const buyerAddress = getAddress(buyer.address);
const OTHER_PAYER = getAddress('0x2547c1122c9aFD11eA0c4b66bb033552b90B979F');
const OTHER_PAYER_2 = getAddress('0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718');
const OTHER_PAYER_3 = getAddress('0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69');
const OWNER = getAddress('0x00000000000000000000000000000000000000aa');

const stubClosers: Array<() => void> = [];
afterEach(async () => {
  while (stubClosers.length) stubClosers.pop()?.();
  await closeAll();
});

// Deterministic BeefAPI stub. `onCall` fires when the upstream request arrives,
// which is where the ledger must already hold the quote.
function startLlmStub() {
  const state = {
    status: 200,
    delayMs: 0,
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
  const calls: Array<Record<string, unknown>> = [];
  let onCall: (() => void) | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push(body);
      onCall?.();
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (state.status !== 200) {
        return new Response(JSON.stringify({ error: 'upstream boom' }), {
          status: state.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return Response.json({
        id: 'chatcmpl-test-1',
        choices: [{ message: { role: 'assistant', content: 'Hello from the model.' } }],
        usage: state.usage,
      });
    },
  });
  stubClosers.push(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    state,
    onCall: (fn: (() => void) | null) => {
      onCall = fn;
    },
  };
}
type Stub = ReturnType<typeof startLlmStub>;

async function setup(
  opts: {
    stub?: Stub;
    facilitator?: Permit2Facilitator;
    payerCap?: bigint;
    globalCap?: bigint;
    deliverEcho?: () => Promise<unknown>;
  } = {},
) {
  const stub = opts.stub ?? startLlmStub();
  const env = await startChain();
  const built = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiBaseUrl: stub.url,
    llmBeefapiApiKey: KEY,
    llmPayerDailyCapAtomic: opts.payerCap,
    llmGlobalDailyCapAtomic: opts.globalCap,
    permit2Facilitator: opts.facilitator,
    deliverEcho: opts.deliverEcho,
  });
  await registerProvider(built.app, env, privateKeyToAccount(AGENT_KEY));
  return { env, stub, ...built };
}

const settleOk = (): Promise<Permit2ReceiptResult> =>
  Promise.resolve({ ok: true, txHash: SETTLE_TX, blockNumber: 1n });
const pending = (): Promise<Permit2ReceiptResult> => Promise.resolve({ ok: false, reason: 'pending' });

const glmBody = () => ({ messages: [{ role: 'user', content: 'hello world' }] });
const echoBody = () => ({ hello: 'world' });

function keyOf(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}` as Hex;
}

function keyFor(nonce: string): Hex {
  return permit2PaymentKey({ chainId: CHAIN_ID, payer: buyerAddress, nonce });
}

// Writes an occupancy row the way a settled payment would have left it. The
// amount is applied with adjustHold/chargeSpend because holdSpend itself would
// reject a fixture that is already over a cap — which is exactly what some of
// these cases need to set up.
function seedSpend(
  store: Store,
  input: {
    key: Hex;
    payer: Address;
    day: string;
    scheme: SpendScheme;
    amount: bigint;
    serviceId: string;
    state: 'held' | 'charged' | 'released';
  },
): void {
  store.holdSpend({
    paymentKey: input.key,
    day: input.day,
    payer: input.payer,
    serviceId: input.serviceId,
    scheme: input.scheme,
    amount: 1n,
  });
  if (input.state === 'charged') store.chargeSpend(input.key, input.amount);
  else store.adjustHold(input.key, input.amount);
  if (input.state === 'released') store.releaseSpend(input.key);
}

async function offer(
  app: SettlementApp,
  serviceId: string,
  body: Record<string, unknown>,
): Promise<X402PaymentRequirements> {
  const res = await req(app, `/api/services/${serviceId}/call`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(402);
  const required = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED')!) as {
    accepts: X402PaymentRequirements[];
  };
  return required.accepts[0]!;
}

// Offer → sign as the buyer → call. One helper for both schemes.
async function paidCall(
  app: SettlementApp,
  serviceId: string,
  body: Record<string, unknown>,
): Promise<{ res: Response; key: Hex }> {
  const requirement = await offer(app, serviceId, body);
  const signed =
    requirement.scheme === 'upto'
      ? await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID })
      : await manualPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const res = await req(app, `/api/services/${serviceId}/call`, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  return { res, key: keyFor(signed.nonce) };
}

async function errorText(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

// A rejected request leaves no trace: no ledger row, and no payment row, so it
// never shows up as a receipt either.
function expectNoTrace(store: Store, key: Hex): void {
  expect(store.getSpend(key)).toBeNull();
  expect(store.getServicePayment(key)).toBeNull();
}

// ---- exact (echo) ----------------------------------------------------------

test('echo reserves the price before prepare and charges it when settlement succeeds', async () => {
  const facilitator = mockFacilitator(settleOk);
  const inner = facilitator.prepare;
  let store: Store | null = null;
  let heldAtPrepare = -1n;
  facilitator.prepare = async (input) => {
    heldAtPrepare = store!.spendFor(buyerAddress, utcDay()).held;
    return inner(input);
  };
  const built = await setup({ facilitator });
  store = built.store;

  const body = echoBody();
  const requirement = await offer(built.app, 'echo', body);
  const signed = await manualPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const res = await req(built.app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(200);

  // The price was already held when the settlement transaction was prepared.
  expect(heldAtPrepare).toBe(ECHO);
  const row = built.store.getSpend(keyFor(signed.nonce))!;
  expect(row.scheme).toBe('exact');
  expect(row.serviceId).toBe('echo');
  expect(row.state).toBe('charged');
  expect(row.amount).toBe(ECHO);
  expect(built.store.spendFor(buyerAddress, row.day)).toEqual({
    charged: ECHO,
    held: 0n,
    llmCharged: 0n,
    llmHeld: 0n,
  });
});

test('a reverted or mismatched echo settlement releases the hold', async () => {
  for (const [reason, status, text] of [
    ['reverted', 402, 'Payment settlement failed.'],
    ['mismatch', 502, 'Settlement receipt does not match the requirements.'],
  ] as const) {
    const { app, store } = await setup({
      facilitator: mockFacilitator(async () => ({ ok: false, reason })),
    });
    const body = echoBody();
    const requirement = await offer(app, 'echo', body);
    const signed = await manualPayload({ requirement, account: buyer, chainId: CHAIN_ID });
    const res = await req(app, '/api/services/echo/call', {
      method: 'POST',
      body: JSON.stringify(body),
      paymentSignature: signed.header,
    });
    expect(res.status, reason).toBe(status);
    expect(await errorText(res), reason).toBe(text);
    const row = store.getSpend(keyFor(signed.nonce))!;
    expect(row.state, reason).toBe('released');
    expect(store.spendFor(buyerAddress, row.day), reason).toEqual({
      charged: 0n,
      held: 0n,
      llmCharged: 0n,
      llmHeld: 0n,
    });
  }
});

test('a pending echo settlement keeps the hold and the retry reuses the same row', async () => {
  let outcome: Permit2ReceiptResult = { ok: false, reason: 'pending' };
  const { app, store } = await setup({ facilitator: mockFacilitator(async () => outcome) });
  const body = echoBody();
  const requirement = await offer(app, 'echo', body);
  const signed = await manualPayload({ requirement, account: buyer, chainId: CHAIN_ID });

  const first = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(first.status).toBe(202);
  const held = store.getSpend(keyFor(signed.nonce))!;
  expect(held.state).toBe('held');
  expect(held.amount).toBe(ECHO);

  outcome = { ok: true, txHash: SETTLE_TX, blockNumber: 1n };
  const second = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(second.status).toBe(200);
  const charged = store.getSpend(keyFor(signed.nonce))!;
  expect(charged.state).toBe('charged');
  // A second row would have doubled the day's total.
  expect(store.spendFor(buyerAddress, charged.day).charged).toBe(ECHO);
});

test('a prepare error keeps the hold and the retry reuses the same row', async () => {
  const facilitator = mockFacilitator(settleOk);
  const inner = facilitator.prepare;
  let failPrepare = true;
  facilitator.prepare = async (input) => {
    if (failPrepare) throw new Error('replacement transaction underpriced');
    return inner(input);
  };
  const { app, store } = await setup({ facilitator });
  const body = echoBody();
  const requirement = await offer(app, 'echo', body);
  const signed = await manualPayload({ requirement, account: buyer, chainId: CHAIN_ID });

  const failed = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(failed.status).toBe(500);
  const held = store.getSpend(keyFor(signed.nonce))!;
  expect(held.state).toBe('held');
  expect(store.spendFor(buyerAddress, held.day).held).toBe(ECHO);

  failPrepare = false;
  const retried = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(retried.status).toBe(200);
  expect(store.getSpend(keyFor(signed.nonce))!.state).toBe('charged');
  // The retry reused the row it already owned: one price, not two.
  expect(store.spendFor(buyerAddress, held.day).charged).toBe(ECHO);
  expect(store.spendFor(buyerAddress, held.day).held).toBe(0n);
});

test('a delivery failure after settlement leaves the price charged', async () => {
  const { app, store } = await setup({
    facilitator: mockFacilitator(settleOk),
    deliverEcho: async () => {
      throw new Error('provider exploded');
    },
  });
  const body = echoBody();
  const requirement = await offer(app, 'echo', body);
  const signed = await manualPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const res = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(500);
  expect(await errorText(res)).toBe('Service temporarily unavailable.');
  const row = store.getSpend(keyFor(signed.nonce))!;
  expect(row.state).toBe('charged');
  expect(row.amount).toBe(ECHO);
});

// ---- upto (metered) --------------------------------------------------------

test('a metered call holds the quote before the upstream call and charges the actual usage', async () => {
  const stub = startLlmStub();
  let store: Store | null = null;
  let heldAtUpstream = -1n;
  stub.onCall(() => {
    heldAtUpstream = store!.spendFor(buyerAddress, utcDay()).held;
  });
  const built = await setup({ stub, facilitator: mockFacilitator(settleOk) });
  store = built.store;

  const body = glmBody();
  const requirement = await offer(built.app, GLM, body);
  expect(requirement.scheme).toBe('upto');
  expect(requirement.amount).toBe(GLM_QUOTE.toString());
  const signed = await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const res = await req(built.app, `/api/services/${GLM}/call`, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(200);

  // The quote was reserved before the model was called.
  expect(heldAtUpstream).toBe(GLM_QUOTE);
  const key = keyFor(signed.nonce);
  const row = built.store.getSpend(key)!;
  expect(row.scheme).toBe('upto');
  expect(row.state).toBe('charged');
  expect(row.amount).toBe(GLM_CHARGE);
  expect(built.store.getServicePayment(key)?.chargedAmount).toBe(GLM_CHARGE.toString());
  expect(built.store.spendFor(buyerAddress, row.day)).toEqual({
    charged: GLM_CHARGE,
    held: 0n,
    llmCharged: GLM_CHARGE,
    llmHeld: 0n,
  });
  // The legacy per-day table is no longer written.
  expect(built.store.llmSpendFor(row.day, buyerAddress)).toBe(0n);
  expect(built.store.llmSpendTotal(row.day)).toBe(0n);
});

test('a zero metered charge releases the hold and sends no transaction', async () => {
  const stub = startLlmStub();
  stub.state.usage = { prompt_tokens: 0, completion_tokens: 0 };
  const { app, store } = await setup({ stub, facilitator: mockFacilitator(settleOk) });
  const body = glmBody();
  const requirement = await offer(app, GLM, body);
  const signed = await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const res = await req(app, `/api/services/${GLM}/call`, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { result: { charged: string } }).result.charged).toBe('0');
  const row = store.getSpend(keyFor(signed.nonce))!;
  expect(row.state).toBe('released');
  expect(store.spendFor(buyerAddress, row.day)).toEqual({
    charged: 0n,
    held: 0n,
    llmCharged: 0n,
    llmHeld: 0n,
  });
});

test('an upstream failure releases the hold and the retry reserves it again', async () => {
  const stub = startLlmStub();
  stub.state.status = 500;
  const { app, store } = await setup({ stub, facilitator: mockFacilitator(settleOk) });
  const body = glmBody();
  const requirement = await offer(app, GLM, body);
  const signed = await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const failed = await req(app, `/api/services/${GLM}/call`, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(failed.status).toBe(502);
  const key = keyFor(signed.nonce);
  const released = store.getSpend(key)!;
  expect(released.state).toBe('released');
  expect(store.getServicePayment(key)?.consumed).toBe(false);
  expect(store.spendFor(buyerAddress, released.day).held).toBe(0n);

  // The signature was never consumed, so the same payload may retry and settle.
  stub.state.status = 200;
  const retried = await req(app, `/api/services/${GLM}/call`, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(retried.status).toBe(200);
  const charged = store.getSpend(key)!;
  expect(charged.state).toBe('charged');
  expect(charged.amount).toBe(GLM_CHARGE);
});

test('a reverted metered settlement releases the hold', async () => {
  const { app, store } = await setup({
    stub: startLlmStub(),
    facilitator: mockFacilitator(async () => ({ ok: false, reason: 'reverted' })),
  });
  const body = glmBody();
  const requirement = await offer(app, GLM, body);
  const signed = await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const res = await req(app, `/api/services/${GLM}/call`, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(402);
  expect(await errorText(res)).toBe('Payment settlement failed.');
  const row = store.getSpend(keyFor(signed.nonce))!;
  expect(row.state).toBe('released');
  expect(store.getSpend(keyFor(signed.nonce))!.amount).toBe(GLM_CHARGE);
});

test('a mismatched metered settlement releases the hold and settles nothing', async () => {
  const stub = startLlmStub();
  const { app, store } = await setup({
    stub,
    facilitator: mockFacilitator(async () => ({ ok: false, reason: 'mismatch' })),
  });
  const body = glmBody();
  const requirement = await offer(app, GLM, body);
  const signed = await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const res = await req(app, `/api/services/${GLM}/call`, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(502);
  expect(await errorText(res)).toBe('Settlement receipt does not match the requirements.');

  const key = keyFor(signed.nonce);
  const row = store.getSpend(key)!;
  // The hold had already shrunk to the actual usage; the mismatch gives it back.
  expect(row.scheme).toBe('upto');
  expect(row.state).toBe('released');
  expect(row.amount).toBe(GLM_CHARGE);
  // Released rows stop counting, so the payer drops out of the day's spend.
  expect(store.spendFor(buyerAddress, row.day)).toEqual({
    charged: 0n,
    held: 0n,
    llmCharged: 0n,
    llmHeld: 0n,
  });

  // Nothing settled: the payment is failed and stays unconsumed, so the
  // signature was never spent and no receipt exists for it.
  const payment = store.getServicePayment(key)!;
  expect(payment.status).toBe('failed');
  expect(payment.consumed).toBe(false);
  expect(payment.error).toBe('Settlement receipt does not match the requirements.');
});

test('a pending metered settlement keeps the actual charge held', async () => {
  let outcome: Permit2ReceiptResult = { ok: false, reason: 'pending' };
  const { app, store } = await setup({
    stub: startLlmStub(),
    facilitator: mockFacilitator(async () => outcome),
  });
  const body = glmBody();
  const requirement = await offer(app, GLM, body);
  const signed = await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const res = await req(app, `/api/services/${GLM}/call`, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(202);
  const row = store.getSpend(keyFor(signed.nonce))!;
  // The hold already shrank to the actual usage, not the quote.
  expect(row.state).toBe('held');
  expect(row.amount).toBe(GLM_CHARGE);

  outcome = { ok: true, txHash: SETTLE_TX, blockNumber: 1n };
  const retried = await req(app, `/api/services/${GLM}/call`, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(retried.status).toBe(200);
  expect(store.getSpend(keyFor(signed.nonce))!.state).toBe('charged');
});

// ---- platform caps ---------------------------------------------------------

test('the per-wallet LLM cap counts metered spend only', async () => {
  const day = utcDay();

  // A payer with 4.99 USDT of charged echo spend is still admitted to a model.
  {
    const stub = startLlmStub();
    const { app, store } = await setup({ stub, facilitator: mockFacilitator(settleOk) });
    seedSpend(store, {
      key: keyOf(1),
      payer: buyerAddress,
      day,
      scheme: 'exact',
      amount: 4_990_000n,
      serviceId: 'echo',
      state: 'charged',
    });
    const { res } = await paidCall(app, GLM, glmBody());
    expect(res.status).toBe(200);
    expect(stub.calls).toHaveLength(1);
  }

  // The same amount of metered spend rejects the next quote with the old text.
  {
    const stub = startLlmStub();
    const { app, store } = await setup({ stub, facilitator: mockFacilitator(settleOk) });
    seedSpend(store, {
      key: keyOf(1),
      payer: buyerAddress,
      day,
      scheme: 'upto',
      amount: 4_990_000n,
      serviceId: GLM,
      state: 'charged',
    });
    const { res, key } = await paidCall(app, GLM, glmBody());
    expect(res.status).toBe(429);
    expect(await errorText(res)).toBe('Daily spending limit reached for this payer.');
    expectNoTrace(store, key);
    expect(stub.calls).toHaveLength(0);
  }
});

test('echo is admitted while both platform caps are exhausted', async () => {
  const day = utcDay();
  const { app, store } = await setup({ facilitator: mockFacilitator(pending) });
  // More metered spend than the per-wallet and the global cap allow.
  seedSpend(store, {
    key: keyOf(1),
    payer: buyerAddress,
    day,
    scheme: 'upto',
    amount: 6_000_000n,
    serviceId: GLM,
    state: 'held',
  });
  seedSpend(store, {
    key: keyOf(2),
    payer: OTHER_PAYER,
    day,
    scheme: 'upto',
    amount: 50_000_000n,
    serviceId: GLM,
    state: 'charged',
  });

  const body = echoBody();
  const requirement = await offer(app, 'echo', body);
  const signed = await manualPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const res = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(202);
  const row = store.getSpend(keyFor(signed.nonce))!;
  expect(row.scheme).toBe('exact');
  expect(row.state).toBe('held');
  expect(row.amount).toBe(ECHO);
});

test('the global model cap counts every payer and ignores released and exact rows', async () => {
  const day = utcDay();

  // (a) Others hold 49.99 USDT of metered spend: the next quote is rejected.
  {
    const stub = startLlmStub();
    const { app, store } = await setup({ stub, facilitator: mockFacilitator(settleOk) });
    seedSpend(store, {
      key: keyOf(1),
      payer: OTHER_PAYER,
      day,
      scheme: 'upto',
      amount: 49_990_000n,
      serviceId: GLM,
      state: 'charged',
    });
    seedSpend(store, {
      key: keyOf(2),
      payer: OTHER_PAYER_2,
      day,
      scheme: 'upto',
      amount: 5_000_000n,
      serviceId: GLM,
      state: 'released',
    });
    seedSpend(store, {
      key: keyOf(3),
      payer: OTHER_PAYER_3,
      day,
      scheme: 'exact',
      amount: 5_000_000n,
      serviceId: 'echo',
      state: 'charged',
    });
    const { res } = await paidCall(app, GLM, glmBody());
    expect(res.status).toBe(429);
    expect(await errorText(res)).toBe('The daily model budget is exhausted.');
    expect(stub.calls).toHaveLength(0);
  }

  // (b) The same fixtures one USDT lower admit the call: released metered rows
  // and charged exact rows do not count towards the global model cap.
  {
    const stub = startLlmStub();
    const { app, store } = await setup({ stub, facilitator: mockFacilitator(settleOk) });
    seedSpend(store, {
      key: keyOf(1),
      payer: OTHER_PAYER,
      day,
      scheme: 'upto',
      amount: 48_000_000n,
      serviceId: GLM,
      state: 'charged',
    });
    seedSpend(store, {
      key: keyOf(2),
      payer: OTHER_PAYER_2,
      day,
      scheme: 'upto',
      amount: 5_000_000n,
      serviceId: GLM,
      state: 'released',
    });
    seedSpend(store, {
      key: keyOf(3),
      payer: OTHER_PAYER_3,
      day,
      scheme: 'exact',
      amount: 5_000_000n,
      serviceId: 'echo',
      state: 'charged',
    });
    const { res } = await paidCall(app, GLM, glmBody());
    expect(res.status).toBe(200);
    expect(stub.calls).toHaveLength(1);
  }
});

// ---- user budget -----------------------------------------------------------

test('the user budget covers echo and the binding scope picks the error text', async () => {
  const { app, store } = await setup({ facilitator: mockFacilitator(pending) });
  const body = echoBody();
  const requirement = await offer(app, 'echo', body);
  const signed = await manualPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const call = () =>
    req(app, '/api/services/echo/call', {
      method: 'POST',
      body: JSON.stringify(body),
      paymentSignature: signed.header,
    });

  store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 50_000n, signer: buyerAddress, via: 'http' });
  const ownRes = await call();
  expect(ownRes.status).toBe(429);
  expect(await errorText(ownRes)).toBe('Daily budget reached for this wallet.');
  expectNoTrace(store, keyFor(signed.nonce));

  // The owner ceiling now binds (same value, checked first) and names the owner.
  store.setCeiling({
    chainId: CHAIN_ID,
    agentId: '1',
    wallet: buyerAddress,
    dailyLimit: 50_000n,
    signer: OWNER,
    via: 'http',
  });
  store.removeOwnBudget({ wallet: buyerAddress, signer: buyerAddress, via: 'http' });
  const ceilingRes = await call();
  expect(ceilingRes.status).toBe(429);
  expect(await errorText(ceilingRes)).toBe('Daily budget set by the agent owner is reached.');
  expectNoTrace(store, keyFor(signed.nonce));
});

test('admission uses the quote maximum, so a cheaper model can still be called', async () => {
  const stub = startLlmStub();
  const { app, store } = await setup({ stub, facilitator: mockFacilitator(settleOk) });
  store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 50_000n, signer: buyerAddress, via: 'http' });
  const day = utcDay();

  // 0.069 USDT over the 0.05 budget: rejected before the model is called.
  const astra = await paidCall(app, ASTRA, glmBody());
  expect(astra.res.status).toBe(429);
  expect(await errorText(astra.res)).toBe('Daily budget reached for this wallet.');
  expectNoTrace(store, astra.key);
  expect(stub.calls).toHaveLength(0);
  expect(ASTRA_QUOTE).toBeGreaterThan(50_000n);

  // 0.0368 USDT fits, and only the actual usage stays in the ledger.
  const opus = await paidCall(app, OPUS, glmBody());
  expect(opus.res.status).toBe(200);
  const opusCharge = BigInt(
    ((await opus.res.json()) as { result: { charged: string } }).result.charged,
  );
  expect(opusCharge).toBeLessThanOrEqual(OPUS_QUOTE);
  const opusRow = store.getSpend(opus.key)!;
  expect(opusRow.state).toBe('charged');
  expect(opusRow.amount).toBe(opusCharge);
  expect(store.spendFor(buyerAddress, day).charged).toBe(opusCharge);

  // 0.019 USDT still fits the remaining budget.
  const glm = await paidCall(app, GLM, glmBody());
  expect(glm.res.status).toBe(200);
  expect(GLM_QUOTE + opusCharge + GLM_QUOTE).toBeLessThan(50_000n);
});

test('a budget of zero pauses every paid service with the matching text', async () => {
  const stub = startLlmStub();
  const { app, store } = await setup({ stub, facilitator: mockFacilitator(settleOk) });
  const services = ['echo', GLM, OPUS, ASTRA];
  const bodyFor = (serviceId: string) => (serviceId === 'echo' ? echoBody() : glmBody());

  store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 0n, signer: buyerAddress, via: 'http' });
  for (const serviceId of services) {
    const { res, key } = await paidCall(app, serviceId, bodyFor(serviceId));
    expect(res.status, serviceId).toBe(429);
    expect(await errorText(res), serviceId).toBe('Daily budget reached for this wallet.');
    expectNoTrace(store, key);
  }
  expect(stub.calls).toHaveLength(0);

  store.removeOwnBudget({ wallet: buyerAddress, signer: buyerAddress, via: 'http' });
  store.setCeiling({
    chainId: CHAIN_ID,
    agentId: '1',
    wallet: buyerAddress,
    dailyLimit: 0n,
    signer: OWNER,
    via: 'http',
  });
  for (const serviceId of services) {
    const { res, key } = await paidCall(app, serviceId, bodyFor(serviceId));
    expect(res.status, serviceId).toBe(429);
    expect(await errorText(res), serviceId).toBe('Daily budget set by the agent owner is reached.');
    expectNoTrace(store, key);
  }
  expect(stub.calls).toHaveLength(0);
});

test('the limit check order maps each combination to its own text', async () => {
  const day = utcDay();

  // Ceiling and own value both exceeded: the ceiling is checked first.
  {
    const { app, store } = await setup({ facilitator: mockFacilitator(settleOk) });
    store.setCeiling({
      chainId: CHAIN_ID,
      agentId: '1',
      wallet: buyerAddress,
      dailyLimit: 50_000n,
      signer: OWNER,
      via: 'http',
    });
    store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 50_000n, signer: buyerAddress, via: 'http' });
    seedSpend(store, {
      key: keyOf(1),
      payer: buyerAddress,
      day,
      scheme: 'exact',
      amount: 50_000n,
      serviceId: 'echo',
      state: 'charged',
    });
    const { res } = await paidCall(app, GLM, glmBody());
    expect(res.status).toBe(429);
    expect(await errorText(res)).toBe('Daily budget set by the agent owner is reached.');
  }

  // The wallet's own value is exceeded and so is the metered per-wallet cap.
  {
    const { app, store } = await setup({ facilitator: mockFacilitator(settleOk) });
    store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 4_990_001n, signer: buyerAddress, via: 'http' });
    seedSpend(store, {
      key: keyOf(1),
      payer: buyerAddress,
      day,
      scheme: 'upto',
      amount: 4_990_000n,
      serviceId: GLM,
      state: 'charged',
    });
    const { res } = await paidCall(app, GLM, glmBody());
    expect(res.status).toBe(429);
    expect(await errorText(res)).toBe('Daily budget reached for this wallet.');
  }

  // No user budget, with the per-wallet and the global cap both exhausted.
  {
    const { app, store } = await setup({ facilitator: mockFacilitator(settleOk) });
    seedSpend(store, {
      key: keyOf(1),
      payer: buyerAddress,
      day,
      scheme: 'upto',
      amount: 4_990_000n,
      serviceId: GLM,
      state: 'charged',
    });
    seedSpend(store, {
      key: keyOf(2),
      payer: OTHER_PAYER,
      day,
      scheme: 'upto',
      amount: 49_990_000n,
      serviceId: GLM,
      state: 'charged',
    });
    const { res } = await paidCall(app, GLM, glmBody());
    expect(res.status).toBe(429);
    expect(await errorText(res)).toBe('Daily spending limit reached for this payer.');
  }
});

// ---- rejected requests -----------------------------------------------------

test('a rejected request settles nothing and leaves its signature usable', async () => {
  const stub = startLlmStub();
  const facilitator = mockFacilitator(settleOk);
  const inner = facilitator.prepare;
  let prepareCalls = 0;
  facilitator.prepare = async (input) => {
    prepareCalls += 1;
    return inner(input);
  };
  const { app, store } = await setup({ stub, facilitator });
  store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 0n, signer: buyerAddress, via: 'http' });

  // Echo: the hold rejects before anything is prepared.
  const body = echoBody();
  const requirement = await offer(app, 'echo', body);
  const signed = await manualPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const echo = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(echo.status).toBe(429);
  expect(await errorText(echo)).toBe('Daily budget reached for this wallet.');
  expect(prepareCalls).toBe(0);
  expectNoTrace(store, keyFor(signed.nonce));

  // Metered: the stub is never called either.
  const glmSigned = await manualUptoPayload({
    requirement: await offer(app, GLM, glmBody()),
    account: buyer,
    chainId: CHAIN_ID,
  });
  const metered = await req(app, `/api/services/${GLM}/call`, {
    method: 'POST',
    body: JSON.stringify(glmBody()),
    paymentSignature: glmSigned.header,
  });
  expect(metered.status).toBe(429);
  expect(stub.calls).toHaveLength(0);
  expectNoTrace(store, keyFor(glmSigned.nonce));

  // Neither signature was consumed: both payloads settle once the budget is up.
  store.removeOwnBudget({ wallet: buyerAddress, signer: buyerAddress, via: 'http' });
  const echoAgain = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: signed.header,
  });
  expect(echoAgain.status).toBe(200);
  expect(store.getSpend(keyFor(signed.nonce))?.state).toBe('charged');
  const meteredAgain = await req(app, `/api/services/${GLM}/call`, {
    method: 'POST',
    body: JSON.stringify(glmBody()),
    paymentSignature: glmSigned.header,
  });
  expect(meteredAgain.status).toBe(200);
  expect(stub.calls).toHaveLength(1);
});

test('MCP reports the same budget rejection as a tool error', async () => {
  const { app, store } = await setup({ facilitator: mockFacilitator(pending) });
  store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 0n, signer: buyerAddress, via: 'http' });
  const mcp = createMcpClient(app);
  await mcp.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  });

  const body = echoBody();
  const requirement = await offer(app, 'echo', body);
  const signed = await manualPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const result = (
    await mcp.call('call_service', { serviceId: 'echo', body }, { 'x402/payment': signed.payload })
  ).result as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toBe('Daily budget reached for this wallet.');
  expectNoTrace(store, keyFor(signed.nonce));
});

// ---- concurrency and mid-day changes ---------------------------------------

test('two concurrent calls from one payer cannot both pass the budget', async () => {
  const stub = startLlmStub();
  stub.state.delayMs = 150;
  const { app, store } = await setup({ stub, facilitator: mockFacilitator(settleOk) });
  store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 30_000n, signer: buyerAddress, via: 'http' });
  const body = glmBody();
  const requirement = await offer(app, GLM, body);
  const first = await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const second = await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const call = (header: string) =>
    req(app, `/api/services/${GLM}/call`, {
      method: 'POST',
      body: JSON.stringify(body),
      paymentSignature: header,
    });

  const [a, b] = await Promise.all([call(first.header), call(second.header)]);
  expect([a.status, b.status].sort()).toEqual([200, 429]);
  const keys = [keyFor(first.nonce), keyFor(second.nonce)];
  const rejectedIndex = a.status === 429 ? 0 : 1;
  expect(await errorText(a.status === 429 ? a : b)).toBe('Daily budget reached for this wallet.');
  expectNoTrace(store, keys[rejectedIndex]!);
  expect(store.getSpend(keys[1 - rejectedIndex]!)?.state).toBe('charged');
  const day = utcDay();
  const totals = store.spendFor(buyerAddress, day);
  expect(totals.held + totals.charged).toBeLessThanOrEqual(30_000n);
});

test('two concurrent calls cannot both pass the metered per-wallet cap', async () => {
  const stub = startLlmStub();
  stub.state.delayMs = 150;
  const { app, store } = await setup({ stub, facilitator: mockFacilitator(settleOk) });
  const day = utcDay();
  seedSpend(store, {
    key: keyOf(1),
    payer: buyerAddress,
    day,
    scheme: 'upto',
    amount: 4_980_000n,
    serviceId: GLM,
    state: 'charged',
  });
  const body = glmBody();
  const requirement = await offer(app, GLM, body);
  const first = await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const second = await manualUptoPayload({ requirement, account: buyer, chainId: CHAIN_ID });
  const call = (header: string) =>
    req(app, `/api/services/${GLM}/call`, {
      method: 'POST',
      body: JSON.stringify(body),
      paymentSignature: header,
    });

  const [a, b] = await Promise.all([call(first.header), call(second.header)]);
  expect([a.status, b.status].sort()).toEqual([200, 429]);
  const keys = [keyFor(first.nonce), keyFor(second.nonce)];
  const rejectedIndex = a.status === 429 ? 0 : 1;
  expect(await errorText(a.status === 429 ? a : b)).toBe(
    'Daily spending limit reached for this payer.',
  );
  expectNoTrace(store, keys[rejectedIndex]!);
  expect(store.getSpend(keys[1 - rejectedIndex]!)?.state).toBe('charged');
  const totals = store.spendFor(buyerAddress, day);
  expect(totals.llmHeld + totals.llmCharged).toBeLessThanOrEqual(5_000_000n);
});

test('a mid-day budget change applies to new requests and keeps in-flight holds', async () => {
  const { app, store } = await setup({
    stub: startLlmStub(),
    facilitator: mockFacilitator(pending),
  });
  store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 50_000n, signer: buyerAddress, via: 'http' });

  const inFlight = await paidCall(app, GLM, glmBody());
  expect(inFlight.res.status).toBe(202);
  expect(store.getSpend(inFlight.key)!.state).toBe('held');
  expect(store.getSpend(inFlight.key)!.amount).toBe(GLM_CHARGE);

  // Lowering the budget neither releases nor shrinks the hold that already ran.
  store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 10_000n, signer: buyerAddress, via: 'http' });
  expect(store.getSpend(inFlight.key)!.state).toBe('held');
  expect(store.getSpend(inFlight.key)!.amount).toBe(GLM_CHARGE);

  const blocked = await paidCall(app, GLM, glmBody());
  expect(blocked.res.status).toBe(429);
  expect(await errorText(blocked.res)).toBe('Daily budget reached for this wallet.');
  expectNoTrace(store, blocked.key);

  // Raising it again admits the next request without waiting for the UTC day.
  store.setOwnBudget({ wallet: buyerAddress, dailyLimit: 50_000n, signer: buyerAddress, via: 'http' });
  const admitted = await paidCall(app, GLM, glmBody());
  expect(admitted.res.status).toBe(202);
  expect(store.getSpend(admitted.key)!.state).toBe('held');
});
