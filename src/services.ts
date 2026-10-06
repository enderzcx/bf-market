import { getAddress } from 'viem';
import type { RuntimeConfig } from './config.ts';
import { METERED_PRICING, type MeteredPricing } from './llm.ts';
import type { Store } from './store.ts';
import type { Address, Hex } from './types.ts';
import { ServiceError } from './types.ts';

// Paid-service catalog. `exact` services charge a fixed price quoted up front;
// `metered` services quote an upper bound from the request body and settle the
// actual token cost with the x402 `upto` scheme (M5). The `inputSchema`/
// `outputSchema` fields feed the x402 Bazaar discovery extension.
export type ServicePricing =
  | { mode: 'exact' }
  | { mode: 'metered'; pricing: MeteredPricing };

export type ServiceDefinition = {
  serviceId: string;
  providerAgentId: string;
  // Fixed price for exact services. Metered services quote per request, so this
  // stays 0 and the amount comes from the body.
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

function meteredDescription(modelId: string, pricing: MeteredPricing): string {
  return [
    `LLM chat completion (model ${modelId}) served through BeefAPI.`,
    `Priced per token: $${usd(pricing.inputMicroUsdPerMillion)} per 1M input tokens and $${usd(pricing.outputMicroUsdPerMillion)} per 1M output tokens, charged in USDT by actual usage.`,
    'The 402 quotes an upper bound from the prompt estimate plus max_tokens; the final charge is at most that bound and can be lower or zero.',
    'Input is an OpenAI chat body: {"messages":[{"role","content"}],"max_tokens"?}; total content is at most 8000 characters, max_tokens defaults to 1000 and is capped at 2000.',
    'Non-streaming only: omit stream or set it to false.',
  ].join(' ');
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

function meteredOutputSchema(): Record<string, unknown> {
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
      charged: { type: 'string', description: 'Actual charged amount in USDT atomic units.' },
      upstream_request_id: { type: ['string', 'null'] },
    },
    required: ['model', 'content', 'usage', 'charged'],
  };
}

function meteredDefinitions(
  providerAgentId: string,
  services: Array<{ serviceId: string; modelId: string }>,
): ServiceDefinition[] {
  return services.map(({ serviceId, modelId }) => {
    const pricing = METERED_PRICING[modelId]!;
    return {
      serviceId,
      providerAgentId,
      price: 0n,
      pricing: { mode: 'metered' as const, pricing },
      description: meteredDescription(modelId, pricing),
      deliver: 'metered',
      inputSchema: meteredInputSchema(),
      outputSchema: meteredOutputSchema(),
      inputExample: {
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 256,
      },
      outputExample: {
        model: modelId,
        content: 'Hello! How can I help?',
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
      ]),
    );
  }
  const byId = new Map(definitions.map((definition) => [definition.serviceId, definition]));
  const meteredDeliver: DeliverHandler = async () => {
    throw new ServiceError(500, 'Metered services are handled by the settlement service.');
  };
  const delivers: Record<string, DeliverHandler> = opts.delivers ?? {
    echo: async (ctx) => ({ ok: true, serviceId: ctx.serviceId, echo: ctx.body }),
    metered: meteredDeliver,
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
