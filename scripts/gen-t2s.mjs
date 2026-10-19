// 生成 src/lib/t2s-chars.ts：繁体（台湾 / 香港写法）→ 简体的单字对照表。
// 片名比较只需要逐字转换（不需要词组转换），所以把 opencc 的结果按单字收下来，前端也能用（几 KB）。
// 用法：node scripts/gen-t2s.mjs
import { Converter } from 'opencc-js';
import fs from 'node:fs';

const converters = [Converter({ from: 'tw', to: 'cn' }), Converter({ from: 'hk', to: 'cn' }), Converter({ from: 't', to: 'cn' })];
const pairs = new Map();
const ranges = [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]];
for (const [lo, hi] of ranges) {
  for (let cp = lo; cp <= hi; cp++) {
    const ch = String.fromCodePoint(cp);
    for (const c of converters) {
      const out = c(ch);
      if (out !== ch && [...out].length === 1) {
        if (!pairs.has(ch)) pairs.set(ch, out);
        break;
      }
    }
  }
}
const from = [...pairs.keys()].join('');
const to = [...pairs.values()].join('');
const src = `// 由 scripts/gen-t2s.mjs 生成，不要手改。繁体（台湾 / 香港）→ 简体的单字对照，共 ${pairs.size} 字。
export const T2S_FROM = ${JSON.stringify(from)};
export const T2S_TO = ${JSON.stringify(to)};
`;
fs.writeFileSync(new URL('../src/lib/t2s-chars.ts', import.meta.url), src);
console.log('pairs', pairs.size, 'bytes', Buffer.byteLength(src));
