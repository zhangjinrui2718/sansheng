export function HistoryRail() {
  return (
    <aside
      className="sansheng-card overflow-hidden flex flex-col"
      style={{ minHeight: 0 }}
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>会话历史</span>
        <button className="sansheng-button" style={{ padding: "2px 8px", fontSize: 11 }}>
          +
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        <Empty />
      </div>
    </aside>
  );
}

function Empty() {
  return (
    <div
      className="rounded-md flex flex-col items-center justify-center text-center px-4 py-8"
      style={{
        background: "var(--ink-2)",
        border: "1px dashed var(--ink-3)",
        color: "var(--bone-mute)",
      }}
    >
      <div className="font-serif text-lg" style={{ color: "var(--bone-dim)", letterSpacing: ".06em" }}>
        缘起
      </div>
      <p className="text-xs mt-2 leading-relaxed">
        尚无对话。下次会话结束后,<br />
        历史的「因」会从此处生长。
      </p>
    </div>
  );
}