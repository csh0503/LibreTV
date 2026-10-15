'use client';

import { useEffect, useState } from 'react';
import { Drawer } from './drawer';
import { useToast } from './toast';
import { useProfile } from '@/lib/use-profile';
import { createProfile, deleteProfile, listProfiles, switchProfile } from '@/lib/profile';
import type { UserProfile } from '@/lib/db';
import { cn } from '@/lib/utils';

/** 同一台设备上的设定档。换档后历史、收藏和个人偏好一起换。 */
export function ProfileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const current = useProfile();
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [unlockId, setUnlockId] = useState('');
  const [unlockPin, setUnlockPin] = useState('');

  const reload = () => {
    void listProfiles().then(setProfiles).catch(() => {});
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
      await switchProfile(profile.id, password);
      setUnlockId('');
      setUnlockPin('');
      toast(`已切换到「${profile.name}」`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '切换失败', 'error');
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="设定档" width="max-w-md">
      <p className="text-xs text-faint mb-3">
        每个设定档有自己的观看历史、收藏、播放进度、搜索记录、直播收藏和成人开关。点播源仍是这台设备共用的。
      </p>
      <ul className="space-y-2 mb-4">
        {profiles.map((profile) => {
          const active = profile.id === current.id;
          return (
            <li key={profile.id} className={cn('rounded-lg border p-3', active ? 'border-accent' : 'border-line')}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-content truncate">{profile.name}</div>
                  <div className="text-[11px] text-faint">{profile.pinHash ? '有密码' : '无密码'}{active ? ' · 使用中' : ''}</div>
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
                {profiles.length > 1 && (
                  <button
                    type="button"
                    className="text-xs text-faint hover:text-red-400"
                    onClick={() => {
                      void deleteProfile(profile.id)
                        .then(() => {
                          reload();
                          toast(`已删除「${profile.name}」`, 'info');
                        })
                        .catch((err) => toast(err instanceof Error ? err.message : '删除失败', 'error'));
                    }}
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
  );
}
