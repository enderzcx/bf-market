import { X402_HEADER_LIMIT } from "../config.ts";
import { ServiceError } from "../types.ts";
import type {
  X402PaymentPayload,
  X402PaymentRequired,
  X402SettleResponse,
} from "./types.ts";

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function encodeUtf8Base64(data: string): string {
  return Buffer.from(data, "utf8").toString("base64");
}

function decodeUtf8Base64(data: string): string {
  return Buffer.from(data, "base64").toString("utf8");
}

function readBoundedHeader(value: string): string {
  if (value.length === 0 || value.length > X402_HEADER_LIMIT) {
    throw new ServiceError(400, "Invalid payment payload.");
  }
  if (value.includes("\n") || value.includes("\r") || value.includes(" ")) {
    throw new ServiceError(400, "Invalid payment payload.");
  }
  if (!BASE64_RE.test(value)) {
    throw new ServiceError(400, "Invalid payment payload.");
  }
  let json: string;
  try {
    json = decodeUtf8Base64(value);
  } catch {
    throw new ServiceError(400, "Invalid payment payload.");
  }
  if (!json || json.length > X402_HEADER_LIMIT * 2) {
    throw new ServiceError(400, "Invalid payment payload.");
  }
  return json;
}

function parseHeaderJson(value: string): unknown {
  const json = readBoundedHeader(value);
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new ServiceError(400, "Invalid payment payload.");
  }
}

export function encodePaymentRequiredHeader(
  paymentRequired: X402PaymentRequired,
): string {
  return encodeUtf8Base64(JSON.stringify(paymentRequired));
}

export function decodePaymentRequiredHeader(
  value: string,
): unknown {
  return parseHeaderJson(value);
}

export function encodePaymentSignatureHeader(
  paymentPayload: X402PaymentPayload,
): string {
  return encodeUtf8Base64(JSON.stringify(paymentPayload));
}

export function decodePaymentSignatureHeader(value: string): unknown {
  return parseHeaderJson(value);
}

export function encodePaymentResponseHeader(
  paymentResponse: X402SettleResponse,
): string {
  return encodeUtf8Base64(JSON.stringify(paymentResponse));
}

export function decodePaymentResponseHeader(value: string): unknown {
  return parseHeaderJson(value);
}

export function headerGet(
  headers: Headers,
  name: string,
): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase());
}
