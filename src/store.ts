import { getAddress, isAddress, keccak256, toHex } from "viem";
import { migrateSchema, type Db } from "./db.ts";
import { createBunDb } from "./db-bun.ts";
import { MERCHANT_ID, PARTNER_ID, PARTNER_NAME } from "./config.ts";
import {
  asBigInt,
  assertLedgerCap,
  formatAmount,
  MAX_AMOUNT,
} from "./money.ts";
import type { X402OrderRecord, X402PaymentPayload } from "./x402/types.ts";
import {
  type Address,
  type AgentDraftRecord,
  type AgentProfile,
  type AgentRecord,
  type AgentRole,
  type AuthRole,
  type Hex,
  type ListedStatus,
  type PartnerRecord,
  type PayoutRecord,
  type PayoutStatus,
  type PublicPayout,
  type ServicePaymentRecord,
  type ServicePaymentStatus,
  type StarterGasRecord,
  type StarterGasStatus,
  type X402PaymentStatus,
  ServiceError,
  toPublicPayout,
} from "./types.ts";

export type Store = ReturnType<typeof createStore>;

// One-shot import of an existing ledger into a fresh database. The field shape
// matches what upsertAgent / createAgentDraft already accept, plus the draft's
// registered_agent_id so an already-registered draft keeps its agent link.
export type SeedAgentInput = {
  chainId: number;
  agentId: string;
  owner: Address;
  agentWallet: Address;
  role: AgentRole;
  listed: ListedStatus;
  agentUri: string;
  registerTx: Hex;
  blockNumber?: string | null;
  createdAt?: number;
};

export type SeedDraftInput = {
  draftId: string;
  address: Address;
  role: AgentRole;
  profile: AgentProfile;
  createdAt?: number;
  registeredAgentId?: string | null;
};

type Clock = () => number;

const STATUSES = new Set<PayoutStatus>([
  "reserved",
  "prepared",
  "broadcast",
  "confirmed",
  "completed",
  "blocked",
]);

const X402_STATUSES = new Set<X402PaymentStatus>([
  "required",
  "submitted",
  "settled",
  "completed",
  "blocked",
]);

const AGENT_ROLES = new Set<AgentRole>(["provider", "buyer"]);

const LISTED_STATUSES = new Set<ListedStatus>([
  "pending",
  "approved",
  "rejected",
]);

const STARTER_GAS_STATUSES = new Set<StarterGasStatus>([
  "reserved",
  "signed",
  "broadcast",
  "confirmed",
  "blocked",
]);

const SERVICE_PAYMENT_STATUSES = new Set<ServicePaymentStatus>([
  "required",
  "verified",
  "settling",
  "settled",
  "delivered",
  "failed",
]);

function payoutId(merchantId: string, sourceId: string): Hex {
  return keccak256(toHex(`${merchantId}/${sourceId}`));
}

function address(value: string, label = "地址"): Address {
  if (!isAddress(value, { strict: false })) {
    throw new ServiceError(400, `${label}无效。`);
  }
  return getAddress(value) as Address;
}

function mapX402Order(row: Record<string, unknown>): X402OrderRecord {
  const status = String(row.status);
  if (!X402_STATUSES.has(status as X402PaymentStatus)) {
    throw new ServiceError(500, "付款状态异常。");
  }
  return {
    requestId: String(row.request_id),
    status: status as X402PaymentStatus,
    payTo: String(row.pay_to) as Address,
    asset: String(row.asset) as Address,
    amount: String(row.amount),
    commissionRate: String(row.commission_rate),
    payer: row.payer ? (String(row.payer) as Address) : null,
    nonce: row.nonce ? (String(row.nonce) as Hex) : null,
    txHash: row.tx_hash ? (String(row.tx_hash) as Hex) : null,
    error: row.error ? String(row.error) : null,
    scanFromBlock: row.scan_from_block ? BigInt(String(row.scan_from_block)) : null,
    scanToBlock: row.scan_to_block ? BigInt(String(row.scan_to_block)) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapAgentDraft(row: Record<string, unknown>): AgentDraftRecord {
  const role = String(row.role);
  if (!AGENT_ROLES.has(role as AgentRole)) {
    throw new ServiceError(500, "The agent draft is in an unexpected state.");
  }
  let profile: AgentProfile;
  try {
    profile = JSON.parse(String(row.profile_json)) as AgentProfile;
  } catch {
    throw new ServiceError(500, "The agent draft is in an unexpected state.");
  }
  return {
    draftId: String(row.draft_id),
    address: String(row.address) as Address,
    role: role as AgentRole,
    profile,
    createdAt: Number(row.created_at),
    registeredAgentId: row.registered_agent_id
      ? String(row.registered_agent_id)
      : null,
  };
}

function mapAgent(row: Record<string, unknown>): AgentRecord {
  const role = String(row.role);
  const listed = String(row.listed);
  if (!AGENT_ROLES.has(role as AgentRole) || !LISTED_STATUSES.has(listed as ListedStatus)) {
    throw new ServiceError(500, "The agent record is in an unexpected state.");
  }
  return {
    chainId: Number(row.chain_id),
    agentId: String(row.agent_id),
    owner: String(row.owner) as Address,
    agentWallet: String(row.agent_wallet) as Address,
    role: role as AgentRole,
    listed: listed as ListedStatus,
    agentUri: String(row.agent_uri),
    registerTx: String(row.register_tx) as Hex,
    blockNumber: row.block_number == null ? null : String(row.block_number),
    createdAt: Number(row.created_at),
  };
}

function mapStarterGas(row: Record<string, unknown>): StarterGasRecord {
  const status = String(row.status);
  if (!STARTER_GAS_STATUSES.has(status as StarterGasStatus)) {
    throw new ServiceError(500, "The starter gas grant is in an unexpected state.");
  }
  return {
    address: String(row.address) as Address,
    amountWei: String(row.amount_wei),
    txHash: row.tx_hash ? (String(row.tx_hash) as Hex) : null,
    journal: row.journal ? (String(row.journal) as Hex) : null,
    status: status as StarterGasStatus,
    day: String(row.day),
    error: row.error ? String(row.error) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapServicePayment(row: Record<string, unknown>): ServicePaymentRecord {
  const status = String(row.status);
  if (!SERVICE_PAYMENT_STATUSES.has(status as ServicePaymentStatus)) {
    throw new ServiceError(500, "The service payment is in an unexpected state.");
  }
  return {
    paymentKey: String(row.payment_key) as Hex,
    serviceId: String(row.service_id),
    chainId: Number(row.chain_id),
    payer: String(row.payer) as Address,
    payTo: String(row.pay_to) as Address,
    asset: String(row.asset) as Address,
    amount: String(row.amount),
    nonce: String(row.nonce),
    scheme: row.scheme ? String(row.scheme) : "exact",
    status: status as ServicePaymentStatus,
    chargedAmount: row.charged_amount == null ? null : String(row.charged_amount),
    consumed: Number(row.consumed ?? 0) === 1,
    usageJson: row.usage_json ? String(row.usage_json) : null,
    upstreamRequestId: row.upstream_request_id ? String(row.upstream_request_id) : null,
    txHash: row.tx_hash ? (String(row.tx_hash) as Hex) : null,
    journal: row.journal ? (String(row.journal) as Hex) : null,
    resultJson: row.result_json ? String(row.result_json) : null,
    error: row.error ? String(row.error) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapPayout(row: Record<string, unknown>): PayoutRecord {
  const status = String(row.status);
  if (!STATUSES.has(status as PayoutStatus)) {
    throw new ServiceError(500, "出款状态异常。");
  }
  return {
    id: String(row.id) as Hex,
    sourceId: String(row.source_id),
    recipient: String(row.recipient) as Address,
    amount: asBigInt(row.amount),
    status: status as PayoutStatus,
    txHash: row.tx_hash ? (String(row.tx_hash) as Hex) : null,
    error: row.error ? String(row.error) : null,
    createdAt: Number(row.created_at),
    rawTransaction: row.raw_transaction
      ? (String(row.raw_transaction) as Hex)
      : null,
    alreadyFrozen: Number(row.already_frozen) === 1,
    requestId: row.request_id ? String(row.request_id) : null,
    externalId: row.external_id == null ? null : Number(row.external_id),
  };
}

export function createStore(opts: {
  path: string;
  db?: Db;
  now?: Clock;
  merchantId?: string;
  partnerId?: string;
  partnerName?: string;
  fingerprint?: string;
}) {
  const now = opts.now ?? Date.now;
  const merchantId = opts.merchantId ?? MERCHANT_ID;
  const partnerId = opts.partnerId ?? PARTNER_ID;
  const partnerName = opts.partnerName ?? PARTNER_NAME;
  const db = opts.db ?? createBunDb(opts.path);
  migrateSchema(db);
  db.run(
    `INSERT OR IGNORE INTO partner (id, name, wallet, auto_settle, available, pending, paid, consumed)
     VALUES (?, ?, '', 0, 0, 0, 0, 0)`,
    [partnerId, partnerName],
  );
  db.run(`INSERT OR IGNORE INTO service (id, paused) VALUES (1, 0)`);
  if (opts.fingerprint) {
    const bound = db
      .query(`SELECT fingerprint FROM runtime WHERE id = 1`)
      .get() as { fingerprint: string } | null;
    if (!bound) {
      db.run(
        `INSERT INTO runtime (id, fingerprint, bound_at) VALUES (1, ?, ?)`,
        [opts.fingerprint, now()],
      );
    } else if (bound.fingerprint !== opts.fingerprint) {
      db.close();
      throw new Error("结算账本与当前运行配置不一致，拒绝复用。");
    }
  }

  const tx = <T>(fn: () => T): T => db.transaction(fn);

  const purgeExpiredAuthSessions = () => {
    db.run(`DELETE FROM auth_sessions WHERE expires_at <= ?`, [now()]);
  };

  const getAuthSession = (tokenHash: string) => {
    purgeExpiredAuthSessions();
    const row = db
      .query(
        `SELECT token_hash, role, credential_fingerprint, created_at, expires_at
         FROM auth_sessions WHERE token_hash = ?`,
      )
      .get(tokenHash) as Record<string, unknown> | null;
    if (!row) return null;
    if (Number(row.expires_at) <= now()) {
      db.run(`DELETE FROM auth_sessions WHERE token_hash = ?`, [tokenHash]);
      return null;
    }
    const role = String(row.role);
    if (role !== "merchant" && role !== "promoter") {
      db.run(`DELETE FROM auth_sessions WHERE token_hash = ?`, [tokenHash]);
      return null;
    }
    return {
      tokenHash: String(row.token_hash),
      role: role as AuthRole,
      credentialFingerprint: String(row.credential_fingerprint),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  };

  const getPartner = (): PartnerRecord => {
    const row = db
      .query(
        `SELECT id, name, wallet, auto_settle, available, pending, paid, consumed FROM partner WHERE id = ?`,
      )
      .get(partnerId) as Record<string, unknown>;
    return {
      id: String(row.id),
      name: String(row.name),
      wallet: String(row.wallet ?? ""),
      autoSettle: Number(row.auto_settle) === 1,
      available: asBigInt(row.available),
      pending: asBigInt(row.pending),
      paid: asBigInt(row.paid),
      consumed: asBigInt(row.consumed),
    };
  };

  const getPayoutBySource = (sourceId: string): PayoutRecord | null => {
    const row = db
      .query(`SELECT * FROM payouts WHERE source_id = ?`)
      .get(sourceId) as Record<string, unknown> | null;
    return row ? mapPayout(row) : null;
  };

  const getAgentDraft = (draftId: string): AgentDraftRecord | null => {
    const row = db
      .query(`SELECT * FROM agent_drafts WHERE draft_id = ?`)
      .get(draftId) as Record<string, unknown> | null;
    return row ? mapAgentDraft(row) : null;
  };

  const getAgent = (chainId: number, agentId: string): AgentRecord | null => {
    const row = db
      .query(`SELECT * FROM agents WHERE chain_id = ? AND agent_id = ?`)
      .get(chainId, agentId) as Record<string, unknown> | null;
    return row ? mapAgent(row) : null;
  };

  const getAgentDraftByAgentId = (agentId: string): AgentDraftRecord | null => {
    const row = db
      .query(
        `SELECT * FROM agent_drafts WHERE registered_agent_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(agentId) as Record<string, unknown> | null;
    return row ? mapAgentDraft(row) : null;
  };

  // Row-level writers shared by the public mutations and the one-shot seed
  // import. They never open their own transaction so importSeed can run every
  // row inside a single transaction.
  const insertAgentDraft = (input: {
    draftId: string;
    address: Address;
    role: AgentRole;
    profile: AgentProfile;
    createdAt?: number;
  }): AgentDraftRecord => {
    const owner = address(input.address, "代理地址");
    if (!AGENT_ROLES.has(input.role)) {
      throw new ServiceError(400, "Invalid agent role.");
    }
    db.run(
      `INSERT INTO agent_drafts (draft_id, address, role, profile_json, created_at, registered_agent_id)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [
        input.draftId,
        owner,
        input.role,
        JSON.stringify(input.profile),
        input.createdAt ?? now(),
      ],
    );
    return getAgentDraft(input.draftId)!;
  };

  const setDraftRegisteredRow = (draftId: string, agentId: string) => {
    const result = db.run(
      `UPDATE agent_drafts SET registered_agent_id = ? WHERE draft_id = ? AND registered_agent_id IS NULL`,
      [agentId, draftId],
    );
    if (result.changes !== 1) {
      const existing = getAgentDraft(draftId);
      if (!existing || existing.registeredAgentId !== agentId) {
        throw new ServiceError(409, "The draft is in an unexpected state.");
      }
    }
  };

  const upsertAgentRow = (input: {
    chainId: number;
    agentId: string;
    owner: Address;
    agentWallet: Address;
    role: AgentRole;
    listed: ListedStatus;
    agentUri: string;
    registerTx: Hex;
    blockNumber?: string | null;
    createdAt?: number;
  }): AgentRecord => {
    const owner = address(input.owner, "代理所有者");
    const wallet = address(input.agentWallet, "代理钱包");
    const existing = getAgent(input.chainId, input.agentId);
    if (existing) {
      if (existing.owner.toLowerCase() !== owner.toLowerCase()) {
        throw new ServiceError(409, "This agentId is already bound to a different owner.");
      }
      return existing;
    }
    db.run(
      `INSERT INTO agents (chain_id, agent_id, owner, agent_wallet, role, listed, agent_uri, register_tx, block_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.chainId,
        input.agentId,
        owner,
        wallet,
        input.role,
        input.listed,
        input.agentUri,
        input.registerTx,
        input.blockNumber ?? null,
        input.createdAt ?? now(),
      ],
    );
    return getAgent(input.chainId, input.agentId)!;
  };

  const getStarterGas = (address_: string): StarterGasRecord | null => {
    if (!isAddress(address_, { strict: false })) return null;
    const row = db
      .query(`SELECT * FROM starter_gas_grants WHERE address = ?`)
      .get(getAddress(address_)) as Record<string, unknown> | null;
    return row ? mapStarterGas(row) : null;
  };

  const getServicePayment = (paymentKey: string): ServicePaymentRecord | null => {
    const row = db
      .query(`SELECT * FROM service_payments WHERE payment_key = ?`)
      .get(paymentKey) as Record<string, unknown> | null;
    return row ? mapServicePayment(row) : null;
  };

  // Public receipt history for one payer. Newest first; the caller caps the
  // limit so a full-table scan cannot be requested through the public API.
  const listServicePaymentsByPayer = (
    payer: string,
    limit: number,
  ): ServicePaymentRecord[] => {
    const rows = db
      .query(
        `SELECT * FROM service_payments WHERE payer = ?
         ORDER BY created_at DESC, payment_key DESC LIMIT ?`,
      )
      .all(address(payer, "付款地址"), limit) as Record<string, unknown>[];
    return rows.map(mapServicePayment);
  };

  // Aggregate public counters. Paid calls are rows that settled (money moved),
  // whether or not delivery later completed; the settled total uses the actual
  // charge and falls back to the authorized amount for exact payments.
  const publicServiceStats = (): {
    calls: number;
    settledUsdt: string;
    payers: number;
    agents: number;
  } => {
    const paid = db
      .query(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CAST(COALESCE(charged_amount, amount) AS INTEGER)), 0) AS total,
                COUNT(DISTINCT payer) AS payers
         FROM service_payments WHERE status IN ('settled', 'delivered')`,
      )
      .get() as { n: number; total: number | string; payers: number };
    const agents = db.query(`SELECT COUNT(*) AS n FROM agents`).get() as {
      n: number;
    };
    return {
      calls: Number(paid.n),
      settledUsdt: BigInt(paid.total).toString(),
      payers: Number(paid.payers),
      agents: Number(agents.n),
    };
  };

  const getPayout = (id: string): PayoutRecord | null => {
    const row = db
      .query(`SELECT * FROM payouts WHERE id = ?`)
      .get(id) as Record<string, unknown> | null;
    return row ? mapPayout(row) : null;
  };

  const insertPayout = (item: {
    sourceId: string;
    recipient: Address;
    amount: bigint;
    alreadyFrozen: boolean;
    createdAt?: number;
    requestId?: string;
    externalId?: number;
  }): PayoutRecord => {
    const existing = getPayoutBySource(item.sourceId);
    if (existing) {
      if (
        existing.amount !== item.amount ||
        existing.recipient.toLowerCase() !== item.recipient.toLowerCase()
      ) {
        throw new ServiceError(409, "同一来源的金额或收款地址不能更改。");
      }
      return existing;
    }
    const id = payoutId(merchantId, item.sourceId);
    const createdAt = item.createdAt ?? now();
    db.run(
      `INSERT INTO payouts (id, source_id, recipient, amount, status, created_at, already_frozen, request_id, external_id)
       VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
      [
        id,
        item.sourceId,
        item.recipient,
        item.amount.toString(),
        createdAt,
        item.alreadyFrozen ? 1 : 0,
        item.requestId ?? null,
        item.externalId ?? null,
      ],
    );
    return getPayoutBySource(item.sourceId)!;
  };

  return {
    close() {
      db.close();
    },
    now,
    merchantId,
    partnerId,
    getPartner,
    isPaused(): boolean {
      const row = db.query(`SELECT paused FROM service WHERE id = 1`).get() as {
        paused: number;
      };
      return Number(row.paused) === 1;
    },
    setPaused(paused: boolean) {
      db.run(`UPDATE service SET paused = ? WHERE id = 1`, [paused ? 1 : 0]);
    },
    setWallet(wallet: string) {
      const value = address(wallet, "钱包地址");
      db.run(`UPDATE partner SET wallet = ? WHERE id = ?`, [value, partnerId]);
    },
    setAutoSettle(enabled: boolean) {
      tx(() => {
        const partner = getPartner();
        if (enabled && !partner.wallet) {
          throw new ServiceError(400, "请先绑定收款钱包，再开启自动结算。");
        }
        db.run(`UPDATE partner SET auto_settle = ? WHERE id = ?`, [
          enabled ? 1 : 0,
          partnerId,
        ]);
      });
    },
    addCommission(amount: bigint): string {
      if (amount <= 0n || amount > MAX_AMOUNT) {
        throw new ServiceError(400, "金额超过单笔上限。");
      }
      return tx(() => {
        const partner = getPartner();
        assertLedgerCap(
          partner.available,
          partner.pending,
          partner.paid,
          partner.consumed,
          amount,
        );
        const sourceId = `fixture:${crypto.randomUUID()}`;
        db.run(
          `INSERT INTO commissions (source_id, amount, remaining, created_at) VALUES (?, ?, ?, ?)`,
          [sourceId, amount.toString(), amount.toString(), now()],
        );
        db.run(`UPDATE partner SET available = available + ? WHERE id = ?`, [
          amount.toString(),
          partnerId,
        ]);
        return sourceId;
      });
    },
    transfer(amount: bigint) {
      if (amount <= 0n || amount > MAX_AMOUNT) {
        throw new ServiceError(400, "金额超过单笔上限。");
      }
      tx(() => {
        const partner = getPartner();
        if (partner.available < amount)
          throw new ServiceError(409, "可用收益不足。");
        assertLedgerCap(partner.consumed, amount);
        let left = amount;
        const rows = db
          .query(
            `SELECT source_id, remaining FROM commissions WHERE remaining > 0 ORDER BY created_at ASC, source_id ASC`,
          )
          .all() as Record<string, unknown>[];
        for (const row of rows) {
          if (left === 0n) break;
          const remaining = asBigInt(row.remaining);
          const take = remaining < left ? remaining : left;
          const upd = db.run(
            `UPDATE commissions SET remaining = remaining - ? WHERE source_id = ? AND remaining >= ?`,
            [take.toString(), String(row.source_id), take.toString()],
          );
          if (upd.changes !== 1) throw new ServiceError(409, "可用收益不足。");
          left -= take;
        }
        if (left !== 0n) throw new ServiceError(409, "可用收益不足。");
        const result = db.run(
          `UPDATE partner SET available = available - ?, consumed = consumed + ?
           WHERE id = ? AND available >= ?`,
          [amount.toString(), amount.toString(), partnerId, amount.toString()],
        );
        if (result.changes !== 1) throw new ServiceError(409, "可用收益不足。");
      });
    },
    listRemainingCommissions(): {
      sourceId: string;
      amount: bigint;
      remaining: bigint;
      createdAt: number;
    }[] {
      const rows = db
        .query(
          `SELECT source_id, amount, remaining, created_at FROM commissions WHERE remaining > 0
           ORDER BY created_at ASC, source_id ASC`,
        )
        .all() as Record<string, unknown>[];
      return rows.map((row) => ({
        sourceId: String(row.source_id),
        amount: asBigInt(row.amount),
        remaining: asBigInt(row.remaining),
        createdAt: Number(row.created_at),
      }));
    },
    reserveMature(opts: {
      recipient: string;
      minAmount: bigint;
      nowMs: number;
      maturityMs: number;
    }): PayoutRecord | null {
      return tx(() => {
        const to = address(opts.recipient, "收款地址");
        const rows = db
          .query(
            `SELECT source_id, remaining, created_at FROM commissions WHERE remaining > 0
             ORDER BY created_at ASC, source_id ASC`,
          )
          .all() as Record<string, unknown>[];
        const selected: { sourceId: string; take: bigint }[] = [];
        let total = 0n;
        for (const row of rows) {
          if (opts.nowMs < Number(row.created_at) + opts.maturityMs) continue;
          const remaining = asBigInt(row.remaining);
          if (remaining <= 0n) continue;
          const room = MAX_AMOUNT - total;
          const take = remaining < room ? remaining : room;
          selected.push({ sourceId: String(row.source_id), take });
          total += take;
          if (total === MAX_AMOUNT) break;
        }
        if (total < opts.minAmount) return null;
        const partner = getPartner();
        if (partner.available < total)
          throw new ServiceError(409, "可用收益不足。");
        const moved = db.run(
          `UPDATE partner SET available = available - ?, pending = pending + ?
           WHERE id = ? AND available >= ?`,
          [total.toString(), total.toString(), partnerId, total.toString()],
        );
        if (moved.changes !== 1) throw new ServiceError(409, "可用收益不足。");
        const sourceId = `fixture:agg:${crypto.randomUUID()}`;
        const payout = insertPayout({
          sourceId,
          recipient: to,
          amount: total,
          alreadyFrozen: false,
        });
        for (const part of selected) {
          const upd = db.run(
            `UPDATE commissions SET remaining = remaining - ? WHERE source_id = ? AND remaining >= ?`,
            [part.take.toString(), part.sourceId, part.take.toString()],
          );
          if (upd.changes !== 1) throw new ServiceError(409, "可用收益不足。");
          db.run(
            `INSERT INTO allocations (payout_id, commission_source_id, amount) VALUES (?, ?, ?)`,
            [payout.id, part.sourceId, part.take.toString()],
          );
        }
        return getPayoutBySource(sourceId)!;
      });
    },
    listAllocations(
      payoutId: string,
    ): { commissionId: string; amount: bigint }[] {
      const rows = db
        .query(
          `SELECT commission_source_id, amount FROM allocations WHERE payout_id = ? ORDER BY commission_source_id`,
        )
        .all(payoutId) as Record<string, unknown>[];
      return rows.map((row) => ({
        commissionId: String(row.commission_source_id),
        amount: asBigInt(row.amount),
      }));
    },
    importReservation(item: {
      sourceId: string;
      recipient: string;
      amount: bigint;
      alreadyFrozen: boolean;
      createdAt?: number;
      requestId?: string;
      externalId?: number;
      numericId?: number;
    }): PayoutRecord {
      if (item.amount <= 0n || item.amount > MAX_AMOUNT) {
        throw new ServiceError(400, "金额超过单笔上限。");
      }
      const to = address(item.recipient, "收款地址");
      return tx(() => {
        const existing = getPayoutBySource(item.sourceId);
        if (existing) {
          if (
            existing.amount !== item.amount ||
            existing.recipient.toLowerCase() !== to.toLowerCase()
          ) {
            throw new ServiceError(409, "同一来源的金额或收款地址不能更改。");
          }
          return existing;
        }
        if (item.alreadyFrozen) {
          const partner = getPartner();
          assertLedgerCap(partner.pending, item.amount);
          db.run(`UPDATE partner SET pending = pending + ? WHERE id = ?`, [
            item.amount.toString(),
            partnerId,
          ]);
        } else {
          const partner = getPartner();
          if (partner.available < item.amount)
            throw new ServiceError(409, "可用收益不足。");
          const result = db.run(
            `UPDATE partner SET available = available - ?, pending = pending + ?
             WHERE id = ? AND available >= ?`,
            [
              item.amount.toString(),
              item.amount.toString(),
              partnerId,
              item.amount.toString(),
            ],
          );
          if (result.changes !== 1)
            throw new ServiceError(409, "可用收益不足。");
        }
        return insertPayout({
          ...item,
          recipient: to,
          requestId: item.requestId,
          externalId: item.externalId ?? item.numericId,
        });
      });
    },
    getPayout,
    getPayoutBySource,
    listPayouts(): PayoutRecord[] {
      const rows = db
        .query(`SELECT * FROM payouts ORDER BY created_at DESC, source_id DESC`)
        .all() as Record<string, unknown>[];
      return rows.map(mapPayout);
    },
    publicPayouts(): PublicPayout[] {
      return this.listPayouts().map(toPublicPayout);
    },
    getInFlight(): PayoutRecord | null {
      const rows = db
        .query(
          `SELECT * FROM payouts WHERE status IN ('prepared', 'broadcast') ORDER BY created_at ASC`,
        )
        .all() as Record<string, unknown>[];
      return rows[0] ? mapPayout(rows[0]) : null;
    },
    listByStatus(statuses: PayoutStatus[]): PayoutRecord[] {
      if (statuses.length === 0) return [];
      const placeholders = statuses.map(() => "?").join(",");
      const rows = db
        .query(
          `SELECT * FROM payouts WHERE status IN (${placeholders}) ORDER BY created_at ASC`,
        )
        .all(...statuses) as Record<string, unknown>[];
      return rows.map(mapPayout);
    },
    nextReserved(): PayoutRecord | null {
      const row = db
        .query(
          `SELECT * FROM payouts WHERE status = 'reserved' ORDER BY created_at ASC LIMIT 1`,
        )
        .get() as Record<string, unknown> | null;
      return row ? mapPayout(row) : null;
    },
    persistPrepared(id: string, rawTransaction: Hex, hash: Hex) {
      tx(() => {
        const current = getPayout(id);
        if (!current || current.status !== "reserved") {
          throw new ServiceError(409, "这笔出款还不能签名。");
        }
        const inflight = db
          .query(
            `SELECT id FROM payouts WHERE status IN ('prepared', 'broadcast') AND id != ?`,
          )
          .get(id) as { id: string } | null;
        if (inflight) throw new ServiceError(409, "已有未完成的出款交易。");
        const prepared = db.run(
          `UPDATE payouts SET status = 'prepared', raw_transaction = ?, tx_hash = ?, error = NULL WHERE id = ? AND status = 'reserved'`,
          [rawTransaction, hash, id],
        );
        if (prepared.changes !== 1)
          throw new ServiceError(409, "这笔出款还不能签名。");
      });
    },
    markBroadcast(id: string) {
      const result = db.run(
        `UPDATE payouts SET status = 'broadcast' WHERE id = ? AND status IN ('prepared', 'broadcast') AND raw_transaction IS NOT NULL AND tx_hash IS NOT NULL`,
        [id],
      );
      if (result.changes !== 1) {
        const current = getPayout(id);
        if (current?.status !== "broadcast") {
          throw new ServiceError(409, "这笔出款还不能广播。");
        }
      }
    },
    markConfirmed(id: string) {
      db.run(
        `UPDATE payouts SET status = 'confirmed', error = NULL WHERE id = ? AND status IN ('prepared', 'broadcast', 'confirmed')`,
        [id],
      );
    },
    blockPayout(id: string, error: string) {
      db.run(
        `UPDATE payouts SET status = 'blocked', error = ? WHERE id = ? AND status IN ('prepared', 'broadcast', 'blocked')`,
        [error, id],
      );
    },
    setPayoutError(id: string, error: string) {
      db.run(`UPDATE payouts SET error = ? WHERE id = ?`, [error, id]);
    },
    completePayout(id: string) {
      tx(() => {
        const current = getPayout(id);
        if (!current) throw new ServiceError(404, "找不到这笔出款。");
        if (current.status === "completed") return;
        if (current.status !== "confirmed") {
          throw new ServiceError(409, "链上回执尚未确认，不能记为完成。");
        }
        const result = db.run(
          `UPDATE payouts SET status = 'completed', error = NULL WHERE id = ? AND status = 'confirmed'`,
          [id],
        );
        if (result.changes !== 1) return;
        const ledger = db.run(
          `UPDATE partner SET pending = pending - ?, paid = paid + ? WHERE id = ? AND pending >= ?`,
          [
            current.amount.toString(),
            current.amount.toString(),
            partnerId,
            current.amount.toString(),
          ],
        );
        if (ledger.changes !== 1) throw new ServiceError(500, "账本金额异常。");
      });
    },
    createSession(): string {
      const id = crypto.randomUUID();
      db.run(`INSERT INTO sessions (id, created_at) VALUES (?, ?)`, [
        id,
        now(),
      ]);
      return id;
    },
    hasSession(id: string): boolean {
      return !!db.query(`SELECT id FROM sessions WHERE id = ?`).get(id);
    },
    createAuthSession(row: {
      tokenHash: string;
      role: AuthRole;
      credentialFingerprint: string;
      expiresAt: number;
    }) {
      purgeExpiredAuthSessions();
      db.run(
        `INSERT INTO auth_sessions (token_hash, role, credential_fingerprint, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          row.tokenHash,
          row.role,
          row.credentialFingerprint,
          now(),
          row.expiresAt,
        ],
      );
    },
    getAuthSession,
    deleteAuthSession(tokenHash: string) {
      db.run(`DELETE FROM auth_sessions WHERE token_hash = ?`, [tokenHash]);
    },
    purgeExpiredAuthSessions,
    putChallenge(row: {
      sessionId: string;
      address: Address;
      nonce: string;
      message: string;
      issuedAt: number;
      expiresAt: number;
    }) {
      db.run(
        `INSERT INTO challenges (session_id, address, nonce, message, issued_at, expires_at, consumed)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(session_id) DO UPDATE SET
           address = excluded.address,
           nonce = excluded.nonce,
           message = excluded.message,
           issued_at = excluded.issued_at,
           expires_at = excluded.expires_at,
           consumed = 0`,
        [
          row.sessionId,
          row.address,
          row.nonce,
          row.message,
          row.issuedAt,
          row.expiresAt,
        ],
      );
    },
    getChallenge(sessionId: string) {
      const row = db
        .query(`SELECT * FROM challenges WHERE session_id = ?`)
        .get(sessionId) as Record<string, unknown> | null;
      if (!row) return null;
      return {
        sessionId: String(row.session_id),
        address: String(row.address) as Address,
        nonce: String(row.nonce),
        message: String(row.message),
        issuedAt: Number(row.issued_at),
        expiresAt: Number(row.expires_at),
        consumed: Number(row.consumed) === 1,
      };
    },
    consumeChallenge(sessionId: string) {
      const result = db.run(
        `UPDATE challenges SET consumed = 1 WHERE session_id = ? AND consumed = 0`,
        [sessionId],
      );
      if (result.changes !== 1)
        throw new ServiceError(409, "This challenge was already used. Request a new one.");
    },
    getOrderSnapshot(requestId: string) {
      const row = db
        .query(
          `SELECT request_id, recipient, reservation_request_id, created_at, error FROM order_snapshots WHERE request_id = ?`,
        )
        .get(requestId) as Record<string, unknown> | null;
      if (!row) return null;
      return {
        requestId: String(row.request_id),
        recipient: String(row.recipient) as Address,
        reservationRequestId: String(row.reservation_request_id),
        createdAt: Number(row.created_at),
        error: row.error ? String(row.error) : null,
      };
    },
    listOrderSnapshots() {
      const rows = db
        .query(
          `SELECT request_id, recipient, reservation_request_id, created_at, error FROM order_snapshots ORDER BY created_at ASC`,
        )
        .all() as Record<string, unknown>[];
      return rows.map((row) => ({
        requestId: String(row.request_id),
        recipient: String(row.recipient) as Address,
        reservationRequestId: String(row.reservation_request_id),
        createdAt: Number(row.created_at),
        error: row.error ? String(row.error) : null,
      }));
    },
    snapshotOrderRecipient(
      requestId: string,
      recipient: string,
      reservationRequestId: string,
    ): Address {
      const to = address(recipient, "收款地址");
      return tx(() => {
        const existing = db
          .query(
            `SELECT recipient FROM order_snapshots WHERE request_id = ?`,
          )
          .get(requestId) as { recipient: string } | null;
        if (existing) return address(existing.recipient, "收款地址");
        db.run(
          `INSERT INTO order_snapshots (request_id, recipient, reservation_request_id, created_at, error)
           VALUES (?, ?, ?, ?, NULL)`,
          [requestId, to, reservationRequestId, now()],
        );
        return to;
      });
    },
    setOrderError(requestId: string, error: string | null) {
      const result = db.run(
        `UPDATE order_snapshots SET error = ? WHERE request_id = ?`,
        [error, requestId],
      );
      if (result.changes !== 1) {
        throw new ServiceError(404, "找不到该订单。");
      }
    },
    getX402Order(requestId: string): X402OrderRecord | null {
      const row = db
        .query(
          `SELECT request_id, status, pay_to, asset, amount, commission_rate, payer, nonce,
                  tx_hash, error, scan_from_block, scan_to_block, created_at, updated_at
           FROM x402_orders WHERE request_id = ?`,
        )
        .get(requestId) as Record<string, unknown> | null;
      return row ? mapX402Order(row) : null;
    },
    listX402Orders(): X402OrderRecord[] {
      const rows = db
        .query(
          `SELECT request_id, status, pay_to, asset, amount, commission_rate, payer, nonce,
                  tx_hash, error, scan_from_block, scan_to_block, created_at, updated_at
           FROM x402_orders ORDER BY created_at ASC`,
        )
        .all() as Record<string, unknown>[];
      return rows.map(mapX402Order);
    },
    createX402Order(input: {
      requestId: string;
      payTo: Address;
      asset: Address;
      amount: string;
      commissionRate: string;
    }): X402OrderRecord {
      return tx(() => {
        const existing = db
          .query(`SELECT * FROM x402_orders WHERE request_id = ?`)
          .get(input.requestId) as Record<string, unknown> | null;
        if (existing) {
          const mapped = mapX402Order(existing);
          if (
            mapped.amount !== input.amount ||
            mapped.payTo.toLowerCase() !== input.payTo.toLowerCase() ||
            mapped.asset.toLowerCase() !== input.asset.toLowerCase()
          ) {
            throw new ServiceError(409, "同一来源的金额或收款地址不能更改。");
          }
          return mapped;
        }
        const createdAt = now();
        db.run(
          `INSERT INTO x402_orders (
             request_id, status, pay_to, asset, amount, commission_rate,
             created_at, updated_at
           ) VALUES (?, 'required', ?, ?, ?, ?, ?, ?)`,
          [
            input.requestId,
            getAddress(input.payTo),
            getAddress(input.asset),
            input.amount,
            input.commissionRate,
            createdAt,
            createdAt,
          ],
        );
        return mapX402Order(
          db
            .query(`SELECT * FROM x402_orders WHERE request_id = ?`)
            .get(input.requestId) as Record<string, unknown>,
        );
      });
    },
    pinX402Authorization(input: {
      requestId: string;
      chainId: number;
      token: Address;
      payer: Address;
      nonce: Hex;
      payload: X402PaymentPayload;
    }): { order: X402OrderRecord; payload: X402PaymentPayload } {
      return tx(() => {
        const current = db
          .query(`SELECT * FROM x402_orders WHERE request_id = ?`)
          .get(input.requestId) as Record<string, unknown> | null;
        if (!current) throw new ServiceError(404, "找不到该订单。");
        const order = mapX402Order(current);
        const payer = address(input.payer, "付款地址");
        const token = address(input.token, "代币");
        const nonce = input.nonce.toLowerCase() as Hex;
        if (order.status === "blocked") {
          throw new ServiceError(409, "付款未完成。");
        }
        if (order.nonce && order.nonce.toLowerCase() !== nonce) {
          throw new ServiceError(409, "该订单已绑定付款授权。");
        }
        if (order.payer && order.payer.toLowerCase() !== payer.toLowerCase()) {
          throw new ServiceError(409, "该订单已绑定付款授权。");
        }
        const taken = db
          .query(
            `SELECT request_id FROM x402_authorizations
             WHERE chain_id = ? AND token = ? AND payer = ? AND nonce = ?`,
          )
          .get(input.chainId, token, payer, nonce) as { request_id: string } | null;
        if (taken && taken.request_id !== input.requestId) {
          throw new ServiceError(409, "该付款已被使用。");
        }
        const existingPayload = db
          .query(
            `SELECT payload_json FROM x402_authorizations WHERE request_id = ?`,
          )
          .get(input.requestId) as { payload_json: string } | null;
        if (!existingPayload) {
          try {
            db.run(
              `INSERT INTO x402_authorizations (
                 request_id, chain_id, token, payer, nonce, payload_json, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                input.requestId,
                input.chainId,
                token,
                payer,
                nonce,
                JSON.stringify(input.payload),
                now(),
              ],
            );
          } catch {
            const raced = db
              .query(
                `SELECT request_id FROM x402_authorizations
                 WHERE chain_id = ? AND token = ? AND payer = ? AND nonce = ?`,
              )
              .get(input.chainId, token, payer, nonce) as {
              request_id: string;
            } | null;
            if (raced && raced.request_id !== input.requestId) {
              throw new ServiceError(409, "该付款已被使用。");
            }
            throw new ServiceError(409, "该订单已绑定付款授权。");
          }
        }
        const nextStatus =
          order.status === "required" ? "submitted" : order.status;
        db.run(
          `UPDATE x402_orders
           SET status = ?, payer = ?, nonce = ?, updated_at = ?
           WHERE request_id = ?`,
          [nextStatus, payer, nonce, now(), input.requestId],
        );
        const stored = existingPayload
          ? (JSON.parse(existingPayload.payload_json) as X402PaymentPayload)
          : input.payload;
        return {
          order: mapX402Order(
            db
              .query(`SELECT * FROM x402_orders WHERE request_id = ?`)
              .get(input.requestId) as Record<string, unknown>,
          ),
          payload: stored,
        };
      });
    },
    getX402Payload(requestId: string): X402PaymentPayload | null {
      const row = db
        .query(
          `SELECT payload_json FROM x402_authorizations WHERE request_id = ?`,
        )
        .get(requestId) as { payload_json: string } | null;
      if (!row) return null;
      try {
        return JSON.parse(row.payload_json) as X402PaymentPayload;
      } catch {
        throw new ServiceError(500, "付款状态异常。");
      }
    },
    setX402ScanRange(requestId: string, fromBlock: bigint, toBlock?: bigint) {
      const result = db.run(
        `UPDATE x402_orders
         SET scan_from_block = COALESCE(scan_from_block, ?),
             scan_to_block = ?,
             updated_at = ?
         WHERE request_id = ?`,
        [
          fromBlock.toString(),
          toBlock == null ? null : toBlock.toString(),
          now(),
          requestId,
        ],
      );
      if (result.changes !== 1) throw new ServiceError(404, "找不到该订单。");
    },
    markX402Settled(requestId: string, txHash: Hex) {
      tx(() => {
        const current = db
          .query(`SELECT status, tx_hash FROM x402_orders WHERE request_id = ?`)
          .get(requestId) as { status: string; tx_hash: string | null } | null;
        if (!current) throw new ServiceError(404, "找不到该订单。");
        if (current.status === "completed" || current.status === "settled") {
          if (
            current.tx_hash &&
            current.tx_hash.toLowerCase() !== txHash.toLowerCase()
          ) {
            throw new ServiceError(409, "该订单已绑定付款授权。");
          }
          db.run(
            `UPDATE x402_orders SET tx_hash = COALESCE(tx_hash, ?), error = NULL, updated_at = ?
             WHERE request_id = ?`,
            [txHash, now(), requestId],
          );
          return;
        }
        if (current.status !== "submitted") {
          throw new ServiceError(409, "这笔付款还不能确认。");
        }
        const result = db.run(
          `UPDATE x402_orders
           SET status = 'settled', tx_hash = ?, error = NULL, updated_at = ?
           WHERE request_id = ? AND status = 'submitted'`,
          [txHash, now(), requestId],
        );
        if (result.changes !== 1) {
          throw new ServiceError(409, "这笔付款还不能确认。");
        }
      });
    },
    markX402Completed(requestId: string) {
      const result = db.run(
        `UPDATE x402_orders
         SET status = 'completed', error = NULL, updated_at = ?
         WHERE request_id = ? AND status IN ('settled', 'completed')`,
        [now(), requestId],
      );
      if (result.changes !== 1) {
        const current = db
          .query(`SELECT status FROM x402_orders WHERE request_id = ?`)
          .get(requestId) as { status: string } | null;
        if (current?.status === "completed") return;
        throw new ServiceError(409, "这笔付款还不能记为完成。");
      }
    },
    blockX402(requestId: string, error: string) {
      db.run(
        `UPDATE x402_orders
         SET status = 'blocked', error = ?, updated_at = ?
         WHERE request_id = ? AND status IN ('required', 'submitted', 'blocked')`,
        [error, now(), requestId],
      );
    },
    setX402Error(requestId: string, error: string | null) {
      db.run(
        `UPDATE x402_orders SET error = ?, updated_at = ? WHERE request_id = ?`,
        [error, now(), requestId],
      );
    },
    partnerPublic(balances?: {
      available: string;
      pending: string;
      paid: string;
      consumed: string;
    }) {
      const partner = getPartner();
      return {
        id: partner.id,
        name: partner.name,
        wallet: partner.wallet,
        autoSettle: partner.autoSettle,
        available: balances?.available ?? formatAmount(partner.available),
        pending: balances?.pending ?? formatAmount(partner.pending),
        paid: balances?.paid ?? formatAmount(partner.paid),
        consumed: balances?.consumed ?? formatAmount(partner.consumed),
      };
    },
    createAgentDraft(input: {
      draftId: string;
      address: Address;
      role: AgentRole;
      profile: AgentProfile;
      createdAt?: number;
    }): AgentDraftRecord {
      return insertAgentDraft(input);
    },
    getAgentDraft,
    getAgentDraftByAgentId,
    countOpenAgentDrafts(address_: string): number {
      const row = db
        .query(
          `SELECT COUNT(*) AS n FROM agent_drafts WHERE address = ? AND registered_agent_id IS NULL`,
        )
        .get(address(address_)) as { n: number };
      return Number(row.n);
    },
    setDraftRegistered(draftId: string, agentId: string) {
      setDraftRegisteredRow(draftId, agentId);
    },
    upsertAgent(input: {
      chainId: number;
      agentId: string;
      owner: Address;
      agentWallet: Address;
      role: AgentRole;
      listed: ListedStatus;
      agentUri: string;
      registerTx: Hex;
      blockNumber?: string | null;
      createdAt?: number;
    }): AgentRecord {
      return tx(() => upsertAgentRow(input));
    },
    getAgent,
    listAgents(filter?: { role?: AgentRole; listed?: ListedStatus }): AgentRecord[] {
      const clauses: string[] = [];
      const params: string[] = [];
      if (filter?.role) {
        clauses.push("role = ?");
        params.push(filter.role);
      }
      if (filter?.listed) {
        clauses.push("listed = ?");
        params.push(filter.listed);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .query(
          `SELECT * FROM agents ${where} ORDER BY chain_id ASC, CAST(agent_id AS INTEGER) ASC`,
        )
        .all(...params) as Record<string, unknown>[];
      return rows.map(mapAgent);
    },
    getStarterGas,
    sumStarterGasForDay(day: string): bigint {
      const row = db
        .query(
          `SELECT COALESCE(SUM(CAST(amount_wei AS INTEGER)), 0) AS total
           FROM starter_gas_grants WHERE day = ? AND status != 'blocked'`,
        )
        .get(day) as { total: number | null };
      return BigInt(row.total ?? 0);
    },
    reserveStarterGas(input: {
      address: Address;
      amountWei: bigint;
      day: string;
      createdAt?: number;
    }): StarterGasRecord {
      const target = address(input.address, "启动 gas 地址");
      return tx(() => {
        const existing = getStarterGas(target);
        if (existing) return existing;
        const at = input.createdAt ?? now();
        db.run(
          `INSERT INTO starter_gas_grants (address, amount_wei, tx_hash, journal, status, day, error, created_at, updated_at)
           VALUES (?, ?, NULL, NULL, 'reserved', ?, NULL, ?, ?)`,
          [target, input.amountWei.toString(), input.day, at, at],
        );
        return getStarterGas(target)!;
      });
    },
    markStarterGasSigned(address_: Address, journal: Hex, txHash: Hex) {
      const result = db.run(
        `UPDATE starter_gas_grants SET status = 'signed', journal = ?, tx_hash = ?, error = NULL, updated_at = ?
         WHERE address = ? AND status = 'reserved'`,
        [journal, txHash, now(), address(address_)],
      );
      if (result.changes !== 1) {
        throw new ServiceError(409, "这笔启动 gas 还不能签名。");
      }
    },
    markStarterGasBroadcast(address_: Address) {
      const result = db.run(
        `UPDATE starter_gas_grants SET status = 'broadcast', updated_at = ?
         WHERE address = ? AND status IN ('signed', 'broadcast') AND journal IS NOT NULL`,
        [now(), address(address_)],
      );
      if (result.changes !== 1) {
        const current = getStarterGas(address_);
        if (current?.status !== "broadcast") {
          throw new ServiceError(409, "这笔启动 gas 还不能广播。");
        }
      }
    },
    markStarterGasConfirmed(address_: Address) {
      const result = db.run(
        `UPDATE starter_gas_grants SET status = 'confirmed', error = NULL, updated_at = ?
         WHERE address = ? AND status IN ('broadcast', 'confirmed')`,
        [now(), address(address_)],
      );
      if (result.changes !== 1) {
        const current = getStarterGas(address_);
        if (current?.status !== "confirmed") {
          throw new ServiceError(409, "这笔启动 gas 还不能确认。");
        }
      }
    },
    blockStarterGas(address_: Address, error: string) {
      db.run(
        `UPDATE starter_gas_grants SET status = 'blocked', error = ?, updated_at = ?
         WHERE address = ? AND status IN ('reserved', 'signed', 'broadcast', 'blocked')`,
        [error, now(), address(address_)],
      );
    },
    getServicePayment,
    listServicePaymentsByPayer,
    publicServiceStats,
    // Creates the payment row on first sight, or returns the existing one for
    // the same (chain, payer, nonce) authorization so a replay never re-settles.
    upsertServicePayment(input: {
      paymentKey: Hex;
      serviceId: string;
      chainId: number;
      payer: Address;
      payTo: Address;
      asset: Address;
      amount: string;
      nonce: string;
      scheme?: string;
      createdAt?: number;
    }): ServicePaymentRecord {
      const payer = address(input.payer, "付款地址");
      const payTo = address(input.payTo, "收款地址");
      const asset = address(input.asset, "代币");
      return tx(() => {
        const byNonce = db
          .query(
            `SELECT * FROM service_payments WHERE chain_id = ? AND payer = ? AND nonce = ?`,
          )
          .get(input.chainId, payer, input.nonce) as Record<string, unknown> | null;
        if (byNonce) return mapServicePayment(byNonce);
        const at = input.createdAt ?? now();
        db.run(
          `INSERT INTO service_payments (payment_key, service_id, chain_id, payer, pay_to, asset, amount, nonce, scheme, status, charged_amount, consumed, usage_json, upstream_request_id, tx_hash, journal, result_json, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'required', NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
          [
            input.paymentKey,
            input.serviceId,
            input.chainId,
            payer,
            payTo,
            asset,
            input.amount,
            input.nonce,
            input.scheme ?? 'exact',
            at,
            at,
          ],
        );
        return getServicePayment(input.paymentKey)!;
      });
    },
    setServicePaymentStatus(
      paymentKey: string,
      status: ServicePaymentStatus,
      extra?: {
        txHash?: Hex | null;
        journal?: Hex | null;
        error?: string | null;
        consumed?: boolean;
        chargedAmount?: string | null;
        usageJson?: string | null;
        upstreamRequestId?: string | null;
        resultJson?: string | null;
      },
    ) {
      const result = db.run(
        `UPDATE service_payments SET
           status = ?,
           tx_hash = COALESCE(?, tx_hash),
           journal = COALESCE(?, journal),
           error = ?,
           charged_amount = COALESCE(?, charged_amount),
           consumed = COALESCE(?, consumed),
           usage_json = COALESCE(?, usage_json),
           upstream_request_id = COALESCE(?, upstream_request_id),
           result_json = COALESCE(?, result_json),
           updated_at = ?
         WHERE payment_key = ?`,
        [
          status,
          extra?.txHash ?? null,
          extra?.journal ?? null,
          extra?.error ?? null,
          extra?.chargedAmount ?? null,
          extra?.consumed === undefined ? null : extra.consumed ? 1 : 0,
          extra?.usageJson ?? null,
          extra?.upstreamRequestId ?? null,
          extra?.resultJson ?? null,
          now(),
          paymentKey,
        ],
      );
      if (result.changes !== 1) {
        throw new ServiceError(409, "The service payment is in an unexpected state.");
      }
      return getServicePayment(paymentKey)!;
    },
    markServicePaymentDelivered(
      paymentKey: string,
      resultJson: string,
      extra?: { txHash?: Hex | null; chargedAmount?: string | null; consumed?: boolean },
    ) {
      const result = db.run(
        `UPDATE service_payments SET
           status = 'delivered',
           result_json = ?,
           error = NULL,
           tx_hash = COALESCE(?, tx_hash),
           charged_amount = COALESCE(?, charged_amount),
           consumed = ?,
           updated_at = ?
         WHERE payment_key = ?`,
        [
          resultJson,
          extra?.txHash ?? null,
          extra?.chargedAmount ?? null,
          extra?.consumed === false ? 0 : 1,
          now(),
          paymentKey,
        ],
      );
      if (result.changes !== 1) {
        throw new ServiceError(409, "The service payment is in an unexpected state.");
      }
      return getServicePayment(paymentKey)!;
    },
    // Metered LLM spend tracking, in USDT atomic units. `day` is a UTC date.
    llmSpendFor(day: string, payer: Address): bigint {
      const row = db
        .query(`SELECT charged FROM llm_daily_spend WHERE day = ? AND payer = ?`)
        .get(day, address(payer, "付款地址")) as { charged: string } | null;
      return row ? BigInt(row.charged) : 0n;
    },
    llmSpendTotal(day: string): bigint {
      const row = db
        .query(`SELECT COALESCE(SUM(CAST(charged AS INTEGER)), 0) AS total FROM llm_daily_spend WHERE day = ?`)
        .get(day) as { total: number | string } | null;
      return row ? BigInt(row.total) : 0n;
    },
    addLlmSpend(day: string, payer: Address, amount: bigint): void {
      if (amount <= 0n) return;
      const owner = address(payer, "付款地址");
      tx(() => {
        const row = db
          .query(`SELECT charged FROM llm_daily_spend WHERE day = ? AND payer = ?`)
          .get(day, owner) as { charged: string } | null;
        const next = (row ? BigInt(row.charged) : 0n) + amount;
        db.run(
          `INSERT INTO llm_daily_spend (day, payer, charged) VALUES (?, ?, ?)
           ON CONFLICT(day, payer) DO UPDATE SET charged = excluded.charged`,
          [day, owner, next.toString()],
        );
      });
    },
    seedState(): { seeded: boolean; agents: number; drafts: number } {
      const seeded =
        db.query(`SELECT 1 AS x FROM seed_state WHERE id = 1`).get() != null;
      const agents = db.query(`SELECT COUNT(*) AS n FROM agents`).get() as {
        n: number;
      };
      const drafts = db.query(`SELECT COUNT(*) AS n FROM agent_drafts`).get() as {
        n: number;
      };
      return {
        seeded,
        agents: Number(agents.n),
        drafts: Number(drafts.n),
      };
    },
    // One-shot import of an existing ledger into a fresh database. Every row
    // lands inside a single transaction together with the seed_done marker, so a
    // failure leaves the database untouched and a success can never be replayed.
    importSeed(input: {
      agents: SeedAgentInput[];
      drafts: SeedDraftInput[];
    }): { agents: number; drafts: number } {
      return tx(() => {
        for (const agent of input.agents) upsertAgentRow(agent);
        for (const draft of input.drafts) {
          insertAgentDraft(draft);
          if (draft.registeredAgentId) {
            setDraftRegisteredRow(draft.draftId, draft.registeredAgentId);
          }
        }
        db.run(`INSERT INTO seed_state (id, done_at) VALUES (1, ?)`, [now()]);
        return { agents: input.agents.length, drafts: input.drafts.length };
      });
    },
  };
}
