/**
 * 设计文档解析器(纯函数,无副作用)
 *
 * 被两处共用:
 *   1. `docs/check-design-consistency.mjs` —— 校验两份文档彼此一致(E1–E13)
 *   2. `tests/platform/design-conformance.test.ts` —— 校验**代码常量**与文档一致
 *
 * 抽出共用是为了让「设计文档是唯一真相源」这条纪律有单一实现。第二处尤其重要:
 * 它把「代码有没有偏离设计」变成一次测试失败,而不是靠人记得同步。
 *
 * 所有函数接收 markdown 文本、返回纯数据,不读文件、不抛异常(解析不到返回 null)。
 */

/** 按行号定位偏移量,供报错时给 file:line */
export function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** 设计 1:能力闭合联合 `export type Capability = ...` */
export function parseCapabilityUnion(md) {
  const m = md.match(/export type Capability =([\s\S]*?)\n```/);
  if (!m) return null;
  const caps = new Map();
  for (const line of m[1].split("\n")) {
    const hit = line.match(/"([a-z_]+(?:\.[a-z_]+)+)"/);
    if (hit) caps.set(hit[1], null);
  }
  return caps;
}

/** 设计 1:能力 → 工具展开表 */
export function parseToolTable(md) {
  const m = md.match(/\| Capability \| 工具名 \| 参数 \| 返回 \|\n\|[-\s|]+\|\n([\s\S]*?)\n\n/);
  if (!m) return null;
  const map = new Map();
  for (const line of m[1].split("\n")) {
    if (!line.startsWith("|")) continue;
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    const cap = (cols[0].match(/`([a-z_]+(?:\.[a-z_]+)+)`/) || [])[1];
    if (!cap) continue;
    map.set(cap, [...cols[1].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]));
  }
  return map;
}

/** 设计 2:Capability × 角色 总矩阵 */
export function parseMatrix(md) {
  const m = md.match(/## 7\. Capability × 角色 总矩阵\n\n(\|[\s\S]*?)\n\n\*\*/);
  if (!m) return null;
  const rows = m[1].split("\n").filter((l) => l.trim().startsWith("|"));
  const header = rows[0].split("|").slice(1, -1).map((c) => c.trim());
  const roles = header.slice(1);
  const granted = new Map(roles.map((r) => [r, new Set()]));
  for (const line of rows.slice(2)) {
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    const caps = [...(cols[0] || "").matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)].map((x) => x[1]);
    if (!caps.length) continue;
    roles.forEach((role, i) => {
      if ((cols[i + 1] || "").includes("✅")) for (const c of caps) granted.get(role).add(c);
    });
  }
  return { roles, granted };
}

/** 设计 2:各角色的出厂工具集合 JSON(键为标题里的显示名,与矩阵表头一致) */
export function parseFactorySets(md) {
  const out = [];
  const heads = [...md.matchAll(/^## \d+\.\s+(\S+)\s+`([a-z_]+)`/gm)];
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)];
  for (const h of heads) {
    const after = blocks.find((b) => b.index > h.index);
    if (!after) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(after[1]);
    } catch {
      out.push({ role: h[1], code: h[2], parseError: true, allow: new Set(), deny: new Set() });
      continue;
    }
    out.push({
      role: h[1],
      code: h[2],
      parseError: false,
      allow: new Set(parsed.allow ?? []),
      deny: new Set(parsed.deny ?? []),
    });
  }
  return out;
}

/** 设计 1:ArtifactKind 闭合联合 */
export function parseArtifactKinds(md) {
  const m = md.match(/export type ArtifactKind =([\s\S]*?)\n```/);
  if (!m) return null;
  return new Set([...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
}

/** 设计 1 §6.2:由协议工具自动创建、模型不能手写的 kind */
export function parseProtocolKinds(md) {
  const m = md.match(/\*\*协议工具自动创建\*\* \|([^|]*)\|/);
  if (!m) return null;
  // 单元格形态:`kind`(`tool` 副产物) · `kind`(`tool` 副产物) …
  // 每个 · 分段只取**第一个**反引号 token —— 拿全部会把 tool 名也当成 kind
  const kinds = new Set();
  for (const seg of m[1].split("·")) {
    const hit = seg.match(/`([a-z_]+)`/);
    if (hit) kinds.add(hit[1]);
  }
  return kinds;
}

/** 设计 2 §8:writeKinds 汇总表 */
export function parseWriteKinds(md) {
  const m = md.match(/## 8\. 写面权限\(writeKinds\)\n\n(\|[\s\S]*?)\n\n/);
  if (!m) return null;
  const map = new Map();
  for (const line of m[1].split("\n")) {
    if (!line.startsWith("|")) continue;
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!cols[0] || cols[0] === "角色" || /^-+$/.test(cols[0])) continue;
    map.set(cols[0], new Set([...(cols[1] || "").matchAll(/`([a-z_]+)`/g)].map((x) => x[1])));
  }
  return map;
}

/** 设计 2:各角色 Capability Ceiling 段(兼容表格式与行内列表式) */
export function parseCeilings(md) {
  const out = new Map();
  const secs = [...md.matchAll(/^## \d+\.\s+(\S+)\s+`([a-z_]+)`/gm)];
  for (let i = 0; i < secs.length; i++) {
    const start = secs[i].index;
    const end = i + 1 < secs.length ? secs[i + 1].index : md.length;
    const body = md.slice(start, end);
    const cm = body.match(/### [\d.]+ Capability Ceiling\n([\s\S]*?)(?=\n### |\n## |$)/);
    if (!cm) continue;
    let block = cm[1];
    // 只取规范列表本身:遇到引用块(说明文字)或 writeKinds 就截断
    const cut = block.search(/^\s*(?:>|\*\*writeKinds\*\*)/m);
    if (cut >= 0) block = block.slice(0, cut);
    const caps = new Set([...block.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)].map((x) => x[1]));
    if (caps.size) out.set(secs[i][1], caps);
  }
  return out;
}

/** 设计 2:各角色段内的 `**writeKinds**:[...]` 内联声明 */
export function parseInlineWriteKinds(md) {
  const out = new Map();
  const secs = [...md.matchAll(/^## \d+\.\s+(\S+)\s+`([a-z_]+)`/gm)];
  for (let i = 0; i < secs.length; i++) {
    const start = secs[i].index;
    const end = i + 1 < secs.length ? secs[i + 1].index : md.length;
    const body = md.slice(start, end);
    const m = body.match(/\*\*writeKinds\*\*:`\[([^\]]*)\]`/);
    if (!m) continue;
    out.set(secs[i][1], new Set([...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1])));
  }
  return out;
}

export function parsePromptUnits(md) {
  const out = new Map();
  const secs = [...md.matchAll(/^## \d+\.\s+(\S+)\s+`([a-z_]+)`/gm)];
  for (let i = 0; i < secs.length; i++) {
    const start = secs[i].index;
    const end = i + 1 < secs.length ? secs[i + 1].index : md.length;
    const body = md.slice(start, end);
    const cm = body.match(/### [\d.]+ 提示词单元\n([\s\S]*?)(?=\n### |\n## |$)/);
    if (!cm) continue;
    const ids = new Set(
      [...cm[1].matchAll(/^\|\s*`([a-z_]+(?:\.[a-z_]+)+)`/gm)].map((x) => x[1]),
    );
    if (ids.size) out.set(secs[i][1], ids);
  }
  return out;
}

/** 文档里声称的计数(用于 E11 与 conformance 断言) */
export function parseClaimedCounts(md) {
  const pair = md.match(/\*\*(\d+) 条 capability 展开成 (\d+) 个工具。\*\*/);
  const caps = md.match(/\*\*共 (\d+) 条 capability。\*\*/);
  return {
    capabilities: pair ? Number(pair[1]) : null,
    tools: pair ? Number(pair[2]) : null,
    matrixCapabilities: caps ? Number(caps[1]) : null,
  };
}
