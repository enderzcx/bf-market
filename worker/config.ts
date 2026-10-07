import { parsePublicOrigin, runtimeConfig, type RuntimeConfig } from '../src/config.ts';
import { selectNetworkByName } from '../src/network.ts';
import type { Address, Hex } from '../src/types.ts';
import type { Env } from './env.ts';

function flag(value: string | undefined): boolean {
  return value === 'true';
}

function wei(value: string | undefined): bigint | undefined {
  return value == null || value === '' ? undefined : BigInt(value);
}

function intEnv(value: string | undefined, fallback: number): number {
  return value == null || value === '' ? fallback : Number(value);
}

// Builds the same RuntimeConfig the Bun entry derives from process.env, but
// reads only the Worker bindings: no filesystem, no .local, no import.meta.dir.
export function configFromEnv(env: Env): RuntimeConfig {
  const profile = selectNetworkByName(env.SETTLEMENT_NETWORK ?? 'botchain-testnet');
  const publicOrigin = env.SETTLEMENT_PUBLIC_ORIGIN
    ? parsePublicOrigin(env.SETTLEMENT_PUBLIC_ORIGIN)
    : null;

  const config = runtimeConfig({
    host: env.SETTLEMENT_HOST ?? '127.0.0.1',
    port: intEnv(env.SETTLEMENT_PORT, 8787),
    chain: {
      rpcUrl: env.SETTLEMENT_RPC_URL ?? profile.rpcUrl,
      chainId: profile.chainId,
      contract: (env.SETTLEMENT_CONTRACT as Address | undefined) ?? undefined,
      token: profile.asset.address,
      privateKey: (env.SETTLEMENT_PRIVATE_KEY as Hex | undefined) ?? undefined,
    },
    source: 'fixture',
    // The Worker entry never runs the payout worker (see createDisabledChain),
    // so a network that normally requires a payout contract (Fuji) starts here
    // only when the deployment says so explicitly.
    payoutsDisabled: flag(env.SETTLEMENT_PAYOUTS_DISABLED),
    // Static assets are served by Workers Assets; the Durable Object never reads
    // the filesystem.
    publicDir: '',
    // runtimeConfig reserves publicOrigin for the Fuji order-demo path. The
    // Worker only needs it as the trusted host and canonical origin, so it is
    // applied after validation below.
    publicOrigin: null,
    agentOrigin: publicOrigin,
    starterGasEnabled: flag(env.SETTLEMENT_STARTER_GAS_ENABLED),
    starterGasWei: wei(env.SETTLEMENT_STARTER_GAS_WEI),
    starterGasDailyCapWei: wei(env.SETTLEMENT_STARTER_GAS_DAILY_CAP_WEI),
    starterGasBalanceThresholdWei: wei(env.SETTLEMENT_STARTER_GAS_BALANCE_THRESHOLD_WEI),
    opsPrivateKey: (env.SETTLEMENT_OPS_PRIVATE_KEY as Hex | undefined) ?? undefined,
    settlementX402Permit2Enabled: flag(env.SETTLEMENT_X402_PERMIT2_ENABLED),
    servicesRequireApproved: flag(env.SETTLEMENT_SERVICES_REQUIRE_APPROVED),
    serviceProviderAgentId: env.SETTLEMENT_SERVICE_PROVIDER_AGENT_ID ?? '0',
    serviceEchoPrice:
      env.SETTLEMENT_SERVICE_ECHO_PRICE != null && env.SETTLEMENT_SERVICE_ECHO_PRICE !== ''
        ? BigInt(env.SETTLEMENT_SERVICE_ECHO_PRICE)
        : undefined,
    llmServicesEnabled: flag(env.SETTLEMENT_LLM_SERVICES_ENABLED),
    llmBeefapiBaseUrl: env.BEEFAPI_BASE_URL,
    llmBeefapiApiKey: env.BEEFAPI_API_KEY ?? '',
    llmPayerDailyCapAtomic: wei(env.SETTLEMENT_LLM_PAYER_DAILY_CAP),
    llmGlobalDailyCapAtomic: wei(env.SETTLEMENT_LLM_GLOBAL_DAILY_CAP),
  });

  return publicOrigin ? { ...config, publicOrigin } : config;
}
