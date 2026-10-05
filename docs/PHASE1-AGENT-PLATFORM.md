---
half_life: 14d
archive_at: 2026-11-05
artifact_mode: delivery-doc
scope_type: phase
scope_name: bf-market-phase1-agent-platform
coverage: BF Market 第一阶段（Agent 商业平台）在 BOT Chain 测试网 968 上跑通一条闭环：人或 Agent 链上注册（自部署 ERC-8004 注册表）→ 服务目录或 MCP 找到服务 → x402 Permit2 自托管结算付款 → 拿到真实 BeefAPI 服务结果 → 收据；含交付顺序、验收证据与审批关口
not_complete_for: 推广分佣、Settlement 出款、ERC-8183 任务托管、智能钱包或 session key、平台抽成、多商家资金隔离、ReputationRegistry、主网、官方 0x8004 地址迁移
verification_level: docs-only
real_smoke_status: requires_approval
review_status: not_reviewed
reviewer: none
review_command: skipped: 计划文档，范围与决定已由 Ender 当面确认
review_notes: 实施中每个里程碑的代码改动按仓库规则做独立审查
review_owner: Ender
review_due: 进入 M2 之前
execution_backend: direct
lead_agent: current
peer_agents: none
builder_agent: none
verifier_agent: none
verification_independence: self_checked
cwf_decision: not_needed
cwf_trigger_boundary: none
goal_handoff: none
acceptance_contract_status: owner-confirmed
memory_required: true
memory_space: default
acceptance_memory_id: c8d727a3-85f6-4f16-8489-5fa266f4cd44
memory_asserted_by: agent:devin
memory_confirmed_by: human:ender
memory_intended_for: bf-market,agent-platform,botchain
memory_validity: current
memory_valid_from: 2026-10-05
memory_review_due: event:m1-start
---

# BF Market 第一阶段：Agent 商业平台落地计划

2026-10-05 起草；同日 Ender 确认了定位、范围、文末九项决定与本计划。

**本文件取代 `docs/PHASE1-BOTCHAIN.md` 的范围。** 旧文件保留作参考。推广佣金自动结算与 Settlement 出款移到后续阶段，不在本阶段。

## 一句话目标

人和 Agent 都能在 BOT Chain 测试网 968 上注册身份、找到 BeefAPI 的服务、用 x402 付款、拿到真实结果，并留下一笔可核验的收据——先跑通这一条闭环。

## 为什么是这个范围

- 定位是「任何 EVM 链都能用的 Agent 商业平台」：一个平台、多条结算链。BOT Chain 是第一条链，BeefAPI 是第一个服务商。
- 第一阶段只验证一件事：Agent 能不能自己发现服务、付款、拿到结果。分佣、出款、托管先不铺开。
- 付款合约不必自建：968 上已有 Permit2 与 x402 Permit2 代理，`@x402/evm@2.26.0` 自带 Permit2 实现（`package.json:25`）。要自建的只有进程内结算服务。
- 官方 ERC-8004 在 968 不可用，自部署依赖最少，而且我们保留 owner。

## 事实依据

链上只读核验（2026-10-05）：

- BOT Chain 测试网链 ID 968，RPC `https://rpc.bohr.life`，浏览器 `https://scan.bohr.life`。水龙头 `https://faucet.botchain.ai/basic`，每地址每 24h 10 tBOT，需人工验证码。
- 测试 USDT `0x75edC9335175fc0552d51d48439f229c10420fe3`，6 位小数，**不支持** EIP-3009 与 EIP-2612。获取路径：TRON Nile 水龙头领 Nile USDT，经 BOT Chain 测试网跨链桥转入（需 Ender 人工）。
- 968 上已只读确认存在：Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`（9152 字节）、x402 Permit2 代理 `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`（2913 字节）、Arachnid CREATE2 部署器 `0x4e59b44847b379578588920cA78FbF26c0B4956C`。
- ERC-8004 官方地址在 968 上均无代码。官方 `0x8004…` 地址依赖 Safe Singleton Factory `0x914d7Fec…`，968 上不存在且需 Safe 团队签名部署；官方 MinimalUUPS 把 owner 硬编码为 `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`，同址复现也无控制权。

项目内事实（影响改动范围）：

- 当前配置只允许本地 31337 与 Fuji 43113：`src/config.ts:29`、`src/config.ts:239`、`src/config.ts:351`、`src/chain.ts:49`、`src/chain.ts:65`。
- x402 校验只放行 EIP-3009：`src/x402/validate.ts:80`（显式拒绝 `permit2Authorization`）、`src/x402/validate.ts:120`（`assetTransferMethod` 只允许 `eip3009`）。
- 多处把链 ID 写死为 43113：`src/x402/validate.ts:202`（EIP-712 domain）、`src/x402/verify.ts:58`、`src/x402/service.ts:189`、`src/x402/service.ts:321`。
- 收据核验依赖 EIP-3009 的 `AuthorizationUsed` 事件加相邻 `Transfer`：`src/x402/verify.ts:17`、`src/x402/verify.ts:37`。Permit2 路径没有该事件，必须另写核验。
- 现有 x402 流程绑定测试订单与佣金：`src/x402/service.ts:88`（`source.listOrders`）、`src/x402/service.ts:340`（`awardOrder`）。本阶段「付费接口无需登录」需要与佣金解耦的新路径。
- 付费路由目前仍需会话：`src/server.ts:645` 经 `requireMutation` 走会话校验；`src/server.ts:203` 的免登录白名单不含 x402 路由。
- 钱包签名身份已有可复用实现（EIP-191 挑战 + 恢复）：`src/auth.ts:214`、`src/auth.ts:254`。
- 结算链适配器对 Fuji 用 finalized 区块，本地链用 canonical：`src/chain.ts:211`。
- agent-service 的 `WriteGate` 当前是 deny-all（`src/security/writeGate.ts:44`）；`MAX_UNAPPROVED_VERIFICATION_LEVEL` 为只读估算（`src/kernel/verification.ts:11`）。我们只借思路，不搬实现。

## 不做什么

推广分佣、Settlement 出款引擎、ERC-8183 任务托管、自研智能钱包或 session key、平台抽成、多商家资金隔离、ReputationRegistry、主网、官方 `0x8004…` 地址迁移。旧 KTrace 合约（各链）与 BOT 主网 677 上的 Settlement/KTrace 部署本阶段不接入、不引用；Settlement 出款引擎保留供后续推广分佣阶段复用。`agent-service` 与 `kite-trace-platform` 只读参考，不再修改。

## 闭环步骤

| 步骤 | 人（看到/做什么 · 平台做什么） | Agent（看到/做什么 · 平台做什么） |
|---|---|---|
| 1 注册（链上） | 看到网页「连接钱包」并点注册；钱包弹出交易，确认后看到自己的 agentId 与档案。平台提供连接与注册入口，发启动 gas，记录 agentId 与档案。 | 调 API/MCP 得到待签注册交易或指引；用自己钱包签名广播，读回 agentId。平台返回待签交易或指引，发启动 gas，记录 agentId。 |
| 2 找服务 | 在服务目录看到 BeefAPI 的服务与价格，或直接问咨询 Agent。平台输出与 x402 Bazaar `/discovery/resources` 兼容的目录。 | 通过 MCP 或目录接口搜到服务，拿到价格与付款要求。平台返回服务清单与 x402 付款要求。 |
| 3 x402 付款 | 首次对 Permit2 做一次 approve（付少量 gas），之后每次只签名。平台自托管结算，用 ops 钱包付结算 gas。 | 对 Permit2 授权后签 x402 付款授权，提交。平台在进程内 verify/settle，钱直接到 BeefAPI 收款地址。 |
| 4 拿真实结果 | 页面直接显示 BeefAPI 返回的真实结果。平台用自己的 BeefAPI key 调用并把结果返回。 | 收到真实结果 JSON。平台确认付款后调用 BeefAPI 并返回结果。 |
| 5 收据 | 在「我的记录」看到每笔调用、金额与交易链接。平台把收据与链上交易对应保存。 | 拿到带交易哈希的收据。平台返回并持久化收据。 |

## 里程碑

### M1：网络配置通用化（本地，无链上写入）

- 借 agent-service 的链 profile 隔离思路：按链作用域的 profile 与指纹（对应 `src/chain/profile.ts:14`、`src/chain/profile.ts:342`），新增 968 profile（RPC、浏览器、USDT 与精度、Permit2、x402 代理、CREATE2 部署器）。借 `AssetAmount` 思路：金额用 `bigint` + 显式精度 + 链作用域资产标识（`src/money/amount.ts:62`）。借 `WriteGate` 的 fail-closed 写闸门思路（`src/security/writeGate.ts:19`）。
- 不同网络使用独立数据库（`dbPath` 按链 ID/指纹命名空间），避免 Fuji 与 968 记录混写。
- 启动校验：RPC 链 ID、USDT 合约代码与精度、Permit2 与 x402 代理代码存在，不一致就拒绝启动。
- 交付物：`src/config.ts`、`src/chain.ts`、`src/x402/*` 的链参数化；新增 profile 模块与测试。
- 完成标准：`bun run verify` 通过；未知网络、链 ID 不符、USDT 精度不符、Permit2 或代理缺代码时拒绝启动。

### M2：身份注册表部署到 968

- 采用 ERC-8004 官方 IdentityRegistry 源码（`erc-8004/erc-8004-contracts`，IdentityRegistryUpgradeable v2.0.0），以「实现 + ERC1967Proxy」部署到我们自己的地址，我们做 owner（方案 B）。
- 需要的最小源码改动：实现里 `initialize()` 是 `reinitializer(2)` `onlyOwner`，部署需改为 owner=部署者或两步初始化。此改动单独审查。
- 注册接口：`register(string agentURI)` `0xf2c298be`、`register()` `0x1aa3a008`、`register(string,MetadataEntry[])` `0x8ea42286`；事件 `Registered(uint256 indexed agentId,string agentURI,address indexed owner)`。注册由用户/Agent 自己的钱包发交易。ReputationRegistry 本阶段不部署。
- 平台记录 agentId 与档案 agentURI；档案 JSON 由平台托管。
- 并行（非阻塞）：经 BOT Chain 对接人推动 Safe Singleton Factory 上 968/677，并邮件 `team@8004.org` 申请官方部署；之后可迁移到官方地址。
- 交付物：`contracts/` 新增注册表源码、部署脚本与测试；968 部署交易与读回。
- 完成标准：本地/分叉测试通过；968 部署（需 Ender 批准）后读回 owner、实现地址、agentId 自增，且注册事件与 agentId 一致。

### M3：注册流程

- 人：网页连接钱包，发起注册交易，看到 agentId 与档案。
- Agent：API/MCP 返回待签注册交易或指引，Agent 用自己的钱包签名广播。
- 启动 gas 发放：平台在测试网给新注册钱包发少量 tBOT（覆盖 register + Permit2 approve），设上限与防刷（每地址一次、每日总额上限、总开关）。
- 交付物：注册路由/API、启动 gas 服务、注册页与测试。
- 完成标准：无 gas 新钱包拿到启动 gas 且不可重复领取；注册交易与 agentId 读回一致。

### M4：x402 Permit2 自托管结算

- x402 v2 exact scheme 改走 Permit2（`@x402/evm` 自带实现），替换现有 EIP-3009-only 校验与核验（`src/x402/validate.ts:80`、`src/x402/verify.ts:37`），并去掉写死的 43113。
- BOT Chain 无第三方 facilitator：结算服务在本服务进程内自托管，由专用 ops 钱包付 gas，与佣金出款钱包分开。买家首次对 Permit2 做一次 approve。
- 钱的流向：买家 USDT 直接到 BeefAPI 收款地址；平台只付结算 gas；平台抽成后续再加。
- 无需登录的付费接口：钱包签名即身份，复用 `src/auth.ts` 的挑战/恢复思路。
- 交付物：进程内 facilitator（实现 `X402Facilitator`）、Permit2 payload 校验、Permit2 路径的 receipt 核验、免登录付费路由。
- 完成标准：签名无效、超时、重复请求、余额或授权不足都不扣款；同一付款只交付一次。

### M5：BeefAPI 第一个服务

- 选一个真实能力（例如按次调用一个模型）；平台用自己的 BeefAPI key 调用并返回结果；BeefAPI 作为服务商身份注册。
- 交付物：服务定义、上游 BeefAPI 调用、定价。
- 完成标准：付款确认后返回真实结果；调用失败不交付、不计成功。

### M6：服务目录 API + MCP + 咨询 Agent

- 服务目录 API：输出与 x402 Bazaar 扩展 `/discovery/resources` 格式兼容。
- MCP 入口：让外部 Agent 自己搜到、付款、拿到结果。
- 咨询 Agent：回答平台能做什么、有哪些服务和价格，引导注册/付款；其模型调用本身向 BeefAPI 购买，作为第一笔「Agent 买服务」。
- 交付物：兼容 `/discovery/resources` 的端点、MCP server、咨询 Agent。
- 完成标准：Agent 通过 MCP 找到服务 → 付款 → 拿到真实结果。

### M7：收据与「我的记录」页

- 每笔调用记录时间、金额、交易链接；沿用海外站设计，1440 与 390 宽度无横向溢出。
- 交付物：收据记录与前端页。
- 完成标准：收据与链上一致；截图验收。

**顺序说明：** M1 是所有后续工作的前提。之后 M2/M3（注册线）与 M4/M5（付款线）互不依赖，可并行推进，闭环在 M6 汇合。M4 的测试网实测需要 M5 提供真实能力，两者作为一对验收。

## 验收

| 验收项 | 证据等级 | 证据 | 状态 | 里程碑 |
|---|---|---|---|---|
| 未知网络、链 ID 不符、USDT 精度不符、Permit2 或代理缺代码时拒绝启动 | local | 新增测试用例 + `bun run verify` | pending | M1 |
| Fuji 既有测试全部继续通过 | local | `bun run verify` | pending | M1 |
| 968 注册表部署后 owner、实现地址、agentId 自增读回一致 | real-smoke | 部署交易、读回结果，存入 `docs/evidence/` | requires approval | M2 |
| 注册交易与 agentId 读回一致 | real-smoke | 注册交易哈希、`Registered` 事件、库内记录 | requires approval | M3 |
| 无 gas 新钱包拿到启动 gas 且不可重复领取 | dev | 测试用例 + 测试网发放记录 | pending | M3 |
| 签名无效、超时、重复请求不扣款 | local | 测试用例 | pending | M4 |
| 余额或授权不足不扣款 | local | 测试用例 | pending | M4 |
| 付款确认后拿到真实 BeefAPI 结果 | real-smoke | 付款交易、返回结果摘要、日志 | requires approval | M4/M5 |
| 同一付款只交付一次 | local + real-smoke | 测试用例 + 测试网复跑记录 | pending | M4/M5 |
| Agent 通过目录或 MCP 找到服务 → 付款 → 拿到真实结果 | real-smoke | MCP 调用记录、付款交易、返回结果 | requires approval | M6 |
| 收据与链上一致，1440 与 390 宽度无溢出 | dev | 浏览器截图 + 逐笔对账 | pending | M7 |

测试替身和本地链结果只能证明代码行为，不能算作 BOT Chain 集成通过。

## 审批关口

以下每一项都要 Ender 在当时明确批准，不能因为本计划被确认就自动执行：

1. 968 合约部署（M2）。
2. 启动 gas 发放开关与额度（M3）。
3. 付费接口对外开放（M4）。
4. 公开页面上线到公网（M7）。
5. 任何主网动作。
6. 任何私钥只放在受控进程环境，不进仓库、不进聊天、不进前端。

## Ender 需要亲自做的事

1. 水龙头领 tBOT：ops 与 buyer-demo 各一次（人工验证码）。
2. TRON Nile 领测试 USDT 并跨链到 968（给 buyer-demo）。
3. 向 BOT Chain 对接人提 Safe 工厂与 ERC-8004 官方部署（可选、非阻塞）。

测试网钱包已生成并保存在 `.local/botchain-testnet/`（git 忽略，权限 600）：ops `0x2547c1122c9aFD11eA0c4b66bb033552b90B979F`（部署注册表、付结算 gas、发启动 gas），buyer-demo `0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada`（演示买家/Agent）。私钥只放受控进程环境，不出现在文档里。

## 停止条件

- USDT 或 Permit2 在测试网实测行为与只读检查不一致：停下，重新评估付款路线。
- 同一付款被重复交付，或收据与链上不一致：暂停付费接口，先查清再继续。
- 启动 gas 被刷或无法防重复：关停发放开关。
- 测试网 RPC、水龙头或跨链桥连续不可用超过一天：记录并告知 Ender，先做不依赖链的部分。

## 未决问题

- 咨询 Agent 用哪个模型、预算多少。
- 第一个 BeefAPI 能力选哪个、如何定价。
- agentURI 档案托管在哪里，域名 `market.bflabs.app` 是否就绪。
- BeefAPI 在 968 上的收款地址（M4 前需要，由 Ender 指定）。
- 每个新钱包发多少启动 gas、每日总额上限多少（M3 审批时定）。

## 已确认的决定（2026-10-05，Ender）

1. 定位：BF Market 是「任何 EVM 链都能用的 Agent 商业平台」，形态为一个平台、多条结算链；BOT Chain 是第一条链，BeefAPI 是第一个服务商。
2. 第一阶段只跑通一条闭环：人或 Agent 注册（链上）→ 找到服务 → x402 付款 → 拿到真实服务结果 → 收据。推广分佣、Settlement 出款、任务托管、智能钱包、主网都不在本阶段。
3. 注册上链：使用 ERC-8004 官方 IdentityRegistry 源码（`erc-8004/erc-8004-contracts`，IdentityRegistryUpgradeable v2.0.0），以「实现 + ERC1967Proxy」部署到我们自己的地址，我们做 owner（方案 B）。原因：官方 `0x8004…` 地址依赖 Safe Singleton Factory `0x914d7Fec…`，968 上不存在且需 Safe 团队签名部署；且官方 MinimalUUPS 把 owner 硬编码为官方地址 `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`，同址复现也无控制权。实现里 `initialize()` 是 `reinitializer(2)` `onlyOwner`，部署需改为 owner=部署者或两步初始化——写为「需要的最小源码改动，单独审查」。注册接口：`register(string agentURI)` `0xf2c298be`、`register()` `0x1aa3a008`、`register(string,MetadataEntry[])` `0x8ea42286`；事件 `Registered(uint256 indexed agentId,string agentURI,address indexed owner)`。注册由用户/Agent 自己的钱包发交易。ReputationRegistry 本阶段不部署。并行（非阻塞）：经 BOT Chain 对接人推动 Safe Singleton Factory 上 968/677，并邮件 `team@8004.org` 申请官方部署，之后可迁移到官方地址。
4. 首跑网络：BOT Chain 测试网 968（RPC `https://rpc.bohr.life`，浏览器 `https://scan.bohr.life`，水龙头 `https://faucet.botchain.ai/basic` 每地址每 24h 10 tBOT，需人工验证码）。测试 USDT `0x75edC9335175fc0552d51d48439f229c10420fe3`（6 位小数，不支持 EIP-3009 与 EIP-2612），获取路径为 TRON Nile 水龙头领 Nile USDT 经 BOT Chain 测试网跨链桥转入（需 Ender 人工）。968 上已只读确认存在：Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`（9152 字节）、x402 Permit2 代理 `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`（2913 字节）、Arachnid CREATE2 部署器 `0x4e59b44847b379578588920cA78FbF26c0B4956C`；ERC-8004 官方地址均无代码。
5. 付款：x402 v2 exact scheme 改走 Permit2（`@x402/evm` 自带实现）；BOT Chain 无第三方 facilitator，结算服务在本服务进程内自托管，由专用 ops 钱包付 gas。买家首次需对 Permit2 做一次 approve。钱的流向：买家 USDT 直接到 BeefAPI 收款地址，平台只付结算 gas；平台抽成后续再加。
6. 入口：服务目录 API（输出与 x402 Bazaar 扩展 `/discovery/resources` 格式兼容）、MCP 入口、咨询 Agent（回答平台能做什么、有哪些服务和价格，引导注册/付款；其模型调用本身向 BeefAPI 购买，作为第一笔「Agent 买服务」）。付费接口无需登录，钱包签名即身份。
7. 新钱包启动 gas：平台在测试网给新注册钱包发少量 tBOT（覆盖 register + Permit2 approve），需设上限与防刷（每地址一次、每日总额上限）。
8. 测试网钱包已生成并保存在 `.local/botchain-testnet/`（git 忽略，权限 600）：ops `0x2547c1122c9aFD11eA0c4b66bb033552b90B979F`（部署注册表、付结算 gas、发启动 gas），buyer-demo `0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada`（演示买家/Agent）。私钥不得出现在文档中。
9. 旧资产处置：KTrace 合约（各链）与 BOT 主网 677 上的 Settlement/KTrace 部署本阶段不接入、不引用；Settlement 出款引擎保留供后续推广分佣阶段复用。`agent-service` 与 `kite-trace-platform` 只读参考，不再修改。

## 记忆交接

确认的范围、验收与关口已写入 nmem，项目空间 `default`，标签 `bf-market`、`agent-platform`、`botchain`、`phase1`，编号 `c8d727a3-85f6-4f16-8489-5fa266f4cd44`。
