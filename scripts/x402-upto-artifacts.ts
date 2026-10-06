import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { concatHex, keccak256, type Hex } from 'viem';

// x402UptoPermit2Proxy for BOT Chain testnet 968, taken from x402-foundation/x402 @ 9b37f376ef
// (contracts/evm/script/Deploy.s.sol). scripts/x402-upto-botchain.json carries the exact
// initCode and the runtime it produces, so deployment never depends on a local Solidity
// toolchain. solc is deliberately not imported here: this repository ships solc 0.8.30 while
// the upstream foundry.toml pins 0.8.28, and only a 0.8.28 build reproduces the address.
export const ARTIFACT = resolve(import.meta.dir, 'x402-upto-botchain.json');
export const UPTO_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002' as const;
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
export const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as const;
export const UPTO_SALT = '0x000000000000000000000000000000000000000000000000b000000001db633d' as const;
// PERMIT2() getter selector, the cheapest proof that the deployed immutables are patched.
export const PERMIT2_SELECTOR = '0x6afdd850' as const;
export const SOURCES = ['src/x402UptoPermit2Proxy.sol', 'src/x402BasePermit2Proxy.sol', 'src/interfaces/ISignatureTransfer.sol'];
export const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'cancun',
  metadata: { bytecodeHash: 'none', appendCBOR: false },
  outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
};

export type UptoArtifact = {
  name: string;
  create2: { deployer: Hex; salt: Hex; address: Hex; addressLowercase: Hex };
  constructorArgs: { permit2: Hex };
  initCode: Hex;
  initCodeHash: Hex;
  deploymentData: Hex;
  runtime: Hex;
  runtimeKeccak: Hex;
  permit2Immutable: { start: number; length: number }[];
  compiler: { solc: string; openzeppelinContracts: string; settings: unknown; sources: Record<string, string>; openzeppelinImports: [string, string][] };
};

export function create2Address(initCodeHash: Hex): Hex {
  return `0x${keccak256(concatHex(['0xff', CREATE2_DEPLOYER, UPTO_SALT, initCodeHash])).slice(26)}` as Hex;
}

export function deploymentData(artifact: UptoArtifact): Hex {
  return concatHex([UPTO_SALT, artifact.initCode]);
}

// Patches every immutable slot of a compiled runtime with the canonical Permit2 address.
export function patchRuntime(runtime: Hex, refs: { start: number; length: number }[], permit2: Hex): Hex {
  let code = runtime.slice(2);
  for (const { start, length } of refs) {
    assert.equal(length, 32, 'Unexpected immutable width');
    code = code.slice(0, start * 2) + permit2.slice(2).toLowerCase().padStart(64, '0') + code.slice((start + length) * 2);
  }
  return `0x${code}`;
}

export function loadArtifact(): UptoArtifact {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as UptoArtifact;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  assert.equal(artifact.name, 'x402UptoPermit2Proxy');
  assert.equal(artifact.create2.salt, UPTO_SALT, 'Artifact salt drift');
  assert.ok(same(artifact.create2.deployer, CREATE2_DEPLOYER), 'Artifact CREATE2 deployer drift');
  assert.ok(same(artifact.create2.address, UPTO_PROXY), 'Artifact target address drift');
  assert.ok(same(artifact.constructorArgs.permit2, PERMIT2), 'Artifact Permit2 drift');
  assert.equal(keccak256(artifact.initCode), artifact.initCodeHash, 'Artifact initCode hash mismatch');
  assert.equal(keccak256(artifact.runtime), artifact.runtimeKeccak, 'Artifact runtime hash mismatch');
  assert.ok(same(create2Address(artifact.initCodeHash), UPTO_PROXY), 'Artifact initCode does not hash to the official address');
  assert.equal(deploymentData(artifact), artifact.deploymentData, 'Artifact calldata mismatch');
  const permit2 = PERMIT2.slice(2).toLowerCase().padStart(64, '0');
  for (const { start, length } of artifact.permit2Immutable) {
    assert.equal(length, 32, 'Unexpected immutable width');
    assert.equal(artifact.runtime.slice(2 + start * 2, 2 + (start + length) * 2), permit2, 'Expected runtime is missing the Permit2 immutable');
  }
  return artifact;
}

// Rebuilds the artifact from the pinned upstream checkout and compares it with the checked-in
// JSON. Run as: X402_SOLC_MODULE=/path/to/solc-0.8.28 X402_CONTRACT_ROOT=/path/to/x402/contracts/evm
// bun scripts/x402-upto-artifacts.ts
export function compileX402Upto(solc: any, contractRoot: string) {
  assert.ok(solc.version().startsWith('0.8.28'), `Upstream foundry.toml pins solc 0.8.28, got ${solc.version()}`);
  const sources = Object.fromEntries(SOURCES.map((p) => [p, { content: readFileSync(resolve(contractRoot, p), 'utf8') }]));
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: SETTINGS }), {
    import: (p: string) => ({ contents: readFileSync(resolve(contractRoot, 'lib/openzeppelin-contracts/contracts', p.slice('@openzeppelin/contracts/'.length)), 'utf8') }),
  }));
  const errors = (out.errors ?? []).filter((e: any) => e.severity === 'error');
  if (errors.length) throw Error(errors.map((e: any) => e.formattedMessage).join('\n'));
  const c = out.contracts[SOURCES[0]].x402UptoPermit2Proxy;
  const permit2Immutable = (Object.values(c.evm.deployedBytecode.immutableReferences) as { start: number; length: number }[][]).flat().sort((a, b) => a.start - b.start);
  const initCode = concatHex([`0x${c.evm.bytecode.object}`, `0x${PERMIT2.slice(2).padStart(64, '0')}`]);
  const runtime = patchRuntime(`0x${c.evm.deployedBytecode.object}`, permit2Immutable, PERMIT2);
  return { initCode, initCodeHash: keccak256(initCode), runtime, runtimeKeccak: keccak256(runtime), permit2Immutable };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const solc = createRequire(import.meta.url)(process.env.X402_SOLC_MODULE ?? 'solc');
  const contractRoot = process.env.X402_CONTRACT_ROOT ?? '/tmp/x402-9b37f376ef/contracts/evm';
  const artifact = loadArtifact();
  const fresh = compileX402Upto(solc, contractRoot);
  assert.equal(fresh.initCode, artifact.initCode, 'Checked-in initCode does not match a fresh compile');
  assert.equal(fresh.runtime, artifact.runtime, 'Checked-in runtime does not match a fresh compile');
  console.log(JSON.stringify({ verified: true, contractRoot, solc: solc.version(), address: UPTO_PROXY, initCodeHash: artifact.initCodeHash, runtimeKeccak: artifact.runtimeKeccak }, null, 2));
}
