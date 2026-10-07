import { createHash } from 'node:crypto';
import { getAddress } from 'viem';
import type { Address } from './types.ts';

// Known settlement networks. This module is the single source of truth for
// chain facts (chain id, CAIP-2, RPC, explorer, asset, finality). Nothing else
// in src/ may hard-code a chain id or asset address.

export type TransferMethod = 'eip3009' | 'eip2612' | 'permit2';

export type FinalityRule =
  | { readonly kind: 'canonical' }
  | { readonly kind: 'finalized' }
  | { readonly kind: 'confirmations'; readonly confirmations: number };

export type NetworkAsset = {
  readonly address: Address;
  readonly decimals: number;
  readonly symbol: string;
  readonly transferMethods: readonly TransferMethod[];
};

export type NetworkProfile = {
  readonly name: NetworkName;
  readonly displayName: string;
  // Native gas token symbol, used in agent-facing copy. Cosmetic only; it is
  // deliberately not part of the settlement fingerprint.
  readonly nativeSymbol: string;
  readonly chainId: number;
  readonly caip2: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly asset: NetworkAsset;
  readonly permit2?: Address;
  readonly x402Permit2Proxy?: Address;
  // ERC-8004 IdentityRegistry (proxy). Declared here when the network has a
  // deployed registry; the local profile leaves it unset so tests and local
  // configs inject the freshly deployed address.
  readonly identityRegistry?: Address;
  readonly finality: FinalityRule;
  // Whether the Settlement payout contract is mandatory for this network.
  // false lets the service start with the payout worker disabled.
  readonly payoutsRequired: boolean;
};

export const NETWORK_NAMES = ['local', 'fuji', 'botchain-testnet'] as const;
export type NetworkName = (typeof NETWORK_NAMES)[number];

// Deployed per-run by scripts/local-chain.ts. The live address always comes
// from .local/chain.json (or SETTLEMENT_TOKEN); this is the deterministic
// first-deploy address used as the profile default.
const LOCAL_TEST_USDC = '0xF2E246BB76DF876Cef8b38ae84130F4F55De395b' as Address;

const PROFILES: Record<NetworkName, NetworkProfile> = {
  local: {
    name: 'local',
    displayName: 'Local testnet',
    nativeSymbol: 'tBOT',
    chainId: 31337,
    caip2: 'eip155:31337',
    rpcUrl: 'http://127.0.0.1:8547',
    explorerUrl: '',
    asset: {
      address: LOCAL_TEST_USDC,
      decimals: 6,
      symbol: 'USDC',
      transferMethods: [],
    },
    finality: { kind: 'canonical' },
    payoutsRequired: true,
  },
  fuji: {
    name: 'fuji',
    displayName: 'Avalanche Fuji',
    nativeSymbol: 'AVAX',
    chainId: 43113,
    caip2: 'eip155:43113',
    rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
    explorerUrl: 'https://testnet.snowtrace.io',
    asset: {
      address: '0x5425890298aed601595a70AB815c96711a31Bc65',
      decimals: 6,
      symbol: 'USDC',
      // Fuji USDC has EIP-3009 for the partner-center order flow; Permit2 is
      // what the BF Market agent platform settles through.
      transferMethods: ['eip3009', 'permit2'],
    },
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    x402Permit2Proxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
    // ERC-8004 official IdentityRegistry on Fuji (owner is the official
    // deployer; registration is open to anyone).
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    finality: { kind: 'finalized' },
    // The partner center pays commissions on Fuji, so a Fuji deployment still
    // needs a Settlement contract and an executor key by default. An
    // x402-only deployment (the BF Market site) opts out explicitly with
    // SETTLEMENT_PAYOUTS_DISABLED instead of faking a contract.
    payoutsRequired: true,
  },
  'botchain-testnet': {
    name: 'botchain-testnet',
    displayName: 'BOT Chain Testnet',
    nativeSymbol: 'tBOT',
    chainId: 968,
    caip2: 'eip155:968',
    rpcUrl: 'https://rpc.bohr.life',
    explorerUrl: 'https://scan.bohr.life',
    asset: {
      address: '0x75edC9335175Fc0552D51D48439F229c10420fe3',
      decimals: 6,
      symbol: 'USDT',
      transferMethods: ['permit2'],
    },
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    x402Permit2Proxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
    identityRegistry: '0xe35a670Ec84477b54f976Ddfa5f8E4601FfC8607',
    finality: { kind: 'finalized' },
    payoutsRequired: false,
  },
};

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

const CAIP2_RE = /^eip155:([1-9][0-9]*)$/;

for (const name of NETWORK_NAMES) {
  const profile = PROFILES[name];
  if (profile.caip2 !== `eip155:${profile.chainId}`) {
    throw new Error(`网络 profile ${name} 的 CAIP-2 与 chainId 不一致。`);
  }
}

export const NETWORK_PROFILES: Readonly<Record<NetworkName, NetworkProfile>> =
  deepFreeze(PROFILES);

export function isNetworkName(value: string): value is NetworkName {
  return (NETWORK_NAMES as readonly string[]).includes(value);
}

export function selectNetworkByName(value: string): NetworkProfile {
  const name = value.trim();
  if (!isNetworkName(name)) {
    throw new Error(
      `未知结算网络 ${value}。只允许：${NETWORK_NAMES.join(' | ')}。`,
    );
  }
  return NETWORK_PROFILES[name];
}

export function profileForChainId(chainId: number): NetworkProfile | null {
  for (const name of NETWORK_NAMES) {
    if (NETWORK_PROFILES[name].chainId === chainId) {
      return NETWORK_PROFILES[name];
    }
  }
  return null;
}

export function chainIdFromCaip2(caip2: string): number {
  const match = CAIP2_RE.exec(caip2);
  if (!match) throw new Error(`不支持的 CAIP-2 网络标识：${caip2}`);
  return Number(match[1]);
}

function fingerprintPayload(profile: NetworkProfile) {
  return {
    name: profile.name,
    chainId: profile.chainId,
    caip2: profile.caip2,
    rpcUrl: profile.rpcUrl.replace(/\/+$/, ''),
    explorerUrl: profile.explorerUrl.replace(/\/+$/, ''),
    asset: {
      address: getAddress(profile.asset.address).toLowerCase(),
      decimals: profile.asset.decimals,
      symbol: profile.asset.symbol,
      transferMethods: [...profile.asset.transferMethods].sort(),
    },
    permit2: profile.permit2 ? getAddress(profile.permit2).toLowerCase() : null,
    x402Permit2Proxy: profile.x402Permit2Proxy
      ? getAddress(profile.x402Permit2Proxy).toLowerCase()
      : null,
    identityRegistry: profile.identityRegistry
      ? getAddress(profile.identityRegistry).toLowerCase()
      : null,
    finality: profile.finality,
  };
}

export function networkFingerprint(profile: NetworkProfile): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(fingerprintPayload(profile)))
    .digest('hex');
  return `sha256:${digest}`;
}
