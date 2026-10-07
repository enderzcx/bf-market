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
    ];
    for (const message of messages) {
      expect(translateBackendError(message, 'zh')).not.toBe(message);
      expect(translateBackendError(message, 'zh').trim()).not.toBe('');
      expect(translateBackendError(message, 'en')).toBe(message);
    }
    expect(translateBackendError('Something odd happened.', 'zh')).toBe('Something odd happened.');
    expect(translateBackendError('Something odd happened.', 'en')).toBe('Something odd happened.');
  });
});
