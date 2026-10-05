# ERC-8004 身份注册表（BOT 测试网 968 本地准备）

M2 的本地准备：把 ERC-8004 官方 IdentityRegistry 以「实现 + ERC1967Proxy」部署到我们自己的地址，由我们做 owner。**本文件只记录准备与只读结果，尚未部署。**

## 来源

- 仓库：`https://github.com/erc-8004/erc-8004-contracts`
- commit：`b9e466c250744a7e06b13dff9d3c2844ed64f825`（2026-08-15，`getVersion()` 返回 `"2.0.0"`）
- 落地文件：`contracts/erc8004/IdentityRegistryUpgradeable.sol`（其余逐字不动）
- 依赖：新增 `@openzeppelin/contracts-upgradeable@5.4.0`（精确版本，2025-07-17 发布，与官方 `^5.4.0` 及本仓库已有 `@openzeppelin/contracts@5.4.0` 一致）。`ERC1967Proxy` 取自已有的 `@openzeppelin/contracts@5.4.0`。

## 唯一一处源码改动

官方 `initialize()` 是 `reinitializer(2) onlyOwner`，依赖官方 MinimalUUPS 先把 owner 硬编码为官方地址、再升级到实现。我们改为单步初始化，让部署方成为 owner：

```diff
-    function initialize() public reinitializer(2) onlyOwner {
+    function initialize(address initialOwner) public initializer {
         __ERC721_init("AgentIdentity", "AGENT");
         __ERC721URIStorage_init();
+        __Ownable_init(initialOwner);
+        __UUPSUpgradeable_init();
         __EIP712_init("ERC8004IdentityRegistry", "1");
     }
```

`__Ownable_init(initialOwner)` 与 `__UUPSUpgradeable_init()` 原本由 MinimalUUPS 执行，这里逐一补回。未增删状态变量、未改继承顺序；OZ v5 的 Ownable/ERC721/EIP712 均用 ERC-7201 命名槽，实现自身的线性存储只有 `_lastId`/`_metadata`，布局与官方一致。`reinitializer(2)` 改回 `initializer`（版本 1），因为我们跳过了 MinimalUUPS，没有消耗过初始化版本。构造函数的 `_disableInitializers()` 保留。

## 为什么不用官方 `0x8004…` 地址

官方地址依赖 Safe Singleton Factory `0x914d7Fec…` 做同址部署，而该工厂在 968 上不存在，需要 Safe 团队签名部署。即使同址复现，官方 MinimalUUPS 把 owner 硬编码为 `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`，我们拿不到控制权。因此部署到我们自己的地址，owner 为部署方。

## 编译与部署脚本

- `scripts/erc8004-artifacts.ts`：按现有 `scripts/ktrace-artifacts.ts` 的方式，用 solc 0.8.30 编译实现与 `ERC1967Proxy`，生成两笔创建的 calldata 与确定性地址。未改动 `scripts/compile.ts`（其清单是单文件单合约，不适合来自 `node_modules` 的代理）。
- `scripts/deploy-erc8004-botchain.ts`：
  - 默认 `bun scripts/deploy-erc8004-botchain.ts` 只读：对 968 做 `eth_estimateGas`/`eth_call`（代理的估计注入实现 runtime 的 state override，以反映真实部署顺序）与 `eth_gasPrice`，打印预计 gas 与 tBOT 费用。
  - 只有显式 `--send` 且进程环境提供 `BOTCHAIN_TESTNET_OPS_PRIVATE_KEY`（仅从 `process.env` 读，不读文件、不打印）才发送；链 ID 必须为 968（拒绝 677 等）；部署前余额检查；签名交易先落盘到 `.local/erc8004-botchain/`（目录 700、文件 600）再广播，重试只允许同一哈希。
  - 部署两笔：实现合约、`ERC1967Proxy(impl, abi.encodeCall(initialize, (owner)))`，owner 为部署地址 `0x2547c1122c9aFD11eA0c4b66bb033552b90B979F`。
  - 读回：`owner()`、`getVersion()=="2.0.0"`、ERC-1967 实现槽、`register(string)` 选择器 `0xf2c298be` 的 `eth_call` 模拟。证据写 `docs/evidence/erc8004-botchain-testnet-<date>.json`（仅发送路径写；dry-run 只打印）。

## dry-run 结果（只读，2026-10-05）

| 交易 | 预计 gas（含 20% 缓冲） | gasPrice | 预计费用 |
|---|---|---|---|
| IdentityRegistryUpgradeable 实现 | 3,885,530 | 20 gwei | 0.0777106 tBOT |
| ERC1967Proxy | 334,842 | 20 gwei | 0.00669684 tBOT |
| 合计 | — | — | **0.08440744 tBOT** |

ops `0x2547…979F` 当前余额约 5 tBOT，充足；两笔合计未超脚本 1 tBOT 上限。确定性地址：实现 `0x15dE9915949D8E326FF2abeC186D7036987786A1`、代理/注册表 `0xe35a670Ec84477b54f976Ddfa5f8E4601FfC8607`（假定 ops nonce=0，脚本按链上实际 nonce 计算）。

## 本地测试

`tests/erc8004-registry.test.ts`（ganache 本地链）：owner 为部署者；initialize 不可二次调用；直接对实现调用 initialize 失败（`_disableInitializers` 生效）；非 owner 无法 `upgradeToAndCall`；任意地址 `register(string)` 成功、agentId 自增、`Registered` 事件参数与 `ownerOf` 一致；`register()`、`register(string,MetadataEntry[])` 可用；`setAgentURI` 仅持有人或被授权者；`getVersion()=="2.0.0"`。

## 风险

- **升级权在我们手上**：我们持有 proxy 的 owner，可随时更换实现。这是方案 B 的代价，需要保管好 ops 私钥与升级流程。
- **地址与官方不同**：我们的注册表地址不是官方 `0x8004…`，第三方索引/浏览器不会自动识别，需手动登记；官方后续在 968 部署后可能考虑迁移。
- 实现合约的 runtime 含 `UUPSUpgradeable.__self` immutable（= 实现地址），部署脚本已按实现地址核验 runtime。
