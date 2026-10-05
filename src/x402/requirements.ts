import { getAddress } from "viem";
import { X402_MAX_TIMEOUT_SECONDS, type RuntimeConfig } from "../config.ts";
import { NETWORK_PROFILES } from "../network.ts";
import { ServiceError } from "../types.ts";
import {
  PAYMENT_MINOR_ATOMIC_FACTOR,
  X402_SCHEME,
  X402_TOKEN_NAME,
  X402_TOKEN_VERSION,
  X402_VERSION,
  type X402PaymentRequired,
  type X402PaymentRequirements,
  type X402SettleResponse,
} from "./types.ts";

export function atomicFromPaymentMinor(minor: string): string {
  if (!/^[1-9][0-9]*$/.test(minor)) {
    throw new ServiceError(400, "订单金额无效。");
  }
  return (BigInt(minor) * PAYMENT_MINOR_ATOMIC_FACTOR).toString();
}

export function canonicalPaymentUrl(
  origin: string,
  requestId: string,
): string {
  return `${origin.replace(/\/$/, "")}/api/x402/orders/${requestId}/pay`;
}

export function x402Asset(): `0x${string}` {
  return getAddress(NETWORK_PROFILES.fuji.asset.address) as `0x${string}`;
}

export function x402PayTo(config: RuntimeConfig): `0x${string}` {
  return getAddress(config.chain.contract) as `0x${string}`;
}

export function buildPaymentRequirements(input: {
  amount: string;
  asset: string;
  payTo: string;
  network?: string;
}): X402PaymentRequirements {
  return {
    scheme: X402_SCHEME,
    network: input.network ?? NETWORK_PROFILES.fuji.caip2,
    amount: input.amount,
    asset: getAddress(input.asset),
    payTo: getAddress(input.payTo),
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: {
      name: X402_TOKEN_NAME,
      version: X402_TOKEN_VERSION,
    },
  };
}

export function buildPaymentRequired(input: {
  origin: string;
  requestId: string;
  amount: string;
  asset: string;
  payTo: string;
  network?: string;
  error?: string;
}): X402PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error: input.error ?? "PAYMENT-SIGNATURE header is required",
    resource: {
      url: canonicalPaymentUrl(input.origin, input.requestId),
      description: "测试订单付款",
      mimeType: "application/json",
    },
    accepts: [
      buildPaymentRequirements({
        amount: input.amount,
        asset: input.asset,
        payTo: input.payTo,
        network: input.network,
      }),
    ],
  };
}

export function buildSettleResponse(input: {
  success: boolean;
  transaction: string;
  payer?: string;
  errorReason?: string;
  network?: string;
}): X402SettleResponse {
  const body: X402SettleResponse = {
    success: input.success,
    transaction: input.transaction,
    network: input.network ?? NETWORK_PROFILES.fuji.caip2,
  };
  if (input.payer) body.payer = input.payer;
  if (input.errorReason) body.errorReason = input.errorReason;
  return body;
}
