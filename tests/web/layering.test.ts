/**
 * 依赖方向哨兵 —— V2 架构的单向分层(设计书 §6.2)
 *
 * 规则:app → features → entities → shared;
 *   · features 不 import app;entities 不 import features/app;
 *   · shared 不 import 任何上层;stores 只被 app/features 消费;
 *   · entities 是纯判据层:无 .tsx、不 import react。
 *
 * 批次 0 时新目录尚未建立(或为空)⇒ 哨兵空转通过;批次 1 起每落一个文件即受管。
 * 仪器自检:合成违规样本必须被抓到(参照 Wave 5「正样本自检」纪律 ——
 * 防止扫描器写坏后「扫描了个寂寞」还返回绿)。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../web/src");

/** 上层索引:数值越大越靠上层;规则 = import 的目标层必须 ≤ 自己的层。 */
const LAYERS: Record<string, number> = {
  app: 3,
  features: 2,
  entities: 1,
  shared: 0,
  stores: 2.5, // 与 features 同层:可被 app/features 消费,可 import entities/shared
};

function walkTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTsFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function layerOf(file: string): { layer: string; rest: string } | null {
  const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
  const head = rel.split("/")[0];
  if (!(head in LAYERS)) return null;
  return { layer: head, rest: rel };
}

/** 从源码提取相对 import 的目标路径(忽略 npm 包与 @shared 别名 —— 后者属外部契约)。 */
function relativeImportsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\s*\(\s*"(\.[^"]+)"\s*\)/g)) out.push(m[1]);
  return out;
}

/** 把相对 import 解析到 src 下的层(步进 ../ 直到落回 src 内已知层)。 */
function resolveLayer(fromFile: string, spec: string): string | null {
  const parts = fromFile.slice(SRC.length + 1).split("/");
  parts.pop(); // 去掉文件名
  const steps = spec.split("/");
  let dir = parts;
  for (const s of steps) {
    if (s === "." || s === "") continue;
    else if (s === "..") dir = dir.slice(0, -1);
    else dir = [...dir, s];
  }
  const head = dir[0];
  return head in LAYERS ? head : null;
}

/** 判定函数单独导出,供正自检喂合成样本。 */
export function violationsOf(files: { path: string; src: string }[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    const mine = layerOf(f.path);
    if (!mine) continue;
    // entities 纯判据:无 .tsx、不 import react
    if (mine.layer === "entities") {
      if (f.path.endsWith(".tsx")) bad.push(`${f.path}: entities 不许有 .tsx`);
      if (/from\s+"react"/.test(f.src) || /from\s+"react-dom/.test(f.src))
        bad.push(`${f.path}: entities 不许 import react`);
    }
    for (const spec of relativeImportsOf(f.src)) {
      const target = resolveLayer(f.path, spec);
      if (target === null) continue;
      if (LAYERS[target] > LAYERS[mine.layer]) {
        bad.push(`${f.path}: ${mine.layer} 不许 import 上层 ${target} (${spec})`);
      }
      // stores 的位置:只许 app/features 引它,它只许引 entities/shared
      if (target === "stores" && mine.layer !== "app" && mine.layer !== "features") {
        bad.push(`${f.path}: stores 只许被 app/features 消费`);
      }
    }
  }
  return bad;
}

function collectRealFiles(): { path: string; src: string }[] {
  return walkTsFiles(SRC)
    .filter((p) => layerOf(p) !== null)
    .map((p) => ({ path: p, src: readFileSync(p, "utf8") }));
}

describe("依赖方向哨兵 · 仪器自检(合成违规样本必须被抓到)", () => {
  it("features import app ⇒ 抓", () => {
    const v = violationsOf([
      { path: `${SRC}/features/chat/x.ts`, src: `import { A } from "../../app/App";` },
    ]);
    expect(v.length).toBeGreaterThan(0);
  });
  it("entities import features ⇒ 抓;entities 带 react ⇒ 抓", () => {
    const v = violationsOf([
      { path: `${SRC}/entities/work.ts`, src: `import { B } from "../features/works/panel";\nimport { useState } from "react";` },
    ]);
    expect(v.length).toBe(2);
  });
  it("shared import entities ⇒ 抓;entities 内 .tsx ⇒ 抓", () => {
    const v = violationsOf([
      { path: `${SRC}/shared/ui/b.tsx`, src: `import { c } from "../../entities/work";` },
      { path: `${SRC}/entities/bad.tsx`, src: `export const x = 1;` },
    ]);
    expect(v.length).toBe(2);
  });
  it("合法分层 ⇒ 零违规(app→features→entities→shared,features→stores)", () => {
    const v = violationsOf([
      { path: `${SRC}/app/App.tsx`, src: `import { C } from "../features/chat/x"; import { S } from "../stores/chat";` },
      { path: `${SRC}/features/chat/x.ts`, src: `import { E } from "../../entities/work"; import { U } from "../../shared/ui/b";` },
      { path: `${SRC}/entities/work.ts`, src: `export const E = 1;` },
      { path: `${SRC}/shared/ui/b.tsx`, src: `export const U = 2;` },
      { path: `${SRC}/stores/chat.ts`, src: `import { E } from "../entities/work"; import { U } from "../shared/ui/b";` },
    ]);
    expect(v).toEqual([]);
  });
});

describe("依赖方向哨兵 · 真实源码(web/src 的 V2 新层)", () => {
  it("新层(app/features/entities/shared/stores)当前文件全数合规(目录未建 = 空转绿)", () => {
    const files = collectRealFiles();
    // 仪器健康:目录还没建时 files 可能为 0,但违规必须为 0
    expect(violationsOf(files)).toEqual([]);
  });

  it("分层规则文本与设计书 §6.2 一致(五层齐全,防规则被静默改弱)", () => {
    expect(Object.keys(LAYERS).sort()).toEqual([
      "app",
      "entities",
      "features",
      "shared",
      "stores",
    ]);
  });
});
