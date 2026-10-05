import { test } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, parseEventLogs, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileErc8004, deploymentSteps } from '../scripts/erc8004-artifacts.ts';
import { LOCAL_KEY, OTHER_KEY } from '../scripts/local-chain.ts';

const bundle = compileErc8004();
const abi = bundle.artifacts.IdentityRegistryUpgradeable.abi;
type RegisteredEvent = { args: { agentId: bigint; agentURI: string; owner: string } };
const registered = (logs: any[]) => parseEventLogs({ abi, eventName: 'Registered', logs }) as unknown as RegisteredEvent[];

test('ERC-8004 IdentityRegistry implementation + ERC1967Proxy behaviour', async () => {
  const server = ganache.server({ chain: { chainId: 968, hardfork: 'shanghai' }, wallet: { accounts: [LOCAL_KEY, OTHER_KEY].map(secretKey => ({ secretKey, balance: '0x3635c9adc5dea00000' })) }, logging: { quiet: true } });
  await server.listen(0, '127.0.0.1');
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const chain = defineChain({ id: 968, name: 'local only', nativeCurrency: { name: 'Test', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
    const client = createPublicClient({ chain, transport: http(url), cacheTime: 0 });
    const deployer = privateKeyToAccount(LOCAL_KEY);
    const outsider = privateKeyToAccount(OTHER_KEY);
    const owner = createWalletClient({ chain, account: deployer, transport: http(url) });
    const other = createWalletClient({ chain, account: outsider, transport: http(url) });
    const steps = deploymentSteps(bundle, deployer.address);
    const [impl, proxy] = [steps[0].address, steps[1].address];
    for (const s of steps) {
      const gas = await client.estimateGas({ account: deployer.address, data: s.data, value: 0n }) * 120n / 100n;
      const receipt = await client.waitForTransactionReceipt({ hash: await owner.sendTransaction({ to: s.to, data: s.data, nonce: s.nonce, value: 0n, gas }) });
      assert.equal(receipt.status, 'success');
      assert.equal(receipt.contractAddress?.toLowerCase(), s.address.toLowerCase());
      assert.ok(await client.getCode({ address: s.address }));
    }

    const read = (functionName: string, args: unknown[] = []) => client.readContract({ address: proxy, abi, functionName, args });
    const write = async (wallet: typeof owner, functionName: string, args: unknown[] = []) => {
      const gas = await client.estimateContractGas({ address: proxy, abi, functionName, args, account: wallet.account }) * 120n / 100n;
      return client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: proxy, abi, functionName, args, gas }) });
    };

    // Owner is the deployer; version and selectors match the agreed interface.
    assert.equal((await read('owner') as string).toLowerCase(), deployer.address.toLowerCase());
    assert.equal(await read('getVersion'), '2.0.0');
    assert.equal(encodeFunctionData({ abi, functionName: 'register', args: [] }).slice(0, 10), '0x1aa3a008');
    assert.equal(encodeFunctionData({ abi, functionName: 'register', args: ['ipfs://x'] }).slice(0, 10), '0xf2c298be');
    assert.equal(encodeFunctionData({ abi, functionName: 'register', args: ['ipfs://x', []] }).slice(0, 10), '0x8ea42286');

    // initialize is single-use on the proxy, and disabled on the implementation itself.
    await assert.rejects(() => write(owner, 'initialize', [deployer.address]));
    const implInit = encodeFunctionData({ abi, functionName: 'initialize', args: [deployer.address] });
    await assert.rejects(() => client.call({ account: deployer.address, to: impl, data: implInit }));

    // Only the owner may upgrade.
    await assert.rejects(() => write(other, 'upgradeToAndCall', [impl, '0x']));

    // Any address can register; agentId increments and the Registered event is exact.
    const uri = 'ipfs://agent-one';
    const first = await write(other, 'register', [uri]);
    const firstEvents = registered(first.logs);
    assert.equal(firstEvents.length, 1);
    const id0 = firstEvents[0].args.agentId;
    assert.equal(id0, 0n);
    assert.equal(firstEvents[0].args.agentURI, uri);
    assert.equal(firstEvents[0].args.owner.toLowerCase(), outsider.address.toLowerCase());
    assert.equal((await read('ownerOf', [id0]) as string).toLowerCase(), outsider.address.toLowerCase());

    const second = await write(other, 'register', []);
    const id1 = registered(second.logs)[0].args.agentId;
    assert.equal(id1, id0 + 1n);

    // register(string,MetadataEntry[]) accepts non-reserved metadata.
    const third = await write(other, 'register', ['ipfs://agent-three', [{ metadataKey: 'service', metadataValue: '0x1234' }]]);
    const id2 = registered(third.logs)[0].args.agentId;
    assert.equal(id2, id1 + 1n);
    assert.equal(await read('getMetadata', [id2, 'service']), '0x1234');

    // setAgentURI is restricted to the NFT holder or an approved operator.
    await assert.rejects(() => write(owner, 'setAgentURI', [id2, 'ipfs://hijack']));
    await write(other, 'setAgentURI', [id2, 'ipfs://agent-three-updated']);
    assert.equal(await read('tokenURI', [id2]), 'ipfs://agent-three-updated');
    await write(other, 'approve', [deployer.address, id2]);
    await write(owner, 'setAgentURI', [id2, 'ipfs://approved-update']);
    assert.equal(await read('tokenURI', [id2]), 'ipfs://approved-update');
  } finally { await server.close(); }
});

test('ERC-8004 registry deployment is deterministic for the ops deployer', () => {
  const ops = '0x2547c1122c9aFD11eA0c4b66bb033552b90B979F' as Hex;
  const steps = deploymentSteps(bundle, ops);
  assert.equal(steps[0].nonce, 0);
  assert.equal(steps[1].nonce, 1);
  assert.equal(steps[0].address, '0x15dE9915949D8E326FF2abeC186D7036987786A1');
  assert.equal(steps[1].address, '0xe35a670Ec84477b54f976Ddfa5f8E4601FfC8607');
  assert.equal(steps[0].data.slice(0, 2), '0x');
  assert.ok(steps[1].data.length > 2);
});
