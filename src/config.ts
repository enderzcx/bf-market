import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { getAddress, isAddress, isHex, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_MIN_AMOUNT } from './money.ts';
import {
  NETWORK_PROFILES,
  NETWORK_NAMES,
  profileForChainId,
  selectNetworkByName,
  type NetworkProfile,
} from './network.ts';
import type { Address, Hex, SourceKind } from './types.ts';
import { ServiceError } from './types.ts';

export const AUTH_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const AUTH_COOKIE_MAX_AGE_SEC = 8 * 60 * 60;

export const CIRCLE_FUJI_USDC = NETWORK_PROFILES.fuji.asset.address;
export const X402_NETWORK = NETWORK_PROFILES.fuji.caip2;
export const MERCHANT_ID = 'demo-merchant';
export const PARTNER_ID = 'demo-partner';
export const PARTNER_NAME = '演示推广者';
export const DEFAULT_PORT = 4311;
export const DEFAULT_TICK_MS = 30_000;
export const DEFAULT_MATURITY_MS = 60_000;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const BODY_LIMIT = 16 * 1024;
export const DEFAULT_X402_FACILITATOR_URL = 'https://facilitator.payai.network';
export const DEFAULT_BEEFAPI_LLM_BASE_URL = 'https://global.beefapi.com';
export const DEFAULT_LLM_PAYER_DAILY_CAP_ATOMIC = 5_000_000n;
export const DEFAULT_LLM_GLOBAL_DAILY_CAP_ATOMIC = 50_000_000n;
// Ceiling for any user-set daily budget (architecture decision N1). Kept equal
// to the LLM per-wallet cap for now; it can be tuned independently later.
export const DEFAULT_SETTLEMENT_BUDGET_MAX_ATOMIC = 5_000_000n;
export const X402_MAX_TIMEOUT_SECONDS = 300;
export const X402_HEADER_LIMIT = 8 * 1024;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export type ChainConfigInput = {
  rpcUrl: string;
  chainId: number;
  contract?: Address;
  token: Address;
  privateKey?: Hex;
  recipient?: Address;
};

export type ChainConfig = {
  rpcUrl: string;
  chainId: number;
  contract: Address;
  token: Address;
  privateKey?: Hex;
  recipient?: Address;
};

export type RuntimeConfig = {
  host: string;
  port: number;
  network: NetworkProfile;
  chain: ChainConfig;
  payoutsEnabled: boolean;
  payoutsDisabledReason: string | null;
  source: SourceKind;
  beefapiBaseUrl: string;
  beefapiToken: string;
  partnerUserId: number;
  minAmount: bigint;
  maturityMs: number;
  tickMs: number;
  dbPath: string;
  lockPath: string;
  publicDir: string;
  merchantId: string;
  partnerId: string;
  partnerName: string;
  orderDemo: boolean;
  authEnabled: boolean;
  publicOrigin: string | null;
  // Public origin used in on-chain agent registration documents. Separate from
  // the auth publicOrigin: registration only needs a network with an identity
  // registry, not the Fuji order-demo configuration.
  agentOrigin: string | null;
  identityRegistry: Address | null;
  starterGasEnabled: boolean;
  starterGasWei: bigint;
  starterGasDailyCapWei: bigint;
  starterGasBalanceThresholdWei: bigint;
  opsPrivateKey: Hex | null;
  merchantPasswordHash: string;
  promoterPasswordHash: string;
  x402Enabled: boolean;
  x402FacilitatorUrl: string;
  // Effective Permit2 + x402 Permit2 proxy for this network. Local injects them
  // (tests, local chain); other networks take the profile values.
  permit2: Address | null;
  x402Permit2Proxy: Address | null;
  // Self-hosted x402 Permit2 settlement (M4). Independent of the legacy
  // Fuji EIP-3009 order demo above.
  settlementX402Permit2Enabled: boolean;
  // When true, only `approved` providers may serve paid calls; pending is
  // allowed by default so tests and first-run providers can be exercised.
  servicesRequireApproved: boolean;
  serviceProviderAgentId: string;
  serviceEchoPrice: bigint;
  // Metered BeefAPI-backed LLM services (M5). Listed only when the switch is on
  // and the BeefAPI credential is present.
  llmServicesEnabled: boolean;
  llmBeefapiBaseUrl: string;
  llmBeefapiApiKey: string;
  // Per-payer and global daily caps on actual charges, in USDT atomic units.
  llmPayerDailyCapAtomic: bigint;
  llmGlobalDailyCapAtomic: bigint;
  // Upper bound on any user-set daily budget (owner ceiling or wallet value),
  // in USDT atomic units. `0` pauses paid calls.
  settlementBudgetMaxAtomic: bigint;
  // Upstream BeefAPI request timeout. Defaults to 60s; tests shorten it.
  llmRequestTimeoutMs: number;
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.replace(/^\[|\]$/g, '').toLowerCase());
}

export function assertLoopbackBind(host: string) {
  if (!isLoopbackHost(host)) {
    throw new Error(`拒绝绑定非本机地址 ${host}。结算服务只监听 127.0.0.1。`);
  }
}

export function originOf(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

export function networkMeta(
  chainId: number,
  token: string,
  extra?: { configured?: boolean; error?: string },
) {
  const configured = extra?.configured ?? true;
  const error = extra?.error;
  const profile = profileForChainId(chainId);
  const base = {
    name: profile?.displayName ?? `Chain ${chainId}`,
    chainId,
    explorer: profile?.explorerUrl ?? '',
    configured,
    token,
  };
  return error ? { ...base, error } : base;
}

export function executorAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address as Address;
}

export function runtimeFingerprint(config: RuntimeConfig, executor?: Address): string {
  const exec =
    executor ??
    (config.chain.privateKey
      ? executorAddress(config.chain.privateKey)
      : undefined);
  return keccak256(
    toHex(
      [
        config.source,
        config.source === 'beefapi' ? config.beefapiBaseUrl : '',
        config.partnerId,
        String(config.partnerUserId),
        String(config.chain.chainId),
        getAddress(config.chain.token),
        getAddress(config.chain.contract),
        exec ? getAddress(exec) : '',
      ].join('|'),
    ),
  );
}

function requiredAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new Error(`${label} 不是有效地址。`);
  }
  return getAddress(value) as Address;
}

function requiredKey(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !isHex(value) || value.length !== 66) {
    throw new Error(`${label} 必须是 32 字节十六进制私钥。`);
  }
  return value.toLowerCase() as Hex;
}

function requiredRpc(value: unknown, profile: NetworkProfile): string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) {
    throw new Error('必须提供明确的 RPC 地址。');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('RPC 地址无效。');
  }
  if (profile.name === 'local' && !isLoopbackHost(url.hostname)) {
    throw new Error('本地链 RPC 必须是本机回环地址。');
  }
  return value;
}

function intEnv(value: string | undefined, fallback: number, label: string): number {
  if (value == null || value === '') return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} 必须是整数。`);
  return Number(value);
}

function flagEnv(value: string | undefined, label: string): boolean {
  if (value == null || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} 只允许 true 或 false。`);
}

function weiEnv(value: string | undefined, label: string): bigint | undefined {
  if (value == null || value === '') return undefined;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} 必须是非负整数 wei。`);
  return BigInt(value);
}

function requiredWei(value: bigint | undefined, label: string): bigint {
  if (value == null || value <= 0n) {
    throw new Error(`${label} 必须提供大于 0 的 wei 金额。`);
  }
  return value;
}

function namespacePath(path: string, profile: NetworkProfile): string {
  // Fuji keeps the original database/lock path so existing deployments still
  // find their ledger. Every other network gets a suffix.
  if (profile.name === 'fuji') return path;
  const dir = dirname(path);
  const file = basename(path);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  return join(dir, `${stem}.${profile.name}${ext}`);
}

export function assertSupportedPasswordHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 30 || value.length > 512) {
    throw new Error(`${label} 必须是受支持的密码哈希。`);
  }
  const argon =
    /^\$argon2(id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;
  const bcrypt = /^\$2[abxy]\$\d{2}\$[A-Za-z0-9./]{53}$/;
  if (!argon.test(value) && !bcrypt.test(value)) {
    throw new Error(`${label} 必须是受支持的密码哈希。`);
  }
  return value;
}

export function parseX402FacilitatorUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SETTLEMENT_X402_FACILITATOR_URL 必须是不含路径的 HTTPS 地址。');
  }
  if (url.protocol !== 'https:') {
    throw new Error('SETTLEMENT_X402_FACILITATOR_URL 必须是不含路径的 HTTPS 地址。');
  }
  if (url.username || url.password) {
    throw new Error('SETTLEMENT_X402_FACILITATOR_URL 必须是不含路径的 HTTPS 地址。');
  }
  if (url.search || url.hash) {
    throw new Error('SETTLEMENT_X402_FACILITATOR_URL 必须是不含路径的 HTTPS 地址。');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('SETTLEMENT_X402_FACILITATOR_URL 必须是不含路径的 HTTPS 地址。');
  }
  if (!url.hostname) {
    throw new Error('SETTLEMENT_X402_FACILITATOR_URL 必须是不含路径的 HTTPS 地址。');
  }
  return url.origin;
}

export function parsePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SETTLEMENT_PUBLIC_ORIGIN 必须是不含路径的 HTTPS 来源。');
  }
  if (url.protocol !== 'https:') {
    throw new Error('SETTLEMENT_PUBLIC_ORIGIN 必须是不含路径的 HTTPS 来源。');
  }
  if (url.username || url.password) {
    throw new Error('SETTLEMENT_PUBLIC_ORIGIN 必须是不含路径的 HTTPS 来源。');
  }
  if (url.search || url.hash) {
    throw new Error('SETTLEMENT_PUBLIC_ORIGIN 必须是不含路径的 HTTPS 来源。');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('SETTLEMENT_PUBLIC_ORIGIN 必须是不含路径的 HTTPS 来源。');
  }
  if (value !== url.origin) {
    throw new Error('SETTLEMENT_PUBLIC_ORIGIN 必须是不含路径的 HTTPS 来源。');
  }
  return url.origin;
}

export type RuntimeConfigInput = Omit<Partial<RuntimeConfig>, 'chain'> & {
  chain: ChainConfigInput;
};

export function runtimeConfig(partial: RuntimeConfigInput): RuntimeConfig {
  const host = partial.host ?? '127.0.0.1';
  assertLoopbackBind(host);
  const chainId = partial.chain.chainId;
  const profile = profileForChainId(chainId);
  if (!profile) {
    throw new Error(
      `未配置已知结算网络，拒绝启动。请设置 SETTLEMENT_NETWORK（${NETWORK_NAMES.join(' | ')}）。`,
    );
  }
  const token = requiredAddress(partial.chain.token, '代币');

  const hasContract =
    partial.chain.contract != null &&
    partial.chain.contract !== ZERO_ADDRESS;
  let contract: Address;
  let privateKey: Hex | undefined;
  if (profile.payoutsRequired) {
    contract = requiredAddress(partial.chain.contract, '结算合约');
    privateKey = requiredKey(partial.chain.privateKey, '执行钱包私钥');
  } else if (hasContract) {
    contract = requiredAddress(partial.chain.contract, '结算合约');
    privateKey = requiredKey(partial.chain.privateKey, '执行钱包私钥');
  } else {
    contract = ZERO_ADDRESS;
    privateKey =
      partial.chain.privateKey != null
        ? requiredKey(partial.chain.privateKey, '执行钱包私钥')
        : undefined;
  }
  const payoutsEnabled = profile.payoutsRequired || hasContract;
  const payoutsDisabledReason = payoutsEnabled
    ? null
    : `该网络（${profile.displayName}）未配置 Settlement 出款合约，出款 worker 未启动。`;

  const source = partial.source ?? 'fixture';
  const orderDemo = partial.orderDemo ?? false;
  const partnerUserId = partial.partnerUserId ?? 1;
  const authEnabled = partial.authEnabled ?? false;
  const publicOrigin = partial.publicOrigin ?? null;
  const x402Enabled = partial.x402Enabled ?? false;
  const x402FacilitatorUrl = x402Enabled
    ? parseX402FacilitatorUrl(
        partial.x402FacilitatorUrl && partial.x402FacilitatorUrl !== ''
          ? partial.x402FacilitatorUrl
          : DEFAULT_X402_FACILITATOR_URL,
      )
    : DEFAULT_X402_FACILITATOR_URL;
  let merchantPasswordHash = partial.merchantPasswordHash ?? '';
  let promoterPasswordHash = partial.promoterPasswordHash ?? '';
  if (orderDemo && (source !== 'beefapi' || partnerUserId !== 1)) {
    throw new Error('测试订单演示只适用于 beefapi 来源。');
  }
  if (authEnabled) {
    merchantPasswordHash = assertSupportedPasswordHash(
      merchantPasswordHash,
      'SETTLEMENT_MERCHANT_PASSWORD_HASH',
    );
    promoterPasswordHash = assertSupportedPasswordHash(
      promoterPasswordHash,
      'SETTLEMENT_PROMOTER_PASSWORD_HASH',
    );
    if (merchantPasswordHash === promoterPasswordHash) {
      throw new Error('商家与推广者必须使用不同的凭据。');
    }
    if (partnerUserId !== 1) {
      throw new Error('认证演示只支持一个固定推广者。');
    }
  } else if (publicOrigin) {
    throw new Error('SETTLEMENT_PUBLIC_ORIGIN 需要开启认证。');
  }
  if (publicOrigin) {
    parsePublicOrigin(publicOrigin);
    if (profile.name !== 'fuji') {
      throw new Error('公开来源只允许 Fuji 测试网。');
    }
    if (source !== 'beefapi' || !orderDemo) {
      throw new Error('公开来源需要订单演示。');
    }
  }
  if (x402Enabled) {
    if (source !== 'beefapi' || !orderDemo) {
      throw new Error('x402 测试付款只适用于 beefapi 订单演示。');
    }
    if (!profile.asset.transferMethods.includes('eip3009')) {
      throw new Error(
        `该网络的 x402 付款方式尚未支持（${profile.displayName} 不支持 EIP-3009；x402 测试付款只适用于 Fuji）。`,
      );
    }
  }

  // The identity registry comes from the profile, or (local only) from the
  // injected config, so tests and local chains can point at a fresh deployment.
  const identityRegistry = profile.identityRegistry
    ? getAddress(profile.identityRegistry) as Address
    : profile.name === 'local' && partial.identityRegistry
      ? requiredAddress(partial.identityRegistry, '身份注册表')
      : null;
  const hasRegistry = identityRegistry !== null;
  const agentOrigin = partial.agentOrigin ?? null;
  if (agentOrigin) {
    parsePublicOrigin(agentOrigin);
    if (!hasRegistry) {
      throw new Error('SETTLEMENT_PUBLIC_ORIGIN 用于注册文件时，网络必须有身份注册表。');
    }
  }

  const starterGasEnabled = partial.starterGasEnabled ?? false;
  let starterGasWei = 0n;
  let starterGasDailyCapWei = 0n;
  let starterGasBalanceThresholdWei = 0n;
  if (starterGasEnabled) {
    if (!hasRegistry) {
      throw new Error('启动 gas 只允许在有身份注册表的测试网或本地网络开启。');
    }
    starterGasWei = requiredWei(partial.starterGasWei, 'SETTLEMENT_STARTER_GAS_WEI');
    starterGasDailyCapWei = requiredWei(
      partial.starterGasDailyCapWei,
      'SETTLEMENT_STARTER_GAS_DAILY_CAP_WEI',
    );
    starterGasBalanceThresholdWei = requiredWei(
      partial.starterGasBalanceThresholdWei,
      'SETTLEMENT_STARTER_GAS_BALANCE_THRESHOLD_WEI',
    );
    if (starterGasWei > starterGasDailyCapWei) {
      throw new Error('单次启动 gas 金额不能超过每日总额上限。');
    }
  }

  // Permit2 + proxy come from the profile, or (local only) from injected config
  // so tests and the local chain can point at a fresh deployment.
  const permit2 = profile.permit2
    ? (getAddress(profile.permit2) as Address)
    : profile.name === 'local' && partial.permit2
      ? requiredAddress(partial.permit2, 'Permit2 地址')
      : null;
  const x402Permit2Proxy = profile.x402Permit2Proxy
    ? (getAddress(profile.x402Permit2Proxy) as Address)
    : profile.name === 'local' && partial.x402Permit2Proxy
      ? requiredAddress(partial.x402Permit2Proxy, 'x402 Permit2 代理')
      : null;
  const settlementX402Permit2Enabled = partial.settlementX402Permit2Enabled ?? false;
  if (settlementX402Permit2Enabled) {
    const supportsPermit2 =
      profile.asset.transferMethods.includes('permit2') || profile.name === 'local';
    if (!supportsPermit2 || !permit2 || !x402Permit2Proxy) {
      throw new Error(
        `该网络的 Permit2 自托管结算尚未支持（${profile.displayName} 缺少 permit2 或 x402 Permit2 代理）。`,
      );
    }
  }

  // The ops key signs starter gas and Permit2 settlement. It is env-only and
  // separate from the payout executor key so a leak of one never unlocks the other.
  let opsPrivateKey: Hex | null = partial.opsPrivateKey ?? null;
  if (starterGasEnabled || settlementX402Permit2Enabled) {
    if (!opsPrivateKey) {
      throw new Error('启动 gas 与 Permit2 结算都需要 SETTLEMENT_OPS_PRIVATE_KEY（仅从环境读取）。');
    }
    opsPrivateKey = requiredKey(opsPrivateKey, 'ops 私钥');
    if (privateKey && opsPrivateKey === privateKey) {
      throw new Error('ops 私钥必须与出款执行钱包私钥不同。');
    }
  } else {
    opsPrivateKey = null;
  }

  // Metered LLM services read the BeefAPI base URL and key from the
  // environment. The base URL defaults to the overseas production host; tests
  // point it at a loopback stub.
  const llmServicesEnabled = partial.llmServicesEnabled ?? false;
  const llmBeefapiBaseUrl = partial.llmBeefapiBaseUrl ?? DEFAULT_BEEFAPI_LLM_BASE_URL;
  const llmBeefapiApiKey = partial.llmBeefapiApiKey ?? '';
  if (llmServicesEnabled) {
    let url: URL;
    try {
      url = new URL(llmBeefapiBaseUrl);
    } catch {
      throw new Error('BEEFAPI_BASE_URL 无效。');
    }
    if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
      throw new Error('BEEFAPI_BASE_URL 必须是 HTTPS 或本机回环地址。');
    }
  }
  const llmPayerDailyCapAtomic =
    partial.llmPayerDailyCapAtomic ?? DEFAULT_LLM_PAYER_DAILY_CAP_ATOMIC;
  const llmGlobalDailyCapAtomic =
    partial.llmGlobalDailyCapAtomic ?? DEFAULT_LLM_GLOBAL_DAILY_CAP_ATOMIC;
  const settlementBudgetMaxAtomic =
    partial.settlementBudgetMaxAtomic ?? DEFAULT_SETTLEMENT_BUDGET_MAX_ATOMIC;
  const llmRequestTimeoutMs = partial.llmRequestTimeoutMs ?? 60_000;

  return {
    host,
    port: partial.port ?? DEFAULT_PORT,
    network: profile,
    chain: {
      rpcUrl: partial.chain.rpcUrl,
      chainId,
      contract,
      token,
      privateKey,
      recipient: partial.chain.recipient
        ? requiredAddress(partial.chain.recipient, '测试收款地址')
        : undefined,
    },
    payoutsEnabled,
    payoutsDisabledReason,
    source,
    orderDemo,
    beefapiBaseUrl: partial.beefapiBaseUrl ?? '',
    beefapiToken: partial.beefapiToken ?? '',
    partnerUserId,
    minAmount: partial.minAmount ?? DEFAULT_MIN_AMOUNT,
    maturityMs: partial.maturityMs ?? DEFAULT_MATURITY_MS,
    tickMs: partial.tickMs ?? DEFAULT_TICK_MS,
    dbPath: namespacePath(
      partial.dbPath ?? join('.local', 'settlement.sqlite'),
      profile,
    ),
    lockPath: namespacePath(
      partial.lockPath ?? join('.local', 'settlement.lock'),
      profile,
    ),
    publicDir: partial.publicDir ?? join(import.meta.dir, '../web/dist'),
    merchantId: partial.merchantId ?? MERCHANT_ID,
    partnerId: partial.partnerId ?? PARTNER_ID,
    partnerName: partial.partnerName ?? PARTNER_NAME,
    authEnabled,
    publicOrigin,
    agentOrigin,
    identityRegistry,
    starterGasEnabled,
    starterGasWei,
    starterGasDailyCapWei,
    starterGasBalanceThresholdWei,
    opsPrivateKey,
    merchantPasswordHash,
    promoterPasswordHash,
    x402Enabled,
    x402FacilitatorUrl,
    permit2,
    x402Permit2Proxy,
    settlementX402Permit2Enabled,
    servicesRequireApproved: partial.servicesRequireApproved ?? false,
    serviceProviderAgentId: partial.serviceProviderAgentId ?? '0',
    serviceEchoPrice: partial.serviceEchoPrice ?? 1_000_000n,
    llmServicesEnabled,
    llmBeefapiBaseUrl,
    llmBeefapiApiKey,
    llmPayerDailyCapAtomic,
    llmGlobalDailyCapAtomic,
    settlementBudgetMaxAtomic,
    llmRequestTimeoutMs,
  };
}

type FileConfig = Partial<ChainConfig> & {
  testOnly?: boolean;
  identityRegistry?: string;
};

export function loadConfig(opts?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
}): RuntimeConfig {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const configPath = resolve(
    cwd,
    env.SETTLEMENT_CHAIN_CONFIG ?? join('.local', 'chain.json'),
  );
  let file: FileConfig | null = null;
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8')) as FileConfig;
    } catch {
      throw new Error(`无法读取链配置 ${configPath}。`);
    }
  }

  const selector = env.SETTLEMENT_NETWORK;
  const chainIdRaw = env.SETTLEMENT_CHAIN_ID ?? file?.chainId;
  let profile: NetworkProfile;
  if (selector != null && selector !== '') {
    profile = selectNetworkByName(selector);
    if (
      chainIdRaw != null &&
      chainIdRaw !== '' &&
      Number(chainIdRaw) !== profile.chainId
    ) {
      throw new Error(
        `SETTLEMENT_NETWORK=${selector} 与 SETTLEMENT_CHAIN_ID=${chainIdRaw} 冲突。`,
      );
    }
  } else {
    const byChainId = profileForChainId(Number(chainIdRaw));
    if (!byChainId) {
      throw new Error(
        `未配置结算链，拒绝以模拟出款启动。请设置 SETTLEMENT_NETWORK（${NETWORK_NAMES.join(' | ')}）或提供 .local/chain.json。`,
      );
    }
    profile = byChainId;
  }

  const rpcUrl = requiredRpc(
    env.SETTLEMENT_RPC_URL ?? file?.rpcUrl ?? profile.rpcUrl,
    profile,
  );
  const token = requiredAddress(
    env.SETTLEMENT_TOKEN ?? file?.token ?? profile.asset.address,
    '代币',
  );

  if (profile.name !== 'local' && getAddress(token) !== getAddress(profile.asset.address)) {
    throw new Error(
      `${profile.displayName} 代币必须固定为 ${profile.asset.symbol} ${profile.asset.address}。`,
    );
  }

  let contract: Address | undefined;
  let privateKey: Hex | undefined;
  if (profile.payoutsRequired) {
    contract = requiredAddress(
      env.SETTLEMENT_CONTRACT ?? file?.contract,
      '结算合约',
    );
    if (profile.name === 'fuji') {
      if (!env.SETTLEMENT_PRIVATE_KEY) {
        throw new Error('Fuji 执行钱包私钥只能通过 SETTLEMENT_PRIVATE_KEY 提供，不能写在配置文件里。');
      }
      privateKey = requiredKey(env.SETTLEMENT_PRIVATE_KEY, '执行钱包私钥');
    } else {
      privateKey = requiredKey(
        env.SETTLEMENT_PRIVATE_KEY ?? file?.privateKey,
        '执行钱包私钥',
      );
    }
  } else {
    const contractRaw = env.SETTLEMENT_CONTRACT ?? file?.contract;
    if (contractRaw != null && contractRaw !== '') {
      contract = requiredAddress(contractRaw, '结算合约');
      privateKey = requiredKey(
        env.SETTLEMENT_PRIVATE_KEY ?? file?.privateKey,
        '执行钱包私钥',
      );
    } else {
      contract = undefined;
      privateKey =
        env.SETTLEMENT_PRIVATE_KEY != null && env.SETTLEMENT_PRIVATE_KEY !== ''
          ? requiredKey(env.SETTLEMENT_PRIVATE_KEY, '执行钱包私钥')
          : undefined;
    }
  }

  const recipientRaw = env.SETTLEMENT_RECIPIENT ?? file?.recipient;
  const source = (env.SETTLEMENT_SOURCE ?? 'fixture') as SourceKind;
  if (source !== 'fixture' && source !== 'beefapi') {
    throw new Error('SETTLEMENT_SOURCE 只允许 fixture 或 beefapi。');
  }
  const orderDemoRaw = env.SETTLEMENT_ORDER_DEMO;
  let orderDemo = false;
  if (orderDemoRaw != null && orderDemoRaw !== '') {
    if (orderDemoRaw === 'true') orderDemo = true;
    else if (orderDemoRaw === 'false') orderDemo = false;
    else throw new Error('SETTLEMENT_ORDER_DEMO 只允许 true 或 false。');
  }

  const publicDir = env.SETTLEMENT_PUBLIC_DIR
    ? isAbsolute(env.SETTLEMENT_PUBLIC_DIR)
      ? env.SETTLEMENT_PUBLIC_DIR
      : resolve(cwd, env.SETTLEMENT_PUBLIC_DIR)
    : join(import.meta.dir, '../web/dist');

  const identityRegistryRaw = env.SETTLEMENT_IDENTITY_REGISTRY ?? file?.identityRegistry;
  const registryConfigured =
    !!profile.identityRegistry ||
    (profile.name === 'local' && identityRegistryRaw != null && identityRegistryRaw !== '');
  // SETTLEMENT_PUBLIC_ORIGIN serves two purposes: the Fuji order-demo public
  // origin (auth + order demo) and the agent registration document origin.
  // Each network consumes only the one it can support.
  const publicOriginRaw =
    env.SETTLEMENT_PUBLIC_ORIGIN && env.SETTLEMENT_PUBLIC_ORIGIN !== ''
      ? parsePublicOrigin(env.SETTLEMENT_PUBLIC_ORIGIN)
      : null;
  if (publicOriginRaw && profile.name !== 'fuji' && !registryConfigured) {
    throw new Error('SETTLEMENT_PUBLIC_ORIGIN 需要 Fuji 测试网或带身份注册表的网络。');
  }
  const publicOrigin = profile.name === 'fuji' ? publicOriginRaw : null;
  const agentOrigin = publicOriginRaw && registryConfigured ? publicOriginRaw : null;

  const cfg = runtimeConfig({
    host: env.SETTLEMENT_HOST ?? '127.0.0.1',
    port: intEnv(env.SETTLEMENT_PORT, DEFAULT_PORT, 'SETTLEMENT_PORT'),
    chain: {
      rpcUrl,
      chainId: profile.chainId,
      contract,
      token,
      privateKey,
      recipient: recipientRaw
        ? requiredAddress(recipientRaw, '测试收款地址')
        : undefined,
    },
    source,
    beefapiBaseUrl: env.BEEFAPI_TEST_BASE_URL ?? '',
    beefapiToken: env.SETTLEMENT_TEST_TOKEN ?? '',
    partnerUserId: intEnv(env.SETTLEMENT_PARTNER_USER_ID, 1, 'SETTLEMENT_PARTNER_USER_ID'),
    minAmount: env.SETTLEMENT_MIN_AMOUNT
      ? BigInt(env.SETTLEMENT_MIN_AMOUNT)
      : DEFAULT_MIN_AMOUNT,
    maturityMs: intEnv(env.SETTLEMENT_MATURITY_MS, DEFAULT_MATURITY_MS, 'SETTLEMENT_MATURITY_MS'),
    tickMs: intEnv(env.SETTLEMENT_TICK_MS, DEFAULT_TICK_MS, 'SETTLEMENT_TICK_MS'),
    dbPath: resolve(cwd, env.SETTLEMENT_DB ?? join('.local', 'settlement.sqlite')),
    lockPath: resolve(cwd, env.SETTLEMENT_LOCK ?? join('.local', 'settlement.lock')),
    publicDir,
    orderDemo,
    authEnabled: flagEnv(env.SETTLEMENT_AUTH_ENABLED, 'SETTLEMENT_AUTH_ENABLED'),
    publicOrigin,
    agentOrigin,
    identityRegistry: identityRegistryRaw as Address | undefined,
    starterGasEnabled: flagEnv(
      env.SETTLEMENT_STARTER_GAS_ENABLED,
      'SETTLEMENT_STARTER_GAS_ENABLED',
    ),
    starterGasWei: weiEnv(env.SETTLEMENT_STARTER_GAS_WEI, 'SETTLEMENT_STARTER_GAS_WEI'),
    starterGasDailyCapWei: weiEnv(
      env.SETTLEMENT_STARTER_GAS_DAILY_CAP_WEI,
      'SETTLEMENT_STARTER_GAS_DAILY_CAP_WEI',
    ),
    starterGasBalanceThresholdWei: weiEnv(
      env.SETTLEMENT_STARTER_GAS_BALANCE_THRESHOLD_WEI,
      'SETTLEMENT_STARTER_GAS_BALANCE_THRESHOLD_WEI',
    ),
    // The starter-gas ops key is env-only and kept separate from the payout
    // executor key so a leak of one never unlocks the other.
    opsPrivateKey: env.SETTLEMENT_OPS_PRIVATE_KEY as Hex | undefined,
    merchantPasswordHash: env.SETTLEMENT_MERCHANT_PASSWORD_HASH ?? '',
    promoterPasswordHash: env.SETTLEMENT_PROMOTER_PASSWORD_HASH ?? '',
    x402Enabled: flagEnv(env.SETTLEMENT_X402_ENABLED, 'SETTLEMENT_X402_ENABLED'),
    x402FacilitatorUrl: env.SETTLEMENT_X402_FACILITATOR_URL ?? DEFAULT_X402_FACILITATOR_URL,
    permit2: env.SETTLEMENT_PERMIT2 as Address | undefined,
    x402Permit2Proxy: env.SETTLEMENT_X402_PERMIT2_PROXY as Address | undefined,
    settlementX402Permit2Enabled: flagEnv(
      env.SETTLEMENT_X402_PERMIT2_ENABLED,
      'SETTLEMENT_X402_PERMIT2_ENABLED',
    ),
    servicesRequireApproved: flagEnv(
      env.SETTLEMENT_SERVICES_REQUIRE_APPROVED,
      'SETTLEMENT_SERVICES_REQUIRE_APPROVED',
    ),
    serviceProviderAgentId: env.SETTLEMENT_SERVICE_PROVIDER_AGENT_ID ?? '0',
    serviceEchoPrice: env.SETTLEMENT_SERVICE_ECHO_PRICE
      ? BigInt(env.SETTLEMENT_SERVICE_ECHO_PRICE)
      : 1_000_000n,
    llmServicesEnabled: flagEnv(
      env.SETTLEMENT_LLM_SERVICES_ENABLED,
      'SETTLEMENT_LLM_SERVICES_ENABLED',
    ),
    llmBeefapiBaseUrl: env.BEEFAPI_BASE_URL ?? DEFAULT_BEEFAPI_LLM_BASE_URL,
    llmBeefapiApiKey: env.BEEFAPI_API_KEY ?? '',
    llmPayerDailyCapAtomic: weiEnv(
      env.SETTLEMENT_LLM_PAYER_DAILY_CAP,
      'SETTLEMENT_LLM_PAYER_DAILY_CAP',
    ) ?? DEFAULT_LLM_PAYER_DAILY_CAP_ATOMIC,
    llmGlobalDailyCapAtomic: weiEnv(
      env.SETTLEMENT_LLM_GLOBAL_DAILY_CAP,
      'SETTLEMENT_LLM_GLOBAL_DAILY_CAP',
    ) ?? DEFAULT_LLM_GLOBAL_DAILY_CAP_ATOMIC,
    settlementBudgetMaxAtomic: weiEnv(
      env.SETTLEMENT_BUDGET_MAX,
      'SETTLEMENT_BUDGET_MAX',
    ) ?? DEFAULT_SETTLEMENT_BUDGET_MAX_ATOMIC,
  });

  if (cfg.source === 'beefapi') {
    if (!cfg.beefapiBaseUrl || !cfg.beefapiToken) {
      throw new Error('beefapi 来源需要 BEEFAPI_TEST_BASE_URL 与 SETTLEMENT_TEST_TOKEN。');
    }
    if (cfg.beefapiToken.length < 32) {
      throw new Error('SETTLEMENT_TEST_TOKEN 长度不足。');
    }
    let url: URL;
    try {
      url = new URL(cfg.beefapiBaseUrl);
    } catch {
      throw new Error('BEEFAPI_TEST_BASE_URL 无效。');
    }
    if (!isLoopbackHost(url.hostname)) {
      throw new Error('BEEFAPI_TEST_BASE_URL 必须是本机回环地址。');
    }
  }
  return cfg;
}

export function demoWalletAddress(config: RuntimeConfig): Address {
  if (config.network.name !== 'local') {
    throw new ServiceError(403, '当前网络不能使用本地测试钱包。');
  }
  if (!config.chain.recipient) {
    throw new ServiceError(400, '本地链未配置测试收款地址。');
  }
  return config.chain.recipient;
}
