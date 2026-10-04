/**
 * 记忆屏(旧 `Memory.tsx` 改接新接口)
 *
 * ── 画像段回来了(批次 16)──────────────────────────────────────
 *
 * 上一轮改造时把「用户画像」段删掉了,理由写在这里:**契约里当时没有画像这一层**
 * —— 领域类型只有记忆碎片,没有对应视图对象,也没有端点。
 *
 * 现在后端补上了(契约「HTTP 接口面」已冻结包含它),所以这一段按原样恢复:
 *
 *   GET /api/memory/fragments[?limit=] → { fragments: MemoryFragmentView[] }
 *   GET /api/profile                   → { entries: Record<string, unknown> }
 *
 * 两者是**两层,不是一个取代另一个**:片段是流水式记录(「用户说过 X」),
 * 画像是当前的结构化摘要(「用户是谁」)。所以它们并列,不合并成一个列表 ——
 * 合并会丢掉「这条是概括还是原话」这个区别。
 *
 * `entries` 的 value 是**任意 JSON**(契约里就是 `unknown`),所以这里不猜结构:
 * 字符串按原文渲染,其余按 JSON 渲染;后端在解析失败时如实回的
 * `{ __unparsable: true }` 标记也照实说明,不装作正常。
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

/** 后端解析不了某条画像时回的标记 —— 如实说明,不装作正常。 */
function isUnparsable(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>)["__unparsable"] === true
  );
}

/** 画像项的 value 是任意 JSON。字符串按原文,其余按 JSON —— **不猜结构**。 */
function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v, null, 2);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

export function MemoryPage() {
  const [fragments, setFragments] = useState<MemoryFragmentView[]>([]);
  const [entries, setEntries] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  // 「还没查过」不等于「查过了,是空」—— 初值 true。
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // 两个端点**各自独立**(一条失败不该把另一条也变成空态):
      // 画像坏了不该让碎片列表消失,反之亦然。
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
    async function loadProfile() {
      try {
        const res = await api.getProfile();
        if (cancelled) return;
        const raw: unknown = res.entries;
        setEntries(
          raw !== null && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : null,
        );
        setProfileError(null);
      } catch (e) {
        if (!cancelled) setProfileError(errorMessage(e));
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    }
    void load();
    void loadProfile();
    return () => {
      cancelled = true;
    };
  }, []);

  const profileKeys = entries === null ? [] : Object.keys(entries).sort();

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
        hint="用户画像 + 记忆碎片"
        hintTitle="GET /api/profile(结构化画像)与 GET /api/memory/fragments(流水式片段)。两层互补:片段是「用户说过 X」,画像是「用户是谁」。没有条目时是空态,不展示示例。kind 是闭合联合,不扩展。"
        aside={
          <StatStrip
            items={[
              { label: "画像项", value: profileKeys.length },
              { label: "碎片", value: fragments.length },
            ]}
          />
        }
      />

      {error !== null ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : null}

      <Section
        title="用户画像"
        count={profileKeys.length}
        hint="结构化摘要 · 与碎片互补"
        hintTitle="来源:GET /api/profile → { entries }。value 是任意 JSON,本页不猜它的结构:字符串按原文渲染,其余按 JSON 渲染。"
      >
        {profileError !== null ? (
          <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
            加载失败:{profileError}
          </div>
        ) : profileLoading ? (
          <EmptyState>加载中…</EmptyState>
        ) : profileKeys.length === 0 ? (
          <EmptyState>暂无用户画像 —— 还没沉淀出「用户是谁」这一层。</EmptyState>
        ) : (
          <div className="grid gap-1.5">
            {profileKeys.map((key) => {
              const value = entries?.[key];
              const broken = isUnparsable(value);
              const text = stringifyValue(value);
              const long = text.length > 120;
              return (
                <div key={key} className="sansheng-card p-2">
                  <div className="ss-meta font-mono truncate" title={key}>
                    {key}
                  </div>
                  {broken ? (
                    <div className="ss-note" style={{ color: "var(--cinnabar)" }}>
                      这一项的 JSON 在库里解析失败 —— 后端如实回了 {"{ __unparsable: true }"},没有原文可显示。
                    </div>
                  ) : long ? (
                    <>
                      <Clamp lines={3}>{text}</Clamp>
                      <Disclosure summary="全文">
                        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>
                          {text}
                        </pre>
                      </Disclosure>
                    </>
                  ) : (
                    <div className="ss-body" style={{ color: "var(--bone)" }}>
                      {text}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="碎片" count={fragments.length} hint="流水式记录">
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
