import { useEffect, useState } from "react";
import type { AgentRunSummary, Blackboard, RoleKind } from "@shared/types/agents";

interface Props {
  conversationId: string | null;
}

const ROLES: RoleKind[] = ["planner", "executor", "critic", "memory", "reflection"];

export function AgentsPage({ conversationId }: Props) {
  const [bb, setBb] = useState<Blackboard | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentRunSummary>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) {
      setBb(null);
      setAgents({});
      return;
    }
    let cancelled = false;
    async function pull() {
      try {
        const res = await fetch(`/api/blackboard/${conversationId}`);
        const data = await res.json();
        if (cancelled) return;
        setBb(data?.blackboard ?? null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    pull();
    // M3b: 简单轮询,2s 一次;M3c 可改 WS 推送
    const id = setInterval(pull, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [conversationId]);

  // M3b: 汇总用 server 返回的 agents 字典 + 本地占位
  const rows: Array<{ key: string; summary: AgentRunSummary }> = Object.entries(agents).map(
    ([key, summary]) => ({ key, summary }),
  );

  return (
    <main className="px-4 pb-4">
      <h2 className="sansheng-h2">Agents & Blackboard</h2>
      {error && (
        <div className="sansheng-card p-3 text-xs opacity-70 mb-3">加载失败:{error}</div>
      )}
      {!conversationId ? (
        <div className="sansheng-card p-4 text-sm opacity-80">
          先在「对话」选一个会话,再切换到「Agent」查看 blackboard。
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <section className="sansheng-card p-4">
            <h3 className="font-medium mb-2">Blackboard</h3>
            {!bb ? (
              <p className="text-sm opacity-80">
                多 agent 尚未启动。发送 <code>/plan 你的目标</code> 触发。
              </p>
            ) : (
              <>
                <div className="text-xs opacity-70 mb-2">
                  状态:{bb.status} · 迭代:{bb.iteration} · 计划 {bb.plan.length} 步 · 证据{" "}
                  {bb.evidence.length} 条
                </div>
                <pre
                  className="text-xs overflow-auto"
                  style={{ maxHeight: 360, whiteSpace: "pre-wrap" }}
                >
                  {JSON.stringify(
                    {
                      goal: bb.goal,
                      plan: bb.plan,
                      evidence: bb.evidence,
                      critique: bb.critique,
                      retrievedMemories: bb.retrievedMemories,
                      decisions: bb.decisions,
                    },
                    null,
                    2,
                  ).slice(0, 2000)}
                </pre>
              </>
            )}
          </section>

          <section className="sansheng-card p-4">
            <h3 className="font-medium mb-2">Agent 状态</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left opacity-70">
                  <th>角色</th>
                  <th>状态</th>
                  <th>输入</th>
                  <th>输出</th>
                </tr>
              </thead>
              <tbody>
                {ROLES.map((r) => {
                  // 找 runner: agents 字典的 key 形如 "planner" 或 "executor::xxx"
                  const entry = rows.find(({ key }) => key === r || key.startsWith(`${r}::`));
                  return (
                    <tr key={r} className="border-t border-white/5">
                      <td className="py-1">{r}</td>
                      <td>{entry?.summary.status ?? "idle"}</td>
                      <td className="truncate" style={{ maxWidth: 120 }}>
                        {entry?.summary.inputPreview ?? "—"}
                      </td>
                      <td className="truncate" style={{ maxWidth: 120 }}>
                        {entry?.summary.outputPreview ?? "—"}
                      </td>
                    </tr>
                  );
                })}
                {rows
                  .filter(({ key }) => !ROLES.some((r) => key === r || key.startsWith(`${r}::`)))
                  .map(({ key, summary }) => (
                    <tr key={key} className="border-t border-white/5">
                      <td className="py-1">{key}</td>
                      <td>{summary.status}</td>
                      <td className="truncate" style={{ maxWidth: 120 }}>
                        {summary.inputPreview}
                      </td>
                      <td className="truncate" style={{ maxWidth: 120 }}>
                        {summary.outputPreview}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </main>
  );
}