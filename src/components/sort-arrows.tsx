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
            'inline-flex items-stretch overflow-hidden rounded-full ring-1 ring-inset',
            sortKey === item.id ? 'ring-content/40' : 'ring-content/[0.1]'
          )}
        >
          <span className={cn('pl-2.5 pr-1.5 py-1 text-xs self-center', sortKey === item.id ? 'text-content font-medium' : 'text-muted')}>
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
        'w-6 text-xs leading-none last:pr-0.5',
        active ? 'bg-content text-page' : 'text-faint hover:text-content hover:bg-content/[0.06]'
      )}
    >
      {glyph}
    </button>
  );
}
