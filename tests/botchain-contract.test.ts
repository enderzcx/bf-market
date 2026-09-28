import { test } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, defineChain, http, erc20Abi, keccak256, toHex, encodeAbiParameters, zeroHash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile } from '../scripts/compile.ts';
import { LOCAL_KEY, OTHER_KEY } from '../scripts/local-chain.ts';
import { TOKEN, expectedRuntime, selectGasPrice, failureReport } from '../scripts/deploy-botchain.ts';
const artifacts = compile();
const testToken = '0x75edC9335175Fc0552D51D48439F229c10420fe3' as const;

for (const chainId of [677, 968, 999]) test(`BOT deployment constraints and payout invariants, chain ${chainId}`, async () => {
  const server = ganache.server({ chain: { chainId, hardfork: 'shanghai' }, wallet: { accounts: [LOCAL_KEY, OTHER_KEY].map(secretKey => ({ secretKey, balance: '0x3635c9adc5dea00000' })) }, logging: { quiet: true } });
  await server.listen(0, '127.0.0.1');
  try {
    const rpcUrl = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const chain = defineChain({ id: chainId, name: 'Local BOT simulation', nativeCurrency: { name: 'Test', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
    const account = privateKeyToAccount(LOCAL_KEY), other = privateKeyToAccount(OTHER_KEY);
    const client = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });
    const wallet = createWalletClient({ chain, account, transport: http(rpcUrl) });
    const outsider = createWalletClient({ chain, account: other, transport: http(rpcUrl) });
    const rpc = (method: string, params: any[]) => server.provider.request({ method, params } as any);
    const token = chainId === 968 ? testToken : TOKEN;
    await rpc('evm_setAccountCode', [token, artifacts.TestUSDC.deployedBytecode]);
    const deploy = (tokenAddress: `0x${string}` = token) => wallet.deployContract({ ...artifacts.Settlement, args: [tokenAddress, account.address, account.address] });
    if (chainId === 999) { await assert.rejects(deploy, /unsupported chain/); return; }
    await assert.rejects(() => deploy(other.address));
    // Code exists at a wrong asset address, but is still rejected.
    await rpc('evm_setAccountCode', [other.address, artifacts.TestUSDC.deployedBytecode]);
    await assert.rejects(() => deploy(other.address), /USDT only/);
    await rpc('evm_setAccountCode', [other.address, '0x']);
    await rpc('evm_setAccountCode', [token, '0x601260005260206000f3']); // decimals() => 18
    await assert.rejects(deploy, /6 decimals required/);
    await rpc('evm_setAccountCode', [token, artifacts.TestUSDC.deployedBytecode]);
    const receipt = await client.waitForTransactionReceipt({ hash: await deploy() });
    assert.equal(receipt.status, 'success');
    const contract = receipt.contractAddress!;
    const read = (functionName:string, args:any[] = []) => client.readContract({ address: contract, abi: artifacts.Settlement.abi, functionName, args });
    const write = async (functionName:string, args:any[] = []) => client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: contract, abi: artifacts.Settlement.abi, functionName, args }) });
    assert.equal(await read('paused'), true);
    assert.equal(await read('hasRole', [zeroHash, account.address]), true);
    if (chainId === 677) assert.equal((await client.getCode({address:contract}))?.toLowerCase(), expectedRuntime(artifacts.Settlement));
    const id = keccak256(toHex('order-1'));
    const pay = (payoutId = id, recipient = other.address, amount = 20_000_000n) => write('pay', [payoutId, recipient, amount]);
    await assert.rejects(pay); // starts paused even when caller is executor
    await assert.rejects(() => outsider.writeContract({ address: contract, abi: artifacts.Settlement.abi, functionName: 'unpause' }));
    await write('unpause');
    await assert.rejects(pay); // no funds; does not consume payout ID
    assert.equal(await read('paid', [id]), false);
    // Local-only mock token balance injection. No calls to a public network.
    const balanceSlot = keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}], [contract, 0n]));
    await rpc('evm_setAccountStorageAt', [token, balanceSlot, toHex(100_000_000n, {size:32})]);
    await assert.rejects(() => outsider.writeContract({ address: contract, abi: artifacts.Settlement.abi, functionName:'pay', args:[id,other.address,20_000_000n] }));
    await pay();
    assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[other.address]}),20_000_000n);
    assert.equal(await read('paid', [id]), true);
    await assert.rejects(() => pay(id, account.address, 1n));
    await write('pause');
    await assert.rejects(() => pay(keccak256(toHex('order-2'))));
    const role = keccak256(toHex('EXECUTOR_ROLE'));
    await write('revokeRole', [role, account.address]);
    await write('unpause');
    await assert.rejects(() => pay(keccak256(toHex('order-2'))));
    assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[other.address]}),20_000_000n);
  } finally { await server.close(); }
});

// Deployment fee changes stay inside the authorized cap; diagnostics never dump RPC bodies.
test('deployment gas quote and safe failure diagnostics', () => {
  const gas = 819_472n;
  assert.equal(selectGasPrice(20_000_000_000n, gas), 22_000_000_000n);
  assert.ok(selectGasPrice(24_000_000_000n, gas) * gas <= 20_000_000_000_000_000n);
  assert.throws(() => selectGasPrice(25_000_000_000n, gas), /cap/);
  assert.throws(() => selectGasPrice(0n, gas), /Invalid/);
  let failure: unknown;
  try { assert.ok(false, 'Wrong signer'); } catch (e) { failure = e; }
  assert.equal(failureReport(failure).reason, 'Wrong signer');
  assert.equal(failureReport(new Error('RPC body contains private material')).reason, 'RPC, validation or filesystem failure');
});
