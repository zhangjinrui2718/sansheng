import { useEffect, useState } from "react";
import { useChatStore } from "@/stores/chat";
import type { AgentRunSummary, Blackboard, RoleKind } from "@shared/types/agents";

/**
 * Agent 活动侧栏 · M3b 动态版
 * - 角色区:每个角色旁加状态徽章(idle / thinking / tool_use / done / failed / aborted)。
 *   M3b 后端 `/api/agents/:id` 暂是占位 [];徽章会显示 idle,等 agent_states 接通就自动活起来。
 * - Blackboard 卡片:每 2s 轮询 `/api/blackboard/:id`;
 *   有 goal / plan / todos 就显示摘要;没有就保留原来的「暂无会话」empty state。
 * - 任何 fetch 异常 → "加载失败:{message}"。
 *
 * 与 M3b /agents 路由页(Agents.tsx)的差异:
 *   - 本组件嵌在主布局右侧栏,只放摘要级信息,不做表格/分页。
 *   - 本组件读 useChatStore 里的 conversationId,不需要 prop 传递。
 */

type AgentStatus = AgentRunSummary["status"];

// 仅展示 5 个核心角色(communicator 走 chat 主对话,不显示在这)
const DISPLAY_ROLES: RoleKind[] = ["planner", "executor", "critic", "memory", "reflection"];

const ROLE_META: Record<RoleKind, { label: string; glyph: string; desc: string }> = {
  communicator: { label: "Communicator", glyph: "✺", desc: "对话桥" },
  planner: { label: "Planner", glyph: "▢", desc: "制定方案" },
  executor: { label: "Executor", glyph: "▷", desc: "执行动作" },
  critic: { label: "Critic", glyph: "◇", desc: "评估质量" },
  memory: { label: "Memory", glyph: "◯", desc: "管理记忆" },
  reflection: { label: "Reflection", glyph: "✦", desc: "反思归纳" },
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "idle",
  thinking: "thinking",
  tool_use: "tool",
  done: "done",
  failed: "failed",
  aborted: "aborted",
};

// 状态颜色:沿用 design tokens(globals.css / tokens.css)。
// thinking/tool_use 走强调色 + 动效;done 走 jade;failed 走 cinnabar;idle/aborted 走 ink。
const STATUS_STYLE: Record<AgentStatus, { bg: string; fg: string }> = {
  idle: { bg: "var(--ink-3)", fg: "var(--bone-mute)" },
  thinking: { bg: "var(--jade-soft)", fg: "var(--jade)" },
  tool_use: { bg: "rgba(212, 154, 58, 0.18)", fg: "var(--amber)" },
  done: { bg: "var(--jade-soft)", fg: "var(--jade)" },
  failed: { bg: "rgba(229, 72, 77, 0.18)", fg: "var(--cinnabar)" },
  aborted: { bg: "var(--ink-3)", fg: "var(--bone-mute)" },
};

/** 该角色若有多个 run(并行 executor),取优先级最高的 status。 */
function aggregateStatus(agents: AgentRunSummary[], role: RoleKind): AgentStatus {
  const runs = agents.filter((a) => a.role === role);
  if (runs.length === 0) return "idle";
  const rank: Record<AgentStatus, number> = {
    thinking: 5,
    tool_use: 4,
    failed: 3,
    done: 2,
    aborted: 1,
    idle: 0,
  };
  return runs.reduce<AgentStatus>(
    (acc, cur) => (rank[cur.status] > rank[acc] ? cur.status : acc),
    "idle",
  );
}

export function AgentPanel() {
  const conversationId = useChatStore((s) => s.conversationId);

  const [bb, setBb] = useState<Blackboard | null>(null);
  const [agents, setAgents] = useState<AgentRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) {
      setBb(null);
      setAgents([]);
      setError(null);
      return;
    }
    let cancelled = false;
    async function pull(): Promise<void> {
      try {
        const [bbRes, agRes] = await Promise.all([
          fetch(`/api/blackboard/${conversationId}`),
          fetch(`/api/agents/${conversationId}`),
        ]);
        const bbData = (await bbRes.json()) as { blackboard?: Blackboard | null };
        const agData = (await agRes.json()) as { agents?: AgentRunSummary[] };
        if (cancelled) return;
        setBb(bbData.blackboard ?? null);
        setAgents(Array.isArray(agData.agents) ? agData.agents : []);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void pull();
    // M3b 简单轮询 2s;M3c 可换 WS 推送(本任务范围之外)
    const interval = setInterval(() => {
      void pull();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversationId]);

  const planTotal = bb?.plan?.length ?? 0;
  const planDone = bb?.plan?.filter((s) => s.status === "done").length ?? 0;
  const todoTotal = bb?.todos?.length ?? 0;
  const todoDone = bb?.todos?.filter((t) => t.done).length ?? 0;
  const hasContent = !!bb && (!!bb.goal || planTotal > 0 || todoTotal > 0);

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
            {DISPLAY_ROLES.map((id) => {
              const meta = ROLE_META[id];
              const status = aggregateStatus(agents, id);
              const style = STATUS_STYLE[status];
              const live = status === "thinking" || status === "tool_use";
              return (
                <li
                  key={id}
                  className="flex items-center gap-2 px-2 py-1 rounded"
                  style={{ background: "var(--ink-1)", border: "1px solid var(--ink-3)" }}
                >
                  <span style={{ color: "var(--jade)" }}>{meta.glyph}</span>
                  <span style={{ fontSize: 12, color: "var(--bone)" }}>{meta.label}</span>
                  <span
                    className={live ? "animate-pulse-soft" : undefined}
                    style={{
                      fontSize: 10,
                      padding: "0 6px",
                      borderRadius: 4,
                      background: style.bg,
                      color: style.fg,
                      letterSpacing: ".04em",
                    }}
                    title={status}
                  >
                    {STATUS_LABEL[status]}
                  </span>
                  <span className="sansheng-text-mute ml-auto" style={{ fontSize: 11 }}>
                    {meta.desc}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="sansheng-card-elevated p-3">
          <div className="text-xs sansheng-text-mute mb-2">Blackboard</div>
          {error ? (
            <div
              className="rounded p-3"
              style={{
                background: "rgba(229, 72, 77, 0.06)",
                border: "1px solid rgba(229, 72, 77, 0.4)",
                color: "var(--bone-mute)",
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              <div className="font-serif mb-1" style={{ color: "var(--cinnabar)" }}>
                加载失败
              </div>
              {error}
            </div>
          ) : hasContent ? (
            <div
              className="rounded p-3"
              style={{
                background: "var(--ink-1)",
                border: "1px solid var(--ink-3)",
                color: "var(--bone)",
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {bb?.goal && (
                <div className="mb-2" style={{ color: "var(--bone)" }}>
                  <span style={{ color: "var(--jade)" }}>🎯 </span>
                  {bb.goal}
                </div>
              )}
              {planTotal > 0 && (
                <div className="mb-1" style={{ color: "var(--bone-dim)" }}>
                  Plan · {planDone}/{planTotal} done
                </div>
              )}
              {todoTotal > 0 && (
                <div className="mb-1" style={{ color: "var(--bone-dim)" }}>
                  Todos · {todoDone}/{todoTotal} done
                </div>
              )}
            </div>
          ) : (
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
          )}
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