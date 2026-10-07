import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import en from './en.js';
import zh from './zh.js';

const LanguageContext = createContext(null);
const DICTIONARIES = { en, zh };
const BACKEND_ERRORS = {
  'Daily budget set by the agent owner is reached.': 'errorOwnerBudgetReached',
  'Daily budget reached for this wallet.': 'errorWalletBudgetReached',
  'The signer is not allowed to set this budget.': 'errorSignerNotAllowed',
  'Invalid daily budget.': 'errorInvalidDailyBudget',
  'The daily budget cannot exceed 5 USDT.': 'errorBudgetMax',
  'This agent has no payment wallet.': 'errorNoPaymentWallet',
  'Request a challenge first.': 'errorChallengeRequired',
  'This challenge was already used. Request a new one.': 'errorChallengeUsed',
  'This challenge has expired. Request a new one.': 'errorChallengeExpired',
  'The request does not match the signed challenge.': 'errorIntentMismatch',
  'Invalid signature.': 'errorInvalidSignature',
  'Could not read the identity registry. Try again.': 'errorRegistryUnavailable',
  'No identity registry is configured on this network, so ownership cannot be verified.':
    'errorNoRegistry',
  "The agent's payment wallet does not match. Refresh the agent and try again.":
    'errorWalletMismatch',
};
// Known budget errors whose text embeds an amount. The first capture group is
// interpolated into the dictionary entry as {amount}.
const BACKEND_ERROR_PATTERNS = [
  {
    pattern: /^The daily budget exceeds the owner's limit of (.+) USDT\.$/,
    key: 'errorOwnAboveCeiling',
  },
  {
    pattern: /^The daily budget cannot exceed (.+) USDT\.$/,
    key: 'errorBudgetMaxAmount',
  },
];

// Browser fetch failures are thrown as TypeError with a browser-specific text
// ("Failed to fetch" in Chromium, "Load failed" in Safari, "NetworkError …" in
// Firefox). They carry no backend message, so both languages get their own copy
// instead of surfacing the raw English string.
const NETWORK_ERROR_PATTERN =
  /^(?:typeerror:\s*)?(failed to fetch|fetch failed|load failed|network error|network request failed|networkerror when attempting to fetch resource\.?|the internet connection appears to be offline\.?)$/i;

export function isNetworkError(message) {
  return typeof message === 'string' && NETWORK_ERROR_PATTERN.test(message.trim());
}

function interpolate(template, replacements) {
  return template.replace(/\{([^}]+)\}/g, (match, name) =>
    Object.hasOwn(replacements, name) ? String(replacements[name]) : match,
  );
}

function normalizedLanguage(value) {
  return value === 'en' || value === 'zh' ? value : null;
}

export function resolveLang(search = '', stored = null, browser = '') {
  const params = new URLSearchParams(String(search).replace(/^\?/, ''));
  return (
    normalizedLanguage(params.get('lang')) ??
    normalizedLanguage(stored) ??
    (String(browser).toLowerCase().startsWith('zh') ? 'zh' : 'en')
  );
}

export function translateBackendError(message, lang) {
  if (isNetworkError(message)) return DICTIONARIES[lang === 'zh' ? 'zh' : 'en'].errorNetwork;
  if (lang !== 'zh') return message;
  const key = BACKEND_ERRORS[message];
  if (key) return zh[key];
  for (const { pattern, key: patternKey } of BACKEND_ERROR_PATTERNS) {
    const match = pattern.exec(message);
    if (match) return interpolate(zh[patternKey], { amount: match[1] });
  }
  return message;
}

function safeStoredLanguage() {
  try {
    return window.localStorage.getItem('bfm.lang');
  } catch {
    return null;
  }
}

function titleKeyForPath(pathname) {
  if (pathname === '/') return 'titleHome';
  if (pathname === '/market') return 'titleMarket';
  if (pathname === '/wallet') return 'titleConsole';
  if (pathname.startsWith('/wallet/')) return 'titleWallet';
  if (pathname === '/docs') return 'titleDocs';
  return 'titleNotFound';
}

export function LanguageProvider({ children }) {
  const location = useLocation();
  const [lang, setLangState] = useState(() =>
    resolveLang(window.location.search, safeStoredLanguage(), navigator.language),
  );

  const setLang = (next) => {
    const language = normalizedLanguage(next);
    if (!language) return;
    setLangState(language);
    try {
      window.localStorage.setItem('bfm.lang', language);
    } catch {
      // Language switching still works when storage is disabled.
    }
    const url = new URL(window.location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.set('lang', language);
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  };

  const value = useMemo(() => {
    const dictionary = DICTIONARIES[lang];
    return {
      lang,
      setLang,
      t(key, replacements = {}) {
        const template = dictionary[key] ?? key;
        return template.replace(/\{([^}]+)\}/g, (match, name) =>
          Object.hasOwn(replacements, name) ? String(replacements[name]) : match,
        );
      },
      translateError(message) {
        return translateBackendError(message, lang);
      },
    };
  }, [lang]);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    const title = DICTIONARIES[lang][titleKeyForPath(location.pathname)];
    document.title = lang === 'zh' ? `BF Market｜${title}` : `BF Market | ${title}`;
  }, [lang, location.pathname]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useT() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useT must be used within LanguageProvider.');
  return context;
}
