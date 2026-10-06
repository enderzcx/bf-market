import React from 'react';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import RecordsPage from './index';

describe('agent records page', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RecordsPage />
    </MemoryRouter>,
  );

  it('asks for a wallet address and reads records without a signature', () => {
    expect(html).toContain('class="records-page"');
    expect(html).toContain('Your records');
    expect(html).toContain('Wallet address');
    expect(html).toContain('View records');
    expect(html).toContain('read-only');
    expect(html).toContain('href="/market"');
    expect(html).toContain('class="global-public-header"');
    expect(html).toContain('class="global-public-footer"');
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
