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
import {
  GLOBAL_PUBLIC_HEADER_COPY,
  GLOBAL_PUBLIC_NAV_LINKS,
} from './GlobalPublicHeader';
import './GlobalPublicFooter.css';

const COPY = { community: '相关链接', navigation: '页脚导航' };



export default function GlobalPublicFooter({
  homeHref = '/',
  nav = GLOBAL_PUBLIC_NAV_LINKS,
  brand = GLOBAL_PUBLIC_HEADER_COPY.brand,
  navigationLabel = COPY.navigation,
}) {
  return (
    <footer className='global-public-footer'>
      <div className='global-public-footer-inner'>
        <a className='global-public-footer-brand' href={homeHref}>
          <span>{brand}</span>
        </a>
        <span className='global-public-footer-social'>BF Labs</span>
        <nav
          className='global-public-footer-links'
          aria-label={navigationLabel}
        >
          {nav.map((item) => (
            <a key={item.itemKey} href={item.to}>
              {item.text}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
