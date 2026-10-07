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
};

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
  if (lang !== 'zh') return message;
  const key = BACKEND_ERRORS[message];
  return key ? zh[key] : message;
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
