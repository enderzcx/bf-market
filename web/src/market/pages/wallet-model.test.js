import { describe, expect, it } from 'bun:test';
import {
  buildWalletViewModel,
  formatAtomicUsdt,
  isWalletAddress,
  shortHash,
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
