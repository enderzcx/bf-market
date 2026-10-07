import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';

// Guarded web build for the BF Market public shell.
//
// `bun run build:web` must never ship the local test wallet
// (web/src/market/wallet/test-provider.js), so it FAILS whenever
// VITE_BFM_TEST_WALLET is set in the environment — an operator is told to
// use `bun run build:web:e2e` instead. The e2e path builds with
// `vite build --mode e2e` and VITE_BFM_TEST_WALLET=1 so the provider chunk is
// emitted for local e2e runs only.

const REPO = import.meta.dir + '/..';
const DIST = `${REPO}/web/dist`;
const FLAG = 'VITE_BFM_TEST_WALLET';
const TEST_WALLET_MARKERS = ['bfm-test-wallet', '127.0.0.1:4335'];

function containsTestWalletMarker(directory: string): boolean {
  try {
    for (const name of readdirSync(directory)) {
      const path = `${directory}/${name}`;
      if (statSync(path).isDirectory()) {
        if (containsTestWalletMarker(path)) return true;
      } else {
        const source = readFileSync(path).toString('utf8');
        if (TEST_WALLET_MARKERS.some((marker) => source.includes(marker))) return true;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return false;
}

const e2e = process.argv.includes('--e2e');
const flagSet = process.env[FLAG] !== undefined;

if (!e2e && flagSet) {
  if (containsTestWalletMarker(DIST)) {
    rmSync(DIST, { recursive: true, force: true });
    console.error('[build:web] removed the previous e2e bundle from web/dist.');
  }
  console.error(
    `[build:web] refusing to build: ${FLAG} is set. The test wallet must not ship in the production bundle. ` +
      'Run `bun run build:web:e2e` for the local e2e build, or unset the variable.',
  );
  process.exit(1);
}

const childEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  if (key === FLAG) continue; // Never inherit a stale flag: the guard script owns it.
  childEnv[key] = value;
}
if (e2e) childEnv[FLAG] = '1';

const result = Bun.spawnSync(
  ['node_modules/.bin/vite', 'build', ...(e2e ? ['--mode', 'e2e'] : [])],
  { cwd: `${REPO}/web`, env: childEnv, stdout: 'inherit', stderr: 'inherit' },
);
process.exit(result.exitCode ?? 1);
