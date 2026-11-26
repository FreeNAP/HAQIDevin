/**
 * 工作目录设置页 — workdir.list / workdir.add / workdir.remove
 *  - 列表: path + exists 状态 (不存在红色标记), 每行删除按钮 (最后一个禁删)
 *  - 添加: 绝对路径文本输入 + 快捷 chips (已存在的灰显); 客户端预校验绝对路径
 *  - 成功后 server 广播新 workdir.list — 连接 store 自动刷新, 无需手动重拉
 */
import React from 'react';
import {
  View,
  ScrollView,
  Pressable,
  StyleSheet,
  Alert,
  RefreshControl,
  TextInput,
  ActivityIndicator,
  Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../../src/theme/colors';
import { useFontTheme } from '../../src/theme/fonts';
import { T, M, HardButton } from '../../src/components/ui';
import { useConnectionStore, WorkdirEntry } from '../../src/store/connection';
import { client } from '../../src/ws/client';
import { dirName } from '../../src/util/time';
import { normalizeFsKey } from '../../src/util/fspath';

/** 快捷目录 chips — 手机端无法浏览 PC 目录, 给常用路径一键填入 */
const QUICK_PATHS = ['C:/Users/30744/Desktop', 'C:/Users/30744/Documents', 'D:/'];

/** 宽松绝对路径判定: Windows 盘符 / UNC / POSIX 根 */
function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

export default function WorkdirsPage() {
  const insets = useSafeAreaInsets();
  const fonts = useFontTheme();
  const phase = useConnectionStore((s) => s.phase);
  const workdirs = useConnectionStore((s) => s.workdirs);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [removingKey, setRemovingKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const authed = phase === 'authed';

  React.useEffect(() => {
    if (authed) client.requestWorkdirs();
  }, [authed]);

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    client.requestWorkdirs();
    setTimeout(() => setRefreshing(false), 700);
  }, []);

  /** 已存在判定 — 归一比较 (分隔符/大小写/尾斜杠差异视为同一目录) */
  const existingKeys = React.useMemo(() => new Set(workdirs.map((d) => normalizeFsKey(d.path))), [workdirs]);

  async function doAdd(path: string) {
    const p = path.trim();
    if (!p) return;
    if (!isAbsolutePath(p)) {
      setError('必须使用绝对路径, 如 C:/Users/30744/Desktop');
      return;
    }
    if (existingKeys.has(normalizeFsKey(p))) {
      setError('该工作目录已在清单内');
      return;
    }
    Keyboard.dismiss();
    setBusy(true);
    setError(null);
    try {
      await client.addWorkdir(p);
      setInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败');
    } finally {
      setBusy(false);
    }
  }

  function confirmRemove(dir: WorkdirEntry) {
    Alert.alert('移除工作目录', `从清单移除「${dir.path}」？\n不会删除磁盘上的任何文件。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '移除',
        style: 'destructive',
        onPress: () => {
          const key = normalizeFsKey(dir.path);
          setRemovingKey(key);
          setError(null);
          void client
            .removeWorkdir(dir.path)
            .catch((e) => {
              setError(e instanceof Error ? e.message : '移除失败');
            })
            .finally(() => setRemovingKey(null));
        },
      },
    ]);
  }

  const chipUsed = (chip: string) => {
    // chips 是用户输入习惯写法; 清单里可能以 resolve 归一形式存在, 归一后比较
    const key = normalizeFsKey(chip);
    if (existingKeys.has(key)) return true;
    // D:/ 根目录特殊: 清单存的可能带尾斜杠差异 — normalizeFsKey 已处理, 此处仅兜底
    return false;
  };

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.appBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <T size={21}>‹</T>
        </Pressable>
        <T size={15} weight="bold" ls={-0.2}>工作目录</T>
        <View style={{ width: 21 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 30 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} colors={[colors.acc]} />}
        keyboardShouldPersistTaps="handled"
      >
        {!authed && (
          <View style={styles.warnBox}>
            <T size={11} color={colors.acc}>未连接主机 — 连接后可管理工作目录</T>
          </View>
        )}
        {error && (
          <View style={styles.warnBox}>
            <T size={11} color={colors.danger}>{error}</T>
          </View>
        )}

        {/* 现有目录 */}
        <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabelFirst}>
          目录清单
        </T>
        {workdirs.length === 0 && (
          <View style={styles.emptyBox}>
            <T size={11} color={colors.ink3}>{authed ? '正在获取目录清单…' : '连接主机后查看'}</T>
          </View>
        )}
        {workdirs.map((d, idx) => {
          const missing = d.exists === false;
          const key = normalizeFsKey(d.path);
          const removing = removingKey === key;
          const isLast = workdirs.length <= 1;
          return (
            <View
              key={d.path + idx}
              style={[styles.dirRow, idx === workdirs.length - 1 && { borderBottomWidth: 1.5 }]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <T size={12.5} weight="bold" numberOfLines={1}>
                    {d.label ?? dirName(d.path)}
                  </T>
                  {missing && (
                    <View style={styles.missingTag}>
                      <T size={8} weight="bold" color={colors.danger} uppercase ls={0.5}>不存在</T>
                    </View>
                  )}
                </View>
                <M size={9} color={missing ? colors.danger : colors.ink3} style={{ marginTop: 3 }} numberOfLines={1}>
                  {d.path}
                </M>
              </View>
              {removing ? (
                <ActivityIndicator size="small" color={colors.danger} />
              ) : (
                <HardButton
                  text="删除"
                  small
                  danger
                  disabled={isLast || busy || !authed}
                  onPress={() => confirmRemove(d)}
                />
              )}
            </View>
          );
        })}
        {workdirs.length <= 1 && workdirs.length > 0 && (
          <M size={8.5} color={colors.ink3} style={{ marginTop: 6 }}>
            至少保留一个工作目录 — 最后一个不可删除
          </M>
        )}

        {/* 添加 */}
        <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
          添加目录
        </T>
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, { fontFamily: fonts.mono || undefined }]}
            value={input}
            onChangeText={setInput}
            placeholder="C:/Users/30744/Desktop"
            placeholderTextColor={colors.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            editable={authed && !busy}
            onSubmitEditing={() => void doAdd(input)}
            returnKeyType="done"
          />
          <HardButton
            text={busy ? '…' : '添加'}
            primary
            disabled={busy || !authed || input.trim().length === 0}
            onPress={() => void doAdd(input)}
          />
        </View>

        <View style={styles.chipRow}>
          {QUICK_PATHS.map((chip) => {
            const used = chipUsed(chip);
            return (
              <Pressable
                key={chip}
                disabled={used || busy || !authed}
                onPress={() => void doAdd(chip)}
                style={({ pressed }) => [
                  styles.chip,
                  used && styles.chipUsed,
                  pressed && !used && { backgroundColor: colors.paper2 },
                ]}
              >
                <M size={9.5} color={used ? colors.ink3 : colors.ink} numberOfLines={1}>
                  {chip}
                </M>
                {used && <M size={8} color={colors.ink3}> ✓</M>}
              </Pressable>
            );
          })}
        </View>

        <M size={8.5} color={colors.ink3} style={{ marginTop: 16, lineHeight: 14 }}>
          目录须为主机上已存在的绝对路径 · 会话只能在此清单内的目录中创建 · 变更即时生效并同步到全部设备
        </M>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  appBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  warnBox: {
    borderWidth: 1.5,
    borderColor: colors.acc,
    backgroundColor: colors.accSoft,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
  },
  sectionLabelFirst: { marginBottom: 8 },
  sectionLabel: { marginTop: 22, marginBottom: 8 },
  dirRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderBottomWidth: 0,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  missingTag: {
    borderWidth: 1,
    borderColor: colors.danger,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  emptyBox: {
    borderWidth: 1.5,
    borderColor: colors.hairline,
    borderStyle: 'dashed',
    paddingVertical: 16,
    alignItems: 'center',
  },
  inputRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.card,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    color: colors.ink,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.card,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  chipUsed: {
    borderColor: colors.hairline,
    backgroundColor: colors.paper2,
    opacity: 0.6,
  },
});
