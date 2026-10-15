'use client';

import { useEffect, useRef } from 'react';

/**
 * 哨兵进入视口就加载下一页。generation 变化时重新观察，
 * 这样一屏装得下时会继续补，直到哨兵被顶出视口或没有下一页。
 */
export function useLoadMore(enabled: boolean, generation: number, onLoad: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadRef.current();
      },
      { rootMargin: '800px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, generation]);

  return ref;
}
