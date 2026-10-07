import React from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import { LanguageProvider, useT } from './i18n/index.js';
import HomePage from './pages/HomePage.jsx';
import MarketPage from './pages/MarketPage.jsx';
import WalletPage from './pages/WalletPage.jsx';
import DocsPage from './pages/DocsPage.jsx';
import './styles/base.css';

if (import.meta.env.VITE_BFM_TEST_WALLET === '1') {
  void import('./wallet/test-provider.js').then((module) => module.installTestWallet());
}

function Header() {
  const location = useLocation();
  const { lang, setLang, t } = useT();
  const links = [
    ['/', 'home'],
    ['/market', 'market'],
    ['/wallet', 'console'],
    ['/docs', 'docs'],
  ];

  return (
    <header className='market-header'>
      <div className='market-container market-header-inner'>
        <Link className='market-brand' to='/' aria-label={t('brand')}>
          {t('brand')}
        </Link>
        <nav className='market-nav' aria-label={t('primaryNavigation')}>
          {links.map(([href, label]) => (
            <Link
              key={href}
              to={href}
              aria-current={
                location.pathname === href ||
                (href === '/wallet' && location.pathname.startsWith('/wallet/'))
                  ? 'page'
                  : undefined
              }
            >
              {t(label)}
            </Link>
          ))}
        </nav>
        <div className='market-header-side'>
          <a className='market-partner-link' href='/partner'>
            {t('partner')}
          </a>
          <div className='market-language' role='group' aria-label={t('language')}>
            <button type='button' aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
              EN
            </button>
            <span className='market-language-separator' aria-hidden='true'>
              /
            </span>
            <button type='button' aria-pressed={lang === 'zh'} onClick={() => setLang('zh')}>
              中文
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

function useFooterInfo() {
  const [info, setInfo] = React.useState(null);
  React.useEffect(() => {
    let active = true;
    fetch('/discovery/resources?limit=1')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!active || !data?.network) return;
        const registry = data.items
          ?.map((item) => item.provider?.agentRegistry)
          .find((value) => typeof value === 'string' && value);
        const registryAddress = registry?.split(':').at(-1);
        setInfo({
          network: data.network,
          asset: data.network.asset,
          identity:
            /^0x[0-9a-fA-F]{40}$/.test(registryAddress ?? '')
              ? registryAddress
              : registry,
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return info;
}

function Footer() {
  const { t } = useT();
  const info = useFooterInfo();
  const network = info?.network;
  const contracts = [
    info?.asset && [t('footerUsdt'), info.asset],
    info?.identity && [t('footerIdentity'), info.identity],
  ].filter(Boolean);

  return (
    <footer className='market-footer'>
      <div className='market-container market-footer-inner'>
        <div className='market-footer-row'>
          <span className='market-footer-label'>{t('footerNetwork')}</span>
          <span className='market-footer-value'>
            {network
              ? `${network.displayName} · chain ${network.chainId} · ${network.caip2}`
              : '—'}
          </span>
        </div>
        {contracts.length > 0 && (
          <div className='market-footer-row'>
            <span className='market-footer-label'>{t('footerContracts')}</span>
            <span className='market-footer-value'>
              {contracts.map(([label, address]) => (
                <span className='market-footer-contract' key={label}>
                  {label} <code>{address}</code>
                </span>
              ))}
            </span>
          </div>
        )}
        <div className='market-footer-row'>
          <span className='market-footer-label'>{t('footerLinks')}</span>
          <span className='market-footer-value'>
            <a href='/skill.md'>skill.md</a>
            <a href='/llms.txt'>llms.txt</a>
            <Link to='/docs#mcp'>{t('footerMcpLink')}</Link>
            <Link to='/docs'>{t('docs')}</Link>
          </span>
        </div>
        <div className='market-footer-row'>
          <span className='market-footer-label'>{t('footerDiscovery')}</span>
          <span className='market-footer-value'>
            <a href='/discovery/resources'>/discovery/resources</a>
            <a href='/api/services'>/api/services</a>
          </span>
        </div>
        <div className='market-footer-row'>
          <span className='market-footer-label'>{t('footerPartner')}</span>
          <span className='market-footer-value'>
            <a href='/partner'>{t('footerPartner')}</a>
          </span>
        </div>
        <div className='market-footer-bottom'>
          <span>BF Market · market.bflabs.app</span>
          <span>x402 · exact · upto · Permit2</span>
        </div>
      </div>
    </footer>
  );
}

function PlaceholderPage({ titleKey, introKey, docs = false }) {
  const { t } = useT();
  return (
    <main className='market-container market-page'>
      <h1 className='market-page-title'>{t(titleKey)}</h1>
      <p className='market-page-note market-prose'>{t(introKey)}</p>
      {docs && (
        <>
          <p id='mcp' className='market-page-note'>
            MCP · <a href='/mcp'>/mcp</a>
          </p>
          <p className='market-partner-docs market-prose'>
            {t('docsPartner')} <a href='/partner/docs'>{t('partner')}</a>
          </p>
        </>
      )}
    </main>
  );
}

function NotFoundPage() {
  return <PlaceholderPage titleKey='notFoundTitle' introKey='notFoundIntro' />;
}

function MarketRoutes() {
  return (
    <div className='market-shell'>
      <Header />
      <Routes>
        <Route path='/' element={<HomePage />} />
        <Route path='/market' element={<MarketPage />} />
        <Route path='/wallet' element={<WalletPage />} />
        <Route path='/wallet/:address' element={<WalletPage />} />
        <Route
          path='/docs'
          element={<DocsPage />}
        />
        <Route path='*' element={<NotFoundPage />} />
      </Routes>
      <Footer />
    </div>
  );
}

export default function MarketRoot() {
  return (
    <BrowserRouter>
      <LanguageProvider>
        <MarketRoutes />
      </LanguageProvider>
    </BrowserRouter>
  );
}
