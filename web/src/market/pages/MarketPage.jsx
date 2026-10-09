import React from 'react';
import { useT } from '../i18n/index.js';
import { formatAtomicUsdt, getServicePrice } from './home-market-model.js';
import './market.css';

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

  return (
    <article className='market-service'>
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
        <span className='market-service-id'>{service.serviceId}</span>
        <span className='market-service-type'>
          {metered ? t('pricingMetered') : t('pricingExact')}
        </span>
        {health && (
          <span className={`market-service-health market-health-${health.status}`}>
            <span className='market-health-dot' aria-hidden='true'>●</span>
            {health.status === 'healthy' && `${health.successRate24h}% · ${health.medianLatencyMs}ms`}
            {health.status === 'stable' && (health.medianLatencyMs ? `${health.medianLatencyMs}ms` : 'Active')}
            {health.status === 'degraded' && 'Degraded'}
            {health.status === 'unknown' && 'New'}
          </span>
        )}
        <span className='market-service-price'>
          <span className='market-service-price-label'>
            {metered ? t('maxPerCall') : t('pricePerCall')}
          </span>
          <strong>{amount == null ? '—' : amount}</strong> <span>{token} / {t('perCall')}</span>
        </span>
        <span className='market-service-action'>{expanded ? t('collapseDetails') : t('expandDetails')}</span>
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
        <p className='market-prose'>
          {metered ? t('uptoExplanation') : t('exactExplanation')}
        </p>
        <p className='market-service-url'>
          <span>{t('callUrl')}:</span> <code>{callUrl}</code>
        </p>
        {health && health.recentProofs?.length > 0 && (
          <div className='market-proofs-section'>
            <span className='market-detail-label'>Verified On-Chain Deliveries</span>
            <ul className='market-proof-list'>
              {health.recentProofs.map((proof) => (
                <li key={proof.txHash} className='market-proof-item'>
                  <span className='market-proof-time'>{new Date(proof.timestamp).toLocaleTimeString()}</span>
                  <code className='market-proof-tx'>{proof.txHash.slice(0, 10)}...{proof.txHash.slice(-8)}</code>
                  <span className='market-proof-badge'>Verified Permit2</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className='market-curl-example'>
          <span className='market-detail-label'>{t('exampleRequest')}</span>
          <pre>
            <code>{curlExample}</code>
          </pre>
        </div>
      </div>
    </article>
  );
}

function ProviderCard({ provider }) {
  const { t } = useT();
  const fullWallet = provider.agentWallet ?? '';

  return (
    <section className='market-provider' aria-labelledby={`provider-${provider.agentId}`}>
      <div className='market-provider-heading'>
        <div className='market-provider-title'>
          <h2 id={`provider-${provider.agentId}`}>{provider.name}</h2>
          <span className='market-provider-agent'>
            {t('providerIdentity')} · ERC-8004 {t('agentNumber', { id: provider.agentId })}
          </span>
        </div>
        <div className='market-provider-wallet'>
          <span>{t('payoutWallet')}</span>
          <code title={fullWallet}>{fullWallet || '—'}</code>
        </div>
      </div>
      {provider.description && (
        <p className='market-provider-description market-prose'>{provider.description}</p>
      )}
      <div className='market-provider-services'>
        {(provider.services ?? []).map((service) => (
          <ServiceRow key={service.serviceId} provider={provider} service={service} />
        ))}
      </div>
    </section>
  );
}

export default function MarketPage() {
  const { providers, loading, failed, t } = useProviders();
  return (
    <main className='market-container market-page market-listing-page'>
      <div className='market-breadcrumb'>BF MARKET&nbsp; / &nbsp;{t('market')}</div>
      <h1 className='market-page-title'>{t('marketTitle')}</h1>
      <p className='market-page-note market-prose'>{t('marketIntro')}</p>
      <div className='market-provider-list' aria-live='polite'>
        {loading && <p className='market-loading'>{t('providersLoading')}</p>}
        {failed && <p className='market-inline-error'>{t('providersUnavailable')}</p>}
        {!loading && !failed && providers.length === 0 && (
          <p className='market-empty'>{t('providersEmpty')}</p>
        )}
        {!failed &&
          providers.map((provider) => <ProviderCard key={provider.agentId} provider={provider} />)}
      </div>
      <aside className='market-become-provider'>
        <p className='market-prose'>
          <strong>{t('becomeProvider')}</strong> — {t('comingSoon')}
        </p>
      </aside>
    </main>
  );
}
