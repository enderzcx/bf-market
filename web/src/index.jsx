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

import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { resolveLegacyRedirect } from './market/redirects.js';

const PartnerRoot = lazy(() => import('./partner/PartnerRoot.jsx'));
const MarketRoot = lazy(() => import('./market/MarketRoot.jsx'));
const pathname = window.location.pathname;
const legacyTarget = resolveLegacyRedirect(window.location);
const isPartner =
  pathname === '/partner' || pathname.startsWith('/partner/');

if (legacyTarget) {
  window.location.replace(legacyTarget);
} else {
  const Root = isPartner ? PartnerRoot : MarketRoot;
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </React.StrictMode>,
  );
}
