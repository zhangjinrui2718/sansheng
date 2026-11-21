/**
 * 成员屏(取代旧的 `Agents.tsx`)
 *
 * ── 为什么换了主体(上一版留下的理由,仍然成立)────────────────────
 *
 * 旧页是「Agent 工作面」:从**工件 author** 反推 planner / executor / harness_manager
 * 在不在跑,还画了一张 todo 的 DAG —— 那是旧系统「按 agent 分工 + 计划即 todo」的
 * 读法,而计划概念在新架构里已删除、agent 也不再是自由命名的角色。
 *
 * 新模型里人/角色的真身在两处:
 *   1. **本项目成员** —— `ProjectDetail.members`(MemberView:role / displayName /
 *      specialization),四个固定职能;
 *   2. **每个角色的能力面** —— `GET /api/harness`(ceiling / writeKinds / tools /
 *      clientFacing),这是只读的架构常量视图。
 *
 * ── 2026-10-06:这一版换掉了什么、为什么 ──────────────────────────
 *
 * 用户的原话(两条,逐字):
 *
 *   「2. 成员的可读性也很差,改成和 harness 类似的可以根据角色做切换」
 *   「3. 成员中我感觉在做什么事情,这个信息没有实时的同步到成员的这个页面来,
 *     现在只有做了些什么,没有正在做什么,有时候我看不懂任何状态性的前端展示,
 *     我担心系统已经挂了,而实际还在运行」
 *
 * 所以这一版换掉两件事,它们**互不替代**:
 *
 *   ① **摆放**(对应用户第 2 条)—— 上一版把四份内容同时铺开:本项目成员 KV +
 *      「他产生了什么对话」里四个人的卡片 + 「角色能力面」里四个角色的卡片。
 *      一屏里同一个人的信息散在三处,而四个人的消息又互相把结构淹掉。
 *      现在照 `Harness.tsx` 的做法(那是同一次可读性改造的另一半):
 *      **一行成员页签**(`role="tablist"` / `aria-selected`,页签上带「它欠着几件事」
 *      的角标与「正在跑」的实时点)+ **一次只渲染一个成员的面板**。
 *
 *   ② **时态**(对应用户第 3 条,这是更要紧的一条)—— 上一版整页都是过去时:
 *      「他产生了什么对话」回答的是「他做过什么」。而一个正在跑 16 分钟回合的
 *      worker 与一个已经停了三小时的 worker,在那一屏里**长得一模一样** ——
 *      这正是用户说的「我担心系统已经挂了,而实际还在运行」。
 *      新增「正在做什么」,数据源是 `useProjectLive`(它自带 2.5s 轮询,是全项目
 *      唯一破例轮询的 hook:WS 只覆盖状态迁移,而「现在」只能由定时器回答)。
 *
 * ── 2026-10-06(同日第二刀):又合并了什么、删了什么 ────────────────
 *
 * 用户的原话(两条,逐字):
 *
 *   「(成员页底部的「不在成员表里的发言」与「本项目成员一览」)这个信息不要
 *     展示了,我感觉没什么意思」
 *   「成员的 harness 管理可以放在成员的 tab 下面,可以把「成员」「harness」
 *     这两个 tab 也合并了」
 *
 * 所以这一版:
 *
 *   ① **「本项目成员一览」整段删除。** 它复述的就是页签上的东西(标签 = 角色、
 *      值 = 显示名、悬停 = agentId),屏幕上会出现「业务经理 业务经理 bm」这种
 *      重复 —— 用户说它「没什么意思」是准确的。删掉不丢任何判据:成员的身份
 *      仍在页签的 tooltip(`agentId = …`)、面板标题(角色名)与摘要行的等宽 id 里。
 *   ② **「不在成员表里的发言」只保留有信息量的那一半** —— 真的不在成员表里的
 *      agent 的发言(`strangers`);**删掉「甲方(你)/平台通知」那张卡**:甲方
 *      自己的话在对话页,平台通知走对话页的系统带,成员页再抄一份就是重复。
 *      整段**只在 `strangers` 非空时才渲染**(真机数据里是 0 个 ⇒ 整段不出现)。
 *      ⚠️ 这不是「静默丢数据」:`strangers` 一旦非空,那一段会写明「这些发言的
 *      作者不在本项目成员表里(可能是历史身份的残留);列出来是为了不静默丢证据」。
 *   ③ **harness 管理并进这一屏** —— 见 `components/members/RoleHarness.tsx`
 *      (它从 `routes/Harness.tsx` 搬来;那个路由页面与它那一行角色页签都已删)。
 *      `MemberPane` 里那块**只读**的「角色能力面」换成自足的
 *      `RoleHarnessSection`(同一处,不许两块并存 —— 那正是用户一直在清理的
 *      重复),那个「只读角色能力面」的 prop 随之删除。旧角色页签承担的「一次只看一个角色」
 *      改由**成员页签**承担(一人一角色)。
 *      ⚠️ 页签角标因此变成**两个**且各有自己的 `title`:「欠活」(本页原有口径:
 *      `readyWorks + todos.length`)+ `roleIssueCount` 的告警角标(缺单元 /
 *      集合文件坏 / 越权被拒 / 未知工具名)。后者是原 harness 页页签角标的功能,
 *      合并后不能丢。
 *
 * ── 2026-10-06(同日第三刀):为什么 harness 要**单独成一张卡**──────────
 *
 * 用户的原话(逐字):
 *
 *   「成员中,角色 harness 单独放一个卡片出来,未来角色的 harness 配置就放在
 *     这个地方」
 *
 * 所以 `MemberPane` 里第 5 块(harness)被**拿了出来**,在同一个 tab 面板里、
 * 面板**之下**单独渲染一块(`MemberTabPanels` 的两个槽:member / harness)。
 * 为什么值得单独一张卡,而不是「成员面板的第 5 块」:
 *
 *   1. **归属不同** —— 那一块描述的是**角色**(能力面 / 提示词单元 / 工具集合
 *      文件),不是**这个人此刻在干什么**。夹在「他产生了什么对话 / 他产出了什么
 *      工件」中间,它会被读成这个成员的又一项活动。
 *   2. **去处明确** —— 它是**未来角色 harness 配置的唯一落点**(用户原话)。
 *      卡片头一行就摆出「这个角色的 harness 正不正常」(状态摘要 + 告警 Pill),
 *      可编辑的内容默认折叠;`Section` 的 `helpId="harness.card"`(一个 `?`)里写清
 *      「这里改什么、什么改不了(ceiling / writeKinds 是代码内常量)」。
 *   3. `MemberPane` 因此**不再接收任何 harness 相关的 prop** —— 「这个人此刻
 *      怎么样」与「这个角色能干什么」两块各自成立,不再互相拖着一堆参数。
 *
 * ── 这一版最硬的一条纪律:三种「不知道」不许长得像「一切正常」────────
 *
 * 契约 `MemberActivityView` / `ProjectLiveView` 的注释逐字写着这件事,前端照做:
 *
 *   - `runtime: "unavailable"` —— **这个进程没接上运行期快照**(例如只挂 HTTP 的
 *     测试装配)。它**不是**「没在跑」,是「读不到」。此时 `turn` 一律 `null`,
 *     界面**绝不**能据此说「空闲 / 没有在跑」;要显示成一句带灰点的
 *     「运行态读不到(该进程没接上运行期快照)」,而**库里的那部分**
 *     (`currentWorks` / `todos` / 最近活动)**照常显示** —— 它们重启后照样成立。
 *   - `live.data === null` —— **还没拿到过任何一份快照**。此时连「读不到」都还不能
 *     断言(请求可能正在路上),所以显示「正在读取运行态…」,而不是一个空的
 *     「一切正常」。一个凭空造的空白运行态会被读成「空闲」,那是同一类谎。
 *   - `turn === null` 而 `runtime === "host"` —— 这**才**允许说「此刻没有回合在跑」。
 *     注意措辞刻意不是「空闲」:真正该读成「空闲」的判据是三者合起来
 *     (没有回合、没有进行中的工作项、没有待办),而这一行只回答其中一问。
 *
 * 页面上**不许只靠颜色**表达状态:每个 Pill 都带中文词,灰点旁边一定有「读不到」
 * 这四个字(色盲用户与截图里都分不出绿点与灰点)。
 *
 * ── 2026-11-20(v5 Wave D):页签形态 → **全员并发板** ──────────────
 *
 * 用户裁决:「成员是可以并发的吧,重新设计一下现在项目成员的展示方式。」
 * 它**取代**了上面 ① 的「一行成员页签 + 一次只渲染一个成员的面板」—— 那是
 * 防杂乱的设计,与「并发可见」正好相反(忙闩键 = (项目, agent),用户回合与
 * 内部推进真的会同时跑)。新形态:每成员一张卡、**同屏常渲染**(`MemberBoard`,
 * components/members/MemberCard.tsx),点卡按 `?member=` 在板下展开完整面板
 * (`MemberPane` 原样保留;harness 卡仍在面板之下 —— 2026-10-06 第三刀的归属不变)。
 * 「一次只看一个」的负样本判据(①)依旧成立:面板一次仍只渲染一个成员。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  ArtifactView,
  MemberActivityView,
  MemberConversationView,
  MemberView,
  ProjectLiveView,
  ProjectRole,
  SessionMessageKind,
  WorkView,
} from "@shared/types/platform";
import {
  Disclosure,
  EmptyState,
  PageHeader,
  Pill,
  RedMeta,
  Section,
  StatStrip,
} from "@/components/ui/primitives";
import { DataState, remoteListOf } from "@/components/ui/DataState";
import { Help } from "@/components/ui/Help";
import { EntityLink, MetadataStrip } from "@/components/ui/MetadataStrip";
import { RelationsRail } from "@/components/relations/RelationsRail";
import { useAppLocation, paramOf } from "@/app/router";
import { artifactLocation, artifactMeta } from "@/lib/entityMeta";
import type { RelationContext } from "@/lib/relations";
import { RoleHarnessSection, roleIssueCount } from "@/components/members/RoleHarness";
import { AgentConversations } from "@/components/members/AgentConversations";
import { MemberBoard } from "@/components/members/MemberCard";
import { TurnStatus } from "@/components/members/TurnStatus";
import { inFlightTurns, type Turn } from "@/stores/chat";
import {
  useArtifacts,
  useHarnessRoles,
  useMemberConversations,
  useProjectLive,
  useProjectMembers,
  useWorks,
} from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import {
  ROLE_LABEL,
  MESSAGE_KIND_LABEL,
  excerpt,
  fmtTime,
  workStatusLabel,
  workStatusTone,
} from "@/lib/vocab";

/**
 * ⚠️ **这一屏原来自己写了一张 `session_messages.kind` 的中文读法表**
 * (`KIND_LABEL`),注释写着「只在这一屏用」—— 而 2026-10-26 之后
 * 「成员页的对话全文」(`components/members/AgentConversations.tsx`)也要用它。
 * 两处各写一张表,它们就会当场漂开 ⇒ **已搬进 `lib/vocab.ts`**
 * (`MESSAGE_KIND_LABEL`),本文件与新组件都从那里取。
 */
const OTHER_KINDS: readonly SessionMessageKind[] = ["assistant", "thinking", "tool"];

// ── 活动判据已搬到 `components/members/activity.ts`(v5 Wave D)────────
// MemberCard(板)与 MemberPane(面板)读同一份;这里 re-export 是给
// 既有测试的(它们从本文件 import 这些名字 —— 判据搬家,读者地址不变)。
import {
  debtFacts,
  elapsedSinceFetch,
  formatAge,
  memberDebt,
  triggerText,
} from "@/components/members/activity";
export { debtFacts, elapsedSinceFetch, formatAge, memberDebt, triggerText } from "@/components/members/activity";

/** 本地时钟。只为一件事存在:让快照里的 `ageMs` 在屏上继续走(见 `elapsedSinceFetch`)。 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * 一个成员的面板。顺序刻意是**「先看现在 → 再看欠什么 → 最后看过去」**:
 *
 *   1. 摘要行 —— 名字 / 角色 / 专长 / id / **此刻状态**;
 *   2. 「正在做什么」—— 库里的活 + 排空器的待办 + 最近一次动 + 排空器心跳;
 *   3. 「他产生了什么对话」—— **默认折叠**(否则一屏又被消息刷满);
 *   4. 「他产出了什么工件」—— 把成员页与工件页连起来。
 *
 * ⚠️ 2026-10-06(第三刀):这里原来还有第 5 块 —— 角色的 harness。用户原话是
 * 「成员中,角色 harness 单独放一个卡片出来,未来角色的 harness 配置就放在这个
 * 地方」,所以它**搬出去了**,由本文件在面板**之下**另起一块
 * (`RoleHarnessSection`,见 `MemberTabPanels`)。`MemberPane` 因此不再接收
 * 任何 harness 相关的 prop —— 它只回答「这个人此刻怎么样」。
 *
 * 纯 props(与 `HarnessRolePane` / `ConversationCard` 同一处置):导出给测试,
 * 不需要起服务、不需要 stub fetch。
 */
export function MemberPane({
  member,
  activity,
  projectId,
  artifacts,
  works,
  relations,
  runtime,
  dispatch,
  fetchedAt,
  now,
}: {
  member: MemberView;
  /** 这个人在这份运行态快照里的那一条;`null` = 还没拿到快照(或快照里没有他) */
  activity: MemberActivityView | null;
  /**
   * 本项目的 id —— 「他说了什么」那块要自己取数(它有自己的端点与自己的窗口)。
   *
   * ⚠️ **2026-10-26:这一块从「清单」改成「全文」** —— 原来它接的是
   * `GET /api/projects/:id/member-conversations` 的那一组摘要(每条截到 90 字、
   * 新的在前、默认折叠),而用户要的是「**具体的对话内容**」。于是:
   *   · `conversation` / `conversationError` 两个 prop **删掉了** —— 它们的读者
   *     (那块摘要列表)已经不在了;留着就是「没有调用方的参数」(死分支)。
   *   · 条数与「读不到」现在由**新组件自己**从新端点拿(同一套纪律:
   *     「读不到」不许显示成「0 条」)。
   */
  projectId: string;
  /** 已按 `authorAgentId === member.id` **过滤好**的工件 —— 过滤在页面层做 */
  artifacts: readonly ArtifactView[];
  /**
   * 本项目的工作项 —— 用来把工件身份条里「产出于」那一格翻成**标题**
   * (拿不到就退成 id,见 `lib/entityMeta.ts`)。
   */
  works: readonly WorkView[];
  /**
   * 关系上下文(算「一圈邻居」用,见 `lib/relations.ts`)。
   *
   * ⚠️ **带加载态** —— 「他负责的环节」在数据还没到的时候是**不知道**,
   * 不是「没有」。两者在屏幕上长得一模一样,而这正是这次要治的观感。
   */
  relations: RelationContext;
  /** 这份快照的运行期来源;`null` = 还没拿到过快照 */
  runtime: ProjectLiveView["runtime"] | null;
  /** 排空器心跳(项目级)—— `null` = 还没拿到过快照 */
  dispatch: ProjectLiveView["dispatch"] | null;
  /** 本地收到这份快照的时刻;`null` = 没有快照(那时年龄一律按快照原值显示) */
  fetchedAt: number | null;
  /** 页面这一刻的本地时钟 */
  now: number;
}) {
  const drift = elapsedSinceFetch(fetchedAt, now);
  /** 快照值 → 屏上此刻的年龄(加法为什么成立,见 `elapsedSinceFetch`)。 */
  const age = (ms: number) => formatAge(ms + drift);
  /** 拿到过一条快照没有。`false` = 连「读不到」都还不能断言。 */
  const hasSnapshot = activity !== null;
  const facts = activity === null ? [] : debtFacts(activity);

  return (
    <Section
      // ⚠️ 标题 = **角色名**(与页签、与 harness 页逐字相同,2026-10-06)。
      // 以前这里是 `member.displayName`,而摘要行里又紧跟一个角色 Pill —— 一人一
      // 角色的组织里那两个词一模一样,屏幕上就成了「工程师 [工程师]」。
      title={ROLE_LABEL[member.role]}
      aside={
        <span className="ss-meta font-mono" title="role —— 角色是属性,身份是 agentId(摘要行里那个等宽小字)">
          {member.role}
        </span>
      }
    >
      <article className="sansheng-card p-3 flex flex-col gap-3">
        {/* ── ① 摘要行:这个人是谁 + **此刻**在不在跑 ─────────────── */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* 人的名字只在**与角色名不同**时才写出来(它是数据,可以被人改;
              同名的场合再写一遍就是冗余 —— 角色名已经在标题与页签上了)。 */}
          {member.displayName !== ROLE_LABEL[member.role] && (
            <span className="ss-body" style={{ color: "var(--bone)" }}>
              {member.displayName}
            </span>
          )}
          {member.specialization !== null && (
            <span className="ss-meta" title={`specialization = ${member.specialization}`}>
              专长 {member.specialization}
            </span>
          )}
          <span className="ss-meta font-mono">{member.id}</span>
          <span className="flex items-center gap-1.5">
            <TurnStatus runtime={runtime} activity={activity} age={age} />
          </span>
        </div>

        {/* ── ② 正在做什么:这一版新增的一块 ───────────────────────── */}
        <div className="flex flex-col gap-2" style={{ borderTop: "1px solid var(--ink-3)", paddingTop: 8 }}>
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <div className="ss-section" style={{ fontSize: 12 }}>
              正在做什么
            </div>
            {/* 这份快照的**新鲜度**。它是「界面会不会停在最后一帧」的唯一可见证据:
                轮询若一直失败,这个数会一直变大(年龄也从那一刻继续推),用户据此
                知道屏上这些「在跑」是**那一刻**的事,而页首那一行会同时报出失败。 */}
            {fetchedAt !== null && (
              <span
                className="ss-meta"
                title="本地收到这一刻的快照 · 一直变大 = 轮询没回来"
              >
                快照 {formatAge(elapsedSinceFetch(fetchedAt, now))} 前收到
              </span>
            )}
          </div>

          {!hasSnapshot ? (
            // ⚠️ `live.data === null`:**不许**渲染成「手上没有进行中的工作项」
            // —— 那是把「还不知道」显示成「一切正常」,与这次要修的是同一类谎。
            <div className="ss-note">
              正在读取运行态…(还没有拿到过一份运行态快照。这一块不代表他手上没事,只是还不知道)
            </div>
          ) : (
            <>
              {/* 库里的真状态(重启后照样成立) */}
              <div className="flex flex-col">
                <span className="ss-meta flex items-center gap-1">
                  <span>手上的活</span>
                  <Help id="agent.busy" />
                </span>
                {activity.currentWorks.length === 0 ? (
                  <div className="ss-note">手上没有进行中的工作项</div>
                ) : (
                  activity.currentWorks.map((w) => (
                    <div
                      key={w.id}
                      className="flex items-baseline gap-2 flex-wrap"
                      style={{ fontSize: 12 }}
                    >
                      <Pill tone={workStatusTone(w.status)}>{workStatusLabel(w.status)}</Pill>
                      <span className="truncate" style={{ color: "var(--bone)" }} title={`${w.title} · ${w.id}`}>
                        {w.title}
                      </span>
                      <span className="ss-meta">更新于 {age(w.ageMs)}</span>
                    </div>
                  ))
                )}
              </div>

              {/* 欠着什么:只有 > 0 的项才出现,数量为 0 的不许占版面 */}
              {facts.length > 0 && (
                <div className="ss-meta flex items-center gap-1">
                  <span>{facts.join(" · ")}</span>
                  <Help id="member.todos" />
                </div>
              )}

              {/* 排空器自己的判据 —— 不是前端重算的一份 */}
              <div className="flex flex-col">
                <span
                  className="ss-meta"
                  title="与排空器同一判据,前端不重算 · 用满预算的在上一个数里"
                >
                  排空器现在要叫醒它的待办
                </span>
                {activity.todos.length === 0 ? (
                  activity.exhaustedTodos === 0 ? (
                    <div className="ss-note">排空器现在没有该它跑的待办</div>
                  ) : (
                    // ⚠️ 这一支不许静默留空:预算用尽的条目**不在** runnable 里,
                    // 所以这一列会是空的 —— 只说「没有待办」会与「它马上就会跑」
                    // 长得一样(用户这次要修的就是这类观感)。
                    <div className="ss-note">
                      排空器此刻没有该它跑的待办 —— 但有 {activity.exhaustedTodos} 件尝试预算已用尽,
                      <span style={{ color: "var(--cinnabar)" }}>不会再被叫醒</span>
                      (就是上一行那个数)。
                    </div>
                  )
                ) : (
                  activity.todos.map((t, i) => (
                    <div
                      key={`${t.kind}-${t.target ?? "none"}-${i}`}
                      className="flex items-baseline gap-2 flex-wrap"
                      style={{ fontSize: 12 }}
                    >
                      <span
                        style={{ color: "var(--bone)" }}
                        title={`kind = ${t.kind}${t.target !== null ? ` · target = ${t.target}` : ""}`}
                      >
                        {t.label}
                      </span>
                      <span className="ss-meta">
                        已叫醒 {t.attempts}/{t.maxAttempts} 次
                      </span>
                    </div>
                  ))
                )}
              </div>

              {/* 最近一次「动」的痕迹(落库的,不是内存的)。
                  ⚠️ 契约里**没有**「最后使用的工具」这一格:`tool` 从不落库(工具调用只走
                  WS 广播),`MemberActivityView` 里曾经有的 `lastTool` 在真机库上恒为 null
                  (没有写入方),已被契约删除(见 `shared/types/platform.ts` 的
                  `lastMessage` 注释)。所以这里只显示落库痕迹,不编一个工具名出来 ——
                  「正在调什么工具」只有 WS 在飞轮里有(那是对话页的事,不在这一屏)。 */}
              <div
                className="ss-meta"
                title="最后一次留下痕迹的时刻 · 不回答「现在在不在跑」"
              >
                {activity.lastMessage !== null ? (
                  <>
                    最后一次动:{MESSAGE_KIND_LABEL[activity.lastMessage.kind]}{" "}
                    {excerpt(activity.lastMessage.excerpt, 60)} · {age(activity.lastMessage.ageMs)}
                  </>
                ) : (
                  <>没有落库的会话消息(它的历史里还没有任何一条)</>
                )}
              </div>

              {/* 排空器心跳 —— **项目级**,不随成员变;一次只渲染一个面板,所以它只出现一次 */}
              {dispatch !== null && (
                <div
                  className="ss-meta"
                  style={{ borderTop: "1px solid var(--ink-3)", paddingTop: 6 }}
                  title="定时器心跳(默认 10s)· 它只说「去查一下」,不携带状态"
                >
                  平台兜底每 {dispatch.intervalMs / 1000}s 查一次 ·{" "}
                  {runtime === "unavailable" ? (
                    // ⚠️ 这里**不能**照抄下面那句 `lastRunAgeMs === null` 的文案:
                    // unavailable 时该字段为 null 是因为**没接上快照**,不是因为
                    // 「本进程没跑过」—— 照抄就把「读不到」说成了「没发生」。
                    <span style={{ color: "var(--amber)" }}>心跳读不到(该进程没接上运行期快照)</span>
                  ) : dispatch.lastRunAgeMs === null ? (
                    <span>本进程还没跑过兜底检查</span>
                  ) : (
                    <span>上一次 {age(dispatch.lastRunAgeMs)}</span>
                  )}
                  {dispatch.draining && (
                    <>
                      {" · "}
                      <Pill tone="jade" title="此刻正在排空这个项目(drainProject 在跑)">
                        正在排空这个项目
                      </Pill>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── ② 他负责的环节(「一圈邻居」)────────────────────────── */}
        {/* ⚠️ 改版前**没有这一面** —— 成员面板只说「他手上正在跑什么」与
            「他产出了什么工件」,而「他负责哪几条活」(含**已完成的**那些)
            在别处也查不到。现在它是一条关系栏,每一项都是**能点的地址**。 */}
        <RelationsRail
          subject={{ kind: "member", memberId: member.id }}
          context={relations}
          title="他负责的环节"
        />

        {/* ── ③ 他说了什么 —— **对话全文**(进行中 + 已完成)────────── */}
        {/* ⚠️ 2026-10-26:这一块从「清单」改成「全文」。原来它接的是
            `member-conversations` 的那一组摘要(每条**截到 90 字**、新的在前、
            默认折叠)—— 那不是「对话内容」。现在它自己取数
            (`GET /api/projects/:id/agents/:agentId/conversations`),
            逐条对话线 + **全文**,并把「正在流的」那一段单独摆出来。
            ⚠️ **两块不许并存**:摘要列表与全文是同一份数据的两种读法,
            成员页再抄一份就是重复(与「甲方(你)/平台通知」那张卡被删同一条理由)。 */}
        <div className="flex flex-col gap-1.5" style={{ borderTop: "1px solid var(--ink-3)", paddingTop: 8 }}>
          <span
            className="ss-meta flex items-center gap-1"
            title="逐条对话线 + 选中那条线的全文(旧 → 新)"
          >
            他说了什么
            <Help id="member.conversations" />
          </span>
          <AgentConversations
            // ⚠️ `key` = 换人时重置「选中哪条线」:上一个成员选的那条线对
            // 新成员多半没有意义(它不在他的线里),留着会让新面板一开始
            // 指向一条不属于他的线。
            key={member.id}
            projectId={projectId}
            agentId={member.id}
            agentName={ROLE_LABEL[member.role]}
          />
        </div>

        {/* ── ④ 他产出了什么工件(成员页 × 工件页的那条连线)──────── */}
        <div className="flex flex-col">
          <span
            className="ss-meta"
            title="按作者过滤 · 一个人的活干到哪,看他产出了什么"
          >
            他产出了什么工件 · {artifacts.length} 件
          </span>
          {artifacts.length === 0 ? (
            <div className="ss-note">他还没有产出的工件。</div>
          ) : (
            artifacts.map((a) => (
              <div key={a.id} className="flex flex-col gap-0.5" style={{ fontSize: 12 }}>
                <EntityLink
                  to={artifactLocation(a.id, a.workId)}
                  title={`${a.title} · ${a.id}`}
                  className="truncate"
                >
                  {a.title || "(无标题)"}
                </EntityLink>
                {/*
                  身份条 —— 与工作项页那份工件清单**同一组事实**
                  (`lib/entityMeta.ts` 的同一份判据)。
                  ⚠️ `withAuthor: false`:这份清单的**主人就是他本人**,
                  再写一遍「作者 业务经理」是废话。
                */}
                <MetadataStrip
                  items={artifactMeta(a, {
                    withAuthor: false,
                    workTitle:
                      a.workId === null
                        ? null
                        : (works.find((w) => w.id === a.workId)?.title ?? null),
                  })}
                />
              </div>
            ))
          )}
        </div>
      </article>
    </Section>
  );
}

/**
 * 同一个成员 tab 面板里的**两块**:成员面板 + 它下面单独一张「角色 harness」卡。
 *
 * 为什么要抽成一个组件、而不是在页面里并排写两个元素:`MembersPage` 从 store
 * (`useChatStore`)取 `projectId`,SSR 下读的是 server snapshot ⇒ 驱动不了
 * (`renderToStaticMarkup` 里它是恒定的空页)。把这两块的**位置与归属**抽成纯
 * props 的组合,测试才能断言:
 *
 *   - harness **不在**成员面板那张卡**里面**(它是角色的配置面,不是这个成员
 *     此刻的活动 —— 见 `RoleHarness.tsx` 文件头);
 *   - 它在面板**之后**、同一个 tab 面板里另起一块(用户原话:「成员中,角色
 *     harness 单独放一个卡片出来,未来角色的 harness 配置就放在这个地方」)。
 */
export function MemberTabPanels({ member, harness }: { member: ReactNode; harness: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {member}
      {harness}
    </div>
  );
}

/**
 * 一个发言者的清单。
 *
 * 导出是给**测试 / 真机验证**用的(纯 props,与 `TurnView` / `ConversationStream`
 * 同一个理由):`MembersPage` 从 store 取 `projectId`,SSR 下读的是 server snapshot
 * ⇒ 驱动不了。真机那一跑要断言的是「屏幕上的条数 = 库里 `GROUP BY agent_id` 的数」,
 * 那正是这个组件显示的 `total`。
 *
 * `group === null` = 后端一组都没返回(这个人一条都没说过)—— 那时显示 `emptyText`,
 * 而 `total` 显示 0:**它真的就是 0**(端点会把有消息的组都返回;没有这个组
 * = 库里确实没有它的行)。
 */
export function ConversationCard({
  title,
  role,
  agentId,
  group,
  kinds,
  emptyText,
}: {
  title: string;
  role: string;
  agentId: string | null;
  group: MemberConversationView | null;
  kinds: readonly SessionMessageKind[];
  emptyText: string;
}) {
  const total = group?.total ?? 0;
  const messages = group?.messages ?? [];
  const summary = group !== null ? kindSummary(group, kinds) : "";
  return (
    <article className="sansheng-card p-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="ss-body" style={{ color: "var(--bone)" }}>
          {title}
        </span>
        <Pill tone="mute">{role}</Pill>
        <span className="ss-meta ml-auto font-mono" title={agentId ?? "agent_id IS NULL"}>
          {total} 条
        </span>
      </div>
      {/* ⚠️ 这里的摘要**只**来自 `kindSummary`(真实条数)。2026-10-06 删掉了
          `note` 参数:它唯一的调用方是「甲方(你)/平台通知」那张卡,而那张卡
          整段已删(甲方的话在对话页、平台通知走对话页的系统带)。删掉参数的同时
          删掉这条分支 —— 留一个没有调用方的可选参数就是死分支。 */}
      {summary !== "" && <div className="ss-meta mt-0.5">{summary}</div>}
      {messages.length === 0 ? (
        <div className="ss-note mt-1">{emptyText}</div>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {messages.map((m) => (
            <li key={m.id} className="flex gap-2 items-baseline" style={{ fontSize: 12 }}>
              <span className="ss-meta flex-none font-mono">{fmtTime(m.createdAt)}</span>
              <span className="ss-meta flex-none">{MESSAGE_KIND_LABEL[m.kind]}</span>
              <span
                className="truncate"
                style={{ color: "var(--bone)" }}
                title={m.content}
              >
                {excerpt(m.content, 90)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {group?.truncated === true && (
        <div className="ss-note mt-1">
          只显示最近 {messages.length} 条(共 {total} 条;`?limit=` 可调,上限 500)
        </div>
      )}
    </article>
  );
}

/** 一组按 kind 的条数摘要(0 条的不显示,免得整行都是 0)。 */
function kindSummary(group: MemberConversationView, kinds: readonly SessionMessageKind[]): string {
  return kinds
    .map((k) => ({ k, n: group.byKind[k] ?? 0 }))
    .filter((x) => x.n > 0)
    .map((x) => `${MESSAGE_KIND_LABEL[x.k]} ${x.n}`)
    .join(" · ");
}

export function MembersPage() {
  const projectId = useChatStore((s) => s.projectId);
  const projects = useChatStore((s) => s.projects);
  const members = useProjectMembers(projectId);
  const conversations = useMemberConversations(projectId);
  /**
   * 页面这一份 harness **只画页签角标**(`roleIssueCount`)。
   *
   * ⚠️ `revision`:成员面板里的 `RoleHarnessSection` 保存成功后会把这一格 +1 ——
   * 它读的是模块级缓存,不推这一格的话,刚补上的缺单元仍会顶着「N 处需要注意」
   * 不放(屏幕上说着与事实相反的话)。见 `lib/data.ts` 里 `revision` 的说明。
   */
  const [harnessRevision, setHarnessRevision] = useState(0);
  const harness = useHarnessRoles({ revision: harnessRevision });
  const artifacts = useArtifacts({ projectId });
  /**
   * 本项目的工作项 —— 只用来把工件身份条里「产出于」那一格翻成**标题**
   * (拿不到就退成 id)。⚠️ 这一份**只为标题**而取:没有它,那份清单里的
   * 「产出于」会是一串 id,而 id 不是人能读的坐标。
   */
  const works = useWorks(projectId);
  /**
   * 关系上下文(算「一圈邻居」用,见 `lib/relations.ts`)。
   * ⚠️ **带加载态** —— 「他负责的环节」在数据还没到的时候是**不知道**,不是「没有」。
   */
  const relations: RelationContext = useMemo(
    () => ({
      projectId,
      works: { data: works.data, loading: works.loading, error: works.error },
    }),
    [projectId, works.data, works.loading, works.error],
  );
  const live = useProjectLive(projectId);
  /** 本地时钟(1s)—— 让快照里的年龄在两次 2.5s 轮询之间也继续走。 */
  const now = useNow(1000);
  /**
   * 当前选中的成员(`agentId`)。**住在地址里**(`#/members?member=a_9`),不是页面 state:
   * 这样「把某个成员的对话发给别人」「F5 之后还在同一个人身上」才成立,而
   * 交付物 / 工作项 / 邻居面板也才有东西可指(那是 Wave 1 实体脊的前置条件)。
   * `null` = 地址里没写 ⇒ 取第一个成员(老行为)。
   */
  const { loc, setParam } = useAppLocation();
  const activeId = paramOf(loc, "member");
  const setActiveId = useCallback((id: string | null) => setParam("member", id), [setParam]);

  const projectName = projects.find((p) => p.id === projectId)?.name;
  /** 这份快照的运行期来源;`null` = 还没拿到过快照。 */
  const runtime = live.data?.runtime ?? null;

  // ── 卡上的实时行:WS 在飞表按成员过滤(store 里现成,零新增请求)─────
  const inFlight = useChatStore((s) => s.inFlight);
  const inFlightOrder = useChatStore((s) => s.inFlightOrder);
  const streamingTurns = useMemo(
    () => inFlightTurns({ inFlight, inFlightOrder }).filter((t) => t.projectId === projectId),
    [inFlight, inFlightOrder, projectId],
  );
  const liveTurnsOf = useCallback(
    (agentId: string): readonly Turn[] => streamingTurns.filter((t) => t.agentId === agentId),
    [streamingTurns],
  );
  /** 快照值 → 屏上此刻的年龄(本地 1s 时钟让它走起来;见 activity.ts)。 */
  const age = useCallback(
    (ms: number) => formatAge(ms + elapsedSinceFetch(live.fetchedAt, now)),
    [live.fetchedAt, now],
  );

  const activityOf = useCallback(
    (agentId: string) => live.data?.agents.find((a) => a.agentId === agentId) ?? null,
    [live.data],
  );

  /**
   * 成员之外的发言者(理论上不该有;有就**如实列出来**,不静默丢)。
   *
   * ⚠️ 2026-10-26:成员面板里那块「他产生了什么对话」从「清单」改成「全文」
   *    (见 `AgentConversations`),所以 `member-conversations` 这一份数据的
   *    **成员部分**读者没了 —— 只剩这里(`strangers`)。**端点还在**(它给
   *    「不在成员表里的发言」这一段),但**别再把它当成员面板的数据源**。
   */
  const strangers = useMemo(
    () => conversations.data.filter((g) => g.agentId !== null && !members.data.some((m) => m.id === g.agentId)),
    [conversations.data, members.data],
  );

  /**
   * 角色 → 这一角色「需要注意的处数」(`roleIssueCount`)。页签上那个告警角标用它。
   *
   * ⚠️ 读不到 harness 视图时返回 0(不显示角标)—— 那是「还不知道」,不是一个
   * 「一切正常」的断言;角标只是**加分项**,缺了它不会把有问题的角色说成没问题
   * (面板里的 `RoleHarnessSection` 会如实说「读不到」)。
   */
  const roleHarnessOf = useMemo(
    () => new Map(harness.roles.map((r) => [r.role, r] as const)),
    [harness.roles],
  );
  const issuesOf = useCallback(
    (role: ProjectRole) => {
      const r = roleHarnessOf.get(role);
      return r === undefined ? 0 : roleIssueCount(r);
    },
    [roleHarnessOf],
  );

  const selected =
    members.data.length === 0
      ? null
      : (members.data.find((m) => m.id === activeId) ?? members.data[0] ?? null);

  /**
   * 页首右侧:本项目此刻的三个数。**只在 `runtime === "host"` 时显示数字** ——
   * unavailable 时 `runningTurns` 之类来自内存的值根本没有意义(契约里那三个
   * 「读不到」的语义),显示成 0 会被读成「没在跑」。其余两种情况如实说「读不到 / 正在读」。
   */
  const liveAside =
    live.error !== null ? (
      <RedMeta title="运行态读面失败 · 会自己重试(2.5s 一次)">运行态读取失败:{live.error}</RedMeta>
    ) : live.data === null ? (
      <span className="ss-meta" style={{ color: "var(--bone-dim)" }}>
        <span className="ss-live-dot" data-state="unknown" /> 正在读取运行态…
      </span>
    ) : runtime === "host" ? (
      <StatStrip
        items={[
          {
            label: "在跑回合",
            value: live.data.runningTurns,
            tone: live.data.runningTurns > 0 ? "jade" : undefined,
            title: "此刻在这个项目里跑着的回合数(四个角色加起来)—— 来自宿主内存的忙闩,重启即清零。",
          },
          {
            label: "未终态工作项",
            value: live.data.openWorks,
            title: "open / in_progress / blocked 的工作项数(库里的真状态)。",
          },
          {
            label: "等你回答",
            value: live.data.pendingQuestions,
            tone: live.data.pendingQuestions > 0 ? "amber" : undefined,
            title: "等甲方答的问题数 —— 它们是流水线停下来的原因。",
          },
        ]}
      />
    ) : (
      <span className="ss-meta" style={{ color: "var(--amber)" }}>
        <span className="ss-live-dot" data-state="unknown" /> 运行态读不到(该进程没接上运行期快照)
      </span>
    );

  if (projectId === null) {
    return (
      <div className="ss-page">
        <PageHeader
          title="成员"
        />
        <EmptyState>未选项目</EmptyState>
      </div>
    );
  }

  return (
    <div className="ss-page">
      <PageHeader
        title="成员"
        hint={projectName}
        aside={liveAside}
      />

      <DataState
        what="成员"
        variant="empty"
        unavailable="读不到这个项目的成员。"
        state={remoteListOf(members.data, members.loading, members.error)}
      >
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState>暂无成员</EmptyState>
          ) : (
        <>
          {/* ── v5:全员并发板(2026-11-20 用户裁决)──────────────────
              每成员一张卡、同屏常渲染 —— 谁在跑/跑了多久/欠什么一眼全见,
              并发直接可见(忙闩键 = (项目, agent),并发是真的)。
              点卡 ⇒ `?member=` 深链接,完整面板(MemberPane + harness 卡)
              在板**之下**展开;「一次只渲染一个面板」的判据由它继续承担。 */}
          <MemberBoard
            members={rows}
            selectedId={selected?.id ?? null}
            onSelect={setActiveId}
            activityOf={activityOf}
            issuesOf={issuesOf}
            runtime={runtime}
            liveTurnsOf={liveTurnsOf}
            age={age}
          />

          {selected !== null && (
            <MemberTabPanels
              member={
                <MemberPane
                  member={selected}
                  activity={activityOf(selected.id)}
                  // 「他说了什么」那块自己取数(它有自己的端点与窗口)。
                  projectId={projectId}
                  // 过滤在页面层做:面板是纯展示,不持有「怎么找这个人的工件」的判据。
                  artifacts={artifacts.data.filter((a) => a.authorAgentId === selected.id)}
                  works={works.data}
                  relations={relations}
                  runtime={runtime}
                  dispatch={live.data?.dispatch ?? null}
                  fetchedAt={live.fetchedAt}
                  now={now}
                />
              }
              // ── 角色 harness:**单独一张卡**,在成员面板**之下** ──────────
              // 用户原话:「成员中,角色 harness 单独放一个卡片出来,未来角色的
              // harness 配置就放在这个地方」。它是**自足**的(自己取整份
              // `GET /api/harness` —— 要整份才能算「共用于 N 个角色」,并自己持有
              // 草稿与备份),所以这里不传数据、只传角色。
              // ⚠️ 页面上那一份 `harness` 只用来画**页签**上的告警角标;保存成功后
              // `onHarnessSaved` 把 `harnessRevision` 推一格,让角标跟上(否则它会顶着旧数
              // 说「N 处需要注意」—— 见 `lib/data.ts` 里 `revision` 的说明)。
              harness={
                <RoleHarnessSection
                  role={selected.role}
                  onHarnessSaved={() => setHarnessRevision((r) => r + 1)}
                />
              }
            />
          )}
        </>
          )
        }
      </DataState>

      {/* ── 不在成员表里的发言 —— **只在真的有人不在成员表里时才渲染** ────
          2026-10-06 用户原话:「(这两段)这个信息不要展示了,我感觉没什么意思」。
          这一版按**信息量**把它切了一半:
            - **删掉「甲方(你)/平台通知」那张卡** —— 甲方自己的话在对话页、平台
              通知走对话页的系统带,成员页再抄一份就是重复。
            - **留下 `strangers`**(真的不在成员表里的 agent 的发言)。
          ⚠️ 这不是「静默丢数据」:`strangers` 一旦非空,这一段就**必须**写清
          「这些发言的作者不在本项目成员表里(可能是历史身份的残留);列出来是为了
          不静默丢证据」—— 一份证据被折叠起来可以,被删掉不行。
          ⚠️ 真机数据里 `strangers` 是 0 个 ⇒ 整段不出现(这才是用户要的效果)。
          ⚠️ `agent_id IS NULL` 那一组(甲方 / 平台通知)不再在这里出现 —— 它
          不是「不在成员表里」,它是「没有角色作者」,两者不是一回事。 */}
      {strangers.length > 0 && (
        <Section
          title="不在成员表里的发言"
          count={strangers.length}
          hint="不在成员表"
        >
          <Disclosure summary={`展开查看 · ${strangers.length} 组`}>
            <div className="grid gap-2">
              {strangers.map((g) => (
                <ConversationCard
                  key={g.agentId}
                  title={g.agentName ?? g.agentId ?? "未知"}
                  role={g.role !== null ? ROLE_LABEL[g.role] : "不在成员表里"}
                  agentId={g.agentId}
                  group={g}
                  kinds={OTHER_KINDS}
                  emptyText="还没有发言。"
                />
              ))}
            </div>
          </Disclosure>
        </Section>
      )}
    </div>
  );
}
