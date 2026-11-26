/**
 * 对话页资源管理器侧边栏 — 右侧滑出面板 (宽 78%), 浏览会话 cwd 内文件树
 *  - drill-down 导航: 点击目录行进入, 顶栏 ‹ 返回上级 (不超出 cwd 根), 进入时才发 fs.list (懒加载+缓存)
 *  - 文件行右侧 @ 按钮 → 引用相对路径到输入框; 点击文件行预览内容 (fs.read)
 *  - 长按行弹操作菜单: 复制/剪切/粘贴(目录)/复制路径/删除 — 粘贴对目录发 fs.copy/fs.move
 *  - 复制路径无 expo-clipboard 依赖, 兜底为可选中文字的弹层, 用户长按自拷
 *  - 协议容错: entries/content 等字段缺失或畸形时不崩, 按空态/错误态渲染
 */
import React from 'react';
import {
  View,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Dimensions,
  Alert,
} from 'react-native';
import { colors } from '../theme/colors';
import { T, M } from './ui';
import { client } from '../ws/client';
import { useFsExplorerStore } from '../store/fsExplorer';
import type { FsEntry } from '../protocol/wire';
import {
  joinPath,
  parentPath,
  relativePath,
  trimTrailingSep,
  formatBytes,
  toReferencePath,
} from '../util/fspath';

interface Props {
  visible: boolean;
  /** 会话工作目录根 (服务器侧绝对路径) — UI 导航边界, 不超出;
   *  server 侧监狱为全局 workdirs 列表, 会话 cwd 必在其中 */
  root: string;
  onClose: () => void;
  /** 点击引用 — 参数为相对 root 的 posix 风格路径 (不含 @ 前缀) */
  onReference: (relPath: string) => void;
}

type ListingStatus = 'loading' | 'loaded' | 'error';

interface Listing {
  status: ListingStatus;
  entries: FsEntry[];
  error?: string;
}

interface PreviewState {
  path: string;
  name: string;
  status: 'loading' | 'loaded' | 'error';
  content: string;
  truncated: boolean;
  /** server 侦测到二进制 (NUL) 返回 base64 — 不渲染原文, 提示不可预览 */
  binary: boolean;
  error?: string;
}

interface ActionTarget {
  entry: FsEntry;
  absPath: string;
}

const PREVIEW_MAX_BYTES = 64 * 1024;

/** fs.list 响应宽松解析 — server 实现出入时字段缺失/畸形不崩, 非法条目剔除 */
function normalizeEntries(raw: unknown): FsEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FsEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name : '';
    // 单段名约束: 空/点/含分隔符的条目无法安全 join, 直接丢弃
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) continue;
    const type: FsEntry['type'] =
      rec.type === 'directory' || rec.type === 'symlink' || rec.type === 'other' || rec.type === 'file'
        ? (rec.type as FsEntry['type'])
        : 'file';
    const path = typeof rec.path === 'string' ? rec.path : '';
    const size = typeof rec.size === 'number' && Number.isFinite(rec.size) ? rec.size : 0;
    const mtimeMs = typeof rec.mtimeMs === 'number' && Number.isFinite(rec.mtimeMs) ? rec.mtimeMs : 0;
    out.push({ name, path, type, size, mtimeMs });
  }
  // 目录在前, 组内按名排序 (大小写不敏感)
  out.sort((a, b) => {
    const ad = a.type === 'directory' ? 0 : 1;
    const bd = b.type === 'directory' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });
  return out;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return '未知错误';
}

function samePath(a: string, b: string): boolean {
  // 统一分隔符后比较 — 配置正斜杠/server 反斜杠混合场景不断链; Windows 大小写不敏感
  const norm = (s: string) => trimTrailingSep(s).replace(/\\/g, '/');
  const ta = norm(a);
  const tb = norm(b);
  if (ta === tb) return true;
  return /^[A-Za-z]:\//.test(ta) && ta.toLowerCase() === tb.toLowerCase();
}

export function FileExplorerSidebar({ visible, root, onClose, onReference }: Props) {
  const [mounted, setMounted] = React.useState(visible);
  const slide = React.useRef(new Animated.Value(0)).current;

  const [current, setCurrent] = React.useState(root);
  const [listings, setListings] = React.useState<Record<string, Listing>>({});
  const [preview, setPreview] = React.useState<PreviewState | null>(null);
  const [actionTarget, setActionTarget] = React.useState<ActionTarget | null>(null);
  const [pathView, setPathView] = React.useState<string | null>(null);
  const [opBusy, setOpBusy] = React.useState(false);

  const clipboard = useFsExplorerStore((s) => s.clipboard);
  const setClipboard = useFsExplorerStore((s) => s.setClipboard);
  const clearClipboard = useFsExplorerStore((s) => s.clearClipboard);

  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 滑入/滑出 — 面板从右缘平移进入, 背景同步淡入
  React.useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(slide, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } else {
      Animated.timing(slide, { toValue: 0, duration: 160, useNativeDriver: true }).start(({ finished }) => {
        // 快速开关时 open 动画会中断 close 动画 (finished=false) — 此时不得卸载, 否则面板闪没
        if (finished && alive.current) setMounted(false);
      });
    }
  }, [visible, slide]);

  // root 变化 (换会话) → 归零重开
  React.useEffect(() => {
    setCurrent(root);
    setListings({});
  }, [root]);

  const fetchDir = React.useCallback(
    async (path: string, force: boolean = false) => {
      if (!force) {
        const cached = listings[path];
        if (cached && cached.status !== 'error') return;
      }
      setListings((prev) => ({ ...prev, [path]: { status: 'loading', entries: prev[path]?.entries ?? [] } }));
      try {
        const res = await client.fsList(path);
        if (!alive.current) return;
        // 失败路径不走这里 — error 消息使 promise reject 进 catch; 结果内只做宽松条目解析
        const entries = normalizeEntries(res.entries);
        setListings((prev) => ({ ...prev, [path]: { status: 'loaded', entries } }));
      } catch (e) {
        if (!alive.current) return;
        setListings((prev) => ({ ...prev, [path]: { status: 'error', entries: [], error: errText(e) } }));
      }
    },
    [listings],
  );

  // 打开时加载/刷新当前目录 (懒加载入口)
  React.useEffect(() => {
    if (visible && root) {
      void fetchDir(current, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  /** 结构变更 (删除/移动/复制) 后整树失效, 重拉当前目录 */
  const refreshAfterMutation = React.useCallback(() => {
    setListings({});
    void fetchDir(current, true);
  }, [current, fetchDir]);

  const enterDir = (absPath: string) => {
    setCurrent(absPath);
    void fetchDir(absPath);
  };

  const canGoBack = relativePath(root, current) !== '' && relativePath(root, current) !== null;
  const goBack = () => {
    if (!canGoBack) return;
    const parent = parentPath(current);
    if (!parent) return;
    // 监狱防御: 不允许跳出 cwd 根
    if (!samePath(parent, root) && relativePath(root, parent) === null) return;
    setCurrent(parent);
    void fetchDir(parent);
  };

  const openPreview = async (absPath: string, name: string) => {
    setPreview({ path: absPath, name, status: 'loading', content: '', truncated: false, binary: false });
    try {
      const res = await client.fsRead(absPath, PREVIEW_MAX_BYTES);
      if (!alive.current) return;
      setPreview({
        path: absPath,
        name,
        status: 'loaded',
        content: typeof res.content === 'string' ? res.content : '',
        truncated: res.truncated === true,
        binary: res.encoding === 'base64',
      });
    } catch (e) {
      if (!alive.current) return;
      setPreview({ path: absPath, name, status: 'error', content: '', truncated: false, binary: false, error: errText(e) });
    }
  };

  // ---------- 文件操作 ----------

  const doDelete = (target: ActionTarget) => {
    const isDir = target.entry.type === 'directory';
    Alert.alert(
      '删除确认',
      `确定删除${isDir ? '目录（含全部内容）' : '文件'}\n${target.entry.name} ?`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setOpBusy(true);
              try {
                // 成功即 resolve (deleted:true); 失败经 error 消息 reject 进 catch
                await client.fsDelete(target.absPath, isDir ? true : undefined);
                if (!alive.current) return;
                refreshAfterMutation();
              } catch (e) {
                if (alive.current) Alert.alert('删除失败', errText(e));
              } finally {
                if (alive.current) setOpBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  /** 粘贴执行体 — overwrite=true 时覆盖已存在目标 (server 先删后移/拷) */
  const execPaste = async (dstDir: string, overwrite: boolean) => {
    if (!clipboard) return;
    // server 契约: dst 为完整目标路径 (含末段名), 已存在则报 exists — 粘贴语义拼上源末段名
    const dst = joinPath(dstDir, clipboard.name);
    setOpBusy(true);
    try {
      if (clipboard.kind === 'cut') {
        await client.fsMove(clipboard.path, dst, overwrite || undefined);
      } else {
        await client.fsCopy(clipboard.path, dst, overwrite || undefined);
      }
      if (!alive.current) return;
      // 剪切兑现后源已不存在 — 剪贴板作废; 复制保留可连续粘贴
      if (clipboard.kind === 'cut') {
        // 当前浏览位置在被移走的目录内 → 退回根重拉, 避免对着已失效路径刷新出错误态
        const insideMoved = relativePath(clipboard.path, current) !== null;
        if (insideMoved) setCurrent(root);
        clearClipboard();
        setListings({});
        void fetchDir(insideMoved ? root : current, true);
      } else {
        refreshAfterMutation();
      }
    } catch (e) {
      if (!alive.current) return;
      const msgText = errText(e);
      // 目标已存在 → 询问覆盖 (server 错误文案 "目标已存在: ..."); 覆盖会替换目标全部内容, 需显式确认
      if (!overwrite && msgText.includes('已存在')) {
        Alert.alert('目标已存在', `${clipboard.name} 已存在于该目录, 覆盖?`, [
          { text: '取消', style: 'cancel' },
          { text: '覆盖', style: 'destructive', onPress: () => void execPaste(dstDir, true) },
        ]);
      } else {
        Alert.alert('粘贴失败', msgText);
      }
    } finally {
      if (alive.current) setOpBusy(false);
    }
  };

  const doPaste = (dstDir: string) => {
    if (!clipboard || opBusy) return;
    // 目录不能粘贴进自身/自身后代 — 客户端先拦一道, 避免服务器递归复制或报错
    if (clipboard.isDir && relativePath(clipboard.path, dstDir) !== null) {
      Alert.alert('无法粘贴', '目标位置在被复制/剪切的目录内部');
      return;
    }
    void execPaste(dstDir, false);
  };

  const reference = (absPath: string) => {
    onReference(toReferencePath(root, absPath));
  };

  // ---------- 渲染 ----------

  if (!mounted || !root) return null;

  const panelWidth = Math.round(Dimensions.get('window').width * 0.78);
  const translateX = slide.interpolate({ inputRange: [0, 1], outputRange: [panelWidth + 8, 0] });

  const listing = listings[current];
  const rel = relativePath(root, current);
  const relDisplay = rel === null || rel === '' ? './' : `./${rel.replace(/\\/g, '/')}/`;

  const renderRow = (entry: FsEntry) => {
    // 优先用 server 拼接好的条目绝对路径, 缺失时客户端 joinPath 兜底
    const absPath = entry.path || joinPath(current, entry.name);
    const isDir = entry.type === 'directory';
    return (
      <Pressable
        key={`${entry.type}:${entry.name}`}
        onPress={() => (isDir ? enterDir(absPath) : void openPreview(absPath, entry.name))}
        onLongPress={() => setActionTarget({ entry, absPath })}
        delayLongPress={420}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.paper2 }]}
      >
        <M size={12} weight="bold" color={isDir ? colors.acc : colors.ink3} style={styles.rowGlyph}>
          {isDir ? '▸' : '·'}
        </M>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={12.5} weight={isDir ? 'semibold' : 'regular'} numberOfLines={1}>
            {entry.name}
            {isDir ? '/' : ''}
          </T>
        </View>
        {!isDir && (
          <M size={9} color={colors.ink3} style={{ marginLeft: 8 }}>
            {formatBytes(entry.size)}
          </M>
        )}
        {!isDir && (
          <Pressable
            onPress={() => reference(absPath)}
            hitSlop={6}
            style={({ pressed }) => [styles.refBtn, pressed && { backgroundColor: colors.ink }]}
            accessibilityLabel={`引用 ${entry.name}`}
          >
            {({ pressed }) => (
              <M size={11} weight="bold" color={pressed ? colors.paper : colors.ink}>
                @
              </M>
            )}
          </Pressable>
        )}
      </Pressable>
    );
  };

  return (
    <View style={styles.overlay}>
      {/* 左侧遮罩 — 点击收起 */}
      <Animated.View style={[styles.backdrop, { opacity: slide }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="关闭文件面板" />
      </Animated.View>

      <Animated.View style={[styles.panel, { width: panelWidth, transform: [{ translateX }] }]}>
        {/* 顶栏: 返回上级 + 相对路径 + 刷新 + 关闭 */}
        <View style={styles.head}>
          <Pressable
            onPress={goBack}
            disabled={!canGoBack}
            hitSlop={10}
            style={[styles.headBtn, !canGoBack && { opacity: 0.25 }]}
            accessibilityLabel="返回上级目录"
          >
            <T size={16} weight="regular" color={colors.ink}>‹</T>
          </Pressable>
          <M size={11} weight="medium" color={colors.ink} numberOfLines={1} style={{ flex: 1 }}>
            {relDisplay}
          </M>
          <Pressable
            onPress={() => void fetchDir(current, true)}
            hitSlop={8}
            style={styles.headBtn}
            accessibilityLabel="刷新目录"
          >
            <T size={14} color={colors.ink2}>↻</T>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={8} style={styles.headBtn} accessibilityLabel="关闭">
            <T size={15} color={colors.ink3}>×</T>
          </Pressable>
        </View>

        {/* 剪贴板状态条 — 粘贴到当前浏览目录 */}
        {clipboard && (
          <View style={styles.clipBar}>
            <M size={9.5} color={colors.ink2} numberOfLines={1} style={{ flex: 1 }}>
              {clipboard.kind === 'cut' ? '已剪切' : '已复制'} {clipboard.name}
            </M>
            <Pressable
              onPress={() => void doPaste(current)}
              disabled={opBusy}
              style={({ pressed }) => [styles.clipPasteBtn, pressed && { backgroundColor: colors.paper2 }]}
            >
              <M size={9.5} weight="bold" color={colors.acc}>
                {opBusy ? '…' : '粘贴到此'}
              </M>
            </Pressable>
            <Pressable onPress={clearClipboard} hitSlop={8} accessibilityLabel="清除剪贴板">
              <T size={12} color={colors.ink3}>×</T>
            </Pressable>
          </View>
        )}

        {/* 列表区 */}
        {!listing || listing.status === 'loading' ? (
          <View style={styles.stateWrap}>
            <ActivityIndicator size="small" color={colors.ink} />
            <M size={9.5} color={colors.ink3} style={{ marginTop: 8 }}>
              加载目录…
            </M>
          </View>
        ) : listing.status === 'error' ? (
          <View style={styles.stateWrap}>
            <T size={11} color={colors.danger} style={{ textAlign: 'center' }}>
              {listing.error ?? '目录读取失败'}
            </T>
            <Pressable onPress={() => void fetchDir(current, true)} style={styles.retryBtn}>
              <M size={10} weight="bold" color={colors.ink}>
                重试
              </M>
            </Pressable>
          </View>
        ) : listing.entries.length === 0 ? (
          <View style={styles.stateWrap}>
            <M size={10} color={colors.ink3}>
              空目录
            </M>
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
            {listing.entries.map(renderRow)}
            <M size={8.5} color={colors.ink3} style={styles.footnote}>
              长按行弹出操作菜单 · 共 {listing.entries.length} 项
            </M>
          </ScrollView>
        )}

        {/* 操作菜单 (长按) */}
        <Modal visible={actionTarget !== null} transparent animationType="fade" onRequestClose={() => setActionTarget(null)}>
          <Pressable style={styles.menuBackdrop} onPress={() => setActionTarget(null)}>
            {actionTarget && (
              <Pressable onPress={(e) => e.stopPropagation()} style={styles.menuSheet}>
                <View style={styles.menuHead}>
                  <M size={10.5} weight="bold" numberOfLines={1}>
                    {actionTarget.entry.name}
                    {actionTarget.entry.type === 'directory' ? '/' : ''}
                  </M>
                  <M size={8.5} color={colors.ink3} numberOfLines={1} style={{ marginTop: 2 }}>
                    {toReferencePath(root, actionTarget.absPath)}
                  </M>
                </View>
                {(
                  [
                    { key: 'copy', label: '复制', show: true },
                    { key: 'cut', label: '剪切', show: true },
                    {
                      key: 'paste',
                      label: clipboard ? `粘贴到此目录 (${clipboard.name})` : '粘贴到此目录',
                      show: actionTarget.entry.type === 'directory' && clipboard !== null,
                    },
                    { key: 'copypath', label: '复制路径', show: true },
                    { key: 'delete', label: '删除', show: true, danger: true },
                  ] as const
                )
                  .filter((it) => it.show)
                  .map((it) => (
                    <Pressable
                      key={it.key}
                      onPress={() => {
                        const target = actionTarget;
                        setActionTarget(null);
                        if (it.key === 'copy') {
                          setClipboard({ kind: 'copy', path: target.absPath, name: target.entry.name, isDir: target.entry.type === 'directory' });
                        } else if (it.key === 'cut') {
                          setClipboard({ kind: 'cut', path: target.absPath, name: target.entry.name, isDir: target.entry.type === 'directory' });
                        } else if (it.key === 'paste') {
                          void doPaste(target.absPath);
                        } else if (it.key === 'copypath') {
                          setPathView(target.absPath);
                        } else if (it.key === 'delete') {
                          doDelete(target);
                        }
                      }}
                      style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: colors.paper2 }]}
                    >
                      <T size={12} weight="medium" color={'danger' in it && it.danger ? colors.danger : colors.ink}>
                        {it.label}
                      </T>
                    </Pressable>
                  ))}
                <Pressable onPress={() => setActionTarget(null)} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: colors.paper2 }]}>
                  <T size={12} color={colors.ink3} style={{ textAlign: 'center' }}>
                    取消
                  </T>
                </Pressable>
              </Pressable>
            )}
          </Pressable>
        </Modal>

        {/* 复制路径 — 无系统剪贴板依赖, 可选中文字长按自拷 */}
        <Modal visible={pathView !== null} transparent animationType="fade" onRequestClose={() => setPathView(null)}>
          <Pressable style={styles.menuBackdrop} onPress={() => setPathView(null)}>
            <Pressable onPress={(e) => e.stopPropagation()} style={styles.menuSheet}>
              <View style={styles.menuHead}>
                <M size={10.5} weight="bold">
                  完整路径 — 长按选中复制
                </M>
              </View>
              <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
                <M size={11} color={colors.ink} selectable>
                  {pathView ?? ''}
                </M>
              </View>
              <Pressable onPress={() => setPathView(null)} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: colors.paper2 }]}>
                <T size={12} color={colors.ink3} style={{ textAlign: 'center' }}>
                  关闭
                </T>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* 文件预览 */}
        <Modal visible={preview !== null} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
          <View style={styles.previewBackdrop}>
            <View style={styles.previewSheet}>
              <View style={styles.previewHead}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <M size={11} weight="bold" numberOfLines={1}>
                    {preview?.name ?? ''}
                  </M>
                  <M size={8.5} color={colors.ink3} numberOfLines={1} style={{ marginTop: 2 }}>
                    {preview ? toReferencePath(root, preview.path) : ''}
                    {preview?.truncated ? ' · 已截断' : ''}
                  </M>
                </View>
                <Pressable
                  onPress={() => {
                    if (preview) reference(preview.path);
                  }}
                  hitSlop={8}
                  style={({ pressed }) => [styles.refBtnLarge, pressed && { backgroundColor: colors.ink }]}
                >
                  {({ pressed }) => (
                    <M size={10} weight="bold" color={pressed ? colors.paper : colors.ink}>
                      @ 引用
                    </M>
                  )}
                </Pressable>
                <Pressable onPress={() => setPreview(null)} hitSlop={10} style={{ marginLeft: 10 }}>
                  <T size={15} color={colors.ink3}>×</T>
                </Pressable>
              </View>
              {preview?.status === 'loading' ? (
                <View style={styles.stateWrap}>
                  <ActivityIndicator size="small" color={colors.ink} />
                </View>
              ) : preview?.status === 'error' ? (
                <View style={styles.stateWrap}>
                  <T size={11} color={colors.danger} style={{ textAlign: 'center' }}>
                    {preview.error ?? '读取失败'}
                  </T>
                </View>
              ) : preview?.binary ? (
                <View style={styles.stateWrap}>
                  <M size={10} color={colors.ink3} style={{ textAlign: 'center' }}>
                    二进制文件不可预览
                  </M>
                  <M size={8.5} color={colors.ink3} style={{ textAlign: 'center' }}>
                    可通过 @ 引用发给 agent 处理
                  </M>
                </View>
              ) : (
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
                  <M size={10} color={colors.ink} selectable style={{ lineHeight: 15 }}>
                    {preview?.content ?? ''}
                  </M>
                  {preview?.truncated && (
                    <M size={9} color={colors.warn} style={{ marginTop: 8 }}>
                      — 内容过大已截断 ({PREVIEW_MAX_BYTES / 1024}KB 上限) —
                    </M>
                  )}
                </ScrollView>
              )}
            </View>
          </View>
        </Modal>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    zIndex: 20,
    elevation: 20,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,19,17,0.35)',
  },
  panel: {
    backgroundColor: colors.paper,
    borderLeftWidth: 2,
    borderLeftColor: colors.ink,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: -3, height: 0 },
    elevation: 16,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  headBtn: { paddingHorizontal: 4, paddingVertical: 2 },
  clipBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.accSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  clipPasteBtn: {
    borderWidth: 1,
    borderColor: colors.acc,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  rowGlyph: { width: 16 },
  refBtn: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  refBtnLarge: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginLeft: 8,
  },
  stateWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
    gap: 8,
  },
  retryBtn: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: 4,
  },
  footnote: {
    textAlign: 'center',
    paddingVertical: 10,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,19,17,0.35)',
    justifyContent: 'flex-end',
  },
  menuSheet: {
    backgroundColor: colors.card,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
    paddingBottom: 10,
  },
  menuHead: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink,
  },
  menuRow: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  previewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,19,17,0.45)',
    justifyContent: 'center',
    padding: 18,
  },
  previewSheet: {
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: colors.ink,
    maxHeight: '82%',
    minHeight: 200,
  },
  previewHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
});
