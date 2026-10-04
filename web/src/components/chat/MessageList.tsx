/**
 * 对话消息流(项目的一条连续对话)
 *
 * 旧版这里还有两种块:`plan`(计划卡)与 `delivery`(交付物卡)。计划概念在新
 * 架构里已删除(换成 works / 工件),`DeliveryBlock` 只服务旧的 `plan_done`,
 * 两者随契约一起删掉了 —— 现在只剩思考 / 正文 / 工具三类。
 *
 * ── 本批次两件事 ────────────────────────────────────────────────
 *
 * 1. **正文按 markdown 渲染**(此前是裸 `{text}`,业务经理的 `**加粗**` / 表格 /
 *    代码块在屏幕上是字面量)。解析在 `@/lib/markdown`,安全边界也在那里。
 *    用户自己键入的那条**仍按字面渲染** —— 把人打的字重新排版成标题/表格,
 *    是替他改写输入,不是他要的。
 *
 * 2. **滚动语义手写**(不用 react-virtuoso:实测 +193.3 kB raw / +61.3 kB gzip,
 *    换来的虚拟化在 14 条消息的会话里是过早优化)。三条行为与判据在
 *    `@/lib/scroll`,这里只做 DOM 侧的接线:
 *      · 贴底 → 新内容跟随(节流 80ms,避免流式高频更新把主线程压住)
 *      · 用户上滚 → 关闭跟随 + 显示「回到底部」;自己滚回底部 → 恢复跟随
 *      · 滚到顶加载历史 → **未做**(后端无分页/游标,见 lib/scroll.ts 文件头)
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore, type Turn } from "@/stores/chat";
import {
  INITIAL_FOLLOW,
  observeFollow,
  scrollBehaviorFor,
  shouldShowJumpButton,
  throttleDelay,
  type FollowObservation,
  type FollowState,
  type ScrollMetrics,
} from "@/lib/scroll";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

function metricsOf(el: HTMLElement): ScrollMetrics {
  return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
}

/** 流式正文的「内容变了」信号:块数 + 各块文本长度(工具块算 1)。 */
function contentSignalOf(turns: Turn[], current: Turn | null): string {
  const blocks = current?.blocks ?? [];
  let textLength = 0;
  for (const b of blocks) textLength += b.kind === "tool" ? 1 : b.text.length;
  return `${turns.length}:${blocks.length}:${textLength}`;
}

export function MessageList() {
  const turns = useChatStore((s) => s.turns);
  const current = useChatStore((s) => s.currentTurn);
  const error = useChatStore((s) => s.error);
  const status = useChatStore((s) => s.status);
  // 切换上下文(项目 / 接待会话)= 换了一整条对话:跟随状态归零并直接跳到底。
  const projectId = useChatStore((s) => s.projectId);
  const intakeActive = useChatStore((s) => s.intakeActive);

  const ref = useRef<HTMLDivElement>(null);
  /** 跟随状态用 ref 持有 —— onScroll 每帧都在读它,不该为它触发一次渲染。 */
  const followRef = useRef<FollowState>(INITIAL_FOLLOW);
  const lastScrollAtRef = useRef(0);
  const pendingScrollRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);

  /** 把一次观察喂给纯函数状态机,并只把「要不要显示按钮」这一位同步到渲染。 */
  const apply = useCallback((o: FollowObservation) => {
    const next = observeFollow(followRef.current, o);
    followRef.current = next;
    setShowJump(shouldShowJumpButton(next));
  }, []);

  /** 真正的程序滚动(唯一一处调用 `scrollTo`)—— 记时间戳 + 同步 lastTop。 */
  const doScroll = useCallback((behavior: ScrollBehavior) => {
    const el = ref.current;
    if (!el) return;
    lastScrollAtRef.current = Date.now();
    el.scrollTo({ top: el.scrollHeight, behavior });
    followRef.current = { ...followRef.current, lastTop: el.scrollTop };
  }, []);

  /**
   * 节流后的程序滚动:距上次不足 80ms 就排一个**尾随**定时器(已有则不再排),
   * 这样流式高频更新下不会每帧都滚,但停下来时一定会滚到最新位置。
   */
  const scheduleScroll = useCallback(
    (behavior: ScrollBehavior) => {
      const delay = throttleDelay(lastScrollAtRef.current, Date.now());
      if (delay === 0) {
        doScroll(behavior);
        return;
      }
      if (pendingScrollRef.current !== null) return;
      pendingScrollRef.current = window.setTimeout(() => {
        pendingScrollRef.current = null;
        doScroll(behavior);
      }, delay);
    },
    [doScroll],
  );

  useEffect(
    () => () => {
      if (pendingScrollRef.current !== null) window.clearTimeout(pendingScrollRef.current);
    },
    [],
  );

  // ① 内容变化(新消息 / 流式 delta)→ 贴底才跟随。
  //    依赖用长度信号而不是 `turns` 引用:delta 只改最后一个块的**文本**,
  //    旧版只依赖 `blocks.length`,于是流式打字期间根本没跟随。
  const contentSignal = useMemo(() => contentSignalOf(turns, current), [turns, current]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    apply({ kind: "content", metrics: metricsOf(el) });
    if (!followRef.current.following) return;
    scheduleScroll(scrollBehaviorFor("content"));
  }, [contentSignal, apply, scheduleScroll]);

  // ② 换项目 / 进接待会话 → 归零并跳到底(不继承上一条对话的滚动位置)。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    apply({ kind: "reset", metrics: metricsOf(el) });
    doScroll(scrollBehaviorFor("reset"));
  }, [projectId, intakeActive, apply, doScroll]);

  /** 用户滚回底部 → 恢复跟随;上滚 → 关闭跟随(见 lib/scroll.ts 的方向判据)。 */
  function handleScroll() {
    const el = ref.current;
    if (!el) return;
    apply({ kind: "scroll", metrics: metricsOf(el) });
  }

  function jumpToBottom() {
    apply({ kind: "pin-bottom" });
    lastScrollAtRef.current = 0; // 用户主动动作不受节流限制
    scheduleScroll(scrollBehaviorFor("pin-bottom"));
  }

  if (turns.length === 0 && !current) return <Empty />;

  return (
    <div className="flex-1 relative flex flex-col" style={{ minHeight: 0 }}>
      <div
        ref={ref}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 py-5"
        style={{ minHeight: 0 }}
      >
        <div className="max-w-3xl mx-auto flex flex-col gap-6">
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} />
          ))}
          {current && <TurnView turn={current} streaming />}
          {error && status === "error" && (
            <div
              className="rounded-md px-3 py-2"
              style={{
                background: "rgba(229, 72, 77, 0.1)",
                border: "1px solid rgba(229, 72, 77, 0.4)",
                color: "var(--cinnabar)",
                fontSize: 12,
              }}
            >
              <div className="font-mono">{error.code}</div>
              <div className="mt-1">{error.message}</div>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          className="sansheng-button absolute"
          style={{
            bottom: 12,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--ink-2)",
            boxShadow: "var(--shadow-ink)",
          }}
          onClick={jumpToBottom}
          title="有更新的内容(用户上滚后不自动跟随)"
        >
          ↓ 回到底部
        </button>
      )}
    </div>
  );
}

function Empty() {
  return (
    <div
      className="flex-1 overflow-y-auto flex items-center justify-center px-6"
      style={{
        background:
          "radial-gradient(600px 400px at 50% 50%, rgba(94,139,126,0.05), transparent 60%)",
      }}
    >
      {/* 原文案是三段:人格名 / 「你的数字雇员 · token 是工资 · 思考 / 行动 / 反思 都在这里」
          / 一块「先到设置配 API Key;配好后回来发条消息试试」的方框。
          slogan 是产品介绍文案(README 里有),不是界面文案 —— 只留人格名 + 可执行的一步。 */}
      <div className="flex flex-col items-center gap-3 text-center">
        <svg width="44" height="44" viewBox="0 0 64 64">
          <g stroke="#5E8B7E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M16 22 L32 14 L48 22 L48 42 L32 50 L16 42 Z" />
            <path d="M32 14 L32 50" />
            <path d="M16 22 L48 42" />
            <path d="M48 22 L16 42" />
          </g>
          <circle cx="32" cy="32" r="3.5" fill="#5E8B7E" />
        </svg>
        <div className="font-serif text-xl" style={{ color: "var(--bone)", letterSpacing: ".08em" }}>
          三生
        </div>
        <p className="sansheng-text-mute" style={{ fontSize: 12 }}>
          先到「设置」配一个 Provider 的 API Key,回来发条消息试试。
        </p>
      </div>
    </div>
  );
}

/**
 * `memo` 保留的原因:streaming 时每个 delta 都会 set 一遍 turns/currentTurn,
 * 没有 memo 的话**整屏对话重渲染**(滚动位置与焦点都会跳)。turn 对象引用未变的
 * 轮次因此被跳过 —— store 只替换正在流式的那一轮。
 *
 * 导出是给测试用的:`tests/web/message-list.test.ts` 直接渲染它(纯 props、
 * 不碰 store)—— 「哪一类块走 markdown、流式时怎么处置表格」这条判据在这里,
 * 而 store 在 SSR 下读的是 zustand 的 server snapshot(store 创建时的初值),
 * 驱动不了。滚动那部分另走纯函数测试(见 lib/scroll.ts)。
 */
export const TurnView = memo(function TurnView({
  turn,
  streaming = false,
}: {
  turn: Turn;
  streaming?: boolean;
}) {
  const isUser = turn.role === "user";
  const usage = turn.usage;
  const showUsage = !!usage && usage.input + usage.output > 0;
  return (
    <div className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
      {/* 说话人 + usage 合并成一行:用户轮不标说话人(气泡靠右已经说明了),
          助手轮只在有真实 token 时才显示数字。 */}
      {!isUser && (showUsage || streaming) && (
        <div
          className="w-full flex items-baseline gap-2"
          style={{ fontSize: 11, letterSpacing: ".04em" }}
        >
          <span className="font-serif sansheng-text-dim">{streaming ? "三生 · 推演中" : "三生"}</span>
          {showUsage && usage ? (
            <span className="ss-meta ml-auto">
              in {usage.input} · out {usage.output}
            </span>
          ) : null}
        </div>
      )}
      <div
        className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"} w-full`}
      >
        {turn.blocks.length === 0 && streaming && (
          <div
            className="rounded-md animate-pulse-soft"
            style={{
              width: 80,
              height: 14,
              background: "var(--ink-2)",
              border: "1px solid var(--ink-3)",
            }}
          />
        )}
        {turn.blocks.map((b, i) => {
          if (b.kind === "thinking") {
            // 思维链是内部推理,不是给用户看的正式输出 —— **不渲染 markdown**,
            // 保持纯文本(等宽字体 + pre-wrap,见 ThinkingBlock)。
            return <ThinkingBlock key={i} text={b.text} streaming={streaming && i === turn.blocks.length - 1} />;
          }
          if (b.kind === "text") {
            return (
              <Bubble
                key={i}
                user={isUser}
                text={b.text}
                streaming={streaming && i === turn.blocks.length - 1}
              />
            );
          }
          if (b.kind === "tool") {
            return <ToolCallCard key={i} block={b} />;
          }
          return null;
        })}
      </div>
    </div>
  );
});

function Bubble({ user, text, streaming }: { user: boolean; text: string; streaming?: boolean }) {
  return (
    <div
      className="rounded-lg px-4 py-3 max-w-[85%]"
      style={{
        background: user ? "var(--ink-2)" : "var(--ink-1)",
        border: "1px solid var(--ink-3)",
        color: "var(--bone)",
        fontSize: 14,
        lineHeight: 1.65,
        // 用户自己键入的内容按字面显示(换行就是他打的换行);
        // 模型输出交给 .ss-md 自己排版,pre-wrap 会干扰块级元素的间距。
        whiteSpace: user ? "pre-wrap" : undefined,
        wordBreak: "break-word",
      }}
    >
      {user ? text : <Markdown text={text} streaming={streaming} />}
      {streaming && <span className="animate-caret" style={{ color: "var(--jade)" }}>▍</span>}
    </div>
  );
}
