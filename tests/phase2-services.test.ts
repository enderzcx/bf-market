import { afterEach, expect, test } from 'bun:test';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { extractResponsesResult, METERED_PRICING } from '../src/llm.ts';
import {
  AGENT_KEY,
  buildApp,
  closeAll,
  registerProvider,
  req,
  startChain,
} from './m6-harness.ts';

const BEEFAPI_KEY = 'beef_test_key_phase2';

afterEach(async () => {
  await closeAll();
});

test('extractResponsesResult parses OpenAI Responses API format correctly', () => {
  const responsesPayload = {
    id: 'resp_abc123',
    object: 'response',
    created_at: 1728518000,
    completed_at: 1728518003,
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'text',
            text: 'Hello from Grok with live Twitter/X data!',
          },
        ],
      },
    ],
    usage: {
      input_tokens: 15,
      output_tokens: 25,
      cost_in_usd_ticks: 75,
    },
  };

  const parsed = extractResponsesResult(responsesPayload);
  expect(parsed).not.toBeNull();
  expect(parsed?.content).toBe('Hello from Grok with live Twitter/X data!');
  expect(parsed?.usage.promptTokens).toBe(15);
  expect(parsed?.usage.completionTokens).toBe(25);
  expect(parsed?.upstreamRequestId).toBe('resp_abc123');
});

test('METERED_PRICING includes grok-4.7, deepseek-v4.1-flash, and qwen3.8-flash with responses API', () => {
  const grok = METERED_PRICING['grok-4.7'];
  expect(grok).toBeDefined();
  expect(grok?.modelId).toBe('grok-4.7');
  expect(grok?.api).toBe('responses');
  expect(grok?.inputMicroUsdPerMillion).toBe(600_000n);
  expect(grok?.outputMicroUsdPerMillion).toBe(1_800_000n);

  const ds = METERED_PRICING['deepseek-v4.1-flash'];
  expect(ds).toBeDefined();
  expect(ds?.api).toBe('responses');

  const qwen = METERED_PRICING['qwen3.8-flash'];
  expect(qwen).toBeDefined();
  expect(qwen?.api).toBe('responses');
});

test('Catalog and /api/services list expanded service suite including image, video, and Grok', async () => {
  const env = await startChain();
  const { app } = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiApiKey: BEEFAPI_KEY,
  });
  const agent = privateKeyToAccount(AGENT_KEY);
  await registerProvider(app, env, agent);

  const res = await req(app, '/api/services');
  expect(res.status).toBe(200);
  const data = (await res.json()) as {
    services: Array<{
      serviceId: string;
      pricing: string;
      price: string;
      description: string;
      health: {
        status: string;
        totalCalls: number;
      };
    }>;
  };

  const ids = data.services.map((s) => s.serviceId);
  expect(ids).toContain('echo');
  expect(ids).toContain('llm-glm-5-3');
  expect(ids).toContain('llm-claude-opus-5-5');
  expect(ids).toContain('llm-gpt-6-astra');
  expect(ids).toContain('llm-grok-4-7');
  expect(ids).toContain('llm-deepseek-v4-1-flash');
  expect(ids).toContain('llm-qwen3-8-flash');
  expect(ids).toContain('video-gemini-3-8-flash');
  expect(ids).toContain('image-gpt-image-2-5');
  expect(ids).toContain('video-wan-3-0');

  // Verify Grok description highlights real-time X search
  const grokService = data.services.find((s) => s.serviceId === 'llm-grok-4-7')!;
  expect(grokService.description).toContain('live real-time X (Twitter) search');

  // Verify Image and Video services are exact pricing with non-zero fixed price
  const imgService = data.services.find((s) => s.serviceId === 'image-gpt-image-2-5')!;
  expect(imgService.pricing).toBe('exact');
  expect(BigInt(imgService.price)).toBe(200_000n); // 0.20 USDT

  const vidService = data.services.find((s) => s.serviceId === 'video-wan-3-0')!;
  expect(vidService.pricing).toBe('exact');
  expect(BigInt(vidService.price)).toBe(50_000n); // 0.05 USDT

  // Verify health structure
  expect(grokService.health.status).toBe('unknown'); // No calls yet
  expect(grokService.health.totalCalls).toBe(0);
});

test('GET /api/services/:id/inspect returns complete metadata, schema, and health', async () => {
  const env = await startChain();
  const { app, store } = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiApiKey: BEEFAPI_KEY,
  });
  const agent = privateKeyToAccount(AGENT_KEY);
  await registerProvider(app, env, agent);

  // Seed a simulated payment to test health aggregation
  const paymentKey = ('0x' + '11'.repeat(32)) as `0x${string}`;
  const txHash = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
  store.upsertServicePayment({
    paymentKey,
    serviceId: 'image-gpt-image-2-5',
    chainId: 31337,
    payer: agent.address,
    payTo: agent.address,
    asset: env.token,
    amount: '200000',
    nonce: '1',
  });
  store.setServicePaymentStatus(paymentKey, 'settled', {
    txHash,
  });
  store.markServicePaymentDelivered(
    paymentKey,
    JSON.stringify({ url: 'https://example.com/art.png' }),
    { txHash, chargedAmount: '200000' },
  );

  const res = await req(app, '/api/services/image-gpt-image-2-5/inspect');
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    serviceId: string;
    provider: { wallet: string; name: string };
    pricing: { mode: string };
    price: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    accepts: Array<Record<string, unknown>>;
    health: {
      status: string;
      totalCalls: number;
      successRate24h: number;
      recentProofs: Array<{ txHash: string; chargedAmount: string | null }>;
    };
  };

  expect(body.ok).toBe(true);
  expect(body.serviceId).toBe('image-gpt-image-2-5');
  expect(getAddress(body.provider.wallet)).toBe(getAddress(agent.address));
  expect(body.pricing.mode).toBe('exact');
  expect(body.price).toBe('200000');
  expect(body.inputSchema.properties).toBeDefined();
  expect(body.outputSchema.properties).toBeDefined();
  expect(body.accepts.length).toBeGreaterThan(0);
  expect(body.health.status).toBe('stable');
  expect(body.health.totalCalls).toBe(1);
  expect(body.health.successRate24h).toBe(100);
  expect(body.health.recentProofs).toHaveLength(1);
  expect(body.health.recentProofs[0]!.txHash).toBe(txHash);

  const grokRes = await req(app, '/api/services/llm-grok-4-7/inspect');
  expect(grokRes.status).toBe(200);
  const grokBody = (await grokRes.json()) as {
    ok: boolean;
    serviceId: string;
    pricing: { mode: string; modelId: string; inputMicroUsdPerMillion: string; outputMicroUsdPerMillion: string };
  };
  expect(grokBody.ok).toBe(true);
  expect(grokBody.serviceId).toBe('llm-grok-4-7');
  expect(grokBody.pricing.mode).toBe('metered');
  expect(grokBody.pricing.modelId).toBe('grok-4.7');
  expect(grokBody.pricing.inputMicroUsdPerMillion).toBe('600000');
  expect(grokBody.pricing.outputMicroUsdPerMillion).toBe('1800000');
});

test('Discovery items include health and can sort by health and calls', async () => {
  const env = await startChain();
  const { app, store } = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiApiKey: BEEFAPI_KEY,
  });
  const agent = privateKeyToAccount(AGENT_KEY);
  await registerProvider(app, env, agent);

  // Add 3 payments for Grok so totalCalls is higher
  for (let i = 1; i <= 3; i++) {
    const key = ('0x' + `${i}`.padStart(2, '0').repeat(32)) as `0x${string}`;
    const hash = ('0x' + `${i}`.padStart(2, '0').repeat(32)) as `0x${string}`;
    store.upsertServicePayment({
      paymentKey: key,
      serviceId: 'llm-grok-4-7',
      chainId: 31337,
      payer: agent.address,
      payTo: agent.address,
      asset: env.token,
      amount: '50000',
      nonce: String(i),
    });
    store.markServicePaymentDelivered(key, JSON.stringify({ text: 'ok' }), {
      txHash: hash,
      chargedAmount: '120',
    });
  }

  // Fetch with sort=calls
  const sortedRes = await req(app, '/discovery/resources?sort=calls');
  expect(sortedRes.status).toBe(200);
  const sortedData = (await sortedRes.json()) as {
    items: Array<{ resource: string; health: { totalCalls: number } }>;
  };

  expect(sortedData.items[0]!.health.totalCalls).toBe(3);
  expect(sortedData.items[0]!.resource).toContain('llm-grok-4-7');
});

test('Calling image, video, and Grok services without payment returns 402 with precise pricing requirements', async () => {
  const env = await startChain();
  const { app } = buildApp(env, {
    llmServicesEnabled: true,
    llmBeefapiApiKey: BEEFAPI_KEY,
  });
  const agent = privateKeyToAccount(AGENT_KEY);
  await registerProvider(app, env, agent);

  // 1. Image service 402 offer
  const imgRes = await req(app, '/api/services/image-gpt-image-2-5/call', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'A neon pelican' }),
  });
  expect(imgRes.status).toBe(402);
  const imgData = (await imgRes.json()) as {
    accepts: Array<{ scheme: string; amount: string; asset: string }>;
  };
  expect(imgData.accepts[0]!.scheme).toBe('exact');
  expect(imgData.accepts[0]!.amount).toBe('200000'); // 0.20 USDT

  // 2. Video service 402 offer
  const vidRes = await req(app, '/api/services/video-wan-3-0/call', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Waves rolling' }),
  });
  expect(vidRes.status).toBe(402);
  const vidData = (await vidRes.json()) as {
    accepts: Array<{ scheme: string; amount: string; asset: string }>;
  };
  expect(vidData.accepts[0]!.scheme).toBe('exact');
  expect(vidData.accepts[0]!.amount).toBe('50000'); // 0.05 USDT

  // 3. Grok service 402 offer (metered upto)
  const grokRes = await req(app, '/api/services/llm-grok-4-7/call', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'What is happening on X today?' }] }),
  });
  expect(grokRes.status).toBe(402);
  const grokData = (await grokRes.json()) as {
    accepts: Array<{ scheme: string; amount: string; asset: string }>;
  };
  expect(grokData.accepts[0]!.scheme).toBe('upto');
  expect(BigInt(grokData.accepts[0]!.amount)).toBeGreaterThan(0n);
});

