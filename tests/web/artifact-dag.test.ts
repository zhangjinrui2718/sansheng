/**
 * 工件页 · **产出流程(DAG)** 的判据(2026-10-06)
 *
 * ⚠️ 页面已改名/改位置:「工件」tab 与「工作项」tab 合并成一个 tab(用户要求:
 * 推进图上本来就同时画着工作项与工件,点绿色条 ⇒ 下面显示它挂着的工件),
 * 合并后的唯一页面是 `web/src/routes/Works.tsx`(`ArtifactsPage` 随之改名
 * `WorksPage`,其余导出名一个都没动)。下面只有 import 路径变了 ——
 * 断言一条都没改,也不许改。
 *
 * ── 为什么要这份测试 ────────────────────────────────────────────
 *
 * 这一版把工件页从「按 kind 平铺」换成「先看流程(DAG)再看环节产出」。改的是
 * **组织方式**,而组织方式最容易悄悄退回去:没有断言的话,下次有人「顺手」把
 * 全部工件铺进每个节点、或者把「读不到运行态」渲染成「空闲」,页面上只会看起来
 * 「信息更多了」,不会有任何东西红。
 *
 * 钉住的六条(每条都对应一个具体的、会骗人的形态):
 *
 *   1. **节点只挂自己的工件** —— 选中 A 时,B 的工件标题不许出现(负样本:
 *      防止「把整个项目的工件都塞进每个节点」);
 *   2. **无环节工件单独列** —— `workId: null` 的决策出现在「不挂在任何环节上」
 *      那块,而**不在**任何节点的工件列表里(负样本);
 *   3. **在跑标记** —— live 里某角色有在跑的回合时,它负责的节点带
 *      `data-running="true"` 且有呼吸点;另一个节点**不带**(负样本);
 *   4. **读不到 ≠ 空闲** —— `runtime: "unavailable"` 时页面出现「读不到」字样,
 *      且**不许**出现「空闲」/「没有在跑」这类断言性文案(负样本);
 *   5. **工件计数** —— 节点上的 `工件 N` 与该 workId 的真实工件数一致;
 *   6. **环上的诚实** —— 依赖成环的两个环节:页面出现「先后算不出来」的说明,
 *      而且**两个节点都还在**(不许丢)。
 *
 * 组件是纯 props 的(`ArtifactsBody` / `WorkDagCanvas` / `WorkNodePanel` /
 * `UnattachedArtifacts` / `DanglingArtifacts`),与 `tests/web/harness-by-role.test.ts`
 * 同一处置:`renderToStaticMarkup` + 夹具,不起服务、不 stub fetch。
 *
 * ⚠️ **断言要落在那个节点上,不能全页 grep。** 页面里同时有 DAG 节点、环节面板、
 * 图例,全页找一个词可能命中别处 —— 所以下面的 `nodeButton()` 取出某个节点卡片的
 * 那一小段标记再断言(与 harness 测试里「正则要找标记里的真实形状」同一条教训)。
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactView, WorkView } from "@shared/types/platform";
import {
  ArtifactsBody,
  WorkDagCanvas,
  WorkNodePanel,
  UnattachedArtifacts,
  DanglingArtifacts,
  type DagLive,
} from "@/routes/Works";
import { layoutWorkDag, splitArtifactsByWork } from "@/lib/workGraph";

// ── 夹具(不连真库:全部字段自己造)────────────────────────────

const work = (id: string, over: Partial<WorkView> = {}): WorkView => ({
  id,
  projectId: "p1",
  parentWorkId: null,
  title: `环节 ${id}`,
  goal: "",
  status: "open",
  assigneeAgentId: "agent-worker",
  assigneeName: "执行者",
  createdAt: 1000,
  updatedAt: 2000,
  dependsOn: [],
  ...over,
});

const art = (id: string, over: Partial<ArtifactView> = {}): ArtifactView => ({
  id,
  projectId: "p1",
  kind: "evidence",
  status: "open",
  title: `工件 ${id}`,
  body: "",
  authorAgentId: "agent-worker",
  authorName: "执行者",
  createdAt: 1000,
  updatedAt: 2000,
  links: [],
  workId: null,
  ...over,
});

/** 三个环节:甲(2 件工件)、乙(1 件)、丙(0 件 —— 安静节点)。 */
const W1 = work("w1", { title: "环节甲" });
const W2 = work("w2", {
  title: "环节乙",
  assigneeAgentId: "agent-qa",
  assigneeName: "质检审查员",
});
const W3 = work("w3", { title: "环节丙" });
const WORKS = [W1, W2, W3];

const A1 = art("a1", { workId: "w1", kind: "evidence", title: "甲的证据条目" });
const A2 = art("a2", { workId: "w1", kind: "work_brief", title: "甲的工作简报" });
const B1 = art("b1", { workId: "w2", kind: "review_finding", title: "乙的评审发现" });
/** `workId: null` —— 决策工件,不由某条工作项产出。 */
const D1 = art("d1", { workId: null, kind: "decision", title: "立项决策记录" });
const ARTS = [A1, A2, B1, D1];

const idleLive: DagLive = {
  runtime: "host",
  agents: [
    { agentId: "agent-worker", turn: null },
    { agentId: "agent-qa", turn: null },
  ],
};

const qaRunningLive: DagLive = {
  runtime: "host",
  agents: [
    { agentId: "agent-worker", turn: null },
    { agentId: "agent-qa", turn: { elapsedMs: 1000 } },
  ],
};

const unavailableLive: DagLive = { runtime: "unavailable", agents: [] };

type BodyProps = Parameters<typeof ArtifactsBody>[0];

function bodyProps(over: Partial<BodyProps> = {}): BodyProps {
  return {
    works: WORKS,
    artifacts: ARTS,
    live: null,
    picked: undefined,
    onPick: vi.fn(),
    openId: null,
    onToggleDetail: vi.fn(),
    ...over,
  };
}

const renderBody = (over: Partial<BodyProps> = {}): string =>
  renderToStaticMarkup(createElement(ArtifactsBody, bodyProps(over)));

/**
 * 取出某个节点卡片的那一段标记(`<button class="ss-dag-node">…</button>`)。
 *
 * 先按标题定位,再向左右扩到按钮边界 —— 这样「B 节点带没带呼吸点」这类断言不会
 * 被图例里那个同名的 `ss-live-dot` 命中。
 */
function nodeButton(html: string, title: string): string {
  const at = html.indexOf(title);
  expect(at, `夹具/渲染里没有节点标题「${title}」`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", at);
  const end = html.indexOf("</button>", at);
  expect(start, "标题不在任何 <button> 里 —— 节点卡片的结构变了").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(at);
  return html.slice(start, end);
}

const countOf = (html: string, re: RegExp): number => (html.match(re) ?? []).length;

// ── 判据 1:节点只挂自己的工件 ──────────────────────────────────

describe("① 节点只挂自己的工件(不许把整个项目的工件塞进每个节点)", () => {
  it("选中甲 ⇒ 只出现甲的工件;乙的工件标题不许出现", () => {
    const html = renderBody({ picked: "w1" });
    expect(html).toContain("甲的证据条目");
    expect(html).toContain("甲的工作简报");
    expect(html, "乙节点的工件漏进了甲节点的面板").not.toContain("乙的评审发现");
  });

  it("正样本:选中乙 ⇒ 乙的工件出现、甲的工件不出现(证明上一条不是空转)", () => {
    const html = renderBody({ picked: "w2" });
    expect(html).toContain("乙的评审发现");
    expect(html).not.toContain("甲的证据条目");
  });

  it("`WorkNodePanel` 拿到的就是「这一个环节」的工件(逐字用 `splitArtifactsByWork`)", () => {
    const split = splitArtifactsByWork(ARTS, WORKS);
    expect(split.byWork.get("w1")?.map((a) => a.title)).toEqual(["甲的证据条目", "甲的工作简报"]);
    const html = renderToStaticMarkup(
      createElement(WorkNodePanel, {
        work: W1,
        works: WORKS,
        artifacts: split.byWork.get("w1") ?? [],
        known: ARTS,
        openId: null,
        onToggleDetail: vi.fn(),
      }),
    );
    expect(html).toContain("甲的证据条目");
    expect(html).not.toContain("乙的评审发现");
    expect(html).not.toContain("立项决策记录");
  });
});

// ── 判据 2:无环节工件单独列 ────────────────────────────────────

describe("② 不挂在任何环节上的工件(workId: null)单独一块", () => {
  it("决策工件出现在那一块,而且**不在**它前面(节点/面板)的任何地方", () => {
    const html = renderBody({ picked: "w1" });
    const at = html.indexOf("不挂在任何环节上");
    expect(at, "没有「不挂在任何环节上」这一块").toBeGreaterThan(-1);

    const before = html.slice(0, at);
    expect(before, "无环节工件被塞进了 DAG / 环节面板").not.toContain("立项决策记录");

    const after = html.slice(at);
    expect(after, "无环节工件没有被列出来").toContain("立项决策记录");
    // 只出现一次:既没塞进节点,也没有在别处重复一遍。
    expect(countOf(html, /立项决策记录/g), "无环节工件出现了不止一次").toBe(1);
  });

  it("它自己带一句「本来就不由某条工作项产出」的说明(不许让读者以为漏了产出)", () => {
    const html = renderToStaticMarkup(
      createElement(UnattachedArtifacts, {
        artifacts: [D1],
        known: ARTS,
        openId: null,
        onToggleDetail: vi.fn(),
      }),
    );
    expect(html).toContain("本来就不由某条工作项产出");
    expect(html).toContain("立项决策记录");
  });

  it("负样本:挂着 workId 的工件**不许**混进这一块", () => {
    const split = splitArtifactsByWork(ARTS, WORKS);
    expect(split.noWork.map((a) => a.id)).toEqual(["d1"]);
    const html = renderToStaticMarkup(
      createElement(UnattachedArtifacts, {
        artifacts: split.noWork,
        known: ARTS,
        openId: null,
        onToggleDetail: vi.fn(),
      }),
    );
    expect(html).not.toContain("甲的证据条目");
    expect(html).not.toContain("乙的评审发现");
  });
});

// ── 判据 3:在跑标记 ────────────────────────────────────────────

describe("③ 在跑标记:只有真的有回合在跑的节点带 data-running / 呼吸点", () => {
  it("质检在跑 ⇒ 乙节点点亮;甲、丙**不带**(负样本)", () => {
    const html = renderBody({ live: qaRunningLive, picked: "w1" });
    expect(countOf(html, /data-running="true"/g), "点亮的节点不是恰好一个").toBe(1);

    const b = nodeButton(html, "环节乙");
    expect(b).toContain('data-running="true"');
    expect(b).toContain("ss-live-dot");

    const a = nodeButton(html, "环节甲");
    expect(a, "空闲节点被点亮了").toContain('data-running="false"');
    expect(a, "空闲节点带了呼吸点").not.toContain("ss-live-dot");

    const c = nodeButton(html, "环节丙");
    expect(c).not.toContain("ss-live-dot");
  });

  it("正样本基线:所有回合都空 ⇒ 一个都不点亮(证明上一条不是恒真)", () => {
    const html = renderBody({ live: idleLive, picked: "w1" });
    expect(countOf(html, /data-running="true"/g)).toBe(0);
  });

  it("`WorkDagCanvas` 是纯 props:直接喂布局 + live 也成立", () => {
    const layout = layoutWorkDag(WORKS, ARTS);
    const html = renderToStaticMarkup(
      createElement(WorkDagCanvas, {
        layout,
        live: qaRunningLive,
        selectedId: "w1",
        onSelect: vi.fn(),
      }),
    );
    expect(countOf(html, /data-running="true"/g)).toBe(1);
    expect(nodeButton(html, "环节甲")).toContain('data-selected="true"');
    expect(nodeButton(html, "环节乙")).toContain('data-selected="false"');
  });
});

// ── 判据 4:读不到 ≠ 空闲 ───────────────────────────────────────

describe("④ 「运行态读不到」不许被渲染成「空闲 / 没有在跑」", () => {
  /** 乙在库里是 in_progress —— 这一条考验的是「过去的状态」与「此刻」的分家。 */
  const works = [W1, work("w2", { title: "环节乙", status: "in_progress", assigneeAgentId: "agent-qa" })];

  it("runtime=unavailable ⇒ 页面上有「读不到」,且没有任何节点被点亮", () => {
    const html = renderBody({ works, live: unavailableLive, picked: null });
    expect(html, "读不到运行态时没有说实话").toContain("读不到");
    expect(countOf(html, /data-running="true"/g), "读不到的运行态被画成了「在跑」").toBe(0);
    // 库里的真状态照旧显示 —— 它是过去的事实,不是「此刻」。
    expect(html).toContain("进行中");
  });

  it("负样本:不许出现「空闲」「没有在跑」这类断言性文案", () => {
    const html = renderBody({ works, live: unavailableLive, picked: null });
    expect(html).not.toContain("空闲");
    expect(html).not.toContain("没有在跑");
  });

  it("正样本:live 是 host 且都空时,**不出现**「读不到」(证明上面那句是有条件的)", () => {
    const html = renderBody({ works, live: idleLive, picked: null });
    expect(html).not.toContain("读不到");
  });

  it("`live === null`(还没拿到过)同样按「读不到」处理,不按「没在跑」", () => {
    const html = renderBody({ works, live: null, picked: null });
    expect(html).toContain("读不到");
    expect(html).not.toContain("空闲");
  });
});

// ── 判据 5:工件计数 ────────────────────────────────────────────

describe("⑤ 节点上的「工件 N」= 该 workId 的真实工件数", () => {
  it("甲 2 件、乙 1 件、丙 0 件 —— 三个数都对得上", () => {
    const html = renderBody({ picked: "w1" });
    expect(nodeButton(html, "环节甲")).toMatch(/工件 <span[^>]*>2<\/span>/);
    expect(nodeButton(html, "环节乙")).toMatch(/工件 <span[^>]*>1<\/span>/);
    expect(nodeButton(html, "环节丙")).toMatch(/工件 <span[^>]*>0<\/span>/);
  });

  it("负样本:计数正则会区分节点(甲的「2」不该匹配到乙的按钮上)", () => {
    const html = renderBody({ picked: "w1" });
    expect(nodeButton(html, "环节乙")).not.toMatch(/工件 <span[^>]*>2<\/span>/);
  });

  it("没有工件的节点明显更安静(opacity 降下来),有功件的不降", () => {
    const html = renderBody({ picked: "w1" });
    expect(nodeButton(html, "环节丙")).toContain("opacity:0.55");
    expect(nodeButton(html, "环节甲")).not.toContain("opacity:0.55");
  });
});

// ── 判据 6:排不出先后时的诚实(含归因)─────────────────────────

describe("⑥ 排不出先后(Kahn 未出队):说明写出来,两个环节都不许丢", () => {
  const C1 = work("c1", { title: "环上的甲", dependsOn: ["c2"] });
  const C2 = work("c2", { title: "环上的乙", dependsOn: ["c1"] });

  it("布局自己先认出环(夹具自检:否则下面两条断言无意义)", () => {
    const layout = layoutWorkDag([C1, C2], []);
    expect([...layout.unlayeredIds].sort()).toEqual(["c1", "c2"]);
  });

  it("页面上出现「先后算不出来」,而且两个节点都还在", () => {
    const html = renderBody({ works: [C1, C2], artifacts: [], picked: null });
    expect(html).toContain("先后算不出来");
    expect(html).toContain("环上的甲");
    expect(html).toContain("环上的乙");
    expect(countOf(html, /class="ss-dag-node"/g), "环上的节点被丢了").toBe(2);
  });

  it("负样本:不成的两个环节**不许**出现这句说明", () => {
    const X = work("x1", { title: "正常甲" });
    const Y = work("x2", { title: "正常乙", dependsOn: ["x1"] });
    const html = renderBody({ works: [X, Y], artifacts: [], picked: null });
    expect(html).not.toContain("先后算不出来");
    expect(countOf(html, /class="ss-dag-node"/g)).toBe(2);
  });

  it("归因文案不许说「依赖成环」—— 环上/环下游才进这一列", () => {
    // 这一条钉的是 subagent 复核出来的**假归因**:更早一版用松弛迭代,把 `C` 也说成
    // 「依赖成环」,而 `C` 根本不在环上。文案相应只说「或环的下游」。
    //
    // ⚠️ 判据在 2026-10-06 又变过一次:**父边的方向改成「子 → 父」**(容器由子项
    // 推动)之后,`C`(环甲/环乙的子项)成了环的**上游**,它排得出来 ⇒ 不进这一列。
    // 所以这条用例现在钉的是「上游不连坐 + 文案仍然只说环上/环下游」。
    const A1 = work("a1", { title: "环甲", dependsOn: ["a2"] });
    const A2 = work("a2", { title: "环乙", dependsOn: ["a1"] });
    const C = work("c1", { title: "上游丙", parentWorkId: "a2" });
    const layout = layoutWorkDag([A1, A2, C], []);
    expect([...layout.unlayeredIds].sort(), "只有环上的两个进这一列").toEqual(["a1", "a2"]);
    expect(
      layout.nodes.find((n) => n.work.id === "c1")?.unlayered,
      "C 在环的上游(子先于父),不该被连坐",
    ).toBe(false);
    const html = renderBody({ works: [A1, A2, C], artifacts: [], picked: null });
    expect(html).toContain("或环的下游");
    expect(html, "对上游节点说「依赖成环」是一句假归因").not.toContain("(依赖成环)");
  });
});

// ── 页面的边界:没有工作项 / 悬挂的 workId ──────────────────────

describe("⑦ 边界:没有工作项时不许画空画布", () => {
  it("works 为空 ⇒ 不画画布(没有 ss-dag-node),但无环节工件照样列出来", () => {
    const html = renderBody({ works: [], artifacts: ARTS, picked: undefined });
    expect(countOf(html, /class="ss-dag-node"/g), "没有工作项却画出了节点").toBe(0);
    expect(html).toContain("不挂在任何环节上");
    expect(html).toContain("立项决策记录");
    // 挂在不存在的工作项上的工件也不许静默丢掉
    expect(html).toContain("本次读不到这条工作项");
  });
});

describe("⑧ 环节读不到的工件(workId 指向本次没读到的工作项)", () => {
  const ghost = art("g1", { workId: "w-gone", kind: "evidence", title: "幽灵环节的工件" });

  it("单独一块列出,并写明是「这条工作项本次读不到」,不是工件没有环节", () => {
    const split = splitArtifactsByWork([...ARTS, ghost], WORKS);
    expect([...split.dangling.keys()]).toEqual(["w-gone"]);
    const html = renderToStaticMarkup(
      createElement(DanglingArtifacts, {
        dangling: split.dangling,
        known: ARTS,
        openId: null,
        onToggleDetail: vi.fn(),
      }),
    );
    expect(html).toContain("w-gone");
    expect(html).toContain("本次读不到这条工作项");
    expect(html).toContain("幽灵环节的工件");
  });
});
