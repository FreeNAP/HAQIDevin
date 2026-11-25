# HAQIDevin WS 协议契约 v2（2026-11-25 扩展）

本文档是 server 与 mobile 两端实现的唯一真相来源。所有消息均为 JSON over WebSocket。

## 新增 client→server 消息

### devinSession.list — 列出 devin 侧全部会话
```json
{"type":"devinSession.list"}
```
响应：
```json
{"type":"devinSession.list","sessions":[{
  "sessionId":"jagged-seeder","cwd":"C:\Users\30744\Desktop\拼豆服务站",
  "title":"具身智能设计","updatedAt":"2026-11-25T03:57:18+00:00",
  "isLocked":false,"additionalDirectories":["D:\具身智能"]
}]}
```
- `isLocked:true` 表示该会话正被 Devin Desktop 占用，加载可能失败或冲突
- 按 updatedAt 降序排列

### session.load — 加载已有 devin 会话
```json
{"type":"session.load","devinSessionId":"jagged-seeder","cwd":"C:\Users\30744\Desktop\拼豆服务站","additionalDirectories":["D:\具身智能"]}
```
- cwd 必须与该会话创建时的 cwd 一致（从 devinSession.list 原样透传）
- 成功：广播 `{"type":"session.loaded","session":{...meta},"acp":{...}}`（同 session.created 结构）
- 幂等：server 侧已加载的同 id 会话直接复用，重复 load 返回成功
- 失败：`{"type":"error","code":"load_failed","message":"..."}`
- 加载后 agent 会重放历史 session/update 通知，经标准事件流广播+持久化，客户端用 session.subscribe 的 snapshot 即可拿到完整历史

### session.prompt 扩展附件
```json
{"type":"session.prompt","sessionId":"...","text":"看看这张图","clientMsgId":"uuid",
 "attachments":[
   {"type":"image","mimeType":"image/png","data":"<base64>","fileName":"shot.png"},
   {"type":"resource_text","mimeType":"text/plain","text":"文件内容","fileName":"notes.txt","uri":"file:///x.txt"}
 ]}
```
- image → ACP content block `{type:"image",data,mimeType}`
- resource_text → embedded context `{type:"resource",resource:{uri,mimeType,text}}`
- 无附件时 attachments 可省略（向后兼容）

## 已有消息（mobile 已实现，本次需要用起来的）

- `session.setConfig` `{sessionId,configId,value}` — configId 为 `"model"` 或 `"mode"`，value 取 configOptions 里的 value
- `session.setMode` `{sessionId,modeId}` — 模式快捷切换
- session snapshot 的 `acp` 字段含完整 `configOptions`（model+mode 全部选项、currentValue、description）和 `modes`
- acp-update 事件流里会出现 `config_option_update` / `current_mode_update` / `available_commands_update` / `usage_update` 等 kind

## configOptions 结构（session/new 与 session/load 都返回）
```json
{"configOptions":[
  {"id":"mode","category":"mode","type":"select","currentValue":"accept-edits",
   "options":[{"value":"accept-edits","name":"Code","description":"..."},{"value":"smart","name":"Smart"},{"value":"ask","name":"Ask"},{"value":"plan","name":"Plan"},{"value":"bypass","name":"Bypass Permissions"}]},
  {"id":"model","category":"model","type":"select","currentValue":"swe-2-flash-medium",
   "options":[{"value":"swe-2-flash-medium","name":"SWE-2 Flash Medium","_meta":{"cognition.ai/supportsImages":false}},{"value":"swe-1-6-slow","name":"SWE-1.6 Slow","_meta":{"cognition.ai/supportsImages":true}}]}
]}
```
注意：swe-2-flash-medium 不支持图片；要发图片附件需切到 swe-1-6-slow，UI 应据此提示。
