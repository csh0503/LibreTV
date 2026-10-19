'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { RecommendSection } from '@/components/douban-section';
import { useTitleFlow } from '@/components/title-flow';
import type { HallChannel } from '@/lib/recommend';

const CHANNELS: HallChannel[] = ['anime', 'movie', 'tv', 'show', 'doc'];

/** 分类片库：独立页面（原来在首页最底下，要滑很久）。?channel= 决定打开哪个频道 */
export default function BrowsePage() {
  return (
    <Suspense>
      <BrowseContent />
    </Suspense>
  );
}

function BrowseContent() {
  const params = useSearchParams();
  const raw = params.get('channel') as HallChannel | null;
  const channel = raw && CHANNELS.includes(raw) ? raw : 'anime';
  const { pickTitle, openSource, modals } = useTitleFlow();
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6">
        <h1 className="sr-only">片库</h1>
        <RecommendSection key={channel} initialChannel={channel} onPick={pickTitle} onOpen={openSource} />
      </main>
      <SiteFooter />
      {modals}
    </div>
  );
}
