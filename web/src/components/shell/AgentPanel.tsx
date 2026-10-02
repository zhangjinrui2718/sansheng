/**
 * Agent 活动侧栏 · M3b 动态版
 *
 * 批次 UI U2(审查 §C10)处置:
 *  - 轮询端点从 legacy `/api/blackboard/:id` + `/api/agents/:id` **换成**现行
 *    `GET /api/artifacts?conversationId=`。旧实现的两个端点都是死数据面:
 *    `getActiveBlackboard` 依赖 `upsertBlackboard`,而它**全仓无调用方** → 恒 null;
 *    `/api/agents/:id` 是硬编码 `{agents:[]}` 的 M3c 占位 → 恒空。
 *  - 角色徽章不再是「永远 idle」:改为按工件 `author` 聚合的真实产出状态。
 *  - 底部「Trace · 本轮」原是四条硬编码 `—` 占位行(纯假 UI),换成真实的工件构成。
 *
 * 与 M3b /agents 路由页(Agents.tsx)的差异:
 *   - 本组件嵌在主布局右侧栏,只放摘要级信息,不做表格/分页。
 *   - 本组件读 useChatStore 里的 conversationId,不需要 prop 传递。
 */
import { useEffect, useState } from "react";
import { useChatStore } from "@/stores/chat";
import type { RoleKind } from "@shared/types/agents";

interface Artifact {
  id: string;
  kind: string;
  title: string;
  author: string;
  status: string;
  createdAt: number;
}

const KIND_LABEL: Record<string, string> = {
  intent: "意图",
  todo: "待办",
  decision: "决策",
  hypothesis: "假设",
  note: "笔记",
  evidence: "证据",
  critique: "批驳",
  reflection: "反思",
  harness_proposal: "提案",
  implementation_preview: "预览",
};

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

/**
 * 角色状态(由工件 author 聚合而来,不再有 `/api/agents` 那种恒空来源):
 *   idle  = 本会话该角色没产出过任何工件
 *   done  = 有产出且全部落在终态
 *   work  = 有产出且仍有非终态工件(等价于「还在跑」)
 */
type RoleState = "idle" | "done" | "work";

const STATUS_LABEL: Record<RoleState, string> = {
  idle: "idle",
  done: "done",
  work: "working",
};

const STATUS_STYLE: Record<RoleState, { bg: string; fg: string }> = {
  idle: { bg: "var(--ink-3)", fg: "var(--bone-mute)" },
  done: { bg: "var(--jade-soft)", fg: "var(--jade)" },
  work: { bg: "rgba(212, 154, 58, 0.18)", fg: "var(--amber)" },
};

const TERMINAL = new Set(["resolved", "superseded", "failed"]);

/** 该角色在本会话的聚合状态。 */
function aggregateRole(artifacts: Artifact[], role: string): RoleState {
  const mine = artifacts.filter((a) => a.author === role);
  if (mine.length === 0) return "idle";
  return mine.every((a) => TERMINAL.has(a.status)) ? "done" : "work";
}

export function AgentPanel() {
  const conversationId = useChatStore((s) => s.conversationId);
  // 批次 U1:artifact 生命周期事件打戳 → 回查(替代 2s 轮询的实时性缺口)
  const artifactRevision = useChatStore((s) => s.artifactRevision);

  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) {
      setArtifacts([]);
      setError(null);
      return;
    }
    const convId = conversationId;
    let cancelled = false;
    async function pull(): Promise<void> {
      try {
        const res = await fetch(
          `/api/artifacts?conversationId=${encodeURIComponent(convId)}&limit=200`,
        );
        const data = (await res.json()) as {
          artifacts?: Artifact[];
          error?: string;
          message?: string;
        };
        if (cancelled) return;
        if (!res.ok || data.error) {
          setError(data.message ?? data.error ?? `HTTP ${res.status}`);
          setArtifacts([]);
        } else {
          setArtifacts(Array.isArray(data.artifacts) ? data.artifacts : []);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void pull();
    // 慢速兜底轮询(WS 断流时仍能收敛);实时性主路径是 artifactRevision 打戳
    const interval = setInterval(() => {
      void pull();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversationId, artifactRevision]);

  const intents = artifacts.filter((a) => a.kind === "intent");
  const todos = artifacts.filter((a) => a.kind === "todo");
  const todoDone = todos.filter((t) => t.status === "resolved" || t.status === "superseded").length;
  const goal = intents.length > 0 ? intents[intents.length - 1] : null;
  const hasContent = artifacts.length > 0;

  // 工件构成(替代旧的四条硬编码 `—` 占位行)
  const kindCounts = artifacts.reduce<Record<string, number>>((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1;
    return acc;
  }, {});

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
          {artifacts.length} 工件
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        <section className="sansheng-card-elevated p-3">
          <div className="text-xs sansheng-text-mute mb-2">角色</div>
          <ul className="flex flex-col gap-1.5">
            {DISPLAY_ROLES.map((id) => {
              const meta = ROLE_META[id];
              const state = aggregateRole(artifacts, id);
              const style = STATUS_STYLE[state];
              const live = state === "work";
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
                    title={`${artifacts.filter((a) => a.author === id).length} 个产出`}
                  >
                    {STATUS_LABEL[state]}
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
              {goal && (
                <div className="mb-2" style={{ color: "var(--bone)" }}>
                  <span style={{ color: "var(--jade)" }}>🎯 </span>
                  {goal.title}
                </div>
              )}
              {todos.length > 0 && (
                <div className="mb-1" style={{ color: "var(--bone-dim)" }}>
                  Todos · {todoDone}/{todos.length} done
                </div>
              )}
              <div style={{ color: "var(--bone-dim)" }}>工件 · {artifacts.length}</div>
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
              intent · todo · evidence · critique
              <br />
              <span className="sansheng-text-mute">会在 Plan 启动时填充。</span>
            </div>
          )}
        </section>

        <section className="sansheng-card-elevated p-3">
          <div className="text-xs sansheng-text-mute mb-2">工件构成</div>
          {hasContent ? (
            <div className="flex flex-col gap-1" style={{ fontSize: 11, color: "var(--bone-mute)" }}>
              {Object.entries(kindCounts).map(([kind, n]) => (
                <div key={kind} className="flex items-center gap-2 rounded px-2 py-1" style={{ background: "var(--ink-2)" }}>
                  <span>{KIND_LABEL[kind] ?? kind}</span>
                  <span className="ml-auto font-mono" style={{ color: "var(--bone-dim)" }}>
                    {n}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="sansheng-text-mute" style={{ fontSize: 11 }}>
              还没有工件。
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
