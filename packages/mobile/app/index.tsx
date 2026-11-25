/**
 * 入口路由 — 按连接状态分发:
 *  authed → 会话列表; 有活跃主机但未连接 → 连接页; 无主机 → 连接页
 */
import React from 'react';
import { Redirect } from 'expo-router';
import { useConnectionStore } from '../src/store/connection';

export default function Index() {
  const phase = useConnectionStore((s) => s.phase);
  const activeHost = useConnectionStore((s) => s.activeHost);

  if (phase === 'authed') {
    return <Redirect href="/(tabs)/sessions" />;
  }
  // 有无主机都进连接页 — 无主机时引导输入, 有主机时自动重连
  void activeHost;
  return <Redirect href="/connect" />;
}
