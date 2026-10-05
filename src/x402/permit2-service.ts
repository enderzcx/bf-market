import { getAddress, isAddress, isHex } from 'viem';
import type { RuntimeConfig } from '../config.ts';
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
} from './types.ts';

const SIG_RE = /^0x[0-9a-fA-F]{128,196}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;

export type Permit2CallResult = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

function asRecord(value: unknown, label = '付款信息'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError(402, `${label}无效。`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new ServiceError(402, `${label}无效。`);
  }
  return value;
}

function requiredUint(value: unknown, label: string): string {
  const raw = requiredString(value, label);
  if (!UINT_RE.test(raw)) throw new ServiceError(402, `${label}无效。`);
  return raw;
}

function requiredAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new ServiceError(402, `${label}无效。`);
  }
  return getAddress(value) as Address;
}

function sameAddress(a: string, b: string): boolean {
  return getAddress(a) === getAddress(b);
}

// Structural parse only; signature/expiry/allowance checks live in the
// facilitator's verify. Field names match the official @x402/evm Permit2 payload.
export function parsePermit2Payload(
  raw: unknown,
  requirements: X402PaymentRequirements,
): X402Permit2PaymentPayload {
  const row = asRecord(raw);
  if (row.x402Version !== X402_VERSION) throw new ServiceError(402, '付款信息无效。');
  const accepted = asRecord(row.accepted, '付款要求');
  if (accepted.scheme !== 'exact') throw new ServiceError(402, '付款信息无效。');
  if (accepted.network !== requirements.network) throw new ServiceError(402, '付款网络不符。');
  if (String(accepted.amount) !== requirements.amount) {
    throw new ServiceError(402, '付款金额不符。');
  }
  if (
    !sameAddress(requiredAddress(accepted.asset, '付款代币'), requirements.asset) ||
    !sameAddress(requiredAddress(accepted.payTo, '收款地址'), requirements.payTo)
  ) {
    throw new ServiceError(402, '付款信息无效。');
  }
  if (accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds) {
    throw new ServiceError(402, '付款信息无效。');
  }
  const extra = accepted.extra == null ? {} : asRecord(accepted.extra, '付款扩展');
  if (extra.assetTransferMethod !== 'permit2') {
    throw new ServiceError(402, '付款方式不符。');
  }
  const payload = asRecord(row.payload, '付款载荷');
  if ('authorization' in payload) throw new ServiceError(402, '付款信息无效。');
  const signature = requiredString(payload.signature, '付款签名');
  if (!SIG_RE.test(signature) || !isHex(signature)) {
    throw new ServiceError(402, '付款签名无效。');
  }
  const authRaw = asRecord(payload.permit2Authorization, 'Permit2 授权');
  const permitted = asRecord(authRaw.permitted, 'Permit2 授权金额');
  const witness = asRecord(authRaw.witness, 'Permit2 收款');
  const authorization: X402Permit2Authorization = {
    from: requiredAddress(authRaw.from, '付款地址'),
    permitted: {
      token: requiredAddress(permitted.token, '付款代币'),
      amount: requiredUint(permitted.amount, '授权金额'),
    },
    spender: requiredAddress(authRaw.spender, '授权对象'),
    nonce: requiredUint(authRaw.nonce, '授权编号'),
    deadline: requiredUint(authRaw.deadline, '授权期限'),
    witness: {
      to: requiredAddress(witness.to, '收款地址'),
      validAfter: requiredUint(witness.validAfter, '生效时间'),
    },
  };
  if (authorization.permitted.amount !== requirements.amount) {
    throw new ServiceError(402, '付款金额不符。');
  }
  if (!sameAddress(authorization.permitted.token, requirements.asset)) {
    throw new ServiceError(402, '付款代币不符。');
  }
  if (!sameAddress(authorization.witness.to, requirements.payTo)) {
    throw new ServiceError(402, '付款收款地址不符。');
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

  const resourceUrl = (origin: string, serviceId: string) =>
    `${origin.replace(/\/$/, '')}/api/services/${encodeURIComponent(serviceId)}/call`;

  const required = (input: {
    origin: string;
    definition: ServiceDefinition;
    requirements: X402PaymentRequirements;
    error: string;
  }): Permit2CallResult => {
    const body: X402PaymentRequired = {
      x402Version: X402_VERSION,
      error: input.error,
      resource: {
        url: resourceUrl(input.origin, input.definition.serviceId),
        description: input.definition.description,
        mimeType: 'application/json',
      },
      accepts: [input.requirements],
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

  return {
    async call(input: {
      serviceId: string;
      signatureHeader: string | null;
      body: Record<string, unknown>;
      origin: string;
    }): Promise<Permit2CallResult> {
      const definition = opts.catalog.get(input.serviceId);
      if (!definition) throw new ServiceError(404, '找不到该服务。');
      const { payTo, deliver } = opts.catalog.resolve(input.serviceId);
      const requirements = opts.facilitator.requirementsOf({
        amount: definition.price.toString(),
        asset: getAddress(opts.config.chain.token) as Address,
        payTo,
      });
      if (!input.signatureHeader) {
        return required({
          origin: input.origin,
          definition,
          requirements,
          error: 'PAYMENT-SIGNATURE header is required',
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
          return required({ origin: input.origin, definition, requirements, error: err.message });
        }
        throw err;
      }

      const payer = payload.payload.permit2Authorization.from;
      const nonce = payload.payload.permit2Authorization.nonce;
      const paymentKey = permit2PaymentKey({
        chainId: opts.config.chain.chainId,
        payer,
        nonce,
      });

      return lockPayment(paymentKey, async () => {
        let record = opts.store.getServicePayment(paymentKey);
        // The same authorization can only back one service; a payload signed for
        // a different service's provider/price must not replay its result.
        if (record && record.serviceId !== input.serviceId) {
          throw new ServiceError(409, '该付款已用于其他服务。');
        }
        if (record?.status === 'delivered') {
          return {
            status: 200,
            body: { result: JSON.parse(record.resultJson ?? 'null') },
            headers: paymentResponse(record.txHash!, record.payer),
          };
        }
        if (record?.status === 'failed') {
          throw new ServiceError(409, record.error ?? '付款未完成。');
        }

        if (!record || record.status === 'required') {
          let verified: Awaited<ReturnType<Permit2Facilitator['verify']>>;
          try {
            verified = await opts.facilitator.verify({ payload, requirements });
          } catch (err) {
            if (err instanceof ServiceError && err.status === 402) {
              return required({
                origin: input.origin,
                definition,
                requirements,
                error: err.message,
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
              payTo,
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
            payTo,
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
              error: '付款结算失败。',
            });
            return required({
              origin: input.origin,
              definition,
              requirements,
              error: '付款结算失败。',
            });
          } else if (inspected.reason === 'mismatch') {
            opts.store.setServicePaymentStatus(paymentKey, 'failed', {
              error: '付款收据与要求不符。',
            });
            return {
              status: 502,
              body: { error: '付款收据与要求不符。' },
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
            result = await deliver({
              serviceId: input.serviceId,
              payer: record.payer,
              payTo,
              amount: BigInt(record.amount),
              paymentKey,
              body: input.body,
            });
          } catch (err) {
            const message = sanitizeError(err);
            opts.store.setServicePaymentStatus(paymentKey, 'settled', { error: message });
            return {
              status: 500,
              body: { error: '服务暂时不可用。' },
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
          body: { error: '付款正在确认，请稍后重试。' },
          headers: {},
        };
      });
    },
  };
}
