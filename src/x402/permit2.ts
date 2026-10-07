import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseErc6492Signature,
  toHex,
  type TransactionReceipt,
} from 'viem';
import {
  PERMIT2_ADDRESS,
  x402ExactPermit2ProxyABI,
  x402UptoPermit2ProxyABI,
  x402UptoPermit2ProxyAddress,
} from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { UptoEvmScheme } from '@x402/evm/upto/facilitator';
import { profileForChainId } from '../network.ts';
import type { OpsSigner } from '../ops-signer.ts';
import type { Address, Hex } from '../types.ts';
import { ServiceError } from '../types.ts';
import type {
  X402PaymentRequirements,
  X402Permit2PaymentPayload,
  X402UptoPermit2PaymentPayload,
} from './types.ts';

// Reused from @x402/evm: the canonical Permit2 address, the
// x402ExactPermit2Proxy settle ABI, the PermitWitnessTransferFrom types and the
// official ExactEvmScheme verifier. Only the settle broadcast is local, because
// the official facilitator broadcasts inside writeContract and cannot persist a
// signed transaction before it hits the network.
export const PERMIT2 = getAddress(PERMIT2_ADDRESS) as Address;
// Canonical upto proxy address (same on every chain via CREATE2).
export const UPTO_PERMIT2_PROXY = getAddress(x402UptoPermit2ProxyAddress) as Address;

const balanceAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
const allowanceAbi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export type Permit2ReceiptResult =
  | { ok: true; txHash: Hex; blockNumber: bigint }
  | { ok: false; reason: 'pending' | 'reverted' | 'mismatch' | 'missing' };

export interface Permit2Facilitator {
  readonly facilitatorAddress: Address;
  getChainId(): Promise<number>;
  requirementsOf(input: {
    amount: string;
    asset: Address;
    payTo: Address;
  }): X402PaymentRequirements;
  // `upto` requirements advertise the upper bound and the facilitator that may
  // settle any amount up to it.
  uptoRequirementsOf(input: {
    amount: string;
    asset: Address;
    payTo: Address;
  }): X402PaymentRequirements;
  verify(input: {
    payload: X402Permit2PaymentPayload;
    requirements: X402PaymentRequirements;
  }): Promise<{ payer: Address; nonce: string; paymentKey: Hex }>;
  verifyUpto(input: {
    payload: X402UptoPermit2PaymentPayload;
    requirements: X402PaymentRequirements;
  }): Promise<{ payer: Address; nonce: string; paymentKey: Hex }>;
  // Re-checks buyer funds and Permit2 allowance before the upstream call, since
  // the upto settle happens after delivery.
  assertFunded(input: { payer: Address; asset: Address; amount: string }): Promise<void>;
  prepare(input: { payload: X402Permit2PaymentPayload }): Promise<{
    rawTransaction: Hex;
    hash: Hex;
  }>;
  prepareUpto(input: { payload: X402UptoPermit2PaymentPayload; amount: string }): Promise<{
    rawTransaction: Hex;
    hash: Hex;
  }>;
  broadcast(rawTransaction: Hex): Promise<void>;
  inspect(input: {
    txHash: Hex;
    asset: Address;
    payTo: Address;
    payer: Address;
    amount: string;
    proxy?: Address;
  }): Promise<Permit2ReceiptResult>;
}

export function permit2PaymentKey(input: {
  chainId: number;
  payer: Address;
  nonce: string;
}): Hex {
  return keccak256(
    toHex(`${input.chainId}:${input.payer.toLowerCase()}:${input.nonce}`),
  );
}

// Official invalidReason codes (from @x402/evm) mapped to operator-facing text.
const REASON_TEXT: Record<string, string> = {
  invalid_exact_evm_scheme: 'Payment scheme does not match the requirements.',
  invalid_upto_evm_scheme: 'Payment scheme does not match the requirements.',
  invalid_exact_evm_network_mismatch: 'Payment network does not match the requirements.',
  invalid_upto_evm_network_mismatch: 'Payment network does not match the requirements.',
  invalid_upto_evm_payload_settlement_exceeds_amount:
    'Settlement amount exceeds the signed upper bound.',
  upto_facilitator_mismatch: 'Payment facilitator does not match this server.',
  invalid_permit2_spender: 'Payment spender is not the x402 Permit2 proxy.',
  invalid_permit2_recipient_mismatch: 'Payment recipient does not match the requirements.',
  permit2_deadline_expired: 'Payment authorization has expired.',
  permit2_not_yet_valid: 'Payment authorization is not valid yet.',
  permit2_amount_mismatch: 'Payment amount does not match the requirements.',
  permit2_token_mismatch: 'Payment token does not match the requirements.',
  invalid_permit2_signature: 'Invalid payment signature.',
  permit2_allowance_required: 'Buyer has not approved Permit2, or the allowance is too low.',
  permit2_proxy_not_deployed: 'Settlement proxy is not deployed.',
  permit2_simulation_failed: 'Payment cannot be settled.',
  permit2_invalid_nonce: 'Payment authorization was already used.',
  asset_not_deployed_contract: 'Payment token is not deployed.',
  unsupported_payload_type: 'Invalid payment payload.',
};

const insufficientBalance = (symbol: string) => `Buyer has insufficient ${symbol} balance.`;

function reasonText(reason: string | undefined, symbol: string): string {
  if (!reason) return 'Invalid payment payload.';
  if (reason === 'permit2_insufficient_balance') return insufficientBalance(symbol);
  return REASON_TEXT[reason] ?? 'Payment failed validation.';
}

function buildSettleArgs(payload: X402Permit2PaymentPayload) {
  const { signature } = parseErc6492Signature(payload.payload.signature);
  const auth = payload.payload.permit2Authorization;
  return [
    {
      permitted: {
        token: getAddress(auth.permitted.token),
        amount: BigInt(auth.permitted.amount),
      },
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
    },
    getAddress(auth.from),
    { to: getAddress(auth.witness.to), validAfter: BigInt(auth.witness.validAfter) },
    signature,
  ] as const;
}

// upto settle: the facilitator passes the actual amount, bounded by the signed
// permitted amount; the witness binds the facilitator that may choose it.
function buildUptoArgs(payload: X402UptoPermit2PaymentPayload, amount: string) {
  const { signature } = parseErc6492Signature(payload.payload.signature);
  const auth = payload.payload.permit2Authorization;
  return [
    {
      permitted: {
        token: getAddress(auth.permitted.token),
        amount: BigInt(auth.permitted.amount),
      },
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
    },
    BigInt(amount),
    getAddress(auth.from),
    {
      to: getAddress(auth.witness.to),
      facilitator: getAddress(auth.witness.facilitator),
      validAfter: BigInt(auth.witness.validAfter),
    },
    signature,
  ] as const;
}

export function permit2ReceiptMatches(input: {
  receipt: TransactionReceipt;
  asset: Address;
  payTo: Address;
  payer: Address;
  amount: bigint;
  proxy: Address;
}): boolean {
  const { receipt, asset, payTo, payer, amount, proxy } = input;
  if (receipt.status !== 'success') return false;
  if (!receipt.to || getAddress(receipt.to) !== getAddress(proxy)) return false;
  let transfer = false;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(asset)) continue;
    try {
      const topic0 = log.topics[0];
      if (
        topic0 !==
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
      ) {
        continue;
      }
      const from = `0x${(log.topics[1] ?? '').slice(26)}` as Address;
      const to = `0x${(log.topics[2] ?? '').slice(26)}` as Address;
      const value = BigInt(log.data);
      if (
        getAddress(from) === getAddress(payer) &&
        getAddress(to) === getAddress(payTo) &&
        value === amount
      ) {
        transfer = true;
      }
    } catch {
      /* unrelated or malformed logs are not payment evidence */
    }
  }
  return transfer;
}

export function createRpcPermit2Facilitator(input: {
  rpcUrl: string;
  chainId: number;
  network: string;
  asset: Address;
  permit2: Address;
  proxy: Address;
  // The x402 upto Permit2 proxy (canonical address on all chains).
  uptoProxy: Address;
  opsSigner: OpsSigner;
  // How long a settle waits for the receipt and, on finalized networks, for the
  // block to reach finality before reporting "pending". Measured 968 lag is
  // 1-2 blocks (~2s), well inside this budget.
  finalityTimeoutMs?: number;
  finalityPollMs?: number;
}): Permit2Facilitator {
  const profile = profileForChainId(input.chainId);
  const finalized = profile?.finality.kind === 'finalized';
  const symbol = profile?.asset.symbol ?? 'token';
  const finalityTimeoutMs = input.finalityTimeoutMs ?? 30_000;
  const finalityPollMs = input.finalityPollMs ?? 500;
  const chain = defineChain({
    id: input.chainId,
    name: 'x402 permit2 settlement network',
    nativeCurrency: { name: 'Test gas', symbol: 'TEST', decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(input.rpcUrl),
    cacheTime: 0,
  });

  type FacilitatorSigner = ConstructorParameters<typeof ExactEvmScheme>[0];
  const notUsed = async (): Promise<never> => {
    throw new Error('self-hosted facilitator signs settlements outside the scheme');
  };
  // Only the read/simulate half of the official signer is used; settle is
  // reimplemented below so the signed transaction can be journaled first.
  const facilitatorSigner = {
    getAddresses: () => [input.opsSigner.address],
    // eth_call must carry the ops address as `from`: the upto proxy requires
    // msg.sender == witness.facilitator, so the verify simulation only passes
    // when the call originates from the facilitator.
    readContract: (args: unknown) =>
      publicClient.readContract({
        account: input.opsSigner.address,
        ...(args as Record<string, unknown>),
      } as Parameters<typeof publicClient.readContract>[0]),
    verifyTypedData: (args: unknown) =>
      publicClient.verifyTypedData(args as Parameters<typeof publicClient.verifyTypedData>[0]),
    writeContract: notUsed,
    sendTransaction: notUsed,
    waitForTransactionReceipt: notUsed,
    getCode: ({ address }: { address: Address }) => publicClient.getCode({ address }),
  } as unknown as FacilitatorSigner;
  const scheme = new ExactEvmScheme(facilitatorSigner);
  const uptoScheme = new UptoEvmScheme(facilitatorSigner);

  const requirementsOf: Permit2Facilitator['requirementsOf'] = ({ amount, asset, payTo }) => ({
    scheme: 'exact',
    network: input.network,
    amount,
    asset: getAddress(asset),
    payTo: getAddress(payTo),
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod: 'permit2',
      permit2: input.permit2,
      x402Permit2Proxy: input.proxy,
    },
  });
  const uptoRequirementsOf: Permit2Facilitator['uptoRequirementsOf'] = ({
    amount,
    asset,
    payTo,
  }) => ({
    scheme: 'upto',
    network: input.network,
    amount,
    asset: getAddress(asset),
    payTo: getAddress(payTo),
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod: 'permit2',
      permit2: input.permit2,
      x402UptoPermit2Proxy: input.uptoProxy,
      // The client must sign this into the witness so only this facilitator can
      // choose the final amount.
      facilitatorAddress: input.opsSigner.address,
    },
  });

  const assertFunded: Permit2Facilitator['assertFunded'] = async ({ payer, asset, amount }) => {
    const required = BigInt(amount);
    let balance: bigint;
    let allowance: bigint;
    try {
      balance = (await publicClient.readContract({
        address: asset,
        abi: balanceAbi,
        functionName: 'balanceOf',
        args: [payer],
      })) as bigint;
      allowance = (await publicClient.readContract({
        address: asset,
        abi: allowanceAbi,
        functionName: 'allowance',
        args: [payer, input.permit2],
      })) as bigint;
    } catch {
      throw new ServiceError(402, 'Payment token is not deployed.');
    }
    if (balance < required) {
      throw new ServiceError(402, insufficientBalance(symbol));
    }
    if (allowance < required) {
      throw new ServiceError(402, 'Buyer has not approved Permit2, or the allowance is too low.');
    }
  };

  return {
    facilitatorAddress: input.opsSigner.address,
    async getChainId() {
      const id = await publicClient.getChainId();
      if (id !== input.chainId) throw new Error('RPC chain mismatch');
      return id;
    },
    requirementsOf,
    uptoRequirementsOf,
    assertFunded,
    async verify({ payload, requirements }) {
      const auth = payload.payload.permit2Authorization;
      const payer = getAddress(auth.from) as Address;
      if (getAddress(auth.spender) !== input.proxy) {
        throw new ServiceError(402, 'Payment spender is not the x402 Permit2 proxy.');
      }
      const code = await publicClient.getCode({ address: input.proxy });
      if (!code || code === '0x') {
        throw new ServiceError(402, 'Settlement proxy is not deployed.');
      }
      await assertFunded({ payer, asset: input.asset, amount: requirements.amount });
      // Official verifier: scheme/network/spender/recipient/deadline/amount/token,
      // signature recovery and an eth_call simulation of the proxy settle.
      const result = await scheme.verify(
        payload as unknown as Parameters<typeof scheme.verify>[0],
        requirements as unknown as Parameters<typeof scheme.verify>[1],
      );
      if (!result.isValid) {
        throw new ServiceError(402, reasonText(result.invalidReason, symbol));
      }
      return {
        payer,
        nonce: auth.nonce,
        paymentKey: permit2PaymentKey({ chainId: input.chainId, payer, nonce: auth.nonce }),
      };
    },
    async verifyUpto({ payload, requirements }) {
      const auth = payload.payload.permit2Authorization;
      const payer = getAddress(auth.from) as Address;
      if (getAddress(auth.spender) !== input.uptoProxy) {
        throw new ServiceError(402, 'Payment spender is not the x402 Permit2 proxy.');
      }
      const code = await publicClient.getCode({ address: input.uptoProxy });
      if (!code || code === '0x') {
        throw new ServiceError(402, 'Settlement proxy is not deployed.');
      }
      await assertFunded({ payer, asset: input.asset, amount: requirements.amount });
      // The official upto verifier enforces permitted.amount == requirements.amount,
      // the facilitator witness binding, the signature and the settle simulation.
      const result = await uptoScheme.verify(
        payload as unknown as Parameters<typeof uptoScheme.verify>[0],
        requirements as unknown as Parameters<typeof uptoScheme.verify>[1],
      );
      if (!result.isValid) {
        throw new ServiceError(402, reasonText(result.invalidReason, symbol));
      }
      return {
        payer,
        nonce: auth.nonce,
        paymentKey: permit2PaymentKey({ chainId: input.chainId, payer, nonce: auth.nonce }),
      };
    },
    async prepare({ payload }) {
      const data = encodeFunctionData({
        abi: x402ExactPermit2ProxyABI,
        functionName: 'settle',
        args: buildSettleArgs(payload),
      });
      return input.opsSigner.sign({ to: input.proxy, data });
    },
    async prepareUpto({ payload, amount }) {
      const data = encodeFunctionData({
        abi: x402UptoPermit2ProxyABI,
        functionName: 'settle',
        args: buildUptoArgs(payload, amount),
      });
      return input.opsSigner.sign({ to: input.uptoProxy, data });
    },
    async broadcast(rawTransaction) {
      await input.opsSigner.sendRawTransaction(rawTransaction);
    },
    async inspect({ txHash, asset, payTo, payer, amount, proxy }) {
      const deadline = Date.now() + finalityTimeoutMs;
      const sleep = () => new Promise((resolve) => setTimeout(resolve, finalityPollMs));
      const readReceipt = async (): Promise<TransactionReceipt | null> => {
        try {
          return await publicClient.getTransactionReceipt({ hash: txHash });
        } catch {
          return null;
        }
      };
      // A broadcast transaction may not be mined yet; wait inside the budget so
      // one request can still settle and deliver without a client retry.
      let receipt = await readReceipt();
      while (!receipt && Date.now() < deadline) {
        await sleep();
        receipt = await readReceipt();
      }
      if (!receipt) return { ok: false, reason: 'missing' };
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) return { ok: false, reason: 'pending' };
      if (finalized) {
        // 968 finalizes 1-2 blocks behind the head (~2s), so waiting here keeps
        // the delivered payment final without a background reorg watcher.
        const readFinalized = () => publicClient.getBlock({ blockTag: 'finalized' });
        let finalizedBlock = await readFinalized();
        while (
          (finalizedBlock.number === null || finalizedBlock.number < receipt.blockNumber) &&
          Date.now() < deadline
        ) {
          await sleep();
          finalizedBlock = await readFinalized();
        }
        if (finalizedBlock.number === null || finalizedBlock.number < receipt.blockNumber) {
          return { ok: false, reason: 'pending' };
        }
      }
      if (receipt.status === 'reverted') return { ok: false, reason: 'reverted' };
      if (
        !permit2ReceiptMatches({
          receipt,
          asset,
          payTo,
          payer,
          amount: BigInt(amount),
          proxy: proxy ?? input.proxy,
        })
      ) {
        return { ok: false, reason: 'mismatch' };
      }
      return { ok: true, txHash, blockNumber: receipt.blockNumber };
    },
  };
}
