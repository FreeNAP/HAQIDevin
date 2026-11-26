# Devin Remote — 产品需求文档（PRD）

> 版本：v1.0 · 2026-11-25
> 状态：待评审（UI 风格选定后进入开发）
> 参考对象：T3 Code（pingdotgg/t3code）的 ACP 控制面思路

---

## 一、背景与目标

### 1.1 背景

T3 Code 证明了一个产品形态：**在用户的机器上跑一个本地服务器，由它统一驱动本机已安装的 coding agent（通过 ACP 协议），桌面 / Web / 手机多端连接同一个服务器，人在办公桌前发起任务，出门后在手机上审批下一步。**

Devin CLI 从 v3000 起原生内置 `devin acp` 子命令——一个标准的 ACP（Agent Client Protocol，Zed 主导的开放协议）服务端，走 JSON-RPC over stdio。这意味着 Devin 可以被任何 ACP 客户端以程序化方式驱动，具备复刻 T3 Code 形态的全部基础条件。

T3 Code 的远程依赖它自己的托管服务 T3 Connect。本项目不依赖任何托管中继：**用户自己配置域名 + Cloudflare Tunnel，连接通道完全掌握在用户自己手里**，VSIX 插件负责把隧道做成"打开 Devin 即在线"的零维护体验。

### 1.2 产品目标

| # | 目标 | 验收标准 |
|---|------|---------|
| G1 | 在桌面 IDE 外远程驱动本机 Devin CLI | 手机端发起 prompt，本机 devin acp 执行，流式输出实时回显，延迟 < 1s（同城网络） |
| G2 | 打开 Devin Desktop 即自动建立稳定隧道 | VSIX 插件激活后 10s 内隧道连通，断线自动重连，7×24 小时不手动干预 |
| G3 | 隧道配置完全自助 | 用户在插件设置页填入自己的域名和 Cloudflare 凭据，一键验证、一键修复 |
| G4 | 手机端完整覆盖核心闭环 | 会话列表 / 新建会话 / 流式对话 / 权限审批 / 取消 / 切换模式与模型 |
| G5 | 连接安全可控 | 设备配对制（一次性配对码），未配对设备无法建立会话；配对码可撤销 |

### 1.3 非目标（本期不做）

- 不实现多人协作 / 团队共享一台主机
- 不做文件浏览器、Git diff 审查、终端全功能仿真（T3 Code 有，列入 v2 候选）
- 不做云端托管中继服务（与产品定位相悖）
- 不上架 App Store / Google Play（侧载 / 内部分发即可）
- 不驱动 Devin Cloud 会话（只驱动本机 `devin acp`；云端会话经 `devin --cloud` 列入 v2 候选）

---

## 二、参考对象分析：T3 Code 的 ACP 思路

### 2.1 T3 Code 架构拆解

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Desktop    │  │  Web        │  │  iOS/Android│
│  client     │  │  client     │  │  client     │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       └────────────────┼────────────────┘
                        │ 同一服务器，多端同状态
               ┌────────▼────────┐
               │  T3 Code server  │  ← 跑在用户机器上
               │  (orchestration) │
               └────────┬────────┘
                        │ ACP: JSON-RPC over stdio
        ┌───────┬───────┼───────┬────────┐
        ▼       ▼       ▼       ▼        ▼
    Claude   Codex   Cursor  OpenCode  任意ACP agent
```

可复用的核心思路：

1. **Agent 进程化**：agent 是被 spawn 的子进程，协议是 NDJSON（换行分隔的 JSON-RPC 2.0），服务器是协议客户端。
2. **多端一服**：所有客户端连同一个服务器，会话状态在服务器侧，换设备无缝衔接。
3. **配对制远程访问**：一次性配对链接 / 配对码授权设备，设备可撤销，30 天不用失效。
4. **审批随身走**：agent 的权限请求（permission request）被推送到手机，人在外面也能批准关键步骤。

### 2.2 本项目与 T3 Code 的差异

| 维度 | T3 Code | Devin Remote |
|------|---------|--------------|
| 驱动的 agent | 十几种（Claude/Codex/…） | 只驱动 Devin（`devin acp`），做深做透 |
| 远程通道 | 托管 T3 Connect / LAN / Tailscale | **用户自有 Cloudflare Tunnel + 自有域名**（也支持 LAN 直连） |
| 隧道运维 | 用户无感知（托管） | VSIX 插件全自动：装 cloudflared、起隧道、断线重连、健康检查 |
| 控制端 | 桌面 + Web + 手机 | VSIX 内嵌面板 + 手机 App（Web 端附带在服务器上，免安装应急用） |

---

## 三、系统总体架构

### 3.1 架构图

```
                        ┌──────────────────────────────────────────┐
                        │            用户桌面机器 (Windows/macOS)    │
                        │                                          │
  ┌───────────────┐     │  ┌────────────────────────────────────┐  │
  │  手机 App      │     │  │  Devin Desktop IDE                 │  │
  │  (React Native│     │  │  ┌──────────────────────────────┐  │  │
  │   / Expo)     │     │  │  │ VSIX 扩展 devin-remote        │  │  │
  └───────┬───────┘     │  │  │  · 隧道管理器 (cloudflared)   │  │  │
          │             │  │  │  · 服务器守护 (内嵌 server)   │  │  │
          │  WSS/HTTPS  │  │  │  · 设置界面 + 状态面板 webview│  │  │
          │             │  │  └──────────────┬───────────────┘  │  │
  ┌───────┴───────┐     │  │                 │ spawn/stdio       │  │
  │ Cloudflare    │     │  │  ┌──────────────▼───────────────┐  │  │
  │  edge network │◀────┼──┼──│ devin-remote-server          │  │  │
  │  (用户域名)    │     │  │  │  · ACP 客户端 (JSON-RPC)      │  │  │
  └───────▲───────┘     │  │  │  · 会话管理 / 状态持久化      │  │  │
          │             │  │  │  · WebSocket + HTTP API      │  │  │
          │ cloudflared │  │  │  · 配对与设备鉴权            │  │  │
          │ tunnel      │  │  └──────┬───────────────┬──────┘  │  │
          │             │  │         │ stdio         │ stdio    │  │
          │             │  │  ┌──────▼─────┐  ┌──────▼─────┐   │  │
          │             │  │  │ devin acp  │  │ devin acp  │ … │  │
          │             │  │  │ (session A)│  │ (session B)│   │  │
          │             │  │  └────────────┘  └────────────┘   │  │
          │             │  └────────────────────────────────────┘  │
          └─────────────┘   (cloudflared 进程，VSIX 扩展托管)
                        └──────────────────────────────────────────┘
```

### 3.2 三大组件

| 组件 | 名称 | 技术栈 | 职责 |
|------|------|--------|------|
| A | **devin-remote-server** | Node.js 24 + TypeScript, `ws`, 无框架 HTTP | ACP 客户端：spawn `devin acp` 子进程，实现 ACP client 侧方法（权限 / 文件 / 终端）；对外暴露 WebSocket + HTTP API；设备配对与鉴权；会话状态持久化 |
| B | **devin-remote-vscode** (VSIX) | TypeScript, VS Code Extension API | Devin Desktop 启动即激活；下载/校验 cloudflared；按用户配置启动命名隧道；断线重连与健康检查；内嵌 server 生命周期管理；设置页 + 状态面板 webview；配对码生成与 QR 展示 |
| C | **devin-remote-mobile** | React Native + Expo (TypeScript) | 手机端：连接管理（多主机）、会话列表、流式对话、权限审批、模式/模型切换、推送级通知（本地通知） |

> 组件 A 同时托管一个**应急 Web 客户端**（静态单页，复用手机端 UI 编译产物）：浏览器打开 `https://<用户域名>` 即可用，作为 App 之外的 fallback。

### 3.3 关键数据流

**发起一次远程 prompt（手机 → Devin）：**

```
手机App ──WSS──▶ Cloudflare edge ──tunnel──▶ devin-remote-server
                                                  │ session/prompt (JSON-RPC over stdio)
                                                  ▼
                                              devin acp 子进程
                                                  │ session/update 通知流 (agent_message_chunk 等)
手机App ◀──WSS── Cloudflare edge ◀──tunnel── devin-remote-server ◀┘
```

**权限审批（Devin 需要用户批准一个工具调用）：**

```
devin acp ──▶ server 收到 session/request_permission（ACP client 方法）
           ──▶ 推送到所有在线客户端（手机震动/横幅）
手机 App ◀── 用户点 "允许一次"
           ──▶ server 把选择结果作为 JSON-RPC response 回给 devin acp
```

---

## 四、ACP 协议映射设计

### 4.1 协议基础

- 传输：NDJSON（每行一个 JSON-RPC 2.0 对象）over stdio
- server 作为 **ACP Client**，`devin acp` 作为 **ACP Agent**
- 每个会话一个 `devin acp` 子进程（会话隔离，崩溃互不影响；`session/load` 用于恢复）

### 4.2 server 必须实现的 ACP 交互

**初始化与鉴权：**

| 方向 | 方法 | 处理 |
|------|------|------|
| client→agent | `initialize` | 协商协议版本，声明 clientCapabilities：`fs`(read/write)、`terminal`: false（v1 不代理终端）、`elicitation`: 按需 |
| client→agent | `authenticate` | devin acp 默认读 `devin auth login` 存的凭据；未登录时引导用户在桌面完成登录，server 透传 auth 状态 |
| client→agent | `session/new` | 参数带 `cwd`（用户选择的工作目录）与 `mcpServers: []` |
| client→agent | `session/load` | 若 agent 声明 `loadSession` 能力则支持恢复历史会话 |

**Prompt 回合：**

| 方向 | 方法 | 处理 |
|------|------|------|
| client→agent | `session/prompt` | 转发用户消息（text content blocks） |
| agent→client | `session/update` 通知 | **核心数据流**：`agent_message_chunk` / `user_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `available_commands_update` / `current_mode_update` —— server 原样序列化转发给在线客户端，同时落盘 |
| client→agent | `session/cancel` 通知 | 用户按"停止" |
| agent→client | `session/prompt` 响应 | `stopReason`: `end_turn` / `cancelled` / `max_tokens` / `refusal` |

**server 作为 ACP client 必须实现的回调方法：**

| 方法 | server 行为 |
|------|------------|
| `session/request_permission` | 挂起 JSON-RPC 请求 → 广播到客户端 → 任一客户端的选择作为 response 返回；支持超时策略（默认不超时，等用户） |
| `fs/read_text_file` | 在宿主机真实读文件（路径必须落在会话工作目录白名单内，防逃逸）后返回内容 |
| `fs/write_text_file` | 同上，写文件。写入操作同样受权限模式约束——devin acp 自身会先走 `request_permission` |
| `elicitation/create`（可选） | 结构化提问转发到客户端表单 |

> `terminal/*` 系列在 v1 声明不支持（capability 不声明），devin acp 会自行在其进程内执行 shell（它本机执行，不需要 client 终端）。v2 再评估终端输出代理。

### 4.3 Devin 特有能力的暴露

devin acp 通过 ACP 暴露的 slash commands（`/model` `/mode` `/plan` `/compact` 等）经 `available_commands_update` 到达 server。手机端把 slash commands 做成输入框的 `/` 自动补全菜单，原样透传，server 不做硬编码——**命令集随 devin 升级自动更新**。

模式切换（normal/plan/bypass…）走 `session/set_mode`；模型选择走 devin 的 `/model` 命令通道。server 在会话元数据里缓存当前 mode/model，新连入的客户端立即可见。

---

## 五、Cloudflare 隧道方案详细设计

### 5.1 为什么选命名隧道 + 自有域名

| 方案 | 稳定性 | 域名 | 结论 |
|------|--------|------|------|
| Quick Tunnel（trycloudflare） | 每次随机 URL，会变 | 无 | 否，违反 G2 |
| **命名隧道 + 用户自有域名** | 固定 hostname，cloudflared 4 路 HA 连接 | 用户自己的 | **采用** |
| Tailscale / LAN | 不出内网或依赖第三方 overlay | — | 作为补充通道（server 同时监听 LAN） |

### 5.2 用户需要准备什么（一次性，约 5 分钟）

1. 一个域名托管在 Cloudflare（免费计划即可）
2. 在 Cloudflare Zero Trust Dashboard → Networks → Tunnels 创建一条隧道，拿到 **Tunnel Token**（`eyJ...` 长串）
3. 给隧道配一个 Public Hostname，例如 `devin.example.com` → `http://localhost:8787`

VSIX 设置页逐项引导这三步，附截图级指引与一键打开对应 dashboard 页面。

### 5.3 VSIX 插件的隧道管理职责

```
Devin Desktop 启动
   │ extension activate
   ▼
读取配置 devinRemote.tunnelToken / devinRemote.hostname
   │ 未配置 → 状态栏显示 "Devin Remote: 未配置"，webview 引导，不阻塞 IDE
   ▼ 已配置
确保 cloudflared 二进制存在
   │ 没有 → 按平台下载官方 release（windows-amd64 / darwin / linux），
   │        校验 SHA256（版本固定，hash 内置表），存到 <extensionStorage>/bin/
   ▼
spawn: cloudflared tunnel --no-autoupdate run --token <TOKEN>
   │
   ├─ 监控 stdout/stderr：出现 "Registered tunnel connection" ×4 → 状态=已连接
   ├─ 进程退出 → 指数退避重启（1s→2s→…→上限 60s），状态栏实时反映
   └─ 每 30s 主动健康检查：https://<hostname>/api/health（走公网回环验证端到端真实可达）
```

关键设计点：

- **端到端健康检查走公网**（不是只查本地端口），因为隧道通 ≠ 服务通，用户关心的是"手机能不能连上"。连续 3 次失败 → 重启 cloudflared；仍失败 → 状态栏红色 + 诊断面板一键复制日志。
- `--no-autoupdate`：版本由扩展统一管理，避免 cloudflared 自动更新把进程搞挂。
- IDE 关闭时优雅终止 cloudflared（deactivate 钩子，3s 内 kill）。
- 同时支持**本地配置文件模式**（高级用户）：不用 token，改用 `cert.pem` + `credentials.json` + `config.yml` 路径，插件只做进程托管。

### 5.4 server 监听与绑定

- server 默认只绑 `127.0.0.1:8787`（隧道回源）+ 可选 `0.0.0.0`（LAN 直连模式，用户在设置里显式开）
- 隧道入口：`https://devin.example.com` → cloudflared → `http://localhost:8787`
- WebSocket 端点 `/ws`，HTTP API `/api/*`，静态 Web 客户端 `/`
- Cloudflare 免费版 WebSocket 直接可用，无需额外配置

---

## 六、安全模型

### 6.1 威胁模型

- 隧道把 server 暴露在公网域名下——**任何扫到域名的人都能摸到登录口**，所以鉴权必须在应用层做死，不依赖"域名保密"。
- devin acp 拥有本机文件与 shell 的高权限，泄露等于主机沦陷。

### 6.2 配对制设备授权（借鉴 T3 Code，简化）

```
未配对设备 → 打开 https://devin.example.com → 只看到配对页
   │
   │ 输入 8 位配对码（XXXX-XXXX）
   ▼
配对码哪来的？→ VSIX 面板点 "生成配对码" / 手机扫码
   │ 配对码 5 分钟有效、一次性、本地 constant-time 比对
   ▼
配对成功 → server 签发设备证书：
   · deviceId + deviceSecret（256bit 随机）存手机安全存储
   · server 端存 deviceId / 设备名 / 签发时间 / 最近活跃
   ▼
之后每次连接：WSS 握手带 deviceId + 基于 deviceSecret 的 HMAC 签名挑战响应
```

- **撤销**：VSIX 面板 / 手机端可列出已配对设备，逐个撤销，即时生效（踢掉在线连接）。
- **30 天未活跃自动失效**（沿用 T3 Code 经验值）。
- pairing code 生成限频：每 IP 每分钟 5 次尝试，失败 10 次锁 15 分钟——防爆破 8 位码。
- 可选增强（v1 就带）：Cloudflare Access（Zero Trust）前置认证——高级用户可在 dashboard 自己叠加，文档里教，不强制。

### 6.3 其他安全约束

- server 所有 HTTP 接口要求设备鉴权（除 `/api/health` 返回裸 200 无信息）
- fs 读写路径约束在会话 cwd 白名单内，拒绝 `..` 逃逸与符号链接逃逸
- TLS 由 Cloudflare edge 终止；tunnel 回源本地 HTTP 不出本机回环，可接受
- 配对码、deviceSecret 不落日志；日志脱敏检查纳入验收
- server 配置目录 `~/.devin-remote/` 权限 700

---

## 七、功能需求详述

### 7.1 手机端 App

| 编号 | 功能 | 描述 | 优先级 |
|------|------|------|--------|
| M1 | 主机连接管理 | 添加多台主机（域名 + 配对码），QR 扫码配对，连接状态指示 | P0 |
| M2 | 会话列表 | 全部会话（跨目录），按最近活跃排序，未读/待审批角标，下拉刷新 | P0 |
| M3 | 新建会话 | 选择主机上预设的工作目录（server 端配置常用目录清单）→ `session/new` | P0 |
| M4 | 流式对话 | 消息气泡，agent 输出 markdown 渲染 + 代码高亮，thought 折叠显示，流式打字机 | P0 |
| M5 | 工具调用卡片 | tool_call 渲染成卡片：工具名、状态（pending/running/completed/failed）、可展开参数摘要；文件编辑显示 diff 摘要 | P0 |
| M6 | 权限审批 | 请求横幅/全屏卡片：工具名 + 关键参数（命令行/文件路径），按钮按 ACP 选项渲染（允许一次/总是允许/拒绝）；超时提示 | P0 |
| M7 | 计划展示 | plan 更新渲染为 checklist 卡片，进行中项高亮 | P1 |
| M8 | 模式与模型 | 底部栏切换 mode（normal/plan/bypass…）、`/model` 选择模型；slash command 自动补全 | P1 |
| M9 | 取消与中断 | 长按停止按钮 → `session/cancel`；turn 结束状态清晰 | P0 |
| M10 | 会话恢复 | 重启 App 后回到会话，从 server 拉全量历史（server 持久化了 update 流） | P0 |
| M11 | 本地通知 | App 在后台时，权限请求 / turn 完成触发本地通知（轮询推送扩展 v2） | P1 |
| M12 | 多会话并行 | 同时多个会话各跑各的，会话间快速切换 | P1 |
| M13 | 设备管理 | 查看/重命名/撤销本账号下设备 | P2 |

### 7.2 VSIX 插件

| 编号 | 功能 | 描述 | 优先级 |
|------|------|------|--------|
| V1 | 启动自激活 | `onStartupFinished` 激活，不阻塞 IDE；首次运行弹欢迎向导 | P0 |
| V2 | 设置向导 webview | 三步引导：①装/查 cloudflared ②填 Tunnel Token + 域名 ③验证连通（分步进度 + 错误诊断文案） | P0 |
| V3 | 隧道守护 | cloudflared 生命周期管理（见 §5.3），指数退避重连，公网健康检查 | P0 |
| V4 | server 守护 | 内嵌 devin-remote-server（Node 子进程），随 IDE 启动/关闭；端口冲突自动换端口并同步改隧道回源提示 | P0 |
| V5 | 状态栏 | 图标 + 文字实时状态：未配置/连接中/已连接(绿)/异常(红)；点击打开面板 | P0 |
| V6 | 控制面板 webview | 仪表盘：隧道状态、server 状态、在线设备数、活跃会话数；配对码生成 + QR；设备列表与撤销；日志查看；一键复制诊断信息 | P0 |
| V7 | 内嵌聊天视图 | 侧栏直接和本机 devin acp 会话（复用与手机端同一套 API，本质是第三个客户端） | P1 |
| V8 | 工作目录管理 | 配置手机端可选的工作目录清单（默认含当前 workspace） | P1 |
| V9 | 高级模式 | 本地配置文件隧道（cert.pem 模式）；自定义 server 端口；LAN 直连开关 | P2 |

### 7.3 devin-remote-server

| 编号 | 功能 | 描述 | 优先级 |
|------|------|------|--------|
| S1 | ACP 桥 | spawn/管理 devin acp 子进程池（每会话一个），完整实现 §4.2 协议交互 | P0 |
| S2 | 会话持久化 | 每会话的事件流（update 通知）落盘 SQLite/JSONL，客户端断线重连可全量回放 | P0 |
| S3 | WebSocket 网关 | `/ws` 多客户端广播，订阅制（按 sessionId），背压处理 | P0 |
| S4 | HTTP API | `/api/health` `/api/pair` `/api/sessions` `/api/devices` 等 REST 端点 | P0 |
| S5 | 配对与鉴权 | §6.2 全套 | P0 |
| S6 | 应急 Web 客户端 | 静态托管手机端同构 UI（PWA），浏览器直接用 | P1 |
| S7 | 进程自愈 | devin acp 子进程崩溃 → 标记会话异常，支持一键 respawn + `session/load` 恢复 | P1 |
| S8 | 优雅停机 | SIGTERM 时拒绝新连接、等待在途 prompt 到达自然停止点或可中断点，写入一致性保证 | P1 |

---

## 八、核心用户流程

### 8.1 首次配置（桌面，10 分钟内完成）

1. 用户在 Cloudflare dashboard 建隧道、配 hostname、复制 token（5 分钟，指引精确到点哪个按钮）
2. Devin Desktop 里装 VSIX → 欢迎向导 → 粘贴 token + 域名 → 点"验证并启动"
3. 插件跑完检查链：cloudflared 就绪 → 隧道 4 连接注册 → server 起来 → 公网健康检查 200 → 绿色"已连接"
4. 点"生成配对码" → 屏幕显示 QR + 8 位码

### 8.2 手机接入（2 分钟）

1. 手机装 App（Expo 侧载 / 内部测试包）→ 扫 QR 或手输域名 + 配对码
2. 配对成功 → 进入会话列表（首次为空）→ 点 "+" 选工作目录 → 新会话
3. 输入"帮我把这个项目的 README 翻译成中文" → 桌面 devin 开始干活，手机实时流式输出
4. devin 要写文件 → 手机弹权限卡片 → 通勤路上点"允许" → 任务继续

### 8.3 日常一天

- 早上桌面发起大重构任务 → 出门
- 地铁上手机审批了 3 次权限请求，追加了一句"测试也一起改了"
- 到办公室打开 Devin Desktop，VSIX 侧栏看到同一会话，接着用键盘继续——**同一份会话状态，无缝接续**

---

## 九、技术选型与理由

| 决策点 | 选择 | 理由 |
|--------|------|------|
| server 语言 | Node.js 24 + TypeScript | 与 VSIX 同语言可共享 ACP 类型定义包；`ws` 成熟；Node 24 本机已有 |
| ACP 实现 | 参考 `@zed-industries/agent-client-protocol` TS SDK 类型，自实现 client 侧（SDK 偏 agent 侧） | 协议稳定 v1 + 类型可生成；T3 Code 用的 effect-acp 过重 |
| server 存储 | SQLite（better-sqlite3）+ JSONL 事件日志双写 | 事件流追加写快，SQLite 查会话元数据；零依赖部署 |
| VSIX | esbuild 打包单文件，无重型依赖 | VS Code 扩展标准做法，冷启动快 |
| cloudflared 获取 | 扩展首次运行按平台下载官方 release + SHA256 校验 | 不捆绑二进制（VSIX 体积），不依赖用户预装 |
| 手机端 | **React Native + Expo (SDK 52+)** | TypeScript 全栈统一；Expo 免去原生构建链，iOS/Android 一套代码；WebSocket/Markdown/通知生态成熟 |
| 手机端状态 | Zustand + 有序事件 reducer | ACP 事件流本质是 append-only log，reducer 重放天然匹配断线恢复 |
| 通信协议 | WSS 上跑 JSON-RPC-ish 自定义 envelope（type/id/payload） | 简单可控；ACP 语义原样嵌套在 payload 里，不做有损转换 |
| 应急 Web 端 | 手机端 Expo Web 导出或独立轻量 PWA | 零额外开发量优先复用 |

---

## 十、项目结构（monorepo）

```
HAQIDevin/
├── PRD.md                          ← 本文档
├── mockups/                        ← UI 风格样稿（选定后归档）
├── package.json                    ← npm workspaces 根
├── tsconfig.base.json
├── packages/
│   ├── acp-types/                  ← ACP 协议 TypeScript 类型 + NDJSON 编解码（三方共享）
│   ├── protocol/                   ← server↔client 自定义 envelope 类型 + 配对/鉴权消息
│   ├── server/                     ← devin-remote-server (组件A)
│   │   ├── src/acp/                ← ACP client：进程 spawn、JSON-RPC、会话运行时
│   │   ├── src/gateway/            ← WebSocket + HTTP API
│   │   ├── src/auth/               ← 配对、设备、HMAC 挑战
│   │   ├── src/store/              ← SQLite + JSONL 持久化
│   │   └── src/web/                ← 应急 Web 客户端静态托管
│   ├── vscode-extension/           ← VSIX (组件B)
│   │   ├── src/tunnel/             ← cloudflared 下载/校验/守护
│   │   ├──src/serverHost/          ← server 进程托管
│   │   ├── src/views/              ← 状态栏、控制面板 webview、设置向导
│   │   └── media/                  ← webview 前端（选定风格的实现）
│   └── mobile/                     ← Expo App (组件C)
│       ├── app/                    ← expo-router 页面
│       ├── src/ws/                 ← 连接层：重连、鉴权、事件分发
│       ├── src/store/              ← Zustand + 事件 reducer
│       └── src/components/         ← 消息流/工具卡片/权限卡片/模式栏
└── docs/
    ├── setup-cloudflare.md         ← 隧道配置图文指引
    └── security.md                 ← 安全模型说明
```

---

## 十一、里程碑计划

| 里程碑 | 内容 | 验收 |
|--------|------|------|
| **MS0 设计定稿** | PRD 评审 + 5 风格样稿选定 1 套 | 用户选定风格 |
| **MS1 打通脊柱** | acp-types + server 最小版：spawn devin acp → 命令行脚本发 prompt → 收到流式 update | 脚本端到端跑通一个 turn |
| **MS2 远程可达** | VSIX 最小版：隧道守护 + server 托管 + 状态栏 | 公网域名访问 `/api/health` 返回 200 |
| **MS3 配对安全** | 配对码、设备鉴权、WSS 网关 | 未配对设备拿不到任何数据 |
| **MS4 手机端闭环** | App：连接/会话/流式对话/权限审批/取消 | 走通 §8.2 全流程 |
| **MS5 面板与抛光** | VSIX 控制面板、内嵌聊天、web 应急端、通知 | 走通 §8.3 |
| **MS6 硬化** | 断线重连矩阵测试、崩溃恢复、日志脱敏审计、7×24h 稳定性 soak | 验收标准全绿 |

---

## 十二、验收标准（Definition of Done）

**功能：**
- [ ] §8.2 / §8.3 两个流程实景走通（录屏为证）
- [ ] 手机端杀掉重开 App，会话历史完整恢复，流式续接无重复无丢失
- [ ] 拔掉网线 60s 恢复后：隧道自动重连 ≤ 30s，手机端自动重订阅，无消息丢失

**稳定：**
- [ ] cloudflared 被 `taskkill` 强杀后 5s 内被插件拉起
- [ ] devin acp 进程崩溃不拖垮 server，其他会话不受影响
- [ ] 72 小时挂机：隧道在线率 ≥ 99.5%（健康检查日志为证）

**安全：**
- [ ] 错误配对码 10 次触发锁定；未配对请求一律 401
- [ ] `fs/read_text_file` 请求 `../../../../etc/passwd` 类路径被拒绝
- [ ] 全量日志 grep 不到配对码与 deviceSecret 明文

**体验：**
- [ ] 手机端流式输出首字节延迟 < 1.5s（同省网络）
- [ ] 权限请求到手机震动/横幅 < 1s
- [ ] 设置向导每步失败都有"怎么办"的具体文案，不出现裸报错

---

## 十三、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| devin acp 协议行为与文档有出入 | ACP 桥返工 | MS1 最先做，用真实 devin acp 做协议探针（先把 initialize/new/prompt 全跑一遍录下真实报文） |
| Cloudflare 免费版 WS 长连接被周期性重置（~100s 空闲传言） | 手机端断流 | 心跳 ping/pong 15s；客户端自动重连 + 事件序号补拉（resume token） |
| Windows 上 cloudflared 被安全软件拦截 | 隧道起不来 | 诊断面板明确提示 + 签名二进制 + 提供手动安装 fallback 路径 |
| ACP 的 fs 回调使 agent 写文件依赖 server 响应速度 | 卡顿 | fs 操作本地执行微秒级；权限请求才是人工瓶颈，UI 上分开计时 |
| Expo iOS 侧载门槛高 | 装机麻烦 | 安卓直装 APK 优先；iOS 用 Expo Go 开发模式 / TestFlight 内部测试；应急 Web 端兜底 |
| 用户填错隧道配置 | 连通失败差评 | 向导逐步验证，错误精确定位到"token 无效 / hostname 未配 / 回源端口错"三种之一并给修法 |

---

## 十四、开放问题（开发前需确认）

1. **手机端范围**：本次先 Android APK + Expo Go，还是要同步准备 iOS TestFlight？（影响证书准备）
2. **UI 风格**：见 mockups/ 五套样稿，选定后全项目统一。
3. 工作目录清单：是否默认只允许 IDE 当前打开的 workspace，还是用户自由配置任意目录？（安全与便利的权衡，PRD 默认后者但需确认）
4. 是否需要局域网直连模式（不走 Cloudflare，同 WiFi 直连）并进 v1？（成本低，价值高，倾向做）

---

## 十四、v2 需求批次 (2026-11-25 用户验收后增补)

> 来源：用户实机验收后提出的功能总单。施工顺序按依赖排列——本地构建环境是所有 mobile 迭代的前提。

### 批 0 — 本地 APK 构建环境 (一切迭代的前提)
- JDK 17 便携版解压至 `C:\Users\30744\dev-tools\jdk-17` (下载已进行中: dev-tools/jdk17.zip)
- Android SDK cmdline-tools + platform-34 + build-tools (dev-tools/sdk-tools.zip 下载中)
- `tools\build-apk-local.bat` 一键: 设 JAVA_HOME/ANDROID_HOME → gradlew assembleRelease → adb install
- 目标: 增量构建 3-8 分钟装机, 告别 CI 30 分钟

### 批 A — 会话能力增强
1. **历史时间线定位**: 会话内完整历史 (session.history 翻页 UI 接入, server 接口已上线), 类似 IDE 的历史列表, 点击条目定位跳转到对应消息位置
2. **回撤 (revert)**: 会话可回退到历史某个检查点 — acp initialize 显示 revert=false, 需探针 devin acp 是否支持 session/revert 或 checkpoint 机制; 不支持则 UI 层做"复制该点之前上下文重开会话"
3. **引用文件功能**: 输入栏 @ 触发文件选择, 引用文件内容/路径注入 prompt

### 批 B — 侧边栏资源管理器 (对话页右上角)
1. 对话页右上角开侧边栏 = 文件资源管理器 (cwd 树形浏览)
2. 每个文件后有引用按钮 → 点击应用到对话输入栏
3. 长按文件: 复制/剪切/粘贴/删除/复制路径 (server fs 监狱已有 read/write, 需补 delete/move/copy API)
4. server 端: fs API 扩展 (readdir 已有? 查 packages/server/src/fs)

### 批 C — 配置中心手机端
1. **workdirs 手机端设置**: 查看/添加/删除工作目录 (server API 读写 config.json + 热生效, 注意 VSIX syncConfig 合并已修复不会丢)
2. **rules 查看编辑**: devin rules 的读取/修改 (CLI `devin rules` 体系, 存储位置待探针)
3. **MCP 配置查看修改**: mcp servers 配置读写
4. **工作区设置**: 同步 IDE 工作区相关配置

### 批 D — 账户/设备/git
1. **额度显示**: 付费额度剩余/周限/日限/额外额度/到期时间 — 已探明线索:
   - acp usage_update 事件 _meta 有 totalCreditCost/totalAcuCost/inputTokens (server events 已持久化, 可直接用)
   - CLI 二进制藏完整 quota 字段族: weekly_quota_remaining_percent / overage_balance_micros / daily_quota_reset_at_unix / weekly_quota_reset_at_unix / acu_consumed / acu_limit / quota_exhausted — 说明后端有额度查询响应结构
   - 下一步: playwright (app.devin.ai 登录态仍在) 抓 web 前端的 usage API 网络请求, 或 connect-RPC 通道探测 GetUsage 类方法; IDE cascade 的 usage 弹窗数据源在 language server wasm
2. **git 功能**: 手机端 git status/diff/commit/push — 关键痛点: Windows git 凭据弹窗每次手动点; 方案: 预置 credential.helper store 或 PAT 入仓配置, 后台自动认证
3. **token 自动获取**: devin auth token 自动化 (已有 pywinpty+playwright 全自动化链路, 产品化为 server 后台定时校验/自动续期)
4. **已撤销设备记录删除**: server API + mobile 设备管理 UI 删除按钮

### 已完成 (本会话)
- [x] 模型清单解锁 319 个 + 默认 swe-2-1-max 端到端生效
- [x] 旧会话模型缓存刷新链路 (subscribe→后台 load→session.loaded→merge)
- [x] VSIX syncConfig 丢字段修复

---

## 十五、施工进度快照 (2026-11-25 深夜, 会话 emerald-straw 收尾时)

### 环境状态
- JDK 17: ✅ 就绪 `C:\Users\30744\dev-tools\jdk-17`
- Android SDK: 🟡 `C:\Users\30744\dev-tools\android-sdk`
  - cmdline-tools ✅ / build-tools 34.0.0 ✅ / platform-tools ✅(待验证完整性, zip 只有 15 entries 可能不全, 不全则用 sdkmanager 补)
  - **platforms;android-34 缺失** — sdkmanager 代理模式后台下载中 (dev-tools/platform-status.log); 若失败, 腾讯镜像正确文件名待查 (mirrors.cloud.tencent.com/AndroidSDK/ 的 platform-34_r03.zip 下载为 0B 失败, 可能文件名不对; 备选: 用 sdkmanager 配 JAVA_TOOL_OPTIONS 代理参数)
- 下载加速结论: 腾讯镜像直连 2-5MB/s 可用; dl.google.com 直连/代理都极慢; sdkmanager 走代理需 JAVA_TOOL_OPTIONS="-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=10808"
- adb 现成可用: `tools\platform-tools\adb.exe` (repo 内)
- 首次构建命令就绪: `tools\build-apk-local.bat` (android 目录不存在会自动 prebuild)

### 代码施工状态 (下次收割)
- **子 agent A (server v2 API)**: fs.list/read/delete/move/copy、workdir.add/remove、rules/mcp 读写、git.status/diff/commit/push/pull、account.quota 额度探针 — 后台施工中, 成果在 packages/server+packages/protocol, **收割时必须 `cd packages/protocol && npx tsc -p tsconfig.json` 重新编译 dist 再验 server tsc**
- **子 agent B (mobile 侧边栏)**: 会话页右侧滑出文件树/引用按钮/长按操作菜单 — 后台施工中, 成果在 packages/mobile/src, wire.ts 协议镜像与 server 对齐联调
- 已完成并 push: device.delete API (server)、session.loaded 模型刷新链路 (server+mobile 已装 APK)、git 免弹窗、credential username 固定
- CI: workflow 只在 packages/mobile/** 变化时触发 (paths 过滤)

### 下次会话开工口令: "收割 v2 批次"
1. 收割两个子 agent 的代码 → tsc 验证 → 联调对齐 wire 协议
2. 补完 platform-34 → 首次本地构建验证 (15-25 分钟, 之后增量 3-8 分钟)
3. 装机验证: 侧边栏/设备删除/模型刷新 → 继续批 A 剩余 (时间线定位/回撤) 与批 D (token 自动化/额度 UI)

---

## 十六、渲染对齐 devin IDE 规格 (2026-11-26 用户验收反馈)

> 用户要求: mobile 工具调用显示与 devin IDE 完全一致。数据基础已实证齐备。

### 事件流数据实证 (server events jsonl)
- tool_call content 为 list, diff 项结构: `{type:'diff', path, oldText?, newText, _meta:{'cognition.ai/linesAdded':N,'cognition.ai/linesRemoved':M}}`
- 纯新增无 oldText; 有删除时 oldText/newText 双字段齐备 → **行级红绿 diff 可渲染**
- 命令类 tool_call 有 rawInput(命令全文)/rawOutput(输出) — 快照按 16KB 截断

### 渲染规格 (对齐 IDE 截图)
1. **命令块 (execute/bash)**: 深色卡片(zinc-900 系) + "Command in {cwd}" 小标题 + 等宽命令文本(语法着色可选) + Output 分区折叠 + 右上复制按钮 + 状态(运行中spinner/完成✓/失败✗) + "Worked for Xs" 耗时
2. **diff 块 (edit/write)**: 卡片头(文件路径 mono + 统计 +N绿 -M红) + 逐行红绿 diff: oldText/newText 行级对比(Myers diff 或简单 LCS——JS 端有 diff 库 jsdiff 可离线内置, 不引依赖就自己写 Myers 简化版~60行) + 默认折叠超 30 行可展开 + 纯新增时整段绿底高亮 newText
3. **思考块**: 折叠"思考"/Thoughts 标题+时长, 展开等宽灰字
4. **plan/skill 等其余类型**: 保持现有卡片但统一深色风格与 IDE 一致(米白→深色)
5. **加载逻辑变更 (用户明确要求)**: 打开会话只加载最新一屏(~30-50条事件), 向上滚动按需分页加载更早批次 — 不是一次 400 条; session.history API 已就绪

### 施工约束
- [id].tsx 与 chatReducer 与批 A 翻页有文件冲突 — 必须等批 A 收割后施工
