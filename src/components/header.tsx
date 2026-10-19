'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from './theme';
import dynamic from 'next/dynamic';
import { useProfile } from '@/lib/use-profile';
import { requestShowDownloadManager } from './download-manager';
import { Icon } from './icon';
import { SearchHistoryDropdown, useSearchHistory } from './search-history';
import { cn } from '@/lib/utils';

// 四个抽屉（设置 / 历史 / 片单 / 设定档）连同它们用到的源管理、订阅解析等代码不小，
// 每个页面打开都要先下载、解析一遍：改成第一次打开时才加载，之后一直挂着（关的动画照常）
const SourceManagerDrawer = dynamic(() => import('./source-manager').then((m) => m.SourceManagerDrawer), { ssr: false });
const HistoryPanel = dynamic(() => import('./history-panel').then((m) => m.HistoryPanel), { ssr: false });
const FavoritePanel = dynamic(() => import('./favorite-panel').then((m) => m.FavoritePanel), { ssr: false });
const ProfileDrawer = dynamic(() => import('./profile-drawer').then((m) => m.ProfileDrawer), { ssr: false });

/** 顶部导航：Logo、搜索框（首页外）、历史、设置 */
export function Header({ showSearch = false }: { showSearch?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [favoriteOpen, setFavoriteOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // 打开过就一直挂着
  const [mounted, setMounted] = useState({ settings: false, history: false, favorite: false, profile: false });
  useEffect(() => {
    setMounted((m) =>
      (settingsOpen && !m.settings) || (historyOpen && !m.history) || (favoriteOpen && !m.favorite) || (profileOpen && !m.profile)
        ? { settings: m.settings || settingsOpen, history: m.history || historyOpen, favorite: m.favorite || favoriteOpen, profile: m.profile || profileOpen }
        : m,
    );
  }, [settingsOpen, historyOpen, favoriteOpen, profileOpen]);
  const profile = useProfile();
  const [query, setQuery] = useState('');
  // 与首页搜索框共用同一套「最近搜索」下拉逻辑
  const searchHistory = useSearchHistory(query);

  const submitSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (!q) return;
    searchHistory.close();
    router.push(`/?s=${encodeURIComponent(q)}`, { scroll: false });
    // 顶栏搜索一并写入最近搜索（此前只有首页会记录）
    searchHistory.record(q);
  };

  const pickHistory = (text: string) => {
    setQuery(text);
    submitSearch(text);
  };

  return (
    <>
      <header className="sticky top-0 z-40 glass !border-x-0 !border-t-0">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/" aria-label="LibreTV 首页" className="flex items-center shrink-0">
            {/* 文字品牌（Apple TV 式），不再用彩色图标 */}
            <span className="text-[17px] font-semibold tracking-[-0.02em] text-content">
              Libre<span className="text-faint font-medium">TV</span>
            </span>
          </Link>

          {showSearch && (
            <form
              className="flex-1 max-w-xl hidden sm:block"
              onSubmit={(e) => {
                e.preventDefault();
                submitSearch(query);
              }}
            >
              <div ref={searchHistory.containerRef} className="relative">
                <input
                  className={cn(
                    'input w-full h-9 !rounded-[22px] pl-4',
                    // 展开时：底边改为内部分隔线，与下拉拼成同一面板
                    searchHistory.visible && '!rounded-b-none focus-visible:ring-0'
                  )}
                  aria-label="搜索影片"
                  placeholder="搜索"
                  value={query}
                  maxLength={100}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-expanded={searchHistory.visible}
                  aria-controls="header-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `header-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {searchHistory.visible && (
                  <SearchHistoryDropdown
                    id="header-search-history"
                    matches={searchHistory.matches}
                    activeIndex={searchHistory.activeIndex}
                    onPick={pickHistory}
                    onRemove={searchHistory.remove}
                    onClearAll={searchHistory.clearAll}
                  />
                )}
              </div>
            </form>
          )}

          <div className="flex-1 sm:hidden" />

          <nav className="flex items-center gap-0.5 sm:gap-1 ml-auto">
            <HeaderLink href="/live" active={pathname === '/live'}>
              直播
            </HeaderLink>
            <span className="hidden sm:contents">
              <HeaderLink href="/about" active={pathname === '/about'}>
                关于
              </HeaderLink>
            </span>
            <ThemeToggle />
            <button
              type="button"
              className="px-3 py-1.5 rounded-full text-sm font-medium text-muted hover:text-content hover:bg-content/[0.08] max-w-16 sm:max-w-24 truncate whitespace-nowrap"
              onClick={() => setProfileOpen(true)}
              title="切换设定档"
            >
              {profile.name || '设定档'}
            </button>
            <IconButton label="收藏" onClick={() => setFavoriteOpen(true)}>
              <Icon name="star" />
            </IconButton>
            <IconButton label="观看历史" onClick={() => setHistoryOpen(true)}>
              <Icon name="clock" />
            </IconButton>
            <IconButton label="下载管理" onClick={requestShowDownloadManager}>
              <Icon name="download" />
            </IconButton>
            <IconButton label="设置" onClick={() => setSettingsOpen(true)}>
              <Icon name="gear" />
            </IconButton>
          </nav>
        </div>
      </header>

      {mounted.settings && <SourceManagerDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
      {mounted.history && <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />}
      {mounted.favorite && <FavoritePanel open={favoriteOpen} onClose={() => setFavoriteOpen(false)} />}
      {mounted.profile && <ProfileDrawer open={profileOpen} onClose={() => setProfileOpen(false)} />}
    </>
  );
}

function HeaderLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        'px-2.5 sm:px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors',
        active ? 'text-content bg-content/[0.1]' : 'text-muted hover:text-content hover:bg-content/[0.06]'
      )}
    >
      {children}
    </Link>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center text-muted hover:text-content hover:bg-content/[0.08] transition-colors"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
