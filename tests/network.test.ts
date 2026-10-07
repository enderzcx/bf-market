import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CIRCLE_FUJI_USDC,
  loadConfig,
  runtimeConfig,
  type RuntimeConfigInput,
} from "../src/config.ts";
import {
  NETWORK_NAMES,
  NETWORK_PROFILES,
  chainIdFromCaip2,
  networkFingerprint,
  profileForChainId,
  selectNetworkByName,
} from "../src/network.ts";
import { assertNetworkPreflight, type PreflightRpc } from "../src/preflight.ts";

const CONTRACT = "0x0000000000000000000000000000000000000002" as const;
const TOKEN = "0x0000000000000000000000000000000000000001" as const;
const KEY = `0x${"1".padStart(64, "0")}` as const;
const BOTCHAIN = NETWORK_PROFILES["botchain-testnet"];
const HAS_CODE = "0x" + "ab".repeat(32);

function stubRpc(opts: {
  chainId?: number;
  noCode?: string[];
  decimals?: Record<string, number>;
} = {}): PreflightRpc {
  const noCode = new Set((opts.noCode ?? []).map((a) => a.toLowerCase()));
  return {
    async getChainId() {
      return opts.chainId ?? BOTCHAIN.chainId;
    },
    async getCode(address) {
      return noCode.has(address.toLowerCase()) ? "0x" : HAS_CODE;
    },
    async readDecimals(address) {
      return opts.decimals?.[address.toLowerCase()] ?? BOTCHAIN.asset.decimals;
    },
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "settlement-network-"));
}

function localChain(extra: Partial<RuntimeConfigInput> = {}): RuntimeConfigInput {
  return {
    chain: {
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contract: CONTRACT,
      token: TOKEN,
      privateKey: KEY,
    },
    ...extra,
  };
}

test("unknown network selector fails closed", () => {
  expect(() => selectNetworkByName("ethereum")).toThrow(/未知结算网络/);
  expect(() => selectNetworkByName("968")).toThrow(/未知结算网络/);
  expect(() =>
    loadConfig({ cwd: tmp(), env: { SETTLEMENT_NETWORK: "mainnet" } }),
  ).toThrow(/未知结算网络/);
});

test("network selection is explicit: missing selector and chain fail closed", () => {
  expect(() => loadConfig({ cwd: tmp(), env: {} })).toThrow(/未配置结算链/);
  expect(() =>
    loadConfig({
      cwd: tmp(),
      env: {
        SETTLEMENT_CHAIN_ID: "677",
        SETTLEMENT_RPC_URL: "https://example.invalid",
      },
    }),
  ).toThrow(/未配置结算链/);
  // Legacy explicit path: a known chain id alone still resolves its profile.
  const fuji = loadConfig({
    cwd: tmp(),
    env: {
      SETTLEMENT_CHAIN_ID: "43113",
      SETTLEMENT_RPC_URL: "https://example.invalid",
      SETTLEMENT_CONTRACT: CONTRACT,
      SETTLEMENT_TOKEN: CIRCLE_FUJI_USDC,
      SETTLEMENT_PRIVATE_KEY: KEY,
    },
  });
  expect(fuji.network.name).toBe("fuji");
});

test("selector and chain id must agree", () => {
  expect(() =>
    loadConfig({
      cwd: tmp(),
      env: { SETTLEMENT_NETWORK: "fuji", SETTLEMENT_CHAIN_ID: "968" },
    }),
  ).toThrow(/冲突/);
});

test("the three known profiles carry the expected chain facts", () => {
  expect([...NETWORK_NAMES]).toEqual(["local", "fuji", "botchain-testnet"]);

  const local = NETWORK_PROFILES.local;
  expect(local.chainId).toBe(31337);
  expect(local.caip2).toBe("eip155:31337");
  expect(local.asset.decimals).toBe(6);
  expect(local.asset.transferMethods).toEqual([]);
  expect(local.finality).toEqual({ kind: "canonical" });
  expect(local.payoutsRequired).toBe(true);

  const fuji = NETWORK_PROFILES.fuji;
  expect(fuji.chainId).toBe(43113);
  expect(fuji.caip2).toBe("eip155:43113");
  expect(fuji.asset.address).toBe(CIRCLE_FUJI_USDC);
  expect(fuji.asset.decimals).toBe(6);
  expect(fuji.asset.transferMethods).toContain("eip3009");
  expect(fuji.asset.transferMethods).toContain("permit2");
  expect(fuji.permit2?.toLowerCase()).toBe(
    "0x000000000022d473030f116ddee9f6b43ac78ba3",
  );
  expect(fuji.x402Permit2Proxy?.toLowerCase()).toBe(
    "0x402085c248eea27d92e8b30b2c58ed07f9e20001",
  );
  expect(fuji.identityRegistry?.toLowerCase()).toBe(
    "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  );
  expect(fuji.finality).toEqual({ kind: "finalized" });
  // Fuji keeps requiring a payout contract by default (partner center); an
  // x402-only deployment opts out with SETTLEMENT_PAYOUTS_DISABLED.
  expect(fuji.payoutsRequired).toBe(true);

  expect(BOTCHAIN.chainId).toBe(968);
  expect(BOTCHAIN.caip2).toBe("eip155:968");
  expect(BOTCHAIN.rpcUrl).toBe("https://rpc.bohr.life");
  expect(BOTCHAIN.explorerUrl).toBe("https://scan.bohr.life");
  expect(BOTCHAIN.asset.decimals).toBe(6);
  expect(BOTCHAIN.asset.symbol).toBe("USDT");
  expect(BOTCHAIN.asset.transferMethods).toEqual(["permit2"]);
  expect(BOTCHAIN.asset.transferMethods).not.toContain("eip3009");
  expect(BOTCHAIN.asset.transferMethods).not.toContain("eip2612");
  expect(BOTCHAIN.permit2?.toLowerCase()).toBe(
    "0x000000000022d473030f116ddee9f6b43ac78ba3",
  );
  expect(BOTCHAIN.x402Permit2Proxy?.toLowerCase()).toBe(
    "0x402085c248eea27d92e8b30b2c58ed07f9e20001",
  );
  expect(BOTCHAIN.identityRegistry?.toLowerCase()).toBe(
    "0xe35a670ec84477b54f976ddfa5f8e4601ffc8607",
  );
  expect(BOTCHAIN.finality).toEqual({ kind: "finalized" });
  expect(BOTCHAIN.payoutsRequired).toBe(false);

  // Fuji and BOT Chain declare a registry in the profile; local injects one.
  expect(local.identityRegistry).toBeUndefined();

  // No 677 mainnet or other networks were added.
  expect(profileForChainId(677)).toBeNull();
  expect(chainIdFromCaip2("eip155:968")).toBe(968);
  expect(() => chainIdFromCaip2("solana:mainnet")).toThrow();
});

test("profile fingerprint is deterministic and network-specific", () => {
  const bot = networkFingerprint(BOTCHAIN);
  expect(bot).toBe(networkFingerprint(BOTCHAIN));
  expect(bot).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(networkFingerprint(NETWORK_PROFILES.fuji)).not.toBe(bot);
  expect(networkFingerprint(NETWORK_PROFILES.local)).not.toBe(bot);
  const clone = {
    ...BOTCHAIN,
    asset: { ...BOTCHAIN.asset, transferMethods: [...BOTCHAIN.asset.transferMethods] },
  };
  expect(networkFingerprint(clone)).toBe(bot);
});

test("preflight passes when chain id, asset and Permit2 all match", async () => {
  await expect(
    assertNetworkPreflight({ profile: BOTCHAIN, rpc: stubRpc({ chainId: 968 }) }),
  ).resolves.toBeUndefined();
});

test("preflight rejects a chain id mismatch", async () => {
  await expect(
    assertNetworkPreflight({ profile: BOTCHAIN, rpc: stubRpc({ chainId: 1 }) }),
  ).rejects.toThrow(/eth_chainId/);
});

test("preflight rejects an asset without contract code", async () => {
  await expect(
    assertNetworkPreflight({
      profile: BOTCHAIN,
      rpc: stubRpc({ chainId: 968, noCode: [BOTCHAIN.asset.address] }),
    }),
  ).rejects.toThrow(/没有代码/);
});

test("preflight rejects an asset whose decimals differ from the profile", async () => {
  await expect(
    assertNetworkPreflight({
      profile: BOTCHAIN,
      rpc: stubRpc({
        chainId: 968,
        decimals: { [BOTCHAIN.asset.address.toLowerCase()]: 18 },
      }),
    }),
  ).rejects.toThrow(/精度/);
});

test("preflight rejects missing Permit2 or x402 proxy code", async () => {
  await expect(
    assertNetworkPreflight({
      profile: BOTCHAIN,
      rpc: stubRpc({ chainId: 968, noCode: [BOTCHAIN.permit2!] }),
    }),
  ).rejects.toThrow(/Permit2/);
  await expect(
    assertNetworkPreflight({
      profile: BOTCHAIN,
      rpc: stubRpc({ chainId: 968, noCode: [BOTCHAIN.x402Permit2Proxy!] }),
    }),
  ).rejects.toThrow(/代理/);
});

test("preflight rejects a declared identity registry without code", async () => {
  await expect(
    assertNetworkPreflight({
      profile: BOTCHAIN,
      rpc: stubRpc({ chainId: 968, noCode: [BOTCHAIN.identityRegistry!] }),
    }),
  ).rejects.toThrow(/注册表/);
});

test("x402 cannot be enabled on a network without EIP-3009", () => {
  expect(() =>
    runtimeConfig({
      chain: { rpcUrl: "https://rpc.bohr.life", chainId: 968, token: BOTCHAIN.asset.address },
      source: "beefapi",
      orderDemo: true,
      beefapiBaseUrl: "http://127.0.0.1:9",
      beefapiToken: "t".repeat(32),
      x402Enabled: true,
    }),
  ).toThrow(/x402/);
});

test("botchain-testnet starts without a Settlement address and disables payouts", () => {
  const cfg = loadConfig({ cwd: tmp(), env: { SETTLEMENT_NETWORK: "botchain-testnet" } });
  expect(cfg.network.name).toBe("botchain-testnet");
  expect(cfg.chain.chainId).toBe(968);
  expect(cfg.chain.token.toLowerCase()).toBe(BOTCHAIN.asset.address.toLowerCase());
  expect(cfg.payoutsEnabled).toBe(false);
  expect(cfg.payoutsDisabledReason).toContain("出款");
  expect(cfg.identityRegistry?.toLowerCase()).toBe(
    BOTCHAIN.identityRegistry!.toLowerCase(),
  );
});

test("agent registration and starter gas stay closed without a registry", () => {
  // The local profile carries no registry until one is injected.
  const base = localChain();
  expect(() =>
    runtimeConfig({ ...base, agentOrigin: "https://example.com" }),
  ).toThrow(/身份注册表/);
  expect(() =>
    runtimeConfig({
      ...base,
      starterGasEnabled: true,
      starterGasWei: 1n,
      starterGasDailyCapWei: 2n,
      starterGasBalanceThresholdWei: 1n,
      opsPrivateKey: KEY,
    }),
  ).toThrow(/身份注册表/);
  // The local profile accepts an injected registry and an agent origin.
  const local = runtimeConfig({
    ...localChain(),
    identityRegistry: CONTRACT,
    agentOrigin: "https://agents.example.com",
  });
  expect(local.identityRegistry).toBe(CONTRACT);
  expect(local.agentOrigin).toBe("https://agents.example.com");
});

test("public networks pin the profile asset and reject a token override", () => {
  expect(() =>
    loadConfig({
      cwd: tmp(),
      env: {
        SETTLEMENT_NETWORK: "botchain-testnet",
        SETTLEMENT_TOKEN: "0x000000000000000000000000000000000000dEaD",
      },
    }),
  ).toThrow(/代币必须固定为 USDT/);
});

test("an x402-only deployment opts out of the Fuji payout contract", () => {
  const base = {
    chain: {
      rpcUrl: "https://example.invalid",
      chainId: 43113,
      token: CIRCLE_FUJI_USDC,
    },
  };
  // Fuji demands a payout contract and an executor key by default.
  expect(() => runtimeConfig(base)).toThrow(/结算合约/);
  // The explicit opt-out starts with payouts disabled and no contract.
  const x402Only = runtimeConfig({ ...base, payoutsDisabled: true });
  expect(x402Only.payoutsEnabled).toBe(false);
  expect(x402Only.payoutsDisabledReason).toContain("SETTLEMENT_PAYOUTS_DISABLED");
  // A contract plus the opt-out is a contradiction, not a silent override.
  expect(() =>
    runtimeConfig({
      ...base,
      chain: { ...base.chain, contract: CONTRACT, privateKey: KEY },
      payoutsDisabled: true,
    }),
  ).toThrow(/SETTLEMENT_PAYOUTS_DISABLED/);
  // The env switch drives the same path.
  const fromEnv = loadConfig({
    cwd: tmp(),
    env: {
      SETTLEMENT_NETWORK: "fuji",
      SETTLEMENT_RPC_URL: "https://example.invalid",
      SETTLEMENT_PAYOUTS_DISABLED: "true",
    },
  });
  expect(fromEnv.payoutsEnabled).toBe(false);
  expect(fromEnv.chain.token).toBe(CIRCLE_FUJI_USDC);
});

test("sqlite path is namespaced per network and keeps Fuji compatible", () => {
  const base = join(tmpdir(), "settlement.sqlite");
  const local = runtimeConfig(localChain({ dbPath: base }));
  const fuji = runtimeConfig({
    chain: {
      rpcUrl: "https://example.invalid",
      chainId: 43113,
      contract: CONTRACT,
      token: CIRCLE_FUJI_USDC,
      privateKey: KEY,
    },
    dbPath: base,
  });
  const bot = runtimeConfig({
    chain: { rpcUrl: "https://rpc.bohr.life", chainId: 968, token: BOTCHAIN.asset.address },
    dbPath: base,
  });
  expect(fuji.dbPath).toBe(base);
  expect(local.dbPath).not.toBe(fuji.dbPath);
  expect(bot.dbPath).not.toBe(fuji.dbPath);
  expect(local.dbPath).not.toBe(bot.dbPath);
  expect(bot.dbPath).toContain("botchain-testnet");
  expect(local.dbPath).toContain(".local.");
});
