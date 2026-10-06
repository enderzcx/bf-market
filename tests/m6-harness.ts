import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'bun:test';
import ganache from 'ganache';
import solc from 'solc';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  toHex,
  type Address,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PERMIT2_ADDRESS, permit2WitnessTypes } from '@x402/evm';
import { compileErc8004, deploymentSteps } from '../scripts/erc8004-artifacts.ts';
import {
  createRpcAgentRegistryChain,
  identityRegistryAbi,
} from '../src/agent-registry.ts';
import {
  DEFAULT_BEEFAPI_LLM_BASE_URL,
  runtimeConfig,
  runtimeFingerprint,
} from '../src/config.ts';
import { createApp, type SettlementApp } from '../src/server.ts';
import { createServiceCatalog } from '../src/services.ts';
import { createSource } from '../src/source.ts';
import { createStore, type Store } from '../src/store.ts';
import type { Chain, Payout, Prepared } from '../src/types.ts';
import { createWorker } from '../src/worker.ts';
import {
  permit2PaymentKey,
  UPTO_PERMIT2_PROXY,
  type Permit2Facilitator,
  type Permit2ReceiptResult,
} from '../src/x402/index.ts';
import type { X402PaymentRequirements } from '../src/x402/types.ts';

// Shared local-chain + Permit2 + ERC-8004 registry harness for the M6 discovery
// and MCP tests. Mirrors the setup in tests/x402-permit2.test.ts.

export const LOCAL_KEY = `0x${'1'.padStart(64, '0')}` as Hex;
export const OPS_KEY = `0x${'2'.padStart(64, '0')}` as Hex;
export const AGENT_KEY = `0x${'3'.padStart(64, '0')}` as Hex;
export const BUYER_KEY = `0x${'4'.padStart(64, '0')}` as Hex;
export const CONTRACT = '0x0000000000000000000000000000000000000002' as Address;
export const X402_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001' as Address;
export const PRICE = 1_000_000n;
export const PROFILE = {
  name: 'Demo Provider',
  services: [{ name: 'echo', endpoint: 'http://127.0.0.1:4311/api/services/echo/call' }],
  x402Support: true,
  active: true,
};

const erc8004 = compileErc8004();
const plainUsdt = compilePlainUSDT();
const x402Proxy = compileX402Proxy();
const x402UptoProxy = compileX402UptoProxy();

function compileSolidity(file: string, contract: string) {
  const content = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { [file]: { content } },
        settings: {
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
      }),
    ),
  );
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw Error(JSON.stringify(errors));
  const c = out.contracts[file][contract];
  return { abi: c.abi as readonly unknown[], bytecode: `0x${c.evm.bytecode.object}` as Hex };
}

function compilePlainUSDT() {
  return compileSolidity('PlainUSDT.sol', 'PlainUSDT');
}

function compileX402Proxy() {
  return compileSolidity('X402ExactPermit2Proxy.sol', 'x402ExactPermit2Proxy');
}

function compileX402UptoProxy() {
  return compileSolidity('X402UptoPermit2Proxy.sol', 'x402UptoPermit2Proxy');
}

function fixtureCode(name: string): Hex {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')).code as Hex;
}

class MockPayoutChain implements Chain {
  async prepare(p: Payout): Promise<Prepared> {
    return {
      rawTransaction: keccak256(toHex(`raw:${p.id}`)),
      hash: keccak256(toHex(`hash:${p.id}`)),
    };
  }
  async broadcast() {}
  async inspect() {
    return 'confirmed' as const;
  }
  async balances() {
    return { token: '0', gas: '0' };
  }
}

const closers: Array<() => void> = [];
export async function closeAll(): Promise<void> {
  while (closers.length) await closers.pop()?.();
}

export type ChainEnv = {
  url: string;
  registry: Address;
  token: Address;
  client: PublicClient;
  viemChain: ViemChain;
  deployer: ReturnType<typeof privateKeyToAccount>;
  proxyAbi: readonly unknown[];
  uptoProxyAbi: readonly unknown[];
};

export async function startChain(): Promise<ChainEnv> {
  const server = ganache.server({
    chain: { chainId: 31337, hardfork: 'shanghai' },
    wallet: {
      accounts: [LOCAL_KEY, OPS_KEY, AGENT_KEY, BUYER_KEY].map((secretKey) => ({
        secretKey,
        balance: '0x3635c9adc5dea00000',
      })),
    },
    logging: { quiet: true },
  });
  await server.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const viemChain = defineChain({
    id: 31337,
    name: 'local permit2 test',
    nativeCurrency: { name: 'Test', symbol: 'TEST', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const client = createPublicClient({ chain: viemChain, transport: http(url), cacheTime: 0 });
  const deployer = privateKeyToAccount(LOCAL_KEY);
  const wallet = createWalletClient({ chain: viemChain, account: deployer, transport: http(url) });

  await server.provider.request({
    method: 'evm_setAccountCode',
    params: [PERMIT2_ADDRESS, fixtureCode('permit2-968.json')],
  });

  const steps = deploymentSteps(erc8004, deployer.address);
  for (const step of steps) {
    const gas =
      ((await client.estimateGas({ account: deployer.address, data: step.data, value: 0n })) * 120n) /
      100n;
    const receipt = await client.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({
        to: step.to,
        data: step.data,
        nonce: step.nonce,
        value: 0n,
        gas,
      }),
    });
    if (receipt.status !== 'success') throw new Error('registry deployment failed');
  }

  const tokenReceipt = await client.waitForTransactionReceipt({
    hash: await wallet.deployContract({ abi: plainUsdt.abi, bytecode: plainUsdt.bytecode, args: [] }),
  });
  if (tokenReceipt.status !== 'success' || !tokenReceipt.contractAddress) {
    throw new Error('token deployment failed');
  }

  const proxyReceipt = await client.waitForTransactionReceipt({
    hash: await wallet.deployContract({
      abi: x402Proxy.abi,
      bytecode: x402Proxy.bytecode,
      args: [PERMIT2_ADDRESS],
    }),
  });
  if (proxyReceipt.status !== 'success' || !proxyReceipt.contractAddress) {
    throw new Error('proxy deployment failed');
  }
  const proxyRuntime = await client.getCode({ address: proxyReceipt.contractAddress });
  if (!proxyRuntime || proxyRuntime === '0x') throw new Error('proxy runtime missing');
  await server.provider.request({
    method: 'evm_setAccountCode',
    params: [X402_PROXY, proxyRuntime],
  });

  // The upto proxy runtime on 968 is Cancun-compiled too; a shanghai build of
  // the same source runs at the canonical upto address.
  const uptoReceipt = await client.waitForTransactionReceipt({
    hash: await wallet.deployContract({
      abi: x402UptoProxy.abi,
      bytecode: x402UptoProxy.bytecode,
      args: [PERMIT2_ADDRESS],
    }),
  });
  if (uptoReceipt.status !== 'success' || !uptoReceipt.contractAddress) {
    throw new Error('upto proxy deployment failed');
  }
  const uptoRuntime = await client.getCode({ address: uptoReceipt.contractAddress });
  if (!uptoRuntime || uptoRuntime === '0x') throw new Error('upto proxy runtime missing');
  await server.provider.request({
    method: 'evm_setAccountCode',
    params: [UPTO_PERMIT2_PROXY, uptoRuntime],
  });

  closers.push(() => server.close());
  return {
    url,
    registry: steps[1]!.address,
    token: tokenReceipt.contractAddress,
    client,
    viemChain,
    deployer,
    proxyAbi: x402Proxy.abi,
    uptoProxyAbi: x402UptoProxy.abi,
  };
}

export function buildApp(
  env: ChainEnv,
  overrides: {
    permit2Enabled?: boolean;
    opsPrivateKey?: Hex;
    servicesRequireApproved?: boolean;
    price?: bigint;
    identityRegistry?: Address | null;
    permit2Facilitator?: Permit2Facilitator;
    deliverEcho?: () => Promise<unknown>;
    starterGas?: boolean;
    llmServicesEnabled?: boolean;
    llmBeefapiBaseUrl?: string;
    llmBeefapiApiKey?: string;
    llmPayerDailyCapAtomic?: bigint;
    llmGlobalDailyCapAtomic?: bigint;
    llmRequestTimeoutMs?: number;
    agentOrigin?: string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'settlement-m6-'));
  const publicDir = join(dir, 'public');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'index.html'), '<html></html>');
  const config = runtimeConfig({
    port: 4311,
    chain: {
      rpcUrl: env.url,
      chainId: 31337,
      contract: CONTRACT,
      token: env.token,
      privateKey: LOCAL_KEY,
    },
    publicDir,
    dbPath: join(dir, 'db.sqlite'),
    lockPath: join(dir, 'lock'),
    minAmount: 1_000_000n,
    maturityMs: 0,
    source: 'fixture',
    identityRegistry:
      overrides.identityRegistry === undefined ? env.registry : overrides.identityRegistry ?? undefined,
    permit2: PERMIT2_ADDRESS,
    x402Permit2Proxy: X402_PROXY,
    settlementX402Permit2Enabled: overrides.permit2Enabled ?? true,
    opsPrivateKey: overrides.opsPrivateKey ?? OPS_KEY,
    serviceEchoPrice: overrides.price ?? PRICE,
    servicesRequireApproved: overrides.servicesRequireApproved ?? false,
    starterGasEnabled: overrides.starterGas ?? false,
    starterGasWei: overrides.starterGas ? 10n ** 15n : undefined,
    starterGasDailyCapWei: overrides.starterGas ? 10n ** 16n : undefined,
    starterGasBalanceThresholdWei: overrides.starterGas ? 10n ** 15n : undefined,
    llmServicesEnabled: overrides.llmServicesEnabled ?? false,
    llmBeefapiBaseUrl: overrides.llmBeefapiBaseUrl ?? DEFAULT_BEEFAPI_LLM_BASE_URL,
    llmBeefapiApiKey: overrides.llmBeefapiApiKey ?? '',
    llmPayerDailyCapAtomic: overrides.llmPayerDailyCapAtomic,
    llmGlobalDailyCapAtomic: overrides.llmGlobalDailyCapAtomic,
    llmRequestTimeoutMs: overrides.llmRequestTimeoutMs,
    agentOrigin: overrides.agentOrigin,
  });
  const store = createStore({
    path: join(dir, 'db.sqlite'),
    fingerprint: runtimeFingerprint(config),
  });
  closers.push(() => store.close());
  const chain = new MockPayoutChain();
  const source = createSource(store, config);
  const worker = createWorker({ store, chain, source, config });
  const serviceCatalog = overrides.deliverEcho
    ? createServiceCatalog({
        store,
        config,
        delivers: { echo: overrides.deliverEcho },
      })
    : undefined;
  const app = createApp({
    store,
    worker,
    chain,
    source,
    config,
    publicDir,
    agentRegistryChain: createRpcAgentRegistryChain({
      rpcUrl: env.url,
      chainId: 31337,
      registry: env.registry,
    }),
    permit2Facilitator: overrides.permit2Facilitator,
    serviceCatalog,
  });
  return { app, store, config, dir };
}

export function req(
  app: SettlementApp,
  path: string,
  init: RequestInit & { paymentSignature?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set('Host', new URL(app.origin).host);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (init.paymentSignature) headers.set('PAYMENT-SIGNATURE', init.paymentSignature);
  return app.fetch(new Request(`${app.origin}${path}`, { ...init, headers }));
}

export async function registerProvider(
  app: SettlementApp,
  env: ChainEnv,
  agent: ReturnType<typeof privateKeyToAccount>,
): Promise<void> {
  const challengeRes = await req(app, '/api/agents/challenge', {
    method: 'POST',
    body: JSON.stringify({ address: agent.address }),
  });
  const { message } = (await challengeRes.json()) as { message: string };
  const signature = await agent.signMessage({ message });
  const draftRes = await req(app, '/api/agents/drafts', {
    method: 'POST',
    body: JSON.stringify({ address: agent.address, signature, role: 'provider', profile: PROFILE }),
  });
  expect(draftRes.status).toBe(200);
  const draft = (await draftRes.json()) as { agentURI: string };
  const wallet = createWalletClient({ chain: env.viemChain, account: agent, transport: http(env.url) });
  const gas =
    ((await env.client.estimateContractGas({
      address: env.registry,
      abi: identityRegistryAbi,
      functionName: 'register',
      args: [draft.agentURI],
      account: agent.address,
    })) *
      120n) /
    100n;
  const hash = await wallet.writeContract({
    address: env.registry,
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [draft.agentURI],
    gas,
  });
  await env.client.waitForTransactionReceipt({ hash });
  const confirm = await req(app, '/api/agents/confirm', {
    method: 'POST',
    body: JSON.stringify({ txHash: hash }),
  });
  expect(confirm.status).toBe(200);
}

export async function mintUsdt(env: ChainEnv, to: Address, amount: bigint) {
  const wallet = createWalletClient({ chain: env.viemChain, account: env.deployer, transport: http(env.url) });
  await env.client.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address: env.token,
      abi: plainUsdt.abi,
      functionName: 'mint',
      args: [to, amount],
    }),
  });
}

export async function approvePermit2(
  env: ChainEnv,
  account: ReturnType<typeof privateKeyToAccount>,
  amount: bigint,
) {
  const wallet = createWalletClient({ chain: env.viemChain, account, transport: http(env.url) });
  await env.client.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address: env.token,
      abi: plainUsdt.abi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, amount],
    }),
  });
}

export async function balanceOf(env: ChainEnv, owner: Address): Promise<bigint> {
  return (await env.client.readContract({
    address: env.token,
    abi: plainUsdt.abi,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint;
}

// Manual Permit2 payload so tests can reuse one signed payment across HTTP and
// MCP without depending on the official client for negative cases.
export async function manualPayload(input: {
  requirement: X402PaymentRequirements;
  account: ReturnType<typeof privateKeyToAccount>;
  chainId: number;
  amount?: string;
  payTo?: Address;
  spender?: Address;
  deadline?: string;
  validAfter?: string;
  nonce?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const nonce =
    input.nonce ??
    BigInt(
      `0x${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`,
    ).toString();
  const auth = {
    from: getAddress(input.account.address),
    permitted: {
      token: getAddress(input.requirement.asset),
      amount: input.amount ?? input.requirement.amount,
    },
    spender: getAddress(input.spender ?? X402_PROXY),
    nonce,
    deadline: input.deadline ?? String(now + input.requirement.maxTimeoutSeconds),
    witness: {
      to: getAddress(input.payTo ?? input.requirement.payTo),
      validAfter: input.validAfter ?? '0',
    },
  };
  const signature = await input.account.signTypedData({
    domain: { name: 'Permit2', chainId: input.chainId, verifyingContract: getAddress(PERMIT2_ADDRESS) },
    types: permit2WitnessTypes,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: getAddress(auth.permitted.token), amount: BigInt(auth.permitted.amount) },
      spender: getAddress(auth.spender),
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      witness: { to: getAddress(auth.witness.to), validAfter: BigInt(auth.witness.validAfter) },
    },
  });
  const payload = {
    x402Version: 2,
    accepted: { ...input.requirement },
    payload: { signature, permit2Authorization: auth },
  };
  return {
    payload,
    header: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    nonce,
    payer: getAddress(input.account.address),
  };
}

export function mockFacilitator(inspect: () => Promise<Permit2ReceiptResult>): Permit2Facilitator {
  return {
    facilitatorAddress: privateKeyToAccount(OPS_KEY).address,
    async getChainId() {
      return 31337;
    },
    requirementsOf({ amount, asset, payTo }) {
      return {
        scheme: 'exact',
        network: 'eip155:31337',
        amount,
        asset: getAddress(asset),
        payTo: getAddress(payTo),
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: 'permit2', permit2: PERMIT2_ADDRESS, x402Permit2Proxy: X402_PROXY },
      };
    },
    uptoRequirementsOf({ amount, asset, payTo }) {
      return {
        scheme: 'upto',
        network: 'eip155:31337',
        amount,
        asset: getAddress(asset),
        payTo: getAddress(payTo),
        maxTimeoutSeconds: 300,
        extra: {
          assetTransferMethod: 'permit2',
          permit2: PERMIT2_ADDRESS,
          x402UptoPermit2Proxy: X402_PROXY,
          facilitatorAddress: privateKeyToAccount(OPS_KEY).address,
        },
      };
    },
    async verify({ payload }) {
      const auth = payload.payload.permit2Authorization;
      return {
        payer: auth.from,
        nonce: auth.nonce,
        paymentKey: permit2PaymentKey({ chainId: 31337, payer: auth.from, nonce: auth.nonce }),
      };
    },
    async verifyUpto({ payload }) {
      const auth = payload.payload.permit2Authorization;
      return {
        payer: auth.from,
        nonce: auth.nonce,
        paymentKey: permit2PaymentKey({ chainId: 31337, payer: auth.from, nonce: auth.nonce }),
      };
    },
    async assertFunded() {},
    async prepare() {
      return { rawTransaction: `0x${'ab'.repeat(32)}` as Hex, hash: keccak256(toHex('settle')) };
    },
    async prepareUpto() {
      return { rawTransaction: `0x${'ab'.repeat(32)}` as Hex, hash: keccak256(toHex('settle')) };
    },
    async broadcast() {},
    inspect,
  };
}

// A minimal MCP JSON-RPC client over Streamable HTTP.
export function createMcpClient(app: SettlementApp) {
  let nextId = 1;
  let sessionId: string | undefined;
  const endpoint = `${app.origin}/mcp`;

  async function rpc(
    method: string,
    params?: Record<string, unknown>,
    notify = false,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const message: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (!notify) message.id = nextId++;
    if (params) message.params = params;
    const res = await app.fetch(
      new Request(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Host: new URL(app.origin).host,
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify(message),
      }),
    );
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) sessionId = sid;
    if (res.status === 202) return {};
    return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  }

  return {
    rpc,
    session: () => sessionId,
    call: (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
      rpc('tools/call', meta ? { name, arguments: args, _meta: meta } : { name, arguments: args }),
  };
}
