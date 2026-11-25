/**
 * 根布局 — 字体加载门控 + 通知初始化 + 持久化数据引导 + 导航栈
 */
import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAppFonts, FontProvider } from '../src/theme/fonts';
import { colors } from '../src/theme/colors';
import { setupNotifications } from '../src/notify';
import { useConnectionStore } from '../src/store/connection';
import { loadHosts, loadActiveHostId } from '../src/store/storage';

export default function RootLayout() {
  const { ready, fonts } = useAppFonts();
  const [booted, setBooted] = React.useState(false);

  React.useEffect(() => {
    void setupNotifications();
    // 引导: 读持久化主机清单, 不自动连接 (用户在连接页/列表页触发)
    void (async () => {
      const conn = useConnectionStore.getState();
      const hosts = await loadHosts();
      const activeId = await loadActiveHostId();
      conn.setHosts(hosts);
      const active = hosts.find((h) => h.id === activeId) ?? hosts[hosts.length - 1] ?? null;
      conn.setActiveHost(active);
      conn.setPhase('idle');
      setBooted(true);
    })();
  }, []);

  if (!ready || !booted) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.acc} />
      </View>
    );
  }

  return (
    <FontProvider value={fonts}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.paper },
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="connect" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="session/[id]" />
          <Stack.Screen name="new-session" options={{ presentation: 'modal' }} />
        </Stack>
      </SafeAreaProvider>
    </FontProvider>
  );
}
