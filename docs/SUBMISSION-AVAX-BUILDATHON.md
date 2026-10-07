# Avalanche Builder Launchpad 提交材料

活动：Team1 China - Avalanche Builder Launchpad（event `093982ed-7037-4765-a066-56a5d3cff8cb`）
提交截止：2026-10-08 05:59 (Asia/Shanghai)
评审口径：价值主张、技术复杂度、对 Avalanche 技术的使用

本文是提交稿，不是完成度声明。所有"已验收"的说法都对应 `docs/evidence/` 下的记录；没验收的一律写在"边界与未完成"里。

---

## short_description

BF Market is an agent commerce platform where AI agents pay per call with stablecoins. An agent reads one URL, hits a 402 quote, signs an x402 v2 Permit2 authorization, and gets the result; the receipt is public. Live on Avalanche Fuji.

## full_description

BF Market, built by BF Labs, lets an AI agent buy a service with stablecoins without an account, an API key or a human in the loop. The agent reads `https://market-fuji.bflabs.app/skill.md`, discovers a service, receives a 402 with a quote, signs an x402 v2 payment authorization, and gets the result. Payment moves test USDC straight from the buyer to the provider's payout address; the platform never holds the buyer's key and only pays the settlement gas.

The whole loop runs on Avalanche Fuji today at https://market-fuji.bflabs.app with four services (a fixed-price echo service and three metered LLM models). This submission covers that Fuji deployment: the network profile, the deployment, an on-chain provider registration, and two settled paid calls.

Why this needs Avalanche rather than a database: the buyer and the seller are independent parties that do not share an account system. An agent that has never registered anywhere must be able to pay a provider it has never met, and both sides must be able to check the same receipt. Avalanche Fuji supplies that shared settlement layer with sub-second finality and negligible gas, which is what makes a sub-cent, per-call price point viable at all. The largest real charge in our acceptance run was 0.000168 USDC; on a chain where a transfer costs more than the payment, per-call billing is not a product.

Two payment shapes are live, both through Permit2 on Fuji:

- **exact** for fixed-price services. The 402 names the price; the signed authorization moves exactly that amount.
- **upto** for metered services. The 402 names a per-call maximum; after the model returns its token usage, the platform settles the actual amount and the signature bounds the worst case. In the recorded run the quote was 0.019040 USDC and the charge was 0.000168 USDC, because only real usage is billed.

A metered price that is only known after the work is done is the interesting case for agent commerce, and it is why we did not stop at fixed pricing. The buyer signs a ceiling before the call and pays the floor after it.

The platform also enforces spending limits, because an agent with a wallet and no supervision is a liability. Each payment wallet has a daily budget; the on-chain agent owner can set a ceiling for each of their agents, and the agent can only lower its own value. Before a call is served, the amount is held against both limits in one transaction; after settlement it is reduced to the actual charge, and on failure it is released. The buyer console is public read-only: anyone can look up a payment address and see what it spent and the receipts behind it, without connecting anything.

## tech_stack

Avalanche Fuji (C-Chain, chain 43113), test USDC `0x5425890298aed601595a70AB815c96711a31Bc65`. No contract was deployed for this submission: Permit2, both official x402 Permit2 proxies and the official ERC-8004 IdentityRegistry already have code on Fuji, and the deployment uses them.

- **Settlement**: x402 v2 over Permit2, exact and upto schemes, self-hosted facilitator. The official hosted facilitator does not cover this network, so the platform verifies and broadcasts the settlement itself, persisting the signed transaction before broadcast, keying each payment for idempotency, and waiting for finality before reporting success.
- **Identity**: ERC-8004 official IdentityRegistry. A provider registers on chain to list a service; the buyer console reads `ownerOf` and `getAgentWallet` to resolve which agents an owner controls. The registered provider is agent 253.
- **Backend**: TypeScript on Cloudflare Workers with one SQLite-backed Durable Object as the serialized ledger, so payment idempotency locks, the signer nonce queue and the budget holds cannot race. The same code runs locally on Bun.
- **Frontend**: React, bilingual (English and Chinese), one build serving multiple deployments.
- **Agent surface**: `skill.md` for instruction-following agents, an MCP Streamable HTTP endpoint carrying the payment in `_meta`, a Bazaar-compatible `/discovery/resources` catalog, and `llms.txt`.

## explanation (disclosure)

BF Labs has been building partner and settlement infrastructure on Avalanche since before this event. The Fuji Settlement contract and the x402 payment-to-commission loop were built and verified on 2026-09-18, and that work was submitted to Team1 Builder Day @Shenzhen on 2026-09-19. We do not present it as new.

What was built and verified on 2026-10-07, during this event window, is the agent commerce product on top of it: the x402 v2 Permit2 exact and upto payment path for AI services, the daily budget ledger with owner ceilings, the public buyer console, the bilingual public site, and the Fuji deployment recorded in `docs/evidence/fuji-market-x402-2026-10-07.json`. That deployment went from an empty worktree to two settled paid calls on Avalanche Fuji in one session.

## Links

- Live product (Avalanche Fuji): https://market-fuji.bflabs.app
- Same product on a second chain, showing the settlement layer is chain-portable: https://market.bflabs.app
- Source: https://github.com/enderzcx/bf-market (branch `codex/fuji-market`)
- Agent instructions: https://market-fuji.bflabs.app/skill.md
- Evidence: `docs/evidence/fuji-market-x402-2026-10-07.json`
- Provider agent 253: https://testnet.snowtrace.io/address/0x8004A818BFB912233c491871b3d84c89A494BD9e

## 边界与未完成

- 验收范围是两次付费调用（一个 buyer 钱包、一个 provider agent）。不是压测、不是多服务商、不是主网。
- Permit2 授权和付费调用是两笔交易；授权是每个代币一次性的链上写入，不是原子分佣。
- provider 已在链上注册，但目录里仍是 pending 审核状态；上架审核策略是后续阶段。
- 这个 Fuji 部署只收 x402，不跑 Settlement 出款 worker，因此伙伴中心的佣金出款流程不在本次范围内。
- 平台抽成、第三方服务商上架、AA 智能合约钱包、主网均未实现。
- 测试资金无实际价值。

## 参考：同一套代码的第二条链

`market.bflabs.app` 是同一套代码在 BOT Chain 测试网（chain 968）上的部署，有独立的 Worker、账本和签名器。它证明结算层与链解耦：换链只改一个网络 profile 和一个部署配置，产品代码不变。这也解释了为什么 Fuji 接入没有部署任何合约。
