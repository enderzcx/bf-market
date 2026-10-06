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

import { Layout } from '@douyinfe/semi-ui';
import { Menu, X } from 'lucide-react';
import App from '../../App';
import ErrorBoundary from '../common/ErrorBoundary';
import React, { Suspense, useEffect, useState } from 'react';
import { useIsMobile } from '../../hooks/common/useIsMobile';
import { useSidebarCollapsed } from '../../hooks/common/useSidebarCollapsed';
import { useLocation } from 'react-router-dom';

const { Sider, Content } = Layout;
const GLOBAL_CLOSE_NAVIGATION_BACKDROP_LABEL = '关闭导航遮罩';
const GLOBAL_SKIP_TO_CONTENT_LABEL = '跳到主要内容';

const SiderBar = React.lazy(() => import('./SiderBar'));

const PageLayout = () => {
  const isMobile = useIsMobile();
  const [collapsed, , setCollapsed] = useSidebarCollapsed();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const isPublicHome = location.pathname === '/';
  const isAuthPage = location.pathname === '/login';
  const isDocsPage = ['/docs', '/progress', '/progress-lab'].includes(location.pathname);
  const isEnglishPublic =
    location.pathname === '/market' || location.pathname === '/records';
  const isPublicChrome = isPublicHome || isAuthPage || isDocsPage || isEnglishPublic;
  const isConsoleRoute = location.pathname.startsWith('/console');
  const showSider = isConsoleRoute && (!isMobile || drawerOpen);

  useEffect(() => {
    document.body.classList.add('global-site-app');
    document.documentElement.lang = isEnglishPublic ? 'en' : 'zh-CN';
    document.title = isEnglishPublic ? 'BF Market' : '伙伴中心';
    return () => document.body.classList.remove('global-site-app');
  }, []);

  useEffect(() => {
    document.documentElement.lang = isEnglishPublic ? 'en' : 'zh-CN';
  }, [location.pathname]);

  useEffect(() => {
    if (isMobile && drawerOpen && collapsed) {
      setCollapsed(false);
    }
  }, [isMobile, drawerOpen, collapsed, setCollapsed]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!isMobile || !drawerOpen) return;
    const handleKey = (event) => {
      const opener = document.querySelector('.global-mobile-menu-button');
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrawerOpen(false);
        opener?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [opener, ...document.querySelectorAll('.app-sider--mobile a, .app-sider--mobile button, .app-sider--mobile summary')]
        .filter((item) => item && !item.disabled && item.getClientRects().length);
      if (!items.length) return;
      const current = items.indexOf(document.activeElement);
      event.preventDefault();
      const next = current < 0 ? 0 : (current + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isMobile, drawerOpen]);

  return (
    <Layout
      className={
        isMobile ? 'app-layout app-layout--mobile' : 'app-layout'
      }
    >
      <a className='global-skip-link' href='#main-content'>
        {GLOBAL_SKIP_TO_CONTENT_LABEL}
      </a>
      {isConsoleRoute && isMobile && (
        <button
          type='button'
          className='global-mobile-menu-button'
          aria-label={drawerOpen ? '关闭导航' : '打开导航'}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((prev) => !prev)}
        >
          {drawerOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      )}
      {isConsoleRoute && isMobile && drawerOpen && (
        <button
          type='button'
          className='global-mobile-menu-backdrop'
          tabIndex={-1}
          aria-label={GLOBAL_CLOSE_NAVIGATION_BACKDROP_LABEL}
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <Layout
        className={
          isMobile ? 'app-body app-body--mobile' : 'app-body'
        }
      >
        {showSider && (
          <Sider
            className={
              isMobile ? 'app-sider app-sider--mobile' : 'app-sider'
            }
          >
            <Suspense fallback={null}>
              <SiderBar
                onNavigate={() => {
                  if (isMobile) setDrawerOpen(false);
                }}
              />
            </Suspense>
          </Sider>
        )}
        <Layout
          className={
            isMobile || !showSider
              ? 'app-main'
              : 'app-main app-main--shifted'
          }
        >
          <Content
            id='main-content'
            className={
              isMobile
                ? 'app-content app-content--mobile'
                : isPublicChrome
                  ? 'app-content app-content--public'
                  : 'app-content'
            }
          >
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </Content>
        </Layout>
      </Layout>
    </Layout>
  );
};

export default PageLayout;
