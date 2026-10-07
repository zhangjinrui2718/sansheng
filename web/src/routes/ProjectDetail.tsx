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
import { useCallback, useState } from "react";
import { PageHeader, Pill, Section, StatStrip, EmptyState, KV, Flag } from "@/components/ui/primitives";
import { ClientQuestionCard } from "@/components/client/ClientQuestionCard";
import {
  useProjectAsks, useProjectChanges, useProjectDetail, useProjectLive, useProjectMessages,
  useProjectWorkspace,
} from "@/lib/data";
import { platformNoticeLabel, type PlatformNoticeKind } from "@/lib/platformNotices";
import { liveHeadline, orgRuntime } from "@/lib/orgState";
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

/**
 * 字节数的读法。**没有**引入任何格式化库 —— 这里只需要「一眼看出量级」,
 * 而多一个依赖换来的千分位/单位智能在磁盘观测这件事上零信息量。
 * 目录(`bytes === null`)由调用点渲染成「—」,不走这里(不编一个 0)。
 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * 可复制的绝对路径。**复制成功要说出来** —— 静默成功的按钮等于没做
 * (与 `deliverable/CodeService.tsx` 的 `Command` 同一条纪律,只是这里
 * 复制的是一个路径而不是一条命令)。
 */
function CopyPath({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }, [text]);
  return (
    <div className="flex items-center gap-2">
      <code
        style={{
          flex: 1,
          fontSize: 12,
          padding: "4px 6px",
          background: "var(--ink-1)",
          border: "1px solid var(--ink-3)",
          borderRadius: 6,
          color: "var(--bone)",
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
        title={text}
      >
        {text}
      </code>
      <button
        type="button"
        className="sansheng-button"
        style={{ padding: "1px 8px", fontSize: 11 }}
        onClick={copy}
        title="复制这个绝对路径"
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

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
  // 「此刻」的唯一读面。`pollMs: 0` = **不轮询**:这一页此前没有任何定时器,状态行要的是
  // 「打开/事件后刷新」而不是每 2.5 秒重画一次(WS 事件会推 `activityRevision`,见
  // `useProjectLive`)。
  const live = useProjectLive(projectId, { pollMs: 0 });
  // 文件系统观测面(设计 §4.4,P0)。与这一页其余读面一样:**不轮询** ——
  // 盘上的形状只在用户主动看时取一次,WS 事件会推 `projectRevision` 让它重查。
  const {
    data: workspace,
    loading: workspaceLoading,
    error: workspaceError,
  } = useProjectWorkspace(projectId);
  // 两类平台记录的**分类**(platformNotices.ts)与**状态派生**(orgState.ts)都是纯函数 ——
  // 页面只渲染结果,不自己认字符串、也不自己编状态。
  const runtime = orgRuntime({ messages, live: live.data });

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
            平台记录的**全文落点**,按主体分两段(2026-10-05)。

            ⚠️ 两段的**状态语义完全不同**,这是这次分家的全部理由:
              - 「停止推进」是运行态**快照** —— 会自己过去(兜底定时器每 10 秒重查);
                所以它带一个**派生出来的状态**(已接回 / 会被接回 / 在等你 / 不会自愈……),
                判据在 `lib/orgState.ts`,事实来自 `GET /live` 与 `GET /messages`。
              - 「合规告警」是既成事实的**记录** —— 它**没有**「已解决」这个状态,
                也不该有(平台不替模型补那行 `[未播报]`)。所以它只报事实与计数,
                并明写「这不是待办」。
          */}
          <Section
            title="组织推进"
            count={runtime.stops.length}
            hint="平台叫醒的排空在这里异常停下过 · 每条带此刻的状态"
            hintTitle="来源:GET /api/projects/:id/messages 里 kind = 'system' 且正文以「⚠️ 组织停止推进」开头的行(serve.ts 的 announceDrain 落库)。状态由 lib/orgState.ts 从「此刻」读面(GET /api/projects/:id/live:在跑的回合 / 可执行待办 / 预算用尽的待办 / 等甲方答的问题 / 兜底定时器心跳)与「这条之后又落了几个回合」派生 —— 不是编的。读不到运行态时显示「读不到」,不显示「空闲」。"
          >
            <div className="ss-note mb-1.5" title="来源:GET /api/projects/:id/live —— 「此刻」的唯一读面">
              {liveHeadline(live.data)}
              {runtime.attention > 0 && (
                <span style={{ color: "var(--amber)" }}>
                  {" · "}
                  有 {runtime.attention} 条停下来的原因**不是自己会过去**的
                </span>
              )}
            </div>
            {noticesError !== null ? (
              <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
                加载失败:{noticesError}
              </div>
            ) : noticesLoading && runtime.stops.length === 0 ? (
              <EmptyState>加载中…</EmptyState>
            ) : runtime.stops.length === 0 ? (
              <EmptyState>没有异常停下过 —— 排空每次都跑到了没有待办为止。</EmptyState>
            ) : (
              <div className="grid gap-1.5">
                {runtime.stops.map(({ notice, state }) => (
                  <article
                    key={notice.id}
                    className="sansheng-card p-2.5"
                    data-notice-kind="stop"
                    data-stop-state={state.key}
                    title={notice.id}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill tone="amber" title={NOTICE_TITLE.stop}>
                        {platformNoticeLabel("stop")}
                      </Pill>
                      {/* 状态是这一批的重点:同一个类名下的两条,状态可能完全不同 */}
                      <Pill
                        tone={
                          state.key === "stalled"
                            ? "cinnabar"
                            : state.key === "waiting_client"
                              ? "amber"
                              : state.key === "unreadable"
                                ? "mute"
                                : "bone"
                        }
                        title={state.why}
                      >
                        {state.label}
                      </Pill>
                      <span className="ss-meta ml-auto">{fmtTime(notice.createdAt)}</span>
                    </div>
                    <div className="ss-note mt-0.5" title="判据(为什么是左边那个状态)">
                      {state.why}
                    </div>
                    <div className="ss-meta">该怎么办:{state.action}</div>
                    {/* 正文原样:换行保留(库里那几段本来就是分行写的) */}
                    <div
                      className="ss-body mt-1"
                      style={{ color: "var(--bone)", whiteSpace: "pre-wrap" }}
                    >
                      {notice.content}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="合规记录"
            count={runtime.compliance.length}
            hint="平台叫醒的回合没留工作记录 · 记录,不是待办"
            hintTitle="来源:GET /api/projects/:id/messages 里 kind = 'system' 且正文以「⚠️ 平台检测」开头的行(serve.ts 的 reportUnannouncedTurn 落库:平台叫醒的回合既没调 tell_client、正文也没有行首 [未播报])。⚠️ 它**没有状态**:那一个回合确实没留痕,平台也不替模型补那行记录 —— 任何「已解决」都是编造现场。能降频的只有机制(提示词 / 检测)。"
          >
            {runtime.compliance.length === 0 ? (
              <EmptyState>没有合规告警 —— 平台叫醒的每个回合都留了工作记录。</EmptyState>
            ) : (
              <div className="grid gap-1.5">
                {runtime.compliance.map((n) => (
                  <article
                    key={n.id}
                    className="sansheng-card p-2.5"
                    data-notice-kind="compliance"
                    title={n.id}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill tone="cyan" title={NOTICE_TITLE.compliance}>
                        {platformNoticeLabel("compliance")}
                      </Pill>
                      <Pill tone="mute" title="这一类没有「已解决」—— 它是记录,不是待办">
                        记录 · 不需要你动作
                      </Pill>
                      <span className="ss-meta ml-auto">{fmtTime(n.createdAt)}</span>
                    </div>
                    <div className="ss-body mt-1" style={{ color: "var(--bone)", whiteSpace: "pre-wrap" }}>
                      {n.content}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Section>

          {/*
            文件系统:项目目录的**只读观测面**(设计 docs/DESIGN-WORKSPACE.md §4.4,P0)。
            放在「组织推进」「合规记录」两段之后 —— 那两段回答「组织在不在动、
            动得规不规矩」,这一段回答「它到底在盘上留下了什么」。

            两条反造假纪律在这里的落法(与 ProjectLiveView.runtime 同源):
              · `runtime === "unavailable"` ⇒ 显示 problem 那一行,**绝不**渲染成空目录;
              · `index.runtime === "not_migrated"` ⇒ 如实写「索引化尚未落地」,
                而不是让 `indexed` 全 false 看起来像「这些文件全是孤儿」。
          */}
          <Section
            title="文件系统"
            count={workspace?.runtime === "ok" ? workspace.counts.entries : undefined}
            hint="只读:盘上有什么 + 索引引用了什么"
            hintTitle="来源:GET /api/projects/:id/workspace(设计 docs/DESIGN-WORKSPACE.md §4.4,P0)。这条读面**只读** —— 它不建目录、不写文件。扫描深度上限 3 层、条目上限 500;到界或有内容读不出来时 truncated = true(不静默少列)。"
          >
            {workspaceError !== null ? (
              <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
                加载失败:{workspaceError}
              </div>
            ) : workspace === null ? (
              <EmptyState>{workspaceLoading ? "加载中…" : "读不到工作区。"}</EmptyState>
            ) : (
              <div className="grid gap-2">
                {/* root 的绝对路径(可复制)—— 「读不到」时它更要显示:用户要拿着它去盘上核对 */}
                <CopyPath text={workspace.root} />

                {workspace.index.runtime === "not_migrated" && (
                  <div
                    className="ss-note"
                    title="artifacts.body_path 这一列由 P2 的 migration 027 加上。在那之前索引里一条正文路径都没有 —— 这不是「盘上的文件都是孤儿」,是「索引这件事还没落地」。"
                  >
                    索引化尚未落地,盘上文件暂未与工件建立边(artifacts.body_path 列还不存在)。
                  </div>
                )}

                {workspace.runtime === "unavailable" ? (
                  // 「读不到」**不是**「空目录」—— 这一行是两者的分界线,不许被空态替代。
                  <Flag tone="cinnabar">
                    读不到这个项目的工作目录(这不是「空目录」,是「没读到」):{workspace.problem}
                  </Flag>
                ) : (
                  <>
                    <div className="flex items-center gap-2 flex-wrap ss-meta">
                      <span>条目 {workspace.counts.entries}</span>
                      <span>已索引 {workspace.counts.indexed}</span>
                      <span>孤儿文件 {workspace.counts.orphanFile}</span>
                      <span>库里有盘上无 {workspace.missing.length}</span>
                      {workspace.truncated && (
                        <Pill tone="amber" title="到深度 / 条目上限,或有内容读不出来 —— 下面这份列表不全">
                          已截断 · 列表不全
                        </Pill>
                      )}
                    </div>

                    {workspace.entries.length === 0 ? (
                      <EmptyState>
                        这个项目的目录是空的 —— 这一次确实「读到了」(runtime ok),里面一个条目都没有。
                      </EmptyState>
                    ) : (
                      <div className="grid gap-1">
                        {workspace.entries.map((e) => (
                          <div
                            key={e.path}
                            className="sansheng-card p-1.5 flex items-center gap-2 flex-wrap"
                            title={e.path}
                          >
                            <Pill tone={e.kind === "dir" ? "mute" : "bone"}>
                              {e.kind === "dir" ? "目录" : "文件"}
                            </Pill>
                            <code style={{ fontSize: 12, color: "var(--bone)", wordBreak: "break-all" }}>
                              {e.path}
                            </code>
                            {e.indexed && (
                              <Pill tone="cyan" title="artifacts.body_path 里有这条路径">
                                已索引
                              </Pill>
                            )}
                            <span className="ss-meta ml-auto">
                              {e.bytes === null ? "— 目录" : fmtBytes(e.bytes)} · {fmtTime(e.mtimeMs)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {workspace.missing.length > 0 && (
                      <div className="grid gap-1">
                        <div className="ss-note">库里有、盘上没有(索引指向的文件在盘上找不到):</div>
                        {workspace.missing.map((m) => (
                          <div
                            key={m.path}
                            className="sansheng-card p-1.5 flex items-center gap-2 flex-wrap"
                            style={{ borderLeft: "2px solid var(--cinnabar)" }}
                            title={m.path}
                          >
                            <code style={{ fontSize: 12, color: "var(--bone)", wordBreak: "break-all" }}>
                              {m.path}
                            </code>
                            <span className="ss-meta ml-auto">
                              {m.title || "(无标题)"}
                              {m.artifactId !== "" && ` · ${m.artifactId}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </Section>

          {/*
            只在**真的有**认不出类别的平台记录时才渲染这一段(与成员页那段 `strangers`
            同一形态:一条证据可以被折叠,但不许被删掉)。今天它是空的 —— 两个写入方
            (`announceDrain` / `reportUnannouncedTurn`)的正文前缀都被分类器认得。
          */}
          {runtime.others.length > 0 && (
            <Section
              title="其他平台记录"
              count={runtime.others.length}
              hint="认不出类别的平台通知 · 原样保留"
              hintTitle="分类器认的是正文首行前缀(「⚠️ 组织停止推进」/「⚠️ 平台检测」)。认不出的**不当丢**:它在这里原样显示 —— 分类失手只会退化成「其他」,不会静默消失(见 lib/platformNotices.ts)。"
            >
              <div className="grid gap-1.5">
                {runtime.others.map((n) => (
                  <article
                    key={n.id}
                    className="sansheng-card p-2.5"
                    data-notice-kind="other"
                    title={n.id}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill tone="bone" title={NOTICE_TITLE.other}>
                        {platformNoticeLabel("other")}
                      </Pill>
                      <span className="ss-meta ml-auto">{fmtTime(n.createdAt)}</span>
                    </div>
                    <div
                      className="ss-body mt-1"
                      style={{ color: "var(--bone)", whiteSpace: "pre-wrap" }}
                    >
                      {n.content}
                    </div>
                  </article>
                ))}
              </div>
            </Section>
          )}

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
