import { describe, expect, it } from 'bun:test';
import { createInjectedWallet, toUtf8Hex } from './injected.js';

function providerMock() {
  const listeners = new Map();
  const calls = [];
  return {
    calls,
    request: async (request) => {
      calls.push(request);
      if (request.method === 'eth_requestAccounts') return ['0x123'];
      if (request.method === 'personal_sign') return '0xsigned';
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
  };
}

describe('injected wallet', () => {
  it('encodes the full UTF-8 message as hex for personal_sign', () => {
    expect(toUtf8Hex('Hello 钱包')).toBe('0x48656c6c6f20e992b1e58c85');
  });

  it('connects through eth_requestAccounts and signs hex UTF-8 with personal_sign', async () => {
    const provider = providerMock();
    const target = new EventTarget();
    const wallet = createInjectedWallet({
      getProvider: () => provider,
      target,
    });
    expect(await wallet.connect()).toBe('0x123');
    expect(await wallet.signMessage('budget', '0x123')).toBe('0xsigned');
    expect(provider.calls).toEqual([
      { method: 'eth_requestAccounts' },
      { method: 'personal_sign', params: ['0x627564676574', '0x123'] },
    ]);
  });

  it('discovers EIP-6963 wallets and forwards account changes', async () => {
    const target = new EventTarget();
    const first = providerMock();
    const second = providerMock();
    target.addEventListener('eip6963:requestProvider', () => {
      target.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { uuid: 'wallet-2', name: 'Wallet Two', icon: '', rdns: 'wallet.two' },
            provider: second,
          },
        }),
      );
      target.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { uuid: 'wallet-1', name: 'Wallet One', icon: '', rdns: 'wallet.one' },
            provider: first,
          },
        }),
      );
    });
    const wallet = createInjectedWallet({ getProvider: () => null, target, discoveryMs: 0 });
    expect(await wallet.discover()).toEqual([
      { uuid: 'wallet-2', name: 'Wallet Two', icon: '', rdns: 'wallet.two' },
      { uuid: 'wallet-1', name: 'Wallet One', icon: '', rdns: 'wallet.one' },
    ]);
    expect(await wallet.connect('wallet-2')).toBe('0x123');

    const changed = [];
    wallet.onAccountsChanged((accounts) => changed.push(accounts));
    second.emit('accountsChanged', ['0x456']);
    expect(changed).toEqual([['0x456']]);
  });
});
