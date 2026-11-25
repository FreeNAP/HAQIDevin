/**
 * Mono 风格 UI 原语 — 瑞士排版: 黑墨白纸、朱红 accent、硬边框、硬阴影、零圆角
 * 视觉参数全部对照 mockups/style-2-mono.html
 */
import React from 'react';
import {
  View,
  Text,
  TextProps,
  ViewStyle,
  StyleSheet,
  Pressable,
  PressableProps,
  StyleProp,
  TextStyle,
} from 'react-native';
import { colors } from '../theme/colors';
import { useFontTheme } from '../theme/fonts';

type Weight = 'regular' | 'medium' | 'semibold' | 'bold';

interface TProps extends TextProps {
  mono?: boolean;
  weight?: Weight;
  size?: number;
  color?: string;
  uppercase?: boolean;
  ls?: number; // letterSpacing
  style?: StyleProp<TextStyle>;
  children?: React.ReactNode;
}

/** 排版文字 — mono=true 用 JetBrains Mono (路径/命令/数字), 否则 Space Grotesk */
export function T({ mono, weight = 'regular', size = 12, color = colors.ink, uppercase, ls, style, children, ...rest }: TProps) {
  const fonts = useFontTheme();
  let fontFamily: string;
  if (mono) {
    fontFamily = weight === 'bold' ? fonts.monoBold : weight === 'medium' || weight === 'semibold' ? fonts.monoMedium : fonts.mono;
  } else {
    fontFamily =
      weight === 'bold' ? fonts.sansBold : weight === 'semibold' ? fonts.sansSemiBold : weight === 'medium' ? fonts.sansMedium : fonts.sans;
  }
  const base: TextStyle = {
    fontFamily: fontFamily || undefined,
    fontSize: size,
    color,
    letterSpacing: ls,
    textTransform: uppercase ? 'uppercase' : 'none',
  };
  return (
    <Text {...rest} style={[base, style]}>
      {children}
    </Text>
  );
}

/** 等宽文字快捷方式 */
export function M(props: Omit<TProps, 'mono'>) {
  return <T {...props} mono />;
}

// ---------- 硬阴影卡片 ----------

interface HardCardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  borderWidth?: number;
  borderColor?: string;
  bg?: string;
  shadowOffset?: number;
  shadowColor?: string;
}

/**
 * 硬阴影卡片 — RN 无 offset 无模糊阴影跨平台方案:
 * 在背后垫一块平移的纯色板 (shadowOffset 位移, 零模糊零圆角)
 */
export function HardCard({
  children,
  style,
  contentStyle,
  borderWidth = 2,
  borderColor = colors.ink,
  bg = colors.card,
  shadowOffset = 0,
  shadowColor = colors.shadowInk,
}: HardCardProps) {
  return (
    <View style={style}>
      {shadowOffset > 0 && (
        <View
          style={{
            position: 'absolute',
            top: shadowOffset,
            left: shadowOffset,
            right: -shadowOffset,
            bottom: -shadowOffset,
            backgroundColor: shadowColor,
          }}
        />
      )}
      <View style={[{ borderWidth, borderColor, backgroundColor: bg }, contentStyle]}>{children}</View>
    </View>
  );
}

// ---------- 状态点 ----------

export function Dot({ color, size = 6, pulse }: { color: string; size?: number; pulse?: boolean }) {
  return <View style={{ width: size, height: size, backgroundColor: color, opacity: 1 }} />;
}

// ---------- badge (状态徽章) ----------

interface BadgeProps {
  text: string;
  tone?: 'warn' | 'live' | 'done' | 'dim' | 'danger';
  pulse?: boolean;
}

export function Badge({ text, tone = 'done', pulse }: BadgeProps) {
  const toneStyle =
    tone === 'warn'
      ? { color: colors.acc, borderColor: colors.acc }
      : tone === 'live'
        ? { color: colors.ink, borderColor: colors.ink }
        : tone === 'danger'
          ? { color: colors.danger, borderColor: colors.danger }
          : tone === 'dim'
            ? { color: colors.ink3, borderColor: colors.hairline }
            : { color: colors.ink3, borderColor: colors.hairline };
  return (
    <View
      style={[
        styles.badge,
        { borderColor: toneStyle.borderColor },
        tone === 'dim' && { borderStyle: 'dashed' },
      ]}
    >
      {pulse && <PulseDot color={toneStyle.color} />}
      <T size={9} weight="bold" color={toneStyle.color} uppercase ls={0.8}>
        {text}
      </T>
    </View>
  );
}

/** 脉动点 — 用透明度动画模拟 mockup 的 pulse */
export function PulseDot({ color, size = 5 }: { color: string; size?: number }) {
  const [on, setOn] = React.useState(true);
  React.useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), 700);
    return () => clearInterval(t);
  }, []);
  return <View style={{ width: size, height: size, backgroundColor: color, opacity: on ? 1 : 0.25 }} />;
}

// ---------- 硬边按钮 ----------

interface HardButtonProps extends Omit<PressableProps, 'style'> {
  text: string;
  primary?: boolean;
  danger?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  textColor?: string;
  disabled?: boolean;
}

export function HardButton({ text, primary, danger, small, style, onPress, disabled, ...rest }: HardButtonProps) {
  const borderColor = danger ? colors.danger : primary ? colors.ink : colors.ink;
  const bg = primary ? colors.ink : colors.card;
  const fg = primary ? colors.paper : danger ? colors.danger : colors.ink;
  return (
    <Pressable
      {...rest}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.hardButton,
        small && styles.hardButtonSmall,
        {
          borderColor,
          backgroundColor: pressed ? (primary ? colors.acc : colors.paper2) : bg,
          opacity: disabled ? 0.4 : 1,
          // 按压下沉 — 对照 mockup .pa:active translate(1px,1px)
          transform: pressed ? [{ translateX: 1 }, { translateY: 1 }] : [],
        },
        style,
      ]}
    >
      {({ pressed }) => (
        <T size={small ? 10 : 11.5} weight="bold" color={pressed && primary ? '#fff' : fg} uppercase ls={0.5}>
          {text}
        </T>
      )}
    </Pressable>
  );
}

// ---------- 细分隔线 ----------

export function Hairline({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: 1, backgroundColor: colors.hairline }, style]} />;
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1.5,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  hardButton: {
    borderWidth: 2,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hardButtonSmall: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderWidth: 1.5,
  },
});
