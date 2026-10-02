/**
 * Sansheng · Harness 页(批次 UI U1)
 *
 * 数据源:`GET /api/harness`(批次 5b-2 已有,src/server/http.ts:244,只读)。
 * 真实返回结构(已由冒烟 curl 逐字段验证):
 *   manager  : { running, stats{received,processed,failed,skippedSeen,skippedStorageDedup,
 *                                skippedInFlight,seenSize,inFlightSize},
 *                decideSource: "production-llm"|"injected", startedAt }
 *   prompts  : Array<{ role, lines, chars, state:"default"|"legacy_factory"|"user_edited"|"empty" }>
 *              (6 角色;state=user_edited = 用户编辑过,ensureHarness 永不覆盖)
 *   harnessManagerPrompt : { source, lines, editable, note }
 *   config   : { enabledTools[], redLines[], budget{maxIterations,perStepTimeoutMs,maxCostUsd} }
 *   proposals / previews : BlackboardArtifact[] —— 持久化在 blackboard storage(scope=global)
 *   notes    : string[] —— server 如实交代语义边界
 *
 * ⚠️ 反造假纪律:proposals 当前**生产无发射点**(executor D13 发射路径待 5c),
 *   所以本页如实显示空态,并把 server 给的 notes 原样展示(其中明确写着
 *   「当前无 harness_proposal 生产发射点…manager 已订阅 artifact_created 待命」),
 *   **不造任何假条目**。manager 计数是内存态(重启清零)—— 页面上标注清楚。
 *
 * 视觉:沿用既有页面骨架 + 设计 token,不引入新设计语言。
 */
import { useCallback, useEffect, useState } from "react";

interface HarnessPromptInfo {
  role: string;
  lines: number;
  chars: number;
  state: "default" | "legacy_factory" | "user_edited" | "empty";
}

interface HarnessStats {
  received: number;
  processed: number;
  failed: number;
  skippedSeen: number;
  skippedStorageDedup: number;
  skippedInFlight: number;
  seenSize: number;
  inFlightSize: number;
}

interface HarnessArtifact {
  id: string;
  kind: string;
  title: string;
  body: string;
  author: string;
  status: string;
  createdAt: number;
}

interface HarnessResponse {
  manager: {
    running: boolean;
    stats: HarnessStats | null;
    decideSource: "production-llm" | "injected" | null;
    startedAt: number | null;
  };
  prompts: HarnessPromptInfo[];
  harnessManagerPrompt: { source: string; lines: number; editable: boolean; note: string };
  config: {
    enabledTools: string[];
    redLines: string[];
    budget: { maxIterations: number; perStepTimeoutMs: number; maxCostUsd: number };
  };
  proposals: HarnessArtifact[];
  previews: HarnessArtifact[];
  notes: string[];
}

const STATE_LABEL: Record<HarnessPromptInfo["state"], string> = {
  default: "默认",
  legacy_factory: "旧工厂",
  user_edited: "用户编辑过",
  empty: "空",
};

const STATE_TONE: Record<HarnessPromptInfo["state"], string> = {
  default: "var(--bone-mute)",
  legacy_factory: "var(--bone-mute)",
  user_edited: "var(--jade)",
  empty: "var(--ochre)",
};

const STAT_LABEL: Array<{ key: keyof HarnessStats; label: string }> = [
  { key: "received", label: "收到" },
  { key: "processed", label: "已处理" },
  { key: "failed", label: "失败" },
  { key: "skippedSeen", label: "去重" },
  { key: "skippedStorageDedup", label: "落库去重" },
  { key: "skippedInFlight", label: "在飞去重" },
  { key: "seenSize", label: "seen" },
  { key: "inFlightSize", label: "在飞" },
];

export function HarnessPage() {
  const [data, setData] = useState<HarnessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/harness");
      const json = (await res.json()) as HarnessResponse & {
        error?: string;
        message?: string;
      };
      if (!res.ok || json.error) {
        setError(json.message ?? json.error ?? `HTTP ${res.status}`);
        setData(null);
      } else {
        setData(json);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <main className="px-4 pb-4">
        <h2 className="sansheng-h2">Harness</h2>
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="px-4 pb-4">
        <h2 className="sansheng-h2">Harness</h2>
        <div className="sansheng-card p-4 text-sm opacity-70">{loading ? "加载中…" : "—"}</div>
      </main>
    );
  }

  const { manager, prompts, config, proposals, previews, notes, harnessManagerPrompt } = data;

  return (
    <main className="px-4 pb-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="sansheng-h2">Harness</h2>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span
            className="rounded"
            style={{
              padding: "1px 7px",
              fontSize: 10,
              background: manager.running ? "var(--jade-soft)" : "var(--ink-3)",
              color: manager.running ? "var(--jade)" : "var(--bone-mute)",
            }}
          >
            {manager.running ? "● 运行中" : "○ 未运行"}
          </span>
          <span className="sansheng-text-mute">{manager.decideSource ?? "—"}</span>
        </div>
      </div>

      <div className="grid gap-3">
        {/* Manager 运行态 */}
        <section className="sansheng-card p-4">
          <h3 className="font-medium mb-2">Manager 运行态</h3>
          <div className="sansheng-text-mute mb-2" style={{ fontSize: 11 }}>
            启动于{" "}
            {manager.startedAt ? new Date(manager.startedAt).toLocaleString() : "—"} · 计数为内存态,
            重启清零
          </div>
          {manager.stats ? (
            <div className="flex flex-wrap gap-1.5">
              {STAT_LABEL.map(({ key, label }) => (
                <span
                  key={key}
                  className="font-mono rounded"
                  style={{
                    fontSize: 10,
                    padding: "2px 7px",
                    background: "var(--ink-2)",
                    color: key === "failed" && (manager.stats?.[key] ?? 0) > 0
                      ? "var(--cinnabar)"
                      : "var(--bone-dim)",
                  }}
                >
                  {label} {manager.stats?.[key] ?? 0}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm opacity-70">manager 未启动(无 stats)。</p>
          )}
        </section>

        {/* 角色 prompt */}
        <section className="sansheng-card p-4">
          <h3 className="font-medium mb-2">角色 Prompt</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left sansheng-text-mute">
                <th style={{ fontSize: 11 }}>角色</th>
                <th style={{ fontSize: 11 }}>状态</th>
                <th style={{ fontSize: 11 }}>行</th>
                <th style={{ fontSize: 11 }}>字符</th>
              </tr>
            </thead>
            <tbody>
              {prompts.map((p) => (
                <tr key={p.role} style={{ borderTop: "1px solid var(--ink-3)" }}>
                  <td className="py-1">{p.role}</td>
                  <td>
                    <span
                      className="font-mono rounded"
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        background: "var(--ink-2)",
                        color: STATE_TONE[p.state],
                      }}
                      title={
                        p.state === "user_edited"
                          ? "用户编辑过 · ensureHarness 永不覆盖"
                          : undefined
                      }
                    >
                      {STATE_LABEL[p.state]}
                    </span>
                  </td>
                  <td className="font-mono sansheng-text-mute">{p.lines}</td>
                  <td className="font-mono sansheng-text-mute">{p.chars}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="sansheng-text-mute mt-2" style={{ fontSize: 11, lineHeight: 1.6 }}>
            manager prompt:{harnessManagerPrompt.note}
          </div>
        </section>

        {/* 配置 */}
        <section className="sansheng-card p-4">
          <h3 className="font-medium mb-2">配置</h3>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {config.enabledTools.map((t) => (
              <span
                key={t}
                className="font-mono rounded"
                style={{ fontSize: 10, padding: "2px 7px", background: "var(--ink-2)", color: "var(--bone-dim)" }}
              >
                {t}
              </span>
            ))}
          </div>
          <div className="text-xs" style={{ color: "var(--cinnabar)", lineHeight: 1.7 }}>
            {config.redLines.map((r) => (
              <div key={r}>⛔ {r}</div>
            ))}
          </div>
          <div className="sansheng-text-mute mt-2 font-mono" style={{ fontSize: 10 }}>
            budget · 迭代 {config.budget.maxIterations} · 单步 {config.budget.perStepTimeoutMs}ms · 上限 $
            {config.budget.maxCostUsd}
          </div>
        </section>

        {/* Proposals / Previews(如实展示,空就是空) */}
        <section className="sansheng-card p-4">
          <h3 className="font-medium mb-2">Proposals · Previews</h3>
          {proposals.length === 0 && previews.length === 0 ? (
            <p className="text-sm opacity-80" style={{ lineHeight: 1.7 }}>
              当前没有任何 harness_proposal / implementation_preview。
              <br />
              <span className="sansheng-text-mute" style={{ fontSize: 11 }}>
                server 说明:无生产发射点,manager 已订阅 artifact_created 待命(见下方 Notes 第 3 条)。
              </span>
            </p>
          ) : (
            <div className="grid gap-2">
              {[...proposals, ...previews].map((a) => (
                <div key={a.id} className="rounded p-2" style={{ background: "var(--ink-1)" }}>
                  <div className="font-mono sansheng-text-mute" style={{ fontSize: 10 }}>
                    {a.kind} · {a.author} · {new Date(a.createdAt).toLocaleString()}
                  </div>
                  <div className="text-sm" style={{ color: "var(--bone)" }}>
                    {a.title}
                  </div>
                  {a.body && (
                    <div className="text-xs mt-1" style={{ color: "var(--bone-dim)", whiteSpace: "pre-wrap" }}>
                      {a.body}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Notes —— server 如实交代的语义边界 */}
        <section className="sansheng-card p-4">
          <h3 className="font-medium mb-2">Notes</h3>
          <ul className="grid gap-1">
            {notes.map((n) => (
              <li key={n} className="sansheng-text-mute" style={{ fontSize: 11, lineHeight: 1.7 }}>
                · {n}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
