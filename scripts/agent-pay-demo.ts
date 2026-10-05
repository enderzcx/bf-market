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
  ExactEvmScheme,
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
} from '@x402/evm/exact/client';

// Agent buyer demo for the M4 Permit2 paid-service path.
//
// Reads the 402 offer, tops up the Permit2 allowance once if needed (that
// approve is an on-chain write and costs gas), signs the official x402 payment
// payload, resends the request and prints the delivered result plus the
// settlement transaction hash.
//
// Defaults to the local chain only. Paying on BOT Chain testnet additionally
// requires `--network botchain-testnet --send`; that path is not run here.
//
// Usage:
//   AGENT_PRIVATE_KEY=0x... bun scripts/agent-pay-demo.ts \
//     [--url http://127.0.0.1:4311/api/services/echo/call] \
//     [--rpc http://127.0.0.1:8547] [--body '{"hello":"world"}']

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const network = arg('network') ?? 'local';
const send = process.argv.includes('--send');
const url = arg('url') ?? process.env.SERVICE_URL ?? 'http://127.0.0.1:4311/api/services/echo/call';
const rpcUrl = arg('rpc') ?? process.env.SETTLEMENT_RPC_URL ?? 'http://127.0.0.1:8547';
const bodyText = arg('body') ?? '{}';

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

const account = privateKeyToAccount(key as `0x${string}`);
const chainId = network === 'botchain-testnet' ? 968 : 31337;
const chain = defineChain({
  id: chainId,
  name: network === 'botchain-testnet' ? 'BOT Chain Testnet' : 'Local test chain',
  nativeCurrency: { name: 'Test gas', symbol: 'TEST', decimals: 18 },
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

const core = new x402Client()
  .setSpendControls(false)
  .register(`eip155:${chainId}`, new ExactEvmScheme(account));
const client = new x402HTTPClient(core);
const paymentRequired = client.getPaymentRequiredResponse((name) => first.headers.get(name));
const requirement = paymentRequired.accepts.find(
  (item) => (item.extra as { assetTransferMethod?: string }).assetTransferMethod === 'permit2',
);
if (!requirement) {
  console.error('The 402 offer has no Permit2 option.');
  process.exit(1);
}
const asset = getAddress(requirement.asset);
const amount = BigInt(requirement.amount);
console.log(
  `Offer: ${requirement.amount} atomic of ${asset} to ${requirement.payTo} on ${requirement.network}`,
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
const result = await paid.text();
console.log(`Paid call HTTP ${paid.status}`);
console.log('Result:', result);
if (settle?.transaction) console.log(`Settlement transaction: ${settle.transaction}`);
if (paid.status >= 400) process.exit(1);
