/**
 * 对话输入区
 *
 * 与旧版的差别:
 *   - 去掉了 `noKernel` 这一档。旧系统有「kernel 未就绪 → 发一条会自动 start」的
 *     状态,新契约里**没有 kernel 会话**(对话就是项目),也就没有「未连接 kernel」
 *     可显示。
 *   - 去掉了 `noProject` 这一档(本批次):`ClientCommand.send.projectId` 现在可为
 *     `null`,那是**接待会话** —— 第一个项目之前也能说话。剩下的两档都是真实存在
 *     的:没配 Key / 推演中;「有项目但没选」是第三种情况,由 `noContext` 表示。
 *
 * Esc 中断的接线保持原样(window keydown,因为推演中 textarea 是 disabled,
 * 绑在它上面永远收不到按键)。
 */
import { useEffect, useState } from "react";
import type { SocketStatus } from "@/lib/ws";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => boolean;
  onInterrupt?: () => void;
  /**
   * **传输层的状态** —— WS 不在 OPEN 时,发出去的消息与停止指令**都会被丢掉**。
   *
   * ⚠️ 此前这个状态在整个界面上**没有一处看得见**,而它同时毁掉三件事:
   * 发出去的消息静默丢失(乐观上屏让它看起来发出去了)、「■ 中断」按下去没反应、
   * 输入框永久死锁(本地轮表收不到 `agent_end`)。
   *
   * ⇒ 断线时**不给能按的按钮**(摆一个按下去必然无效的按钮比没有按钮更坏),
   * 并且**说清楚**「这期间发不出去」。
   *
   * ⚠️ **三态不是两种**:`connecting`(还在连)与 `closed`(已经断了)是**两件事** ——
   * 前者等一下就好,后者要等重连。说成同一句就是在骗用户
   * (他会以为是平台坏了,于是反复重试)。
   */
  connection?: SocketStatus;
  /**
   * **「此刻有东西可以停」** —— 中断入口的可见性。
   *
   * ⚠️ 判据在 `lib/data.ts` 的 `interruptAvailableOf`(**唯一一处**):本地有在飞的轮,
   * 或者服务端说这个上下文有回合在跑(刷新 / 切走再切回之后本地轮表是空的,
   * 而那个回合**真的还在跑**)。
   *
   * ⚠️ 它**不是**「输入框被禁用」的同义词:输入框的禁用只认**甲方通道在跑**
   * (bug A 的纪律 —— 内部角色在跑不许锁死输入框),而「能不能停」认**任何**在跑的
   * 回合。两个判据各管各的,不许互相顶替。
   */
  interruptible?: boolean;
  disabled?: boolean;
  reason?: "streaming" | "noContext" | "noKey";
  placeholder?: string;
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onInterrupt,
  connection = "open",
  interruptible,
  disabled,
  reason,
  placeholder,
}: Props) {
  const [focused, setFocused] = useState(false);
  // ⚠️ **「还在连」与「已经断了」是两种不同的故障** —— 界面不许把前者说成后者。
  const offline = connection === "closed";
  const connecting = connection === "connecting";

  // 「Esc 中断」必须真接线:推演中 textarea 是 disabled,监听挂 window。
  //
  // ⚠️ **武装条件是「有东西可以停」,不是「输入框被禁用」** ——
  // 此前是 `disabled && reason === "streaming"`:刷新页面之后本地轮表是空的
  // (输入框**没被禁用**),于是 Esc 不武装 ⇒ 用户按 Esc 什么也没发生,
  // 而顶部那盏灯明明写着「推演中」。
  const canInterrupt = !!interruptible && !!onInterrupt;
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
    if (disabled || connection !== "open") return;
    const t = value.trim();
    if (!t) return;
    // ⚠️ **没发出去就不清输入框** —— 用户那句话还在他手里。
    // 清掉就是「我说了话,它没了」,而服务端压根没收到。
    if (onSubmit(t) === false) return;
    onChange("");
  }

  // 调用方没给 placeholder 时才退回默认文案。
  const ph =
    placeholder ??
    (offline
      ? "连接已断开,正在重连…"
      : connecting
        ? "连接中…"
        : disabled
          ? "正在生成…"
          : "说点什么 · Enter 发送 · Shift+Enter 换行");

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
        {/*
          **停止按钮** —— 它就在「发送」旁边,因为发送键此刻是死的
          (推演中时被禁用,写着「推演中…」)。

          ⚠️ **按钮的可见性只看「能不能停」,不看输入框的可用性** ——
          刷新页面之后输入框是可用的(本地没有在飞的轮),而服务端那一轮
          **真的还在跑**:这时唯一说得清的入口就是这个按钮
          ( Esc 同理,见上面 `canInterrupt`)。
        */}
        {interruptible && (
          <button
            className="sansheng-button flex-none"
            onClick={() => onInterrupt?.()}
            title="停止这一轮(也可以按 Esc)"
            style={{ padding: "6px 12px" }}
          >
            ■ 停止
          </button>
        )}
        <button
          className="sansheng-button-primary flex-none"
          onClick={send}
          disabled={disabled || connection !== "open" || !value.trim()}
          style={{ padding: "6px 14px" }}
        >
          {offline
            ? "连接断了"
            : connecting
              ? "连接中…"
              : disabled
                ? reason === "noContext"
                  ? "先选上下文"
                  : reason === "noKey"
                    ? "未配 API Key"
                    : "推演中…"
                : "发送 ⏎"}
        </button>
      </div>
      {/* 状态与快捷键合并成一行。 */}
      <div className="mt-1.5 flex items-center gap-2 ss-meta">
        <span>
          {offline
            ? "连接已断开,正在重连… —— 这期间发不出去的消息与停止指令都不会生效"
            : connecting
              ? "连接中… —— 连接好之前,发不出去的消息与停止指令都不会生效"
              : disabled
                ? reason === "noContext"
                  ? "左栏选一个项目,或点「+ 新建」和业务经理聊聊"
                  : reason === "noKey"
                    ? "请先在「设置」配置 API Key"
                    : "推演中 · Esc 中断"
                : interruptible
                  ? // ⚠️ **输入框可用、但确实有回合在跑** —— 这是刷新 / 切走再切回之后
                    // 的那一档:本地轮表是空的,服务端那一轮还在跑。
                    // 话不能说「就绪」(那是在说「没事」),也不能说「推演中」(输入框没禁用)。
                    "有回合在跑 · ■ 停止 / Esc 也能停"
                  : "就绪"}
        </span>
        <span className="ml-auto">⏎ 发送 · ⇧⏎ 换行</span>
      </div>
    </div>
  );
}
