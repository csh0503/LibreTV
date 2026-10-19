'use client';

import { useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import type { SearchResultItem, TitlePick } from '@/lib/types';

/**
 * 首页卡片点开时记下的元数据（封面、年份），按片名存。
 * 放在模块里而不是组件 state：从播放页后退、或从片库 / 排行页跳到搜索结果时都还在，「暂无片源」卡要用。
 */
export const pickedTitles = new Map<string, TitlePick>();

const TitleModal = dynamic(() => import('./title-modal').then((m) => m.TitleModal), { ssr: false });
const DetailModal = dynamic(() => import('./detail-modal').then((m) => m.DetailModal), { ssr: false });

/** 记下这张卡的元数据，返回弹窗用的 pick */
export function rememberPick(title: string, pick?: TitlePick & { yearSoft?: boolean }): TitlePick {
  // 按筛选条件填上去的年份（B站片库按年份筛）不是这部的真实年份：拿它去认作品会认错（「航海王」+ 2026 → 乐高特别篇）
  const { yearSoft, ...rest } = pick ?? {};
  const full: TitlePick = { ...rest, title, ...(yearSoft ? { year: undefined } : {}) };
  pickedTitles.set(title.trim().slice(0, 100), full);
  return full;
}

/**
 * 片库、排行这些独立页面用的「点卡片 → 作品详情 → 选源」流程。
 * 「全部搜索结果」跳回首页的搜索结果页。
 */
export function useTitleFlow() {
  const router = useRouter();
  const [titlePick, setTitlePick] = useState<TitlePick | null>(null);
  const [detailItem, setDetailItem] = useState<SearchResultItem | null>(null);

  const pickTitle = useCallback((title: string, pick?: TitlePick & { yearSoft?: boolean }) => {
    setTitlePick(rememberPick(title, pick));
  }, []);
  const closeTitle = useCallback(() => setTitlePick(null), []);

  const modals = (
    <>
      {titlePick && (
        <TitleModal
          pick={titlePick}
          onClose={closeTitle}
          onOpenSource={(item) => {
            setTitlePick(null);
            setDetailItem(item);
          }}
          onShowResults={(title) => {
            setTitlePick(null);
            router.push(`/?s=${encodeURIComponent(title.trim().slice(0, 100))}`);
          }}
        />
      )}
      {detailItem && <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />}
    </>
  );

  return { pickTitle, openSource: setDetailItem, modals };
}
