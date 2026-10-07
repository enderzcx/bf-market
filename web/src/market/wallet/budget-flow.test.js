import { describe, expect, it } from 'bun:test';
import { createBudgetChangeGate, submitBudgetChange } from './budget-flow.js';

const OWNER = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada';
const WALLET = '0x1111111111111111111111111111111111111111';
const BODY = { scope: 'ceiling', wallet: WALLET, signer: OWNER, agentId: '7', dailyLimit: '50000' };

function recordingSession(signature = '0xsig') {
  const calls = [];
  return {
    calls,
    session: {
      async signMessage(message, signer) {
        calls.push({ message, signer });
        return signature;
      },
    },
  };
}

describe('budget change flow', () => {
  it('prevents simultaneous challenges that share scope, signer and wallet', () => {
    const gate = createBudgetChangeGate();
    const first = gate.acquire({ mode: 'ceiling', wallet: WALLET, signer: OWNER, agentId: '2' });

    expect(typeof first).toBe('function');
    expect(gate.isBusy({ mode: 'ceiling', wallet: WALLET, signer: OWNER, agentId: '2' })).toBe(true);
    expect(gate.acquire({ mode: 'ceiling', wallet: WALLET, signer: OWNER, agentId: '9' })).toBeNull();
    expect(typeof gate.acquire({ mode: 'own', wallet: WALLET, signer: OWNER })).toBe('function');

    first();
    expect(gate.isBusy({ mode: 'ceiling', wallet: WALLET, signer: OWNER })).toBe(false);
    expect(typeof gate.acquire({ mode: 'ceiling', wallet: WALLET, signer: OWNER, agentId: '9' })).toBe(
      'function',
    );
  });

  it('signs the challenge message with the declared signer and submits it', async () => {
    const { calls, session } = recordingSession();
    const order = [];
    const result = await submitBudgetChange({
      session,
      body: BODY,
      signer: OWNER,
      postChallenge: async (body) => {
        order.push(['challenge', body]);
        return { message: 'BF Market daily budget change\n...' };
      },
      postSubmit: async (body) => {
        order.push(['submit', body]);
        return {};
      },
    });

    expect(result.ok).toBe(true);
    expect(order[0]).toEqual(['challenge', BODY]);
    expect(calls).toEqual([{ message: 'BF Market daily budget change\n...', signer: OWNER }]);
    expect(order[1]).toEqual(['submit', { ...BODY, signature: '0xsig' }]);
  });

  it('fails without a session instead of reaching the challenge or submit endpoints', async () => {
    let challenged = false;
    let submitted = false;
    const result = await submitBudgetChange({
      session: undefined,
      body: BODY,
      signer: OWNER,
      postChallenge: async () => {
        challenged = true;
        return { message: 'M' };
      },
      postSubmit: async () => {
        submitted = true;
        return {};
      },
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('missing-session');
    expect(challenged).toBe(false);
    expect(submitted).toBe(false);
  });

  it('reports a cancelled signature without submitting', async () => {
    let submitted = false;
    const result = await submitBudgetChange({
      session: {
        signMessage: async () => {
          throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        },
      },
      body: BODY,
      signer: OWNER,
      postChallenge: async () => ({ message: 'M' }),
      postSubmit: async () => {
        submitted = true;
        return {};
      },
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('signature-rejected');
    expect(submitted).toBe(false);
  });

  it('reports challenge, signature and submit failures with their kind', async () => {
    const challengeError = await submitBudgetChange({
      session: { signMessage: async () => '0xsig' },
      body: BODY,
      signer: OWNER,
      postChallenge: async () => {
        throw new Error('Request a challenge first.');
      },
      postSubmit: async () => ({}),
    });
    expect(challengeError).toMatchObject({ ok: false, kind: 'challenge' });

    const signatureError = await submitBudgetChange({
      session: {
        signMessage: async () => {
          throw new Error('hardware failure');
        },
      },
      body: BODY,
      signer: OWNER,
      postChallenge: async () => ({ message: 'M' }),
      postSubmit: async () => ({}),
    });
    expect(signatureError).toMatchObject({ ok: false, kind: 'signature' });

    const submitError = await submitBudgetChange({
      session: { signMessage: async () => '0xsig' },
      body: BODY,
      signer: OWNER,
      postChallenge: async () => ({ message: 'M' }),
      postSubmit: async () => {
        throw new Error('The signer is not allowed to set this budget.');
      },
    });
    expect(submitError).toMatchObject({ ok: false, kind: 'submit' });
    expect(submitError.error.message).toBe('The signer is not allowed to set this budget.');
  });
});
