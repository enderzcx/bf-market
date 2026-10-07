import { getAddress } from 'viem';
import type { AgentRegistryChain } from './agent-registry.ts';
import { budgetMax, effectiveBudget, utcDay } from './budget.ts';
import type { RuntimeConfig } from './config.ts';
import { meteredUpperBound } from './llm.ts';
import type { ServiceCatalog } from './services.ts';
import type { Store } from './store.ts';
import type { Address, AgentRecord, CeilingRecord, ServicePaymentRecord } from './types.ts';
import { ServiceError } from './types.ts';

// Public read surface (architecture §4). Four endpoints, no auth, no writes to
// the chain except the owner-console refresh, which only mirrors chain truth
// into the database. Every limit printed here is computed with the same helpers
// the paid path uses, so a quote and the summary can never disagree.

// A stale agent is re-checked at most this often; the owner list skips agents
// whose last refresh is younger, and the refresh endpoint is throttled by it.
const OWNER_LIST_STALE_MS = 60_000;
const AGENT_REFRESH_THROTTLE_MS = 30_000;
// Bound on on-chain re-checks per owner request (architecture N9).
const OWNER_LIST_MAX_CHECKS = 20;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type WalletSummary = Record<string, unknown>;
export type OwnerAgents = Record<string, unknown>;
export type Providers = { providers: Record<string, unknown>[] };

export function createReadApis(opts: {
  store: Store;
  config: RuntimeConfig;
  catalog: ServiceCatalog;
  registry: AgentRegistryChain | null;
  now?: () => number;
  // Projections owned by the HTTP layer so the summary shows exactly the same
  // agent and receipt JSON as the existing endpoints.
  publicAgent: (record: AgentRecord) => Record<string, unknown>;
  publicReceipt: (record: ServicePaymentRecord) => Record<string, unknown>;
}) {
  const store = opts.store;
  const config = opts.config;
  const now = opts.now ?? store.now ?? Date.now;
  const chainId = config.chain.chainId;

  const dayInfo = (at: number): { day: string; resetsAt: number } => {
    const day = utcDay(at);
    return { day, resetsAt: Date.parse(`${day}T00:00:00Z`) + 86_400_000 };
  };

  const minCeiling = (ceilings: readonly CeilingRecord[]): CeilingRecord | null => {
    let min: CeilingRecord | null = null;
    for (const ceiling of ceilings) {
      if (min === null || ceiling.dailyLimit < min.dailyLimit) min = ceiling;
    }
    return min;
  };

  const remaining = (limit: bigint, used: bigint): bigint =>
    limit > used ? limit - used : 0n;

  // ---- GET /api/wallets/:address/summary (architecture §4.1) ----------------

  const walletSummary = (wallet: Address, limit: number): WalletSummary => {
    const at = now();
    const { day, resetsAt } = dayInfo(at);
    const ceilings = store.listCeilingsForWallet(wallet);
    const ownRecord = store.getWalletBudget(wallet);
    const effective = effectiveBudget({
      ceilings: ceilings.map((ceiling) => ceiling.dailyLimit),
      own: ownRecord?.dailyLimit ?? null,
    });
    const totals = store.spendFor(wallet, day);
    const ceiling = minCeiling(ceilings);
    const llmUsed = totals.llmCharged + totals.llmHeld;
    const llmGlobalRemaining = remaining(config.llmGlobalDailyCapAtomic, store.uptoSpendForDay(day));
    const userRemaining = effective
      ? remaining(effective.limit, totals.charged + totals.held)
      : null;
    let llmRemaining = remaining(config.llmPayerDailyCapAtomic, llmUsed);
    if (llmRemaining > llmGlobalRemaining) llmRemaining = llmGlobalRemaining;
    if (userRemaining !== null && llmRemaining > userRemaining) llmRemaining = userRemaining;

    return {
      wallet,
      network: config.network.caip2,
      asset: {
        address: config.network.asset.address,
        symbol: config.network.asset.symbol,
        decimals: config.network.asset.decimals,
      },
      day,
      resetsAt,
      userBudget: effective
        ? {
            effective: effective.limit.toString(),
            source: effective.source,
            ceiling: ceiling
              ? {
                  dailyLimit: ceiling.dailyLimit.toString(),
                  agentId: ceiling.agentId,
                  setBy: ceiling.setBy,
                  updatedAt: ceiling.updatedAt,
                }
              : null,
            own: ownRecord
              ? {
                  dailyLimit: ownRecord.dailyLimit.toString(),
                  updatedAt: ownRecord.updatedAt,
                  // The wallet's own value keeps its stored value even when the
                  // owner's ceiling is lower; the console marks that state.
                  cappedByCeiling: ceiling ? ownRecord.dailyLimit > ceiling.dailyLimit : false,
                }
              : null,
          }
        : null,
      platform: {
        llmWalletDailyCap: config.llmPayerDailyCapAtomic.toString(),
        llmGlobalDailyCap: config.llmGlobalDailyCapAtomic.toString(),
        llmGlobalRemaining: llmGlobalRemaining.toString(),
        budgetMax: budgetMax(config).toString(),
      },
      spent: {
        all: { charged: totals.charged.toString(), pending: totals.held.toString() },
        llm: { charged: totals.llmCharged.toString(), pending: totals.llmHeld.toString() },
      },
      remaining: {
        userBudget: userRemaining === null ? null : userRemaining.toString(),
        llm: llmRemaining.toString(),
      },
      // A hint only: the database association may be behind the chain.
      agents: store.listAgentsByWallet(wallet).map((agent) => ({
        agentId: agent.agentId,
        owner: agent.owner,
        verifiedAt: agent.refreshedAt ?? agent.createdAt,
      })),
      recentReceipts: store.listServicePaymentsByPayer(wallet, limit).map((record) =>
        opts.publicReceipt(record),
      ),
    };
  };

  // ---- Chain refresh (architecture §3.4 step 2) -----------------------------

  const requireRegistry = (): AgentRegistryChain => {
    if (!opts.registry) {
      throw new ServiceError(
        503,
        'No identity registry is configured on this network, so ownership cannot be verified.',
      );
    }
    return opts.registry;
  };

  const chainWallet = (wallet: Address): Address | '' => {
    const value = getAddress(wallet);
    return value.toLowerCase() === ZERO_ADDRESS ? '' : value;
  };

  // Reads ownerOf and getAgentWallet for one agent and mirrors them into the DB.
  // Returns the refreshed row, never a synthesized one.
  const refreshFromChain = async (agentId: string): Promise<AgentRecord | null> => {
    const registry = requireRegistry();
    const at = now();
    let owner: Address;
    let wallet: Address;
    try {
      [owner, wallet] = await Promise.all([
        registry.readOwnerOf(BigInt(agentId)),
        registry.readAgentWallet(BigInt(agentId)),
      ]);
    } catch {
      throw new ServiceError(503, 'Could not read the identity registry. Try again.');
    }
    store.syncAgentChainState(chainId, agentId, getAddress(owner), chainWallet(wallet), at);
    return store.getAgent(chainId, agentId);
  };

  // ---- POST /api/agents/:agentId/refresh -----------------------------------

  const refreshAgent = async (agentId: string): Promise<{ agent: Record<string, unknown> }> => {
    const record = store.getAgent(chainId, agentId);
    if (!record) throw new ServiceError(404, 'Agent not found.');
    const at = now();
    // The throttle is per agent and persisted on the row, so two callers within
    // 30 s cannot drive two RPC reads.
    if (record.refreshedAt !== null && at - record.refreshedAt < AGENT_REFRESH_THROTTLE_MS) {
      return { agent: { ...opts.publicAgent(record), refreshedAt: record.refreshedAt } };
    }
    const refreshed = (await refreshFromChain(agentId)) ?? record;
    return { agent: { ...opts.publicAgent(refreshed), refreshedAt: refreshed.refreshedAt } };
  };

  // ---- GET /api/owners/:address/agents (architecture §3.4) ------------------

  const ownerAgents = async (owner: Address): Promise<OwnerAgents> => {
    const at = now();
    const { day } = dayInfo(at);
    // Candidates: the agents the DB already associates with this owner, plus
    // the agents this address wrote a ceiling for, so a former owner can still
    // see and clear that ceiling after the agent moved away.
    const candidates = new Map<string, AgentRecord>();
    for (const agent of store.listAgentsByOwner(owner)) candidates.set(agent.agentId, agent);
    for (const ceiling of store.listCeilingsBySetter(owner)) {
      if (candidates.has(ceiling.agentId)) continue;
      const agent = store.getAgent(chainId, ceiling.agentId);
      if (agent) candidates.set(agent.agentId, agent);
    }
    const ordered = [...candidates.values()].sort(
      (a, b) => Number(a.agentId) - Number(b.agentId),
    );
    // Only the first 20 stale candidates are re-checked on chain per request.
    const stale = ordered
      .filter((agent) => agent.refreshedAt === null || at - agent.refreshedAt > OWNER_LIST_STALE_MS)
      .slice(0, OWNER_LIST_MAX_CHECKS);

    // Read everything before writing anything, so a failing RPC leaves the
    // database untouched instead of half-refreshed.
    const registry = opts.registry;
    const verified = new Map<string, { owner: Address; wallet: Address | '' }>();
    const attempted = new Set<string>();
    if (registry && stale.length) {
      for (const agent of stale) attempted.add(agent.agentId);
      const reads = await Promise.all(
        stale.map(async (agent) => {
          try {
            const [chainOwner, wallet] = await Promise.all([
              registry.readOwnerOf(BigInt(agent.agentId)),
              registry.readAgentWallet(BigInt(agent.agentId)),
            ]);
            return { agentId: agent.agentId, owner: getAddress(chainOwner), wallet: chainWallet(wallet) };
          } catch {
            // A failed read (RPC outage, or an agent that is not minted on this
            // chain) is not proof of ownership: leave the row alone and keep the
            // agent out of the owned list.
            return null;
          }
        }),
      );
      for (const read of reads) {
        if (!read) continue;
        store.syncAgentChainState(chainId, read.agentId, read.owner, read.wallet, at);
        verified.set(read.agentId, { owner: read.owner, wallet: read.wallet });
      }
    }

    const wanted = owner.toLowerCase();
    const agents: Record<string, unknown>[] = [];
    const transferredAway: Record<string, unknown>[] = [];
    for (const candidate of ordered) {
      const row = store.getAgent(chainId, candidate.agentId) ?? candidate;
      const ceiling = store.getCeiling(chainId, candidate.agentId);
      const check = verified.get(candidate.agentId);
      // A freshly checked agent answers from the chain; an agent whose chain
      // read failed counts as not owned; a row that was not stale is taken at
      // its stored word.
      const ownedByThisAddress = check
        ? check.owner.toLowerCase() === wanted
        : attempted.has(candidate.agentId)
          ? false
          : row.owner.toLowerCase() === wanted;
      if (!ownedByThisAddress) {
        transferredAway.push({
          agentId: row.agentId,
          ceiling: ceiling ? ceiling.dailyLimit.toString() : null,
        });
        continue;
      }
      // A row whose agent has no payment wallet is stored as '' (the zero
      // address detaches the ceiling).
      const rawWallet: string = row.agentWallet;
      const wallet =
        rawWallet === '' || rawWallet.toLowerCase() === ZERO_ADDRESS
          ? null
          : getAddress(rawWallet);
      const ownRecord = wallet ? store.getWalletBudget(wallet) : null;
      const limits = ceiling ? [ceiling.dailyLimit] : [];
      const effective = effectiveBudget({
        ceilings: limits,
        own: ownRecord?.dailyLimit ?? null,
      });
      const totals = wallet ? store.spendFor(wallet, day) : { charged: 0n, held: 0n };
      agents.push({
        agentId: row.agentId,
        role: row.role,
        agentWallet: row.agentWallet,
        refreshedAt: row.refreshedAt ?? row.createdAt,
        ceiling: ceiling ? ceiling.dailyLimit.toString() : null,
        own: ownRecord ? ownRecord.dailyLimit.toString() : null,
        effective: effective ? effective.limit.toString() : null,
        spentToday: totals.charged.toString(),
        pendingToday: totals.held.toString(),
      });
    }
    return { owner, agents, transferredAway };
  };

  // ---- GET /api/providers (architecture §4.3) -------------------------------

  const providers = (): Providers => {
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const { definition } of opts.catalog.available()) {
      const list = grouped.get(definition.providerAgentId) ?? [];
      list.push(
        definition.pricing.mode === 'metered'
          ? {
              serviceId: definition.serviceId,
              pricing: 'metered',
              modelId: definition.pricing.pricing.modelId,
              quoteMax: meteredUpperBound(definition.pricing.pricing).toString(),
              description: definition.description,
            }
          : {
              serviceId: definition.serviceId,
              pricing: 'exact',
              price: definition.price.toString(),
              description: definition.description,
            },
      );
      grouped.set(definition.providerAgentId, list);
    }
    const providers = [...grouped.entries()]
      .map(([agentId, services]) => ({ agentId, services }))
      .sort((a, b) => Number(a.agentId) - Number(b.agentId))
      .flatMap(({ agentId, services }) => {
        const agent = store.getAgent(chainId, agentId);
        if (!agent) return [];
        // Only the three public profile fields are exposed; the draft itself
        // never leaves the server.
        const profile = store.getAgentDraftByAgentId(agentId)?.profile;
        return [
          {
            agentId,
            name: profile?.name ?? `Agent ${agentId}`,
            description: profile?.description ?? null,
            image: profile?.image ?? null,
            agentWallet: agent.agentWallet,
            listed: agent.listed,
            services,
          },
        ];
      });
    return { providers };
  };

  return { walletSummary, ownerAgents, refreshAgent, providers };
}

export type ReadApis = ReturnType<typeof createReadApis>;
