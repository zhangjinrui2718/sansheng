/**
 * 推进图(时间轴 × 泳道)的纯函数判据
 *
 * ── 这份测试守的是什么 ──────────────────────────────────────────
 *
 * 用户对旧图的判词是「都缠在一起了」,并给了新形状:**横轴是时间、纵轴是工件的类型**,
 * 还要「工作项的完成和工件的产出也标在图表里面」。这张图一旦错,最可能的两种错法
 * **在截图里都看不出来**:
 *
 *   ① **漏数据**(某件工件没有点 / 某条工作项没有条)—— 图上少一个点,看起来只是
 *      「这个项目就这么多」;
 *   ② **把「未收口」画成「已收口」**(开口端画成了封口,或者右端点用了 `updatedAt`
 *      而不是「此刻」)—— 那是在替平台宣布「这条做完了」。
 *
 * 所以这里的判据是**计数 + 端点语义**,不是「渲染出来没报错」:
 *   每件工件恰好一个点(正样本:数量相等;负样本:不存在两个点同 id);
 *   未终态 ⇒ `open: true` 且右端 = now;终态 ⇒ `open: false` 且右端 = updatedAt
 *   (**并且刻度文案只敢说「最后一次变更」**,见 `timeline.ts` 文件头纪律①);
 *   `runtime: "unavailable"` ⇒ 一律不点亮(`running` 全 false)。
 */
import { describe, expect, it } from "vitest";
import type { ArtifactView, WorkView } from "@shared/types/platform";
import {
  TL_DOT_R,
  TL_GUTTER,
  TL_KIND_LANE_H,
  TL_MIN_SPAN_MS,
  TL_PLOT_W,
  TL_WORK_LANE_H,
  formatClock,
  formatTick,
  layoutTimeline,
  timelineDomain,
  timelineTicks,
  clipLabel,
  textWidthPx,
} from "@/lib/timeline";

const T0 = Date.parse("2026-10-05T16:54:00+08:00");

function work(
  id: string,
  over: Partial<WorkView> = {},
): WorkView {
  return {
    id,
    projectId: "p1",
    parentWorkId: null,
    title: `环节 ${id}`,
    goal: "",
    status: "done",
    assigneeAgentId: "wk",
    assigneeName: "工程师",
    createdAt: T0,
    updatedAt: T0 + 30 * 60_000,
    dependsOn: [],
    ...over,
  };
}

function art(id: string, kind: ArtifactView["kind"], at: number, workId: string | null = null): ArtifactView {
  return {
    id,
    projectId: "p1",
    kind,
    status: "open",
    title: `工件 ${id}`,
    body: "",
    authorAgentId: "wk",
    authorName: "工程师",
    createdAt: at,
    updatedAt: at,
    links: [],
    workId,
  };
}

/**
 * 真机形状(逐项对齐 2026-10-05 那份库):1 根 + 4 子;**20 件工件** =
 * evidence 6 + review_finding 7 + deliverable 1(**14 件挂了环节**)+
 * decision 6(**`workId` 为 null,不挂任何环节**)。
 *
 * 计数照抄真库是要紧的:「图上少画了几个点」只有对着一个**已知数量**的夹具
 * 才判得出来(见文件头那段「漏数据在截图里看不出来」)。
 */
function realShape(): { works: WorkView[]; artifacts: ArtifactView[] } {
  const works = [
    work("root", { createdAt: T0, updatedAt: T0 + 31 * 60_000 }),
    work("a", { createdAt: T0 + 1 * 60_000, updatedAt: T0 + 20 * 60_000 }),
    work("b", { createdAt: T0 + 1 * 60_000, updatedAt: T0 + 29 * 60_000 }),
    work("c", { createdAt: T0 + 3 * 60_000, updatedAt: T0 + 20 * 60_000 }),
    work("int", { createdAt: T0 + 5 * 60_000, updatedAt: T0 + 29 * 60_000 }),
  ];
  const ev = (id: string, at: number, wid: string) => art(id, "evidence", at, wid);
  const rf = (id: string, at: number, wid: string) => art(id, "review_finding", at, wid);
  const artifacts: ArtifactView[] = [
    // evidence 6(真机:模块 A 三次 + B/C/整合各一次)
    ev("e1", T0 + 2 * 60_000, "a"),
    ev("e2", T0 + 3 * 60_000, "a"),
    ev("e3", T0 + 4 * 60_000, "b"),
    ev("e4", T0 + 8 * 60_000, "c"),
    ev("e5", T0 + 12 * 60_000, "int"),
    ev("e6", T0 + 13 * 60_000, "int"),
    // review_finding 7(每条工作项都有审过)
    rf("r1", T0 + 10 * 60_000, "a"),
    rf("r2", T0 + 11 * 60_000, "a"),
    rf("r3", T0 + 15 * 60_000, "b"),
    rf("r4", T0 + 16 * 60_000, "b"),
    rf("r5", T0 + 18 * 60_000, "c"),
    rf("r6", T0 + 24 * 60_000, "int"),
    rf("r7", T0 + 26 * 60_000, "root"),
    // deliverable 1(挂在根上)
    art("dl", "deliverable", T0 + 25 * 60_000, "root"),
    // decision 6 —— **没有环节**(立项决策 / 答复 / 部署形态…)
    ...Array.from({ length: 6 }, (_, i) => art(`d${i}`, "decision", T0 + (i + 1) * 60_000, null)),
  ];
  return { works, artifacts };
}

const NO_LIVE = null;
const HOST_IDLE = { runtime: "host" as const, agents: [{ agentId: "wk", turn: null }] };
const HOST_RUNNING = {
  runtime: "host" as const,
  agents: [{ agentId: "wk", turn: { elapsedMs: 1000 } }],
};
const UNAVAILABLE = { runtime: "unavailable" as const, agents: [{ agentId: "wk", turn: null }] };

const NOW = T0 + 40 * 60_000;

// ── ① 泳道 ──────────────────────────────────────────────────────

describe("① 纵轴 = 泳道:工作项一条一道、工件每种 kind 一道", () => {
  it("工作项 5 条 ⇒ 5 道;工件出现过的 kind 只有 4 种 ⇒ 只有 4 道(**空 kind 不占道**)", () => {
    const { works, artifacts } = realShape();
    const tl = layoutTimeline({ works, artifacts, now: NOW, live: NO_LIVE });
    const workLanes = tl.lanes.filter((l) => l.group === "work");
    const kindLanes = tl.lanes.filter((l) => l.group === "kind");
    expect(workLanes.length, "每条工作项恰好一道").toBe(5);
    expect(workLanes.map((l) => l.label)).toEqual(["环节 root", "环节 a", "环节 b", "环节 c", "环节 int"]);
    // 契约里 11 种 kind,数据里只有 4 种 ⇒ 那道**不许**出现(空道只会把图拉长)
    expect(kindLanes.map((l) => l.label)).toEqual([
      "decision", "deliverable", "evidence", "review_finding",
    ]);
    expect(kindLanes.length).toBe(4);
  });

  it("两道之间不重叠,且**一区在上、kind 区在下**", () => {
    const { works, artifacts } = realShape();
    const tl = layoutTimeline({ works, artifacts, now: NOW, live: NO_LIVE });
    const sorted = [...tl.lanes].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      expect(cur.y, `${prev.key} 与 ${cur.key} 叠在一起`).toBeGreaterThanOrEqual(prev.y + prev.height);
    }
    const lastWork = tl.lanes.filter((l) => l.group === "work").at(-1)!;
    const firstKind = tl.lanes.filter((l) => l.group === "kind")[0]!;
    expect(lastWork.y).toBeLessThan(firstKind.y);
    // 工作项道比工件道高(它上面还要挂里程碑刻度)
    expect(TL_WORK_LANE_H).toBeGreaterThan(TL_KIND_LANE_H);
  });

  it("没有工作项时只有 kind 道(不许崩、也不许画出空的工作项区)", () => {
    const tl = layoutTimeline({
      works: [],
      artifacts: [art("d", "decision", T0, null)],
      now: NOW,
      live: NO_LIVE,
    });
    expect(tl.lanes.map((l) => l.key)).toEqual(["kind:decision"]);
    expect(tl.spans.length).toBe(0);
    expect(tl.marks.length).toBe(1);
  });

  it("空项目:不崩,画布仍有一个可读的最小高度", () => {
    const tl = layoutTimeline({ works: [], artifacts: [], now: NOW, live: NO_LIVE });
    expect(tl.lanes.length).toBe(0);
    expect(tl.marks.length).toBe(0);
    expect(tl.spans.length).toBe(0);
    expect(tl.height).toBeGreaterThan(0);
    expect(tl.domain.to - tl.domain.from).toBe(TL_MIN_SPAN_MS);
  });
});

// ── ② 工件 = 点(每一件恰好一个,含没有环节的)────────────────────

describe("② 工件 = 点:每一件恰好一个,**没在 DAG 上的也在图上**", () => {
  it("20 件 ⇒ 20 个点,且不存在两个点同 id(负样本)", () => {
    const { works, artifacts } = realShape();
    const tl = layoutTimeline({ works, artifacts, now: NOW, live: NO_LIVE });
    expect(tl.artifactCount).toBe(20);
    expect(tl.marks.length, "图上少画了工件").toBe(20);
    expect(new Set(tl.marks.map((m) => m.id)).size, "同一个工件画了两次").toBe(20);
  });

  it("`workId === null` 的 6 件决策**照样在图上**(这正是用户要的那一条)", () => {
    const { works, artifacts } = realShape();
    const tl = layoutTimeline({ works, artifacts, now: NOW, live: NO_LIVE });
    const orphan = tl.marks.filter((m) => m.workId === null);
    expect(orphan.length).toBe(6);
    for (const m of orphan) {
      expect(m.laneKey, "它落在自己 kind 的那一道上").toBe("kind:decision");
      expect(m.workTitle).toBeNull();
    }
  });

  it("点的横坐标 = 它的创建时刻在刻度上的位置(单调、在绘图区内)", () => {
    const { works, artifacts } = realShape();
    const tl = layoutTimeline({ works, artifacts, now: NOW, live: NO_LIVE });
    const ev = tl.marks.filter((m) => m.kind === "evidence").sort((p, q) => p.createdAt - q.createdAt);
    for (let i = 1; i < ev.length; i += 1) {
      expect(ev[i]!.x, "时间越晚的点必须越靠右").toBeGreaterThan(ev[i - 1]!.x);
    }
    for (const m of tl.marks) {
      expect(m.x).toBeGreaterThanOrEqual(TL_GUTTER);
      expect(m.x).toBeLessThanOrEqual(TL_GUTTER + TL_PLOT_W);
      expect(TL_DOT_R).toBeGreaterThan(0);
    }
  });

  it("点落在**自己 kind 那道**的中线上(不是随便一道)", () => {
    const { works, artifacts } = realShape();
    const tl = layoutTimeline({ works, artifacts, now: NOW, live: NO_LIVE });
    for (const m of tl.marks) {
      const lane = tl.lanes.find((l) => l.key === m.laneKey)!;
      expect(m.y).toBe(lane.y + lane.height / 2);
    }
  });
});

// ── ③ 工作项 = 跨度条(完成与产出标在同一行)──────────────────────

describe("③ 工作项 = 跨度条:终态封口、未终态开口,产出打成条上的刻度", () => {
  it("终态 ⇒ 右端 = `updatedAt`(最后一次变更)且**不是**开口", () => {
    const { works, artifacts } = realShape();
    const tl = layoutTimeline({ works, artifacts, now: NOW, live: NO_LIVE });
    const a = tl.spans.find((s) => s.id === "a")!;
    expect(a.open).toBe(false);
    expect(a.endedAt).toBe(T0 + 20 * 60_000);
    expect(a.status).toBe("done");
  });

  it("未终态 ⇒ 右端 = **此刻**且 `open: true`(不许替平台宣布「做完了」)", () => {
    const w = work("w1", { status: "in_progress", createdAt: T0, updatedAt: T0 + 5 * 60_000 });
    const tl = layoutTimeline({ works: [w], artifacts: [], now: NOW, live: HOST_IDLE });
    const s = tl.spans[0]!;
    expect(s.open, "在跑的工作项必须画成开口的").toBe(true);
    expect(s.endedAt).toBe(NOW);
    // 关键负样本:右端**不许**取 updated_at(那会画成一条更短的、看起来已收口的条)
    expect(s.endedAt).not.toBe(w.updatedAt);
    expect(s.x2).toBeGreaterThan(s.x1);
  });

  it("产出 = 条上的里程碑刻度:每条工作项只挂**自己**的工件", () => {
    const { works, artifacts } = realShape();
    const tl = layoutTimeline({ works, artifacts, now: NOW, live: NO_LIVE });
    const byId = new Map(tl.spans.map((s) => [s.id, s]));
    expect(byId.get("a")!.milestones.map((m) => m.id)).toEqual(["e1", "e2", "r1", "r2"]);
    expect(byId.get("b")!.milestones.map((m) => m.id)).toEqual(["e3", "r3", "r4"]);
    expect(byId.get("c")!.milestones.map((m) => m.id)).toEqual(["e4", "r5"]);
    expect(byId.get("int")!.milestones.map((m) => m.id)).toEqual(["e5", "e6", "r6"]);
    expect(byId.get("root")!.milestones.map((m) => m.id)).toEqual(["dl", "r7"]);
    // 负样本:a 的刻度里不许出现 b 的工件
    expect(byId.get("a")!.milestones.map((m) => m.id)).not.toContain("r3");
    // 刻度位置与那个点在 kind 道上的 x **一致**(同一时刻在两张读法里位置相同)
    const markById = new Map(tl.marks.map((m) => [m.id, m]));
    for (const s of tl.spans) {
      for (const ms of s.milestones) {
        expect(ms.x).toBe(markById.get(ms.id)!.x);
      }
    }
    // 刻度按时间排好(条上的小刻度不许乱序)
    const a = byId.get("a")!.milestones;
    expect(a[0]!.x).toBeLessThan(a[1]!.x);
  });

  it("每条工作项恰好一条条(计数对得上),且落在**自己**那一道上", () => {
    const { works, artifacts } = realShape();
    const tl = layoutTimeline({ works, artifacts, now: NOW, live: NO_LIVE });
    expect(tl.spans.length).toBe(works.length);
    for (const s of tl.spans) {
      const lane = tl.lanes.find((l) => l.key === s.laneKey)!;
      expect(lane.group).toBe("work");
      expect(s.y + s.height / 2).toBe(lane.y + lane.height / 2);
    }
  });
});

// ── ④ 运行态:三个「不知道」不许长得一样 ─────────────────────────

describe("④ 运行态:`unavailable` 不许点亮任何东西", () => {
  it("host + 该角色有回合在跑 ⇒ 那条未终态的工作项点亮", () => {
    const w = work("w1", { status: "in_progress", updatedAt: T0 });
    const tl = layoutTimeline({ works: [w], artifacts: [], now: NOW, live: HOST_RUNNING });
    expect(tl.spans[0]!.running).toBe(true);
    expect(tl.spans[0]!.unknown).toBe(false);
    expect(tl.nowX, "有回合在跑 ⇒ 时间域含「此刻」,此刻线要画").not.toBeNull();
  });

  it("`runtime: unavailable` ⇒ running 全 false(即便库里是 in_progress)", () => {
    const w = work("w1", { status: "in_progress", updatedAt: T0 });
    const tl = layoutTimeline({ works: [w], artifacts: [], now: NOW, live: UNAVAILABLE });
    expect(tl.spans[0]!.running, "读不到运行态却点亮了呼吸点").toBe(false);
    expect(tl.spans[0]!.unknown, "必须标记「读不到」").toBe(true);
    expect(tl.nowX, "读不到运行态 ⇒ 不画此刻线").toBeNull();
  });

  it("`live === null`(还没拿到快照)⇒ 与 unavailable 一样不点亮", () => {
    const w = work("w1", { status: "in_progress", updatedAt: T0 });
    const tl = layoutTimeline({ works: [w], artifacts: [], now: NOW, live: null });
    expect(tl.spans[0]!.running).toBe(false);
    expect(tl.spans[0]!.unknown).toBe(true);
    expect(tl.nowX).toBeNull();
  });

  it("已收口的工作项**永不**点亮(哪怕此刻有回合在跑)", () => {
    const w = work("w1", { status: "done", updatedAt: T0 });
    const tl = layoutTimeline({ works: [w], artifacts: [], now: NOW, live: HOST_RUNNING });
    expect(tl.spans[0]!.running).toBe(false);
  });
});

// ── ⑤ 时间域与刻度 ──────────────────────────────────────────────

describe("⑤ 时间域与刻度:覆盖全部时间戳,步长自适应", () => {
  it("域覆盖所有工作项与工件的时间戳,且两端留白", () => {
    const { works, artifacts } = realShape();
    const input = { works, artifacts, now: NOW, live: NO_LIVE };
    const { from, to } = timelineDomain(input);
    const stamps = [...works.flatMap((w) => [w.createdAt, w.updatedAt]), ...artifacts.map((a) => a.createdAt)];
    for (const t of stamps) {
      expect(t).toBeGreaterThanOrEqual(from);
      expect(t).toBeLessThanOrEqual(to);
    }
    expect(from).toBeLessThan(Math.min(...stamps));
    expect(to).toBeGreaterThan(Math.max(...stamps));
  });

  it("只有一件工件 ⇒ 撑到最小跨度(否则横轴是一根零宽的轴)", () => {
    const a = art("only", "evidence", T0, null);
    const { from, to } = timelineDomain({ works: [], artifacts: [a], now: NOW, live: NO_LIVE });
    expect(to - from).toBeGreaterThanOrEqual(TL_MIN_SPAN_MS);
  });

  it("刻度步长随跨度变大而变大,而且标签不会挤在一起(密度 ≤ 目标)", () => {
    const span30m = timelineTicks(T0, T0 + 30 * 60_000);
    const span3d = timelineTicks(T0, T0 + 3 * 24 * 60 * 60_000);
    expect(span30m.length).toBeGreaterThanOrEqual(2);
    expect(span30m.length).toBeLessThanOrEqual(9);
    expect(span3d.length).toBeLessThanOrEqual(9);
    // 相邻标签的像素间距 ≥ 60px(这是「读得下去」的下界)
    for (const ticks of [span30m, span3d]) {
      for (let i = 1; i < ticks.length; i += 1) {
        expect(ticks[i]!.x - ticks[i - 1]!.x).toBeGreaterThanOrEqual(60);
      }
    }
    // 步长确实变大了:3 天的刻度不会被「每 5 分钟一格」铺满
    expect(span3d.length).toBeLessThan(span30m.length * 60);
  });

  it("刻度对齐到整步长,而且同一份数据两次算的刻度完全相同", () => {
    const first = timelineTicks(T0 + 61_000, T0 + 30 * 60_000);
    const second = timelineTicks(T0 + 61_000, T0 + 30 * 60_000);
    expect(second).toEqual(first);
    const minutes = new Set(first.map((t) => new Date(t.at).getMinutes()));
    // 5 分钟的步长落在 0/5/10… 上(整点对齐)—— 允许 15/30 分钟的更大步长
    for (const m of minutes) expect([0, 5, 10, 15, 20, 25, 30, 45].includes(m)).toBe(true);
  });

  it("同一天只写 `HH:MM`;跨天补上日期(否则 30 分钟里全是重复前缀)", () => {
    const sameDay = timelineTicks(T0, T0 + 30 * 60_000);
    expect(sameDay.every((t) => /^\d\d:\d\d$/.test(t.label))).toBe(true);
    expect(formatTick(T0, true)).toMatch(/^\d\d-\d\d \d\d:\d\d$/);
    expect(formatClock(T0)).toMatch(/^\d\d:\d\d$/);
    expect(formatClock(T0, true)).toMatch(/^\d\d-\d\d \d\d:\d\d$/);
  });
});

// ── ⑥ 泳道名与时间域:看了真机渲染图之后补的两条 ──────────────────

describe("⑥ 泳道名截断与时间域密度(2026-10-06 看真机渲染图后补)", () => {
  it("泳道名截到栏宽以内:超长的截 + 省略号,短的**原样不动**(负样本)", () => {
    const short = "节律感知模块方案设计";
    expect(clipLabel(short, TL_GUTTER - 16), "放得下的名字不该被改").toBe(short);
    const long = "催收机器人 Qwen-Omni 架构方案交付";
    const clipped = clipLabel(long, TL_GUTTER - 16);
    expect(clipped.endsWith("…"), "超长的必须带省略号").toBe(true);
    expect(clipped.length).toBeLessThan(long.length);
    expect(textWidthPx(clipped), "截断之后仍然超宽就等于没截").toBeLessThanOrEqual(TL_GUTTER - 16);
    // 真机那五条标题**逐条**都要能在栏内放下(否则右对齐会溢出到 x<0 被裁掉)
    for (const title of [
      "催收机器人 Qwen-Omni 架构方案交付",
      "基础打断模块方案设计",
      "Qwen-Omni 全双工通道接入方案设计",
      "节律感知模块方案设计",
      "三模块架构整合与关键技术决策汇总",
    ]) {
      expect(textWidthPx(clipLabel(title, TL_GUTTER - 16))).toBeLessThanOrEqual(TL_GUTTER - 16);
    }
  });

  it("宽度估算:汉字比 ASCII 宽,这是截断判据的前提", () => {
    expect(textWidthPx("工程师")).toBeGreaterThan(textWidthPx("wk"));
    expect(textWidthPx("")).toBe(0);
    // 混合串:两种宽度都算进去了(否则 `Qwen-Omni 全双工…` 会被算得过窄而溢出)
    const mixed = textWidthPx("Qwen-Omni 全双工通道接入方案设计");
    const parts = textWidthPx("Qwen-Omni") + textWidthPx("全双工通道接入方案设计");
    expect(mixed).toBeGreaterThan(textWidthPx("Qwen-Omni"));
    // 逐字符求和 ⇒ 混合串 = 两段之和 + 那个空格(`textWidthPx` 是可加的,这条
    // 钉的是「两部分都真的被算进去了」而不是「算了其中一段」)
    expect(mixed).toBeGreaterThan(parts);
    expect(mixed).toBeLessThan(parts + 7);
  });

  it("真机跨度(31 分钟)**不许**被撑成 1 小时(那会左右各空掉四分之一)", () => {
    const { works, artifacts } = realShape();
    const { from, to } = timelineDomain({ works, artifacts, now: NOW, live: NO_LIVE });
    // 真数据跨度 ≈ 31 分钟 ⇒ 域最多比它宽一点(两端各 4% 留白),绝不到 60 分钟
    expect(to - from).toBeLessThan(40 * 60_000);
    expect(to - from).toBeGreaterThan(30 * 60_000);
  });

  it("只有一件工件(几乎没有跨度)才撑到最小跨度 —— 而且那个最小跨度是 2 分钟", () => {
    expect(TL_MIN_SPAN_MS).toBe(2 * 60_000);
    const a = art("only", "evidence", T0, null);
    const { from, to } = timelineDomain({ works: [], artifacts: [a], now: NOW, live: NO_LIVE });
    // 撑到最小跨度**之后**两端还要留白(4%),所以略大于那个常量
    expect(to - from).toBeGreaterThanOrEqual(TL_MIN_SPAN_MS);
    expect(to - from).toBeLessThan(TL_MIN_SPAN_MS * 1.1);
  });
});
