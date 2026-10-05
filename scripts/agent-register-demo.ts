import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Walks the M3 registration flow as an Agent: challenge -> sign -> draft ->
// send the register transaction with the Agent's own wallet -> confirm -> read
// the record back. Defaults to the local chain; a public testnet requires both
// --network botchain-testnet and --send to be explicit.
const KNOWN_NETWORKS = {
  local: { chainId: 31337, rpcUrl: "http://127.0.0.1:8547" },
  "botchain-testnet": { chainId: 968, rpcUrl: "https://rpc.bohr.life" },
} as const;

const args = process.argv.slice(2);
const hasFlag = (name: string) => args.includes(name);
const argValue = (name: string, fallback: string): string => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1]! : fallback;
};

const network = argValue("--network", "local");
if (!(network in KNOWN_NETWORKS)) {
  throw new Error(`未知网络 ${network}。只允许：${Object.keys(KNOWN_NETWORKS).join(" | ")}。`);
}
const expected = KNOWN_NETWORKS[network as keyof typeof KNOWN_NETWORKS];
const isLocal = network === "local";
if (!isLocal && !hasFlag("--send")) {
  throw new Error("对非本地网络运行必须同时给出 --network 与 --send。");
}

const serverUrl = argValue("--url", "http://127.0.0.1:4311").replace(/\/+$/, "");
const rpcUrl = argValue("--rpc", expected.rpcUrl);
const privateKey = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
if (!privateKey) {
  throw new Error("请通过 AGENT_PRIVATE_KEY 提供 Agent 钱包私钥（仅从环境读取）。");
}

const account = privateKeyToAccount(privateKey);
const chain = defineChain({
  id: expected.chainId,
  name: network,
  nativeCurrency: { name: "Test gas", symbol: "TEST", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(`${path} 失败：${message}`);
  }
  return body as T;
}

const chainId = await publicClient.getChainId();
if (chainId !== expected.chainId) {
  throw new Error(`RPC 链 ID ${chainId} 与 ${network} 的 ${expected.chainId} 不一致。`);
}

const profile = {
  name: "Demo Agent",
  description: "BF Market M3 registration demo agent",
  services: [{ name: "web", endpoint: `${serverUrl}/` }],
  x402Support: false,
  active: true,
};

console.log(`[demo] agent=${account.address} network=${network} server=${serverUrl}`);

const challenge = await api<{ message: string; purpose: string }>("/api/agents/challenge", {
  method: "POST",
  body: JSON.stringify({ address: account.address, purpose: "agent-draft" }),
});
const signature = await account.signMessage({ message: challenge.message });

const draft = await api<{
  draftId: string;
  agentURI: string;
  registerTx: { chainId: number; to: `0x${string}`; data: `0x${string}`; value: string };
}>("/api/agents/drafts", {
  method: "POST",
  body: JSON.stringify({
    address: account.address,
    signature,
    role: "provider",
    profile,
  }),
});
console.log(`[demo] draftId=${draft.draftId} agentURI=${draft.agentURI}`);

const gas = await publicClient.estimateGas({
  account: account.address,
  to: draft.registerTx.to,
  data: draft.registerTx.data,
  value: BigInt(draft.registerTx.value),
});
const txHash = await wallet.sendTransaction({
  to: draft.registerTx.to,
  data: draft.registerTx.data,
  value: BigInt(draft.registerTx.value),
  gas: (gas * 120n) / 100n,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== "success") {
  throw new Error(`注册交易失败：${txHash}`);
}
console.log(`[demo] registerTx=${txHash}`);

let confirmed: { agent: { agentId: string } } | null = null;
for (let attempt = 0; attempt < 10; attempt += 1) {
  const result = await api<
    | { status: "pending" }
    | { status: "confirmed"; agent: { agentId: string } }
  >("/api/agents/confirm", {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
  if (result.status === "confirmed") {
    confirmed = result;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!confirmed) throw new Error("注册确认仍在等待最终确认。");
console.log(`[demo] confirmed agentId=${confirmed.agent.agentId}`);

const record = await api<{ agent: unknown }>(`/api/agents/${confirmed.agent.agentId}`);
console.log(`[demo] record=${JSON.stringify(record.agent)}`);

const document = await fetch(draft.agentURI).then((res) => res.json());
console.log(`[demo] registration=${JSON.stringify(document)}`);
