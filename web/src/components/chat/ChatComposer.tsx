/**
 * 对话输入区
 *
 * 与旧版的差别:去掉了 `noKernel` 这一档。旧系统有「kernel 未就绪 → 发一条会
 * 自动 start」的状态,新契约里**没有 kernel 会话**(对话就是项目),也就没有
 * 「未连接 kernel」可显示。剩下的三档都是真实存在的:未选项目 / 没配 Key / 推演中。
 *
 * Esc 中断的接线保持原样(window keydown,因为推演中 textarea 是 disabled,
 * 绑在它上面永远收不到按键)。
 */
import { useEffect, useState } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  onInterrupt?: () => void;
  disabled?: boolean;
  reason?: "streaming" | "noProject" | "noKey";
  placeholder?: string;
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onInterrupt,
  disabled,
  reason,
  placeholder,
}: Props) {
  const [focused, setFocused] = useState(false);

  // 「Esc 中断」必须真接线:推演中 textarea 是 disabled,监听挂 window。
  const canInterrupt = !!disabled && reason === "streaming" && !!onInterrupt;
  useEffect(() => {
    if (!canInterrupt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onInterrupt?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canInterrupt, onInterrupt]);

  function send() {
    if (disabled) return;
    const t = value.trim();
    if (!t) return;
    onSubmit(t);
    onChange("");
  }

  // 调用方没给 placeholder 时才退回默认文案。
  const ph =
    placeholder ??
    (disabled ? "正在生成…" : "说点什么 · Enter 发送 · Shift+Enter 换行");

  return (
    <div
      className="px-4 py-3 flex-none"
      style={{
        borderTop: "1px solid var(--ink-3)",
        background: "rgba(11,15,20,0.6)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div
        className="rounded-lg flex items-end px-3 py-2 gap-2"
        style={{
          background: "var(--ink-1)",
          border: `1px solid ${focused ? "var(--jade)" : "var(--ink-3)"}`,
          boxShadow: focused ? "var(--shadow-jade-glow)" : "none",
          transition: "border-color 160ms var(--ease-out), box-shadow 160ms var(--ease-out)",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <textarea
          className="flex-1 bg-transparent outline-none resize-none"
          rows={1}
          placeholder={ph}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={disabled}
          style={{
            color: "var(--bone)",
            fontSize: 14,
            lineHeight: 1.6,
            minHeight: 22,
            maxHeight: 220,
          }}
        />
        <button
          className="sansheng-button-primary flex-none"
          onClick={send}
          disabled={disabled || !value.trim()}
          style={{ padding: "6px 14px" }}
        >
          {disabled
            ? reason === "noProject"
              ? "先选项目"
              : reason === "noKey"
                ? "未配 API Key"
                : "推演中…"
            : "发送 ⏎"}
        </button>
      </div>
      {/* 状态与快捷键合并成一行。 */}
      <div className="mt-1.5 flex items-center gap-2 ss-meta">
        <span>
          {disabled
            ? reason === "noProject"
              ? "左栏还没有选中的项目"
              : reason === "noKey"
                ? "请先在「设置」配置 API Key"
                : "推演中 · Esc 中断"
            : "就绪"}
        </span>
        <span className="ml-auto">⏎ 发送 · ⇧⏎ 换行</span>
      </div>
    </div>
  );
}
