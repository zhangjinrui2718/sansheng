/**
 * 对话消息流(批次 UI U4:每轮的头/尾两行合成一行)
 *
 * 改这一层之前,每一轮助手回复都在内容上方单独占一行「三生」,内容下方再单独占
 * 一行 `in 12 · out 340`(且 token 为 0 时也占一行)。也就是说,**每轮有 2 行
 * 不是内容的行**。现在合成一条头(左:说话人 / 右:usage,usage 为 0 时不显示)，
 * 一屏能多看到大约一轮对话。
 *
 * 空态同理:原来「三生」+ 一句slogan + 一块两行的「去设置配 Key」提示共三段文字。
 * 现在保留人格名与**唯一可执行的一步**,其余移到文件注释。
 */
import { useEffect, useRef } from "react";
import { useChatStore, type Turn } from "@/stores/chat";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

export function MessageList() {
  const turns = useChatStore((s) => s.turns);
  const current = useChatStore((s) => s.currentTurn);
  const error = useChatStore((s) => s.error);
  const status = useChatStore((s) => s.status);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns.length, current?.blocks.length]);

  if (turns.length === 0 && !current) return <Empty />;

  return (
    <div ref={ref} className="flex-1 overflow-y-auto px-6 py-5">
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

function TurnView({ turn, streaming = false }: { turn: Turn; streaming?: boolean }) {
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
}

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
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
      {streaming && <span className="animate-caret" style={{ color: "var(--jade)" }}>▍</span>}
    </div>
  );
}
