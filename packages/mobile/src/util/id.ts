/**
 * clientMsgId / 本地 id 生成器
 * RN (Hermes) 无 crypto.getRandomValues 原生支持, 幂等键无需密码学强度,
 * 用时间戳 + 计数器 + Math.random 组合保证实际唯一性
 */
let counter = 0;

export function genId(prefix: string = 'm'): string {
  counter = (counter + 1) % 0xffff;
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function genClientMsgId(): string {
  return genId('cm_');
}
