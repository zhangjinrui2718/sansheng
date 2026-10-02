import { useEffect, useState } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  onInterrupt?: () => void;
  disabled?: boolean;
  reason?: "streaming" | "noKernel" | "noKey";
  placeholder?: string;
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onInterrupt,
  disabled,
  reason,
}: Props) {
  const [focused, setFocused] = useState(false);

  // 批次 UI U2(C10-1):「Esc 中断」此前**没有任何 keydown 接线** —— 一句纯文案承诺。
  // server 侧能力一直存在(ws.ts:542 → kernel.abort()),这里把 Escape 接上。
  // 为什么挂在 window 而不是 textarea 的 onKeyDown:推演中 textarea 是 disabled,
  // disabled 元素既不派发键盘事件也不持有焦点,绑在它上面永远收不到 Esc。
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

  return (
    <div
      className="px-4 py-3"
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
          placeholder={disabled ? "正在生成…" : "说点什么 · Enter 发送 · Shift+Enter 换行"}
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
          className="sansheng-button-primary"
          onClick={send}
          disabled={disabled || !value.trim()}
          style={{ padding: "6px 14px" }}
        >
          {disabled
            ? reason === "noKernel"
              ? "未连接 · 点发送自动恢复"
              : reason === "noKey"
                ? "未配 API Key"
                : "推演中…"
            : "发送 ⏎"}
        </button>
      </div>
      <div
        className="mt-2 flex items-center gap-3 text-xs sansheng-text-mute"
        style={{ fontSize: 11 }}
      >
        <span>
          {disabled
            ? reason === "noKernel"
              ? "kernel 未就绪 · 发一条会自动 start"
              : reason === "noKey"
                ? "请先在 ⚙ 设置配置 API Key"
                : "三生正在推演 · Esc 中断"
            : "Sansheng 闲置"}
        </span>
        <span>·</span>
        <span>思考 / 行动 / 反思 都会落到 timeline</span>
        <span className="ml-auto">
          ⏎ 发送 · ⇧⏎ 换行{canInterrupt && " · Esc 中断"}
        </span>
      </div>
    </div>
  );
}