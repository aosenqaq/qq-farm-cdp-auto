# Changelog

## 2026-04-13

- 修复微信路线一键启动时 `--wx` 透传到 `wmpf` 后触发 `ERR_PARSE_ARGS_UNKNOWN_OPTION` 的问题，微信注入链路现在会兼容并忽略上层运行时参数。
- 修复空地自动种植会把未解锁/不可交互地块误判为空地的问题；自动种植现在只会处理可交互空地，避免卡在种植流程。
- 从上游 `linguo2625469/qq-farm-cdp-auto` 的 `56db5f7 修复下未解锁土地种植bug` 中抽取并移植了核心过滤逻辑，但按当前本地代码结构手工合并，没有直接整体 cherry-pick。
- 修复自动种植中“策略1 背包优先 / 策略2 经验最大(经验/小时最高)”命中背包种子后，因库存不足仍错误打开商店并卡在商店的问题。
- 调整自动种植执行逻辑：当背包优先或排行策略已选中背包种子但库存不足时，仅按背包现有数量种植，不再强制补购打开商店。
- 自动农场日志新增 `背包部分种植` 来源标记，便于区分“纯背包种植”和“背包 + 商店补购”。
- 从上游 `linguo2625469/qq-farm-cdp-auto` 的 `upstream/main` 梳理近期提交，重点评估了 `5c7fabd 掉线重连`、`59c6576 尝试修复收取特殊地块果实(未完成)`、`56db5f7 修复下未解锁土地种植bug`、`a1e1d3d 修复帮忙和经验判断`。
- 选择性合并了 `5c7fabd 掉线重连` 的核心能力，但没有直接 cherry-pick 整个提交，而是按当前本地代码结构手动接入，避免把上游较大范围的 UI、资源目录和运行时差异一并带入。
- 新增 QQ 宿主自动重连能力：当游戏弹出网络异常/重新连接提示时，宿主可识别提示状态、主动触发重连，并提供轮询 watcher 持续兜底。
- 自动农场执行链路增加重连恢复：关键 `gameCtl.*` 调用前会先尝试恢复，调用失败后若检测到已处理重连，会自动重试一次。
- 扩展 QQ RPC 白名单，允许网关和自动农场调用 `gameCtl.autoReconnectIfNeeded`。
- 同步更新本地测试宿主 `qq-ws-test/miniapp-client.js`，补齐新的重连 RPC 映射。
- 已重新生成宿主产物 `dist/qq-miniapp-bootstrap.js`，并重新补丁本机当前活跃的 QQEX 小程序 `game.js`，确保实际宿主脚本与仓库源码一致。
- 本次实际修改文件：
- `button.js`
- `src/auto-farm-executor.js`
- `src/auto-farm-manager.js`
- `src/qq-rpc-spec.js`
- `qq-ws-test/miniapp-client.js`
- `dist/qq-miniapp-bootstrap.js`
- `wmpf/src/cli.js`
- 已完成静态校验：`node --check button.js`、`node --check src/auto-farm-executor.js`、`node --check src/auto-farm-manager.js`、`node --check qq-ws-test/miniapp-client.js` 均通过。
- 已补充静态校验：`node --check wmpf/src/cli.js` 通过。
- 暂未合并上游其余近期提交，原因：
- `59c6576` 明确标注“未完成”，风险偏高。
- `a1e1d3d` 改动较多，且涉及 UI 与自动农场行为判断，不适合在未专项验证时直接并入。
