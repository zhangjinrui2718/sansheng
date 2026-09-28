import { useState } from "react";
import type { Block } from "@/stores/chat";

interface Props {
  block: Extract<Block, { kind: "tool" }>;
}

const KIND_GLYPH: Record<string, string> = {
  bash: "$",
  read: "📄",
  write: "✎",
  edit: "✎",
  grep: "🔍",
  find: "🔍",
  ls: "≣",
};

export function ToolCallCard({ block }: Props) {
  const [open, setOpen] = useState(false);
  const { tool } = block;
  const isError = !!tool.isError;
  const duration = tool.durationMs ? `${tool.durationMs}ms` : "…";
  const glyph = KIND_GLYPH[tool.name] ?? "⚙";

  return (
    <div
      className="rounded-md"
      style={{
        background: isError ? "rgba(229, 72, 77, 0.06)" : "var(--ink-2)",
        border: `1px solid ${isError ? "rgba(229, 72, 77, 0.4)" : "var(--ink-3)"}`,
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left"
        style={{ fontSize: 12 }}
      >
        <span style={{ color: isError ? "var(--cinnabar)" : "var(--bone-dim)" }}>{glyph}</span>
        <span style={{ color: isError ? "var(--cinnabar)" : "var(--bone)" }}>{tool.name}</span>
        <span
          className="ml-auto font-mono"
          style={{ fontSize: 10, color: "var(--bone-mute)" }}
        >
          {duration}
        </span>
        {tool.result !== undefined && (
          <span
            className="font-mono"
            style={{
              fontSize: 10,
              color: isError ? "var(--cinnabar)" : "var(--bamboo)",
              marginLeft: 6,
            }}
          >
            {isError ? "✗" : "✓"}
          </span>
        )}
        {!tool.result && (
          <span
            className="font-mono animate-pulse-soft"
            style={{ fontSize: 10, color: "var(--bone-mute)", marginLeft: 6 }}
          >
            ⏳
          </span>
        )}
      </button>
      {open && (
        <div
          className="px-3 py-2"
          style={{ borderTop: "1px solid var(--ink-3)", fontSize: 12 }}
        >
          {tool.args !== undefined && (
            <pre
              className="font-mono overflow-x-auto mb-2"
              style={{
                color: "var(--bone-dim)",
                background: "var(--ink-1)",
                padding: 8,
                borderRadius: 4,
                border: "1px solid var(--ink-3)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {formatArgs(tool.args)}
            </pre>
          )}
          {tool.result !== undefined && (
            <pre
              className="font-mono overflow-x-auto"
              style={{
                color: isError ? "var(--cinnabar)" : "var(--bone-dim)",
                background: "var(--ink-1)",
                padding: 8,
                borderRadius: 4,
                border: "1px solid var(--ink-3)",
                maxHeight: 320,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {formatResult(tool.result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function formatArgs(args: unknown): string {
  if (args == null) return "(no args)";
  if (typeof args === "string") return args;
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

function formatResult(result: unknown): string {
  if (result == null) return "(no result)";
  if (typeof result === "string") return result;
  const r = result as any;
  if (Array.isArray(r.content)) {
    return r.content
      .map((c: any) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
      .join("\n");
  }
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}