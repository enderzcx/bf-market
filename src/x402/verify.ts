import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  parseAbi,
  type TransactionReceipt,
} from "viem";
import { profileForChainId } from "../network.ts";
import type { Address, Hex } from "../types.ts";
import {
  X402_SCAN_CHUNK,
  X402_SCAN_SPAN,
  type X402Chain,
  type X402ReceiptResult,
} from "./types.ts";

const eip3009Abi = parseAbi([
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const same = (a: string | null | undefined, b: string) =>
  a != null && a.toLowerCase() === b.toLowerCase();

export function receiptMatchesPayment(input: {
  receipt: TransactionReceipt;
  token: Address;
  payTo: Address;
  payer: Address;
  amount: bigint;
  nonce: Hex;
}): boolean {
  const { receipt, token, payTo, payer, amount, nonce } = input;
  if (receipt.status !== "success") return false;
  // Circle emits AuthorizationUsed immediately before that authorization's Transfer.
  // Match the adjacent pair: a separate transfer in a Multicall batch is not proof.
  for (let i = 0; i < receipt.logs.length; i++) {
    const log = receipt.logs[i]!;
    if (!same(log.address, token)) continue;
    try {
      const event = decodeEventLog({ abi: eip3009Abi, data: log.data, topics: log.topics });
      if (event.eventName !== "AuthorizationUsed" ||
          !same(String(event.args.authorizer), payer) ||
          String(event.args.nonce).toLowerCase() !== nonce.toLowerCase()) continue;
      const next = receipt.logs[i + 1];
      if (!next || !same(next.address, token)) return false;
      const transfer = decodeEventLog({ abi: eip3009Abi, data: next.data, topics: next.topics });
      return transfer.eventName === "Transfer" &&
        same(String(transfer.args.from), payer) &&
        same(String(transfer.args.to), payTo) && transfer.args.value === amount;
    } catch { /* unrelated or malformed logs are not payment evidence */ }
  }
  return false;
}

export function createRpcX402Chain(input: {
  rpcUrl: string;
  chainId: number;
}): X402Chain {
  const finalized = profileForChainId(input.chainId)?.finality.kind === "finalized";
  const chain = defineChain({
    id: input.chainId,
    name: "x402 verify network",
    nativeCurrency: { name: "Test gas", symbol: "TEST", decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(input.rpcUrl),
    cacheTime: 0,
  });

  const inspectReceipt: X402Chain["inspectReceipt"] = async (args) => {
    let receipt: TransactionReceipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: args.txHash });
    } catch {
      return { ok: false, reason: "missing" };
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) return { ok: false, reason: "pending" };
    if (finalized) {
      const finalizedBlock = await client.getBlock({ blockTag: "finalized" });
      if (
        finalizedBlock.number === null ||
        finalizedBlock.number < receipt.blockNumber
      ) {
        return { ok: false, reason: "pending" };
      }
    }
    if (receipt.status === "reverted") return { ok: false, reason: "reverted" };
    if (
      !receiptMatchesPayment({
        receipt,
        token: args.token,
        payTo: args.payTo,
        payer: args.payer,
        amount: args.amount,
        nonce: args.nonce,
      })
    ) {
      return { ok: false, reason: "mismatch" };
    }
    return { ok: true, txHash: args.txHash, blockNumber: receipt.blockNumber };
  };

  return {
    async getBlockNumber() {
      return client.getBlockNumber();
    },
    async getChainId() {
      const id = await client.getChainId();
      if (id !== input.chainId) {
        throw new Error("RPC chain mismatch");
      }
      return id;
    },
    inspectReceipt,
    async findAuthorization(args) {
      const start = args.fromBlock;
      const hardEnd =
        args.toBlock < start + X402_SCAN_SPAN
          ? args.toBlock
          : start + X402_SCAN_SPAN - 1n;
      if (hardEnd < start) return null;
      for (let from = start; from <= hardEnd; from += X402_SCAN_CHUNK) {
        const to =
          from + X402_SCAN_CHUNK - 1n > hardEnd
            ? hardEnd
            : from + X402_SCAN_CHUNK - 1n;
        const logs = await client.getLogs({
          address: args.token,
          event: eip3009Abi[0],
          args: { authorizer: args.payer, nonce: args.nonce },
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs) {
          if (!log.transactionHash) continue;
          const checked = await inspectReceipt({
            txHash: log.transactionHash,
            token: args.token,
            payTo: args.payTo,
            payer: args.payer,
            amount: args.amount,
            nonce: args.nonce,
          });
          if (checked.ok) return checked.txHash;
        }
      }
      return null;
    },
  };
}
