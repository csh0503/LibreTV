/**
 * 伺服器启动时跑一次（Next.js instrumentation）。Edge 也会编译这个文件，
 * 所以只在 nodejs 分支里 import（webpack 按 NEXT_RUNTIME 把另一支整个去掉，Edge 不会去解析 fs / sqlite）。
 * 具体做什么见 instrumentation-node.ts。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
