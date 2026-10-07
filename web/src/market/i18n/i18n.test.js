import { describe, expect, it } from 'bun:test';
import en from './en.js';
import zh from './zh.js';
import { resolveLang, translateBackendError } from './index.js';

describe('market dictionaries', () => {
  it('keeps en and zh keys and interpolation placeholders in sync', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), `en.${key}`).not.toBe('');
      expect(zh[key].trim(), `zh.${key}`).not.toBe('');
      expect([...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort()).toEqual(
        [...zh[key].matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort(),
      );
    }
  });

  it('resolves URL, stored, browser, then English language preference', () => {
    expect(resolveLang('?lang=zh', 'en', 'en-US')).toBe('zh');
    expect(resolveLang('?lang=en', 'zh', 'zh-CN')).toBe('en');
    expect(resolveLang('?lang=fr', 'zh', 'en-US')).toBe('zh');
    expect(resolveLang('', 'invalid', 'zh-Hant-TW')).toBe('zh');
    expect(resolveLang('', null, 'en-US')).toBe('en');
    expect(resolveLang('', null, '')).toBe('en');
  });

  it('translates known backend errors only in Chinese', () => {
    const messages = [
      'Daily budget set by the agent owner is reached.',
      'Daily budget reached for this wallet.',
      'The signer is not allowed to set this budget.',
      'Invalid daily budget.',
      'The daily budget cannot exceed 5 USDT.',
      'This agent has no payment wallet.',
      'Request a challenge first.',
      'This challenge was already used. Request a new one.',
      'This challenge has expired. Request a new one.',
      'The request does not match the signed challenge.',
      'Invalid signature.',
      'Could not read the identity registry. Try again.',
      'No identity registry is configured on this network, so ownership cannot be verified.',
      "The agent's payment wallet does not match. Refresh the agent and try again.",
    ];
    for (const message of messages) {
      expect(translateBackendError(message, 'zh')).not.toBe(message);
      expect(translateBackendError(message, 'zh').trim()).not.toBe('');
      expect(translateBackendError(message, 'en')).toBe(message);
    }
    expect(translateBackendError('Something odd happened.', 'zh')).toBe('Something odd happened.');
    expect(translateBackendError('Something odd happened.', 'en')).toBe('Something odd happened.');
  });

  it('maps network failures to a localized message in both languages', () => {
    const messages = [
      'Failed to fetch',
      'TypeError: Failed to fetch',
      'NetworkError when attempting to fetch resource.',
      'Load failed',
      'fetch failed',
      'Network request failed',
      'The Internet connection appears to be offline.',
    ];
    for (const message of messages) {
      expect(translateBackendError(message, 'zh'), message).toBe(zh.errorNetwork);
      expect(translateBackendError(message, 'en'), message).toBe(en.errorNetwork);
      expect(translateBackendError(message, 'en')).not.toBe(message);
      expect(translateBackendError(message, 'zh')).not.toContain('Failed');
    }
    expect(translateBackendError('Something odd happened.', 'zh')).toBe('Something odd happened.');
  });

  it('interpolates the amount in dynamic budget errors', () => {
    const zhCeiling = translateBackendError(
      "The daily budget exceeds the owner's limit of 0.050000 USDT.",
      'zh',
    );
    expect(zhCeiling).toContain('0.050000');
    expect(zhCeiling).not.toContain('owner');

    const zhMax = translateBackendError('The daily budget cannot exceed 3.000000 USDT.', 'zh');
    expect(zhMax).toContain('3.000000');

    expect(translateBackendError("The daily budget exceeds the owner's limit of 0.05 USDT.", 'en')).toBe(
      "The daily budget exceeds the owner's limit of 0.05 USDT.",
    );
  });
});
