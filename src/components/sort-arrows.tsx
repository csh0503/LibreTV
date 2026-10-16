'use client';

import type { HallSortDir, HallSortKey } from '@/lib/recommend';
import { cn } from '@/lib/utils';

const KEYS: { id: HallSortKey; label: string }[] = [
  { id: 'hot', label: '热度' },
  { id: 'rate', label: '评分' },
  { id: 'date', label: '日期' },
  { id: 'title', label: '片名' },
];

/** 每个排序字段一对上下箭头：上是升序，下是降序。 */
export function SortArrows({
  sortKey,
  sortDir,
  onChange,
}: {
  sortKey: HallSortKey;
  sortDir: HallSortDir;
  onChange: (key: HallSortKey, dir: HallSortDir) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {KEYS.map((item) => (
        <div
          key={item.id}
          className={cn(
            'inline-flex items-stretch overflow-hidden rounded-lg border',
            sortKey === item.id ? 'border-accent' : 'border-line'
          )}
        >
          <span className={cn('px-2 py-0.5 text-xs self-center', sortKey === item.id ? 'text-content' : 'text-muted')}>
            {item.label}
          </span>
          <SortArrow
            label={`${item.label}升序`}
            glyph="↑"
            active={sortKey === item.id && sortDir === 'asc'}
            onClick={() => onChange(item.id, 'asc')}
          />
          <SortArrow
            label={`${item.label}降序`}
            glyph="↓"
            active={sortKey === item.id && sortDir === 'desc'}
            onClick={() => onChange(item.id, 'desc')}
          />
        </div>
      ))}
    </div>
  );
}

function SortArrow({
  label,
  glyph,
  active,
  onClick,
}: {
  label: string;
  glyph: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'w-6 text-xs leading-none border-l border-line',
        active ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
      )}
    >
      {glyph}
    </button>
  );
}
