/**
 * 记忆屏(旧 `Memory.tsx` 改接新接口)
 *
 * ── 去掉了一半数据源 ────────────────────────────────────────────
 *
 * 旧页并发拉两个端点:`GET /api/profile`(画像)与 `GET /api/memory/fragments`。
 * 新契约的领域类型里只有**记忆碎片**(`MemoryPort` 的 remember/recall/decay),
 * 没有「画像」这一层 —— 契约里也没有对应的视图对象。所以这一页只渲染碎片。
 * (画像若仍是平台的一部分,补一个视图对象与端点即可把这一段加回来;见报告 open questions。)
 *
 * ── 端点 ────────────────────────────────────────────────────────
 *
 *   GET /api/memory/fragments[?limit=] → { fragments: MemoryFragmentView[] }
 *
 * 碎片按 kind 分组。`FragmentKind` 是闭合联合(fact|preference|project|context|summary)
 * —— 这是项目纪律,不要扩展;未知 kind 原样显示英文,不猜含义。
 */
import { useEffect, useState } from "react";
import {
  Clamp,
  Disclosure,
  EmptyState,
  PageHeader,
  Section,
  StatStrip,
} from "@/components/ui/primitives";
import type { MemoryFragmentView } from "@shared/types/platform";
import * as api from "@/lib/api";
import { errorMessage } from "@/lib/api";
import { fmtTime } from "@/lib/vocab";

const KIND_ORDER = ["fact", "preference", "project", "context", "summary"] as const;
type FragmentKind = (typeof KIND_ORDER)[number];

const KIND_LABEL: Record<FragmentKind, string> = {
  fact: "事实",
  preference: "偏好",
  project: "项目",
  context: "上下文",
  summary: "摘要",
};

/** module-level type guard:把 runtime 的 kind 字符串收窄到闭合 union。 */
function isFragmentKind(value: string): value is FragmentKind {
  return (KIND_ORDER as readonly string[]).includes(value);
}

function kindLabel(kind: string): string {
  return isFragmentKind(kind) ? KIND_LABEL[kind] : kind;
}

function kindOrder(kind: string): number {
  const i = (KIND_ORDER as readonly string[]).indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

export function MemoryPage() {
  const [fragments, setFragments] = useState<MemoryFragmentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 「还没查过」不等于「查过了,是空」—— 初值 true。
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api.listMemoryFragments();
        if (cancelled) return;
        setFragments(Array.isArray(res.fragments) ? res.fragments : []);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // 按 kind 分组;组内 createdAt 倒序。分组只依据本次真实返回的 kind 值。
  const groups = new Map<string, MemoryFragmentView[]>();
  for (const f of fragments) {
    const bucket = groups.get(f.kind);
    if (bucket) bucket.push(f);
    else groups.set(f.kind, [f]);
  }
  const grouped = [...groups.entries()]
    .sort((a, b) => kindOrder(a[0]) - kindOrder(b[0]))
    .map(([kind, rows]) => ({
      kind,
      rows: [...rows].sort((a, b) => b.createdAt - a.createdAt),
    }));

  return (
    <div className="ss-page">
      <PageHeader
        title="记忆"
        hint="来自 /api/memory/fragments"
        hintTitle="GET /api/memory/fragments。没有条目时是空态,不展示示例。kind 是闭合联合,不扩展。"
        aside={<StatStrip items={[{ label: "碎片", value: fragments.length }]} />}
      />

      {error !== null ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : null}

      <Section title="碎片" count={fragments.length}>
        {loading ? (
          <EmptyState>加载中…</EmptyState>
        ) : fragments.length === 0 ? (
          <EmptyState>暂无记忆碎片。</EmptyState>
        ) : (
          <div className="grid gap-4">
            {grouped.map(({ kind, rows }) => (
              <div key={kind} title={kind}>
                <Section title={kindLabel(kind)} count={rows.length}>
                  <div className="grid gap-1.5">
                    {rows.map((f) => {
                      const meta: string[] = [fmtTime(f.createdAt)];
                      if (typeof f.importance === "number") meta.push(`重要度 ${f.importance}`);
                      if (typeof f.accessCount === "number") meta.push(`访问 ${f.accessCount}`);
                      const long = f.content.length > 80;
                      return (
                        <div key={f.id} className="sansheng-card p-2">
                          <div className="ss-meta" title={meta.join(" · ")}>
                            {meta[0]}
                          </div>
                          {long ? (
                            <>
                              <Clamp lines={3}>{f.content}</Clamp>
                              <Disclosure summary="全文">{f.content}</Disclosure>
                            </>
                          ) : (
                            <div className="ss-body" style={{ color: "var(--bone)" }}>
                              {f.content}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Section>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
