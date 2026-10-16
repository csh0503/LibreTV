'use client';

import { useSyncExternalStore } from 'react';
import { getProfileSnapshot, subscribeProfile, type ProfileSnapshot } from './profile-session';

/** 服务端快照要每次返回同一个对象，否则 React 会警告并反复重渲染 */
const SERVER_SNAPSHOT: ProfileSnapshot = { id: '', name: '' };
const getServerSnapshot = () => SERVER_SNAPSHOT;

export function useProfile(): ProfileSnapshot {
  return useSyncExternalStore(subscribeProfile, getProfileSnapshot, getServerSnapshot);
}
