'use client';

import { useEffect, useState } from 'react';
import { createProfile, listProfiles } from '@/lib/profile';
import { api } from '@/lib/client-api';
import { openCloudProfile, pushProfile } from '@/lib/profile-sync';
import type { UserProfile } from '@/lib/db';


const COLORS = ['#e11d48', '#0ea5e9', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2'];

function colorFor(name: string): string {
  let n = 0;
  for (const ch of name) n = (n + ch.charCodeAt(0)) % COLORS.length;
  return COLORS[n] ?? COLORS[0];
}

/** 登录后先选设定档，选完才进入首页。刷新或重新登录会再出现一次。 */
export function ProfileGate() {
  const [open, setOpen] = useState(true);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [unlockId, setUnlockId] = useState('');
  const [unlockPin, setUnlockPin] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const reload = () => {
    void (async () => {
      const local = await listProfiles();
      let cloud: { id: string; name: string; pinHash?: string; updatedAt: number }[] = [];
      try {
        cloud = (await api.profileCatalog()).profiles;
      } catch {
        // 云端暂时不可用时仍显示本机设定档
      }
      for (const item of local) {
        if (!cloud.some((remote) => remote.id === item.id)) {
          try {
            await pushProfile(item.id);
          } catch {
            // 上传失败不挡住选档
          }
        }
      }
      const byId = new Map(local.map((item) => [item.id, item]));
      for (const remote of cloud) {
        const existing = byId.get(remote.id);
        byId.set(remote.id, {
          id: remote.id,
          name: remote.name || existing?.name || '设定档',
          pinHash: remote.pinHash || existing?.pinHash,
          createdAt: existing?.createdAt ?? remote.updatedAt,
          cloudUpdatedAt: remote.updatedAt,
        });
      }
      setProfiles([...byId.values()]);
    })().catch(() => setError('设定档还没准备好'));
  };

  useEffect(() => {
    reload();
  }, []);

  const enter = async (profile: UserProfile, password?: string) => {
    setError('');
    try {
      await openCloudProfile(profile.id, password);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换失败');
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-page px-4">
      <h1 className="text-2xl sm:text-3xl font-semibold text-content mb-8">谁在看？</h1>
      <div className="flex flex-wrap justify-center gap-6 max-w-3xl">
        {profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            className="group flex flex-col items-center gap-2 w-28"
            onClick={() => (profile.pinHash ? setUnlockId(profile.id) : void enter(profile))}
          >
            <span
              className="w-24 h-24 rounded-xl grid place-items-center text-3xl font-semibold text-white shadow-lg transition-transform group-hover:scale-105"
              style={{ background: colorFor(profile.name) }}
            >
              {profile.name.slice(0, 1) || '档'}
            </span>
            <span className="text-sm text-muted group-hover:text-content truncate max-w-full">
              {profile.name}
              {profile.pinHash ? ' · 有密码' : ''}
            </span>
          </button>
        ))}
        <button type="button" className="flex flex-col items-center gap-2 w-28" onClick={() => setAdding(true)}>
          <span className="w-24 h-24 rounded-xl grid place-items-center text-4xl text-muted bg-chip border border-dashed border-line group-hover:text-content">
            +
          </span>
          <span className="text-sm text-muted">新建设定档</span>
        </button>
      </div>

      {unlockId && (
        <form
          className="mt-8 w-full max-w-xs space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const profile = profiles.find((item) => item.id === unlockId);
            if (profile) void enter(profile, unlockPin);
          }}
        >
          <p className="text-sm text-muted text-center">
            输入「{profiles.find((item) => item.id === unlockId)?.name}」的密码
          </p>
          <input
            type="password"
            className="input w-full"
            value={unlockPin}
            onChange={(event) => setUnlockPin(event.target.value)}
            aria-label="设定档密码"
            autoFocus
          />
          <button type="submit" className="btn-primary w-full">进入</button>
        </form>
      )}

      {adding && (
        <form
          className="mt-8 w-full max-w-xs space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createProfile(name, pin.trim() || undefined)
              .then(() => setOpen(false))
              .catch((err) => setError(err instanceof Error ? err.message : '创建失败'));
          }}
        >
          <input
            className="input w-full"
            placeholder="名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="设定档名称"
          />
          <input
            type="password"
            className="input w-full"
            placeholder="密码，可选"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            aria-label="设定档密码，可选"
          />
          <button type="submit" className="btn-primary w-full" disabled={!name.trim()}>
            创建并进入
          </button>
        </form>
      )}

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
    </div>
  );
}
