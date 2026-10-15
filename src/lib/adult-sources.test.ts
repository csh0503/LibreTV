import { describe, expect, it } from 'vitest';
import { isKnownAdultSource, sourceIsAdult } from './adult-sources';

const ADULT_URLS = [
  'https://hsckzy.vip/api.php/provide/vod',
  'https://apilsbzy1.com/api.php/provide/vod',
  'https://155api.com/api.php/provide/vod',
  'https://yutuzy10.com/api.php/provide/vod',
  'https://api.souavzy.vip/api.php/provide/vod',
  'https://jkunzyapi.com/api.php/provide/vod',
  'https://ckzy.me/api.php/provide/vod',
  'https://www.ckzy1.com/api.php/provide/vod',
];

describe('成人源地址', () => {
  it('这 8 个地址即使没勾选标记也算成人源', () => {
    for (const url of ADULT_URLS) {
      expect(isKnownAdultSource(url)).toBe(true);
      expect(sourceIsAdult({ url })).toBe(true);
    }
  });

  it('普通采集站不是成人源', () => {
    expect(isKnownAdultSource('https://vod.example.com/api.php/provide/vod')).toBe(false);
    expect(sourceIsAdult({ url: 'https://vod.example.com/api.php/provide/vod', isAdult: true })).toBe(true);
  });
});
