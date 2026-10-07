import { budgetChallengeKey } from '../pages/wallet-model.js';
import { isUserRejectedSignature } from './session.js';

// A budget challenge is keyed by scope, signer and wallet on the backend.
// Lock matching controls until submit or signature failure to prevent one
// challenge overwriting another before the first is submitted.
export function createBudgetChangeGate() {
  const busyKeys = new Set();

  return {
    acquire(intent) {
      const key = budgetChallengeKey(intent);
      if (busyKeys.has(key)) return null;
      busyKeys.add(key);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        busyKeys.delete(key);
      };
    },
    isBusy(intent) {
      return busyKeys.has(budgetChallengeKey(intent));
    },
  };
}

// One budget change = challenge -> personal_sign -> submit. Extracted from the
// React component so the signing path is testable and the signer address is
// always the one declared in the request body: if accountsChanged fires between
// the challenge and the signature, the challenge intent and the recovered
// signer stay in sync.
//
// Returns { ok: true, signature } or { ok: false, kind, error } where `kind` is
// one of 'missing-session' | 'challenge' | 'signature-rejected' | 'signature' |
// 'submit'.
export async function submitBudgetChange({ session, body, signer, postChallenge, postSubmit }) {
  if (!session || typeof session.signMessage !== 'function') {
    return { ok: false, kind: 'missing-session', error: null };
  }

  let challenge;
  try {
    challenge = await postChallenge(body);
  } catch (error) {
    return { ok: false, kind: 'challenge', error };
  }

  let signature;
  try {
    signature = await session.signMessage(challenge?.message, signer);
  } catch (error) {
    return {
      ok: false,
      kind: isUserRejectedSignature(error) ? 'signature-rejected' : 'signature',
      error,
    };
  }

  try {
    await postSubmit({ ...body, signature });
  } catch (error) {
    return { ok: false, kind: 'submit', error };
  }

  return { ok: true, signature };
}
