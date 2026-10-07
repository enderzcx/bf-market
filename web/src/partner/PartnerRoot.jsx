import React from 'react';
import { LocaleProvider } from '@douyinfe/semi-ui';
import zhCN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import '@douyinfe/semi-ui/dist/css/semi.css';
import { PartnerProvider } from '../context/Partner';
import PageLayout from '../components/layout/PageLayout';
import '../index.css';
import '../styles/global-site.css';
import '../pages/GlobalConsole/global-console.css';
import '../pages/GlobalConsole/invitation.css';
import '../styles/partner-chrome.css';
import '../styles/partner-visual.css';

if (typeof window !== 'undefined') {
  console.log(
    '%cWE ❤ NEWAPI%c Github: https://github.com/QuantumNous/new-api',
    'color: #10b981; font-weight: bold; font-size: 24px;',
    'color: inherit; font-size: 14px;',
  );
}

export default function PartnerRoot() {
  return (
    <LocaleProvider locale={zhCN}>
      <PartnerProvider>
        <BrowserRouter
          basename='/partner'
          future={{
            v7_startTransition: true,
            v7_relativeSplatPath: true,
          }}
        >
          <PageLayout />
        </BrowserRouter>
      </PartnerProvider>
    </LocaleProvider>
  );
}
