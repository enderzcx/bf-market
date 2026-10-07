const EIP6963_ANNOUNCE = 'eip6963:announceProvider';
const EIP6963_REQUEST = 'eip6963:requestProvider';

function toUtf8Hex(message) {
  const bytes = new TextEncoder().encode(String(message));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createInjectedWallet({ getProvider, target = window, discoveryMs = 80 }) {
  const providers = new Map();
  const accountListeners = new Set();
  let selected = null;
  let selectedAccountsListener = null;

  const rememberProvider = (event) => {
    const detail = event?.detail;
    if (!detail?.info?.uuid || !detail?.provider?.request) return;
    providers.set(detail.info.uuid, {
      info: detail.info,
      provider: detail.provider,
    });
  };

  const useProvider = (providerOrId) => {
    if (typeof providerOrId === 'string') {
      const entry = providers.get(providerOrId);
      if (providerOrId === 'injected-default') {
        const fallback = getProvider?.();
        if (fallback?.request) return fallback;
      }
      if (!entry) throw new Error('The selected wallet is no longer available.');
      return entry.provider;
    }
    if (providerOrId?.request) return providerOrId;
    const fallback = getProvider?.();
    if (!fallback?.request) throw new Error('No browser wallet was found.');
    return fallback;
  };

  const setSelected = (provider) => {
    if (selected && selectedAccountsListener && selected.removeListener) {
      selected.removeListener('accountsChanged', selectedAccountsListener);
    }
    selected = provider;
    selectedAccountsListener = (accounts) => {
      for (const listener of accountListeners) listener(accounts);
    };
    selected.on?.('accountsChanged', selectedAccountsListener);
    return provider;
  };

  target.addEventListener(EIP6963_ANNOUNCE, rememberProvider);

  return {
    async discover() {
      target.addEventListener(EIP6963_ANNOUNCE, rememberProvider);
      target.dispatchEvent(new Event(EIP6963_REQUEST));
      await new Promise((resolve) => setTimeout(resolve, discoveryMs));
      const entries = [...providers.values()];
      const fallback = getProvider?.();
      if (fallback?.request && !entries.some((entry) => entry.provider === fallback)) {
        entries.unshift({
          info: {
            uuid: 'injected-default',
            name: fallback.isMetaMask ? 'MetaMask' : 'Browser wallet',
            icon: '',
            rdns: 'injected.default',
          },
          provider: fallback,
        });
      }
      return entries.map(({ info }) => ({ ...info }));
    },

    async connect(providerId) {
      const provider = setSelected(useProvider(providerId));
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') {
        throw new Error('The wallet did not return an account.');
      }
      return accounts[0];
    },

    async signMessage(message, address) {
      const provider = selected ?? setSelected(useProvider());
      return provider.request({
        method: 'personal_sign',
        params: [toUtf8Hex(message), address],
      });
    },

    onAccountsChanged(listener) {
      accountListeners.add(listener);
      return () => accountListeners.delete(listener);
    },

    getSelectedProvider() {
      return selected;
    },
  };
}

export { toUtf8Hex };
