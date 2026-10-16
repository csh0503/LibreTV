'use client';

import { useEffect, useState } from 'react';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { useToast } from './toast';
import { useProfile } from '@/lib/use-profile';
import { api } from '@/lib/client-api';
import { openCloudProfile, syncCloudProfilesToDevice } from '@/lib/profile-sync';
import { createProfile, deleteProfile, listProfiles } from '@/lib/profile';
import type { UserProfile } from '@/lib/db';
import { cn } from '@/lib/utils';

type ListedProfile = UserProfile & { cloudOnly?: boolean };

/** 同一台设备上的设定档。云端有的档打开时就会拉下来。换档后历史、收藏和个人偏好一起换。 */
export function ProfileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const current = useProfile();
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<ListedProfile[]>([]);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [unlockId, setUnlockId] = useState('');
  const [unlockPin, setUnlockPin] = useState('');
  const [pending, setPending] = useState<ListedProfile | null>(null);

  const reload = () => {
    void (async () => {
      const listed = await syncCloudProfilesToDevice();
      const local = await listProfiles();
      const cloud = listed ?? [];
      const localIds = new Set(local.map((item) => item.id));
      const extras: ListedProfile[] = cloud
        .filter((item) => !localIds.has(item.id))
        .map((item) => ({
          id: item.id,
          name: item.name || '设定档',
          pinHash: item.pinHash,
          createdAt: item.updatedAt,
          cloudUpdatedAt: item.updatedAt,
          cloudOnly: true,
        }));
      setProfiles([...local, ...extras]);
    })().catch(() => {});
  };

  useEffect(() => {
    if (open) reload();
  }, [open, current.id]);

  const onCreate = async () => {
    try {
      await createProfile(name, pin.trim() || undefined);
      setName('');
      setPin('');
      reload();
      toast('已切换到新设定档', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建设定档失败', 'error');
    }
  };

  const onSwitch = async (profile: UserProfile, password?: string) => {
    try {
      await openCloudProfile(profile.id, password);
      setUnlockId('');
      setUnlockPin('');
      toast(`已切换到「${profile.name}」`, 'success');
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : '切换失败', 'error');
    }
  };

  return (
    <>
    <Drawer open={open} onClose={onClose} title="设定档" width="max-w-md">
      <p className="text-xs text-faint mb-3">
        每个设定档有自己的观看历史、收藏和偏好。其他设备上新建的档会自动同步到这里。
      </p>
      <ul className="space-y-2 mb-4">
        {profiles.map((profile) => {
          const active = profile.id === current.id;
          const localCount = profiles.filter((item) => !item.cloudOnly).length;
          return (
            <li key={profile.id} className={cn('rounded-xl border p-3', active ? 'border-accent' : 'border-line')}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-content truncate">{profile.name}</div>
                  <div className="text-[11px] text-faint">
                    {profile.cloudOnly
                      ? '正在从云端同步'
                      : `${profile.pinHash ? '有密码' : '无密码'}${active ? ' · 使用中' : ''}`}
                  </div>
                </div>
                {!active && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => (profile.pinHash ? setUnlockId(profile.id) : void onSwitch(profile))}
                  >
                    切换
                  </button>
                )}
                {(profile.cloudOnly || localCount > 1) && (
                  <button
                    type="button"
                    className="text-xs text-faint hover:text-red-400"
                    onClick={() => setPending(profile)}
                  >
                    删除
                  </button>
                )}
              </div>
              {unlockId === profile.id && (
                <form
                  className="flex gap-2 mt-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onSwitch(profile, unlockPin);
                  }}
                >
                  <input
                    type="password"
                    className="input flex-1"
                    placeholder="这个设定档的密码"
                    value={unlockPin}
                    onChange={(event) => setUnlockPin(event.target.value)}
                    aria-label="设定档密码"
                  />
                  <button type="submit" className="btn-primary btn-sm">进入</button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      <form
        className="space-y-2 border-t border-line pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate();
        }}
      >
        <div className="text-xs text-muted">新建设定档</div>
        <input
          className="input w-full"
          placeholder="名称，例如客厅、小朋友"
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
        <button type="submit" className="btn-primary btn-sm" disabled={!name.trim()}>
          创建并切换
        </button>
      </form>
    </Drawer>
    <ConfirmDialog
      open={Boolean(pending)}
      danger
      title={pending ? `删除「${pending.name}」？` : '删除设定档'}
      confirmLabel="删除"
      message={
        pending?.cloudOnly
          ? '这个设定档只在云端。删掉后，其他设备的「谁在看」里也不会再出现。里面的观看记录和收藏会一起去掉。'
          : '这台设备和云端都会删掉。里面的观看记录和收藏会一起去掉。'
      }
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const profile = pending;
        setPending(null);
        if (!profile) return;
        void (async () => {
          try {
            if (profile.cloudOnly) await api.profileSyncDelete(profile.id);
            else await deleteProfile(profile.id);
            reload();
            toast(`已删除「${profile.name}」`, 'info');
          } catch (err) {
            toast(err instanceof Error ? err.message : '删除失败', 'error');
          }
        })();
      }}
    />
    </>
  );
}
