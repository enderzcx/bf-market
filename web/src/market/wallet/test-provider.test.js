import { describe, expect, it } from 'bun:test';
import {
  TEST_SIGNER_URL,
  TEST_WALLET_MARKER,
  createTestProvider,
  installTestWallet,
  isLocalHostname,
  testWalletInfo,
} from './test-provider.js';

const HEX_MESSAGE = '0x' + Buffer.from('hello budget', 'utf8').toString('hex');
const OWNER = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada';

function fakeWindow(hostname = 'localhost', existingEthereum = undefined, search = '') {
  const listeners = new Map();
  const dispatched = [];
  const win = {
    location: { hostname, search },
    ethereum: existingEthereum,
    addEventListener(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
    },
    dispatchEvent(event) {
      dispatched.push(event);
      return true;
    },
  };
  return { win, dispatched, listeners };
}

function captureWarn() {
  const lines = [];
  return { warn: (line) => lines.push(String(line)), lines };
}

function refusingFetch() {
  return () => {
    throw new Error('fetch must not be called');
  };
}

describe('test wallet hostname guard', () => {
  it('accepts only loopback hostnames', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1']) {
      expect(isLocalHostname(host)).toBe(true);
    }
    for (const host of [
      'example.com',
      'market.bflabs.app',
      '::1',
      '[::1]',
      'market.localhost',
      '0.0.0.0',
      '127.0.0.2',
      '192.168.1.5',
      '127.0.0.1.nip.io',
      'localhost.evil.com',
      ' ',
      '',
      undefined,
      123,
    ]) {
      expect(isLocalHostname(host)).toBe(false);
    }
  });

  it('logs refusal and leaves window.ethereum untouched on non-local host', () => {
    const existing = { sentinel: 'existing-wallet' };
    const { win, dispatched } = fakeWindow('market.bflabs.app', existing);
    const { warn, lines } = captureWarn();
    const detail = installTestWallet({
      window: win,
      env: { VITE_BFM_TEST_WALLET: '1' },
      warn,
      fetch: refusingFetch(),
    });
    expect(detail).toBeNull();
    expect(win.ethereum).toBe(existing);
    expect(lines.join('\n')).toContain('refusing to install on non-local host market.bflabs.app');
    expect(dispatched).toHaveLength(0);
  });

  it('refuses without the build flag even on localhost', () => {
    const { win, dispatched } = fakeWindow('localhost');
    const { warn, lines } = captureWarn();
    const detail = installTestWallet({ window: win, env: {}, warn });
    expect(detail).toBeNull();
    expect(win.ethereum).toBeUndefined();
    expect(lines.join('\n')).toContain('VITE_BFM_TEST_WALLET is not "1"');
    expect(dispatched).toHaveLength(0);
  });

  it('requires the exact flag value 1', () => {
    const { win, dispatched } = fakeWindow('localhost');
    const { warn, lines } = captureWarn();
    const detail = installTestWallet({
      window: win,
      env: { VITE_BFM_TEST_WALLET: '0' },
      warn,
      fetch: refusingFetch(),
    });
    expect(detail).toBeNull();
    expect(win.ethereum).toBeUndefined();
    expect(lines.join('\n')).toContain('VITE_BFM_TEST_WALLET is not "1"');
    expect(dispatched).toHaveLength(0);
  });

  it('installs on localhost and announces over EIP-6963', () => {
    const { win, dispatched, listeners } = fakeWindow('localhost');
    const { warn, lines } = captureWarn();
    const detail = installTestWallet({
      window: win,
      env: { VITE_BFM_TEST_WALLET: '1' },
      warn,
      fetch: refusingFetch(),
    });
    expect(detail).not.toBeNull();
    expect(detail.info.name).toContain(TEST_WALLET_MARKER);
    expect(win.ethereum).toBe(detail.provider);
    const announcements = dispatched.filter((event) => event.type === 'eip6963:announceProvider');
    expect(announcements).toHaveLength(1);
    expect(announcements[0].detail).toBe(detail);
    // A later EIP-6963 requestProvider re-announces the same detail.
    for (const handler of listeners.get('eip6963:requestProvider') ?? []) handler();
    expect(dispatched.filter((event) => event.type === 'eip6963:announceProvider')).toHaveLength(2);
    expect(lines).toHaveLength(0);
  });

  it('keeps an existing window.ethereum and only announces on localhost', () => {
    const existing = { sentinel: 'real-wallet' };
    const { win, dispatched } = fakeWindow('localhost', existing);
    const { warn, lines } = captureWarn();
    const detail = installTestWallet({
      window: win,
      env: { VITE_BFM_TEST_WALLET: '1' },
      warn,
      fetch: refusingFetch(),
    });
    expect(detail).not.toBeNull();
    expect(win.ethereum).toBe(existing);
    expect(dispatched.some((event) => event.type === 'eip6963:announceProvider')).toBe(true);
    expect(lines.join('\n')).toContain('window.ethereum already exists');
  });

  it('selects the agent account from the local testAccount query parameter', async () => {
    const { win } = fakeWindow('127.0.0.1', undefined, '?testAccount=agent');
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ accounts: [OWNER] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const detail = installTestWallet({
      window: win,
      env: { VITE_BFM_TEST_WALLET: '1' },
      warn: () => {},
      fetch: fetchImpl,
    });
    expect(await detail.provider.request({ method: 'eth_requestAccounts' })).toEqual([OWNER]);
    expect(calls[0]).toBe(`${TEST_SIGNER_URL}/accounts?testAccount=agent`);
  });
});

describe('test provider EIP-1193 surface', () => {
  function recordingFetch() {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init: init ?? null });
      if (String(url).startsWith(`${TEST_SIGNER_URL}/accounts`)) {
        return new Response(JSON.stringify({ testAccount: 'owner', accounts: [OWNER] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).startsWith(`${TEST_SIGNER_URL}/sign`)) {
        return new Response(JSON.stringify({ testAccount: 'owner', signature: '0xsig' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    };
    return { calls, fetchImpl };
  }

  it('forwards personal_sign to the local signer with the test account', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const provider = createTestProvider({ testAccount: 'agent', fetch: fetchImpl });
    const signature = await provider.request({
      method: 'personal_sign',
      params: [HEX_MESSAGE, OWNER],
    });
    expect(signature).toBe('0xsig');
    expect(calls[0].url).toBe(`${TEST_SIGNER_URL}/accounts?testAccount=agent`);
    expect(calls[1].url).toBe(`${TEST_SIGNER_URL}/sign?testAccount=agent`);
    expect(calls[1].init.method).toBe('POST');
    expect(JSON.parse(calls[1].init.body)).toEqual({ message: HEX_MESSAGE });
  });

  it('serves accounts and chainId and rejects unsupported methods', async () => {
    const { fetchImpl } = recordingFetch();
    const provider = createTestProvider({ fetch: fetchImpl });
    expect(await provider.request({ method: 'eth_requestAccounts' })).toEqual([OWNER]);
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([OWNER]);
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x3c8');
    await expect(provider.request({ method: 'eth_sendTransaction' })).rejects.toMatchObject({
      code: 4200,
    });
  });

  it('rejects malformed messages and mismatched signer addresses', async () => {
    const { fetchImpl } = recordingFetch();
    const provider = createTestProvider({ fetch: fetchImpl });
    await expect(
      provider.request({ method: 'personal_sign', params: ['nothex', OWNER] }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      provider.request({
        method: 'personal_sign',
        params: [HEX_MESSAGE, '0x0000000000000000000000000000000000000000'],
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('reports an unreachable signer as a provider error', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: 'down' }), { status: 503 });
    const provider = createTestProvider({ fetch: fetchImpl });
    await expect(provider.request({ method: 'eth_requestAccounts' })).rejects.toMatchObject({
      code: 4900,
    });
  });

  it('exposes stable EIP-6963 wallet info carrying the scan marker', () => {
    const info = testWalletInfo();
    expect(info.rdns).toContain(TEST_WALLET_MARKER);
    expect(info.name).toContain(TEST_WALLET_MARKER);
  });

  it('switches the active test account and announces accountsChanged', async () => {
    const AGENT = '0x9Fb2A80007047d249F5926960d870cD8aB5E7A4A';
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      const account = String(url).includes('testAccount=agent') ? AGENT : OWNER;
      return new Response(JSON.stringify({ accounts: [account] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = createTestProvider({ testAccount: 'owner', fetch: fetchImpl });
    const events = [];
    provider.on('accountsChanged', (accounts) => events.push(accounts));

    expect(provider.currentAccount()).toBe('owner');
    await provider.switchAccount('agent');

    expect(provider.currentAccount()).toBe('agent');
    expect(events).toEqual([[AGENT]]);
    expect(calls.at(-1)).toBe(`${TEST_SIGNER_URL}/accounts?testAccount=agent`);
  });
});
