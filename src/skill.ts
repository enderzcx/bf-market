import type { RuntimeConfig } from './config.ts';
import {
  LLM_DEFAULT_MAX_TOKENS,
  LLM_MAX_CONTENT_CHARS,
  LLM_MAX_MAX_TOKENS,
  meteredUpperBound,
  type MeteredRequest,
} from './llm.ts';
import type { ServiceCatalog, ServiceDefinition } from './services.ts';
import { UPTO_PERMIT2_PROXY } from './x402/index.ts';

// Agent-facing instructions. Every value comes from the running config and the
// live catalog, so a network change or a newly listed service is reflected on
// the next request. No keys, no internal paths.

const MAX_REQUEST: MeteredRequest = {
  messages: [{ role: 'user', content: 'x'.repeat(LLM_MAX_CONTENT_CHARS) }],
  maxTokens: LLM_MAX_MAX_TOKENS,
  inputChars: LLM_MAX_CONTENT_CHARS,
  inputTokens: BigInt(LLM_MAX_CONTENT_CHARS / 2),
};

// The copyable prompt shown at the top of skill.md and on the market page. Keep
// both copies identical.
export function agentPrompt(origin: string): string {
  return `Read ${origin.replace(/\/+$/, '')}/skill.md and use BF Market to find and pay for a service with x402, then read the result.`;
}

function formatUsdt(atomic: bigint): string {
  const base = 1_000_000n;
  const whole = atomic / base;
  const frac = (atomic % base).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}.00`;
}

function usd(microUsdPerMillion: bigint): string {
  return (Number(microUsdPerMillion) / 1_000_000).toFixed(2);
}

function priceCapOf(definition: ServiceDefinition): bigint {
  return definition.pricing.mode === 'metered'
    ? meteredUpperBound(definition.pricing.pricing, MAX_REQUEST)
    : definition.price;
}

function serviceRow(definition: ServiceDefinition): string {
  const cap = formatUsdt(priceCapOf(definition));
  if (definition.pricing.mode === 'metered') {
    const pricing = definition.pricing.pricing;
    return [
      `| \`${definition.serviceId}\` | ${pricing.modelId} | metered (x402 \`upto\`) | ${cap} USDT |`,
      ` total input <= ${LLM_MAX_CONTENT_CHARS} chars; max_tokens <= ${LLM_MAX_MAX_TOKENS} (default ${LLM_DEFAULT_MAX_TOKENS}) |`,
      ` up to ceil(max_tokens x 1.1) completion tokens |`,
      ` input $${usd(pricing.inputMicroUsdPerMillion)} / 1M tokens, output $${usd(pricing.outputMicroUsdPerMillion)} / 1M tokens |`,
    ].join('');
  }
  return [
    `| \`${definition.serviceId}\` | - | exact | ${cap} USDT |`,
    ' any JSON object, up to 16 KB | the request body echoed back |',
    ' fixed price |',
  ].join('');
}

function serviceTable(catalog: ServiceCatalog): string {
  const rows = catalog.available().map(({ definition }) => serviceRow(definition));
  if (rows.length === 0) {
    return 'No service is listed right now. Check the live catalog at `/discovery/resources`.';
  }
  return [
    '| Service ID | Model | Pricing | Max price (worst case) | Input limits | Output limits | Rates |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function firstExample(catalog: ServiceCatalog): string {
  const first = catalog.available()[0]?.definition;
  if (!first) return '{\n  "hello": "world"\n}';
  return JSON.stringify(first.inputExample, null, 2);
}

function firstServiceId(catalog: ServiceCatalog): string {
  return catalog.available()[0]?.definition.serviceId ?? 'echo';
}

export function buildSkillMarkdown(input: {
  config: RuntimeConfig;
  catalog: ServiceCatalog;
  origin: string;
}): string {
  const { config, catalog } = input;
  const origin = input.origin.replace(/\/+$/, '');
  const net = config.network;
  const asset = net.asset;
  const tokenAddress = config.chain.token;
  const permit2 = config.permit2 ?? '(not configured on this network)';
  const exactProxy = config.x402Permit2Proxy ?? '(not configured on this network)';
  const uptoProxy = UPTO_PERMIT2_PROXY;
  const registry = config.identityRegistry ?? '(no identity registry on this network)';

  const starterGas = config.starterGasEnabled
    ? [
        'A brand-new wallet needs a little tBOT to pay for the one-time Permit2 approve. On this testnet the platform can send it once per address, while the balance is still below the threshold.',
        '',
        `1. POST ${origin}/api/agents/challenge with \`{ "address": "0x...", "purpose": "starter-gas" }\` and read \`message\`.`,
        '2. Sign `message` with your wallet (EIP-191 personal_sign).',
        `3. POST ${origin}/api/agents/starter-gas with \`{ "address": "0x...", "signature": "0x..." }\`. The reply carries \`status\`, \`txHash\` and \`amountWei\`.`,
        '4. If `status` is not `confirmed` yet, wait and post the same body again until it is.',
        '',
        `Testnet limits: one grant per address, ${config.starterGasWei} wei per grant, ${config.starterGasDailyCapWei} wei per UTC day across all addresses, and only while the balance is below ${config.starterGasBalanceThresholdWei} wei.`,
      ].join('\n')
    : 'Starter gas is not enabled on this deployment. A new wallet must get testnet tBOT from the BOT Chain testnet faucet before it can approve Permit2.';

  return `# BF Market

> Copy this prompt into your agent:
>
> \`\`\`
> ${agentPrompt(origin)}
> \`\`\`

## 1. What BF Market is

BF Market is an agent commerce platform on the ${net.displayName} (chain ${net.chainId}): find a service, pay per call with x402, and get the result. Payment is a signed x402 authorization settled through Permit2, so the platform never holds your key and never signs for you.

Any wallet can pay for a service without registering. A provider registers an on-chain identity (ERC-8004) to list a service and receive payments. Settlement is self-hosted: the buyer signs, and ${asset.symbol} moves straight from the buyer to the provider payout address.

## 2. Pay for a service without registering

A wallet signature is the identity, so there is no account and no login. The shortest path:

1. Send a POST request to \`${origin}/api/services/{serviceId}/call\` with a JSON body (the service table in section 6 has the id and body shape). The \`resource\` field of \`/discovery/resources\` is the authoritative URL for a service.
2. The server answers \`402 Payment Required\` with a \`PAYMENT-REQUIRED\` header. Decode it to read \`accepts\` (the payment options), \`resource.url\` and the quoted \`amount\`. That 402 amount is authoritative: for a small request it is much lower than the worst-case cap in section 6.
3. A metered service offers two options at the same quoted amount: \`upto\` first, then \`exact\`. Choose \`upto\` so only the actual usage settles. \`exact\` is a fallback for exact-only clients and settles the full quoted cap even when the call uses less. Fixed-price services offer \`exact\` only.
4. Approve Permit2 once for ${asset.symbol}. The ERC-20 \`approve\` target is Permit2 itself (\`${permit2}\`); the x402 proxies in the table below are not approve targets, they only appear inside the signed Permit2 authorization. Register \`UptoEvmScheme\` for metered services and \`ExactEvmScheme\` for fixed-price services with the official x402 v2 client (\`@x402/core\` + \`@x402/evm\`).
5. Resend the same request with the \`PAYMENT-SIGNATURE\` header.
6. Check the response status. A \`200\` body is \`{ "result": <output> }\`, so read \`json.result\` (the output examples show the inner object). A \`502\` with \`{"error":"The model provider call failed. You were not charged."}\` settled nothing: retry or pick another service.
7. Read the charge. For metered services the decoded \`PAYMENT-RESPONSE\` carries \`amount\` (the actual charge in atomic ${asset.symbol}) with \`transaction\`, \`payer\` and \`network\`; \`result.charged\` and the \`charged\` field of \`/api/receipts\` report the same. Fixed-price services charge the price quoted in the 402.

### Network and contracts

| Item | Value |
| --- | --- |
| Network | ${net.displayName} (chain ${net.chainId}, ${net.caip2}) |
| Settlement token | ${asset.symbol} ${tokenAddress} (${asset.decimals} decimals) |
| Permit2 | ${permit2} |
| x402 exact Permit2 proxy | ${exactProxy} |
| x402 upto Permit2 proxy | ${uptoProxy} |
| Identity registry (ERC-8004) | ${registry} |

### Minimal TypeScript example

Install: \`bun add viem @x402/core @x402/evm\` (or \`npm install viem @x402/core @x402/evm\`). Tested with \`@x402/core\` and \`@x402/evm\` 2.26.0 and 2.28.0.

\`\`\`ts
import { createPublicClient, createWalletClient, defineChain, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { decodePaymentResponseHeader, x402HTTPClient } from '@x402/core/http';
import {
  ExactEvmScheme,
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
} from '@x402/evm/exact/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';

const ORIGIN = '${origin}';
const CHAIN_ID = ${net.chainId};
const SERVICE = '${firstServiceId(catalog)}';
const RPC = '${config.chain.rpcUrl}';

// Never share this key with anyone or any service. It only signs x402/Permit2
// payloads, and those signatures can only move the quoted amount.
const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as \`0x\${string}\`);

const body = ${firstExample(catalog)};

const chain = defineChain({
  id: CHAIN_ID,
  name: '${net.displayName}',
  nativeCurrency: { name: 'tBOT', symbol: 'tBOT', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const url = \`\${ORIGIN}/api/services/\${SERVICE}/call\`;
const post = (headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const first = await post();
if (first.status !== 402) throw new Error(\`expected 402, got \${first.status}\`);

// Register both schemes so the client can pick whichever option the 402
// offers: upto for metered services, exact for fixed-price services.
const core = new x402Client()
  .setSpendControls(false)
  .register(\`eip155:\${CHAIN_ID}\`, new ExactEvmScheme(account))
  .register(\`eip155:\${CHAIN_ID}\`, new UptoEvmScheme(account));
const client = new x402HTTPClient(core);
const required = client.getPaymentRequiredResponse((name) => first.headers.get(name));
// Both metered options quote the same cap. Prefer upto so only the actual
// usage settles; exact would settle the full cap.
const option = required.accepts.find((a) => a.scheme === 'upto') ?? required.accepts[0]!;

const asset = getAddress(option.asset);
const allowance = (await publicClient.readContract(
  getPermit2AllowanceReadParams({ tokenAddress: asset, ownerAddress: account.address }),
)) as bigint;
if (allowance < BigInt(option.amount)) {
  // One-time approve, needs gas. Safe to skip once the allowance is high enough.
  const approval = createPermit2ApprovalTx(asset);
  await publicClient.waitForTransactionReceipt({
    hash: await wallet.sendTransaction({ to: approval.to, data: approval.data }),
  });
}

const payload = await client.createPaymentPayload(required);
const paid = await post(client.encodePaymentSignatureHeader(payload));
const responseBody = (await paid.json()) as { result?: unknown; error?: string };
if (paid.status !== 200) {
  // A 502 here means the provider call failed and you were not charged.
  throw new Error(\`call failed with \${paid.status}: \${responseBody.error ?? 'unknown error'}\`);
}
const settle = decodePaymentResponseHeader(paid.headers.get('PAYMENT-RESPONSE')!);
// Metered services report the actual charge; exact services charge the quote.
console.log('charged (atomic ${asset.symbol})', settle.amount ?? option.amount);
console.log('settlement transaction', settle.transaction);
console.log('result', responseBody.result);
\`\`\`

## 3. Starter gas for a new wallet

${starterGas}

## 4. List a service as a provider

Providers register an on-chain ERC-8004 identity; registering is what lists the service and sets the payout address. Sign and broadcast with your own wallet. The platform never signs for you.

1. POST ${origin}/api/agents/challenge with \`{ "address": "0x..." }\` and read \`message\`.
2. Sign \`message\` with your wallet (EIP-191 personal_sign).
3. POST ${origin}/api/agents/drafts with \`{ "address", "signature", "role": "provider", "profile" }\`. The reply carries \`agentURI\` and \`registerTx\` (\`{ chainId, to, data, value }\`).
4. Broadcast \`registerTx\` with your wallet and keep the transaction hash.
5. POST ${origin}/api/agents/confirm with \`{ "txHash" }\` and read back the \`agentId\`. A 202 means the receipt is not final yet; retry.

Listing review is off-chain. Once the identity is registered with a non-zero payout wallet, the service can be called.

## 5. Connect over MCP

The MCP entry point is a Streamable HTTP server at \`${origin}/mcp\`. Tools:

- \`platform_info\` - what the platform is, its network, and how to register or pay.
- \`search_services\` - search the catalog by keyword or price cap.
- \`get_service\` - one service's input and output schemas plus payment requirements.
- \`call_service\` - call a paid service. Without a payment it returns the payment requirements; retry with the x402 payment in \`_meta["x402/payment"]\` and read the result from \`_meta["x402/payment-response"]\`. Build that payment payload exactly as in section 2 and pass it in \`_meta["x402/payment"]\` of \`call_service\`.
- \`register_agent_info\` - the ERC-8004 registration steps.

Client configuration (Claude Desktop, Cursor and other Streamable HTTP clients):

\`\`\`json
{
  "mcpServers": {
    "bf-market": {
      "type": "http",
      "url": "${origin}/mcp"
    }
  }
}
\`\`\`

## 6. Services

Price cap for a metered service: \`ceil(input_tokens x input_price) + ceil(ceil(max_tokens x 1.1) x output_price)\`, where \`input_tokens = ceil(total_input_chars / 2)\`. The "Max price (worst case)" column is that cap at ${LLM_MAX_CONTENT_CHARS} input chars and \`max_tokens\` ${LLM_MAX_MAX_TOKENS}, the largest request allowed - a real call usually quotes far less. The 402 amount is the authoritative quote for your request. With \`upto\` the final charge is the actual usage and never exceeds the quote.

${serviceTable(catalog)}

## 7. Errors and troubleshooting

- \`PAYMENT-SIGNATURE header is required\` - send the signed payment in the \`PAYMENT-SIGNATURE\` header.
- \`Buyer has not approved Permit2, or the allowance is too low.\` - send the one-time Permit2 approve for ${asset.symbol} first.
- \`Buyer has insufficient USDT balance.\` - top up the buyer wallet with testnet ${asset.symbol}.
- \`Payment authorization has expired. Sign a new payment.\` - the signed deadline passed; sign a fresh payload.
- \`Payment authorization was already used.\` or \`This payment was already used for another service.\` - every signature settles once; sign a new one for a new call.
- \`Settlement amount exceeds the signed upper bound.\` - you signed below the quote; sign the exact amount from the 402.
- \`Payment amount does not match the requirements.\` - use the amount from the 402 unchanged.
- \`Payment facilitator does not match this server.\` - sign the \`extra.facilitatorAddress\` from the 402 into the witness.
- \`Payment spender is not the x402 Permit2 proxy.\` - use the spender and proxy from \`extra\` in the 402.
- \`Daily spending limit reached for this payer.\` or \`The daily model budget is exhausted.\` - the per-day cap is spent; retry after the next UTC day.
- \`The model provider call failed. You were not charged.\` - retry; nothing was settled.
- \`This service is temporarily unavailable.\` - the provider is not registered or approved yet.

## 8. Testnet notice and safety

- This is ${net.displayName}. Test ${asset.symbol} and tBOT have no real value.
- The platform never asks for your private key. Never send a private key to anyone.
- Only sign Permit2/x402 payment payloads. Never sign an arbitrary approval or transfer to an unknown contract.
- Before signing, check the spender, proxy and recipient against the table in section 2.
- Payments go straight to the provider payout address. The platform only pays the settlement gas.

See \`${origin}/llms.txt\` for a short index of machine-readable entry points.
`;
}

export function buildLlmsTxt(input: { origin: string }): string {
  const origin = input.origin.replace(/\/+$/, '');
  return `# BF Market

> Agent commerce platform on BOT Chain testnet. Find a service, pay per call with x402, and get the result.

- Skill instructions: ${origin}/skill.md
- Service catalog: ${origin}/discovery/resources
- Service search: ${origin}/discovery/search
- MCP endpoint (Streamable HTTP): ${origin}/mcp
- Receipts: ${origin}/api/receipts?payer=0x...
- Public stats: ${origin}/api/stats/public
`;
}
