import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ganache from 'ganache';
import solc from 'solc';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseTransaction,
  toHex,
  type Address,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader as decodeOfficialRequired,
  decodePaymentResponseHeader as decodeOfficialResponse,
  x402HTTPClient,
} from '@x402/core/http';
import { PERMIT2_ADDRESS, permit2WitnessTypes } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { compileErc8004, deploymentSteps } from '../scripts/erc8004-artifacts.ts';
import {
  createRpcAgentRegistryChain,
  identityRegistryAbi,
} from '../src/agent-registry.ts';
import { runtimeConfig, runtimeFingerprint } from '../src/config.ts';
import { createOpsSigner } from '../src/ops-signer.ts';
import { createApp, type SettlementApp } from '../src/server.ts';
import { createServiceCatalog } from '../src/services.ts';
import { createSource } from '../src/source.ts';
import { createStore, type Store } from '../src/store.ts';
import type { Chain, Payout, Prepared } from '../src/types.ts';
import { createWorker } from '../src/worker.ts';
import {
  permit2PaymentKey,
  type Permit2Facilitator,
  type Permit2ReceiptResult,
} from '../src/x402/index.ts';
import type { X402PaymentRequirements, X402Permit2PaymentPayload } from '../src/x402/types.ts';

const LOCAL_KEY = `0x${'1'.padStart(64, '0')}` as Hex;
const OPS_KEY = `0x${'2'.padStart(64, '0')}` as Hex;
const AGENT_KEY = `0x${'3'.padStart(64, '0')}` as Hex;
const BUYER_KEY = `0x${'4'.padStart(64, '0')}` as Hex;
const CONTRACT = '0x0000000000000000000000000000000000000002' as Address;
const OTHER = '0x0000000000000000000000000000000000000009' as Address;
const BOTCHAIN_USDT = '0x75edC9335175Fc0552D51D48439F229c10420fe3' as Address;
const X402_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001' as Address;
const PRICE = 1_000_000n;
const PROFILE = {
  name: 'Demo Provider',
  services: [{ name: 'echo', endpoint: 'http://127.0.0.1:4311/api/services/echo/call' }],
  x402Support: true,
  active: true,
};

const erc8004 = compileErc8004();
const plainUsdt = compilePlainUSDT();
const x402Proxy = compileX402Proxy();

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

// The canonical proxy runtime on BOT Chain testnet is Cancun-compiled and uses
// a single MCOPY opcode, which ganache 7.9.2 rejects. The test deploys a
// shanghai-pinned build of the same source and places its runtime at the
// canonical proxy address, so the real Permit2 runtime is still exercised.
function compileX402Proxy() {
  return compileSolidity('X402ExactPermit2Proxy.sol', 'x402ExactPermit2Proxy');
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
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

type ChainEnv = {
  url: string;
  registry: Address;
  token: Address;
  client: PublicClient;
  viemChain: ViemChain;
  deployer: ReturnType<typeof privateKeyToAccount>;
};

async function startChain(): Promise<ChainEnv> {
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

  // Permit2 is not deployed locally, so the 968 runtime code is placed at the
  // same address (the fixture records its source block and keccak).
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

  // The proxy runtime on 968 is Cancun-compiled (MCOPY), which ganache cannot
  // execute, so the same source built for shanghai runs at the canonical address.
  // Deployed last so it does not shift the registry steps' fixed nonces.
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

  closers.push(() => server.close());
  return { url, registry: steps[1]!.address, token: tokenReceipt.contractAddress, client, viemChain, deployer };
}

function buildApp(
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
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'settlement-permit2-'));
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

function req(
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

async function registerProvider(
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

async function mintUsdt(env: ChainEnv, to: Address, amount: bigint) {
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

async function approvePermit2(env: ChainEnv, account: ReturnType<typeof privateKeyToAccount>, amount: bigint) {
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

async function balanceOf(env: ChainEnv, owner: Address): Promise<bigint> {
  return (await env.client.readContract({
    address: env.token,
    abi: plainUsdt.abi,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint;
}

async function fetchOffer(app: SettlementApp) {
  const res = await req(app, '/api/services/echo/call', { method: 'POST', body: JSON.stringify({ hello: 'world' }) });
  expect(res.status).toBe(402);
  const required = decodeOfficialRequired(res.headers.get('PAYMENT-REQUIRED')!);
  return { res, required, requirement: required.accepts[0]! };
}

// Manual Permit2 payload so negative cases can tweak one field at a time. The
// happy path uses the official @x402/evm client instead.
async function manualPayload(input: {
  requirement: X402PaymentRequirements;
  account: ReturnType<typeof privateKeyToAccount>;
  chainId: number;
  amount?: string;
  payTo?: Address;
  spender?: Address;
  deadline?: string;
  validAfter?: string;
  nonce?: string;
  signWith?: ReturnType<typeof privateKeyToAccount>;
}) {
  const now = Math.floor(Date.now() / 1000);
  const nonce =
    input.nonce ??
    BigInt(
      `0x${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`,
    ).toString();
  const auth = {
    from: getAddress(input.account.address),
    permitted: { token: getAddress(input.requirement.asset), amount: input.amount ?? input.requirement.amount },
    spender: getAddress(input.spender ?? X402_PROXY),
    nonce,
    deadline: input.deadline ?? String(now + input.requirement.maxTimeoutSeconds),
    witness: {
      to: getAddress(input.payTo ?? input.requirement.payTo),
      validAfter: input.validAfter ?? '0',
    },
  };
  const signer = input.signWith ?? input.account;
  const signature = await signer.signTypedData({
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

function mockFacilitator(inspect: () => Promise<Permit2ReceiptResult>): Permit2Facilitator {
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

test('the 968 fixtures keep their recorded source and the local proxy build matches the witness type', () => {
  for (const name of ['permit2-968.json', 'x402-permit2-proxy-968.json']) {
    const fixture = JSON.parse(
      readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
    ) as { code: Hex; keccak256: Hex; source: { chainId: number; blockNumber: number } };
    expect(keccak256(fixture.code)).toBe(fixture.keccak256);
    expect(fixture.source.chainId).toBe(968);
    expect(fixture.source.blockNumber).toBeGreaterThan(0);
  }
  // WITNESS_TYPEHASH read from the proxy deployed on 968; the shanghai build used
  // locally must expose the same witness semantics.
  expect(keccak256(toHex('Witness(address to,uint256 validAfter)'))).toBe(
    '0xd97b3239a7f32295517bd14cb074edfdd188dfe5eb42f802bb26d4fd1eb12c37',
  );
});

test('402 offer carries the official Permit2 exact fields', async () => {
  const env = await startChain();
  const { app } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  await registerProvider(app, env, agent);

  const { required, requirement } = await fetchOffer(app);
  expect(required.x402Version).toBe(2);
  expect(requirement.scheme).toBe('exact');
  expect(requirement.network).toBe('eip155:31337');
  expect(requirement.amount).toBe(PRICE.toString());
  expect(getAddress(requirement.asset)).toBe(getAddress(env.token));
  expect(getAddress(requirement.payTo)).toBe(getAddress(agent.address));
  expect(requirement.maxTimeoutSeconds).toBe(300);
  expect((requirement.extra as { assetTransferMethod?: string }).assetTransferMethod).toBe('permit2');
  expect(
    await env.client.readContract({
      address: X402_PROXY,
      abi: x402Proxy.abi,
      functionName: 'WITNESS_TYPEHASH',
    }),
  ).toBe(keccak256(toHex('Witness(address to,uint256 validAfter)')));

  const services = await req(app, '/api/services');
  expect(services.status).toBe(200);
  const list = (await services.json()) as { services: Array<{ serviceId: string; price: string }> };
  expect(list.services[0]?.serviceId).toBe('echo');
  expect(list.services[0]?.price).toBe(PRICE.toString());
});

test('official client payment settles, delivers once, and repeats the same result', async () => {
  const env = await startChain();
  const { app, store } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  const buyer = privateKeyToAccount(BUYER_KEY);
  await registerProvider(app, env, agent);
  await mintUsdt(env, buyer.address, 10n * PRICE);
  await approvePermit2(env, buyer, 10n * PRICE);

  await fetchOffer(app);
  const core = new x402Client()
    .setSpendControls(false)
    .register('eip155:31337', new ExactEvmScheme(buyer));
  const client = new x402HTTPClient(core);
  const offer = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
  });
  const required = client.getPaymentRequiredResponse((name) => offer.headers.get(name));
  expect((required.accepts[0]!.extra as { assetTransferMethod?: string }).assetTransferMethod).toBe(
    'permit2',
  );
  const payload = await client.createPaymentPayload(required);
  const encoded = client.encodePaymentSignatureHeader(payload);

  const opsAddress = privateKeyToAccount(OPS_KEY).address;
  const opsBefore = await env.client.getTransactionCount({ address: opsAddress });
  const payToBefore = await balanceOf(env, agent.address);

  const paid = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
    paymentSignature: encoded['PAYMENT-SIGNATURE']!,
  });
  expect(paid.status).toBe(200);
  const body = (await paid.json()) as { result: { ok: boolean; serviceId: string; echo: unknown } };
  expect(body.result).toEqual({ ok: true, serviceId: 'echo', echo: { hello: 'world' } });
  const settle = decodeOfficialResponse(paid.headers.get('PAYMENT-RESPONSE')!);
  expect(settle.success).toBe(true);
  expect(settle.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
  const payToAfter = await balanceOf(env, agent.address);
  expect(payToAfter - payToBefore).toBe(PRICE);
  const opsAfter = await env.client.getTransactionCount({ address: opsAddress });
  expect(opsAfter - opsBefore).toBe(1);

  const again = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
    paymentSignature: encoded['PAYMENT-SIGNATURE']!,
  });
  expect(again.status).toBe(200);
  expect((await again.json()).result).toEqual(body.result);
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsAfter);
  expect(await balanceOf(env, agent.address)).toBe(payToAfter);
  const payment = store.getServicePayment(
    permit2PaymentKey({
      chainId: 31337,
      payer: getAddress(buyer.address),
      nonce: (payload.payload as { permit2Authorization: { nonce: string } }).permit2Authorization.nonce,
    }),
  );
  expect(payment?.status).toBe('delivered');
});

test('invalid, expired, mismatched, unfunded, and unauthorized payments return 402 without sending a transaction', async () => {
  const env = await startChain();
  const { app, store } = buildApp(env);
  const agent = privateKeyToAccount(AGENT_KEY);
  const buyer = privateKeyToAccount(BUYER_KEY);
  const other = privateKeyToAccount(generatePrivateKey());
  await registerProvider(app, env, agent);
  const opsAddress = privateKeyToAccount(OPS_KEY).address;
  const opsBefore = await env.client.getTransactionCount({ address: opsAddress });
  const { requirement } = await fetchOffer(app);
  const path = '/api/services/echo/call';
  const body = JSON.stringify({});

  const cases: Array<{ name: string; header: string; payer: Address; nonce: string }> = [];

  // Wrong signer for the claimed `from`.
  cases.push(
    await manualPayload({ requirement, account: buyer, chainId: 31337, signWith: other }).then((p) => ({
      name: 'bad signature',
      header: p.header,
      payer: p.payer,
      nonce: p.nonce,
    })),
  );
  // Expired deadline.
  cases.push(
    await manualPayload({
      requirement,
      account: buyer,
      chainId: 31337,
      deadline: String(Math.floor(Date.now() / 1000) - 10),
    }).then((p) => ({ name: 'expired', header: p.header, payer: p.payer, nonce: p.nonce })),
  );
  // Amount below the requirement.
  cases.push(
    await manualPayload({ requirement, account: buyer, chainId: 31337, amount: '1' }).then((p) => ({
      name: 'amount',
      header: p.header,
      payer: p.payer,
      nonce: p.nonce,
    })),
  );
  // Wrong recipient.
  cases.push(
    await manualPayload({ requirement, account: buyer, chainId: 31337, payTo: OTHER }).then((p) => ({
      name: 'payTo',
      header: p.header,
      payer: p.payer,
      nonce: p.nonce,
    })),
  );
  // Insufficient balance and no allowance (buyer never funded/approved).
  cases.push(
    await manualPayload({ requirement, account: buyer, chainId: 31337 }).then((p) => ({
      name: 'balance/allowance',
      header: p.header,
      payer: p.payer,
      nonce: p.nonce,
    })),
  );

  for (const item of cases) {
    const res = await req(app, path, { method: 'POST', body, paymentSignature: item.header });
    expect(res.status, item.name).toBe(402);
    expect(
      store.getServicePayment(
        permit2PaymentKey({ chainId: 31337, payer: item.payer, nonce: item.nonce }),
      ),
      item.name,
    ).toBeNull();
  }
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore);

  // Fund but do not approve: allowance is the only missing piece.
  await mintUsdt(env, buyer.address, 10n * PRICE);
  const noAllowance = await manualPayload({ requirement, account: buyer, chainId: 31337 });
  const allowanceRes = await req(app, path, {
    method: 'POST',
    body,
    paymentSignature: noAllowance.header,
  });
  expect(allowanceRes.status).toBe(402);
  expect((await allowanceRes.json()).error).toBe(
    'Buyer has not approved Permit2, or the allowance is too low.',
  );
  expect(await env.client.getTransactionCount({ address: opsAddress })).toBe(opsBefore);
});

test('a reverted settlement is recorded as failed and never delivers', async () => {
  const env = await startChain();
  let delivered = 0;
  const { app, store } = buildApp(env, {
    permit2Facilitator: mockFacilitator(async () => ({ ok: false, reason: 'reverted' })),
    deliverEcho: async () => {
      delivered += 1;
      return { ok: true };
    },
  });
  const agent = privateKeyToAccount(AGENT_KEY);
  const buyer = privateKeyToAccount(BUYER_KEY);
  await registerProvider(app, env, agent);
  const { requirement } = await fetchOffer(app);
  const signed = await manualPayload({ requirement, account: buyer, chainId: 31337 });

  const res = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({}),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(402);
  expect(delivered).toBe(0);
  const record = store.getServicePayment(
    permit2PaymentKey({ chainId: 31337, payer: signed.payer, nonce: signed.nonce }),
  );
  expect(record?.status).toBe('failed');

  // A repeat of the failed payload is rejected without a new attempt.
  const repeat = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({}),
    paymentSignature: signed.header,
  });
  expect(repeat.status).toBe(409);
  expect(delivered).toBe(0);
});

test('a deliver failure is recorded as settled but not delivered', async () => {
  const env = await startChain();
  const { app, store } = buildApp(env, {
    permit2Facilitator: mockFacilitator(async () => ({ ok: true, txHash: keccak256(toHex('settle')), blockNumber: 1n })),
    deliverEcho: async () => {
      throw new Error('delivery exploded');
    },
  });
  const agent = privateKeyToAccount(AGENT_KEY);
  const buyer = privateKeyToAccount(BUYER_KEY);
  await registerProvider(app, env, agent);
  const { requirement } = await fetchOffer(app);
  const signed = await manualPayload({ requirement, account: buyer, chainId: 31337 });

  const res = await req(app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({}),
    paymentSignature: signed.header,
  });
  expect(res.status).toBe(500);
  const record = store.getServicePayment(
    permit2PaymentKey({ chainId: 31337, payer: signed.payer, nonce: signed.nonce }),
  );
  expect(record?.status).toBe('settled');
  expect(record?.error).not.toBeNull();
});

test('the service is unavailable when the provider is missing or not approved', async () => {
  const env = await startChain();
  // No provider registered at all.
  const missing = buildApp(env);
  const res = await req(missing.app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(503);

  // Registered but pending, with approval required.
  const strict = buildApp(env, { servicesRequireApproved: true });
  const agent = privateKeyToAccount(AGENT_KEY);
  await registerProvider(strict.app, env, agent);
  const gated = await req(strict.app, '/api/services/echo/call', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  expect(gated.status).toBe(503);
});

test('the ops signer serializes concurrent signing into unique sequential nonces', async () => {
  const env = await startChain();
  const signer = createOpsSigner({ rpcUrl: env.url, chainId: 31337, privateKey: OPS_KEY });
  const to = privateKeyToAccount(LOCAL_KEY).address;
  const signed = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      signer.sign({ to, value: BigInt(index + 1) }),
    ),
  );
  const nonces = signed
    .map((item) => parseTransaction(item.rawTransaction).nonce ?? -1)
    .sort((a, b) => a - b);
  expect(nonces).toEqual([0, 1, 2, 3, 4]);
});

test('the shared ops signer keeps starter gas and settlement nonces apart', async () => {
  const env = await startChain();
  const { app, store } = buildApp(env, { starterGas: true });
  const agent = privateKeyToAccount(AGENT_KEY);
  const buyer = privateKeyToAccount(BUYER_KEY);
  await registerProvider(app, env, agent);
  await mintUsdt(env, buyer.address, 10n * PRICE);
  await approvePermit2(env, buyer, 10n * PRICE);
  const { requirement } = await fetchOffer(app);
  const signed = await manualPayload({ requirement, account: buyer, chainId: 31337 });
  const freshAccount = privateKeyToAccount(generatePrivateKey());
  const fresh = freshAccount.address;
  const challengeRes = await req(app, '/api/agents/challenge', {
    method: 'POST',
    body: JSON.stringify({ address: fresh, purpose: 'starter-gas' }),
  });
  const { message } = (await challengeRes.json()) as { message: string };
  const freshSignature = await freshAccount.signMessage({ message });

  // Both paths sign through the one process-wide ops signer at the same time.
  const [gasRes, paid] = await Promise.all([
    req(app, '/api/agents/starter-gas', {
      method: 'POST',
      body: JSON.stringify({ address: fresh, signature: freshSignature }),
    }),
    req(app, '/api/services/echo/call', {
      method: 'POST',
      body: JSON.stringify({}),
      paymentSignature: signed.header,
    }),
  ]);
  expect(paid.status).toBe(200);
  expect(gasRes.status).toBe(200);
  const gas = (await gasRes.json()) as { txHash: Hex };
  const payment = store.getServicePayment(
    permit2PaymentKey({ chainId: 31337, payer: signed.payer, nonce: signed.nonce }),
  );
  expect(payment?.status).toBe('delivered');

  const ops = privateKeyToAccount(OPS_KEY).address;
  const nonces: number[] = [];
  for (const hash of [gas.txHash, payment!.txHash!]) {
    const tx = await env.client.getTransaction({ hash });
    expect(tx.from.toLowerCase()).toBe(ops.toLowerCase());
    nonces.push(tx.nonce);
  }
  expect(nonces).toHaveLength(2);
  expect(new Set(nonces).size).toBe(2);
  expect(await env.client.getBalance({ address: fresh })).toBe(10n ** 15n);
});

test('the Permit2 settlement switch is independent from the Fuji EIP-3009 switch', () => {
  const localBase = {
    chain: {
      rpcUrl: 'http://127.0.0.1:8547',
      chainId: 31337,
      contract: CONTRACT,
      token: BOTCHAIN_USDT,
      privateKey: LOCAL_KEY,
    },
    source: 'fixture' as const,
  };
  // Old switch needs EIP-3009 and a beefapi order demo.
  expect(() => runtimeConfig({ ...localBase, x402Enabled: true })).toThrow();
  // New switch needs Permit2, the proxy, and the ops key.
  expect(() => runtimeConfig({ ...localBase, settlementX402Permit2Enabled: true })).toThrow(
    /Permit2/,
  );
  expect(() =>
    runtimeConfig({
      ...localBase,
      settlementX402Permit2Enabled: true,
      permit2: PERMIT2_ADDRESS,
      x402Permit2Proxy: X402_PROXY,
    }),
  ).toThrow(/SETTLEMENT_OPS_PRIVATE_KEY/);
  const local = runtimeConfig({
    ...localBase,
    settlementX402Permit2Enabled: true,
    permit2: PERMIT2_ADDRESS,
    x402Permit2Proxy: X402_PROXY,
    opsPrivateKey: OPS_KEY,
  });
  expect(local.settlementX402Permit2Enabled).toBe(true);
  expect(local.x402Enabled).toBe(false);

  // BOT Chain testnet: the old switch is rejected, the new switch is accepted.
  const botBase = {
    chain: { rpcUrl: 'https://rpc.bohr.life', chainId: 968, token: BOTCHAIN_USDT },
    source: 'fixture' as const,
  };
  expect(() =>
    runtimeConfig({
      ...botBase,
      source: 'beefapi',
      orderDemo: true,
      beefapiBaseUrl: 'http://127.0.0.1:9',
      beefapiToken: 't'.repeat(32),
      x402Enabled: true,
    }),
  ).toThrow();
  const bot = runtimeConfig({
    ...botBase,
    settlementX402Permit2Enabled: true,
    opsPrivateKey: OPS_KEY,
  });
  expect(bot.settlementX402Permit2Enabled).toBe(true);
  expect(bot.x402Enabled).toBe(false);
  expect(getAddress(bot.permit2!)).toBe(getAddress(PERMIT2_ADDRESS));

  // Fuji declares Permit2 in its profile, so the new switch resolves the
  // canonical Permit2 and x402 proxy addresses there too.
  const fuji = runtimeConfig({
    chain: {
      rpcUrl: 'https://example.invalid',
      chainId: 43113,
      contract: CONTRACT,
      token: '0x5425890298aed601595a70AB815c96711a31Bc65',
      privateKey: LOCAL_KEY,
    },
    source: 'fixture',
    settlementX402Permit2Enabled: true,
    opsPrivateKey: OPS_KEY,
  });
  expect(fuji.settlementX402Permit2Enabled).toBe(true);
  expect(getAddress(fuji.permit2!)).toBe(getAddress(PERMIT2_ADDRESS));
  expect(getAddress(fuji.x402Permit2Proxy!)).toBe(getAddress(X402_PROXY));
});
