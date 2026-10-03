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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 可选位置参数,便于对副本做反向测试:node check-design-consistency.mjs [设计1.md] [设计2.md]
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const P1_PATH = args[0] ? args[0] : join(HERE, "DESIGN-PLATFORM.md");
const P2_PATH = args[1] ? args[1] : join(HERE, "DESIGN-AGENTS.md");

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

console.log(G(`✓ 全部校验通过(E1–E13)\n`));
process.exit(0);
