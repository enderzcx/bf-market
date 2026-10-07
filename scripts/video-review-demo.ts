import { createPublicClient, createWalletClient, defineChain, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { decodePaymentResponseHeader, x402HTTPClient } from '@x402/core/http';
import {
  UptoEvmScheme,
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
} from '@x402/evm/upto/client';
import { writeFileSync } from 'node:fs';

// An agent that cannot watch video finds a video-understanding service on BF
// Market, pays for one call with x402 `upto` on Avalanche Fuji, and saves the
// review it bought.
//
//   AGENT_PRIVATE_KEY=0x... bun scripts/video-review-demo.ts --send \
//     --market https://market-fuji.bflabs.app \
//     --video https://market-fuji.bflabs.app/demo/pelican-neon-ride-v1.mp4 \
//     [--prompt "..."] [--out review.json]

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const market = (arg('market') ?? 'https://market-fuji.bflabs.app').replace(/\/+$/, '');
const videoUrl = arg('video');
const rpcUrl = arg('rpc') ?? 'https://api.avax-test.network/ext/bc/C/rpc';
const out = arg('out');
const prompt =
  arg('prompt') ??
  [
    'You are the reviewer for a 20-second animated short. The editor who made it cannot watch video, so be concrete.',
    'Intended beats: a pelican rides a bicycle along a neon synthwave seafront; around 0:07 a fish leaps out of the sea into its throat pouch while a FISH.EXE billboard fills to 100%; around 0:12 it hops over a traffic cone; around 0:17 it brakes to a stop and sunglasses drop onto its face.',
    '1) List what actually happens with mm:ss timestamps.',
    '2) For each intended beat, say whether it reads clearly, and if not, why.',
    '3) List the visual problems an editor should fix, most severe first, each with a timestamp and a concrete fix.',
    'Keep it under 350 words.',
  ].join('\n');

if (!videoUrl) {
  console.error('Pass --video <public https URL>.');
  process.exit(1);
}
if (!process.argv.includes('--send')) {
  console.error('Refusing to pay without --send. This moves Fuji test USDC.');
  process.exit(1);
}
const key = process.env.AGENT_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('Set AGENT_PRIVATE_KEY to a 32-byte hex private key.');
  process.exit(1);
}

const account = privateKeyToAccount(key as `0x${string}`);
const chain = defineChain({
  id: 43113,
  name: 'Avalanche Fuji',
  nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

// 1. Discover: the agent only knows the market, not the service id.
type DiscoveryItem = { resource: string; description?: string; accepts: Array<{ scheme: string }> };
const discovery = (await (await fetch(`${market}/discovery/resources`)).json()) as {
  items: DiscoveryItem[];
};
const found = discovery.items.find(
  (item) => /video/i.test(item.description ?? '') && item.accepts.some((a) => a.scheme === 'upto'),
);
if (!found) {
  console.error('No video-understanding service is listed on this market.');
  process.exit(1);
}
const url = found.resource;
console.log(`Found ${url}`);

const body = { video_url: videoUrl, prompt, max_tokens: 1500 };
const post = (headers?: Record<string, string>) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
  });

// 2. Read the 402 quote.
const first = await post();
if (first.status !== 402) {
  console.error(`Expected 402, got ${first.status}: ${await first.text()}`);
  process.exit(1);
}
const client = new x402HTTPClient(
  new x402Client().setSpendControls(false).register('eip155:43113', new UptoEvmScheme(account)),
);
const paymentRequired = client.getPaymentRequiredResponse((name) => first.headers.get(name));
const requirement = paymentRequired.accepts.find((item) => item.scheme === 'upto');
if (!requirement) {
  console.error('The 402 offer has no upto option.');
  process.exit(1);
}
const asset = getAddress(requirement.asset);
console.log(`Quote: up to ${requirement.amount} atomic USDC to ${requirement.payTo}`);

// 3. One-time Permit2 approval if needed, then sign and resend.
const allowance = (await publicClient.readContract(
  getPermit2AllowanceReadParams({ tokenAddress: asset, ownerAddress: account.address }),
)) as bigint;
let approveTx: string | null = null;
if (allowance < BigInt(requirement.amount)) {
  const approval = createPermit2ApprovalTx(asset);
  approveTx = await walletClient.sendTransaction({ to: approval.to, data: approval.data });
  await publicClient.waitForTransactionReceipt({ hash: approveTx as `0x${string}` });
  console.log(`Approved Permit2 in ${approveTx}`);
}
const payload = await client.createPaymentPayload(paymentRequired);
const started = Date.now();
const paid = await post(client.encodePaymentSignatureHeader(payload));
const elapsedMs = Date.now() - started;
const settleHeader = paid.headers.get('PAYMENT-RESPONSE');
const settle = settleHeader ? decodePaymentResponseHeader(settleHeader) : null;
const text = await paid.text();
let result: { result?: { content?: string; usage?: unknown; charged?: string; model?: string } } = {};
try {
  result = JSON.parse(text);
} catch {
  /* printed below */
}

console.log(`Paid call HTTP ${paid.status} in ${(elapsedMs / 1000).toFixed(1)}s`);
console.log(`Charged ${result.result?.charged ?? '?'} atomic USDC, settle tx ${settle?.transaction ?? '-'}`);
console.log(result.result?.content ?? text);

if (out) {
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        market,
        service: url,
        network: requirement.network,
        buyer: account.address,
        payTo: requirement.payTo,
        asset,
        quoteMaxAtomic: requirement.amount,
        video: videoUrl,
        prompt,
        httpStatus: paid.status,
        elapsedMs,
        model: result.result?.model ?? null,
        usage: result.result?.usage ?? null,
        chargedAtomic: result.result?.charged ?? null,
        permit2ApproveTx: approveTx,
        settleTx: settle?.transaction ?? null,
        review: result.result?.content ?? null,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Saved ${out}`);
}
if (paid.status >= 400) process.exit(1);
