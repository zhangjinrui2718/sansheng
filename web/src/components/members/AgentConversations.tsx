/**
 * 成员页 · 「**他说了什么**」—— 某一个成员的**对话全文**(进行中 + 已完成)
 *
 * ── 用户要的是什么(原话)────────────────────────────────────────
 *
 * 「我想看看每一个agent 进行中、已完成的具体的对话内容,只读就好了,
 *   在成员的这个页面中新增这项功能」
 *
 * 所以这一块只做**读**:它不写任何东西、不发任何指令、不改任何状态。
 *
 * ── 之前那一块为什么不够 ───────────────────────────────────────
 *
 * 成员页原来那块「他产生了什么对话」是 `memberConversations` 给的一页摘要:
 * 每条**截到 90 字**、**新的在前**、默认折叠。那是**清单**(谁说过几条话),
 * 不是**对话内容** —— 用户要的正是后者。
 *
 * ⚠️ **两块的分工**(不是二选一):
 *   · `member-conversations` 答「**谁**说过话、各说了几条」→ 页签角标与总数;
 *   · 本组件答「**这个人具体说了什么**」→ 逐条对话线 + 全文。
 *
 * ── 「进行中」的数据源 = **前端 WS 流的在飞轮** ──────────────────
 *
 * ⚠️ **落库只有回合的最终正文**:一条会话消息 = 一个回合的正文(`kind='assistant'`),
 * 工具调用与思考过程**不落库**。所以「进行中」的那部分内容**只在它正在流的时候
 * 看得见** —— 它在 WS 事件流里(`message_start` / `delta` / `tool_start`),
 * 回合结束后进 `session_messages`。
 *
 * ⇒ 这一块的诚实边界:① **正在流的**内容来自本浏览器的 WS 连接(断了就没有);
 * ② **已完成的**内容是库里那个回合的**最终正文**(不是整个过程的流水)。
 * 两件事都在界面上说清楚,不把「只看得见最终正文」说成「看得见全部过程」。
 *
 * ── 为什么不用忙闩(`hub.runningTurns()`)判「进行中」──────────────
 *
 * 忙闩答的是「**有没有回合在跑**」(宿主内存,重启即清零),它**不带 sessionId
 * 也不带内容** —— 用它只能显示一个「在跑」的灯,给不了「他在说什么」。
 * 用户要的是内容,所以这里取 WS 在飞轮(`stores/chat.ts` 的 `inFlight`),
 * 它**带 agentId / sessionId / 正文块**。
 * ⚠️ 代价要说清:**WS 断流时这一块会空** —— 那时界面如实说「实时流读不到」,
 * 而**已完成的那部分照常显示**(它来自库,与 WS 无关)。
 */
import { useMemo, useState } from "react";
import type {
  AgentConversationLineView,
  SessionMessageView,
} from "@shared/types/platform";
import { Pill } from "@/components/ui/primitives";
import { Markdown } from "@/components/chat/Markdown";
import { useAgentConversations } from "@/lib/data";
import { inFlightTurns, useChatStore, type Turn } from "@/stores/chat";
import { MESSAGE_KIND_LABEL, fmtTime } from "@/lib/vocab";

/** 一条对话线的读法:**它叫什么**。`null` = 甲方没起名 ⇒ 显示「对话」,不编一个。 */
function lineLabel(line: AgentConversationLineView): string {
  if (line.title !== null && line.title !== "") return line.title;
  return line.kind === "main" ? "主对话" : "对话";
}

/** 一条对话线的副标:它是哪条线 + 多少条。 */
function lineSubtitle(line: AgentConversationLineView): string {
  const kind = line.kind === "main" ? "主对话" : "另开的线";
  const channel = line.channel === "client" ? "交付对话" : "内部会话";
  return `${kind} · ${channel} · ${line.messageCount} 条`;
}

/**
 * 一个在飞轮的**正文**:正文块拼起来(思考与工具分开算)。
 *
 * ⚠️ **思考与正文必须分开**(7-I):把推理混进正文,界面上就分不出「他在说」
 * 与「他在想」—— 而那正是这一块要展示的东西。
 */
export function liveTurnParts(turn: Turn): { text: string; thinking: string; tools: string[] } {
  let text = "";
  let thinking = "";
  const tools: string[] = [];
  for (const b of turn.blocks) {
    if (b.kind === "text") text += b.text;
    else if (b.kind === "thinking") thinking += b.text;
    else tools.push(b.tool.isError === true ? `${b.tool.name}(失败)` : b.tool.name);
  }
  return { text, thinking, tools };
}

/**
 * **容器**:取数 + 选中哪条线。
 *
 * ⚠️ **选中哪条线是组件内的状态**(不是后端记的):后端只答「你给的 sessionId
 * 是不是他真有的线」,选哪条是页面的事。
 */
export function AgentConversations({
  projectId,
  agentId,
  agentName,
}: {
  projectId: string;
  agentId: string;
  /** 这个人的显示名(面板标题已有一个,这里只用在提示语里) */
  agentName: string;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const conv = useAgentConversations(projectId, agentId, sessionId);
  // ⚠️ 选择器只取**引用稳定**的字段:`inFlightTurns(s)` 每次调用都返回新数组,
  // 直接放进 selector 会让 zustand 每次都认为状态变了(与 `MessageList` 同一条)。
  const inFlight = useChatStore((s) => s.inFlight);
  const inFlightOrder = useChatStore((s) => s.inFlightOrder);
  const live = useMemo(
    () =>
      inFlightTurns({ inFlight, inFlightOrder }).filter(
        (t) => t.projectId === projectId && t.agentId === agentId,
      ),
    [inFlight, inFlightOrder, projectId, agentId],
  );

  return (
    <AgentConversationBody
      agentName={agentName}
      lines={conv.data?.lines ?? []}
      messages={conv.data?.messages ?? []}
      truncated={conv.data?.truncated ?? false}
      /**
       * **以后端选中的那条为准**(它会拒掉「他真没有消息的线」并退回第一条)——
       * 但**点了之后立刻高亮**:回一赵期间高亮要跟着手指走,否则用户会以为点空了。
       * 两个条件合起来才是对的:本地选中的那个 id **必须真的是他的一条线**
       * (否则那个 id 没意义),否则退回后端说的那条。
       */
      selectedSessionId={
        sessionId !== null && (conv.data?.lines ?? []).some((l) => l.sessionId === sessionId)
          ? sessionId
          : (conv.data?.sessionId ?? null)
      }
      loading={conv.loading}
      error={conv.error}
      live={live}
      onSelectSession={setSessionId}
    />
  );
}

/**
 * **纯 props 的展示件**(导出给测试)—— 与 `MemberPane` / `ConversationCard` 同一处置:
 * 组件不碰 store、不发请求,判据全在 props 里。
 */
export function AgentConversationBody({
  agentName,
  lines,
  messages,
  truncated,
  selectedSessionId,
  loading,
  error,
  live,
  onSelectSession,
}: {
  agentName: string;
  lines: readonly AgentConversationLineView[];
  messages: readonly SessionMessageView[];
  truncated: boolean;
  selectedSessionId: string | null;
  loading: boolean;
  error: string | null;
  /** 正在流的轮(WS 在飞轮里筛出来的) */
  live: readonly Turn[];
  onSelectSession: (sessionId: string) => void;
}) {
  const total = lines.reduce((n, l) => n + l.messageCount, 0);
  const selected = lines.find((l) => l.sessionId === selectedSessionId) ?? null;
  /**
   * ⚠️ **「还没查过」不许长成「0 条」** —— 那是与「读不到」同款的谎(见
   * `useAgentConversations` 的注释):`loading && lines.length === 0` 是
   * 「还没拿到过任何一份数据」,而 `共 0 条` 是「他真的一句话都没说过」。
   */
  const known = error === null && !(loading && lines.length === 0);

  return (
    <div className="flex flex-col gap-2">
      {/* ── 进行中:WS 在飞轮 ─────────────────────────────────────── */}
      <div className="flex flex-col gap-1">
        <div className="ss-section" style={{ fontSize: 12 }}>
          正在说什么
          <span className="ss-meta" style={{ marginLeft: 6 }}>
            {live.length === 0 ? "此刻没有正在流的回复" : `${live.length} 轮正在流`}
          </span>
        </div>
        {live.length === 0 ? (
          <div
            className="ss-note"
            title="这里空着多半是实时连接断了 · 已完成的不受影响"
          >
            进行中的内容只在它正在跑的时候看得见(它在实时流里,回合结束后才落库)。
          </div>
        ) : (
          live.map((t) => <LiveTurn key={t.id} turn={t} lines={lines} />)
        )}
      </div>

      {/* ── 已说完的:库里那个回合的正文 ─────────────────────────── */}
      <div className="flex flex-col gap-1">
        <div className="ss-section" style={{ fontSize: 12 }}>
          已说完的
          <span className="ss-meta" style={{ marginLeft: 6 }}>
            {error !== null ? "读不到" : known ? `共 ${total} 条` : "正在读取…"}
          </span>
        </div>

        {error !== null ? (
          <div className="ss-note" style={{ color: "var(--cinnabar)" }}>
            {`对话内容读不到:${error} —— 这一次请求失败了,所以下面不是「他一句话都没说过」。`}
          </div>
        ) : !known ? (
          <div className="ss-note">正在读取对话内容…</div>
        ) : lines.length === 0 ? (
          <div className="ss-note">
            {`${agentName}在这个项目里还没有留下任何发言记录。`}
          </div>
        ) : (
          <details className="ss-disclosure">
            {/* ⚠️ **默认收起**(与这一屏原来的那块一致):成员面板一屏只显示一个
                成员,里面还有「正在做什么」「工件」两块 —— 把几百条消息铺开会把
                结构淹掉(这一屏 2026-10-06 重排的就是这个)。**条数永远可见**
                (上面那行),内容点开就看。 */}
            <summary>{`展开看已说完的 · ${total} 条`}</summary>
            <div style={{ paddingTop: 6 }}>
              {/* 线头:哪条对话线 */}
              <div className="flex flex-wrap items-center gap-1.5">
                {lines.map((l) => {
                  const on = l.sessionId === selectedSessionId;
                  return (
                    <button
                      key={l.sessionId}
                      type="button"
                      className="sansheng-card"
                      onClick={() => onSelectSession(l.sessionId)}
                      style={{
                        padding: "2px 8px",
                        fontSize: 12,
                        cursor: "pointer",
                        borderColor: on ? "var(--jade)" : "var(--ink-3)",
                      }}
                      title={`${lineSubtitle(l)} · 最后一条 ${fmtTime(l.lastMessageAt)}`}
                    >
                      <span style={{ color: on ? "var(--bone)" : "var(--bone-dim)" }}>
                        {lineLabel(l)}
                      </span>
                      <span className="ss-meta" style={{ marginLeft: 6 }}>
                        {l.messageCount} 条
                      </span>
                    </button>
                  );
                })}
              </div>

              {selected !== null && (
                <div className="ss-meta">
                  {`${lineSubtitle(selected)} · 最后一条 ${fmtTime(selected.lastMessageAt)}`}
                </div>
              )}

              {/* 正文:旧 → 新,全文不截断。
                  ⚠️ **限高 + 滚动**(不是折叠):用户要看的是「具体内容」——
                      折叠起来等于要他多点一次才能看见;限高则内容就在眼前,
                      而面板不会被几百条消息撑爆。 */}
              <div
                className="flex flex-col gap-2"
                style={{ maxHeight: 420, overflowY: "auto", paddingRight: 4 }}
              >
                {messages.map((m) => (
                  <article
                    key={m.id}
                    className="sansheng-card p-2.5"
                    style={{ borderColor: "var(--ink-3)" }}
                  >
                    <div className="flex items-baseline gap-2 flex-wrap" style={{ fontSize: 12 }}>
                      <span className="ss-meta font-mono">{fmtTime(m.createdAt)}</span>
                      <Pill tone={m.agentId === null ? "mute" : "jade"}>
                        {m.agentId === null ? MESSAGE_KIND_LABEL.user : MESSAGE_KIND_LABEL.assistant}
                      </Pill>
                      {m.agentId === null && (
                        <span className="ss-meta">甲方在这条线上的话(他说这些话的上下文)</span>
                      )}
                    </div>
                    <div style={{ marginTop: 4 }}>
                      <Markdown text={m.content} />
                    </div>
                  </article>
                ))}
              </div>

              {truncated && (
                <div className="ss-note">
                  只显示最近 {messages.length} 条(这条线上还有更早的;`?limit=` 可调,上限 500)
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

/** 一个正在流的轮:正文(还在长)、思考(折叠)、工具(名字)。 */
function LiveTurn({ turn, lines }: { turn: Turn; lines: readonly AgentConversationLineView[] }) {
  const { text, thinking, tools } = liveTurnParts(turn);
  const line = lines.find((l) => l.sessionId === turn.sessionId) ?? null;
  return (
    <article className="sansheng-card p-2.5" style={{ borderColor: "var(--jade)" }}>
      <div className="flex items-baseline gap-2 flex-wrap" style={{ fontSize: 12 }}>
        <Pill tone="jade">正在说</Pill>
        <span className="ss-meta font-mono">{fmtTime(turn.startedAt)}</span>
        <span className="ss-meta">
          {line !== null
            ? `在「${lineLabel(line)}」那条线上`
            : "这一轮还没落库(回合结束后会出现在下面「已说完的」里)"}
        </span>
      </div>
      {text.trim() === "" ? (
        <div className="ss-note">还没吐出正文(可能正在调工具)。</div>
      ) : (
        <div style={{ marginTop: 4 }}>
          <Markdown text={text} streaming />
        </div>
      )}
      {thinking.trim() !== "" && (
        <details className="ss-disclosure" style={{ marginTop: 4 }}>
          <summary>思考过程({thinking.length} 字)</summary>
          <div className="ss-note" style={{ paddingTop: 6, whiteSpace: "pre-wrap" }}>
            {thinking}
          </div>
        </details>
      )}
      {tools.length > 0 && (
        <div className="ss-meta" style={{ marginTop: 4 }}>
          {`工具:${tools.join(" · ")}`}
        </div>
      )}
    </article>
  );
}
