import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  parseAbi,
  type TransactionReceipt,
} from 'viem';
import { profileForChainId } from './network.ts';
import type { Address, AgentProfile, AgentProfileService, Hex } from './types.ts';
import { ServiceError } from './types.ts';

// ERC-8004 IdentityRegistry surface used by the registration flow. Only the
// register/read paths are needed; metadata writes stay out of M3.
export const identityRegistryAbi = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

export const AGENT_ROLES = ['provider', 'buyer'] as const;
export const LISTED_STATUSES = ['pending', 'approved', 'rejected'] as const;

export const MAX_AGENT_DRAFTS_PER_ADDRESS = 5;
export const AGENT_NAME_MAX = 64;
export const AGENT_DESCRIPTION_MAX = 500;
export const AGENT_SERVICE_NAME_MAX = 64;
export const AGENT_SERVICES_MAX = 8;
export const AGENT_IMAGE_MAX = 512;
export const REGISTRATION_TYPE =
  'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

const DRAFT_ID_RE = /^[0-9a-f]{32}$/;

export function newDraftId(): string {
  return randomBytes(16).toString('hex');
}

export function isDraftId(value: string): boolean {
  return DRAFT_ID_RE.test(value);
}

// eip155:<chainId>:<registry>, the ERC-8004 registration identifier.
export function agentRegistryId(chainId: number, registry: Address): string {
  return `eip155:${chainId}:${getAddress(registry)}`;
}

export function agentUriFor(origin: string, draftId: string): string {
  return `${origin.replace(/\/+$/, '')}/registrations/${draftId}.json`;
}

export function parseDraftIdFromUri(uri: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = /^\/registrations\/([0-9a-f]{32})\.json$/.exec(url.pathname);
  return match ? match[1]! : null;
}

export function registerCalldata(agentURI: string): Hex {
  return encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [agentURI],
  });
}

function allowedUrl(value: string, allowInsecureLocal: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return !!url.hostname;
  if (!allowInsecureLocal) return false;
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  );
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') {
    throw new ServiceError(400, `${label}必须是文本。`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new ServiceError(400, `${label}长度必须在 1 到 ${max} 之间。`);
  }
  return trimmed;
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ServiceError(400, `${label}必须是文本。`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ServiceError(400, `${label}长度不能超过 ${max}。`);
  }
  return trimmed.length ? trimmed : undefined;
}

export function validateAgentProfile(
  input: unknown,
  opts?: { allowInsecureLocal?: boolean },
): AgentProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, '代理档案无效。');
  }
  const raw = input as Record<string, unknown>;
  const allowInsecureLocal = opts?.allowInsecureLocal === true;
  const name = requiredString(raw.name, '代理名称', AGENT_NAME_MAX);
  const description = optionalString(
    raw.description,
    '代理描述',
    AGENT_DESCRIPTION_MAX,
  );
  const image = optionalString(raw.image, '代理图标', AGENT_IMAGE_MAX);
  if (image && !allowedUrl(image, allowInsecureLocal)) {
    throw new ServiceError(400, '代理图标必须是 HTTPS 地址。');
  }
  const rawServices = raw.services;
  if (!Array.isArray(rawServices) || rawServices.length === 0) {
    throw new ServiceError(400, '代理服务列表不能为空。');
  }
  if (rawServices.length > AGENT_SERVICES_MAX) {
    throw new ServiceError(400, `代理服务最多 ${AGENT_SERVICES_MAX} 个。`);
  }
  const services: AgentProfileService[] = rawServices.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ServiceError(400, '代理服务条目无效。');
    }
    const service = item as Record<string, unknown>;
    const serviceName = requiredString(
      service.name,
      '服务名称',
      AGENT_SERVICE_NAME_MAX,
    );
    const endpoint = requiredString(service.endpoint, '服务地址', AGENT_IMAGE_MAX);
    if (!allowedUrl(endpoint, allowInsecureLocal)) {
      throw new ServiceError(400, '服务地址必须是 HTTPS 地址。');
    }
    return { name: serviceName, endpoint };
  });
  const profile: AgentProfile = { name, services };
  if (description) profile.description = description;
  if (image) profile.image = image;
  if (raw.x402Support != null) {
    if (typeof raw.x402Support !== 'boolean') {
      throw new ServiceError(400, 'x402Support 必须是布尔值。');
    }
    profile.x402Support = raw.x402Support;
  }
  if (raw.active != null) {
    if (typeof raw.active !== 'boolean') {
      throw new ServiceError(400, 'active 必须是布尔值。');
    }
    profile.active = raw.active;
  }
  return profile;
}

export function buildRegistrationDocument(input: {
  profile: AgentProfile;
  registrations: Array<{ agentId: string; agentRegistry: string }>;
}): Record<string, unknown> {
  const { profile } = input;
  const doc: Record<string, unknown> = {
    type: REGISTRATION_TYPE,
    name: profile.name,
  };
  if (profile.description) doc.description = profile.description;
  if (profile.image) doc.image = profile.image;
  doc.services = profile.services;
  doc.x402Support = profile.x402Support ?? false;
  doc.active = profile.active ?? true;
  doc.registrations = input.registrations;
  return doc;
}

export type RegisteredEvent = {
  agentId: bigint;
  agentURI: string;
  owner: Address;
};

export function decodeRegisteredEvent(
  receipt: TransactionReceipt,
  registry: Address,
): RegisteredEvent | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
    try {
      const event = decodeEventLog({
        abi: identityRegistryAbi,
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName !== 'Registered') continue;
      const args = event.args as {
        agentId: bigint;
        agentURI: string;
        owner: Address;
      };
      return {
        agentId: args.agentId,
        agentURI: args.agentURI,
        owner: getAddress(args.owner) as Address,
      };
    } catch {
      /* unrelated logs on the registry are not registration evidence */
    }
  }
  return null;
}

// Read-only registry surface. Returns null for a receipt that is missing,
// reorged out, or not yet final, so the caller can answer 202 pending.
export interface AgentRegistryChain {
  getChainId(): Promise<number>;
  getFinalizedReceipt(txHash: Hex): Promise<TransactionReceipt | null>;
  readOwnerOf(agentId: bigint): Promise<Address>;
  readAgentWallet(agentId: bigint): Promise<Address>;
}

export function createRpcAgentRegistryChain(input: {
  rpcUrl: string;
  chainId: number;
  registry: Address;
}): AgentRegistryChain {
  const finalized =
    profileForChainId(input.chainId)?.finality.kind === 'finalized';
  const chain = defineChain({
    id: input.chainId,
    name: 'agent registry network',
    nativeCurrency: { name: 'Test gas', symbol: 'TEST', decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(input.rpcUrl),
    cacheTime: 0,
  });
  const registry = getAddress(input.registry);
  return {
    async getChainId() {
      const id = await client.getChainId();
      if (id !== input.chainId) throw new Error('RPC chain mismatch');
      return id;
    },
    async getFinalizedReceipt(txHash) {
      let receipt: TransactionReceipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash });
      } catch {
        return null;
      }
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) return null;
      if (finalized) {
        const finalizedBlock = await client.getBlock({ blockTag: 'finalized' });
        if (
          finalizedBlock.number === null ||
          finalizedBlock.number < receipt.blockNumber
        ) {
          return null;
        }
      }
      return receipt;
    },
    async readOwnerOf(agentId) {
      return (await client.readContract({
        address: registry,
        abi: identityRegistryAbi,
        functionName: 'ownerOf',
        args: [agentId],
      })) as Address;
    },
    async readAgentWallet(agentId) {
      return (await client.readContract({
        address: registry,
        abi: identityRegistryAbi,
        functionName: 'getAgentWallet',
        args: [agentId],
      })) as Address;
    },
  };
}

export function isAgentAddress(value: unknown): value is Address {
  return typeof value === 'string' && isAddress(value, { strict: false });
}
