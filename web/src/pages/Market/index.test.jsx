import React from 'react';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import MarketPage from './index';

describe('agent market page', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <MarketPage />
    </MemoryRouter>,
  );

  it('renders the two entry cards and the records link in English', () => {
    expect(html).toContain('class="market-page"');
    expect(html).toContain('class="market-hero"');
    expect(html).toContain('class="market-entries"');
    expect(html).toContain('Use with an agent');
    expect(html).toContain('Browse services');
    expect(html).toContain('Agent commerce,');
    expect(html).toContain('class="global-public-header"');
    expect(html).toContain('class="global-public-footer"');
  });

  it('links to the skill file, MCP config and records without internal names', () => {
    expect(html).toContain('href="/skill.md"');
    expect(html).toContain('href="/records"');
    expect(html).toContain('/mcp');
    expect(html).toContain('bf-market');
    expect(html).toContain('href="/market"');
    // Every word an agent or visitor reads is English.
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
