/**
 * 批次 UI U4-G —— 「不静默丢数据」:orphanTodos 判据的单测
 *
 * ## 起因
 *
 * 用户在看「目标」页时问「这个前端展示是不是也有问题」。查下来目标页有一处
 * **真 bug**:它只 `filter(kind === "intent")` 组装目标,于是
 * `parentIntent` 没写、或指向本会话不存在 intent 的 todo **被整段丢掉** ——
 * 页面只显示「本会话暂无目标」,而 blackboard 上明明躺着 N 个待办。
 *
 * 同一份数据,Agent 页早就为它单开了一块「未归属意图的待办」,还特意注明
 * 「以免丢数据」;工件页也早有同一条纪律(§4 表末行:「不给它们建组就等于把
 * 真实数据藏起来」)。只有目标页违反。判据因此抽到
 * `lib/artifacts.ts` 的 `orphanTodos()`,两页共用一份,并在此固化。
 *
 * 下面的样本按真机数据形状构造(2026-10-02 取自 `conv_muqyliyi_pz2y`:
 * 2 intent / 10 todo,todo 的 parentIntent 全部指向本会话存在的 intent)。
 */
import { describe, expect, it } from "vitest";
import { orphanTodos } from "../../web/src/lib/artifacts";
import type { Artifact } from "../../web/src/lib/artifacts";

function todo(id: string, parentIntent?: string): Artifact {
  return {
    id,
    scope: "conversation",
    kind: "todo",
    title: `todo ${id}`,
    body: "",
    author: "planner",
    status: "open",
    parentIntent,
    createdAt: 1,
    updatedAt: 1,
  };
}

function intent(id: string): Artifact {
  return {
    id,
    scope: "conversation",
    kind: "intent",
    title: `intent ${id}`,
    body: "",
    author: "communicator",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
  };
}

const evidence: Artifact = {
  id: "ev-1",
  scope: "conversation",
  kind: "evidence",
  title: "evidence",
  body: "",
  author: "executor",
  status: "resolved",
  createdAt: 1,
  updatedAt: 1,
};

describe("orphanTodos · 挂不到任何目标名下的待办", () => {
  it("parentIntent 指向存在的 intent → 不算孤儿", () => {
    const arts = [intent("i1"), todo("t1", "i1"), todo("t2", "i1")];
    expect(orphanTodos(arts)).toEqual([]);
  });

  it("parentIntent 没写 → 算孤儿(真机数据里 planner 早于 intent 落笔时会出现)", () => {
    const arts = [intent("i1"), todo("t1"), todo("t2", "i1")];
    expect(orphanTodos(arts).map((t) => t.id)).toEqual(["t1"]);
  });

  it("parentIntent 指向本会话不存在的 intent → 算孤儿", () => {
    const arts = [intent("i1"), todo("t1", "art-does-not-exist")];
    expect(orphanTodos(arts).map((t) => t.id)).toEqual(["t1"]);
  });

  it("非 todo 工件一律不算(evidence / note / decision 都不是待办)", () => {
    const arts = [intent("i1"), evidence, todo("t1", "i1")];
    expect(orphanTodos(arts)).toEqual([]);
  });

  it("真机形状:2 intent / 10 todo 全部正确归属 → 0 个孤儿", () => {
    // conv_muqyliyi_pz2y 的真实分布:8 个挂 i1,2 个挂 i2。
    const arts = [
      intent("i1"),
      intent("i2"),
      ...Array.from({ length: 8 }, (_, n) => todo(`a${n}`, "i1")),
      ...Array.from({ length: 2 }, (_, n) => todo(`b${n}`, "i2")),
    ];
    expect(orphanTodos(arts)).toEqual([]);
  });

  it("一个 intent 都没有时,全部 todo 都是孤儿 —— 目标页必须如实说出来", () => {
    const arts = [todo("t1"), todo("t2"), evidence];
    expect(orphanTodos(arts).map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("空数组不炸", () => {
    expect(orphanTodos([])).toEqual([]);
  });
});
