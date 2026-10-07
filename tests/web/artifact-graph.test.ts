/**
 * 工件关系图(`lib/artifactGraph.ts`)的判据测试 —— **纯函数**,不起服务
 *
 * ── 夹具的形状照抄真机库(2026-10-06 14:10 查的)────────────────────
 *
 * 美股项目那一份:`11` 条 `depends_on`(交付物 ← 它的依据)、`2` 条 `answers`
 * (答复 ← 提问)、**0** 条逻辑关系、**0** 条 `parent`(闭集里有、全仓零写入侧),
 * 以及 **8 条 decision + 3 条 client_question 没有 `work_id`** ——
 * 最后这一点是换图的**首要理由**:在「节点 = 环节」的旧图上它们一个节点都没有。
 *
 * ── 这个文件钉的五件事 ──────────────────────────────────────────
 *
 *  ① **方向归一**:库里 `A depends_on B`(B 在前)画出来必须是 `B → A`。
 *     三类边全是因果边,全部指向「后发生的那件」—— 这条是「按时间分层不交叉」
 *     的唯一前提,错了整张图的读法就反了。
 *  ② **一件工件都不许丢**:孤点也画。甲方拍的那条决策在图上消失,正是换图要修的。
 *  ③ **三类异常分流**:反向边 / 悬空目标 / 成环 —— 各自报出,不混成一句。
 *  ④ **不丢边也不重复**:真机上 `A → B` 出现过两行(migration 无 UNIQUE)。
 *  ⑤ **未知 rel 原样跳过**:契约是闭集,出现未知值是前后端漂了,不该由本函数猜。
 */
import { describe, it, expect } from "vitest";
import type { ArtifactView, WorkView } from "@shared/types/platform";
import {
  AG_NODE_H,
  AG_NODE_W,
  LOGICAL_RELATION_NOTE,
  RELATIONS,
  isIsolated,
  layoutArtifactGraph,
  type ArtifactRelation,
} from "@/lib/artifactGraph";

const T0 = Date.parse("2026-10-06T08:42:00+08:00");
const MIN = 60_000;

function art(
  id: string,
  kind: ArtifactView["kind"],
  at: number,
  over: Partial<ArtifactView> = {},
): ArtifactView {
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
    createdAt: at,
    updatedAt: at,
    links: [],
    workId: null,
    ...over,
  };
}

/** 真机形状:7 条子项 evidence + 7 份 pm deliverable + 2 对问答 + 1 条审查不通过。 */
function realShape(): ArtifactView[] {
  const rows: ArtifactView[] = [];
  const letters = ["W1", "W2", "W3", "W4", "W5", "W6", "W7"];
  letters.forEach((n, i) => {
    const at = T0 + i * MIN;
    const ev = `art_${n}`;
    const dl = `deliv_${n}`;
    rows.push(art(ev, "evidence", at, { workId: `wk_${n}`, title: `${n} 调研报告` }));
    // ⚠️ 方向是「交付物 **depends_on** 依据」—— 依据在前、结论在后。
    rows.push(
      art(dl, "deliverable", at + 30_000, {
        workId: "wk_root",
        title: `${n} 整合结论`,
        links: [{ rel: "depends_on", targetId: ev }],
      }),
    );
  });
  // 甲方问答:提问 → 答复(库里存的是「答复 answers 提问」)
  rows.push(art("q1", "client_question", T0 + 100 * MIN, { title: "W1 您倾向哪种?" }));
  rows.push(
    art("d1", "decision", T0 + 101 * MIN, {
      title: "甲方答复:W1",
      links: [{ rel: "answers", targetId: "q1" }],
    }),
  );
  // **不挂任何工作项**的那些(旧图上完全没有它们)
  rows.push(art("q2", "client_question", T0 + 140 * MIN, { title: "W2 您倾向哪种档位?" }));
  rows.push(
    art("d2", "decision", T0 + 141 * MIN, {
      title: "甲方答复:W2",
      links: [{ rel: "answers", targetId: "q2" }],
    }),
  );
  // 质检的不通过(真机 08:57 那一件)
  rows.push(
    art("rf_root", "review_finding", T0 + 15 * MIN, { workId: "wk_root", title: "W0 审查不通过" }),
  );
  return rows;
}

function works(): WorkView[] {
  return [
    { id: "wk_root", projectId: "p1", parentWorkId: null, title: "整合与最终交付", goal: "",
      status: "done", assigneeAgentId: "pm", assigneeName: "项目经理",
      createdAt: T0, updatedAt: T0 + 18 * MIN, dependsOn: [] },
  ];
}

// ── ① 方向归一 ──────────────────────────────────────────────────

describe("① 方向:三类边都从「因」指向「果」", () => {
  it("`depends_on` 库里是「交付物依赖依据」,画出来是 依据 → 交付物", () => {
    const l = layoutArtifactGraph(realShape(), works());
    const e = l.edges.find((x) => x.rel === "depends_on" && x.to === "deliv_W1");
    expect(e, "W1 那条依赖边没画").toBeDefined();
    expect(e!.from).toBe("art_W1");
    // 负样本:不能画成库里的那个方向
    expect(e!.from).not.toBe("deliv_W1");
  });

  it("`answers` 库里是「答复回应提问」,画出来是 提问 → 答复", () => {
    const l = layoutArtifactGraph(realShape(), works());
    const e = l.edges.find((x) => x.rel === "answers" && x.to === "d1");
    expect(e!.from).toBe("q1");
  });

  it("三类边的 `reversed` 与 README 里的表一致(**别把方向改反了还留着旧注释**)", () => {
    expect(RELATIONS.depends_on.reversed).toBe(true);
    expect(RELATIONS.answers.reversed).toBe(true);
    expect(RELATIONS.parent.reversed).toBe(false);
  });

  it("分层单调于时间:每条边都从更早的指向更晚的(不交叉的性质靠这条成立)", () => {
    const arts = realShape();
    const at = new Map(arts.map((a) => [a.id, a.createdAt]));
    for (const e of layoutArtifactGraph(arts, works()).edges) {
      expect(at.get(e.from)!, `${e.rel} ${e.from}→${e.to} 指向了更晚的一端`)
        .toBeLessThanOrEqual(at.get(e.to)!);
    }
  });
});

// ── ② 一件都不许丢 ──────────────────────────────────────────────

describe("② 孤点也画 —— 甲方拍的那条决策不许从图上消失", () => {
  it("节点数 = 输入件数(夹具 22 件,一件不多一件不少)", () => {
    const arts = realShape();
    const l = layoutArtifactGraph(arts, works());
    // 7 evidence + 7 deliverable + 2 提问 + 2 答复 + 1 审查发现 = 19
    expect(arts).toHaveLength(19);
    expect(l.nodes).toHaveLength(19);
    expect(l.artifactCount).toBe(19);
  });

  it("不挂工作项的 decision / client_question **照样有节点**(旧图上它们一个都没有)", () => {
    const l = layoutArtifactGraph(realShape(), works());
    for (const id of ["d1", "d2", "q1", "q2"]) {
      expect(l.nodes.some((n) => n.artifact.id === id), `${id} 在图上消失了`).toBe(true);
    }
  });

  it("没有任何边的工件在图上是 `isolated` 标记 + 入出度都是 0", () => {
    const arts = [art("lonely", "decision", T0), art("q", "client_question", T0, {
      links: [{ rel: "answers", targetId: "lonely" }],
    })];
    const l = layoutArtifactGraph(arts);
    // 两条其实有边 —— 换个真正孤的
    const l2 = layoutArtifactGraph([art("alone", "note", T0)]);
    const n = l2.nodes[0]!;
    expect(n.inDegree).toBe(0);
    expect(n.outDegree).toBe(0);
    expect(isIsolated(l2)).toBe(true);
  });

  it("全图零边时 `isIsolated` 为真(页面据此说明「是数据没记」)", () => {
    expect(isIsolated(layoutArtifactGraph([art("a", "note", T0)]))).toBe(true);
    expect(isIsolated(layoutArtifactGraph(realShape(), works()))).toBe(false);
  });
});

// ── ③ 三类异常分流 ──────────────────────────────────────────────

describe("③ 反向边 / 悬空目标 / 成环:各报各的,不混成一句", () => {
  it("**反向边不画**,并如实报出来(「从左到右读先后」这句话在有它时不成立)", () => {
    // 库里的 `depends_on` 指向一个**更晚**的工件 ⇒ 归一后成了一条「果 → 因」
    const arts = [
      art("early", "evidence", T0),
      art("late", "deliverable", T0 + 10 * MIN, {
        links: [{ rel: "depends_on", targetId: "early" }],
      }),
      art("back", "deliverable", T0 + 20 * MIN, {
        links: [{ rel: "parent", targetId: "late" }], // parent 不反向 ⇒ late 在前,正常
      }),
    ];
    // 真正反向的那条:早的 a 声称 depends_on 更晚的 b ⇒ 归一后是 b → a(果→因)
    const rev = layoutArtifactGraph([
      art("a", "evidence", T0, { links: [{ rel: "depends_on", targetId: "b" }] }),
      art("b", "deliverable", T0 + 10 * MIN), // a(早) 依赖 b(晚) ⇒ 反向
    ]);
    expect(rev.backwardEdges).toHaveLength(1);
    expect(rev.edges, "反向边不许被画出来").toHaveLength(0);
    expect(rev.backwardEdges[0]!.rel).toBe("depends_on");
    expect(arts).toHaveLength(3);
  });

  it("悬空目标(本次没读到)不画,并报出来 —— 不是丢一条边假装图完整", () => {
    const l = layoutArtifactGraph([
      art("a", "deliverable", T0, { links: [{ rel: "depends_on", targetId: "ghost" }] }),
    ]);
    expect(l.edges).toHaveLength(0);
    expect(l.dangling).toHaveLength(1);
    expect(l.dangling[0]!.to).toBe("ghost");
  });

  it("成环的节点进 `unlayeredIds`,并**被排到第 0 列**(别按左右读它们的先后)", () => {
    // ⚠️ **必须同一毫秒**:跨时刻的环必然有一条「果 → 因」的边,那条边被纪律①
    // 先剔掉了,于是环根本到不了 Kahn —— 那是**正确**行为(因果图上不该有环),
    // 不是判据没跑。所以这里用同刻节点造出真正的环。
    const l = layoutArtifactGraph([
      art("x", "evidence", T0, { links: [{ rel: "parent", targetId: "y" }] }),
      art("y", "evidence", T0, { links: [{ rel: "parent", targetId: "x" }] }),
    ]);
    expect(l.unlayeredIds.sort()).toEqual(["x", "y"]);
    for (const n of l.nodes) expect(n.depth).toBe(0);
    for (const n of l.nodes) expect(n.unlayered).toBe(true);
  });

  it("**假归因的负样本**:环的**下游**不许被说成「在环上」", () => {
    // z 依赖 x,y;而 x↔y 成环 ⇒ Kahn 分不出 z,但 z 并不在环上。
    const l = layoutArtifactGraph([
      art("x", "evidence", T0, { links: [{ rel: "parent", targetId: "y" }] }),
      art("y", "evidence", T0, { links: [{ rel: "parent", targetId: "x" }] }),
      art("z", "deliverable", T0 + 2 * MIN, { links: [{ rel: "parent", targetId: "x" }] }),
    ]);
    // z 的父边方向归一后是 x → z(早→晚),不反向,所以它进得了图;但 x,y 互咬
    expect(l.unlayeredIds.sort()).toEqual(["x", "y"]);
    expect(l.unlayeredIds, "z 在环下游但**不在环上**,两者都被归到同一列 —— 判据是「排不出先后」").not.toContain("z");
  });
});

// ── ④ 不丢边也不重复 ────────────────────────────────────────────

describe("④ 重复边去重(真机上 `A → B` 出现过两行,migration 无 UNIQUE)", () => {
  it("同一对同一 rel 画一条,`stats` 也只计一次", () => {
    const l = layoutArtifactGraph([
      art("a", "evidence", T0),
      art("b", "deliverable", T0 + MIN, {
        links: [
          { rel: "depends_on", targetId: "a" },
          { rel: "depends_on", targetId: "a" },
        ],
      }),
    ]);
    expect(l.edges.filter((e) => e.rel === "depends_on")).toHaveLength(1);
    expect(l.stats.depends_on).toBe(1);
  });

  it("自环被丢掉(库里有 CHECK 挡着,这里兜底)", () => {
    const l = layoutArtifactGraph([
      art("a", "note", T0, { links: [{ rel: "parent", targetId: "a" }] }),
    ]);
    expect(l.edges).toHaveLength(0);
    expect(l.nodes).toHaveLength(1);
  });

  it("真机形状:7 条 `depends_on` + 7 条派生的「质检所审」+ 2 条 `answers`,`parent` 0 条", () => {
    const l = layoutArtifactGraph(realShape(), works());
    expect(l.stats.depends_on).toBe(7);
    expect(l.stats.answers).toBe(2);
    expect(l.stats.parent).toBe(0);
    // ⚠️ 「质检所审」是**派生**的,不在 `links` 里 —— 夹具里它一条都没写。
    // rf_root(T0+15m)挂着 wk_root,wk_root 上只有 7 份 deliverable(都在 T0+30s 起,
    // 比它早)⇒ 连 7 条。这正是真机 08:53 那批的形状:审查挂根、根上只有整合稿。
    expect(l.stats.review_about).toBe(7);
    expect(l.edges).toHaveLength(16);
    // rf_root 指向 7 份整合稿 ⇒ **一个多目标集合**;界面上要写出来
    expect(l.multiTargetReviews).toBe(1);
  });

  it("**负样本:审查当时还不存在的产出不算它审过的**(方向反了就编出关系)", () => {
    // finding 在 T0;同一条工作项上另有一件产出在 T0+10m(之后才有)
    const l = layoutArtifactGraph([
      art("late", "deliverable", T0 + 10 * MIN, { workId: "wk" }),
      art("f", "review_finding", T0, { workId: "wk" }),
    ]);
    expect(l.stats.review_about, "它审的是一份还不存在的东西").toBe(0);
  });

  it("正样本:审查当时的产出连得上(上一条的对照,证明它不是恒 0)", () => {
    const l = layoutArtifactGraph([
      art("early", "evidence", T0, { workId: "wk" }),
      art("f", "review_finding", T0 + MIN, { workId: "wk" }),
    ]);
    expect(l.stats.review_about).toBe(1);
    expect(l.edges[0]).toMatchObject({ from: "early", to: "f", rel: "review_about" });
  });

  it("多目标时要报出来(集合关系:每条边都真,但没有一条能说「就是这一份」)", () => {
    const l = layoutArtifactGraph([
      art("e1", "evidence", T0, { workId: "wk" }),
      art("e2", "evidence", T0 + MIN, { workId: "wk" }),
      art("f", "review_finding", T0 + 2 * MIN, { workId: "wk" }),
    ]);
    expect(l.stats.review_about).toBe(2);
    expect(l.multiTargetReviews).toBe(1);
  });
});

// ── ⑤ 未知 rel 与契约漂移 ───────────────────────────────────────

describe("⑤ 未知 rel 原样跳过,不塞进任何一类", () => {
  it("出现契约外的 rel ⇒ 不画、不计数(那是前后端漂了,该由别处报)", () => {
    const l = layoutArtifactGraph([
      art("a", "evidence", T0, {
        links: [{ rel: "totally_new_rel", targetId: "b" } as never],
      }),
      art("b", "deliverable", T0 + MIN),
    ]);
    expect(l.edges).toHaveLength(0);
    expect(l.stats.depends_on).toBe(0);
    expect(l.stats.answers).toBe(0);
    expect(l.dangling, "它不是「目标读不到」,是关系本身不认识").toHaveLength(0);
  });
});

// ── ⑥ 图例文案与代码同源 ───────────────────────────────────────

describe("⑥ 界面上那句「逻辑关系当前 0 条」必须与代码同源", () => {
  it("`LOGICAL_RELATION_NOTE` 写明了「0 条」「库里没有这一列」「不画」三件事", () => {
    expect(LOGICAL_RELATION_NOTE).toContain("当前 0 条");
    expect(LOGICAL_RELATION_NOTE).toContain("库里没有");
    expect(LOGICAL_RELATION_NOTE).toContain("编造");
  });

  it("`parent` 的说明写明它零写入侧(否则读者会以为那是个正常关系)", () => {
    expect(RELATIONS.parent.why).toContain("零写入侧");
  });

  it("三类边都有非空 `why` —— 图例项的悬停解释不许留空", () => {
    for (const r of ["depends_on", "answers", "parent"] as ArtifactRelation[]) {
      expect(RELATIONS[r].why.length, `${r} 没有 why`).toBeGreaterThan(10);
      expect(RELATIONS[r].label.length).toBeGreaterThan(0);
    }
  });
});

// ── ⑦ 几何:同列不重叠,列间距恒定 ──────────────────────────────

describe("⑦ 摆位:同列不重叠,不同列 x 严格递增", () => {
  it("同一列里任意两个节点的 y 至少差一个节点高 + 间距", () => {
    const l = layoutArtifactGraph(realShape(), works());
    const byCol = new Map<number, number[]>();
    for (const n of l.nodes) byCol.set(n.depth, [...(byCol.get(n.depth) ?? []), n.y]);
    for (const ys of byCol.values()) {
      ys.sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i += 1) {
        expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(AG_NODE_H);
      }
    }
  });

  it("x 由列号决定(同一列的 x 必然相同)", () => {
    const l = layoutArtifactGraph(realShape(), works());
    for (const n of l.nodes) expect(n.x).toBe(8 + n.depth * (AG_NODE_W + 84));
  });
});
