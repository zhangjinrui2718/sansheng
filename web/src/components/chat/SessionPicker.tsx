/**
 * 对话线选择器(migration 024)
 *
 * ── 它为什么**独占一行**(2026-10-06 修的第一版布局)─────────────
 *
 * 第一版把它塞进对话页头部那一行的**中间**,和「项目名 + 状态 + 模型」、
 * 「运行态 + 中断」抢同一行宽度。真机症状是这个项目底下有 **9 条**线:
 *
 *   · 页签**文字纵向排列** —— 按钮没有 `white-space: nowrap`,CJK 被 flex 压到
 *     最小宽度,一个字一行;
 *   · **右边几个页签点不到** —— 头部是 `justify-between` 且卡片带
 *     `overflow-hidden`,撑出去的按钮被**裁在可视区之外**。它们确实渲染了,
 *     只是鼠标够不着。
 *
 * 两条都**不像布局坏了**:第一个看起来像「样式没加载」,第二个像「按钮失效」——
 * 而真正的原因是「一行放不下」。
 *
 * ⇒ 现在它**独占第二行**,横向可滚动,宽度不超过容器。任何宽度下都不会挤,
 * 也不会被裁。
 */
import { useState } from "react";
import { useChatStore } from "@/stores/chat";

export function SessionPicker() {
  const intakeActive = useChatStore((s) => s.intakeActive);
  const projectId = useChatStore((s) => s.projectId);
  const sessions = useChatStore((s) => s.sessions);
  const sessionId = useChatStore((s) => s.sessionId);
  const selectSession = useChatStore((s) => s.selectSession);
  const newThread = useChatStore((s) => s.newThread);
  const [adding, setAdding] = useState(false);

  // 接待会话全局只有一条,没有「选哪条」这回事
  if (intakeActive || projectId === null) return null;

  const onlyOne = sessions.length <= 1;

  return (
    // ⚠️ `min-w-0` 让这个 flex 子项**可以缩到 0**,于是内部的滚动容器才拿得到
    // 确定的宽度 —— 少了它,父级的 `min-w-0` 规则会让滚动条永远不动。
    <div
      className="flex items-center gap-2 flex-none"
      style={{ minWidth: 0, borderTop: "1px solid var(--ink-3)", padding: "4px 16px" }}
    >
      {onlyOne ? (
        // 只有一条线时**不显示页签** —— 一个只有一个选项的选择器是在制造噪音。
        // 但「另开一条」仍然要能点到。
        <span style={{ fontSize: 11, color: "var(--bone-mute)" }}>
          只有一条对话线
        </span>
      ) : (
        <div
          // 横向滚动:宽度不够时**滚动**,而不是把按钮压扁或挤出容器。
          className="flex items-center gap-1"
          style={{ overflowX: "auto", minWidth: 0, flex: 1 }}
        >
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => { void selectSession(s.id); }}
              title={
                s.kind === "main"
                  ? "主对话:平台叫醒业务经理的回合落在这里"
                  : "另开的对话线:只有你在这里说的话会进来"
              }
              style={{
                fontSize: 11,
                // ⚠️ **`nowrap` 是必须的** —— 没有它 CJK 会被压成「一个字一行」,
                // 那看起来像样式没加载,而不像一行放不下。
                whiteSpace: "nowrap",
                // flex 子项默认 `min-width: auto`(内容宽度),这里显式收窄,
                // 否则长标题会把整行撑开。
                flexShrink: 0,
                padding: "2px 8px",
                borderRadius: 999,
                cursor: "pointer",
                border: `1px solid ${s.id === sessionId ? "var(--ink-2)" : "var(--ink-3)"}`,
                background: s.id === sessionId ? "var(--ink-2)" : "transparent",
                color: s.id === sessionId ? "var(--bone)" : "var(--bone-dim)",
              }}
            >
              {/* ⚠️ `title` 为 null 显示「对话」而不是「未命名」——
                  后者听起来像故障,而「甲方没起名」是一个正常状态。 */}
              {s.title ?? (s.kind === "main" ? "主对话" : "对话")}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        style={{
          fontSize: 11, whiteSpace: "nowrap", flexShrink: 0,
          color: "var(--bone-mute)", background: "none",
          border: "1px dashed var(--ink-3)", borderRadius: 999,
          padding: "2px 8px", cursor: "pointer",
        }}
        title="另开一条对话线:同一件事的不同侧面各走一条,上下文不互相污染"
        onClick={() => setAdding(true)}
      >
        + 新对话线
      </button>
      {adding && (
        <NewThreadForm
          onCancel={() => setAdding(false)}
          onSubmit={(t) => {
            setAdding(false);
            const trimmed = t.trim();
            void newThread(trimmed === "" ? undefined : trimmed);
          }}
        />
      )}
    </div>
  );
}

/**
 * 起名框。**留空就开** —— 平台不猜这条线该叫什么(§2.11:规则不做语义猜测),
 * 编一个「对话 2」出来会让人以为甲方真的这么命名过。
 *
 * ⚠️ 它是**受控**的:值在本地 state 里,`onSubmit` 把它交出去。
 * 上一版把它写成了一个 `value={propsTitleValue()}` 的占位(永远空串)——
 * 那看起来能输入,实际一个字都留不住,而**界面表现完全正常**。
 */
function NewThreadForm(props: { onCancel: () => void; onSubmit: (title: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <span className="flex items-center gap-1" style={{ flexShrink: 0 }}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="这条线聊什么(可留空)"
        style={{
          fontSize: 11, width: 160, padding: "2px 6px",
          background: "var(--ink-1)", color: "var(--bone)",
          border: "1px solid var(--ink-3)", borderRadius: 4,
          whiteSpace: "nowrap",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") props.onSubmit(value);
          if (e.key === "Escape") props.onCancel();
        }}
      />
      <button
        type="button"
        style={{ fontSize: 11, whiteSpace: "nowrap", cursor: "pointer" }}
        onClick={() => props.onSubmit(value)}
      >
        开
      </button>
      <button
        type="button"
        style={{ fontSize: 11, whiteSpace: "nowrap", cursor: "pointer" }}
        onClick={props.onCancel}
      >
        取消
      </button>
    </span>
  );
}