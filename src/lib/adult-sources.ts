/**
 * 这些采集站是成人源。订阅 JSON 没写 isAdult 时，也按地址认出来，
 * 这样成人开关会挡住它们，解锁后也会放进成人片库。
 */
const ADULT_HOSTS = new Set([
  'hsckzy.vip', // 黄色仓库
  'apilsbzy1.com', // lsb
  '155api.com', // 155
  'yutuzy10.com', // 玉兔
  'api.souavzy.vip', // souav
  'jkunzyapi.com', // jkun
  'ckzy.me', // CK
  'ckzy1.com', // CK 备用（www 会先去掉）
]);

export function isKnownAdultSource(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return ADULT_HOSTS.has(host);
  } catch {
    return false;
  }
}

export function sourceIsAdult(source: { url?: string; isAdult?: boolean } | undefined): boolean {
  if (!source) return false;
  return source.isAdult === true || isKnownAdultSource(source.url);
}
