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
        <span style={{ color: "var(--jade)" }}>▾</span>
        <span className="font-mono" style={{ fontSize: 11 }}>
          思考
        </span>
        {streaming && (
          <span className="sansheng-text-jade animate-pulse-soft" style={{ fontSize: 10 }}>
            · 推演中
          </span>
        )}
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