const LEGACY_ROUTES = {
  '/login': '/partner/login',
  '/register': '/partner/login',
  '/reset': '/partner/login',
  '/console': '/partner/console',
  '/console/orders': '/partner/console/orders',
  '/console/settlements': '/partner/console/settlements',
  '/console/wallet': '/partner/console/wallet',
  '/progress': '/partner/progress',
  '/progress-lab': '/partner/progress-lab',
  '/partner/register': '/partner/login',
  '/partner/reset': '/partner/login',
};

const WALLET_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function resolveLegacyRedirect({ pathname, search = '', hash = '' }) {
  let target = LEGACY_ROUTES[pathname];
  if (pathname === '/records') {
    const payer = new URLSearchParams(search).get('payer');
    target = payer && WALLET_ADDRESS.test(payer) ? `/wallet/${payer}` : '/wallet';
  }
  if (!target) return null;
  return `${target}${search}${hash}`;
}
