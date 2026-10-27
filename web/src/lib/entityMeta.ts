/**
 * 「实体身份」—— 每类实体**一份**事实判据
 *
 * ── 它治的是什么病 ────────────────────────────────────────────────
 *
 * 同一个工件在这套界面里会被说到很多次:推进图旁边的清单、关系图的节点、
 * 展开后的详情、项目页的工件列表、成员面板的「他产出了什么」。
 * 改版前每一处都**自己写一遍**「类型 / 状态 / 作者 / 时间」——
 * 于是同一个工件在五个地方有五种说法:一处写「作者」一处写「产出者」,
 * 一处带时间一处不带,一处把 id 显示出来另一处不显示。
 *
 * 那不是「重复代码」的问题,是**同一个事实有五个来源**的问题:
 * 读者没法把两处的话对上,平台也没法保证两处说的是同一件事。
 *
 * ⇒ 所以身份是**一个纯函数**:同一类实体在哪儿出现,都调它。
 * 本文件**不 import React**(只有类型),所以它可以被单测直接比对
 * 「同一个工件的两次渲染给出同一组事实、同一顺序、同一批地址」。
 *
 * ── 「身份」与「详情」的分界 ──────────────────────────────────────
 *
 * 身份 = **这个东西是什么**(类型、状态、谁做的、什么时候、归谁)。
 * 详情 = 它的正文、它的依赖、它的原始字段。
 * ⚠️ 身份条一格都不许放「需要展开才看得懂」的东西 —— 它是**扫一眼**用的。
 *
 * ── 邻居 ──────────────────────────────────────────────────────────
 *
 * `MetaItem.links` 是「一圈邻居」的那根线:从一份工件能走到产出它的环节,
 * 从环节能走到负责人,从负责人能走回他的产出。
 * ⚠️ 链接的目标必须是**真地址**(`lib/route.ts` 的 `AppLocation`),
 * 不是字符串拼的 —— 手拼 `#/works?work=` + id 会在某处漏掉 encode,
 * 而一个漏 encode 的地址在工件 id 里带斜杠时会指向别的东西。
 *
 * ── 为什么没有「成员」这一份 ──────────────────────────────────────
 *
 * 成员**只出现在成员页**(他不是某个列表里的一项),而它的「身份」三件
 * (角色 / 名字 / 专长)已经由成员面板的标题与摘要行承担了。
 * 再加一条身份条只会让同一个词在同一块屏幕上出现三遍 ——
 * 那是另一种「各说一套」。⇒ 成员**作为邻居**存在(别人链到它),
 * 但**自己不占一条身份条**。
 */
import type {
  ArtifactView,
  BlockerView,
  KnowledgeChunkView,
  WorkView,
} from "@shared/types/platform";
import type { Tone } from "@/components/ui/primitives";
import {
  artifactKindLabel,
  artifactKindTone,
  artifactStatusLabel,
  artifactStatusTone,
  blockerSeverityLabel,
  blockerSeverityTone,
  blockerStatusLabel,
  blockerStatusTone,
  fmtTime,
  workStatusLabel,
  workStatusTone,
} from "./vocab";
import type { AppLocation } from "./route";

/** 身份条上的一格。`value` 是**已格式化**的文本 —— 格式化判据只有这一处。 */
export interface MetaItem {
  /** 这一格的**标签**。同一个实体在不同地方用**同一个词** —— 标签是契约的一部分。 */
  label: string;
  /** 文本值(没有 `links` 时用)。 */
  value?: string;
  tone?: Tone;
  /** 渲染成一枚 `Pill`(状态 / 类型这类「一枚徽标」的格子)。 */
  pill?: boolean;
  /** 判据出处(真 `title=`,不是悬停正文)。 */
  title?: string;
  /** 这一格指向别的实体(渲染成可点的链接)。 */
  links?: readonly MetaLink[];
}

export interface MetaLink {
  label: string;
  to: AppLocation;
}

// ── 邻居的地址 ────────────────────────────────────────────────────

/** 某个成员的地址(成员页选中他)。 */
export const memberLocation = (agentId: string): AppLocation => ({
  route: "members",
  params: { member: agentId },
});

/** 某条工作项的地址(工作项页选中它)。 */
export const workLocation = (workId: string): AppLocation => ({
  route: "works",
  params: { work: workId },
});

/**
 * 某份工件的地址。`workId` 给了就一起选上那个环节 ——
 * 于是「从一份工件走到产出它的环节」是一步,不是两步。
 */
export const artifactLocation = (artifactId: string, workId?: string | null): AppLocation => ({
  route: "works",
  params: workId ? { work: workId, artifact: artifactId } : { artifact: artifactId },
});

/**
 * 某条阻塞的地址(项目页定位到它)。
 *
 * ⚠️ **它指向的是项目页而不是工作项页** —— 阻塞是**项目级**的实体
 * (它卡住若干条环节,但不属于任何一条),所以它没有自己的「工作项页地址」。
 * 项目页是它唯一有地址的地方。
 *
 * ⚠️ **`projectId` 给了就一起带上** —— 阻塞只存在于**某一个**项目里,
 * 而「当前项目」是应用里的一处**全局选择**(store 的 `projectId`)。
 * 不带项目 id 的地址是**半个地址**:它只在「你正好在看那个项目」时成立,
 * 而链接的用处恰恰是**从别处跳过来**。⇒ 带项目 id 的地址才落得到点上。
 */
export const blockerLocation = (blockerId: string, projectId?: string | null): AppLocation => ({
  route: "project",
  params: projectId ? { project: projectId, blocker: blockerId } : { blocker: blockerId },
});

/**
 * 项目自己的地址。
 *
 * ⚠️ **带项目 id** —— 「当前项目」是应用里的一处**全局选择**(store 的 `projectId`),
 * 不带 id 的地址是**半个地址**:它只在「你正好在看那个项目」时成立,
 * 而链接的用处恰恰是**从别处跳过来**。
 */
export const projectLocation = (projectId: string | null | undefined): AppLocation => ({
  route: "project",
  params: projectId ? { project: projectId } : {},
});

/**
 * 给一条地址**补上项目坐标**。
 *
 * ⚠️ **只在地址指向别的项目时需要** —— 同项目内的地址(当前项目里的工件、
 * 环节、成员)补了坐标只是噪音(而坐标是**坐标**,不是状态:它回答
 * 「这条地址说的是哪个项目」,不回答「你现在在看哪个项目」)。
 *
 * ⇒ 这也是「跨项目地址带坐标」的唯一实现处:页面**不许**自己拼 `project=`。
 */
export const withProjectCoordinate = (
  loc: AppLocation,
  projectId: string | null | undefined,
): AppLocation =>
  projectId ? { route: loc.route, params: { ...loc.params, project: projectId } } : loc;

/**
 * 一块**语料**的来源地址(记忆页「知识语料」段)。
 *
 * ⚠️ **语料是全局可读的**(跨项目),所以它的来源地址**几乎总是跨项目的**
 * ⇒ 不带坐标就是**半个地址**:点得动、跳得过去、就是找不到。
 *
 * ⚠️ **消息来源没有自己的地址** —— 库里那条消息属于某条对话线,
 * 而地址这一层**还没有「定位到某条消息」的参数**(对话页只有项目与线两个层级)。
 * ⇒ 消息来源落到**那个项目的对话页**(落得到点上,只是落不到那一句)。
 * 这个缺口如实记着,不假装「点进去就能看到那句话」。
 */
export function chunkSourceLocation(chunk: KnowledgeChunkView): AppLocation | null {
  // ⚠️ **拿不到项目 ⇒ 不编地址** —— 半个地址(只在「你正好在看那个项目」时成立)
  // 比没有地址更坏:点得动、跳得过去、就是找不到。
  if (chunk.projectId === null) return null;
  if (chunk.sourceKind === "artifact") {
    if (chunk.artifactId === null) return null;
    return withProjectCoordinate(artifactLocation(chunk.artifactId), chunk.projectId);
  }
  return withProjectCoordinate({ route: "chat", params: {} }, chunk.projectId);
}

/**
 * 一块语料的来源**叫什么**(与地址同源 —— 标签与地址不许各说各的)。
 */
export function chunkSourceLabel(chunk: KnowledgeChunkView): string {
  if (chunk.sourceKind === "artifact") {
    return chunk.artifactTitle ?? chunk.artifactId ?? chunk.sourceId;
  }
  return chunk.messageId ?? chunk.sourceId;
}

// ── 三类实体的身份 ────────────────────────────────────────────────

/**
 * 「作者」那一格的**文本**。
 *
 * ⚠️ 单独导出是因为别处(图节点的悬浮提示)也要说「谁做的」——
 * 那一处**不许**自己写 `authorName || authorAgentId`:
 * 那样就多了一个事实来源,而两份写法一旦漂开,界面上看不出来。
 */
export function authorLabelOf(a: ArtifactView): string {
  return a.authorName || a.authorAgentId;
}

export interface ArtifactMetaOptions {
  /**
   * 「产出于」那一格显示的**标题**。拿不到就退成工作项 id(不留空 ——
   * 留空与「没有」在屏幕上长得一样)。
   */
  workTitle?: string | null;
  /**
   * 作者格是否显示。**在「他产出了什么」那份清单里作者就是清单的主人**,
   * 再写一遍「作者 业务经理」是废话 —— 那里传 `false`。
   */
  withAuthor?: boolean;
}

/**
 * 工件的身份。**一份**判据,哪儿出现都调它。
 *
 * ⚠️ `workTitle` **拿不到就退成 id**,不留空 —— 「不知道标题」与
 * 「不由任何环节产出」是两件不同的事:后者写「不由工作项产出」,
 * 前者写 id 并把它放进 `title=`。
 */
export function artifactMeta(a: ArtifactView, opts: ArtifactMetaOptions = {}): MetaItem[] {
  const withAuthor = opts.withAuthor !== false;
  const items: MetaItem[] = [
    {
      label: "类型",
      value: artifactKindLabel(a.kind),
      tone: artifactKindTone(a.kind),
      pill: true,
    },
    {
      label: "状态",
      value: artifactStatusLabel(a.status),
      tone: artifactStatusTone(a.status),
      pill: true,
    },
  ];
  if (withAuthor) {
    items.push({
      label: "作者",
      links: [{ label: authorLabelOf(a), to: memberLocation(a.authorAgentId) }],
      title: "作者 id:" + a.authorAgentId,
    });
  }
  items.push(
    a.workId === null
      ? {
          label: "产出于",
          value: "不由工作项产出",
          title: "决策 / 甲方问答这类工件不是任何工作项的执行产出",
        }
      : {
          label: "产出于",
          links: [{ label: opts.workTitle ?? a.workId, to: workLocation(a.workId) }],
          title: "产出它的工作项 id:" + a.workId,
        },
  );
  items.push({ label: "创建", value: fmtTime(a.createdAt), title: "契约 ArtifactView.createdAt" });
  return items;
}

/** 工作项的身份。 */
export function workMeta(w: WorkView): MetaItem[] {
  return [
    {
      label: "状态",
      value: workStatusLabel(w.status),
      tone: workStatusTone(w.status),
      pill: true,
    },
    {
      label: "负责人",
      links: [{ label: w.assigneeName || w.assigneeAgentId, to: memberLocation(w.assigneeAgentId) }],
      title: "负责人 id:" + w.assigneeAgentId,
    },
    w.parentWorkId === null
      ? { label: "父项", value: "顶层环节", title: "没有父工作项 —— 这是一条顶层环节" }
      : {
          label: "父项",
          links: [{ label: w.parentWorkId, to: workLocation(w.parentWorkId) }],
          title: "父工作项 id:" + w.parentWorkId,
        },
    { label: "创建", value: fmtTime(w.createdAt), title: "契约 WorkView.createdAt" },
    { label: "更新", value: fmtTime(w.updatedAt), title: "契约 WorkView.updatedAt" },
  ];
}

/**
 * 阻塞的身份。
 *
 * ⚠️ 「卡住」那格的**条数是数出来的**,不是估的;每一条都带一个地址 ——
 * 「哪件事被卡住了」才是甲方要的答案,而一个没有地址的答案只能让人去搜。
 */
export function blockerMeta(b: BlockerView, workTitles?: ReadonlyMap<string, string>): MetaItem[] {
  return [
    {
      label: "严重度",
      value: blockerSeverityLabel(b.severity),
      tone: blockerSeverityTone(b.severity),
      pill: true,
    },
    {
      label: "状态",
      value: blockerStatusLabel(b.status),
      tone: blockerStatusTone(b.status),
      pill: true,
    },
    { label: "提出者", value: b.raisedByName },
    {
      label: "卡住",
      value:
        b.blockedWorkIds.length === 0
          ? "没有登记卡住的工作项"
          : `${b.blockedWorkIds.length} 个工作项`,
      links:
        b.blockedWorkIds.length === 0
          ? undefined
          : b.blockedWorkIds.map((id) => ({
              label: workTitles?.get(id) ?? id,
              to: workLocation(id),
            })),
      title:
        b.blockedWorkIds.length === 0
          ? "没有登记它卡住了哪些工作项"
          : "卡住的工作项 id:" + b.blockedWorkIds.join(", "),
    },
    { label: "登记", value: fmtTime(b.createdAt), title: "契约 BlockerView.createdAt" },
  ];
}
