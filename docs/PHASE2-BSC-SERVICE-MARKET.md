---
half_life: 7d
archive_at: 2026-10-31
artifact_mode: delivery-doc
scope_type: phase
scope_name: phase2-bsc-agent-market-alignment
coverage: BeefAPI 生产服务上架（Grok/生图/视频/TTS）、Responses API 协议升级、BSC 主网接入与 Permit2 结算、链上可信健康度看板、统一自省规范及 BNB Chain Grant 申报准备
not_complete_for: Solana SVM 支付流、多服务商撮合分佣结算（Settlement Payouts）、主网去中心化 Facilitator 节点网络
verification_level: real-smoke
real_smoke_status: required
review_status: reviewed
reviewer: human
review_command: bun run verify && bun scripts/agent-pay-demo.ts --network bsc-testnet
review_notes: Phase 2 优化方案由 delivery-planner 依据实机实测与生产数据制定
review_owner: Ender
review_due: 2026-10-16
execution_backend: direct
lead_agent: current
peer_agents: none
builder_agent: current
verifier_agent: current
verification_independence: self_checked
cwf_decision: not_applicable
cwf_trigger_boundary: none
goal_handoff: none
acceptance_contract_status: proposed
memory_required: true
memory_space: default
acceptance_memory_id: pending
memory_asserted_by: agent:antigravity
memory_confirmed_by: human:Ender
memory_intended_for: bf-market, beefapi, bsc-ecosystem
memory_validity: proposed
memory_valid_from: 2026-10-09
memory_review_due: 2026-10-31
---

# BF Market Phase 2: Web2 竞品对齐与 BSC 商业化交付计划

## 1. 背景与目标

### 1.1 现状与差距
通过实机查验 BeefAPI 生产宿主机（43.159.171.118）与数据库日志，确认上游已完全具备并常态化运行 **Grok 4.7（X 实时搜索）、GPT-Image-2.5（生图）、Seedance 2.0/Wan 3.0（视频生成）、MiniMax 2.8（语音合成）** 等能力。但当前 BF Market（`bf-market`）仅上架了 5 个初级服务（echo + 3 个 LLM + 1 个 Gemini 视频审片），且仅跑在 Fuji / BOT Chain 测试网。

同时，Web2 竞品 Monid 凭借统一 `discover`、统一 `inspect` 和动态健康度在开发者社区迅速起量。

### 1.2 核心目标
1. **上游协议升级**：实测验证 OpenAI Responses API（`/v1/responses`）比 `/v1/chat/completions` 时延低 25%、直出微美分成本与起止时间戳，将其作为首选 Deliverer 通路。
2. **自营供给矩阵上线**：上架 Grok 4.7（X 实时搜索）、GPT-Image-2.5 生图、Seedance 视频生成和 MiniMax 语音合成，形成“生成 + 审片”的闭环。
3. **链上真实履约健康看板**：利用数据库真实 `service_payments` 产生可验证时延、24h 成功率和 BscScan Tx 证据流，对齐并超越 Web2 中心化打点。
4. **公链转向 BSC（BNB Chain）**：避开 Base 的红海与亲儿子垄断，接入 BSC 主网与测试网（复用 BSC 官方 Permit2 `0x000000000022d473030f116ddee9f6b43ac78ba3`），沉淀真实消费数据，冲击 BNB Chain MVB 加速器与生态 Grant。

---

## 2. 详细技术方案 (SPEC)

### 2.1 上游通路重构：接入 Responses API
实测数据对比（模型：`grok-4.7`）：
- `/v1/chat/completions`：耗时 4.04s，标准 choice 返回，无官方直出精确计费。
- `/v1/responses`：耗时 3.12s（提速 23%），返回结构自带 `created_at`、`completed_at`，`usage.cost_in_usd_ticks`（微美分精确定价），以及推理与消息分块。

**设计**：
在 `src/llm.ts` 中新增 `callResponsesApi`：
- 请求体：`{ model, input: string | array, max_output_tokens, tools? }`
- 响应解析：读取 `usage.cost_in_usd_ticks` 直接对账，以 `completed_at - created_at` 记录实际模型用时。
- 容错：当上游模型未配置 responses 路由时，自动回退到 `/v1/chat/completions`。

### 2.2 新增 4 类服务 Deliverer
在 `src/services/` 中实现模块化交付器：

1. **`llm-grok-4-7`（X / Twitter 实时搜索）**：
   - 协议：x402 `upto` 模式，最高报价 0.02 USDT，按实际 Token 扣费。
   - 输入：OpenAI messages 格式或简单 prompt。
   - 卖点：免买 \$100/月 Twitter 官方 API，按次低成本获取实时推文舆情。
2. **`image-gpt-image-2-5`（AI 生图）**：
   - 协议：x402 `exact` 固定价，定价 0.20 USDT/张。
   - 接口：调用 BeefAPI `POST /v1/images/generations`，返回图片下载 URL。
3. **`video-seedance-2-0` / `video-wan-3-0`（视频生成）**：
   - 协议：x402 `exact` 固定价，Wan 3.0 定价 0.05 USDT/条，Seedance 定价 0.15 USDT/条。
   - 接口：调用 BeefAPI `POST /v1/videos` 提交任务，异步轮询直到完成，返回 MP4 URL。
   - 闭环：产出视频可直接送入现有的 `video-gemini-3-8-flash` 审片服务质检。
4. **`speech-minimax-2-8`（语音合成）**：
   - 协议：x402 `exact` 或 `upto` 按字数计费，定价 0.01 USDT/千字。

### 2.3 链上履约健康看板（On-chain Health）
在 `src/discovery.ts` 和 `src/server.ts` 中增加健康度计算引擎：
- 聚合最近 100 笔支付数据（`service_payments`）：
  - P50 / P90 交付时延（`updated_at - created_at`）；
  - 24 小时成功率（`delivered` / (`delivered` + `failed`)）；
  - 最近 5 笔已结算的 BscScan / Snowtrace 交易哈希。
- 对外输出标准：在 `/discovery/resources`、`GET /api/services/{id}/inspect` 和前端页面同步暴露。

### 2.4 BSC（BNB Chain）多链 Profile
在 `src/network.ts` 中注册 `bsc` 和 `bsc-testnet`：
- ChainId: 56（主网）、97（测试网）；
- Permit2: `0x000000000022d473030f116ddee9f6b43ac78ba3`（BSC 官方部署同址）；
- Asset: BSC USDT `0x55d398326f99059fF775485246999027B3197955`、USDC `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`；
- Explorer: `https://bscscan.com`。

---

## 3. 验收矩阵 (Acceptance Matrix)

| Criterion | Evidence level | Test or manual evidence | Status | Notes |
|---|---|---|---|---|
| **Responses API 通路验证** | real-smoke | `bun test tests/llm-responses.test.ts` & 实际调用 Grok 4.7 验证耗时与 ticks | pending | 确保比 chat.completions 延迟更低且对账准确 |
| **Grok 4.7 服务上架** | real-smoke | 通过 x402 签单调用 `llm-grok-4-7`，验证 X 实时搜索能力与 upto 扣款 | pending | 输出包含实时推文信息且链上正确扣除实际 token 对应金额 |
| **生图模型交付** | real-smoke | 通过 x402 签单调用 `image-gpt-image-2-5`，成功返回合法图片 URL | pending | 验证生成图片格式、可访问性及 exact 扣费 |
| **视频生成与审片闭环** | real-smoke | 调用视频生成，拿到 MP4 URL 后自动传给 `video-gemini-3-8-flash` 完成一次审片 | pending | 形成平台内自闭环商业消费流 |
| **链上履约健康度看板** | dev | `GET /discovery/resources` 返回 `health` 字段（包含 P50 延迟、成功率、最近 5 笔 Tx 证明） | pending | 网页 Market 页面正确渲染健康度徽标与 BscScan 链接 |
| **BSC 测试网/主网链上结算** | real-smoke | 在 BSC 测试网或主网完成一次真实的 Permit2 代币划转与 receipt 生成 | pending | 链上交易在 BscScan 可查，平台 ops 代付 Gas 正常 |
| **BNB Chain Grant 申报材料** | docs-only | 产出《BSC AI Agent 商业微支付基础设施申报白皮书与真实数据指标》 | pending | 包含真实调用量、Gas 消耗与生态定位 |

---

## 4. 实施阶段与排期 (Phases & Milestones)

### Phase 2.1: 协议与供给升级（2天）
- [ ] 改造 `src/llm.ts`，支持 Responses API 并完成 Grok 4.7 接入；
- [ ] 实现 `image-gpt-image-2-5`（`/v1/images/generations`）与 `video-wan-3-0` 交付器；
- [ ] 在 `src/services.ts` 注册新服务并补充完整的 input/output schema。

### Phase 2.2: 链上健康看板与 Inspect 规范（2天）
- [ ] 在数据库中补齐时延聚合指标统计函数；
- [ ] 实现 `GET /api/services/{id}/inspect`；
- [ ] 更新前端 Market 列表页，渲染“真实链上履约凭据”卡片。

### Phase 2.3: BSC 网络接入与线上实跑（2天）
- [ ] 在 `src/network.ts` 配置 `bsc-testnet` 与 `bsc`；
- [ ] 部署测试网 Worker，执行一次全流程实测（Grok 搜索 + 视频生成 + 审片）；
- [ ] 收集 evidence 证据日志。

### Phase 2.4: 生态 Grant 包装与发布（1天）
- [ ] 梳理 BSC 上线证据文件与演示视频；
- [ ] 提交 BNB Chain MVB / AI Ecosystem Grant 申请。
