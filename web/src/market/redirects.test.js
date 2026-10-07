import { describe, expect, it } from 'bun:test';
import { resolveLegacyRedirect } from './redirects.js';

describe('legacy public route redirects', () => {
  it.each([
    ['/login', '/partner/login'],
    ['/register', '/partner/login'],
    ['/reset', '/partner/login'],
    ['/console', '/partner/console'],
    ['/console/orders', '/partner/console/orders'],
    ['/console/settlements', '/partner/console/settlements'],
    ['/console/wallet', '/partner/console/wallet'],
    ['/progress', '/partner/progress'],
    ['/progress-lab', '/partner/progress-lab'],
    ['/partner/register', '/partner/login'],
    ['/partner/reset', '/partner/login'],
  ])('redirects %s to %s and retains search/hash', (pathname, target) => {
    expect(resolveLegacyRedirect({ pathname, search: '?q=1', hash: '#section' })).toBe(
      `${target}?q=1#section`,
    );
  });

  it('moves payer record links to the public wallet view', () => {
    const address = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada';
    expect(
      resolveLegacyRedirect({
        pathname: '/records',
        search: `?payer=${address}&limit=5`,
        hash: '#recent',
      }),
    ).toBe(`/wallet/${address}?payer=${address}&limit=5#recent`);
    expect(resolveLegacyRedirect({ pathname: '/records', search: '?limit=5', hash: '' })).toBe(
      '/wallet?limit=5',
    );
  });

  it('leaves public routes without a legacy mapping alone', () => {
    expect(resolveLegacyRedirect({ pathname: '/', search: '', hash: '' })).toBeNull();
    expect(resolveLegacyRedirect({ pathname: '/market', search: '', hash: '' })).toBeNull();
    expect(resolveLegacyRedirect({ pathname: '/wallet', search: '', hash: '' })).toBeNull();
  });
});
