/**
 * 扫码配对弹层 — expo-camera CameraView 全屏扫码 (仅 QR)
 *  - 权限未授权: 中文说明 + 授权按钮; 永久拒绝: 降级提示引导手动输入
 *  - 扫到一次即回调并关闭 (scanned 守卫防连扫)
 * 视觉: 黑墨硬边扫描框 + 朱红角标, 零圆角, 延续 mono 风格
 */
import React from 'react';
import { View, Modal, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { colors } from '../theme/colors';
import { T, M, HardButton } from './ui';

interface Props {
  visible: boolean;
  onScanned: (data: string) => void;
  onClose: () => void;
}

export function QrScannerModal({ visible, onScanned, onClose }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = React.useRef(false);
  const [permissionError, setPermissionError] = React.useState(false);

  // 每次打开重置扫码守卫
  React.useEffect(() => {
    if (visible) scannedRef.current = false;
  }, [visible]);

  const onBarcodeScanned = React.useCallback(
    (result: { data?: string }) => {
      if (scannedRef.current) return;
      if (typeof result.data !== 'string' || !result.data) return;
      scannedRef.current = true;
      onScanned(result.data);
    },
    [onScanned],
  );

  async function onRequestPermission() {
    try {
      await requestPermission();
    } catch {
      setPermissionError(true);
    }
  }

  const granted = permission?.granted === true;
  const canAsk = permission?.canAskAgain !== false;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.page}>
        {/* 顶栏 */}
        <View style={styles.topBar}>
          <T size={15} weight="bold" ls={-0.2}>扫码配对</T>
          <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn}>
            <T size={16} color={colors.paper}>×</T>
          </Pressable>
        </View>

        {!permission && (
          <View style={styles.centerBox}>
            <ActivityIndicator color={colors.paper} />
            <T size={11} color={colors.paper} style={{ marginTop: 12 }}>正在检查相机权限…</T>
          </View>
        )}

        {permission && !granted && (
          <View style={styles.centerBox}>
            <M size={30} color={colors.ink3}>▣</M>
            <T size={13} weight="semibold" color={colors.paper} style={{ marginTop: 14, textAlign: 'center' }}>
              {canAsk ? '需要相机权限' : '相机权限已被拒绝'}
            </T>
            <T size={10.5} color={colors.ink3} style={{ marginTop: 8, textAlign: 'center', lineHeight: 17, paddingHorizontal: 40 }}>
              {canAsk
                ? '扫描桌面端「Devin Remote」面板显示的配对二维码，自动填入主机地址与配对码'
                : '请在系统设置中为 HAQIDevin 开启相机权限；或关闭本页手动输入主机地址与配对码'}
            </T>
            {permissionError && (
              <T size={10} color={colors.acc} style={{ marginTop: 8 }}>权限请求失败 — 请重试</T>
            )}
            <View style={{ marginTop: 18, alignSelf: 'stretch', paddingHorizontal: 60 }}>
              {canAsk ? (
                <HardButton text="授权相机" primary onPress={() => void onRequestPermission()} />
              ) : (
                <HardButton text="手动输入" primary onPress={onClose} />
              )}
            </View>
          </View>
        )}

        {granted && (
          <>
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onBarcodeScanned}
            />
            {/* 扫描框 overlay — 硬边角标 */}
            <View style={styles.overlay} pointerEvents="none">
              <View style={styles.frame}>
                <View style={[styles.corner, styles.cornerTL]} />
                <View style={[styles.corner, styles.cornerTR]} />
                <View style={[styles.corner, styles.cornerBL]} />
                <View style={[styles.corner, styles.cornerBR]} />
              </View>
              <T size={10.5} color={colors.paper} style={styles.overlayHint}>
                对准桌面端配对二维码
              </T>
              <M size={8.5} color={colors.ink3} style={{ marginTop: 8, textAlign: 'center' }}>
                devinremote://pair?host=…&code=XXXX-XXXX
              </M>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const CORNER = 22;
const BORDER = 3;

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ink },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 50,
    paddingBottom: 12,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderWidth: 1.5,
    borderColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  camera: { flex: 1 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    width: 220,
    height: 220,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderColor: colors.acc,
  },
  cornerTL: { top: 0, left: 0, borderTopWidth: BORDER, borderLeftWidth: BORDER },
  cornerTR: { top: 0, right: 0, borderTopWidth: BORDER, borderRightWidth: BORDER },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: BORDER, borderLeftWidth: BORDER },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: BORDER, borderRightWidth: BORDER },
  overlayHint: { marginTop: 26 },
});
