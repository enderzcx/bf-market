import {test} from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import {createPublicClient,createWalletClient,defineChain,http,erc20Abi,keccak256,toHex,encodeAbiParameters} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {compileKtrace,deploymentSteps,addresses,OWNER,TOKEN,type Name} from '../scripts/ktrace-artifacts.ts';
import {compile} from '../scripts/compile.ts';
import {LOCAL_KEY,OTHER_KEY} from '../scripts/local-chain.ts';
const bundle=compileKtrace();
test('unchanged KTrace deployment graph, permissions, guarded job payment and replay rejection',async()=>{
 const server=ganache.server({chain:{chainId:677,hardfork:'shanghai'},wallet:{unlockedAccounts:[OWNER],accounts:[LOCAL_KEY,OTHER_KEY].map(secretKey=>({secretKey,balance:'0x3635c9adc5dea00000'}))},logging:{quiet:true}});
 await server.listen(0,'127.0.0.1');
 try{
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const chain=defineChain({id:677,name:'local only',nativeCurrency:{name:'Test',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[url]}}});
  const rpc=(method:string,params:any[])=>server.provider.request({method,params} as any);
  const client=createPublicClient({chain,transport:http(url),cacheTime:0});
  const owner=createWalletClient({chain,account:OWNER,transport:http(url)});
  const buyer=createWalletClient({chain,account:privateKeyToAccount(LOCAL_KEY),transport:http(url)});
  const seller=createWalletClient({chain,account:privateKeyToAccount(OTHER_KEY),transport:http(url)});
  await rpc('evm_setAccountBalance',[OWNER,'0x3635c9adc5dea00000']);await rpc('evm_setAccountNonce',[OWNER,'0x1']);
  await rpc('evm_setAccountCode',[TOKEN,compile().TestUSDC.deployedBytecode]);
  const done=async(hash:Promise<`0x${string}`>)=>{const r=await client.waitForTransactionReceipt({hash:await hash});assert.equal(r.status,'success');return r;};
  for(const s of deploymentSteps(bundle)){
   const r=await done(owner.sendTransaction({to:s.to,data:s.data,nonce:s.nonce,value:0n,gas:await client.estimateGas({account:OWNER,to:s.to,data:s.data})*120n/100n}));
   if(!s.to){assert.equal(r.contractAddress?.toLowerCase(),s.address.toLowerCase());assert.equal(await client.getCode({address:s.address}),s.runtime);}
  }
  const read=(n:Name,fn:string,args:any[]=[])=>client.readContract({address:addresses[n],abi:bundle.artifacts[n].abi,functionName:fn,args});
  const write=async(w:any,n:Name,fn:string,args:any[]=[])=>{const call={address:addresses[n],abi:bundle.artifacts[n].abi,functionName:fn,args};const gas=await client.estimateContractGas({...call,account:w.account})*120n/100n;return done(w.writeContract({...call,gas}));};
  assert.equal((await read('JobEscrowV4','traceAnchorGuard') as string).toLowerCase(),addresses.TraceAnchorGuard.toLowerCase());
  assert.equal((await read('JobEscrowV4','settlementToken') as string).toLowerCase(),TOKEN.toLowerCase());
  for(const n of ['IdentityRegistryV1','TrustPublicationAnchorV1','JobLifecycleAnchorV2','JobEscrowV4'] as Name[]){assert.equal((await read(n,'owner') as string).toLowerCase(),OWNER.toLowerCase());await assert.rejects(()=>write(buyer,n,'transferOwnership',[buyer.account.address]));}
  await write(buyer,'IdentityRegistryV1','register',['ipfs://local-test']);
  assert.equal(await read('IdentityRegistryV1','getAgentWallet',[1n]),buyer.account.address);
  const hash=keccak256(toHex('test'));
  const publication=['test','source','1',1n,'ref','trace',hash,'ipfs://local-test'];
  await assert.rejects(()=>write(seller,'TrustPublicationAnchorV1','publishTrustPublication',publication));
  await write(buyer,'TrustPublicationAnchorV1','publishTrustPublication',publication);
  const slot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[buyer.account.address,0n]));
  await rpc('evm_setAccountStorageAt',[TOKEN,slot,toHex(20000000n,{size:32})]);
  await done(buyer.writeContract({address:TOKEN,abi:erc20Abi,functionName:'approve',args:[addresses.JobEscrowV4,20000000n]}));
  const deadline=(await client.getBlock()).timestamp+3600n;
  const args=['local-job',buyer.account.address,seller.account.address,buyer.account.address,20000000n,deadline,0n];
  await write(buyer,'JobEscrowV4','lockFunds',args);await assert.rejects(()=>write(buyer,'JobEscrowV4','lockFunds',args));
  await assert.rejects(()=>write(buyer,'JobEscrowV4','acceptJob',['local-job']));
  await write(seller,'JobEscrowV4','acceptJob',['local-job']);
  await assert.rejects(()=>write(seller,'JobEscrowV4','submitResult',['local-job',hash]));
  const anchor=['submitted','local-job','trace','provider','capability','submitted','','','','',hash,'ipfs://test'];
  await assert.rejects(()=>write(buyer,'JobLifecycleAnchorV2','publishJobLifecycleAnchor',anchor));
  await write(owner,'JobLifecycleAnchorV2','publishJobLifecycleAnchor',anchor);
  await write(seller,'JobEscrowV4','submitResult',['local-job',hash]);
  await assert.rejects(()=>write(seller,'JobEscrowV4','validate',['local-job',true]));
  await write(buyer,'JobEscrowV4','validate',['local-job',true]);
  await assert.rejects(()=>write(buyer,'JobEscrowV4','validate',['local-job',true]));
  assert.equal(await client.readContract({address:TOKEN,abi:erc20Abi,functionName:'balanceOf',args:[seller.account.address]}),20000000n);
  assert.equal(await client.readContract({address:TOKEN,abi:erc20Abi,functionName:'balanceOf',args:[addresses.JobEscrowV4]}),0n);
  await assert.rejects(()=>write(owner,'JobEscrowV4','setTraceAnchorGuard',[addresses.TraceAnchorGuard]));
 }finally{await server.close();}
});
