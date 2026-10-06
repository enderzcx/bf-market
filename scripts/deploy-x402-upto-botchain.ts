import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { acquireProcessLock } from '../src/lock.ts';
import { CREATE2_DEPLOYER, PERMIT2, PERMIT2_SELECTOR, UPTO_PROXY, deploymentData, loadArtifact } from './x402-upto-artifacts.ts';

// x402UptoPermit2Proxy for BOT Chain testnet 968: one CREATE2 transaction to Arachnid's
// deterministic deployer (salt ++ initCode as calldata). The default run is read-only: artifact
// validation plus eth_estimateGas/eth_gasPrice/eth_call. Nothing is signed or broadcast unless
// --send is passed and BOTCHAIN_TESTNET_OPS_PRIVATE_KEY is present in the environment.
export const OPS = '0x2547c1122c9aFD11eA0c4b66bb033552b90B979F' as const;
const RPC = 'https://rpc.bohr.life';
const CHAIN_ID = 968;
const CAP = 1n * 10n ** 17n; // 0.1 tBOT upper bound for the single deployment transaction, not a target spend.
const chain = defineChain({ id: CHAIN_ID, name: 'BOT Chain Testnet', nativeCurrency: { name: 'tBOT', symbol: 'tBOT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const DIR = resolve(import.meta.dir, '../.local/x402-upto-botchain');
let stage = 'initialization';

const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function failureReport(error: unknown) {
  const e = error as { name?: string; message?: string; generatedMessage?: boolean };
  const reason = e?.name === 'AssertionError' && e.generatedMessage === false
    ? e.message
    : e?.message === 'Broadcast uncertain; preserve journal' ? e.message : 'RPC, validation or filesystem failure';
  return { status: 'STOPPED', stage, reason, recovery: 'Preserve .local/x402-upto-botchain; reconcile the same hash. Never create a new nonce.' };
}

function durable(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, json(value), { mode: 0o600 });
  const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}

async function rawRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

export async function main(mode: string) {
  assert.ok(['dry-run', 'send'].includes(mode), 'Use dry-run (default) or send');
  stage = 'artifact';
  const artifact = loadArtifact();
  const data = deploymentData(artifact);
  const client = createPublicClient({ chain, transport: http(RPC, { timeout: 20_000, retryCount: 1 }), cacheTime: 0 });
  stage = 'network-check';
  assert.equal(await client.getChainId(), CHAIN_ID, 'Wrong network; expected BOT Chain testnet 968');
  const targetCode = await client.getCode({ address: UPTO_PROXY });
  assert.ok(!targetCode || targetCode === '0x', 'Target already deployed');
  const permit2Code = await client.getCode({ address: PERMIT2 });
  assert.ok(permit2Code && permit2Code !== '0x', 'Permit2 missing on this network');
  const deployerCode = await client.getCode({ address: CREATE2_DEPLOYER });
  assert.ok(deployerCode && deployerCode !== '0x', 'CREATE2 deployer missing on this network');
  stage = 'estimate-and-simulate';
  const nonce = await client.getTransactionCount({ address: OPS, blockTag: 'latest' });
  const gasPrice = await client.getGasPrice();
  assert.ok(gasPrice > 0n, 'Invalid gas quote');
  const gas = await client.estimateGas({ account: OPS, to: CREATE2_DEPLOYER, data, value: 0n }) * 120n / 100n;
  const feeWei = gas * gasPrice;
  assert.ok(feeWei <= CAP, 'Deployment fee exceeds the 0.1 tBOT cap');
  const balance = await client.getBalance({ address: OPS });
  // The deployer returns the address it created, so the simulation already proves where the
  // CREATE2 lands; the state override then executes the expected runtime at that address.
  const simulated = await client.call({ account: OPS, to: CREATE2_DEPLOYER, data, value: 0n, gas });
  assert.ok(simulated.data && same(simulated.data, UPTO_PROXY), 'Creation simulation landed on an unexpected address');
  const probed = await rawRpc<Hex>('eth_call', [{ from: OPS, to: UPTO_PROXY, data: PERMIT2_SELECTOR }, 'latest', { [UPTO_PROXY]: { code: artifact.runtime } }]);
  assert.ok(same(`0x${probed.slice(-40)}`, PERMIT2), 'Expected runtime does not expose the canonical Permit2');
  const plan = {
    mode, chainId: CHAIN_ID, rpc: RPC, ops: OPS, nonce, gasPrice, balance, capWei: CAP, gas, feeWei,
    sufficientBalance: balance >= feeWei, target: UPTO_PROXY, targetCodeEmpty: true,
    permit2: PERMIT2, permit2CodeHash: keccak256(permit2Code), permit2Selector: PERMIT2_SELECTOR, permit2FromRuntime: `0x${probed.slice(-40)}`,
    create2Deployer: CREATE2_DEPLOYER, create2DeployerCodeHash: keccak256(deployerCode),
    initCodeHash: artifact.initCodeHash, initCodeBytes: (artifact.initCode.length - 2) / 2, runtimeKeccak: artifact.runtimeKeccak,
    permit2Immutable: artifact.permit2Immutable, simulatedAddress: simulated.data,
    compiler: artifact.compiler.solc, openzeppelinContracts: artifact.compiler.openzeppelinContracts,
    sourceHashes: artifact.compiler.sources,
  };
  if (mode === 'dry-run') { console.log(json(plan)); return; }

  // ---- send path (requires explicit --send and a signer in the process environment) ----
  const key = process.env.BOTCHAIN_TESTNET_OPS_PRIVATE_KEY as Hex;
  assert.ok(/^0x[0-9a-fA-F]{64}$/.test(key ?? ''), 'Missing BOTCHAIN_TESTNET_OPS_PRIVATE_KEY');
  const account = privateKeyToAccount(key);
  assert.ok(same(account.address, OPS), 'Signer does not match the ops deployer');
  assert.ok(balance >= feeWei, 'Insufficient tBOT for deployment');
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const wallet = createWalletClient({ chain, account, transport: http(RPC) });
  const lock = acquireProcessLock(`${DIR}/deploy.lock`);
  try {
    stage = 'journal';
    const path = `${DIR}/signed-${nonce}.json`;
    let journal: { hash: Hex; raw: TransactionSerialized } | undefined = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    if (!journal) {
      stage = 'fresh-preflight';
      assert.equal(await client.getTransactionCount({ address: OPS, blockTag: 'latest' }), nonce, 'Nonce changed');
      assert.equal(await client.getTransactionCount({ address: OPS, blockTag: 'pending' }), nonce, 'Pending transaction');
      assert.ok(!await client.getCode({ address: UPTO_PROXY }), 'Target already deployed');
      const freshPrice = await client.getGasPrice();
      assert.ok(freshPrice > 0n, 'Invalid fresh gas quote');
      const freshGas = await client.estimateGas({ account: OPS, to: CREATE2_DEPLOYER, data, value: 0n }) * 120n / 100n;
      assert.ok(freshGas * freshPrice <= CAP, 'Fresh gas quote exceeds cap');
      assert.ok(await client.getBalance({ address: OPS }) >= freshGas * freshPrice, 'Insufficient tBOT for this transaction');
      const freshSim = await client.call({ account: OPS, to: CREATE2_DEPLOYER, data, value: 0n, gas: freshGas });
      assert.ok(freshSim.data && same(freshSim.data, UPTO_PROXY), 'Final creation simulation mismatch');
      stage = 'sign-and-persist';
      const raw = await wallet.signTransaction({ type: 'legacy', chainId: CHAIN_ID, nonce, to: CREATE2_DEPLOYER, data, value: 0n, gas: freshGas, gasPrice: freshPrice });
      journal = { raw, hash: keccak256(raw) };
      durable(path, journal); // Persist before any broadcast. Never create a second nonce.
    }
    stage = 'validate-and-broadcast';
    assert.equal(keccak256(journal.raw), journal.hash);
    const tx = parseTransaction(journal.raw);
    assert.equal(tx.chainId, CHAIN_ID); assert.equal(tx.nonce, nonce); assert.equal(tx.data?.toLowerCase(), data.toLowerCase()); assert.equal(tx.value ?? 0n, 0n);
    assert.ok(tx.to && same(tx.to, CREATE2_DEPLOYER));
    assert.ok(tx.gasPrice && tx.gasPrice > 0n && (tx.gas ?? 0n) * tx.gasPrice <= CAP);
    assert.ok(same(await recoverTransactionAddress({ serializedTransaction: journal.raw }), OPS));
    let receipt = await client.getTransactionReceipt({ hash: journal.hash }).catch((error) => {
      if (error.name === 'TransactionReceiptNotFoundError') return undefined;
      throw error;
    });
    if (!receipt) {
      try { assert.equal(await client.sendRawTransaction({ serializedTransaction: journal.raw }), journal.hash); }
      catch { if (!await client.getTransaction({ hash: journal.hash }).catch(() => undefined)) throw Error('Broadcast uncertain; preserve journal'); }
      console.log(json({ status: 'broadcast', hash: journal.hash, address: UPTO_PROXY }));
      receipt = await client.waitForTransactionReceipt({ hash: journal.hash, timeout: 120_000, confirmations: 2, pollingInterval: 2000 });
    }
    stage = 'receipt';
    assert.equal(receipt.status, 'success', 'Transaction failed');
    assert.ok(same(receipt.from, OPS));
    stage = 'readback';
    const code = await client.getCode({ address: UPTO_PROXY });
    assert.ok(code && keccak256(code) === artifact.runtimeKeccak, 'Deployed runtime mismatch');
    const immutable = PERMIT2.slice(2).toLowerCase().padStart(64, '0');
    for (const { start, length } of artifact.permit2Immutable) {
      assert.equal(code.slice(2 + start * 2, 2 + (start + length) * 2), immutable, 'Permit2 immutable mismatch');
    }
    const live = await rawRpc<Hex>('eth_call', [{ from: OPS, to: UPTO_PROXY, data: PERMIT2_SELECTOR }, 'latest']);
    assert.ok(same(`0x${live.slice(-40)}`, PERMIT2), 'Deployed Permit2 getter mismatch');
    const evidence = {
      result: 'DEPLOYED', checkedAt: new Date().toISOString(), chainId: CHAIN_ID, rpc: RPC, ops: OPS,
      target: UPTO_PROXY, initCodeHash: artifact.initCodeHash, runtimeKeccak: artifact.runtimeKeccak,
      deployedRuntimeKeccak: keccak256(code), permit2: PERMIT2, permit2FromRuntime: `0x${live.slice(-40)}`,
      permit2Immutable: artifact.permit2Immutable,
      transaction: { nonce, hash: journal.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice, feeWei: receipt.gasUsed * receipt.effectiveGasPrice },
      ownerBalanceWei: await client.getBalance({ address: OPS }),
      compiler: artifact.compiler.solc, openzeppelinContracts: artifact.compiler.openzeppelinContracts, sourceHashes: artifact.compiler.sources,
    };
    mkdirSync(resolve(import.meta.dir, '../docs/evidence'), { recursive: true });
    durable(resolve(import.meta.dir, `../docs/evidence/x402-upto-botchain-testnet-${new Date().toISOString().slice(0, 10)}.json`), evidence);
    console.log(json(evidence));
  } finally { lock.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.includes('--send') ? 'send' : 'dry-run').catch(error => { console.error(json(failureReport(error))); process.exitCode = 1; });
}
