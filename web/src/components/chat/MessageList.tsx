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
    <div ref={ref} className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-3xl mx-auto flex flex-col gap-5">
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
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <svg width="56" height="56" viewBox="0 0 64 64">
          <g stroke="#5E8B7E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M16 22 L32 14 L48 22 L48 42 L32 50 L16 42 Z" />
            <path d="M32 14 L32 50" />
            <path d="M16 22 L48 42" />
            <path d="M48 22 L16 42" />
          </g>
          <circle cx="32" cy="32" r="3.5" fill="#5E8B7E" />
        </svg>
        <div>
          <div className="font-serif text-2xl" style={{ color: "var(--bone)", letterSpacing: ".08em" }}>
            三生
          </div>
          <div className="sansheng-text-dim mt-1" style={{ fontSize: 12 }}>
            你的数字雇员 · token 是工资 · 思考 / 行动 / 反思 都在这里
          </div>
        </div>
        <div
          className="text-xs sansheng-text-mute leading-relaxed px-4 py-3 rounded-md"
          style={{
            background: "var(--ink-2)",
            border: "1px solid var(--ink-3)",
            maxWidth: 360,
          }}
        >
          先到「设置」配 API Key 与模型;<br />
          配好后回来发条消息试试。
        </div>
      </div>
    </div>
  );
}

function TurnView({ turn, streaming = false }: { turn: Turn; streaming?: boolean }) {
  const isUser = turn.role === "user";
  return (
    <div className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
      {!isUser && (
        <div
          className="font-serif sansheng-text-dim"
          style={{ fontSize: 12, letterSpacing: ".06em" }}
        >
          三生{streaming ? " · 推演中" : ""}
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
      {turn.usage && (
        <div className="font-mono sansheng-text-mute" style={{ fontSize: 10 }}>
          in {turn.usage.input} · out {turn.usage.output}
        </div>
      )}
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
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
      {streaming && <span className="animate-caret" style={{ color: "var(--jade)" }}>▍</span>}
    </div>
  );
}