import { getAddress } from 'viem';
import type { RuntimeConfig } from './config.ts';
import type { Store } from './store.ts';
import type { Address, Hex } from './types.ts';
import { ServiceError } from './types.ts';

// Minimal paid-service catalog for M4. Real BeefAPI deliverables land in M5 via
// a new `deliver` handler key; the shape here is the interface M5 fills in.
//
// The `inputSchema`/`outputSchema` fields feed the x402 Bazaar discovery
// extension (M6) so external facilitators and agents can read how to call a
// service and what it returns. M5's BeefAPI service fills in real schemas.
export type ServiceDefinition = {
  serviceId: string;
  providerAgentId: string;
  price: bigint;
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

export function createServiceCatalog(opts: {
  store: Store;
  config: RuntimeConfig;
  delivers?: Record<string, DeliverHandler>;
}) {
  const definitions: ServiceDefinition[] = [
    {
      serviceId: 'echo',
      providerAgentId: opts.config.serviceProviderAgentId,
      price: opts.config.serviceEchoPrice,
      description: '回显测试服务：把请求体原样返回。',
      deliver: 'echo',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
        description: '任意 JSON 对象，会原样回显。',
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
  const byId = new Map(definitions.map((definition) => [definition.serviceId, definition]));
  const delivers: Record<string, DeliverHandler> = opts.delivers ?? {
    echo: async (ctx) => ({ ok: true, serviceId: ctx.serviceId, echo: ctx.body }),
  };

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
    if (!definition) throw new ServiceError(404, '找不到该服务。');
    const available = availability(definition);
    if (!available) throw new ServiceError(503, '该服务暂时不可用。');
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
