const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 给设定档生成同步码。新设备输入同一串就能把资料拉下来。 */
export function createSyncSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/** 去掉空格和横线，方便粘贴。 */
export function normalizeSyncCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatSyncCode(secret: string): string {
  const raw = normalizeSyncCode(secret);
  return raw.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}
