import type { Config } from 'tailwindcss';

/**
 * 语义化颜色 token：全部通过 CSS 变量驱动，支持亮暗主题切换。
 * 具体色值只在 globals.css 的 :root / .dark 里定义（2026-10-19 起是莫兰迪色系：
 * 暗色暖炭灰 #151413 / 燕麦白字，亮色米灰 #f3f0eb / 深灰褐字，主色雾霾蓝）。
 * 这里只负责把变量接到 Tailwind 上，改颜色请改 globals.css。
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        page: 'rgb(var(--c-page) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',
          raised: 'rgb(var(--c-surface-raised) / <alpha-value>)',
        },
        card: 'rgb(var(--c-card) / <alpha-value>)',
        chip: 'rgb(var(--c-chip) / <alpha-value>)',
        hover: 'rgb(var(--c-hover) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        content: 'rgb(var(--c-content) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        faint: 'rgb(var(--c-faint) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          hover: 'rgb(var(--c-accent-hover) / <alpha-value>)',
        },
        // 语义状态色：随亮/暗主题切换，替代直接使用 red/green/amber 等调色板
        danger: {
          DEFAULT: 'rgb(var(--c-danger) / <alpha-value>)',
          hover: 'rgb(var(--c-danger-hover) / <alpha-value>)',
        },
        success: 'rgb(var(--c-success) / <alpha-value>)',
        warning: 'rgb(var(--c-warning) / <alpha-value>)',
        info: 'rgb(var(--c-info) / <alpha-value>)',
        rating: 'rgb(var(--c-rating) / <alpha-value>)',
        // accent 实心底上的文字色：亮色=白、暗色=深（霓虹蓝底对白字对比度不足）
        'on-accent': 'rgb(var(--c-on-accent) / <alpha-value>)',
        // 实心状态底色（配白字），比语义色更深一档保证对比度
        'danger-solid': 'rgb(var(--c-danger-solid) / <alpha-value>)',
        'success-solid': 'rgb(var(--c-success-solid) / <alpha-value>)',
        'warning-solid': 'rgb(var(--c-warning-solid) / <alpha-value>)',
        'info-solid': 'rgb(var(--c-info-solid) / <alpha-value>)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.25s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
