import { startCatalogSync } from './lib/catalog-sync';
import { startHomeSnapshotLoop } from './lib/home-snapshot';

/**
 * 常驻 Node 进程（家用伺服器的 Docker 容器）启动后：开本地片库的背景同步、首页快照每 10 分钟重算。
 * Vercel 上不开（没有常驻进程、文件系统只读）；本机开发默认不开（CATALOG_SYNC=1 才开），免得每次 dev 都去抓。
 */
const onVercel = Boolean(process.env.VERCEL);
const devWithoutSync = process.env.NODE_ENV !== 'production' && process.env.CATALOG_SYNC !== '1';

if (!onVercel && !devWithoutSync) {
  startCatalogSync();
  startHomeSnapshotLoop();
}
