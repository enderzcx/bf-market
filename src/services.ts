import { getAddress } from 'viem';
import type { RuntimeConfig } from './config.ts';
import type { Store } from './store.ts';
import type { Address, Hex } from './types.ts';
import { ServiceError } from './types.ts';

// Minimal paid-service catalog for M4. Real BeefAPI deliverables land in M5 via
// a new `deliver` handler key; the shape here is the interface M5 fills in.
export type ServiceDefinition = {
  serviceId: string;
  providerAgentId: string;
  price: bigint;
  description: string;
  deliver: string;
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
    },
  ];
  const byId = new Map(definitions.map((definition) => [definition.serviceId, definition]));
  const delivers: Record<string, DeliverHandler> = opts.delivers ?? {
    echo: async (ctx) => ({ ok: true, serviceId: ctx.serviceId, echo: ctx.body }),
  };

  const resolve = (serviceId: string) => {
    const definition = byId.get(serviceId);
    if (!definition) throw new ServiceError(404, '找不到该服务。');
    const provider = opts.store.getAgent(
      opts.config.chain.chainId,
      definition.providerAgentId,
    );
    if (!provider || provider.role !== 'provider') {
      throw new ServiceError(503, '该服务暂时不可用。');
    }
    if (provider.agentWallet.toLowerCase() === ZERO) {
      throw new ServiceError(503, '该服务暂时不可用。');
    }
    if (opts.config.servicesRequireApproved && provider.listed !== 'approved') {
      throw new ServiceError(503, '该服务暂时不可用。');
    }
    const deliver = delivers[definition.deliver];
    if (!deliver) throw new ServiceError(503, '该服务暂时不可用。');
    return {
      definition,
      payTo: getAddress(provider.agentWallet) as Address,
      deliver,
    };
  };

  return {
    list: () => [...definitions],
    get: (serviceId: string) => byId.get(serviceId) ?? null,
    resolve,
  };
}

export type ServiceCatalog = ReturnType<typeof createServiceCatalog>;
