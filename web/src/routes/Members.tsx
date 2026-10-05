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
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  ArtifactView,
  MemberActivityView,
  MemberConversationView,
  MemberView,
  ProjectLiveView,
  RoleHarnessView,
  SessionMessageKind,
  TriggerTodoKind,
  TurnTrigger,
} from "@shared/types/platform";
import {
  Disclosure,
  EmptyState,
  KV,
  PageHeader,
  Pill,
  Section,
  StatStrip,
} from "@/components/ui/primitives";
import {
  useArtifacts,
  useHarnessRoles,
  useMemberConversations,
  useProjectLive,
  useProjectMembers,
} from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import {
  ROLE_LABEL,
  artifactKindLabel,
  artifactKindTone,
  artifactStatusLabel,
  artifactStatusTone,
  excerpt,
  fmtTime,
  workStatusLabel,
  workStatusTone,
} from "@/lib/vocab";

/** `session_messages.kind` 的中文读法。**只在这一屏用** —— 它标的是「这条是什么」。 */
const KIND_LABEL: Record<SessionMessageKind, string> = {
  user: "甲方",
  assistant: "发言",
  thinking: "思考",
  tool: "工具",
  system: "系统",
};

const OTHER_KINDS: readonly SessionMessageKind[] = ["assistant", "thinking", "tool"];

/**
 * `TriggerTodoKind` 的中文读法。
 *
 * ⚠️ 为什么写在这一屏而不是 `lib/vocab.ts`:vocab 是**契约状态的共享词表**
 * (项目 / 工作项 / 工件 / 提问 / 角色),而这一列在此之前**没有任何前端读者**
 * (`stores/chat.ts` 只读 `trigger.kind`,不读 `todoKind`)。本次改造把它第一次
 * 摆到用户面前,所以先随这一屏落地;真要第二次用到它,再搬进 vocab。
 * 与 vocab 同一纪律:**未知取值原样透出,不猜**(见下面的 `todoKindLabel`)。
 */
const TODO_KIND_LABEL: Record<TriggerTodoKind, string> = {
  answer_ask: "回答提问",
  attend_meeting: "参加评审会",
  review_change: "评审变更",
  fix_work_assignment: "改派工作项",
  resolve_blocked_work: "处理被卡住的工作项",
  decompose_project: "拆解项目",
  execute_work: "执行工作项",
  review_work: "审查产出",
  integrate: "整合成果",
  handover: "交付交接",
  report_downstream: "向甲方汇报下游结果",
};

/** 未知取值原样显示英文 —— 「显示英文」比「显示一个编的中文」诚实。 */
function todoKindLabel(kind: string): string {
  return (TODO_KIND_LABEL as Record<string, string>)[kind] ?? kind;
}

/** 「这一轮为什么存在」。判据与契约 `TurnTrigger` 一致,只有两半。 */
function triggerText(trigger: TurnTrigger): string {
  if (trigger.kind === "user") return "你亲口发起";
  return `排空器按待办叫醒(${todoKindLabel(trigger.todoKind)})`;
}

/**
 * 服务端算的 `ageMs` → 人话。
 *
 * ⚠️ 这里的入参**已经**加过「本地收到快照之后流逝的时间」(见 `elapsedSinceFetch`),
 * 不是裸的快照值 —— 不要把两者搞混。
 *
 * 粒度**刻意到秒**:这一屏存在的理由是让用户看出「它还活着」,而 60s 粒度会让
 * 「已跑 1 分」在整整一分钟里一动不动 —— 那正是「界面停在最后一帧上」的观感。
 * 一小时以上退到「时 + 分」,一天以上退到「天 + 时」(那时秒已经没有信息量)。
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时${m % 60}分`;
  const d = Math.floor(h / 24);
  return `${d}天${h % 24}小时`;
}

/**
 * 「本地收到这份快照之后过了多久」。
 *
 * ── 为什么这个加法成立 ──────────────────────────────────────────
 *
 * 契约里 `ageMs` 由**服务端**算(快照时刻 − 事件时刻),是**一个快照值**,
 * 不会自己往前走。要让它「看起来在走」,就把本地已经过去的时间加上去:
 *
 *     显示年龄 = ageMs(服务端算) + (now(本地) − fetchedAt(本地收到快照的时刻))
 *
 * 这一步成立的前提是**同一台机器**:`platform-serve` 与浏览器跑在本机同一时钟上,
 * 所以两段时长的流逝速率相同,相加不会引入时钟偏移。若哪天宿主与浏览器不同机,
 * 这个加法就要换成「用两次快照的差值外推」(那需要保留上一份快照)。
 *
 * ⚠️ **这是展示层面的推进,不是重新取数**:它不改任何判定,也不制造新事实 ——
 * `useProjectLive` 每 2.5s 会用新快照把 `ageMs` 重新校正一次,所以误差只在两次
 * 轮询之间累积,而且**只影响显示出来的那个数字**。
 * ⚠️ `fetchedAt === null`(还没拿到过快照)时加 0:不假装时间在走。
 */
export function elapsedSinceFetch(fetchedAt: number | null, now: number): number {
  if (fetchedAt === null) return 0;
  return Math.max(0, now - fetchedAt);
}

/**
 * 页签角标 = 「它欠着几件事」。
 *
 * 口径:`readyWorks + todos.length`。理由**逐项写清**,因为这个数字最容易被读歪:
 *
 *   - `readyWorks` —— 派给它、**前置已满足**、还没终态的活(`collectPendingWork()
 *     .myOpenWorks`)。这是「它手上真实欠着的活」。
 *   - `todos.length` —— 排空器**现在愿意叫它去跑**的条目(`collectTodos` 的
 *     runnable)。这是「平台现在会去推它的事」。
 *   - **不含 `waitingWorks`**:那些前置还没满足,它想做也做不了 —— 算进「欠」会让
 *     每个上游没做完的成员都顶着一个永远不变的数字。
 *   - **不含 `exhaustedTodos`**:那是「预算用尽、排空器**不再叫醒**它了」,
 *     性质是**卡住**而不是**欠着**;它由「正在做什么」里那行
 *     「预算用尽不再叫醒 N 件」单独说,不混进角标。
 *
 * ⚠️ **这个和是会重叠的**:一条 `execute_work` 待办对应的往往正是 `readyWorks`
 * 里的那条活,两边各算一次。所以它的准确读法是「**需要它动手的处数**」,
 * 而不是「不重复的工作项个数」—— 可能偏大。我**宁可偏大也不偏小**:
 * 角标的用途是「这个人身上有东西,值得点开看」,把一个有活的成员显示成 0
 * 恰好就是这次要修的那类谎(「看起来一切正常」)。
 */
export function memberDebt(activity: MemberActivityView | null): number {
  if (activity === null) return 0;
  return activity.readyWorks + activity.todos.length;
}

/**
 * 「他欠着什么」的一行事实。
 *
 * **只有 > 0 的才出现** —— 数是 0 的时候占版面,只会把有信息的那一项淹掉
 * (上一版的教训:整行都是 0 时,读者会把这一行整个跳过,连非零项也一起跳过)。
 */
export function debtFacts(activity: MemberActivityView): string[] {
  const facts: string[] = [];
  if (activity.readyWorks > 0) facts.push(`优先做 ${activity.readyWorks} 件`);
  if (activity.waitingWorks > 0) facts.push(`等前置 ${activity.waitingWorks} 件`);
  if (activity.exhaustedTodos > 0) facts.push(`预算用尽不再叫醒 ${activity.exhaustedTodos} 件`);
  return facts;
}

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
 * 成员页签。**一次只看一个人** —— 四个人同时铺开时,消息与卡片会把彼此的结构淹掉
 * (这一版要修的就是那个)。形态照 `HarnessRoleTabs`,主体从「角色」换成「人」。
 */
export function MemberRoleTabs({
  members,
  active,
  onSelect,
  activityOf,
  runtime,
}: {
  members: readonly MemberView[];
  /** 当前选中的 `agentId`;`null` = 还没选(取第一个成员) */
  active: string | null;
  onSelect: (agentId: string) => void;
  /** 取这个人在这份运行态快照里的那一条;没拿到快照时返回 `null` */
  activityOf: (agentId: string) => MemberActivityView | null;
  /** 这份快照的运行期来源;`null` = 还没拿到过快照 */
  runtime: ProjectLiveView["runtime"] | null;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap" role="tablist" aria-label="按成员查看">
      {members.map((m) => {
        const isActive = m.id === active;
        const activity = activityOf(m.id);
        const debt = memberDebt(activity);
        // ⚠️ 只有 `runtime === "host"` 时 `turn` 才是事实 —— 其余两种「不知道」
        // 一律不许被读成「没在跑」,所以这里连点都不点亮的绿点也不给,只给灰点。
        const turn = runtime === "host" ? (activity?.turn ?? null) : null;
        const unknown = runtime !== "host";
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className="sansheng-button flex items-center"
            onClick={() => onSelect(m.id)}
            title={
              `${m.displayName} · ${ROLE_LABEL[m.role]}\n` +
              `agentId = ${m.id}` +
              (turn !== null
                ? `\n此刻有回合在它身上跑(${triggerText(turn.trigger)})`
                : unknown
                  ? `\n运行态${runtime === null ? "还没读到" : "读不到"} —— 这一刻不下任何结论`
                  : "\n此刻没有回合在它身上跑") +
              (debt > 0 ? `\n它欠着 ${debt} 件(优先做的活 + 排空器要叫醒它的待办)` : "")
            }
            style={{
              padding: "6px 10px",
              gap: 6,
              background: isActive ? "var(--ink-2)" : "transparent",
              color: isActive ? "var(--bone)" : "var(--bone-dim)",
              borderColor: isActive ? "var(--ink-4)" : "transparent",
            }}
          >
            {/* ⚠️ 页签主体 = **角色名**(与 harness 页逐字相同,2026-10-06)。
                人的名字(`agents.display_name`)进 tooltip:一人一角色的组织里它与
                角色名一模一样,同时显示两遍就是用户说的「解释」。 */}
            <span style={{ fontSize: 12 }}>{ROLE_LABEL[m.role]}</span>
            {/* 有回合在跑 = 实时点(会呼吸);读不到 = 灰点且不动 —— 两种状态在
                视觉上必须分得开,`.ss-live-dot[data-state="unknown"]` 正是为此存在。 */}
            {turn !== null ? (
              <span className="ss-live-dot" />
            ) : unknown ? (
              <span
                className="ss-live-dot"
                data-state="unknown"
                title="运行态读不到 —— 这一刻不下任何结论"
              />
            ) : null}
            {debt > 0 && (
              <Pill
                tone="cinnabar"
                title={`它欠着 ${debt} 件 = 优先做的活 ${activity?.readyWorks ?? 0} 件 + 排空器现在要叫醒它的待办 ${activity?.todos.length ?? 0} 条(两个来源会重叠,所以这是「需要它动手的处数」)`}
              >
                {debt}
              </Pill>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 「此刻状态」那一格。三种「不知道」在这里被分开说(整个改版的判据都压在这上面)。
 *
 * 顺序刻意是**先判「有没有数据」再判「数据说没说不知道」**:
 * 没拿到快照时连 `runtime` 都不知道,断言「读不到」同样是提前下结论。
 */
function turnStatusNode(
  runtime: ProjectLiveView["runtime"] | null,
  activity: MemberActivityView | null,
  age: (ms: number) => string,
): ReactNode {
  if (activity === null || runtime === null) {
    return (
      <>
        <span className="ss-live-dot" data-state="unknown" />
        <span className="ss-meta" style={{ color: "var(--bone-dim)" }}>
          正在读取运行态…
        </span>
      </>
    );
  }
  if (runtime === "unavailable") {
    return (
      <>
        <span className="ss-live-dot" data-state="unknown" />
        <span
          className="ss-meta"
          style={{ color: "var(--amber)" }}
          title="这一份快照的 runtime = unavailable:该进程没接上运行期快照(例如只挂 HTTP 的装配)。⚠️「读不到」与「它真的停着」是两件事 —— 所以这一格不下任何关于回合的结论。库里的那部分(手上的活 / 待办 / 最近活动)照常显示。"
        >
          运行态读不到(该进程没接上运行期快照)
        </span>
      </>
    );
  }
  if (activity.turn !== null) {
    return (
      <>
        <span className="ss-live-dot" />
        <span className="ss-body" style={{ color: "var(--jade)" }}>
          在跑 · 已跑 {age(activity.turn.elapsedMs)}
        </span>
        <span className="ss-meta">{triggerText(activity.turn.trigger)}</span>
      </>
    );
  }
  // 只有 host 快照 + turn === null 才允许说这一句。措辞是「没有回合在跑」而不是
  // 「空闲」:后者还要看手上有没有活、排空器有没有待办。
  return (
    <span className="ss-meta" title="快照说此刻没有回合登记在它身上。这不等于「它没事」—— 往下的手上的活与待办才是欠不欠活的答案。">
      此刻没有回合在跑
    </span>
  );
}

/**
 * 一个成员的面板。顺序刻意是**「先看现在 → 再看欠什么 → 最后看过去」**:
 *
 *   1. 摘要行 —— 名字 / 角色 / 专长 / id / **此刻状态**;
 *   2. 「正在做什么」—— 库里的活 + 排空器的待办 + 最近一次动 + 排空器心跳;
 *   3. 「他产生了什么对话」—— **默认折叠**(否则一屏又被消息刷满);
 *   4. 「他产出了什么工件」—— 把成员页与工件页连起来;
 *   5. 角色能力面 —— **默认折叠**(它是只读常量,不该占首屏)。
 *
 * 纯 props(与 `HarnessRolePane` / `ConversationCard` 同一处置):导出给测试,
 * 不需要起服务、不需要 stub fetch。
 */
export function MemberPane({
  member,
  activity,
  conversation,
  harnessRole,
  artifacts,
  runtime,
  dispatch,
  fetchedAt,
  now,
}: {
  member: MemberView;
  /** 这个人在这份运行态快照里的那一条;`null` = 还没拿到快照(或快照里没有他) */
  activity: MemberActivityView | null;
  conversation: MemberConversationView | null;
  /** 这个**角色**的能力面(`useHarnessRoles()` 里按 `role` 取的那一条) */
  harnessRole: RoleHarnessView | null;
  /** 已按 `authorAgentId === member.id` **过滤好**的工件 —— 过滤在页面层做 */
  artifacts: readonly ArtifactView[];
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
      hintTitle={`agentId = ${member.id} · role = ${member.role} · agents.display_name = ${member.displayName}`}
      aside={
        <span className="ss-meta font-mono" title="role —— 角色是**属性**,身份是 agentId(摘要行里那个等宽小字)">
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
          <span className="flex items-center gap-1.5">{turnStatusNode(runtime, activity, age)}</span>
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
                title="这份运行态快照是本地什么时候收到的(useProjectLive 自带 2.5s 轮询)。这个数一直变大 = 轮询没有在成功回来 —— 下面的「在跑」是**收到那一刻**的事实,不是此刻的。"
              >
                快照 {formatAge(elapsedSinceFetch(fetchedAt, now))} 前收到
              </span>
            )}
          </div>

          {!hasSnapshot ? (
            // ⚠️ `live.data === null`:**不许**渲染成「手上没有进行中的工作项」
            // —— 那是把「还不知道」显示成「一切正常」,与这次要修的是同一类谎。
            <div className="ss-note">
              正在读取运行态…(还没有拿到过一份运行态快照。这一块**不代表**他手上没事,只是还不知道)
            </div>
          ) : (
            <>
              {/* 库里的真状态(重启后照样成立) */}
              <div className="flex flex-col">
                <span
                  className="ss-meta"
                  title="库里的真状态:派给他的工作项里 status ∈ {in_progress, blocked}。与宿主内存里的忙闩不同,它重启后照样成立。"
                >
                  手上的活
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
                <div
                  className="ss-meta"
                  title="readyWorks = 派给他、前置已满足、还没终态的活;waitingWorks = 派给他但前置没满足的活(「他为什么还没动」的答案);exhaustedTodos = 尝试预算用尽、排空器不再叫醒的待办数(静默放弃是禁止的,所以它必须显示)。"
                >
                  {facts.join(" · ")}
                </div>
              )}

              {/* 排空器自己的判据 —— 不是前端重算的一份 */}
              <div className="flex flex-col">
                <span
                  className="ss-meta"
                  title="直接来自 collectTodos 的 runnable,按 agentId 分组 —— 与排空器用的是同一个判据,前端不重算。attempts 是尝试预算已用掉的次数,用满的条目不在这一列,而在上面「预算用尽不再叫醒」那个数里。"
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
                title="最近一条落库的会话消息(库里实际只有 user / assistant / system —— tool 不落库)。它回答「他最后一次留下痕迹是什么时候」,不回答「现在在不在跑」。"
              >
                {activity.lastMessage !== null ? (
                  <>
                    最后一次动:{KIND_LABEL[activity.lastMessage.kind]}{" "}
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
                  title="宿主里 fixed-delay 定时器的心跳(默认 10s):它不携带任何状态,只说「现在去查一下该谁跑」。判定永远重新查库(见 runtime/dispatcher.ts)。"
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

        {/* ── ③ 他产生了什么对话 —— **默认折叠**,标题写清条数 ─────── */}
        {/* `conversation === null` 就是真的 0:端点会把有消息的组都返回,没有这个组
            = 库里确实没有它的行(见 `ConversationCard` 的注释)。 */}
        <Disclosure summary={`他产生了什么对话 · ${conversation?.total ?? 0} 条`}>
          <ConversationCard
            title={member.displayName}
            role={ROLE_LABEL[member.role]}
            agentId={member.id}
            group={conversation}
            kinds={OTHER_KINDS}
            emptyText="还没有发言。"
          />
        </Disclosure>

        {/* ── ④ 他产出了什么工件(成员页 × 工件页的那条连线)──────── */}
        <div className="flex flex-col">
          <span
            className="ss-meta"
            title="按 authorAgentId === 这个人的 id 过滤(过滤在页面层做,面板只负责摆)。工件是流水线上的关键节点:一个人的活干到哪一步,看他产出了什么最直接。"
          >
            他产出了什么工件 · {artifacts.length} 件
          </span>
          {artifacts.length === 0 ? (
            <div className="ss-note">他还没有产出的工件。</div>
          ) : (
            artifacts.map((a) => (
              <div key={a.id} className="flex items-baseline gap-2 flex-wrap" style={{ fontSize: 12 }}>
                <Pill tone={artifactKindTone(a.kind)}>{artifactKindLabel(a.kind)}</Pill>
                <Pill tone={artifactStatusTone(a.status)}>{artifactStatusLabel(a.status)}</Pill>
                <span className="truncate" style={{ color: "var(--bone)" }} title={`${a.title} · ${a.id}`}>
                  {a.title}
                </span>
                <span className="ss-meta" title={`createdAt = ${a.createdAt} · updatedAt = ${a.updatedAt}`}>
                  {fmtTime(a.createdAt)}
                </span>
              </div>
            ))
          )}
        </div>

        {/* ── ⑤ 角色能力面 —— 只读常量,折起来不占首屏 ───────────── */}
        <Disclosure
          summary={
            harnessRole === null
              ? "角色能力面(还没读到)"
              : `角色能力面(只读)· 能力 ${harnessRole.ceiling.length} 项`
          }
        >
          {harnessRole === null ? (
            <div className="ss-note">
              还没读到这个角色的能力面(`GET /api/harness` 未就绪,或这个角色不在返回里)。
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="ss-meta" title="ceiling 是 ROLE_SPECS 里的代码内常量,不是可编辑文件 —— 界面改不了它。">
                能力 {harnessRole.ceiling.length} 项 · 代码内常量,改不了
              </div>
              {/* ⚠️ `toolsSolved === false` 时**不许显示「0 个」**:那是「算不出来」
                  (库里连这个角色的 agent 行都没有 —— 组织未播种 / 刚被重置),
                  不是「一个工具都没有」。两种状态在界面上长得一样是这个项目反复
                  栽过的形态(2026-10-05 真机现场:这里显示了「实得工具 0 个」)。
                  ⚠️ 判据是 **`=== false`**,不是 `!toolsSolved`:字段缺失(前端比后端新)
                  要退化回旧行为照常显示计数,别把「旧后端没这个字段」误报成「组织未播种」。 */}
              {harnessRole.toolsSolved !== false ? (
                <div className="ss-meta">
                  实得工具 {harnessRole.tools.length} 个
                  {harnessRole.tools.length > 0
                    ? ` · ${harnessRole.tools.slice(0, 6).join(" · ")}${harnessRole.tools.length > 6 ? ` …(+${harnessRole.tools.length - 6})` : ""}`
                    : ""}
                </div>
              ) : (
                <div
                  className="ss-meta"
                  style={{ color: "var(--cinnabar)" }}
                  title="库里没有这个角色的 agent 行(组织还没播种,或刚被重置)—— 工具面求解不了。它**不是**「0 个工具」。"
                >
                  实得工具 求解不了(组织未播种)
                </div>
              )}
              {harnessRole.blockedByCeiling.length > 0 && (
                <div className="ss-meta" style={{ color: "var(--cinnabar)" }}>
                  超出架构上界(被 ceiling 拒绝):{harnessRole.blockedByCeiling.join(" · ")}
                </div>
              )}
              <div className="flex flex-wrap gap-1" style={{ marginTop: 4 }}>
                {harnessRole.ceiling.slice(0, 8).map((c) => (
                  <span key={c} className="ss-pill" data-tone="bone">
                    {c}
                  </span>
                ))}
                {harnessRole.ceiling.length > 8 && (
                  <span className="ss-meta">…(+{harnessRole.ceiling.length - 8})</span>
                )}
              </div>
            </div>
          )}
        </Disclosure>
      </article>
    </Section>
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
  note,
}: {
  title: string;
  role: string;
  agentId: string | null;
  group: MemberConversationView | null;
  kinds: readonly SessionMessageKind[];
  emptyText: string;
  note?: string;
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
      {(summary !== "" || note !== undefined) && (
        <div className="ss-meta mt-0.5">
          {note !== undefined ? note : summary}
        </div>
      )}
      {messages.length === 0 ? (
        <div className="ss-note mt-1">{emptyText}</div>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {messages.map((m) => (
            <li key={m.id} className="flex gap-2 items-baseline" style={{ fontSize: 12 }}>
              <span className="ss-meta flex-none font-mono">{fmtTime(m.createdAt)}</span>
              <span className="ss-meta flex-none">{KIND_LABEL[m.kind]}</span>
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
    .map((x) => `${KIND_LABEL[x.k]} ${x.n}`)
    .join(" · ");
}

export function MembersPage() {
  const projectId = useChatStore((s) => s.projectId);
  const projects = useChatStore((s) => s.projects);
  const members = useProjectMembers(projectId);
  const conversations = useMemberConversations(projectId);
  const harness = useHarnessRoles();
  const artifacts = useArtifacts({ projectId });
  const live = useProjectLive(projectId);
  /** 本地时钟(1s)—— 让快照里的年龄在两次 2.5s 轮询之间也继续走。 */
  const now = useNow(1000);
  /** 当前选中的成员(`agentId`)。`null` = 还没选(取第一个成员)。 */
  const [activeId, setActiveId] = useState<string | null>(null);

  const projectName = projects.find((p) => p.id === projectId)?.name;
  /** 这份快照的运行期来源;`null` = 还没拿到过快照。 */
  const runtime = live.data?.runtime ?? null;

  const activityOf = useCallback(
    (agentId: string) => live.data?.agents.find((a) => a.agentId === agentId) ?? null,
    [live.data],
  );

  /** agentId(`null` = 没有角色作者)→ 那一组。 */
  const groupOf = useMemo(() => {
    const m = new Map<string | null, MemberConversationView>();
    for (const g of conversations.data) m.set(g.agentId, g);
    return m;
  }, [conversations.data]);

  /** 成员之外的发言者(理论上不该有;有就**如实列出来**,不静默丢)。 */
  const strangers = useMemo(
    () => conversations.data.filter((g) => g.agentId !== null && !members.data.some((m) => m.id === g.agentId)),
    [conversations.data, members.data],
  );

  const nullGroup = groupOf.get(null) ?? null;
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
      <span className="ss-meta" style={{ color: "var(--cinnabar)" }} title="GET /api/projects/:id/live 失败。WS 断了 REST 还在,所以这一条会自己重试(2.5s 一次)。">
        运行态读取失败:{live.error}
      </span>
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
          hintTitle="本项目成员来自 GET /api/projects/:id/members;运行态来自 GET /api/projects/:id/live(2.5s 轮询);角色能力面来自只读的 GET /api/harness。"
        />
        <EmptyState>先在「对话」页的左栏选一个项目。</EmptyState>
      </div>
    );
  }

  return (
    <div className="ss-page">
      <PageHeader
        title="成员"
        hint={projectName}
        hintTitle="本项目成员来自 GET /api/projects/:id/members;运行态来自 GET /api/projects/:id/live(2.5s 轮询);角色能力面来自只读的 GET /api/harness。"
        aside={liveAside}
      />

      {members.error !== null ? (
        <div className="ss-empty" style={{ color: "var(--cinnabar)" }}>
          加载失败:{members.error}
        </div>
      ) : members.loading && members.data.length === 0 ? (
        <EmptyState>加载中…</EmptyState>
      ) : members.data.length === 0 ? (
        <EmptyState>这个项目还没有成员。</EmptyState>
      ) : (
        <>
          {/* ── 按成员分栏:一次只看一个人(照 Harness 的组织方式)─────
              上一版把成员 KV / 每个人的对话 / 每个角色的能力面同时铺开,
              4 个人 × 3 块内容挤在一屏里 —— 这一版要修的就是那个。 */}
          <MemberRoleTabs
            members={members.data}
            active={selected?.id ?? null}
            onSelect={setActiveId}
            activityOf={activityOf}
            runtime={runtime}
          />

          {selected !== null && (
            <MemberPane
              member={selected}
              activity={activityOf(selected.id)}
              conversation={groupOf.get(selected.id) ?? null}
              // 能力面按**角色**取:同一个人身上只有一份角色属性(角色只有一处真相)。
              harnessRole={harness.roles.find((r) => r.role === selected.role) ?? null}
              // 过滤在页面层做:面板是纯展示,不持有「怎么找这个人的工件」的判据。
              artifacts={artifacts.data.filter((a) => a.authorAgentId === selected.id)}
              runtime={runtime}
              dispatch={live.data?.dispatch ?? null}
              fetchedAt={live.fetchedAt}
              now={now}
            />
          )}
        </>
      )}

      {/* ── 不在成员表里的发言 —— 上一版有这一块,这一版**不许静默丢掉** ──
          ⚠️ `agent_id IS NULL` 那一组**不是「甲方」的同义词**:甲方(`kind='user'`)
          与平台通知(`kind='system'`,排空器异常停下时落的那条)都在里面,所以它
          按 kind 分开显示 —— 把系统通知算成甲方说的话正是 A1 实测到的坑。 */}
      {(strangers.length > 0 || nullGroup !== null) && (
        <Section
          title="不在成员表里的发言"
          count={strangers.length + (nullGroup?.total ?? 0)}
          hint="甲方与平台通知在库里都是 agent_id IS NULL,靠 kind 分开"
          hintTitle="数据来自 GET /api/projects/:id/member-conversations(按 session_messages.agent_id 在 SQL 里 GROUP BY)。这一块与成员面板里的清单是同一个端点、同一套判据,只是发言者不属于本项目成员表。"
        >
          <Disclosure summary={`展开查看 · ${strangers.length + (nullGroup?.total ?? 0)} 条`}>
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

              <ConversationCard
                title="甲方(你)"
                role="没有角色作者"
                agentId={null}
                group={nullGroup}
                kinds={["user", "system"]}
                emptyText="这段对话里还没有你说的话。"
                note={
                  nullGroup !== null
                    ? `甲方 ${nullGroup.byKind.user ?? 0} 条 · 平台通知 ${nullGroup.byKind.system ?? 0} 条` +
                      "(两者在库里都是 agent_id IS NULL,靠 kind 分开)"
                    : "甲方 0 条 · 平台通知 0 条"
                }
              />
            </div>
          </Disclosure>
        </Section>
      )}

      {/* ── 本项目成员一览(四个固定职能)—— 放在页面底部 ────────── */}
      <Section
        title="本项目成员一览"
        count={members.data.length}
        hint="四个固定职能:业务经理 / 项目经理 / 工程师 / 质检"
        hintTitle="这一行是**组织**的答案(谁在这个项目里);上面那行页签是**运行**的答案(他们此刻在干什么)。"
      >
        {members.data.length === 0 ? (
          <EmptyState>这个项目还没有成员。</EmptyState>
        ) : (
          <div className="sansheng-card px-3 py-1.5">
            {members.data.map((m) => (
              <KV
                key={m.id}
                label={ROLE_LABEL[m.role]}
                value={m.displayName}
                title={m.specialization !== null ? `专长 ${m.specialization} · ${m.id}` : m.id}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
