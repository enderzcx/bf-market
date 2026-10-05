import {
  createPublicClient,
  defineChain,
  http,
  parseTransaction,
  recoverTransactionAddress,
  TransactionReceiptNotFoundError,
  type TransactionSerialized,
} from 'viem';
import { profileForChainId } from './network.ts';
import { createOpsSigner, type OpsSigner } from './ops-signer.ts';
import type { Store } from './store.ts';
import type {
  Address,
  Hex,
  StarterGasRecord,
  StarterGasStatus,
} from './types.ts';
import { ServiceError } from './types.ts';

const same = (a: string | null | undefined, b: string) =>
  a != null && a.toLowerCase() === b.toLowerCase();

export type StarterGasGrant = {
  status: StarterGasStatus;
  txHash: Hex | null;
  amountWei: string;
};

// Writes native gas to a fresh wallet. Signing is separated from broadcasting so
// a signed transfer can be persisted before it ever hits the network.
export interface StarterGasChain {
  getChainId(): Promise<number>;
  getBalance(address: Address): Promise<bigint>;
  signTransfer(input: {
    to: Address;
    amountWei: bigint;
  }): Promise<{ rawTransaction: Hex; hash: Hex }>;
  broadcast(rawTransaction: Hex): Promise<void>;
  inspect(hash: Hex): Promise<'pending' | 'confirmed' | 'reverted'>;
}

export function createRpcStarterGasChain(input: {
  rpcUrl: string;
  chainId: number;
  privateKey: Hex;
  signer?: OpsSigner;
}): StarterGasChain {
  const finalized =
    profileForChainId(input.chainId)?.finality.kind === 'finalized';
  const chain = defineChain({
    id: input.chainId,
    name: 'starter gas network',
    nativeCurrency: { name: 'Test gas', symbol: 'TEST', decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  });
  // Starter gas and Permit2 settlement share one ops wallet. Signing through the
  // shared serialized signer keeps their nonces from colliding.
  const signer =
    input.signer ??
    createOpsSigner({
      rpcUrl: input.rpcUrl,
      chainId: input.chainId,
      privateKey: input.privateKey,
    });
  const account = { address: signer.address };
  const publicClient = createPublicClient({
    chain,
    transport: http(input.rpcUrl),
    cacheTime: 0,
  });
  return {
    async getChainId() {
      const id = await publicClient.getChainId();
      if (id !== input.chainId) throw new Error('RPC chain mismatch');
      return id;
    },
    async getBalance(address) {
      return publicClient.getBalance({ address });
    },
    async signTransfer({ to, amountWei }) {
      return signer.sign({ to, value: amountWei });
    },
    async broadcast(raw) {
      const tx = parseTransaction(raw);
      if (
        tx.chainId !== input.chainId ||
        !tx.to ||
        (tx.value ?? 0n) <= 0n ||
        !same(
          await recoverTransactionAddress({
            serializedTransaction: raw as TransactionSerialized,
          }),
          account.address,
        )
      ) {
        throw new Error('Signed starter gas configuration mismatch');
      }
      await signer.sendRawTransaction(raw);
    },
    async inspect(hash) {
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash });
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return 'pending';
        throw err;
      }
      const block = await publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      });
      if (block.hash !== receipt.blockHash) return 'pending';
      if (finalized) {
        const finalizedBlock = await publicClient.getBlock({
          blockTag: 'finalized',
        });
        if (
          finalizedBlock.number === null ||
          finalizedBlock.number < receipt.blockNumber
        ) {
          return 'pending';
        }
      }
      return receipt.status === 'reverted' ? 'reverted' : 'confirmed';
    },
  };
}

export function createStarterGasService(opts: {
  store: Store;
  chain: StarterGasChain;
  config: {
    starterGasEnabled: boolean;
    starterGasWei: bigint;
    starterGasDailyCapWei: bigint;
    starterGasBalanceThresholdWei: bigint;
  };
  now: () => number;
}) {
  const day = () => new Date(opts.now()).toISOString().slice(0, 10);

  const snapshot = (record: StarterGasRecord): StarterGasGrant => ({
    status: record.status,
    txHash: record.txHash,
    amountWei: record.amountWei,
  });

  return {
    enabled: opts.config.starterGasEnabled,
    async grant(address: Address): Promise<StarterGasGrant> {
      if (!opts.config.starterGasEnabled) {
        throw new ServiceError(403, '启动 gas 未开启。');
      }
      let record = opts.store.getStarterGas(address);
      if (record) {
        if (record.status === 'blocked') {
          throw new ServiceError(409, record.error ?? '该地址的启动 gas 已被阻止。');
        }
        if (record.status === 'confirmed') return snapshot(record);
      } else {
        const balance = await opts.chain.getBalance(address);
        if (balance >= opts.config.starterGasBalanceThresholdWei) {
          throw new ServiceError(409, '地址余额充足，无需启动 gas。');
        }
        const used = opts.store.sumStarterGasForDay(day());
        if (used + opts.config.starterGasWei > opts.config.starterGasDailyCapWei) {
          throw new ServiceError(429, '今日启动 gas 额度已用完。');
        }
        record = opts.store.reserveStarterGas({
          address,
          amountWei: opts.config.starterGasWei,
          day: day(),
        });
      }

      if (record.status === 'reserved') {
        const signed = await opts.chain.signTransfer({
          to: address,
          amountWei: BigInt(record.amountWei),
        });
        opts.store.markStarterGasSigned(address, signed.rawTransaction, signed.hash);
        record = opts.store.getStarterGas(address)!;
      }

      // A signed transfer is replayed as-is; never sign a second one for the
      // same address, so an uncertain broadcast can only land once.
      if (record.status === 'signed') {
        try {
          await opts.chain.broadcast(record.journal!);
        } catch {
          throw new ServiceError(502, '启动 gas 广播状态未知，请重试。');
        }
        opts.store.markStarterGasBroadcast(address);
        record = opts.store.getStarterGas(address)!;
      }

      if (record.status === 'broadcast') {
        const result = await opts.chain.inspect(record.txHash!);
        if (result === 'confirmed') {
          opts.store.markStarterGasConfirmed(address);
          return snapshot(opts.store.getStarterGas(address)!);
        }
        if (result === 'reverted') {
          opts.store.blockStarterGas(address, '启动 gas 交易失败。');
          throw new ServiceError(502, '启动 gas 交易失败。');
        }
        return snapshot(record);
      }

      return snapshot(record);
    },
  };
}
