/**
 * 附件采集与装配 — 契约 v2 session.prompt attachments
 *  - 拍照/相册: expo-image-picker, base64 + quality 0.7
 *  - 文件: expo-document-picker + expo-file-system/legacy 读文本 (限 200KB), 图片文件转 base64
 *  - toWireAttachments 组装契约格式: image → {type:'image',data,mimeType}; 文本 → {type:'resource_text',...}
 */
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import type { PromptAttachment } from '../protocol/wire';

export interface PendingImage {
  kind: 'image';
  uri: string;          // 本地预览 uri
  fileName: string;
  mimeType: string;
  base64: string;
  sizeBytes?: number;
}

export interface PendingFile {
  kind: 'file';
  uri: string;
  fileName: string;
  mimeType: string;
  text: string;
  sizeBytes?: number;
}

export type PendingAttachment = PendingImage | PendingFile;

/** 文本附件上限 200KB (契约约定) */
export const MAX_TEXT_FILE_BYTES = 200 * 1024;

export interface PickResult {
  attachment?: PendingAttachment;
  /** 用户取消时为 undefined; 出错/拒绝时为中文提示 */
  error?: string;
  cancelled?: boolean;
}

// ---------- 判定辅助 ----------

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bat', 'ps1', 'yaml', 'yml', 'xml', 'csv',
  'log', 'ini', 'conf', 'cfg', 'env', 'sql', 'html', 'htm', 'css', 'vue', 'toml', 'swift',
]);

function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function isTextLike(mimeType: string | undefined, fileName: string): boolean {
  if (mimeType) {
    if (mimeType.startsWith('text/')) return true;
    if (['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/toml'].includes(mimeType)) return true;
    if (mimeType.includes('json') || mimeType.includes('xml')) return true;
  }
  return TEXT_EXTENSIONS.has(extOf(fileName));
}

function isImageLike(mimeType: string | undefined, fileName: string): boolean {
  if (mimeType && mimeType.startsWith('image/')) return true;
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp'].includes(extOf(fileName));
}

function fallbackImageMime(fileName: string): string {
  const ext = extOf(fileName);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/png';
}

function imageFileName(asset: ImagePicker.ImagePickerAsset): string {
  if (asset.fileName) return asset.fileName;
  const ext = asset.mimeType?.includes('png') ? 'png' : 'jpg';
  return `photo-${Date.now()}.${ext}`;
}

// ---------- 拍照 / 相册 ----------

function assetToPendingImage(asset: ImagePicker.ImagePickerAsset): PendingImage | { error: string } {
  if (!asset.base64) {
    return { error: '图片读取失败 — 未获取到图像数据' };
  }
  return {
    kind: 'image',
    uri: asset.uri,
    fileName: imageFileName(asset),
    mimeType: asset.mimeType ?? fallbackImageMime(asset.fileName ?? ''),
    base64: asset.base64,
    sizeBytes: asset.fileSize,
  };
}

/** 拍照 — 需相机权限, 拒绝时返回中文降级提示 */
export async function pickImageFromCamera(): Promise<PickResult> {
  try {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      return {
        error: perm.canAskAgain
          ? '相机权限被拒绝 — 需要拍摄照片时请允许授权'
          : '相机权限已被拒绝 — 请在系统设置中为 HAQIDevin 开启相机权限',
      };
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return { cancelled: true };
    const conv = assetToPendingImage(result.assets[0]);
    if ('error' in conv) return { error: conv.error };
    return { attachment: conv };
  } catch (e) {
    return { error: `拍照失败 — ${e instanceof Error ? e.message : '未知错误'}` };
  }
}

/** 相册选图 — iOS 14+ 受限相册也能正常返回所选照片 */
export async function pickImageFromLibrary(): Promise<PickResult> {
  try {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      return {
        error: perm.canAskAgain
          ? '相册权限被拒绝 — 需要选择图片时请允许授权'
          : '相册权限已被拒绝 — 请在系统设置中为 HAQIDevin 开启照片权限',
      };
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return { cancelled: true };
    const conv = assetToPendingImage(result.assets[0]);
    if ('error' in conv) return { error: conv.error };
    return { attachment: conv };
  } catch (e) {
    return { error: `选图失败 — ${e instanceof Error ? e.message : '未知错误'}` };
  }
}

// ---------- 文件 ----------

/** 选文件 — 文本文件读 UTF8 (限 200KB); 图片文件读 base64 按图片附件走 */
export async function pickDocument(): Promise<PickResult> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled || !result.assets?.[0]) return { cancelled: true };
    const asset = result.assets[0];
    const name = asset.name ?? 'file';
    const mime = asset.mimeType;

    if (isImageLike(mime, name)) {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      return {
        attachment: {
          kind: 'image',
          uri: asset.uri,
          fileName: name,
          mimeType: mime ?? fallbackImageMime(name),
          base64,
          sizeBytes: asset.size,
        },
      };
    }

    if (!isTextLike(mime, name)) {
      return { error: `不支持的文件类型 — 仅支持文本文件和图片 (${name})` };
    }
    if (typeof asset.size === 'number' && asset.size > MAX_TEXT_FILE_BYTES) {
      return { error: `文件超过 200KB 上限 (${Math.round(asset.size / 1024)}KB) — 请拆分或粘贴关键片段` };
    }
    const text = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
    // 二次防护: 部分平台 asset.size 缺失, 读完后按字符数估算
    if (text.length > MAX_TEXT_FILE_BYTES) {
      return { error: `文件超过 200KB 上限 — 请拆分或粘贴关键片段` };
    }
    return {
      attachment: {
        kind: 'file',
        uri: asset.uri,
        fileName: name,
        mimeType: mime ?? 'text/plain',
        text,
        sizeBytes: asset.size,
      },
    };
  } catch (e) {
    return { error: `读取文件失败 — ${e instanceof Error ? e.message : '未知错误'}` };
  }
}

// ---------- 装配契约附件 ----------

/** PendingAttachment[] → 契约 session.prompt attachments 数组 */
export function toWireAttachments(list: PendingAttachment[]): PromptAttachment[] {
  return list.map((a): PromptAttachment => {
    if (a.kind === 'image') {
      return { type: 'image', mimeType: a.mimeType, data: a.base64, fileName: a.fileName };
    }
    return { type: 'resource_text', mimeType: a.mimeType || 'text/plain', text: a.text, fileName: a.fileName, uri: a.uri };
  });
}

export function hasImageAttachment(list: PendingAttachment[]): boolean {
  return list.some((a) => a.kind === 'image');
}
