/**
 * 把客户端 chunk 的语法降到 Chrome 83，让旧电视的系统 WebView（Android 11 出厂版本）也能运行。
 *
 * 只靠 browserslist + transpilePackages 降不下来：依赖里的私有方法（`#x()`，Chrome 84 才支持）
 * 仍会留在产物里，整个 chunk 报 SyntaxError，页面落到 global-error。所以在 next build 之后
 * 再转一遍。这里只改语法，不补运行时 API。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';

const TARGET = 'chrome83';
const ROOT = path.join('.next', 'static', 'chunks');
const PRIVATE_METHOD = /[\s{};]#[A-Za-z_$][\w$]*\(/;

function listJs(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return listJs(file);
    return file.endsWith('.js') ? [file] : [];
  });
}

const files = listJs(ROOT);
let left = 0;
for (const file of files) {
  const { code } = await transform(readFileSync(file, 'utf8'), {
    target: TARGET,
    minify: true,
    legalComments: 'none',
  });
  writeFileSync(file, code);
  if (PRIVATE_METHOD.test(code)) left += 1;
}

// 没降干净就让构建失败，不要把会白屏的产物部署出去
if (left > 0) {
  console.error(`lower-client-syntax: ${left} 个 chunk 仍含私有方法`);
  process.exit(1);
}
console.log(`lower-client-syntax: ${files.length} 个 chunk 已降到 ${TARGET}`);
