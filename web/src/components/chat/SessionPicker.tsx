/**
 * 对话线选择器(migration 024)
 *
 * ── 为什么它长在对话页的**右上角**,而不是另开一个页面 ───────────────
 *
 * 2026-10-06 之前,对话页是**单指针**:一个项目一条对话,没有选择余地,也就没有
 * 选择器。现在一个项目下面可以有多条线(「W1–W7 调研推进」「收口与验收」
 * 「v2 的想法」),而用户仍然希望它们**在同一个地方**看 —— 所以它是头部右侧
 * 的一组页签,不是另一个路由。
 *
 * ⚠️ **页签上不显示条数**:条数只能由 SQL `GROUP BY` 给出,而这条读面没有那个
 * 口径(见 `listMemberConversations` 的注释:「客户端数出来的条数会**静默少数**」)。
 * 宁可少显示一个数字,也不要一个看起来正常的错数字。
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
  const [title, setTitle] = useState("");

  // 接待会话全局只有一条,没有「选哪条」这回事
  if (intakeActive || projectId === null) return null;
  if (sessions.length <= 1) {
    // 只有一条线时**不显示页签** —— 一个只有一个选项的下拉框是在制造噪音。
    // 但「另开一条」仍然要能点到,所以留一个极轻的入口。
    return (
      <button
        type="button"
        className="ss-meta"
        style={{ fontSize: 11, color: "var(--ink-2)", background: "none", border: 0, cursor: "pointer" }}
        title="另开一条对话线:同一件事的不同侧面各走一条,上下文不互相污染"
        onClick={() => setAdding(true)}
      >
        + 新对话线
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-none">
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
            padding: "2px 8px",
            borderRadius: 999,
            cursor: "pointer",
            border: `1px solid ${s.id === sessionId ? "var(--ink-2)" : "var(--ink-3)"}`,
            background: s.id === sessionId ? "var(--ink-2)" : "transparent",
            color: s.id === sessionId ? "var(--bone)" : "var(--ink-2)",
          }}
        >
          {/* ⚠️ `title` 为 null 显示「对话」而不是「未命名」——
              后者听起来像故障,而「甲方没起名」是一个正常状态。 */}
          {s.title ?? (s.kind === "main" ? "主对话" : "对话")}
        </button>
      ))}
      <button
        type="button"
        className="ss-meta"
        style={{ fontSize: 11, color: "var(--ink-2)", background: "none", border: 0, cursor: "pointer" }}
        title="另开一条对话线"
        onClick={() => setAdding(true)}
      >
        +
      </button>
      {adding && (
        <NewThreadForm
          onCancel={() => { setAdding(false); setTitle(""); }}
          onSubmit={(t) => {
            const trimmed = t.trim();
            setAdding(false);
            setTitle("");
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
    <span className="flex items-center gap-1">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="这条线聊什么(可留空)"
        style={{
          fontSize: 11, width: 160, padding: "2px 6px",
          background: "var(--ink-1)", color: "var(--bone)",
          border: "1px solid var(--ink-3)", borderRadius: 4,
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") props.onSubmit(value);
          if (e.key === "Escape") props.onCancel();
        }}
      />
      <button type="button" style={{ fontSize: 11 }} onClick={() => props.onSubmit(value)}>开</button>
      <button type="button" style={{ fontSize: 11 }} onClick={props.onCancel}>取消</button>
    </span>
  );
}
