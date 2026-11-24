/**
 * 成员页 · 「**他做了什么**」—— 某一个成员的执行轨迹(migration 035)
 *
 * ── 它与「他说了什么」(`AgentConversations`)的分工 ────────────────
 *
 *   · 那条答「他说了什么」:对话全文(回合的**正文**,`session_messages`);
 *   · 本组件答「他做了什么」:逐次工具调用 / provider 故障 / 回合级标记
 *     (`turn_events`,工具行**逐条落库**)。
 *
 * ── 为什么要有这一块(真机痛点)──────────────────────────────────
 *
 * 排查「它到底卡在哪一步」(unanswered_turn、109K token 墙钟超时、排空器
 * 空转)此前只能翻 stdout 日志 —— 工具轨迹在回合内存里抓得全,却只被渲染成
 * 一段散文随日志漂走。落库之后这一块就是它的**读面**。
 *
 * ⚠️ **进行中的回合也在**(2026-11-25):工具行每次调用结束就落库,所以正在跑的
 * 那一轮在这里一行一行地长。收没收口由 `finished` 说话 —— `false` 只能读成
 * 「还没结束」:它可能还在跑,也可能是进程在它结束前退出过,读面分不开这两者,
 * 界面就不替它断言哪一种。
 *
 * ⚠️ **四态只算一次**(`remoteListOf`):「还没查过」不许长成「0 个回合」,
 * 「读不到」不许长成「没做过事」—— 与全站 `DataState` 同一条纪律。
 */
import type { AgentTurnView } from "@shared/types/platform";
import { Pill } from "@/components/ui/primitives";
import { DataState, remoteListOf } from "@/components/ui/DataState";
import { useAgentTurnEvents } from "@/lib/data";
import { fmtTime } from "@/lib/vocab";

/** 容器:取数(四态在展示件里判,容器只递原始三件套)。 */
export function AgentTurnLog({
  projectId,
  agentId,
  agentName,
}: {
  projectId: string;
  agentId: string;
  agentName: string;
}) {
  const log = useAgentTurnEvents(projectId, agentId);
  return (
    <AgentTurnLogBody
      agentName={agentName}
      turns={log.data?.turns ?? []}
      loading={log.loading}
      error={log.error}
    />
  );
}

/**
 * **纯 props 的展示件**(导出给测试)—— 与 `AgentConversationBody` 同一处置:
 * 组件不碰 store、不发请求,判据全在 props 里。
 */
export function AgentTurnLogBody({
  agentName,
  turns,
  loading,
  error,
}: {
  agentName: string;
  turns: readonly AgentTurnView[];
  loading: boolean;
  error: string | null;
}) {
  const state = remoteListOf(turns, loading, error);
  const toolTotal = turns.reduce((n, t) => n + t.events.filter((e) => e.kind === "tool").length, 0);
  const failedTotal = turns.reduce(
    (n, t) => n + t.events.filter((e) => e.kind === "tool" && e.isError).length,
    0
  );
  /** 没收口的回合数 —— 写在**折叠标题**里:这一块默认收起,不展开也要看得出有回合在长。 */
  const openTotal = turns.filter((t) => !t.finished).length;

  return (
    <DataState
      what="执行轨迹"
      variant="note"
      state={state}
      errorLabel="执行轨迹读不到"
      errorNote=" —— 这次请求失败了,不是「他什么都没做过」。"
      loadingLabel="正在读取执行轨迹…"
    >
      {(rows) =>
        rows.length === 0 ? (
          <div className="ss-note">
            {`${agentName}还没有留下过执行轨迹(只有发生过工具调用、故障或超时标记的回合才会有一行)。`}
          </div>
        ) : (
          <details className="ss-disclosure">
            {/* 默认收起(与「已说完的」同一条理由):面板一屏还有别的块,
                铺开会把结构淹掉;**计数永远可见**(点开之前就知道有几回合)。 */}
            <summary>
              {`展开看轨迹 · ${rows.length} 个回合 / ${toolTotal} 次工具` +
                (failedTotal > 0 ? ` / ${failedTotal} 次失败` : "") +
                (openTotal > 0 ? ` / ${openTotal} 个未结束` : "")}
            </summary>
            <div
              className="flex flex-col gap-2"
              style={{ maxHeight: 420, overflowY: "auto", paddingTop: 6, paddingRight: 4 }}
            >
              {rows.map((t) => (
                <TurnEventCard key={t.turnId} turn={t} />
              ))}
            </div>
          </details>
        )
      }
    </DataState>
  );
}

/** 一个回合的轨迹卡:头部(时刻 + 线 + 失败计数)+ 逐事件行。 */
function TurnEventCard({ turn }: { turn: AgentTurnView }) {
  const failed = turn.events.filter((e) => e.kind === "tool" && e.isError).length;
  return (
    <article className="sansheng-card p-2.5" style={{ borderColor: "var(--ink-3)" }}>
      <div className="flex items-baseline gap-2 flex-wrap" style={{ fontSize: 12 }}>
        <span className="ss-meta font-mono">{fmtTime(turn.createdAt)}</span>
        <Pill tone={failed > 0 ? "cinnabar" : "mute"}>
          {`${turn.events.filter((e) => e.kind === "tool").length} 次工具` +
            (failed > 0 ? ` · ${failed} 失败` : "")}
        </Pill>
        <span className="ss-meta">
          {turn.workId !== null ? `工作项 ${turn.workId}` : "不挂工作项"}
        </span>
        {!turn.finished && <Pill tone="mute">未结束</Pill>}
      </div>
      {!turn.finished && (
        <div className="ss-note" style={{ marginTop: 4 }}>
          还没结束,行会继续增加;一直停在这里说明进程中途退出过。
        </div>
      )}
      <div
        className="flex flex-col gap-0.5"
        style={{ marginTop: 6, fontSize: 12, lineHeight: 1.7 }}
      >
        {turn.events.map((e) => (
          <TurnEventLine key={e.seq} event={e} />
        ))}
      </div>
    </article>
  );
}

/** 一行轨迹:工具(名字 + 时长 + 参数/结果摘要)或故障/标记。 */
function TurnEventLine({ event }: { event: AgentTurnView["events"][number] }) {
  if (event.kind === "tool") {
    return (
      <div className="flex gap-1.5 items-baseline flex-wrap">
        <span style={{ color: event.isError ? "var(--cinnabar)" : "var(--jade)" }}>
          {event.isError ? "✖" : "✓"}
        </span>
        <span className="font-mono">{event.tool}</span>
        {event.durationMs !== null && <span className="ss-meta">{event.durationMs}ms</span>}
        {event.argsSummary !== "" && (
          <span className="ss-meta" style={{ wordBreak: "break-all" }}>
            参数:{event.argsSummary}
          </span>
        )}
        {event.resultSummary !== "" && (
          <span className="ss-meta" style={{ wordBreak: "break-all" }}>
            结果:{event.resultSummary}
          </span>
        )}
      </div>
    );
  }
  // provider 故障与回合级标记:一行事实,失败的红、提示的灰。
  return (
    <div
      className="ss-meta"
      style={{
        wordBreak: "break-all",
        ...(event.isError ? { color: "var(--cinnabar)" } : {}),
      }}
    >
      {`${event.kind === "provider_error" ? "供应商故障" : "标记"}:${event.resultSummary}`}
    </div>
  );
}
