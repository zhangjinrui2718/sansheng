/**
 * Sansheng · 目标页(批次 UI U1 · 批次 UI U4 文字分层)
 *
 * ⚠️ 数据来源声明(这是**投影视图**,不是独立的 goals 子系统;完整论证在下面,
 * 页面上的那两行说明已移进 `PageHeader` 的 `hintTitle`,悬停可见):
 *   PLAN.md 的 M7「Goals」目前**后端没有实现**。开工前逐项查证:
 *     - `shared/types/goals.ts` 只有 `Goal`/`RedLine` 两个 interface,文件头自述
 *       「M5/M7/M8 填实」,全仓**零消费者**(grep `types/goals` 在 src/ web/ tests/ 无命中);
 *     - `migrations/001..005_*.sql` 里**没有 goals 表**(artifacts 存在 blackboards
 *       表的 artifacts_json 列里);
 *     - HTTP 层**没有** `/api/goals` 路由(src/server/http.ts + http/blackboardRoutes.ts 全量核对)。
 *   故按任务书「方案②」:目标 = 用户/沟通员表达过的 **intent artifact**,
 *   进度 = 该 intent 名下 todo artifact 的真实状态聚合(parentIntent 关联由
 *   planner.ts:239 真实写入、orchestrator.ts:406 maybeResolveIntent 真实消费)。
 *   这是**可逆**方案:将来 M7 真落地时,只需把本文件的数据源从 artifacts 换成
 *   `/api/goals`,页面结构与设计不动。**零 mock 数据** —— 空库就显示空态。
 *
 * 数据源:`GET /api/artifacts?conversationId=<id>&limit=200`(同工件页的权威端点),
 *   由 `lib/artifacts.ts` 的 `useArtifacts()` 统一读取(同端点 / 同 limit / 同错误解析),
 *   intent 取 kind=intent,todo 取 kind=todo 并按 parentIntent 归组。
 *
 * ── 批次 UI U4:本页搬走了什么 ────────────────────────────────────
 *  - 页首那段两行「数据来源:本会话的 intent 工件(沟通员/用户表达过的目标)+ 其名下
 *    todo 的真实状态。M7 Goals 子系统尚未实现,当前为投影视图。」从**常驻正文**降级为
 *    `PageHeader` 的 `hintTitle`(悬停可见);h1 旁边只留一句短的 hint。
 *    —— 事实一个字没删,只是不再要求每个读者读完才看到第一个目标。
 *  - 标题前的靶心 emoji(本行刻意不写该字符,以免被 emoji 静态扫描误判)→ 一个 jade
 *    圆点(项目规则:UI 标签不用 emoji)。
 *  - 本地自持的三张词表(`STATUS_LABEL` / `STATUS_TONE` / `TODO_TONE`)+ 自己抄的
 *    fetch/useState 三件套 → 全部换成 `lib/artifacts.ts` 的共享版本。
 *    ⚠️ **这修了一处真实的读法漂移**:本页旧词表把 `open` 写成「进行中」、
 *    `resolved` 写成「已达成」、`failed` 写成「未达成」,而工件页 / Agents 页把同一个
 *    状态写成「待处理」/「已解决」/「失败」—— 同一个工件两种读法。现在四页一致,
 *    目标卡显示的是**共享状态标签**(即 intent 工件本身的状态,不是本页另造的一套)。
 *  - 目标正文由「整段撑开」改为默认 `Clamp(2)` + 长文才出现的 `Disclosure`
 *    (长度判据是 `excerpt(body,120) !== body`,对真实字段做的计算,不是拍脑袋的阈值),
 *    免得一个长 body 把下面所有目标卡推出首屏。
 *  - 根元素 `<main className="px-4 pb-4">` → `<div className="ss-page">`:
 *    app shell 已经拥有 `<main>` 与滚动容器,嵌套 `<main>` 是无效 HTML。
 */
import { useMemo } from "react";
import {
  PLAN_HOWTO,
  excerpt,
  fmtTime,
  orphanTodos,
  statusLabel,
  statusTone,
  useArtifacts,
} from "@/lib/artifacts";
import {
  Clamp,
  Disclosure,
  EmptyState,
  Flag,
  PageHeader,
  Pill,
  Progress,
  StatStrip,
  toneColor,
} from "@/components/ui/primitives";

/** 计入「已完成」的 todo 状态(本地进度口径,不是工件页的终态表)。 */
const DONE_STATUSES: ReadonlySet<string> = new Set<string>(["resolved", "superseded"]);

interface Props {
  conversationId: string | null;
}

export function GoalsPage({ conversationId }: Props) {
  const { artifacts, loading, error } = useArtifacts();

  // 目标 = intent artifact;进度 = 名下 todo 的真实状态聚合
  const goals = useMemo(() => {
    const intents = artifacts.filter((a) => a.kind === "intent");
    return intents
      .map((intent) => {
        const todos = artifacts.filter((a) => a.kind === "todo" && a.parentIntent === intent.id);
        const done = todos.filter((t) => DONE_STATUSES.has(t.status)).length;
        return { intent, todos, done, total: todos.length };
      })
      .sort((a, b) => b.intent.createdAt - a.intent.createdAt);
  }, [artifacts]);

  /**
   * 挂不到任何目标名下的待办(`parentIntent` 没写,或指向本会话不存在的 intent)。
   *
   * 这一段是本批新加的。此前本页只 `filter(kind === "intent")`,于是这类待办
   * **被静默丢掉**:页面只说「本会话暂无目标」,而实际上有 N 个待办躺在
   * blackboard 上没人管。Agent 页早就为同一件事专门开了一块「未归属意图的
   * 待办」(还写明了「以免丢数据」),本页却装作没有 —— 同一份数据,两个页面
   * 两种说法。判据抽在 `lib/artifacts.ts` 的 `orphanTodos()`,两页共用一份。
   */
  const orphans = useMemo(() => orphanTodos(artifacts), [artifacts]);

  const settled = goals.filter((g) => g.intent.status === "resolved" || g.intent.status === "failed");

  return (
    <div className="ss-page">
      <PageHeader
        title="目标"
        // 空页不挂 hint,也不摆一排 0 —— 那两个 0 在没有数据时不是「测出来的 0」。
        hint={goals.length > 0 ? "本会话表达过的目标" : undefined}
        hintTitle="数据来源:本会话的 intent 工件(沟通员 / 用户表达过的目标)+ 其名下 todo 的真实状态。M7 Goals 子系统尚未实现,当前为投影视图,不是独立的 goals 存储。"
        aside={
          goals.length > 0 ? (
            <StatStrip
              items={[
                { label: "目标", value: goals.length },
                { label: "已收口", value: settled.length, tone: settled.length > 0 ? "bamboo" : undefined },
                ...(loading && artifacts.length > 0 ? [{ label: "状态", value: "刷新中" }] : []),
              ]}
            />
          ) : undefined
        }
      />

      {error && (
        <Flag tone="cinnabar">
          <span className="ss-body" style={{ color: "var(--cinnabar)" }}>
            加载失败:{error}
          </span>
        </Flag>
      )}

      {!conversationId ? (
        <EmptyState>先在「对话」里选一个会话。</EmptyState>
      ) : loading && goals.length === 0 ? (
        // 此前这一档不存在:加载中直接落到下面的 `goals.map`,页面上什么都不渲染。
        // 空白比「加载中…」难判断得多(用户会以为这页坏了)。
        <EmptyState>加载中…</EmptyState>
      ) : !error && goals.length === 0 ? (
        <EmptyState>
          {orphans.length > 0 ? (
            /* 有待办却没有目标 —— 此时说「本会话暂无目标」等于**把 N 个待办藏起来**。
               用户看到的是一个空页,实际上 blackboard 上有活。 */
            <>
              本会话有 {orphans.length} 个待办没有归属到任何目标下(目标工件为空),
              规划员还没落意图。在「Agent 工作面」页能看到它们。
            </>
          ) : (
            <>
              本会话暂无目标 —— 普通的聊天不会产生目标。
              {PLAN_HOWTO}
            </>
          )}
        </EmptyState>
      ) : (
        <div className="grid gap-2">
          {goals.map(({ intent, todos, done, total }) => {
            const pct = total === 0 ? 0 : Math.round((done / total) * 100);
            const tone = intent.status === "failed" ? "cinnabar" : "jade";
            const body = intent.body && intent.body !== intent.title ? intent.body : "";
            // 长文才给「展开」入口:判据是对真实 body 做的截断比较,不是固定字数拍脑袋。
            const bodyLong = body.length > 0 && excerpt(body, 120) !== body;
            return (
              <article key={intent.id} className="sansheng-card p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      background: "var(--jade)",
                      flex: "0 0 auto",
                    }}
                  />
                  <Pill tone={statusTone(intent.status)} title="intent 工件状态(与工件页同一套词表)">
                    {statusLabel(intent.status)}
                  </Pill>
                  <span className="ss-meta ml-auto">{fmtTime(intent.createdAt)}</span>
                </div>
                <div className="ss-body" style={{ color: "var(--bone)" }}>
                  {intent.title}
                </div>
                {body.length > 0 && (
                  <>
                    <Clamp lines={2} style={{ marginTop: 4 }}>
                      {body}
                    </Clamp>
                    {bodyLong && (
                      <Disclosure summary="展开原文">
                        <div style={{ whiteSpace: "pre-wrap" }}>{body}</div>
                      </Disclosure>
                    )}
                  </>
                )}

                {total > 0 ? (
                  <div className="mt-2">
                    <div className="flex items-center gap-2">
                      <Progress pct={pct} tone={tone} />
                      <span className="ss-meta">
                        {done}/{total} · {pct}%
                      </span>
                    </div>
                    <ul className="grid gap-1 mt-2">
                      {todos.map((t) => (
                        <li key={t.id} className="flex items-center gap-2">
                          <span
                            title={`${statusLabel(t.status)}${t.id ? ` · ${t.id}` : ""}`}
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 2,
                              flex: "0 0 auto",
                              background: toneColor(statusTone(t.status)),
                            }}
                          />
                          <span className="truncate ss-body" style={{ color: "var(--bone-dim)" }}>
                            {t.title}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="ss-note mt-2">尚无 todo —— Planner 还没拆解这个目标。</div>
                )}
              </article>
            );
          })}

          {/* 部分归属的情况:有目标,也有几个待办不属于任何一个。同样不藏。 */}
          {orphans.length > 0 && (
            <div className="sansheng-card p-3">
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="ss-section" style={{ fontSize: 12 }}>
                  未归属的待办
                </span>
                <span className="ss-meta">{orphans.length}</span>
              </div>
              <ul className="grid gap-1">
                {orphans.map((t) => (
                  <li key={t.id} className="flex items-center gap-2">
                    <span
                      title={statusLabel(t.status)}
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 2,
                        flex: "0 0 auto",
                        background: toneColor(statusTone(t.status)),
                      }}
                    />
                    <span className="truncate ss-body" style={{ color: "var(--bone-dim)" }}>
                      {t.title}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="ss-note mt-1.5">
                parentIntent 没写,或指向本会话不存在的目标工件。
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
