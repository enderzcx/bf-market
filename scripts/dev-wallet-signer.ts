import { concat, hexToBytes, keccak256, toBytes } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

// Local-only dev wallet signer for the BF Market test wallet
// (`web/src/market/wallet/test-provider.js`). The browser test provider
// forwards `personal_sign` payloads here; this process holds the keys and
// returns an EIP-191 signature.
//
// Secrets policy: keys are read from the environment only
// (OWNER_PRIVATE_KEY / AGENT_PRIVATE_KEY). They are never accepted as CLI
// arguments, never written to a request or response, and never printed —
// startup output lists addresses only.
//
// Network policy: the server binds strictly to 127.0.0.1 and answers CORS
// preflights only for loopback origins. A non-loopback Origin is refused.

export const DEV_WALLET_SIGNER_HOST = '127.0.0.1';
export const DEV_WALLET_SIGNER_PORT = 4335;
const ALLOWED_BROWSER_ORIGINS = new Set([
  'http://127.0.0.1:4333',
  'http://localhost:4333',
]);

export const TEST_ACCOUNT_NAMES = ['owner', 'agent'] as const;
export type TestAccountName = (typeof TEST_ACCOUNT_NAMES)[number];

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_MESSAGE_RE = /^0x([0-9a-fA-F]{2})*$/;

export function isLocalOrigin(origin: string): boolean {
  try {
    return ALLOWED_BROWSER_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

// Loads test accounts from env. An unset variable means the account is
// disabled; a malformed key aborts startup (never a silent partial wallet).
export function loadSignerAccounts(
  env: Record<string, string | undefined>,
): Record<TestAccountName, PrivateKeyAccount | null> {
  const accounts = { owner: null, agent: null } as Record<TestAccountName, PrivateKeyAccount | null>;
  for (const name of TEST_ACCOUNT_NAMES) {
    const envName = `${name.toUpperCase()}_PRIVATE_KEY`;
    const raw = env[envName];
    if (raw === undefined || raw === '') continue;
    const key = raw.trim();
    if (!PRIVATE_KEY_RE.test(key)) {
      // Deliberately generic: never echo the value back.
      throw new Error(
        `${envName} is set but is not a valid secp256k1 private key (expected 0x plus 64 hex characters). ` +
          'Refusing to start; the value was not printed.',
      );
    }
    try {
      accounts[name] = privateKeyToAccount(key as `0x${string}`);
    } catch {
      throw new Error(
        `${envName} is set but is not a valid secp256k1 private key. Refusing to start; the value was not printed.`,
      );
    }
  }
  if (!accounts.owner && !accounts.agent) {
    throw new Error('No test accounts configured. Export OWNER_PRIVATE_KEY and/or AGENT_PRIVATE_KEY.');
  }
  return accounts;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export type DevWalletSignerOptions = {
  env?: Record<string, string | undefined>;
  hostname?: string;
  port?: number;
  log?: (line: string) => void;
};

// Builds the fetch handler. Pure enough to reuse from tests with fake env.
export function createDevWalletSignerHandler(
  opts: DevWalletSignerOptions = {},
): (request: Request) => Promise<Response> {
  const accounts = loadSignerAccounts(opts.env ?? {});
  const hostname = opts.hostname ?? DEV_WALLET_SIGNER_HOST;

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    if (origin && !isLocalOrigin(origin)) {
      return jsonResponse(403, { error: 'Forbidden: only local origins may use the dev wallet signer.' });
    }
    const cors: Record<string, string> = origin
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          vary: 'Origin',
        }
      : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      if (request.method !== 'GET') {
        return jsonResponse(405, { error: 'Use GET for /healthz.' }, cors);
      }
      return jsonResponse(
        200,
        {
          ok: true,
          service: 'bfm-test-wallet-signer',
          host: hostname,
          accounts: {
            owner: accounts.owner?.address ?? null,
            agent: accounts.agent?.address ?? null,
          },
        },
        cors,
      );
    }

    const testAccount = url.searchParams.get('testAccount');
    if (testAccount !== 'owner' && testAccount !== 'agent') {
      return jsonResponse(
        400,
        { error: 'Invalid testAccount. Pass ?testAccount=owner or ?testAccount=agent.' },
        cors,
      );
    }
    const account = accounts[testAccount];
    if (!account) {
      return jsonResponse(
        503,
        {
          error: `Test account "${testAccount}" is not configured (${testAccount.toUpperCase()}_PRIVATE_KEY missing).`,
        },
        cors,
      );
    }

    if (url.pathname === '/accounts') {
      if (request.method !== 'GET') {
        return jsonResponse(405, { error: 'Use GET for /accounts.' }, cors);
      }
      return jsonResponse(200, { testAccount, accounts: [account.address] }, cors);
    }

    if (url.pathname === '/sign') {
      if (request.method !== 'POST') {
        return jsonResponse(405, { error: 'Use POST for /sign.' }, cors);
      }
      let body: { message?: unknown; address?: unknown };
      try {
        body = (await request.json()) as { message?: unknown; address?: unknown };
      } catch {
        return jsonResponse(400, { error: 'Body must be JSON: { message, address? }.' }, cors);
      }
      const message = body.message;
      if (
        typeof message !== 'string' ||
        message.length > 32_770 ||
        !HEX_MESSAGE_RE.test(message) ||
        message === '0x'
      ) {
        return jsonResponse(
          400,
          { error: 'message must be a non-empty hex string (0x + byte pairs), as sent to personal_sign.' },
          cors,
        );
      }
      if (body.address !== undefined && typeof body.address !== 'string') {
        return jsonResponse(400, { error: 'address must be the selected test account.' }, cors);
      }
      if (typeof body.address === 'string') {
        if (body.address.toLowerCase() !== account.address.toLowerCase()) {
          return jsonResponse(
            400,
            { error: `address does not match the selected test account "${testAccount}".` },
            cors,
          );
        }
      }
      // EIP-191 personal_sign semantics over the raw hex bytes (what an
      // injected wallet produces for `personal_sign`). viem's string path
      // hashes utf8 bytes with the same prefix, so the settlement server's
      // `recoverMessageAddress(message)` recovers this signature.
      const bytes = hexToBytes(message as `0x${string}`);
      (opts.log ?? console.log)(
        `[dev-wallet-signer] personal_sign testAccount=${testAccount} message=${JSON.stringify(
          Buffer.from(bytes).toString('utf8'),
        )}`,
      );
      const hash = keccak256(concat([toBytes(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes]));
      const signature = await account.sign({ hash });
      return jsonResponse(200, { testAccount, signature }, cors);
    }

    return jsonResponse(404, { error: 'Not found. Use /healthz, /accounts or /sign.' }, cors);
  };
}

// Starts the server, strictly bound to the loopback hostname.
export type DevWalletServer = ReturnType<typeof Bun.serve>;

export function startDevWalletSigner(opts: DevWalletSignerOptions = {}): DevWalletServer {
  const port = opts.port ?? DEV_WALLET_SIGNER_PORT;
  const hostname = opts.hostname ?? DEV_WALLET_SIGNER_HOST;
  if (port !== 0 && port !== DEV_WALLET_SIGNER_PORT) {
    throw new Error(`The dev wallet signer only runs on port ${DEV_WALLET_SIGNER_PORT}.`);
  }
  if (hostname !== DEV_WALLET_SIGNER_HOST) {
    throw new Error(`The dev wallet signer only binds to ${DEV_WALLET_SIGNER_HOST}.`);
  }
  const handler = createDevWalletSignerHandler(opts);
  return Bun.serve({
    hostname,
    port,
    fetch: (request) => handler(request),
  });
}

if (import.meta.main) {
  try {
    const server = startDevWalletSigner({ env: process.env });
    const accounts = loadSignerAccounts(process.env);
    console.log(`[dev-wallet-signer] listening on http://${DEV_WALLET_SIGNER_HOST}:${server.port} (local only)`);
    console.log(
      `[dev-wallet-signer] accounts: owner=${accounts.owner?.address ?? 'none'} agent=${accounts.agent?.address ?? 'none'}`,
    );
  } catch (error) {
    console.error(`[dev-wallet-signer] ${(error as Error).message}`);
    process.exit(1);
  }
}
