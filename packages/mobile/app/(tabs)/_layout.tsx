/**
 * 底部 tab — 对照 mockup tabbar: 2px 硬顶边, 大写小字标签, 几何线框图标
 * 会话 / 设备
 */
import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../../src/theme/colors';
import { T } from '../../src/components/ui';
import { useSessionsStore, waitingCount } from '../../src/store/sessions';
import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs';

/** 线框方块图标 — 用边框几何模拟 mockup 的 clip-path 图标 */
function TabGlyph({ kind, color }: { kind: 'chat' | 'dev'; color: string }) {
  if (kind === 'chat') {
    return (
      <View style={[glyphs.chat, { borderColor: color }]}>
        <View style={[glyphs.chatTail, { borderColor: color, borderTopColor: 'transparent', borderRightColor: 'transparent' }]} />
      </View>
    );
  }
  return <View style={[glyphs.dev, { borderColor: color }]} />;
}

function MonoTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const pending = useSessionsStore((s) => waitingCount(s.sessions));

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const color = focused ? colors.acc : colors.ink3;
        const isSessions = route.name === 'sessions';
        const label = isSessions ? '会话' : '设备';
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };
        return (
          <Pressable key={route.key} onPress={onPress} style={styles.tab}>
            <View>
              <TabGlyph kind={isSessions ? 'chat' : 'dev'} color={color} />
              {isSessions && pending > 0 && (
                <View style={styles.badgeDot}>
                  <T size={7.5} weight="bold" color="#fff">{pending > 9 ? '9+' : pending}</T>
                </View>
              )}
            </View>
            <T size={9.5} weight="semibold" uppercase ls={0.6} color={color} style={{ marginTop: 4 }}>
              {label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <MonoTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="sessions" />
      <Tabs.Screen name="devices" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 2,
    borderTopColor: colors.ink,
    backgroundColor: colors.card,
    paddingTop: 8,
  },
  tab: { flex: 1, alignItems: 'center', gap: 0 },
  badgeDot: {
    position: 'absolute',
    top: -5,
    right: -12,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.acc,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
});

const glyphs = StyleSheet.create({
  chat: {
    width: 15,
    height: 11,
    borderWidth: 1.5,
    position: 'relative',
  },
  chatTail: {
    position: 'absolute',
    bottom: -5,
    left: 2,
    width: 6,
    height: 6,
    borderWidth: 1.5,
    transform: [{ rotate: '45deg' }],
    backgroundColor: colors.card,
  },
  dev: {
    width: 13,
    height: 15,
    borderWidth: 1.5,
  },
});
