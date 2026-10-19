// 采集站（Apple CMS 资源站）描述
export interface SourceConfig {
  /** 唯一标识，如 "custom_0"；内置源直接用短名 */
  key: string;
  name: string;
  /** API 根地址，如 https://example.com/api.php/provide/vod */
  url: string;
  /** 可选：详情页根地址（部分源需要爬详情页提取 m3u8） */
  detail?: string;
  isAdult?: boolean;
}

/** 采集站列表里的一条影片（搜索和分类浏览共用） */
export interface VodListItem {
  vodId: string;
  name: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
  /** 源站自带评分（vod_douban_score / vod_score），没有或为 0 时不填 */
  rating?: string;
}

export interface SearchResultItem extends VodListItem {
  sourceKey: string;
  sourceName: string;
  /** 自定义源的 API 地址，详情请求需要 */
  sourceUrl?: string;
  isAdult?: boolean;
  /** 搜索结果里自带的第 1 集地址（ac=videolist 有 vod_play_url）：质检直接用，不用再请求详情 */
  firstEpisode?: string;
  /** 搜索结果里自带的集数 */
  episodeCount?: number;
}

/** 采集站分类（ac=list 的 class） */
export interface CmsClass {
  id: string;
  name: string;
}

/** 分类浏览：分类表 + 当前条件下的一页影片（不含源身份，由调用方补上） */
export interface BrowseResponse {
  classes: CmsClass[];
  items: VodListItem[];
  page: number;
  pageCount: number;
}

export interface VideoInfo {
  title?: string;
  cover?: string;
  desc?: string;
  typeName?: string;
  year?: string;
  area?: string;
  director?: string;
  actor?: string;
  remarks?: string;
  sourceKey: string;
  sourceName: string;
  sourceUrl?: string;
}

export interface VideoDetail {
  episodes: string[];
  /** 集名（「第02集」），和 episodes 一一对应；源没给就没有 */
  episodeNames?: string[];
  videoInfo: VideoInfo;
}

/** 首页卡片点开时一起带上的元数据：作品详情弹窗和「暂无片源」卡用它展示海报、简介等 */
export type TitlePick = Pick<DoubanItem, 'title'> &
  Partial<
    Pick<
      DoubanItem,
      | 'id'
      | 'cover'
      | 'backdrop'
      | 'year'
      | 'rating'
      | 'ratings'
      | 'area'
      | 'genres'
      | 'isTv'
      | 'status'
      | 'statusGuessed'
      | 'remarks'
      | 'subtitle'
      | 'sourceLabel'
    >
  >;

export type RatingSource = 'douban' | 'bangumi' | 'tmdb' | 'bili';

export interface DoubanItem {
  id: string;
  title: string;
  cover: string;
  /** 横版海报/剧照（如 B站 ss_horizontal_cover 或 TMDB backdrop），首页大图优先采用 */
  backdrop?: string;
  rating?: string;
  /** 这条资料来自哪个站（编号看不出来时才标，比如 Bangumi 放送表的纯数字编号、百度热播） */
  origin?: RatingSource | 'other';
  /** 各站的原始评分（融合后才有）：rating 是按各站偏差校正后的加权平均 */
  ratings?: Partial<Record<RatingSource, number>>;
  isTv?: boolean;
  /** 上映年，豆瓣 card_subtitle 或 year 字段 */
  year?: string;
  /** year 不是来源给的、是按筛选条件填的（B站片库按年份筛）：合并时不当作可靠年份 */
  yearSoft?: boolean;
  /** 最新一集的播出日期（YYYY-MM-DD，目前只有 B站条目有）：判断热度是不是「现在」的 */
  lastAired?: string;
  /** 原名（TMDB 的 original_name、Bangumi 的日文名）：各站中文译名不一样时靠它认同一部 */
  originalTitle?: string;
  /** 还没开播（只在服务端取数过程中用来剔除） */
  unreleased?: boolean;
  /** 地区，可能是「美国 加拿大」这种多地区 */
  area?: string;
  /** 题材，空格分隔，来自 card_subtitle 的第三段 */
  genres?: string;
  /**
   * 能判断时才有。连载来自「更新至」或本周放送；
   * 完结来自「全N集 / 完结」，或上映年早于今年。
   */
  status?: 'airing' | 'ended';
  /** status 只是按年份推断的（没有任何更新说明或完结标记），合并时让位给有依据的来源 */
  statusGuessed?: boolean;
  /** 原始更新说明，如「更新至18集」或实时热度 */
  remarks?: string;
  /** 简短看点、主演阵容、播放热度或剧情简介，用于首页大图与实时榜单展示 */
  subtitle?: string;
  /** 榜单来源标签，如「豆瓣实时」「B站国创」「B站番剧」「百度热播」「TMDB」 */
  sourceLabel?: string;
  /** 来源自带的热度值（如 Bangumi 在看 + 评分人数），只用于同一来源内部排序 */
  popularity?: number;
  /** 综合总榜：比起 3~24 小时前上升了几名（负数为下降） */
  rankDelta?: number;
  /** 综合总榜：上次快照里还没有，新上榜 */
  rankNew?: boolean;
}

export interface SourceSearchOutcome {
  sourceKey: string;
  ok: boolean;
  list: SearchResultItem[];
  error?: string;
  /** 因超时失败：源可能只是慢，前端以琥珀色区分于真正的失败 */
  timedOut?: boolean;
  /** 该源搜索总耗时（ms），用于健康徽章 */
  ms?: number;
}

// —— API 响应结构 ——

export interface SearchResponse {
  list: SearchResultItem[];
  failures: { sourceKey: string; error: string; timedOut?: boolean }[];
  /** 除用户输入外额外搜过的通行名，例如搜航海王时的海贼王 */
  aliases?: string[];
}

/** /api/search?stream=1 的 NDJSON 事件：逐源推送 + 最终聚合 */
export type SearchStreamEvent =
  | ({ type: 'source' } & SourceSearchOutcome)
  | { type: 'done'; list: SearchResultItem[]; failures: SearchResponse['failures']; aliases?: string[] };

export interface DoubanResponse {
  items: DoubanItem[];
  /** 该筛选条件下的总条数；没有时前端按「本页是否满页」判断还有没有下一页 */
  total?: number;
  /** 热榜才有：服务端算出这份榜单的时间、缓存时长和各来源取数情况 */
  meta?: {
    updatedAt: number;
    ttl: number;
    sources: { name: string; ok: boolean; count: number }[];
  };
}

export interface BangumiCalendarDay {
  /** 1=周一 … 7=周日 */
  weekday: number;
  items: DoubanItem[];
}

export interface BangumiCalendarResponse {
  days: BangumiCalendarDay[];
}

export interface AuthStatusResponse {
  /** 服务器是否配置了 PASSWORD */
  passwordRequired: boolean;
  /** 当前会话是否已验证 */
  verified: boolean;
  version: string;
  /** 部署者通过 DEFAULT_SOURCES 环境变量预置的采集站（未配置时为空数组） */
  defaultSources: SourceConfig[];
  /** 部署者通过 DEFAULT_LIVE_SOURCES 环境变量预置的直播源（未配置时为空数组） */
  defaultLiveSources: LiveSourceConfig[];
  /** 部署者通过 DEFAULT_SUBSCRIPTIONS 环境变量预置的 SourceList 订阅链接（未配置时为空数组） */
  defaultSubscriptions: { url: string; name?: string }[];
  /** 部署者通过 DEFAULT_RECOMMEND_SOURCE 环境变量指定的首页推荐数据源默认值（未配置时为 null） */
  defaultRecommendSource: 'douban' | 'bangumi' | 'hot-list' | null;
  /** 部署者通过 DEFAULT_IMAGE_MODE 环境变量指定的封面图加载方式默认值（未配置时为 null） */
  defaultImageMode: 'direct' | 'proxy' | null;
  /** 设定档同步用的存储 */
  syncStorage?: 'redis' | 'blob' | 'file' | 'none';
}

// —— 直播 / IPTV ——

/** 直播源（M3U 订阅）配置 */
export interface LiveSourceConfig {
  key: string;
  name: string;
  /** M3U 订阅地址 */
  url: string;
  /** 可选：XMLTV 节目单地址 */
  epg?: string;
}

/** 单个直播频道（由 M3U 解析得到） */
export interface LiveChannel {
  /** tvg-id 优先，缺失时由 URL 生成的稳定短 id */
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  /** M3U 的 tvg-name 属性（原始台名） */
  rawName?: string;
}

export interface LivePlaylistResponse {
  /** 订阅名（M3U 无名时为空） */
  name?: string;
  channels: LiveChannel[];
  groups: string[];
}

/** 单条节目单条目（XMLTV programme） */
export interface EpgProgram {
  channelId: string;
  /** epoch ms */
  start: number;
  /** epoch ms */
  stop: number;
  title: string;
  desc?: string;
}

export interface LiveEpgResponse {
  channelId: string;
  current?: EpgProgram;
  next?: EpgProgram;
  programs: EpgProgram[];
}

// —— 数据源订阅 ——

/** 订阅条目未被导入（跳过）的原因分类 */
export type SubscriptionSkipReason =
  /** Spider 类站点（csp_* / jar / js / py），需 TVBOX 引擎才能运行 */
  | 'spider'
  /** 仅提供 XML 接口或不支持的类型 */
  | 'xml'
  /** 站点自身标记为不可搜索（本站只有搜索入口，导入后无法使用） */
  | 'unsearchable'
  /** 直播源不是 M3U 播放列表（如 txt 频道列表、单仓 JSON） */
  | 'nonM3uLive'
  /** 地址非法、非 http(s) 或未通过服务端公网校验 */
  | 'invalidUrl';

/** 订阅解析统计：说明跳过与截断情况，用于导入结果提示 */
export interface SubscriptionParseStats {
  /** 识别出的订阅格式 */
  format: 'libretv' | 'tvbox';
  /** 被跳过的条目总数 */
  skipped: number;
  /** 跳过原因分类计数 */
  skippedByReason: Partial<Record<SubscriptionSkipReason, number>>;
  /** 被跳过条目的名称示例（最多 3 个），便于用户定位 */
  skippedSamples?: string[];
  /** 因超出数量上限被截断的条目数 */
  truncated: number;
}

/**
 * 远程订阅解析结果。
 * `sources` 为点播源（Apple CMS 采集站），`liveSources` 为直播源（M3U + 可选 EPG）。
 * 兼容两种订阅格式：LibreTV-SourceList JSON 与 TVBOX 配置 JSON（`sites` / `lives`）。
 * 老格式订阅只有 `sources`，此时 `liveSources` 为空数组。
 */
export interface SourceListPayload {
  /** 订阅列表自带名称 */
  name?: string;
  sources: Omit<SourceConfig, 'key'>[];
  liveSources: Omit<LiveSourceConfig, 'key'>[];
  /** 解析统计（格式、跳过与截断），老数据可能缺失 */
  stats?: SubscriptionParseStats;
}
