import React from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n/index.js';
import {
  agentPromptForOrigin,
  extractAgentPrompt,
  formatAtomicUsdt,
} from './home-market-model.js';
import './home.css';

const ASCII_WORDMARK = String.raw` ____  _____   __  __    _    ____  _  _______ _____
| __ )|  ___| |  \/  |  / \  |  _ \| |/ / ____|_   _|
|  _ \| |_    | |\/| | / _ \ | |_) | ' /|  _|   | |
| |_) |  _|   | |  | |/ ___ \|  _ <| . \| |___| |
|____/|_|     |_|  |_/_/   \_\_| \_\_|\_\_____|_|`;

const FLOW_STEPS = [
  ['01', 'flowDiscoverTitle', 'flowDiscoverText', 'flowDiscoverCode'],
  ['02', 'flowQuoteTitle', 'flowQuoteText', 'flowQuoteCode'],
  ['03', 'flowSignTitle', 'flowSignText', 'flowSignCode'],
  ['04', 'flowSettleTitle', 'flowSettleText', 'flowSettleCode'],
];

function useLiveStats() {
  const { t } = useT();
  const [stats, setStats] = React.useState(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    fetch('/api/stats/public', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('stats request failed');
        return response.json();
      })
      .then((data) => setStats(data))
      .catch((error) => {
        if (error.name !== 'AbortError') setFailed(true);
      });
    return () => controller.abort();
  }, []);

  return {
    stats,
    failed,
    errorText: t('statsUnavailable'),
  };
}

function useAgentPrompt() {
  const fallback = React.useMemo(() => agentPromptForOrigin(window.location.origin), []);
  const [prompt, setPrompt] = React.useState(fallback);

  React.useEffect(() => {
    const controller = new AbortController();
    fetch('/skill.md', { signal: controller.signal })
      .then((response) => (response.ok ? response.text() : ''))
      .then((markdown) => {
        const exactPrompt = extractAgentPrompt(markdown);
        if (exactPrompt) setPrompt(exactPrompt);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return prompt;
}

function PromptBox() {
  const { t } = useT();
  const prompt = useAgentPrompt();
  const [copied, setCopied] = React.useState(false);
  const [copyFailed, setCopyFailed] = React.useState(false);
  const timer = React.useRef(null);

  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 2800);
  };

  return (
    <div className='home-prompt-block'>
      <div className='home-prompt'>
        <span className='home-prompt-label'>[ {t('promptLabel')} ]</span>
        <code className='home-prompt-text'>{prompt}</code>
        <button className='home-copy-button' type='button' onClick={copyPrompt}>
          <span aria-hidden='true'>▢</span>
          {copied ? t('copied') : t('copyPrompt')}
        </button>
      </div>
      <p className='home-prompt-feedback' aria-live='polite'>
        {copied ? t('copiedFeedback') : copyFailed ? t('copyFailed') : t('promptHint')}
      </p>
    </div>
  );
}

function LiveStats() {
  const { t } = useT();
  const { stats, failed, errorText } = useLiveStats();
  const settledAmount =
    stats?.settledUsdt == null ? '—' : formatAtomicUsdt(stats.settledUsdt) ?? '—';
  const values = [
    ['statsCalls', stats?.calls ?? '—'],
    ['statsSettled', settledAmount],
    ['statsPayers', stats?.payers ?? '—'],
    ['statsAgents', stats?.agents ?? '—'],
  ];

  return (
    <section className='home-section home-stats-section' aria-labelledby='home-stats-title'>
      <h2 className='home-section-title' id='home-stats-title'>
        {t('statsTitle')}
      </h2>
      {failed && <p className='home-inline-error'>{errorText}</p>}
      <dl className='home-stats'>
        {values.map(([label, value]) => (
          <div className='home-stat' key={label}>
            <dt>{t(label)}</dt>
            <dd className='market-mono'>
              {value}
              {label === 'statsSettled' && value !== '—' && (
                <span className='home-stat-unit'> USDT</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className='home-stats-note'>{t('statsNote')}</p>
    </section>
  );
}

function Flow() {
  const { t } = useT();
  return (
    <section className='home-section' aria-labelledby='home-flow-title'>
      <h2 className='home-section-title' id='home-flow-title'>
        {t('flowTitle')}
      </h2>
      <p className='home-section-intro market-prose'>{t('flowIntro')}</p>
      <ol className='home-flow'>
        {FLOW_STEPS.map(([number, titleKey, textKey, codeKey]) => (
          <li className='home-flow-step' key={number}>
            <span className='home-flow-number'>{number}</span>
            <h3>{t(titleKey)}</h3>
            <p className='market-prose'>{t(textKey)}</p>
            <code className='home-flow-code'>{t(codeKey)}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StartLinks() {
  const { t } = useT();
  return (
    <section className='home-section home-start-section' aria-labelledby='home-start-title'>
      <h2 className='home-section-title' id='home-start-title'>
        {t('startTitle')}
      </h2>
      <div className='home-start-grid'>
        <Link className='home-start-card' to='/market'>
          <span className='home-start-eyebrow'>{t('marketEntryEyebrow')}</span>
          <span className='home-start-title'>{t('marketEntryTitle')}</span>
          <span className='home-start-copy market-prose'>{t('marketEntryText')}</span>
          <span className='home-start-link'>→ {t('market')} · {t('marketEntryMeta')}</span>
        </Link>
        <Link className='home-start-card' to='/wallet'>
          <span className='home-start-eyebrow'>{t('consoleEntryEyebrow')}</span>
          <span className='home-start-title'>{t('consoleEntryTitle')}</span>
          <span className='home-start-copy market-prose'>{t('consoleEntryText')}</span>
          <span className='home-start-link'>→ {t('console')} · {t('consoleEntryMeta')}</span>
        </Link>
      </div>
    </section>
  );
}

export default function HomePage() {
  const { t } = useT();
  return (
    <main className='market-container home-page'>
      <section className='home-hero' aria-labelledby='home-tagline'>
        <pre className='market-ascii' aria-hidden='true'>
          {ASCII_WORDMARK}
        </pre>
        <h1 className='market-tagline' id='home-tagline'>
          {t('homeTagline')}
          <span className='market-cursor' aria-hidden='true' />
        </h1>
        <p className='market-intro market-prose'>{t('homeLead')}</p>
        <PromptBox />
      </section>
      <LiveStats />
      <Flow />
      <StartLinks />
    </main>
  );
}
