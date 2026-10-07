import { isWalletAddress } from '../pages/wallet-model.js';

// EIP-1193 providers signal a user-cancelled signature with code 4001; some
// wallets wrap it in `data.code` or use the ethers ACTION_REJECTED string.
export function isUserRejectedSignature(error) {
  if (error == null || typeof error !== 'object') return false;
  const code = error.code ?? error.data?.code ?? error.cause?.code;
  if (code === 4001 || code === 'ACTION_REJECTED' || code === 'USER_REJECTED') return true;
  const message = String(error.message ?? error.data?.message ?? '');
  return /user (rejected|denied)|rejected the request|signature (request )?(was )?(rejected|denied)|declined/i.test(
    message,
  );
}

// Session state for the connected owner console. Kept framework-free so the
// accountsChanged transition can be unit-tested without a DOM.
export function createWalletSession({ wallet }) {
  let address = null;
  const listeners = new Set();

  const notify = () => {
    for (const listener of [...listeners]) listener(address);
  };

  const unsubscribe = wallet.onAccountsChanged((accounts) => {
    if (!Array.isArray(accounts)) return;
    const candidate = accounts.find((value) => typeof value === 'string');
    // An empty list means the wallet disconnected; an unrecognized entry is
    // ignored so a malformed event cannot wipe a valid session.
    const next = candidate == null ? null : isWalletAddress(candidate) ? candidate : address;
    if ((next ?? '').toLowerCase() === (address ?? '').toLowerCase()) return;
    address = next;
    notify();
  });

  return {
    getAddress() {
      return address;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      unsubscribe?.();
      listeners.clear();
    },
    discover() {
      return wallet.discover();
    },
    async connect(providerId) {
      const account = await wallet.connect(providerId);
      // Validate before touching state: an invalid provider response must not
      // persist an address or notify subscribers.
      if (!isWalletAddress(account)) {
        throw new Error('The wallet returned an invalid address.');
      }
      address = account;
      notify();
      return address;
    },
    async disconnect() {
      address = null;
      notify();
    },
    signMessage(message, signer) {
      return wallet.signMessage(message, signer ?? address);
    },
  };
}
