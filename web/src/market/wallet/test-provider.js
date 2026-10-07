// BF Market local test wallet (EIP-1193 + EIP-6963).
//
// This module is ONLY for local e2e runs of the public market shell. It is
// kept out of production bundles by a literal dynamic-import guard in
// MarketRoot.jsx (`import.meta.env.VITE_BFM_TEST_WALLET` around a literal
// `import('./wallet/test-provider.js')`), and the installer below refuses a
// second layer of defense: it only installs on loopback hostnames and only
// when VITE_BFM_TEST_WALLET is set. Signing never happens in the page: every
// `personal_sign` is forwarded to the local dev-wallet-signer at
// http://127.0.0.1:4335, which holds the keys in its own process env.

export const TEST_WALLET_MARKER = 'bfm-test-wallet';
export const TEST_SIGNER_URL = 'http://127.0.0.1:4335';

const TEST_WALLET_UUID = 'bfm-test-wallet.local';
const TEST_WALLET_RDNS = 'app.bflabs.bfm-test-wallet';
const LOCAL_CHAIN_ID = '0x3c8'; // BOT Chain testnet, chain 968

// Deliberately allow only the two hostnames used by the local Worker. Everything
// else (including IPv6 loopback, localhost subdomains, DNS tricks and LAN
// addresses) is refused.
export function isLocalHostname(hostname) {
  if (typeof hostname !== 'string') return false;
  const host = hostname.trim().toLowerCase();
  return host === 'localhost' || host === '127.0.0.1';
}

function providerError(code, message) {
  return { code, message };
}

// Minimal EIP-1193 provider backed by the local signer. `personal_sign`
// params follow the de-facto standard `[hexMessage, address]` used by the
// market console pages.
export function createTestProvider(options = {}) {
  const signerUrl = options.signerUrl || TEST_SIGNER_URL;
  const testAccount = options.testAccount || 'owner';
  const chainId = options.chainId || LOCAL_CHAIN_ID;
  const fetchImpl = options.fetch || fetch;
  const accountUrl = `${signerUrl}/accounts?testAccount=${encodeURIComponent(testAccount)}`;
  const signUrl = `${signerUrl}/sign?testAccount=${encodeURIComponent(testAccount)}`;
  const listeners = new Map();

  const fetchAccounts = async () => {
    const response = await fetchImpl(accountUrl);
    if (!response.ok) {
      throw providerError(
        4900,
        `BF Market test wallet: signer ${signerUrl} is not reachable or has no "${testAccount}" account.`,
      );
    }
    const data = await response.json();
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    return accounts.filter((value) => typeof value === 'string');
  };

  const provider = {
    [TEST_WALLET_MARKER]: true,
    async request({ method, params = [] } = {}) {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return fetchAccounts();
      }
      if (method === 'eth_chainId') return chainId;
      if (method === 'personal_sign') {
        const [message, address] = params;
        if (typeof message !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(message)) {
          throw providerError(-32602, 'BF Market test wallet: personal_sign expects a hex message.');
        }
        if (address !== undefined) {
          const [own] = await fetchAccounts();
          if (own && address.toLowerCase() !== own.toLowerCase()) {
            throw providerError(
              -32602,
              'BF Market test wallet: personal_sign address does not match the selected test account.',
            );
          }
        }
        const response = await fetchImpl(signUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        if (!response.ok) {
          throw providerError(4900, `BF Market test wallet: signer ${signerUrl} rejected the sign request.`);
        }
        const data = await response.json();
        if (typeof data?.signature !== 'string') {
          throw providerError(4900, `BF Market test wallet: signer ${signerUrl} returned no signature.`);
        }
        return data.signature;
      }
      throw providerError(4200, `BF Market test wallet: ${method} is not supported.`);
    },
    on(event, handler) {
      if (typeof handler !== 'function') return () => {};
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
  };
  return provider;
}

export function testWalletInfo() {
  return {
    uuid: TEST_WALLET_UUID,
    name: `BF Market test wallet (${TEST_WALLET_MARKER})`,
    icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
    rdns: TEST_WALLET_RDNS,
  };
}

// Install the test provider. Refusal paths log one warning and leave the
// page untouched: never overwrite or unset window.ethereum when refusing.
// On loopback it sets window.ethereum only when absent (a real injected
// wallet stays first) and always announces itself over EIP-6963.
export function installTestWallet(options = {}) {
  const win = options.window ?? (typeof window === 'undefined' ? null : window);
  const env = options.env ?? import.meta.env ?? {};
  const warn = options.warn ?? console.warn;

  if (env.VITE_BFM_TEST_WALLET !== '1') {
    warn(
      `[${TEST_WALLET_MARKER}] VITE_BFM_TEST_WALLET is not "1"; not installing the test wallet.`,
    );
    return null;
  }
  if (!win?.location) {
    warn(`[${TEST_WALLET_MARKER}] no window available; not installing the test wallet.`);
    return null;
  }
  const hostname = win.location.hostname;
  if (!isLocalHostname(hostname)) {
    warn(
      `[${TEST_WALLET_MARKER}] refusing to install on non-local host ${hostname}; window.ethereum is left untouched.`,
    );
    return null;
  }

  const queryAccount = new URLSearchParams(win.location.search ?? '').get('testAccount');
  const testAccount =
    options.testAccount || (queryAccount === 'agent' || queryAccount === 'owner' ? queryAccount : 'owner');
  const provider = createTestProvider({ ...options, testAccount });
  const detail = { info: testWalletInfo(), provider };
  const announce = () => {
    const EventClass = win.CustomEvent ?? CustomEvent;
    if (!EventClass) return;
    win.dispatchEvent(new EventClass('eip6963:announceProvider', { detail }));
  };
  if (typeof win.addEventListener === 'function') {
    win.addEventListener('eip6963:requestProvider', announce);
  }
  announce();

  if (win.ethereum) {
    warn(
      `[${TEST_WALLET_MARKER}] window.ethereum already exists; keeping it and announcing the test wallet via EIP-6963 only.`,
    );
  } else {
    win.ethereum = provider;
  }
  return detail;
}
