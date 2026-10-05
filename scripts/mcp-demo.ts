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
  ExactEvmScheme,
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
} from '@x402/evm/exact/client';

// External-Agent demo over the MCP Streamable HTTP entry.
//
// Walks the full loop a buyer agent would: platform_info → search_services →
// get_service → call_service. The first call_service returns the x402 payment
// requirements; the script signs a Permit2 payment with the official
// @x402/evm client (after a one-time approve) and retries with the payment in
// `_meta["x402/payment"]`, then prints the delivered result and the settlement
// transaction hash.
//
// Defaults to the local chain only. Paying on BOT Chain testnet additionally
// requires `--network botchain-testnet --send`; that path is not run here.
//
// Usage:
//   AGENT_PRIVATE_KEY=0x... bun scripts/mcp-demo.ts \
//     [--url http://127.0.0.1:4311/mcp] \
//     [--rpc http://127.0.0.1:8547] [--service echo] [--body '{"hello":"world"}']

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const network = arg('network') ?? 'local';
const send = process.argv.includes('--send');
const mcpUrl = arg('url') ?? process.env.MCP_URL ?? 'http://127.0.0.1:4311/mcp';
const rpcUrl = arg('rpc') ?? process.env.SETTLEMENT_RPC_URL ?? 'http://127.0.0.1:8547';
const serviceId = arg('service') ?? 'echo';
const bodyText = arg('body') ?? '{"hello":"world"}';

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

let nextId = 1;
let sessionId: string | undefined;

async function rpc(method: string, params?: Record<string, unknown>, notify = false) {
  const message: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (!notify) message.id = nextId++;
  if (params) message.params = params;
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const sid = res.headers.get('Mcp-Session-Id');
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!text) return null;
  const parsed = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  if (parsed.error) throw new Error(parsed.error.message ?? 'MCP error');
  return parsed.result;
}

async function tool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
  const params: Record<string, unknown> = { name, arguments: args };
  if (meta) params._meta = meta;
  return (await rpc('tools/call', params)) as {
    content?: Array<{ text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  };
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

console.log(`Agent ${account.address} connecting to ${mcpUrl}`);
const init = (await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'bf-market-mcp-demo', version: '0.1.0' },
})) as { serverInfo?: { name?: string } };
console.log(`Connected to ${init?.serverInfo?.name ?? 'MCP server'} (session ${sessionId})`);
await rpc('notifications/initialized', undefined, true);

const info = await tool('platform_info', {});
console.log('\n[platform_info]\n' + (info.content?.[0]?.text ?? ''));

const search = await tool('search_services', { query: serviceId });
const services = (search.structuredContent as { services?: unknown[] })?.services ?? [];
console.log(`\n[search_services] ${services.length} service(s)`);
console.log(JSON.stringify(services, null, 2));

const detail = await tool('get_service', { serviceId });
console.log('\n[get_service]\n' + (detail.content?.[0]?.text ?? ''));

const first = await tool('call_service', { serviceId, body });
if (!first.isError) {
  console.log('\n[call_service] No payment required:', first.content?.[0]?.text);
  process.exit(0);
}
const paymentRequired = first.structuredContent as {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    extra?: { assetTransferMethod?: string };
  }>;
};
console.log('\n[call_service] Payment required');
console.log(JSON.stringify(paymentRequired, null, 2));

const requirement = paymentRequired.accepts.find(
  (item) => item.extra?.assetTransferMethod === 'permit2',
);
if (!requirement) {
  console.error('The offer has no Permit2 option.');
  process.exit(1);
}
const asset = getAddress(requirement.asset);
const amount = BigInt(requirement.amount);

const allowance = (await publicClient.readContract(
  getPermit2AllowanceReadParams({ tokenAddress: asset, ownerAddress: account.address }),
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

const core = new x402Client()
  .setSpendControls(false)
  .register(`eip155:${chainId}`, new ExactEvmScheme(account));
const payload = await core.createPaymentPayload(paymentRequired as never);

const paid = await tool(
  'call_service',
  { serviceId, body },
  { 'x402/payment': payload },
);
console.log(`\n[call_service] paid, isError=${paid.isError ?? false}`);
console.log('Result:', JSON.stringify(paid.structuredContent ?? null, null, 2));
const settle = paid._meta?.['x402/payment-response'] as { transaction?: string } | undefined;
if (settle?.transaction) console.log(`Settlement transaction: ${settle.transaction}`);
if (paid.isError) process.exit(1);
