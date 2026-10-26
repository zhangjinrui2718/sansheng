/**
 * 「待答」面板的**显示作用域**(2026-10-12 用户裁决:切到哪个项目才看到哪个项目的)
 *
 * ── 它盯的是「筛选对不对」,不是「数据对不对」────────────────────────
 *
 * 数据侧(`GET /api/client-questions`)仍然是全局的,而且它**必须**仍然是:
 * 筛选是**显示口径**的改变,不是事实的隐藏(别处要用、要审计的都还拿得到)。
 * 真正的回归风险有三条,所以这里三条各钉一格 + 每条一个变异自检:
 *
 *   ① **筛选根本没接上** —— 后端给了带 `projectId` 的全局列表,面板照样整个渲染;
 *   ② **`null` 分支退化成「全部」** —— 没选项目时悄悄变成全局面板,那个矛盾
 *      (上面「本项目一切正常」,下面挂着别的项目的提问)是**默默地**回来的;
 *   ③ **收口计数用了全局那份** —— 后端 `fromClosedProjects` 是全局的,直接显示会
 *      把别的项目的条数报在当前项目名下(用户看到「这个项目里怎么有 3 件已收口」)。
 *
 * ⚠️ **断言针对代码,不对注释**:这几份源码里都有大段注释在解释「为什么这么筛」,
 * 而注释里必然出现「全局」「当前项目」这些词 —— 扫描前先 `stripComments`。
 * (交付物 iframe 那条判据吃过一次亏:裸 grep 报 3 处,剥掉注释后是 0。
 *  **错的是仪器,不是代码。**)
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeClientQuestions } from "../../web/src/lib/questionScope";
import type { ClientQuestionView } from "@shared/types/platform";

const WEB_SRC = join(process.cwd(), "web/src");
const readWebSrc = (rel: string): string => readFileSync(join(WEB_SRC, rel), "utf8");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const source = (rel: string): string => stripComments(readWebSrc(rel));

// ── 夹具 ──────────────────────────────────────────────────────────

const q = (over: Partial<ClientQuestionView> & { id: string; projectId: string }): ClientQuestionView => ({
  question: `问题 ${over.id}`,
  status: "open",
  createdAt: 0,
  ...over,
});

/**
 * 「null 当作全部」的变异实现(= **改之前的口径**:全局显示)。
 *
 * ⚠️ 这才是这道题真正的失败形态:真函数里那个 `projectId === null` 守卫**并不是**
 *   必需的 —— `filter(q => q.projectId === null)` 今天恰好也给空,把它删掉行为不变。
 *   真正会出事的是有人反过来写:`null` 时**不过滤**(把面板退化成全局面板)。那个形态
 *   在下面两格里被点名。
 */
function scopeTreatingNullAsAll(
  questions: readonly ClientQuestionView[],
  closedProjectQuestions: readonly ClientQuestionView[],
  projectId: string | null,
): { items: ClientQuestionView[]; closedCount: number } {
  const mine = projectId === null ? questions : questions.filter((x) => x.projectId === projectId);
  return {
    items: [...mine].sort((a, b) => a.createdAt - b.createdAt),
    closedCount: closedProjectQuestions.length,
  };
}

describe("scopeClientQuestions · 只显示当前项目的待答", () => {
  it("**正样本**:当前项目的两条都在", () => {
    const r = scopeClientQuestions(
      [q({ id: "a1", projectId: "p1" }), q({ id: "a2", projectId: "p1" })],
      [],
      "p1",
    );
    expect(r.items.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(r.closedCount).toBe(0);
  });

  it("**负样本**:别的项目的那条**不在**里面(这条就是这次改动的全部内容)", () => {
    const r = scopeClientQuestions(
      [q({ id: "a1", projectId: "p1" }), q({ id: "b1", projectId: "p2" })],
      [],
      "p1",
    );
    expect(r.items.map((i) => i.id)).toEqual(["a1"]);
    expect(r.items.some((i) => i.projectId === "p2")).toBe(false);
  });

  it("队列是 FIFO:早问的先答(筛选不是排序的借口)", () => {
    const r = scopeClientQuestions(
      [
        q({ id: "late", projectId: "p1", createdAt: 200 }),
        q({ id: "early", projectId: "p1", createdAt: 100 }),
      ],
      [],
      "p1",
    );
    expect(r.items.map((i) => i.id)).toEqual(["early", "late"]);
  });

  it("⚠️ **没选项目 ⇒ 空,不是「全部」** —— 退化成全局面板就是矛盾默默回来", () => {
    const all = [q({ id: "a1", projectId: "p1" }), q({ id: "b1", projectId: "p2" })];
    const closed = [q({ id: "c1", projectId: "p1" })];
    const r = scopeClientQuestions(all, closed, null);
    expect(r.items).toEqual([]);
    expect(r.closedCount).toBe(0);
    // 判据自检:「null ⇒ 全部」那个变异(= 改之前的口径)必须过不了上面两句 ——
    // 否则这两句与 `projectId` 无关,面板什么时候退化成全局都不会有人知道。
    // ⚠️ 这一格验的是**判据的区分力**;真代码靠下面「接线」里的源码断言钉住。
    const mutated = scopeTreatingNullAsAll(all, closed, null);
    expect(mutated.items.length).not.toBe(0);
    expect(mutated.closedCount).not.toBe(0);
  });

  it("**收口计数按项目数**,不把别的项目的条数报在当前项目名下", () => {
    const closed = [
      q({ id: "c1", projectId: "p1" }),
      q({ id: "c2", projectId: "p1" }),
      q({ id: "cOther", projectId: "p2" }),
    ];
    const r = scopeClientQuestions([q({ id: "a1", projectId: "p1" })], closed, "p1");
    expect(r.closedCount).toBe(2);
    // 判据自检:全局那一份(= 后端 `fromClosedProjects`,也就是改之前的口径)会数成 3,
    // 而上面那句 `toBe(2)` 必须过不了它 —— 否则「按项目数」这四个字是空的。
    expect(closed.length).not.toBe(r.closedCount);
  });

  it("⚠️ **只数不渲染**:收口的那批永远不会出现在 items 里", () => {
    const r = scopeClientQuestions(
      [],
      [q({ id: "c1", projectId: "p1" }), q({ id: "c2", projectId: "p1" })],
      "p1",
    );
    expect(r.items).toEqual([]);
    expect(r.closedCount).toBe(2);
  });

  it("空输入不炸(items 空、计数 0)", () => {
    expect(scopeClientQuestions([], [], "p1")).toEqual({ items: [], closedCount: 0 });
  });

  it("不改动传入的数组(排序不能就地改别人的引用)", () => {
    const input = [
      q({ id: "late", projectId: "p1", createdAt: 200 }),
      q({ id: "early", projectId: "p1", createdAt: 100 }),
    ];
    scopeClientQuestions(input, [], "p1");
    expect(input.map((i) => i.id)).toEqual(["late", "early"]);
  });
});

describe("接线 · 面板真的用了这道筛", () => {
  const dock = (): string => source("components/client/ClientQuestionDock.tsx");
  const scope = (): string => source("lib/questionScope.ts");

  it("面板把**筛选结果**渲染出去(不是把全局列表整个渲染)", () => {
    const s = dock();
    expect(s).toMatch(/scopeClientQuestions\(/);
    // 2026-10-26:`items.map(` 那一行改成了 `DataState` 的 `rows.map(`
    // (四态收进 `ui/DataState.tsx`)。**判据没变** —— 被渲染的仍必须是
    // 那道筛的输出,所以这里改成「`items` 是喂给状态的那一份」+「渲染的是它吐出来的 `rows`」,
    // 两条合起来才等价于原来那一条(单看 `rows.map(` 是恒真的空断言)。
    expect(s).toMatch(/remoteListOf\(items,/);
    expect(s).toMatch(/rows\.map\(/);
    // ⚠️ 变异自检:整份 questions 直接 map 出去 ⇒ 这一格当场变红
    expect(s).not.toMatch(/questions\.map\(/);
    // ⚠️ 变异自检:把 `questions` 喂给 DataState(而不是筛过的 `items`)⇒ 红
    expect(s).not.toMatch(/remoteListOf\(questions,/);
  });

  it("面板**不用**后端那个全局收口计数(它答不对「本项目有几件」)", () => {
    expect(dock()).not.toMatch(/fromClosedProjects/);
  });

  it("面板**不**把收口那批渲染成可答的卡片", () => {
    const s = dock();
    expect(s).not.toMatch(/closedProjectQuestions\.map\(/);
    // 变异自检:加了这么一行 ⇒ 这一格当场变红
    expect(s + "\nclosedProjectQuestions.map((q) => q)").toMatch(/closedProjectQuestions\.map\(/);
  });

  it("筛选函数本身还认得「没选项目 ⇒ 空」这句话(死了就会被改回去)", () => {
    const s = scope();
    expect(s).toMatch(/projectId === null/);
    expect(s).toMatch(/items:\s*\[\]/);
  });
});