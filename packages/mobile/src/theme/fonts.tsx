/**
 * 字体主题: Space Grotesk (标题/正文) + JetBrains Mono (路径/命令/数字)
 * 对照 mockup: --sans: 'Space Grotesk' / --mono: 'JetBrains Mono'
 * 自定义字体加载失败时降级到系统等宽/默认字体, 保证可用性
 */
import React, { createContext, useContext } from 'react';
import { Platform } from 'react-native';
import {
  useFonts as useSpaceGroteskFonts,
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import {
  useFonts as useJetBrainsFonts,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';

export interface FontTheme {
  sans: string;
  sansMedium: string;
  sansSemiBold: string;
  sansBold: string;
  mono: string;
  monoMedium: string;
  monoBold: string;
}

const systemMono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** 降级方案: sans 空串 = 系统默认; mono = 系统等宽 */
export const fallbackFonts: FontTheme = {
  sans: '',
  sansMedium: '',
  sansSemiBold: '',
  sansBold: '',
  mono: systemMono,
  monoMedium: systemMono,
  monoBold: systemMono,
};

export const customFonts: FontTheme = {
  sans: 'SpaceGrotesk_400Regular',
  sansMedium: 'SpaceGrotesk_500Medium',
  sansSemiBold: 'SpaceGrotesk_600SemiBold',
  sansBold: 'SpaceGrotesk_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
  monoBold: 'JetBrainsMono_700Bold',
};

const FontContext = createContext<FontTheme>(fallbackFonts);

export function useFontTheme(): FontTheme {
  return useContext(FontContext);
}

export interface FontLoadState {
  ready: boolean;   // 加载完成 (无论成败) — 可以渲染 app
  fonts: FontTheme;
}

/** 在根布局调用: 加载两套字体, 返回就绪状态与实际生效的字体主题 */
export function useAppFonts(): FontLoadState {
  const [sgLoaded, sgError] = useSpaceGroteskFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
  });
  const [jbLoaded, jbError] = useJetBrainsFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });
  const ready = (sgLoaded || !!sgError) && (jbLoaded || !!jbError);
  const ok = sgLoaded && jbLoaded && !sgError && !jbError;
  return { ready, fonts: ok ? customFonts : fallbackFonts };
}

export const FontProvider = FontContext.Provider;
