import { describe, expect, it } from 'bun:test';
import { createInjectedWallet } from './injected.js';
import { createWalletSession, isUserRejectedSignature } from './session.js';

const OWNER = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada';
const AGENT = '0x9Fb2A80007047d249F5926960d870cD8aB5E7A4A';

function providerMock(accounts = [OWNER]) {
  const listeners = new Map();
  let current = accounts;
  return {
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return current;
      if (method === 'personal_sign') return '0xsigned';
      return null;
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    emit(event, value) {
      listeners.get(event)?.(value);
    },
    setAccounts(next) {
      current = next;
    },
  };
}

function walletFor(provider) {
  return createInjectedWallet({ getProvider: () => provider, target: new EventTarget() });
}

describe('wallet session', () => {
  it('tracks the connected account and follows accountsChanged', async () => {
    const provider = providerMock();
    const session = createWalletSession({ wallet: walletFor(provider) });
    const seen = [];
    session.subscribe((address) => seen.push(address));

    expect(session.getAddress()).toBeNull();
    expect(await session.connect()).toBe(OWNER);
    expect(session.getAddress()).toBe(OWNER);

    provider.setAccounts([AGENT]);
    provider.emit('accountsChanged', [AGENT]);
    expect(session.getAddress()).toBe(AGENT);

    provider.setAccounts([]);
    provider.emit('accountsChanged', []);
    expect(session.getAddress()).toBeNull();
    expect(seen).toEqual([OWNER, AGENT, null]);
  });

  it('ignores unchanged and malformed account changes', async () => {
    const provider = providerMock();
    const session = createWalletSession({ wallet: walletFor(provider) });
    const seen = [];
    session.subscribe((address) => seen.push(address));
    await session.connect();

    provider.emit('accountsChanged', [OWNER]);
    provider.emit('accountsChanged', ['not-an-address']);
    expect(seen).toEqual([OWNER]);
    expect(session.getAddress()).toBe(OWNER);
  });

  it('clears the account on disconnect', async () => {
    const provider = providerMock();
    const session = createWalletSession({ wallet: walletFor(provider) });
    await session.connect();
    await session.disconnect();
    expect(session.getAddress()).toBeNull();
  });

  it('rejects an invalid address without changing state or notifying', async () => {
    const provider = providerMock(['not-an-address']);
    const session = createWalletSession({ wallet: walletFor(provider) });
    const seen = [];
    session.subscribe((address) => seen.push(address));

    await expect(session.connect()).rejects.toThrow();
    expect(session.getAddress()).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe('signature rejection detection', () => {
  it('recognizes EIP-1193 code 4001 and rejection messages', () => {
    expect(isUserRejectedSignature({ code: 4001 })).toBe(true);
    expect(isUserRejectedSignature({ code: 4001, message: 'User rejected the request.' })).toBe(true);
    expect(isUserRejectedSignature(new Error('User denied message signature.'))).toBe(true);
    expect(isUserRejectedSignature({ code: -32603, message: 'internal error' })).toBe(false);
    expect(isUserRejectedSignature(null)).toBe(false);
    expect(isUserRejectedSignature('User rejected the request.')).toBe(false);
  });
});
