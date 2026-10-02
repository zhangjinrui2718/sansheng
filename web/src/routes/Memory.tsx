/**
 * Sansheng · 记忆页(批次 UI U4 收敛)
 *
 * 改之前这页是**两个没有区分度的平铺列表**:每条画像一个卡片、每条碎片一个卡片,
 * 没有计数、没有分组、中文页面标题里混着英文 section 名 —— 读者看不出「系统记得
 * 什么、记得多少」。收敛后:
 *   · 抬头一行给出**真实计数**(画像 N / 碎片 N,都是本次 payload 的 length);
 *   · 画像按「键 / 值」两列排(键是 profile.key 原文,值是 profile.value);
 *   · 碎片按 kind 分组,组内按 createdAt 倒序,每组一个真实 count;
 *   · 碎片正文默认截断 3 行,长的点开看全文 —— 首屏不再被整段内容推走。
 *
 * ── 数据源(两个只读端点,一次 `Promise.all` 并发拉取,行为与改前逐字等价)────
 *   GET /api/profile            → { profile: ProfileEntry[] }
 *     后端真实字段(src/server/storage/repo/profile.ts 的 `ProfileEntry`):
 *       key / value / confidence / effectiveConfidence(按天衰减后的当前值)/
 *       observedAt / lastReinforcedAt / evidenceCount / metadata。
 *       页面**只画 key + value**;置信度 / 证据条数 / 观察时间是真数据,放进该行的
 *       `title=`,不占正文。`listProfile` 只返回 effectiveConfidence ≥ 0.1 的条目。
 *   GET /api/memory/fragments   → { fragments: FragmentRow[] }(默认 limit=100,
 *       createdAt DESC)。真实字段(同 repo/fragments.ts):id / kind / content /
 *       importance / decayFactor / accessCount / lastAccessedAt / createdAt / metadata。
 *
 * ── 反造假纪律 ────────────────────────────────────────────────────────────
 *   1. **不造示例条目**:profile / fragments 没有就是空态,一句话说明「什么情况下会有」。
 *   2. **每个数字都来自真实数组**:抬头计数 = 两个数组的 length;分组计数 = 该组
 *      filter 后的 length。不做估算、不显示「上次同步于」之类没有来源的时间。
 *   3. **kind 是闭合 union**(`fact|preference|project|context|summary`,见
 *      FRAGMENT_KINDS),本文件只为这 5 个值准备中文标签;将来若后端扩展,
 *      未知 kind 原样显示英文,**不猜含义**。
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

interface ProfileEntry {
  key: string;
  value: string;
  confidence?: number;
  effectiveConfidence?: number;
  observedAt?: number;
  evidenceCount?: number;
}

interface FragmentRow {
  id: string;
  kind: "fact" | "preference" | "project" | "context" | "summary";
  content: string;
  importance?: number;
  accessCount?: number;
  createdAt: number;
}

/** 闭合 union(AGENTS.md 纪律:FragmentRow.kind 不可扩展)。分组顺序即展示顺序。 */
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

/** 画像行的 `title=`:全部是后端真实字段,拼不出来就少拼一段,不填 0。 */
function profileTitle(p: ProfileEntry): string {
  const bits: string[] = [];
  const conf = p.effectiveConfidence ?? p.confidence;
  if (typeof conf === "number") bits.push(`置信度 ${conf.toFixed(2)}`);
  if (typeof p.evidenceCount === "number") bits.push(`证据 ${p.evidenceCount} 条`);
  if (typeof p.observedAt === "number") {
    bits.push(`观察于 ${new Date(p.observedAt).toLocaleString()}`);
  }
  return bits.length > 0 ? bits.join(" · ") : p.key;
}

export function MemoryPage() {
  const [profile, setProfile] = useState<ProfileEntry[]>([]);
  const [fragments, setFragments] = useState<FragmentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [profRes, fragRes] = await Promise.all([
          fetch("/api/profile").then((r) => r.json()),
          fetch("/api/memory/fragments").then((r) => r.json()),
        ]);
        if (cancelled) return;
        setProfile(Array.isArray(profRes?.profile) ? profRes.profile : []);
        setFragments(Array.isArray(fragRes?.fragments) ? fragRes.fragments : []);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // 按 kind 分组;组内 createdAt 倒序。分组只依据本次真实返回的 kind 值。
  const groups = new Map<string, FragmentRow[]>();
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
        hint="来自 /api/profile 与 /api/memory/fragments"
        hintTitle="GET /api/profile 与 GET /api/memory/fragments;没有条目时是空态,不展示示例。"
        aside={
          <StatStrip
            items={[
              { label: "画像", value: profile.length },
              { label: "碎片", value: fragments.length },
            ]}
          />
        }
      />

      {error ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : null}

      <Section title="画像" count={profile.length}>
        {loading ? (
          <EmptyState>加载中…</EmptyState>
        ) : profile.length === 0 ? (
          <EmptyState>暂无画像条目。</EmptyState>
        ) : (
          <div className="sansheng-card px-3 py-1.5 grid gap-0">
            {profile.map((p, i) => (
              <div
                key={p.key}
                title={profileTitle(p)}
                className="grid gap-x-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-baseline py-1.5"
                style={i > 0 ? { borderTop: "1px solid var(--ink-3)" } : undefined}
              >
                <span className="ss-meta truncate">{p.key}</span>
                <span className="ss-body" style={{ color: "var(--bone)" }}>
                  {p.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="碎片" count={fragments.length}>
        {loading ? (
          <EmptyState>加载中…</EmptyState>
        ) : fragments.length === 0 ? (
          <EmptyState>暂无记忆碎片。</EmptyState>
        ) : (
          <div className="grid gap-4">
            {grouped.map(({ kind, rows }) => (
              // 原始 kind 保留在 title=,页面上只出现中文标签
              <div key={kind} title={kind}>
                <Section title={kindLabel(kind)} count={rows.length}>
                  <div className="grid gap-1.5">
                    {rows.map((f) => {
                      const meta: string[] = [new Date(f.createdAt).toLocaleString()];
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
