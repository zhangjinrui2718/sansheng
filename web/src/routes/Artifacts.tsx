/**
 * 工件屏(旧 `Artifacts.tsx` 改接新接口)
 *
 * ── 数据面换掉了什么 ────────────────────────────────────────────
 *
 * 旧:`GET /api/artifacts?conversationId=&limit=200` → blackboard 的 Artifact
 * (scope / conversationId / refs / executors / dependsOn / parentIntent / metadata)。
 * 新:`GET /api/artifacts[?projectId=&kind=&status=&limit=]` → **ArtifactView**
 * (projectId / kind / status / authorName / links),过滤维度从「会话」换成「项目」。
 *
 * ── 词表也换掉了 ────────────────────────────────────────────────
 *
 * 旧 KIND_LABEL 认的是 intent / todo / critique / reflection 这些**计划时代**的
 * kind(计划已删),新的 kind 闭集见契约 ArtifactKind(decision / note / evidence /
 * hypothesis / project_brief / work_brief / meeting_note / review_finding /
 * change_record / client_question),标签统一在 `lib/vocab.ts`。
 *
 * 呈现:先在页首**选定一个项目**(契约没有跨项目的 `/api/artifacts` ——
 * 「工件总是属于某个项目,提供平级列表等于邀请调用方绕过项目这个组织维度」),
 * 再按 kind 分组。分组只依据**本次真实返回的 kind**;未知 kind 原样显示英文。
 */
import { useEffect, useMemo, useState } from "react";
import type { ArtifactKind } from "@shared/types/platform";
import {
  Clamp,
  Disclosure,
  EmptyState,
  PageHeader,
  Pill,
  Section,
  StatStrip,
  toneColor,
} from "@/components/ui/primitives";
import { useArtifacts } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import {
  artifactKindLabel,
  artifactKindTone,
  artifactStatusLabel,
  artifactStatusTone,
  fmtTime,
} from "@/lib/vocab";

/** 展示顺序:结论类优先,过程类靠后。表里没有的 kind 落在末尾(不丢)。 */
const KIND_ORDER: ArtifactKind[] = [
  "decision",
  "project_brief",
  "work_brief",
  "evidence",
  "review_finding",
  "change_record",
  "meeting_note",
  "hypothesis",
  "client_question",
  "note",
];

export function ArtifactsPage() {
  const projects = useChatStore((s) => s.projects);
  const activeProjectId = useChatStore((s) => s.projectId);
  const [scope, setScope] = useState<string | null>(activeProjectId);

  useEffect(() => {
    // 用户在对话页切了项目 → 工件页跟着切(不然会对着旧项目的工件发呆)。
    setScope(activeProjectId);
  }, [activeProjectId]);

  const { data: artifacts, loading, error } = useArtifacts({ projectId: scope });

  const groups = useMemo(() => {
    const byKind = new Map<string, typeof artifacts>();
    for (const a of artifacts) {
      const bucket = byKind.get(a.kind);
      if (bucket) bucket.push(a);
      else byKind.set(a.kind, [a]);
    }
    return [...byKind.entries()]
      .sort((x, y) => {
        const ix = KIND_ORDER.indexOf(x[0] as ArtifactKind);
        const iy = KIND_ORDER.indexOf(y[0] as ArtifactKind);
        return (ix === -1 ? KIND_ORDER.length : ix) - (iy === -1 ? KIND_ORDER.length : iy);
      })
      .map(([kind, rows]) => ({
        kind,
        rows: [...rows].sort((a, b) => b.createdAt - a.createdAt),
      }));
  }, [artifacts]);

  const scopeName =
    scope === null ? "未选项目" : projects.find((p) => p.id === scope)?.name ?? scope;

  return (
    <div className="ss-page">
      <PageHeader
        title="工件"
        hint={`范围:${scopeName}`}
        hintTitle="数据来源:GET /api/projects/:id/artifacts(可带 kind / status / limit)。契约没有跨项目的 /api/artifacts。kind / status 是契约里的闭合集合。"
        aside={
          <div className="flex items-center gap-1.5 flex-wrap">
            <select
              value={scope ?? ""}
              onChange={(e) => setScope(e.target.value === "" ? null : e.target.value)}
              style={{
                background: "var(--ink-1)",
                border: "1px solid var(--ink-3)",
                borderRadius: 4,
                padding: "2px 4px",
                color: "var(--bone-dim)",
                fontSize: 11,
              }}
              title="选择项目"
            >
              <option value="">选择项目…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <StatStrip items={[{ label: "共", value: artifacts.length }]} />
          </div>
        }
      />

      {scope === null ? (
        <EmptyState>先在「对话」页的左栏选一个项目,或在上面的选择器里挑一个。</EmptyState>
      ) : error !== null ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : loading && artifacts.length === 0 ? (
        <EmptyState>加载中…</EmptyState>
      ) : artifacts.length === 0 ? (
        <EmptyState>这个项目还没有工件。项目跑起来后,决策 / 证据 / 简报会落在这里。</EmptyState>
      ) : (
        <div className="grid gap-4">
          {groups.map(({ kind, rows }) => (
            <Section key={kind} title={artifactKindLabel(kind)} count={rows.length} hint={kind}>
              <div className="grid gap-1.5">
                {rows.map((a) => {
                  const long = a.body.length > 120;
                  return (
                    <article key={a.id} className="sansheng-card p-2.5" title={a.id}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 2,
                            flex: "0 0 auto",
                            background: toneColor(artifactKindTone(a.kind)),
                          }}
                        />
                        <Pill tone={artifactStatusTone(a.status)}>{artifactStatusLabel(a.status)}</Pill>
                        <span className="ss-body" style={{ color: "var(--bone)" }}>
                          {a.title || "(无标题)"}
                        </span>
                        <span className="ss-meta ml-auto">{a.authorName || a.authorAgentId}</span>
                      </div>
                      {a.body.length > 0 && a.body !== a.title && (
                        <>
                          <Clamp lines={2} style={{ marginTop: 4 }}>
                            {a.body}
                          </Clamp>
                          {long && (
                            <Disclosure summary="全文">
                              <div style={{ whiteSpace: "pre-wrap" }}>{a.body}</div>
                            </Disclosure>
                          )}
                        </>
                      )}
                      <div className="ss-meta mt-1">
                        {fmtTime(a.createdAt)}
                        {a.links.length > 0 &&
                          ` · 关联 ${a.links.map((l) => `${l.rel}→${l.targetId}`).join(" · ")}`}
                      </div>
                    </article>
                  );
                })}
              </div>
            </Section>
          ))}
        </div>
      )}
    </div>
  );
}
