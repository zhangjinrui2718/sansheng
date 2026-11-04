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

/* ── ratchet:「四态只有一处写法」不许退回 ──────────────────────────────
 *
 * 这一段全是**源码级**判据。理由:四态写法的回归不是「测试失败」,
 * 而是「又有一处手写三元链」—— 而手写链在屏幕上看不出差别,
 * 所以只有源码扫描能看见它。
 *
 * ⚠️ 每条都带**正样本自检**(扫描器必须能命中已知的东西),
 * 否则「0 命中」可能只是扫描器写错了(AGENTS.md 第三节:
 * 一个坏掉的检查返回一个看起来正常的答案)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = "web/src";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const WEB_FILES = walk(WEB).map((p) => ({ path: p, src: readFileSync(p, "utf8") }));

describe("ratchet:红色的壳只有一处", () => {
  /**
   * 「红字壳」= **壳的 class** + **朱色** 在**同一个元素**上。
   *
   * ⚠️ **为什么按元素扫而不是按字面量扫**:壳的 class 常常还带别的类
   * (`ss-meta mt-1`、`sansheng-card p-3 text-xs flex flex-col gap-0.5`),
   * 按「精确字符串」扫会**漏掉一半**(2026-10-27 实测:精确形状只抓到 4 处,
   * 放宽到「class 含这个壳 + 同一元素上有朱色」抓到 13 处 —— 多出来的 9 处
   * 全是变体)。⇒ 仪器比判据宽 ⇒ 会让人改代码;仪器比判据窄 ⇒ 会漏。两头都要避免。
   */
  const SHELL_CLASSES = [
    "sansheng-card p-3 text-xs",
    "ss-note",
    "ss-meta",
    "ss-empty",
    "p-2 text-xs",
  ];

  /**
   * 扫出一个文件里的手写红壳。
   *
   * ⚠️ **条件色不算红壳**:「红 / 灰」二选一的 `color` 是**状态色**
   * (`summaryBad ? "var(--cinnabar)" : "var(--bone-dim)"`)——
   * 它不是「这里有一处写死的红」,而是「这一处会变成红」⇒ 不归 `Red*` 原语管。
   * 判据:朱色出现在三元里 ⇒ 条件色,放过。
   */
  function redShellOffenders(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/className="([^"]*)"([^>]*)>/g)) {
      const [, cls, props] = m;
      if (!SHELL_CLASSES.some((s) => cls.includes(s))) continue;
      if (!props.includes("var(--cinnabar")) continue;
      // 条件色:朱色被三元选中 ⇒ 不算「写死的红壳」
      if (/\?[^?]*var\(--cinnabar/.test(props)) continue;
      out.push(`${cls} :: ${props.trim().slice(0, 80)}`);
    }
    return out;
  }

  it("正样本自检:扫描器能命中已知的红壳,且不命中条件色", () => {
    const knownShell = `<span className="ss-meta" style={{ color: "var(--cinnabar)" }}>坏了</span>`;
    expect(redShellOffenders(knownShell).length, "正样本没命中").toBe(1);
    // 变体壳也要命中(className 带别的类)
    const variant = `<div className="ss-meta mt-1" style={{ color: "var(--cinnabar)" }}>坏了</div>`;
    expect(redShellOffenders(variant).length, "变体正样本没命中").toBe(1);
    // 条件色**不**该命中
    const conditional = `<span className="ss-meta" style={{ color: bad ? "var(--cinnabar)" : "var(--bone-dim)" }}>x</span>`;
    expect(redShellOffenders(conditional).length, "条件色被误判了").toBe(0);
    // 无朱色的壳不命中
    expect(redShellOffenders(`<span className="ss-meta">x</span>`).length).toBe(0);
  });

  it("除 primitives.tsx 外,不许再有一处手写红壳", () => {
    const offenders: string[] = [];
    for (const { path, src } of WEB_FILES) {
      if (path.endsWith("ui/primitives.tsx")) continue;
      for (const hit of redShellOffenders(src)) offenders.push(`${path} × ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it("primitives.tsx 里朱色字面量只有一处(色值不许外溢)", () => {
    const primitives = WEB_FILES.find((f) => f.path.endsWith("ui/primitives.tsx"))!.src;
    // ⚠️ **扫描前先剥注释** —— 判据那句话本身写在注释里,不剥就等于「判据把自己判红了」。
    const code = primitives.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const hits = code.match(/var\(--cinnabar/g) ?? [];
    expect(hits.length, `朱色字面量出现了 ${hits.length} 次,应当只有一处`).toBe(1);
  });

  it("五个红壳原语都得有读者(没人用的原语是第二份事实来源)", () => {
    const used = new Set<string>();
    for (const { path, src } of WEB_FILES) {
      if (path.endsWith("ui/primitives.tsx")) continue;
      for (const m of src.matchAll(/<Red(Note|Meta|Card|Empty|Inline)\b/g)) used.add(m[1]);
    }
    for (const name of ["Note", "Meta", "Card", "Empty", "Inline"]) {
      expect(used.has(name), `Red${name} 没有读者`).toBe(true);
    }
  });
});

describe("ratchet:四态的判据只有一处", () => {
  it("`RemoteState` 只在 ui/DataState.tsx 里定义", () => {
    const offenders = WEB_FILES.filter(
      (f) => !f.path.endsWith("ui/DataState.tsx") && /type RemoteState</.test(f.src),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("四个状态字面量只在 ui/DataState.tsx 里出现", () => {
    const offenders = WEB_FILES.filter(
      (f) =>
        !f.path.endsWith("ui/DataState.tsx") &&
        /kind:\s*"(loading|error|unavailable|ready)"/.test(f.src),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("这些读面文件必须用 `<DataState`(不许自己写四态链)", () => {
    const files = [
      "routes/Memory.tsx",
      "routes/Works.tsx",
      "routes/ProjectDetail.tsx",
      "routes/Members.tsx",
      "components/members/AgentConversations.tsx",
      "components/members/RoleHarness.tsx",
      "components/client/AcceptanceDock.tsx",
      "components/client/ClientQuestionDock.tsx",
      "components/shell/AgentPanel.tsx",
    ];
    const missing = files.filter((f) => {
      const hit = WEB_FILES.find((x) => x.path.endsWith(f));
      return !hit || !/<DataState/.test(hit.src);
    });
    expect(missing).toEqual([]);
  });
});

describe("ratchet:每个 variant 都有读者", () => {
  it("四个 variant 都真的被用着(没人用的 variant 是第二份事实来源)", () => {
    const used = new Set<string>();
    for (const { src } of WEB_FILES) {
      for (const m of src.matchAll(/variant="([a-z]+)"/g)) used.add(m[1]);
    }
    // `empty` 是默认值(不用写 prop),所以它按「默认」算有读者
    expect(used.has("empty")).toBe(true);
    for (const v of ["note", "card", "inline"]) {
      expect(used.has(v), `variant="${v}" 没有读者`).toBe(true);
    }
  });

  it("⚠️ 不许有第五个 variant(加 variant 必须同时加读者)", () => {
    const union = readFileSync(join(WEB, "components/ui/DataState.tsx"), "utf8");
    const m = union.match(/export type DataStateVariant =([^;]+);/);
    expect(m).not.toBeNull();
    const declared = (m![1].match(/"([a-z]+)"/g) ?? []).map((s) => s.replace(/"/g, ""));
    expect(declared.sort()).toEqual(["card", "empty", "inline", "note"]);
  });
});

describe("ratchet:同名组件不许有两个", () => {
  it("`function EmptyState(` 只在 ui/primitives.tsx 里(左栏那个叫 RailEmpty)", () => {
    const offenders = WEB_FILES.filter(
      (f) => !f.path.endsWith("ui/primitives.tsx") && /function EmptyState\(/.test(f.src),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
