import { getAddress, isHex } from "viem";
import type { RuntimeConfig } from "../config.ts";
import { orderReservationRequestId } from "../source.ts";
import type { Store } from "../store.ts";
import {
  type PublicOrder,
  type Source,
  type SourceOrder,
  ServiceError,
  sanitizeError,
} from "../types.ts";
import type { Address, Hex } from "../types.ts";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "./codec.ts";
import {
  atomicFromPaymentMinor,
  buildPaymentRequired,
  buildPaymentRequirements,
  buildSettleResponse,
} from "./requirements.ts";
import { validatePaymentPayload } from "./validate.ts";
import type {
  X402Chain,
  X402Facilitator,
  X402OrderRecord,
  X402PaymentPayload,
} from "./types.ts";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export type X402PayResult =
  | {
      kind: "required";
      status: 402;
      order: PublicOrder;
      headers: Record<string, string>;
    }
  | {
      kind: "ok";
      status: 200;
      order: PublicOrder;
      headers: Record<string, string>;
    };

function publicPayment(row: X402OrderRecord) {
  return {
    mode: "x402" as const,
    status: row.status,
    txHash: row.txHash,
    error: row.error,
  };
}

function withPayment(order: PublicOrder, row: X402OrderRecord | null): PublicOrder {
  if (!row) return order;
  return { ...order, payment: publicPayment(row), error: row.error ?? order.error };
}

function parseTxHash(value: string | undefined): Hex | null {
  if (!value || !TX_HASH_RE.test(value) || !isHex(value)) return null;
  return value.toLowerCase() as Hex;
}

export function createX402Service(opts: {
  store: Store;
  source: Source;
  config: RuntimeConfig;
  facilitator: X402Facilitator;
  chain: X402Chain;
  now: () => number;
  originOf: (host: string) => string;
  awardOrder: (requestId: string) => Promise<PublicOrder>;
}) {
  const requirementsOf = (row: X402OrderRecord) =>
    buildPaymentRequirements({
      amount: row.amount,
      asset: row.asset,
      payTo: row.payTo,
      network: opts.config.network.caip2,
    });

  const ensureOrder = async (requestId: string): Promise<{
    sourceOrder: SourceOrder;
    x402: X402OrderRecord;
  }> => {
    if (!opts.source.listOrders) {
      throw new ServiceError(502, "来源服务暂时不可用。");
    }
    const listed = await opts.source.listOrders();
    const sourceOrder = listed.find((row) => row.requestId === requestId);
    if (!sourceOrder) throw new ServiceError(404, "找不到该订单。");
    let x402 = opts.store.getX402Order(requestId);
    if (!x402) {
      if (sourceOrder.status === "paid") {
        throw new ServiceError(409, "该订单已支付。");
      }
      x402 = opts.store.createX402Order({
        requestId,
        payTo: getAddress(opts.config.chain.contract) as Address,
        asset: getAddress(opts.config.chain.token) as Address,
        amount: atomicFromPaymentMinor(sourceOrder.paymentAmountMinor),
        commissionRate: sourceOrder.commissionRate,
      });
    }
    return { sourceOrder, x402 };
  };

  const success = (order: PublicOrder, row: X402OrderRecord): X402PayResult => {
    const payload = opts.store.getX402Payload(row.requestId);
    const payer = payload?.payload.authorization.from ?? row.payer ?? undefined;
    return {
      kind: "ok",
      status: 200,
      order: withPayment(order, row),
      headers: {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader(
          buildSettleResponse({
            success: true,
            transaction: row.txHash ?? "",
            payer,
            network: opts.config.network.caip2,
          }),
        ),
      },
    };
  };

  const required = (
    order: PublicOrder,
    row: X402OrderRecord,
    origin: string,
  ): X402PayResult => ({
    kind: "required",
    status: 402,
    order: withPayment(order, row),
    headers: {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
        buildPaymentRequired({
          origin,
          requestId: row.requestId,
          amount: row.amount,
          asset: row.asset,
          payTo: row.payTo,
          network: opts.config.network.caip2,
        }),
      ),
    },
  });

  const recoverOnChain = async (row: X402OrderRecord): Promise<Hex | null> => {
    if (!row.payer || !row.nonce) return null;
    const head = await opts.chain.getBlockNumber();
    const fromBlock = row.scanFromBlock ?? head;
    const found = await opts.chain.findAuthorization({
      token: row.asset,
      payTo: row.payTo,
      payer: row.payer,
      amount: BigInt(row.amount),
      nonce: row.nonce,
      fromBlock,
      toBlock: head,
    });
    opts.store.setX402ScanRange(row.requestId, fromBlock, head);
    return found;
  };

  const inspectHash = async (
    row: X402OrderRecord,
    txHash: Hex,
  ): Promise<Hex | null> => {
    if (!row.payer || !row.nonce) return null;
    const result = await opts.chain.inspectReceipt({
      txHash,
      token: row.asset,
      payTo: row.payTo,
      payer: row.payer,
      amount: BigInt(row.amount),
      nonce: row.nonce,
    });
    if (result.ok) return result.txHash;
    return null;
  };

  const confirmChain = async (
    row: X402OrderRecord,
    candidate: Hex | null,
  ): Promise<Hex> => {
    const chainId = await opts.chain.getChainId();
    if (chainId !== opts.config.network.chainId) {
      throw new ServiceError(502, "付款未完成。");
    }
    if (candidate) {
      const verified = await inspectHash(row, candidate);
      if (verified) return verified;
    }
    const recovered = await recoverOnChain(row);
    if (recovered) {
      const verified = await inspectHash(row, recovered);
      if (verified) return verified;
    }
    throw new ServiceError(502, "付款正在确认，请稍后重试。");
  };

  const settlePinned = async (
    row: X402OrderRecord,
    payload: X402PaymentPayload,
  ): Promise<Hex> => {
    const head = await opts.chain.getBlockNumber();
    if (row.scanFromBlock == null) {
      opts.store.setX402ScanRange(row.requestId, head);
      row = opts.store.getX402Order(row.requestId) ?? row;
    }
    const recovered = await recoverOnChain(row);
    if (recovered) {
      const verified = await inspectHash(row, recovered);
      if (verified) return verified;
    }
    // Expiry prevents a new submission, not recovery of an already broadcast payment.
    if (BigInt(payload.payload.authorization.validBefore) <= BigInt(Math.floor(opts.now() / 1000))) {
      throw new ServiceError(502, "付款正在确认，请稍后重试。");
    }
    const settled = await opts.facilitator.settle(payload, requirementsOf(row));
    if (settled.kind === "timeout" || settled.kind === "pending") {
      const hint = parseTxHash(settled.kind === "pending" ? settled.transaction : undefined);
      if (hint) {
        const verified = await inspectHash(row, hint);
        if (verified) return verified;
      }
      const after = await recoverOnChain(row);
      if (after) {
        const verified = await inspectHash(row, after);
        if (verified) return verified;
      }
      opts.store.setX402Error(row.requestId, "付款正在确认，请稍后重试。");
      throw new ServiceError(502, "付款正在确认，请稍后重试。");
    }
    if (settled.kind === "failed") {
      const recoveredAfterFail = await recoverOnChain(row);
      if (recoveredAfterFail) {
        const verified = await inspectHash(row, recoveredAfterFail);
        if (verified) return verified;
      }
      opts.store.setX402Error(row.requestId, "付款未完成。");
      throw new ServiceError(502, "付款未完成。");
    }
    const hint = parseTxHash(settled.transaction);
    return confirmChain(row, hint);
  };

  return {
    publicPayment,
    persistCreatedOrder(order: SourceOrder) {
      if (order.status === "paid" && !opts.store.getX402Order(order.requestId)) return;
      opts.store.createX402Order({
        requestId: order.requestId,
        payTo: getAddress(opts.config.chain.contract) as Address,
        asset: getAddress(opts.config.chain.token) as Address,
        amount: atomicFromPaymentMinor(order.paymentAmountMinor),
        commissionRate: order.commissionRate,
      });
    },
    attach(order: PublicOrder): PublicOrder {
      return withPayment(order, opts.store.getX402Order(order.requestId));
    },
    async pay(input: {
      requestId: string;
      host: string;
      signatureHeader: string | null;
    }): Promise<X402PayResult> {
      const origin = opts.originOf(input.host);
      const { sourceOrder, x402: existing } = await ensureOrder(input.requestId);
      const baseOrder: PublicOrder = {
        requestId: sourceOrder.requestId,
        tradeNo: sourceOrder.tradeNo,
        paymentAmountMinor: sourceOrder.paymentAmountMinor,
        commissionRate: sourceOrder.commissionRate,
        commissionUsdc: sourceOrder.commissionUsdc,
        status: sourceOrder.status,
        recipient: opts.store.getOrderSnapshot(sourceOrder.requestId)?.recipient ?? "",
        error: opts.store.getOrderSnapshot(sourceOrder.requestId)?.error ?? null,
      };
      if (existing.status === "completed") {
        const latest = opts.store.getX402Order(existing.requestId)!;
        if (sourceOrder.status !== "paid") {
          const awarded = await opts.awardOrder(existing.requestId);
          opts.store.markX402Completed(existing.requestId);
          return success(awarded, opts.store.getX402Order(existing.requestId)!);
        }
        return success(withPayment(baseOrder, latest), latest);
      }
      if (existing.status === "blocked") {
        throw new ServiceError(409, existing.error ?? "付款未完成。");
      }
      if (sourceOrder.status === "paid" && existing.status !== "settled") {
        throw new ServiceError(409, "该订单已支付。");
      }
      const partner = opts.store.getPartner();
      const snapshot = opts.store.getOrderSnapshot(existing.requestId);
      if (!snapshot && !partner.wallet) {
        throw new ServiceError(400, "请先绑定收款钱包，再确认测试订单。");
      }
      const recipient = opts.store.snapshotOrderRecipient(
        existing.requestId,
        snapshot?.recipient ?? partner.wallet,
        orderReservationRequestId(existing.requestId),
      );
      void recipient;

      let payload: X402PaymentPayload | null = opts.store.getX402Payload(existing.requestId);
      if (input.signatureHeader) {
        const validated = await validatePaymentPayload({
          raw: decodePaymentSignatureHeader(input.signatureHeader),
          origin,
          requestId: existing.requestId,
          requirements: requirementsOf(existing),
          nowMs: opts.now(),
          allowExpiredPinned: payload !== null,
        });
        const pinned = opts.store.pinX402Authorization({
          requestId: existing.requestId,
          chainId: opts.config.network.chainId,
          token: existing.asset,
          payer: validated.payload.authorization.from,
          nonce: validated.payload.authorization.nonce,
          payload: validated,
        });
        payload = pinned.payload;
      } else if (!payload) {
        return required(baseOrder, existing, origin);
      }

      if (!payload) return required(baseOrder, existing, origin);
      let row = opts.store.getX402Order(existing.requestId)!;
      try {
        if (row.status !== "settled" && row.status !== "completed") {
          const txHash = await settlePinned(row, payload);
          opts.store.markX402Settled(row.requestId, txHash);
          row = opts.store.getX402Order(row.requestId)!;
        }
        const awarded = await opts.awardOrder(row.requestId);
        opts.store.markX402Completed(row.requestId);
        opts.store.setX402Error(row.requestId, null);
        return success(awarded, opts.store.getX402Order(row.requestId)!);
      } catch (err) {
        const message = sanitizeError(err);
        try {
          opts.store.setX402Error(row.requestId, message);
          opts.store.setOrderError(row.requestId, message);
        } catch {
          /* snapshot may already carry the error */
        }
        throw err instanceof ServiceError ? err : new ServiceError(502, message);
      }
    },
  };
}
