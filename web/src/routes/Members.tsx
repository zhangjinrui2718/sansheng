/**
 * 成员屏(取代旧的 `Agents.tsx`)
 *
 * ── 为什么换了主体 ──────────────────────────────────────────────
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
 * ── 本批次新增:「他产生了什么对话」(设计 1 §2.10 / §2.12 的 A3)────────
 *
 * 对话页是**甲方 ↔ 业务经理**的通道,其他角色的回合不在那里。那它们去哪了?
 * 这一屏 —— 每个角色一份「他说了什么」的清单,供甲方**检查**。
 *
 * 数据来自 `GET /api/projects/:id/member-conversations`,它按 `agent_id` 在
 * **SQL 里** `GROUP BY`:
 *
 *   - 走这条端点而不是拿 `/messages` 在客户端分组,原因是**条数**:后者每条会话只取
 *     最早的 200 条,消息一多,前端数出来的条数会**静默少数**(界面上看不出来)。
 *   - ⚠️ `agent_id IS NULL` 那一组**不是「甲方」的同义词**:甲方(`kind='user'`)与
 *     平台通知(`kind='system'`,排空器异常停下时落的那条)都在里面,所以那一组
 *     按 kind 分开显示 —— 把系统通知算成甲方说的话正是 A1 实测到的坑。
 *   - 按 `agentId` 分组而不是按 `role`:身份是 `agentId`,角色是属性(§2.4.2 的 M:N)。
 */
import { useMemo } from "react";
import type { MemberConversationView, SessionMessageKind } from "@shared/types/platform";
import { EmptyState, KV, PageHeader, Pill, Section } from "@/components/ui/primitives";
import { useMemberConversations, useHarnessRoles, useProjectMembers } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import { ROLE_LABEL, excerpt, fmtTime } from "@/lib/vocab";

/** `session_messages.kind` 的中文读法。**只在这一屏用** —— 它标的是「这条是什么」。 */
const KIND_LABEL: Record<SessionMessageKind, string> = {
  user: "甲方",
  assistant: "发言",
  thinking: "思考",
  tool: "工具",
  system: "系统",
};

const OTHER_KINDS: readonly SessionMessageKind[] = ["assistant", "thinking", "tool"];

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
  const { data: members, loading, error } = useProjectMembers(projectId);
  const conversations = useMemberConversations(projectId);
  const harness = useHarnessRoles();
  const projectName = projects.find((p) => p.id === projectId)?.name;

  /** agentId(`null` = 没有角色作者)→ 那一组。 */
  const groupOf = useMemo(() => {
    const m = new Map<string | null, MemberConversationView>();
    for (const g of conversations.data) m.set(g.agentId, g);
    return m;
  }, [conversations.data]);

  /** 成员之外的发言者(理论上不该有;有就**如实列出来**,不静默丢)。 */
  const strangers = useMemo(
    () => conversations.data.filter((g) => g.agentId !== null && !members.some((m) => m.id === g.agentId)),
    [conversations.data, members],
  );

  const nullGroup = groupOf.get(null) ?? null;
  const totalShown =
    conversations.data.reduce((n, g) => n + g.total, 0);

  return (
    <div className="ss-page">
      <PageHeader
        title="成员"
        hint={projectName}
        hintTitle="本项目成员来自 GET /api/projects/:id/members;角色能力面来自只读的 GET /api/harness。"
      />

      <Section
        title="本项目成员"
        count={members.length}
        hint="四个固定职能:业务经理 / 项目经理 / 执行者 / 质检审查员"
      >
        {!projectId ? (
          <EmptyState>先在「对话」页的左栏选一个项目。</EmptyState>
        ) : error !== null ? (
          <div className="ss-empty" style={{ color: "var(--cinnabar)" }}>
            加载失败:{error}
          </div>
        ) : loading && members.length === 0 ? (
          <EmptyState>加载中…</EmptyState>
        ) : members.length === 0 ? (
          <EmptyState>这个项目还没有成员。</EmptyState>
        ) : (
          <div className="sansheng-card px-3 py-1.5">
            {members.map((m) => (
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

      <Section
        title="他产生了什么对话"
        count={totalShown}
        hint="对话页只显示你与业务经理的往来;这里逐人检查其他角色说了什么"
        hintTitle="数据来源:GET /api/projects/:id/member-conversations —— 按 session_messages.agent_id 在 SQL 里 GROUP BY(条数是真的总数,不是返回了多少条)。每组消息新的在前。"
      >
        {!projectId ? (
          <EmptyState>先在「对话」页的左栏选一个项目。</EmptyState>
        ) : conversations.error !== null ? (
          <div className="ss-empty" style={{ color: "var(--cinnabar)" }}>
            加载失败:{conversations.error}
          </div>
        ) : conversations.loading && conversations.data.length === 0 ? (
          <EmptyState>加载中…</EmptyState>
        ) : (
          <div className="grid gap-2">
            {members.map((m) => {
              const g = groupOf.get(m.id) ?? null;
              return (
                <ConversationCard
                  key={m.id}
                  title={m.displayName}
                  role={ROLE_LABEL[m.role]}
                  agentId={m.id}
                  group={g}
                  kinds={OTHER_KINDS}
                  emptyText="还没有发言。"
                />
              );
            })}

            {/* 其余发言者(不在本项目成员表里的 agent 产生了消息)—— 列出来,不吞掉 */}
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

            {/* ⚠️ agentId === null 的那一组:甲方 + 平台通知。**必须分开数** —— 
                只看 agentId 会把平台通知算成甲方说的话(设计 1 §2.10)。 */}
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
        )}
      </Section>

      <Section
        title="角色能力面"
        count={harness.roles.length}
        hint="只读 · 架构常量"
        hintTitle="ceiling 是代码内常量(不是可编辑文件),前端如实标注这一点;工具集合已过三重门控。"
      >
        {harness.error !== null ? (
          <div className="ss-empty" style={{ color: "var(--cinnabar)" }}>
            读取失败:{harness.error}
          </div>
        ) : !harness.ready ? (
          <EmptyState>加载中…</EmptyState>
        ) : (
          <div className="grid gap-2">
            {harness.roles.map((r) => (
              <article key={r.role} className="sansheng-card p-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="ss-body" style={{ color: "var(--bone)" }}>
                    {r.displayName}
                  </span>
                  {r.clientFacing && <Pill tone="jade">甲方接口</Pill>}
                  <span className="ss-meta ml-auto font-mono">{r.role}</span>
                </div>
                <div className="ss-meta mt-1">
                  能力 {r.ceiling.length} 项 · 可写 {r.writeKinds.length} 类 · 实得工具{" "}
                  {r.tools.length} 个
                  {r.blockedByCeiling.length > 0 && ` · 越界 ${r.blockedByCeiling.length} 项`}
                </div>
                {r.tools.length > 0 && (
                  <div className="ss-note mt-0.5" title={r.tools.join(" · ")}>
                    工具:{r.tools.slice(0, 6).join(" · ")}
                    {r.tools.length > 6 ? ` …(+${r.tools.length - 6})` : ""}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/**
 * 一个发言者的清单。
 *
 * 导出是给**真机验证**用的(纯 props,与 `TurnView` / `ConversationStream` 同一个
 * 理由):`MembersPage` 从 store 取 `projectId`,SSR 下读的是 server snapshot ⇒
 * 驱动不了。真机那一跑要断言的是「屏幕上的条数 = 库里 `GROUP BY agent_id` 的数」,
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
