// 扫「手写红壳」:className 是那五种壳之一(或其变体),且同一元素上出现 var(--cinnabar。
import fs from "node:fs";
import path from "node:path";

const SHELL_CLASSES = ["ss-note", "ss-meta", "ss-empty", "sansheng-card p-3 text-xs", "p-2 text-xs"];

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk("web/src").filter((p) => !p.endsWith("ui/primitives.tsx"));
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const sh of SHELL_CLASSES) {
    const re = new RegExp(`className="${sh}[^"]*"[^>]*var\\(--cinnabar`, "g");
    const hits = src.match(re);
    if (hits) console.log(`${f} × ${sh} × ${hits.length}`);
  }
}
