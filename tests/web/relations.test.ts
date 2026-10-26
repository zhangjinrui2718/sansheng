/**
 * `relationsOf` / `RelationsRail` —— 「一圈邻居」的判据与排版
 *
 * ── 测什么 ────────────────────────────────────────────────────────
 *
 * 1. **关系只有一个家** —— 同一件东西在卡片上、详情里、面板里说的话
 *    必须逐字相同。判据在 `lib/relations.ts`,这里直接比对这个函数的输出。
 * 2. **「没有」与「读不到」分开** —— 上下文里没加载的那份数据 ⇒ 那一组
 *    是 `unavailable`,**不是**「空」。这一条是这套界面反复吃过亏的地方
 *    (`ProjectLiveView.runtime === "unavailable"` 被渲染成「空闲」、
 *    「还没查过」与「查过了是 0 条」长成同一个空态)。
 * 3. **关系类与身份条互斥** —— 身份条(`lib/entityMeta.ts`)有的那几条
 *    (作者 / 产出于 / 负责人 / 父项)**不许**在关系栏里再出现一遍:
 *    同一个事实两处说 = 读者没法把两处的话对上。
 * 4. **链接是真 `<a href>`** —— 右键复制地址 / 中键开新标签 / 后退三件全靠它。
 * 5. **地址逐字相等** —— 拼错的 href 与拼对的在屏幕上**长得一样**。
 *
 * ⚠️ 判据里刻意**没有**「样式好不好看」:那不是判据,是审美。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { relationsOf } from "../../web/src/lib/relations";
import type { RelationContext, RelationSubject } from "../../web/src/lib/relations";
import { RelationsRail } from "../../web/src/components/relations/RelationsRail";
import { artifactMeta } from "../../web/src/lib/entityMeta";
import type { ArtifactView, BlockerView, WorkView } from "../../shared/types/platform";

// ── 夹具 ──────────────────────────────────────────────────────────

const artifact = (over: Partial<ArtifactView> = {}): ArtifactView => ({
  id: "art_1",
  projectId: "p_1",
  kind: "evidence",
  status: "open",
  title: "调研结论",
  bodyPath: "artifacts/art_1-x.md",
  bodyBytes: 12,
  commitSha: null,
  authorAgentId: "a_9",
  authorName: "研究员",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  links: [],
  workId: "w_1",
  deliverableType: null,
  acceptance: null,
  ...over,
});

const work = (over: Partial<WorkView> = {}): WorkView =>
  ({
    id: "w_1",
    projectId: "p_1",
    title: "写调研",
    goal: "写调研",
    status: "in_progress",
    assigneeAgentId: "a_9",
    assigneeName: "研究员",
    parentWorkId: null,
    dependsOn: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }) as WorkView;

const blocker = (over: Partial<BlockerView> = {}): BlockerView =>
  ({
    id: "b_1",
    projectId: "p_1",
    title: "等甲方确认口径",
    detail: "",
    severity: "high",
    status: "open",
    raisedByAgentId: "a_1",
    raisedByName: "项目经理",
    blockedWorkIds: ["w_1"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }) as BlockerView;

const ready = <T,>(data: T) => ({ data, loading: false, error: null });

const ctx = (over: Partial<RelationContext> = {}): RelationContext => ({
  projectId: "p_1",
  works: ready([work()]),
  artifacts: ready([artifact()]),
  blockers: ready([blocker()]),
  ...over,
});

// ── 判据:关系词是中文,不是原始 rel 字符串 ────────────────────────

describe("relationsOf:关系词是中文,不是原始 rel 字符串", () => {
  it("出边用中文关系词(parent 不出现)", () => {
    const a = artifact({
      links: [{ rel: "parent", targetId: "art_0" }],
    });
    const groups = relationsOf({ kind: "artifact", artifact: a }, ctx());
    const related = groups.find((g) => g.key === "related");
    expect(related?.state).toBe("ready");
    expect(related?.items[0]?.rel).toBe("父工件");
    expect(JSON.stringify(related?.items)).not.toContain("parent");
  });

  it("反向边单独成项 —— 「谁指向它」与「它指向谁」不是同一件事", () => {
    const a = artifact({ id: "art_2", links: [] });
    const other = artifact({ id: "art_1", links: [{ rel: "depends_on", targetId: "art_2" }] });
    const groups = relationsOf(
      { kind: "artifact", artifact: a },
      ctx({ artifacts: ready([a, other]) }),
    );
    const items = groups.find((g) => g.key === "related")?.items ?? [];
    expect(items.map((i) => i.rel)).toEqual(["被引用"]);
    expect(items[0]?.label).toBe("调研结论");
  });

  it("目标不在列表里 ⇒ 退成 id,不留空", () => {
    const a = artifact({ links: [{ rel: "parent", targetId: "art_9" }] });
    const groups = relationsOf({ kind: "artifact", artifact: a }, ctx());
    const item = groups.find((g) => g.key === "related")?.items[0];
    expect(item?.label).toBe("art_9");
    expect(item?.label).not.toBe("");
  });
});

// ── 判据:「没有」与「读不到」分开 ──────────────────────────────────

describe("relationsOf:三态分开", () => {
  it("上下文里没接这份数据 ⇒ unavailable(不是 ready + 空)", () => {
    const groups = relationsOf(
      { kind: "work", work: work() },
      ctx({ blockers: undefined }),
    );
    const g = groups.find((x) => x.key === "blockers");
    expect(g?.state).toBe("unavailable");
    expect(g?.items).toEqual([]);
  });

  it("拉失败 ⇒ unavailable", () => {
    const groups = relationsOf(
      { kind: "work", work: work() },
      ctx({ blockers: { data: [], loading: false, error: "boom" } }),
    );
    expect(groups.find((x) => x.key === "blockers")?.state).toBe("unavailable");
  });

  it("还在拉 ⇒ loading(也不许先说「没有」)", () => {
    const groups = relationsOf(
      { kind: "work", work: work() },
      ctx({ blockers: { data: [], loading: true, error: null } }),
    );
    expect(groups.find((x) => x.key === "blockers")?.state).toBe("loading");
  });

  it("真的没有 ⇒ ready + 0 条(这是事实,不是故障)", () => {
    const groups = relationsOf(
      { kind: "work", work: work() },
      ctx({ blockers: ready([]) }),
    );
    const g = groups.find((x) => x.key === "blockers");
    expect(g?.state).toBe("ready");
    expect(g?.items).toEqual([]);
  });
});

// ── 判据:不适用的组整组不出现(那是事实,不是故障)────────────────────

describe("relationsOf:不适用 ≠ 读不到", () => {
  it("不由任何环节产出的工件 ⇒ 「它所属环节的阻塞」整组不出现", () => {
    const a = artifact({ workId: null });
    const groups = relationsOf({ kind: "artifact", artifact: a }, ctx());
    expect(groups.find((g) => g.key === "work_blockers")).toBeUndefined();
    // 而「相关工件」那一组仍然在 —— 它是适用的。
    expect(groups.find((g) => g.key === "related")).toBeDefined();
  });
});

// ── 判据:顺序固定 ────────────────────────────────────────────────

describe("relationsOf:顺序固定", () => {
  it("同一份输入 ⇒ 同一组事实、同一顺序", () => {
    const subject: RelationSubject = { kind: "work", work: work() };
    const c = ctx();
    const a = relationsOf(subject, c);
    const b = relationsOf(subject, c);
    expect(a.map((g) => g.key)).toEqual(b.map((g) => g.key));
    expect(a.map((g) => g.key)).toEqual(["children", "depends_on", "blockers"]);
  });

  it("成员的组只有「负责的环节」", () => {
    const groups = relationsOf({ kind: "member", memberId: "a_9" }, ctx());
    expect(groups.map((g) => g.key)).toEqual(["works"]);
    expect(groups[0]?.items[0]?.label).toBe("写调研");
  });

  it("成员没有环节 ⇒ 0 条,但仍然是 ready(不是「读不到」)", () => {
    const groups = relationsOf({ kind: "member", memberId: "a_x" }, ctx());
    expect(groups[0]?.state).toBe("ready");
    expect(groups[0]?.items).toEqual([]);
  });
});

// ── 判据:地址逐字相等 ────────────────────────────────────────────

describe("relationsOf:地址是地址本身", () => {
  it("阻塞的地址带项目 id —— 阻塞只存在于某一个项目里", () => {
    const groups = relationsOf({ kind: "work", work: work() }, ctx({ projectId: "p_2" }));
    const item = groups.find((g) => g.key === "blockers")?.items[0];
    expect(item?.to).toEqual({ route: "project", params: { project: "p_2", blocker: "b_1" } });
  });

  it("没有项目 id 时不带 project 参数(而不是带一个空串)", () => {
    const groups = relationsOf(
      { kind: "work", work: work() },
      ctx({ projectId: null }),
    );
    const item = groups.find((g) => g.key === "blockers")?.items[0];
    expect(item?.to).toEqual({ route: "project", params: { blocker: "b_1" } });
  });

  it("前置的地址指向那条工作项", () => {
    const w = work({ dependsOn: ["w_0"] });
    const groups = relationsOf({ kind: "work", work: w }, ctx());
    const item = groups.find((g) => g.key === "depends_on")?.items[0];
    expect(item?.to).toEqual({ route: "works", params: { work: "w_0" } });
  });
});

// ── 判据:关系类与身份条互斥 ──────────────────────────────────────

describe("relationsOf:与身份条不重叠", () => {
  it("关系栏里不出现身份条的那几条(作者 / 产出于 / 负责人 / 父项)", () => {
    const groups = relationsOf({ kind: "artifact", artifact: artifact() }, ctx());
    const labels = groups.flatMap((g) => g.items.map((i) => i.rel));
    for (const forbidden of ["作者", "产出于", "负责人", "父项"]) {
      expect(labels).not.toContain(forbidden);
    }
  });

  it("身份条里的关系类也不在关系栏里 —— 两套判据不许长到一处去", () => {
    const stripLabels = artifactMeta(artifact()).map((m) => m.label);
    const groups = relationsOf({ kind: "artifact", artifact: artifact() }, ctx());
    const groupTitles = groups.map((g) => g.title);
    for (const label of stripLabels) {
      expect(groupTitles).not.toContain(label);
    }
  });
});

// ── 排版:RelationsRail ────────────────────────────────────────────

const render = (subject: RelationSubject, context: RelationContext): string =>
  renderToStaticMarkup(createElement(RelationsRail, { subject, context }));

describe("RelationsRail:排版", () => {
  it("链接是真 <a href>,href 就是地址本身", () => {
    const html = render({ kind: "work", work: work({ dependsOn: ["w_0"] }) }, ctx());
    expect(html).toContain('href="#/works?work=w_0"');
  });

  it("⚠️ 不用 onClick 改 hash —— 那样右键复制 / 中键 / 后退三件全没了", () => {
    const html = render({ kind: "work", work: work({ dependsOn: ["w_0"] }) }, ctx());
    expect(html).not.toContain("onClick");
  });

  it("阻塞的地址带上项目 —— 逐字相等", () => {
    const html = render({ kind: "work", work: work() }, ctx({ projectId: "p_2" }));
    expect(html).toContain('href="#/project?blocker=b_1&amp;project=p_2"');
  });

  it("「读不到」与「没有」在屏幕上必须不同", () => {
    const bad = render({ kind: "work", work: work() }, ctx({ blockers: undefined }));
    // 阻塞那一组:读不到
    expect(bad).toMatch(
      /data-relation-group="blockers" data-relation-state="unavailable">[\s\S]*?读不到/,
    );
    // 而子项那一组:算出来了,真的没有
    expect(bad).toMatch(/data-relation-group="children" data-relation-state="ready">[\s\S]*?无</);

    const none = render({ kind: "work", work: work() }, ctx({ blockers: ready([]) }));
    expect(none).toMatch(
      /data-relation-group="blockers" data-relation-state="ready">[\s\S]*?无</,
    );
    expect(none).not.toContain("读不到");
  });

  it("还在拉 ⇒ 「加载中…」(也不许先说「没有」)", () => {
    const html = render(
      { kind: "work", work: work() },
      ctx({ blockers: { data: [], loading: true, error: null } }),
    );
    expect(html).toContain("加载中…");
  });

  it("摘要模式(compact)只渲染算出来且非空的组", () => {
    const html = renderToStaticMarkup(
      createElement(RelationsRail, {
        subject: { kind: "work", work: work({ dependsOn: ["w_0"] }) },
        context: ctx({ blockers: undefined }),
        compact: true,
      }),
    );
    // 「卡住它的阻塞」读不到 ⇒ 摘要里不出现(细节在详情里)。
    expect(html).not.toContain("读不到");
    expect(html).toContain('href="#/works?work=w_0"');
  });

  it("整组都不适用 ⇒ 什么都不渲染(不留一条空带子)", () => {
    const html = renderToStaticMarkup(
      createElement(RelationsRail, {
        subject: { kind: "artifact", artifact: artifact({ workId: null, links: [] }) },
        context: ctx(),
        compact: true,
      }),
    );
    expect(html).toBe("");
  });
});
