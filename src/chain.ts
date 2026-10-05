import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  encodeFunctionData,
  decodeEventLog,
  decodeFunctionData,
  keccak256,
  toHex,
  parseTransaction,
  recoverTransactionAddress,
  TransactionReceiptNotFoundError,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORK_PROFILES, profileForChainId } from "./network.ts";
export type Payout = {
  id: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
};
export type Prepared = { rawTransaction: `0x${string}`; hash: `0x${string}` };
export interface Chain {
  prepare(p: Payout): Promise<Prepared>;
  broadcast(raw: `0x${string}`): Promise<void>;
  inspect(
    p: Payout,
    hash: `0x${string}`,
  ): Promise<"pending" | "confirmed" | "reverted">;
  balances(): Promise<{ token: string; gas: string }>;
}
export const settlementAbi = parseAbi([
  "function pay(bytes32 payoutId,address recipient,uint256 amount)",
  "function token() view returns(address)",
  "function hasRole(bytes32 role,address account) view returns(bool)",
  "function paid(bytes32 payoutId) view returns(bool)",
  "function pause()",
  "function unpause()",
  "event Paid(bytes32 indexed payoutId,address indexed recipient,uint256 amount,address indexed token)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export type EvmConfig = {
  rpcUrl: string;
  chainId: number;
  contract: `0x${string}`;
  token: `0x${string}`;
  privateKey: `0x${string}`;
};
export const FUJI_USDC = NETWORK_PROFILES.fuji.asset.address;
const LOCAL_TEST_KEYS = [1, 2].map(
  (n) => `0x${n.toString(16).padStart(64, "0")}`,
);
const same = (a: string | null | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();
export class EvmChain implements Chain {
  readonly publicClient;
  readonly walletClient;
  readonly account;
  constructor(readonly config: EvmConfig) {
    const profile = profileForChainId(config.chainId);
    if (!profile) throw new Error("Unknown settlement network");
    if (
      profile.name === "local" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(config.rpcUrl).hostname,
      )
    )
      throw new Error("Local chain RPC must be loopback");
    if (profile.name === "fuji" && !same(config.token, profile.asset.address))
      throw new Error("Fuji requires Circle test USDC");
    if (
      profile.name === "fuji" &&
      (LOCAL_TEST_KEYS.includes(config.privateKey.toLowerCase()) ||
        config.privateKey.toLowerCase() ===
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
    )
      throw new Error("Public local test keys are forbidden on Fuji");
    this.account = privateKeyToAccount(config.privateKey);
    const chain = defineChain({
      id: config.chainId,
      name: "Settlement test network",
      nativeCurrency: { name: "Test gas", symbol: "TEST", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    this.publicClient = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
      cacheTime: 0,
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(config.rpcUrl),
    });
  }
  private async validate() {
    if ((await this.publicClient.getChainId()) !== this.config.chainId)
      throw new Error("RPC chain mismatch");
    const token = await this.publicClient.readContract({
      address: this.config.contract,
      abi: settlementAbi,
      functionName: "token",
    });
    if (!same(token, this.config.token))
      throw new Error("Settlement token mismatch");
    const decimals = profileForChainId(this.config.chainId)?.asset.decimals;
    if (
      (await this.publicClient.readContract({
        address: this.config.token,
        abi: tokenAbi,
        functionName: "decimals",
      })) !== decimals
    )
      throw new Error(`Expected ${decimals} decimal test token`);
  }
  async prepare(p: Payout): Promise<Prepared> {
    await this.validate();
    if (
      !(await this.publicClient.readContract({
        address: this.config.contract,
        abi: settlementAbi,
        functionName: "hasRole",
        args: [keccak256(toHex("EXECUTOR_ROLE")), this.account.address],
      }))
    )
      throw new Error("Signer lacks executor role");
    await this.publicClient.simulateContract({
      account: this.account,
      address: this.config.contract,
      abi: settlementAbi,
      functionName: "pay",
      args: [p.id, p.recipient, p.amount],
    });
    const request = await this.walletClient.prepareTransactionRequest({
      to: this.config.contract,
      data: encodeFunctionData({
        abi: settlementAbi,
        functionName: "pay",
        args: [p.id, p.recipient, p.amount],
      }),
      nonce: await this.publicClient.getTransactionCount({
        address: this.account.address,
        blockTag: "pending",
      }),
    });
    const rawTransaction = await this.walletClient.signTransaction(request);
    return { rawTransaction, hash: keccak256(rawTransaction) };
  }
  async broadcast(raw: `0x${string}`) {
    await this.validate();
    const tx = parseTransaction(raw);
    if (
      tx.chainId !== this.config.chainId ||
      !same(tx.to, this.config.contract) ||
      !same(
        await recoverTransactionAddress({
          serializedTransaction: raw as TransactionSerialized,
        }),
        this.account.address,
      ) ||
      (tx.value ?? 0n) !== 0n
    )
      throw new Error("Signed transaction configuration mismatch");
    const decoded = decodeFunctionData({ abi: settlementAbi, data: tx.data! });
    if (decoded.functionName !== "pay")
      throw new Error("Not a payout transaction");
    const [id, recipient, amount] = decoded.args;
    if (
      BigInt(id) === 0n ||
      BigInt(recipient) === 0n ||
      same(recipient, this.config.contract) ||
      amount <= 0n
    )
      throw new Error("Invalid signed payout");
    await this.publicClient.sendRawTransaction({ serializedTransaction: raw });
  }
  async inspect(
    p: Payout,
    hash: `0x${string}`,
  ): Promise<"pending" | "confirmed" | "reverted"> {
    await this.validate();
    let receipt;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash });
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return "pending";
      throw e;
    }
    const tx = await this.publicClient.getTransaction({ hash });
    const expected = encodeFunctionData({
      abi: settlementAbi,
      functionName: "pay",
      args: [p.id, p.recipient, p.amount],
    });
    // A wrong receipt is an evidence failure, never permission to release frozen funds.
    if (
      !same(tx.to, this.config.contract) ||
      !same(tx.from, this.account.address) ||
      tx.input !== expected ||
      tx.value !== 0n
    )
      throw new Error("Payout transaction mismatch");
    const block = await this.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (block.hash !== receipt.blockHash) return "pending";
    if (profileForChainId(this.config.chainId)?.finality.kind === "finalized") {
      const finalized = await this.publicClient.getBlock({
        blockTag: "finalized",
      });
      if (finalized.number === null || finalized.number < receipt.blockNumber)
        return "pending";
    }
    if (receipt.status === "reverted") return "reverted";
    let paid = false,
      transfer = false;
    for (const log of receipt.logs) {
      try {
        if (same(log.address, this.config.contract)) {
          const event = decodeEventLog({
            abi: settlementAbi,
            data: log.data,
            topics: log.topics,
          });
          if (event.eventName === "Paid")
            paid =
              same(event.args.payoutId, p.id) &&
              same(event.args.recipient, p.recipient) &&
              event.args.amount === p.amount &&
              same(event.args.token, this.config.token);
        }
        if (same(log.address, this.config.token)) {
          const event = decodeEventLog({
            abi: tokenAbi,
            data: log.data,
            topics: log.topics,
          });
          if (event.eventName === "Transfer")
            transfer ||=
              same(event.args.from, this.config.contract) &&
              same(event.args.to, p.recipient) &&
              event.args.value === p.amount;
        }
      } catch {
        /* unrelated logs are not settlement evidence */
      }
    }
    if (!paid || !transfer)
      throw new Error("Missing matching payout and token transfer evidence");
    return "confirmed"; // profile finality: finalized block or canonical inclusion.
  }
  async balances() {
    await this.validate();
    const [token, gas] = await Promise.all([
      this.publicClient.readContract({
        address: this.config.token,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [this.config.contract],
      }),
      this.publicClient.getBalance({ address: this.account.address }),
    ]);
    return { token: token.toString(), gas: gas.toString() };
  }
}
