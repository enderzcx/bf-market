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
  ['01', 'flowDiscoverTitle', 'flowDiscoverText', 'flowDiscoverCode', '🔍'],
  ['02', 'flowQuoteTitle', 'flowQuoteText', 'flowQuoteCode', '📋'],
  ['03', 'flowSignTitle', 'flowSignText', 'flowSignCode', '✍️'],
  ['04', 'flowSettleTitle', 'flowSettleText', 'flowSettleCode', '⚡'],
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
        <div className='home-prompt-header'>
          <span className='home-prompt-label'>
            <span className='prompt-pulse' aria-hidden='true' />
            {t('promptLabel')}
          </span>
          <span className='home-prompt-hint-inline'>
            {t('promptHint')}
          </span>
        </div>
        <div className='home-prompt-body'>
          <code className='home-prompt-text'>{prompt}</code>
          <button
            className={`home-copy-button ${copied ? 'is-copied' : ''}`}
            type='button'
            onClick={copyPrompt}
          >
            <span aria-hidden='true'>{copied ? '✓' : '⧉'}</span>
            <span>{copied ? t('copied') : t('copyPrompt')}</span>
          </button>
        </div>
      </div>
      <p className='home-prompt-feedback' aria-live='polite'>
        {copied ? t('copiedFeedback') : copyFailed ? t('copyFailed') : null}
      </p>
    </div>
  );
}

function LiveStats() {
  const { t, token } = useT();
  const { stats, failed, errorText } = useLiveStats();
  const settledAmount =
    stats?.settledUsdt == null ? '--' : formatAtomicUsdt(stats.settledUsdt) ?? '--';
  const values = [
    { label: 'statsCalls', value: stats?.calls ?? '--', icon: '📊' },
    { label: 'statsSettled', value: settledAmount, icon: '💎', isSettled: true },
    { label: 'statsPayers', value: stats?.payers ?? '--', icon: '👛' },
    { label: 'statsAgents', value: stats?.agents ?? '--', icon: '🤖' },
  ];

  return (
    <section className='home-section home-stats-section' aria-labelledby='home-stats-title'>
      <div className='home-section-header'>
        <h2 className='home-section-title' id='home-stats-title'>
          <span className='title-dot' aria-hidden='true' />
          {t('statsTitle')}
        </h2>
        <span className='home-stats-live-badge'>
          <span className='live-pulse-dot' aria-hidden='true' />
          NETWORK VERIFIED
        </span>
      </div>
      {failed && <p className='home-inline-error'>{errorText}</p>}
      <div className='home-stats'>
        {values.map(({ label, value, icon, isSettled }) => (
          <div className='home-stat' key={label}>
            <div className='home-stat-top'>
              <span className='home-stat-label'>{t(label)}</span>
              <span className='home-stat-icon' aria-hidden='true'>{icon}</span>
            </div>
            <div className='home-stat-val market-mono'>
              {value}
              {isSettled && value !== '--' && (
                <span className='home-stat-unit'> {token}</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className='home-stats-note'>{t('statsNote')}</p>
    </section>
  );
}

function Flow() {
  const { t } = useT();
  return (
    <section className='home-section home-flow-section' aria-labelledby='home-flow-title'>
      <div className='home-section-header'>
        <h2 className='home-section-title' id='home-flow-title'>
          <span className='title-dot' aria-hidden='true' />
          {t('flowTitle')}
        </h2>
      </div>
      <p className='home-section-intro market-prose'>{t('flowIntro')}</p>
      <div className='home-flow'>
        {FLOW_STEPS.map(([number, titleKey, textKey, codeKey, icon]) => (
          <div className='home-flow-step' key={number}>
            <div className='home-flow-step-header'>
              <span className='home-flow-number'>{number}</span>
              <span className='home-flow-step-icon' aria-hidden='true'>{icon}</span>
            </div>
            <h3>{t(titleKey)}</h3>
            <p className='market-prose'>{t(textKey)}</p>
            <code className='home-flow-code'>{t(codeKey)}</code>
          </div>
        ))}
      </div>
    </section>
  );
}

function StartLinks() {
  const { t } = useT();
  return (
    <section className='home-section home-start-section' aria-labelledby='home-start-title'>
      <div className='home-section-header'>
        <h2 className='home-section-title' id='home-start-title'>
          <span className='title-dot' aria-hidden='true' />
          {t('startTitle')}
        </h2>
      </div>
      <div className='home-start-grid'>
        <Link className='home-start-card' to='/market'>
          <div className='home-start-card-glow' aria-hidden='true' />
          <span className='home-start-eyebrow'>{t('marketEntryEyebrow')}</span>
          <span className='home-start-title'>{t('marketEntryTitle')}</span>
          <span className='home-start-copy market-prose'>{t('marketEntryText')}</span>
          <span className='home-start-link'>
            <span>{t('market')} · {t('marketEntryMeta')}</span>
            <span className='home-arrow-icon' aria-hidden='true'>→</span>
          </span>
        </Link>
        <Link className='home-start-card' to='/wallet'>
          <div className='home-start-card-glow' aria-hidden='true' />
          <span className='home-start-eyebrow'>{t('consoleEntryEyebrow')}</span>
          <span className='home-start-title'>{t('consoleEntryTitle')}</span>
          <span className='home-start-copy market-prose'>{t('consoleEntryText')}</span>
          <span className='home-start-link'>
            <span>{t('console')} · {t('consoleEntryMeta')}</span>
            <span className='home-arrow-icon' aria-hidden='true'>→</span>
          </span>
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
        <div className='home-hero-glow' aria-hidden='true' />
        <div className='home-live-badge'>
          <span className='live-badge-dot' aria-hidden='true' />
          <span>MULTI-CHAIN EVM &amp; BSC LIVE · AGENT SETTLEMENT PROTOCOL</span>
        </div>
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
