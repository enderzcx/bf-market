# BF Market

BF Market 是一个让 AI agent 按次付费调用服务的市场，跑在 **BOT Chain 测试网**（链 968）上，线上地址 https://market.bflabs.app 。

一次调用是这样完成的：agent 拿到 `skill.md`，找到服务，请求后收到 x402 的 402 报价，签一份 Permit2 授权（`exact` 固定价，`upto` 按报价上限授权），平台按实际用量结算并出一张收据。付款用测试网 USDT，结算 gas 由平台的 ops 钱包代付；私钥不进仓库，也不进浏览器。

网站和 API 由同一个 Cloudflare Worker（`bf-market`）提供。无状态 Worker 把所有动态请求转发给唯一的 Durable Object（`ledger`），预算账本、付款幂等锁、ops 签名 nonce 和启动 gas 额度都集中在这一个对象里，因此保持串行。DO 的存储是 `ctx.storage.sql`，与 Bun 版共用同一套表结构和 SQL。

## 网站

| 路径 | 内容 |
| --- | --- |
| `/` | 首页 Home：一句话定位、可复制给 agent 的提示词、实时统计、四步流程 |
| `/market` | 市场 Market：按服务方（ERC-8004 agent）分组，列出服务、计价方式和单次报价上限，可展开看调用示例 |
| `/wallet` | 控制台 Console：连接钱包管理预算，或输入地址查看任意钱包 |
| `/wallet/0x…` | 某个付款钱包的公开摘要：今日已花、生效预算、平台限额、各服务单次报价、最近收据 |
| `/docs` | 双语文档：`skill.md`、MCP、API、预算与限额、合约地址 |
| `/records` | 跳转到控制台（`/records?payer=0x…` → `/wallet/0x…`） |
| `/partner/*` | 伙伴中心（原有功能，仅换了挂载前缀） |
| `/demo` | 静态演示页 |

全站中英双语，导航右上角切换，支持 `?lang=zh` 和 `?lang=en`，之后会记住选择。视觉是「终端琥珀」主题：暗底、等宽字体、1px 分隔线、不用阴影。旧的伙伴中心路径（`/login`、`/console`、`/progress` 等）会自动跳转到 `/partner/...`。

## 每日预算 budgets

一个付款钱包可以带一份每日预算，对**所有付费服务**生效，包括 `echo`。生效值是两者中较小的一个：

- **owner 上限**：ERC-8004 的 owner 给某个 agent 设的上限，作用在该 agent 的付款钱包上；
- **自设值**：付款钱包给自己设的值。

两者都没设时没有用户预算（`userBudget` 为 `null`）：`echo` 不限，大模型只受平台限额约束。设成 `0` 等于暂停该钱包的全部付费调用。每个值最高 5 USDT。

规则：

- 付款钱包只能设 ≤ owner 上限的值，超了返回 `The daily budget exceeds the owner's limit of <amount> USDT.`。
- owner 调低上限不会改写钱包存下来的自设值，生效值暂时降到上限；上限调高或删除后，自设值自动生效。
- 能否调用按**单次报价上限**判断：报价高于当日剩余额度的模型当天不可调用，便宜的那个仍然可以。结算后只按实际用量计费。
- 预算改动立即生效；已经在途的调用保留已预占的额度。

大模型的平台限额只统计大模型（metered/`upto`）花费：每个钱包每天 5 USDT、全平台每天 50 USDT；`echo` 没有平台限额。

改预算用两步钱包签名：`POST /api/budgets/challenge` 拿一条 EIP-191 `personal_sign` 挑战（5 分钟有效、一次性），签名后连同同样的请求体 `POST /api/budgets`。`scope` 为 `ceiling`（带 `agentId`）或 `wallet`；`dailyLimit: null` 表示删除。也可以走 MCP 的 `set_wallet_budget`（先不带 `signature` 拿挑战，再带上 `signature` 提交）。读当前状态用 `GET /api/wallets/{address}/summary`。

命令行：`bun scripts/budget-demo.ts --help` 支持 `show | set-ceiling | remove-ceiling | set-own | remove-own`，签名用 `--owner-key` / `--wallet-key` 指向环境变量名（默认 `OWNER_PRIVATE_KEY` / `AGENT_PRIVATE_KEY`），从不打印私钥。

## 本地运行（端口 4333）

先构建前端到 `web/dist`（Worker Assets 提供这些文件，不起 Vite 开发服务器）：

```sh
bun run build:web
```

方式一，本机跑 Worker（最接近线上；API + 已构建的网站都在 4333）：

```sh
./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 4333 --inspector-port 4334 \
  --persist-to /tmp/bfm-local-state \
  --env-file .secrets/beefapi.env \
  --var SETTLEMENT_PUBLIC_ORIGIN: --var SETTLEMENT_PORT:4333
```

方式二，跑 Bun 进程（本机 SQLite，同一套接口）：

```sh
SETTLEMENT_PORT=4333 bun run dev
```

打开 http://127.0.0.1:4333 。本地 Worker 会通过 RPC 读真实的测试网注册表（`ownerOf` / `getAgentWallet`），但本地用的是一次性 ops key，没有 gas，所以本地只能报价、验签、预占和拒绝，不会真正结算；「预算内付费成功并按实际用量扣费」在线上验证。

密钥只放在被 Git 忽略的 `.secrets/`（权限 600），用 `--env-file .secrets/...` 或 `set -a; . .secrets/botchain-testnet/xxx.env; set +a` 在单条命令里加载，不要写进仓库、日志或前端。

付费与 MCP 示例脚本：`bun scripts/agent-pay-demo.ts`（echo，exact）、`bun scripts/llm-pay-demo.ts`（大模型，upto）、`bun scripts/mcp-demo.ts`（MCP 入口）。它们默认只连本地链，测试网要显式加 `--network botchain-testnet --send`。

## 测试

```sh
bun run verify        # tsc --noEmit + bun test（根目录套件已包含 web 单测）
bun test              # 只跑测试
cd web && bun test    # 只跑前端单测
bun run typecheck     # 只做类型检查
```

构建预演：

```sh
bun run build:web     # 生产构建；设置了 VITE_BFM_TEST_WALLET 时直接失败
bun run build:worker  # wrangler deploy --dry-run，不写线上
```

本地要验证浏览器钱包签名路径时，用 e2e 构建加本机签名服务（只监听 127.0.0.1:4335，私钥来自环境变量）：

```sh
bun run build:web:e2e
bun run dev:wallet-signer --port 4335
```

生产构建不会包含测试钱包：构建期剔除、构建脚本拒绝、产物扫描（`web/dist` 里不能出现 `bfm-test-wallet`）、运行期拒绝非回环主机，共四道保护。

## 部署

每一条远程 wrangler 命令都必须带 `CLOUDFLARE_ACCOUNT_ID`（本机登着两个账号，`bf-market` 属于 `b3f5c8a115367959cacd82878f8c84ab`）：

```sh
CLOUDFLARE_ACCOUNT_ID=b3f5c8a115367959cacd82878f8c84ab bun run build:worker            # 预演
CLOUDFLARE_ACCOUNT_ID=b3f5c8a115367959cacd82878f8c84ab ./node_modules/.bin/wrangler deploy
CLOUDFLARE_ACCOUNT_ID=b3f5c8a115367959cacd82878f8c84ab ./node_modules/.bin/wrangler deployments list
CLOUDFLARE_ACCOUNT_ID=b3f5c8a115367959cacd82878f8c84ab ./node_modules/.bin/wrangler rollback <version-id>
```

自定义域 `market.bflabs.app` 在 `wrangler.jsonc` 的 `routes` 里；非明文配置放在同一文件的 `vars`。密钥只用 `wrangler secret put` 写入，仓库里不保存，名字是 `SETTLEMENT_OPS_PRIVATE_KEY`、`BEEFAPI_API_KEY`、`BEEFAPI_BASE_URL`。

部署后头几秒，唯一的 `ledger` Durable Object 可能还在跑旧代码（新路由会短暂返回 405），重新探测一次再判断是不是部署失败。

线上预算矩阵的验证记录在 `docs/evidence/worker-budget-botchain-testnet-2026-10-07.json`（部署版本、agent 编号、公开地址、每一步请求与结果、交易哈希）。

## 同一套代码跑第二条链（Avalanche Fuji）

BF Market 可以在另一条链上单独部署，和 BOT Chain 版互不影响。Fuji 已经具备 x402 付费路径需要的一切，不需要部署任何合约：

- Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- x402 exact Permit2 代理 `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`、upto 代理 `0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`
- ERC-8004 官方身份注册表 `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- 测试 USDC `0x5425890298aed601595a70AB815c96711a31Bc65`

Fuji 的 profile 默认仍要求 Settlement 出款合约（伙伴中心靠它在 Fuji 出款）。只做 x402 收款的部署用 `SETTLEMENT_PAYOUTS_DISABLED=true` 显式关掉出款，而不是塞一个占位合约地址；这个开关和结算合约不能同时配置。

部署独立实例：

```sh
bun run build:web
CLOUDFLARE_ACCOUNT_ID=b3f5c8a115367959cacd82878f8c84ab \
  npx wrangler deploy -c wrangler.fuji.jsonc
```

`wrangler.fuji.jsonc` 把 Worker 名、自定义域和 `SETTLEMENT_NETWORK=fuji` 固定下来；密钥用 `wrangler secret put -c wrangler.fuji.jsonc` 单独写入。线上验收记录见 `docs/evidence/fuji-market-x402-2026-10-07.json`。

在 Fuji 上注册服务商、跑一次付费调用：

```sh
AGENT_PRIVATE_KEY=0x... bun scripts/agent-register-demo.ts \
  --network fuji --send --url https://market-fuji.bflabs.app --role provider

AGENT_PRIVATE_KEY=0x... bun scripts/agent-pay-demo.ts \
  --network fuji --send --rpc https://api.avax-test.network/ext/bc/C/rpc \
  --url https://market-fuji.bflabs.app/api/services/echo/call --body '{"hello":"fuji"}'
```

`llm-pay-demo.ts` 用同样的 `--network fuji --send` 跑按量计费的 upto 路径。

## 视频理解服务

视频理解服务 `video-gemini-3-8-flash` 在两条链上都提供，接收 `{"video_url","prompt"}`，服务端下载视频后交给 Gemini 3.8 Flash。一个看不了视频的剪辑 agent 用它审片、改片四轮的演示见 `docs/evidence/fuji-video-review-2026-10-07.md`：

```sh
# BOT Chain 测试网（market.bflabs.app，付测试 USDT）
AGENT_PRIVATE_KEY=0x... bun scripts/video-review-demo.ts --send --network botchain-testnet \
  --video https://market.bflabs.app/demo/pelican-neon-ride-v4.mp4 --out review.json

# Avalanche Fuji（market-fuji.bflabs.app，付测试 USDC）
AGENT_PRIVATE_KEY=0x... bun scripts/video-review-demo.ts --send \
  --video https://market-fuji.bflabs.app/demo/pelican-neon-ride-v4.mp4 --out review.json
```

## 给 agent 的入口

- `GET /skill.md`：接入说明、服务与价格、每日预算、错误列表（英文）。
- `GET /llms.txt`：机器可读的入口索引。
- `POST /mcp`：MCP（Streamable HTTP），工具包括 `platform_info`、`search_services`、`get_service`、`call_service`、`register_agent_info`、`get_wallet_summary`、`set_wallet_budget`。
- `GET /api/services/:id/call`、`GET /api/receipts`、`GET /api/wallets/:address/summary`、`GET /api/owners/:address/agents`、`GET /api/providers`：HTTP 接口。

接口错误统一用英文，文案以 `skill.md` 和线上响应为准。

## 伙伴中心（`/partner`）

原有的伙伴中心整体挂在 `/partner` 下：`/partner`、`/partner/login`、`/partner/console`、`/partner/progress`、`/partner/docs`。文案和样式保持原样，固定中文，不显示语言切换；旧路径（`/login`、`/console/*`、`/progress`、`/progress-lab`）自动跳转过去。

伙伴中心背后的结算原型（自有链、商户/推广者演示、版本化来源适配器）仍在本仓库里，设计说明与历史验证记录见 [docs/VERIFICATION.md](docs/VERIFICATION.md)、[docs/CONTRACT.md](docs/CONTRACT.md) 和 [docs/PUBLIC-DEMO.md](docs/PUBLIC-DEMO.md)。它与 BF Market 线上 Worker 用的是各自独立的账本与配置。

## 源码与许可

个人仓库：`enderzcx/partner-center`。已由项目所有者授权公开，用于 Team1 Builder Day @Shenzhen 项目提交。

迁入的前端保留 new-api / QuantumNous 的版权与许可声明，适用上游条款见 [UPSTREAM-LICENSE](UPSTREAM-LICENSE)。合约等文件另有文件级 SPDX 标记，字体许可证随资源保存；不能把整个项目统一重新声明为原创 MIT 项目。
