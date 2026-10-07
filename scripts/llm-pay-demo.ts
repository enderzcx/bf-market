import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import {
  decodePaymentResponseHeader,
  x402HTTPClient,
} from '@x402/core/http';
import {
  UptoEvmScheme,
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
} from '@x402/evm/upto/client';

// Buyer demo for the M5 metered LLM services (x402 `upto` / Permit2).
//
// Reads the 402 offer, picks the upto option, tops up the Permit2 allowance
// once if needed, signs the official upto payment payload, resends the request
// and prints the model reply, the token usage, the actual charge and the
// settlement transaction hash.
//
// Defaults to the local chain only. Paying on BOT Chain testnet additionally
// requires `--network botchain-testnet --send`; that path is not run here.
//
// Usage:
//   AGENT_PRIVATE_KEY=0x... bun scripts/llm-pay-demo.ts \
//     [--url http://127.0.0.1:4311/api/services/llm-glm-5-3/call] \
//     [--rpc http://127.0.0.1:8547] \
//     [--body '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":256}']

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const network = arg('network') ?? 'local';
const send = process.argv.includes('--send');
const url =
  arg('url') ?? process.env.SERVICE_URL ?? 'http://127.0.0.1:4311/api/services/llm-glm-5-3/call';
const rpcUrl = arg('rpc') ?? process.env.SETTLEMENT_RPC_URL ?? 'http://127.0.0.1:8547';
const bodyText =
  arg('body') ?? '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":256}';

if (network !== 'local' && !send) {
  console.error(
    `Refusing to pay on ${network} without --send. Testnet payments move real test funds.`,
  );
  process.exit(1);
}

const key = process.env.AGENT_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('Set AGENT_PRIVATE_KEY to a 32-byte hex private key.');
  process.exit(1);
}

let body: Record<string, unknown>;
try {
  const parsed = JSON.parse(bodyText) as unknown;
  body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
} catch {
  console.error('--body must be a JSON object.');
  process.exit(1);
}

const NETWORKS = {
  local: { chainId: 31337, name: 'Local test chain', native: 'TEST' },
  fuji: { chainId: 43113, name: 'Avalanche Fuji', native: 'AVAX' },
  'botchain-testnet': { chainId: 968, name: 'BOT Chain Testnet', native: 'tBOT' },
} as const;

const account = privateKeyToAccount(key as `0x${string}`);
const net = NETWORKS[network as keyof typeof NETWORKS];
if (!net) {
  console.error(`Unknown network ${network}. Allowed: ${Object.keys(NETWORKS).join(' | ')}.`);
  process.exit(1);
}
const chainId = net.chainId;
const chain = defineChain({
  id: chainId,
  name: net.name,
  nativeCurrency: { name: net.native, symbol: net.native, decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

const post = (headers?: Record<string, string>) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
  });

console.log(`Buyer ${account.address} calling ${url}`);
const first = await post();
if (first.status !== 402) {
  console.log(`No payment required (HTTP ${first.status}):`, await first.text());
  process.exit(0);
}

// Registering only the upto scheme makes the client pick the upto option from
// the mixed offer.
const core = new x402Client()
  .setSpendControls(false)
  .register(`eip155:${chainId}`, new UptoEvmScheme(account));
const client = new x402HTTPClient(core);
const paymentRequired = client.getPaymentRequiredResponse((name) => first.headers.get(name));
const requirement = paymentRequired.accepts.find((item) => item.scheme === 'upto');
if (!requirement) {
  console.error('The 402 offer has no upto option.');
  process.exit(1);
}
const asset = getAddress(requirement.asset);
const amount = BigInt(requirement.amount);
console.log(
  `Offer: up to ${requirement.amount} atomic of ${asset} to ${requirement.payTo} on ${requirement.network}`,
);

const allowance = (await publicClient.readContract(
  getPermit2AllowanceReadParams({
    tokenAddress: asset,
    ownerAddress: account.address,
  }),
)) as bigint;
if (allowance < amount) {
  console.log('Permit2 allowance too low; sending one approve transaction (needs gas).');
  const approval = createPermit2ApprovalTx(asset);
  const hash = await walletClient.sendTransaction({ to: approval.to, data: approval.data });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    console.error('Permit2 approval failed.');
    process.exit(1);
  }
  console.log(`Approved Permit2 in ${hash}`);
}

const payload = await client.createPaymentPayload(paymentRequired);
const headers = client.encodePaymentSignatureHeader(payload);
const paid = await post(headers);
const responseHeader = paid.headers.get('PAYMENT-RESPONSE');
const settle = responseHeader ? decodePaymentResponseHeader(responseHeader) : undefined;

console.log(`Paid call HTTP ${paid.status}`);
const text = await paid.text();
type PaidResult = { result?: { content?: string; usage?: unknown; charged?: string } };
let parsed: PaidResult | null = null;
try {
  parsed = JSON.parse(text) as PaidResult;
} catch {
  /* print the raw body below */
}
if (parsed?.result) {
  console.log('Model reply:', parsed.result.content);
  console.log('Usage:', JSON.stringify(parsed.result.usage));
  console.log('Charged (USDT atomic):', parsed.result.charged);
} else {
  console.log('Result:', text);
}
if (settle) {
  console.log(`Settlement transaction: ${settle.transaction || '(none: zero charge)'}`);
  if ((settle as { amount?: string }).amount) {
    console.log(`Settled amount: ${(settle as { amount?: string }).amount}`);
  }
}
if (paid.status >= 400) process.exit(1);
