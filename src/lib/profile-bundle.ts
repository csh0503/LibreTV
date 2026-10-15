/** 换设备时整份带走的设定档。不含本机 id，到新浏览器再挂到那里的设定档上。 */
export interface ProfileBundle {
  version: 1;
  name: string;
  updatedAt: number;
  prefs: Record<string, unknown>;
  history: Record<string, unknown>[];
  favorites: Record<string, unknown>[];
  progress: { localKey: string; position: number; duration: number; updatedAt: number }[];
  searches: { text: string; timestamp: number }[];
  device?: {
    customAPIs?: { url?: string; key?: string }[];
    selectedKeys?: string[];
    subscriptions?: { url?: string }[];
    liveSubscriptions?: { url?: string }[];
    liveSelectedUrls?: string[];
  };
}
