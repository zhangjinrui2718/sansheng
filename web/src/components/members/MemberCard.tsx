/**
 * 全员并发板(v5 Wave D,2026-11-20)—— 成员页的新形态。
 *
 * ── 裁决变更记录 ────────────────────────────────────────────────
 *
 * **2026-11-20 用户裁决**:「成员是可以并发的吧,重新设计一下现在项目成员的
 * 展示方式。」它**取代**了 2026-10-06 的「一行成员页签 + 一次只渲染一个成员的
 * 面板」—— 那是防杂乱的设计,与「并发可见」正好相反:两个角色同时在跑时,
 * 页签形态要你点两次才能确认,而忙闩的键本来就是 `(项目, agent)`(hub.ts),
 * 用户回合与内部推进**真的会同时跑**(serve.ts)。
 *
 * 新形态:**每个成员一张卡,五张(四角色 + 编制)同屏常渲染** —— 谁在跑、
 * 跑了多久、手上有什么、欠着什么,一眼全见;并发直接可见。点一张卡
 * (`?member=` 深链接不变)⇒ 那个成员的完整面板(`MemberPane`,原样保留)
 * 在板**之下**展开 —— 板回答「现在谁在干什么」,面板回答「这个人的一切」。
 *
 * ── 卡面的数据(全部现成,零新增请求)────────────────────────────
 *
 *   · 状态行:`TurnStatus`(三态判据的唯一落点,与面板共用);
 *   · 手上的活 / 欠着什么 / 待办数:`MemberActivityView`(2.5s 轮询);
 *   · 最后动作:`lastMessage`(落库痕迹);
 *   · **紧凑实时行**:`liveLineOf` —— 该成员 inFlight 回合(WS 在飞表,store 里
 *     已有)的最新状态。它比 2.5s 快照更「现在」:并发正在发生的那一格。
 *
 * ⚠️ 三种「不知道」的纪律与面板逐字相同(见 `TurnStatus` 文件头):
 * 读不到不许说成空闲,没拿到快照不许说成读不到。
 */
import type { MemberActivityView, MemberView, ProjectLiveView } from "@shared/types/platform";
import type { Turn } from "@/stores/chat";
import { Pill } from "@/components/ui/primitives";
import { ROLE_LABEL, MESSAGE_KIND_LABEL, excerpt } from "@/lib/vocab";
import { debtFacts, formatAge, memberDebt, triggerText } from "./activity";
import { TurnStatus } from "./TurnStatus";

/**
 * 该成员**正在流**的那一轮的一行摘要(判据,导出给测试)。
 *
 *   · 最新块是工具 ⇒ 「刚调 {工具名}」(工具名只存在于 WS 在飞轮里,落库永远没有);
 *   · 最新块是正文 ⇒ 「在写:…」(截 24 字);
 *   · 只有思考 ⇒ 「在推演…」;
 *   · 没有在飞轮 ⇒ `null`(整行不出现 —— 不是「没在跑」,是「没有正在流的东西」,
 *     在跑与否由 `TurnStatus` 按快照说)。
 *
 * ⚠️ 看的是**最后一个块**:流式追加时它就是「此刻」;倒序找,不排序。
 */
export function liveLineOf(turns: readonly Turn[]): string | null {
  if (turns.length === 0) return null;
  const t = turns[turns.length - 1]!;
  for (let i = t.blocks.length - 1; i >= 0; i -= 1) {
    const b = t.blocks[i]!;
    if (b.kind === "tool") return `刚调 ${b.tool.name}`;
    if (b.kind === "text" && b.text.trim() !== "") return `在写:${excerpt(b.text, 24)}`;
  }
  return "在推演…";
}

/**
 * 一张成员卡。**整卡可点**(`aria-expanded` 表达展开态;展开的完整面板在板之下,
 * 不在卡里 —— 卡保持「一眼可扫」的密度)。
 */
export function MemberCard({
  member,
  activity,
  runtime,
  age,
  issues,
  streamingLine,
  expanded,
  onSelect,
}: {
  member: MemberView;
  /** 这个人在快照里的那一条;`null` = 还没拿到快照 */
  activity: MemberActivityView | null;
  /** 快照运行期来源;`null` = 还没拿到过快照 */
  runtime: ProjectLiveView["runtime"] | null;
  /** 快照值 → 屏上此刻年龄 */
  age: (ms: number) => string;
  /** 这个**角色**的 harness 需要注意处数(角标;0 = 不显示) */
  issues: number;
  /** 正在流的实时行(`liveLineOf`);`null` = 整行不出现 */
  streamingLine: string | null;
  expanded: boolean;
  onSelect: () => void;
}) {
  const debt = memberDebt(activity);
  const facts = activity === null ? [] : debtFacts(activity);
  const todoCount = activity?.todos.length ?? 0;
  const exhausted = activity?.exhaustedTodos ?? 0;
  // ⚠️ 只有 `runtime === "host"` 时 `turn` 才是事实(与面板的同一条判据):
  // 其余两种「不知道」不许被读成「没在跑」。实时点的画法只有一处:TurnStatus。
  const running = runtime === "host" ? (activity?.turn ?? null) : null;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onSelect}
      data-member-card={member.id}
      title={`${member.displayName} · ${ROLE_LABEL[member.role]}\nagentId = ${member.id}`}
      className="sansheng-card p-3 text-left flex flex-col gap-2"
      style={{
        borderColor: expanded ? "var(--jade)" : undefined,
        minHeight: 96,
      }}
    >
      {/* ── 头:角色名 + 两个角标(欠活 / harness)───────────────────
          ⚠️ 实时点**不在这里**:状态行(TurnStatus)紧贴其下,点在那一份 ——
          同一个事实两处画,迟早一处漂(运行/读不到的三态由它唯一承担)。 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span style={{ fontSize: 13, color: "var(--bone)", fontWeight: 500 }}>
          {ROLE_LABEL[member.role]}
        </span>
        {debt > 0 && (
          <Pill tone="cinnabar" title={`欠 ${debt} 件:在做的活 + 排空器要叫醒的待办(两来源有重叠)`}>
            {debt}
          </Pill>
        )}
        {issues > 0 && (
          <Pill tone="cinnabar" title={`harness 有 ${issues} 处要注意(配置问题,不是它手上的活)`}>
            {issues}
          </Pill>
        )}
        <span className="ss-meta ml-auto font-mono">{member.id}</span>
      </div>

      {/* ── 状态行:三态判据的唯一落点(TurnStatus,与面板共用)────── */}
      <div className="flex items-center gap-1.5 flex-wrap" style={{ fontSize: 12 }}>
        <TurnStatus runtime={runtime} activity={activity} age={age} />
        {running !== null && (
          <span className="ss-meta">· {triggerText(running.trigger)}</span>
        )}
      </div>

      {/* ── 正在流的实时行(WS 在飞轮;比 2.5s 快照更「现在」)────────── */}
      {streamingLine !== null && (
        <div className="flex items-center gap-1.5" data-role="card-live-line">
          <span className="ss-live-dot" />
          <span className="ss-meta" style={{ color: "var(--jade)" }}>
            {streamingLine}
          </span>
        </div>
      )}

      {/* ── 手上的活(进行中的;每条一行,状态 pill + 标题)────────── */}
      {activity !== null && activity.currentWorks.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {activity.currentWorks.map((w) => (
            <div key={w.id} className="flex items-baseline gap-2 flex-wrap" style={{ fontSize: 12 }}>
              <Pill tone={w.status === "in_progress" ? "jade" : undefined} title={w.id}>
                {w.status === "in_progress" ? "在做" : w.status}
              </Pill>
              <span className="truncate" style={{ color: "var(--bone)" }} title={w.title}>
                {w.title}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── 欠什么 / 待办 / 最后动作(只有非零与非空才占版面)───────── */}
      {facts.length > 0 && <div className="ss-meta">{facts.join(" · ")}</div>}
      {activity !== null && todoCount > 0 && (
        <div className="ss-meta">排空器要叫醒 {todoCount} 件待办</div>
      )}
      {exhausted > 0 && (
        <div className="ss-meta" title="预算用尽的条目不在 runnable 里 —— 这是「卡住」,不是「欠着」">
          预算用尽不再叫醒 {exhausted} 件
        </div>
      )}
      {activity?.lastMessage != null && (
        <div className="ss-meta" title="最后一次留下痕迹的时刻 · 不回答「现在在不在跑」">
          最后:{MESSAGE_KIND_LABEL[activity.lastMessage.kind]} {excerpt(activity.lastMessage.excerpt, 30)} ·{" "}
          {age(activity.lastMessage.ageMs)}
        </div>
      )}
    </button>
  );
}

/**
 * 全员板:**每个成员一张卡,与选中无关** —— 这是本波的灵魂判据
 * (哨兵:`tests/web/members-board.test.ts` 钉「渲染数量 = 成员数,不随选中变」)。
 */
export function MemberBoard({
  members,
  selectedId,
  onSelect,
  activityOf,
  issuesOf,
  runtime,
  liveTurnsOf,
  age,
}: {
  members: readonly MemberView[];
  /** 当前展开的成员;`null` = 没有展开(板照常渲染全部卡) */
  selectedId: string | null;
  onSelect: (agentId: string) => void;
  activityOf: (agentId: string) => MemberActivityView | null;
  issuesOf: (role: MemberView["role"]) => number;
  runtime: ProjectLiveView["runtime"] | null;
  /** 该成员正在流的轮(WS 在飞表按 agentId 过滤)—— 卡上实时行用 */
  liveTurnsOf: (agentId: string) => readonly Turn[];
  age: (ms: number) => string;
}) {
  return (
    <div
      className="grid gap-2"
      data-role="member-board"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}
    >
      {members.map((m) => (
        <MemberCard
          key={m.id}
          member={m}
          activity={activityOf(m.id)}
          runtime={runtime}
          age={age}
          issues={issuesOf(m.role)}
          streamingLine={liveLineOf(liveTurnsOf(m.id))}
          expanded={m.id === selectedId}
          onSelect={() => onSelect(m.id)}
        />
      ))}
    </div>
  );
}
