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
  /** 豆瓣题材。旧包裹没有这份时当作还没记过。 */
  /**
   * 「不再推荐」。旧包裹没有这份时，不要清掉本机名单。
   * on 为 false 是取消；另一台较新的取消盖过较早的标记。
   */
  notInterested?: { title: string; at: number; on: boolean }[];
  tastes?: {
    title: string;
    updatedAt: number;
    doubanId?: string;
    channel?: string;
    genres?: string;
    area?: string;
    year?: string;
    rating?: string;
  }[];
  device?: {
    customAPIs?: { url?: string; key?: string }[];
    selectedKeys?: string[];
    subscriptions?: { url?: string }[];
    liveSubscriptions?: { url?: string }[];
    liveSelectedUrls?: string[];
  };
}
