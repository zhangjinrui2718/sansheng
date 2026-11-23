/**
 * 上下文超长(⑥,2026-11-22)· 回归 —— resume-unsafe:换会话,不换家、不烧闸
 *
 * ── 它守着的缺陷 ────────────────────────────────────────────────
 *
 * 上下文超长此前归 `unknown`:不降级、不刹车、工作项直接记 `failed` ——
 * 而病**在会话不在供应商**:换家没用、等也没用,重跑同一条常驻会话只会再撞
 * 一次。正确处置 = dispose 这条会话、下一次派发从库里重放历史开新会话
 * (multica 的 resume-unsafe 同款),并且**不重置尝试预算** —— 历史本身超限时
 * 新会话一样撞,「叫醒三次」的预算正是防止无限循环的那道闸。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  insertDispatchEvent, listPendingDispatchEvents, listAttempts,
} from "../../src/platform/storage/repo/dispatch.js";
import { classifyProviderFailure } from "../../src/platform/runtime/providerFailure.js";
import {
  collectTodos, drainProject, type DrainTurnReport,
} from "../../src/platform/runtime/dispatcher.js";

// ── ① 分类器 ────────────────────────────────────────────────────

describe("classifyProviderFailure · context_overflow(⑥)", () => {
  it("各家原文都归 context_overflow,且 retryable=false(换家没用)", () => {
    const samples = [
      "Error: 400 This model's maximum context length is 128000 tokens",
      "prompt is too long: 190744 tokens > 200000 maximum",
      '{"type":"error","code":400,"error":{"type":"context_length_exceeded","message":"prompt too long"}}',
      "上下文长度超出模型窗口限制,请缩短输入",
    ];
    for (const raw of samples) {
      const f = classifyProviderFailure(raw);
      expect(f.kind, `原文应归 context_overflow:${raw.slice(0, 40)}`).toBe("context_overflow");
      expect(f.retryable, "病在会话不在供应商 —— 不值得换家").toBe(false);
    }
  });

  it("顺序:429+额度词仍归 quota(更具体的先判);rate_limit_error 类型 + 超长正文归 context_overflow", () => {
    expect(
      classifyProviderFailure(
        "429 已达到 Token Plan 用量上限:请升级套餐 (2056)",
      ).kind,
    ).toBe("quota");
    expect(
      classifyProviderFailure(
        '{"error":{"type":"rate_limit_error","message":"prompt is too long: 190744 tokens"}}',
      ).kind,
    ).toBe("context_overflow");
  });

  it("裸的 too long 不误伤(只认带上下文语的短语)", () => {
    expect(classifyProviderFailure("the tool result was too long").kind).not.toBe("context_overflow");
  });
});

// ── ② dispatcher 语义:sessionReset 不消费、不重置预算 ───────────

describe("drainProject · sessionReset(⑥)", () => {
  let db: Database.Database;
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    db = openPlatformMemoryDb();
    insertProject(db, {
      id: "p1", name: "超长会话", client: "甲方", goal: "g", status: "active", createdAt: T0,
    });
    ensureProjectOrg(db, "p1", T0);
    // 一条未消费的下游事件 ⇒ report_downstream 待办(消费面在它身上最可观测)。
    insertDispatchEvent(db, {
      projectId: "p1", kind: "work_done", subjectId: "w9",
      summary: "「调研」做完了", createdAt: T0,
    });
  });
  afterEach(() => db.close());

  const okTurn: DrainTurnReport = { aborted: false, timedOut: false, text: "说了", toolCalls: [] };

  it("sessionReset ⇒ 不消费事件、预算照烧(3 次后 exhausted,不会无限换会话)", async () => {
    expect(
      collectTodos({ db, projectId: "p1", now: T0 + 10, reportBatchSize: 1, reportMaxDelayMs: 0 })
        .runnable.some((t) => t.kind === "report_downstream"),
      "夹具前提:得有 report_downstream 待办",
    ).toBe(true);

    const result = await drainProject({
      db, projectId: "p1", now: () => T0 + 10, log: () => {},
      reportBatchSize: 1, reportMaxDelayMs: 0,
      runAgentTurn: async () => ({ ...okTurn, sessionReset: true }),
      runWork: async () => { throw new Error("这一串里没有工作项要执行"); },
    });

    // 事件没被消费(那一轮被 provider 拒了,「已向甲方交代」不能记)。
    expect(
      listPendingDispatchEvents(db, "p1").length > 0,
      "sessionReset 的一轮不许消费事件",
    ).toBe(true);
    // 预算烧满 ⇒ exhausted(不是无限重试)。
    const ledger = [...listAttempts(db, "p1").values()].find((a) =>
      a.todoKey.startsWith("report_downstream"),
    );
    expect(ledger?.attempts, "预算照烧 —— 三次后由预算闸停住").toBe(3);
    expect(result.exhausted.map((t) => t.kind)).toContain("report_downstream");
  });
});
