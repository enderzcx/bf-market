import { describe, expect, it } from 'bun:test';
import {
  budgetChallengeKey,
  buildBudgetIntent,
  buildOwnerConsoleModel,
  buildWalletViewModel,
  formatAtomicUsdt,
  isWalletAddress,
  parseUsdtToAtomic,
  shortHash,
  sameWalletAddress,
  validateBudgetAmount,
  walletBudgetAccessKey,
} from './wallet-model.js';

describe('wallet view model', () => {
  it('validates trimmed EVM addresses without accepting malformed values', () => {
    expect(isWalletAddress('  0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada  ')).toBe(true);
    expect(isWalletAddress('0x123')).toBe(false);
    expect(isWalletAddress('hello')).toBe(false);
    expect(isWalletAddress(`0x${'a'.repeat(41)}`)).toBe(false);
  });

  it('formats atomic USDT exactly to six decimal places', () => {
    expect(formatAtomicUsdt('50000')).toBe('0.050000');
    expect(formatAtomicUsdt('3013675')).toBe('3.013675');
    expect(formatAtomicUsdt('not-a-number')).toBeNull();
  });

  it('maps spend, budget source, LLM usage and per-service callability', () => {
    const view = buildWalletViewModel(
      {
        userBudget: {
          effective: '100000',
          source: 'ceiling',
          ceiling: { dailyLimit: '100000' },
          own: { dailyLimit: '130000', cappedByCeiling: true },
        },
        platform: { llmWalletDailyCap: '5000000', llmGlobalDailyCap: '50000000' },
        spent: {
          all: { charged: '12000', pending: '19040' },
          llm: { charged: '10000', pending: '5000' },
        },
        remaining: { userBudget: '68960', llm: '68960' },
      },
      [
        { serviceId: 'echo', pricing: 'exact', price: '1000000' },
        { serviceId: 'llm-glm-5-3', pricing: 'metered', quoteMax: '19040' },
      ],
    );

    expect(view.todayCharged).toBe('0.012000');
    expect(view.todayPending).toBe('0.019040');
    expect(view.llmUsed).toBe('0.015000');
    expect(view.budget.effective).toBe('0.100000');
    expect(view.budget.ownIsCapped).toBe(true);
    expect(view.services.map(({ canCallToday }) => canCallToday)).toEqual([false, true]);
  });

  it('does not treat a missing user budget as a zero budget', () => {
    const view = buildWalletViewModel(
      {
        userBudget: null,
        platform: { llmWalletDailyCap: '5000000', llmGlobalDailyCap: '50000000' },
        spent: { all: { charged: '0', pending: '0' }, llm: { charged: '0', pending: '0' } },
        remaining: { userBudget: null, llm: '4980960' },
      },
      [
        { serviceId: 'echo', pricing: 'exact', price: '1000000' },
        { serviceId: 'llm-glm-5-3', pricing: 'metered', quoteMax: '19040' },
        { serviceId: 'llm-gpt-6-astra', pricing: 'metered', quoteMax: '69000' },
      ],
    );

    expect(view.budget).toBeNull();
    expect(view.services.map(({ canCallToday }) => canCallToday)).toEqual([true, true, true]);
  });

  it('shortens transaction hashes for receipt links', () => {
    expect(shortHash(`0x${'a'.repeat(64)}`)).toBe('0xaaaa…aaaa');
    expect(shortHash('—')).toBe('—');
  });
});

describe('budget amount parsing', () => {
  it('parses decimal USDT exactly to atomic units', () => {
    expect(parseUsdtToAtomic('0.05')).toBe('50000');
    expect(parseUsdtToAtomic('5.01')).toBe('5010000');
    expect(parseUsdtToAtomic('1')).toBe('1000000');
    expect(parseUsdtToAtomic('0')).toBe('0');
    expect(parseUsdtToAtomic('0.000001')).toBe('1');
    expect(parseUsdtToAtomic(' 0.5 ')).toBe('500000');
    expect(parseUsdtToAtomic('.5')).toBe('500000');
  });

  it('rejects non-numeric, negative and over-precise amounts', () => {
    expect(parseUsdtToAtomic('abc')).toBeNull();
    expect(parseUsdtToAtomic('-1')).toBeNull();
    expect(parseUsdtToAtomic('1.0000001')).toBeNull();
    expect(parseUsdtToAtomic('')).toBeNull();
    expect(parseUsdtToAtomic(null)).toBeNull();
    expect(parseUsdtToAtomic(undefined)).toBeNull();
  });

  it('validates against the platform max and, for own values, the ceiling', () => {
    expect(validateBudgetAmount('abc', { maxAtomic: '5000000' })).toEqual({
      atomic: null,
      errorKey: 'walletInvalidBudget',
      limit: null,
    });
    expect(validateBudgetAmount('5.01', { maxAtomic: '5000000' })).toEqual({
      atomic: '5010000',
      errorKey: 'walletBudgetAboveMax',
      limit: '5.000000',
    });
    expect(validateBudgetAmount('0.10', { ceilingAtomic: '50000' })).toEqual({
      atomic: '100000',
      errorKey: 'walletOwnAboveCeiling',
      limit: '0.050000',
    });
    expect(validateBudgetAmount('0.03', { maxAtomic: '5000000', ceilingAtomic: '50000' })).toEqual({
      atomic: '30000',
      errorKey: null,
      limit: null,
    });
  });
});

describe('budget request intent', () => {
  it('builds the same challenge key for controls that share a wallet and signer', () => {
    const first = budgetChallengeKey({
      mode: 'ceiling',
      wallet: '0x1111111111111111111111111111111111111111',
      signer: '0x2222222222222222222222222222222222222222',
    });
    const second = budgetChallengeKey({
      mode: 'ceiling',
      wallet: '0x1111111111111111111111111111111111111111',
      signer: '0x2222222222222222222222222222222222222222',
    });

    expect(first).toBe('wallet-budget:ceiling:0x2222222222222222222222222222222222222222:0x1111111111111111111111111111111111111111');
    expect(second).toBe(first);
    expect(
      budgetChallengeKey({
        mode: 'own',
        wallet: '0x1111111111111111111111111111111111111111',
        signer: '0x2222222222222222222222222222222222222222',
      }),
    ).not.toBe(first);
  });

  it('maps the own-value UI mode to the wallet API scope', () => {
    expect(
      buildBudgetIntent({
        mode: 'own',
        wallet: '0x1111111111111111111111111111111111111111',
        signer: '0x2222222222222222222222222222222222222222',
        dailyLimit: '30000',
      }),
    ).toEqual({
      scope: 'wallet',
      wallet: '0x1111111111111111111111111111111111111111',
      signer: '0x2222222222222222222222222222222222222222',
      dailyLimit: '30000',
    });
  });

  it('keeps an owner ceiling scope bound to its agent id', () => {
    expect(
      buildBudgetIntent({
        mode: 'ceiling',
        wallet: '0x1111111111111111111111111111111111111111',
        signer: '0x2222222222222222222222222222222222222222',
        agentId: '2',
        dailyLimit: null,
      }),
    ).toEqual({
      scope: 'ceiling',
      wallet: '0x1111111111111111111111111111111111111111',
      signer: '0x2222222222222222222222222222222222222222',
      agentId: '2',
      dailyLimit: null,
    });
  });
});

describe('connected wallet matching', () => {
  it('compares wallet addresses without case sensitivity', () => {
    expect(
      sameWalletAddress(
        '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada',
        '0x458045ab70e11ff1eeb5f6226e5e02f92f7b9ada',
      ),
    ).toBe(true);
    expect(
      sameWalletAddress(
        '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada',
        '0xeD0c5d27b51839FE943f2FB5789921d5120D427c',
      ),
    ).toBe(false);
    expect(sameWalletAddress(null, 'not-an-address')).toBe(false);
  });

  it('uses accurate budget guidance for disconnected, same-wallet and other-wallet views', () => {
    const wallet = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada';
    expect(walletBudgetAccessKey(wallet, null)).toBe('walletConnectToManage');
    expect(walletBudgetAccessKey(wallet, '0x458045ab70e11ff1eeb5f6226e5e02f92f7b9ada')).toBe(
      'walletOwnerControlsBelow',
    );
    expect(
      walletBudgetAccessKey(
        wallet,
        '0xeD0c5d27b51839FE943f2FB5789921d5120D427c',
      ),
    ).toBe('walletOtherAccountControlsBelow');
  });
});

describe('owner console view model', () => {
  const OWNER = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada';
  const AGENT_WALLET = '0x1111111111111111111111111111111111111111';
  const summary = {
    userBudget: {
      effective: '10000',
      source: 'ceiling',
      ceiling: { dailyLimit: '50000' },
      own: { dailyLimit: '30000', cappedByCeiling: true },
    },
    platform: { budgetMax: '5000000' },
    spent: { all: { charged: '12834', pending: '0' } },
  };

  it('formats agent rows and keeps one control when owner equals payment wallet', () => {
    const model = buildOwnerConsoleModel({
      ownerData: {
        owner: OWNER,
        agents: [
          {
            agentId: '0',
            role: 'buyer',
            agentWallet: OWNER,
            ceiling: '10000',
            own: '30000',
            effective: '10000',
            spentToday: '0',
            pendingToday: '0',
          },
          {
            agentId: '7',
            role: 'buyer',
            agentWallet: AGENT_WALLET,
            ceiling: '50000',
            own: null,
            effective: '50000',
            spentToday: '12834',
            pendingToday: '5',
          },
        ],
        transferredAway: [
          { agentId: '3', ceiling: '20000' },
          { agentId: '4', ceiling: null },
        ],
      },
      summary,
      account: OWNER,
    });

    expect(model.agents[0].sameAddress).toBe(true);
    expect(model.agents[0].showRowControl).toBe(false);
    expect(model.agents[0].ceiling).toBe('0.010000');
    expect(model.agents[0].own).toBe('0.030000');
    expect(model.agents[1].sameAddress).toBe(false);
    expect(model.agents[1].showRowControl).toBe(true);
    expect(model.agents[1].own).toBeNull();
    expect(model.agents[1].spentToday).toBe('0.012834');
    expect(model.agents[1].pendingToday).toBe('0.000005');
    expect(model.agents[1].agentWalletShort).toBe('0x1111…1111');
    expect(model.wallet.control).toEqual({
      show: true,
      mode: 'ceiling',
      agentId: '0',
      ceilingAtomic: null,
    });
    expect(model.wallet.spentToday).toBe('0.012834');
    expect(model.wallet.maxAtomic).toBe('5000000');
    expect(model.transferredAway).toEqual([
      { agentId: '3', ceiling: '0.020000' },
      { agentId: '4', ceiling: null },
    ]);
  });

  it('falls back to a wallet own-budget control with the ceiling as its limit', () => {
    const model = buildOwnerConsoleModel({
      ownerData: {
        owner: OWNER,
        agents: [
          {
            agentId: '7',
            role: 'buyer',
            agentWallet: AGENT_WALLET,
            ceiling: '50000',
            own: null,
            effective: '50000',
            spentToday: '0',
            pendingToday: '0',
          },
          {
            agentId: '8',
            role: 'buyer',
            agentWallet: '',
            ceiling: null,
            own: null,
            effective: null,
            spentToday: '0',
            pendingToday: '0',
          },
        ],
        transferredAway: [],
      },
      summary,
      account: OWNER,
    });

    expect(model.agents[1].agentWallet).toBeNull();
    expect(model.agents[1].showRowControl).toBe(false);
    expect(model.agents[1].viewAddress).toBeNull();
    expect(model.wallet.control).toEqual({
      show: true,
      mode: 'own',
      agentId: null,
      ceilingAtomic: '50000',
    });
    expect(model.wallet.budget.ownIsCapped).toBe(true);
  });

  it('keeps every ceiling controllable when two agents share the connected address', () => {
    const model = buildOwnerConsoleModel({
      ownerData: {
        owner: OWNER,
        agents: [
          {
            agentId: '0',
            role: 'buyer',
            agentWallet: OWNER,
            ceiling: '10000',
            own: null,
            effective: '10000',
            spentToday: '0',
            pendingToday: '0',
          },
          {
            agentId: '9',
            role: 'buyer',
            agentWallet: OWNER,
            ceiling: '20000',
            own: null,
            effective: '20000',
            spentToday: '0',
            pendingToday: '0',
          },
        ],
        transferredAway: [],
      },
      summary: {
        userBudget: {
          effective: '10000',
          source: 'ceiling',
          ceiling: { dailyLimit: '10000' },
          own: null,
        },
        platform: { budgetMax: '5000000' },
        spent: { all: { charged: '0', pending: '0' } },
      },
      account: OWNER,
    });

    // Both same-address agents keep their own ceiling control.
    expect(model.agents.map((agent) => agent.showRowControl)).toEqual([true, true]);
    // The wallet card still lets the owner manage the wallet's own value, and
    // its inline limit is the smallest ceiling applying to that wallet.
    expect(model.wallet.control).toEqual({
      show: true,
      mode: 'own',
      agentId: null,
      ceilingAtomic: '10000',
    });
  });
});
