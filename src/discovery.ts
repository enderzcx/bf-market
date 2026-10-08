import { getAddress } from 'viem';
import { agentRegistryId } from './agent-registry.ts';
import type { RuntimeConfig } from './config.ts';
import type { ServiceCatalog, ServiceDefinition } from './services.ts';
import type { Store } from './store.ts';
import type { Address } from './types.ts';
import { ServiceError } from './types.ts';
import { X402_VERSION, type X402PaymentRequirements } from './x402/types.ts';

// x402 Bazaar discovery extension (specs/extensions/bazaar.md). The extension
// rides in the `extensions` object of a 402 Payment Required response and in
// the `/discovery/resources` catalog. `info` carries the discovery data and
// `schema` validates its structure.
//
// Over HTTP a delivered result is the body `{ result: <output> }`, so the HTTP
// output example carries that envelope. MCP `call_service` returns the bare
// output as `structuredContent`, so the MCP example stays unwrapped.
const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

export const BAZAAR_KEY = 'bazaar';

// HTTP POST endpoints: the paid service is called at its own URL with a JSON body.
export function bazaarHttpExtension(definition: ServiceDefinition): Record<string, unknown> {
  return {
    [BAZAAR_KEY]: {
      info: {
        input: {
          type: 'http',
          method: 'POST',
          bodyType: 'json',
          body: definition.inputExample,
          inputSchema: definition.inputSchema,
        },
        output: { type: 'json', example: { result: definition.outputExample } },
      },
      schema: httpSchema(),
    },
  };
}

// MCP tools: identified by the tuple (resource.url, input.toolName). The
// per-service `inputSchema` describes the `body` argument of `call_service`.
export function bazaarMcpExtension(
  definition: ServiceDefinition,
  toolName: string,
): Record<string, unknown> {
  return {
    [BAZAAR_KEY]: {
      info: {
        input: {
          type: 'mcp',
          toolName,
          description: definition.description,
          transport: 'streamable-http',
          inputSchema: {
            type: 'object',
            properties: {
              serviceId: { type: 'string', const: definition.serviceId },
              body: definition.inputSchema,
            },
            required: ['serviceId', 'body'],
          },
          example: { serviceId: definition.serviceId, body: definition.inputExample },
        },
        output: { type: 'json', example: definition.outputExample },
      },
      schema: mcpSchema(),
    },
  };
}

function httpSchema(): Record<string, unknown> {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'http' },
          method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
          bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] },
          body: { type: 'object' },
          inputSchema: { type: 'object' },
        },
        required: ['type', 'method', 'bodyType', 'body'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { type: { type: 'string' }, example: {} },
        required: ['type'],
      },
    },
    required: ['input'],
  };
}

function mcpSchema(): Record<string, unknown> {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'mcp' },
          toolName: { type: 'string' },
          description: { type: 'string' },
          transport: { type: 'string', enum: ['streamable-http', 'sse'] },
          inputSchema: { type: 'object' },
          example: { type: 'object' },
        },
        required: ['type', 'toolName', 'inputSchema'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { type: { type: 'string' }, example: {} },
        required: ['type'],
      },
    },
    required: ['input'],
  };
}

export type DiscoveryFilter = {
  type?: string;
  payTo?: string;
  scheme?: string;
  network?: string;
  extensions?: string;
  limit?: number;
  offset?: number;
};

export type DiscoveryItem = {
  resource: string;
  type: string;
  x402Version: number;
  accepts: X402PaymentRequirements[];
  description: string;
  mimeType: string;
  lastUpdated: string;
  extensions: Record<string, unknown>;
  provider: {
    agentId: string;
    agentRegistry: string | null;
    name: string;
    role: string;
    agentWallet: string;
    agentUri: string;
  };
};

export type DiscoveryNetwork = {
  name: string;
  displayName: string;
  chainId: number;
  caip2: string;
  explorer: string;
  faucet: string | null;
  asset: string;
  symbol: string;
  decimals: number;
};

export type DiscoveryList = {
  x402Version: number;
  // Network facts for the same catalog, so a public page can render explorer
  // links without hard-coding a chain id.
  network: DiscoveryNetwork;
  items: DiscoveryItem[];
  pagination: { limit: number; offset: number; total: number };
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parseDiscoveryFilter(searchParams: URLSearchParams): DiscoveryFilter {
  const filter: DiscoveryFilter = {};
  for (const key of ['type', 'payTo', 'scheme', 'network', 'extensions'] as const) {
    const value = searchParams.get(key);
    if (value != null && value !== '') filter[key] = value;
  }
  for (const key of ['limit', 'offset'] as const) {
    const value = searchParams.get(key);
    if (value == null || value === '') continue;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ServiceError(400, 'Invalid pagination parameter.');
    }
    filter[key] = parsed;
  }
  return filter;
}

function isValidPayTo(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function createServiceDiscovery(opts: {
  store: Store;
  config: RuntimeConfig;
  catalog: ServiceCatalog;
  // Advertised payment options for a service. Metered services list the upto
  // option at their fixed quote; fixed-price services list exact.
  acceptsFor: (definition: ServiceDefinition, payTo: Address) => X402PaymentRequirements[];
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;

  const networkInfo = (): DiscoveryNetwork => ({
    name: opts.config.network.name,
    displayName: opts.config.network.displayName,
    chainId: opts.config.network.chainId,
    caip2: opts.config.network.caip2,
    explorer: opts.config.network.explorerUrl,
    faucet: opts.config.network.faucetUrl ?? null,
    asset: opts.config.chain.token,
    symbol: opts.config.network.asset.symbol,
    decimals: opts.config.network.asset.decimals,
  });

  const serviceUrl = (origin: string, serviceId: string) =>
    `${origin.replace(/\/+$/, '')}/api/services/${encodeURIComponent(serviceId)}/call`;

  const build = (origin: string, definition: ServiceDefinition, payTo: Address): DiscoveryItem => {
    const provider = opts.store.getAgent(opts.config.chain.chainId, definition.providerAgentId);
    const draft = opts.store.getAgentDraftByAgentId(definition.providerAgentId);
    const accepts = opts.acceptsFor(definition, payTo);
    const registry = opts.config.identityRegistry;
    const lastUpdated = provider?.createdAt
      ? new Date(provider.createdAt).toISOString()
      : new Date(now()).toISOString();
    return {
      resource: serviceUrl(origin, definition.serviceId),
      type: 'http',
      x402Version: X402_VERSION,
      accepts,
      description: definition.description,
      mimeType: 'application/json',
      lastUpdated,
      extensions: bazaarHttpExtension(definition),
      provider: {
        agentId: definition.providerAgentId,
        agentRegistry: registry ? agentRegistryId(opts.config.chain.chainId, registry) : null,
        name: draft?.profile.name ?? `Agent ${definition.providerAgentId}`,
        role: provider?.role ?? 'provider',
        agentWallet: payTo,
        agentUri: provider?.agentUri ?? '',
      },
    };
  };

  const all = (origin: string): DiscoveryItem[] =>
    opts.catalog
      .available()
      .map(({ definition, payTo }) => build(origin, definition, payTo));

  const applyFilter = (items: DiscoveryItem[], filter: DiscoveryFilter): DiscoveryItem[] => {
    return items.filter((item) => {
      if (filter.type && item.type !== filter.type) return false;
      if (filter.scheme && !item.accepts.some((a) => a.scheme === filter.scheme)) return false;
      if (filter.network && !item.accepts.some((a) => a.network === filter.network)) return false;
      if (filter.payTo && !item.accepts.some((a) => getAddress(a.payTo) === getAddress(filter.payTo!))) {
        return false;
      }
      if (filter.extensions && !(filter.extensions in item.extensions)) return false;
      return true;
    });
  };

  const matchesQuery = (item: DiscoveryItem, query: string): boolean => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const haystack = [
      item.resource,
      item.description,
      item.provider.name,
      item.provider.agentId,
      ...item.accepts.map((a) => a.asset),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  };

  const paginate = (items: DiscoveryItem[], filter: DiscoveryFilter) => {
    const total = items.length;
    const offset = Math.min(filter.offset ?? 0, total);
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    return { page: items.slice(offset, offset + limit), total, limit, offset };
  };

  return {
    list(origin: string, filter: DiscoveryFilter): DiscoveryList {
      if (filter.type && filter.type !== 'http' && filter.type !== 'mcp') {
        throw new ServiceError(400, 'Invalid resource type.');
      }
      if (filter.payTo && !isValidPayTo(filter.payTo)) {
        throw new ServiceError(400, 'Invalid payout address.');
      }
      const items = applyFilter(all(origin), filter);
      const { page, total, limit, offset } = paginate(items, filter);
      return {
        x402Version: X402_VERSION,
        network: networkInfo(),
        items: page,
        pagination: { limit, offset, total },
      };
    },

    search(origin: string, filter: DiscoveryFilter & { query?: string }) {
      const items = applyFilter(all(origin), filter).filter((item) =>
        matchesQuery(item, filter.query ?? ''),
      );
      const { page, total, limit, offset } = paginate(items, filter);
      return {
        x402Version: X402_VERSION,
        network: networkInfo(),
        resources: page,
        pagination: { limit, offset, total },
      };
    },

    get(origin: string, serviceId: string): DiscoveryItem | null {
      const available = opts.catalog.available().find((s) => s.definition.serviceId === serviceId);
      if (!available) return null;
      return build(origin, available.definition, available.payTo);
    },
  };
}

export type ServiceDiscovery = ReturnType<typeof createServiceDiscovery>;
