/**
 * HMAC-SHA256 (RFC 2104) 纯 TS 实现, 基于 ./sha256
 * 用于配对设备的挑战响应签名: hex HMAC-SHA256(deviceSecret, deviceId + ':' + nonce)
 * 正确性由 RFC 4231 测试向量在 node 下验证 (见开发记录)
 */
import { sha256Bytes, utf8Encode, bytesToHex } from './sha256';

const BLOCK_SIZE = 64; // SHA-256 分组字节数

export function hmacSha256Bytes(keyBytes: Uint8Array, message: Uint8Array): Uint8Array {
  let key = keyBytes;
  if (key.length > BLOCK_SIZE) {
    key = sha256Bytes(key);
  }
  const ipad = new Uint8Array(BLOCK_SIZE);
  const opad = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    const kb = i < key.length ? key[i]! : 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  const inner = new Uint8Array(BLOCK_SIZE + message.length);
  inner.set(ipad, 0);
  inner.set(message, BLOCK_SIZE);
  const innerHash = sha256Bytes(inner);

  const outer = new Uint8Array(BLOCK_SIZE + innerHash.length);
  outer.set(opad, 0);
  outer.set(innerHash, BLOCK_SIZE);
  return sha256Bytes(outer);
}

/** hex HMAC-SHA256(key, message) — key 与 message 均按 UTF-8 编码 */
export function hmacSha256Hex(key: string, message: string): string {
  return bytesToHex(hmacSha256Bytes(utf8Encode(key), utf8Encode(message)));
}

/** 设备鉴权签名: hex HMAC-SHA256(deviceSecret, deviceId + ':' + nonce) — 与线协议注释一字不差 */
export function deviceSignature(deviceSecret: string, deviceId: string, nonce: string): string {
  return hmacSha256Hex(deviceSecret, deviceId + ':' + nonce);
}
