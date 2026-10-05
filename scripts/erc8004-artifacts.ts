import solc from 'solc';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeDeployData, encodeFunctionData, getContractAddress, type Hex } from 'viem';

// Official ERC-8004 IdentityRegistry (v2.0.0) plus the OpenZeppelin ERC1967 proxy,
// deployed as implementation + proxy. Local source carries exactly one change:
// initialize(address initialOwner) initializer, replacing reinitializer(2) onlyOwner.
export const REGISTRY_SOURCE = 'contracts/erc8004/IdentityRegistryUpgradeable.sol';
export const PROXY_SOURCE = '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
// ERC-1967 implementation slot: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1).
export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

export function compileErc8004() {
  const root = resolve(import.meta.dir, '..');
  const sources: Record<string, { content: string }> = {
    [REGISTRY_SOURCE]: { content: readFileSync(resolve(root, REGISTRY_SOURCE), 'utf8') },
    [PROXY_SOURCE]: { content: readFileSync(resolve(root, 'node_modules', PROXY_SOURCE), 'utf8') },
  };
  const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings }), { import: (p: string) => ({ contents: readFileSync(resolve(root, 'node_modules', p), 'utf8') }) }));
  const errors = (out.errors ?? []).filter((e: any) => e.severity === 'error');
  if (errors.length) throw Error(errors.map((e: any) => e.formattedMessage).join('\n'));
  const artifacts = {
    IdentityRegistryUpgradeable: artifact(out, REGISTRY_SOURCE, 'IdentityRegistryUpgradeable'),
    ERC1967Proxy: artifact(out, PROXY_SOURCE, 'ERC1967Proxy'),
  };
  const hashes = Object.fromEntries(Object.entries(sources).map(([p, s]) => [p, createHash('sha256').update(s.content).digest('hex')]));
  return { artifacts, hashes, compiler: solc.version(), settings };
}

function artifact(out: any, source: string, name: string) {
  const c = out.contracts[source][name];
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` as Hex, runtime: `0x${c.evm.deployedBytecode.object}` as Hex, immutables: c.evm.deployedBytecode.immutableReferences as Record<string, { start: number; length: number }[]> };
}

export function deploymentSteps(bundle: ReturnType<typeof compileErc8004>, owner: Hex, startNonce = 0) {
  const impl = getContractAddress({ from: owner, nonce: BigInt(startNonce) });
  const proxy = getContractAddress({ from: owner, nonce: BigInt(startNonce + 1) });
  const initData = encodeFunctionData({ abi: bundle.artifacts.IdentityRegistryUpgradeable.abi, functionName: 'initialize', args: [owner] });
  return [
    { name: 'IdentityRegistryUpgradeable', nonce: startNonce, address: impl, to: undefined as Hex | undefined, data: encodeDeployData({ abi: bundle.artifacts.IdentityRegistryUpgradeable.abi, bytecode: bundle.artifacts.IdentityRegistryUpgradeable.bytecode, args: [] }), runtime: bundle.artifacts.IdentityRegistryUpgradeable.runtime },
    { name: 'ERC1967Proxy', nonce: startNonce + 1, address: proxy, to: undefined as Hex | undefined, data: encodeDeployData({ abi: bundle.artifacts.ERC1967Proxy.abi, bytecode: bundle.artifacts.ERC1967Proxy.bytecode, args: [impl, initData] }), runtime: undefined as Hex | undefined },
  ];
}
