/**
 * 资源管理器剪贴板 store — 复制/剪切跨侧边栏开关存活
 * 仅存内存不落盘; 粘贴目标为目录, 由 FileExplorerSidebar 发 fs.copy/fs.move 兑现
 */
import { create } from 'zustand';

export interface FsClipboardItem {
  kind: 'copy' | 'cut';
  path: string;      // 源绝对路径
  name: string;      // 末段名 (粘贴拼接用)
  isDir: boolean;
}

interface FsExplorerState {
  clipboard: FsClipboardItem | null;
  setClipboard: (item: FsClipboardItem) => void;
  clearClipboard: () => void;
}

export const useFsExplorerStore = create<FsExplorerState>((set) => ({
  clipboard: null,
  setClipboard: (item) => set({ clipboard: item }),
  clearClipboard: () => set({ clipboard: null }),
}));
