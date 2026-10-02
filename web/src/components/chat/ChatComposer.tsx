/**
 * 对话输入区(批次 UI U4:底部三段文字压成一行 + 接上**一直没被用的** placeholder)
 *
 * 改这一层之前有两个问题:
 *
 *  1. **`placeholder` prop 是死的。** ChatSurface 精心算出了三档 placeholder
 *     (kernel 未就绪 / 没配 Key / 正常),逐层传给 ChatComposer,而 ChatComposer
 *     **根本没有解构这个 prop**,textarea 里写的是一句写死的
 *     `disabled ? "正在生成…" : "说点什么…"`。结果是「请先在「设置」配置 API Key」
 *     这类最该被看见的引导从来没出现在输入框里。现在接线,三档提示真正生效。
 *  2. **底部状态条有三段文字**:`状态说明 · 「思考 / 行动 / 反思 都会落到 timeline」
 *     · 快捷键提示`。中间那句是产品介绍文案,而且声称「落到 timeline」——
 *     思考/工具确实进对话流,规划产出落到工件页,不是 timeline,属于半个空头承诺
 *     (与 tests/web/c10-dead-code.test.ts 守的同一类问题)。删掉,状态与快捷键
 *     合并成一行。
 *
 * Esc 中断的接线保持原样(window keydown,因为推演中 textarea 是 disabled,
 * 绑在它上面永远收不到按键)—— tests/web/c10-dead-code.test.ts 守着这一条。
 */
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
  placeholder,
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

  // 调用方没给 placeholder 时才退回默认文案(此前是无论传什么都不看)。
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
            ? reason === "noKernel"
              ? "未连接 · 点发送自动恢复"
              : reason === "noKey"
                ? "未配 API Key"
                : "推演中…"
            : "发送 ⏎"}
        </button>
      </div>
      {/* 状态与快捷键合并成一行;不再有第二行的产品介绍文案。 */}
      <div className="mt-1.5 flex items-center gap-2 ss-meta">
        <span>
          {disabled
            ? reason === "noKernel"
              ? "kernel 未就绪 · 发一条会自动 start"
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
