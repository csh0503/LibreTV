import type { NextConfig } from 'next';
import fs from 'node:fs';
import path from 'node:path';

/** 版本号以 package.json 为单一来源，构建时注入 process.env.APP_VERSION（/api/status 使用） */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 全站安全头。
 * 只放「不改变渲染行为」的几条：CSP 仅用 frame-ancestors（不限制脚本 / 样式 / 媒体 ——
 * 播放器要连任意采集站、要有 inline 主题脚本，强 CSP 会直接把播放打死）。
 * Permissions-Policy 不碰 fullscreen / picture-in-picture：播放器依赖这两个默认放行。
 */
const SECURITY_HEADERS = [
  // 播放页不允许被别站套 iframe（clickjacking）；同源嵌入不受影响
  { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // 跨站请求只带 origin，别让采集站 / 图床从 Referer 反查到完整播放地址
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), usb=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
];

const nextConfig: NextConfig = {
  // standalone 输出仅供 Docker 镜像构建使用（DOCKER_BUILD=1）；
  // 本地 next start 在 standalone 模式下不受支持，故按环境切换
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  // 不对外暴露框架指纹
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  env: {
    APP_VERSION: readAppVersion(),
    // Vercel 构建时提供；页脚显示短哈希，方便确认线上跑的是哪次提交
    NEXT_PUBLIC_APP_COMMIT: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7),
  },
  // 采集站/豆瓣等上游地址在运行时由用户配置，构建期无法枚举，关闭图片优化改用 <img>
  images: { unoptimized: true },
};

export default nextConfig;
