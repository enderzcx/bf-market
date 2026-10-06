/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import React, { useEffect, useState } from 'react';
import GlobalPublicHeader from '../../components/layout/GlobalPublicHeader';
import GlobalPublicFooter from '../../components/layout/GlobalPublicFooter';
import {
  MARKET_LABELS,
  MARKET_NAV,
  agentPrompt,
  explorerAddress,
  formatUsdt,
  mcpConfig,
  serviceIdFromResource,
  shortAddress,
} from './market-copy';
import './market.css';
import '../../styles/agent-pages.css';

const CopyField = ({ label, value, mono = false }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard permission can be denied; the text stays selectable. */
    }
  };

  return (
    <div className='market-copy'>
      <div className='market-copy-head'>
        <span className='market-copy-label'>{label}</span>
        <button type='button' className='market-copy-button' onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className={
          mono ? 'market-copy-value market-copy-value--mono' : 'market-copy-value'
        }
      >
        {value}
      </pre>
    </div>
  );
};

const ServiceCard = ({ item, network }) => {
  const id = serviceIdFromResource(item.resource);
  const cap = (item.accepts || []).reduce(
    (max, option) => {
      try {
        const amount = BigInt(String(option.amount));
        return amount > max ? amount : max;
      } catch {
        return max;
      }
    },
    0n,
  );
  const metered = (item.accepts || []).some((option) => option.scheme === 'upto');
  const explorer = explorerAddress(network.explorer, item.provider.agentWallet);

  return (
    <article className='market-service'>
      <div className='market-service-top'>
        <h3>{item.provider.name}</h3>
        <code className='market-service-id'>{id}</code>
      </div>
      <p className='market-service-desc'>{item.description}</p>
      <dl className='market-service-facts'>
        <div>
          <dt>Price cap</dt>
          <dd>
            {formatUsdt(cap)} {network.symbol}
          </dd>
        </div>
        <div>
          <dt>Pricing</dt>
          <dd>{metered ? 'Metered, per token' : 'Fixed price'}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>Agent #{item.provider.agentId}</dd>
        </div>
      </dl>
      {explorer ? (
        <a
          className='market-service-link'
          href={explorer}
          target='_blank'
          rel='noopener noreferrer'
        >
          View provider on explorer
        </a>
      ) : (
        <span className='market-service-address'>
          Payout {shortAddress(item.provider.agentWallet)}
        </span>
      )}
    </article>
  );
};

const MarketPage = () => {
  const [catalog, setCatalog] = useState(null);
  const [status, setStatus] = useState('loading');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const prompt = agentPrompt(origin);
  const mcp = mcpConfig(origin);

  const load = async () => {
    setStatus('loading');
    try {
      const response = await fetch('/discovery/resources');
      if (!response.ok) throw new Error('catalog unavailable');
      const body = await response.json();
      setCatalog(body);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const network = catalog?.network ?? null;
  const items = catalog?.items ?? [];
  const networkLine = network
    ? `${network.displayName} · test funds have no value`
    : '';

  return (
    <div className='market-page'>
      <GlobalPublicHeader
        pathname='/market'
        nav={MARKET_NAV}
        labels={MARKET_LABELS}
      />

      <main id='page-top'>
        <section className='market-hero'>
          <div className='agent-shell'>
            {networkLine ? (
              <p className='market-eyebrow'>{networkLine}</p>
            ) : null}
            <h1>
              <span className='market-hero-line'>Agent commerce,</span>
              <span className='market-hero-line'>one call at a time.</span>
            </h1>
            <p className='market-hero-copy'>
              Find a service, pay for a single call with x402, and read the
              result. A wallet signature is the identity, so there is no account
              and no sign-up.
            </p>

            <div className='market-entries'>
              <article className='market-entry' id='use-with-an-agent'>
                <h2>Use with an agent</h2>
                <p>
                  Paste one line into your agent, or point it at the
                  instructions file.
                </p>
                <CopyField label='Prompt' value={prompt} />
                <p className='market-entry-links'>
                  <a href='/skill.md'>Open skill.md</a>
                </p>
                <CopyField
                  label='MCP server (Claude, Cursor)'
                  value={mcp}
                  mono
                />
              </article>

              <article className='market-entry'>
                <h2>Browse services</h2>
                <p>
                  See what is listed, its price cap, and who provides it before
                  you pay.
                </p>
                <a className='market-entry-cta' href='#services'>
                  Browse services
                </a>
              </article>
            </div>
          </div>
        </section>

        <section className='market-section agent-shell' id='services'>
          <div className='market-section-head'>
            <h2>Services</h2>
            {network ? (
              <p>
                Prices settle in {network.symbol} on {network.displayName}.
              </p>
            ) : null}
          </div>

          {status === 'loading' ? (
            <p className='market-note'>Loading services…</p>
          ) : null}
          {status === 'error' ? (
            <div className='market-note'>
              <p>Could not load services right now.</p>
              <button type='button' className='market-retry' onClick={load}>
                Try again
              </button>
            </div>
          ) : null}
          {status === 'ready' && items.length === 0 ? (
            <p className='market-note'>
              No services are listed yet. Check back soon.
            </p>
          ) : null}
          {status === 'ready' && items.length > 0 ? (
            <div className='market-services'>
              {items.map((item) => (
                <ServiceCard key={item.resource} item={item} network={network} />
              ))}
            </div>
          ) : null}
        </section>
      </main>

      <div className='agent-shell market-records-link'>
        <a href='/records'>See your call records</a>
      </div>

      <GlobalPublicFooter
        homeHref='/market'
        nav={MARKET_NAV}
        brand='BF Market'
        navigationLabel={MARKET_LABELS.footerNavigation}
      />
    </div>
  );
};

export default MarketPage;
