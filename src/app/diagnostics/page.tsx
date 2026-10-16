'use client';

import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { LoadingState, ErrorState } from '@/components/states';
import { api } from '@/lib/client-api';
import { cn } from '@/lib/utils';

/**
 * 数据源体检页：首页的热榜、片库、找片源、设定档同步分别依赖哪些上游，它们现在通不通、
 * 取到多少、多快、取到的是什么。出问题时截这一页就能定位。
 */
export default function DiagnosticsPage() {
  const query = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api.diagnostics(signal),
    staleTime: Infinity,
    retry: 0,
  });
  const results = query.data?.results ?? [];
  const groups = [...new Set(results.map((r) => r.group))];
  const okCount = results.filter((r) => r.ok).length;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-8 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-content">数据源体检</h1>
            <p className="text-sm text-muted mt-1">
              现场把每个上游请求一遍（不走缓存）。
              {query.data &&
                ` ${new Date(query.data.at).toLocaleTimeString()} · ${okCount}/${results.length} 正常 · 设定档存储：${query.data.storage}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="btn-ghost btn-sm"
          >
            {query.isFetching ? '检测中…' : '重新检测'}
          </button>
        </div>

        {query.isLoading ? (
          <LoadingState label="正在逐个请求上游，大约 10 秒…" />
        ) : query.isError ? (
          <ErrorState message={query.error instanceof Error ? query.error.message : '体检失败'} onRetry={() => void query.refetch()} />
        ) : (
          groups.map((group) => (
            <section key={group} className="space-y-2">
              <h2 className="text-sm font-semibold text-content">{group}</h2>
              <div className="rounded-xl border border-line overflow-hidden divide-y divide-line">
                {results
                  .filter((r) => r.group === group)
                  .map((r) => (
                    <div key={r.name} className="px-4 py-2.5 text-xs grid grid-cols-[1fr_auto] sm:grid-cols-[14rem_4rem_5rem_1fr] gap-x-4 gap-y-1 items-baseline">
                      <span className="flex items-center gap-2 text-content font-medium min-w-0">
                        <span className={cn('w-2 h-2 rounded-full shrink-0', r.ok ? 'bg-emerald-500' : 'bg-red-500')} aria-hidden />
                        <span className="truncate">{r.name}</span>
                      </span>
                      <span className={cn('text-right sm:text-left', r.ok ? 'text-muted' : 'text-danger')}>
                        {r.ok ? `${r.count} 条` : '失败'}
                      </span>
                      <span className={cn('hidden sm:inline', r.ms > 5000 ? 'text-warning' : 'text-faint')}>{r.ms} ms</span>
                      <span className="col-span-2 sm:col-span-1 text-faint truncate" title={r.error || r.sample.join('、')}>
                        {r.error ? <span className="text-danger">{r.error}</span> : r.sample.join('、')}
                      </span>
                    </div>
                  ))}
              </div>
            </section>
          ))
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
