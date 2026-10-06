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

import React from 'react';
import GlobalBrandMark from '../common/logo/GlobalBrandMark';
import './GlobalPublicHeader.css';

export const GLOBAL_PUBLIC_HEADER_COPY = {
  brandHome: '伙伴中心首页',
  brand: '伙伴中心',
  primaryNavigation: '主要导航',
  docs: '说明',
  login: '登录',
  getStarted: '进入控制台',
};

export const GLOBAL_PUBLIC_NAV_LINKS = [
  { text: '产品进展', itemKey: 'progress', to: '/progress' },
  {
    text: GLOBAL_PUBLIC_HEADER_COPY.docs,
    itemKey: 'docs',
    to: '/docs',
  },
  {
    text: GLOBAL_PUBLIC_HEADER_COPY.login,
    itemKey: 'login',
    to: '/login',
  },
];

export function currentGlobalPublicNav(pathname = '') {
  if (pathname === '/docs' || pathname.startsWith('/docs/')) return 'docs';
  if (pathname === '/progress') return 'progress';
  if (pathname === '/login') return 'login';
  if (pathname === '/market') return 'market';
  if (pathname === '/records') return 'records';
  return '';
}

export default function GlobalPublicHeader({
  pathname = '',
  nav = GLOBAL_PUBLIC_NAV_LINKS,
  labels = GLOBAL_PUBLIC_HEADER_COPY,
}) {
  const active = currentGlobalPublicNav(pathname);
  const items = nav.map((item) => ({
    key: item.itemKey,
    href: item.to,
    label: item.text,
  }));

  return (
    <header className='global-public-header'>
      <a
        className='global-public-header-brand'
        href={labels.homeHref ?? '/'}
        aria-label={labels.brandHome}
      >
        <GlobalBrandMark />
        <span>{labels.brand}</span>
      </a>
      <nav
        className='global-public-header-links'
        aria-label={labels.primaryNavigation}
      >
        {items.map((item) => (
          <a
            key={item.key}
            href={item.href}
            aria-current={active === item.key ? 'page' : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <a
        className='global-public-header-cta'
        href={labels.ctaHref ?? '/console'}
      >
        {labels.getStarted}
      </a>
    </header>
  );
}
