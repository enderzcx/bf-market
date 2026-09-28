import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, erc20Abi, encodeDeployData, keccak256, getContractAddress, zeroHash, toHex, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile } from './compile.ts';
import { acquireProcessLock } from '../src/lock.ts';

// One authorized deployment, no funding, role changes, unpause or payout calls.
export const OWNER = '0x28172e0d973fFf24651B6Ed4cA6d1007bc168C94' as const;
export const TOKEN = '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C' as const;
const RPC = 'https://rpc.botchain.ai';
const CHAIN = defineChain({ id: 677, name: 'BOT Chain', nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const MAX_FEE = 2n * 10n ** 16n; // 0.02 BOT upper bound, not a target spend.
const NONCE = 0;
export const ADDRESS = getContractAddress({ from: OWNER, nonce: BigInt(NONCE) });
const DIR = resolve(import.meta.dir, '../.local/botchain-deploy');
const PLAN = `${DIR}/plan.json`;
const JOURNAL = `${DIR}/signed.json`;
let stage = 'initialization';
export function selectGasPrice(quote: bigint, gas: bigint): bigint {
  assert.ok(quote > 0n && gas > 0n, 'Invalid gas quote');
  const ceiling = MAX_FEE / gas;
  assert.ok(quote <= ceiling, 'Fresh gas quote exceeds 0.02 BOT cap');
  const buffered = quote * 110n / 100n;
  return buffered < ceiling ? buffered : ceiling;
}
export function failureReport(error: unknown) {
  const e = error as {name?: string; message?: string; generatedMessage?: boolean};
  const reason = e?.name === 'AssertionError' && e.generatedMessage === false
    ? e.message
    : e?.message === 'Broadcast uncertain; preserve journal' ? e.message : 'RPC, validation or filesystem failure';
  return {status:'STOPPED', stage, reason, recovery:'Preserve .local/botchain-deploy; reconcile the same hash. Never create a new nonce.'};
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
function durable(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, json(value), { mode: 0o600 });
  const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(DIR, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function expectedRuntime(artifact: ReturnType<typeof compile>['Settlement']): Hex {
  let code = artifact.deployedBytecode.slice(2);
  // Settlement has exactly one immutable, the token address.
  assert.equal(Object.keys(artifact.immutableReferences).length, 1);
  for (const refs of Object.values(artifact.immutableReferences)) for (const { start, length } of refs) {
    assert.equal(length, 32);
    code = code.slice(0, start * 2) + TOKEN.slice(2).toLowerCase().padStart(64, '0') + code.slice((start + length) * 2);
  }
  return `0x${code}`;
}
export async function main(mode: string) {
  assert.ok(['prepare', 'send', 'verify'].includes(mode), 'Use prepare, send or verify');
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const lock = acquireProcessLock(`${DIR}/deploy.lock`);
  try {
    stage = 'compile-and-network-check';
    const client = createPublicClient({ chain: CHAIN, transport: http(RPC, { timeout: 20_000, retryCount: 1 }), cacheTime: 0 });
    const artifact = compile().Settlement;
    const data = encodeDeployData({ ...artifact, args: [TOKEN, OWNER, OWNER] });
    const dataHash = keccak256(data);
    const runtimeHash = keccak256(expectedRuntime(artifact));
    assert.equal(await client.getChainId(), 677, 'Wrong network');
    const tokenCode = await client.getCode({ address: TOKEN });
    assert.ok(tokenCode && tokenCode !== '0x', 'Missing USDT code');
    assert.equal(await client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'decimals' }), 6);
    let journal: { hash: Hex; raw: TransactionSerialized } | undefined = existsSync(JOURNAL) ? JSON.parse(readFileSync(JOURNAL, 'utf8')) : undefined;
    if (mode === 'prepare') {
      assert.ok(!journal, 'Signed deployment exists; use verify/send to reconcile');
      assert.ok(!await client.getCode({ address: ADDRESS }), 'Target already deployed');
      assert.equal(await client.getTransactionCount({ address: OWNER, blockTag: 'latest' }), NONCE, 'Owner nonce changed');
      assert.equal(await client.getTransactionCount({ address: OWNER, blockTag: 'pending' }), NONCE, 'Pending owner transaction');
      stage = 'prepare-simulation';
      const gasEstimate = await client.estimateGas({ account: OWNER, data, value: 0n });
      const gas = gasEstimate * 120n / 100n;
      const gasPrice = await client.getGasPrice();
      assert.ok(gas * gasPrice <= MAX_FEE, 'Deployment fee exceeds 0.02 BOT cap');
      assert.ok(await client.getBalance({ address: OWNER }) >= gas * gasPrice, 'Insufficient gas');
      const simulated = await client.call({ account: OWNER, data, gas, value: 0n });
      assert.ok(simulated.data && keccak256(simulated.data) === runtimeHash, 'Creation simulation runtime mismatch');
      const plan = { createdAt: new Date().toISOString(), chainId: 677, rpc: RPC, owner: OWNER, admin: OWNER, executor: OWNER, token: TOKEN, tokenCodeHash: keccak256(tokenCode), address: ADDRESS, nonce: NONCE, dataHash, runtimeHash, gasEstimate, gas, gasPrice, maximumCostWei: gas * gasPrice, capWei: MAX_FEE, startsPaused: true, fundingUSDT: '0' };
      durable(PLAN, plan);
      console.log(json(plan));
      return;
    }
    assert.ok(existsSync(PLAN), 'Run prepare first');
    const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
    assert.equal(plan.dataHash, dataHash, 'Source changed since preparation');
    assert.equal(plan.runtimeHash, runtimeHash);
    assert.equal(plan.tokenCodeHash, keccak256(tokenCode), 'USDT code changed');
    assert.equal(plan.nonce, NONCE);
    assert.ok(same(plan.address, ADDRESS));
    const gas = BigInt(plan.gas);
    let gasPrice = BigInt(plan.gasPrice);
    assert.ok(gas > 0n && gasPrice > 0n && gas * gasPrice <= MAX_FEE);
    if (mode === 'send' && !journal) {
      stage = 'unsigned-plan-and-nonce-check';
      assert.equal(process.env.BOT_DEPLOY_APPROVED_DATA_HASH, dataHash, 'Reviewed data hash required');
      assert.equal(await client.getTransactionCount({ address: OWNER, blockTag: 'latest' }), NONCE);
      assert.equal(await client.getTransactionCount({ address: OWNER, blockTag: 'pending' }), NONCE);
      assert.ok(!await client.getCode({ address: ADDRESS }), 'Target already deployed');
      stage = 'fresh-gas-quote';
      gasPrice = selectGasPrice(await client.getGasPrice(), gas);
      assert.ok(await client.getBalance({address:OWNER}) >= gas * gasPrice, 'Insufficient deployment gas');
      plan.gasPrice = gasPrice.toString();
      plan.maximumCostWei = (gas * gasPrice).toString();
      plan.quotedAt = new Date().toISOString();
      durable(PLAN, plan);
      stage = 'signer-check';
      const key = process.env.BOT_DEPLOY_PRIVATE_KEY as Hex;
      assert.ok(/^0x[0-9a-fA-F]{64}$/.test(key ?? ''), 'Missing signer');
      const account = privateKeyToAccount(key);
      assert.ok(same(account.address, OWNER), 'Wrong signer');
      stage = 'final-creation-simulation';
      const simulated = await client.call({ account: OWNER, data, gas, value: 0n });
      assert.ok(simulated.data && keccak256(simulated.data) === runtimeHash, 'Final runtime mismatch');
      const wallet = createWalletClient({ chain: CHAIN, account, transport: http(RPC) });
      stage = 'sign-and-persist';
      const raw = await wallet.signTransaction({ type: 'legacy', chainId: 677, nonce: NONCE, data, value: 0n, gas, gasPrice });
      journal = { raw, hash: keccak256(raw) };
      durable(JOURNAL, journal); // Persist before any broadcast. Never create a second nonce.
    }
    stage = 'signed-transaction-validation';
    assert.ok(journal, 'No signed deployment to verify');
    assert.equal(keccak256(journal.raw), journal.hash);
    const tx = parseTransaction(journal.raw);
    assert.equal(tx.chainId, 677); assert.equal(tx.nonce, NONCE);
    assert.ok(!tx.to); assert.equal(tx.value ?? 0n, 0n); assert.equal(tx.data, data);
    assert.equal(tx.gas, gas); assert.equal(tx.gasPrice, gasPrice);
    assert.ok(same(await recoverTransactionAddress({ serializedTransaction: journal.raw }), OWNER));
    stage = 'receipt-lookup';
    let receipt = await client.getTransactionReceipt({ hash: journal.hash }).catch((error) => {
      if (error.name === 'TransactionReceiptNotFoundError') return undefined;
      throw error;
    });
    if (!receipt && mode === 'send') {
      assert.equal(process.env.BOT_DEPLOY_APPROVED_DATA_HASH, dataHash);
      stage = 'broadcast-same-transaction';
      // On resume only rebroadcast the identical signed creation transaction.
      try { assert.equal(await client.sendRawTransaction({ serializedTransaction: journal.raw }), journal.hash); }
      catch { if (!await client.getTransaction({ hash: journal.hash }).catch(() => undefined)) throw Error('Broadcast uncertain; preserve journal'); }
      console.log(json({ status: 'broadcast', hash: journal.hash, address: ADDRESS }));
      stage = 'wait-for-confirmations';
      receipt = await client.waitForTransactionReceipt({ hash: journal.hash, timeout: 120_000, confirmations: 2, pollingInterval: 2000 });
    }
    stage = 'deployed-state-verification';
    assert.ok(receipt, 'Receipt pending; do not create a new deployment');
    assert.equal(receipt.status, 'success'); assert.ok(receipt.contractAddress && same(receipt.contractAddress, ADDRESS));
    assert.ok(same(receipt.from, OWNER));
    const code = await client.getCode({ address: ADDRESS });
    assert.ok(code && keccak256(code) === runtimeHash, 'Deployed runtime mismatch');
    const read = (functionName: string, args: unknown[] = []) => client.readContract({ address: ADDRESS, abi: artifact.abi, functionName, args });
    assert.ok(same(await read('token') as string, TOKEN));
    assert.equal(await read('paused'), true);
    assert.equal(await read('hasRole', [zeroHash, OWNER]), true);
    assert.equal(await read('hasRole', [keccak256(toHex('EXECUTOR_ROLE')), OWNER]), true);
    const balance = await client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESS] });
    assert.equal(balance, 0n, 'Unexpected funding; leave paused');
    const evidence = { result: 'DEPLOYED_PAUSED_UNFUNDED', checkedAt: new Date().toISOString(), chainId: 677, contract: ADDRESS, transactionHash: journal.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, actualFeeWei: receipt.gasUsed * receipt.effectiveGasPrice, token: TOKEN, owner: OWNER, admin: OWNER, executor: OWNER, paused: true, tokenBalance: balance, runtimeHash, dataHash, automaticPayoutsEnabled: false, finalized: false };
    durable(`${DIR}/verified.json`, evidence);
    console.log(json(evidence));
  } finally { lock.release(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? 'prepare').catch(error => { console.error(json(failureReport(error))); process.exitCode = 1; });
}
