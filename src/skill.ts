import type { RuntimeConfig } from './config.ts';
import { budgetMax } from './budget.ts';
import {
  LLM_DEFAULT_MAX_TOKENS,
  LLM_MAX_CONTENT_CHARS,
  LLM_MAX_MAX_TOKENS,
  LLM_QUOTE_INPUT_TOKENS,
  LLM_QUOTE_OUTPUT_TOKENS,
  meteredUpperBound,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_PROMPT_CHARS,
} from './llm.ts';
import type { ServiceCatalog, ServiceDefinition } from './services.ts';
import { UPTO_PERMIT2_PROXY } from './x402/index.ts';

// Agent-facing instructions. Every value comes from the running config and the
// live catalog, so a network change or a newly listed service is reflected on
// the next request. No keys, no internal paths.

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
    ? meteredUpperBound(definition.pricing.pricing)
    : definition.price;
}

function serviceRow(definition: ServiceDefinition, symbol: string): string {
  const cap = formatUsdt(priceCapOf(definition));
  if (definition.pricing.mode === 'metered') {
    const pricing = definition.pricing.pricing;
    const maxTokens = `max_tokens <= ${LLM_MAX_MAX_TOKENS} (default ${LLM_DEFAULT_MAX_TOKENS})`;
    const inputLimits =
      pricing.input === 'video'
        ? `video_url: public https mp4, mov or webm, <= ${VIDEO_MAX_BYTES / 1024 / 1024} MB; prompt <= ${VIDEO_MAX_PROMPT_CHARS} chars; ${maxTokens}; quote assumes ${pricing.quoteInputTokens ?? LLM_QUOTE_INPUT_TOKENS} input tokens`
        : `total input <= ${LLM_MAX_CONTENT_CHARS} chars; ${maxTokens}`;
    return [
      `| \`${definition.serviceId}\` | ${pricing.modelId} | metered (x402 \`upto\`) | ${cap} ${symbol} |`,
      ` ${inputLimits} |`,
      ` fixed quote up to ${LLM_QUOTE_OUTPUT_TOKENS} completion tokens |`,
      ` input $${usd(pricing.inputMicroUsdPerMillion)} / 1M tokens, output $${usd(pricing.outputMicroUsdPerMillion)} / 1M tokens |`,
    ].join('');
  }
  return [
    `| \`${definition.serviceId}\` | - | exact | ${cap} ${symbol} |`,
    ' any JSON object, up to 16 KB | the request body echoed back |',
    ' fixed price |',
  ].join('');
}

function serviceTable(catalog: ServiceCatalog, symbol: string): string {
  const rows = catalog.available().map(({ definition }) => serviceRow(definition, symbol));
  if (rows.length === 0) {
    return 'No service is listed right now. Check the live catalog at `/discovery/resources`.';
  }
  return [
    '| Service ID | Model | Pricing | Quote per call (max) | Input limits | Output limits | Rates |',
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
  const payerDaily = formatUsdt(config.llmPayerDailyCapAtomic);
  const globalDaily = formatUsdt(config.llmGlobalDailyCapAtomic);
  const budgetCeiling = formatUsdt(budgetMax(config));

  const faucet = net.faucetUrl;
  const faucetRow = faucet
    ? `\n| Faucet (test ${net.nativeSymbol} and ${asset.symbol}) | ${faucet} (human verification required) |`
    : '';
  const faucetNote = faucet
    ? `\n\nTest ${net.nativeSymbol} and test ${asset.symbol} both come from the faucet at ${faucet}. It asks for a human verification, so the person running the agent claims them for the wallet address.`
    : '';
  const topUp = faucet
    ? `top up the buyer wallet with testnet ${asset.symbol} from ${faucet}.`
    : `top up the buyer wallet with testnet ${asset.symbol}.`;

  const starterGas = config.starterGasEnabled
    ? [
        `A brand-new wallet needs a little ${net.nativeSymbol} to pay for the one-time Permit2 approve. On this testnet the platform can send it once per address, while the balance is still below the threshold.`,
        '',
        `1. POST ${origin}/api/agents/challenge with \`{ "address": "0x...", "purpose": "starter-gas" }\` and read \`message\`.`,
        '2. Sign `message` with your wallet (EIP-191 personal_sign).',
        `3. POST ${origin}/api/agents/starter-gas with \`{ "address": "0x...", "signature": "0x..." }\`. The reply carries \`status\`, \`txHash\` and \`amountWei\`.`,
        '4. If `status` is not `confirmed` yet, wait and post the same body again until it is.',
        '',
        `Testnet limits: one grant per address, ${config.starterGasWei} wei per grant, ${config.starterGasDailyCapWei} wei per UTC day across all addresses, and only while the balance is below ${config.starterGasBalanceThresholdWei} wei.`,
      ].join('\n')
    : `Starter gas is not enabled on this deployment. A new wallet must get testnet ${net.nativeSymbol} from the ${net.displayName} faucet before it can approve Permit2.`;

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
2. The server answers \`402 Payment Required\` with a \`PAYMENT-REQUIRED\` header. Decode it to read \`accepts\` (the payment options), \`resource.url\` and the quoted \`amount\`. For a metered service that amount is the fixed per-call maximum in section 6; the charge is the actual usage at or below it.
3. A metered service offers one option, \`upto\`, which settles only the actual usage. A fixed-price service offers \`exact\` and charges the fixed quoted price.
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
| Identity registry (ERC-8004) | ${registry} |${faucetRow}

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
  nativeCurrency: { name: '${net.nativeSymbol}', symbol: '${net.nativeSymbol}', decimals: 18 },
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
// Metered services offer upto; fixed-price services offer exact. Prefer upto
// when it is present so only the actual usage settles.
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

${starterGas}${faucetNote}

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
- \`call_service\` - call a paid service. Without a payment it returns the payment requirements; build the payment payload exactly as in section 2 and retry with it in \`_meta["x402/payment"]\`. The output comes back as \`structuredContent\` (no \`result\` wrapper) and the settlement in \`_meta["x402/payment-response"]\`.
- \`register_agent_info\` - the ERC-8004 registration steps.
- \`get_wallet_summary\` - a payment wallet's daily budget, today's spend, remaining budget and recent receipts.
- \`set_wallet_budget\` - read the daily budget challenge, then submit a signed change to the owner ceiling or the wallet's own value.

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

Quote per call for a metered service: \`ceil(${LLM_QUOTE_INPUT_TOKENS} input tokens x input_price) + ceil(${LLM_QUOTE_OUTPUT_TOKENS} output tokens x output_price)\`, the same fixed maximum for every request. Upstream models add hidden prompt tokens that the request does not show, so the quote sits above a typical call; with \`upto\` only the actual usage is charged, so the maximum costs nothing extra. The "Quote per call (max)" column shows it per model, and the 402 \`amount\` is that same fixed quote.

Video services (ids starting with \`video-\`) watch a video for you. Their body is \`{"video_url","prompt","max_tokens"?}\` instead of chat messages: \`video_url\` is a public https link to an mp4, mov or webm file of at most 20 MB, and the quote allows 64000 input tokens because video is token-heavy. If the server cannot fetch the video, nothing is charged.

Daily LLM limits, read from config, apply to LLM (metered) services only: at most ${payerDaily} ${asset.symbol} per wallet and ${globalDaily} ${asset.symbol} platform-wide per UTC day, counting metered spend only. Hitting either returns \`429\` with \`Daily spending limit reached for this payer.\` or \`The daily model budget is exhausted.\`, and nothing is settled. \`echo\` is a fixed-price service and has no platform daily limit.

${serviceTable(catalog, asset.symbol)}

## 7. Daily budget

A payment wallet can carry a daily budget that applies to every paid service, including \`echo\`. The effective budget for a wallet is the smaller of two values:

- the owner's ceiling: a per-agent limit set by the ERC-8004 owner, applied to that agent's payment wallet;
- the wallet's own value: a limit the payment wallet sets for itself.

When neither is set there is no user budget: \`echo\` then has no daily limit and the LLM services are bounded only by the platform limits in section 6. A value of \`0\` pauses every paid call for that wallet. Every user value is at most ${budgetCeiling} ${asset.symbol}.

Rules:

- The payment wallet may only set a value at or below the owner's ceiling. A larger value is rejected with \`The daily budget exceeds the owner's limit of <amount> ${asset.symbol}.\`
- Lowering the ceiling does not overwrite the wallet's stored value; the effective budget just drops to the ceiling until the ceiling is raised or removed.
- Calls are admitted against the quoted maximum per call, so a model whose fixed quote is above the remaining budget cannot be called today while a cheaper model still can. After settlement only the actual usage counts.
- The budget changes apply immediately; a hold already taken by an in-flight call keeps its amount.

Read the current state with \`GET ${origin}/api/wallets/{address}/summary\`: \`userBudget.effective\` and \`userBudget.source\` show the limit in force, and \`spent\` and \`remaining\` show today's usage.

Set a budget with a two-step wallet signature: an EIP-191 \`personal_sign\` over a server-issued challenge, valid 5 minutes and single use.

1. \`POST ${origin}/api/budgets/challenge\` with \`{ "scope": "wallet", "wallet": "0x...", "signer": "0x...", "dailyLimit": "30000" }\` and read \`message\`. Use \`"scope": "ceiling"\` together with \`"agentId"\` for an owner setting the ceiling, and \`"dailyLimit": null\` to remove a value.
2. Sign \`message\` with the named signer, then \`POST ${origin}/api/budgets\` with the same body plus \`"signature"\`. The reply is the wallet summary.

Over MCP the same flow is \`set_wallet_budget\` with the same arguments: call it without \`signature\` to get the challenge, then call it again with \`signer\` and \`signature\` to submit.

A rejected budget change returns an English error with the reason, for example \`The signer is not allowed to set this budget.\` or \`Invalid daily budget.\`

## 8. Errors and troubleshooting

- \`PAYMENT-SIGNATURE header is required\` - send the signed payment in the \`PAYMENT-SIGNATURE\` header.
- \`Buyer has not approved Permit2, or the allowance is too low.\` - send the one-time Permit2 approve for ${asset.symbol} first.
- \`Buyer has insufficient ${asset.symbol} balance.\` - ${topUp}
- \`Payment authorization has expired. Sign a new payment.\` - the signed deadline passed; sign a fresh payload.
- \`Payment authorization was already used.\` or \`This payment was already used for another service.\` - every signature settles once; sign a new one for a new call.
- \`Settlement amount exceeds the signed upper bound.\` - you signed below the quote; sign the exact amount from the 402.
- \`Payment amount does not match the requirements.\` - use the amount from the 402 unchanged.
- \`Payment facilitator does not match this server.\` - sign the \`extra.facilitatorAddress\` from the 402 into the witness.
- \`Payment spender is not the x402 Permit2 proxy.\` - use the spender and proxy from \`extra\` in the 402.
- \`Daily spending limit reached for this payer.\` or \`The daily model budget is exhausted.\` - the platform per-day LLM cap is spent; retry after the next UTC day.
- \`Daily budget set by the agent owner is reached.\` - the owner's daily ceiling for this wallet is spent; retry after the next UTC day.
- \`Daily budget reached for this wallet.\` - the wallet's own daily budget is spent; retry after the next UTC day.
- \`The model provider call failed. You were not charged.\` - retry; nothing was settled.
- \`This service is temporarily unavailable.\` - the provider is not registered or approved yet.

## 9. Testnet notice and safety

- This is ${net.displayName}. Test ${asset.symbol} and ${net.nativeSymbol} have no real value.
- The platform never asks for your private key. Never send a private key to anyone.
- Only sign Permit2/x402 payment payloads. Never sign an arbitrary approval or transfer to an unknown contract.
- Before signing, check the spender, proxy and recipient against the table in section 2.
- Payments go straight to the provider payout address. The platform only pays the settlement gas.

See \`${origin}/llms.txt\` for a short index of machine-readable entry points.
`;
}

export function buildLlmsTxt(input: { origin: string; network: string }): string {
  const origin = input.origin.replace(/\/+$/, '');
  return `# BF Market

> Agent commerce platform on ${input.network}. Find a service, pay per call with x402, and get the result.

- Skill instructions: ${origin}/skill.md
- Service catalog: ${origin}/discovery/resources
- Service search: ${origin}/discovery/search
- MCP endpoint (Streamable HTTP): ${origin}/mcp
- Daily budget: read ${origin}/api/wallets/{address}/summary, change it with ${origin}/api/budgets
- Receipts: ${origin}/api/receipts?payer=0x...
- Public stats: ${origin}/api/stats/public
`;
}
