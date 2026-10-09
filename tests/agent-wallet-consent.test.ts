import { afterEach, expect, test } from 'bun:test';
import { createWalletClient, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AGENT_WALLET_SET_DOMAIN_NAME,
  AGENT_WALLET_SET_DOMAIN_VERSION,
  AGENT_WALLET_SET_MAX_DEADLINE_SECONDS,
  agentWalletSetDeadline,
  agentWalletSetTypedData,
  decodeRegisteredEvent,
  identityRegistryAbi,
  readAgentWalletSetDomain,
  setAgentWalletCalldata,
} from '../src/agent-registry.ts';
import { main as setAgentWalletMain } from '../scripts/agent-set-wallet.ts';
import { AGENT_KEY, BUYER_KEY, closeAll, startChain, type ChainEnv } from './m6-harness.ts';

// ERC-8004 owner-driven wallet rotation: the *new* payment wallet signs the
// EIP-712 consent and the current owner pays the gas. These cases pin the
// consent shape against the real contracts/erc8004 registry, so a domain or
// struct drift cannot pass unnoticed.

const OWNER = privateKeyToAccount(BUYER_KEY);
const NEW_WALLET_KEY = `0x${'6'.repeat(64)}` as Hex;
const OTHER_WALLET_KEY = `0x${'7'.repeat(64)}` as Hex;
const NEW_WALLET = privateKeyToAccount(NEW_WALLET_KEY);
const OTHER_WALLET = privateKeyToAccount(OTHER_WALLET_KEY);

afterEach(async () => {
  await closeAll();
});

async function registerAgentOnChain(env: ChainEnv, agentURI = 'ipfs://agent-wallet-consent'): Promise<bigint> {
  const wallet = createWalletClient({ chain: env.viemChain, account: OWNER, transport: http(env.url) });
  const hash = await wallet.writeContract({
    address: env.registry,
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [agentURI],
  });
  const receipt = await env.client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  const event = decodeRegisteredEvent(receipt, env.registry);
  expect(event).not.toBeNull();
  return event!.agentId;
}

async function readAgentWallet(env: ChainEnv, agentId: bigint): Promise<Address> {
  return getAddress(
    (await env.client.readContract({
      address: env.registry,
      abi: identityRegistryAbi,
      functionName: 'getAgentWallet',
      args: [agentId],
    })) as Address,
  );
}

async function buildConsent(
  env: ChainEnv,
  agentId: bigint,
  options: { newWallet?: ReturnType<typeof privateKeyToAccount>; signWith?: ReturnType<typeof privateKeyToAccount>; deadline?: bigint } = {},
) {
  const nominated = options.newWallet ?? NEW_WALLET;
  const domain = await readAgentWalletSetDomain(env.client, env.registry);
  let nowSeconds: bigint;
  try {
    const block = await env.client.getBlock();
    nowSeconds = block.timestamp;
  } catch {
    nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  }
  const consent = {
    agentId,
    newWallet: getAddress(nominated.address),
    owner: getAddress(OWNER.address),
    deadline: options.deadline ?? agentWalletSetDeadline(nowSeconds),
  };
  const signature = await (options.signWith ?? nominated).signTypedData(
    agentWalletSetTypedData({ domain, consent }),
  );
  return { domain, consent, signature };
}

test('the consent domain is read from the registry and the owner can rotate the wallet', async () => {
  const env = await startChain();
  const agentId = await registerAgentOnChain(env);
  const domain = await readAgentWalletSetDomain(env.client, env.registry);
  expect(domain).toEqual({
    name: AGENT_WALLET_SET_DOMAIN_NAME,
    version: AGENT_WALLET_SET_DOMAIN_VERSION,
    chainId: 31337,
    verifyingContract: getAddress(env.registry),
  });

  // register() parks the wallet on the registering owner; the consent moves it.
  expect(await readAgentWallet(env, agentId)).toBe(getAddress(OWNER.address));

  const { consent, signature } = await buildConsent(env, agentId);
  const ahead = Number(consent.deadline) - Math.floor(Date.now() / 1000);
  expect(ahead).toBeGreaterThan(0);
  expect(ahead).toBeLessThanOrEqual(AGENT_WALLET_SET_MAX_DEADLINE_SECONDS);

  const data = setAgentWalletCalldata({ ...consent, signature });
  const wallet = createWalletClient({ chain: env.viemChain, account: OWNER, transport: http(env.url) });
  const gas = await env.client.estimateContractGas({
    address: env.registry,
    abi: identityRegistryAbi,
    functionName: 'setAgentWallet',
    args: [agentId, consent.newWallet, consent.deadline, signature],
    account: OWNER.address,
  });
  const hash = await wallet.sendTransaction({ to: env.registry, data, gas: (gas * 120n) / 100n });
  const receipt = await env.client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  expect(await readAgentWallet(env, agentId)).toBe(getAddress(NEW_WALLET.address));
});

test('an expired deadline or a signature from another key cannot set the wallet', async () => {
  const env = await startChain();
  const agentId = await registerAgentOnChain(env);
  const wallet = createWalletClient({ chain: env.viemChain, account: OWNER, transport: http(env.url) });

  const expired = await buildConsent(env, agentId, {
    deadline: BigInt(Math.floor(Date.now() / 1000) - 1),
  });
  const expiredReceipt = await env.client.waitForTransactionReceipt({
    hash: await wallet.sendTransaction({
      to: env.registry,
      data: setAgentWalletCalldata({ ...expired.consent, signature: expired.signature }),
      gas: 400_000n,
    }),
  });
  expect(expiredReceipt.status).toBe('reverted');

  // Nominating NEW_WALLET but signing with another key never authorizes it.
  const foreign = await buildConsent(env, agentId, { signWith: OTHER_WALLET });
  const foreignReceipt = await env.client.waitForTransactionReceipt({
    hash: await wallet.sendTransaction({
      to: env.registry,
      data: setAgentWalletCalldata({ ...foreign.consent, signature: foreign.signature }),
      gas: 400_000n,
    }),
  });
  expect(foreignReceipt.status).toBe('reverted');

  expect(await readAgentWallet(env, agentId)).toBe(getAddress(OWNER.address));
});

test('the deadline helper enforces the contract five minute ceiling', () => {
  const now = 1_800_000_000n;
  expect(agentWalletSetDeadline(now)).toBe(now + BigInt(AGENT_WALLET_SET_MAX_DEADLINE_SECONDS));
  expect(agentWalletSetDeadline(now, 60)).toBe(now + 60n);
  expect(() => agentWalletSetDeadline(now, 301)).toThrow(/deadline/);
  expect(() => agentWalletSetDeadline(now, 0)).toThrow(/deadline/);
  expect(() => agentWalletSetDeadline(now, -5)).toThrow(/deadline/);
});

test('scripts/agent-set-wallet.ts rotates the wallet when the owner sends the transaction', async () => {
  const env = await startChain();
  const agentId = await registerAgentOnChain(env);
  const lines: string[] = [];

  const result = await setAgentWalletMain(
    ['--network', 'local', '--rpc', env.url, '--registry', env.registry, '--agent', String(agentId)],
    { OWNER_PRIVATE_KEY: BUYER_KEY, AGENT_PRIVATE_KEY: NEW_WALLET_KEY },
    (line: string) => lines.push(line),
  );

  expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(await readAgentWallet(env, agentId)).toBe(getAddress(NEW_WALLET.address));
  expect(lines.join('\n')).toContain(getAddress(NEW_WALLET.address));
});

test('the script refuses testnet writes without --send and rejects a non-owner key', async () => {
  await expect(
    setAgentWalletMain(
      ['--network', 'botchain-testnet', '--agent', '0'],
      { OWNER_PRIVATE_KEY: BUYER_KEY, AGENT_PRIVATE_KEY: NEW_WALLET_KEY },
      () => {},
    ),
  ).rejects.toThrow(/--send/);

  const env = await startChain();
  const agentId = await registerAgentOnChain(env);
  const before = await readAgentWallet(env, agentId);
  await expect(
    setAgentWalletMain(
      ['--network', 'local', '--rpc', env.url, '--registry', env.registry, '--agent', String(agentId)],
      { OWNER_PRIVATE_KEY: AGENT_KEY, AGENT_PRIVATE_KEY: NEW_WALLET_KEY },
      () => {},
    ),
  ).rejects.toThrow(/owner/i);
  expect(await readAgentWallet(env, agentId)).toBe(before);
});
