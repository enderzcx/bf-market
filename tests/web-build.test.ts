import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

// The test wallet must never ship in a production web bundle:
// - `bun run build:web` fails outright when VITE_BFM_TEST_WALLET is set.
// - A production build of web/dist contains neither the marker string
//   `bfm-test-wallet` nor the dev signer URL `127.0.0.1:4335`.
//
// The e2e build must contain both markers so the local provider can run, while
// the production build must contain neither.

const REPO = import.meta.dir + '/..';
const MARKERS = ['bfm-test-wallet', '127.0.0.1:4335'];

function spawnBuild(extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!Object.hasOwn(extraEnv, 'VITE_BFM_TEST_WALLET')) {
    delete env.VITE_BFM_TEST_WALLET;
  }
  return Bun.spawnSync(['bun', 'scripts/build-web.ts'], {
    cwd: REPO,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function spawnE2eBuild() {
  const env = { ...process.env };
  delete env.VITE_BFM_TEST_WALLET;
  return Bun.spawnSync(['bun', 'scripts/build-web.ts', '--e2e'], {
    cwd: REPO,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function scanDist(): string[] {
  if (!existsSync(`${REPO}/web/dist`)) return [];
  const hits: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (const file of walkFiles(`${REPO}/web/dist`)) {
    const raw = decoder.decode(new Uint8Array(readFileSync(file)));
    for (const marker of MARKERS) {
      if (raw.includes(marker)) hits.push(`${file}: ${marker}`);
    }
  }
  return hits;
}

describe('build:web test-wallet guard', () => {
  it('fails when VITE_BFM_TEST_WALLET is set and points at the e2e script', () => {
    const result = spawnBuild({ VITE_BFM_TEST_WALLET: '1' });
    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain('VITE_BFM_TEST_WALLET');
    expect(stderr).toContain('build:web:e2e');
  }, 30000);

  it('includes the test provider marker and signer URL in the e2e build', () => {
    const build = spawnE2eBuild();
    expect(build.exitCode).toBe(0);
    const hits = scanDist();
    expect(hits.some((hit) => hit.includes('bfm-test-wallet'))).toBe(true);
    expect(hits.some((hit) => hit.includes('127.0.0.1:4335'))).toBe(true);
  }, 180000);

  it('removes a prior e2e bundle when the production build guard refuses', () => {
    const result = spawnBuild({ VITE_BFM_TEST_WALLET: '1' });
    expect(result.exitCode).not.toBe(0);
    expect(scanDist()).toEqual([]);
  }, 30000);

  it('produces a production web/dist free of the test wallet marker and signer URL', () => {
    const build = spawnBuild();
    expect(build.exitCode).toBe(0);
    const files = walkFiles(`${REPO}/web/dist`);
    expect(files.length).toBeGreaterThan(0);
    expect(scanDist()).toEqual([]);
  }, 180000);
});
