/**
 * 批次 4a · B8 — 重启/失败无对账:非终态 todo 永久悬挂
 * (docs/CODE-REVIEW-2026-10-01.md §B8)
 *
 * 缺陷形态:协调层状态(Orchestrator.activeExecutors/waiting/todoByExecutorSession/
 * run promise)纯内存,进程重启全丢;SQLite 里 open/in_progress/waiting_for_decision
 * 的 todo 与 open 的 intent 无任何 boot 对账代码(全仓 grep 无 recovery/reconcile)
 * → 非终态 todo 永久悬挂(前端「进行中」永不终结,intent 永不收尾)。
 *
 * 修复契约:
 *  - 存储层 `reconcileOrphanedRunArtifacts(db)`:把**所有**非终态 todo
 *    (open/in_progress/waiting_for_decision)与 open intent 终态化为 failed,
 *    metadata.errorReason = "reconciled on boot: orphaned by server restart"
 *    (与批次 1 cascadeFailDependents 的 errorReason 同形态:`<原因前缀>: <说明>`,
 *    sink 的 todo_failed reason 同源读取该字段);
 *  - boot 接线点 = Storage 构造器(文件路径分支,migrations 之后):对账恰好在
 *    「进程已起、尚未对外服务」窗口执行一次;
 *  - 已终态(resolved/failed/superseded)artifact 一律不动;既有 failed 的
 *    errorReason(如批次 1 cascade 文案)不被覆盖。
 *
 * 「无主」判据(防误杀论证,详见报告):
 *  - Orchestrator 生命周期状态纯内存 → 新进程启动瞬间**必然零 active run**;
 *  - 对账在 Storage 构造时同步执行,早于 HTTP listen / WS accept / kernel 接线
 *    → 执行时刻库中任何非终态 todo 的属主 run 只可能来自已死进程 → 全部无主;
 *  - boot 之后同进程新建 run 的 todo 不会再被触碰(一次性,无定时器/轮询)
 *    → 「server 正常运行中新 run 的 todo」零误杀(下方专测);
 *  - 不需要时间窗:时间窗(如「只杀 N 分钟前的」)反而漏掉重启前一刻刚创建的
 *    真孤儿;归属判据 = 「进程边界」本身,精确且无参数。
 *  - 已知边界:第二个进程对同一 DB 文件再构造 Storage 会终态化第一个进程活 run
 *    的 todo —— 生产由 pid 文件 + 端口占用约束单实例(daemon 健康检查/EADDRINUSE),
 *    该形态属误用,注释中已声明。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storageIndex from "../../src/server/storage/index.js";
import {
  Storage,
  upsertArtifact,
  getArtifact,
} from "../../src/server/storage/index.js";
import type { BlackboardArtifact } from "../../shared/types/blackboard.js";

const BOOT_REASON = "reconciled on boot: orphaned by server restart";

const tmpDirs: string[] = [];
function tmpDbPath(prefix = "sansheng-b8-reconcile-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return join(dir, "sansheng.db");
}
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mkArtifact(
  partial: Partial<BlackboardArtifact> & { id: string; kind: BlackboardArtifact["kind"] },
): BlackboardArtifact {
  const now = Date.now();
  return {
    scope: "conversation",
    conversationId: "conv-restart",
    title: `artifact ${partial.id}`,
    body: "",
    author: "executor",
    status: "open",
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe("B8 · boot 对账:重启后遗留非终态 todo → failed + errorReason", () => {
  it("模拟重启:open/in_progress/waiting_for_decision todo 与 open intent 全部终态化;终态与既有 errorReason 不动", () => {
    const dbPath = tmpDbPath();
    // —— 进程 1:留下一个「死掉」的 run 现场 ——
    const s1 = new Storage(dbPath);
    const cascadeReason = "cascade from todo-done: upstream dependency failed";
    upsertArtifact(s1.db, mkArtifact({ id: "intent-1", kind: "intent", author: "communicator", status: "open", title: "重启前的目标" }));
    upsertArtifact(s1.db, mkArtifact({ id: "todo-open", kind: "todo", status: "open", parentIntent: "intent-1" }));
    upsertArtifact(s1.db, mkArtifact({ id: "todo-wip", kind: "todo", status: "in_progress", parentIntent: "intent-1" }));
    upsertArtifact(s1.db, mkArtifact({ id: "todo-wait", kind: "todo", status: "waiting_for_decision", parentIntent: "intent-1" }));
    upsertArtifact(s1.db, mkArtifact({ id: "todo-done", kind: "todo", status: "resolved", parentIntent: "intent-1" }));
    upsertArtifact(s1.db, mkArtifact({ id: "todo-failed", kind: "todo", status: "failed", parentIntent: "intent-1", metadata: { errorReason: cascadeReason } }));
    s1.close();

    // —— 进程 2(模拟重启):boot 对账发生在 Storage 构造器 ——
    const s2 = new Storage(dbPath);
    try {
      for (const id of ["todo-open", "todo-wip", "todo-wait"]) {
        const a = getArtifact(s2.db, id);
        // RED(修复前):无对账代码 → 仍是原状态(open/in_progress/waiting_for_decision)
        expect(a?.status, `${id} 应被对账为 failed`).toBe("failed");
        expect(a?.metadata?.errorReason, `${id} errorReason 应与批次 1 cascade 同形态`).toBe(BOOT_REASON);
      }
      const intent = getArtifact(s2.db, "intent-1");
      expect(intent?.status).toBe("failed"); // intent 同步终态化
      expect(intent?.metadata?.errorReason).toBe(BOOT_REASON);
      // 终态 artifact 不动、既有失败原因不被覆盖
      expect(getArtifact(s2.db, "todo-done")?.status).toBe("resolved");
      expect(getArtifact(s2.db, "todo-done")?.metadata?.errorReason).toBeUndefined();
      expect(getArtifact(s2.db, "todo-failed")?.status).toBe("failed");
      expect(getArtifact(s2.db, "todo-failed")?.metadata?.errorReason).toBe(cascadeReason);
    } finally {
      s2.close();
    }
  });

  it("活 run 不误杀:同一 Storage 实例(= 同一进程 boot 之后)新建的非终态 todo 保持不变", () => {
    const s = new Storage(tmpDbPath());
    try {
      upsertArtifact(s.db, mkArtifact({ id: "todo-live", kind: "todo", status: "in_progress" }));
      expect(getArtifact(s.db, "todo-live")?.status).toBe("in_progress");
      // 后续读写活动不会触发任何「后台对账」(一次性、无定时器)
      upsertArtifact(s.db, mkArtifact({ id: "todo-live-2", kind: "todo", status: "waiting_for_decision" }));
      upsertArtifact(s.db, mkArtifact({ id: "todo-live", kind: "todo", status: "in_progress", title: "更新过的标题" }));
      expect(getArtifact(s.db, "todo-live")?.status).toBe("in_progress");
      expect(getArtifact(s.db, "todo-live-2")?.status).toBe("waiting_for_decision");
    } finally {
      s.close();
    }
  });
});

describe("B8 · 存储层 API:reconcileOrphanedRunArtifacts 可直接调用且幂等", () => {
  it("导出函数存在;返回对账摘要;二次调用为 no-op", () => {
    // RED(修复前):storage/index.ts 无此导出 → undefined
    const fn = (storageIndex as Record<string, unknown>).reconcileOrphanedRunArtifacts;
    expect(typeof fn, "storage 层应导出 reconcileOrphanedRunArtifacts").toBe("function");
    if (typeof fn !== "function") return;
    const reconcile = fn as (db: unknown) => {
      failedTodos: number;
      failedIntents: number;
      todoIds: string[];
      intentIds: string[];
    };

    const s = new Storage(tmpDbPath());
    try {
      upsertArtifact(s.db, mkArtifact({ id: "intent-u", kind: "intent", author: "communicator", status: "open" }));
      upsertArtifact(s.db, mkArtifact({ id: "todo-u1", kind: "todo", status: "in_progress", parentIntent: "intent-u" }));
      upsertArtifact(s.db, mkArtifact({ id: "todo-u2", kind: "todo", status: "open", parentIntent: "intent-u" }));
      upsertArtifact(s.db, mkArtifact({ id: "todo-u3", kind: "todo", status: "resolved", parentIntent: "intent-u" }));

      const r1 = reconcile(s.db);
      expect(r1.failedTodos).toBe(2);
      expect(r1.failedIntents).toBe(1);
      expect(r1.todoIds.sort()).toEqual(["todo-u1", "todo-u2"]);
      expect(r1.intentIds).toEqual(["intent-u"]);
      expect(getArtifact(s.db, "todo-u1")?.metadata?.errorReason).toBe(BOOT_REASON);

      const r2 = reconcile(s.db); // 幂等:已全部终态
      expect(r2.failedTodos).toBe(0);
      expect(r2.failedIntents).toBe(0);
    } finally {
      s.close();
    }
  });

  it("BOOT_RECONCILE_REASON 常量导出且与批次 1 cascade 文案同形态(<前缀>: <说明>)", () => {
    const reason = (storageIndex as Record<string, unknown>).BOOT_RECONCILE_REASON;
    expect(reason).toBe(BOOT_REASON);
    expect(String(reason)).toMatch(/^[^:]+: .+/);
  });
});
