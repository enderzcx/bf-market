import type { Ledger } from './ledger.ts';

// Bindings and vars available to the Worker and the Ledger Durable Object.
// Secrets (SETTLEMENT_OPS_PRIVATE_KEY, BEEFAPI_API_KEY, BEEFAPI_BASE_URL) are
// provided at deploy time and never written to this repository.
export interface Env {
  ASSETS: Fetcher;
  Ledger: DurableObjectNamespace<Ledger>;

  SETTLEMENT_NETWORK?: string;
  SETTLEMENT_RPC_URL?: string;
  SETTLEMENT_CONTRACT?: string;
  SETTLEMENT_PRIVATE_KEY?: string;
  SETTLEMENT_PAYOUTS_DISABLED?: string;
  SETTLEMENT_HOST?: string;
  SETTLEMENT_PORT?: string;
  SETTLEMENT_PUBLIC_ORIGIN?: string;
  SETTLEMENT_X402_PERMIT2_ENABLED?: string;
  SETTLEMENT_SERVICES_REQUIRE_APPROVED?: string;
  SETTLEMENT_SERVICE_PROVIDER_AGENT_ID?: string;
  SETTLEMENT_SERVICE_ECHO_PRICE?: string;
  SETTLEMENT_STARTER_GAS_ENABLED?: string;
  SETTLEMENT_STARTER_GAS_WEI?: string;
  SETTLEMENT_STARTER_GAS_DAILY_CAP_WEI?: string;
  SETTLEMENT_STARTER_GAS_BALANCE_THRESHOLD_WEI?: string;
  SETTLEMENT_LLM_SERVICES_ENABLED?: string;
  SETTLEMENT_LLM_PAYER_DAILY_CAP?: string;
  SETTLEMENT_LLM_GLOBAL_DAILY_CAP?: string;

  SETTLEMENT_OPS_PRIVATE_KEY?: string;
  BEEFAPI_API_KEY?: string;
  BEEFAPI_BASE_URL?: string;
  // One-shot identity seed token for POST /internal/seed. When unset the route
  // is not registered and answers 404.
  SEED_TOKEN?: string;
}
