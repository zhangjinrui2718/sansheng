/**
 * 批次 5a.5 · T1 — 记忆循环修复(下):断垃圾源 + 存量 summary 失活
 *
 * 根因(docs/CODE-REVIEW-2026-10-01.md §B1,用户实测):
 *  - extractor.ts M2 占位启发式把每条 ≥50 字符 assistant 回复**原文全存**为
 *    kind:"summary" fragment(用户真实库已积累 13 条 reasoning+回复拼接垃圾);
 *  - searchFragmentsByText LIKE 命中垃圾 → ws.ts 注入 prompt → 模型模仿 →
 *    新回复又被存成 summary → 自我放大循环。
 *
 * RED(旧代码失败):
 *  ① extractFragments(assistant, ≥50 字符)不再产 summary fragment
 *  ② searchFragmentsByText 默认(不传 kinds)不返回 summary kind
 * GREEN 守护(修复前后都必须通过):
 *  - REMEMBER_RE「记住:」fact 提取保留(能力不回退)
 *  - 显式 kinds:["summary"] 仍可检索(存量失活 ≠ 删数据;清理 SQL 由用户自行决定)
 *
 * 全部使用 mkdtemp 临时目录,不碰真实 ~/.sansheng。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import {
  Storage,
  extractFragments,
  insertFragment,
  searchFragmentsByText,
  upsertConversation,
  type FragmentRow,
} from "../../src/server/storage/index.js";

/** ≥50 字符、不含任何「记住:」触发词的普通 assistant 回复 */
const LONG_ASSISTANT =
  "好的,我先梳理一下现状:仓库里共有三个模块需要联动修改,建议先从存储层开始," +
  "再逐步向上验证,过程中保持每步可回滚,这样风险最小。";

let dataDir: string;
let storage: Storage;
let db: Database.Database;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-memloop-"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  db = storage.db;
  // fragments.source_conversation_id 有 FK → 先建 conversation 行
  upsertConversation(db, { id: "conv-memloop-test", cwd: dataDir });
});

afterEach(() => {
  try { storage.close(); } catch { /* ignore */ }
  rmSync(dataDir, { recursive: true, force: true });
});

function seedFragment(kind: FragmentRow["kind"], content: string): void {
  insertFragment(db, {
    id: nanoid(),
    kind,
    content,
    sourceConversationId: "conv-memloop-test",
    sourceMessageId: null,
    importance: 0.5,
    decayFactor: 0.95,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: Date.now(),
    metadata: null,
  });
}

describe("storage/extractor · 断垃圾源(批次 5a.5 T1)", () => {
  it("① assistant 长回复(≥50 字符)不再整条存成 summary fragment", () => {
    expect(LONG_ASSISTANT.length).toBeGreaterThanOrEqual(50);
    const frags = extractFragments({ role: "assistant", content: LONG_ASSISTANT });
    // RED(旧代码):M2 占位启发式会返回一条 kind:"summary" 的原文全存
    expect(frags.some((f) => f.kind === "summary")).toBe(false);
  });

  it("守护:「记住:」触发词 fact 提取保留(assistant / user 两 role)", () => {
    const a = extractFragments({ role: "assistant", content: "记住:用户偏好暗色主题,以后默认暗色。" });
    expect(a.some((f) => f.kind === "fact" && f.content.includes("用户偏好暗色主题"))).toBe(true);

    const u = extractFragments({ role: "user", content: "记住:我对花生过敏" });
    expect(u.some((f) => f.kind === "fact" && f.content.includes("我对花生过敏"))).toBe(true);
  });
});

describe("storage/fragments · searchFragmentsByText 默认排除 summary(批次 5a.5 T1)", () => {
  const QUERY = "MARKQ-有什么茶推荐";

  beforeEach(() => {
    // 模拟用户库现状:一条正常 fact + 一条 M2 时代积累的 summary 垃圾,都能被 LIKE 命中
    seedFragment("fact", `${QUERY}-FACT-用户喜欢普洱`);
    seedFragment("summary", `${QUERY}-SUMMARY-JUNK-旧回复原文拼接垃圾 # Relevant Memories --- User:`);
  });

  it("② 默认(不传 kinds)不返回 summary — 存量 13 条垃圾不再被注入", () => {
    const hits = searchFragmentsByText(db, QUERY, { limit: 5 });
    // RED(旧代码):默认无 kind 过滤,fact 与 summary 垃圾一起命中
    expect(hits.some((f) => f.kind === "summary")).toBe(false);
    expect(hits.some((f) => f.kind === "fact")).toBe(true);
  });

  it("守护:显式 kinds:[\"summary\"] 仍可检索(失活 ≠ 删数据)", () => {
    const hits = searchFragmentsByText(db, QUERY, { kinds: ["summary"] });
    expect(hits.some((f) => f.kind === "summary")).toBe(true);
  });
});
