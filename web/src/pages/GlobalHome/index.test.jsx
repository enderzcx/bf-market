import React from 'react';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import GlobalHome from './index';

describe('partner public home', () => {
  it('keeps the overseas homepage composition and commission copy', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <GlobalHome />
      </MemoryRouter>,
    );

    expect(html).toContain('服务商伙伴中心');
    expect(html).toContain('链上佣金结算');
    expect(html).toContain('BeefAPI 是首个测试接入案例');
    expect(html).toContain('已完成案例');
    expect(html).toContain('class="global-home-hero"');
    expect(html).toContain('class="global-home-receipt-object"');
    expect(html).toContain('class="global-home-router-panel"');
    expect(html).toContain('class="global-home-rates"');
    expect(html).toContain('class="global-home-shot"');
    expect(html).toContain('/global/console-preview.png');
    expect(html).toContain('class="global-public-header"');
    expect(html).toContain('class="global-public-footer"');
    expect(html).toContain('href="/partner/docs"');
    expect(html).toContain('href="/partner/login"');
    expect(html).toContain('href="/partner/console"');
    expect(html).not.toContain('JSON-tool');
    expect(html).not.toContain('自助注册');
    expect(html).not.toContain('app-shell');
  });
});
