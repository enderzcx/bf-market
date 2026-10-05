import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from './types.ts';

// One process-wide signer for the ops wallet. The same key pays starter gas and
// settles Permit2 payments, so every signature must go through this queue: it
// serializes signing and hands out strictly increasing nonces, otherwise the two
// paths would race and collide on the same nonce.
export interface OpsSigner {
  readonly address: Address;
  sign(input: {
    to: Address;
    data?: Hex;
    value?: bigint;
  }): Promise<{ rawTransaction: Hex; hash: Hex }>;
  sendRawTransaction(rawTransaction: Hex): Promise<void>;
}

export function createOpsSigner(input: {
  rpcUrl: string;
  chainId: number;
  privateKey: Hex;
}): OpsSigner {
  const account = privateKeyToAccount(input.privateKey);
  const chain = defineChain({
    id: input.chainId,
    name: 'ops signer network',
    nativeCurrency: { name: 'Test gas', symbol: 'TEST', decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(input.rpcUrl),
    cacheTime: 0,
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(input.rpcUrl),
  });

  let queue: Promise<unknown> = Promise.resolve();
  let nextNonce: number | null = null;

  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    address: account.address as Address,
    sign({ to, data, value }) {
      return runExclusive(async () => {
        if (nextNonce === null) {
          nextNonce = await publicClient.getTransactionCount({
            address: account.address,
            blockTag: 'pending',
          });
        }
        const nonce = nextNonce;
        const request = await walletClient.prepareTransactionRequest({
          account,
          to,
          data,
          value: value ?? 0n,
          nonce,
        });
        const rawTransaction = await walletClient.signTransaction(request);
        // Only advance after a successful signature so a failed prepare does not
        // burn a nonce.
        nextNonce = nonce + 1;
        return { rawTransaction, hash: keccak256(rawTransaction) };
      });
    },
    async sendRawTransaction(rawTransaction) {
      await publicClient.sendRawTransaction({ serializedTransaction: rawTransaction });
    },
  };
}
