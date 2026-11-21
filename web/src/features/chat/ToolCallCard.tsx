/**
 * 工具调用卡(批次 UI U4:工具图标从 emoji 换成与全站一致的几何字形)
 *
 * 原表混着 emoji(📄 🔍)与几何字形($ ✎ ≣)—— emoji 在不同系统里字形与
 * 字重都不一样,深色底上还偏色,和全站「状态用色块 + mono pill,不用 emoji 当
 * UI 标签」的规则也不一致。这里统一成几何字形。
 */
import { useState } from "react";
import type { Block } from "@/stores/chat";

interface Props {
  block: Extract<Block, { kind: "tool" }>;
}

const KIND_GLYPH: Record<string, string> = {
  bash: "$",
  read: "▤",
  write: "✎",
  edit: "✎",
  grep: "⌕",
  find: "⌕",
  ls: "≣",
};

/**
 * 批次 UI U2(C10-3):web 侧唯一的那处类型逃逸就在本文件(AGENTS.md 硬规则要求全仓 0)。
 * 用 module-level type guard 替代(与 server 侧 hasBaseUrl / hasCost 同款约定)。
 */
function hasContentArray(value: unknown): value is { content: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/** content 数组里的元素:要么是裸字符串,要么是带 text 字段的块。 */
function contentPartText(part: unknown): string {
  if (typeof part === "string") return part;
  if (part !== null && typeof part === "object") {
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
}

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
        {/* C10-3 第二个实锤:旧实现在这里写 `!tool.result` —— 空串结果("")既是
            falsy 又 !== undefined,于是同一张卡上 ✓ 和 ⏳ 同时出现。空串是**合法
            结果**(命令成功但无输出),必须归到「已完成」一侧。判据只认 undefined。 */}
        {tool.result === undefined && (
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
  if (hasContentArray(result)) {
    return result.content.map(contentPartText).join("\n");
  }
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}