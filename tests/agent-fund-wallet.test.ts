import { afterEach, expect, test } from 'bun:test';
import { getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { main as fundWalletMain } from '../scripts/agent-fund-wallet.ts';
import { BUYER_KEY, closeAll, mintUsdt, startChain } from './m6-harness.ts';

// Funding helper used by the owner≠wallet test agent: gas and USDT for the new
// payment wallet, plus its one-time Permit2 approval.

const FUNDER = privateKeyToAccount(BUYER_KEY);
const TARGET_KEY = `0x${'8'.repeat(64)}` as Hex;
const TARGET = privateKeyToAccount(TARGET_KEY);
const MAX_UINT256 = 2n ** 256n - 1n;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const tokenAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

afterEach(async () => {
  await closeAll();
});

test('the funding script sends gas and USDT, then the target approves Permit2', async () => {
  const env = await startChain();
  await mintUsdt(env, FUNDER.address, 5_000_000n);
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  const funded = await fundWalletMain(
    [
      '--network', 'local',
      '--rpc', env.url,
      '--token', env.token,
      '--to', TARGET.address,
      '--native', '0.5',
      '--usdt', '1.2',
    ],
    { FUNDER_PRIVATE_KEY: BUYER_KEY },
    log,
  );
  expect(funded.txHashes).toHaveLength(2);

  const usdt = (await env.client.readContract({
    address: env.token,
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: [TARGET.address],
  })) as bigint;
  expect(usdt).toBe(1_200_000n);
  const gas = await env.client.getBalance({ address: TARGET.address });
  expect(gas).toBeGreaterThan(400_000_000_000_000_000n);

  const approved = await fundWalletMain(
    [
      '--network', 'local',
      '--rpc', env.url,
      '--token', env.token,
      '--permit2', PERMIT2,
      '--to', TARGET.address,
      '--approve-permit2',
    ],
    { TARGET_PRIVATE_KEY: TARGET_KEY },
    log,
  );
  expect(approved.txHashes).toHaveLength(1);
  const allowance = (await env.client.readContract({
    address: env.token,
    abi: tokenAbi,
    functionName: 'allowance',
    args: [getAddress(TARGET.address), getAddress(PERMIT2)],
  })) as bigint;
  expect(allowance).toBe(MAX_UINT256);
  expect(lines.join('\n')).not.toContain(BUYER_KEY);
});

test('the funding script refuses testnet writes without --send', async () => {
  await expect(
    fundWalletMain(
      ['--network', 'botchain-testnet', '--to', TARGET.address, '--usdt', '1.2'],
      { FUNDER_PRIVATE_KEY: BUYER_KEY },
      () => {},
    ),
  ).rejects.toThrow(/--send/);
  await expect(
    fundWalletMain(
      ['--network', 'botchain-testnet', '--to', TARGET.address, '--approve-permit2'],
      { TARGET_PRIVATE_KEY: TARGET_KEY },
      () => {},
    ),
  ).rejects.toThrow(/--send/);
});
