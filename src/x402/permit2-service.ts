import { getAddress, isAddress, isHex } from 'viem';
import type { RuntimeConfig } from '../config.ts';
import { bazaarHttpExtension, bazaarMcpExtension } from '../discovery.ts';
import {
  LLM_SETTLE_MARGIN_SECONDS,
  createLlmClient,
  meteredCharge,
  meteredUpperBound,
  parseMeteredRequest,
  type LlmUsage,
  type MeteredPricing,
  type MeteredRequest,
} from '../llm.ts';
import type { ServiceCatalog, ServiceDefinition } from '../services.ts';
import type { Store } from '../store.ts';
import type { Address, Hex } from '../types.ts';
import { ServiceError, sanitizeError } from '../types.ts';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from './codec.ts';
import { permit2PaymentKey, type Permit2Facilitator } from './permit2.ts';
import { buildSettleResponse } from './requirements.ts';
import {
  X402_VERSION,
  type X402PaymentRequired,
  type X402PaymentRequirements,
  type X402Permit2Authorization,
  type X402Permit2PaymentPayload,
  type X402SettleResponse,
  type X402UptoPermit2Authorization,
  type X402UptoPermit2PaymentPayload,
} from './types.ts';

const SIG_RE = /^0x[0-9a-fA-F]{128,196}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;

export type Permit2CallResult = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

function asRecord(value: unknown, label = 'payment info'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError(402, `Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new ServiceError(402, `Invalid ${label}.`);
  }
  return value;
}

function requiredUint(value: unknown, label: string): string {
  const raw = requiredString(value, label);
  if (!UINT_RE.test(raw)) throw new ServiceError(402, `Invalid ${label}.`);
  return raw;
}

function requiredAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new ServiceError(402, `Invalid ${label}.`);
  }
  return getAddress(value) as Address;
}

function sameAddress(a: string, b: string): boolean {
  return getAddress(a) === getAddress(b);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

// Structural parse only; signature/expiry/allowance checks live in the
// facilitator's verify. Field names match the official @x402/evm Permit2 payload.
export function parsePermit2Payload(
  raw: unknown,
  requirements: X402PaymentRequirements,
): X402Permit2PaymentPayload {
  const row = asRecord(raw);
  if (row.x402Version !== X402_VERSION) throw new ServiceError(402, 'Invalid payment payload.');
  const accepted = asRecord(row.accepted, 'payment requirements');
  if (accepted.scheme !== 'exact') throw new ServiceError(402, 'Invalid payment payload.');
  if (accepted.network !== requirements.network) {
    throw new ServiceError(402, 'Payment network does not match the requirements.');
  }
  if (String(accepted.amount) !== requirements.amount) {
    throw new ServiceError(402, 'Payment amount does not match the requirements.');
  }
  if (
    !sameAddress(requiredAddress(accepted.asset, 'payment token'), requirements.asset) ||
    !sameAddress(requiredAddress(accepted.payTo, 'payout address'), requirements.payTo)
  ) {
    throw new ServiceError(402, 'Invalid payment payload.');
  }
  if (accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds) {
    throw new ServiceError(402, 'Invalid payment payload.');
  }
  const extra = accepted.extra == null ? {} : asRecord(accepted.extra, 'payment extension');
  if (extra.assetTransferMethod !== 'permit2') {
    throw new ServiceError(402, 'Payment transfer method is not supported.');
  }
  const payload = asRecord(row.payload, 'payment payload');
  if ('authorization' in payload) throw new ServiceError(402, 'Invalid payment payload.');
  const signature = requiredString(payload.signature, 'payment signature');
  if (!SIG_RE.test(signature) || !isHex(signature)) {
    throw new ServiceError(402, 'Invalid payment signature.');
  }
  const authRaw = asRecord(payload.permit2Authorization, 'Permit2 authorization');
  const permitted = asRecord(authRaw.permitted, 'Permit2 permitted amount');
  const witness = asRecord(authRaw.witness, 'Permit2 recipient');
  const authorization: X402Permit2Authorization = {
    from: requiredAddress(authRaw.from, 'payer address'),
    permitted: {
      token: requiredAddress(permitted.token, 'payment token'),
      amount: requiredUint(permitted.amount, 'permitted amount'),
    },
    spender: requiredAddress(authRaw.spender, 'spender'),
    nonce: requiredUint(authRaw.nonce, 'authorization nonce'),
    deadline: requiredUint(authRaw.deadline, 'authorization deadline'),
    witness: {
      to: requiredAddress(witness.to, 'payout address'),
      validAfter: requiredUint(witness.validAfter, 'valid-after time'),
    },
  };
  if (authorization.permitted.amount !== requirements.amount) {
    throw new ServiceError(402, 'Payment amount does not match the requirements.');
  }
  if (!sameAddress(authorization.permitted.token, requirements.asset)) {
    throw new ServiceError(402, 'Payment token does not match the requirements.');
  }
  if (!sameAddress(authorization.witness.to, requirements.payTo)) {
    throw new ServiceError(402, 'Payment recipient does not match the requirements.');
  }
  return {
    x402Version: X402_VERSION,
    accepted: {
      scheme: 'exact',
      network: requirements.network,
      amount: requirements.amount,
      asset: requirements.asset,
      payTo: requirements.payTo,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      extra: { ...requirements.extra },
    },
    payload: { signature: signature as Hex, permit2Authorization: authorization },
  };
}

// `upto` payload parse. Unlike exact, the witness also carries the facilitator
// that may choose the final amount, so it is validated against the offer's
// extra.facilitatorAddress.
export function parseUptoPayload(
  raw: unknown,
  requirements: X402PaymentRequirements,
): X402UptoPermit2PaymentPayload {
  const row = asRecord(raw);
  if (row.x402Version !== X402_VERSION) throw new ServiceError(402, 'Invalid payment payload.');
  const accepted = asRecord(row.accepted, 'payment requirements');
  if (accepted.scheme !== 'upto') throw new ServiceError(402, 'Invalid payment payload.');
  if (accepted.network !== requirements.network) {
    throw new ServiceError(402, 'Payment network does not match the requirements.');
  }
  if (String(accepted.amount) !== requirements.amount) {
    throw new ServiceError(402, 'Payment amount does not match the requirements.');
  }
  if (
    !sameAddress(requiredAddress(accepted.asset, 'payment token'), requirements.asset) ||
    !sameAddress(requiredAddress(accepted.payTo, 'payout address'), requirements.payTo)
  ) {
    throw new ServiceError(402, 'Invalid payment payload.');
  }
  if (accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds) {
    throw new ServiceError(402, 'Invalid payment payload.');
  }
  const extra = accepted.extra == null ? {} : asRecord(accepted.extra, 'payment extension');
  if (extra.assetTransferMethod !== 'permit2') {
    throw new ServiceError(402, 'Payment transfer method is not supported.');
  }
  const payload = asRecord(row.payload, 'payment payload');
  if ('authorization' in payload) throw new ServiceError(402, 'Invalid payment payload.');
  const signature = requiredString(payload.signature, 'payment signature');
  if (!SIG_RE.test(signature) || !isHex(signature)) {
    throw new ServiceError(402, 'Invalid payment signature.');
  }
  const authRaw = asRecord(payload.permit2Authorization, 'Permit2 authorization');
  const permitted = asRecord(authRaw.permitted, 'Permit2 permitted amount');
  const witness = asRecord(authRaw.witness, 'Permit2 recipient');
  const authorization: X402UptoPermit2Authorization = {
    from: requiredAddress(authRaw.from, 'payer address'),
    permitted: {
      token: requiredAddress(permitted.token, 'payment token'),
      amount: requiredUint(permitted.amount, 'permitted amount'),
    },
    spender: requiredAddress(authRaw.spender, 'spender'),
    nonce: requiredUint(authRaw.nonce, 'authorization nonce'),
    deadline: requiredUint(authRaw.deadline, 'authorization deadline'),
    witness: {
      to: requiredAddress(witness.to, 'payout address'),
      facilitator: requiredAddress(witness.facilitator, 'facilitator address'),
      validAfter: requiredUint(witness.validAfter, 'valid-after time'),
    },
  };
  if (authorization.permitted.amount !== requirements.amount) {
    throw new ServiceError(402, 'Payment amount does not match the requirements.');
  }
  if (!sameAddress(authorization.permitted.token, requirements.asset)) {
    throw new ServiceError(402, 'Payment token does not match the requirements.');
  }
  if (!sameAddress(authorization.witness.to, requirements.payTo)) {
    throw new ServiceError(402, 'Payment recipient does not match the requirements.');
  }
  const facilitatorAddress = requirements.extra.facilitatorAddress;
  if (typeof facilitatorAddress !== 'string' || !sameAddress(authorization.witness.facilitator, facilitatorAddress)) {
    throw new ServiceError(402, 'Payment facilitator does not match this server.');
  }
  return {
    x402Version: X402_VERSION,
    accepted: {
      scheme: 'upto',
      network: requirements.network,
      amount: requirements.amount,
      asset: requirements.asset,
      payTo: requirements.payTo,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      extra: { ...requirements.extra },
    },
    payload: { signature: signature as Hex, permit2Authorization: authorization },
  };
}

export type Permit2Service = ReturnType<typeof createPermit2Service>;

export function createPermit2Service(opts: {
  store: Store;
  config: RuntimeConfig;
  catalog: ServiceCatalog;
  facilitator: Permit2Facilitator;
}) {
  const locks = new Map<string, Promise<unknown>>();
  const lockPayment = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    void settled.then(() => {
      if (locks.get(key) === settled) locks.delete(key);
    });
    return run;
  };

  const llm = createLlmClient(opts.config);
  const asset = getAddress(opts.config.chain.token) as Address;
  const MCP_TOOL = 'call_service';
  const resourceUrl = (origin: string, serviceId: string) =>
    `${origin.replace(/\/$/, '')}/api/services/${encodeURIComponent(serviceId)}/call`;
  const mcpUrl = (origin: string) => `${origin.replace(/\/$/, '')}/mcp`;

  // The 402 body carries the bazaar discovery extension (specs/extensions/
  // bazaar.md). HTTP and MCP differ in `resource.url` and `info.input.type`;
  // the payment requirements are identical either way.
  const required = (input: {
    origin: string;
    definition: ServiceDefinition;
    accepts: X402PaymentRequirements[];
    error: string;
    transport: 'http' | 'mcp';
  }): Permit2CallResult => {
    const body: X402PaymentRequired = {
      x402Version: X402_VERSION,
      error: input.error,
      resource: {
        url:
          input.transport === 'mcp'
            ? mcpUrl(input.origin)
            : resourceUrl(input.origin, input.definition.serviceId),
        description: input.definition.description,
        mimeType: 'application/json',
      },
      accepts: input.accepts,
      extensions:
        input.transport === 'mcp'
          ? bazaarMcpExtension(input.definition, MCP_TOOL)
          : bazaarHttpExtension(input.definition),
    };
    return {
      status: 402,
      body: body as unknown as Record<string, unknown>,
      headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body) },
    };
  };

  const paymentResponse = (txHash: Hex, payer: Address): Record<string, string> => ({
    'PAYMENT-RESPONSE': encodePaymentResponseHeader(
      buildSettleResponse({
        success: true,
        transaction: txHash,
        payer,
        network: opts.config.network.caip2,
      }),
    ),
  });

  // Metered payments report the actual charge in the settlement header; a zero
  // charge carries an empty transaction.
  const meteredResponse = (
    txHash: Hex | null,
    payer: Address,
    amount: bigint,
  ): Record<string, string> => ({
    'PAYMENT-RESPONSE': encodePaymentResponseHeader({
      success: true,
      transaction: txHash ?? '',
      payer,
      network: opts.config.network.caip2,
      amount: amount.toString(),
    } as X402SettleResponse),
  });

  const meteredOutput = (
    modelId: string,
    content: string,
    usage: LlmUsage,
    charged: bigint,
    upstreamRequestId: string | null,
  ) => ({
    model: modelId,
    content,
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    },
    charged: charged.toString(),
    upstream_request_id: upstreamRequestId,
  });

  const assertDailyLimits = (payer: Address, upperBound: bigint): void => {
    const day = utcDay();
    if (opts.store.llmSpendFor(day, payer) + upperBound > opts.config.llmPayerDailyCapAtomic) {
      throw new ServiceError(429, 'Daily spending limit reached for this payer.');
    }
    if (opts.store.llmSpendTotal(day) + upperBound > opts.config.llmGlobalDailyCapAtomic) {
      throw new ServiceError(429, 'The daily model budget is exhausted.');
    }
  };

  const callLlmOnce = async (input: {
    pricing: MeteredPricing;
    request: MeteredRequest;
    payer: Address;
  }): Promise<{ content: string; usage: LlmUsage; upstreamRequestId: string | null }> => {
    try {
      return await llm.chat({
        model: input.pricing.modelId,
        messages: input.request.messages,
        maxTokens: input.request.maxTokens,
        user: input.payer.toLowerCase(),
      });
    } catch {
      throw new ServiceError(502, 'The model provider call failed. You were not charged.');
    }
  };

  const exactEchoFlow = async (input: {
    definition: ServiceDefinition;
    requirements: X402PaymentRequirements;
    payload: X402Permit2PaymentPayload;
    serviceId: string;
    origin: string;
    transport: 'http' | 'mcp';
    body: Record<string, unknown>;
    payTo: Address;
    deliver: (ctx: {
      serviceId: string;
      payer: Address;
      payTo: Address;
      amount: bigint;
      paymentKey: Hex;
      body: Record<string, unknown>;
    }) => Promise<unknown>;
  }): Promise<Permit2CallResult> => {
    const { requirements, payload } = input;
    const payer = payload.payload.permit2Authorization.from;
    const nonce = payload.payload.permit2Authorization.nonce;
    const paymentKey = permit2PaymentKey({
      chainId: opts.config.chain.chainId,
      payer,
      nonce,
    });
    return lockPayment(paymentKey, async () => {
      let record = opts.store.getServicePayment(paymentKey);
      if (record && record.serviceId !== input.serviceId) {
        throw new ServiceError(409, 'This payment was already used for another service.');
      }
      if (record?.status === 'delivered') {
        return {
          status: 200,
          body: { result: JSON.parse(record.resultJson ?? 'null') },
          headers: paymentResponse(record.txHash!, record.payer),
        };
      }
      if (record?.status === 'failed') {
        throw new ServiceError(409, record.error ?? 'Payment was not completed.');
      }

      if (!record || record.status === 'required') {
        let verified: Awaited<ReturnType<Permit2Facilitator['verify']>>;
        try {
          verified = await opts.facilitator.verify({ payload, requirements });
        } catch (err) {
          if (err instanceof ServiceError && err.status === 402) {
            return required({
              origin: input.origin,
              definition: input.definition,
              accepts: [requirements],
              error: err.message,
              transport: input.transport,
            });
          }
          throw err;
        }
        if (!record) {
          record = opts.store.upsertServicePayment({
            paymentKey,
            serviceId: input.serviceId,
            chainId: opts.config.chain.chainId,
            payer: verified.payer,
            payTo: input.payTo,
            asset: requirements.asset as Address,
            amount: requirements.amount,
            nonce: verified.nonce,
          });
        }
        if (record.status === 'required') {
          record = opts.store.setServicePaymentStatus(paymentKey, 'verified');
        }
      }

      if (record.status === 'verified') {
        const signed = await opts.facilitator.prepare({ payload });
        record = opts.store.setServicePaymentStatus(paymentKey, 'settling', {
          journal: signed.rawTransaction,
          txHash: signed.hash,
          error: null,
        });
      }

      if (record.status === 'settling') {
        try {
          await opts.facilitator.broadcast(record.journal!);
        } catch {
          /* a replayed transaction may already be mined; inspect decides */
        }
        const inspected = await opts.facilitator.inspect({
          txHash: record.txHash!,
          asset: requirements.asset as Address,
          payTo: input.payTo,
          payer,
          amount: requirements.amount,
        });
        if (inspected.ok) {
          record = opts.store.setServicePaymentStatus(paymentKey, 'settled', {
            txHash: inspected.txHash,
            error: null,
          });
        } else if (inspected.reason === 'reverted') {
          opts.store.setServicePaymentStatus(paymentKey, 'failed', {
            error: 'Payment settlement failed.',
          });
          return required({
            origin: input.origin,
            definition: input.definition,
            accepts: [requirements],
            error: 'Payment settlement failed.',
            transport: input.transport,
          });
        } else if (inspected.reason === 'mismatch') {
          opts.store.setServicePaymentStatus(paymentKey, 'failed', {
            error: 'Settlement receipt does not match the requirements.',
          });
          return {
            status: 502,
            body: { error: 'Settlement receipt does not match the requirements.' },
            headers: {},
          };
        } else {
          return {
            status: 202,
            body: { status: 'settling', txHash: record.txHash },
            headers: {},
          };
        }
      }

      if (record.status === 'settled' || record.status === 'delivered') {
        let result: unknown;
        try {
          result = await input.deliver({
            serviceId: input.serviceId,
            payer: record.payer,
            payTo: input.payTo,
            amount: BigInt(record.amount),
            paymentKey,
            body: input.body,
          });
        } catch (err) {
          const message = sanitizeError(err);
          opts.store.setServicePaymentStatus(paymentKey, 'settled', { error: message });
          return {
            status: 500,
            body: { error: 'Service temporarily unavailable.' },
            headers: paymentResponse(record.txHash!, record.payer),
          };
        }
        const delivered = opts.store.markServicePaymentDelivered(
          paymentKey,
          JSON.stringify(result ?? null),
        );
        return {
          status: 200,
          body: { result: result ?? null },
          headers: paymentResponse(delivered.txHash!, delivered.payer),
        };
      }

      return {
        status: 502,
        body: { error: 'Payment is still confirming. Try again shortly.' },
        headers: {},
      };
    });
  };

  const callMetered = async (input: {
    serviceId: string;
    definition: ServiceDefinition;
    payTo: Address;
    signatureHeader: string | null;
    body: Record<string, unknown>;
    origin: string;
    transport: 'http' | 'mcp';
  }): Promise<Permit2CallResult> => {
    const { definition } = input;
    if (definition.pricing.mode !== 'metered') {
      throw new ServiceError(500, 'Service pricing is misconfigured.');
    }
    const pricing = definition.pricing.pricing;
    // The quote depends on the body, so a body-less request cannot be priced.
    const request = parseMeteredRequest(input.body);
    const upperBound = meteredUpperBound(pricing, request);
    const uptoRequirements = opts.facilitator.uptoRequirementsOf({
      amount: upperBound.toString(),
      asset,
      payTo: input.payTo,
    });
    const exactRequirements = opts.facilitator.requirementsOf({
      amount: upperBound.toString(),
      asset,
      payTo: input.payTo,
    });
    const accepts = [uptoRequirements, exactRequirements];
    const offer = (error: string): Permit2CallResult =>
      required({
        origin: input.origin,
        definition,
        accepts,
        error,
        transport: input.transport,
      });

    if (!input.signatureHeader) return offer('PAYMENT-SIGNATURE header is required');

    let scheme: 'upto' | 'exact';
    let payload: X402UptoPermit2PaymentPayload | X402Permit2PaymentPayload;
    try {
      const raw = decodePaymentSignatureHeader(input.signatureHeader);
      const acceptedScheme = (asRecord(asRecord(raw).accepted, 'payment requirements').scheme ??
        null) as unknown;
      if (acceptedScheme === 'upto') {
        scheme = 'upto';
        payload = parseUptoPayload(raw, uptoRequirements);
      } else {
        scheme = 'exact';
        payload = parsePermit2Payload(raw, exactRequirements);
      }
    } catch (err) {
      if (err instanceof ServiceError && err.status === 402) return offer(err.message);
      throw err;
    }

    const authorization = payload.payload.permit2Authorization;
    const payer = authorization.from;
    const paymentKey = permit2PaymentKey({
      chainId: opts.config.chain.chainId,
      payer,
      nonce: authorization.nonce,
    });
    const deadline = Number(authorization.deadline);
    const uptoProxy = getAddress(
      uptoRequirements.extra.x402UptoPermit2Proxy as string,
    ) as Address;

    return lockPayment(paymentKey, async () => {
      let record = opts.store.getServicePayment(paymentKey);
      if (record && record.serviceId !== input.serviceId) {
        throw new ServiceError(409, 'This payment was already used for another service.');
      }
      // A delivered result (including a zero charge) is final: repeat requests
      // return it without calling the model or settling again.
      if (record?.consumed && record.resultJson != null) {
        const output = JSON.parse(record.resultJson) as unknown;
        return {
          status: 200,
          body: { result: output },
          headers: meteredResponse(record.txHash, record.payer, BigInt(record.chargedAmount ?? '0')),
        };
      }
      if (record && record.scheme !== scheme) {
        throw new ServiceError(409, 'This payment was signed for a different scheme.');
      }
      // An unsettled failure leaves the signature unconsumed; it may only be
      // retried while the authorization still has settlement time left.
      if (record?.status === 'failed') {
        if (nowSeconds() + LLM_SETTLE_MARGIN_SECONDS > deadline) {
          return offer('Payment authorization has expired. Sign a new payment.');
        }
      }

      // Verify (fresh, or the first retry of an unsettled failure). A payment
      // already past verify does not re-run it.
      if (
        !record ||
        record.status === 'required' ||
        record.status === 'failed' ||
        record.status === 'verified'
      ) {
        let verified: { payer: Address; nonce: string };
        try {
          verified =
            scheme === 'upto'
              ? await opts.facilitator.verifyUpto({
                  payload: payload as X402UptoPermit2PaymentPayload,
                  requirements: uptoRequirements,
                })
              : await opts.facilitator.verify({
                  payload: payload as X402Permit2PaymentPayload,
                  requirements: exactRequirements,
                });
        } catch (err) {
          if (err instanceof ServiceError && err.status === 402) return offer(err.message);
          throw err;
        }
        if (!record) {
          record = opts.store.upsertServicePayment({
            paymentKey,
            serviceId: input.serviceId,
            chainId: opts.config.chain.chainId,
            payer: verified.payer,
            payTo: input.payTo,
            asset,
            amount: upperBound.toString(),
            nonce: verified.nonce,
            scheme,
          });
        }
        if (record.status !== 'verified') {
          record = opts.store.setServicePaymentStatus(paymentKey, 'verified');
        }
      }

      // The upto settle happens after the model call, so re-check the buyer's
      // funds, allowance and remaining deadline right before spending upstream.
      if (scheme === 'upto') {
        if (nowSeconds() + LLM_SETTLE_MARGIN_SECONDS > deadline) {
          return offer('Payment authorization has expired. Sign a new payment.');
        }
        try {
          await opts.facilitator.assertFunded({
            payer: record.payer,
            asset,
            amount: upperBound.toString(),
          });
        } catch (err) {
          if (err instanceof ServiceError && err.status === 402) return offer(err.message);
          throw err;
        }
      }

      // Per-payer and global daily caps are enforced before the upstream call.
      const day = utcDay();
      const paymentKeyRef = paymentKey;

      // ---- Exact option: charge the full upper bound up front, then deliver.
      if (scheme === 'exact') {
        if (record.status === 'verified') {
          assertDailyLimits(record.payer, upperBound);
          const signed = await opts.facilitator.prepare({
            payload: payload as X402Permit2PaymentPayload,
          });
          record = opts.store.setServicePaymentStatus(paymentKeyRef, 'settling', {
            journal: signed.rawTransaction,
            txHash: signed.hash,
            error: null,
          });
        }
        if (record.status === 'settling') {
          try {
            await opts.facilitator.broadcast(record.journal!);
          } catch {
            /* inspect decides */
          }
          const inspected = await opts.facilitator.inspect({
            txHash: record.txHash!,
            asset,
            payTo: input.payTo,
            payer,
            amount: upperBound.toString(),
          });
          if (inspected.ok) {
            record = opts.store.setServicePaymentStatus(paymentKeyRef, 'settled', {
              txHash: inspected.txHash,
              error: null,
            });
          } else if (inspected.reason === 'reverted') {
            opts.store.setServicePaymentStatus(paymentKeyRef, 'failed', {
              error: 'Payment settlement failed.',
            });
            return offer('Payment settlement failed.');
          } else if (inspected.reason === 'mismatch') {
            opts.store.setServicePaymentStatus(paymentKeyRef, 'failed', {
              error: 'Settlement receipt does not match the requirements.',
            });
            return {
              status: 502,
              body: { error: 'Settlement receipt does not match the requirements.' },
              headers: {},
            };
          } else {
            return {
              status: 202,
              body: { status: 'settling', txHash: record.txHash },
              headers: {},
            };
          }
        }
        let call: Awaited<ReturnType<typeof callLlmOnce>>;
        try {
          call = await callLlmOnce({ pricing, request, payer: record.payer });
        } catch {
          // The exact option settles before delivery, so the payment stands; the
          // model failure is recorded against the settled row.
          opts.store.setServicePaymentStatus(paymentKeyRef, 'settled', {
            error: 'The model provider call failed.',
          });
          return {
            status: 500,
            body: { error: 'Service temporarily unavailable.' },
            headers: meteredResponse(record.txHash, record.payer, upperBound),
          };
        }
        const output = meteredOutput(pricing.modelId, call.content, call.usage, upperBound, call.upstreamRequestId);
        opts.store.addLlmSpend(day, record.payer, upperBound);
        const delivered = opts.store.markServicePaymentDelivered(
          paymentKeyRef,
          JSON.stringify(output),
          { chargedAmount: upperBound.toString(), consumed: true },
        );
        return {
          status: 200,
          body: { result: output },
          headers: meteredResponse(delivered.txHash, delivered.payer, upperBound),
        };
      }

      // ---- Upto option: call the model, then settle the actual usage.
      let usage: LlmUsage | null = record.usageJson
        ? (JSON.parse(record.usageJson) as LlmUsage)
        : null;
      if (!usage) {
        assertDailyLimits(record.payer, upperBound);
        // Call upstream exactly once per payload; a failed call leaves the
        // signature unconsumed and settles nothing.
        let call: Awaited<ReturnType<typeof callLlmOnce>>;
        try {
          call = await callLlmOnce({ pricing, request, payer: record.payer });
        } catch (err) {
          opts.store.setServicePaymentStatus(paymentKeyRef, 'failed', {
            error: 'The model provider call failed.',
            consumed: false,
          });
          throw err;
        }
        usage = call.usage;
        const actual = meteredCharge(pricing, usage, upperBound);
        const output = meteredOutput(
          pricing.modelId,
          call.content,
          usage,
          actual,
          call.upstreamRequestId,
        );
        // Persist usage, charge and the delivered payload together so a crash
        // before settle can resume without calling the model again.
        record = opts.store.setServicePaymentStatus(paymentKeyRef, 'verified', {
          chargedAmount: actual.toString(),
          usageJson: JSON.stringify(usage),
          upstreamRequestId: call.upstreamRequestId,
          resultJson: JSON.stringify(output),
          error: null,
        });
      }

      const charged = BigInt(record.chargedAmount ?? '0');
      const output = JSON.parse(record.resultJson ?? 'null') as unknown;

      if (charged === 0n) {
        // Nothing to transfer: mark the payload consumed so the same signature
        // can never be settled later, and skip the on-chain transaction.
        const delivered = opts.store.markServicePaymentDelivered(
          paymentKeyRef,
          JSON.stringify(output),
          { chargedAmount: '0', consumed: true },
        );
        return {
          status: 200,
          body: { result: output },
          headers: meteredResponse(null, delivered.payer, 0n),
        };
      }

      if (record.status !== 'settling') {
        const signed = await opts.facilitator.prepareUpto({
          payload: payload as X402UptoPermit2PaymentPayload,
          amount: charged.toString(),
        });
        record = opts.store.setServicePaymentStatus(paymentKeyRef, 'settling', {
          journal: signed.rawTransaction,
          txHash: signed.hash,
          error: null,
        });
      }

      try {
        await opts.facilitator.broadcast(record.journal!);
      } catch {
        /* a replayed transaction may already be mined; inspect decides */
      }
      const inspected = await opts.facilitator.inspect({
        txHash: record.txHash!,
        asset,
        payTo: input.payTo,
        payer,
        amount: charged.toString(),
        proxy: uptoProxy,
      });
      if (inspected.ok) {
        opts.store.addLlmSpend(day, record.payer, charged);
        const delivered = opts.store.markServicePaymentDelivered(
          paymentKeyRef,
          JSON.stringify(output),
          { txHash: inspected.txHash, chargedAmount: charged.toString(), consumed: true },
        );
        return {
          status: 200,
          body: { result: output },
          headers: meteredResponse(delivered.txHash, delivered.payer, charged),
        };
      }
      if (inspected.reason === 'reverted') {
        opts.store.setServicePaymentStatus(paymentKeyRef, 'failed', {
          error: 'Payment settlement failed.',
          consumed: false,
        });
        return offer('Payment settlement failed.');
      }
      if (inspected.reason === 'mismatch') {
        opts.store.setServicePaymentStatus(paymentKeyRef, 'failed', {
          error: 'Settlement receipt does not match the requirements.',
          consumed: false,
        });
        return {
          status: 502,
          body: { error: 'Settlement receipt does not match the requirements.' },
          headers: {},
        };
      }
      return {
        status: 202,
        body: { status: 'settling', txHash: record.txHash },
        headers: {},
      };
    });
  };

  return {
    async call(input: {
      serviceId: string;
      signatureHeader: string | null;
      body: Record<string, unknown>;
      origin: string;
      transport?: 'http' | 'mcp';
    }): Promise<Permit2CallResult> {
      const transport = input.transport ?? 'http';
      const definition = opts.catalog.get(input.serviceId);
      if (!definition) throw new ServiceError(404, 'Service not found.');
      const { payTo, deliver } = opts.catalog.resolve(input.serviceId);

      if (definition.pricing.mode === 'metered') {
        return callMetered({
          serviceId: input.serviceId,
          definition,
          payTo,
          signatureHeader: input.signatureHeader,
          body: input.body,
          origin: input.origin,
          transport,
        });
      }

      const requirements = opts.facilitator.requirementsOf({
        amount: definition.price.toString(),
        asset,
        payTo,
      });
      if (!input.signatureHeader) {
        return required({
          origin: input.origin,
          definition,
          accepts: [requirements],
          error: 'PAYMENT-SIGNATURE header is required',
          transport,
        });
      }

      let payload: X402Permit2PaymentPayload;
      try {
        payload = parsePermit2Payload(
          decodePaymentSignatureHeader(input.signatureHeader),
          requirements,
        );
      } catch (err) {
        if (err instanceof ServiceError && err.status === 402) {
          return required({
            origin: input.origin,
            definition,
            accepts: [requirements],
            error: err.message,
            transport,
          });
        }
        throw err;
      }

      return exactEchoFlow({
        definition,
        requirements,
        payload,
        serviceId: input.serviceId,
        origin: input.origin,
        transport,
        body: input.body,
        payTo,
        deliver,
      });
    },
  };
}
