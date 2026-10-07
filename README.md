# 伙伴中心 · Partner Center

面向 new-api、sub2api 部署者的自部署伙伴中心，连接已有网关、业务账本与链上佣金结算。BeefAPI 是首个已验证的测试接入方；两个上游生态的标准适配尚待开发与版本验收。

**当前已验收：Avalanche Fuji 公网测试订单收款与自动返佣闭环。** 完整海外站 React 前端已迁入伙伴中心，公网展示为持续迭代版本。迁移范围见 [前端验收合同](docs/OVERSEAS-ACCEPTANCE.md)。公网发布状态与链上证据以 [验证记录](docs/VERIFICATION.md) 为准。

## 前端构建

前端源码位于 `web/`。先执行 `cd web && bun install --frozen-lockfile && bun run build`，再运行根目录服务。服务默认提供 `web/dist`，支持明确的伙伴中心页面路径及构建资源；`SETTLEMENT_PUBLIC_DIR` 可以覆盖该目录。不要把旧 `public/index.html` 作为新版入口。现有 `public/app.js` 保留为已验证 x402 客户端的源码依赖，随 React 构建打包。

### BF Market 公共网站

`web/` 同时包含 BF Market 公共网站和原伙伴中心。公共网站首页、市场、钱包控制台和双语文档分别位于 `/`、`/market`、`/wallet` 和 `/docs`；伙伴中心入口位于 `/partner`。从仓库根目录运行 `bun run build:web`，构建产物由 Worker Assets 提供。网站默认根据浏览器语言显示中文或英文，也可用 `?lang=zh` 或 `?lang=en` 指定语言，之后会记住选择。

下面的本地链、来源和资金示例是原型开发说明，不代表已连接生产账本。

## 本地运行

安装 Bun，然后在本目录运行：

```sh
bun install --frozen-lockfile
bun run chain:local
```

另开终端运行：

```sh
bun run dev
```

打开 http://127.0.0.1:4311 。选择本地测试钱包，开启自动结算，在商家页创建测试佣金。正常执行由定时器推进，也可立即检查。模拟佣金不是营收；本地链代币不是 Circle USDC。测试工作区中的商家/推广者切换仅用于演示，不是账号登录和权限隔离。

状态：待结算 → 已签名 → 已广播 → 链上已确认 → 原账本已完成。服务在发送交易前保存签名交易。结果不明时只重播同一笔交易；账本回写失败时只补回写。异常任务继续保持冻结，不自动解冻或换单重付。

本地链和服务数据都保存在被 Git 忽略的 `.local/`。独占执行钱包不能被其他脚本同时使用。重置本地链时必须同步重置对应的演示账本，不能将旧账本与新链混用。

## Cloudflare Workers 入口

`worker/index.ts` 是第二个入口（Bun 版 `src/server.ts` 保持不变）。无状态 Worker 把所有动态请求转发给唯一的 Durable Object（`idFromName('ledger')`），静态前端 `web/dist` 由 Workers Assets 托管并做 SPA 回退。账本、付款幂等锁、ops 签名 nonce 与启动 gas 额度都集中在这一个对象里，因此保持串行。DO 的存储是 `ctx.storage.sql`，与 Bun 版共用同一套表结构和 SQL（见 `src/db.ts` 的 `Db` 抽象）。

```sh
bun run dev:worker    # wrangler dev --local
bun run build:worker  # wrangler deploy --dry-run --outdir dist-worker
```

本地 `wrangler dev` 的请求主机名需要是公开来源，否则动态接口按设计拒绝：

```sh
curl -H 'Host: market.bflabs.app' http://localhost:8787/healthz
```

非明文配置写在 `wrangler.jsonc` 的 `vars`；下列密钥只在部署时用 `wrangler secret put` 写入，不写进仓库：

- `SETTLEMENT_OPS_PRIVATE_KEY`
- `BEEFAPI_API_KEY`
- `BEEFAPI_BASE_URL`

`compatibility_date` 目前固定为 `2026-10-03`，这是 `wrangler@4.143.0` 自带 workerd 支持的最新日期；升级 wrangler 后应改回部署当日。自定义域（`routes`）留到部署时再配置。

### 同一套代码跑第二条链（Avalanche Fuji）

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

## BeefAPI 接入

BeefAPI 适配代码位于独立工作树 `codex/fuji-settlement`。它增加默认关闭、独立鉴权的测试接口。BeefAPI 原账本负责实际可用余额、冻结和已提现记录，结算服务不重复计算或复制可用佣金余额。

- `POST /api/settlement-test/reservations` 冻结 global 佣金并返回唯一单。
- `GET /api/settlement-test/reservations` 分页取单。
- `POST /api/settlement-test/reservations/:id/complete` 链上核验后完成原账本。
- `GET /api/settlement-test/partners/:id` 读取原账本余额。

测试订单演示默认关闭。仅当来源为 beefapi 且双方都显式打开时可用：来源 `SETTLEMENT_TEST_ORDER_MODE=true`，本应用 `SETTLEMENT_ORDER_DEMO=true`。此时可创建默认 10 USD 测试订单，页面用「模拟支付成功」确认，不会向买家扣款。佣金金额以来源为准，收款地址在首次确认时固定。出款仍由定时器执行，不在确认接口里上链。

- `GET /api/settlement-test/orders`
- `POST /api/settlement-test/orders`
- `POST /api/settlement-test/orders/:request_id/pay`

独立服务只接受回环地址上的 BeefAPI 测试环境。普通生产提现和钱包入口保持既有行为。适配鉴权 token 由环境配置，不出现在网页中，不写入仓库。

## Fuji 联调所需

已完成一次明确授权的 Fuji 部署及 1 测试 USDC 出款，凭证见 `docs/evidence/fuji-acceptance-2026-09-18.json`。新增付款需按当前金额和收款地址授权；订单驱动演示入口见 [ORDER-DEMO.md](docs/ORDER-DEMO.md)。以下是 Fuji 执行条件：

1. 商家管理员、专用执行钱包和推广者收款钱包的公开地址。
2. 执行钱包的测试 AVAX、出款合约的测试 USDC。
3. 私钥只放受控进程环境，不能粘贴聊天、提交 Git 或放进前端。
4. 部署并确认出款合约地址，核对管理员与执行者角色。

官方测试 USDC 固定为 `0x5425890298aed601595a70AB815c96711a31Bc65`，链 ID `43113`。引用：[Circle 合约地址](https://developers.circle.com/stablecoins/usdc-contract-addresses)。

无需私钥的只读检查：

```sh
bun scripts/fuji-preflight.ts
```

该脚本只检查网络、USDC 精度和区块；可设置 `FUJI_EXECUTOR_ADDRESS` 读取测试钱包余额。成功不代表任何合约部署、出款或最终账本验收。

## 公网演示与运行边界

演示入口：https://partner.bflabs.app/ 。当前具备商家/推广者登录、角色权限隔离和 HTTPS 会话；应用进程仍监听回环，由反向代理提供公网入口。部署方式见 [PUBLIC-DEMO.md](docs/PUBLIC-DEMO.md)，账号与会话配置见 [AUTH-DEMO.md](docs/AUTH-DEMO.md)。仓库不提供公网账号密码或钱包私钥。

x402 测试收款已完成独立验收，见 [X402.md](docs/X402.md)。它先核验 10 测试 USDC 收款，再由业务账本计算并冻结 1 测试 USDC 佣金，随后执行另一笔出款交易；这不是收款时原子分账，也不充值生产 API 余额。手动转币到合约只是补充资金，尚无通用手动充值归因入口。

当前仍为受控单商家测试环境。多商家资金隔离、生产订单、退款策略、生产密钥托管和主网验收尚未完成。BeefAPI 来源适配器在另一个工作树中，本仓库不是包含该网关全部源码的一键部署包。

## 源码与许可

个人仓库：`enderzcx/partner-center`。已于 2026-09-19 经项目所有者授权公开，用于 Team1 Builder Day @Shenzhen 项目提交。

迁入前端保留 new-api / QuantumNous 的版权与许可声明，适用上游条款见 [UPSTREAM-LICENSE](UPSTREAM-LICENSE)。合约等文件另有文件级 SPDX 标记，字体许可证随资源保存；不能把整个项目统一重新声明为原创 MIT 项目。

## 复现接入验收

先启动本地链。编译真实 BeefAPI 控制器的测试 fixture（只需首次或适配源码变化后）：

```sh
cd /Volumes/ExternalWork/Worktrees/beefapi/fuji-settlement
go test -c ./controller -o /Volumes/ExternalWork/Worktrees/settlement/fuji-demo/.local/beefapi-fixture.test
```

在本项目新终端启动 fixture：

```sh
bun scripts/beefapi-fixture.ts
```

它创建全新的临时 SQLite、100 单位测试收益和专用临时 token，运行上限 30 分钟。生成的 `.local/beefapi.env` 只供服务进程读取，并为本轮生成独立结算数据库路径。

停止占用 4311 的 fixture 模式应用后，在本项目另一终端运行：

```sh
source .local/beefapi.env
SETTLEMENT_TICK_MS=1000 bun run dev
```

执行端到端验收：

```sh
bun scripts/verify-live.ts
```

脚本自动提交一张 10 单位的测试结算单，等待定时器出款，核对本地 EVM 余额实际增量与源账本状态，然后重复触发检查确认不多付。只允许本机 31337 网络。fixture 模式也可运行同一脚本，它会绑定本地钱包并添加测试佣金。

仅监听一个服务实例；不得让其他进程共用执行私钥。不同来源使用不同账本文件，默认独占锁仍共用。服务重启后继续使用原账本、链数据库和配置；不同来源/链/代币/合约/执行地址不能复用同一账本。

常规验证：

```sh
bun run verify
```

默认演示参数为 1 USDC 最低金额、60 秒成熟期、30 秒扫描；`SETTLEMENT_MATURITY_MS=0 SETTLEMENT_TICK_MS=1000` 仅用于加速本地测试。BeefAPI 已冻结的单据按来源确认结果处理，不再次套用演示成熟期。

## 产品与演示

产品方向是优先服务 new-api、sub2api 部署者，提供独立伙伴中心与版本化适配器。商家保留现有网关、计费和账号系统，逐步在统一入口管理多个产品。当前仅为 BeefAPI 单商家受控测试，不代表上游全版本兼容或官方合作。

- [在线演示](https://partner.bflabs.app/demo)：前7页约3分钟，后4页问答。展示既有 Fuji 测试案例。
- [逐页讲稿](docs/DEMO-DAY-SCRIPT.md)与[产品进展](https://partner.bflabs.app/progress)。
- CommissionEscrow 仅本地验证，待 Fuji 接线与领取验证。定制结算 L1、预制配置包、商家专属部署、ICM／ICTT 及 MCP 接口均为后续方向，详见 [产品方向与路线](docs/PRODUCT-ROADMAP.md)。
