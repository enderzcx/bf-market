# KTrace 旧版商业合约迁移到 BOT Chain

2026-09-28，Owner 明确要求把 KTrace 之前使用的 Agent 商业平台合约部署到 BOT Chain 主网，后续再迭代。此授权扩展了先前只部署佣金合约的范围。

## 本次范围

原样复制 `kite-trace-platform/backend/contracts/` 中 IdentityRegistryV1、TrustPublicationAnchorV1、JobLifecycleAnchorV2、TraceAnchorGuard、JobEscrowV4 及接口。业务 Solidity 源码不改。来源仓库 https://github.com/enderzcx/kite-trace-platform ，提交 `410bc41b0f00c7acf7805e5b8ff73e12910dce35`；这些合约源文件在原工作区没有未提交修改，逐字复制核对一致。编译使用锁定的 solc 0.8.30 / OpenZeppelin 5.4.0 / optimizer 200 / viaIR / Shanghai；字节码可能与旧链编译版本不同，以本次源文件哈希和运行时代码核对为准。这是项目自有的旧版实现，不声称是最新 ERC 官方标准实现。

- 主网：677，RPC https://rpc.botchain.ai。
- Owner：0x28172e0d973fFf24651B6Ed4cA6d1007bc168C94，沿用已确认的部署钱包。
- USDT：0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C，6 位精度。
- nonce 1–5：依次部署上述五个合约；nonce 6：给托管合约连接 TraceAnchorGuard。
- 注册表沿用旧名称与符号，注册费、修改费均为 0。
- 最多消耗 0.3 BOT gas；未使用部分留在原钱包。每笔新签名前刷新报价、检查 nonce、只读模拟、持久化已签交易再广播。恢复只复用原始交易，不自动替换或改 nonce。
- 既有佣金 Settlement 保持暂停。本次不转入 USDT、不创建任务、不注册 Agent、不接通后端或执行交易，不部署 AA 智能钱包、EntryPoint 或 bundler。

这些旧合约没有全局暂停机制，部署后链上公开方法即可被调用。资金托管继续要求付款者自行授权并入金；任务记录由 Owner 发布。部署本身不等于生产开放。源码是历史演示逻辑，未来正式经营前仍需审计及业务适配，包括注册表 NFT 转移后的旧 operator 授权、开放任务抢占、validator/过期争议、trace 仅检查存在等既有语义。

## 验证和不可逆边界

部署不能回滚；可停止后端接入并在未来发布新版本，不能撤回 gas。停止条件：链或 nonce 改变、USDT 代码改变、费用超限、模拟失败、收据失败、代码/Owner/依赖读回不一致。私钥只在内存加载，不写入新文件或输出；`.local/ktrace-botchain/` 保存受限权限的签名日志以供不确定发送恢复。

本地部署并覆盖构造配置、权限拒绝、身份注册和信任发布、任务托管→接受→记录→提交→结算、缺记录拒绝。主网发送前进行独立只读审查。部署后逐个核对 runtime、owner、依赖和 USDT 余额，记录 receipt/费用/最终确认状态。浏览器源码验证和正式资金业务不在本次交付内。

操作入口：`bun scripts/deploy-ktrace-botchain.ts prepare|send|verify`。send 额外需要与已审查计划一致的 KTRACE_APPROVED_DIGEST，以及进程内 KTRACE_DEPLOY_PRIVATE_KEY；两者不应写入产品配置。

## 已部署结果（2026-09-28）

五个合约及一次 guard 连接共六笔交易成功，RPC finalized 区块 24782487 已覆盖所有收据。实际 gas 0.127609636 BOT；部署钱包剩余 2.857510466 BOT；任务托管余额 0 USDT。所有运行时代码、Owner、代币与依赖地址读回一致。138 项测试通过，类型检查通过，独立审查无部署阻塞项。浏览器源码验证尚未完成。

| 合约 | BOT Chain 主网地址 | 部署交易 |
|---|---|---|
| IdentityRegistryV1 | [0xA0A902E556795E2b1B0424525e2F7535388A407F](https://scan.botchain.ai/address/0xA0A902E556795E2b1B0424525e2F7535388A407F) | [0x21469938b42c30d84ffa523b6c20ae99840ea2b60f668606d8804b813a87ce2c](https://scan.botchain.ai/tx/0x21469938b42c30d84ffa523b6c20ae99840ea2b60f668606d8804b813a87ce2c) |
| TrustPublicationAnchorV1 | [0xdAC1840050f2EBfC9b92c2Cc9080d2E623E46622](https://scan.botchain.ai/address/0xdAC1840050f2EBfC9b92c2Cc9080d2E623E46622) | [0xa8f8b495dc045a97bf43605909fd4f6f41f3128c1c8c6f73b2dc24311d7646e4](https://scan.botchain.ai/tx/0xa8f8b495dc045a97bf43605909fd4f6f41f3128c1c8c6f73b2dc24311d7646e4) |
| JobLifecycleAnchorV2 | [0x64Dae9cC4063Caf71A132E3372E09807064585aB](https://scan.botchain.ai/address/0x64Dae9cC4063Caf71A132E3372E09807064585aB) | [0x1ed6b9a3e38cc2a025cb0bc70199133773970ca662c4910fccb2598938ef0619](https://scan.botchain.ai/tx/0x1ed6b9a3e38cc2a025cb0bc70199133773970ca662c4910fccb2598938ef0619) |
| TraceAnchorGuard | [0xD1ae614A07f30d115004146F7FAf8C838A4B3fB4](https://scan.botchain.ai/address/0xD1ae614A07f30d115004146F7FAf8C838A4B3fB4) | [0xf4d0de002a9d9187725240c2e2fe62118bafd7c93666720853da67969042ae31](https://scan.botchain.ai/tx/0xf4d0de002a9d9187725240c2e2fe62118bafd7c93666720853da67969042ae31) |
| JobEscrowV4 | [0x885164d7b9591016EcD0aAD8b06A6E9191752B88](https://scan.botchain.ai/address/0x885164d7b9591016EcD0aAD8b06A6E9191752B88) | [0x400bb86ce9b7907d490545d2c2acc034ca084024db80b620a53f34196e8c06eb](https://scan.botchain.ai/tx/0x400bb86ce9b7907d490545d2c2acc034ca084024db80b620a53f34196e8c06eb) |

Guard 连接交易：[0x1c9744ac5ec67480252f3eb803a03220cbd7ed83146965f77ce5cfe1ab692843](https://scan.botchain.ai/tx/0x1c9744ac5ec67480252f3eb803a03220cbd7ed83146965f77ce5cfe1ab692843)。

完整回执见 `docs/evidence/ktrace-botchain-deployment-2026-09-28.json`，审查见 `docs/evidence/ktrace-botchain-review-2026-09-28.json`。恢复所需签名日志保留在被忽略的 `.local/ktrace-botchain/`，不纳入 Git。后端尚未启用这组地址。
