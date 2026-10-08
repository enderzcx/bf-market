export function formatAtomicUsdt(amount) {
  try {
    const atomic = BigInt(amount);
    const sign = atomic < 0n ? '-' : '';
    const absolute = atomic < 0n ? -atomic : atomic;
    const whole = absolute / 1_000_000n;
    const fraction = (absolute % 1_000_000n).toString().padStart(6, '0');
    return `${sign}${whole}.${fraction}`;
  } catch {
    return null;
  }
}

function contractAddresses(discoveryData) {
  const items = Array.isArray(discoveryData?.items) ? discoveryData.items : [];
  const extras = items.flatMap((item) =>
    (Array.isArray(item.accepts) ? item.accepts : []).map((accept) => accept.extra ?? {}),
  );
  const firstValue = (key) => extras.find((extra) => typeof extra[key] === 'string')?.[key] ?? null;
  const registry = items.find((item) => typeof item.provider?.agentRegistry === 'string')
    ?.provider.agentRegistry;
  const registryAddress = registry?.split(':').at(-1) ?? null;

  return [
    ['asset', null],
    ['permit2', firstValue('permit2')],
    ['exactProxy', firstValue('x402Permit2Proxy')],
    ['uptoProxy', firstValue('x402UptoPermit2Proxy')],
    ['identityRegistry', registryAddress],
  ];
}

export function docsDataModel({ servicesData, discoveryData, summaryData }) {
  const services = Array.isArray(servicesData?.services) ? servicesData.services : [];
  const service = services[0];
  const discoveryNetwork = discoveryData?.network;
  const assetAddress = service?.asset ?? discoveryNetwork?.asset ?? null;
  const contracts = contractAddresses(discoveryData).map(([key, value]) => [
    key,
    key === 'asset' ? assetAddress : value,
  ]).filter(([, value]) => typeof value === 'string' && value.length > 0);
  const platform = summaryData?.platform ?? {};
  const networkId = service?.network ?? discoveryNetwork?.caip2 ?? null;

  return {
    network: networkId
      ? {
          name: discoveryNetwork?.displayName ?? null,
          chainId: discoveryNetwork?.chainId ?? null,
          caip2: networkId,
          symbol: discoveryNetwork?.symbol ?? null,
          decimals: discoveryNetwork?.decimals ?? null,
          faucet: typeof discoveryNetwork?.faucet === 'string' ? discoveryNetwork.faucet : null,
        }
      : null,
    contracts,
    limits: {
      budgetMax: formatAtomicUsdt(platform.budgetMax),
      llmWalletDailyCap: formatAtomicUsdt(platform.llmWalletDailyCap),
      llmGlobalDailyCap: formatAtomicUsdt(platform.llmGlobalDailyCap),
    },
  };
}
