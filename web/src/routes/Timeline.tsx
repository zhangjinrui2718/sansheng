/**
 * Sansheng · 总线页(原「Agents Live Trace」)—— 产品设计 §5「总线:它是什么、该显示什么」
 * 实施批次 P0 #5(docs/PRODUCT-DESIGN-2026-10-02.md:239-266)。
 *
 * **零后端改动**:数据全部来自 zustand(chat store 的 busStream / pendingQuestions),
 * 不动 WS 事件、不动 bus.jsonl、不加端点 —— 只是把**已有的** BusMessage 重新组织成
 * 能读的结构(§7 P0「全部是已有数据的重新组织」)。
 *
 * ── ① 线程化,取代行平铺 ──────────────────────────────────────────────
 * `question` 与它的 `reply` 共用 questionId,且 **questionId === 那条 question 的 id**,
 * 两条生产路径都如此,这是线程化的唯一依据:
 *   - `MessageBus.ask`:`{ id: questionId, ... }`(messageBus.ts:68-73);
 *   - executor 合成提问:`id = q-exec-${nanoid(8)}`,发往用户时 pending_question 事件
 *     带的 questionId 就是这条消息的 id(agentKernel.ts:627 / communicator.ts:805)。
 * 于是:线程键 = question 自身的 `questionId ?? id`;reply 归到它的 `questionId`。
 * 没有 questionId 的 broadcast、以及找不到对应 question 的孤立 reply,各自独立成条 ——
 * 不硬凑线程,也不假装它属于谁(卡片上如实标「原提问不在流内」)。
 * **线程的通道归属由锚点(首条消息)决定**:worker 提问 + 它的回复整体算「升级求助」道,
 * 回复自己那条 comm→worker 的方向仍在行内照常显示。
 *
 * ── ② 按方向分道 ────────────────────────────────────────────────────
 * worker→comm=升级求助 / comm→worker=委派 / user↔comm=对话,三条道各带标题与计数,
 * 按「升级求助 → 委派 → 对话」固定顺序堆叠。**道内按时间升序**;跨道不再全局混排 ——
 * 三条道本就是三条不同语义的通道,混在一条时间轴里只会被时间戳淹没(旧实现的问题)。
 *
 * ── ③ 计数口径(页面上每个 N 都写明数的是什么) ──────────────────────
 *   - 状态条右侧「N 条消息 · M 个线程」:N = 当前过滤后**原始 BusMessage 条数**
 *     (与旧版「N 条 bus 消息」同口径,未变),M = **线程数**,即下方实际渲染的卡片数。
 *   - 每条通道标题的「N 个线程」= 该道内的卡片数。
 * 页面上不存在第三个口径,任何数字都和它标注的东西一一对应。
 *
 * ── ④ 刻意不显示的东西(反造假) ──────────────────────────────────────
 *   - **不显示「等了多久」**:`PendingQuestion.ts` 是**客户端收到 ws 事件那一刻**打的戳
 *     (chat.ts:521 `ts: Date.now()`),不是 worker 提问的时刻;刷新即丢(pending 不随
 *     bus_replay 恢复 —— MessageBus.restore 明确 clear pending)。拿它算「阻塞时长」
 *     等于把客户端收包时间冒充 worker 的等待时间。如实不显示。
 *   - 线程状态三态全部由真实字段推出:pendingQuestions 命中 questionId → 等待回答;
 *     线程内有 reply → 已回复;两者皆无 → 未收到回复(不猜它是在等还是在超时)。
 *
 * ── ⑤ 重渲染优化(批次 3 F5 / B10-4,**不许退化成每条都重渲**) ─────────
 *   - now 仍是 30s 桶(BUS_ROW_NOW_BUCKET_MS):相对时间标签每 30s 刷一次,两桶之间
 *     不产生任何行的重渲染。
 *   - 两层 memo,共用同一套「引用 + 桶」比较语义:
 *       `BusRow`   行级 —— 比较器是 lib/busRow.ts 的 busRowPropsEqual(有单测,**未改动**);
 *       `BusThread`线程卡级 —— busThreadPropsEqual 用同样的两条规则(引用相同 + now 同桶)。
 *     线程卡级这层是线程化后新加的:用户在「回答」输入框里打字只改 answerDraft,
 *     线程对象引用不变、now 也没跨桶 → 整卡跳过,连行都不进。
 *   - 成立前提:buildThreads 的结果**引用稳定** —— 它挂在 [filtered, pendingIds] 上,
 *     两者都是 useMemo 的稳定引用,内容不变时 threads 数组与其中每个 thread 对象
 *     都保持同一引用,memo 才真的生效(否则每次重渲都是新对象,memo 形同虚设)。
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

// ── 通道(分道)定义:三类语义完全不同的总线用途 ──────────────────────────

type LaneKey = "escalation" | "delegation" | "dialogue";

const LANE_LABEL: Record<LaneKey, string> = {
  escalation: "升级求助",
  delegation: "委派",
  dialogue: "对话",
};

const LANE_TONE: Record<LaneKey, string> = {
  escalation: "var(--amber)",
  delegation: "var(--cyan, #4cc9c0)",
  dialogue: "var(--jade)",
};

/** 一行说明这条道是干什么的 —— 不解释总线为什么不承载其它往来(见 §5 ⑤ 范围说明行)。 */
const LANE_HINT: Record<LaneKey, string> = {
  escalation: "worker → 沟通员:卡住了,要一个决定",
  delegation: "沟通员 → worker:派活 / 回话",
  dialogue: "沟通员 ↔ 用户:原话与应答",
};

/** 展示顺序:要人拍板的排最前,对话条数最多、最不需要优先看,排最后。 */
const LANE_ORDER: readonly LaneKey[] = ["escalation", "delegation", "dialogue"];

const LANE_OF: Record<BusDirection, LaneKey> = {
  "worker→comm": "escalation",
  "comm→worker": "delegation",
  "user→comm": "dialogue",
  "comm→user": "dialogue",
};

function fmtRel(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 1000) return "刚刚";
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  return new Date(ts).toLocaleTimeString();
}

/** context 最多摊几条 —— 只摊**原始类型**的值,对象/数组不 JSON 化(避免页面上糊一大坨)。 */
const CONTEXT_MAX = 4;

/** 类型收窄:context 的值是 `unknown`,只把原始类型摊成 key=value(不写类型断言)。 */
function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function contextChips(ctx: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!ctx) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (out.length >= CONTEXT_MAX) break;
    if (isPrimitive(v)) out.push([k, String(v)]);
  }
  return out;
}

// ── 线程化 ────────────────────────────────────────────────────────────

/** 线程状态:全部由真实字段推出(见文件头 ④)。 */
type ThreadState = "oneway" | "awaiting" | "answered" | "silent" | "orphan";

interface BusThread {
  /** 线程键:question 的 questionId ?? id;broadcast 用自身 id。 */
  key: string;
  /** 首条消息(定通道 + 定排序);`messages[0]` 恒等于它。 */
  anchor: BusMessage;
  /** 锚点 + 后续 reply,按 ts 升序。 */
  messages: BusMessage[];
  lane: LaneKey;
  state: ThreadState;
}

/**
 * 把扁平流折成线程(纯函数,无副作用,便于心算与将来单测)。
 * pendingIds 来自 store 的 pendingQuestions —— 线程是否「等待回答」只由它决定。
 */
function buildThreads(messages: BusMessage[], pendingIds: ReadonlySet<string>): BusThread[] {
  const byKey = new Map<string, BusMessage[]>();
  const order: string[] = [];

  const push = (key: string, msg: BusMessage): void => {
    const list = byKey.get(key);
    if (list) {
      list.push(msg);
      return;
    }
    byKey.set(key, [msg]);
    order.push(key);
  };

  for (const m of messages) {
    if (m.kind === "reply" && m.questionId) push(m.questionId, m);
    else if (m.kind === "question") push(m.questionId ?? m.id, m);
    else push(m.id, m);
  }

  const threads: BusThread[] = [];
  for (const key of order) {
    const msgs = byKey.get(key);
    if (!msgs || msgs.length === 0) continue;
    const sorted = msgs.slice().sort((a, b) => a.ts - b.ts);
    const anchor = sorted[0];
    if (!anchor) continue;
    const replied = sorted.some((m) => m.kind === "reply");
    let state: ThreadState;
    if (anchor.kind === "broadcast") state = "oneway";
    else if (pendingIds.has(key)) state = "awaiting";
    else if (replied) state = "answered";
    else if (anchor.kind === "reply") state = "orphan";
    else state = "silent";
    threads.push({ key, anchor, messages: sorted, lane: LANE_OF[anchor.direction], state });
  }
  // 道内按时间升序(bus.jsonl 回放不保证入流顺序,旧实现也是显式 sort)。
  threads.sort((a, b) => a.anchor.ts - b.anchor.ts);
  return threads;
}

const THREAD_STATE: Record<ThreadState, { label: string; tone: string }> = {
  oneway: { label: "单向 · 无需回复", tone: "var(--jade)" },
  awaiting: { label: "等待回答", tone: "var(--amber)" },
  answered: { label: "已回复", tone: "var(--bamboo)" },
  silent: { label: "未收到回复", tone: "var(--bone-mute)" },
  orphan: { label: "回复 · 原提问不在流内", tone: "var(--bone-dim)" },
};

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

  // 当前会话的流(其它会话不显示)
  const filtered = useMemo(
    () =>
      conversationId
        ? busStream.filter((m) => m.conversationId === conversationId)
        : busStream,
    [busStream, conversationId],
  );

  // 线程化:依赖引用稳定的 filtered / pendingIds,内容不变时 thread 对象逐个保持同引用,
  // 下面的 BusThread memo 才生效(见文件头 ⑤)。
  const pendingIds = useMemo(
    () => new Set(pendingQuestions.map((q) => q.questionId)),
    [pendingQuestions],
  );
  const threads = useMemo(() => buildThreads(filtered, pendingIds), [filtered, pendingIds]);

  // 分道:三条道各自的线程(道内已按时间升序)。
  const lanes = useMemo(() => {
    const map = new Map<LaneKey, BusThread[]>(LANE_ORDER.map((k) => [k, [] as BusThread[]]));
    for (const t of threads) map.get(t.lane)?.push(t);
    return map;
  }, [threads]);

  // stick-to-bottom 自动滚动(依赖线程而非原始流:内容变了才滚)
  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threads, stickToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setStickToBottom(atBottom);
  };

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
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="sansheng-h2">总线 Bus</h2>
        <div className="text-xs sansheng-text-mute font-mono">
          {conversationId ?? "全局流(当前会话未加载)"}
        </div>
      </div>

      {/* §5 ⑤ 范围说明:一句话讲清总线承载什么、不承载什么 —— 不写这句,
          用户会一直找「为什么看不到 planner 和 executor 的对话」。 */}
      <div className="text-xs sansheng-text-mute mb-3">
        总线只承载升级 / 求助;planner 与 executor 之间的大部分协作通过工件完成,不经过总线。
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
            {filtered.length} 条消息 · {threads.length} 个线程
          </div>
        </div>
      </section>

      {/* pending question 升级提示 —— 回答 / 取消的真交互,保留原样。
          线程卡只显示「等待回答」状态,不在卡里再放一份输入框(同一个 questionId
          的两个输入框会互相打架);回答入口唯一,就在这里。 */}
      {pendingQuestions.length > 0 && (
        <section className="sansheng-card p-3 mb-3" style={{ borderColor: "var(--amber)" }}>
          <div className="text-sm mb-2 flex items-center gap-2">
            <span
              className="inline-block"
              style={{ width: 8, height: 8, background: LANE_TONE.escalation }}
            />
            <span>Worker 升级了 {pendingQuestions.length} 个问题给你</span>
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

      {/* Bus 线程流(按通道分道) */}
      <section className="sansheng-card p-3">
        <div className="flex items-baseline justify-between mb-2">
          <div className="text-sm sansheng-text-mute">总线线程</div>
          <div className="text-xs sansheng-text-mute font-mono">
            {threads.length} 个线程 / {filtered.length} 条消息
          </div>
        </div>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            maxHeight: "60vh",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {threads.length === 0 ? (
            <div className="text-xs sansheng-text-mute text-center py-8">
              还没有 bus 消息。发一条试试看,Communicator 会自动分流。
            </div>
          ) : (
            LANE_ORDER.map((lane) => {
              const list = lanes.get(lane) ?? [];
              if (list.length === 0) return null;
              return (
                <section key={lane} className="flex flex-col gap-2">
                  <div className="flex items-baseline gap-2">
                    <span
                      className="inline-block"
                      style={{ width: 8, height: 8, background: LANE_TONE[lane] }}
                    />
                    <span className="text-xs" style={{ color: LANE_TONE[lane] }}>
                      {LANE_LABEL[lane]}
                    </span>
                    <span className="text-xs sansheng-text-mute">{LANE_HINT[lane]}</span>
                    <span className="ml-auto text-xs sansheng-text-mute font-mono">
                      {list.length} 个线程
                    </span>
                  </div>
                  {list.map((t) => (
                    <BusThreadRow key={t.key} thread={t} now={now} />
                  ))}
                </section>
              );
            })
          )}
        </div>
        {/* 滚动高度由消息量决定(线程卡更高,条目数不再是好的判据),阈值沿用旧版的 20 条。 */}
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

// ── 线程卡(第二层 memo)────────────────────────────────────────────────

function BusThreadImpl({ thread, now }: { thread: BusThread; now: number }) {
  const state = THREAD_STATE[thread.state];
  const replies = thread.messages.slice(1);

  return (
    <article
      className="rounded p-2 flex flex-col gap-1"
      style={{ background: "var(--ink-2)", border: "1px solid var(--ink-3)" }}
    >
      {/* 线程头:哪条通道 + 现在什么状态 + 收了几条回复 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs" style={{ color: LANE_TONE[thread.lane] }}>
          {LANE_LABEL[thread.lane]}
        </span>
        <span
          className="font-mono text-xs px-1 rounded"
          style={{ background: state.tone, color: "var(--ink-0)" }}
        >
          {state.label}
        </span>
        {/* 只有「一问一答」型线程才谈得上回复条数;broadcast / 孤立 reply 不凑数。 */}
        {thread.anchor.kind !== "broadcast" && thread.state !== "orphan" && (
          <span className="text-xs sansheng-text-mute">{replies.length} 条回复</span>
        )}
        <span className="ml-auto text-xs sansheng-text-mute font-mono">
          发起于 {fmtRel(thread.anchor.ts, now)}
        </span>
      </div>
      <BusRow msg={thread.anchor} now={now} />
      {replies.map((r) => (
        <div key={r.id} className="ml-3">
          <BusRow msg={r} now={now} />
        </div>
      ))}
    </article>
  );
}

/**
 * 线程卡级比较器:与 lib/busRow.ts 的 busRowPropsEqual 同一套语义
 * (引用相同 + now 落在同一 30s 桶 = 跳过重渲),只是比较对象从「单条消息」换成
 * 「整条线程」。它让「回答」输入框里的每次击键(只改 answerDraft)不必重渲整卡。
 * 放在本文件而非 lib/:线程化是本页内部结构,不值得再开一个共享模块。
 */
function busThreadPropsEqual(
  prev: { thread: BusThread; now: number },
  next: { thread: BusThread; now: number },
): boolean {
  return prev.thread === next.thread && nowBucket(prev.now) === nowBucket(next.now);
}

export const BusThreadRow = memo(BusThreadImpl, busThreadPropsEqual);

// ── 单行(第一层 memo,沿用批次 3 F5 / B10-4)─────────────────────────

function BusRowImpl({ msg, now }: { msg: BusMessage; now: number }) {
  const dir = msg.direction;
  const icon = DIR_ICON[dir] ?? "?";
  const dirLabel = DIR_LABEL[dir] ?? dir;
  const badge = KIND_BADGE[msg.kind];
  const isQuestion = msg.kind === "question";
  const ctx = contextChips(msg.context);

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
      {/* context 里的原始类型字段(todoId / hypothesisId / source …)—— 只摊真实值。 */}
      {ctx.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-1">
          {ctx.map(([k, v]) => (
            <span
              key={k}
              className="font-mono text-xs sansheng-text-mute"
              style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {k}={v}
            </span>
          ))}
        </div>
      )}
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
 *
 * 线程化之后它降为第二层:线程卡(BusThreadRow)整体已经能跳过,行级 memo 现在
 * 负责的是「卡内只有一条 reply 变了」这类局部更新,以及 30s 桶刷新时的逐行判断。
 */
export const BusRow = memo(BusRowImpl, busRowPropsEqual);
