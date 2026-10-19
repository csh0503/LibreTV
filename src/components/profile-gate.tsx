'use client';

import { useEffect, useState } from 'react';
import { createProfile, deleteProfile, listProfiles } from '@/lib/profile';
import { api } from '@/lib/client-api';
import { openCloudProfile, syncCloudProfilesToDevice } from '@/lib/profile-sync';
import { db, type UserProfile } from '@/lib/db';
import { rememberedProfileId } from '@/lib/profile-session';


const COLORS = ['#e11d48', '#0ea5e9', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2'];

type GateProfile = UserProfile & { onDevice: boolean };

function colorFor(name: string): string {
  let n = 0;
  for (const ch of name) n = (n + ch.charCodeAt(0)) % COLORS.length;
  return COLORS[n] ?? COLORS[0];
}

/** 本机一个设定档都没有时建「默认」：只建一次（同时有两处调用时不会建出两个） */
let creatingDefault: Promise<void> | null = null;

/**
 * 「谁在看？」：选过一次就记住（rememberProfileChoice），以后打开直接进、不问密码；
 * 只有手动切换设定档时才再选（有密码的要输密码）。第一次打开、只有一个没密码的设定档时也直接进。
 */
export function ProfileGate() {
  // 记住了就先不显示，免得闪一下；确认那个设定档还在这台设备上，不在了再打开
  const [open, setOpen] = useState(() => !rememberedProfileId());
  const [profiles, setProfiles] = useState<GateProfile[]>([]);
  const [unlockId, setUnlockId] = useState('');
  const [unlockPin, setUnlockPin] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [managing, setManaging] = useState(false);
  const [pending, setPending] = useState<GateProfile | null>(null);
  const reload = () => {
    void (async () => {
      let listed = await syncCloudProfilesToDevice();
      let local = await listProfiles();
      // 本机一个都没有、云端又一时没连上（服务器冷启动 / 网络慢）：多等几次再说，
      // 不然第一次打开只看到一个空的「谁在看？」和「+」
      for (let attempt = 0; listed === null && local.length === 0 && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        listed = await syncCloudProfilesToDevice();
        local = await listProfiles();
      }
      // 云端没连上时不要把本机档清掉，也不要当成「云端是空的」再新建一个默认
      const cloud = listed ?? [];
      if (listed && local.length === 0 && cloud.length === 0) {
        if (!creatingDefault) creatingDefault = createProfile('默认');
        await creatingDefault;
        local = await listProfiles();
      }
      const byId = new Map<string, GateProfile>();
      for (const item of local) byId.set(item.id, { ...item, onDevice: true });
      for (const remote of cloud) {
        const existing = byId.get(remote.id);
        byId.set(remote.id, {
          id: remote.id,
          name: remote.name || existing?.name || '设定档',
          pinHash: remote.pinHash || existing?.pinHash,
          createdAt: existing?.createdAt ?? remote.updatedAt,
          cloudUpdatedAt: remote.updatedAt,
          onDevice: Boolean(existing),
        });
      }
      const all = [...byId.values()];
      setProfiles(all);
      // 只有一个、没有密码：不用选
      if (!rememberedProfileId() && all.length === 1 && !all[0].pinHash) void enter(all[0]);
    })().catch(() => setError('设定档还没准备好'));
  };

  useEffect(() => {
    const remembered = rememberedProfileId();
    if (remembered) {
      void db.profiles.get(remembered).then((p) => {
        if (!p) {
          setOpen(true);
          reload();
        }
      });
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const choose = (profile: GateProfile) => {
    if (managing) return;
    setError('');
    if (profile.pinHash) {
      setUnlockId(profile.id);
      setUnlockPin('');
      return;
    }
    void enter(profile);
  };

  const remove = async (profile: GateProfile) => {
    setError('');
    try {
      if (profile.onDevice) {
        const local = await listProfiles();
        if (local.length <= 1) {
          setError('这台设备上至少留一个设定档。标着「只在云端」的可以删。');
          return;
        }
        await deleteProfile(profile.id);
      } else {
        await api.profileSyncDelete(profile.id);
      }
      setPending(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-page px-4">
      <h1 className="text-2xl sm:text-3xl font-semibold text-content mb-2">谁在看？</h1>
      <button type="button" className="text-sm text-muted hover:text-content mb-8" onClick={() => setManaging((value) => !value)}>
        {managing ? '完成' : '管理设定档'}
      </button>
      <div className="flex flex-wrap justify-center gap-6 max-w-3xl">
        {profiles.map((profile) => (
          <div
            key={profile.id}
            role="button"
            tabIndex={0}
            className="group relative flex flex-col items-center gap-2 w-28"
            onClick={() => choose(profile)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              choose(profile);
            }}
          >
            {managing && profiles.length > 1 && (
              <button
                type="button"
                className="absolute -right-1 -top-1 z-10 grid h-6 w-6 place-items-center rounded-full bg-red-600 text-sm text-white"
                aria-label={`删除${profile.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setPending(profile);
                }}
              >
                ×
              </button>
            )}
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
            {!profile.onDevice && (
              <span className="text-[11px] text-faint -mt-1">点一下同步到这台</span>
            )}
          </div>
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

      {pending && (
        <div className="mt-8 w-full max-w-xs rounded-xl bg-surface-raised p-4 shadow-2xl">
          <p className="text-sm text-content">删除「{pending.name}」？</p>
          <p className="mt-1 text-xs text-muted leading-relaxed">
            {pending.onDevice
              ? '这台设备和云端都会删掉。里面的观看记录和收藏会一起去掉。'
              : '它只在云端，这台设备的设定里看不到。删掉后，其他设备的「谁在看」里也不会再出现。'}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="btn-ghost text-sm" onClick={() => setPending(null)}>
              取消
            </button>
            <button type="button" className="btn text-sm text-white bg-danger hover:bg-danger-hover" onClick={() => void remove(pending)}>
              删除
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
    </div>
  );
}
