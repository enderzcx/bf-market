import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, parseAbi, encodeFunctionData } from "viem";
import { EvmChain, settlementAbi, FUJI_USDC } from "../src/chain.js";
import { startLocalChain, OTHER_KEY } from "../scripts/local-chain.js";

test("real EVM: funding, permission, pause, replay protection, receipt matching and reverted transfer", { timeout: 30_000 }, async () => {
  const local = await startLocalChain(0);
  try {
    const adapter = new EvmChain(local.config);
    const payout = {
      id: keccak256(toHex("merchant/order/1")),
      recipient: local.recipient,
      amount: 2_500_000n,
    };
    assert.equal((await adapter.balances()).token, "10000000000");
    await assert.rejects(
      () =>
        new EvmChain({ ...local.config, privateKey: OTHER_KEY }).prepare(
          payout,
        ),
      /executor/,
    );
    assert.throws(
      () => new EvmChain({ ...local.config, chainId: 43113 }),
      /Circle test USDC/,
    );
    assert.throws(
      () => new EvmChain({ ...local.config, chainId: 43113, token: FUJI_USDC }),
      /test keys/,
    );
    await assert.rejects(
      () =>
        new EvmChain({
          ...local.config,
          chainId: 43113,
          token: FUJI_USDC,
          privateKey: `0x${"3".padStart(64, "0")}`,
        }).prepare(payout),
      /chain mismatch/,
    );
    await assert.rejects(
      () =>
        new EvmChain({ ...local.config, token: local.recipient }).prepare(
          payout,
        ),
      /token mismatch/,
    );
    const pauseHash = await local.wallet.writeContract({
      address: local.config.contract,
      abi: settlementAbi,
      functionName: "pause",
    });
    await local.publicClient.waitForTransactionReceipt({ hash: pauseHash });
    await assert.rejects(() => adapter.prepare(payout));
    const unpauseHash = await local.wallet.writeContract({
      address: local.config.contract,
      abi: settlementAbi,
      functionName: "unpause",
    });
    await local.publicClient.waitForTransactionReceipt({ hash: unpauseHash });
    await assert.rejects(() =>
      local.publicClient.simulateContract({
        account: local.recipient,
        address: local.config.contract,
        abi: settlementAbi,
        functionName: "pay",
        args: [payout.id, payout.recipient, payout.amount],
      }),
    );
    await assert.rejects(() =>
      local.publicClient.simulateContract({
        account: local.recipient,
        address: local.config.contract,
        abi: settlementAbi,
        functionName: "pause",
      }),
    );
    const prepared = await adapter.prepare(payout);
    assert.equal(await adapter.inspect(payout, prepared.hash), "pending");
    await adapter.broadcast(prepared.rawTransaction);
    await local.publicClient.waitForTransactionReceipt({ hash: prepared.hash });
    assert.equal(await adapter.inspect(payout, prepared.hash), "confirmed");
    assert.equal(await adapter.inspect(payout, prepared.hash), "confirmed");
    await assert.rejects(() => adapter.prepare(payout));
    const balance = await local.publicClient.readContract({
      address: local.config.token,
      abi: parseAbi(["function balanceOf(address) view returns(uint256)"]),
      functionName: "balanceOf",
      args: [local.recipient],
    });
    assert.equal(balance, 2_500_000n);
    await assert.rejects(
      () => adapter.inspect({ ...payout, amount: 3n }, prepared.hash),
      /mismatch/,
    );
    await assert.rejects(() => adapter.inspect(payout, pauseHash), /mismatch/);
    // Mine a transaction that reverts (bypass simulation explicitly) to test receipt distinction.
    const bad = {
      ...payout,
      id: keccak256(toHex("insufficient")),
      amount: 100_000n * 10n ** 6n,
    };
    const badHash = await local.wallet.sendTransaction({
      to: local.config.contract,
      data: encodeFunctionData({
        abi: settlementAbi,
        functionName: "pay",
        args: [bad.id, bad.recipient, bad.amount],
      }),
      gas: 200_000n,
    });
    await local.publicClient.waitForTransactionReceipt({ hash: badHash });
    assert.equal(await adapter.inspect(bad, badHash), "reverted");
    assert.equal(
      await local.publicClient.readContract({
        address: local.config.contract,
        abi: settlementAbi,
        functionName: "paid",
        args: [bad.id],
      }),
      false,
    );
    // Duplicate ID is rejected even if recipient and amount are changed.
    const duplicateHash = await local.wallet.sendTransaction({
      to: local.config.contract,
      data: encodeFunctionData({
        abi: settlementAbi,
        functionName: "pay",
        args: [payout.id, local.wallet.account.address, 1n],
      }),
      gas: 200_000n,
    });
    assert.equal(
      (
        await local.publicClient.waitForTransactionReceipt({
          hash: duplicateHash,
        })
      ).status,
      "reverted",
    );
  } finally {
    await local.server.close();
  }
});

test("persistent local EVM restart preserves payout receipt and replay guard", { timeout: 30_000 }, async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "settlement-chain-"));
  let local = await startLocalChain(0, { databasePath: join(dir, "ganache") });
  try {
    const adapter = new EvmChain(local.config);
    const payout = {
      id: keccak256(toHex("restart-test")),
      recipient: local.recipient,
      amount: 1_000_000n,
    };
    const prepared = await adapter.prepare(payout);
    await adapter.broadcast(prepared.rawTransaction);
    await local.publicClient.waitForTransactionReceipt({ hash: prepared.hash });
    const config = local.config;
    await local.server.close();
    local = await startLocalChain(0, {
      databasePath: join(dir, "ganache"),
      config,
    });
    const recovered = new EvmChain(local.config);
    assert.equal(await recovered.inspect(payout, prepared.hash), "confirmed");
    await assert.rejects(() => recovered.prepare(payout));
    assert.equal((await recovered.balances()).token, "9999000000");
  } finally {
    await local.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
