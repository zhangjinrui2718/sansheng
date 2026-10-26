/**
 * `DataState` —— 四态的**唯一**写法
 *
 * ── 为什么值得单独一份单元测试 ──────────────────────────────────────
 *
 * 这个组件存在的全部理由是「**读不到 ≠ 没有**」,而这句话的失败形态是
 * **看起来完全正常的一屏空**。真机上已经出现过三次同款:
 * `project_live.runtime === "unavailable"` 被渲染成「空闲」、知识语料的
 * `unavailable` 被显示成「0 条」、慢请求被渲染成「查过了是空的」。
 *
 * 所以这里不测样式,只测**四种状态两两不同**,以及两个构造器把「空」与
 * 「还没拿到」分开的那一下 —— 那一下就是判据本身。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataState, remoteListOf, remoteOf, type RemoteState } from "../../web/src/components/ui/DataState";

const render = (state: RemoteState<readonly string[]>, variant?: "note" | "empty"): string =>
  renderToStaticMarkup(
    createElement(DataState<readonly string[]>, {
      what: "清单",
      state,
      variant,
      unavailable: "这一块读不到。",
      children: (rows) => createElement("span", null, rows.length === 0 ? "真的是空的" : rows.join(",")),
    }),
  );

describe("remoteListOf:空数组不总是「空」", () => {
  it("首帧(`loading` + 空数组)⇒ loading,不是 ready", () => {
    expect(remoteListOf([], true, null)).toEqual({ kind: "loading" });
  });

  it("查完了 + 空数组 ⇒ ready(这时「空」才是真的)", () => {
    expect(remoteListOf([], false, null)).toEqual({ kind: "ready", data: [] });
  });

  it("错误优先于一切(有数据也不许把它盖掉)", () => {
    expect(remoteListOf(["a"], true, "boom")).toEqual({ kind: "error", error: "boom" });
    expect(remoteListOf(["a"], false, "boom")).toEqual({ kind: "error", error: "boom" });
  });

  it("有数据且没在加载 ⇒ ready", () => {
    expect(remoteListOf(["a"], false, null)).toEqual({ kind: "ready", data: ["a"] });
  });
});

describe("remoteOf:null 不等于「没有」", () => {
  it("null + 还在加载 ⇒ loading", () => {
    expect(remoteOf<string>(null, null, true)).toEqual({ kind: "loading" });
  });

  it("null + 加载结束 + 没出错 ⇒ **unavailable**(查过了但读不到)", () => {
    expect(remoteOf<string>(null, null, false)).toEqual({ kind: "unavailable" });
  });

  it("有值 ⇒ ready,哪怕还标着 loading", () => {
    expect(remoteOf("x", null, true)).toEqual({ kind: "ready", data: "x" });
  });

  it("错误优先", () => {
    expect(remoteOf("x", "boom", false)).toEqual({ kind: "error", error: "boom" });
  });
});

describe("DataState:四态在屏幕上是四句不同的话", () => {
  const loading = render({ kind: "loading" });
  const error = render({ kind: "error", error: "boom" });
  const unavailable = render({ kind: "unavailable" });
  const empty = render({ kind: "ready", data: [] });
  const full = render({ kind: "ready", data: ["a", "b"] });

  it("加载中 ⇒ 说「加载中…」,一个结论都不给", () => {
    expect(loading).toContain("加载中…");
    expect(loading).not.toContain("真的是空的");
  });

  it("读失败 ⇒ **错误原文上屏**(不吞、不落进空态)", () => {
    expect(error).toContain("加载失败:boom");
    expect(error).not.toContain("真的是空的");
  });

  it("读不到 ⇒ 说读不到,不说「没有」", () => {
    expect(unavailable).toContain("这一块读不到。");
    expect(unavailable).not.toContain("真的是空的");
  });

  it("真的空 ⇒ 才轮到调用点说「空」", () => {
    expect(empty).toContain("真的是空的");
  });

  it("有数据 ⇒ 渲染数据", () => {
    expect(full).toContain("a,b");
  });

  it("自检:五种渲染**两两不同**(上面那几条不是恒真)", () => {
    const variants = [loading, error, unavailable, empty, full];
    expect(new Set(variants).size).toBe(variants.length);
  });
});
