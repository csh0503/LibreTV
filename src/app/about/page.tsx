'use client';

import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';

export default function AboutPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-10 space-y-8">
        <section>
          <h1 className="text-xl font-bold text-content mb-3">关于 LibreTV</h1>
          <p className="text-sm text-muted leading-relaxed">
            LibreTV 是一个免费的在线视频搜索与观看平台。输入片名即可在多个点播源中聚合搜索，
            无需注册、无内嵌广告、不存储任何视频文件。所有播放内容均来自第三方公开接口。
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">快捷键</h2>
          <ul className="text-sm text-muted space-y-1.5 list-disc list-inside">
            <li><code className="text-accent">空格</code> 播放 / 暂停</li>
            <li><code className="text-accent">←</code> / <code className="text-accent">→</code> 快退 / 快进（步长在播放器设置里选 5 / 10 / 15 / 30 秒）</li>
            <li><code className="text-accent">↑</code> / <code className="text-accent">↓</code> 音量调节</li>
            <li><code className="text-accent">F</code> 切换全屏</li>
            <li><code className="text-accent">Alt + ←/→</code> 上一集 / 下一集</li>
            <li><code className="text-accent">&lt;</code> / <code className="text-accent">&gt;</code> 减速 / 加速</li>
            <li>手机上：按住画面 2 倍速、双击左右两侧快退快进、左右滑拖进度</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">数据源体检</h2>
          <p className="text-sm text-muted leading-relaxed">
            首页的热榜、片库、找片源依赖豆瓣、B站、百度、Bangumi、TMDB 等上游。
            <a href="/diagnostics" className="text-accent hover:underline">打开体检页</a>
            可以看到它们现在通不通、取到多少、多快。
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">隐私与数据</h2>
          <p className="text-sm text-muted leading-relaxed">
            搜索历史、观看进度、收藏默认只保存在本设备浏览器中（IndexedDB）。
          </p>
          <p className="text-sm text-muted leading-relaxed mt-2">
            如果你使用「设定档」跨设备同步，这台设定档的观看记录、收藏、搜索记录会上传到本站配置的云存储
            （站点自建的 Redis 或 Vercel Blob），仅用同步码取回 —— 数据不出你部署的这套服务。
            不想同步就别在另一台设备输入同步码，或直接在设定档里删除。
          </p>
          <p className="text-sm text-muted leading-relaxed mt-2">
            聚合搜索请求由服务端代理转发，数据源看不到你的 IP 地址。
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">免责声明</h2>
          <p className="text-sm text-faint leading-relaxed">
            本项目不存储、不制作任何视频内容，仅提供第三方公开接口的聚合与播放能力。
            请尊重版权，所有内容的合法性由对应数据源负责。
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
