'use client';

import { useSyncExternalStore } from 'react';
import { getProfileSnapshot, subscribeProfile, type ProfileSnapshot } from './profile-session';

export function useProfile(): ProfileSnapshot {
  return useSyncExternalStore(subscribeProfile, getProfileSnapshot, () => ({ id: '', name: '' }));
}
