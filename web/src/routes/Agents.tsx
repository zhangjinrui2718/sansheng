/**
 * Sansheng · Agents 页(批次 UI U2 改自原 M3b 占位版)
 *
 * 批次 UI U2 处置(审查 §C10「Agents 页 setAgents 零调用 + server /api/agents 恒
 * {agents:[]}」):
 *  - **删** `setAgents` 死状态:原实现声明了 agents 字典,却没有任何一处调用它 ——
 *    表格永远用空字典渲染,五行全显示 "idle" —— 纯假 UI。
 *  - **删** `/api/agents/:id` 拉取:该端点(http.ts:229)是硬编码 `{agents:[]}`
 *    的 M3c 占位,拉回来必然是空数组,留着只会让人误以为「agent 都没跑」。
 *  - **换** legacy `/api/blackboard/:id` 轮询:该端点读 `getActiveBlackboard`,
 *    而 `upsertBlackboard` **全仓无调用方** → 恒 null(§C10 实锤)。换成现行
 *    artifact 端点 `GET /api/artifacts?conversationId=`,拿得到真实的
 *    intent/todo/decision/evidence 及其状态。
 *  - **接真实来源** 角色表:server 目前**没有** per-role 运行态 API
 *    (`/api/agents/:id` 恒空),但 artifact 的 `author` 字段是**真实**的角色维度
 *    (communicator/planner/executor/critic/memory/reflection/harness_manager)——
 *    按 author 聚合出「每个角色产出了什么、最新一条什么时候」,没有 artifact 时
 *    如实显示空态,不再摆 5 行假的 idle。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChatStore } from "@/stores/chat";
import type { ArtifactStatus } from "@shared/types/blackboard";
import type { RoleKind } from "@shared/types/agents";

interface Artifact {
  id: string;
  kind: string;
  title: string;
  body: string;
  author: string;
  status: ArtifactStatus;
  parentIntent?: string;
  createdAt: number;
}

const ROLES: RoleKind[] = ["planner", "executor", "critic", "memory", "reflection"];

const KIND_LABEL: Record<string, string> = {
  intent: "意图",
  todo: "待办",
  decision: "决策",
  hypothesis: "假设",
  note: "笔记",
  evidence: "证据",
  critique: "批驳",
  reflection: "反思",
};

interface Props {
  conversationId: string | null;
}

export function AgentsPage({ conversationId }: Props) {
  // artifactRevision:artifact 生命周期事件(批次 U1 接线)→ 回查
  const artifactRevision = useChatStore((s) => s.artifactRevision);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!conversationId) {
      setArtifacts([]);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/artifacts?conversationId=${encodeURIComponent(conversationId)}&limit=200`,
      );
      const data = (await res.json()) as {
        artifacts?: Artifact[];
        error?: string;
        message?: string;
      };
      if (!res.ok || data.error) {
        setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        setArtifacts([]);
      } else {
        setArtifacts(Array.isArray(data.artifacts) ? data.artifacts : []);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setArtifacts([]);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load, artifactRevision]);

  // 角色活动:按 artifact.author 聚合(真实数据)
  const byRole = useMemo(() => {
    const map = new Map<string, Artifact[]>();
    for (const a of artifacts) {
      const list = map.get(a.author);
      if (list) list.push(a);
      else map.set(a.author, [a]);
    }
    return map;
  }, [artifacts]);

  // Blackboard 摘要:真实 artifact 图(intent + 名下 todo 的完成度)
  const intents = useMemo(
    () => artifacts.filter((a) => a.kind === "intent").sort((a, b) => b.createdAt - a.createdAt),
    [artifacts],
  );
  const todos = useMemo(() => artifacts.filter((a) => a.kind === "todo"), [artifacts]);

  return (
    <main className="px-4 pb-4">
      <h2 className="sansheng-h2">Agents & Blackboard</h2>
      {error && (
        <div className="sansheng-card p-3 text-xs mb-3" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      )}
      {!conversationId ? (
        <div className="sansheng-card p-4 text-sm opacity-80">
          先在「对话」选一个会话,再切换到「Agent」查看 blackboard。
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <section className="sansheng-card p-4">
            <h3 className="font-medium mb-2">Blackboard</h3>
            {loading && !artifacts.length ? (
              <p className="text-sm opacity-80">加载中…</p>
            ) : intents.length === 0 ? (
              <p className="text-sm opacity-80">
                多 agent 尚未启动。发送 <code>/plan 你的目标</code> 触发。
              </p>
            ) : (
              <div className="grid gap-2">
                {intents.map((intent) => {
                  const own = todos.filter((t) => t.parentIntent === intent.id);
                  const done = own.filter(
                    (t) => t.status === "resolved" || t.status === "superseded",
                  ).length;
                  return (
                    <div key={intent.id} className="rounded p-2" style={{ background: "var(--ink-1)" }}>
                      <div className="font-mono sansheng-text-mute" style={{ fontSize: 10 }}>
                        {intent.status} · {new Date(intent.createdAt).toLocaleString()}
                      </div>
                      <div className="text-sm" style={{ color: "var(--bone)" }}>
                        {intent.title}
                      </div>
                      {own.length > 0 && (
                        <div className="sansheng-text-mute mt-1" style={{ fontSize: 11 }}>
                          todo {done}/{own.length} done
                        </div>
                      )}
                    </div>
                  );
                })}
                <div className="sansheng-text-mute" style={{ fontSize: 11 }}>
                  共 {artifacts.length} 个工件 ·{" "}
                  {Object.entries(
                    artifacts.reduce<Record<string, number>>((acc, a) => {
                      acc[a.kind] = (acc[a.kind] ?? 0) + 1;
                      return acc;
                    }, {}),
                  )
                    .map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`)
                    .join(" · ")}
                </div>
              </div>
            )}
          </section>

          <section className="sansheng-card p-4">
            <h3 className="font-medium mb-2">Agent 状态</h3>
            {artifacts.length === 0 ? (
              <p className="text-sm opacity-80">
                本会话还没有任何 agent 产出。
                <br />
                <span className="sansheng-text-mute" style={{ fontSize: 11 }}>
                  状态由工件作者字段聚合;发送 /plan 触发后这里会亮起来。
                </span>
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left sansheng-text-mute">
                    <th style={{ fontSize: 11 }}>角色</th>
                    <th style={{ fontSize: 11 }}>产出</th>
                    <th style={{ fontSize: 11 }}>最新</th>
                  </tr>
                </thead>
                <tbody>
                  {ROLES.map((r) => {
                    const items = byRole.get(r);
                    const last = items?.[items.length - 1];
                    return (
                      <tr key={r} style={{ borderTop: "1px solid var(--ink-3)" }}>
                        <td className="py-1">{r}</td>
                        <td className="font-mono sansheng-text-mute">{items ? items.length : "—"}</td>
                        <td
                          className="truncate"
                          style={{ maxWidth: 160, color: last ? "var(--bone-dim)" : undefined }}
                          title={last?.title}
                        >
                          {last ? last.title : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {byRole.size > 0 && (
              <div className="sansheng-text-mute mt-2" style={{ fontSize: 11, lineHeight: 1.6 }}>
                非核心角色:{[...byRole.keys()].filter((k) => !ROLES.includes(k as RoleKind)).join(" · ") || "—"}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
