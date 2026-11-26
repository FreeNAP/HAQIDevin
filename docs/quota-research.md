# Devin 额度探针结论（2026-11-26）

## 结论

connect-RPC 已走通。`account.quota` 使用 devin CLI 同一通道查询：

- endpoint: `POST {api_server_url}/exa.seat_management_pb.SeatManagementService/GetUserStatus`
- 默认 host 来自 `%APPDATA%/devin/credentials.toml` 的 `api_server_url`，本机为 `https://server.codeium.com`
- headers: `Content-Type: application/json`、`Connect-Protocol-Version: 1`、`Authorization: Bearer <windsurf_api_key>`
- body 必须带 `metadata`，不能只发 `{}`；只发 `{}` 在本机实证返回 HTTP 400 `invalid_argument / an internal error occurred`

请求形状（密钥不落盘、不写入响应）：

```json
{
  "metadata": {
    "apiKey": "<windsurf_api_key>",
    "ideName": "devin-cli",
    "ideVersion": "3000.11.3",
    "extensionName": "devin",
    "extensionVersion": "3000.11.3",
    "locale": "en-US"
  }
}
```

## 本机实证拿到的字段

`GetUserStatus` 返回 HTTP 200。额度相关字段位于 `userStatus.planStatus` / `planInfo`：

- `dailyQuotaRemainingPercent`: 本机实证为 `100`
- `overageBalanceMicros`: 本机实证为负整数（表示透支/负余额，原样透传）
- `dailyQuotaResetAtUnix`: 有值，秒级 unix 时间
- `weeklyQuotaResetAtUnix`: 有值，秒级 unix 时间
- `planInfo.planName`: `Max`
- `planInfo.billingStrategy`: `BILLING_STRATEGY_QUOTA`
- `weeklyQuotaRemainingPercent`: 本机响应未返回（Max 计划可能隐藏/不按周百分比展示）
- `acuConsumed` / `acuLimit`: 本机响应未返回

server API 对这些缺省字段返回 `null`，不伪造。

## 隐私处理

原始响应含 email、team/org/user id 等账户隐私。wire 的 `raw` 不直接透传完整响应，只返回 quota/plan 相关安全投影；Authorization 与 `apiKey` 永不写入日志、state 或响应。

## events fallback 及限制

server 持久化的 `usage_update` 事件 `_meta` 可见：

- `cognition.ai/inputTokens`
- `cognition.ai/outputTokens`
- `cognition.ai/cachedReadTokens`
- 部分会话有 `cognition.ai/totalCreditCost` / `cognition.ai/totalAcuCost`

限制：这些事件在 `session/load` 历史重放时会重复写入，且 token/ACU 字段经常是同一会话累计值而不是单条增量。直接逐条求和会严重高估。因此 fallback 采用“每会话各指标取最大值，再跨会话求和”的保守近似：

- 能作为「本地观察到至少消耗了多少」的对照指标
- 不能视作云端账单精确值
- `totalCreditCost/totalAcuCost` 缺失时只能为 0/null，不推断

`account.quota` 始终附带 `sessionUsage`；connect-RPC 成功时 `source=connect-rpc`，失败且本地有 usage 事件时 `source=events-fallback`。
