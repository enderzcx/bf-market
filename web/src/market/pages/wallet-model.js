export function isWalletAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value ?? '').trim());
}

export function sameWalletAddress(left, right) {
  return (
    isWalletAddress(left) &&
    isWalletAddress(right) &&
    String(left).trim().toLowerCase() === String(right).trim().toLowerCase()
  );
}

export function walletBudgetAccessKey(wallet, account) {
  if (!account) return 'walletConnectToManage';
  return sameWalletAddress(wallet, account)
    ? 'walletOwnerControlsBelow'
    : 'walletOtherAccountControlsBelow';
}

// Mirrors the backend challenge key so independent controls that target the
// same scope/signer/wallet can be mutually disabled while one signature is in
// flight.
export function budgetChallengeKey({ mode, wallet, signer }) {
  const scope = mode === 'ceiling' ? 'ceiling' : 'wallet';
  return `wallet-budget:${scope}:${String(signer ?? '').toLowerCase()}:${String(wallet ?? '').toLowerCase()}`;
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

const USDT_DECIMALS = 6;

function formatNullableUsdt(amount) {
  return amount == null || amount === '' ? null : formatAtomicUsdt(amount);
}

// Exact decimal USDT -> atomic units. Accepts "0.05", "5", ".5"; rejects
// negatives, non-numeric text and values with more than six decimal places.
// Returns null when the input cannot be represented exactly.
export function parseUsdtToAtomic(value, decimals = USDT_DECIMALS) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  try {
    const scaled = BigInt(whole || '0') * 10n ** BigInt(decimals);
    return (scaled + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
  } catch {
    return null;
  }
}

// Validate a typed USDT amount before a challenge or signature is requested.
// `maxAtomic` is the platform budget max; `ceilingAtomic` is the owner ceiling
// that a payment wallet's own value must not exceed.
export function validateBudgetAmount(value, { maxAtomic = null, ceilingAtomic = null } = {}) {
  const atomic = parseUsdtToAtomic(value);
  if (atomic === null) {
    return { atomic: null, errorKey: 'walletInvalidBudget', limit: null };
  }
  if (maxAtomic != null && BigInt(atomic) > BigInt(maxAtomic)) {
    return {
      atomic,
      errorKey: 'walletBudgetAboveMax',
      limit: formatAtomicUsdt(maxAtomic),
    };
  }
  if (ceilingAtomic != null && BigInt(atomic) > BigInt(ceilingAtomic)) {
    return {
      atomic,
      errorKey: 'walletOwnAboveCeiling',
      limit: formatAtomicUsdt(ceilingAtomic),
    };
  }
  return { atomic, errorKey: null, limit: null };
}

// UI controls use `own` for the wallet's personal value, while the API's
// corresponding budget scope is named `wallet`.
export function buildBudgetIntent({ mode, wallet, signer, agentId = null, dailyLimit }) {
  return {
    scope: mode === 'ceiling' ? 'ceiling' : 'wallet',
    wallet,
    signer,
    ...(agentId != null ? { agentId } : {}),
    dailyLimit,
  };
}

// Build the connected console view from GET /api/owners/:address/agents plus the
// connected wallet's summary.
//
// Control placement (architecture §5.5, VAL-WALLET-018):
// - Exactly one agent shares the connected address (the usual #0 case): that
//   agent keeps a single combined control in the wallet card, written as a
//   ceiling, so exactly one control owns the address.
// - No agent shares the address: the wallet card shows the wallet's own value.
// - Several agents share the address: every such agent keeps its own ceiling
//   control, and the wallet card switches to the own-value control so the
//   wallet's own value stays manageable. Its inline limit is the smallest
//   ceiling that applies to that wallet.
export function buildOwnerConsoleModel({ ownerData, summary = null, account } = {}) {
  const normalized = String(account ?? '').toLowerCase();
  const rawAgents = Array.isArray(ownerData?.agents) ? ownerData.agents : [];

  const rawWalletOf = (agent) =>
    typeof agent.agentWallet === 'string' && agent.agentWallet !== '' ? agent.agentWallet : null;
  const isSameAddress = (agent) => {
    const wallet = rawWalletOf(agent);
    return wallet != null && wallet.toLowerCase() === normalized;
  };
  const sameAddressCount = rawAgents.filter(isSameAddress).length;
  const multipleSameAddress = sameAddressCount > 1;

  const agents = rawAgents.map((agent) => {
    const wallet = rawWalletOf(agent);
    const sameAddress = wallet != null && wallet.toLowerCase() === normalized;
    return {
      agentId: String(agent.agentId),
      role: agent.role ?? null,
      agentWallet: wallet,
      agentWalletShort: wallet == null ? '—' : shortHash(wallet),
      spentToday: formatNullableUsdt(agent.spentToday),
      pendingToday: formatNullableUsdt(agent.pendingToday),
      ceiling: formatNullableUsdt(agent.ceiling),
      own: formatNullableUsdt(agent.own),
      effective: formatNullableUsdt(agent.effective),
      sameAddress,
      showRowControl: multipleSameAddress ? wallet != null : !sameAddress && wallet != null,
      viewAddress: wallet,
    };
  });

  const sameAddressAgents = agents.filter((agent) => agent.sameAddress);
  const singleSameAddressAgent = sameAddressAgents.length === 1 ? sameAddressAgents[0] : null;
  const own = summary?.userBudget?.own ?? null;
  const ceiling = summary?.userBudget?.ceiling ?? null;
  const budget = summary?.userBudget
    ? {
        effective: formatAtomicUsdt(summary.userBudget.effective),
        source: summary.userBudget.source,
        own: own ? formatAtomicUsdt(own.dailyLimit) : null,
        ceiling: ceiling ? formatAtomicUsdt(ceiling.dailyLimit) : null,
        ownIsCapped: own?.cappedByCeiling === true,
      }
    : null;

  // The wallet's own value is capped by every ceiling on that wallet, so the
  // inline limit is the smallest of the agent ceilings and the summary ceiling.
  const ceilingCandidates = [
    ceiling?.dailyLimit,
    ...rawAgents.filter(isSameAddress).map((agent) => agent.ceiling),
  ]
    .filter((value) => value != null && value !== '' && /^\d+$/.test(String(value)))
    .map((value) => BigInt(value));
  const minCeilingAtomic = ceilingCandidates.length
    ? ceilingCandidates.reduce((min, value) => (value < min ? value : min)).toString()
    : null;

  return {
    account: account ?? null,
    agents,
    transferredAway: (Array.isArray(ownerData?.transferredAway) ? ownerData.transferredAway : []).map(
      (entry) => ({
        agentId: String(entry.agentId),
        ceiling: formatNullableUsdt(entry.ceiling),
      }),
    ),
    wallet: {
      account: account ?? null,
      spentToday: formatAtomicUsdt(summary?.spent?.all?.charged),
      pendingToday: formatAtomicUsdt(summary?.spent?.all?.pending),
      budget,
      maxAtomic: summary?.platform?.budgetMax ?? null,
      control: {
        show: true,
        mode: singleSameAddressAgent ? 'ceiling' : 'own',
        agentId: singleSameAddressAgent ? singleSameAddressAgent.agentId : null,
        ceilingAtomic: singleSameAddressAgent ? null : minCeilingAtomic,
      },
    },
  };
}
