import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { acquireProcessLock } from '../src/lock.ts';
import { compileErc8004, deploymentSteps, IMPLEMENTATION_SLOT } from './erc8004-artifacts.ts';

// ERC-8004 IdentityRegistry (implementation + ERC1967Proxy) for BOT Chain testnet 968.
// Default run is read-only: local simulation plus eth_estimateGas/eth_gasPrice. Nothing is
// signed or broadcast unless --send is passed and BOTCHAIN_TESTNET_OPS_PRIVATE_KEY is present.
export const OPS = '0x2547c1122c9aFD11eA0c4b66bb033552b90B979F' as const;
export const REGISTER_SELECTORS = { 'register()': '0x1aa3a008', 'register(string)': '0xf2c298be', 'register(string,(string,bytes)[])': '0x8ea42286' } as const;
const RPC = 'https://rpc.bohr.life';
const CHAIN_ID = 968;
const CAP = 1n * 10n ** 18n; // 1 tBOT upper bound for both deployments, not a target spend.
const chain = defineChain({ id: CHAIN_ID, name: 'BOT Chain Testnet', nativeCurrency: { name: 'tBOT', symbol: 'tBOT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const DIR = resolve(import.meta.dir, '../.local/erc8004-botchain');
let stage = 'initialization';

const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function failureReport(error: unknown) {
  const e = error as { name?: string; message?: string; generatedMessage?: boolean };
  const reason = e?.name === 'AssertionError' && e.generatedMessage === false
    ? e.message
    : e?.message === 'Broadcast uncertain; preserve journal' ? e.message : 'RPC, validation or filesystem failure';
  return { status: 'STOPPED', stage, reason, recovery: 'Preserve .local/erc8004-botchain; reconcile the same hash. Never create a new nonce.' };
}

function durable(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, json(value), { mode: 0o600 });
  const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}

// The implementation embeds UUPSUpgradeable.__self = address(this); the deployed runtime must
// carry the implementation address in every immutable slot. The proxy has no immutables.
export function expectedRuntime(artifact: { runtime: Hex; immutables: Record<string, { start: number; length: number }[]> }, address: Hex): Hex {
  let code = artifact.runtime.slice(2);
  for (const refs of Object.values(artifact.immutables)) for (const { start, length } of refs) {
    assert.equal(length, 32);
    code = code.slice(0, start * 2) + address.slice(2).toLowerCase().padStart(64, '0') + code.slice((start + length) * 2);
  }
  return `0x${code}`;
}

async function rawRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

// Read-only eth_estimateGas/eth_call for a creation transaction. The 968 node expects the
// object-keyed state override form. The proxy creation delegatecalls the implementation, so its
// runtime is injected and the sender nonce advanced to reflect the real deployment order.
async function creationQuote(data: Hex, nonce: number, override?: Record<string, unknown>) {
  const tx = { from: OPS, data, value: '0x0', nonce: toHex(nonce) };
  const params = override ? [tx, 'latest', override] : [tx, 'latest'];
  return { gas: BigInt(await rawRpc<string>('eth_estimateGas', params)), runtime: await rawRpc<Hex>('eth_call', params) };
}

export async function main(mode: string) {
  assert.ok(['dry-run', 'send'].includes(mode), 'Use dry-run (default) or send');
  const client = createPublicClient({ chain, transport: http(RPC, { timeout: 20_000, retryCount: 1 }), cacheTime: 0 });
  stage = 'compile-and-network-check';
  const bundle = compileErc8004();
  assert.equal(await client.getChainId(), CHAIN_ID, 'Wrong network; expected BOT Chain testnet 968');
  const nonce = await client.getTransactionCount({ address: OPS, blockTag: 'latest' });
  const steps = deploymentSteps(bundle, OPS, nonce);
  stage = 'estimate-and-simulate';
  const gasPrice = await client.getGasPrice();
  assert.ok(gasPrice > 0n, 'Invalid gas quote');
  const estimates = [];
  const implAddress = steps[0].address;
  for (const s of steps) {
    assert.ok(!await client.getCode({ address: s.address }), 'Target already deployed');
    const artifact = s.name === 'IdentityRegistryUpgradeable' ? bundle.artifacts.IdentityRegistryUpgradeable : bundle.artifacts.ERC1967Proxy;
    const override = s.name === 'ERC1967Proxy'
      ? { [implAddress]: { code: expectedRuntime(bundle.artifacts.IdentityRegistryUpgradeable, implAddress) }, [OPS]: { nonce: toHex(s.nonce) } }
      : undefined;
    const quote = await creationQuote(s.data, s.nonce, override);
    const gas = quote.gas * 120n / 100n;
    assert.ok(quote.runtime && keccak256(quote.runtime) === keccak256(expectedRuntime(artifact, s.address)), 'Creation simulation runtime mismatch');
    estimates.push({ name: s.name, nonce: s.nonce, address: s.address, gas, gasPrice, feeWei: gas * gasPrice });
  }
  const totalFeeWei = estimates.reduce((a, e) => a + e.feeWei, 0n);
  assert.ok(totalFeeWei <= CAP, 'Deployment fee exceeds 1 tBOT cap');
  const balance = await client.getBalance({ address: OPS });
  const plan = {
    mode, chainId: CHAIN_ID, rpc: RPC, owner: OPS, nonce, gasPrice, balance,
    sufficientBalance: balance >= totalFeeWei, capWei: CAP, totalFeeWei,
    contracts: { IdentityRegistryUpgradeable: steps[0].address, ERC1967Proxy: steps[1].address, registry: steps[1].address },
    registerSelectors: REGISTER_SELECTORS, sourceHashes: bundle.hashes, compiler: bundle.compiler,
    steps: estimates,
  };
  if (mode === 'dry-run') { console.log(json(plan)); return; }

  // ---- send path (requires explicit --send and a signer in the process environment) ----
  const key = process.env.BOTCHAIN_TESTNET_OPS_PRIVATE_KEY as Hex;
  assert.ok(/^0x[0-9a-fA-F]{64}$/.test(key ?? ''), 'Missing BOTCHAIN_TESTNET_OPS_PRIVATE_KEY');
  const account = privateKeyToAccount(key);
  assert.ok(same(account.address, OPS), 'Signer does not match the ops deployer');
  assert.ok(balance >= totalFeeWei, 'Insufficient tBOT for deployment');
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const lock = acquireProcessLock(`${DIR}/deploy.lock`);
  try {
    const wallet = createWalletClient({ chain, account, transport: http(RPC) });
    const receipts = [];
    for (const s of steps) {
      stage = `${s.name}:journal`;
      const path = `${DIR}/signed-${s.nonce}.json`;
      let journal: { hash: Hex; raw: TransactionSerialized } | undefined = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
      if (!journal) {
        stage = `${s.name}:fresh-preflight`;
        assert.equal(await client.getTransactionCount({ address: OPS, blockTag: 'latest' }), s.nonce, 'Nonce changed');
        assert.equal(await client.getTransactionCount({ address: OPS, blockTag: 'pending' }), s.nonce, 'Pending transaction');
        assert.ok(!await client.getCode({ address: s.address }), 'Target already deployed');
        const freshPrice = await client.getGasPrice();
        assert.ok(freshPrice > 0n, 'Invalid fresh gas quote');
        const gas = await client.estimateGas({ account: OPS, data: s.data, value: 0n }) * 120n / 100n;
        assert.ok(gas * freshPrice <= CAP, 'Fresh gas quote exceeds cap');
        assert.ok(await client.getBalance({ address: OPS }) >= gas * freshPrice, 'Insufficient tBOT for this transaction');
        if (!s.to) {
          const simulated = await client.call({ account: OPS, data: s.data, gas, value: 0n });
          assert.ok(simulated.data && keccak256(simulated.data) === keccak256(expectedRuntime(s.name === 'IdentityRegistryUpgradeable' ? bundle.artifacts.IdentityRegistryUpgradeable : bundle.artifacts.ERC1967Proxy, s.address)), 'Final runtime mismatch');
        }
        stage = `${s.name}:sign-and-persist`;
        const raw = await wallet.signTransaction({ type: 'legacy', chainId: CHAIN_ID, nonce: s.nonce, to: s.to, data: s.data, value: 0n, gas, gasPrice: freshPrice });
        journal = { raw, hash: keccak256(raw) };
        durable(path, journal); // Persist before any broadcast. Never create a second nonce.
      }
      stage = `${s.name}:validate-and-broadcast`;
      assert.equal(keccak256(journal.raw), journal.hash);
      const tx = parseTransaction(journal.raw);
      assert.equal(tx.chainId, CHAIN_ID); assert.equal(tx.nonce, s.nonce); assert.equal(tx.data, s.data); assert.equal(tx.value ?? 0n, 0n);
      assert.ok(s.to ? same(tx.to ?? '', s.to) : !tx.to);
      assert.ok(tx.gasPrice && tx.gasPrice > 0n && (tx.gas ?? 0n) * tx.gasPrice <= CAP);
      assert.ok(same(await recoverTransactionAddress({ serializedTransaction: journal.raw }), OPS));
      let receipt = await client.getTransactionReceipt({ hash: journal.hash }).catch((error) => {
        if (error.name === 'TransactionReceiptNotFoundError') return undefined;
        throw error;
      });
      if (!receipt) {
        try { assert.equal(await client.sendRawTransaction({ serializedTransaction: journal.raw }), journal.hash); }
        catch { if (!await client.getTransaction({ hash: journal.hash }).catch(() => undefined)) throw Error('Broadcast uncertain; preserve journal'); }
        console.log(json({ status: 'broadcast', name: s.name, hash: journal.hash, address: s.address }));
        receipt = await client.waitForTransactionReceipt({ hash: journal.hash, timeout: 120_000, confirmations: 2, pollingInterval: 2000 });
      }
      stage = `${s.name}:receipt`;
      assert.equal(receipt.status, 'success', 'Transaction failed');
      assert.ok(same(receipt.from, OPS));
      if (!s.to) {
        assert.ok(receipt.contractAddress && same(receipt.contractAddress, s.address), 'Unexpected contract address');
        const artifact = s.name === 'IdentityRegistryUpgradeable' ? bundle.artifacts.IdentityRegistryUpgradeable : bundle.artifacts.ERC1967Proxy;
        assert.ok(same(await client.getCode({ address: s.address }) ?? '', expectedRuntime(artifact, s.address)), 'Deployed runtime mismatch');
      }
      receipts.push({ name: s.name, address: s.address, nonce: s.nonce, hash: journal.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice, feeWei: receipt.gasUsed * receipt.effectiveGasPrice });
    }
    stage = 'readback';
    const impl = steps[0].address, registry = steps[1].address;
    const read = (functionName: string, args: unknown[] = []) => client.readContract({ address: registry, abi: bundle.artifacts.IdentityRegistryUpgradeable.abi, functionName, args });
    assert.ok(same(await read('owner') as string, OPS), 'Wrong owner');
    assert.equal(await read('getVersion'), '2.0.0', 'Wrong registry version');
    const slot = await client.getStorageAt({ address: registry, slot: IMPLEMENTATION_SLOT });
    assert.ok(slot && same(`0x${slot.slice(-40)}`, impl), 'Wrong ERC1967 implementation slot');
    const probe = '0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada' as const;
    const registerData = encodeFunctionData({ abi: bundle.artifacts.IdentityRegistryUpgradeable.abi, functionName: 'register', args: ['ipfs://erc8004-botchain-probe'] });
    assert.equal(registerData.slice(0, 10), REGISTER_SELECTORS['register(string)'], 'register(string) selector drift');
    const registered = await client.call({ account: probe, to: registry, data: registerData });
    assert.ok(registered.data !== '0x', 'register(string) simulation failed');
    const evidence = {
      result: 'DEPLOYED', checkedAt: new Date().toISOString(), chainId: CHAIN_ID, rpc: RPC, owner: OPS,
      implementation: impl, proxy: registry, registry,
      getVersion: await read('getVersion'), implementationSlot: impl, registerSelectorSimulated: true,
      transactions: receipts, totalFeeWei: receipts.reduce((a, r) => a + r.feeWei, 0n),
      ownerBalanceWei: await client.getBalance({ address: OPS }),
      sourceHashes: bundle.hashes, compiler: bundle.compiler,
    };
    mkdirSync(resolve(import.meta.dir, '../docs/evidence'), { recursive: true });
    durable(resolve(import.meta.dir, `../docs/evidence/erc8004-botchain-testnet-${new Date().toISOString().slice(0, 10)}.json`), evidence);
    console.log(json(evidence));
  } finally { lock.release(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.includes('--send') ? 'send' : 'dry-run').catch(error => { console.error(json(failureReport(error))); process.exitCode = 1; });
}
