/**
 * 「一圈邻居」—— 一个实体**连着什么**的判据
 *
 * ── 它治的是什么病 ────────────────────────────────────────────────
 *
 * 身份条(`lib/entityMeta.ts`)答的是「**这个东西是什么**」:类型、状态、谁做的、
 * 归哪条环节。改版前还有第二个问题没人答 ——「**它连着什么**」——
 * 而那一面当时是**三处各写各的**:
 *
 *   - 工件卡片:`关联 ${links.map((l) => \`${l.rel}→${l.targetId}\`)}`
 *     ⇒ **印的是 id 与英文关系词**(`parent→art_x`),读者既看不懂也不知道点哪儿;
 *   - 工件详情:一节「关联(N)」,标题能读懂但**不是链接**(跳不过去);
 *   - 工作项面板:「前置」是**纯文本**,同样跳不过去;
 *   - 成员面板:**根本没有**「他手上有哪些活」这一面。
 *
 * ⇒ 所以关系也收成**一个纯函数**:`relationsOf(主体, 上下文) ⇒ 一组「关系组」。
 * 每一组 = 一个关系类别 + 若干条(关系词 · 目标 · **地址**)。
 *
 * ── 与身份条的分工(不许重叠)────────────────────────────────────
 *
 * | | 身份条 | 关系栏 |
 * |---|---|---|
 * | 答 | 这是什么 | 它连着什么 |
 * | 拥有 | 作者 / 负责人 / 父项 / 产出于 | 相关工件 / 子项 / 前置 / 阻塞 / 负责的环节 |
 *
 * ⚠️ **两者的关系类是互斥的** —— 身份条有的那几条(作者 / 产出于 / 负责人 / 父项)
 * **不在**关系栏里,反之亦然。否则同一个事实会在同一块屏幕上出现两遍,
 * 那正是这次重构要治的「各说一套」。
 *
 * ── 「没有」与「读不到」必须分开 ─────────────────────────────────
 *
 * 上下文里没加载的那份数据(比如这一页没取阻塞列表)⇒ 那一组是
 * **`unavailable`,不是「空」**。渲染成「没有阻塞」就是把一次读失败说成事实
 * —— 本仓库反复吃过这个亏(`ProjectLiveView.runtime === "unavailable"` 被渲染成
 * 「空闲」、「还没查过」与「查过了是 0 条」长成同一个空态)。
 *
 * ⇒ 组有三种状态:
 * - `ready` —— 算出来了(**可能 0 条**,那是「没有」这个事实);
 * - `loading` —— 还在拉(说「加载中」,不许先说「没有」);
 * - `unavailable` —— 拉失败了(说「读不到」)。
 *
 * ⚠️ **`loading` 与 `unavailable` 都**不是**「没有」** —— 三者在界面上必须不同。
 *
 * ── 顺序是固定的 ─────────────────────────────────────────────────
 *
 * 同一份输入 ⇒ 同一组事实、**同一顺序**。顺序写在一张表里(`GROUPS`),
 * 不由数组的偶然顺序决定 —— 否则「关系栏第一行」会随数据变化。
 *
 * ── 本文件不 import React ────────────────────────────────────────
 *
 * 纯数据 ⇒ 单测可以直接比对「两次调用给出同一组关系」,不必渲染组件。
 */
import type { AppLocation } from "./route";
import {
  artifactLocation,
  blockerLocation,
  memberLocation,
  workLocation,
} from "./entityMeta";
import type { ArtifactView, BlockerView, MemberView, WorkView } from "@shared/types/platform";

/**
 * 一份数据的加载态。
 *
 * ⚠️ **不 import `lib/data.ts` 的 `Loaded<T>`** —— 那个模块带 React hooks,
 * 而本文件要保持纯数据(测试不必渲染组件就能比对)。两者**结构相同**,
 * 所以页面里的 hook 结果可以直接传进来(结构化类型)。
 */
export interface Loadable<T> {
  data: T;
  loading: boolean;
  error: string | null;
}

/** 关系的主体 —— **带实体本身**,不是只带 id。 */
export type RelationSubject =
  | { kind: "artifact"; artifact: ArtifactView }
  | { kind: "work"; work: WorkView }
  | { kind: "member"; memberId: string };

/**
 * 上下文 = 算关系需要的**别的**实体。
 *
 * ⚠️ **每一份都可缺省,缺省 = 那一类关系「读不到」**(不是「没有」)。
 */
export interface RelationContext {
  /**
   * 这些实体属于**哪个项目**。
   *
   * ⚠️ **阻塞的地址要靠它** —— 阻塞是项目级实体,它的地址必须带项目 id,
   * 否则那是一条「只在你正好看着那个项目时才成立」的半个地址(见
   * `entityMeta.blockerLocation`)。
   */
  projectId?: string | null;
  works?: Loadable<readonly WorkView[]>;
  artifacts?: Loadable<readonly ArtifactView[]>;
  blockers?: Loadable<readonly BlockerView[]>;
  members?: Loadable<readonly MemberView[]>;
}

/** 一条关系。 */
export interface RelationItem {
  /** 关系词(「父工件」「被引用」)—— 这一条边叫什么。组名已经说明的可以留空。 */
  rel: string;
  /** 目标的标题 / 名字。**读不到就退成 id**,不留空。 */
  label: string;
  /** 目标的地址。`null` = 目标**没有地址**。 */
  to: AppLocation | null;
  /** 判据出处(真 `title=`,不是悬停正文)。 */
  title?: string;
}

/** 一组关系。 */
export interface RelationGroup {
  /** 稳定的组 id(渲染与测试都按它认,不按显示名)。 */
  key: string;
  /** 显示名。 */
  title: string;
  /** `ready` = 算出来了 · `loading` = 还在拉 · `unavailable` = 拉失败了。 */
  state: "ready" | "loading" | "unavailable";
  items: RelationItem[];
}

// ── 关系词表 ──────────────────────────────────────────────────────

/**
 * 工件间关系(`ArtifactView.links[].rel`)的**中文说法**。
 *
 * ⚠️ 这一张表是**唯一**的来源 —— 改版前卡片上印的是英文原值
 * (`parent→art_x`),而详情里用的是另一套词(`REL_LABEL`)。
 * 两套词并排出现在同一份工件上,而读者没法把它们对上。
 */
export const ARTIFACT_REL_WORDS: Readonly<Record<string, string>> = {
  parent: "父工件",
  depends_on: "依赖",
  answers: "回答",
};

/** 反向边(别的工件指向它)的说法。 */
export const REVERSE_REL_WORD = "被引用";

// ── 组的定义(顺序 = 渲染顺序)─────────────────────────────────────

type ContextKey = "works" | "artifacts" | "blockers" | "members";

/** 已经算好(加载完)的上下文 —— 组的状态是 `ready` 时才传进来。 */
interface Resolved {
  projectId?: string | null;
  works?: readonly WorkView[];
  artifacts?: readonly ArtifactView[];
  blockers?: readonly BlockerView[];
  members?: readonly MemberView[];
}

interface GroupSpec {
  key: string;
  title: string;
  /** 算这一组要哪几份数据。缺任何一份 ⇒ 这一组不是 `ready`。 */
  needs: readonly ContextKey[];
  /**
   * 这一组**适不适用**于这个主体 —— 不适用就整组不出现。
   *
   * ⚠️ 「不适用」与「算不出」是两件事:前者是**事实**(这份工件不由任何环节产出,
   * 所以「它所属环节的阻塞」对它没有意义),后者是**读不到**。
   */
  applicable?: (subject: RelationSubject) => boolean;
  compute: (subject: RelationSubject, data: Resolved) => RelationItem[];
}

const titleOfArtifact = (a: ArtifactView | undefined): string | null =>
  a === undefined ? null : a.title || a.id;

const titleOfWork = (w: WorkView | undefined): string | null =>
  w === undefined ? null : w.title || w.id;

const findWork = (data: Resolved, id: string): WorkView | undefined =>
  data.works?.find((w) => w.id === id);

const findArtifact = (data: Resolved, id: string): ArtifactView | undefined =>
  data.artifacts?.find((a) => a.id === id);

/**
 * 一组关系的**固定顺序**。⚠️ 这是「同一份输入 ⇒ 同一组事实、同一顺序」的落点。
 */
const GROUPS: Readonly<Record<RelationSubject["kind"], readonly GroupSpec[]>> = {
  artifact: [
    {
      key: "related",
      title: "相关工件",
      needs: ["artifacts"],
      compute: (subject, data) => {
        if (subject.kind !== "artifact") return [];
        const a = subject.artifact;
        const items: RelationItem[] = [];
        // 出边:它自己声明的(父工件 / 依赖 / 回答)。
        for (const link of a.links) {
          const target = findArtifact(data, link.targetId);
          items.push({
            rel: ARTIFACT_REL_WORDS[link.rel] ?? link.rel,
            label: titleOfArtifact(target) ?? link.targetId,
            to: artifactLocation(link.targetId, target?.workId ?? null),
            title:
              target === undefined
                ? "目标不在本次列表里,只显示 id"
                : "目标工件 id:" + link.targetId,
          });
        }
        // 入边:别的工件指向它(反向边)。⚠️ 出边**不含**它 —— 方向不一样,
        // 混在一起会把「它依赖谁」与「谁依赖它」说成同一件事。
        for (const other of data.artifacts ?? []) {
          if (other.id === a.id) continue;
          for (const link of other.links) {
            if (link.targetId !== a.id) continue;
            items.push({
              rel: REVERSE_REL_WORD,
              label: titleOfArtifact(other) ?? other.id,
              to: artifactLocation(other.id, other.workId),
              title: "它指向本工件(工件 id:" + other.id + ")",
            });
          }
        }
        return items;
      },
    },
    {
      key: "work_blockers",
      title: "它所属环节的阻塞",
      needs: ["blockers"],
      // ⚠️ 不由任何环节产出的工件(决策 / 甲方问答)**没有**所属环节 ⇒ 这一组不适用。
      applicable: (subject) => subject.kind === "artifact" && subject.artifact.workId !== null,
      compute: (subject, data) => {
        if (subject.kind !== "artifact") return [];
        const workId = subject.artifact.workId;
        if (workId === null) return [];
        return (data.blockers ?? [])
          .filter((b) => b.blockedWorkIds.includes(workId))
          .map((b) => ({
            rel: "",
            label: b.title || b.id,
            to: blockerLocation(b.id, data.projectId),
            title: "阻塞 id:" + b.id,
          }));
      },
    },
  ],
  work: [
    {
      key: "children",
      title: "子项",
      needs: ["works"],
      compute: (subject, data) => {
        if (subject.kind !== "work") return [];
        return (data.works ?? [])
          .filter((w) => w.parentWorkId === subject.work.id)
          .map((w) => ({
            rel: "",
            label: titleOfWork(w) ?? w.id,
            to: workLocation(w.id),
            title: "工作项 id:" + w.id,
          }));
      },
    },
    {
      key: "depends_on",
      title: "前置",
      needs: ["works"],
      compute: (subject, data) => {
        if (subject.kind !== "work") return [];
        return subject.work.dependsOn.map((id) => {
          const dep = findWork(data, id);
          return {
            rel: "",
            label: titleOfWork(dep) ?? id,
            to: workLocation(id),
            title: dep === undefined ? "本次列表里没有这条工作项" : "工作项 id:" + id,
          };
        });
      },
    },
    {
      key: "blockers",
      title: "卡住它的阻塞",
      needs: ["blockers"],
      compute: (subject, data) => {
        if (subject.kind !== "work") return [];
        return (data.blockers ?? [])
          .filter((b) => b.blockedWorkIds.includes(subject.work.id))
          .map((b) => ({
            rel: "",
            label: b.title || b.id,
            to: blockerLocation(b.id, data.projectId),
            title: "阻塞 id:" + b.id,
          }));
      },
    },
  ],
  member: [
    {
      key: "works",
      title: "负责的环节",
      needs: ["works"],
      compute: (subject, data) => {
        if (subject.kind !== "member") return [];
        return (data.works ?? [])
          .filter((w) => w.assigneeAgentId === subject.memberId)
          .map((w) => ({
            rel: "",
            label: titleOfWork(w) ?? w.id,
            to: workLocation(w.id),
            title: "工作项 id:" + w.id,
          }));
      },
    },
  ],
};

/**
 * 算一圈邻居。
 *
 * ⚠️ **只返回这个主体适用的组** —— 组要么是 `ready`(可能 0 条),要么是
 * `loading` / `unavailable`。不适用的组**整组不出现**(那是事实,不是故障)。
 *
 * ⚠️ **上下文整体缺席 ⇒ 全部 `unavailable`(「读不到」),不是崩溃** ——
 * 一个调用点忘了传上下文,症状应该是「这一面读不到」,
 * 而**不是整页白屏**。理由与「四态不许合一」同源:读不到必须**看得出来**。
 */
export function relationsOf(
  subject: RelationSubject,
  ctx: RelationContext | undefined,
): RelationGroup[] {
  const context: RelationContext = ctx ?? {};
  const specs = GROUPS[subject.kind] ?? [];
  const out: RelationGroup[] = [];
  for (const spec of specs) {
    if (spec.applicable !== undefined && !spec.applicable(subject)) continue;
    let state: RelationGroup["state"] = "ready";
    for (const k of spec.needs) {
      const piece = context[k];
      // 缺席 = 没接这份数据(「读不到」);出错 = 拉失败(「读不到」);在拉 = 「加载中」。
      if (piece === undefined || piece.error !== null) {
        state = "unavailable";
        break;
      }
      if (piece.loading) {
        state = "loading";
        break;
      }
    }
    const items =
      state === "ready"
        ? spec.compute(subject, {
            projectId: context.projectId,
            works: context.works?.data,
            artifacts: context.artifacts?.data,
            blockers: context.blockers?.data,
            members: context.members?.data,
          })
        : [];
    out.push({ key: spec.key, title: spec.title, state, items });
  }
  return out;
}

/** 这个主体**可能**有关系的那几类**(与实际算出来的分开)—— 用来回答「哪些没算出来」。 */
export function relationGroupTitles(subject: RelationSubject): string[] {
  return (GROUPS[subject.kind] ?? []).map((s) => s.title);
}

/** 成员名(给「负责的环节」那种没有标题的场景用)。 */
export function memberLabelOf(members: readonly MemberView[] | undefined, agentId: string): string {
  const m = members?.find((x) => x.id === agentId);
  return m?.displayName ?? agentId;
}

export { memberLocation, workLocation, artifactLocation, blockerLocation };
