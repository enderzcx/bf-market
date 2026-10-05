import { getAddress, isAddress, isHex, recoverTypedDataAddress } from "viem";
import { X402_MAX_TIMEOUT_SECONDS } from "../config.ts";
import { chainIdFromCaip2 } from "../network.ts";
import { ServiceError } from "../types.ts";
import type { Address, Hex } from "../types.ts";
import { canonicalPaymentUrl } from "./requirements.ts";
import {
  X402_CLOCK_SKEW_SECONDS,
  X402_SCHEME,
  X402_TOKEN_NAME,
  X402_TOKEN_VERSION,
  X402_VERSION,
  type X402ExactAuthorization,
  type X402ExactPayload,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "./types.ts";

const SIG_RE = /^0x[0-9a-fA-F]{128,196}$/;
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, "付款信息无效。");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new ServiceError(400, "付款信息无效。");
  }
  return value;
}

function requiredAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new ServiceError(400, "付款信息无效。");
  }
  return getAddress(value) as Address;
}

function sameAddress(a: string, b: string): boolean {
  return getAddress(a) === getAddress(b);
}

function parseAuthorization(raw: unknown): X402ExactAuthorization {
  const row = asRecord(raw);
  const nonce = requiredString(row.nonce);
  if (!NONCE_RE.test(nonce)) throw new ServiceError(400, "付款信息无效。");
  const validAfter = requiredString(row.validAfter);
  const validBefore = requiredString(row.validBefore);
  const value = requiredString(row.value);
  if (!UINT_RE.test(validAfter) || !UINT_RE.test(validBefore) || !UINT_RE.test(value)) {
    throw new ServiceError(400, "付款信息无效。");
  }
  return {
    from: requiredAddress(row.from),
    to: requiredAddress(row.to),
    value,
    validAfter,
    validBefore,
    nonce: nonce.toLowerCase() as Hex,
  };
}

function parseExactPayload(raw: unknown): X402ExactPayload {
  const row = asRecord(raw);
  if ("permit2Authorization" in row) {
    throw new ServiceError(400, "付款信息无效。");
  }
  const signature = requiredString(row.signature);
  if (!SIG_RE.test(signature) || !isHex(signature)) {
    throw new ServiceError(400, "付款信息无效。");
  }
  return {
    signature: signature as Hex,
    authorization: parseAuthorization(row.authorization),
  };
}

function parseAccepted(
  raw: unknown,
  expected: X402PaymentRequirements,
): X402PaymentRequirements {
  const row = asRecord(raw);
  const scheme = requiredString(row.scheme);
  const network = requiredString(row.network);
  const amount = requiredString(row.amount);
  const asset = requiredAddress(row.asset);
  const payTo = requiredAddress(row.payTo);
  if (row.maxTimeoutSeconds !== expected.maxTimeoutSeconds) {
    throw new ServiceError(400, "付款信息无效。");
  }
  if (
    scheme !== X402_SCHEME ||
    network !== expected.network ||
    amount !== expected.amount ||
    !sameAddress(asset, expected.asset) ||
    !sameAddress(payTo, expected.payTo)
  ) {
    throw new ServiceError(400, "付款信息无效。");
  }
  const extraRaw = row.extra;
  const extra = extraRaw == null ? {} : asRecord(extraRaw);
  if (extra.name !== X402_TOKEN_NAME || extra.version !== X402_TOKEN_VERSION) {
    throw new ServiceError(400, "付款信息无效。");
  }
  if (
    extra.assetTransferMethod != null &&
    extra.assetTransferMethod !== "eip3009"
  ) {
    throw new ServiceError(400, "付款信息无效。");
  }
  if (
    extra.paymentFlow != null &&
    extra.paymentFlow !== "authorization" &&
    extra.paymentFlow !== "upfront"
  ) {
    throw new ServiceError(400, "付款信息无效。");
  }
  return {
    scheme: X402_SCHEME,
    network: expected.network,
    amount,
    asset,
    payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: {
      name: X402_TOKEN_NAME,
      version: X402_TOKEN_VERSION,
      ...(typeof extra.assetTransferMethod === "string"
        ? { assetTransferMethod: extra.assetTransferMethod }
        : {}),
    },
  };
}

function parseResourceUrl(raw: unknown, expectedUrl: string): void {
  if (raw == null) return;
  const row = asRecord(raw);
  const url = requiredString(row.url);
  if (url.length > 2048 || url !== expectedUrl) {
    throw new ServiceError(400, "付款信息无效。");
  }
}

export async function validatePaymentPayload(input: {
  raw: unknown;
  origin: string;
  requestId: string;
  requirements: X402PaymentRequirements;
  nowMs: number;
  allowExpiredPinned?: boolean;
}): Promise<X402PaymentPayload> {
  const row = asRecord(input.raw);
  if (row.x402Version !== X402_VERSION) {
    throw new ServiceError(400, "付款信息无效。");
  }
  const expectedUrl = canonicalPaymentUrl(input.origin, input.requestId);
  parseResourceUrl(row.resource, expectedUrl);
  const accepted = parseAccepted(row.accepted, input.requirements);
  const payload = parseExactPayload(row.payload);
  const auth = payload.authorization;
  if (auth.value !== input.requirements.amount) {
    throw new ServiceError(400, "付款信息无效。");
  }
  if (!sameAddress(auth.to, input.requirements.payTo)) {
    throw new ServiceError(400, "付款信息无效。");
  }
  const nowSec = BigInt(Math.floor(input.nowMs / 1000));
  const validAfter = BigInt(auth.validAfter);
  const validBefore = BigInt(auth.validBefore);
  if (validAfter > nowSec) {
    throw new ServiceError(400, "付款信息无效。");
  }
  if (validBefore <= nowSec && !input.allowExpiredPinned) {
    throw new ServiceError(400, "付款授权已过期。");
  }
  const maxValidBefore =
    nowSec + BigInt(X402_MAX_TIMEOUT_SECONDS + X402_CLOCK_SKEW_SECONDS);
  if (validBefore > maxValidBefore) {
    throw new ServiceError(400, "付款信息无效。");
  }
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: X402_TOKEN_NAME,
        version: X402_TOKEN_VERSION,
        chainId: chainIdFromCaip2(input.requirements.network),
        verifyingContract: input.requirements.asset as Address,
      },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter,
        validBefore,
        nonce: auth.nonce,
      },
      signature: payload.signature,
    });
  } catch {
    throw new ServiceError(400, "付款信息无效。");
  }
  if (!sameAddress(recovered, auth.from)) {
    throw new ServiceError(400, "付款信息无效。");
  }
  return {
    x402Version: X402_VERSION,
    resource: { url: expectedUrl },
    accepted,
    payload,
  };
}
