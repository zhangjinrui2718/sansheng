import { useChatStore } from "@/stores/chat";

/**
 * 会话历史侧栏 · M1.5
 * - 「+ 新对话」按钮:清当前会话、换 conversationId(M2 持久化后会真正列出历史)
 * - 历史列表:M2 接 SQLite 后填充;现在只显示当前会话占位
 */
export function HistoryRail() {
  const conversationId = useChatStore((s) => s.conversationId);
  const turns = useChatStore((s) => s.turns);
  const newConversation = useChatStore((s) => s.newConversation);

  const hasCurrent = turns.length > 0;

  return (
    <aside className="sansheng-card overflow-hidden flex flex-col" style={{ minHeight: 0 }}>
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>会话历史</span>
        <button
          className="sansheng-button"
          style={{ padding: "2px 10px", fontSize: 12 }}
          onClick={() => newConversation()}
          title="新建对话(清空当前,开始新会话)"
        >
          + 新对话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {hasCurrent && conversationId ? (
          <div
            className="rounded-md px-3 py-2"
            style={{ background: "var(--ink-2)", border: "1px solid var(--jade)" }}
          >
            <div style={{ fontSize: 12, color: "var(--bone)" }}>当前会话</div>
            <div className="font-mono sansheng-text-mute mt-1" style={{ fontSize: 10 }}>
              {conversationId.slice(-10)} · {turns.length} 轮
            </div>
          </div>
        ) : (
          <Empty />
        )}

        <div
          className="rounded-md px-3 py-2 mt-1 sansheng-text-mute"
          style={{ background: "transparent", border: "1px dashed var(--ink-3)", fontSize: 11, lineHeight: 1.6 }}
        >
          历史归档将在 <span className="sansheng-text-jade">M2</span>(SQLite 持久化)后出现。
          <br />
          现在「+ 新对话」会清空当前会话重新开始。
        </div>
      </div>
    </aside>
  );
}

function Empty() {
  return (
    <div
      className="rounded-md flex flex-col items-center justify-center text-center px-4 py-6"
      style={{ background: "var(--ink-2)", border: "1px dashed var(--ink-3)", color: "var(--bone-mute)" }}
    >
      <div className="font-serif text-base" style={{ color: "var(--bone-dim)", letterSpacing: ".06em" }}>
        缘起
      </div>
      <p className="text-xs mt-1 leading-relaxed">尚无对话。</p>
    </div>
  );
}
