/**
 * 批次 7-I · 交付物挑选(pickDeliveries)—— B 缺陷的正面解
 *
 * **背景(B)**:plan 跑完后,executor 写出的 evidence 正文只躺在 blackboard 里,
 * 用户在对话中只看到一行「完成 N/M」。协议上 `plan_done` 早就带着整个
 * `artifacts`,是前端丢了、只渲染 summary —— 所以这个缺陷是「**传了但没人收**」,
 * 不是「少传数据」。
 *
 * 本文件守「什么才算交付物」这条定义。**逐类排除的理由是设计决定,不是实现细节**:
 * 混进 hypothesis 会让用户以为事情做完了(它其实在等用户拍板);
 * 混进 note 会把错误当产物交付。
 */
import { describe, expect, it } from "vitest";
import { DELIVERY_BODY_MAX_CHARS, pickDeliveries } from "../../src/server/agents/deliveries.js";
import type { BlackboardArtifact } from "../../../shared/types/blackboard.js";

function art(partial: Partial<BlackboardArtifact> & Pick<BlackboardArtifact, "id" | "kind" | "status">): BlackboardArtifact {
  return {
    scope: "conversation",
    title: partial.id,
    body: "",
    author: "executor",
    createdAt: Date.now(),
    ...partial,
  } as BlackboardArtifact;
}

describe("7-I 交付物 · 只收 resolved 的 evidence", () => {
  it("resolved 的 evidence 是交付物本体", () => {
    const out = pickDeliveries([
      art({ id: "ev-1", kind: "evidence", status: "resolved", title: "技术方案", body: "正文" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "ev-1", kind: "evidence", title: "技术方案", body: "正文" });
  });

  it("hypothesis 不算交付 —— 它意味着「卡住了等用户拍板」", () => {
    const out = pickDeliveries([
      art({ id: "h-1", kind: "hypothesis", status: "waiting_for_decision", body: "要不要删库?" }),
    ]);
    expect(out).toEqual([]);
  });

  it("note 不算交付 —— 那是失败说明,是错误不是产物", () => {
    const out = pickDeliveries([art({ id: "n-1", kind: "note", status: "failed", body: "做不了" })]);
    expect(out).toEqual([]);
  });

  it("未完成的 evidence 不算交付", () => {
    const out = pickDeliveries([
      art({ id: "ev-pending", kind: "evidence", status: "open", body: "半成品" }),
      art({ id: "ev-failed", kind: "evidence", status: "failed", body: "失败了" }),
    ]);
    expect(out).toEqual([]);
  });

  it("todo / intent / decision 都不是交付物(工单与目标是输入,decision 是交互记录)", () => {
    const out = pickDeliveries([
      art({ id: "t-1", kind: "todo", status: "resolved", body: "工单正文" }),
      art({ id: "i-1", kind: "intent", status: "resolved", body: "目标" }),
      art({ id: "d-1", kind: "decision", status: "resolved", body: "用户决定" }),
    ]);
    expect(out).toEqual([]);
  });

  it("混合场景:只取该取的那几条,顺序稳定", () => {
    const out = pickDeliveries([
      art({ id: "b", kind: "evidence", status: "resolved", body: "B", createdAt: 2000 }),
      art({ id: "a", kind: "evidence", status: "resolved", body: "A", createdAt: 1000 }),
      art({ id: "z", kind: "hypothesis", status: "waiting_for_decision", body: "卡住", createdAt: 500 }),
    ]);
    expect(out.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("同毫秒创建的按 id 兜底排序(可复现,不靠 nanoid 的运气)", () => {
    const t = 1_000_000;
    const a = pickDeliveries([
      art({ id: "zz", kind: "evidence", status: "resolved", body: "Z", createdAt: t }),
      art({ id: "aa", kind: "evidence", status: "resolved", body: "A", createdAt: t }),
    ]);
    const b = pickDeliveries([
      art({ id: "aa", kind: "evidence", status: "resolved", body: "A", createdAt: t }),
      art({ id: "zz", kind: "evidence", status: "resolved", body: "Z", createdAt: t }),
    ]);
    expect(a.map((x) => x.id)).toEqual(["aa", "zz"]);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });
});

describe("7-I 交付物 · 关联工单与体积上限", () => {
  it("带 parentTodoId 时补上对应工单标题(让用户知道这份交付是为哪件事做的)", () => {
    const out = pickDeliveries([
      art({ id: "t-1", kind: "todo", status: "resolved", title: "调研外呼方案" }),
      art({
        id: "ev-1",
        kind: "evidence",
        status: "resolved",
        title: "技术方案",
        body: "正文",
        metadata: { parentTodoId: "t-1" },
      }),
    ]);
    expect(out[0]?.todoTitle).toBe("调研外呼方案");
  });

  it("parentTodoId 指向不存在的 todo 时不编造标题(只给 id,不猜)", () => {
    const out = pickDeliveries([
      art({ id: "ev-1", kind: "evidence", status: "resolved", body: "x", metadata: { parentTodoId: "ghost" } }),
    ]);
    expect(out[0]?.todoTitle).toBeUndefined();
  });

  it("超长正文被截断且**显式标注**,不静默丢内容", () => {
    const long = "x".repeat(DELIVERY_BODY_MAX_CHARS + 500);
    const out = pickDeliveries([art({ id: "ev-long", kind: "evidence", status: "resolved", body: long })]);
    expect(out[0]?.body.length).toBeGreaterThan(DELIVERY_BODY_MAX_CHARS);
    expect(out[0]?.body).toContain("已截断");
  });

  it("未超长的正文原样保留,不加截断标记", () => {
    const out = pickDeliveries([
      art({ id: "ev-1", kind: "evidence", status: "resolved", body: "短正文" }),
    ]);
    expect(out[0]?.body).toBe("短正文");
  });

  it("空 blackboard → 空交付物(不是编造一条占位)", () => {
    expect(pickDeliveries([])).toEqual([]);
  });
});
