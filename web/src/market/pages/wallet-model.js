export function isWalletAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value ?? '').trim());
}

export function formatAtomicUsdt(amount) {
  try {
    const value = BigInt(amount);
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    return `${negative ? '-' : ''}${absolute / 1_000_000n}.${(absolute % 1_000_000n)
      .toString()
      .padStart(6, '0')}`;
  } catch {
    return null;
  }
}

function atomic(value) {
  try {
    return BigInt(value ?? '0');
  } catch {
    return 0n;
  }
}

function addAmounts(left, right) {
  return (atomic(left) + atomic(right)).toString();
}

export function buildWalletViewModel(summary, services = []) {
  const own = summary.userBudget?.own ?? null;
  const ceiling = summary.userBudget?.ceiling ?? null;
  const budget = summary.userBudget
    ? {
        effective: formatAtomicUsdt(summary.userBudget.effective),
        source: summary.userBudget.source,
        own: own ? formatAtomicUsdt(own.dailyLimit) : null,
        ceiling: ceiling ? formatAtomicUsdt(ceiling.dailyLimit) : null,
        agentId: ceiling?.agentId ?? null,
        ownIsCapped: own?.cappedByCeiling === true,
      }
    : null;
  const llmUsedAtomic = addAmounts(summary.spent?.llm?.charged, summary.spent?.llm?.pending);
  const remainingUser = summary.remaining?.userBudget;
  const remainingLlm = summary.remaining?.llm;
  const publicServices = services.map((service) => {
    const quote = service.pricing === 'exact' ? service.price : service.quoteMax;
    const validQuote = quote != null && /^\d+$/.test(String(quote));
    const remainingForCall =
      service.pricing === 'metered'
        ? remainingLlm
        : summary.userBudget != null
          ? remainingUser
          : null;
    const canCallToday =
      validQuote &&
      (remainingForCall == null || atomic(quote) <= atomic(remainingForCall));
    return {
      ...service,
      quote: validQuote ? formatAtomicUsdt(quote) : null,
      canCallToday,
    };
  });

  return {
    todayCharged: formatAtomicUsdt(summary.spent?.all?.charged),
    todayPending: formatAtomicUsdt(summary.spent?.all?.pending),
    budget,
    llmUsed: formatAtomicUsdt(llmUsedAtomic),
    llmCap: formatAtomicUsdt(summary.platform?.llmWalletDailyCap),
    llmGlobalCap: formatAtomicUsdt(summary.platform?.llmGlobalDailyCap),
    llmGlobalRemaining: formatAtomicUsdt(summary.platform?.llmGlobalRemaining),
    llmRemaining: formatAtomicUsdt(remainingLlm),
    services: publicServices,
  };
}

export function shortHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('0x') || hash.length < 14) {
    return hash || '—';
  }
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}
