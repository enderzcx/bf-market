import { describe, expect, it } from 'bun:test';
import { createInjectedWallet } from './injected.js';
import { createOwnerConsoleStore } from './owner-console.js';
import { createWalletSession } from './session.js';

const BUYER_DEMO = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada';
const AGENT_WALLET = '0xeD0c5d27b51839FE943f2FB5789921d5120D427c';

// Minimal EIP-1193 provider, same shape as the one used by session.test.js.
function providerMock(accounts = [BUYER_DEMO]) {
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

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Serves the console's two reads (owner agents + wallet summary) and records
// every requested path so a test can assert which owner was loaded.
function consoleFetch({ owners = {}, summaries = {} } = {}) {
  const requests = [];
  const fetchImpl = async (path) => {
    requests.push(path);
    const ownerMatch = /^\/api\/owners\/([^/]+)\/agents$/.exec(path);
    if (ownerMatch) {
      const address = decodeURIComponent(ownerMatch[1]);
      return jsonResponse(owners[address] ?? { agents: [], transferredAway: [] });
    }
    const summaryMatch = /^\/api\/wallets\/([^/]+)\/summary$/.exec(path);
    if (summaryMatch) {
      const address = decodeURIComponent(summaryMatch[1]);
      return jsonResponse(summaries[address] ?? { wallet: address, day: '2026-10-07' });
    }
    return new Response('not found', { status: 404 });
  };
  return { requests, fetchImpl };
}

function waitForState(store, predicate) {
  if (predicate(store.getState())) return Promise.resolve(store.getState());
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe((state) => {
      if (!predicate(state)) return;
      unsubscribe();
      resolve(state);
    });
  });
}

const OWNERS = {
  [BUYER_DEMO]: { agents: [{ agentId: '0', agentWallet: BUYER_DEMO }], transferredAway: [] },
  [AGENT_WALLET]: { agents: [{ agentId: '2', agentWallet: AGENT_WALLET }], transferredAway: [] },
};

// WalletPage wires the connected address straight into the console store
// (session.subscribe -> store.setAccount). Driving both here exercises the same
// code path the page uses, with a fake EIP-1193 provider and no DOM.
function connectedConsole() {
  const provider = providerMock();
  const wallet = createInjectedWallet({ getProvider: () => provider, target: new EventTarget() });
  const session = createWalletSession({ wallet });
  const { requests, fetchImpl } = consoleFetch({ owners: OWNERS });
  const store = createOwnerConsoleStore({ fetchImpl });
  session.subscribe((address) => {
    void store.setAccount(address);
  });
  return { provider, session, store, requests };
}

describe('connected owner console', () => {
  it('follows accountsChanged to a new owner and back to not connected', async () => {
    const { provider, session, store, requests } = connectedConsole();
    expect(session.getAddress()).toBeNull();

    await session.connect();
    await waitForState(store, (state) => state.loadedAccount === BUYER_DEMO);

    expect(session.getAddress()).toBe(BUYER_DEMO);
    expect(store.getState().account).toBe(BUYER_DEMO);
    expect(store.getState().ownerData).toEqual(OWNERS[BUYER_DEMO]);
    expect(requests).toContain(`/api/owners/${BUYER_DEMO}/agents`);

    const requestsBeforeSwitch = requests.length;
    provider.setAccounts([AGENT_WALLET]);
    provider.emit('accountsChanged', [AGENT_WALLET]);

    // The connected address becomes the new account...
    expect(session.getAddress()).toBe(AGENT_WALLET);
    expect(store.getState().account).toBe(AGENT_WALLET);
    // ...the previous owner's agents are dropped instead of shown under the new
    // address...
    expect(store.getState().ownerData).toBeNull();
    // ...and the new owner's agents are fetched.
    expect(requests).toContain(`/api/owners/${AGENT_WALLET}/agents`);
    expect(requests.length).toBeGreaterThan(requestsBeforeSwitch);

    await waitForState(store, (state) => state.loadedAccount === AGENT_WALLET);
    expect(store.getState().ownerData).toEqual(OWNERS[AGENT_WALLET]);

    const requestsBeforeDisconnect = requests.length;
    provider.setAccounts([]);
    provider.emit('accountsChanged', []);

    // accountsChanged([]) is the not-connected state: the page stops rendering
    // the console and the store holds no owner data.
    expect(session.getAddress()).toBeNull();
    expect(store.getState().account).toBeNull();
    expect(store.getState().ownerData).toBeNull();
    expect(store.getState().summary).toBeNull();
    expect(store.getState().loading).toBe(false);
    expect(requests.length).toBe(requestsBeforeDisconnect);
  });

  it('keeps the current agents visible while a same-owner refresh runs', async () => {
    const { session, store } = connectedConsole();

    await session.connect();
    await waitForState(store, (state) => state.loadedAccount === BUYER_DEMO);

    const refresh = store.refresh();
    expect(store.getState().ownerData).toEqual(OWNERS[BUYER_DEMO]);
    await refresh;
    expect(store.getState().ownerData).toEqual(OWNERS[BUYER_DEMO]);
    expect(store.getState().loadedAccount).toBe(BUYER_DEMO);
  });

  it('ignores a slow response for an account that is no longer connected', async () => {
    const provider = providerMock();
    const wallet = createInjectedWallet({ getProvider: () => provider, target: new EventTarget() });
    const session = createWalletSession({ wallet });
    const pending = [];
    const fetchImpl = (path) =>
      new Promise((resolve) => {
        pending.push({ path, resolve });
      });
    const store = createOwnerConsoleStore({ fetchImpl });
    session.subscribe((address) => {
      void store.setAccount(address);
    });

    await session.connect();
    provider.setAccounts([AGENT_WALLET]);
    provider.emit('accountsChanged', [AGENT_WALLET]);
    expect(store.getState().account).toBe(AGENT_WALLET);

    // The buyer-demo responses arrive after the switch and must not resurface.
    for (const entry of pending) {
      if (entry.path.includes(BUYER_DEMO)) entry.resolve(jsonResponse(OWNERS[BUYER_DEMO]));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getState().ownerData).toBeNull();
    expect(store.getState().account).toBe(AGENT_WALLET);
  });
});
