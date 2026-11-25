# devin/remote

把手机变成 devin 的远程控制面 — 在办公桌前发起任务, 在路上用手机审批权限、追问、验收。

参考 T3 Code 的架构思路: 一个本地服务驱动 `devin acp` (Agent Client Protocol), 手机端 / PWA / VSIX 面板都连同一个服务, 会话状态天然同步。

## 架构

```
┌─────────────┐   WebSocket (配对+HMAC鉴权)   ┌──────────────────────┐   stdio JSON-RPC   ┌────────────┐
│  Android App │◄────────────────────────────►│  devin-remote-server │◄──────────────────►│ devin acp  │
│  PWA 浏览器  │   LAN 直连 或 Cloudflare 隧道 │  (Node, 本机 8787)    │   ACP 协议         │ (真实agent)│
└─────────────┘                                └──────────────────────┘                    └────────────┘
                                                         ▲
                                                VSIX 插件托管 (Devin Desktop 启动即在线)
```

- **server** spawn `devin acp` 子进程, 作为 ACP Client 实现 fs 读写 (目录监狱) 和权限代理
- 会话事件溯源持久化 (`~/.devin-remote/events/*.jsonl`), 手机端断线重连后按 seq 增量同步
- 权限请求实时推送到所有在线设备, 任一设备裁决即生效
- 安全模型: 一次性 8 位配对码 → 设备证书 (HMAC-SHA256 挑战响应) → 防爆破锁定 → 30 天闲置失效

## 快速开始

### 1. 构建

```bash
npm install
cd packages/server && npm run build   # 编译 server + 拷贝 PWA
cd ../extension && npm install esbuild qrcode && node build.mjs  # 构建插件 + server bundle
```

### 2. 直接跑 server (不开插件也能用)

```bash
node packages/server/dist/index.js
# 首次会在 ~/.devin-remote/config.json 生成配置, 编辑 workdirs 加入允许手机操作的目录后重启
```

打开 `http://127.0.0.1:8787/` 即是 PWA 应急端; 本机 `curl -X POST http://127.0.0.1:8787/api/pairing/code` 生成配对码。

### 3. VSIX 插件 (推荐日常方式)

插件在 Devin Desktop 启动时自动托管 server + cloudflared 隧道:

```bash
cd packages/extension
npx @vscode/vsce package --no-dependencies   # 产出 devin-remote-0.1.0.vsix
# 在 Devin Desktop 里 Install from VSIX
```

设置项 (`devin-remote.*`):

| 设置 | 说明 |
|------|------|
| `port` | 本地端口, 默认 8787 |
| `workdirs` | **必填**: 允许手机操作的工作目录绝对路径清单 |
| `publicHostname` | 你的域名, 如 `devin.example.com` |
| `tunnelToken` | Cloudflare 命名隧道 token |
| `lanEnabled` | 局域网直连开关 (同 WiFi 手机直输 IP 即可, 不走 Cloudflare) |

### 4. Cloudflare 隧道一次性配置 (5 分钟)

1. 域名 DNS 托管到 Cloudflare (免费)
2. [Zero Trust 控制台](https://one.dash.cloudflare.com/) → Networks → Tunnels → **Create a tunnel** → cloudflared
3. 复制 **Tunnel Token** (`eyJ...` 长串) → 填入插件设置 `devin-remote.tunnelToken`
4. 隧道加 **Public Hostname**: subdomain `devin`, domain 选你的域名, Service 填 `http://localhost:8787`
5. 该完整域名 (`devin.example.com`) 填入 `devin-remote.publicHostname`

插件自动下载 cloudflared、守护进程、每 20s 走公网回环检查 `https://你的域名/api/health`, 状态栏实时显示。

### 5. 手机接入

- **Android App**: `packages/mobile` (Expo) — 扫码或输码配对
- **应急/其他设备**: 浏览器开 `https://你的域名` (或局域网 `http://电脑IP:8787`), 输入配对码

配对码在 VSIX 控制面板生成 (Devin Remote: 打开控制面板 → 生成配对码), 5 分钟有效、仅用一次。

**手机端能力一览**:

- **全量会话接入** — 列表展示 devin 侧所有会话 (含 Devin Desktop 里创建的), 点击即可接管继续对话, 完整历史自动重放; 桌面端占用中的会话有冲突提示
- **模型/模式切换** — Code/Smart/Ask/Plan/Bypass 五模式 + SWE 模型选择, 与桌面端同源 (configOptions 实时同步)
- **附件发送** — 拍照/相册图片/文本文件, 不支持图片的模型会提示先切换
- **流式对话** — 思考流/tool_call 卡片/权限审批/用量统计全量渲染
- **扫码配对** — 相机扫 QR 一键完成主机+配对码录入

## 安全说明

- `~/.devin-remote/state.json` 含设备密钥, 权限已限制; **不要分享此文件**
- 配对码防爆破: 每 IP 1 分钟 5 次, 累计 10 次失败锁 15 分钟
- 公网暴露的是无亮点的 JSON 端点, 所有会话操作都要求设备证书 HMAC 挑战响应
- 撤销设备: 控制面板 → 已配对设备 → 撤销 (即时生效, 在线连接被踢)
- agent 文件读写被限制在会话所在目录子树内 (realpath 防符号链接逃逸)

## 仓库结构

```
packages/
  acp-types/    ACP 协议类型定义 (initialize/session/prompt/tool_call/permission)
  protocol/     server↔client 线协议 (配对/鉴权/事件/权限裁决)
  server/       核心服务: ACP 桥 + 会话管理 + 事件持久化 + WS 网关 + PWA
  extension/    VSIX 插件: server 托管 + cloudflared 守护 + 控制面板 + 状态栏
  mobile/       Expo Android 客户端 (React Native, Mono 风格)
scripts/
  acp-probe.mjs       ACP 协议探针 (MS1 验证工具)
  e2e-test.mjs        端到端集成测试: 17 项断言全绿
mockups/        5 套 UI 风格样稿 (已选定: 极简白纸 Mono)
PRD.md          产品需求文档
```

## 验证

```bash
node scripts/e2e-test.mjs   # 真实 devin acp 全链路: 配对/鉴权/会话/流式事件/文件监狱/持久化
```

## 已知限制 (v1)

- `session/load` 要求 cwd 与该会话创建时一致 (devin 侧约束) — App 会自动透传无需关心; 桌面端占用中的会话接管可能产生双端冲突, UI 已加确认提示
- server 重启后已加载会话的 acp 侧连接需要重新 load (点击会话即可, 历史持久化不丢)
- iOS 未适配 (Expo 项目理论上可编译, 未测试)
- 隧道 token 目前存在 vscode 设置里 (明文), 后续迁移 SecretStorage

## 受限网络下的公网隧道（重要）

如果 `https://devin.haqiai.com` 返回 530 而隧道配置无误，根因通常是**代理节点对 Go TLS 指纹的审计重置**：

- cloudflared 是 Go 程序，其 TLS ClientHello 指纹独特
- 部分机场节点在出口审计 TLS 指纹，识别到 cloudflared 特征后重置连接（防滥用）
- 实测同一链路上 openssl/python 指纹的 TLS 握手成功、cloudflared 零字节 EOF

**自助排查（按顺序试）**：

1. 在 v2rayN 中**切换节点**（换 2-3 个试），然后双击运行 `tools/start-tunnel.bat`，看到 200 即放行成功
2. 手机热点共享给电脑后重试（移动网络对 7844 的封锁策略不同）
3. 都不行就用 **LAN 直连**（同 WiFi 下手机输电脑 IP:8787，不依赖任何公网）

**一键工具**：`tools/start-tunnel.bat` 会启动 edge-relay（socks5 中转）+ cloudflared 并自动验证公网状态码。工具链：

- `tools/edge-relay.py` — 127.0.0.1:17844 经本地 socks5 代理转发到 CF edge
- `tools/cloudflared-2024.exe` — 固定用 2024.6.1 版本（稳定性已验证）
- 配置 `~/.cloudflared/config-devin.yml`（ingress: devin.haqiai.com 指向 localhost:8787）
