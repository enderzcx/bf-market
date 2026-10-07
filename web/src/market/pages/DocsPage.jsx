import React from 'react';
import { useT } from '../i18n/index.js';
import { extractAgentPrompt, agentPromptForOrigin } from './home-market-model.js';
import { docsDataModel } from './docs-model.js';
import './docs.css';

const EMPTY_ADDRESS = `0x${'0'.repeat(40)}`;

function useDocsData() {
  const [result, setResult] = React.useState({
    servicesData: null,
    discoveryData: null,
    summaryData: null,
    prompt: null,
  });

  React.useEffect(() => {
    const controller = new AbortController();
    const loadJson = (url) =>
      fetch(url, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .catch((error) => {
          if (error.name === 'AbortError') throw error;
          return null;
        });

    Promise.all([
      loadJson('/api/services'),
      loadJson('/discovery/resources?limit=50'),
      loadJson(`/api/wallets/${EMPTY_ADDRESS}/summary`),
      fetch('/skill.md', { signal: controller.signal })
        .then((response) => (response.ok ? response.text() : ''))
        .catch((error) => {
          if (error.name === 'AbortError') throw error;
          return '';
        }),
    ])
      .then(([servicesData, discoveryData, summaryData, skill]) => {
        setResult({
          servicesData,
          discoveryData,
          summaryData,
          prompt: extractAgentPrompt(skill) ?? agentPromptForOrigin(window.location.origin),
        });
      })
      .catch(() => {});

    return () => controller.abort();
  }, []);

  return {
    ...result,
    model: docsDataModel(result),
  };
}

const API_ROWS = [
  ['GET', '/discovery/resources', 'docsApiDiscovery'],
  ['GET', '/api/services', 'docsApiServiceList'],
  ['POST', '/api/services/:id/call', 'docsApiCall'],
  ['GET', '/api/receipts?payer=0x...', 'docsApiReceipts'],
  ['GET', '/api/wallets/:address/summary', 'docsApiSummary'],
  ['GET', '/api/owners/:address/agents', 'docsApiOwnerAgents'],
  ['POST', '/api/budgets/challenge', 'docsApiBudgetChallenge'],
  ['POST', '/api/budgets', 'docsApiBudgetSubmit'],
  ['POST', '/api/agents/challenge', 'docsApiAgentChallenge'],
  ['POST', '/api/agents/drafts', 'docsApiAgentDrafts'],
  ['POST', '/api/agents/confirm', 'docsApiAgentConfirm'],
  ['POST', '/api/agents/:agentId/refresh', 'docsApiAgentRefresh'],
  ['POST', '/api/agents/starter-gas', 'docsApiStarterGas'],
];

const MCP_TOOLS = [
  ['platform_info', 'docsMcpPlatformInfo'],
  ['search_services', 'docsMcpSearch'],
  ['get_service', 'docsMcpGetService'],
  ['call_service', 'docsMcpCall'],
  ['register_agent_info', 'docsMcpRegister'],
  ['get_wallet_summary', 'docsMcpWalletSummary'],
  ['set_wallet_budget', 'docsMcpWalletBudget'],
];

function DocSection({ id, title, intro, children }) {
  return (
    <section className='docs-section' id={id}>
      <h2 className='docs-section-title'>{title}</h2>
      {intro && <p className='docs-prose docs-section-intro'>{intro}</p>}
      {children}
    </section>
  );
}

function CodeBlock({ children, label }) {
  return (
    <div className='docs-code-block'>
      {label && <div className='docs-code-label'>{label}</div>}
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}

export default function DocsPage() {
  const { t, token } = useT();
  const { model, prompt } = useDocsData();
  const mcpConfig = {
    mcpServers: {
      'bf-market': {
        type: 'http',
        url: `${window.location.origin}/mcp`,
      },
    },
  };
  const contractLabels = {
    asset: t('docsContractAsset'),
    permit2: 'Permit2',
    exactProxy: t('docsContractExactProxy'),
    uptoProxy: t('docsContractUptoProxy'),
    identityRegistry: t('docsContractIdentity'),
  };

  return (
    <main className='market-container market-main docs-page'>
      <div className='market-breadcrumb'>BF MARKET&nbsp; / &nbsp;{t('docs')}</div>
      <p className='market-partner-docs docs-partner-note'>
        {t('docsPartner')} <a href='/partner/docs'>{t('docsPartnerLink')}</a>
      </p>
      <header className='docs-page-head'>
        <h1 className='market-page-title'>{t('docsPageTitle')}</h1>
        <p className='market-page-note market-prose'>{t('docsPageIntro')}</p>
        <nav className='docs-index' aria-label={t('docsIndex')}>
          {[
            ['quick-start', 'docsQuickStart'],
            ['payment', 'docsPayment'],
            ['mcp', 'docsMcp'],
            ['api', 'docsApi'],
            ['limits', 'docsLimits'],
            ['network', 'docsNetwork'],
            ['safety', 'docsSafety'],
          ].map(([id, label]) => (
            <a href={`#${id}`} key={id}>{t(label)}</a>
          ))}
        </nav>
      </header>

      <DocSection id='quick-start' title={t('docsQuickStart')} intro={t('docsQuickIntro')}>
        <div className='docs-prompt'>
          <span className='docs-prompt-label'>[ {t('promptLabel')} ]</span>
          <code>{prompt ?? agentPromptForOrigin(window.location.origin)}</code>
        </div>
        <p className='docs-inline-links docs-prose'>
          <a href='/skill.md'>skill.md</a>
          <span aria-hidden='true'> · </span>
          <a href='/llms.txt'>llms.txt</a>
        </p>
      </DocSection>

      <DocSection id='payment' title={t('docsPayment')} intro={t('docsPaymentIntro')}>
        <ol className='docs-prose docs-steps'>
          <li>{t('docsPaymentStep402')} <code>402 Payment Required</code></li>
          <li>
            {t('docsPaymentStepSchemes')} <code>upto</code> {t('docsUptoForMetered')}{' '}
            <code>exact</code> {t('docsExactForFixed')}
          </li>
          <li>{t('docsPaymentStepApproval')} <strong>Permit2</strong> {t('docsApprovalTarget')}</li>
          <li>{t('docsPaymentStepReceipt')} <code>PAYMENT-RESPONSE</code> · <code>/api/receipts</code></li>
        </ol>
        <div className='docs-callout docs-prose'>
          <strong>{t('docsPaymentCautionTitle')}</strong>
          <span>{t('docsPaymentCaution')}</span>
        </div>
      </DocSection>

      <DocSection id='mcp' title={t('docsMcp')} intro={t('docsMcpIntro')}>
        <CodeBlock label={t('docsMcpConfig')}>{JSON.stringify(mcpConfig, null, 2)}</CodeBlock>
        <ul className='docs-tool-list'>
          {MCP_TOOLS.map(([name, description]) => (
            <li key={name}>
              <code>{name}</code>
              <span className='docs-prose'>{t(description)}</span>
            </li>
          ))}
        </ul>
      </DocSection>

      <DocSection id='api' title={t('docsApi')} intro={t('docsApiIntro')}>
        <div className='docs-api-table-wrap'>
          <table className='docs-api-table'>
            <thead>
              <tr>
                <th>{t('docsMethod')}</th>
                <th>{t('docsEndpoint')}</th>
                <th>{t('docsDescription')}</th>
              </tr>
            </thead>
            <tbody>
              {API_ROWS.map(([method, path, description]) => (
                <tr key={`${method}-${path}`}>
                  <td><span className='docs-method'>{method}</span></td>
                  <td><code>{path}</code></td>
                  <td className='docs-prose'>{t(description)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className='docs-prose docs-api-note'>{t('docsApiNote')}</p>
      </DocSection>

      <DocSection id='limits' title={t('docsLimits')} intro={t('docsLimitsIntro')}>
        <div className='docs-limits'>
          {[
            ['docsBudgetMax', model.limits.budgetMax],
            ['docsLlmWalletLimit', model.limits.llmWalletDailyCap],
            ['docsLlmGlobalLimit', model.limits.llmGlobalDailyCap],
          ].map(([label, amount]) => (
            <div className='docs-limit' key={label}>
              <span>{t(label)}</span>
              <strong>{amount == null ? '—' : `${amount} ${token}`}</strong>
            </div>
          ))}
        </div>
        <p className='docs-prose docs-section-note'>{t('docsLimitsNote')}</p>
      </DocSection>

      <DocSection id='network' title={t('docsNetwork')} intro={t('docsNetworkIntro')}>
        <dl className='docs-network-list'>
          <div>
            <dt>{t('docsNetworkName')}</dt>
            <dd>
              {model.network?.name ?? '—'}
              {model.network?.chainId != null ? ` · ${t('docsChain', { id: model.network.chainId })}` : ''}
            </dd>
          </div>
          <div>
            <dt>{t('docsNetworkId')}</dt>
            <dd><code>{model.network?.caip2 ?? '—'}</code></dd>
          </div>
          <div>
            <dt>{t('docsTokenDetails')}</dt>
            <dd>
              {model.network?.symbol ?? '—'}
              {model.network?.decimals != null ? ` · ${t('docsDecimals', { count: model.network.decimals })}` : ''}
            </dd>
          </div>
          {model.contracts.map(([key, value]) => (
            <div key={key}>
              <dt>{contractLabels[key] ?? key}</dt>
              <dd><code title={value}>{value}</code></dd>
            </div>
          ))}
        </dl>
      </DocSection>

      <DocSection id='safety' title={t('docsSafety')} intro={t('docsSafetyIntro')}>
        <ul className='docs-prose docs-safety-list'>
          <li>{t('docsSafetyTestnet')}</li>
          <li>{t('docsSafetyKeys')}</li>
          <li>{t('docsSafetyApproval')}</li>
          <li>{t('docsSafetyWallet')}</li>
          <li>{t('docsSafetyGas')}</li>
        </ul>
      </DocSection>
    </main>
  );
}
