---
half_life: 14d
archive_at: 2026-10-26
artifact_mode: delivery-doc
scope_type: phase
scope_name: bf-market-phase1-botchain
coverage: BF Market 第一阶段在 BOT Chain 上完成推广佣金自动结算、Agent 用 x402 按次付费并给推荐人分佣、公开记录页，以及主网小额真实出款的交付顺序、验收证据和审批关口
not_complete_for: 多商家入驻、商家自助上架、ERC-8004 身份、ERC-8183 任务托管、智能钱包授权、收款时原子分账、退款政策变更、自建 L1、BeefAPI 生产订单全量接入
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
acceptance_memory_id: 371ceda2-ca76-4c8f-b482-7320ebe11a13
memory_asserted_by: agent:cursor
memory_confirmed_by: human:ender
memory_intended_for: bf-market,botchain
memory_validity: current
memory_valid_from: 2026-09-26
memory_review_due: event:m2-start
---

# BF Market 第一阶段：BOT Chain 落地计划

2026-09-26 起草；同日 Ender 确认了范围和文末三项决定。

## 一句话目标

BeefAPI 海外版的推广佣金能在 BOT Chain 上用 USDT 自动结算；Agent 能在 BOT Chain 上按次购买 BeefAPI 的能力，推荐它的人或 Agent 自动拿到分成；每一笔都有公开、可核验的记录。

这一阶段完成的是平台「钱」的部分和第一笔 Agent 交易，不等于平台已经上线。多商家和服务目录属于第二阶段。

## 为什么是这个范围

- 业务重心是帮 BeefAPI 海外版通过推广者拿到付费客户。链是结算通道和生态资源。
- BOT Chain 生态扶持看重真实用户、真实交易和留在链上的稳定币。推广佣金出款每次都是一笔真实 USDT 转给真实地址，商家预存的出款资金留在链上，而且按周或按月持续发生。
- 对接人重视 Agent 方向。现有 x402 收款代码可以复用，不需要新建身份、任务或钱包体系。

## 事实依据

- 现有成果：本仓库已在 Avalanche Fuji 跑通「x402 收 10 测试 USDC → 冻结 10% 佣金 → Settlement 合约出款 1 测试 USDC → 回写 BeefAPI 测试账本」，证据见 `docs/evidence/fuji-acceptance-2026-09-18.json`。这是两笔交易，不是收款时原子分账。
- BOT Chain 只读实测（2026-09-26）：
  - 测试网链 ID 968、主网链 ID 677；USDT 为 6 位小数。
  - USDT（测试网 `0x75edC933…0fe3`，主网 `0xaBabc7Dd…7a3C`）**不支持** EIP-3009 和 EIP-2612 permit。
  - 两条网都已部署 Permit2（`0x0000…8BA3`，9152 字节）和 x402 官方 Permit2 代理（`0x4020…0001`，2913 字节）。
  - 对接人给的主网 gas：`0x28172e0d973fFf24651B6Ed4cA6d1007bc168C94` 收到 3 BOT（交易 `0x8a636f33…d2c5`），尚未花费；该地址测试网余额为 0。
- 项目内 `@x402/evm@2.26.0` 自带 Permit2 付款实现；当前 `src/x402/validate.ts` 只放行 EIP-3009，`contracts/Settlement.sol` 构造函数只允许 Fuji 和本地链。
- 桥出限制（官方文档）：BOT Chain 桥出手续费 0.1%，最低 1 USDT，单笔需大于 10 USDT。

## 不做什么

ERC-8004 身份注册、ERC-8183 任务托管、自研智能钱包或 session key、收款时原子分账、多商家资金隔离、退款规则改动、自建 L1、把 BeefAPI 生产订单全量接入。旧 KTrace 代码只作展示和参考，不迁入。

## 里程碑

### M1：链配置通用化（本地，无链上写入）

- 把写死的 `43113 | 31337` 改成网络配置：Fuji 43113、BOT Chain 测试网 968、BOT Chain 主网 677、本地 31337。每个网络固定 RPC、浏览器、USDT 地址与精度、Permit2 与代理地址。
- 启动时校验 RPC 链 ID、USDT 合约代码和精度，不一致就拒绝启动。
- `Settlement.sol` 构造函数改成按链 ID 白名单校验代币地址。主网部署另走 M6 的关口。
- 不同网络使用各自的数据库与账本，避免 Fuji 与 BOT Chain 记录混写。

### M2：BOT Chain 测试网佣金出款

- 领取测试 BOT（水龙头每 24 小时 10 个，需要人工验证码）。
- 取得测试 USDT：TRON Nile 水龙头领 Nile USDT，经 BOT Chain 测试网跨链桥转入。
- 部署 Settlement 合约，存入测试 USDT，用 BeefAPI 测试账本跑完整出款：冻结 → 签名 → 广播 → 确认 → 回写。
- 复跑 Fuji 已有的异常验收：重复出款、重启恢复、回写失败、资金不足、暂停。

### M3：Agent 用 x402 按次付费并分佣（测试网）

- 付款方式改为 Permit2：付款钱包先对 Permit2 做一次性 `approve`（要付少量 BOT gas），之后每次付款只需签名。
- BOT Chain 没有第三方结算服务，x402 结算在服务进程内自托管，由专用结算钱包付 gas，与佣金出款钱包分开。
- 上架一个真实可用的 BeefAPI 能力作为付费接口，付款确认后返回真实结果。
- 请求可携带推荐码；付款确认后按商家比例冻结佣金，走 M2 的出款流程付给推荐人。推荐人可以是人或 Agent 的收款地址。
- 验收一次「Agent 付款 → 拿到结果 → 推荐人收到佣金」，外加超时、重复请求、签名无效等异常情况。

### M4：公开记录页

- 公开页面列出 BOT Chain 上的每笔收款与佣金出款：时间、金额、用途、浏览器链接。地址默认只显示首尾几位。
- 每月统计：出款笔数、出款金额、收款地址数、Agent 付费调用次数。
- 页面沿用海外站设计，符合用户可见文字规则，桌面和手机宽度都没有横向溢出。

### M5：服务目录与 MCP 入口

- 把 M3 的付费能力放进公开目录，并提供 MCP 入口，让外部 Agent 自己搜到、付款、拿到结果。
- 已确认放进第一阶段。可复用旧 KTrace 的服务发现与 MCP 思路，但在本仓库重新实现，不搬旧代码。

### M6：主网小额真实出款（需单独批准）

- 用对接人给的 3 BOT 付 gas，部署主网出款合约，由商家存入经批准上限的 USDT。
- 给经批准的真实推广者出一笔小额佣金，核对链上记录与账本一致。
- 主网合约部署前需再做一次独立审查。

## 验收

| 验收项 | 证据等级 | 证据 | 状态 | 说明 |
|---|---|---|---|---|
| 未知网络、链 ID 不符、USDT 精度不符时拒绝启动 | local | 新增测试用例 + `bun run verify` | pending | M1 |
| Fuji 既有测试全部继续通过 | local | `bun run verify` | pending | M1，防止改坏已有成果 |
| 测试网佣金出款到账且账本回写一致 | real-smoke | 测试网交易哈希、合约 Paid 事件、账本记录，存入 `docs/evidence/` | requires approval | M2，部署和领币属外部写入 |
| 重复出款、重启、回写失败、资金不足、暂停均不重复付款也不误报成功 | local + real-smoke | 本地测试 + 测试网复跑记录 | pending | M2 |
| Agent 用 Permit2 付款后拿到真实 BeefAPI 结果 | real-smoke | 付款交易、返回结果摘要、日志 | requires approval | M3 |
| 推荐人按比例收到佣金，同一付款只计一次 | real-smoke | 付款交易与佣金出款交易的对应关系 | requires approval | M3 |
| 签名无效、超时、重复请求不扣款或不重复计佣 | local | 测试用例 | pending | M3 |
| 公开记录页数据与链上一致，1440 与 390 宽度无溢出 | dev | 浏览器截图 + 逐笔对账 | pending | M4 |
| 外部 Agent 通过目录或 MCP 找到付费能力并完成购买 | real-smoke | MCP 调用记录、付款交易、返回结果 | requires approval | M5 |
| 低于 20 USDT 的佣金不出款，累计达到后才出款 | local | 测试用例 | pending | M6 前必须通过 |
| 主网小额出款到账，金额与收款人与批准一致 | prod | 主网交易哈希、账本记录 | requires approval | M6 |

测试替身和本地链结果只能证明代码行为，不能算作 BOT Chain 集成通过。

## 审批关口

以下每一项都要 Ender 在当时明确批准，不能因为本计划被确认就自动执行：

1. 测试网合约部署、领水龙头、跨链桥转入（M2）。
2. 测试网付费接口对外开放（M3）。
3. 公开记录页上线到公网（M4）。
4. 主网合约部署、存入资金的上限、收款推广者和出款金额（M6）。
5. 任何私钥只放在受控进程环境，不进仓库、不进聊天、不进前端。

## 停止条件

- USDT 或 Permit2 在测试网实测行为与只读检查不一致：停下，重新评估付款路线。
- 任一出款出现重复付款或账本与链上不一致：暂停出款，先查清再继续。
- 测试网 RPC 或跨链桥连续不可用超过一天：记录并告知 Ender，先做不依赖链的部分。

## 已确认的决定（2026-09-26，Ender）

1. **服务目录与 MCP 入口（M5）放进第一阶段**，让对接人看到 Agent 自己找服务、付款、拿结果的完整过程。
2. **主网最低出款金额 20 USDT**：未达到的佣金继续累计，达到后再出款。原因是桥出到其他链最低收 1 USDT 手续费，且单笔需大于 10 USDT。
3. **对外定位以 EVM 链为主**：BF Market 支持主流 EVM 链，BOT Chain 与 Avalanche 为首批结算网络。仓库路线图里以 Avalanche 自建 L1 为主的说法，改成可选项。

仍按默认处理、实施时再报告的事项：测试网给演示 Agent 预存少量测试 BOT 用于 Permit2 一次性授权；主网是否补贴 Agent 的 gas，到 M6 前再定。

## 记忆交接

确认的范围、验收和关口已写入 nmem，项目空间 `default`，标签 `bf-market`、`botchain`、`phase1`，编号 `371ceda2-ca76-4c8f-b482-7320ebe11a13`。
