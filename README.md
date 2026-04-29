这是一个偏工程实验性质的项目。和“农场脚本”本身相比，更值得看的其实是两件事：

- 如何把非标准小游戏调试链路补成可用的 CDP / RPC
- 如何把游戏内能力层、外部网关、网页控制台拆开

项目目前已经同时支持两条路线：

- 微信小游戏调试环境：`CDP + 自动注入 button.js`
- QQ 小程序本地资源环境：`WebSocket 宿主 + QQ bundle`
#####
hook 代码感谢 [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger)
#####
部分功能设计实现思路感谢https://github.com/Penty-d/qq-farm-bot-ui
#####
0开作者仓库 https://github.com/linguo2625469/qq-farm-cdp-auto
#####
#————————————————————
种田交流群：922286747
#————————————————————
#####

# 农场自动化控制台 V1.6.1

## 30 秒快速开始

最推荐无脑启动方式：

1. 下载本项目到本地任意位置
2. 双击打开 `start.bat`
3. 按提示选择 `QQ` 或 `微信` 启动

说明：

- `start.bat` 会自动检查 Node.js、安装依赖，并在启动后自动打开控制页

如果你更习惯手动执行命令，再看下面：

安装依赖：

```bash
npm install
```

发布前清理：

```bash
npm run release:prepare
```

说明：

- 会保留 `node_modules/`，只清掉 `logs/`、运行缓存、每日统计以及测试目录 `qq-ws-test/`
- 会保留源码、资源文件和空目录骨架，适合直接打包发人
- 打包完成后，建议执行 `npm run release:verify` 检查目录关键文件是否完整
- 如果你是手动压缩成 `.zip` 再分发，建议再执行 `node scripts/verify-release-package.cjs 你的发布包.zip`
- 如果只是想清运行痕迹、不删依赖，可执行 `npm run clean:runtime`
- 如果想做更瘦的发布包，再执行 `npm run release:slim`

微信路线：

```bash
npm run start -- --wx
```

QQ 路线：

```bash
npm run start -- --qq
```

启动后打开控制页：

- 默认地址：<http://127.0.0.1:8787/>

如果是 QQ 路线：

1. 进入控制页“运行时”页签
2. 若已知 `appid`，直接填入页面里的 “QQ 小程序 AppID”
3. 点击“保存 QQ Bundle”导出 bundle，或点击“一键打补丁” 自动查找最新 QQ 资源目录并把 bundle 写入 `game.js`
4. 再启动 QQ 小程序

## 当前架构

### 微信 / CDP

- `wmpf/` 把小游戏调试协议补成可用的 CDP
- `public/index.html` 通过网关拿状态、预览、输入事件
- 上下文就绪后自动注入 [`button.js`](button.js)
- 自动农场通过 `gameCtl.*` 执行业务动作

### QQ / WebSocket

- `button.js` 仍然只负责游戏内能力层
- [`qq-host.js`](qq-host.js) 是小程序内常驻宿主
- 网关通过 `/miniapp` WebSocket 和宿主 RPC 通信
- QQ bundle = `button.js + qq-host.js`
- 可在网页中直接导出 bundle，或直接给 `game.js` 打补丁

## 项目目录

| 路径 | 说明 |
|------|------|
| [`wmpf/`](wmpf) | 微信小游戏调试桥、Frida hook、CDP 代理。 |
| [`src/`](src) | 网关、自动农场编排、QQ WS / CDP transport、bundle 生成。 |
| [`public/`](public) | 网页控制台。 |
| [`gameConfig/plant_images/`](gameConfig/plant_images) | 统一图片资源目录：`stages/作物` 存放作物主图与阶段图，`stages/*` 目录可放仓库物品资源包，`default/` 存放默认兜底图。 |
| [`button.js`](button.js) | 游戏内能力层，暴露 `gameCtl.*`。 |
| [`qq-host.js`](qq-host.js) | QQ 小程序宿主模板。 |
| [`scripts/patch-qq-miniapp.cjs`](scripts/patch-qq-miniapp.cjs) | 命令行生成 / 打补丁工具。 |
| [`docs/qq-ws-automation-plan.md`](docs/qq-ws-automation-plan.md) | QQ WebSocket 自动化改造计划。 |

### 图片资源约定

- `gameConfig/plant_images/default/`
  - 存放默认兜底图；当前默认图为 `400.jpg`
- `gameConfig/plant_images/stages/作物/<作物名>/`
  - 存放作物主图与阶段图
  - 主图约定：`<作物名>_00_作物图.*` 或 `<作物名>_00_主图.*`
  - 阶段图约定：`<作物名>_01_种子.*`、`<作物名>_02_发芽.*` 这类按阶段顺序编号的文件
  - 土地详情会优先按 `phaseName` 命中阶段图，普通主图会优先读取 `00` 主图
- `gameConfig/plant_images/stages/<资源包目录>/`
  - 可放仓库页使用的非作物资源，例如 `狗粮`、`化肥道具`、`活动货币`、`礼包与宝箱`
  - 每个目录建议附带一个 `*_mapping.json`
  - 当前网关会按 `mapping.json` 中的 `item_id` 建立 `物品 ID -> 名称/图片` 映射；图片文件名优先按 `name` 精确匹配
- `gameConfig/plant_images/stages/作物/黄金果实_mapping.json`
  - 用于给 `104xxxx` 黄金果实补齐仓库名称、等级、稀有度和黄金主图
  - 若后续新增黄金/变异资源，优先沿用这类 `item_id + name + phase_names/phase_paths` 结构

## 环境要求

- Windows
- Node.js >= 22
- 微信路线需要可用的微信 PC 版调试环境
- QQ 路线需要能访问本地 `game.js` 资源文件

说明：

- `frida` 安装慢、编译慢、卡住，多半是本机环境问题，不是本项目逻辑问题
- 支持的微信版本可看 [`wmpf/frida/config`](wmpf/frida/config)

## 启动方式

最推荐无脑启动方式：

1. 下载本项目到本地任意位置
2. 双击打开 `start.bat`
3. 选择 `QQ` 或 `微信` 启动

说明：

- `start.bat` 会自动检查依赖、按所选路线启动，并在就绪后自动打开控制页

如果你更习惯命令行，也可以直接运行：

```bash
npm run start --runtime cdp
```

```bash
npm run start --runtime qq_ws
```

简写：

```bash
npm run start --wx
```

```bash
npm run start --qq
```

也可以只启动网关：

```bash
npm run gateway --wx
```

```bash
npm run gateway --qq
```

## 环境变量

项目会自动读取：

- `.env`
- `.env.local`

也支持额外文件：

```bash
FARM_ENV_FILE=.env.qq
```

参考模板见 [`.env.example`](.env.example)。

### 常用变量

| 变量 | 说明 |
|------|------|
| `FARM_RUNTIME_TARGET` | `cdp` / `qq_ws` / `auto` |
| `FARM_GATEWAY_HOST` | 网关监听地址 |
| `FARM_GATEWAY_PORT` | 网关端口 |
| `FARM_CDP_WS` | 微信 CDP 目标 |
| `FARM_QQ_WS_PATH` | QQ 宿主 WebSocket 路径，默认 `/miniapp` |
| `FARM_QQ_GAME_JS` | QQ 小程序 `game.js` 路径，用于一键打补丁 |
| `FARM_QQ_APPID` | QQ 小程序 appid；未设置 `FARM_QQ_GAME_JS` 时按它自动定位最新版本目录 |
| `FARM_QQ_MINIAPP_SRC_ROOT` | QQ `miniapp_src` 根目录；默认 `%APPDATA%\\QQEX\\miniapp\\temps\\miniapp_src` |
| `FARM_QQ_HOST_WS_URL` | 生成 QQ bundle 时写入的本地宿主地址 |
| `FARM_QQ_HOST_VERSION` | QQ 宿主版本号 |
| `FARM_QQ_BUNDLE_OUT` | 命令行生成 bundle 的输出路径 |

### QQ 路线示例

```env
FARM_RUNTIME_TARGET=qq_ws
FARM_GATEWAY_HOST=127.0.0.1
FARM_GATEWAY_PORT=18788
FARM_QQ_WS_PATH=/miniapp
FARM_QQ_WS_READY_TIMEOUT_MS=15000
FARM_QQ_WS_CALL_TIMEOUT_MS=15000
# 显式路径优先；不填时按 appid 自动扫描最新目录
# FARM_QQ_GAME_JS=D:\path\to\qq-miniapp\game.js
FARM_QQ_APPID=1112386029
# FARM_QQ_MINIAPP_SRC_ROOT=C:\Users\RJ\AppData\Roaming\QQEX\miniapp\temps\miniapp_src
FARM_QQ_HOST_WS_URL=ws://127.0.0.1:18788/miniapp
FARM_QQ_HOST_VERSION=qq-host-1
```

## 控制页说明

控制页现在是运行时感知的，不再把 QQ 路线硬套成 CDP。

主要页签：

- `自动农场`
  - 基础任务支持二级折叠，`收获 / 除草 / 浇水 / 杀虫` 四个动作可分别开启或关闭
  - 当基础动作全部关闭且未配置自动种植/自动施肥时，会自动跳过自己农场空跑
  - 模块开关新增独立“奖励弹窗拦截”，仅对 QQ WS 运行时生效，不会写入自动农场策略配置
  - 好友列表扫描、进好友农场偷菜、好友帮忙
  - 可分别配置 `偷菜巡查间隔`、`帮助巡查间隔`、每轮好友数、进场等待、动作等待、回家、出错停止、自动种植、自动施肥，以及好友帮忙“每天帮忙上限”
  - `背包优先` 种植策略支持二级展开的 `背包种子优先级` 面板，可对真实背包种子勾选并排序
  - 背包优先级列表默认只显示当前背包里真实存在且有库存的种子；不会把 `0` 库存种子整表展示出来
  - 背包优先支持 `强制保留优先级`：开启后，即便背包暂时没有该种子，也会继续保留在前端优先级列表里；后续重新掉落回背包时，会继续按原优先级优先种植
  - 背包优先在单轮内会按优先级连续补种：优先级 1 数量不足时，会在同一轮继续尝试优先级 2、优先级 3，而不是等到下一轮
  - 自动农场每轮执行背包优先时，都会重新读取一次当前背包种子
  - 爱心果 `seedId=20046` 会显示为 `不可种植`，且自动种植时会被背包优先策略自动跳过
  - 自动农场与调度配置改动后，页面左下角会出现全局“有修改未保存”提示，点击即可直接保存
- `调度中心`
  - 统一管理控制页常驻任务的串行调度，不再依赖多个模块各自并发轮询
  - 支持任务启停、优先级、轮询间隔、页签运行模式和任务间缓冲时间配置
  - 支持查看当前运行队列、下一次预计执行时间，并可快速上移/下移任务优先度
- `土地详情`
  - 展示土地、作物、成熟倒计时和品质信息
  - 作物状态优先按 `成熟倒计时 + grow_phases + 当前季次` 推导，减少运行时阶段号异常导致的错判
  - 作物图片会按当前阶段切换；阶段文案统一显示为 `大叶期 4/6` 或 `第1季 · 大叶期 4/6`
  - 支持单地块手动 `无机 / 有机` 施肥
- `仓库`
  - 后台会隐藏打开仓库并访问四个页签，聚合展示同类物品总数、预估售价与来源页签
  - 支持本地仓库缓存；仓库页打开时若远端未即时返回，会先展示最近一次成功读取结果
  - 支持按 `gameConfig/plant_images/stages/*/*_mapping.json` 自动补齐仓库物品图片与名称；狗粮、化肥道具、活动货币、礼包与宝箱等资源包可直接显示
  - 黄金果实 `104xxxx` 物品支持显示 `黄金·xxx` 名称与黄金主图
  - 支持卡片 `出售` 与顶部多选出售；聚合卡片出售会自动映射到同类物品对应的多个真实仓格
  - 出售配置已拆成独立区域，固定显示 `果实 / 种子 / 道具 / 材料` 四类真实可售类别，即使当前库存为 `0` 也可提前勾选
  - 支持“按出售范围选中”快捷操作，可按当前出售类别筛选一键勾选页面中匹配的可售物品
  - 默认每 `5` 分钟自动刷新一次仓库缓存；自动出售默认每 `12` 小时执行一次，填 `0` 时每次刷新都会尝试出售已勾选类别中的可预估物品
- `运行时`
  - 显示当前到底走 `微信 CDP` 还是 `QQ WS`
  - 显示 QQ 宿主最近日志
  - 支持填写 `appid` 自动查找最新 QQ 小程序 `game.js`
  - 可直接“保存 QQ Bundle”
  - 若已配置 `FARM_QQ_GAME_JS` 或 `FARM_QQ_APPID`，可直接“一键打补丁”
- `画面预览`
  - 仅 CDP 路线可用
  - 仅支持点击
- `好友农场`
  - 获取好友列表
  - 直接进入指定好友农场，并支持单个好友偷菜 / 帮忙
- `账户状态`
  - 展示账号、等级、等级经验进度和运行统计
  - 运行统计会按天本地持久化，重启后保留当天数据，并可查看最近 `30` 天历史
  - 账户资料会本地缓存，弱网或网关重启后可回退到最近一次可用数据
- `日志中心`
  - 拆分显示自动农场日志与消息日志
- `消息推送`
  - 支持 `Server酱 / PushPlus / 企业微信 / 钉钉 / 飞书 / Telegram / Bark / ntfy / Webhook`
  - 异常通知会同时扫描网关日志与自动农场内部 `warn / error` 事件，不再只识别单一超时
  - 已覆盖网络/连接、运行时/上下文、请求/协议、持久化/状态、调度/执行、资源/数据等异常类型
  - `超时` 相关异常仍按阈值累计触发，已接入 `等待自动农场空闲超时`、`AUTO_FARM_RUNTIME_BUSY_TIMEOUT`、`request timeout`、`ETIMEDOUT` 等判断
  - 网关启动后会自动把控制台输出镜像到 `logs/gateway-out.log` 与 `logs/gateway-err.log`，用于日志异常监控
  - 可按指定时间推送前一天的自动农场日报

## QQ 路线使用方式

### 方式 1：网页导出 bundle

适合不想记命令的人。

1. `npm run start -- --qq`
2. 打开控制页
3. 进入“运行时”页签
4. 点击“保存 QQ Bundle”
5. 把导出的内容放进 QQ 小程序 `game.js`

说明：

- 浏览器支持 `showSaveFilePicker` 时，会弹系统保存框
- 不支持时，会走普通文件下载

### 方式 2：网页一键打补丁

前提：

- 已配置 `FARM_QQ_GAME_JS`
- 或已配置 `FARM_QQ_APPID`
- 或在控制页里临时填写 `appid`

1. `npm run start -- --qq`
2. 打开控制页
3. 进入“运行时”页签
4. 若未配置默认值，先填写 `QQ 小程序 AppID`
5. 点击“一键打补丁”

补丁行为：

- 首次写入时会生成 `game.js.qq-farm.bak`
- 重复执行会替换旧标记区块，不会无限追加
- 若未显式配置 `FARM_QQ_GAME_JS`，会扫描 `%APPDATA%\\QQEX\\miniapp\\temps\\miniapp_src` 下 `appid_*` 目录，并选取最近更新的一份 `game.js`

### 方式 3：命令行生成 / 打补丁

仅当你想绕过网页时使用。

只生成 bundle：

```bash
npm run qq:bundle
```

直接补丁：

```bash
npm run qq:patch
```

也可以临时指定 appid：

```bash
npm run qq:patch -- --qq-appid 1112386029
```

### 方式 4：导出当前小程序缓存里的全部图片

会按项目现在的产物形式，把当前 QQ 小程序缓存目录里的图片统一复制到仓库根目录 `_miniapp_extracted_images/`，并生成 `manifest.json`。

默认按 `FARM_QQ_APPID` 自动定位最新缓存目录：

```bash
npm run qq:images
```

也可以临时指定 appid：

```bash
npm run qq:images -- --qq-appid 1112386029
```

或者直接指定某个缓存目录：

```bash
npm run qq:images -- --miniapp-dir "C:\Users\xxx\AppData\Roaming\QQ\miniapp\temps\miniapp_src\1112386029_xxx"
```

## 微信路线使用方式

1. `npm run start -- --wx`
2. 打开目标小游戏
3. 打开控制页
4. 等待上下文就绪
5. 页面会自动注入 `button.js`

说明：

- 微信路线下，画面预览、点击、拖动都走 CDP
- 若出现 `CDP timeout`，一般先检查小游戏是否真的在前台、调试链路是否还活着

## 当前能力

- 微信 CDP 路线自动探测上下文并自动注入 `button.js`
- QQ WebSocket 宿主链路
- QQ bundle 生成
- QQ `game.js` 一键打补丁
- QQ `appid -> 最新版本目录 -> game.js` 自动发现
- 自动农场调度：
  - 自己农场一键收获 / 浇水 / 除草 / 杀虫 / 自动种植 / 自动施肥
  - 好友列表刷新、进入好友农场、一键偷菜 / 好友帮忙
  - 好友偷菜与好友帮忙支持独立巡查间隔；好友帮忙支持子动作拆分
  - 自动回家
- 仓库页与仓库调度：
  - 四页签仓库聚合预览
  - 仓库本地缓存与后台定时刷新
  - 卡片出售、批量出售、自动定时出售
  - 独立出售设置区、固定四类可售类别、按出售范围选中
  - 刷新与自动出售合并为同一次仓库会话
- 地块详情与单地块手动 `无机 / 有机` 施肥
- 土地详情阶段图、主图与默认图统一走 `gameConfig/plant_images/` 资源目录
- 智能施肥支持按当前季最长生长期判断无机肥施肥时机，并在日志中显示“等待智能施肥阶段”等调试信息
- 好友列表获取、进入指定好友农场、单个好友手动偷菜 / 帮忙
- 运行时状态页、账户状态页、独立日志中心
- 异常通知与日报消息推送
- CDP 画面预览与网页点击 / 拖动输入
- 自动农场地块级 / 好友级日志展示
- 账户状态缓存、好友帮忙状态缓存、自动施肥状态缓存
- 页面左侧 GitHub 项目说明悬浮入口

## 默认端口

| 服务 | 默认值 |
|------|------|
| 微信调试 WebSocket | `9421` |
| CDP 代理 | `62000` |
| 网关 HTTP | `8787` |
| 网关控制 WebSocket | `/ws` |
| QQ 宿主 WebSocket | `/miniapp` |

## 常见说明

### 为什么 QQ 和微信不是同一条底层链路

不是故意拆开，而是宿主条件不同：

- 微信这边本来就有调试链路，适合走 CDP
- QQ 这边能直接改资源文件，适合走“常驻宿主 + 本机 WebSocket”

所以统一的是“启动入口”和“网页控制台”，不是强行把两端伪装成同一种底层协议。

### 为什么 QQ 预览还没有网页实时画面

当前网页实时预览还是 CDP 能力。QQ 路线现在先解决的是自动化控制链路和工程化补丁，没把画面采集也接到宿主里。

## 免责声明

- 本仓库仅供学习、研究与安全测试
- 作者与贡献者与腾讯、QQ、微信及其小游戏无关联
- 对第三方软件进行注入、调试或自动化，可能违反协议并导致封号、限制功能或其他后果
- 一切风险由使用者自行承担

## 许可证

本项目使用 [GNU GPL v3.0](LICENSE)。
