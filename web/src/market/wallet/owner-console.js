import { fetchJson } from './http.js';

// Data for the connected-owner console: GET /api/owners/:address/agents plus the
// connected wallet's summary. Kept framework-free so the accountsChanged
// transition is testable without a DOM, and so a slower response for a previous
// account can never overwrite the console after a switch.
//
// State:
//   account        the connected address, or null when not connected
//   loadedAccount  the address the current data was loaded for
//   ownerData      GET /api/owners/:address/agents payload
//   summary        GET /api/wallets/:address/summary payload
//   loading        the console should show its loading state instead of data
//   failed         the last load for the current account failed
export function createOwnerConsoleStore({ fetchImpl = fetch } = {}) {
  let state = {
    account: null,
    loadedAccount: null,
    ownerData: null,
    summary: null,
    loading: true,
    failed: false,
  };
  const listeners = new Set();
  let controller = null;
  let inflightAccount = null;
  let token = 0;

  const emit = () => {
    for (const listener of [...listeners]) listener(state);
  };

  const update = (patch) => {
    state = { ...state, ...patch };
    emit();
  };

  const abort = () => {
    inflightAccount = null;
    if (controller) {
      controller.abort();
      controller = null;
    }
  };

  const clear = (patch = {}) => {
    update({
      loadedAccount: null,
      ownerData: null,
      summary: null,
      failed: false,
      ...patch,
    });
  };

  const load = (account) => {
    const current = ++token;
    abort();
    controller = new AbortController();
    inflightAccount = account;
    const { signal } = controller;
    return Promise.all([
      fetchJson(`/api/owners/${encodeURIComponent(account)}/agents`, { signal }, fetchImpl),
      fetchJson(`/api/wallets/${encodeURIComponent(account)}/summary`, { signal }, fetchImpl),
    ])
      .then(([ownerData, summary]) => {
        if (current !== token || signal.aborted) return;
        inflightAccount = null;
        update({ account, loadedAccount: account, ownerData, summary, loading: false, failed: false });
      })
      .catch((error) => {
        if (current !== token || signal.aborted || error?.name === 'AbortError') return;
        inflightAccount = null;
        update({ failed: true, loading: false });
      });
  };

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAccount(account) {
      if (account == null) {
        token += 1;
        abort();
        clear({ account: null, loading: false });
        return Promise.resolve();
      }
      if (account === state.account && (inflightAccount === account || state.ownerData)) {
        return Promise.resolve();
      }
      clear({ account, loading: true });
      return load(account);
    },
    // Reload for the current account without dropping the rows already on
    // screen; used after a budget change.
    refresh() {
      if (state.account == null) return Promise.resolve();
      update({ failed: false });
      return load(state.account);
    },
    destroy() {
      token += 1;
      abort();
      listeners.clear();
    },
  };
}
