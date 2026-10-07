import { describe, expect, it } from 'bun:test';
import {
  extractAgentPrompt,
  formatAtomicUsdt,
  getServicePrice,
} from './home-market-model.js';

describe('home and market view models', () => {
  it('extracts the exact prompt shown in skill.md', () => {
    const prompt =
      'Read http://127.0.0.1:4333/skill.md and use BF Market to find and pay for a service with x402, then read the result.';
    expect(
      extractAgentPrompt(
        `# BF Market\n\n> Copy this prompt into your agent:\n>\n> \`\`\`\n> ${prompt}\n> \`\`\`\n`,
      ),
    ).toBe(prompt);
  });

  it('formats six-decimal atomic USDT without floating-point rounding', () => {
    expect(formatAtomicUsdt('3013675')).toBe('3.013675');
    expect(formatAtomicUsdt('1000000')).toBe('1.000000');
    expect(formatAtomicUsdt('19040')).toBe('0.019040');
    expect(formatAtomicUsdt('0')).toBe('0.000000');
  });

  it('uses fixed price for exact and quote maximum for metered services', () => {
    expect(getServicePrice({ pricing: 'exact', price: '1000000' })).toBe('1000000');
    expect(getServicePrice({ pricing: 'metered', quoteMax: '19040' })).toBe('19040');
    expect(getServicePrice({ pricing: 'metered', quoteMax: null })).toBeNull();
  });
});
