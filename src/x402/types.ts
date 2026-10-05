import type { Address, Hex, X402PaymentStatus } from "../types.ts";

export const X402_VERSION = 2;
export const X402_SCHEME = "exact";
export const X402_TOKEN_NAME = "USD Coin";
export const X402_TOKEN_VERSION = "2";
export const X402_FACILITATOR_TIMEOUT_MS = 30_000;
export const X402_SCAN_SPAN = 2048n;
export const X402_SCAN_CHUNK = 512n;
export const X402_CLOCK_SKEW_SECONDS = 30;
export const PAYMENT_MINOR_ATOMIC_FACTOR = 10_000n;

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export type X402Network = string;

export type X402ResourceInfo = {
  url: string;
  description?: string;
  mimeType?: string;
};

export type X402PaymentRequirements = {
  scheme: string;
  network: X402Network;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name?: string;
    version?: string;
    assetTransferMethod?: string;
    paymentFlow?: string;
    [key: string]: unknown;
  };
};

export type X402PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirements[];
};

export type X402ExactAuthorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

export type X402ExactPayload = {
  signature: Hex;
  authorization: X402ExactAuthorization;
};

export type X402PaymentPayload = {
  x402Version: number;
  resource?: X402ResourceInfo;
  accepted: X402PaymentRequirements;
  payload: X402ExactPayload;
};

// Permit2 exact-scheme payload. Field names match @x402/evm so an official
// client's payload verifies unchanged.
export type X402Permit2Witness = {
  to: Address;
  validAfter: string;
};

export type X402Permit2Authorization = {
  from: Address;
  permitted: { token: Address; amount: string };
  spender: Address;
  nonce: string;
  deadline: string;
  witness: X402Permit2Witness;
};

export type X402Permit2Payload = {
  signature: Hex;
  permit2Authorization: X402Permit2Authorization;
};

export type X402Permit2PaymentPayload = {
  x402Version: number;
  resource?: X402ResourceInfo;
  accepted: X402PaymentRequirements;
  payload: X402Permit2Payload;
};

export type X402SettleResponse = {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
};

export type X402OrderRecord = {
  requestId: string;
  status: X402PaymentStatus;
  payTo: Address;
  asset: Address;
  amount: string;
  commissionRate: string;
  payer: Address | null;
  nonce: Hex | null;
  txHash: Hex | null;
  error: string | null;
  scanFromBlock: bigint | null;
  scanToBlock: bigint | null;
  createdAt: number;
  updatedAt: number;
};

export type X402ReceiptResult =
  | { ok: true; txHash: Hex; blockNumber: bigint }
  | { ok: false; reason: "pending" | "mismatch" | "missing" | "reverted" };

export interface X402Chain {
  getBlockNumber(): Promise<bigint>;
  getChainId(): Promise<number>;
  inspectReceipt(input: {
    txHash: Hex;
    token: Address;
    payTo: Address;
    payer: Address;
    amount: bigint;
    nonce: Hex;
  }): Promise<X402ReceiptResult>;
  findAuthorization(input: {
    token: Address;
    payTo: Address;
    payer: Address;
    amount: bigint;
    nonce: Hex;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Hex | null>;
}

export type X402SettleResult =
  | { kind: "success"; transaction: string; payer?: string; network?: string }
  | { kind: "pending"; transaction?: string }
  | { kind: "timeout" }
  | { kind: "failed"; errorReason?: string; transaction?: string };

export interface X402Facilitator {
  settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402SettleResult>;
}
