#!/usr/bin/env node
/**
 * Sansheng 设计文档一致性校验 · docs/check-design-consistency.mjs
 *
 * 为什么存在:设计 1 的能力联合、工具展开表、设计 2 的角色矩阵与四份出厂工具
 * JSON 是**手工维护的同一份事实的四种写法**。2026-10-03 首版就漏了 8 条能力,
 * 其中 `collab.meeting.respond` / `collab.meeting.conclude` 被正文引用却没有
 * 定义 —— 意味着会议发起后永远无法表态、无法收尾。靠眼睛看不住,所以做成脚本。
 *
 * 校验项:
 *   E1  能力联合 ↔ 工具展开表      双向闭合
 *   E2  能力联合 ↔ 角色矩阵        双向闭合
 *   E3  无孤儿能力                 每条能力至少一个角色持有
 *   E4  工具名唯一                 一个工具名不能挂到两条能力下
 *   E5  矩阵 ↔ 出厂 JSON           按矩阵推导工具集,与 allow 逐项比对
 *   E6  deny 自洽                  deny 与 allow 不能有交集
 *   E7  deny 里的工具必须存在      不能 deny 一个不存在的工具
 *   E8  writeKinds 必须是合法 kind
 *   E9  协议创建的 kind 不得进 writeKinds(decision 为文档化例外)
 *   E10 正文引用的能力名必须已定义(命名空间内为 E,命名空间外为 W)
 *   E11 文档声称的计数与实际一致
 *   E12 各角色 Capability Ceiling 行 ↔ 角色矩阵
 *   E13 各角色内联 writeKinds ↔ §8 汇总表
 *   E14 跨文档章节引用必须指得着(不许引用不存在的 §N / #N)
 *
 * 用法:node docs/check-design-consistency.mjs
 * 退出码:0 全部通过;1 存在错误
 */
import { readFileSync } from "node:fs";
import {
  parseCapabilityUnion, parseToolTable, parseMatrix, parseFactorySets,
  parseArtifactKinds, parseProtocolKinds, parseWriteKinds,
  parseCeilings, parseInlineWriteKinds, parseClaimedCounts,
} from "./design-parse.mjs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 可选位置参数,便于对副本做反向测试:node check-design-consistency.mjs [设计1.md] [设计2.md]
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const P1_PATH = args[0] ? args[0] : join(HERE, "DESIGN-PLATFORM.md");
const P2_PATH = args[1] ? args[1] : join(HERE, "DESIGN-AGENTS.md");
// 其余也要被扫的文档(它们是**引用源**,但不是 `设计 N` 引用目标)
const OTHER_DOCS = ["ADR-001-harness-wiring.md"].map((f) => join(HERE, f));

const errors = [];
const warnings = [];
const E = (code, msg) => errors.push({ code, msg });
const W = (msg) => warnings.push(msg);

// ── 读取 ─────────────────────────────────────────────────────────
let p1, p2;
try {
  p1 = readFileSync(P1_PATH, "utf8");
  p2 = readFileSync(P2_PATH, "utf8");
} catch (e) {
  console.error(`无法读取设计文档:${e.message}`);
  process.exit(1);
}

// ── 解析(实现在 docs/design-parse.mjs,与 conformance 测试共用)──
const caps = parseCapabilityUnion(p1);
const toolTable = parseToolTable(p1);
const matrix = parseMatrix(p2);
const factory = parseFactorySets(p2);
const artifactKinds = parseArtifactKinds(p1);
const protocolKinds = parseProtocolKinds(p1);
const writeKinds = parseWriteKinds(p2);

for (const [name, v] of Object.entries({ caps, toolTable, matrix, artifactKinds, protocolKinds, writeKinds })) {
  if (!v || (v instanceof Map && v.size === 0)) {
    console.error(`解析失败:${name} —— 文档结构可能被改动,请检查标题/表头是否仍匹配`);
    process.exit(1);
  }
}

// ── E1 联合 ↔ 工具表 ─────────────────────────────────────────────
for (const c of caps.keys()) if (!toolTable.has(c)) E("E1", `能力 \`${c}\` 在联合里定义了,但工具展开表没有对应行`);
for (const c of toolTable.keys()) if (!caps.has(c)) E("E1", `工具展开表有 \`${c}\`,但能力联合里没有定义`);

// ── E2 联合 ↔ 矩阵 ───────────────────────────────────────────────
const allGranted = new Set();
for (const s of matrix.granted.values()) for (const c of s) allGranted.add(c);
for (const c of caps.keys()) if (!allGranted.has(c)) E("E2", `能力 \`${c}\` 未出现在角色矩阵中`);
for (const c of allGranted) if (!caps.has(c)) E("E2", `角色矩阵引用了未定义的能力 \`${c}\``);

// ── E3 无孤儿能力 ────────────────────────────────────────────────
for (const c of caps.keys()) if (!allGranted.has(c)) E("E3", `能力 \`${c}\` 没有任何角色持有(孤儿能力)`);

// ── E4 工具名唯一 ────────────────────────────────────────────────
const toolOwner = new Map();
for (const [cap, tools] of toolTable) {
  for (const t of tools) {
    if (toolOwner.has(t)) E("E4", `工具名 \`${t}\` 同时挂在 \`${toolOwner.get(t)}\` 与 \`${cap}\` 下,展开会有歧义`);
    else toolOwner.set(t, cap);
  }
}
const allTools = new Set(toolOwner.keys());

// ── E5/E6/E7 矩阵 ↔ 出厂集合 ─────────────────────────────────────
for (const { role, allow, deny } of factory) {
  const granted = matrix.granted.get(role);
  if (!granted) {
    E("E5", `出厂集合里的角色 \`${role}\` 在矩阵表头里找不到`);
    continue;
  }
  const expected = new Set();
  for (const c of granted) for (const t of toolTable.get(c) ?? []) expected.add(t);

  for (const t of allow) if (!expected.has(t)) E("E5", `${role}:allow 有 \`${t}\`,但矩阵没给该角色能展开出这个工具的能力`);
  for (const t of expected) if (!allow.has(t)) E("E5", `${role}:矩阵给了能展开出 \`${t}\` 的能力,但 allow 里漏了`);

  for (const t of deny) {
    if (allow.has(t)) E("E6", `${role}:\`${t}\` 同时出现在 allow 与 deny 里,自相矛盾`);
    if (!allTools.has(t)) E("E7", `${role}:deny 里的 \`${t}\` 不是任何已定义工具(拼写错误?)`);
  }
}

// ── E8/E9 writeKinds 语义 ───────────────────────────────────────
// 两个来源都要查:§8 汇总表与各角色段内的内联声明。只查一个的话,
// 往另一个里塞协议 kind 就漏过去了。
const WRITEKIND_EXCEPTION = new Set(["decision"]); // 文档化例外:问答流程与手写两可
function checkKindSemantics(role, kinds, source) {
  for (const k of kinds) {
    if (!artifactKinds.has(k)) E("E8", `${role} 的 writeKinds(${source})含未定义 kind \`${k}\``);
    if (protocolKinds.has(k) && !WRITEKIND_EXCEPTION.has(k)) {
      E("E9", `${role} 的 writeKinds(${source})含 \`${k}\`,但它是协议工具的必然产物,不应由模型手写`);
    }
  }
}
for (const [role, kinds] of writeKinds) checkKindSemantics(role, kinds, "§8 汇总表");

// ── E10 正文引用的能力名 ─────────────────────────────────────────
// 判据(高信号、低噪音):
//   ① 命名空间内但不是已定义能力          → 错误(命名空间拼错)
//   ② 是某条已定义能力的「去掉命名空间后的后缀」→ 错误(漏了 collab. 这类前缀)
//      例:`meeting.respond` 命中 `collab.meeting.respond` —— 这正是 2026-10-03
//      首版漏掉两个会议动词时的写法
//   ③ 其余点号 token 视为代码/提示词单元表达式,不报(可用 --verbose 列出审计)
const namespaces = new Set([...caps.keys()].map((c) => c.split(".")[0]));
const FILE_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|html|css|ya?ml|sh|txt|log)$/;
const suppressed = new Set();
const seen = new Set();
for (const md of [p1, p2]) {
  for (const line of md.split("\n")) {
    for (const tok of [...line.matchAll(/`([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+)`/g)].map((x) => x[1])) {
      if (caps.has(tok) || FILE_EXT.test(tok) || seen.has(tok)) continue;
      seen.add(tok);
      if (namespaces.has(tok.split(".")[0])) {
        E("E10", `正文引用了 \`${tok}\` —— 命名空间对得上,但联合里没有这条能力`);
        continue;
      }
      const missingPrefix = [...caps.keys()].find((c) => c.endsWith(`.${tok}`));
      if (missingPrefix) {
        E("E10", `正文引用了 \`${tok}\`,看起来是漏了命名空间的 \`${missingPrefix}\``);
        continue;
      }
      suppressed.add(tok);
    }
  }
}

const inlineWK = parseInlineWriteKinds(p2);
if (inlineWK.size !== writeKinds.size) {
  E("E13", `解析到 ${inlineWK.size} 个内联 writeKinds,§8 汇总表有 ${writeKinds.size} 个角色`);
}
for (const [role, kinds] of inlineWK) checkKindSemantics(role, kinds, "内联声明");
for (const [role, kinds] of inlineWK) {
  const summary = writeKinds.get(role);
  if (!summary) {
    E("E13", `内联 writeKinds 的角色 \`${role}\` 在 §8 汇总表里找不到`);
    continue;
  }
  for (const k of kinds) if (!summary.has(k)) E("E13", `${role}:内联 writeKinds 有 \`${k}\`,§8 汇总表没有`);
  for (const k of summary) if (!kinds.has(k)) E("E13", `${role}:§8 汇总表有 \`${k}\`,内联 writeKinds 漏了`);
}

const ceilings = parseCeilings(p2);
if (ceilings.size !== matrix.roles.length) {
  E("E12", `解析到 ${ceilings.size} 个角色的 Ceiling 段,矩阵有 ${matrix.roles.length} 个角色`);
}
for (const [role, capsInCeiling] of ceilings) {
  const granted = matrix.granted.get(role);
  if (!granted) {
    E("E12", `Ceiling 段里的角色 \`${role}\` 在矩阵表头里找不到`);
    continue;
  }
  for (const c of capsInCeiling) if (!granted.has(c)) E("E12", `${role}:Ceiling 写了 \`${c}\`,但矩阵没给这个角色`);
  for (const c of granted) if (!capsInCeiling.has(c)) E("E12", `${role}:矩阵给了 \`${c}\`,但 Ceiling 行漏了`);
}

// ── E11 声称的计数 ───────────────────────────────────────────────
const claimedPair = p1.match(/\*\*(\d+) 条 capability 展开成 (\d+) 个工具。\*\*/);
if (claimedPair) {
  if (+claimedPair[1] !== caps.size) E("E11", `设计 1 声称 ${claimedPair[1]} 条 capability,实际 ${caps.size}`);
  if (+claimedPair[2] !== allTools.size) E("E11", `设计 1 声称 ${claimedPair[2]} 个工具,实际 ${allTools.size}`);
} else {
  W("设计 1 里没找到「N 条 capability 展开成 M 个工具」的计数声明,跳过 E11 的一半");
}
const claimedCaps = p2.match(/\*\*共 (\d+) 条 capability。\*\*/);
if (claimedCaps && +claimedCaps[1] !== caps.size) {
  E("E11", `设计 2 声称共 ${claimedCaps[1]} 条 capability,实际 ${caps.size}`);
}

// ── E14 跨文档章节引用 ───────────────────────────────────────────
//
// 起因:ADR-001 §5.3 写着「设计 1 §12 的未决问题 #3(「周期对焦的触发方式」)」,
// 而「周期对焦」在设计 2 §11 #3,设计 1 §12 #3 讲的是横向沟通留痕密度 ——
// 引错了文档,而且那个 #3 在那时根本不存在。
//
// 这正是本项目最在意的那类缺陷的**文档版**:声称有、实际没有。它在评审时
// 极难被发现(读的人会以为对方查过),所以必须有机器防线。
//
// **第一版只做了结构校验,抓不到它** —— 因为「设计 1 §12」确实存在。编号对、
// 标题错,结构检查无能为力。所以加了第四条:
//
//   E14a 「设计 N §M」的节必须存在
//   E14b 「§M #K」的编号必须在 §M 的编号列表里
//   E14c 「#K「标题」」的标题必须真的出现在第 K 条的正文里   ← 这条才抓得住
//   E14d 带 #K 的引用**必须**带标题,否则 E14c 无从校验(报错,不是警告)
//
// 引用格式约定:`设计 1 §12 #3「横向沟通留痕密度」`
{
  // 引用**目标**(`设计 N` 能指向的文档)
  const DOCS = {
    "设计 1": { path: P1_PATH, text: p1 },
    "设计 2": { path: P2_PATH, text: p2 },
  };
  // 引用**源**(所有含引用的文档,含 ADR)
  //
  // 第一版只扫了 DOCS,于是 ADR 里的引用**从来没被检查过** —— 反向验证时
  // 四次注入全部静默通过,才发现的。**守卫漏掉一个源,等于那些引用没有守卫。**
  const SOURCES = [
    ...Object.entries(DOCS),
    ...OTHER_DOCS.map((path) => {
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return null;
      }
      return [basename(path), { path, text }];
    }).filter(Boolean),
  ];

  /** 取一个文档里所有 `## N` / `### N.M` 的节号。 */
  function sectionsOf(text) {
    const out = new Set();
    for (const m of text.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)*)[.\s]/gm)) out.add(m[1]);
    return out;
  }

  /**
   * 取某节下编号列表的编号 → 该条正文(到下一个编号条为止)。
   * 支持 `1. xxx`,也支持 `**1. xxx**`。
   */
  function itemsUnder(text, secNo) {
    const lines = text.split("\n");
    const head = new RegExp(`^#{2,4}\\s+${secNo.replace(/\./g, "\\.")}[.\\s]`);
    const start = lines.findIndex((l) => head.test(l));
    if (start < 0) return null;

    const items = new Map();
    let cur = null;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      // 下一节开始 → 停。**判据是「任何 `##` 标题」,不只是「带编号的标题」** ——
      // 2026-10-07 实测的坑:文档末尾追加了一节**无编号**的 `## 质检返工与兜底`
      // (新专题,不占 §编号),而旧判据只被编号标题终止、又把无编号子标题「穿过」
      // ⇒ 那一节里的 `1.` `2.` `3.` 被当成了 **§12 的第 1/2/3 条**,报出
      // 「编号对但标题对不上」——**错的是仪器,不是文档**(已用注入样本自检:
      // 真引错时它照样报)。
      // 现在:`##`(任意)终止;`###` 及更深的无编号子标题仍然穿过
      // (§2.11 那种「### 已决 / ### 仍未决」的写法要保留)。
      if (/^##\s/.test(l)) break;
      if (/^#{3,4}\s+\d/.test(l)) break;
      if (/^#{3,4}\s/.test(l)) continue;
      const m = l.match(/^\s*(?:\*\*)?(\d+)\.\s*(.*)$/);
      if (m) {
        cur = m[1];
        items.set(cur, m[2]);
      } else if (cur !== null) {
        items.set(cur, items.get(cur) + "\n" + l);
      }
    }
    return items;
  }

  const secCache = new Map();
  for (const [label, d] of Object.entries(DOCS)) secCache.set(label, sectionsOf(d.text));

  // 引用形态:「(设计 N|本设计) §M [任意少量连接词] [(#K) [「标题」]]」
  const REF = /(设计 [12]|本设计)\s*§\s*(\d+(?:\.\d+)*)(?:[^\n。;]{0,12}?#\s*(\d+)\s*(?:[「『]([^」』]{2,40})[」』])?)?/g;

  let refCount = 0;
  let titledRefs = 0;

  for (const [srcLabel, d] of SOURCES) {
    REF.lastIndex = 0;
    for (const m of d.text.matchAll(REF)) {
      refCount++;
      // 「本设计」只在源是设计文档时有意义;从 ADR 里写「本设计」指代不明,跳过
      if (m[1] === "本设计" && !(srcLabel in DOCS)) continue;
      const targetLabel = m[1] === "本设计" ? srcLabel : m[1];
      const secNo = m[2];
      const itemNo = m[3];
      const title = m[4];
      const target = DOCS[targetLabel];
      if (!target) continue;

      // E14a 节必须存在
      if (!secCache.get(targetLabel).has(secNo)) {
        E("E14", `${srcLabel} 引用了「${targetLabel} §${secNo}」,但该文档里没有这一节`);
        continue;
      }
      if (itemNo === undefined) continue;

      // E14b 编号必须存在
      const items = itemsUnder(target.text, secNo);
      if (items === null || items.size === 0) {
        E("E14", `${srcLabel} 引用了「${targetLabel} §${secNo} #${itemNo}」,但该节里没有编号列表`);
        continue;
      }
      if (!items.has(itemNo)) {
        E("E14",
          `${srcLabel} 引用了「${targetLabel} §${secNo} #${itemNo}」,` +
          `但 §${secNo} 的编号只有 ${[...items.keys()].sort((a, b) => +a - +b).join(", ")}`);
        continue;
      }

      // E14d 带 #K 就必须带标题 —— 否则 E14c 无从校验,引用等于没被检查
      if (title === undefined) {
        E("E14",
          `${srcLabel} 的引用「${targetLabel} §${secNo} #${itemNo}」没带标题。` +
          `请写成「§${secNo} #${itemNo}「该条标题」」—— 不带标题的引用无法校验,` +
          `正是这类引用引错了文档还没人发现`);
        continue;
      }

      // E14c 标题必须真的出现在第 K 条正文里
      titledRefs++;
      const body = items.get(itemNo);
      const norm = (t) => t.replace(/[\s*`_()（）「」『』,、。:;:;]/g, "");
      if (!norm(body).includes(norm(title))) {
        E("E14",
          `${srcLabel} 引用了「${targetLabel} §${secNo} #${itemNo}「${title}」」,` +
          `但第 ${itemNo} 条实际讲的是「${body.trim().slice(0, 40)}…」—— 编号对但标题对不上,` +
          `通常意味着引错了文档`);
      }
    }
  }

  if (refCount === 0) W("E14:一条跨文档章节引用都没扫到,这条检查可能是空转");
  else if (titledRefs === 0) W("E14:扫到引用但一条带标题的都没有,E14c 没被真正执行过");
}

// ── 报告 ─────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

console.log(`\nSansheng 设计一致性校验`);
console.log(D(`  设计 1  ${P1_PATH}`));
console.log(D(`  设计 2  ${P2_PATH}\n`));
console.log(`  能力 ${caps.size} · 工具 ${allTools.size} · 角色 ${matrix.roles.length} · 出厂集合 ${factory.length}`);
console.log(
  `  联合↔工具表 ${caps.size === toolTable.size ? G("✅") : R("❌")}` +
  `   联合↔矩阵 ${caps.size === allGranted.size ? G("✅") : R("❌")}` +
  `   writeKinds ${[...writeKinds.values()].reduce((a, s) => a + s.size, 0)} 项\n`,
);

if (warnings.length) {
  console.log(Y(`⚠  ${warnings.length} 条警告`));
  for (const w of warnings) console.log(`   ${w}`);
  console.log();
}

if (process.argv.includes("--verbose")) {
  console.log(D(`ℹ  已按「代码/提示词单元表达式」放行的点号 token(${suppressed.size} 个,仅供审计):`));
  console.log(D(`   ${[...suppressed].sort().join("  ")}\n`));
}

if (errors.length) {
  console.log(R(`✖ ${errors.length} 个错误`));
  for (const e of errors) console.log(`   [${e.code}] ${e.msg}`);
  console.log();
  process.exit(1);
}

console.log(G(`✓ 全部校验通过(E1–E14)\n`));
process.exit(0);
