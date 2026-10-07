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
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { profileForChainId } from './network.ts';
import type { Address, AgentProfile, AgentProfileService, Hex } from './types.ts';
import { ServiceError } from './types.ts';

// ERC-8004 IdentityRegistry surface used by the registration flow, the owner
// console reads and the owner-driven wallet rotation (EIP-712 consent).
export const identityRegistryAbi = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  // Owner-driven wallet rotation (EIP-712 consent) plus the ERC-721 transfer
  // used to build the transferred-away cases.
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'function unsetAgentWallet(uint256 agentId)',
  'function transferFrom(address from, address to, uint256 agentId)',
  // IERC-5267 domain getter: the consent must be signed over the registry's own
  // domain, never a copy hard-coded here.
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
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

// --- setAgentWallet consent (ERC-8004 owner-driven wallet rotation) ---------
//
// The registry verifies an EIP-712 signature from the *new* wallet over
// AgentWalletSet(agentId, newWallet, owner, deadline) and rejects a deadline
// more than five minutes out. The domain is read from the contract itself, so
// these helpers never assume the name or version.

export const AGENT_WALLET_SET_DOMAIN_NAME = 'ERC8004IdentityRegistry';
export const AGENT_WALLET_SET_DOMAIN_VERSION = '1';
// MAX_DEADLINE_DELAY in contracts/erc8004/IdentityRegistryUpgradeable.sol.
export const AGENT_WALLET_SET_MAX_DEADLINE_SECONDS = 300;

export const agentWalletSetTypes = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type AgentWalletSetDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
};

export type AgentWalletSetConsent = {
  agentId: bigint;
  newWallet: Address;
  owner: Address;
  deadline: bigint;
};

export function agentWalletSetTypedData(input: {
  domain: AgentWalletSetDomain;
  consent: AgentWalletSetConsent;
}) {
  return {
    domain: {
      name: input.domain.name,
      version: input.domain.version,
      chainId: input.domain.chainId,
      verifyingContract: getAddress(input.domain.verifyingContract),
    },
    types: agentWalletSetTypes,
    primaryType: 'AgentWalletSet' as const,
    message: {
      agentId: input.consent.agentId,
      newWallet: getAddress(input.consent.newWallet),
      owner: getAddress(input.consent.owner),
      deadline: input.consent.deadline,
    },
  };
}

// A deadline the contract accepts: at most five minutes past block time.
export function agentWalletSetDeadline(
  nowSeconds: bigint,
  ttlSeconds: number = AGENT_WALLET_SET_MAX_DEADLINE_SECONDS,
): bigint {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > AGENT_WALLET_SET_MAX_DEADLINE_SECONDS
  ) {
    throw new Error(
      `The setAgentWallet deadline must be 1 to ${AGENT_WALLET_SET_MAX_DEADLINE_SECONDS} seconds ahead.`,
    );
  }
  return nowSeconds + BigInt(ttlSeconds);
}

export async function readAgentWalletSetDomain(
  client: PublicClient,
  registry: Address,
): Promise<AgentWalletSetDomain> {
  const result = (await client.readContract({
    address: getAddress(registry),
    abi: identityRegistryAbi,
    functionName: 'eip712Domain',
  })) as unknown as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];
  const [, name, version, chainId, verifyingContract] = result;
  if (!name || !version) {
    throw new Error('The identity registry returned an empty EIP-712 domain.');
  }
  return {
    name,
    version,
    chainId: Number(chainId),
    verifyingContract: getAddress(verifyingContract),
  };
}

export function setAgentWalletCalldata(
  input: AgentWalletSetConsent & { signature: Hex },
): Hex {
  return encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: 'setAgentWallet',
    args: [input.agentId, getAddress(input.newWallet), input.deadline, input.signature],
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
    throw new ServiceError(400, `${label} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new ServiceError(400, `${label} must be between 1 and ${max} characters.`);
  }
  return trimmed;
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ServiceError(400, `${label} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ServiceError(400, `${label} must be at most ${max} characters.`);
  }
  return trimmed.length ? trimmed : undefined;
}

export function validateAgentProfile(
  input: unknown,
  opts?: { allowInsecureLocal?: boolean },
): AgentProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(400, 'Invalid agent profile.');
  }
  const raw = input as Record<string, unknown>;
  const allowInsecureLocal = opts?.allowInsecureLocal === true;
  const name = requiredString(raw.name, 'Agent name', AGENT_NAME_MAX);
  const description = optionalString(
    raw.description,
    'Agent description',
    AGENT_DESCRIPTION_MAX,
  );
  const image = optionalString(raw.image, 'Agent image', AGENT_IMAGE_MAX);
  if (image && !allowedUrl(image, allowInsecureLocal)) {
    throw new ServiceError(400, 'Agent image must be an HTTPS URL.');
  }
  const rawServices = raw.services;
  if (!Array.isArray(rawServices) || rawServices.length === 0) {
    throw new ServiceError(400, 'The agent services list must not be empty.');
  }
  if (rawServices.length > AGENT_SERVICES_MAX) {
    throw new ServiceError(400, `At most ${AGENT_SERVICES_MAX} agent services are allowed.`);
  }
  const services: AgentProfileService[] = rawServices.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ServiceError(400, 'Invalid agent service entry.');
    }
    const service = item as Record<string, unknown>;
    const serviceName = requiredString(
      service.name,
      'Service name',
      AGENT_SERVICE_NAME_MAX,
    );
    const endpoint = requiredString(service.endpoint, 'Service endpoint', AGENT_IMAGE_MAX);
    if (!allowedUrl(endpoint, allowInsecureLocal)) {
      throw new ServiceError(400, 'Service endpoint must be an HTTPS URL.');
    }
    return { name: serviceName, endpoint };
  });
  const profile: AgentProfile = { name, services };
  if (description) profile.description = description;
  if (image) profile.image = image;
  if (raw.x402Support != null) {
    if (typeof raw.x402Support !== 'boolean') {
      throw new ServiceError(400, 'x402Support must be a boolean.');
    }
    profile.x402Support = raw.x402Support;
  }
  if (raw.active != null) {
    if (typeof raw.active !== 'boolean') {
      throw new ServiceError(400, 'active must be a boolean.');
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
