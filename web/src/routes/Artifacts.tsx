/**
 * Sansheng · 工件页(批次 UI U1)
 *
 * 数据源:`GET /api/artifacts?conversationId=<id>&limit=200`
 *   —— blackboard v3 artifact 的**唯一读端点**(src/server/http/blackboardRoutes.ts:74),
 *   scope 默认 conversation(全局工件在 Harness 页的 proposals/previews 里展示)。
 *   返回体已由真实 server 冒烟验证:`{ artifacts: BlackboardArtifact[] }`,
 *   单条含 id/scope/conversationId/kind/title/body/author/status/createdAt/updatedAt
 *   + 可选 refs/executors/dependsOn/parentIntent/metadata。
 *
 * 实时性:WS 的 artifact_created / artifact_status_changed / plan_done 经 chat store
 * 汇总成 artifactRevision 计数(与既有 historyRefreshTrigger 同款模式),页面依赖它
 * 回查。**不把 artifact 本体塞进 store** —— 权威数据永远回查后端,避免两份真相。
 *
 * 视觉:完全沿用既有页面骨架(Memory.tsx / Agents.tsx 同款 `<main className="px-4 pb-4">`
 * + `sansheng-h2` + `sansheng-card`),不引入新配色/字体/间距体系。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChatStore } from "@/stores/chat";
import type { ArtifactKind, ArtifactStatus } from "@shared/types/blackboard";

/** 与 src/server/http/blackboardRoutes.ts listArtifacts 的上限一致(4a-OQ2)。 */
const LIMIT = 200;

interface Artifact {
  id: string;
  scope: "global" | "conversation";
  conversationId?: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  refs?: string[];
  author: string;
  status: ArtifactStatus;
  executors?: string[];
  dependsOn?: string[];
  parentIntent?: string;
  metadata?: { source?: string; [k: string]: unknown };
  createdAt: number;
  updatedAt: number;
}

/** 本页关注的 kind(沉淀笔记沉淀在 note;其余 kind 也一并展示,不做白名单隐藏)。 */
const KIND_LABEL: Record<string, string> = {
  intent: "意图",
  hypothesis: "假设",
  note: "笔记",
  decision: "决策",
  todo: "待办",
  evidence: "证据",
  critique: "批驳",
  reflection: "反思",
  harness_proposal: "提案",
  implementation_preview: "预览",
};

const KIND_TONE: Record<string, string> = {
  intent: "var(--jade)",
  hypothesis: "var(--amber)",
  note: "var(--bone-dim)",
  decision: "var(--bamboo)",
  todo: "var(--cyan, #4cc9c0)",
  evidence: "var(--bone-dim)",
  critique: "var(--ochre)",
  reflection: "var(--bone-dim)",
  harness_proposal: "var(--ochre)",
  implementation_preview: "var(--ochre)",
};

const STATUS_LABEL: Record<string, string> = {
  open: "待处理",
  in_progress: "进行中",
  waiting_for_decision: "等决策",
  resolved: "已解决",
  superseded: "被取代",
  failed: "失败",
};

const STATUS_TONE: Record<string, string> = {
  open: "var(--bone-mute)",
  in_progress: "var(--jade)",
  waiting_for_decision: "var(--amber)",
  resolved: "var(--bamboo)",
  superseded: "var(--bone-mute)",
  failed: "var(--cinnabar)",
};

/** 过滤维度(纯前端,不加后端查询参数 —— 5b-2 OQ1 建议的后端过滤留待后续)。 */
const KINDS: Array<{ key: string; label: string }> = [
  { key: "all", label: "全部" },
  { key: "intent", label: "意图" },
  { key: "hypothesis", label: "假设" },
  { key: "note", label: "笔记" },
  { key: "decision", label: "决策" },
];

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

interface Props {
  conversationId: string | null;
}

export function ArtifactsPage({ conversationId }: Props) {
  const artifactRevision = useChatStore((s) => s.artifactRevision);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState("all");
  const [sedimentationOnly, setSedimentationOnly] = useState(false);

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

  // 首载 + 会话切换 + artifactRevision 打戳 → 回查
  useEffect(() => {
    void load();
  }, [load, artifactRevision]);

  const filtered = useMemo(
    () =>
      artifacts
        .filter((a) => (kindFilter === "all" ? true : a.kind === kindFilter))
        .filter((a) => (sedimentationOnly ? a.metadata?.source === "sedimentation" : true))
        .sort((a, b) => b.createdAt - a.createdAt),
    [artifacts, kindFilter, sedimentationOnly],
  );

  const sedimentCount = useMemo(
    () => artifacts.filter((a) => a.metadata?.source === "sedimentation").length,
    [artifacts],
  );

  return (
    <main className="px-4 pb-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="sansheng-h2">工件</h2>
        <div className="text-xs sansheng-text-mute font-mono">
          {artifacts.length} 条
          {filtered.length !== artifacts.length && ` · 过滤后 ${filtered.length}`}
          {loading && " · 刷新中"}
        </div>
      </div>

      {conversationId && artifacts.length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {KINDS.map((k) => (
            <button
              key={k.key}
              className="sansheng-button"
              onClick={() => setKindFilter(k.key)}
              style={{
                padding: "3px 9px",
                fontSize: 11,
                background: kindFilter === k.key ? "var(--ink-2)" : "transparent",
                color: kindFilter === k.key ? "var(--bone)" : "var(--bone-dim)",
                borderColor: kindFilter === k.key ? "var(--ink-4)" : "transparent",
              }}
            >
              {k.label}
            </button>
          ))}
          {sedimentCount > 0 && (
            <button
              className="sansheng-button"
              onClick={() => setSedimentationOnly((v) => !v)}
              title="只看 metadata.source=sedimentation 的沉淀产物"
              style={{
                padding: "3px 9px",
                fontSize: 11,
                background: sedimentationOnly ? "var(--jade-soft)" : "transparent",
                color: sedimentationOnly ? "var(--jade)" : "var(--bone-dim)",
                borderColor: sedimentationOnly ? "var(--jade)" : "transparent",
              }}
            >
              沉淀 {sedimentCount}
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="sansheng-card p-3 text-xs mb-3" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      )}

      {!conversationId ? (
        <div className="sansheng-card p-4 text-sm opacity-80">
          先在「对话」选一个会话,再切换到「工件」查看该会话的 blackboard 工件。
        </div>
      ) : !error && !loading && filtered.length === 0 ? (
        <div className="sansheng-card p-4 text-sm opacity-80">
          {artifacts.length === 0
            ? "本会话暂无工件。发送 /plan 触发规划后,Planner 的 intent/todo 与 Executor 的 evidence 会落在这里。"
            : "当前过滤条件下没有工件。"}
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((a) => (
            <article key={a.id} className="sansheng-card p-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span
                  className="font-mono rounded"
                  style={{
                    fontSize: 10,
                    padding: "0 6px",
                    background: "var(--ink-3)",
                    color: KIND_TONE[a.kind] ?? "var(--bone-dim)",
                  }}
                >
                  {KIND_LABEL[a.kind] ?? a.kind}
                </span>
                <span
                  className="font-mono rounded"
                  style={{
                    fontSize: 10,
                    padding: "0 6px",
                    background: "var(--ink-3)",
                    color: STATUS_TONE[a.status] ?? "var(--bone-mute)",
                  }}
                >
                  {STATUS_LABEL[a.status] ?? a.status}
                </span>
                {a.metadata?.source === "sedimentation" && (
                  <span
                    className="font-mono rounded"
                    style={{
                      fontSize: 10,
                      padding: "0 6px",
                      background: "var(--jade-soft)",
                      color: "var(--jade)",
                    }}
                    title="metadata.source=sedimentation · 沉淀产物"
                  >
                    沉淀
                  </span>
                )}
                <span className="sansheng-text-mute font-mono ml-auto" style={{ fontSize: 10 }}>
                  {a.author} · {fmtTime(a.createdAt)}
                </span>
              </div>
              <div className="text-sm" style={{ color: "var(--bone)" }}>
                {a.title}
              </div>
              {a.body && (
                <div
                  className="text-xs mt-1"
                  style={{ color: "var(--bone-dim)", whiteSpace: "pre-wrap", lineHeight: 1.6 }}
                >
                  {a.body}
                </div>
              )}
              {(a.dependsOn?.length || a.parentIntent) && (
                <div className="sansheng-text-mute font-mono mt-1" style={{ fontSize: 10 }}>
                  {a.parentIntent && `parent ${a.parentIntent}`}
                  {a.dependsOn && a.dependsOn.length > 0 && ` · dependsOn ${a.dependsOn.join(", ")}`}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
