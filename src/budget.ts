import { DEFAULT_SETTLEMENT_BUDGET_MAX_ATOMIC } from './config.ts';

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
