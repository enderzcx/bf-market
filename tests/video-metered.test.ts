import { afterEach, expect, test } from 'bun:test';
import { createWalletClient, getAddress, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader as decodeOfficialRequired,
  decodePaymentResponseHeader as decodeOfficialResponse,
  x402HTTPClient,
} from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { PERMIT2_ADDRESS } from '@x402/evm';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { parseVideoUrl } from '../src/llm.ts';
import type { X402PaymentRequirements } from '../src/x402/types.ts';
import {
  AGENT_KEY,
  BUYER_KEY,
  balanceOf,
  buildApp,
  closeAll,
  mintUsdt,
  registerProvider,
  req,
  startChain,
} from './m6-harness.ts';

const SERVICE = 'video-gemini-3-8-flash';
const PATH = `/api/services/${SERVICE}/call`;
const KEY = 'sk-test-beefapi-secret-value-1234567890';
const VIDEO_URL = 'https://videos.example.com/pelican.mp4';
const VIDEO_BYTES = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
const approveAbi = parseAbi(['function approve(address,uint256) returns (bool)']);

const realFetch = globalThis.fetch;
const closers: Array<() => void> = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  while (closers.length) closers.pop()?.();
  await closeAll();
});

// BeefAPI stub plus an in-process stand-in for the public video host: requests
// to videos.example.com are answered here, everything else hits the network.
function startStubs(video: { status?: number; type?: string; bytes?: Uint8Array<ArrayBuffer> } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const videoHits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      calls.push((await request.json()) as Record<string, unknown>);
      return Response.json({
        id: 'chatcmpl-video-1',
        choices: [{ message: { role: 'assistant', content: '00:07 the fish lands in the pouch.' } }],
        usage: { prompt_tokens: 1340, completion_tokens: 500 },
      });
    },
  });
  closers.push(() => server.stop(true));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://videos.example.com/')) {
      videoHits.push(url);
      return new Response(video.bytes ?? VIDEO_BYTES, {
        status: video.status ?? 200,
        headers: { 'Content-Type': video.type ?? 'video/mp4' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return { url: `http://127.0.0.1:${server.port}`, calls, videoHits };
}

async function setup(stubUrl: string) {
  const env = await startChain();
  const built = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiBaseUrl: stubUrl,
    llmBeefapiApiKey: KEY,
  });
  await registerProvider(built.app, env, privateKeyToAccount(AGENT_KEY));
  return { env, ...built };
}

async function fundAndApprove(env: Awaited<ReturnType<typeof startChain>>, amount: bigint) {
  const account = privateKeyToAccount(BUYER_KEY);
  await mintUsdt(env, account.address, amount);
  const wallet = createWalletClient({ chain: env.viemChain, account, transport: http(env.url) });
  await env.client.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address: env.token,
      abi: approveAbi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, amount],
    }),
  });
  return account;
}

const body = { video_url: VIDEO_URL, prompt: 'List the key events with timestamps.' };

// 64k input tokens at $0.50/1M plus 2200 output tokens at $3.00/1M.
const QUOTE = 32_000n + 6_600n;

test('the video service quotes a fixed upto cap with a 64k input allowance', async () => {
  const stubs = startStubs();
  const { app } = await setup(stubs.url);
  const res = await req(app, PATH, { method: 'POST', body: JSON.stringify(body) });
  expect(res.status).toBe(402);
  const required = decodeOfficialRequired(res.headers.get('PAYMENT-REQUIRED')!) as {
    accepts: X402PaymentRequirements[];
    extensions?: { bazaar?: { info?: { input?: { inputSchema?: { required?: string[] } } } } };
  };
  expect(required.accepts.map((a) => a.scheme)).toEqual(['upto']);
  expect(required.accepts[0]!.amount).toBe(QUOTE.toString());
  expect(required.extensions?.bazaar?.info?.input?.inputSchema?.required).toEqual([
    'video_url',
    'prompt',
  ]);
  expect(stubs.calls).toHaveLength(0);
  expect(stubs.videoHits).toHaveLength(0);
});

test('bad video requests are rejected before any payment offer', async () => {
  const stubs = startStubs();
  const { app } = await setup(stubs.url);
  for (const bad of [
    { prompt: 'x' },
    { video_url: 'http://videos.example.com/a.mp4', prompt: 'x' },
    { video_url: 'https://127.0.0.1/a.mp4', prompt: 'x' },
    { video_url: VIDEO_URL },
    { video_url: VIDEO_URL, prompt: 'x'.repeat(4001) },
    { video_url: VIDEO_URL, prompt: 'x', max_tokens: 5000 },
  ]) {
    const res = await req(app, PATH, { method: 'POST', body: JSON.stringify(bad) });
    expect(res.status).toBe(400);
  }
});

test('video_url accepts only public https hosts', () => {
  expect(parseVideoUrl('https://market-fuji.bflabs.app/demo/pelican.mp4')).toBe(
    'https://market-fuji.bflabs.app/demo/pelican.mp4',
  );
  for (const bad of [
    'ftp://example.com/a.mp4',
    'https://user:pw@example.com/a.mp4',
    'https://localhost/a.mp4',
    'https://10.0.0.1/a.mp4',
    'https://[::1]/a.mp4',
    'https://printer.local/a.mp4',
    'https://example.com:8443/a.mp4',
  ]) {
    expect(() => parseVideoUrl(bad)).toThrow();
  }
});

test('a paid call sends the video inline to the model and settles actual usage', async () => {
  const stubs = startStubs();
  const { env, app } = await setup(stubs.url);
  const buyer = await fundAndApprove(env, 10_000_000n);

  const offer = await req(app, PATH, { method: 'POST', body: JSON.stringify(body) });
  const required = decodeOfficialRequired(offer.headers.get('PAYMENT-REQUIRED')!);
  const client = new x402HTTPClient(
    new x402Client().setSpendControls(false).register('eip155:31337', new UptoEvmScheme(buyer)),
  );
  const payload = await client.createPaymentPayload(required as unknown as PaymentRequired);
  const encoded = client.encodePaymentSignatureHeader(payload);
  const payTo = getAddress(privateKeyToAccount(AGENT_KEY).address);
  const before = await balanceOf(env, payTo);

  const paid = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: encoded['PAYMENT-SIGNATURE']!,
  });
  expect(paid.status).toBe(200);
  const result = (await paid.json()) as { result: { content: string; charged: string } };
  // 1340 input tokens at $0.50/1M (670) + 500 output tokens at $3.00/1M (1500).
  expect(result.result.charged).toBe('2170');
  expect(result.result.content).toContain('pouch');
  expect(decodeOfficialResponse(paid.headers.get('PAYMENT-RESPONSE')!).success).toBe(true);
  expect((await balanceOf(env, payTo)) - before).toBe(2170n);

  expect(stubs.videoHits).toEqual([VIDEO_URL]);
  expect(stubs.calls).toHaveLength(1);
  const sent = stubs.calls[0]! as {
    model: string;
    messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
  };
  expect(sent.model).toBe('gemini-3.8-flash');
  const parts = sent.messages[0]!.content;
  expect(parts[0]).toEqual({ type: 'text', text: body.prompt });
  expect(parts[1]!.image_url!.url).toBe(
    `data:video/mp4;base64,${Buffer.from(VIDEO_BYTES).toString('base64')}`,
  );
});

test('a video that cannot be fetched settles nothing and skips the model', async () => {
  const stubs = startStubs({ type: 'text/html' });
  const { env, app } = await setup(stubs.url);
  const buyer = await fundAndApprove(env, 10_000_000n);
  const offer = await req(app, PATH, { method: 'POST', body: JSON.stringify(body) });
  const required = decodeOfficialRequired(offer.headers.get('PAYMENT-REQUIRED')!);
  const client = new x402HTTPClient(
    new x402Client().setSpendControls(false).register('eip155:31337', new UptoEvmScheme(buyer)),
  );
  const payload = await client.createPaymentPayload(required as unknown as PaymentRequired);
  const encoded = client.encodePaymentSignatureHeader(payload);
  const payTo = getAddress(privateKeyToAccount(AGENT_KEY).address);
  const before = await balanceOf(env, payTo);

  const paid = await req(app, PATH, {
    method: 'POST',
    body: JSON.stringify(body),
    paymentSignature: encoded['PAYMENT-SIGNATURE']!,
  });
  expect(paid.status).toBe(502);
  expect(((await paid.json()) as { error: string }).error).toContain('could not be fetched');
  expect(stubs.calls).toHaveLength(0);
  expect(await balanceOf(env, payTo)).toBe(before);
});
