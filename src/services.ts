import { getAddress } from 'viem';
import type { RuntimeConfig } from './config.ts';
import {
  LLM_QUOTE_INPUT_TOKENS,
  LLM_QUOTE_OUTPUT_TOKENS,
  METERED_PRICING,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_PROMPT_CHARS,
  meteredUpperBound,
  type MeteredPricing,
} from './llm.ts';
import type { Store } from './store.ts';
import type { Address, Hex } from './types.ts';
import { ServiceError } from './types.ts';
import { createImageClient } from './services/image.ts';
import { createVideoGenClient } from './services/video.ts';

function atomicAmount(usdtDollars: number, decimals: number): bigint {
  const factor = 10n ** BigInt(decimals);
  const cents = BigInt(Math.round(usdtDollars * 100));
  return (cents * factor) / 100n;
}

// Paid-service catalog. `exact` services charge a fixed price quoted up front;
// `metered` services quote a fixed per-call maximum and settle the actual token
// cost with the x402 `upto` scheme (M5). The `inputSchema`/`outputSchema` fields
// feed the x402 Bazaar discovery extension.
export type ServicePricing =
  | { mode: 'exact' }
  | { mode: 'metered'; pricing: MeteredPricing };

export type ServiceDefinition = {
  serviceId: string;
  providerAgentId: string;
  // Fixed price for exact services. Metered services quote the same cap for
  // every call, so this stays 0 and the amount comes from the pricing table.
  price: bigint;
  pricing: ServicePricing;
  description: string;
  deliver: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  inputExample: Record<string, unknown>;
  outputExample: unknown;
};

export type DeliverContext = {
  serviceId: string;
  payer: Address;
  payTo: Address;
  amount: bigint;
  paymentKey: Hex;
  body: Record<string, unknown>;
};

export type DeliverHandler = (ctx: DeliverContext) => Promise<unknown>;

export type ResolvedService = {
  definition: ServiceDefinition;
  payTo: Address;
  deliver: DeliverHandler;
};

const ZERO = '0x0000000000000000000000000000000000000000';

function usd(microUsdPerMillion: bigint): string {
  return (Number(microUsdPerMillion) / 1_000_000).toFixed(2);
}

function usdt(atomic: bigint): string {
  const base = 1_000_000n;
  const whole = atomic / base;
  const frac = (atomic % base).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}.00`;
}

function meteredDescription(modelId: string, pricing: MeteredPricing, symbol: string): string {
  const video = pricing.input === 'video';
  const quoteInput = pricing.quoteInputTokens ?? LLM_QUOTE_INPUT_TOKENS;
  const intro = video
    ? `Video understanding (model ${modelId}, native multimodal) served through BeefAPI: send a video URL and a question, get the model's answer about what happens in the video.`
    : modelId === 'grok-4.7'
      ? `LLM chat completion with live real-time X (Twitter) search (model ${modelId}) served through BeefAPI. Retrieves real-time public tweets, sentiment, and breaking news without requiring a separate Twitter API subscription.`
      : `LLM chat completion (model ${modelId}) served through BeefAPI.`;
  return [
    intro,
    `Priced per token: $${usd(pricing.inputMicroUsdPerMillion)} per 1M input tokens and $${usd(pricing.outputMicroUsdPerMillion)} per 1M output tokens, charged in ${symbol} by actual usage.`,
    `The 402 quotes a fixed per-call maximum of ${usdt(meteredUpperBound(pricing))} ${symbol}, the same for every request (the price of ${quoteInput} input and ${LLM_QUOTE_OUTPUT_TOKENS} output tokens). Upstream models add hidden prompt tokens, so the maximum is above a typical call; only the actual usage is charged, at most that maximum and possibly lower or zero.`,
    'Payment uses the x402 `upto` scheme only.',
    video
      ? `Input is {"video_url","prompt","max_tokens"?}: video_url is a public https link to an mp4, mov or webm file of at most ${VIDEO_MAX_BYTES / 1024 / 1024} MB, prompt is at most ${VIDEO_MAX_PROMPT_CHARS} characters, max_tokens defaults to 1000 and is capped at 2000. If the video cannot be fetched, nothing is charged.`
      : 'Input is an OpenAI chat body: {"messages":[{"role","content"}],"max_tokens"?}; total content is at most 8000 characters, max_tokens defaults to 1000 and is capped at 2000.',
    'Non-streaming only: omit stream or set it to false.',
  ].join(' ');
}

function imageDefinition(
  providerAgentId: string,
  symbol: string,
  decimals: number,
): ServiceDefinition {
  const price = atomicAmount(0.20, decimals);
  return {
    serviceId: 'image-gpt-image-2-5',
    providerAgentId,
    price,
    pricing: { mode: 'exact' },
    description: `AI Image Generation (model gpt-image-2.5) served through BeefAPI: generates high-resolution images from natural language text prompts. Fixed price: $0.20 in ${symbol}.`,
    deliver: 'image',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          maxLength: 2000,
          description: 'Text prompt describing the desired image.',
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1024x1792', '1792x1024'],
          default: '1024x1024',
          description: 'Image dimensions.',
        },
      },
      required: ['prompt'],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'Generated image public URL or data URI.' },
        model: { type: 'string' },
        created: { type: 'integer' },
      },
      required: ['url', 'model', 'created'],
    },
    inputExample: { prompt: 'A futuristic cybernetic pelican overlooking neon Tokyo skyline, digital art', size: '1024x1024' },
    outputExample: {
      url: 'https://images.example.com/generated/pelican-cyberpunk.png',
      model: 'gpt-image-2.5',
      created: 1728518400,
    },
  };
}

function videoGenDefinition(
  providerAgentId: string,
  symbol: string,
  decimals: number,
): ServiceDefinition {
  const price = atomicAmount(0.05, decimals);
  return {
    serviceId: 'video-wan-3-0',
    providerAgentId,
    price,
    pricing: { mode: 'exact' },
    description: `AI Video Generation (model wan3.0-video) served through BeefAPI: generates high-fidelity short video clips from text prompts. Fixed price: $0.05 in ${symbol}. Output video URL is ready for playback or downstream automated review.`,
    deliver: 'video_gen',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          maxLength: 2000,
          description: 'Text prompt describing the desired video scene and motion.',
        },
      },
      required: ['prompt'],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'Generated MP4 video download/streaming URL.' },
        model: { type: 'string' },
        taskId: { type: 'string' },
      },
      required: ['url', 'model', 'taskId'],
    },
    inputExample: { prompt: 'A pelican swooping gracefully over ocean waves at golden sunset, slow motion' },
    outputExample: {
      url: 'https://videos.example.com/generated/pelican-waves.mp4',
      model: 'wan3.0-video',
      taskId: 'task_wan3_abc123',
    },
  };
}

function videoInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      video_url: {
        type: 'string',
        format: 'uri',
        description: `Public https URL of an mp4, mov or webm video, at most ${VIDEO_MAX_BYTES / 1024 / 1024} MB.`,
      },
      prompt: {
        type: 'string',
        maxLength: VIDEO_MAX_PROMPT_CHARS,
        description: 'What to ask about the video.',
      },
      max_tokens: {
        type: 'integer',
        minimum: 1,
        maximum: 2000,
        default: 1000,
        description: 'Maximum completion tokens to generate.',
      },
      stream: { type: 'boolean', const: false, description: 'Streaming is not supported.' },
    },
    required: ['video_url', 'prompt'],
    additionalProperties: true,
  };
}

function meteredInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', description: 'For example system, user, or assistant.' },
            content: { type: 'string' },
          },
          required: ['role', 'content'],
          additionalProperties: false,
        },
      },
      max_tokens: {
        type: 'integer',
        minimum: 1,
        maximum: 2000,
        default: 1000,
        description: 'Maximum completion tokens to generate.',
      },
      stream: { type: 'boolean', const: false, description: 'Streaming is not supported.' },
    },
    required: ['messages'],
    additionalProperties: true,
  };
}

function meteredOutputSchema(symbol: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      model: { type: 'string' },
      content: { type: 'string' },
      usage: {
        type: 'object',
        properties: {
          prompt_tokens: { type: 'integer' },
          completion_tokens: { type: 'integer' },
          total_tokens: { type: 'integer' },
        },
        required: ['prompt_tokens', 'completion_tokens'],
      },
      charged: { type: 'string', description: `Actual charged amount in ${symbol} atomic units.` },
      upstream_request_id: { type: ['string', 'null'] },
    },
    required: ['model', 'content', 'usage', 'charged'],
  };
}

function meteredDefinitions(
  providerAgentId: string,
  services: Array<{ serviceId: string; modelId: string }>,
  symbol: string,
): ServiceDefinition[] {
  return services.map(({ serviceId, modelId }) => {
    const pricing = METERED_PRICING[modelId]!;
    const video = pricing.input === 'video';
    return {
      serviceId,
      providerAgentId,
      price: 0n,
      pricing: { mode: 'metered' as const, pricing },
      description: meteredDescription(modelId, pricing, symbol),
      deliver: 'metered',
      inputSchema: video ? videoInputSchema() : meteredInputSchema(),
      outputSchema: meteredOutputSchema(symbol),
      inputExample: video
        ? {
            video_url: 'https://example.com/clip.mp4',
            prompt: 'List the key events with timestamps.',
            max_tokens: 800,
          }
        : {
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 256,
          },
      outputExample: {
        model: modelId,
        content: video ? '00:03 A pelican catches a fish.' : 'Hello! How can I help?',
        usage: { prompt_tokens: 3, completion_tokens: 8, total_tokens: 11 },
        charged: '26',
        upstream_request_id: 'chatcmpl-example',
      },
    };
  });
}

export function createServiceCatalog(opts: {
  store: Store;
  config: RuntimeConfig;
  delivers?: Record<string, DeliverHandler>;
}) {
  // Metered LLM services are only listed when the switch is on and the BeefAPI
  // credential is present; a missing key must not break the exact services.
  const llmEnabled =
    opts.config.llmServicesEnabled === true && opts.config.llmBeefapiApiKey !== '';

  const definitions: ServiceDefinition[] = [
    {
      serviceId: 'echo',
      providerAgentId: opts.config.serviceProviderAgentId,
      price: opts.config.serviceEchoPrice,
      pricing: { mode: 'exact' },
      description: 'Echo test service: returns the request body unchanged.',
      deliver: 'echo',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
        description: 'Any JSON object. It is echoed back unchanged.',
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          serviceId: { type: 'string' },
          echo: { type: 'object' },
        },
        required: ['ok', 'serviceId', 'echo'],
      },
      inputExample: { hello: 'world' },
      outputExample: { ok: true, serviceId: 'echo', echo: { hello: 'world' } },
    },
  ];
  if (llmEnabled) {
    definitions.push(
      ...meteredDefinitions(opts.config.serviceProviderAgentId, [
        { serviceId: 'llm-glm-5-3', modelId: 'glm-5.3' },
        { serviceId: 'llm-claude-opus-5-5', modelId: 'claude-opus-5-5' },
        { serviceId: 'llm-gpt-6-astra', modelId: 'gpt-6-astra' },
        { serviceId: 'llm-grok-4-7', modelId: 'grok-4.7' },
        { serviceId: 'llm-deepseek-v4-1-flash', modelId: 'deepseek-v4.1-flash' },
        { serviceId: 'llm-qwen3-8-flash', modelId: 'qwen3.8-flash' },
        { serviceId: 'video-gemini-3-8-flash', modelId: 'gemini-3.8-flash' },
      ], opts.config.network.asset.symbol),
      imageDefinition(
        opts.config.serviceProviderAgentId,
        opts.config.network.asset.symbol,
        opts.config.network.asset.decimals,
      ),
      videoGenDefinition(
        opts.config.serviceProviderAgentId,
        opts.config.network.asset.symbol,
        opts.config.network.asset.decimals,
      ),
    );
  }
  const byId = new Map(definitions.map((definition) => [definition.serviceId, definition]));
  const meteredDeliver: DeliverHandler = async () => {
    throw new ServiceError(500, 'Metered services are handled by the settlement service.');
  };
  const imageClient = createImageClient(opts.config);
  const videoGenClient = createVideoGenClient(opts.config);

  const defaultDelivers: Record<string, DeliverHandler> = {
    echo: async (ctx) => ({ ok: true, serviceId: ctx.serviceId, echo: ctx.body }),
    metered: meteredDeliver,
    image: async (ctx) => {
      const prompt = typeof ctx.body.prompt === 'string' ? ctx.body.prompt : '';
      const size = typeof ctx.body.size === 'string' ? ctx.body.size : undefined;
      return await imageClient.generate({ prompt, size, user: ctx.payer });
    },
    video_gen: async (ctx) => {
      const prompt = typeof ctx.body.prompt === 'string' ? ctx.body.prompt : '';
      return await videoGenClient.generate({ prompt });
    },
  };
  const delivers: Record<string, DeliverHandler> = {
    ...defaultDelivers,
    ...(opts.delivers ?? {}),
  };
  // Always provide the metered placeholder so a metered definition resolves even
  // when a custom deliver map only supplies the exact handlers.
  if (!delivers.metered) delivers.metered = meteredDeliver;

  // Non-throwing availability check: a service is only discoverable/servable
  // when its provider is registered, has a non-zero wallet, and (when the
  // switch is on) is approved.
  const availability = (
    definition: ServiceDefinition,
  ): { payTo: Address; deliver: DeliverHandler } | null => {
    const provider = opts.store.getAgent(
      opts.config.chain.chainId,
      definition.providerAgentId,
    );
    if (!provider || provider.role !== 'provider') return null;
    if (provider.agentWallet.toLowerCase() === ZERO) return null;
    if (opts.config.servicesRequireApproved && provider.listed !== 'approved') return null;
    const deliver = delivers[definition.deliver];
    if (!deliver) return null;
    return { payTo: getAddress(provider.agentWallet) as Address, deliver };
  };

  const resolve = (serviceId: string): ResolvedService => {
    const definition = byId.get(serviceId);
    if (!definition) throw new ServiceError(404, 'Service not found.');
    const available = availability(definition);
    if (!available) throw new ServiceError(503, 'This service is temporarily unavailable.');
    return { definition, ...available };
  };

  return {
    list: () => [...definitions],
    get: (serviceId: string) => byId.get(serviceId) ?? null,
    resolve,
    // Available services in list order, for the discovery catalog.
    available: () =>
      definitions.flatMap((definition) => {
        const available = availability(definition);
        return available ? [{ definition, ...available }] : [];
      }),
  };
}

export type ServiceCatalog = ReturnType<typeof createServiceCatalog>;
