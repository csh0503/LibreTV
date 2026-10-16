import { describe, expect, it } from 'vitest';
import { cnDateString, lookupChinese, lookupChineseByNames, normalizeNative } from './upcoming';

describe('即将播出：日文原名 → 中文名映射', () => {
  const map = new Map([
    [normalizeNative('葬送のフリーレン 第2期'), { title: '葬送的芙莉莲 第二季' }],
    [normalizeNative('チェンソーマン'), { title: '电锯人' }],
  ]);

  it('忽略空格与标点精确命中', () => {
    expect(lookupChinese(map, '葬送のフリーレン　第２期'.replace('２', '2'))?.title).toBe('葬送的芙莉莲 第二季');
    expect(lookupChinese(map, 'チェンソーマン')?.title).toBe('电锯人');
  });

  it('前缀命中（AniList 多带副标题时）且不误命中', () => {
    expect(lookupChinese(map, 'チェンソーマン レゼ篇')?.title).toBe('电锯人');
    expect(lookupChinese(map, 'まったく別の作品')).toBeUndefined();
  });

  it('下一季不能命中上一季的前缀', () => {
    const seasons = new Map([[normalizeNative('Re:ゼロから始める異世界生活'), { title: 'Re：从零开始的异世界生活' }]]);
    expect(lookupChinese(seasons, 'Re:ゼロから始める異世界生活 3rd Season')).toBeUndefined();
    expect(lookupChinese(seasons, 'Re:ゼロから始める異世界生活 氷結の絆')).toBeDefined();
    expect(lookupChinese(seasons, 'Re:ゼロから始める異世界生活2')).toBeUndefined();
    expect(lookupChinese(seasons, 'Re:ゼロから始める異世界生活 第2期')).toBeUndefined();
  });

  it('日文原名对不上时用罗马音 / 英文名（Netflix 作品，如边缘行者 2）', () => {
    const bgm = new Map([[normalizeNative('Cyberpunk: Edgerunners 2'), { title: '赛博朋克：边缘行者 2' }]]);
    expect(lookupChinese(bgm, 'サイバーパンク: エッジランナーズ2')).toBeUndefined();
    expect(
      lookupChineseByNames(bgm, ['サイバーパンク: エッジランナーズ2', 'Cyberpunk: Edgerunners 2', undefined])?.title,
    ).toBe('赛博朋克：边缘行者 2');
  });

  it('按北京时间取日期', () => {
    // 2026-10-16 17:00 UTC = 2026-10-17 01:00 北京时间
    expect(cnDateString(Date.UTC(2026, 9, 16, 17, 0))).toBe('2026-10-17');
  });
});
