import React from 'react';
import { useT } from '../i18n/index.js';
import { formatAtomicUsdt, getServicePrice } from './home-market-model.js';
import './market.css';

function getServiceCategory(serviceId) {
  if (serviceId.startsWith('image-') || serviceId.startsWith('video-')) return 'media';
  if (serviceId.startsWith('llm-')) return 'llm';
  return 'protocol';
}

function getCategoryBadge(cat) {
  switch (cat) {
    case 'llm':
      return { icon: '🧠', label: 'LLM', color: 'purple' };
    case 'media':
      return { icon: '🎨', label: 'MEDIA', color: 'cyan' };
    case 'protocol':
      return { icon: '⚙️', label: 'PROTOCOL', color: 'emerald' };
    default:
      return { icon: '✦', label: 'SERVICE', color: 'amber' };
  }
}

function getServiceTags(serviceId) {
  switch (serviceId) {
    case 'llm-grok-4.7-thinking':
      return [
        { label: 'Live X Search', theme: 'accent' },
        { label: 'Deep Reasoning', theme: 'purple' },
      ];
    case 'llm-grok-4.7':
      return [
        { label: 'Live X Search', theme: 'accent' },
        { label: 'Real-time Web', theme: 'cyan' },
      ];
    case 'image-gpt-image-2.5':
      return [
        { label: '1024x1024 Art', theme: 'rose' },
        { label: 'DALL-E HD', theme: 'purple' },
      ];
    case 'video-wan-3.0':
      return [
        { label: '720p HD Video', theme: 'cyan' },
        { label: 'Diffusion Video', theme: 'accent' },
      ];
    case 'llm-gemini-3.8-flash':
      return [
        { label: 'Sub-second Latency', theme: 'emerald' },
        { label: 'High Throughput', theme: 'cyan' },
      ];
    case 'llm-deepseek-v3.2':
      return [
        { label: 'Math & Code', theme: 'cyan' },
        { label: 'V3.2 Engine', theme: 'accent' },
      ];
    case 'llm-qwen-3.5-max':
      return [
        { label: 'Multilingual', theme: 'emerald' },
        { label: 'Enterprise', theme: 'purple' },
      ];
    case 'echo':
      return [
        { label: 'Exact Fixed', theme: 'emerald' },
        { label: 'Zero Overhead', theme: 'dim' },
      ];
    case 'echo-metered':
      return [
        { label: 'Metered Upto', theme: 'cyan' },
        { label: 'Pay Actual', theme: 'accent' },
      ];
    case 'llm-mock':
      return [{ label: 'Sandbox Sim', theme: 'dim' }];
    default:
      return [];
  }
}

function useProviders() {
  const { t } = useT();
  const [providers, setProviders] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch('/api/providers', { signal: controller.signal }).then((r) => {
        if (!r.ok) throw new Error('providers request failed');
        return r.json();
      }),
      fetch('/api/services', { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : { services: [] }))
        .catch(() => ({ services: [] })),
    ])
      .then(([provData, servData]) => {
        const healthMap = new Map(
          (servData?.services || []).map((s) => [s.serviceId, s.health]),
        );
        const provs = Array.isArray(provData.providers) ? provData.providers : [];
        setProviders(
          provs.map((p) => ({
            ...p,
            services: (p.services || []).map((s) => ({
              ...s,
              health: s.health || healthMap.get(s.serviceId),
            })),
          })),
        );
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setFailed(true);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  return { providers, loading, failed, t };
}

function ServiceRow({ provider, service }) {
  const { t, token } = useT();
  const [expanded, setExpanded] = React.useState(false);
  const [copiedCurl, setCopiedCurl] = React.useState(false);
  const [copiedUrl, setCopiedUrl] = React.useState(false);
  const curlTimer = React.useRef(null);
  const urlTimer = React.useRef(null);

  React.useEffect(() => {
    return () => {
      window.clearTimeout(curlTimer.current);
      window.clearTimeout(urlTimer.current);
    };
  }, []);

  const panelId = `service-detail-${provider.agentId}-${service.serviceId}`.replace(
    /[^a-zA-Z0-9_-]/g,
    '-',
  );
  const callUrl = `${window.location.origin}/api/services/${encodeURIComponent(service.serviceId)}/call`;
  const atomicPrice = getServicePrice(service);
  const amount = atomicPrice == null ? null : formatAtomicUsdt(atomicPrice);
  const metered = service.pricing === 'metered';
  const curlBody =
    service.serviceId === 'echo'
      ? `'{\"hello\":\"world\"}'`
      : service.serviceId.startsWith('image-')
        ? `'{\"prompt\":\"A futuristic cybernetic pelican overlooking neon Tokyo skyline, digital art\"}'`
        : service.serviceId.startsWith('video-wan')
          ? `'{\"prompt\":\"A pelican swooping gracefully over ocean waves at golden sunset, slow motion\"}'`
          : `'{\"messages\":[{\"role\":\"user\",\"content\":\"Say hello in one sentence.\"}]}'`;
  const curlExample = `curl -X POST '${callUrl}' \\\n  -H 'Content-Type: application/json' \\\n  -d ${curlBody}`;
  const health = service.health;

  const category = getServiceCategory(service.serviceId);
  const catBadge = getCategoryBadge(category);
  const featureTags = getServiceTags(service.serviceId);

  const handleCopyCurl = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(curlExample);
      setCopiedCurl(true);
      window.clearTimeout(curlTimer.current);
      curlTimer.current = window.setTimeout(() => setCopiedCurl(false), 2200);
    } catch {}
  };

  const handleCopyUrl = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(callUrl);
      setCopiedUrl(true);
      window.clearTimeout(urlTimer.current);
      urlTimer.current = window.setTimeout(() => setCopiedUrl(false), 2200);
    } catch {}
  };

  return (
    <article className={`market-service ${expanded ? 'is-expanded' : ''}`}>
      <button
        className='market-service-toggle'
        type='button'
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className='market-service-marker' aria-hidden='true'>
          {expanded ? '−' : '+'}
        </span>

        <span className={`market-service-cat-badge badge-${catBadge.color}`} title={catBadge.label}>
          <span className='cat-icon' aria-hidden='true'>{catBadge.icon}</span>
          <span className='cat-text'>{catBadge.label}</span>
        </span>

        <div className='market-service-primary'>
          <span className='market-service-id'>{service.serviceId}</span>
          <div className='market-service-tags' aria-label='Feature tags'>
            {featureTags.map((tag) => (
              <span key={tag.label} className={`market-tag market-tag-${tag.theme}`}>
                {tag.label}
              </span>
            ))}
          </div>
        </div>

        <span className='market-service-type'>
          {metered ? t('pricingMetered') : t('pricingExact')}
        </span>

        {health && (
          <span className={`market-service-health market-health-${health.status}`}>
            <span className='market-health-dot' aria-hidden='true' />
            <span className='market-health-text'>
              {health.status === 'healthy' && `${health.successRate24h}% · ${health.medianLatencyMs}ms`}
              {health.status === 'stable' && (health.medianLatencyMs ? `${health.medianLatencyMs}ms` : 'Active')}
              {health.status === 'degraded' && 'Degraded'}
              {health.status === 'unknown' && 'New'}
            </span>
          </span>
        )}

        <span className='market-service-price'>
          <span className='market-service-price-label'>
            {metered ? t('maxPerCall') : t('pricePerCall')}
          </span>
          <strong className='market-price-value'>{amount == null ? '—' : amount}</strong>{' '}
          <span className='market-price-unit'>{token} / {t('perCall')}</span>
        </span>

        <span className='market-service-action'>
          <span className='market-action-label'>{expanded ? t('collapseDetails') : t('expandDetails')}</span>
          <span className={`market-chevron ${expanded ? 'rotate-180' : ''}`} aria-hidden='true'>▾</span>
        </span>
      </button>

      <p
        className='market-service-description market-prose'
        title={service.description || undefined}
      >
        {service.description || t('serviceDescriptionUnavailable')}
      </p>

      <div
        className='market-service-detail'
        id={panelId}
        role='region'
        aria-label={service.serviceId}
        hidden={!expanded}
      >
        {service.description && (
          <p className='market-service-full-description market-prose'>{service.description}</p>
        )}
        <div className='market-pricing-note'>
          <span className='market-note-badge' aria-hidden='true'>ℹ</span>
          <p className='market-prose'>
            {metered ? t('uptoExplanation') : t('exactExplanation')}
          </p>
        </div>

        <div className='market-endpoint-bar'>
          <span className='market-detail-label'>{t('callUrl')}</span>
          <div className='market-endpoint-box'>
            <code>{callUrl}</code>
            <button
              type='button'
              className='market-copy-mini-btn'
              onClick={handleCopyUrl}
              title='Copy Endpoint URL'
            >
              {copiedUrl ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {health && health.recentProofs?.length > 0 && (
          <div className='market-proofs-section'>
            <div className='market-proofs-header'>
              <span className='market-detail-label'>{t('recentDeliveries') || 'Verified On-Chain Deliveries'}</span>
              <span className='market-proofs-badge-total'>{health.recentProofs.length} Recent Proofs</span>
            </div>
            <ul className='market-proof-list'>
              {health.recentProofs.map((proof) => {
                const shortTx = `${proof.txHash.slice(0, 10)}...${proof.txHash.slice(-8)}`;
                const txUrl = `https://testnet.snowtrace.io/tx/${proof.txHash}`;
                return (
                  <li key={proof.txHash} className='market-proof-item'>
                    <span className='market-proof-time'>{new Date(proof.timestamp).toLocaleTimeString()}</span>
                    <a
                      href={txUrl}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='market-proof-tx'
                      title={`Verify transaction: ${proof.txHash}`}
                    >
                      <code>{shortTx}</code>
                      <span className='market-external-icon' aria-hidden='true'>↗</span>
                    </a>
                    <span className='market-proof-badge'>
                      <span className='market-proof-check' aria-hidden='true'>✓</span>
                      {t('verifiedProof') || 'Verified Permit2'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className='market-curl-example'>
          <div className='market-curl-header'>
            <span className='market-detail-label'>{t('exampleRequest')}</span>
            <button
              type='button'
              className={`market-copy-curl-btn ${copiedCurl ? 'is-copied' : ''}`}
              onClick={handleCopyCurl}
            >
              <span aria-hidden='true'>{copiedCurl ? '✓' : '⧉'}</span>
              <span>{copiedCurl ? (t('curlCopied') || 'Copied!') : (t('copyCurl') || 'Copy cURL')}</span>
            </button>
          </div>
          <pre>
            <code>{curlExample}</code>
          </pre>
        </div>
      </div>
    </article>
  );
}

function ProviderCard({ provider, activeCategory, searchQuery }) {
  const { t } = useT();
  const fullWallet = provider.agentWallet ?? '';

  const filteredServices = React.useMemo(() => {
    return (provider.services ?? []).filter((service) => {
      if (activeCategory !== 'all') {
        const cat = getServiceCategory(service.serviceId);
        if (cat !== activeCategory) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchId = service.serviceId.toLowerCase().includes(q);
        const matchDesc = (service.description || '').toLowerCase().includes(q);
        const matchProv = (provider.name || '').toLowerCase().includes(q);
        if (!matchId && !matchDesc && !matchProv) return false;
      }
      return true;
    });
  }, [provider.services, activeCategory, searchQuery, provider.name]);

  if (filteredServices.length === 0 && (activeCategory !== 'all' || searchQuery.trim())) {
    return null;
  }

  const shortWallet = fullWallet
    ? `${fullWallet.slice(0, 8)}...${fullWallet.slice(-6)}`
    : '—';

  return (
    <section className='market-provider' aria-labelledby={`provider-${provider.agentId}`}>
      <div className='market-provider-heading'>
        <div className='market-provider-title'>
          <div className='market-provider-avatar' aria-hidden='true'>
            {provider.name?.slice(0, 1) || 'P'}
          </div>
          <div className='market-provider-meta'>
            <h2 id={`provider-${provider.agentId}`}>{provider.name}</h2>
            <span className='market-provider-agent'>
              <span className='provider-erc-badge'>ERC-8004</span>
              <span>{t('agentNumber', { id: provider.agentId })}</span>
            </span>
          </div>
        </div>
        <div className='market-provider-wallet'>
          <span className='market-wallet-label'>{t('payoutWallet')}</span>
          <code title={fullWallet} className='market-wallet-address'>
            {shortWallet}
          </code>
        </div>
      </div>
      {provider.description && (
        <p className='market-provider-description market-prose'>{provider.description}</p>
      )}
      <div className='market-provider-services'>
        {filteredServices.map((service) => (
          <ServiceRow key={service.serviceId} provider={provider} service={service} />
        ))}
      </div>
    </section>
  );
}

export default function MarketPage() {
  const { providers, loading, failed, t } = useProviders();
  const [activeCategory, setActiveCategory] = React.useState('all');
  const [searchQuery, setSearchQuery] = React.useState('');

  const allServices = React.useMemo(() => {
    return providers.flatMap((p) => p.services || []);
  }, [providers]);

  const categoryCounts = React.useMemo(() => {
    const counts = { all: allServices.length, llm: 0, media: 0, protocol: 0 };
    for (const s of allServices) {
      const cat = getServiceCategory(s.serviceId);
      if (counts[cat] !== undefined) counts[cat]++;
    }
    return counts;
  }, [allServices]);

  const totalMatchingServices = React.useMemo(() => {
    return allServices.filter((service) => {
      if (activeCategory !== 'all') {
        const cat = getServiceCategory(service.serviceId);
        if (cat !== activeCategory) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchId = service.serviceId.toLowerCase().includes(q);
        const matchDesc = (service.description || '').toLowerCase().includes(q);
        if (!matchId && !matchDesc) return false;
      }
      return true;
    }).length;
  }, [allServices, activeCategory, searchQuery]);

  return (
    <main className='market-container market-page market-listing-page'>
      <div className='market-breadcrumb'>BF MARKET&nbsp; / &nbsp;{t('market')}</div>
      <div className='market-header-block'>
        <div className='market-header-glow' aria-hidden='true' />
        <h1 className='market-page-title'>{t('marketTitle')}</h1>
        <p className='market-page-note market-prose'>{t('marketIntro')}</p>
      </div>

      <div className='market-toolbar'>
        <div className='market-categories' role='tablist' aria-label='Service categories'>
          <button
            type='button'
            role='tab'
            aria-selected={activeCategory === 'all'}
            className={`market-category-tab ${activeCategory === 'all' ? 'is-active' : ''}`}
            onClick={() => setActiveCategory('all')}
          >
            <span>{t('categoryAll') || 'All Services'}</span>
            <span className='tab-count'>{categoryCounts.all}</span>
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeCategory === 'llm'}
            className={`market-category-tab ${activeCategory === 'llm' ? 'is-active' : ''}`}
            onClick={() => setActiveCategory('llm')}
          >
            <span aria-hidden='true'>🧠</span>
            <span>{t('categoryLlm') || 'LLMs & Search'}</span>
            <span className='tab-count'>{categoryCounts.llm}</span>
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeCategory === 'media'}
            className={`market-category-tab ${activeCategory === 'media' ? 'is-active' : ''}`}
            onClick={() => setActiveCategory('media')}
          >
            <span aria-hidden='true'>🎨</span>
            <span>{t('categoryMedia') || 'Media & Vision'}</span>
            <span className='tab-count'>{categoryCounts.media}</span>
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeCategory === 'protocol'}
            className={`market-category-tab ${activeCategory === 'protocol' ? 'is-active' : ''}`}
            onClick={() => setActiveCategory('protocol')}
          >
            <span aria-hidden='true'>⚙️</span>
            <span>{t('categoryProtocol') || 'Protocol & Utility'}</span>
            <span className='tab-count'>{categoryCounts.protocol}</span>
          </button>
        </div>

        <div className='market-search-box'>
          <span className='market-search-icon' aria-hidden='true'>🔍</span>
          <input
            type='text'
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('searchPlaceholder') || 'Search services, models, providers…'}
            className='market-search-input'
            aria-label='Search services'
          />
          {searchQuery && (
            <button
              type='button'
              className='market-search-clear'
              onClick={() => setSearchQuery('')}
              title='Clear search'
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className='market-results-meta'>
        <span className='market-results-count'>
          {totalMatchingServices} {t('servicesCount', { count: totalMatchingServices }) || 'services available'}
        </span>
        {(searchQuery || activeCategory !== 'all') && (
          <button
            type='button'
            className='market-reset-filters'
            onClick={() => {
              setActiveCategory('all');
              setSearchQuery('');
            }}
          >
            Reset filters
          </button>
        )}
      </div>

      <div className='market-provider-list' aria-live='polite'>
        {loading && (
          <div className='market-loading-state'>
            <div className='market-spinner' aria-hidden='true' />
            <p className='market-loading'>{t('providersLoading')}</p>
          </div>
        )}
        {failed && <p className='market-inline-error'>{t('providersUnavailable')}</p>}
        {!loading && !failed && totalMatchingServices === 0 && (
          <div className='market-empty-state'>
            <div className='empty-icon' aria-hidden='true'>🔍</div>
            <p className='market-empty'>
              {searchQuery ? `No services matching "${searchQuery}"` : t('providersEmpty')}
            </p>
            {searchQuery && (
              <button
                type='button'
                className='market-clear-query-btn'
                onClick={() => setSearchQuery('')}
              >
                Clear query
              </button>
            )}
          </div>
        )}
        {!failed &&
          providers.map((provider) => (
            <ProviderCard
              key={provider.agentId}
              provider={provider}
              activeCategory={activeCategory}
              searchQuery={searchQuery}
            />
          ))}
      </div>

      <aside className='market-become-provider'>
        <div className='become-provider-icon' aria-hidden='true'>🚀</div>
        <div className='become-provider-text'>
          <strong>{t('becomeProvider')}</strong> · {t('comingSoon')}
          <p className='become-provider-sub'>
            Publish AI services, earn on-chain USDT micro-settlements, and register on ERC-8004.
          </p>
        </div>
      </aside>
    </main>
  );
}
