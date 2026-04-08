# 注意 测试迭代中
# 注意 测试迭代中
# 注意 测试迭代中

# 农场 CDP 控制自动收菜项目

通过hook小程序cdp协议转换为标准cdp，再通过cdp来控制qq经典农场小程序进行自动化操作

hook代码感谢[evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger)

## 目录说明

| 路径 | 说明 |
|------|------|
| **`wmpf/`** | Hook 与调试服务：`frida/hook.js`、`frida/config/addresses.*.json`、`src/*.js`（已由 TS 编译为纯 JS）。勿改 Frida 相对路径结构。 |
| **`src/gateway/`** | 连接本机 CDP 的网关（HTTP 静态页 + WebSocket）。 |
| **`public/`** | 浏览器控制页：`index.html`（注入 `button.js`、拉取土地汇总）。 |
| **`button.js`** | 放在**仓库根目录**；`--auto-farm` 时从当前工作目录解析为根目录下的 `button.js`。 |

## 环境要求

- **Windows**（Frida 针对 `WeChatAppEx.exe`）
- **Node.js ≥ 22**
- 微信 PC 版、可按 Frida 要求使用注入
- 支持的小程序版本在wmpf\frida\config可以查看（当前最新为19433 对应wx4.1.8.101）

## 安装

在**仓库根目录**执行：

```bash
npm install
```

注意 npm install卡住 失败等问题都是本机编译frida太慢（梯子开tun模式尝试）
可查看 [yarn 安装报错 MEGA THREAD #58](https://github.com/evi0s/WMPFDebugger/issues/58) 解决 这里不再讨论npm报错问题

## 启动

```bash
npm run start
```

启动后在浏览器打开 **<http://127.0.0.1:8787/>**：可 **注入 `button.js`**、**获取土地信息**（通过 WebSocket `ws://127.0.0.1:8787/ws`）。需 **微信已打开目标小游戏**（调试端 9421 有连接），否则 CDP 不会回包；若出现 `CDP timeout`，先确认小游戏在前台、再重试。

## 端口（默认）

| 服务 | 端口 |
|------|------|
| 调试 WebSocket | `9421` |
| CDP 代理 | `62000` |
| 网关 HTTP 控制页 | `8787`（页面 `/`，静态资源 `public/`） |
| 网关 WebSocket | 同端口路径 **`/ws`**（与页面同源自动连接） |

## 已实现功能

待更新

## 免责声明

- 本仓库**仅供学习、研究与安全测试**，作者与贡献者**与腾讯、QQ、微信及其小游戏无关联**，亦**不提供**任何绕过监管、作弊或违反服务条款的保证。
- 对第三方软件（含微信、小游戏）进行注入、调试或自动化，可能违反**用户协议 / 服务条款**，并导致**封号、限制功能或法律责任**；**一切风险与后果由使用者自行承担**。
- 本软件按「**现状**」提供，**不作任何明示或默示担保**；因使用或无法使用本软件造成的直接或间接损失，**责任自负**。
- **禁止**将本仓库用于任何违法、侵权或损害他人权益的行为。

## 许可证（GPL-3.0）

- 本项目以 **[GNU General Public License v3.0](LICENSE)**（**GPL-3.0**）授权发布。Hook 相关思路参考 [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger)；若上游以 **GPL-2.0-or-later** 授权，则选用 **GPL-3.0** 即是在「或更高版本」条款下选择 GPLv3，对外分发时仍须完整遵守 **GPLv3**。
- **Copyleft**：若你**分发**本项目的修改版或与本项目**合并**后的作品，在 GPLv3 适用范围内，你通常须**以同一许可证（GPL-3.0）**向接收者提供对应**源代码**，并遵守 GPLv3 全文义务。完整条文见仓库根目录 **`LICENSE`**。
- 使用、复制、修改或分发前，请**完整阅读** `LICENSE`；若你**不同意** GPLv3 条款，**请勿使用**本软件。
