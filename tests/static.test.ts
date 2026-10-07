import { expect, test } from 'bun:test';
import { staticFileFor } from '../src/static.ts';

test('SPA page refreshes resolve while API and removed product routes do not', () => {
  for (const path of [
    '/',
    '/login',
    '/register',
    '/reset',
    '/console',
    '/console/orders',
    '/console/settlements',
    '/console/wallet',
    '/docs',
    '/progress',
    '/progress-lab',
    '/partner',
    '/partner/login',
    '/partner/docs',
    '/partner/progress',
    '/partner/console/orders',
    '/partner/register',
    '/partner/reset',
    '/wallet',
    '/wallet/0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada',
  ]) {
    expect(staticFileFor(path)?.file).toBe('index.html');
  }
  for (const path of [
    '/api/state',
    '/api/unknown',
    '/console/token',
    '/console/topup',
    '/pricing',
    '/missing',
    '/wallet/0xZZ',
  ]) {
    expect(staticFileFor(path)).toBeNull();
  }
});

test('built assets are constrained to public types and safe relative paths', () => {
  expect(staticFileFor('/assets/index-AbC12.js')?.type).toContain('javascript');
  expect(staticFileFor('/assets/index-AbC12.css')?.type).toContain('text/css');
  expect(staticFileFor('/fonts/schibsted-latin.woff2')?.type).toBe('font/woff2');
  expect(staticFileFor('/images/partner/receipt.webp')?.type).toBe('image/webp');
  expect(staticFileFor('/global/console-preview.png')?.type).toBe('image/png');
  expect(staticFileFor('/fonts/schibsted-OFL.txt')?.type).toContain('text/plain');
  for (const path of ['/assets/../secret.js', '/assets/%2e%2e/secret.js', '/assets/%2fsecret.js', '/assets/index.js.map', '/assets/.env', '/src/server.ts', '/assets/source.ts', '/assets/dir\\secret.js']) {
    expect(staticFileFor(path)).toBeNull();
  }
});

test('public demo is an exact allowlisted document', () => {
  expect(staticFileFor('/demo')?.file).toBe('demo.html');
  for (const path of ['/demo.html', '/demo/../secrets', '/demo%2f..%2fsecrets']) expect(staticFileFor(path)).toBeNull();
});
