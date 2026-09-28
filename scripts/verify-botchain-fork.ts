import assert from 'node:assert/strict';
import ganache from 'ganache';
import {createPublicClient,createWalletClient,http,defineChain,erc20Abi,keccak256,toHex,encodeAbiParameters} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {compile} from './compile.ts';
import {TOKEN} from './deploy-botchain.ts';
import {writeFileSync} from 'node:fs';
const key=`0x${'1'.padStart(64,'0')}` as const;
const recipient=privateKeyToAccount(`0x${'2'.padStart(64,'0')}`).address;
const remote=createPublicClient({transport:http('https://rpc.botchain.ai',{timeout:20000})});
const block=await remote.getBlockNumber();
const reads = new Set(['eth_blockNumber','eth_chainId','net_version','eth_getBlockByNumber','eth_getBlockByHash','eth_getBalance','eth_getCode','eth_getTransactionCount','eth_getStorageAt','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_getProof']);
const forkProvider = {request:({method,params}:any)=>{assert.ok(reads.has(method), `Fork upstream method denied: ${method}`);return remote.request({method,params} as any);}};
const server=ganache.server({fork:{provider:forkProvider,blockNumber:Number(block)},chain:{chainId:677,hardfork:'shanghai'},wallet:{accounts:[{secretKey:key,balance:'0x3635c9adc5dea00000'}]},logging:{quiet:true}});
await server.listen(0,'127.0.0.1');
try{
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const chain=defineChain({id:677,name:'LOCAL fork only',nativeCurrency:{name:'TEST',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[url]}}});
 const client=createPublicClient({chain,transport:http(url,{timeout:60000}),cacheTime:0});
 const wallet=createWalletClient({chain,account:privateKeyToAccount(key),transport:http(url,{timeout:60000})});
 const artifact=compile().Settlement;
 const receipt=await client.waitForTransactionReceipt({hash:await wallet.deployContract({...artifact,args:[TOKEN,wallet.account.address,wallet.account.address]})});
 assert.equal(receipt.status,'success'); const contract=receipt.contractAddress!;
 const call=(functionName:string,args:any[]=[])=>client.readContract({address:contract,abi:artifact.abi,functionName,args});
 const write=async(functionName:string,args:any[]=[])=>client.waitForTransactionReceipt({hash:await wallet.writeContract({address:contract,abi:artifact.abi,functionName,args})});
 assert.equal(await call('paused'),true);
 const balance=(a:`0x${string}`)=>client.readContract({address:TOKEN,abi:erc20Abi,functionName:'balanceOf',args:[a]});
 // Inject balance into LOCAL fork storage only; no real token funding or transfer.
 let found=-1;
 for(let slot=0;slot<20;slot++){
  const location=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[contract,BigInt(slot)]));
  const previous=await client.getStorageAt({address:TOKEN,slot:location});
  await server.provider.request({method:'evm_setAccountStorageAt',params:[TOKEN,location,toHex(40_000_000n,{size:32})]} as any);
  if(await balance(contract)===40_000_000n){found=slot;break;}
  await server.provider.request({method:'evm_setAccountStorageAt',params:[TOKEN,location,previous??toHex(0n,{size:32})]} as any);
 }
 assert.ok(found>=0,'Could not inject local token balance');
 const before=await balance(recipient), id=keccak256(toHex('LOCAL-FORK-ONLY'));
 await assert.rejects(()=>write('pay',[id,recipient,20_000_000n]));
 await write('unpause');
 assert.equal((await write('pay',[id,recipient,20_000_000n])).status,'success');
 assert.equal(await balance(recipient)-before,20_000_000n);
 await assert.rejects(()=>write('pay',[id,recipient,20_000_000n]));
 const insufficient=keccak256(toHex('LOCAL-FORK-INSUFFICIENT'));
 await assert.rejects(()=>write('pay',[insufficient,recipient,30_000_000n]));
 assert.equal(await call('paid',[insufficient]),false);
 await write('pause');
 assert.equal(await call('paused'),true);
 const result={result:'PASS',kind:'LOCAL_FORK_NOT_MAINNET_PAYMENT',checkedAt:new Date().toISOString(),forkBlock:block.toString(),chainId:677,token:TOKEN,tokenCodeHash:keccak256((await client.getCode({address:TOKEN}))!),stateInjection:'40 USDT injected in local fork balance mapping only',balanceSlot:found,checks:['mainnet USDT code SafeERC20 transfer','paused by default','local 20 USDT transfer','duplicate denied','insufficient balance does not consume ID','pause'],realMainnetWrites:0};
 writeFileSync(new URL('../.local/botchain-fork-verification.json', import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await server.close();}
