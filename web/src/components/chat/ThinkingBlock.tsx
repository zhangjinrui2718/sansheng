/**
 * 思考块(批次 UI U4:状态行去掉重复的「推演中」)
 *
 * 「推演中」此前在本块与 MessageList 的轮次头**各出现一次**;轮次头已经有了,
 * 这里删掉,只保留箭头随展开状态旋转(旧实现写死 ▾,展开后纹丝不动)。
 */
import { useState } from "react";

interface Props {
  text: string;
  streaming?: boolean;
}

export function ThinkingBlock({ text, streaming }: Props) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").slice(0, 60) + (text.length > 60 ? "…" : "");
  return (
    <div
      className="rounded-md"
      style={{
        background: "rgba(94, 139, 126, 0.06)",
        border: "1px solid rgba(94, 139, 126, 0.25)",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left"
        style={{ color: "var(--bone-dim)", fontSize: 12 }}
      >
        {/* 箭头随展开状态旋转 —— 旧实现写死 ▾,展开后箭头纹丝不动,读不出当前状态。 */}
        <span
          style={{
            color: "var(--jade)",
            display: "inline-block",
            transition: "transform var(--duration-160) var(--ease-out)",
            transform: open ? "rotate(90deg)" : "none",
          }}
        >
          ›
        </span>
        <span className="font-mono" style={{ fontSize: 11 }}>
          思考
        </span>
        {!open && (
          <span className="sansheng-text-mute truncate ml-2" style={{ fontSize: 11 }}>
            {preview || "…"}
          </span>
        )}
      </button>
      {open && (
        <div
          className="px-3 py-2 sansheng-text-dim"
          style={{
            fontSize: 12,
            lineHeight: 1.6,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            borderTop: "1px solid rgba(94, 139, 126, 0.2)",
          }}
        >
          {text}
          {streaming && <span className="animate-caret">▍</span>}
        </div>
      )}
    </div>
  );
}