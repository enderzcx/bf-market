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

import React, { useState } from 'react';
import GlobalPublicHeader from '../../components/layout/GlobalPublicHeader';
import GlobalPublicFooter from '../../components/layout/GlobalPublicFooter';
import {
  MARKET_LABELS,
  MARKET_NAV,
  formatTime,
  formatUsdt,
  receiptStatusLabel,
  shortAddress,
} from '../Market/market-copy';
import './records.css';
import '../../styles/agent-pages.css';

const ReceiptRow = ({ receipt }) => {
  const symbol = receipt.symbol || 'USDT';
  const usage = receipt.usage;
  const settlement = receipt.settlement;
  const status = receipt.status;

  return (
    <li className='record-row'>
      <div className='record-head'>
        <span className='record-service'>{receipt.serviceId}</span>
        <span className={`record-badge record-badge--${status}`}>
          {receiptStatusLabel(status)}
        </span>
      </div>

      <dl className='record-facts'>
        <div>
          <dt>Charged</dt>
          <dd>
            {receipt.charged == null
              ? '—'
              : `${formatUsdt(receipt.charged)} ${symbol}`}
          </dd>
        </div>
        <div>
          <dt>Authorized up to</dt>
          <dd>
            {formatUsdt(receipt.amount)} {symbol}
          </dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{formatTime(receipt.createdAt)}</dd>
        </div>
        {usage ? (
          <div>
            <dt>Tokens</dt>
            <dd>
              {usage.totalTokens} ({usage.promptTokens} in / {usage.completionTokens}{' '}
              out)
            </dd>
          </div>
        ) : null}
      </dl>

      <div className='record-foot'>
        {settlement && settlement.explorerUrl ? (
          <a
            className='record-link'
            href={settlement.explorerUrl}
            target='_blank'
            rel='noopener noreferrer'
          >
            View settlement
          </a>
        ) : settlement && settlement.txHash ? (
          <span className='record-hash'>{shortAddress(settlement.txHash)}</span>
        ) : (
          <span className='record-hash'>No settlement transaction</span>
        )}
      </div>
    </li>
  );
};

const RecordsPage = () => {
  const [address, setAddress] = useState('');
  const [receipts, setReceipts] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    const value = address.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      setError('Enter a valid wallet address.');
      setStatus('idle');
      return;
    }
    setError('');
    setStatus('loading');
    try {
      const response = await fetch(
        `/api/receipts?payer=${encodeURIComponent(value)}&limit=50`,
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || 'Could not load records.');
      }
      const body = await response.json();
      setReceipts(Array.isArray(body.receipts) ? body.receipts : []);
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load records.');
      setStatus('error');
    }
  };

  return (
    <div className='records-page'>
      <GlobalPublicHeader
        pathname='/records'
        nav={MARKET_NAV}
        labels={MARKET_LABELS}
      />

      <main id='page-top'>
        <section className='records-hero'>
          <div className='agent-shell'>
            <p className='records-eyebrow'>Call records</p>
            <h1>Your records</h1>
            <p className='records-copy'>
              Enter the wallet address you paid with to see every call. This is
              read-only: no signature and no wallet connection.
            </p>

            <form className='records-form' onSubmit={submit}>
              <label className='records-label' htmlFor='payer-address'>
                Wallet address
              </label>
              <div className='records-form-row'>
                <input
                  id='payer-address'
                  className='records-input'
                  type='text'
                  inputMode='text'
                  autoComplete='off'
                  spellCheck='false'
                  placeholder='0x...'
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
                <button type='submit' className='records-submit'>
                  View records
                </button>
              </div>
            </form>
          </div>
        </section>

        <section className='records-list agent-shell' aria-live='polite'>
          {status === 'loading' ? (
            <p className='records-note'>Loading records…</p>
          ) : null}

          {status === 'error' ? (
            <p className='records-note records-note--error'>{error}</p>
          ) : null}

          {error && status === 'idle' ? (
            <p className='records-note records-note--error'>{error}</p>
          ) : null}

          {status === 'ready' && receipts.length === 0 ? (
            <div className='records-empty'>
              <p>No calls found for this address yet.</p>
              <p className='records-empty-hint'>
                Calls appear here after the address pays for a service.
              </p>
            </div>
          ) : null}

          {status === 'ready' && receipts.length > 0 ? (
            <ul className='records-rows'>
              {receipts.map((receipt) => (
                <ReceiptRow key={receipt.paymentKey} receipt={receipt} />
              ))}
            </ul>
          ) : null}
        </section>
      </main>

      <div className='agent-shell records-back'>
        <a href='/market'>Back to services</a>
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

export default RecordsPage;
