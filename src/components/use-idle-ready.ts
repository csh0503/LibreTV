'use client';

import { useEffect, useState } from 'react';

/**
 * 首屏内容出来、浏览器闲下来之后才变成 true。
 * 给「看看有没有更新」这类后台检查用：它们一打开就并发去查每部剧的详情、整站搜索，
 * 会和大图 / TOP 10 / 货架抢网络和主线程，首页打开就卡。
 */
export function useIdleReady(delayMs = 2500): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let idleHandle: number | undefined;
    const timer = window.setTimeout(() => {
      const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) idleHandle = ric(() => setReady(true), { timeout: 3000 });
      else setReady(true);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      const cic = (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (idleHandle !== undefined && cic) cic(idleHandle);
    };
  }, [delayMs]);
  return ready;
}
