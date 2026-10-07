import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  parseUnits,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { isNetworkName, NETWORK_NAMES, selectNetworkByName } from '../src/network.ts';
import type { Address } from '../src/types.ts';

// Funds the payment wallet of an owner≠wallet test agent: native gas for its own
// transactions and USDT for a paid call, plus its one-time Permit2 approval.
// Nothing here prints a private key.
//
// Usage:
//   FUNDER_PRIVATE_KEY=0x.. bun scripts/agent-fund-wallet.ts --network botchain-testnet --send \
//     --to 0xW [--native 0.01] [--usdt 1.2] [--rpc url] [--token 0x..]
//   TARGET_PRIVATE_KEY=0x.. bun scripts/agent-fund-wallet.ts --network botchain-testnet --send \
//     --to 0xW --approve-permit2 [--rpc url] [--token 0x..]
//
// --network local sends without --send; every other network requires it.

const USAGE = `Usage: FUNDER_PRIVATE_KEY=0x.. bun scripts/agent-fund-wallet.ts --network <${NETWORK_NAMES.join('|')}> --to 0x.. [--native 0.01] [--usdt 1.2] [--rpc <url>] [--token 0x..] [--send]
       TARGET_PRIVATE_KEY=0x.. bun scripts/agent-fund-wallet.ts --network <${NETWORK_NAMES.join('|')}> --to 0x.. --approve-permit2 [--rpc <url>] [--token 0x..] [--send]

--native/--usdt are sent by FUNDER_PRIVATE_KEY (the owner). --approve-permit2 is
signed by TARGET_PRIVATE_KEY (the payment wallet) and approves the network's
Permit2 contract for the whole token balance.`;

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

const tokenAbi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export type FundWalletResult = { txHashes: Hex[]; target: Address };

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  log: (line: string) => void = console.log,
): Promise<FundWalletResult> {
  const hasFlag = (name: string): boolean => argv.includes(name);
  const argValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  if (hasFlag('--help') || argv.length === 0) {
    log(USAGE);
    return { txHashes: [], target: '0x0000000000000000000000000000000000000000' };
  }

  const network = argValue('--network') ?? 'local';
  if (!isNetworkName(network)) {
    throw new Error(`Unknown network ${network}. Allowed: ${NETWORK_NAMES.join(' | ')}.`);
  }
  const profile = selectNetworkByName(network);
  if (network !== 'local' && !hasFlag('--send')) {
    throw new Error(
      `Refusing to move funds on ${network} without --send. These are on-chain writes.`,
    );
  }

  const toArg = argValue('--to');
  if (!toArg) throw new Error('--to <address> is required.');
  const target = getAddress(toArg) as Address;

  const tokenArg = argValue('--token') ?? profile.asset.address;
  const token = getAddress(tokenArg) as Address;
  const rpcUrl = argValue('--rpc') ?? profile.rpcUrl;

  const approve = hasFlag('--approve-permit2');
  const nativeAmount = argValue('--native');
  const usdtAmount = argValue('--usdt');
  if (!approve && nativeAmount === undefined && usdtAmount === undefined) {
    throw new Error('Nothing to do: pass --native, --usdt or --approve-permit2.');
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

  const txHashes: Hex[] = [];
  const send = async (
    account: ReturnType<typeof privateKeyToAccount>,
    request: { to: Address; data?: Hex; value?: bigint },
    label: string,
  ) => {
    const gas = await publicClient.estimateGas({
      account: account.address,
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
    });
    log(`[estimate] ${label} gas ${gas}`);
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
    const hash = await wallet.sendTransaction({
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      gas: (gas * 120n) / 100n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
    log(`[tx] ${label} ${hash} gasUsed=${receipt.gasUsed}`);
    txHashes.push(hash);
  };

  if (nativeAmount !== undefined || usdtAmount !== undefined) {
    const funderKey = env.FUNDER_PRIVATE_KEY;
    if (!funderKey || !KEY_RE.test(funderKey)) {
      throw new Error('Set FUNDER_PRIVATE_KEY to the 32-byte hex key of the funding wallet.');
    }
    const funder = privateKeyToAccount(funderKey as Hex);
    log(`[plan] funding ${target} from ${getAddress(funder.address)} on ${network}`);

    if (nativeAmount !== undefined) {
      const value = parseEther(nativeAmount);
      if (value <= 0n) throw new Error('--native must be greater than zero.');
      await send(funder, { to: target, value }, `native ${nativeAmount} to ${target}`);
    }
    if (usdtAmount !== undefined) {
      const amount = parseUnits(usdtAmount, profile.asset.decimals);
      if (amount <= 0n) throw new Error('--usdt must be greater than zero.');
      const before = (await publicClient.readContract({
        address: token,
        abi: tokenAbi,
        functionName: 'balanceOf',
        args: [target],
      })) as bigint;
      await send(
        funder,
        {
          to: token,
          data: encodeTransfer(target, amount),
        },
        `USDT ${usdtAmount} to ${target}`,
      );
      const after = (await publicClient.readContract({
        address: token,
        abi: tokenAbi,
        functionName: 'balanceOf',
        args: [target],
      })) as bigint;
      log(
        `[read] ${profile.asset.symbol} balance of ${target}: ${before} -> ${after} (atomic)`,
      );
    }
  }

  if (approve) {
    const permit2Arg = argValue('--permit2') ?? profile.permit2;
    if (!permit2Arg) {
      throw new Error(`${network} has no Permit2 contract in src/network.ts; pass --permit2 0x...`);
    }
    const permit2 = getAddress(permit2Arg) as Address;
    const targetKey = env.TARGET_PRIVATE_KEY;
    if (!targetKey || !KEY_RE.test(targetKey)) {
      throw new Error('Set TARGET_PRIVATE_KEY to the 32-byte hex key of the payment wallet.');
    }
    const account = privateKeyToAccount(targetKey as Hex);
    if (getAddress(account.address) !== target) {
      throw new Error('--to must match the address derived from TARGET_PRIVATE_KEY.');
    }
    const before = (await publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: 'allowance',
      args: [target, permit2],
    })) as bigint;
    if (before === maxUint256) {
      log(`[read] ${target} already approved Permit2 (${before}); nothing to send.`);
      return { txHashes, target };
    }
    await send(
      account,
      {
        to: token,
        data: encodeApprove(permit2, maxUint256),
      },
      `Permit2 approval for ${target}`,
    );
    const after = (await publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: 'allowance',
      args: [target, permit2],
    })) as bigint;
    log(`[read] ${profile.asset.symbol} allowance ${target} -> Permit2: ${before} -> ${after}`);
  }

  return { txHashes, target };
}

function encodeTransfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [to, amount] });
}

function encodeApprove(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [spender, amount] });
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
