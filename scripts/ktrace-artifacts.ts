import solc from 'solc';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getContractAddress, encodeDeployData, encodeFunctionData, type Hex } from 'viem';
export const OWNER = '0x28172e0d973fFf24651B6Ed4cA6d1007bc168C94' as const;
export const TOKEN = '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C' as const;
export const names = ['IdentityRegistryV1','TrustPublicationAnchorV1','JobLifecycleAnchorV2','TraceAnchorGuard','JobEscrowV4'] as const;
export type Name = typeof names[number];
export const addresses = Object.fromEntries(names.map((name,i)=>[name,getContractAddress({from:OWNER,nonce:BigInt(i+1)})])) as Record<Name,Hex>;
export function compileKtrace() {
  const root=resolve(import.meta.dir,'..');
  const sources=Object.fromEntries([...names,'ITraceAnchorGuard'].map(n=>[`${n}.sol`,{content:readFileSync(resolve(root,'contracts/ktrace',`${n}.sol`),'utf8')}]));
  const settings={optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences']}}};
  const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings}),{import:(p:string)=>({contents:readFileSync(resolve(root,'node_modules',p),'utf8')})}));
  const errors=(out.errors??[]).filter((e:any)=>e.severity==='error');
  if(errors.length)throw Error(errors.map((e:any)=>e.formattedMessage).join('\n'));
  const artifacts=Object.fromEntries(names.map(n=>{const c=out.contracts[`${n}.sol`][n];return [n,{abi:c.abi,bytecode:`0x${c.evm.bytecode.object}` as Hex,runtime:`0x${c.evm.deployedBytecode.object}` as Hex,immutables:c.evm.deployedBytecode.immutableReferences as Record<string,{start:number,length:number}[]>}]})) as Record<Name,{abi:any;bytecode:Hex;runtime:Hex;immutables:Record<string,{start:number,length:number}[]>}>;
  const hashes=Object.fromEntries(Object.entries(sources).map(([p,s])=>[p,createHash('sha256').update(s.content).digest('hex')]));
  return {artifacts,hashes,compiler:solc.version(),settings};
}
export function deploymentSteps(bundle:ReturnType<typeof compileKtrace>) {
  const args:Record<Name,unknown[]>={IdentityRegistryV1:['Kite Trace Identity Registry','KTRC',OWNER,0n,0n],TrustPublicationAnchorV1:[OWNER,addresses.IdentityRegistryV1],JobLifecycleAnchorV2:[OWNER],TraceAnchorGuard:[addresses.JobLifecycleAnchorV2],JobEscrowV4:[TOKEN,OWNER]};
  const steps=names.map((name,i)=>{
    const a=bundle.artifacts[name]; let runtime=a.runtime.slice(2);
    const immutable=name==='TraceAnchorGuard'?addresses.JobLifecycleAnchorV2:name==='JobEscrowV4'?TOKEN:undefined;
    if(Object.keys(a.immutables).length!==(immutable?1:0))throw Error('Unexpected immutable layout');
    for(const refs of Object.values(a.immutables))for(const {start,length} of refs){if(length!==32)throw Error('Unexpected immutable length');runtime=runtime.slice(0,start*2)+immutable!.slice(2).toLowerCase().padStart(64,'0')+runtime.slice((start+length)*2);}
    return {name,nonce:i+1,address:addresses[name],to:undefined as Hex|undefined,data:encodeDeployData({...a,args:args[name]}),runtime:`0x${runtime}` as Hex};
  });
  return [...steps,{name:'SetTraceAnchorGuard',nonce:6,address:addresses.JobEscrowV4,to:addresses.JobEscrowV4,data:encodeFunctionData({abi:bundle.artifacts.JobEscrowV4.abi,functionName:'setTraceAnchorGuard',args:[addresses.TraceAnchorGuard]}),runtime:undefined}];
}
