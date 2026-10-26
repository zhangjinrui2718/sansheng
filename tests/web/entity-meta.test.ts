/**
 * 「实体身份」—— **同一组事实,同一批地址**的判据
 *
 * ── 为什么值得单独一份测试 ────────────────────────────────────────
 *
 * 实体条存在的理由是:同一个工件在五个地方被说到,而改版前那五处**各写一遍**
 * 「类型 / 状态 / 作者 / 时间」—— 于是同一个工件有五种说法,读者没法把两处
 * 的话对上。
 *
 * 这份测试钉住的**不是**渲染,是三件更靠前的事:
 *
 *   1. **判据只有一份** —— 同一份输入永远给出同一组事实、同一顺序;
 *   2. **标签是契约** —— 同一类实体在任何地方用**同一个词**(「作者」不写成
 *      「产出者」,「产出于」不写成「来自」);
 *   3. **邻居有地址** —— 「作者」「产出于」「父项」「卡住」这几格指向的必须是
 *      **真的地址**,而不是一段拼出来的字符串(拼错了会指向别的东西,而且
 *      拼错与拼对在屏幕上长得一模一样)。
 *
 * ⚠️ 第 3 条是本文件最容易变成「恒真断言」的地方:一个 `to` 拼错了字段名,
 * 测试如果只断言「有个 to」就照样绿。所以这里断言的是**地址本身**
 * (route + params 的逐字相等),而地址由 `lib/route.ts` 的 `toHash` 序列化 ——
 * 「拼错」会在这里当场变红。
 */
import { describe, expect, it } from "vitest";
import {
  artifactLocation,
  artifactMeta,
  blockerMeta,
  memberLocation,
  workLocation,
  workMeta,
} from "../../web/src/lib/entityMeta";
import { toHash } from "../../web/src/lib/route";
import type { ArtifactView, BlockerView, WorkView } from "../../shared/types/platform";

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

const work = (over: Partial<WorkView> = {}): WorkView => ({
  id: "w_1",
  projectId: "p_1",
  parentWorkId: null,
  title: "调研",
  goal: "把方案摸清楚",
  status: "in_progress",
  assigneeAgentId: "a_9",
  assigneeName: "研究员",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  dependsOn: [],
  ...over,
});

const blocker = (over: Partial<BlockerView> = {}): BlockerView => ({
  id: "b_1",
  projectId: "p_1",
  title: "缺一份外部口径",
  detail: "甲方还没给口径",
  severity: "high",
  status: "open",
  raisedByName: "业务经理",
  createdAt: 1_700_000_000_000,
  blockedWorkIds: [],
  ...over,
});

const labels = (items: readonly { label: string }[]) => items.map((i) => i.label);
const cell = (items: readonly { label: string }[], label: string) =>
  items.find((i) => i.label === label);

describe("实体身份:一份判据,同一组事实", () => {
  it("同一份输入 ⇒ 同一组事实、同一顺序(两次调用逐字相等)", () => {
    const a = artifact();
    expect(artifactMeta(a)).toEqual(artifactMeta(a));
    expect(artifactMeta(a)).toEqual(artifactMeta({ ...a }));
  });

  it("标签是契约:同一类实体在任何地方用同一个词", () => {
    expect(labels(artifactMeta(artifact()))).toEqual(["类型", "状态", "作者", "产出于", "创建"]);
    expect(labels(workMeta(work()))).toEqual(["状态", "负责人", "父项", "创建", "更新"]);
    expect(labels(blockerMeta(blocker()))).toEqual([
      "严重度",
      "状态",
      "提出者",
      "卡住",
      "登记",
    ]);
  });

  it("⚠️ 标签改了就是契约破了 —— 这条断言就是为了让改标签的人看见它", () => {
    // 快照:身份条的标签集合是**对外的词表**。改它 = 改一句约定。
    const snapshot = ["类型", "状态", "作者", "产出于", "创建"];
    expect(labels(artifactMeta(artifact()))).toEqual(snapshot);
    // 少一格不是「少一条事实」,是「少一个坐标」。
    expect(cell(artifactMeta(artifact()), "作者")).toBeDefined();
  });
});

describe("实体身份:邻居有地址", () => {
  it("作者的地址指向成员页并带着 agentId", () => {
    const author = cell(artifactMeta(artifact()), "作者");
    expect(author?.links?.[0]?.to).toEqual({ route: "members", params: { member: "a_9" } });
    expect(toHash(author!.links![0].to)).toBe("#/members?member=a_9");
  });

  it("产出于的地址指向工作项页并带着 workId", () => {
    const produced = cell(artifactMeta(artifact()), "产出于");
    expect(produced?.links?.[0]?.to).toEqual({ route: "works", params: { work: "w_1" } });
  });

  it("有标题时显示标题,没标题时退成 id —— **不留空**", () => {
    expect(cell(artifactMeta(artifact(), { workTitle: "调研" }), "产出于")?.links?.[0]?.label).toBe(
      "调研",
    );
    // 拿不到标题 ⇒ 退成 id。留空与「没有」在屏幕上长得一样。
    expect(cell(artifactMeta(artifact(), { workTitle: null }), "产出于")?.links?.[0]?.label).toBe(
      "w_1",
    );
  });

  it("不由任何环节产出的工件:明说,不假装有父项", () => {
    const produced = cell(artifactMeta(artifact({ workId: null })), "产出于");
    expect(produced?.links).toBeUndefined();
    expect(produced?.value).toBe("不由工作项产出");
  });

  it("工作项的负责人与父项各有地址;顶层环节明说", () => {
    expect(cell(workMeta(work()), "负责人")?.links?.[0]?.to).toEqual({
      route: "members",
      params: { member: "a_9" },
    });
    expect(cell(workMeta(work({ parentWorkId: "w_0" })), "父项")?.links?.[0]?.to).toEqual({
      route: "works",
      params: { work: "w_0" },
    });
    expect(cell(workMeta(work()), "父项")?.value).toBe("顶层环节");
  });

  it("阻塞的「卡住」:条数是数出来的,而且每一条都有地址", () => {
    const meta = blockerMeta(blocker({ blockedWorkIds: ["w_1", "w_2"] }));
    const stuck = cell(meta, "卡住");
    expect(stuck?.value).toBe("2 个工作项");
    expect(stuck?.links?.map((l) => l.to)).toEqual([
      { route: "works", params: { work: "w_1" } },
      { route: "works", params: { work: "w_2" } },
    ]);
  });

  it("阻塞的「卡住」:有标题就用标题,没有就用 id", () => {
    const titles = new Map([["w_1", "调研"]]);
    const meta = blockerMeta(blocker({ blockedWorkIds: ["w_1", "w_2"] }), titles);
    expect(cell(meta, "卡住")?.links?.map((l) => l.label)).toEqual(["调研", "w_2"]);
  });

  it("没登记卡住谁时明说「没有」,而不是显示 0", () => {
    const stuck = cell(blockerMeta(blocker()), "卡住");
    expect(stuck?.value).toBe("没有登记卡住的工作项");
    expect(stuck?.links).toBeUndefined();
  });
});

describe("实体身份:工件的地址带上产出它的那条环节", () => {
  it("给了 workId ⇒ 一步同时选上环节与工件", () => {
    expect(artifactLocation("art_1", "w_1")).toEqual({
      route: "works",
      params: { work: "w_1", artifact: "art_1" },
    });
  });

  it("没给 workId ⇒ 只选工件", () => {
    expect(artifactLocation("art_1", null)).toEqual({
      route: "works",
      params: { artifact: "art_1" },
    });
  });
});

describe("实体身份:同一个地址只有一种写法", () => {
  it("memberLocation / workLocation 逐字固定(它们是「邻居」的坐标)", () => {
    expect(memberLocation("a_9")).toEqual({ route: "members", params: { member: "a_9" } });
    expect(workLocation("w_1")).toEqual({ route: "works", params: { work: "w_1" } });
  });
});
