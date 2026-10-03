/**
 * 批次 4a · B3(守护)— sqlite-vec 扩展加载失败 → 降级不崩 boot
 * (docs/CODE-REVIEW-2026-10-01.md §B3 修复方向:「db.ts 构造器 try/catch load」)
 *
 * 场景:sqlite-vec 的平台二进制是 optionalDependencies —— 装不上(不受支持平台 /
 * 安装器跳过 optional)时 `load(db)` throw。修复后 db.ts 构造器必须:
 *  1. 捕获加载失败,Storage 照常构造(boot 不崩);
 *  2. migration 002 走既有 catch-and-skip → skipped 列表可见、其余 1/3/4/5 照常 applied;
 *  3. isVecAvailable=false → upsertFragmentEmbedding 静默降级(不 throw)、
 *     searchFragments 走 importance fallback;常规 CRUD 全部可用。
 *
 * RED 说明:修复前 db.ts 根本不 import sqlite-vec → vecLoaded 属性不存在
 * (undefined ≠ false)→ 本文件红;修复后 mock 的 load() throw 走真实降级路径 → 绿。
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("sqlite-vec", () => ({
  load: () => {
    throw new Error("Loadble extension for sqlite-vec not found. Was the sqlite-vec-darwin-arm64 package installed? (simulated)");
  },
  getLoadablePath: () => {
    throw new Error("simulated: extension binary missing");
  },
}));

import { Storage } from "../../src/server/storage/db.js";
import { versionsWithoutVec } from "./_migrations.js";
import {
  isVecAvailable,
  insertFragment,
  upsertFragmentEmbedding,
  searchFragments,
} from "../../src/server/storage/repo/fragments.js";
import { upsertConversation, listConversations } from "../../src/server/storage/repo/conversations.js";

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sansheng-b3-novec-"));
  tmpDirs.push(dir);
  return join(dir, "sansheng.db");
}
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("B3 · vec 扩展加载失败 → 降级不崩 boot", () => {
  it("Storage 构造成功 + 002 skipped + 其余 migration 照常 + vec 链路静默降级", () => {
    let storage: Storage | null = null;
    // 修复契约:构造器 try/catch load → 不 throw
    expect(() => {
      storage = new Storage(tmpDbPath());
    }).not.toThrow();
    const s = storage as Storage | null;
    if (!s) throw new Error("unreachable: storage not constructed");
    try {
      // RED(修复前):vecLoaded 属性不存在 → undefined ≠ false
      expect((s as Storage & { vecLoaded?: boolean }).vecLoaded).toBe(false);
      // 002 被 skip(扩展缺失),其余照常
      const versions = (
        s.db.prepare(`SELECT version FROM schema_version ORDER BY version`).all() as Array<{
          version: number;
        }>
      ).map((r) => r.version);
      expect(versions).toEqual(versionsWithoutVec());
      expect(isVecAvailable(s.db)).toBe(false);
      // 常规 CRUD 可用
      upsertConversation(s.db, { id: "c-novec", cwd: "/tmp", modelId: "m", provider: "p" });
      expect(listConversations(s.db, 10)).toHaveLength(1);
      // 向量链路静默降级:upsert 不 throw(早退),search 走 fallback
      insertFragment(s.db, {
        id: "f-novec",
        kind: "fact",
        content: "降级路径片段",
        sourceConversationId: null,
        sourceMessageId: null,
        importance: 0.7,
        decayFactor: 0.95,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: Date.now(),
        metadata: null,
      });
      expect(() => upsertFragmentEmbedding(s.db, "f-novec", [0.1, 0.2, 0.3])).not.toThrow();
      const rows = searchFragments(s.db, { embedding: [0.1, 0.2, 0.3], limit: 5 });
      expect(rows[0]?.id).toBe("f-novec"); // importance fallback 仍可检索
    } finally {
      s.close();
    }
  });
});
