/**
 * 当前设定档的同步快照。不引用 IndexedDB，避免和 db.ts 循环依赖。
 */

export interface ProfileSnapshot {
  id: string;
  name: string;
}

let snapshot: ProfileSnapshot = { id: '', name: '' };
const listeners = new Set<() => void>();
let ensureProfiles: () => Promise<void> = () => Promise.resolve();
let ready: Promise<void> | null = null;

export function getProfileSnapshot(): ProfileSnapshot {
  return snapshot;
}

export function setProfileSnapshot(next: ProfileSnapshot): void {
  snapshot = next;
  if (typeof localStorage !== 'undefined' && next.id) {
    localStorage.setItem('libretv-active-profile', next.id);
  }
  listeners.forEach((listener) => listener());
}

export function getActiveProfileId(): string {
  return snapshot.id;
}

export function subscribeProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readStoredProfileId(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem('libretv-active-profile') || '';
}

export function registerProfileStarter(starter: () => Promise<void>): void {
  ensureProfiles = starter;
}

export function whenProfileReady(): Promise<void> {
  if (!ready) ready = ensureProfiles();
  return ready;
}

export function resetProfileReady(): void {
  ready = null;
}
