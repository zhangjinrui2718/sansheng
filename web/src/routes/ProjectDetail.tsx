/**
 * 项目详情屏(新)
 *
 * 一个项目「是什么、谁在做、做到哪、卡在哪、等我答什么」—— 一屏说完。
 * 数据全部来自五个只读端点,由 `lib/data.ts` 的 hooks 统一读取:
 *
 *   GET /api/projects/:id          → ProjectDetail(目标 / 成员 / 工作项 / 待答问题)
 *   GET /api/projects/:id/blockers → 阻塞列表(「哪件事被卡住了」)
 *   GET /api/projects/:id/asks     → **角色之间**的提问(内部协作,不是问用户的)
 *   GET /api/projects/:id/changes  → 变更记录(提议 → 评审 → 接受/实施)
 *   GET /api/projects/:id/messages → 平台通知(`kind = 'system'`)—— 「组织运行态」卡
 *
 * ── 「组织运行态」卡为什么在这一页(本批新增)────────────────────
 *
 * 两条平台通知(排空异常停下 / 回合漏留工作记录)原先只出现在**对话页**的系统带里。
 * 但它们的主体是**项目**:一条回答「组织还动不动」,一条回答「这个项目跑得规不规矩」。
 * 对话页是「甲方与业务经理的对话」,机器记录横在那里既不是发言、也没有该看它的人。
 * 所以全文落在这一屏(挨着「成员」——目标是谁做、他们现在在动吗、做到哪),
 * 对话页只留一行摘要并指回这里。判据在 `lib/platformNotices.ts`(纯函数)。
 *
 * ── asks 与 client-questions 在界面上怎么分开(本次刻意做的一件事)────
 *
 * 两者都叫「提问」,但**收件人完全不同**:
 *
 *   - `AskView`(本页「内部协作」区)= 角色问角色,例如工程师问项目经理。
 *     甲方不是对话的一方,看了也插不上手 → 区块标成「内部协作」,理由是
 *     「不用你处理」;
 *   - `ClientQuestionView`(本页「待你回答」区 + 待办页)= 等甲方拍板,
 *     有输入框、点了会真的落成 decision 工件 → 区块标成「需要你处理」。
 *
 * 契约原话:「甲方看不到横向沟通,只看发给自己那部分」。所以内部提问**不放进
 * 待办队列**(`/api/client-questions`),只在项目详情里作为进度信息展示 ——
 * 否则用户会以为自己欠了二十个回答。两个区块的 hint 也逐字写明这一点。
 *
 * 反造假纪律:没有就显示空态,不摆 0 占位、不造示例行;每个计数都来自本次真实数组
 * 的 length。工作项的 DAG 入边(`dependsOn`)只在存在时标注,不画一张空图。
 * 关联目标只显示 id —— 契约 `ArtifactView.links` / `AskView.parentAskId` 都只有 id,
 * 没有目标标题,不编一个出来。
 */
import { PageHeader, Pill, Section, StatStrip, EmptyState, KV, Flag } from "@/components/ui/primitives";
import { ClientQuestionCard } from "@/components/client/ClientQuestionCard";
import { useProjectAsks, useProjectChanges, useProjectDetail, useProjectMessages } from "@/lib/data";
import { collectPlatformNotices, platformNoticeLabel, type PlatformNoticeKind } from "@/lib/platformNotices";
import { useChatStore } from "@/stores/chat";
import {
  ROLE_LABEL,
  askStatusLabel,
  askStatusTone,
  blockerSeverityLabel,
  blockerSeverityTone,
  blockerStatusLabel,
  blockerStatusTone,
  changeStatusLabel,
  changeStatusTone,
  excerpt,
  fmtTime,
  projectStatusLabel,
  projectStatusTone,
  workStatusLabel,
  workStatusTone,
} from "@/lib/vocab";

/**
 * 悬停时补一句「这一类意味着什么」。类名本身只有一处
 * (`platformNotices.ts` 的 `platformNoticeLabel`)—— 这里不重复名字,只解释后果。
 */
const NOTICE_TITLE: Record<PlatformNoticeKind, string> = {
  stop: "排空器异常停下(撞上单次回合上限 / 待办预算用尽)—— 平台到界不静默,这条是它的现场",
  compliance:
    "平台叫醒的回合没留工作记录(未调 tell_client,正文也没有行首 [未播报])—— 「判断过」与「漏了」的分界",
  other: "平台自己落的通知:作者不是任何角色,也不是甲方",
};

export function ProjectDetailPage() {
  const projectId = useChatStore((s) => s.projectId);
  const { detail, blockers, loading, error } = useProjectDetail(projectId);
  const { data: asks, loading: asksLoading, error: asksError } = useProjectAsks(projectId);
  const { data: changes, loading: changesLoading, error: changesError } = useProjectChanges(projectId);
  const {
    data: messages,
    loading: noticesLoading,
    error: noticesError,
  } = useProjectMessages(projectId);
  // 平台通知的全文落点。判据(哪一行算通知、属于哪一类)在
  // `lib/platformNotices.ts` 的纯函数里 —— 页面只渲染结果,不自己认字符串。
  const notices = collectPlatformNotices(messages);

  if (!projectId) {
    return (
      <div className="ss-page">
        <PageHeader title="项目" />
        <EmptyState>先在「对话」页的左栏选一个项目。</EmptyState>
      </div>
    );
  }

  return (
    <div className="ss-page">
      <PageHeader
        title={detail?.name ?? "项目"}
        hint={detail ? (detail.client ? `甲方 ${detail.client}` : undefined) : undefined}
        hintTitle="数据来源:GET /api/projects/:id、/blockers、/asks、/changes。"
        aside={
          detail ? (
            <StatStrip
              items={[
                { label: "状态", value: projectStatusLabel(detail.status), tone: projectStatusTone(detail.status) },
                { label: "工作项", value: `${detail.counts.openWorks}/${detail.counts.works}` },
                { label: "工件", value: detail.counts.artifacts },
                {
                  label: "待答",
                  value: detail.counts.pendingQuestions,
                  tone: detail.counts.pendingQuestions > 0 ? "amber" : undefined,
                  title: "等你回答的问题(来自 /api/client-questions 的同一批工件)",
                },
                {
                  label: "内部提问",
                  value: asks.length,
                  title: "角色之间的提问,不是问你的 —— 不需要你处理",
                },
                { label: "变更", value: changes.length },
              ]}
            />
          ) : undefined
        }
      />

      {error !== null ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : loading && !detail ? (
        <EmptyState>加载中…</EmptyState>
      ) : !detail ? (
        <EmptyState>读不到这个项目。</EmptyState>
      ) : (
        <>
          <Section title="目标">
            {detail.goal.length > 0 ? (
              <div className="sansheng-card p-3 ss-body" style={{ color: "var(--bone)" }}>
                {detail.goal}
              </div>
            ) : (
              <EmptyState>这个项目还没写目标。</EmptyState>
            )}
          </Section>

          <Section title="成员" count={detail.members.length}>
            {detail.members.length === 0 ? (
              <EmptyState>还没有成员。四个角色:业务经理 / 项目经理 / 工程师 / 质检。</EmptyState>
            ) : (
              <div className="sansheng-card px-3 py-1.5">
                {detail.members.map((m) => (
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

          {/*
            平台通知的**全文落点**(本批:从对话页的系统带搬过来)。

            ⚠️ 这些记录的主体是**项目**,不是那场对话:一条说「排空在 8 回合处停下,
            还有待办没跑完」(组织不动了),一条说「某个回合没留工作记录」
            (合规)。它们原先只出现在对话页的系统带里 —— 而那页是「甲方与业务经理
            的对话」,一段机器记录横在里面既不像发言、也找不到该谁看。今天:
            全文在这里;对话页只留一行摘要 + 指向本页。
          */}
          <Section
            title="组织运行态"
            count={notices.total}
            hint="平台留下的机器记录 · 停止推进 / 合规告警"
            hintTitle="来源:GET /api/projects/:id/messages 里 kind = 'system' 的行,按时间倒序。①「停止推进」= serve.ts 的 announceDrain(排空撞上单次回合上限或待办预算用尽 —— 到界不静默);②「合规告警」= reportUnannouncedTurn(平台叫醒的回合既没调 tell_client、正文也没有行首 [未播报])。正文原样显示,不做字段解析 —— 解析失手会静默丢内容。"
          >
            {noticesError !== null ? (
              <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
                加载失败:{noticesError}
              </div>
            ) : noticesLoading && notices.total === 0 ? (
              <EmptyState>加载中…</EmptyState>
            ) : notices.total === 0 ? (
              <EmptyState>没有平台通知 —— 排空没有异常停下,也没有回合漏留工作记录。</EmptyState>
            ) : (
              <div className="grid gap-1.5">
                {notices.all.map((n) => (
                  <article
                    key={n.id}
                    className="sansheng-card p-2.5"
                    data-notice-kind={n.kind}
                    title={n.id}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill
                        tone={n.kind === "stop" ? "amber" : n.kind === "compliance" ? "cyan" : "bone"}
                        title={NOTICE_TITLE[n.kind]}
                      >
                        {platformNoticeLabel(n.kind)}
                      </Pill>
                      <span className="ss-meta ml-auto">{fmtTime(n.createdAt)}</span>
                    </div>
                    {/* 正文原样:换行保留(库里那两段本来就是分行写的) */}
                    <div
                      className="ss-body mt-1"
                      style={{ color: "var(--bone)", whiteSpace: "pre-wrap" }}
                    >
                      {n.content}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="工作项"
            count={detail.works.length}
            hint="项目经理把目标拆成的工作项"
            hintTitle="状态取值来自契约 WorkStatus(open|in_progress|blocked|done|failed|cancelled)。"
          >
            {detail.works.length === 0 ? (
              <EmptyState>还没有工作项。</EmptyState>
            ) : (
              <div className="grid gap-1.5">
                {detail.works.map((w) => (
                  <article key={w.id} className="sansheng-card p-2.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill tone={workStatusTone(w.status)}>{workStatusLabel(w.status)}</Pill>
                      <span className="ss-body" style={{ color: "var(--bone)" }}>
                        {w.title}
                      </span>
                      <span className="ss-meta ml-auto">{w.assigneeName || w.assigneeAgentId}</span>
                    </div>
                    {w.goal.length > 0 && w.goal !== w.title && (
                      <div className="ss-note mt-0.5" title={w.goal}>
                        {excerpt(w.goal, 90)}
                      </div>
                    )}
                    <div className="ss-meta mt-0.5">
                      {fmtTime(w.createdAt)}
                      {w.dependsOn.length > 0 && ` · 依赖 ${w.dependsOn.length} 项`}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="待你回答"
            count={detail.pendingQuestions.length}
            hint="需要你处理 · 答完落成 decision 工件"
            hintTitle="来源:ProjectDetail.pendingQuestions(kind = client_question 的工件)。它是持久的 —— 关掉页面下次还看得见。这是**唯一**需要用户动手的提问类数据。"
          >
            {detail.pendingQuestions.length === 0 ? (
              <EmptyState>没有等甲方回答的问题。</EmptyState>
            ) : (
              <div className="grid gap-2">
                {detail.pendingQuestions.map((q) => (
                  <ClientQuestionCard key={q.id} q={q} />
                ))}
              </div>
            )}
          </Section>

          {/*
            内部协作区。**刻意与「待你回答」分开**:这一区里的提问收件人是别的角色,
            用户不是对话的一方。做成同样的可回答卡片会邀请用户去替项目经理拍板,
            而那条链路(角色间问答)有自己的升级机制(judgment 轮 → 必要时才升级到用户)。
          */}
          <Section
            title="内部协作"
            count={asks.length}
            hint="角色之间的提问 · 不用你处理"
            hintTitle="来源:GET /api/projects/:id/asks(AskView)。契约:「甲方看不到横向沟通,只看发给自己那部分」。这一区只读 —— 角色间的问答由团队自己收敛,越不过去时才升级成「待你回答」的问题。"
          >
            {asksError !== null ? (
              <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
                加载失败:{asksError}
              </div>
            ) : asksLoading && asks.length === 0 ? (
              <EmptyState>加载中…</EmptyState>
            ) : asks.length === 0 ? (
              <EmptyState>没有角色之间的提问 —— 团队没卡在横向沟通上。</EmptyState>
            ) : (
              <div className="grid gap-1.5">
                {asks.map((a) => (
                  <article key={a.id} className="sansheng-card p-2.5" title={a.id}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill tone={askStatusTone(a.status)} title={`AskStatus.${a.status}`}>
                        {askStatusLabel(a.status)}
                      </Pill>
                      <span className="ss-body" style={{ color: "var(--bone)" }}>
                        {a.fromName || a.fromAgentId}
                        <span className="ss-meta"> 问 </span>
                        {a.toName || a.toAgentId}
                      </span>
                      <span className="ss-meta ml-auto">{fmtTime(a.createdAt)}</span>
                    </div>

                    <div className="ss-body mt-1" style={{ color: "var(--bone)" }}>
                      {a.question}
                    </div>

                    {/* hypothesis = 提问者自己先给一个判断(与 client_question 的 lean 同构)。
                        后端纪律要求它必须有全文,否则接话的人无从判断 —— 所以不折叠。 */}
                    {a.hypothesis.length > 0 && (
                      <Flag tone="cyan">
                        <span className="ss-meta">假设</span>
                        <span className="ss-body" style={{ color: "var(--bone-dim)" }} title={a.hypothesis}>
                          {excerpt(a.hypothesis, 160)}
                        </span>
                      </Flag>
                    )}

                    {a.options.length > 0 && (
                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                        {a.options.map((opt) => (
                          <span key={opt} className="ss-pill" data-tone="bone" title="候选答案(只读)">
                            {opt}
                          </span>
                        ))}
                      </div>
                    )}

                    {a.needs !== null && a.needs.length > 0 && (
                      <div className="ss-note mt-0.5" title={a.needs}>
                        需要:{excerpt(a.needs, 120)}
                      </div>
                    )}

                    <div className="ss-meta mt-0.5">
                      {a.deadlineAt !== null && `截止 ${fmtTime(a.deadlineAt)}`}
                      {a.deadlineAt !== null && a.resolvedAt !== null && " · "}
                      {a.resolvedAt !== null && `答复于 ${fmtTime(a.resolvedAt)}`}
                      {a.parentAskId !== null && ` · 上级提问 ${a.parentAskId}`}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="变更记录"
            count={changes.length}
            hint="提议 → 评审 → 接受/实施"
            hintTitle="来源:GET /api/projects/:id/changes(ChangeView)。status 取值来自契约 ChangeStatus(proposed|under_review|accepted|implemented|rejected)。"
          >
            {changesError !== null ? (
              <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
                加载失败:{changesError}
              </div>
            ) : changesLoading && changes.length === 0 ? (
              <EmptyState>加载中…</EmptyState>
            ) : changes.length === 0 ? (
              <EmptyState>没有变更记录 —— 这个项目还没改过范围或方向。</EmptyState>
            ) : (
              <div className="grid gap-1.5">
                {changes.map((c) => (
                  <article key={c.id} className="sansheng-card p-2.5" title={c.id}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill tone={changeStatusTone(c.status)} title={`ChangeStatus.${c.status}`}>
                        {changeStatusLabel(c.status)}
                      </Pill>
                      <span className="ss-body" style={{ color: "var(--bone)" }}>
                        {c.title || "(无标题)"}
                      </span>
                      <span className="ss-meta ml-auto">{fmtTime(c.createdAt)}</span>
                    </div>
                    {c.rationale.length > 0 && (
                      <div className="ss-note mt-0.5" title={c.rationale}>
                        {excerpt(c.rationale, 140)}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="阻塞"
            count={blockers.length}
            hint="卡住了哪些工作项"
            hintTitle="来源:GET /api/projects/:id/blockers。severity / status 取值来自契约的 BlockerSeverity / BlockerStatus。"
          >
            {blockers.length === 0 ? (
              <EmptyState>没有登记在案的阻塞。</EmptyState>
            ) : (
              <div className="grid gap-1.5">
                {blockers.map((b) => (
                  <article key={b.id} className="sansheng-card p-2.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill tone={blockerSeverityTone(b.severity)}>{blockerSeverityLabel(b.severity)}</Pill>
                      <Pill tone={blockerStatusTone(b.status)}>{blockerStatusLabel(b.status)}</Pill>
                      <span className="ss-body" style={{ color: "var(--bone)" }}>
                        {b.title}
                      </span>
                      <span className="ss-meta ml-auto">{b.raisedByName}</span>
                    </div>
                    {b.detail.length > 0 && (
                      <div className="ss-note mt-0.5" title={b.detail}>
                        {excerpt(b.detail, 90)}
                      </div>
                    )}
                    <div className="ss-meta mt-0.5">
                      {fmtTime(b.createdAt)}
                      {b.blockedWorkIds.length > 0 && ` · 卡住 ${b.blockedWorkIds.length} 个工作项`}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
