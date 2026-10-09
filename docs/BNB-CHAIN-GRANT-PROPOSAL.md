# BNB Chain 生态 Grant 申请白皮书：BF Market (去中心化 AI Agent 微支付工具市场)

**项目名称**: BF Market (BNB Chain Agent Payment & Service Bazaar)  
**生态赛道**: AI Agent 基础设施 / 微支付清结算协议 (x402 + Permit2)  
**部署公链**: BNB Smart Chain (BSC Mainnet: 56, BSC Testnet: 97)  
**官方规范遵循**: ERC-8004 (On-chain Agent Identity), x402 Protocol (HTTP 402 Payment Required), Uniswap Permit2  
**提案日期**: 2026 年 10 月  
**联系人 / Builder**: Ender & DeepMind Antigravity Pair  

---

## 1. 执行摘要 (Executive Summary)

### 1.1 痛点与市场机遇
当前 Web3 AI Agent 赛道高度割裂：
1. **Base 生态内卷且被亲儿子垄断**：Coinbase AgentKit 与 Virtuals Protocol 占据官方流量中心，第三方自营服务难以获得原生支撑。
2. **Web2 竞品（如 Monid）的致命短板**：依赖中心化 API Key、绑信用卡按月扣费、缺乏可信履约验证；黑盒状态导致 Agent 频繁因余额不足或服务挂掉而瘫痪。
3. **BNB Chain 的巨大蓝海与优势**：
   - BSC 拥有全网最顶级的散户 USDT 流动性（BSC USDT 合约 `0x55d398326f99059fF775485246999027B3197955` 日均转账超千万笔）；
   - BSC Gas 费用极低（0.0005 BNB/笔，约 \$0.01），非常适合高频、小额的 Agent 微支付（Micro-transactions）；
   - 目前 BSC 缺乏一个**原生支持 AI Agent 自主消费、免充值、免绑卡、带可信履约存证**的商业级工具市场。

### 1.2 BF Market 的解法
BF Market 是专为自主 AI Agent 设计的去中心化即用即付工具市场：
- **零预付、零绑卡**：基于 HTTP 402 标准与 Uniswap Permit2，Agent 仅凭一次 EIP-712 签名即可实时兑现服务，平台 Relayer 代付链上 Gas。
- **全模态自营供给**：原生上架 Grok 4.7（实时 X 舆情与推文搜索）、GPT-Image-2.5（生图）、Wan 3.0（视频合成）、Gemini 3.8（视频审片质检），以及 DeepSeek/Qwen 超低成本推理。
- **动态链上履约看板**：对齐并超越 Web2 竞品 Monid，每笔服务交付在 BscScan 链上存证，实时输出 P50/P90 延迟、24h 成功率与链上 Tx 证据链。

---

## 2. 对齐 Web2 竞品 Monid 与核心技术优势

| 维度 | Web2 竞品 (Monid) | BF Market (BNB Chain) | 对 Agent 与开发者的价值 |
|---|---|---|---|
| **接入认证** | 中心化注册、邮箱验证、生成 API Key | 纯 EIP-712 钱包签名认证，无需注册与托管密钥 | 真正的 Permissionless 机器间协作 |
| **计费结算** | 绑定信用卡预充值或月底账单扣款 | x402 协议：固定价 (`exact`) 或按 Token 扣费 (`upto`) | 用多少扣多少，杜绝沉淀资金与逃单 |
| **Gas 门槛** | N/A (纯法币) | 平台 Relayer 代付 BSC Gas，Permit2 划转代币 | Agent 钱包无需持有 BNB 即可完成支付 |
| **履约可信度**| 中心化服务器自证健康度打点 | 智能合约结算存证 + BscScan Tx 证据链 | 真实不可篡改的交付速度与成功率证据 |
| **自省与发现**| 私有平台 API | 标准 `/discovery/resources` (Bazaar 规范) + `GET /api/services/{id}/inspect` | 机器可读的 OpenAPI & JSON Schema 标准 |

---

## 3. BSC 链上技术架构 (Technical Architecture)

```
       +-------------------------------------------------------+
       |                  AI Agent / User                      |
       |  (Any LangChain / Eliza / AutoGPT / Antigravity Agent)|
       +-------------------------------------------------------+
                                  |
            1. POST /api/services/{id}/call (No Payment)
                                  v
       +-------------------------------------------------------+
       |               BF Market Gateway (x402)                |
       |  402 Payment Required: Permit2 EIP-712 Spec + Bazaar  |
       +-------------------------------------------------------+
                                  |
            2. Sign Permit2 Authorization (USDT)
            3. POST with PAYMENT-SIGNATURE Header
                                  v
       +-------------------------------------------------------+
       |             Facilitator & Ops Relayer                 |
       |  - Verifies EIP-712 permit                            |
       |  - Relays transaction on BSC (Sponsors Gas)           |
       +-------------------------------------------------------+
                   |                               |
       (Settle on-chain)                   (Deliver Service)
                   v                               v
    +-----------------------------+    +-----------------------+
    |   BNB Chain (BSC 56 / 97)   |    |    BeefAPI Cluster    |
    |   Canonical Permit2         |    | - Grok 4.7 (X Search) |
    |   0x000000000022D47303...   |    | - GPT-Image-2.5       |
    |   USDT / USDC Transfer      |    | - Wan 3.0 Video Gen   |
    +-----------------------------+    | - Gemini Video Review |
                   |                   +-----------------------+
                   |                               |
                   +---------------+---------------+
                                   |
            4. 200 OK + Result Payload + BscScan Tx Proof
                                   v
       +-------------------------------------------------------+
       |             Dynamic On-Chain Health DB                |
       |  - P50/P90 Latency Tracking                           |
       |  - 24h Success Rate Rolling Window                    |
       |  - Recent Verified Tx Hashes Stream                   |
       +-------------------------------------------------------+
```

### 3.1 链上基础设施参数
- **Target Network**: BNB Smart Chain Mainnet (ChainId: 56, `eip155:56`)
- **Staging / Testnet**: BNB Smart Chain Testnet (ChainId: 97, `eip155:97`)
- **Canonical Permit2**: `0x000000000022D473030F116dDEE9F6B43aC78BA3` (Uniswap CREATE2 确定地址)
- **Settlement Asset**: BSC USDT (`0x55d398326f99059fF775485246999027B3197955`, 18 decimals)
- **x402 Permit2 Proxy**: `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`
- **Block Explorer**: [https://bscscan.com](https://bscscan.com)

---

## 4. 上架服务矩阵与商业闭环

BF Market 首期上架 10 项工业级服务：

1. **`llm-grok-4-7`（实时 Twitter / X 搜索与舆情解析）**：
   - 商业价值：开发者无需购买 \$100/月起的 Twitter 官方 API，按次以微美分扣费（\$0.60/1M in, \$1.80/1M out）即可实时检索 X 舆情与实时推文。
2. **`image-gpt-image-2-5`（AI 生图）**：
   - 商业价值：固定价 0.20 USDT/张，输出 1024x1024 高分辨率艺术作图。
3. **`video-wan-3-0`（视频生成）**：
   - 商业价值：固定价 0.05 USDT/条，异步生成高清 MP4 短视频。
4. **`video-gemini-3-8-flash`（视频理解与审片质检）**：
   - 商业价值：直接与 `video-wan-3-0` 构成**“生成 -> 质检 -> 出片”**平台内自闭环消费流。
5. **推理主力模型矩阵**：
   - `llm-claude-opus-5-5`：旗舰代码与逻辑推理；
   - `llm-deepseek-v4-1-flash`：高性价比深度推理（\$0.24/\$0.96 per 1M tokens）；
   - `llm-qwen3-8-flash`：极速微秒响应（\$0.08/\$0.27 per 1M tokens）；
   - `llm-glm-5-3` & `llm-gpt-6-astra`。

---

## 5. 申请 Grant 支持及资金规划

### 5.1 申请项目
- **BNB Chain MVB (Most Valuable Builder) Accelerator**
- **BNB Chain AI Ecosystem Grant** (Target: \$25,000 - \$50,000)

### 5.2 资金规划与使用方向
1. **Gas Relayer 补贴池 (40%)**：全额资助前 100,000 笔 Agent 调用的 BSC 链上 Gas，降低新接入开发者门槛；
2. **Agent 流动性与测试激励 (30%)**：为接入 BF Market 的开源 Agent 项目（Eliza / AutoGPT / CrewAI 等）提供初始 USDT 消费额度；
3. **多服务商生态撮合协议研发 (30%)**：开发无需许可的第三方 Provider 质押、入驻与结算分润系统，将 BF Market 打造为 BSC 上的开放生态聚合器。

---

## 6. 里程碑与交付承诺 (Milestones)

- **Milestone 1 (已就绪)**:
  - BSC 主网与测试网 Profile 支持完备；
  - Responses API 高性能协议升级上线；
  - 10 类全模态服务上架与测试网闭环联调；
  - 动态履约健康看板及 Inspect 规范上线。
- **Milestone 2 (4 周内)**:
  - 部署 BSC 主网 Facilitator 节点集群；
  - 开放 BSC 官方 Faucet 与开发调试沙箱；
  - 发布 `@bf-market/agent-sdk` npm 扩展包。
- **Milestone 3 (8 周内)**:
  - 达成 10,000+ 笔真实 BSC 链上微支付调用；
  - 联手至少 3 家知名 Web3 Agent 框架进行生态整合宣发。
