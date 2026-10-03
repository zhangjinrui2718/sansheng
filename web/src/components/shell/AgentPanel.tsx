/**
 * Agent 活动侧栏 · M3b 动态版(批次 UI U4:三块合成一块)
 *
 * 改这一层之前,这个 284 行的侧栏有三处是**纯噪声**,还有一个和 Agent 页打架:
 *
 *  1. **`critic` / `memory` / `reflection` 三行永远是 `idle`。** 这三个角色没有 class
 *     实现、全仓也没有任何代码读它们的 harness 提示词(产品设计 §1,用户 2026-10-02
 *     决定暂不实现)。Agent 页早就按同一条决定把它们从角色表里整行删掉了(理由:
 *     「永远点不亮的灰行是噪声」),侧栏却还留着 —— 同一个决定在两个视图里不一致。
 *     现在侧栏也只列真实在跑的角色。
 *  2. **「Blackboard」卡和「工件构成」卡说的是同一件事。** 前者写「工件 · 12」,
 *     后者把同一个 12 拆成 6 行 kind 计数 —— 侧栏高度被两块卡吃掉了。合并成一块:
 *     目标一行 + 一行 kind 计数。
 *  3. **空态写了三行**「暂无会话 / intent · todo · evidence · critique / 会在 Plan
 *     启动时填充」。一行就够。
 *  4. 🎯 emoji 换成色点(项目规则:UI 标签不用 emoji)。
 *
 * 数据面没动:仍读 `GET /api/artifacts?conversationId=…`,仍以 store 的
 * `artifactRevision` 打戳触发回查,仍保留 5s 慢速兜底轮询(WS 断流时侧栏要能收敛)
 * —— 轮询间隔经 `useArtifacts({ pollMs })` 传入,不是新写的一套 fetch。
 *
 * 与 /agents 路由页(Agents.tsx)的分工:**本组件是摘要**,不做表格 / 分组 / DAG;
 * 详情去 Agent 页。
 */
import { useMemo } from "react";
import { EmptyState, KV, Pill, StatStrip } from "@/components/ui/primitives";
import type { Tone } from "@/components/ui/primitives";
import { useArtifacts, kindLabel } from "@/lib/artifacts";

/**
 * 只列真实在跑的角色。communicator 走「对话」主入口,不进这个侧栏 ——
 * 它的每个动作都会在对话页留下痕迹,再列一行是重复。
 * critic / memory / reflection 见文件头 ①:暂不实现,不列。
 */
const DISPLAY_ROLES = [
  { id: "planner", label: "Planner", desc: "制定方案" },
  { id: "executor", label: "Executor", desc: "执行动作" },
  { id: "harness_manager", label: "Harness", desc: "自我改进" },
] as const;

/**
 * 角色状态(由工件 author 聚合而来,不再有 `/api/agents` 那种恒空来源):
 *   idle = 本会话该角色没产出过任何工件
 *   done = 有产出且全部落在终态
 *   work = 有产出且仍有非终态工件(等价于「还在跑」)
 */
type RoleState = "idle" | "done" | "work";

const STATE_META: Record<RoleState, { label: string; tone: Tone }> = {
  idle: { label: "idle", tone: "mute" },
  done: { label: "done", tone: "jade" },
  work: { label: "running", tone: "amber" },
};

const TERMINAL = new Set(["resolved", "superseded", "failed"]);

function aggregateRole(author: string, artifacts: { author: string; status: string }[]): RoleState {
  const mine = artifacts.filter((a) => a.author === author);
  if (mine.length === 0) return "idle";
  return mine.every((a) => TERMINAL.has(a.status)) ? "done" : "work";
}

export function AgentPanel() {
  const { artifacts, loading, error } = useArtifacts({ pollMs: 5000 });

  const goal = useMemo(() => {
    const intents = artifacts.filter((a) => a.kind === "intent");
    return intents.length > 0 ? intents[intents.length - 1] : undefined;
  }, [artifacts]);

  const todos = useMemo(() => artifacts.filter((a) => a.kind === "todo"), [artifacts]);
  const doneCount = todos.filter((t) => t.status === "resolved" || t.status === "superseded").length;

  /** kind 计数按数量倒序 —— 侧栏高度有限,先看到的主要产出。 */
  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of artifacts) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
    return [...counts.entries()].sort((x, y) => y[1] - x[1]);
  }, [artifacts]);

  return (
    <aside className="sansheng-card overflow-hidden flex flex-col" style={{ minHeight: 0 }}>
      <div
        className="px-3 py-2 flex items-center justify-between flex-none"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>Agent 活动</span>
        <span className="ss-meta">{artifacts.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        <ul className="flex flex-col gap-1">
          {DISPLAY_ROLES.map((r) => {
            const state = aggregateRole(r.id, artifacts);
            const count = artifacts.filter((a) => a.author === r.id).length;
            const meta = STATE_META[state];
            return (
              <li
                key={r.id}
                className="flex items-center gap-2 px-2 py-1 rounded"
                style={{ background: "var(--ink-1)", border: "1px solid var(--ink-3)" }}
                title={`${r.label} · ${r.desc} · 本会话 ${count} 个产出`}
              >
                <span style={{ fontSize: 12, color: "var(--bone)" }}>{r.label}</span>
                <span className="sansheng-text-mute truncate" style={{ fontSize: 11 }}>
                  {r.desc}
                </span>
                <span className="ml-auto flex-none">
                  <Pill tone={meta.tone}>{meta.label}</Pill>
                </span>
              </li>
            );
          })}
        </ul>

        {error ? (
          <div className="ss-empty" style={{ color: "var(--cinnabar)" }}>
            加载失败:{error}
          </div>
        ) : loading && artifacts.length === 0 ? (
          /* 此前这里没有 loading 档:首次挂载直接跳到「还没有工件」,同样是在
             还没问过服务器时下结论。与 Agents / 工件 / 目标 三页对齐。 */
          <EmptyState>加载中…</EmptyState>
        ) : artifacts.length === 0 ? (
          <EmptyState>还没有工件。以 /plan 开头发一条,这里会显示各角色的产出。</EmptyState>
        ) : (
          <div className="flex flex-col gap-1.5">
            {goal && (
              <div
                className="flex items-start gap-1.5 rounded px-2 py-1.5"
                style={{ background: "var(--ink-1)", border: "1px solid var(--ink-3)" }}
              >
                <span
                  className="inline-block rounded-full flex-none"
                  style={{ width: 5, height: 5, marginTop: 6, background: "var(--jade)" }}
                />
                <span className="ss-body ss-clamp-2" style={{ fontSize: 12 }}>
                  {goal.title}
                </span>
              </div>
            )}
            {todos.length > 0 && (
              <StatStrip
                items={[
                  { label: "待办", value: `${doneCount}/${todos.length}` },
                  {
                    label: "工件",
                    value: artifacts.length,
                    title: "本会话 blackboard 上的全部工件",
                  },
                ]}
              />
            )}
            {/* 「Blackboard」与「工件构成」原本是两张卡,现在合成一块:目标 → 计数 → 构成。 */}
            <div className="flex flex-col">
              {kinds.map(([kind, n]) => (
                <KV key={kind} label={kindLabel(kind)} value={<span className="font-mono">{n}</span>} />
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
