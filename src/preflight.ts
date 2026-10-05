import { createPublicClient, defineChain, http, parseAbi } from 'viem';
import type { NetworkProfile } from './network.ts';
import type { Address } from './types.ts';

const erc20DecimalsAbi = parseAbi([
  'function decimals() view returns (uint8)',
]);

// Injectable RPC surface so the preflight can be unit tested with stubs.
export type PreflightRpc = {
  getChainId(): Promise<number>;
  getCode(address: Address): Promise<string | undefined>;
  readDecimals(address: Address): Promise<number>;
};

export function rpcPreflightClient(input: {
  rpcUrl: string;
  chainId: number;
}): PreflightRpc {
  const chain = defineChain({
    id: input.chainId,
    name: 'settlement preflight',
    nativeCurrency: { name: 'Test gas', symbol: 'TEST', decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(input.rpcUrl),
    cacheTime: 0,
  });
  return {
    async getChainId() {
      return client.getChainId();
    },
    async getCode(address) {
      return client.getCode({ address });
    },
    async readDecimals(address) {
      return client.readContract({
        address,
        abi: erc20DecimalsAbi,
        functionName: 'decimals',
      });
    },
  };
}

// Read-only startup gate: refuses to start when the selected network does not
// match its profile. Never writes to the chain.
export async function assertNetworkPreflight(input: {
  profile: NetworkProfile;
  rpc: PreflightRpc;
  token?: Address;
}): Promise<void> {
  const { profile, rpc } = input;
  const errors: string[] = [];

  const chainId = await rpc.getChainId();
  if (chainId !== profile.chainId) {
    errors.push(
      `RPC eth_chainId=${chainId}，与 ${profile.name} profile 的 ${profile.chainId} 不一致。`,
    );
  }

  const token = input.token ?? profile.asset.address;
  const tokenCode = await rpc.getCode(token);
  if (!tokenCode || tokenCode === '0x') {
    errors.push(`资产合约 ${token} 没有代码。`);
  } else {
    const decimals = await rpc.readDecimals(token);
    if (decimals !== profile.asset.decimals) {
      errors.push(
        `资产 ${token} 精度为 ${decimals}，与 profile 的 ${profile.asset.decimals} 不一致。`,
      );
    }
  }

  const contracts: Array<[string, Address | undefined]> = [
    ['Permit2', profile.permit2],
    ['x402 Permit2 代理', profile.x402Permit2Proxy],
    ['身份注册表', profile.identityRegistry],
  ];
  for (const [label, address] of contracts) {
    if (!address) continue;
    const code = await rpc.getCode(address);
    if (!code || code === '0x') {
      errors.push(`${label} ${address} 没有代码。`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`网络预检未通过（${profile.name}）：${errors.join(' ')}`);
  }
}
