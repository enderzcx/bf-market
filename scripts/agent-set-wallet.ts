import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AGENT_WALLET_SET_DOMAIN_NAME,
  AGENT_WALLET_SET_DOMAIN_VERSION,
  AGENT_WALLET_SET_MAX_DEADLINE_SECONDS,
  agentWalletSetDeadline,
  agentWalletSetTypedData,
  identityRegistryAbi,
  readAgentWalletSetDomain,
  setAgentWalletCalldata,
} from '../src/agent-registry.ts';
import { isNetworkName, NETWORK_NAMES, selectNetworkByName } from '../src/network.ts';
import type { Address } from '../src/types.ts';

// Rotates an ERC-8004 agent's payment wallet. The new wallet signs the EIP-712
// consent over the registry's own domain (name/version/chainId/verifyingContract
// read from the contract); the current owner sends the transaction and pays the
// gas. Nothing here prints a private key.
//
// Usage:
//   OWNER_PRIVATE_KEY=0x.. AGENT_PRIVATE_KEY=0x.. bun scripts/agent-set-wallet.ts \
//     --network local|botchain-testnet --agent <agentId> [--wallet 0x..] \
//     [--ttl-seconds 300] [--rpc url] [--registry 0x..] [--send]
//
// --network local sends without --send; every other network requires it.

const USAGE = `Usage: OWNER_PRIVATE_KEY=0x.. AGENT_PRIVATE_KEY=0x.. bun scripts/agent-set-wallet.ts --network <${NETWORK_NAMES.join('|')}> --agent <agentId> [--wallet 0x..] [--ttl-seconds ${AGENT_WALLET_SET_MAX_DEADLINE_SECONDS}] [--rpc <url>] [--registry 0x..] [--send]

The new wallet (AGENT_PRIVATE_KEY) signs the EIP-712 AgentWalletSet consent; the
current owner (OWNER_PRIVATE_KEY) sends setAgentWallet and pays the gas.`;

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export type SetWalletResult = { txHash: Hex; agentId: bigint; wallet: Address };

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  log: (line: string) => void = console.log,
): Promise<SetWalletResult> {
  const hasFlag = (name: string): boolean => argv.includes(name);
  const argValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  if (hasFlag('--help') || argv.length === 0) {
    log(USAGE);
    return { txHash: '0x', agentId: 0n, wallet: '0x0000000000000000000000000000000000000000' };
  }

  const network = argValue('--network') ?? 'local';
  if (!isNetworkName(network)) {
    throw new Error(`Unknown network ${network}. Allowed: ${NETWORK_NAMES.join(' | ')}.`);
  }
  const profile = selectNetworkByName(network);
  if (network !== 'local' && !hasFlag('--send')) {
    throw new Error(
      `Refusing to rotate an agent wallet on ${network} without --send. This is an on-chain write.`,
    );
  }

  const agentArg = argValue('--agent');
  if (!agentArg || !/^\d+$/.test(agentArg)) {
    throw new Error('--agent <agentId> must be a non-negative integer.');
  }
  const agentId = BigInt(agentArg);

  const ttlArg = argValue('--ttl-seconds');
  const ttlSeconds =
    ttlArg === undefined ? AGENT_WALLET_SET_MAX_DEADLINE_SECONDS : Number(ttlArg);

  const registryArg = argValue('--registry') ?? profile.identityRegistry;
  if (!registryArg) {
    throw new Error(
      `${network} has no identity registry in src/network.ts; pass --registry 0x...`,
    );
  }
  const registry = getAddress(registryArg) as Address;
  const rpcUrl = argValue('--rpc') ?? profile.rpcUrl;

  const ownerKey = env.OWNER_PRIVATE_KEY;
  const agentKey = env.AGENT_PRIVATE_KEY;
  if (!ownerKey || !KEY_RE.test(ownerKey)) {
    throw new Error('Set OWNER_PRIVATE_KEY to the 32-byte hex key of the current owner.');
  }
  if (!agentKey || !KEY_RE.test(agentKey)) {
    throw new Error('Set AGENT_PRIVATE_KEY to the 32-byte hex key of the new payment wallet.');
  }
  const owner = privateKeyToAccount(ownerKey as Hex);
  const newWallet = privateKeyToAccount(agentKey as Hex);

  const walletArg = argValue('--wallet');
  if (walletArg && getAddress(walletArg) !== getAddress(newWallet.address)) {
    throw new Error('--wallet must match the address derived from AGENT_PRIVATE_KEY.');
  }

  const chain = defineChain({
    id: profile.chainId,
    name: profile.displayName,
    nativeCurrency: { name: 'Test gas', symbol: 'tBOT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });

  const chainId = await publicClient.getChainId();
  if (chainId !== profile.chainId) {
    throw new Error(`RPC chain id ${chainId} does not match ${network} (${profile.chainId}).`);
  }

  const onChainOwner = getAddress(
    (await publicClient.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [agentId],
    })) as Address,
  );
  if (onChainOwner !== getAddress(owner.address)) {
    throw new Error(
      `Agent #${agentId} is owned by ${onChainOwner}, not by OWNER_PRIVATE_KEY ${getAddress(owner.address)}.`,
    );
  }

  const domain = await readAgentWalletSetDomain(publicClient, registry);
  if (domain.chainId !== chainId || domain.verifyingContract !== registry) {
    throw new Error(
      `The registry EIP-712 domain points at chain ${domain.chainId} / ${domain.verifyingContract}, not ${chainId} / ${registry}.`,
    );
  }
  if (
    domain.name !== AGENT_WALLET_SET_DOMAIN_NAME ||
    domain.version !== AGENT_WALLET_SET_DOMAIN_VERSION
  ) {
    log(
      `[note] the registry advertises EIP-712 domain "${domain.name}" v${domain.version}; signing over the contract value.`,
    );
  }

  const currentWallet = getAddress(
    (await publicClient.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'getAgentWallet',
      args: [agentId],
    })) as Address,
  );

  let nowSeconds: bigint;
  try {
    const block = await publicClient.getBlock();
    nowSeconds = block.timestamp;
  } catch {
    nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  }
  const consent = {
    agentId,
    newWallet: getAddress(newWallet.address) as Address,
    owner: getAddress(owner.address) as Address,
    deadline: agentWalletSetDeadline(nowSeconds, ttlSeconds),
  };
  const signature = await newWallet.signTypedData(
    agentWalletSetTypedData({ domain, consent }),
  );
  const data = setAgentWalletCalldata({ ...consent, signature });

  log(
    `[plan] agent #${agentId} wallet ${currentWallet} -> ${consent.newWallet} on ${network} (chain ${chainId})`,
  );
  log(
    `[plan] registry ${registry} domain "${domain.name}" v${domain.version}; deadline ${consent.deadline} (${Number(consent.deadline) - Number(nowSeconds)}s ahead)`,
  );

  const gas = await publicClient.estimateGas({
    account: getAddress(owner.address),
    to: registry,
    data,
    value: 0n,
  });
  log(`[estimate] setAgentWallet gas ${gas}`);

  const wallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
  const txHash = await wallet.sendTransaction({
    to: registry,
    data,
    value: 0n,
    gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`setAgentWallet reverted: ${txHash}`);
  }

  const after = getAddress(
    (await publicClient.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'getAgentWallet',
      args: [agentId],
    })) as Address,
  );
  if (after !== consent.newWallet) {
    throw new Error(`getAgentWallet(#${agentId}) is ${after} after the transaction.`);
  }
  log(`[tx] ${txHash} status=${receipt.status} gasUsed=${receipt.gasUsed}`);
  log(`[read] getAgentWallet(#${agentId}) = ${after}`);

  return { txHash, agentId, wallet: after };
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
