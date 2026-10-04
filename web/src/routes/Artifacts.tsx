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
 * change_record / client_question / deliverable),标签统一在 `lib/vocab.ts`。
 * ⚠️ 这份括号里的清单是**注释**,不是守卫 —— 真正的守卫是 `vocab.ts` 的
 * `Record<ArtifactKind, …>`(漏一个 `tsconfig.web.json` 就红)。
 *
 * 呈现:先在页首**选定一个项目**(契约没有跨项目的 `/api/artifacts` ——
 * 「工件总是属于某个项目,提供平级列表等于邀请调用方绕过项目这个组织维度」),
 * 再按 kind 分组。分组只依据**本次真实返回的 kind**;未知 kind 原样显示英文。
 *
 * ── 点开看详情(本次新加)────────────────────────────────────────
 *
 * 列表里的 body 是截断的,而工件的价值大半在全文与**关联关系**上。所以每条可以
 * 展开:展开时按 id 拉一次 `GET /api/artifacts/:id`(`{ artifact: ArtifactView }`),
 * 显示 body 全文 + links 出边(rel → targetId)。
 *
 * **详情单独拉一次,不拿列表里那条凑** —— 契约给了 `/:id` 这条端点,它的存在
 * 意义就是「列表里的字段可能不是全量」;用列表项假装详情,等于把契约里的那条
 * 端点变成死代码。
 *
 * 关联目标只显示 id(契约 `ArtifactView.links` 只有 `targetId`,没有目标标题);
 * 若目标恰好在本次已加载的列表里,顺手把它的标题带上 —— **不做二次请求**。
 */
import { useEffect, useMemo, useState } from "react";
import type { ArtifactKind, ArtifactView } from "@shared/types/platform";
import {
  Clamp,
  Disclosure,
  EmptyState,
  KV,
  PageHeader,
  Pill,
  Section,
  StatStrip,
  toneColor,
} from "@/components/ui/primitives";
import { useArtifacts } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import { errorMessage, getArtifact } from "@/lib/api";
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
  // 交付物是整合的产物,与 decision / *_brief 同属「结论类」,排在过程类之前。
  "deliverable",
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
  /** 展开查看详情的那条工件 id(null = 都收起)。 */
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    // 用户在对话页切了项目 → 工件页跟着切(不然会对着旧项目的工件发呆)。
    setScope(activeProjectId);
    setOpenId(null);
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
                  const open = openId === a.id;
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
                        <button
                          type="button"
                          className="sansheng-button"
                          style={{ padding: "1px 8px", fontSize: 11 }}
                          title="按 id 拉 GET /api/artifacts/:id,看正文全文与关联关系"
                          onClick={() => setOpenId(open ? null : a.id)}
                        >
                          {open ? "收起" : "详情"}
                        </button>
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
                      {open && <ArtifactDetail id={a.id} known={artifacts} />}
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

/** links 的 rel 是契约里的闭合联合(parent | depends_on | answers);未知值原样透出。 */
const REL_LABEL: Record<string, string> = {
  parent: "父工件",
  depends_on: "依赖",
  answers: "答复",
};

/**
 * 工件详情。展开时按 id 拉一次 `GET /api/artifacts/:id`。
 *
 * `known` 只用来**顺手**把关联目标的标题显示出来(目标恰好在本次列表里时),
 * 不做二次请求 —— 目标不在列表里就只显示 id,不编一个标题出来。
 */
function ArtifactDetail({ id, known }: { id: string; known: ArtifactView[] }) {
  const [artifact, setArtifact] = useState<ArtifactView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setArtifact(null);
    setError(null);
    getArtifact(id)
      .then((r) => {
        if (cancelled) return;
        setArtifact(r.artifact);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const titleOf = (targetId: string): string | null =>
    known.find((k) => k.id === targetId)?.title ?? null;

  return (
    <div
      className="mt-2"
      style={{ borderTop: "1px solid var(--ink-3)", paddingTop: 6 }}
      title="GET /api/artifacts/:id"
    >
      {error !== null ? (
        <div className="text-xs" style={{ color: "var(--cinnabar)" }}>
          详情加载失败:{error}
        </div>
      ) : loading ? (
        <div className="ss-meta">详情加载中…</div>
      ) : artifact === null ? (
        <div className="ss-meta">读不到这条工件的详情。</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Pill tone={artifactKindTone(artifact.kind)} title={artifact.kind}>
              {artifactKindLabel(artifact.kind)}
            </Pill>
            <Pill tone={artifactStatusTone(artifact.status)} title={artifact.status}>
              {artifactStatusLabel(artifact.status)}
            </Pill>
            <span className="ss-body" style={{ color: "var(--bone)" }}>
              {artifact.title || "(无标题)"}
            </span>
            <span className="ss-meta ml-auto">
              {artifact.authorName || artifact.authorAgentId} · {fmtTime(artifact.createdAt)}
            </span>
          </div>

          {artifact.body.length > 0 ? (
            <>
              <div className="ss-section" style={{ fontSize: 12 }}>
                正文
              </div>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 12,
                  lineHeight: 1.7,
                  margin: 0,
                  padding: "6px 8px",
                  background: "var(--ink-1)",
                  border: "1px solid var(--ink-3)",
                  borderRadius: 6,
                  color: "var(--bone-dim)",
                  maxHeight: 420,
                  overflow: "auto",
                }}
              >
                {artifact.body}
              </pre>
            </>
          ) : (
            <div className="ss-note">这条工件没有正文(body 为空)。</div>
          )}

          <div>
            <div className="ss-section" style={{ fontSize: 12 }}>
              关联({artifact.links.length})
            </div>
            {artifact.links.length === 0 ? (
              <div className="ss-note">没有出边 —— 这条工件不挂在别的工件上。</div>
            ) : (
              <div className="flex flex-col">
                {artifact.links.map((l) => {
                  const t = titleOf(l.targetId);
                  return (
                    <KV
                      key={`${l.rel}:${l.targetId}`}
                      label={REL_LABEL[l.rel] ?? l.rel}
                      value={t ?? l.targetId}
                      title={t !== null ? l.targetId : "该目标不在本次列表里,只显示 id"}
                    />
                  );
                })}
              </div>
            )}
          </div>

          <Disclosure summary="原始字段">
            <div className="flex flex-col gap-0.5">
              <span>工件 id:{artifact.id}</span>
              <span>项目 id:{artifact.projectId}</span>
              <span>kind:{artifact.kind}</span>
              <span>status:{artifact.status}</span>
              <span>作者 id:{artifact.authorAgentId}</span>
              <span>作者名(authorName):{artifact.authorName}</span>
              <span>创建:{fmtTime(artifact.createdAt)}</span>
              <span>更新:{fmtTime(artifact.updatedAt)}</span>
            </div>
          </Disclosure>
        </div>
      )}
    </div>
  );
}
