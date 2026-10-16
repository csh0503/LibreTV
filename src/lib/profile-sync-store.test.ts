import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const blob = new Map<string, string>();
const blobGets: string[] = [];
vi.mock('@vercel/blob', () => ({
  get: vi.fn(async (path: string) => {
    blobGets.push(path);
    const value = blob.get(path);
    return value === undefined
      ? null
      : { statusCode: 200, stream: new Response(value).body };
  }),
  put: vi.fn(async (path: string, json: string) => {
    blob.set(path, json);
  }),
  del: vi.fn(async (path: string) => {
    blob.delete(path);
  }),
}));

const redis = new Map<string, string>();
const ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  blob.clear();
  redis.clear();
  blobGets.length = 0;
  vi.stubEnv('KV_REST_API_URL', 'https://redis.test');
  vi.stubEnv('KV_REST_API_TOKEN', 't');
  vi.stubEnv('BLOB_STORE_ID', 'store');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const [cmd, key, value] = JSON.parse(init.body) as string[];
      let result: unknown = null;
      if (cmd === 'GET') result = redis.get(key) ?? null;
      if (cmd === 'SET') {
        redis.set(key, value);
        result = 'OK';
      }
      if (cmd === 'DEL') result = redis.delete(key) ? 1 : 0;
      if (cmd === 'EXISTS') result = redis.has(key) ? 1 : 0;
      return new Response(JSON.stringify({ result }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('从 Blob 搬到 Redis', () => {
  it('读名单时把名单和名单上的设定档一起搬进 Redis，之后不再读 Blob', async () => {
    const store = await import('./profile-sync-store');
    blob.set('profile-sync/catalog.json', JSON.stringify({ profiles: [{ id: ID, name: '我' }] }));
    blob.set(`profile-sync/profiles/${ID}.json`, '{"version":1}');

    expect(store.syncStorageKind()).toBe('redis');
    const catalog = await store.readStoredJson(store.PROFILE_CATALOG_KEY);
    expect(JSON.parse(catalog!).profiles[0].id).toBe(ID);
    expect(redis.get('profile:catalog.json')).toBe(catalog);
    expect(redis.get(`profile:profiles/${ID}.json`)).toBe('{"version":1}');

    blobGets.length = 0;
    expect(await store.readStoredJson(store.profileDataKey(ID))).toBe('{"version":1}');
    expect(blobGets).toHaveLength(0);
  });

  it('写只写 Redis；删除连 Blob 的旧副本一起删，删掉的不会被搬回来', async () => {
    const store = await import('./profile-sync-store');
    blob.set(`profile-sync/profiles/${ID}.json`, '{"old":true}');
    await store.writeStoredJson(store.profileDataKey(ID), '{"new":true}');
    expect(redis.get(`profile:profiles/${ID}.json`)).toBe('{"new":true}');
    expect(blob.get(`profile-sync/profiles/${ID}.json`)).toBe('{"old":true}');

    await store.deleteStoredJson(store.profileDataKey(ID));
    expect(await store.readStoredJson(store.profileDataKey(ID))).toBeNull();
  });

  it('认自定义前缀的 Upstash 变量', async () => {
    vi.stubEnv('KV_REST_API_URL', '');
    vi.stubEnv('KV_REST_API_TOKEN', '');
    vi.stubEnv('STORAGE_REST_API_URL', 'https://xx.upstash.io');
    vi.stubEnv('STORAGE_REST_API_TOKEN', 't');
    const store = await import('./profile-sync-store');
    expect(store.syncStorageKind()).toBe('redis');
  });

  it('只接了 Blob 时照旧用 Blob', async () => {
    vi.stubEnv('KV_REST_API_URL', '');
    vi.stubEnv('KV_REST_API_TOKEN', '');
    const store = await import('./profile-sync-store');
    expect(store.syncStorageKind()).toBe('blob');
    blob.set('profile-sync/catalog.json', '{"profiles":[]}');
    expect(await store.readStoredJson(store.PROFILE_CATALOG_KEY)).toBe('{"profiles":[]}');
    expect(redis.size).toBe(0);
  });
});
