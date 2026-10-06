export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export type PayoutStatus =
  | 'reserved'
  | 'prepared'
  | 'broadcast'
  | 'confirmed'
  | 'completed'
  | 'blocked';

export type Payout = { id: Hex; recipient: Address; amount: bigint };
export type Prepared = { rawTransaction: Hex; hash: Hex };

export type AgentRole = 'provider' | 'buyer';
export type ListedStatus = 'pending' | 'approved' | 'rejected';

export type AgentProfileService = { name: string; endpoint: string };

export type AgentProfile = {
  name: string;
  description?: string;
  image?: string;
  services: AgentProfileService[];
  x402Support?: boolean;
  active?: boolean;
};

export type AgentDraftRecord = {
  draftId: string;
  address: Address;
  role: AgentRole;
  profile: AgentProfile;
  createdAt: number;
  registeredAgentId: string | null;
};

export type AgentRecord = {
  chainId: number;
  agentId: string;
  owner: Address;
  agentWallet: Address;
  role: AgentRole;
  listed: ListedStatus;
  agentUri: string;
  registerTx: Hex;
  blockNumber: string | null;
  createdAt: number;
};

export type StarterGasStatus =
  | 'reserved'
  | 'signed'
  | 'broadcast'
  | 'confirmed'
  | 'blocked';

export type StarterGasRecord = {
  address: Address;
  amountWei: string;
  txHash: Hex | null;
  journal: Hex | null;
  status: StarterGasStatus;
  day: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export interface Chain {
  prepare(p: Payout): Promise<Prepared>;
  broadcast(raw: Hex): Promise<void>;
  inspect(p: Payout, hash: Hex): Promise<'pending' | 'confirmed' | 'reverted'>;
  balances(): Promise<{ token: string; gas: string }>;
}

export type SourceKind = 'fixture' | 'beefapi';
export type AuthRole = 'merchant' | 'promoter';

export type SourceOrderStatus = 'pending' | 'paid';

export type SourceOrder = {
  requestId: string;
  tradeNo: string;
  paymentAmountMinor: string;
  commissionRate: string;
  commissionUsdc: string;
  status: SourceOrderStatus;
};

export type X402PaymentStatus =
  | 'required'
  | 'submitted'
  | 'settled'
  | 'completed'
  | 'blocked';

// Lifecycle of a Permit2-settled paid service call, keyed by the signed
// payment authorization so the same payload can only be delivered once.
export type ServicePaymentStatus =
  | 'required'
  | 'verified'
  | 'settling'
  | 'settled'
  | 'delivered'
  | 'failed';

export type ServicePaymentRecord = {
  paymentKey: Hex;
  serviceId: string;
  chainId: number;
  payer: Address;
  payTo: Address;
  asset: Address;
  // For metered (upto) payments this is the signed upper bound; for exact it is
  // the fixed price.
  amount: string;
  nonce: string;
  scheme: string;
  status: ServicePaymentStatus;
  // Actual amount charged. Null until the call settles; "0" when the usage
  // charge rounds to zero.
  chargedAmount: string | null;
  // 1 once the payload has produced a delivered result (including a zero
  // charge); such a payload is never re-invoked or re-settled.
  consumed: boolean;
  usageJson: string | null;
  upstreamRequestId: string | null;
  txHash: Hex | null;
  journal: Hex | null;
  resultJson: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type PublicX402Payment = {
  mode: 'x402';
  status: X402PaymentStatus;
  txHash: string | null;
  error: string | null;
};

export type PublicX402Config = {
  enabled: boolean;
  network: string;
  asset: string;
  payTo: string;
};

export type PublicOrder = {
  requestId: string;
  tradeNo: string;
  paymentAmountMinor: string;
  commissionRate: string;
  commissionUsdc: string;
  status: SourceOrderStatus;
  recipient: string;
  error: string | null;
  payment?: PublicX402Payment;
};

export type SourceItem = {
  sourceId: string;
  recipient: Address;
  amount: bigint;
  createdAt: number;
  alreadyFrozen: boolean;
  numericId?: number;
  requestId?: string;
  chainId?: number;
  token?: Address;
};

export type CommissionScope = 'demo' | 'global';
export type CommissionRateSource =
  | 'demo'
  | 'default'
  | 'override'
  | 'disabled'
  | 'unavailable';

export type CommissionState = {
  rate: string | null;
  scope: CommissionScope;
  rateSource: CommissionRateSource;
  basis: 'actual_payment';
  lockedAt: 'order_creation';
};

export type SourceBalances = {
  available: string;
  pending: string;
  paid: string;
  consumed: string;
  commissionRate?: string;
  commissionRateSource?: string;
};

export interface Source {
  kind: SourceKind;
  pull(): Promise<SourceItem[]>;
  complete(payout: PayoutRecord): Promise<void>;
  balances(): Promise<SourceBalances | null>;
  lastError?(): string | null;
  listOrders?(): Promise<SourceOrder[]>;
  createOrder?(input: {
    requestId: string;
    paymentAmountMinor: string;
  }): Promise<SourceOrder>;
  payOrder?(requestId: string): Promise<SourceOrder>;
  reserveFrozen?(input: {
    requestId: string;
    recipient: Address;
    amountUsdc: string;
  }): Promise<SourceItem>;
}

export type PayoutRecord = {
  id: Hex;
  sourceId: string;
  recipient: Address;
  amount: bigint;
  status: PayoutStatus;
  txHash: Hex | null;
  error: string | null;
  createdAt: number;
  rawTransaction: Hex | null;
  alreadyFrozen: boolean;
  requestId: string | null;
  externalId: number | null;
};

export type PublicPayout = {
  id: string;
  sourceId: string;
  recipient: string;
  amount: string;
  status: PayoutStatus;
  txHash: string | null;
  error: string | null;
  createdAt: number;
};

export type PartnerRecord = {
  id: string;
  name: string;
  wallet: string;
  autoSettle: boolean;
  available: bigint;
  pending: bigint;
  paid: bigint;
  consumed: bigint;
};

export type AppState = {
  network: {
    name: string;
    chainId: number;
    explorer: string;
    configured: boolean;
    token: string;
    error?: string;
  };
  paused: boolean;
  wallet: { token: string; gas: string };
  partner: {
    id: string;
    name: string;
    wallet: string;
    autoSettle: boolean;
    available: string;
    pending: string;
    paid: string;
    consumed: string;
  };
  payouts: PublicPayout[];
  source: SourceKind;
  minAmount: string;
  commission: CommissionState;
  orderDemo: boolean;
  orders?: PublicOrder[];
  sourceError?: string;
  authEnabled?: boolean;
  role?: AuthRole;
  x402: PublicX402Config;
};

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export const PROVIDER_FAILURE = 'Settlement is temporarily unavailable.';

export function sanitizeError(err: unknown): string {
  if (err instanceof ServiceError) return err.message;
  return PROVIDER_FAILURE;
}

export function toPublicPayout(row: PayoutRecord): PublicPayout {
  return {
    id: row.id,
    sourceId: row.sourceId,
    recipient: row.recipient,
    amount: row.amount.toString(),
    status: row.status,
    txHash: row.txHash,
    error: row.error,
    createdAt: row.createdAt,
  };
}
