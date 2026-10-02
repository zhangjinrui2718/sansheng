/**
 * Sansheng · 目标页(批次 UI U1)
 *
 * ⚠️ 数据来源声明(必须显眼 —— 这是**投影视图**,不是独立的 goals 子系统):
 *   PLAN.md 的 M7「Goals」目前**后端没有实现**。本批开工前逐项查证:
 *     - `shared/types/goals.ts` 只有 `Goal`/`RedLine` 两个 interface,文件头自述
 *       「M5/M7/M8 填实」,全仓**零消费者**(grep `types/goals` 在 src/ web/ tests/ 无命中);
 *     - `migrations/001..005_*.sql` 里**没有 goals 表**(artifacts 存在 blackboards
 *       表的 artifacts_json 列里);
 *     - HTTP 层**没有** `/api/goals` 路由(src/server/http.ts + http/blackboardRoutes.ts 全量核对)。
 *   故按任务书「方案②」:目标 = 用户/沟通员表达过的 **intent artifact**,
 *   进度 = 该 intent 名下 todo artifact 的真实状态聚合(parentIntent 关联由
 *   planner.ts:239 真实写入、orchestrator.ts:406 maybeResolveIntent 真实消费)。
 *   这是**可逆**方案:将来 M7 真落地时,只需把本文件的数据源从 artifacts 换成
 *   `/api/goals`,页面结构与设计不动。**零 mock 数据** —— 空库就显示空态。
 *
 * 数据源:`GET /api/artifacts?conversationId=<id>&limit=200`(同工件页的权威端点),
 *   intent 取 kind=intent,todo 取 kind=todo 并按 parentIntent 归组。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChatStore } from "@/stores/chat";
import type { ArtifactStatus } from "@shared/types/blackboard";

const LIMIT = 200;

interface Artifact {
  id: string;
  kind: string;
  title: string;
  body: string;
  author: string;
  status: ArtifactStatus;
  parentIntent?: string;
  dependsOn?: string[];
  createdAt: number;
  updatedAt: number;
}

const STATUS_LABEL: Record<string, string> = {
  open: "进行中",
  in_progress: "执行中",
  waiting_for_decision: "等决策",
  resolved: "已达成",
  superseded: "被取代",
  failed: "未达成",
};

const STATUS_TONE: Record<string, string> = {
  open: "var(--jade)",
  in_progress: "var(--jade)",
  waiting_for_decision: "var(--amber)",
  resolved: "var(--bamboo)",
  superseded: "var(--bone-mute)",
  failed: "var(--cinnabar)",
};

const TODO_TONE: Record<string, string> = {
  open: "var(--bone-mute)",
  in_progress: "var(--jade)",
  waiting_for_decision: "var(--amber)",
  resolved: "var(--bamboo)",
  superseded: "var(--bone-mute)",
  failed: "var(--cinnabar)",
};

const DONE_STATUSES = new Set<string>(["resolved", "superseded"]);

interface Props {
  conversationId: string | null;
}

export function GoalsPage({ conversationId }: Props) {
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
        `/api/artifacts?conversationId=${encodeURIComponent(conversationId)}&limit=${LIMIT}`,
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

  // 目标 = intent artifact;进度 = 名下 todo 的真实状态聚合
  const goals = useMemo(() => {
    const intents = artifacts.filter((a) => a.kind === "intent");
    return intents
      .map((intent) => {
        const todos = artifacts.filter((a) => a.kind === "todo" && a.parentIntent === intent.id);
        const done = todos.filter((t) => DONE_STATUSES.has(t.status)).length;
        return { intent, todos, done, total: todos.length };
      })
      .sort((a, b) => b.intent.createdAt - a.intent.createdAt);
  }, [artifacts]);

  const settled = goals.filter((g) => g.intent.status === "resolved" || g.intent.status === "failed");

  return (
    <main className="px-4 pb-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="sansheng-h2">目标</h2>
        <div className="text-xs sansheng-text-mute font-mono">
          {goals.length} 个目标{settled.length > 0 && ` · ${settled.length} 已收口`}
          {loading && " · 刷新中"}
        </div>
      </div>
      <p className="sansheng-text-mute mb-3" style={{ fontSize: 11, lineHeight: 1.6 }}>
        数据来源:本会话的 intent 工件(沟通员/用户表达过的目标)+ 其名下 todo 的真实状态。
        M7 Goals 子系统尚未实现,当前为投影视图。
      </p>

      {error && (
        <div className="sansheng-card p-3 text-xs mb-3" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      )}

      {!conversationId ? (
        <div className="sansheng-card p-4 text-sm opacity-80">
          先在「对话」选一个会话,再切换到「目标」查看该会话表达过的目标。
        </div>
      ) : !error && !loading && goals.length === 0 ? (
        <div className="sansheng-card p-4 text-sm opacity-80">
          本会话暂无目标。发送 /plan 你的目标 触发规划后,目标会出现在这里。
        </div>
      ) : (
        <div className="grid gap-2">
          {goals.map(({ intent, todos, done, total }) => {
            const pct = total === 0 ? 0 : Math.round((done / total) * 100);
            return (
              <article key={intent.id} className="sansheng-card p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span style={{ color: "var(--jade)" }}>🎯</span>
                  <span
                    className="font-mono rounded"
                    style={{
                      fontSize: 10,
                      padding: "0 6px",
                      background: "var(--ink-3)",
                      color: STATUS_TONE[intent.status] ?? "var(--bone-mute)",
                    }}
                  >
                    {STATUS_LABEL[intent.status] ?? intent.status}
                  </span>
                  <span className="sansheng-text-mute font-mono ml-auto" style={{ fontSize: 10 }}>
                    {new Date(intent.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="text-sm" style={{ color: "var(--bone)" }}>
                  {intent.title}
                </div>
                {intent.body && intent.body !== intent.title && (
                  <div
                    className="text-xs mt-1"
                    style={{ color: "var(--bone-dim)", whiteSpace: "pre-wrap", lineHeight: 1.6 }}
                  >
                    {intent.body}
                  </div>
                )}

                {total > 0 ? (
                  <div className="mt-2">
                    <div className="flex items-center gap-2 mb-1">
                      <div
                        style={{
                          flex: 1,
                          height: 3,
                          background: "var(--ink-3)",
                          borderRadius: 2,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${pct}%`,
                            height: "100%",
                            background:
                              intent.status === "failed" ? "var(--cinnabar)" : "var(--jade)",
                          }}
                        />
                      </div>
                      <span className="font-mono sansheng-text-mute" style={{ fontSize: 10 }}>
                        {done}/{total} · {pct}%
                      </span>
                    </div>
                    <ul className="grid gap-1">
                      {todos.map((t) => (
                        <li key={t.id} className="flex items-center gap-2">
                          <span
                            className="font-mono"
                            style={{
                              fontSize: 10,
                              color: TODO_TONE[t.status] ?? "var(--bone-mute)",
                            }}
                          >
                            {DONE_STATUSES.has(t.status) ? "✓" : t.status === "failed" ? "✗" : "◌"}
                          </span>
                          <span className="truncate" style={{ fontSize: 12, color: "var(--bone-dim)" }}>
                            {t.title}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="sansheng-text-mute mt-2" style={{ fontSize: 11 }}>
                    尚无 todo —— Planner 还没拆解这个目标。
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
