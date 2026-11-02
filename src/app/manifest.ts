import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'LibreTV - 免费在线视频搜索与观看平台',
    short_name: 'LibreTV',
    description: '免费在线视频搜索与观看平台',
    start_url: '/',
    display: 'standalone',
    // 和 layout.tsx 的 viewport.themeColor / globals.css 的暗色 --c-page（#151413）保持一致：
    // 以前是旧版赛博蓝 #0b101a，装到桌面后启动画面会闪一下蓝黑
    background_color: '#151413',
    theme_color: '#151413',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
