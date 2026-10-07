import { describe, expect, test } from 'bun:test';
import { docsDataModel } from './docs-model.js';

const servicesData = {
  services: [
    {
      serviceId: 'echo',
      network: 'eip155:968',
      asset: '0xToken',
    },
  ],
};

const discoveryData = {
  network: {
    displayName: 'BOT Chain Testnet',
    chainId: 968,
    caip2: 'eip155:968',
    asset: '0xToken',
    symbol: 'USDT',
    decimals: 6,
  },
  items: [
    {
      provider: { agentRegistry: 'eip155:968:0xIdentity' },
      accepts: [
        {
          extra: {
            permit2: '0xPermit2',
            x402Permit2Proxy: '0xExact',
            x402UptoPermit2Proxy: '0xUpto',
          },
        },
      ],
    },
  ],
};

describe('docsDataModel', () => {
  test('formats current platform limits from the wallet summary', () => {
    const model = docsDataModel({
      servicesData,
      discoveryData,
      summaryData: {
        platform: {
          budgetMax: '3000000',
          llmWalletDailyCap: '5100000',
          llmGlobalDailyCap: '62000000',
        },
      },
    });

    expect(model.limits).toEqual({
      budgetMax: '3.000000',
      llmWalletDailyCap: '5.100000',
      llmGlobalDailyCap: '62.000000',
    });
  });

  test('uses network and contract addresses from service APIs', () => {
    const model = docsDataModel({ servicesData, discoveryData, summaryData: null });

    expect(model.network).toEqual({
      name: 'BOT Chain Testnet',
      chainId: 968,
      caip2: 'eip155:968',
      symbol: 'USDT',
      decimals: 6,
    });
    expect(model.contracts).toEqual([
      ['asset', '0xToken'],
      ['permit2', '0xPermit2'],
      ['exactProxy', '0xExact'],
      ['uptoProxy', '0xUpto'],
      ['identityRegistry', '0xIdentity'],
    ]);
  });

  test('leaves API-backed values empty when their endpoints have no data', () => {
    const model = docsDataModel({ servicesData: null, discoveryData: null, summaryData: null });

    expect(model.network).toBeNull();
    expect(model.contracts).toEqual([]);
    expect(model.limits).toEqual({
      budgetMax: null,
      llmWalletDailyCap: null,
      llmGlobalDailyCap: null,
    });
  });
});
