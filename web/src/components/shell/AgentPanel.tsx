const ROLES = [
  { id: "planner", label: "Planner", glyph: "▢", desc: "制定方案" },
  { id: "executor", label: "Executor", glyph: "▷", desc: "执行动作" },
  { id: "critic", label: "Critic", glyph: "◇", desc: "评估质量" },
  { id: "memory", label: "Memory", glyph: "◯", desc: "管理记忆" },
  { id: "reflection", label: "Reflection", glyph: "✦", desc: "反思归纳" },
];

export function AgentPanel() {
  return (
    <aside
      className="sansheng-card overflow-hidden flex flex-col"
      style={{ minHeight: 0 }}
    >
      <div
        className="px-3 py-2 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>Agent 活动</span>
        <span className="sansheng-text-mute" style={{ fontSize: 11 }}>
          M3 解锁
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        <section className="sansheng-card-elevated p-3">
          <div className="text-xs sansheng-text-mute mb-2">角色</div>
          <ul className="flex flex-col gap-1.5">
            {ROLES.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 px-2 py-1 rounded"
                style={{ background: "var(--ink-1)", border: "1px solid var(--ink-3)" }}
              >
                <span style={{ color: "var(--jade)" }}>{r.glyph}</span>
                <span style={{ fontSize: 12, color: "var(--bone)" }}>{r.label}</span>
                <span className="sansheng-text-mute ml-auto" style={{ fontSize: 11 }}>
                  {r.desc}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="sansheng-card-elevated p-3">
          <div className="text-xs sansheng-text-mute mb-2">Blackboard</div>
          <div
            className="rounded p-3"
            style={{
              background: "var(--ink-1)",
              border: "1px dashed var(--ink-3)",
              color: "var(--bone-mute)",
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            <div className="font-serif mb-1" style={{ color: "var(--bone-dim)" }}>
              暂无会话
            </div>
            goal · plan · todos · evidence · critique
            <br />
            <span className="sansheng-text-mute">会在 Plan 启动时填充。</span>
          </div>
        </section>

        <section className="sansheng-card-elevated p-3">
          <div className="text-xs sansheng-text-mute mb-2">Trace · 本轮</div>
          <div className="flex flex-col gap-1" style={{ fontSize: 11, color: "var(--bone-mute)" }}>
            <Row time="—" tag="user" />
            <Row time="—" tag="think" muted />
            <Row time="—" tag="tool" muted />
            <Row time="—" tag="text" muted />
          </div>
        </section>
      </div>
    </aside>
  );
}

function Row({ time, tag, muted = false }: { time: string; tag: string; muted?: boolean }) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1 rounded font-mono"
      style={{
        background: muted ? "transparent" : "var(--ink-2)",
        color: "var(--bone-mute)",
        border: "1px solid var(--ink-3)",
      }}
    >
      <span className="sansheng-text-mute" style={{ fontSize: 10 }}>{time}</span>
      <span
        className="rounded px-1.5"
        style={{
          fontSize: 10,
          background: "var(--ink-3)",
          color: "var(--bone-dim)",
        }}
      >
        {tag}
      </span>
    </div>
  );
}