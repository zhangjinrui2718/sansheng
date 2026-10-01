/**
 * Sansheng · plan summary(M3+ B2)
 *
 * 从 BlackboardShape 产一个可读的 plan 总结,给前端 plan_done 渲染总结卡用 — 1~3 行:
 *  - "完成了 N 个 todo:M1, M2"
 *  - "失败 K 个 todo:K1"
 *  - "未触发任何 todo"
 *
 * 原为 ws.ts 私有函数;批次 1(docs/CODE-REVIEW-2026-10-01.md §D1)提取为独立模块:
 * ws.ts 与 tests/agents/e2e-blockers.test.ts 共用同一实现,消除测试复刻导致的漂移
 * (复刻版恰好掩盖了 §A1 的 TDZ 崩溃)。
 */
import type {
  BlackboardArtifact,
  BlackboardShape,
} from "../../../shared/types/blackboard.js";

export function buildPlanSummary(
  finalBb: BlackboardShape,
  goalTitle: string,
): string {
  const todos = (finalBb.artifacts ?? []).filter((a: BlackboardArtifact) => a.kind === "todo");
  if (todos.length === 0) {
    return `计划 "${goalTitle.slice(0, 60)}" 没有产生任何 todo。`;
  }
  const resolved = todos.filter((t) => t.status === "resolved");
  const failed = todos.filter((t) => t.status === "failed");
  const parts: string[] = [];
  parts.push(`计划 "${goalTitle.slice(0, 60)}" 完成 ${resolved.length}/${todos.length}`);
  if (failed.length > 0) {
    parts.push(`失败 ${failed.length}:${failed.map((t) => t.title.slice(0, 30)).join(", ")}`);
  }
  return parts.join(";");
}
