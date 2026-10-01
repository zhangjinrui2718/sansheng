/**
 * Sansheng · Live Trace 页面 (M3c)
 *
 * 实时显示 MessageBus 上的所有 BusMessage,stick-to-bottom,不允许用户评论某一行
 * (想发消息请回 Chat 输入框)。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "@/stores/chat";
import { BUS_ROW_NOW_BUCKET_MS, busRowPropsEqual, nowBucket } from "@/lib/busRow";
import type { BusDirection, BusMessage, BusKind } from "@shared/types/agents";

const DIR_ICON: Record<BusDirection, string> = {
  "user→comm": "↗",
  "comm→user": "↙",
  "comm→worker": "→",
  "worker→comm": "←",
};

const DIR_LABEL: Record<BusDirection, string> = {
  "user→comm": "用户 → 沟通员",
  "comm→user": "沟通员 → 用户",
  "comm→worker": "沟通员 → worker",
  "worker→comm": "worker → 沟通员",
};

const KIND_BADGE: Record<BusKind, { label: string; tone: string }> = {
  question: { label: "提问", tone: "var(--amber)" },
  broadcast: { label: "广播", tone: "var(--jade)" },
  reply: { label: "回复", tone: "var(--cyan, #4cc9c0)" },
};

function fmtRel(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 1000) return "刚刚";
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  return new Date(ts).toLocaleTimeString();
}

interface Props {
  conversationId: string | null;
}

export function TimelinePage({ conversationId }: Props) {
  const busStream = useChatStore((s) => s.busStream);
  const communicatorStatus = useChatStore((s) => s.communicatorStatus);
  const pendingQuestions = useChatStore((s) => s.pendingQuestions);
  const sendAnswerQuestion = useChatStore((s) => s.sendAnswerQuestion);
  const sendCancelQuestion = useChatStore((s) => s.sendCancelQuestion);
  const answerDraft = useChatStore((s) => s.answerDraft);
  const setAnswerDraft = useChatStore((s) => s.setAnswerDraft);
  // B10-4(F5):now 用 30s 桶值 + 30s tick —— 与 busRowPropsEqual 的桶粒度一致,
  // 相对时间标签每 30s 刷一次(旧实现 5s tick 但比较器丢弃 now,标签实际冻结)。
  const [now, setNow] = useState(() => nowBucket(Date.now()));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // 时间相对显示
  useEffect(() => {
    const id = setInterval(() => setNow(nowBucket(Date.now())), BUS_ROW_NOW_BUCKET_MS);
    return () => clearInterval(id);
  }, []);

  // stick-to-bottom 自动滚动
  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [busStream, stickToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setStickToBottom(atBottom);
  };

  // 当前会话的流(其它会话不显示)
  const filtered = useMemo(
    () =>
      conversationId
        ? busStream.filter((m) => m.conversationId === conversationId)
        : busStream,
    [busStream, conversationId],
  );

  const commMessages = filtered.filter((m) => m.fromRole === "communicator");
  const workerMessages = filtered.filter((m) => m.fromRole !== "communicator" && m.fromRole !== "user");

  const status = communicatorStatus; // "idle" | "thinking" | "tool_use"
  const statusColor = {
    idle: "var(--jade)",
    thinking: "var(--amber)",
    tool_use: "var(--cyan, #4cc9c0)",
  }[status];

  const onSubmitAnswer = (questionId: string) => {
    const text = answerDraft.get(questionId) ?? "";
    if (!text.trim()) return;
    sendAnswerQuestion(questionId, text.trim());
    setAnswerDraft(questionId, "");
  };

  return (
    <main className="px-4 pb-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="sansheng-h2">Agents Live Trace</h2>
        <div className="text-xs sansheng-text-mute font-mono">
          {filtered.length} 条 bus 消息
          {!conversationId && " · 当前会话未加载,显示全局流"}
        </div>
      </div>

      {/* Communicator 状态条 */}
      <section
        className="sansheng-card p-3 mb-3"
        style={{ borderColor: statusColor, borderWidth: 1 }}
      >
        <div className="flex items-center gap-3">
          <span
            className="inline-block rounded-full"
            style={{
              width: 10,
              height: 10,
              background: statusColor,
              boxShadow: `0 0 8px ${statusColor}`,
            }}
          />
          <div className="flex-1">
            <div className="text-sm">沟通员(Communicator)</div>
            <div className="text-xs sansheng-text-mute">
              {status === "idle" && "待命 · 用户消息先过我,我决定 chat / task / feedback"}
              {status === "thinking" && "思考中 · 正在判断这条消息怎么走"}
              {status === "tool_use" && "调用工具 · 自己查代码 / 读工具"}
            </div>
          </div>
          <div className="text-xs font-mono sansheng-text-mute">
            comm→user {commMessages.filter((m) => m.toRole === "user").length} ·{" "}
            comm→worker {commMessages.filter((m) => m.toRole !== "user").length}
          </div>
        </div>
      </section>

      {/* pending question 升级提示 */}
      {pendingQuestions.length > 0 && (
        <section className="sansheng-card p-3 mb-3" style={{ borderColor: "var(--amber)" }}>
          <div className="text-sm mb-2">
            <span className="font-mono mr-2">↗</span>
            Worker 升级了 {pendingQuestions.length} 个问题给你
          </div>
          <div className="flex flex-col gap-2">
            {pendingQuestions.map((q) => (
              <div
                key={q.questionId}
                className="rounded p-2 text-xs"
                style={{ background: "var(--ink-1)" }}
              >
                <div className="mb-1">
                  <span className="font-mono mr-1">[{q.fromRole}]</span>
                  <span className="sansheng-text-mute">questionId={q.questionId.slice(0, 8)}</span>
                </div>
                <div className="mb-2 whitespace-pre-wrap">{q.payload}</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="回答 worker..."
                    value={answerDraft.get(q.questionId) ?? ""}
                    onChange={(e) => setAnswerDraft(q.questionId, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onSubmitAnswer(q.questionId);
                    }}
                    className="sansheng-input flex-1"
                    style={{ fontSize: 12 }}
                  />
                  <button
                    onClick={() => onSubmitAnswer(q.questionId)}
                    className="sansheng-button-primary"
                    style={{ padding: "4px 10px", fontSize: 12 }}
                  >
                    回答
                  </button>
                  <button
                    onClick={() => sendCancelQuestion(q.questionId)}
                    className="sansheng-button"
                    style={{ padding: "4px 10px", fontSize: 12 }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Bus stream */}
      <section className="sansheng-card p-3">
        <div className="text-sm mb-2 sansheng-text-mute">Bus Stream</div>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            maxHeight: "60vh",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {filtered.length === 0 ? (
            <div className="text-xs sansheng-text-mute text-center py-8">
              还没有 bus 消息。发一条试试看,Communicator 会自动分流。
            </div>
          ) : (
            filtered
              .slice()
              .sort((a, b) => a.ts - b.ts)
              .map((m) => <BusRow key={m.id} msg={m} now={now} />)
          )}
        </div>
        {filtered.length > 20 && (
          <div className="text-xs sansheng-text-mute mt-2 text-center">
            {stickToBottom ? (
              <span>已自动跟随最新事件 ↓</span>
            ) : (
              <button
                className="sansheng-button"
                style={{ padding: "2px 8px" }}
                onClick={() => {
                  setStickToBottom(true);
                  const el = scrollRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
                }}
              >
                ↓ 跳到最新
              </button>
            )}
          </div>
        )}
      </section>

      {workerMessages.length > 0 && (
        <section className="sansheng-card p-3 mt-3 text-xs sansheng-text-mute">
          <div className="font-mono mb-1">Worker 角色概览</div>
          <div className="flex flex-wrap gap-2">
            {Array.from(new Set(workerMessages.map((m) => String(m.fromRole)))).map((r) => (
              <span key={r} className="font-mono">{r}</span>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function BusRowImpl({ msg, now }: { msg: BusMessage; now: number }) {
  const dir = msg.direction;
  const icon = DIR_ICON[dir] ?? "?";
  const dirLabel = DIR_LABEL[dir] ?? dir;
  const badge = KIND_BADGE[msg.kind];
  const isQuestion = msg.kind === "question";

  return (
    <div
      className="rounded p-2"
      style={{
        background: "var(--ink-1)",
        borderLeft: `3px solid ${badge?.tone ?? "var(--bone-dim)"}`,
        fontSize: 12,
        opacity: msg.kind === "reply" ? 0.85 : 1,
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono" style={{ color: badge?.tone }}>
          {icon}
        </span>
        <span className="font-mono text-xs sansheng-text-mute">
          {dirLabel}
        </span>
        <span
          className="font-mono text-xs px-1 rounded"
          style={{ background: badge?.tone, color: "var(--ink-0)" }}
        >
          {badge?.label ?? msg.kind}
        </span>
        <span className="font-mono text-xs sansheng-text-mute">
          {String(msg.fromRole)} → {String(msg.toRole)}
        </span>
        <span className="ml-auto text-xs sansheng-text-mute">{fmtRel(msg.ts, now)}</span>
      </div>
      <div
        className="whitespace-pre-wrap break-words"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {msg.payload}
      </div>
      {isQuestion && msg.questionId && (
        <div className="text-xs sansheng-text-mute mt-1 font-mono">
          questionId={msg.questionId.slice(0, 12)}
        </div>
      )}
    </div>
  );
}

/**
 * B7 + B10-4(F5):React.memo 包裹,避免无关状态变化触发所有 bus row 重渲染。
 * 比较器(lib/busRow.ts 纯函数,可单测):msg 引用相同 **且** now 落在同一 30s
 * 桶 → 跳过重渲;msg 变更或 now 跨桶 → 重渲。
 *
 * 勘误(旧注释是对 memo 语义的误解):自定义比较器返回 true 时 React **一定**
 * 跳过重渲,不存在「React.memo 也会放行变更」的兜底 —— 旧比较器
 * `prev.msg === next.msg` 丢弃 now prop,导致相对时间标签永久冻结(B10-4)。
 */
export const BusRow = memo(BusRowImpl, busRowPropsEqual);