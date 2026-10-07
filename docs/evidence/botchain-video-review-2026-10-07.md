# BOT Chain 测试网：一次付费视频审片（2026-10-07）

Fuji 上做过的视频审片演示，在 BOT Chain 测试网（链 968）的 https://market.bflabs.app 上复跑一次。代码是同一套，Worker 版本 `df64b585-bc9d-4203-8ff8-aaa8b84f6ec1`（合并提交 `02aae4e`，回滚点 `f061bfc2`）。

## 过程

agent 只知道市场地址：读 `/discovery/resources` 找到视频理解服务，收到 402 报价（`upto`，上限 38600 atomic USDT），签 Permit2 授权，拿到审片结果。命令：

```sh
AGENT_PRIVATE_KEY=0x... bun scripts/video-review-demo.ts --send --network botchain-testnet \
  --video https://market.bflabs.app/demo/pelican-neon-ride-v4.mp4 --out review.json
```

## 结果

| 项目 | 值 |
| --- | --- |
| 服务 | `video-gemini-3-8-flash`（Gemini 3.8 Flash，经 BeefAPI） |
| 买家 | `0x458045aB70E11Ff1eeB5f6226e5E02f92f7B9ada` |
| 收款 | `0x9Fb2A80007047d249F5926960d870cD8aB5E7A4A`（provider agent 1） |
| 报价上限 | 38600 atomic USDT（0.0386） |
| 实际扣款 | 5968 atomic USDT（0.005968） |
| 用量 | prompt 1495 / completion 1740 tokens |
| 耗时 | 31.7 s |
| 结算交易 | [`0x06beaa25…29ed`](https://scan.bohr.life/tx/0x06beaa253dc16648560c258fb0f7a2e97dc140fc1ee4541aa1ece7834bb629ed)，区块 26035281 |

链上读回：交易 status 1；交易内唯一的 USDT `Transfer` 是买家 → 收款地址 5968，与 `chargedAtomic` 一致。买家余额 5.755535 → 5.749567 USDT，差额正好 0.005968。

审片结论：四个情节（夜骑、吞鱼与 FISH.EXE、跳锥、刹车戴墨镜）都识别到了；模型仍认为 FISH.EXE 窗口像漂浮的弹窗，并建议给跳跃加预备动作、刹车时锁住踏板。完整原文在 `botchain-video-review-2026-10-07.json` 的 `review` 字段。

## 失败的第一次

同一分钟内的第一次调用在 127 s 后返回 `502 {"error":"The model provider call failed. You were not charged."}`，没有结算交易。随后直接调上游同一模型 15 s 返回正常，第二次付费调用成功。买家余额只减少了第二次的 5968，证明失败那次确实没扣款。
