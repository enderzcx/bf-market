import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useT } from '../i18n/index.js';
import { createInjectedWallet } from '../wallet/injected.js';
import { buildWalletViewModel, formatAtomicUsdt, isWalletAddress, shortHash } from './wallet-model.js';
import './wallet.css';

function WalletLookup() {
  const { t } = useT();
  const navigate = useNavigate();
  const [address, setAddress] = React.useState('');
  const [error, setError] = React.useState('');
  const [connecting, setConnecting] = React.useState(false);
  const [providers, setProviders] = React.useState([]);
  const [walletError, setWalletError] = React.useState('');
  const wallet = React.useMemo(
    () => createInjectedWallet({ getProvider: () => window.ethereum }),
    [],
  );

  const openAddress = (value) => navigate(`/wallet/${encodeURIComponent(value.trim())}`);

  const submitAddress = (event) => {
    event.preventDefault();
    const value = address.trim();
    if (!isWalletAddress(value)) {
      setError(t('walletInvalidAddress'));
      return;
    }
    setError('');
    openAddress(value);
  };

  const connect = async (providerId) => {
    setConnecting(true);
    setWalletError('');
    try {
      const account = await wallet.connect(providerId);
      if (!isWalletAddress(account)) throw new Error('The wallet returned an invalid address.');
      setProviders([]);
      openAddress(account);
    } catch {
      setWalletError(t('walletConnectError'));
    } finally {
      setConnecting(false);
    }
  };

  const startConnect = async () => {
    setConnecting(true);
    setWalletError('');
    try {
      const available = await wallet.discover();
      if (available.length > 1) {
        setProviders(available);
        setConnecting(false);
        return;
      }
      await connect(available[0]?.uuid);
    } catch {
      setWalletError(t('walletConnectError'));
      setConnecting(false);
    }
  };

  return (
    <main className='market-container market-page wallet-page'>
      <div className='market-breadcrumb'>BF MARKET&nbsp; / &nbsp;{t('console')}</div>
      <h1 className='market-page-title'>{t('walletLookupTitle')}</h1>
      <p className='market-page-note market-prose'>{t('walletLookupIntro')}</p>
      <section className='wallet-lookup-panel' aria-label={t('console')}>
        <button
          className='wallet-primary-button'
          type='button'
          disabled={connecting}
          onClick={startConnect}
        >
          {connecting ? t('walletConnecting') : t('walletConnect')}
        </button>
        {walletError && <p className='wallet-inline-error' role='alert'>{walletError}</p>}
        {providers.length > 1 && (
          <div className='wallet-provider-choices' role='group' aria-label={t('walletChooseProvider')}>
            <h2>{t('walletChooseProvider')}</h2>
            {providers.map((provider) => (
              <button
                key={provider.uuid}
                type='button'
                disabled={connecting}
                onClick={() => connect(provider.uuid)}
              >
                {provider.name}
              </button>
            ))}
          </div>
        )}
        <div className='wallet-lookup-divider' aria-hidden='true'>
          <span>{t('walletOr')}</span>
        </div>
        <form className='wallet-address-form' onSubmit={submitAddress} noValidate>
          <label htmlFor='wallet-address'>{t('walletAddressLabel')}</label>
          <div className='wallet-address-controls'>
            <input
              id='wallet-address'
              autoComplete='off'
              inputMode='text'
              placeholder={t('walletAddressPlaceholder')}
              value={address}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'wallet-address-error' : undefined}
              onChange={(event) => {
                setAddress(event.target.value);
                setError('');
              }}
            />
            <button className='wallet-secondary-button' type='submit'>
              {t('walletLookup')}
            </button>
          </div>
          {error && (
            <p className='wallet-inline-error' id='wallet-address-error' role='alert'>
              {error}
            </p>
          )}
        </form>
      </section>
    </main>
  );
}

function formatTime(timestamp, lang) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return '—';
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function receiptStatusKey(status) {
  return (
    {
      settled: 'walletReceiptSettled',
      delivered: 'walletReceiptDelivered',
      failed: 'walletReceiptFailed',
      required: 'walletReceiptRequired',
      verified: 'walletReceiptVerified',
      settling: 'walletReceiptSettling',
    }[status] ?? 'walletReceiptUnknown'
  );
}

function WalletReceiptTable({ receipts, lang, t }) {
  if (receipts.length === 0) {
    return <p className='wallet-empty-receipts market-prose'>{t('walletReceiptEmpty')}</p>;
  }

  return (
    <div className='wallet-receipts-scroll'>
      <table className='wallet-receipts-table'>
        <thead>
          <tr>
            <th>{t('walletReceiptTime')}</th>
            <th>{t('walletReceiptService')}</th>
            <th>{t('walletReceiptCharged')}</th>
            <th>{t('walletReceiptStatus')}</th>
            <th>{t('walletReceiptTx')}</th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((receipt) => {
            const hash = receipt.settlement?.txHash;
            const charged = receipt.charged == null ? null : formatAtomicUsdt(receipt.charged);
            const explorerUrl =
              ['settled', 'delivered'].includes(receipt.status) &&
              typeof hash === 'string' &&
              /^0x[0-9a-fA-F]{64}$/.test(hash)
                ? `https://scan.bohr.life/tx/${hash}`
                : null;
            return (
              <tr key={receipt.paymentKey}>
                <td className='wallet-receipt-time'>{formatTime(receipt.createdAt, lang)}</td>
                <td className='wallet-receipt-service'>{receipt.serviceId || '—'}</td>
                <td>{charged == null ? '—' : `${charged} USDT`}</td>
                <td>{t(receiptStatusKey(receipt.status))}</td>
                <td>
                  {explorerUrl ? (
                    <a
                      href={explorerUrl}
                      target='_blank'
                      rel='noopener'
                      title={hash}
                    >
                      {shortHash(hash)}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WalletSummary({ address }) {
  const { lang, t } = useT();
  const [summary, setSummary] = React.useState(null);
  const [services, setServices] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    setServices([]);
    setLoading(true);
    setFailed(false);

    Promise.all([
      fetch(`/api/wallets/${encodeURIComponent(address)}/summary`, {
        signal: controller.signal,
      }).then((response) => {
        if (!response.ok) throw new Error('wallet summary request failed');
        return response.json();
      }),
      fetch('/api/providers', { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error('provider list request failed');
        return response.json();
      }),
    ])
      .then(([data, providersData]) => {
        setSummary(data);
        setServices(
          (Array.isArray(providersData.providers) ? providersData.providers : []).flatMap(
            (provider) =>
              (Array.isArray(provider.services) ? provider.services : []).map((service) => ({
                ...service,
                providerName: provider.name,
                providerAgentId: provider.agentId,
              })),
          ),
        );
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [address]);

  if (loading) {
    return (
      <main className='market-container market-page wallet-page'>
        <p className='wallet-loading' role='status'>{t('walletLoading')}</p>
      </main>
    );
  }
  if (failed || !summary) {
    return (
      <main className='market-container market-page wallet-page'>
        <p className='wallet-inline-error' role='alert'>{t('walletLoadFailed')}</p>
      </main>
    );
  }

  const view = buildWalletViewModel(summary, services);
  return (
    <main className='market-container market-page wallet-page'>
      <div className='market-breadcrumb'>BF MARKET&nbsp; / &nbsp;{t('console')}</div>
      <div className='wallet-summary-heading'>
        <div>
          <h1 className='market-page-title'>{t('walletSummaryFor')}</h1>
          <code className='wallet-address-value'>{summary.wallet || address}</code>
        </div>
        <span className='wallet-day-label'>{t('walletToday')} · {summary.day}</span>
      </div>

      <section className='wallet-spend-panel' aria-labelledby='wallet-spend-title'>
        <h2 id='wallet-spend-title' className='wallet-section-title'>{t('walletToday')}</h2>
        <div className='wallet-spend-metrics'>
          <div>
            <span>{t('walletCharged')}</span>
            <strong>{view.todayCharged} <small>USDT</small></strong>
          </div>
          <div>
            <span>{t('walletPending')}</span>
            <strong>{view.todayPending} <small>USDT</small></strong>
          </div>
        </div>
      </section>

      <section className='wallet-budget-panel' aria-labelledby='wallet-budget-title'>
        <h2 id='wallet-budget-title' className='wallet-section-title'>{t('walletEffectiveBudget')}</h2>
        {view.budget ? (
          <>
            <div className='wallet-budget-main'>
              <strong>{view.budget.effective} <small>USDT</small></strong>
              <span>
                {t('walletBudgetSource')}: {t(
                  view.budget.source === 'ceiling'
                    ? 'walletSourceCeiling'
                    : view.budget.source === 'own'
                      ? 'walletSourceOwn'
                      : 'walletSourceBoth',
                )}
              </span>
            </div>
            <div className='wallet-budget-details'>
              {view.budget.ceiling != null && (
                <span>{t('walletOwnerCeiling')}: {view.budget.ceiling} USDT</span>
              )}
              {view.budget.own != null && (
                <span>{t('walletOwnBudget')}: {view.budget.own} USDT</span>
              )}
            </div>
            {view.budget.ownIsCapped && (
              <p className='wallet-budget-capped'>{t('walletCappedByCeiling')}</p>
            )}
          </>
        ) : (
          <p className='wallet-no-budget market-prose'>{t('walletNoBudget')}</p>
        )}
      </section>

      <section className='wallet-llm-panel' aria-labelledby='wallet-llm-title'>
        <h2 id='wallet-llm-title' className='wallet-section-title'>{t('walletLlmTitle')}</h2>
        <div className='wallet-llm-metrics'>
          <div>
            <span>{t('walletLlmUsed')}</span>
            <strong>{view.llmUsed} <small>/ {view.llmCap} USDT</small></strong>
          </div>
          <div>
            <span>{t('walletLlmRemaining')}</span>
            <strong>{view.llmRemaining} <small>USDT</small></strong>
          </div>
          <div>
            <span>{t('walletLlmGlobal')}</span>
            <strong>{view.llmGlobalRemaining} <small>/ {view.llmGlobalCap} USDT</small></strong>
          </div>
        </div>
      </section>

      <section className='wallet-services-section' aria-labelledby='wallet-services-title'>
        <h2 id='wallet-services-title' className='wallet-section-title'>{t('walletServicesTitle')}</h2>
        <div className='wallet-service-list'>
          {view.services.map((service, index) => (
            <article className='wallet-service-row' key={`${service.serviceId}-${index}`}>
              <div className='wallet-service-main'>
                <strong>{service.serviceId}</strong>
                {service.providerName && <span>{service.providerName}</span>}
              </div>
              <div className='wallet-service-quote'>
                <span>{service.pricing === 'metered' ? t('walletMaxPerCall') : t('walletFixedPerCall')}</span>
                <strong>{service.quote ?? '—'} USDT</strong>
              </div>
              <span className={service.canCallToday ? 'wallet-callable' : 'wallet-not-callable'}>
                {t(service.canCallToday ? 'walletCallable' : 'walletNotCallable')}
              </span>
            </article>
          ))}
        </div>
      </section>

      <section className='wallet-receipts-section' aria-labelledby='wallet-receipts-title'>
        <h2 id='wallet-receipts-title' className='wallet-section-title'>{t('walletReceiptsTitle')}</h2>
        <WalletReceiptTable receipts={summary.recentReceipts ?? []} lang={lang} t={t} />
      </section>
    </main>
  );
}

export default function WalletPage() {
  const { address } = useParams();
  return address ? <WalletSummary address={address} /> : <WalletLookup />;
}
