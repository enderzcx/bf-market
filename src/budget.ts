import { parseAddress, issueChallenge, recoverBoundAddress } from './auth.ts';
import type { AgentRegistryChain } from './agent-registry.ts';
import { DEFAULT_SETTLEMENT_BUDGET_MAX_ATOMIC, ZERO_ADDRESS } from './config.ts';
import type { RuntimeConfig } from './config.ts';
import type { Store } from './store.ts';
import { ServiceError, type Address, type BudgetEventVia } from './types.ts';

// Shared budget arithmetic (architecture §1.2). The enforcement path, the read
// APIs and the tests all go through these helpers so "today" and the effective
// daily limit are computed identically everywhere.

export type BudgetSource = 'ceiling' | 'own' | 'ceiling+own';

export type EffectiveBudget = { limit: bigint; source: BudgetSource };

// UTC day key (`YYYY-MM-DD`), fixed when a payment is held. `at` is epoch
// milliseconds.
export function utcDay(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

// Upper bound for every user-set daily budget; `0` pauses paid calls.
export function budgetMax(config: { settlementBudgetMaxAtomic?: bigint } = {}): bigint {
  return config.settlementBudgetMaxAtomic ?? DEFAULT_SETTLEMENT_BUDGET_MAX_ATOMIC;
}

// Effective user budget of one payment wallet: the smallest of every ceiling
// that names the wallet and the wallet's own value. `null` means nothing is set,
// so no user budget applies (echo is then unlimited, LLM keeps only the platform
// caps).
export function effectiveBudget(input: {
  ceilings: readonly bigint[];
  own: bigint | null;
}): EffectiveBudget | null {
  const ceilings = input.ceilings;
  const own = input.own;
  if (ceilings.length === 0 && own === null) return null;
  const ceiling = ceilings.length ? ceilings.reduce((min, value) => (value < min ? value : min)) : null;
  if (ceiling === null) return { limit: own as bigint, source: 'own' };
  if (own === null) return { limit: ceiling, source: 'ceiling' };
  if (own < ceiling) return { limit: own, source: 'own' };
  if (ceiling < own) return { limit: ceiling, source: 'ceiling' };
  return { limit: ceiling, source: 'ceiling+own' };
}

// ---- Signed budget writes (architecture §3) -------------------------------

export const BUDGET_CHALLENGE_PURPOSE = 'wallet-budget';

const BUDGET_SCOPES = ['ceiling', 'wallet'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

// `0.05 USDT` / `5 USDT` in the challenge message and the two range errors. No
// trailing zeros, so the text of a full max reads "5", not "5.00".
export function formatUsdt(atomic: bigint): string {
  const base = 1_000_000n;
  const whole = atomic / base;
  const frac = (atomic % base).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export type BudgetIntentJson = {
  scope: BudgetScope;
  wallet: string;
  agentId: string | null;
  dailyLimit: string | null;
};

// One challenge per (scope, signer, wallet): reissuing overwrites the previous
// challenge for the same key, so only the newest signature can be submitted.
export function budgetChallengeKey(scope: BudgetScope, signer: string, wallet: string): string {
  return `${BUDGET_CHALLENGE_PURPOSE}:${scope}:${signer.toLowerCase()}:${wallet.toLowerCase()}`;
}

export type BudgetService = ReturnType<typeof createBudgetService>;

// The signed budget write shared by the HTTP route and the MCP tool. Both pass
// the same body shape, get the same error texts and see the same wallet summary
// back, so the two surfaces cannot drift. Chain reads happen here and only here:
// the paid path still reads nothing but the database.
export function createBudgetService(opts: {
  store: Store;
  config: RuntimeConfig;
  registry?: AgentRegistryChain | null;
  now?: () => number;
  // The wallet summary after a successful write (architecture §4.1). Injected so
  // this module does not depend on the read API layer.
  summary: (wallet: Address) => Record<string, unknown>;
}) {
  const store = opts.store;
  const config = opts.config;
  const now = opts.now ?? store.now ?? Date.now;
  const chainId = config.chain.chainId;

  const parseScope = (value: unknown): BudgetScope => {
    if (typeof value !== 'string' || !(BUDGET_SCOPES as readonly string[]).includes(value)) {
      throw new ServiceError(400, 'Invalid scope.');
    }
    return value as BudgetScope;
  };

  const parseAgentId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
      throw new ServiceError(400, 'Invalid agent id.');
    }
    return value;
  };

  const parseDailyLimit = (value: unknown): bigint | null => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
      throw new ServiceError(400, 'Invalid daily budget.');
    }
    const limit = BigInt(value);
    const max = budgetMax(config);
    if (limit > max) {
      throw new ServiceError(400, `The daily budget cannot exceed ${formatUsdt(max)} USDT.`);
    }
    return limit;
  };

  const parseIntent = (json: string | null): BudgetIntentJson | null => {
    if (!json) return null;
    try {
      const parsed = JSON.parse(json) as Partial<BudgetIntentJson>;
      if (typeof parsed?.scope !== 'string' || typeof parsed?.wallet !== 'string') return null;
      const dailyLimit =
        parsed.dailyLimit === null || parsed.dailyLimit === undefined
          ? null
          : String(parsed.dailyLimit);
      if (dailyLimit !== null && !/^[0-9]+$/.test(dailyLimit)) return null;
      return {
        scope: parsed.scope as BudgetScope,
        wallet: parsed.wallet.toLowerCase(),
        agentId: parsed.agentId == null ? null : String(parsed.agentId),
        dailyLimit,
      };
    } catch {
      return null;
    }
  };

  const requireRegistry = (): AgentRegistryChain => {
    if (!opts.registry) {
      throw new ServiceError(
        503,
        'No identity registry is configured on this network, so ownership cannot be verified.',
      );
    }
    return opts.registry;
  };

  // Issue a challenge. Format and range only: issuing never reads the chain, so
  // a caller can prepare a signature before the platform is reachable.
  const issue = (
    body: Record<string, unknown>,
    domain: string,
  ): { message: string; expiresAt: number } => {
    const scope = parseScope(body.scope);
    const wallet = parseAddress(body.wallet);
    const signer = parseAddress(body.signer);
    const agentId = scope === 'ceiling' ? parseAgentId(body.agentId) : null;
    const dailyLimit = parseDailyLimit(body.dailyLimit);
    const issued = issueChallenge({
      domain,
      userId: 'agent',
      address: signer,
      chainId: config.chain.chainId,
      now: now(),
      purpose: BUDGET_CHALLENGE_PURPOSE,
      extraLines: [
        `Scope: ${scope === 'ceiling' ? `owner ceiling for agent #${agentId}` : "wallet's own budget"}`,
        `Wallet: ${wallet}`,
        `Daily budget: ${
          dailyLimit === null ? 'removed' : `${formatUsdt(dailyLimit)} USDT (${dailyLimit})`
        }`,
      ],
    });
    const intent: BudgetIntentJson = {
      scope,
      wallet: wallet.toLowerCase(),
      agentId,
      dailyLimit: dailyLimit === null ? null : dailyLimit.toString(),
    };
    store.putChallenge({
      sessionId: budgetChallengeKey(scope, signer, wallet),
      address: signer,
      nonce: issued.nonce,
      message: issued.message,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt,
      intentJson: JSON.stringify(intent),
    });
    return { message: issued.message, expiresAt: issued.expiresAt };
  };

  const submit = async (
    body: Record<string, unknown>,
    via: BudgetEventVia,
  ): Promise<Record<string, unknown>> => {
    const scope = parseScope(body.scope);
    const wallet = parseAddress(body.wallet);
    const signer = parseAddress(body.signer);
    const agentId = scope === 'ceiling' ? parseAgentId(body.agentId) : null;
    const dailyLimit = parseDailyLimit(body.dailyLimit);

    // 1. challenge state, 2. signed intent, 3. signer, 4. permission.
    const key = budgetChallengeKey(scope, signer, wallet);
    const challenge = store.getChallenge(key);
    if (!challenge) throw new ServiceError(400, 'Request a challenge first.');
    if (challenge.consumed) {
      throw new ServiceError(409, 'This challenge was already used. Request a new one.');
    }
    if (now() > challenge.expiresAt) {
      throw new ServiceError(400, 'This challenge has expired. Request a new one.');
    }
    const intent = parseIntent(challenge.intentJson);
    const sameLimit =
      intent?.dailyLimit === null
        ? dailyLimit === null
        : dailyLimit !== null && intent !== null && BigInt(intent.dailyLimit!) === dailyLimit;
    if (
      !intent ||
      intent.scope !== scope ||
      intent.wallet !== wallet.toLowerCase() ||
      intent.agentId !== agentId ||
      !sameLimit
    ) {
      throw new ServiceError(400, 'The request does not match the signed challenge.');
    }
    const recovered = await recoverBoundAddress(challenge.message, body.signature);
    if (recovered.toLowerCase() !== signer.toLowerCase()) {
      throw new ServiceError(400, 'Invalid signature.');
    }

    const at = now();
    if (scope === 'ceiling') {
      const registry = requireRegistry();
      let owner: Address;
      let chainWalletRaw: Address;
      try {
        [owner, chainWalletRaw] = await Promise.all([
          registry.readOwnerOf(BigInt(agentId!)),
          registry.readAgentWallet(BigInt(agentId!)),
        ]);
      } catch {
        throw new ServiceError(503, 'Could not read the identity registry. Try again.');
      }
      if (owner.toLowerCase() !== signer.toLowerCase()) {
        throw new ServiceError(403, 'The signer is not allowed to set this budget.');
      }
      const chainWallet =
        chainWalletRaw.toLowerCase() === ZERO_ADDRESS ? '' : (chainWalletRaw as Address);
      if (chainWallet === '') throw new ServiceError(409, 'This agent has no payment wallet.');
      if (chainWallet.toLowerCase() !== wallet.toLowerCase()) {
        throw new ServiceError(
          409,
          "The agent's payment wallet does not match. Refresh the agent and try again.",
        );
      }
      if (dailyLimit === null) {
        store.removeCeiling({ chainId, agentId: agentId!, signer, via, at, challengeKey: key });
      } else {
        store.setCeiling({
          chainId,
          agentId: agentId!,
          wallet: chainWallet,
          dailyLimit,
          signer,
          via,
          at,
          challengeKey: key,
        });
      }
      // Mirror the verified owner and wallet back; the ceiling follows the
      // agent's wallet (architecture §3.3).
      store.refreshAgentChainState(chainId, agentId!, owner, chainWallet, at);
    } else {
      if (signer.toLowerCase() !== wallet.toLowerCase()) {
        throw new ServiceError(403, 'The signer is not allowed to set this budget.');
      }
      if (dailyLimit === null) {
        store.removeOwnBudget({ wallet, signer, via, at, challengeKey: key });
      } else {
        // The wallet's own value must fit under every ceiling on that wallet.
        // Enforced with the same rows the paid path reads.
        const ceilings = store.listCeilingsForWallet(wallet);
        if (ceilings.length) {
          const ceiling = ceilings.reduce<bigint>(
            (min, row) => (row.dailyLimit < min ? row.dailyLimit : min),
            ceilings[0]!.dailyLimit,
          );
          if (dailyLimit > ceiling) {
            throw new ServiceError(
              400,
              `The daily budget exceeds the owner's limit of ${formatUsdt(ceiling)} USDT.`,
            );
          }
        }
        store.setOwnBudget({ wallet, dailyLimit, signer, via, at, challengeKey: key });
      }
    }
    return opts.summary(wallet);
  };

  return { issueChallenge: issue, submit, summary: opts.summary };
}
