/**
 * 产出图布局的**纯函数**判据(`web/src/lib/workGraph.ts`)
 *
 * 为什么要单独一份(而不是只靠页面级的 SSR 断言):这一层是「画出来的图是不是
 * 真的等于库里的流程形状」的唯一落点。它一旦错,页面上表现为**一条线画歪了**
 * 或**少了一个节点** —— 两者都极难在截图里看出来,而它们都是假话:
 *
 *   ① 分层 = **按先后**(前置在前;子项在父项之前完成 —— 容器由子项推动),
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
    bodyPath: `artifacts/art_${id}.md`,
    bodyBytes: 0,
    commitSha: null,
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

describe("① 分层 = 按先后(前置在前;子项在父项之前)", () => {
  it("真机那份数据的形状:模块 → 节律 → 整合 → 交付,五条排成四列", () => {
    // 这一条是用户那句「现在的 dag 完全是乱的,你检查一下」的回归。
    // 真机五条:根 khu + 四个子项,且 khu 又 depends_on kv0(整合)。
    // ⚠️ 父边的方向是**子 → 父**(容器由子项推动),于是这份数据的先后是
    //    基础打断/全双工(0) → 节律(1) → 整合(2) → 交付(3) —— **没有环**。
    const works = [
      work("khu", { at: 1, deps: ["kv0"] }),
      work("mile", { parent: "khu", at: 2 }),
      work("mim", { parent: "khu", at: 3 }),
      work("kph", { parent: "khu", at: 4, deps: ["mim"] }),
      work("kv0", { parent: "khu", at: 5, deps: ["mile", "mim", "kph"] }),
    ];
    const layout = layoutWorkDag(works, []);
    const depth = new Map(layout.nodes.map((n) => [n.work.id, n.depth]));

    expect(depth.get("mile")).toBe(0);
    expect(depth.get("mim"), "全双工与基础打断同时起头").toBe(0);
    expect(depth.get("kph"), "节律等全双工").toBe(1);
    expect(depth.get("kv0"), "整合等前三个").toBe(2);
    expect(depth.get("khu"), "交付(容器)在最后").toBe(3);
    expect(layout.layers, "四列,不是一列").toBe(4);
    expect(layout.unlayeredIds, "这份数据里**没有**排不出先后的节点").toEqual([]);
    expect(layout.mutualPairs, "也没有互相咬住的边").toEqual([]);
    // 没有任何节点被迫进尾列(旧实现的形态:五个全在一列)
    const tail = Math.max(...layout.nodes.map((n) => n.depth));
    expect(layout.nodes.filter((n) => n.depth === tail).length).toBe(1);
  });

  it("**每条边都从左指向右**(分层的最长路径保证;反向边=读者会读错的那种图)", () => {
    const layout = layoutWorkDag(realShape(), []);
    const depth = new Map(layout.nodes.map((n) => [n.work.id, n.depth]));
    expect(layout.edges.length, "夹具里的边数(4 条父 + 4 条前置)").toBe(8);
    for (const e of layout.edges) {
      expect(
        depth.get(e.to)!,
        `${e.kind} 边 ${e.from}→${e.to} 画成了反向`,
      ).toBeGreaterThan(depth.get(e.from)!);
    }
  });

  it("x/y 由层与层内序号算出来,画布尺寸容得下所有节点", () => {
    const layout = layoutWorkDag(realShape(), []);
    const a = layout.nodes.find((n) => n.work.id === "a");
    const root = layout.nodes.find((n) => n.work.id === "root");
    expect(a?.x, "第 0 列在最左").toBe(DAG_PAD);
    expect(root?.x, "根(容器)在最右的第 3 列").toBe(DAG_PAD + 3 * (DAG_NODE_W + DAG_COL_GAP));
    for (const n of layout.nodes) {
      expect(n.x + DAG_NODE_W).toBeLessThanOrEqual(layout.width);
      expect(n.y + DAG_NODE_H).toBeLessThanOrEqual(layout.height);
    }
    // 同层不重叠:相邻行的间距**正好**是「节点高 + 行距」
    const layer0 = layout.nodes.filter((n) => n.depth === 0).sort((p, q) => p.y - q.y);
    expect(layer0.length, "第 0 列是两个同时起头的子项").toBe(2);
    expect((layer0[1]?.y ?? 0) - (layer0[0]?.y ?? 0)).toBe(DAG_NODE_H + DAG_ROW_GAP);
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
  it("父子边与依赖边分开保留,而且**父边的方向是子 → 父**", () => {
    const { edges } = layoutWorkDag(realShape(), []);
    const kinds = new Set(edges.map((e) => `${e.from}->${e.to}:${e.kind}`));
    expect(kinds.has("a->root:parent"), "父边从子项指向父项(先后方向)").toBe(true);
    expect(kinds.has("root->a:parent"), "反过来写就把「交付在最后」读成「交付在最前」").toBe(false);
    expect(kinds.has("b->c:depends_on")).toBe(true);
    // c 既在 root 下、又依赖 b ⇒ 两条边都在
    expect(kinds.has("c->root:parent")).toBe(true);
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

describe("③ 排不出先后:真环仍然被报出来,而且**说出是哪两条边**", () => {
  it("两条前置互相指 ⇒ 两个节点都保留、都标 unlayered、同处尾列", () => {
    const layout = layoutWorkDag(
      [work("a", { deps: ["b"], at: 1 }), work("b", { deps: ["a"], at: 2 })],
      [],
    );
    expect(layout.nodes.length, "拓扑排序的实现常见错法是环上节点静默不进结果 —— 这里必须都在").toBe(2);
    expect(layout.unlayeredIds.sort()).toEqual(["a", "b"]);
    for (const n of layout.nodes) expect(n.unlayered).toBe(true);
    expect(layout.layers, "没有可分层 ⇒ 只有那一个尾列").toBe(1);
    expect(new Set(layout.nodes.map((n) => n.depth)).size, "它们同处一列").toBe(1);
    // 病灶:一对边,两条 kind 都是前置
    expect(layout.mutualPairs.length).toBe(1);
    expect([layout.mutualPairs[0]!.ab, layout.mutualPairs[0]!.ba]).toEqual([
      "depends_on", "depends_on",
    ]);
  });

  it("⚠️ 归因精度:环**上游**的节点照常分层(它不依赖环能不能解开)", () => {
    // C 是 B 的子项 ⇒ 父边是 C→B(子先于父)⇒ C 在环之前,排得出来。
    // (旧实现把「环下游」的节点也塞进尾列;方向改成先后之后,上游不再被连坐。)
    const layout = layoutWorkDag(
      [
        work("a", { deps: ["b"], at: 1 }),
        work("b", { deps: ["a"], at: 2 }),
        work("c", { parent: "b", at: 3 }),
      ],
      [],
    );
    expect([...layout.unlayeredIds].sort()).toEqual(["a", "b"]);
    const c = layout.nodes.find((n) => n.work.id === "c")!;
    expect(c.unlayered, "C 在环的上游,不该被标成排不出先后").toBe(false);
    expect(c.depth).toBe(0);
    expect(layout.layers, "正常层 1 + 尾列 1").toBe(2);
  });

  it("**互相咬住的一对边**要说清 kind:拆解与前置方向相反才是环", () => {
    // khu 是 kv0 的父(父边 kv0→khu);而 kv0 depends_on khu(前置边 khu→kv0)⇒ 相反。
    const layout = layoutWorkDag(
      [work("khu", { at: 1 }), work("kv0", { parent: "khu", at: 2, deps: ["khu"] })],
      [],
    );
    expect(layout.mutualPairs.length, "闭环的那一对只报一次").toBe(1);
    const pair = layout.mutualPairs[0]!;
    expect([pair.a, pair.b].sort()).toEqual(["khu", "kv0"]);
    expect([pair.ab, pair.ba].sort()).toEqual(["depends_on", "parent"]);
    expect([...layout.unlayeredIds].sort()).toEqual(["khu", "kv0"]);
  });

  it("✅ 负样本:「拆解 + 前置」方向**一致**时不是环(真机那份数据就是这样)", () => {
    // khu 是 kv0 的父(子→父:kv0→khu),同时 khu depends_on kv0(前置:kv0→khu)
    // ⇒ 两条边同向,先后关系自洽,不该报环。
    const layout = layoutWorkDag(
      [work("khu", { at: 1, deps: ["kv0"] }), work("kv0", { parent: "khu", at: 2 })],
      [],
    );
    expect(layout.mutualPairs).toEqual([]);
    expect(layout.unlayeredIds).toEqual([]);
    const depth = new Map(layout.nodes.map((n) => [n.work.id, n.depth]));
    expect(depth.get("kv0")).toBe(0);
    expect(depth.get("khu")).toBe(1);
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
