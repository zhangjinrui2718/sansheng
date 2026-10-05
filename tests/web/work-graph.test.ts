/**
 * 产出图布局的**纯函数**判据(`web/src/lib/workGraph.ts`)
 *
 * 为什么要单独一份(而不是只靠页面级的 SSR 断言):这一层是「画出来的图是不是
 * 真的等于库里的流程形状」的唯一落点。它一旦错,页面上表现为**一条线画歪了**
 * 或**少了一个节点** —— 两者都极难在截图里看出来,而它们都是假话:
 *
 *   ① 分层必须是**最长路径**(不是父深度 + 1),否则跨层依赖会反向画;
 *   ② 边去重、去自环 —— 真机库的 `work_deps` 里同一条边出现过两次;
 *   ③ **有环就说有环**,而且环上的节点**一个都不许丢**(拓扑排序会在环上
 *      静默丢节点,那种「少了一条工作项」在界面上几乎看不出来);
 *   ④ 工件分三堆(`挂着的` / `本来就没环节的` / `挂到读不到的环节上的`),
 *      后两堆必须分开 —— 混在一起会让人以为「漏了几条产出」。
 *
 * 夹具直接用真实库的形状(2026-10-05 的 `pj_muv…`:1 根 + 4 子 + 5 条依赖边,
 * 20 件工件里 14 件有产出边),因为这些边界就是从那份数据上长出来的。
 */
import { describe, expect, it } from "vitest";
import type { ArtifactView, WorkView } from "@shared/types/platform";
import {
  DAG_COL_GAP,
  DAG_NODE_H,
  DAG_NODE_W,
  DAG_PAD,
  DAG_ROW_GAP,
  layoutWorkDag,
  splitArtifactsByWork,
  workRunningState,
} from "@/lib/workGraph";

// ── 夹具 ────────────────────────────────────────────────────────

function work(
  id: string,
  over: { parent?: string | null; deps?: string[]; status?: WorkView["status"]; at?: number } = {},
): WorkView {
  return {
    id,
    projectId: "p1",
    parentWorkId: over.parent ?? null,
    title: `环节 ${id}`,
    goal: "",
    status: over.status ?? "open",
    assigneeAgentId: "wk",
    assigneeName: "工程师",
    createdAt: over.at ?? 1000,
    updatedAt: over.at ?? 1000,
    dependsOn: over.deps ?? [],
  };
}

function artifact(id: string, workId: string | null, kind: ArtifactView["kind"] = "evidence"): ArtifactView {
  return {
    id,
    projectId: "p1",
    kind,
    status: "open",
    title: `工件 ${id}`,
    body: "",
    authorAgentId: "wk",
    authorName: "工程师",
    createdAt: 2000,
    updatedAt: 2000,
    links: [],
    workId,
  };
}

/** 真机库的形状:根 + 三个并行子项 + 一个整合项(依赖那三个)。 */
function realShape(): WorkView[] {
  return [
    work("root", { at: 1 }),
    work("a", { parent: "root", at: 2 }),
    work("b", { parent: "root", at: 3 }),
    work("c", { parent: "root", at: 4, deps: ["b"] }),
    work("integrate", { parent: "root", at: 5, deps: ["a", "b", "c"] }),
  ];
}

// ── ① 分层 ──────────────────────────────────────────────────────

describe("① 最长路径分层", () => {
  it("跨层依赖把目标推到**更长**的那一层(不能只看父节点深度)", () => {
    const { nodes } = layoutWorkDag(realShape(), []);
    const at = (id: string) => nodes.find((n) => n.work.id === id);

    // root=0;a/b/c=1;integrate 依赖 a/b/c ⇒ 2(它同时也挂在 root 下,
    // 只看 `parentWorkId` 会得出 1 —— 那就是「反向边」的来源)
    expect(at("root")?.depth).toBe(0);
    expect(at("a")?.depth).toBe(1);
    expect(at("c")?.depth, "c 依赖 b ⇒ 必须在 b 右边").toBe(2);
    expect(at("integrate")?.depth).toBe(3);
    // 正样本自检:`dependsOn` 真的参与分层了 —— 否则 integrate 只会是 1
    expect(at("integrate")?.depth).not.toBe(1);
  });

  it("x/y 由层与层内序号算出来,画布尺寸容得下所有节点", () => {
    const layout = layoutWorkDag(realShape(), []);
    const root = layout.nodes.find((n) => n.work.id === "root");
    const a = layout.nodes.find((n) => n.work.id === "a");
    expect(root?.x).toBe(DAG_PAD);
    expect(a?.x).toBe(DAG_PAD + (DAG_NODE_W + DAG_COL_GAP));
    expect(layout.width).toBeGreaterThanOrEqual(
      DAG_PAD * 2 + layout.layers * DAG_NODE_W + (layout.layers - 1) * DAG_COL_GAP,
    );
    for (const n of layout.nodes) {
      expect(n.x + DAG_NODE_W).toBeLessThanOrEqual(layout.width);
      expect(n.y + DAG_NODE_H).toBeLessThanOrEqual(layout.height);
    }
    // 同层不重叠:相邻行的间距**正好**是「节点高 + 行距」(写死一个小上界
    // 会让这条断言在布局把间距算错时照样绿)
    const layer1 = layout.nodes.filter((n) => n.depth === 1).sort((p, q) => p.y - q.y);
    expect(layer1.length).toBe(2);
    expect((layer1[1]?.y ?? 0) - (layer1[0]?.y ?? 0)).toBe(DAG_NODE_H + DAG_ROW_GAP);
  });

  it("层内顺序稳定:同一份数据两次布局,坐标逐项相同", () => {
    const first = layoutWorkDag(realShape(), []);
    const second = layoutWorkDag(realShape(), []);
    expect(second.nodes.map((n) => `${n.work.id}@${n.x},${n.y}`)).toEqual(
      first.nodes.map((n) => `${n.work.id}@${n.x},${n.y}`),
    );
  });
});

// ── ② 边 ────────────────────────────────────────────────────────

describe("② 边:去重、去自环、不画幽灵线,并且如实报出丢了几条", () => {
  it("父子边与依赖边分开保留(同两个节点之间两条语义不同)", () => {
    const { edges } = layoutWorkDag(realShape(), []);
    const kinds = new Set(edges.map((e) => `${e.from}->${e.to}:${e.kind}`));
    expect(kinds.has("root->a:parent")).toBe(true);
    expect(kinds.has("b->c:depends_on")).toBe(true);
    // c 既在 root 下、又依赖 b ⇒ 两条边都在
    expect(kinds.has("root->c:parent")).toBe(true);
  });

  it("重复的依赖边画一条(真机库里有 `A→B` 出现两次的行)", () => {
    const works = [work("a", { at: 1 }), work("b", { at: 2, deps: ["a", "a"] })];
    const layout = layoutWorkDag(works, []);
    expect(layout.edges.filter((e) => e.kind === "depends_on").length).toBe(1);
    expect(layout.droppedEdges, "被丢掉的重复边要记账").toBe(1);
  });

  it("自环不画,并且记账", () => {
    const layout = layoutWorkDag([work("a", { deps: ["a"] })], []);
    expect(layout.edges.length).toBe(0);
    expect(layout.droppedEdges).toBe(1);
  });

  it("指向**不在本次列表里**的工作项的边不画(不生成幽灵节点)", () => {
    const layout = layoutWorkDag([work("a", { deps: ["不存在"] })], []);
    expect(layout.nodes.map((n) => n.work.id)).toEqual(["a"]);
    expect(layout.edges.length).toBe(0);
    expect(layout.droppedEdges).toBe(1);
  });
});

// ── ③ 环 ────────────────────────────────────────────────────────

describe("③ 排不出先后:说清先后算不出来,但**一个节点都不许丢**", () => {
  it("两个节点互相依赖 ⇒ 都保留、都标 unlayered、分层数收敛", () => {
    const layout = layoutWorkDag(
      [work("a", { deps: ["b"], at: 1 }), work("b", { deps: ["a"], at: 2 })],
      [],
    );
    expect(layout.nodes.length, "拓扑排序的实现常见错法是环上节点静默不进结果 —— 这里必须都在").toBe(2);
    expect(layout.unlayeredIds.sort()).toEqual(["a", "b"]);
    for (const n of layout.nodes) expect(n.unlayered).toBe(true);
    // 排不出先后的节点排在**单独一层**(正常的层之后)
    expect(layout.layers).toBe(1);
    expect(new Set(layout.nodes.map((n) => n.depth)).size, "它们同处一列").toBe(1);
  });

  it("环 + 正常节点并存:正常的那几个照常分层,不许被环拖成同一层", () => {
    const layout = layoutWorkDag(
      [work("x", { at: 1 }), work("y", { parent: "x", at: 2 }), work("a", { deps: ["b"], at: 3 }), work("b", { deps: ["a"], at: 4 })],
      [],
    );
    const at = (id: string) => layout.nodes.find((n) => n.work.id === id);
    expect(at("x")?.depth).toBe(0);
    expect(at("y")?.depth).toBe(1);
    expect(layout.unlayeredIds.sort()).toEqual(["a", "b"]);
    expect(at("a")?.unlayered).toBe(true);
    expect(at("y")?.unlayered).toBe(false);
    // 正常层 2 层 + 排不出先后的那 1 列
    expect(layout.layers).toBe(3);
  });

  it("⚠️ 归因精度:环的**下游**节点也排不出先后,但它不在环上", () => {
    // 这一条钉的是 subagent 复核出来的假归因(旧实现用松弛迭代 + 「最后一轮还在
    // 变」近似,会把下游节点算成环成员)。Kahn 的未出队集合的**语义**恰好是
    // 「环上 ∪ 环下游」—— 所以集合不变,但**措辞**必须只说「排不出先后」。
    const layout = layoutWorkDag(
      [work("a", { deps: ["b"], at: 1 }), work("b", { deps: ["a"], at: 2 }), work("c", { parent: "b", at: 3 })],
      [],
    );
    expect([...layout.unlayeredIds].sort()).toEqual(["a", "b", "c"]);
    // 边界样本:环下游的**下游**同样排不出来(深度在环上无界),Kahn 也照收
    const chain = layoutWorkDag(
      [
        work("a", { deps: ["b"], at: 1 }),
        work("b", { deps: ["a"], at: 2 }),
        work("c", { parent: "b", at: 3 }),
        work("d", { parent: "c", at: 4 }),
      ],
      [],
    );
    expect([...chain.unlayeredIds].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

// ── ④ 工件三堆 ──────────────────────────────────────────────────

describe("④ 工件分三堆:挂着的 / 本来就没环节的 / 挂到读不到环节上的", () => {
  it("`workId: null` 的决策工件进 `noWork`,**不许**混进任何一个节点", () => {
    const works = [work("a")];
    const { byWork, noWork, dangling } = splitArtifactsByWork(
      [artifact("e1", "a"), artifact("d1", null, "decision")],
      works,
    );
    expect(byWork.get("a")?.map((x) => x.id)).toEqual(["e1"]);
    expect(noWork.map((x) => x.id)).toEqual(["d1"]);
    expect(dangling.size).toBe(0);
  });

  it("`workId` 指向读不到的环节 ⇒ 单独一堆(不塞进 noWork,也不假装是自己的产出)", () => {
    const { byWork, noWork, dangling } = splitArtifactsByWork(
      [artifact("e1", "a"), artifact("ghost", "已删除的环节")],
      [work("a")],
    );
    expect(byWork.get("a")?.length).toBe(1);
    expect(noWork.length, "「环节读不到」≠「本来就没环节」—— 两者必须分开").toBe(0);
    expect([...dangling.keys()]).toEqual(["已删除的环节"]);
    expect(dangling.get("已删除的环节")?.map((x) => x.id)).toEqual(["ghost"]);
  });

  it("真机形状:14 件有产出边、6 件决策 ⇒ 分堆后一件不丢", () => {
    const works = realShape();
    const artifacts: ArtifactView[] = [
      ...Array.from({ length: 6 }, (_, i) => artifact(`ev${i}`, "a")),
      ...Array.from({ length: 7 }, (_, i) => artifact(`rf${i}`, "b", "review_finding")),
      artifact("dl", "integrate", "deliverable"),
      ...Array.from({ length: 6 }, (_, i) => artifact(`dec${i}`, null, "decision")),
    ];
    const { byWork, noWork, dangling } = splitArtifactsByWork(artifacts, works);
    const total = [...byWork.values()].reduce((n, xs) => n + xs.length, 0) + noWork.length + [...dangling.values()].reduce((n, xs) => n + xs.length, 0);
    expect(total, "分堆是划分,不是筛选").toBe(20);
    expect(noWork.length).toBe(6);
    expect(byWork.get("a")?.length).toBe(6);
  });
});

// ── ⑤ 「在跑」判据 ──────────────────────────────────────────────

describe("⑤ `workRunningState`:`读不到` 不是 `空闲`", () => {
  it("宿主说这个角色的回合在跑 ⇒ running(即使工作项还没被置 in_progress)", () => {
    const st = workRunningState(work("a"), {
      runtime: "host",
      agents: [{ agentId: "wk", turn: { elapsedMs: 1000 } }],
    });
    expect(st).toEqual({ running: true, unknown: false });
  });

  it("库里是 in_progress(宿主这个进程没登记回合)也 ⇒ running", () => {
    const st = workRunningState(work("a", { status: "in_progress" }), {
      runtime: "host",
      agents: [{ agentId: "wk", turn: null }],
    });
    expect(st.running).toBe(true);
    expect(st.unknown).toBe(false);
  });

  it("`runtime: unavailable` ⇒ **unknown**,而不是「没在跑」", () => {
    const st = workRunningState(work("a"), {
      runtime: "unavailable",
      agents: [{ agentId: "wk", turn: null }],
    });
    expect(st.unknown, "读不到运行态必须被标成读不到").toBe(true);
    expect(st.running, "但库里的 in_progress 仍然算在跑").toBe(false);
  });

  it("live 还没拿到(null)⇒ unknown(不是「空闲」)", () => {
    expect(workRunningState(work("a"), null)).toEqual({ running: false, unknown: true });
  });
});
