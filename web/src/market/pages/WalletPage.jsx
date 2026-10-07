import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useT } from '../i18n/index.js';
import { createInjectedWallet } from '../wallet/injected.js';
import { createWalletSession } from '../wallet/session.js';
import { createBudgetChangeGate, submitBudgetChange } from '../wallet/budget-flow.js';
import { postJson } from '../wallet/http.js';
import { createOwnerConsoleStore } from '../wallet/owner-console.js';
import {
  budgetChallengeKey,
  buildBudgetIntent,
  buildOwnerConsoleModel,
  buildWalletViewModel,
  formatAtomicUsdt,
  isWalletAddress,
  shortHash,
  validateBudgetAmount,
  walletBudgetAccessKey,
} from './wallet-model.js';
import './wallet.css';

// Connect flow shared by the lookup page and the public wallet view, so both
// offer the same button, wallet picker and error handling.
function useWalletConnect(session) {
  const { t } = useT();
  const [connecting, setConnecting] = React.useState(false);
  const [providers, setProviders] = React.useState([]);
  const [error, setError] = React.useState('');

  const connect = React.useCallback(
    async (providerId) => {
      setConnecting(true);
      setError('');
      try {
        const account = await session.connect(providerId);
        setProviders([]);
        return account;
      } catch {
        setError(t('walletConnectError'));
        return null;
      } finally {
        setConnecting(false);
      }
    },
    [session, t],
  );

  const startConnect = React.useCallback(async () => {
    setConnecting(true);
    setError('');
    try {
      const available = await session.discover();
      if (available.length > 1) {
        setProviders(available);
        setConnecting(false);
        return;
      }
      await connect(available[0]?.uuid);
    } catch {
      setError(t('walletConnectError'));
      setConnecting(false);
    }
  }, [session, connect, t]);

  return { connecting, providers, error, connect, startConnect };
}

function WalletConnectPanel({ connect, connecting, providers, error, startConnect }) {
  const { t } = useT();
  return (
    <div className='wallet-connect-panel'>
      <button
        className='wallet-primary-button'
        type='button'
        disabled={connecting}
        onClick={startConnect}
      >
        {connecting ? t('walletConnecting') : t('walletConnect')}
      </button>
      {error && <p className='wallet-inline-error' role='alert'>{error}</p>}
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
    </div>
  );
}

function WalletLookup({ session }) {
  const { t } = useT();
  const navigate = useNavigate();
  const [address, setAddress] = React.useState('');
  const [error, setError] = React.useState('');
  const { connecting, providers, error: walletError, connect, startConnect } = useWalletConnect(session);

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

  return (
    <main className='market-container market-page wallet-page'>
      <div className='market-breadcrumb'>BF MARKET&nbsp; / &nbsp;{t('console')}</div>
      <h1 className='market-page-title'>{t('walletLookupTitle')}</h1>
      <p className='market-page-note market-prose'>{t('walletLookupIntro')}</p>
      <section className='wallet-lookup-panel' aria-label={t('console')}>
        <WalletConnectPanel
          connect={connect}
          connecting={connecting}
          providers={providers}
          error={walletError}
          startConnect={startConnect}
        />
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

// Inline amount control used both for an agent ceiling (owner scope) and for the
// connected wallet's own value (wallet scope). Amounts are validated before any
// challenge or signature is requested, and the signature always targets the
// declared `signer` so a mid-flow account switch cannot change the signer.
function BudgetControl({
  label,
  mode,
  wallet,
  signer,
  session,
  agentId = null,
  maxAtomic,
  ceilingAtomic,
  onDone,
  onAcquireChange,
  blocked = false,
  inputId,
}) {
  const { t, translateError } = useT();
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  if (!wallet) return null;

  const send = async (dailyLimit) => {
    const release = onAcquireChange?.({ mode, wallet, signer });
    if (onAcquireChange && !release) {
      setMessage('');
      setError(t('walletBudgetChangeInProgress'));
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    const body = buildBudgetIntent({
      mode,
      wallet,
      signer,
      agentId,
      dailyLimit,
    });
    try {
      const result = await submitBudgetChange({
        session,
        body,
        signer,
        postChallenge: (payload) => postJson('/api/budgets/challenge', payload),
        postSubmit: (payload) => postJson('/api/budgets', payload),
      });
      if (!result.ok) {
        if (result.kind === 'signature-rejected') {
          setError(t('walletSignatureRejected'));
          return;
        }
        const fallback =
          result.kind === 'challenge'
            ? t('walletChallengeFailed')
            : result.kind === 'submit'
              ? t('walletBudgetSaveFailed')
              : t('walletChallengeFailed');
        setError(result.error?.message ? translateError(result.error.message) : fallback);
        return;
      }
      setValue('');
      setMessage(
        dailyLimit === null
          ? t('walletBudgetRemoved')
          : dailyLimit === '0'
            ? t('walletBudgetPaused')
            : t('walletBudgetSaved'),
      );
      onDone?.();
    } finally {
      setBusy(false);
      release?.();
    }
  };

  const submitValue = (event) => {
    event.preventDefault();
    const result = validateBudgetAmount(value, { maxAtomic, ceilingAtomic });
    if (result.errorKey) {
      setMessage('');
      setError(t(result.errorKey, { amount: result.limit ?? '' }));
      return;
    }
    send(result.atomic);
  };

  return (
    <div className='wallet-budget-control'>
      <form className='wallet-budget-form' onSubmit={submitValue} noValidate>
        <label htmlFor={inputId}>{label}</label>
        <div className='wallet-budget-controls'>
          <input
            id={inputId}
            autoComplete='off'
            inputMode='decimal'
            disabled={busy || blocked}
            placeholder={ceilingAtomic ? formatAtomicUsdt(ceilingAtomic) : ''}
            value={value}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setValue(event.target.value);
              setError('');
            }}
          />
          <button type='submit' disabled={busy || blocked}>
            {busy ? t('walletSaving') : t(mode === 'ceiling' ? 'walletActionSetCeiling' : 'walletActionSave')}
          </button>
          <button type='button' disabled={busy || blocked} onClick={() => send('0')}>
            {t('walletActionPause')}
          </button>
          <button type='button' disabled={busy || blocked} onClick={() => send(null)}>
            {t('walletActionRemove')}
          </button>
        </div>
      </form>
      {error && <p className='wallet-inline-error' role='alert'>{error}</p>}
      {message && <p className='wallet-inline-ok' role='status'>{message}</p>}
    </div>
  );
}

function OwnerConsole({ account, session, refreshNonce, onChanged }) {
  const { t, translateError } = useT();
  const storeRef = React.useRef(null);
  if (!storeRef.current) storeRef.current = createOwnerConsoleStore();
  const store = storeRef.current;
  const [state, setState] = React.useState(() => store.getState());
  const [agentId, setAgentId] = React.useState('');
  const [refreshError, setRefreshError] = React.useState('');
  const [refreshBusy, setRefreshBusy] = React.useState(false);
  const [activeBudgetKeys, setActiveBudgetKeys] = React.useState(() => new Set());
  const budgetGateRef = React.useRef(null);

  if (!budgetGateRef.current) budgetGateRef.current = createBudgetChangeGate();

  const acquireBudgetChange = React.useCallback((intent) => {
    const release = budgetGateRef.current.acquire(intent);
    if (!release) return null;
    const key = budgetChallengeKey(intent);
    setActiveBudgetKeys((current) => new Set(current).add(key));
    return () => {
      release();
      setActiveBudgetKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    };
  }, []);

  // The rows live in a store rather than in component state: it owns the
  // accountsChanged transition (drop the previous owner's agents, then fetch
  // the new owner's) and ignores a response that arrives after a switch.
  React.useEffect(() => store.subscribe(setState), [store]);
  React.useEffect(() => {
    void store.setAccount(account);
  }, [store, account]);
  React.useEffect(() => {
    if (refreshNonce > 0) void store.refresh();
  }, [store, refreshNonce]);
  React.useEffect(() => () => store.destroy(), [store]);

  const refreshAgent = async (event) => {
    event.preventDefault();
    const id = agentId.trim();
    if (!/^\d+$/.test(id)) {
      setRefreshError(t('walletAddRefreshInvalid'));
      return;
    }
    setRefreshError('');
    setRefreshBusy(true);
    try {
      await postJson(`/api/agents/${encodeURIComponent(id)}/refresh`);
      setAgentId('');
      onChanged?.();
    } catch (error) {
      setRefreshError(error.message ? translateError(error.message) : t('walletRefreshFailed'));
    } finally {
      setRefreshBusy(false);
    }
  };

  if (state.failed) {
    return <p className='wallet-inline-error' role='alert'>{t('walletLoadAgentsFailed')}</p>;
  }
  // Rows render only when they belong to the connected account, so switching
  // accounts shows the loading state instead of the previous owner's agents.
  if (state.loadedAccount !== account || !state.ownerData) {
    return <p className='wallet-loading' role='status'>{t('walletLoading')}</p>;
  }

  const model = buildOwnerConsoleModel({
    ownerData: state.ownerData,
    summary: state.summary,
    account,
  });
  const { wallet } = model;

  return (
    <section className='wallet-owner-console' aria-labelledby='wallet-owner-title'>
      <div className='wallet-owner-heading'>
        <h2 id='wallet-owner-title' className='wallet-section-title'>
          {t('walletMyConsole')}
        </h2>
        <span className='wallet-connected-address'>
          {t('walletConnectedAs')} <code>{account}</code>
        </span>
      </div>

      <section className='wallet-my-wallet' aria-labelledby='wallet-my-wallet-title'>
        <h3 id='wallet-my-wallet-title' className='wallet-subsection-title'>
          {t('walletMyWallet')}
        </h3>
        <p className='wallet-note market-prose'>{t('walletMyWalletIntro')}</p>
        <div className='wallet-spend-metrics'>
          <div>
            <span>{t('walletCharged')}</span>
            <strong>
              {wallet.spentToday ?? '—'} <small>USDT</small>
            </strong>
          </div>
          <div>
            <span>{t('walletPending')}</span>
            <strong>
              {wallet.pendingToday ?? '—'} <small>USDT</small>
            </strong>
          </div>
        </div>
        {wallet.budget && (
          <div className='wallet-budget-details'>
            <span>
              {t('walletEffectiveBudget')}: {wallet.budget.effective} USDT
            </span>
            {wallet.budget.ceiling != null && (
              <span>
                {t('walletOwnerCeiling')}: {wallet.budget.ceiling} USDT
              </span>
            )}
            {wallet.budget.own != null && (
              <span>
                {t('walletOwnBudget')}: {wallet.budget.own} USDT
              </span>
            )}
          </div>
        )}
        {wallet.budget?.ownIsCapped && (
          <p className='wallet-budget-capped'>{t('walletCappedByCeiling')}</p>
        )}
        <BudgetControl
          inputId='wallet-card-budget'
          label={t(wallet.control.mode === 'ceiling' ? 'walletSetCeilingFor' : 'walletOwnBudgetFor', {
            id: wallet.control.agentId,
          })}
          mode={wallet.control.mode}
          wallet={account}
          signer={account}
          session={session}
          agentId={wallet.control.agentId}
          maxAtomic={wallet.maxAtomic}
          ceilingAtomic={wallet.control.ceilingAtomic}
          onDone={onChanged}
          onAcquireChange={acquireBudgetChange}
          blocked={activeBudgetKeys.has(
            budgetChallengeKey({
              mode: wallet.control.mode,
              wallet: account,
              signer: account,
            }),
          )}
        />
        {wallet.control.mode === 'ceiling' && (
          <p className='wallet-note market-prose'>{t('walletSameAddressNote')}</p>
        )}
      </section>

      <section className='wallet-agents-section' aria-labelledby='wallet-my-agents-title'>
        <h3 id='wallet-my-agents-title' className='wallet-subsection-title'>
          {t('walletMyAgents')}
        </h3>
        {model.agents.length === 0 ? (
          <p className='wallet-empty-agents market-prose'>{t('walletNoAgents')}</p>
        ) : (
          <div className='wallet-agents-scroll'>
            <table className='wallet-agents-table'>
              <thead>
                <tr>
                  <th>{t('walletColumnAgentId')}</th>
                  <th>{t('walletColumnPaymentWallet')}</th>
                  <th>{t('walletColumnSpentToday')}</th>
                  <th>{t('walletColumnCeiling')}</th>
                  <th>{t('walletColumnOwn')}</th>
                  <th>{t('walletColumnEffective')}</th>
                  <th>{t('walletColumnActions')}</th>
                </tr>
              </thead>
              <tbody>
                {model.agents.map((agent) => (
                  <tr key={agent.agentId}>
                    <td className='wallet-agent-id'>{agent.agentId}</td>
                    <td>
                      <code title={agent.agentWallet ?? ''}>{agent.agentWalletShort}</code>
                    </td>
                    <td>{agent.spentToday ?? '—'}</td>
                    <td>{agent.ceiling ?? '—'}</td>
                    <td>{agent.own ?? '—'}</td>
                    <td>{agent.effective ?? '—'}</td>
                    <td className='wallet-agent-actions'>
                      {agent.showRowControl && (
                        <BudgetControl
                          inputId={`agent-budget-${agent.agentId}`}
                          label={t('walletSetCeilingFor', { id: agent.agentId })}
                          mode='ceiling'
                          wallet={agent.agentWallet}
                          signer={account}
                          session={session}
                          agentId={agent.agentId}
                          maxAtomic={wallet.maxAtomic}
                          ceilingAtomic={null}
                          onDone={onChanged}
                          onAcquireChange={acquireBudgetChange}
                          blocked={activeBudgetKeys.has(
                            budgetChallengeKey({
                              mode: 'ceiling',
                              wallet: agent.agentWallet,
                              signer: account,
                            }),
                          )}
                        />
                      )}
                      {agent.viewAddress ? (
                        <Link className='wallet-agent-view' to={`/wallet/${agent.viewAddress}`}>
                          {t('walletActionView')}
                        </Link>
                      ) : (
                        <span className='wallet-agent-view'>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form className='wallet-agent-refresh' onSubmit={refreshAgent} noValidate>
          <label htmlFor='wallet-agent-id'>{t('walletAddRefreshTitle')}</label>
          <div className='wallet-agent-refresh-controls'>
            <input
              id='wallet-agent-id'
              autoComplete='off'
              inputMode='numeric'
              placeholder={t('walletAddRefreshPlaceholder')}
              value={agentId}
              aria-invalid={Boolean(refreshError)}
              onChange={(event) => {
                setAgentId(event.target.value);
                setRefreshError('');
              }}
            />
            <button type='submit' disabled={refreshBusy}>
              {t('walletAddRefresh')}
            </button>
          </div>
          {refreshError && (
            <p className='wallet-inline-error' role='alert'>
              {refreshError}
            </p>
          )}
        </form>
      </section>

      {model.transferredAway.length > 0 && (
        <section className='wallet-transferred-section' aria-labelledby='wallet-transferred-title'>
          <h3 id='wallet-transferred-title' className='wallet-subsection-title'>
            {t('walletTransferredAway')}
          </h3>
          <p className='wallet-note market-prose'>{t('walletTransferredAwayNote')}</p>
          <ul className='wallet-transferred-list'>
            {model.transferredAway.map((entry) => (
              <li key={entry.agentId}>
                <span>{t('agentNumber', { id: entry.agentId })}</span>
                <span>
                  {t('walletColumnCeiling')}: {entry.ceiling == null ? t('walletTransferredNoCeiling') : `${entry.ceiling} USDT`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className='wallet-advanced-section' aria-labelledby='wallet-advanced-title'>
        <h3 id='wallet-advanced-title' className='wallet-subsection-title'>
          {t('walletAdvancedTitle')}
        </h3>
        <button type='button' className='wallet-advanced-button' disabled aria-disabled='true'>
          {t('walletAdvancedText')}
        </button>
      </section>
    </section>
  );
}

function WalletSummaryBody({ address, refreshNonce, account, session }) {
  const { lang, t } = useT();
  const [summary, setSummary] = React.useState(null);
  const [services, setServices] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const connect = useWalletConnect(session);

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
  }, [address, refreshNonce]);

  if (loading) {
    return <p className='wallet-loading' role='status'>{t('walletLoading')}</p>;
  }
  if (failed || !summary) {
    return <p className='wallet-inline-error' role='alert'>{t('walletLoadFailed')}</p>;
  }

  const view = buildWalletViewModel(summary, services);
  return (
    <>
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

      <section className='wallet-access-section' aria-labelledby='wallet-access-title'>
        <h2 id='wallet-access-title' className='wallet-section-title'>{t('walletBudgetAccess')}</h2>
        {!account ? (
          <>
            <p className='wallet-note market-prose'>{t('walletConnectToManage')}</p>
            <WalletConnectPanel
              connect={connect.connect}
              connecting={connect.connecting}
              providers={connect.providers}
              error={connect.error}
              startConnect={connect.startConnect}
            />
          </>
        ) : (
          <p className='wallet-note market-prose'>
            {t(walletBudgetAccessKey(address, account))}{' '}
            <a href='#wallet-owner-title'>{t('walletMyConsole')}</a>
          </p>
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
    </>
  );
}

export default function WalletPage() {
  const { address } = useParams();
  const { t } = useT();
  const walletRef = React.useRef(null);
  if (!walletRef.current) {
    walletRef.current = createInjectedWallet({ getProvider: () => window.ethereum });
  }
  const sessionRef = React.useRef(null);
  if (!sessionRef.current) {
    sessionRef.current = createWalletSession({ wallet: walletRef.current });
  }
  const session = sessionRef.current;
  const [account, setAccount] = React.useState(() => session.getAddress());
  const [refreshNonce, setRefreshNonce] = React.useState(0);

  React.useEffect(() => session.subscribe(setAccount), [session]);

  const refreshAll = React.useCallback(() => setRefreshNonce((value) => value + 1), []);

  if (!address && !account) {
    return <WalletLookup session={session} />;
  }

  return (
    <main className='market-container market-page wallet-page'>
      {address ? (
        <WalletSummaryBody
          address={address}
          refreshNonce={refreshNonce}
          account={account}
          session={session}
        />
      ) : (
        <div className='market-breadcrumb'>BF MARKET&nbsp; / &nbsp;{t('console')}</div>
      )}
      {account && (
        <OwnerConsole
          account={account}
          session={session}
          refreshNonce={refreshNonce}
          onChanged={refreshAll}
        />
      )}
    </main>
  );
}
