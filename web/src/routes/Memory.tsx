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
 *
 * ── 第三段「知识语料」(2026-10-08)────────────────────────────────
 *
 * 用户把**只读检索语料**(设计 `docs/DESIGN-KNOWLEDGE.md`)的读面放在了这里。它**不是记忆**:
 *
 *   记忆  关于**用户**(偏好 / 事实),模型写、**会淡忘**;
 *   语料  关于**项目 / 组织**(工件正文 + 对话正文),**平台索引、agent 只读、不淡忘**。
 *
 * 所以它是**独立的一段**,不并进上面两张列表 —— 并进去会丢掉「这条是用户说的,还是项目里
 * 写过的」这个区别。这一段要回答的问题是**「这个机制有没有在正常运行」**,所以它先给判据
 * (见 `lib/knowledgeState.ts` 的 `corpusStatus`:读不到 > 索引坏了 > 空 > 落后 > 正常),
 * 再给量级与时效,最后才是明细检索。
 */
import { useEffect, useState } from "react";
import {
  Clamp,
  Disclosure,
  EmptyState,
  PageHeader,
  Pill,
  Section,
  StatStrip,
} from "@/components/ui/primitives";
import type { KnowledgeChunkView, KnowledgeOverviewView, MemoryFragmentView } from "@shared/types/platform";
import * as api from "@/lib/api";
import { errorMessage } from "@/lib/api";
import { corpusStatus, corpusTone, fmtSpan, pendingTotal } from "@/lib/knowledgeState";
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

/**
 * 明细区一次取多少块。
 *
 * 一处定义两处用(请求 + 屏幕上那句「最近索引的 N 块」直接读响应长度)——
 * 分开写会得到「请求 10 条、标签说 20 条」这种只有对着看才发现的不一致。
 */
const CHUNK_PAGE_SIZE = 10;

/** 明细区的输入 / 按钮样式 —— 沿用 Works.tsx 那处 select 的 token(不新增配色体系)。 */
const FILTER_INPUT_STYLE = {
  background: "var(--ink-1)",
  border: "1px solid var(--ink-3)",
  borderRadius: 4,
  padding: "2px 4px",
  color: "var(--bone-dim)",
  fontSize: 11,
} as const;

const FILTER_BUTTON_STYLE = {
  ...FILTER_INPUT_STYLE,
  cursor: "pointer",
} as const;

export function MemoryPage() {
  const [fragments, setFragments] = useState<MemoryFragmentView[]>([]);
  const [entries, setEntries] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  // 「还没查过」不等于「查过了,是空」—— 初值 true。
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);

  // ── 知识语料(独立于上面两条:它坏了不该让记忆那两段变成空态)──
  const [knowledge, setKnowledge] = useState<KnowledgeOverviewView | null>(null);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(true);
  const [q, setQ] = useState("");
  const [chunkProject, setChunkProject] = useState<string | null>(null);
  const [chunks, setChunks] = useState<KnowledgeChunkView[] | null>(null);
  const [chunksError, setChunksError] = useState<string | null>(null);
  const [chunksLoading, setChunksLoading] = useState(false);

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
    async function loadKnowledge() {
      try {
        const res = await api.getKnowledgeOverview();
        if (!cancelled) { setKnowledge(res); setKnowledgeError(null); }
      } catch (e) {
        if (!cancelled) setKnowledgeError(errorMessage(e));
      } finally {
        if (!cancelled) setKnowledgeLoading(false);
      }
    }
    async function loadInitialChunks() {
      setChunksLoading(true);
      try {
        // 不传 q = **按时间浏览**最近索引的块(合法用法,不是"空检索")
        const res = await api.listKnowledgeChunks({ limit: CHUNK_PAGE_SIZE });
        if (!cancelled) { setChunks(res.chunks); setChunksError(null); }
      } catch (e) {
        if (!cancelled) setChunksError(errorMessage(e));
      } finally {
        if (!cancelled) setChunksLoading(false);
      }
    }
    void load();
    void loadProfile();
    void loadKnowledge();
    void loadInitialChunks();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 明细:有 `query` 走检索,没有则按时间浏览。**错误原样显示**,别说成「没有结果」。 */
  async function loadChunks(query: string, projectId: string | null): Promise<void> {
    setChunksLoading(true);
    try {
      const res = await api.listKnowledgeChunks({
        ...(query.trim() !== "" ? { q: query } : {}),
        ...(projectId !== null ? { projectId } : {}),
        limit: CHUNK_PAGE_SIZE,
      });
      setChunks(res.chunks);
      setChunksError(null);
    } catch (e) {
      // ⚠️ 不清空上一次的结果:一次「查询词太短」不该把屏幕上已有的东西抹掉,
      // 那会让「参数错了」看起来像「语料没了」。
      setChunksError(errorMessage(e));
    } finally {
      setChunksLoading(false);
    }
  }

  const profileKeys = entries === null ? [] : Object.keys(entries).sort();
  // ⚠️ **读不到也要有状态** —— 那是这一段最该说清楚的一种情况,所以判据不依赖 corpus 非空。
  const corpus = knowledge === null ? null : corpusStatus(knowledge);

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
        hint="用户画像 + 记忆碎片 + 知识语料"
        hintTitle="三段是**两套东西**:画像 / 碎片来自 GET /api/profile 与 /api/memory/fragments —— 关于**用户**,模型写、会淡忘;知识语料来自 GET /api/knowledge —— 关于**项目 / 组织**,平台索引、agent 只读、不淡忘(设计 docs/DESIGN-KNOWLEDGE.md)。没有条目时是空态,不展示示例。kind 是闭合联合,不扩展。"
        aside={
          <StatStrip
            items={[
              { label: "画像项", value: profileKeys.length },
              { label: "碎片", value: fragments.length },
              {
                label: "语料块",
                value: knowledge === null ? "—" : knowledge.runtime === "ok" ? knowledge.chunks : "读不到",
                tone: knowledge !== null && knowledge.runtime === "ok" ? "jade" : "mute",
                title: "知识语料的块数;读不到 ≠ 0",
              },
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

      <Section
        title="知识语料"
        count={knowledge !== null && knowledge.runtime === "ok" ? knowledge.chunks : undefined}
        hint="关于项目 / 组织 · 平台索引 · agent 只读"
        hintTitle={
          "它**不是记忆**:记忆关于**用户**(偏好 / 事实,模型写、会淡忘),语料关于**项目 / 组织**" +
          "(工件正文 + 对话正文,平台在回合边界与启动时索引、不淡忘、agent 只读)。" +
          "这里有三个问题:量级(多少块 / 覆盖多少项目)、时效(上次索引多久前、落后多少)、" +
          "机制状态(行与 FTS 索引是否一致 / 有没有来源还没进)。明细走下面的检索。" +
          "来源:GET /api/knowledge 与 GET /api/knowledge/chunks(q 有值 = 检索,没值 = 按时间浏览)。"
        }
      >
        {knowledgeError !== null ? (
          <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
            加载失败:{knowledgeError}
          </div>
        ) : knowledgeLoading || knowledge === null || corpus === null ? (
          <EmptyState>加载中…</EmptyState>
        ) : (
          <div className="grid gap-3">
            {/* ① 机制状态:一行判据 + 量级 / 时效 */}
            <div className="sansheng-card p-2 grid gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <Pill tone={corpusTone(corpus.level)} title={corpus.detail}>
                  {corpus.label}
                </Pill>
                <span className="ss-note">{corpus.detail}</span>
              </div>
              <StatStrip
                items={[
                  { label: "语料块", value: knowledge.chunks },
                  {
                    label: "来源",
                    value: `${knowledge.sourcesIndexed.artifacts} 工件 + ${knowledge.sourcesIndexed.messages} 消息`,
                    title: "已进语料的**来源条数**(不是块数:一份工件会被切成多块)",
                  },
                  {
                    label: "待索引",
                    value: pendingTotal(knowledge),
                    tone: pendingTotal(knowledge) > 0 ? "amber" : "jade",
                    title: "库里有、语料里还没有的来源数。它给 0 才说明索引跟得上。",
                  },
                  {
                    label: "FTS 索引",
                    value: knowledge.ftsRows,
                    tone: knowledge.ftsRows === knowledge.chunks ? "jade" : "cinnabar",
                    title: "与「语料块」必须相等;不等 = 索引损坏",
                  },
                  {
                    label: "覆盖项目",
                    value: `${knowledge.projects.filter((p) => p.chunks > 0).length} / ${knowledge.projects.length}`,
                    title: "有语料的项目数 / 项目总数 —— 只给数,不列项目(这一页是跨项目的面)",
                  },
                  {
                    label: "上次索引",
                    value: knowledge.lastIndexedAt === null ? "从未" : `${fmtSpan(knowledge.at - knowledge.lastIndexedAt)}前`,
                  },
                  {
                    label: "落后",
                    value: knowledge.lagMs === null ? "—" : fmtSpan(knowledge.lagMs),
                    tone: (knowledge.lagMs ?? 0) > 0 ? "amber" : "jade",
                    title: "最新来源 与 上次索引 之间的时间差",
                  },
                ]}
              />
            </div>

            {/* ② 待索引的是**哪几条**(数字之外要能看到明细,不然只能靠猜) */}
            {knowledge.pending.preview.length > 0 ? (
              <div className="sansheng-card p-2 grid gap-1">
                <div className="ss-meta">还没进语料的来源(最多列 5 条)</div>
                {knowledge.pending.preview.map((r) => (
                  <div key={`${r.sourceKind}:${r.sourceId}`} className="ss-note truncate" title={r.sourceId}>
                    [{r.sourceKind === "artifact" ? "工件" : "消息"}] {r.label}
                  </div>
                ))}
              </div>
            ) : null}

            {/* ③ 明细:检索(有 q)或浏览(没 q)。
                ⚠️ 项目这一维只作为这里的**筛选控件**出现,不在概览里铺开 ——
                这一页是跨项目的面,把某个项目的名字与它的量摆上来会读成"这页在讲那个项目"。 */}
            <div className="sansheng-card p-2 grid gap-2">
              <form
                className="flex items-center gap-2 flex-wrap"
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadChunks(q, chunkProject);
                }}
              >
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="检索语料(中文至少 2 个字)…"
                  style={FILTER_INPUT_STYLE}
                  aria-label="检索知识语料"
                />
                <select
                  value={chunkProject ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : e.target.value;
                    setChunkProject(v);
                    void loadChunks(q, v);
                  }}
                  style={FILTER_INPUT_STYLE}
                  aria-label="按项目过滤"
                >
                  <option value="">全部项目</option>
                  {knowledge.projects.map((row) => (
                    <option key={row.projectId} value={row.projectId}>
                      {row.name}
                    </option>
                  ))}
                </select>
                <button type="submit" style={FILTER_BUTTON_STYLE}>
                  查询
                </button>
                {q.trim() !== "" ? (
                  <button
                    type="button"
                    style={FILTER_BUTTON_STYLE}
                    onClick={() => {
                      setQ("");
                      void loadChunks("", chunkProject);
                    }}
                  >
                    清空
                  </button>
                ) : null}
              </form>

              {chunksError !== null ? (
                <div className="ss-note" style={{ color: "var(--cinnabar)" }}>
                  {chunksError}
                </div>
              ) : null}

              {chunksLoading ? (
                <EmptyState>查询中…</EmptyState>
              ) : chunks === null ? null : chunks.length === 0 ? (
                <EmptyState>
                  {q.trim() === ""
                    ? "这个范围里还没有语料。"
                    : `没有匹配「${q}」的块 —— 换一个词,别把「没搜到」当成「项目里没有」。`}
                </EmptyState>
              ) : (
                <div className="grid gap-1.5">
                  <div className="ss-meta">
                    {q.trim() === "" ? `最近索引的 ${chunks.length} 块` : `命中 ${chunks.length} 块`}
                    {chunkProject !== null ? " · 已按项目过滤" : ""}
                  </div>
                  {chunks.map((c) => (
                    <div key={c.id} className="sansheng-card p-2 grid gap-1">
                      <div className="ss-meta truncate" title={`${c.id} · ${c.sourceId}`}>
                        [{c.sourceKind === "artifact" ? "工件" : "消息"}]{" "}
                        {c.artifactTitle ?? c.messageId ?? c.sourceId}
                        {c.projectName !== null ? ` · ${c.projectName}` : ""}
                        {c.bodyPath !== null
                          ? ` · ${c.bodyPath}${c.commitSha !== null ? `@${c.commitSha.slice(0, 8)}` : ""}`
                          : ""}
                        {` · [${c.offset}, ${c.offset + c.length})`}
                      </div>
                      {/* ⚠️ 三态:不是 ok 就都不是「空正文」 */}
                      {c.state !== "ok" ? (
                        <div className="ss-note" style={{ color: "var(--cinnabar)" }}>
                          {c.state === "unavailable"
                            ? "读不到正文"
                            : "索引记的那一段与来源现在的内容不一致(drifted)"}
                          :{c.problem}
                        </div>
                      ) : null}
                      {c.state === "unavailable" ? null : (
                        <>
                          <Clamp lines={3}>{c.excerpt}</Clamp>
                          <Disclosure summary="全文">{c.text}</Disclosure>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
