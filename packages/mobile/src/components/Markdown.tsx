/**
 * Markdown 渲染 — react-native-markdown-display 包装
 * 风格: 代码块深色底+等宽字体, 行内代码 mono 朱红, 零圆角硬边
 */
import React from 'react';
import { StyleSheet, Platform } from 'react-native';
import MarkdownDisplay from 'react-native-markdown-display';
import { colors } from '../theme/colors';
import { useFontTheme } from '../theme/fonts';

interface Props {
  text: string;
  /** 用户气泡反色模式 (黑底白字内容) */
  inverted?: boolean;
}

export function Markdown({ text, inverted }: Props) {
  const fonts = useFontTheme();
  const styles = React.useMemo(() => makeStyles(fonts.mono, fonts.monoBold, fonts.sans, fonts.sansBold, inverted), [fonts, inverted]);
  return <MarkdownDisplay style={styles}>{text}</MarkdownDisplay>;
}

function makeStyles(mono: string, monoBold: string, sans: string, sansBold: string, inverted?: boolean) {
  const bodyColor = inverted ? colors.paper : colors.ink;
  const codeBg = inverted ? 'rgba(255,255,255,0.14)' : '#111311';
  const codeFg = inverted ? colors.paper : '#f1f1ec';
  return StyleSheet.create({
    body: {
      color: bodyColor,
      fontSize: 13,
      lineHeight: 21,
      fontFamily: sans || undefined,
    },
    heading1: { fontFamily: sansBold || undefined, fontSize: 17, lineHeight: 24, marginTop: 8, marginBottom: 4, color: bodyColor },
    heading2: { fontFamily: sansBold || undefined, fontSize: 15.5, lineHeight: 22, marginTop: 8, marginBottom: 4, color: bodyColor },
    heading3: { fontFamily: sansBold || undefined, fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 3, color: bodyColor },
    heading4: { fontFamily: sansBold || undefined, fontSize: 13, color: bodyColor },
    strong: { fontFamily: sansBold || undefined },
    em: { fontStyle: 'italic' },
    s: { textDecorationLine: 'line-through' },
    link: { color: inverted ? '#ffb3a6' : colors.acc, textDecorationLine: 'underline' },
    blocklink: { borderColor: colors.acc },
    hr: { backgroundColor: inverted ? 'rgba(250,250,247,0.3)' : colors.hairline, height: 1, marginVertical: 8 },
    code_inline: {
      fontFamily: mono || undefined,
      backgroundColor: inverted ? 'rgba(255,255,255,0.14)' : colors.paper2,
      color: inverted ? colors.paper : colors.acc,
      fontSize: 12,
      borderWidth: inverted ? 0 : 1,
      borderColor: colors.hairline,
      paddingHorizontal: 3,
    },
    code_block: {
      fontFamily: mono || undefined,
      backgroundColor: codeBg,
      color: codeFg,
      fontSize: 11.5,
      lineHeight: 17,
      padding: 10,
      marginVertical: 6,
      borderWidth: inverted ? 0 : 1.5,
      borderColor: colors.ink,
      borderRadius: 0,
    },
    fence: {
      fontFamily: mono || undefined,
      backgroundColor: codeBg,
      color: codeFg,
      fontSize: 11.5,
      lineHeight: 17,
      padding: 10,
      marginVertical: 6,
      borderWidth: inverted ? 0 : 1.5,
      borderColor: colors.ink,
      borderRadius: 0,
    },
    blockquote: {
      backgroundColor: inverted ? 'rgba(255,255,255,0.06)' : colors.paper2,
      borderLeftWidth: 3,
      borderLeftColor: colors.acc,
      paddingHorizontal: 10,
      paddingVertical: 4,
      marginVertical: 4,
    },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { marginVertical: 2, flexDirection: 'row' },
    bullet_list_icon: {
      color: inverted ? colors.paper : colors.acc,
      fontFamily: monoBold || undefined,
      marginRight: 6,
    },
    ordered_list_icon: {
      color: inverted ? colors.paper : colors.acc,
      fontFamily: monoBold || undefined,
      marginRight: 6,
    },
    table: { borderWidth: 1, borderColor: colors.ink, borderRadius: 0 },
    thead: { backgroundColor: inverted ? 'rgba(255,255,255,0.1)' : colors.paper2 },
    th: { padding: 6, borderWidth: 1, borderColor: colors.ink },
    td: { padding: 6, borderWidth: 1, borderColor: colors.hairline },
    paragraph: { marginTop: 0, marginBottom: 6 },
    text: {},
    span: {},
    image: { borderWidth: 1, borderColor: colors.ink },
  } as never);
}
