import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {createPublicClient,createWalletClient,defineChain,http,erc20Abi,keccak256,parseTransaction,recoverTransactionAddress,type Hex,type TransactionSerialized} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {acquireProcessLock} from '../src/lock.ts';
import {compileKtrace,deploymentSteps,addresses,OWNER,TOKEN,names} from './ktrace-artifacts.ts';
const RPC='https://rpc.botchain.ai';
const chain=defineChain({id:677,name:'BOT Chain',nativeCurrency:{name:'BOT',symbol:'BOT',decimals:18},rpcUrls:{default:{http:[RPC]}}});
const DIR=resolve(import.meta.dir,'../.local/ktrace-botchain');
const CAP=3n*10n**17n; // Maximum combined gas liability: 0.3 BOT for all six transactions.
const stringify=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2);
function save(name:string,x:unknown){const p=`${DIR}/${name}.json`;writeFileSync(`${p}.tmp`,stringify(x),{mode:0o600});const fd=openSync(`${p}.tmp`,'r');fsyncSync(fd);closeSync(fd);renameSync(`${p}.tmp`,p);const d=openSync(DIR,'r');fsyncSync(d);closeSync(d);}
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
let stage='start';
export async function main(mode:string){
  assert.ok(['prepare','send','verify'].includes(mode),'Invalid mode');
  mkdirSync(DIR,{recursive:true,mode:0o700});const lock=acquireProcessLock(`${DIR}/lock.sqlite`);
  try{
    stage='compile';const bundle=compileKtrace();const steps=deploymentSteps(bundle);
    const digest=keccak256(new TextEncoder().encode(stringify(steps)));
    const client=createPublicClient({chain,transport:http(RPC,{timeout:20000,retryCount:1}),cacheTime:0});
    stage='network';assert.equal(await client.getChainId(),677,'Wrong chain');
    const tokenCode=await client.getCode({address:TOKEN});assert.ok(tokenCode&&tokenCode!=='0x','Missing token');
    assert.equal(await client.readContract({address:TOKEN,abi:erc20Abi,functionName:'decimals'}),6,'Wrong token decimals');
    const planFile=`${DIR}/plan.json`;
    if(mode==='prepare'){
      assert.ok(!existsSync(planFile),'Plan exists; reconcile existing plan');
      assert.equal(await client.getTransactionCount({address:OWNER,blockTag:'latest'}),1,'Nonce changed');
      assert.equal(await client.getTransactionCount({address:OWNER,blockTag:'pending'}),1,'Pending transaction');
      const estimates=[];const gasPrice=await client.getGasPrice()*110n/100n;
      for(const s of steps){
        assert.ok(!await client.getCode({address:s.address}),'Target already deployed');
        // The final setter depends on contracts not deployed yet; local test checks its execution.
        const gas=s.to?100000n:await client.estimateGas({account:OWNER,data:s.data,value:0n})*120n/100n;
        if(!s.to){const result=await client.call({account:OWNER,data:s.data,gas,value:0n});assert.equal(result.data,s.runtime,'Creation runtime mismatch');}
        estimates.push({name:s.name,nonce:s.nonce,address:s.address,gas:gas.toString(),gasPrice:gasPrice.toString()});
      }
      const cost=estimates.reduce((a,s)=>a+BigInt(s.gas)*gasPrice,0n);assert.ok(cost<=CAP,'Gas cap exceeded');
      assert.ok(await client.getBalance({address:OWNER})>=cost,'Insufficient gas');
      const plan={digest,chainId:677,owner:OWNER,token:TOKEN,tokenCodeHash:keccak256(tokenCode),capWei:CAP,maximumFeeWei:cost,steps:estimates,sourceHashes:bundle.hashes,compiler:bundle.compiler,settings:bundle.settings};
      save('plan',plan);console.log(stringify(plan));return;
    }
    const plan=JSON.parse(readFileSync(planFile,'utf8'));assert.equal(plan.digest,digest,'Source or parameters changed');assert.equal(plan.tokenCodeHash,keccak256(tokenCode),'Token changed');
    assert.equal(plan.steps.length,6,'Invalid plan');assert.equal(plan.capWei,CAP.toString(),'Cap changed');
    let totalLiability=0n;const evidence=[];
    for(const s of steps){
      stage=`${s.name}:journal`;const p=plan.steps[s.nonce-1];assert.equal(p.name,s.name);assert.equal(p.nonce,s.nonce);assert.ok(same(p.address,s.address));
      const path=`${DIR}/signed-${s.nonce}.json`;
      let j: {raw:TransactionSerialized;hash:Hex}|undefined=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;
      const gas=BigInt(p.gas);assert.ok(gas>0n&&gas<=10000000n,'Invalid gas limit');
      if(mode==='send'&&!j){
        assert.equal(process.env.KTRACE_APPROVED_DIGEST,digest,'Reviewed digest required');
        stage=`${s.name}:preflight`;assert.equal(await client.getTransactionCount({address:OWNER,blockTag:'latest'}),s.nonce,'Nonce changed');assert.equal(await client.getTransactionCount({address:OWNER,blockTag:'pending'}),s.nonce,'Pending nonce changed');
        if(!s.to)assert.ok(!await client.getCode({address:s.address}),'Target occupied');
        const price=await client.getGasPrice()*110n/100n;assert.ok(price>0n,'Invalid quote');
        assert.ok(totalLiability+gas*price<=CAP,'Total gas cap exceeded');assert.ok(await client.getBalance({address:OWNER})>=gas*price,'Insufficient gas');
        const result=await client.call({account:OWNER,to:s.to,data:s.data,gas,value:0n});if(!s.to)assert.equal(result.data,s.runtime,'Runtime mismatch');
        const key=process.env.KTRACE_DEPLOY_PRIVATE_KEY as Hex;assert.ok(/^0x[0-9a-fA-F]{64}$/.test(key??''),'Missing signer');const account=privateKeyToAccount(key);assert.ok(same(account.address,OWNER),'Wrong signer');
        const wallet=createWalletClient({chain,account,transport:http(RPC)});
        const raw=await wallet.signTransaction({type:'legacy',chainId:677,nonce:s.nonce,to:s.to,data:s.data,value:0n,gas,gasPrice:price});j={raw,hash:keccak256(raw)};save(`signed-${s.nonce}`,j);
      }
      assert.ok(j,'Missing signed transaction');assert.equal(keccak256(j.raw),j.hash);
      const tx=parseTransaction(j.raw);assert.equal(tx.chainId,677);assert.equal(tx.nonce,s.nonce);assert.equal(tx.data,s.data);assert.equal(tx.value??0n,0n);assert.equal(tx.gas,gas);assert.ok(s.to?same(tx.to??'',s.to):!tx.to);assert.ok(tx.gasPrice&&tx.gasPrice>0n);assert.ok(same(await recoverTransactionAddress({serializedTransaction:j.raw}),OWNER));
      totalLiability+=gas*tx.gasPrice;assert.ok(totalLiability<=CAP,'Total fee exceeds cap');
      let receipt=await client.getTransactionReceipt({hash:j.hash}).catch(e=>{if(e.name==='TransactionReceiptNotFoundError')return undefined;throw e;});
      if(!receipt&&mode==='send'){
        assert.equal(process.env.KTRACE_APPROVED_DIGEST,digest,'Reviewed digest required');stage=`${s.name}:broadcast`;
        try{assert.equal(await client.sendRawTransaction({serializedTransaction:j.raw}),j.hash);}catch{assert.ok(await client.getTransaction({hash:j.hash}).catch(()=>undefined),'Uncertain broadcast; preserve journal');}
        console.log(stringify({status:'broadcast',name:s.name,hash:j.hash,address:s.address}));
        receipt=await client.waitForTransactionReceipt({hash:j.hash,confirmations:2,timeout:120000,pollingInterval:2000});
      }
      stage=`${s.name}:readback`;assert.ok(receipt,'Pending receipt; preserve journal');assert.equal(receipt.status,'success','Transaction failed');assert.ok(same(receipt.from,OWNER));
      if(!s.to){assert.ok(same(receipt.contractAddress??'',s.address));assert.equal(await client.getCode({address:s.address}),s.runtime,'Deployed bytecode mismatch');}
      evidence.push({name:s.name,address:s.address,nonce:s.nonce,hash:j.hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,gasUsed:receipt.gasUsed,gasPrice:receipt.effectiveGasPrice,feeWei:receipt.gasUsed*receipt.effectiveGasPrice,runtimeHash:s.runtime?keccak256(s.runtime):undefined});
    }
    stage='configuration-readback';
    const read=(name:typeof names[number],fn:string)=>client.readContract({address:addresses[name],abi:bundle.artifacts[name].abi,functionName:fn});
    for(const n of names.filter(n=>n!=='TraceAnchorGuard'))assert.ok(same(await read(n,'owner') as string,OWNER),'Wrong owner');
    assert.equal(await read('IdentityRegistryV1','registerFee'),0n);assert.equal(await read('IdentityRegistryV1','metadataUpdateFee'),0n);
    assert.ok(same(await read('TrustPublicationAnchorV1','identityRegistry') as string,addresses.IdentityRegistryV1));
    assert.ok(same(await read('TraceAnchorGuard','registry') as string,addresses.JobLifecycleAnchorV2));
    assert.ok(same(await read('JobEscrowV4','traceAnchorGuard') as string,addresses.TraceAnchorGuard));
    assert.ok(same(await read('JobEscrowV4','settlementToken') as string,TOKEN));
    const tokenBalance=await client.readContract({address:TOKEN,abi:erc20Abi,functionName:'balanceOf',args:[addresses.JobEscrowV4]});assert.equal(tokenBalance,0n,'Unexpected funding');
    const finalized=await client.getBlock({blockTag:'finalized'});const result={status:'DEPLOYED_CONFIGURED_UNFUNDED',checkedAt:new Date().toISOString(),chainId:677,owner:OWNER,token:TOKEN,digest,sourceHashes:bundle.hashes,compiler:bundle.compiler,transactions:evidence,totalFeeWei:evidence.reduce((a,e)=>a+e.feeWei,0n),ownerBalanceWei:await client.getBalance({address:OWNER}),escrowTokenBalance:tokenBalance,finalized:evidence.every(e=>e.blockNumber<=finalized.number!),finalizedBlock:finalized.number,hasPauseSwitch:false,backendActivated:false};
    save('verified',result);console.log(stringify(result));
  }finally{lock.release();}
}
if(import.meta.main)main(process.argv[2]??'prepare').catch(e=>{console.error(JSON.stringify({status:'STOPPED',stage,reason:e?.name==='AssertionError'&&e.generatedMessage===false?e.message:'RPC or validation failure; preserve journal'}));process.exitCode=1;});
