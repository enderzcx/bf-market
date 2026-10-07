import { afterEach, describe, expect, it } from 'bun:test';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DEV_WALLET_SIGNER_HOST,
  createDevWalletSignerHandler,
  isLocalOrigin,
  loadSignerAccounts,
  startDevWalletSigner,
  type DevWalletServer,
} from '../scripts/dev-wallet-signer.ts';

// Deterministic throwaway keys, never a real secret: 0x01..01 / 0x02..02.
const OWNER_KEY = `0x${'1'.repeat(64)}` as `0x${string}`;
const AGENT_KEY = `0x${'2'.repeat(64)}` as `0x${string}`;
const owner = privateKeyToAccount(OWNER_KEY);
const agent = privateKeyToAccount(AGENT_KEY);
const hexMessage = '0x' + Buffer.from('wallet-budget challenge', 'utf8').toString('hex');

const servers: DevWalletServer[] = [];

function start(
  env: Record<string, string | undefined>,
  log?: (line: string) => void,
): string {
  const server = startDevWalletSigner({ env, port: 0, log });
  servers.push(server);
  return `http://${DEV_WALLET_SIGNER_HOST}:${server.port}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe('dev wallet signer config', () => {
  it('loads accounts from env and never reports key material', () => {
    const accounts = loadSignerAccounts({ OWNER_PRIVATE_KEY: OWNER_KEY, AGENT_PRIVATE_KEY: AGENT_KEY });
    expect(accounts.owner?.address).toBe(owner.address);
    expect(accounts.agent?.address).toBe(agent.address);
    expect(JSON.stringify(accounts)).not.toContain(OWNER_KEY);
    expect(JSON.stringify(accounts)).not.toContain(AGENT_KEY);
  });

  it('aborts on malformed keys without echoing them', () => {
    const badKey = 'not-a-key';
    expect(() => loadSignerAccounts({ OWNER_PRIVATE_KEY: badKey })).toThrow(/OWNER_PRIVATE_KEY/);
    try {
      loadSignerAccounts({ OWNER_PRIVATE_KEY: badKey });
    } catch (error) {
      expect((error as Error).message).not.toContain(badKey);
    }
  });

  it('refuses to start with no accounts', () => {
    expect(() => loadSignerAccounts({})).toThrow(/No test accounts configured/);
  });

  it('accepts only loopback origins', () => {
    expect(isLocalOrigin('http://localhost:4333')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1:4333')).toBe(true);
    expect(isLocalOrigin('http://localhost:4321')).toBe(false);
    expect(isLocalOrigin('http://[::1]:4321')).toBe(false);
    expect(isLocalOrigin('http://market.localhost:4321')).toBe(false);
    expect(isLocalOrigin('https://market.bflabs.app')).toBe(false);
    expect(isLocalOrigin('http://127.0.0.1.nip.io:4321')).toBe(false);
    expect(isLocalOrigin('not a url')).toBe(false);
  });

  it('uses only the designated signer port outside ephemeral test servers', () => {
    expect(() =>
      startDevWalletSigner({ env: { OWNER_PRIVATE_KEY: OWNER_KEY }, port: 4336 }),
    ).toThrow('The dev wallet signer only runs on port 4335.');
  });
});

describe('dev wallet signer HTTP surface', () => {
  const base = () => start({ OWNER_PRIVATE_KEY: OWNER_KEY, AGENT_PRIVATE_KEY: AGENT_KEY });

  it('binds to loopback and answers /healthz with addresses only', async () => {
    const origin = base();
    expect(servers.at(-1)?.hostname).toBe(DEV_WALLET_SIGNER_HOST);
    const response = await fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);
    const text = await response.text();
    const data = JSON.parse(text);
    expect(data.ok).toBe(true);
    expect(data.accounts.owner).toBe(owner.address);
    expect(data.accounts.agent).toBe(agent.address);
    expect(text).not.toContain(OWNER_KEY);
    expect(text).not.toContain(AGENT_KEY);
  });

  it('serves accounts per ?testAccount and rejects bad or unconfigured accounts', async () => {
    const origin = base();
    expect(await (await fetch(`${origin}/accounts?testAccount=owner`)).json()).toEqual({
      testAccount: 'owner',
      accounts: [owner.address],
    });
    expect(await (await fetch(`${origin}/accounts?testAccount=agent`)).json()).toEqual({
      testAccount: 'agent',
      accounts: [agent.address],
    });
    expect((await fetch(`${origin}/accounts`)).status).toBe(400);
    expect((await fetch(`${origin}/accounts?testAccount=intruder`)).status).toBe(400);

    const partial = start({ OWNER_PRIVATE_KEY: OWNER_KEY });
    expect((await fetch(`${partial}/accounts?testAccount=agent`)).status).toBe(503);
  });

  it('signs an EIP-191 personal_sign payload and the signature verifies', async () => {
    const lines: string[] = [];
    const origin = start(
      { OWNER_PRIVATE_KEY: OWNER_KEY, AGENT_PRIVATE_KEY: AGENT_KEY },
      (line) => lines.push(line),
    );
    const response = await fetch(`${origin}/sign?testAccount=agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: hexMessage, address: agent.address }),
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.testAccount).toBe('agent');
    expect(
      await verifyMessage({ address: agent.address, message: 'wallet-budget challenge', signature: data.signature }),
    ).toBe(true);
    expect(
      await verifyMessage({ address: agent.address, message: 'other message', signature: data.signature }),
    ).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('testAccount=agent');
    expect(lines[0]).toContain('"wallet-budget challenge"');
  });

  it('rejects malformed sign requests', async () => {
    const origin = base();
    const post = (body: unknown) =>
      fetch(`${origin}/sign?testAccount=owner`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === null ? 'not json' : JSON.stringify(body),
      });
    expect((await post({ message: 'plain text' })).status).toBe(400);
    expect((await post({ message: '0x' })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect((await post({ message: hexMessage, address: '0x0000000000000000000000000000000000000001' })).status).toBe(400);
    expect((await fetch(`${origin}/sign?testAccount=owner`)).status).toBe(405);
    expect((await fetch(`${origin}/nope?testAccount=owner`)).status).toBe(404);
  });

  it('answers CORS for local origins and refuses non-local ones', async () => {
    const origin = base();
    const local = await fetch(`${origin}/accounts?testAccount=owner`, {
      headers: { origin: 'http://localhost:4333' },
    });
    expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:4333');
    expect(local.headers.get('access-control-allow-methods')).toContain('POST');
    const preflight = await fetch(`${origin}/sign?testAccount=owner`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:4333' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4333');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');
    const remote = await fetch(`${origin}/healthz`, { headers: { origin: 'https://market.bflabs.app' } });
    expect(remote.status).toBe(403);
    expect(remote.headers.get('access-control-allow-origin')).toBeNull();
    // Same-origin tools (no Origin header) still work.
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
  });

  it('is usable as a bare handler for in-process tests', async () => {
    const handler = createDevWalletSignerHandler({ env: { AGENT_PRIVATE_KEY: AGENT_KEY } });
    const response = await handler(new Request('http://127.0.0.1:4335/healthz'));
    const data = await response.json();
    expect(data.accounts.agent).toBe(agent.address);
    expect(data.accounts.owner).toBeNull();
  });
});
