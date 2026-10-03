/**
 * Sansheng · 工件页(批次 UI U1 · P0-B「按沟通职能」重做 → 批次 UI U4 文本分层)
 *
 * 数据源:`GET /api/artifacts?conversationId=<id>&limit=200`
 *   —— blackboard v3 artifact 的**唯一读端点**(src/server/http/blackboardRoutes.ts:74),
 *   scope 默认 conversation(全局工件在 Harness 页的 proposals/previews 里展示)。
 *   返回体已由真实 server 冒烟验证:`{ artifacts: BlackboardArtifact[] }`,
 *   单条含 id/scope/conversationId/kind/title/body/author/status/createdAt/updatedAt
 *   + 可选 refs/executors/dependsOn/parentIntent/metadata。
 *   本批(U1)**零后端改动**:不加端点、不动 DB、不动 WS 事件 —— 只是已有数据的重新组织。
 *   读取函数与 5 张词表已上收到 lib/artifacts.ts(那里说明了四份副本怎么漂移的);
 *   本页只负责「怎么排」,不再自己 fetch。
 *
 * 为什么按职能分组(docs/PRODUCT-DESIGN-2026-10-02.md §4):
 *   artifact 的 10 个 kind 是**受控词汇表**,不是聊天记录 —— 每条都带 author(谁产出)、
 *   status(生命周期状态机)、refs/dependsOn(关系)、metadata。数据模型**早就是**「挑选后的
 *   结构化产出」,上一版 UI 把它按 createdAt 倒序平铺,才让用户误以为「这里应该有聊天记录」。
 *   所以 U1 只做四件事:
 *   ① 取消时间倒序流水账,改按**沟通职能**分组(§4 表):待决 / 决策 / 证据 / 批驳 / 沉淀。
 *      §4 表未列的 `intent` / `todo` 归入「意图与待办」—— 不给它们建组就等于把真实数据
 *      藏起来(反造假:宁可多一组,不静默丢数据)。
 *      `harness_proposal` / `implementation_preview` 属 **Harness 页**,在 filter 之前就被
 *      `HARNESS_ONLY_KINDS` 剔掉,**不进任何分组**、也进不了兜底的「其它」组(§4 表末行)。
 *      若真拉到了,页首如实写一行「另有 N 个 … 在 Harness 页」,不假装它们不存在。
 *   ② 每张卡片保留「轮到 X」白话读法(§4②):工件是**带状态机的消息**,页面要能一眼看出
 *      「现在轮到谁」;`waiting_for_decision` 额外加左侧琥珀色边条。
 *   ③ 「待转述」视图 = 沟通员的**待发件箱**(§4③):`(author=executor 且 kind ∈
 *      {hypothesis, decision}) or status=waiting_for_decision`。这是「agent 和沟通员沟通」
 *      这个需求在 UI 上第一次有落点 —— 之前这个角色分工完全不可见。
 *   ④ 页首一行教学文案(§4④):工件 = 挑选后的结构化产出,聊天记录在「对话」页。
 *
 * ── U4:屏幕上文字分层(这一版的改动)────────────────────────────────────
 * 改这一版之前,页面上每张卡片挂着 3 行头 + 完整 body(pre-wrap 不截断)+ 6 段状态机轨道
 * + 一串原始 id,一个会话几十条工件时首屏根本读不到底。分层的规则只有一条:
 *   **屏幕上只留「是什么 / 轮到谁 / 正文写了什么」,其余默认收起。**
 *   - 分组说明句从页面上删掉,改挂到分组标题的 `title=`(悬停才见);
 *   - 教学文案压成页首一行 hint,长句进 `hintTitle`;
 *   - 卡片 body 截断到 3 行,原文进 `<Disclosure>展开正文`;
 *   - `parent` / `dependsOn` / `执行` 原始 id 进 `<Disclosure>关联`,
 *     一条都没有的卡片**不渲染这个折叠块**(空折叠块只是噪音);
 *   - `LifecycleTrack`(6 段灰/彩色小竖条)**整段删除**:状态 pill + 「轮到 X」已经把状态机
 *     说完了,轨道是同一句话的第二次表达,而且暗示了一条并不存在的流转历史;
 *   - 「更新 …」从脚注行移进时间那一格的 `title=`。
 * 反造假纪律**没有放松**:被移走的每一句都还能在悬停 / 点开里查到,
 * 页面上每一个数字仍然是对本次真实数组 filter 后的 length。
 *
 * 分组语义(原 GROUPS.desc,现在只出现在悬停提示与本段注释里):
 *   待决      = 卡住等人拍板的工作 —— 执行员提的假设,状态到「等决策」的最需要先看。
 *   意图与待办 = 规划员落的意图与 DAG 步骤(§4 分组表未列,归此处以免真实数据被藏起来)。
 *   决策      = 已定、具约束力的结论。
 *   证据      = 执行员的观察产出。
 *   批驳      = 评审结论。
 *   沉淀      = 跑完之后活下来的长期记忆(笔记 / 反思)。
 *   其它      = 不属于任何已知分组的 kind(新 kind 加入时落这里,不会被静默丢掉)。
 *   待转述    = 沟通员的待发件箱 —— 执行员产出的假设 / 决策,以及任何挂在「等决策」上的工件。
 *
 * 实时性:WS 的 artifact_created / artifact_status_changed / plan_done 经 chat store
 *   汇总成 artifactRevision 计数(与既有 historyRefreshTrigger 同款模式),`useArtifacts` 依赖
 *   它回查。**不把 artifact 本体塞进 store** —— 权威数据永远回查后端,避免两份真相。
 *
 * 视觉:根元素改 `<div className="ss-page">` —— App 的非对话路由外壳已经提供滚动容器与
 *   `<main>`,页面再自带 `<main>` 就是嵌套 <main>(非法 HTML)。字号层级改用 components/ui/
 *   primitives 的 ss-* class,颜色只用 tokens.css 既有变量,无新配色 / 无新字体 / 无新间距体系,
 *   UI 标签一律不用 emoji。
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ARTIFACT_KINDS } from "@shared/types/blackboard";
import type { ArtifactKind } from "@shared/types/blackboard";
import {
  PLAN_HOWTO,
  STATUS_TURN,
  authorLabel,
  fmtTime,
  kindLabel,
  kindTone,
  statusLabel,
  statusTone,
  useArtifacts,
} from "@/lib/artifacts";
import type { Artifact } from "@/lib/artifacts";
import {
  Clamp,
  Disclosure,
  EmptyState,
  PageHeader,
  Pill,
  StatStrip,
  toneColor,
} from "@/components/ui/primitives";
import type { Tone } from "@/components/ui/primitives";

/** 「待决」分组内的紧迫度(§4①:重点是 waiting_for_decision);其余分组只用时间序。 */
const STATUS_RANK: Record<string, number> = {
  waiting_for_decision: 0,
  failed: 1,
  in_progress: 2,
  open: 3,
  resolved: 4,
  superseded: 5,
};

/** 属 Harness 页的全局工件:本页任何分组都不列(含兜底「其它」组)。 */
const HARNESS_ONLY_KINDS: ReadonlySet<string> = new Set([
  "harness_proposal",
  "implementation_preview",
]);

/** 状态机的白话读法指向的机器读法 —— 现在是状态 pill 的 `title=`。 */
const STATE_MACHINE_HINT =
  "工件状态机:open → in_progress → waiting_for_decision → resolved / superseded / failed。";

/** 「待转述」视图的完整语义(按钮悬停 + 分组标题悬停,不再占一整段正文)。 */
const INBOX_DESC =
  "沟通员的待发件箱 —— 执行员产出的假设 / 决策,或任何挂在「等决策」上的工件;按状态机紧迫度排序。";

/**
 * body 超过这么多字符才给「展开」。卡片宽约 1000px、13px 正文,一行放得下 60–70 个汉字,
 * 3 行 ≈ 200 字 —— 阈值取 150 偏保守:**宁可多给一次点开,也不让正文的尾巴没有出口。**
 */
const BODY_EXPAND_CHARS = 150;

interface GroupDef {
  key: string;
  label: string;
  /** 分组语义:只出现在分组标题的 title=(完整句子另见文件头)。 */
  desc: string;
  kinds: ReadonlyArray<ArtifactKind>;
  /** 「待决」组按状态机紧迫度排(§4①),其余组按更新时间倒序。 */
  urgent?: boolean;
}

const GROUPS: ReadonlyArray<GroupDef> = [
  {
    key: "pending",
    label: "待决",
    desc: "卡住等人拍板的工作 —— 执行员提的**协议假设**(会真的触发向你提问),状态到「等决策」的最需要先看。沉淀的推测不在这里(它们是 insight)。",
    kinds: ["hypothesis"],
    urgent: true,
  },
  {
    key: "plan",
    label: "意图与待办",
    desc: "规划员落的意图与 DAG 步骤(§4 分组表未列,归此处以免真实数据被藏起来)。",
    kinds: ["intent", "todo"],
  },
  {
    key: "decision",
    label: "决策",
    desc: "已定、具约束力的结论。",
    kinds: ["decision"],
  },
  {
    key: "evidence",
    label: "执行产出",
    desc: "执行员的工作产出:观察到的证据,或没做成时的失败说明。",
    kinds: ["evidence", "note"],
  },
  {
    key: "critique",
    label: "批驳",
    desc: "评审结论。",
    kinds: ["critique"],
  },
  {
    key: "sediment",
    label: "沉淀",
    desc: "沉淀器从对话里提炼的长期记忆(7-J 起 kind 恒为 insight),以及反思总结。这些**不会触发任何人的工作流**。",
    kinds: ["insight", "reflection"],
  },
];

/**
 * 待转述(§4③)= 沟通员**应当转达给用户**的工件,即沟通员的待发件箱:
 *   (a) 执行员产出的假设 / 决策,或 (b) 任何挂在「等决策」上的工件。
 * 徽章与列表共用这一个谓词 —— 两处各算一套就会出现「写 N 条、点进去 0 条」。
 */
function isPendingRelay(a: Artifact): boolean {
  // 批次 7-J:这个谓词之所以成立,靠的是 author==="executor" **且** kind 是工作流 kind。
  // 沉淀器产的 insight 两条都不满足(author=communicator、kind=insight)—— 语义串味
  // 的根因被移除后,这里天然只命中「真的会触发提问」的那些。
  return (
    (a.author === "executor" && (a.kind === "hypothesis" || a.kind === "decision")) ||
    a.status === "waiting_for_decision"
  );
}

function byRecency(a: Artifact, b: Artifact): number {
  return b.updatedAt - a.updatedAt;
}

function byUrgency(a: Artifact, b: Artifact): number {
  const r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
  return r !== 0 ? r : byRecency(a, b);
}

/** 过滤行的小圆片:未选中几乎隐形,选中才上实色。 */
function Chip({
  active = false,
  tone = "mute",
  onClick,
  title,
  children,
}: {
  active?: boolean;
  tone?: Tone;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  const c = toneColor(tone);
  return (
    <button
      className="sansheng-button"
      onClick={onClick}
      title={title}
      style={{
        padding: "1px 8px",
        fontSize: 11,
        lineHeight: "18px",
        background: active ? c : "transparent",
        color: active ? "var(--ink-0)" : "var(--bone-dim)",
        borderColor: active ? c : "transparent",
      }}
    >
      {children}
    </button>
  );
}

/**
 * 分组标题:名字 + 计数,说明句只在 `title=` 里。
 * 没用 `Section`:它的 `hint` 是**可见**文本,而这里要的正是「说明默认不在屏幕上」。
 */
function GroupHeading({ label, count, desc }: { label: string; count: number; desc: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-2 flex-wrap">
      <h2 className="ss-section" title={desc}>
        {label}
      </h2>
      <span className="ss-meta">{count}</span>
    </div>
  );
}

function ArtifactCard({ a }: { a: Artifact }) {
  const blocked = a.status === "waiting_for_decision";
  const tone = statusTone(a.status);
  const body = (a.body ?? "").trim();
  const updated = a.updatedAt !== a.createdAt;
  const relations = [
    a.parentIntent ? `parent ${a.parentIntent}` : "",
    a.dependsOn && a.dependsOn.length > 0 ? `dependsOn ${a.dependsOn.join(", ")}` : "",
    a.executors && a.executors.length > 0 ? `执行 ${a.executors.join(", ")}` : "",
  ].filter((x) => x !== "");

  return (
    <article
      className="sansheng-card p-3"
      style={blocked ? { borderLeft: "2px solid var(--amber)" } : undefined}
    >
      {/* 一行元信息:kind · status · 轮到谁 · 沉淀 —— 右对齐「作者 · 时间」 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Pill tone={kindTone(a.kind)}>{kindLabel(a.kind)}</Pill>
        <Pill tone={tone} title={`${STATE_MACHINE_HINT}当前:${statusLabel(a.status)}`}>
          {statusLabel(a.status)}
        </Pill>
        <span className="ss-meta" style={{ color: toneColor(tone) }}>
          轮到 {STATUS_TURN[a.status] ?? a.status}
        </span>
        {a.metadata?.source === "sedimentation" && (
          <Pill tone="jade" title="metadata.source=sedimentation · 沉淀产物">
            沉淀
          </Pill>
        )}
        <span
          className="ss-meta ml-auto"
          title={`创建 ${fmtTime(a.createdAt)}${updated ? ` · 更新 ${fmtTime(a.updatedAt)}` : ""}`}
        >
          {authorLabel(a.author)} · {fmtTime(a.createdAt)}
        </span>
      </div>
      {/* 标题是卡里最该被读的一行:比正文大一档,超两行截断 */}
      <Clamp lines={2} style={{ marginTop: 4, color: "var(--bone)", fontSize: 14 }}>
        {a.title}
      </Clamp>
      {body ? (
        <>
          <Clamp lines={3} style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>
            {body}
          </Clamp>
          {body.length > BODY_EXPAND_CHARS && (
            <Disclosure summary="展开正文">
              <div style={{ whiteSpace: "pre-wrap" }}>{body}</div>
            </Disclosure>
          )}
        </>
      ) : null}
      {/* 原始 id / 依赖:一条都没有就不渲染折叠块 */}
      {relations.length > 0 && (
        <Disclosure summary="关联">
          <div className="font-mono" style={{ overflowWrap: "anywhere" }}>
            {relations.join(" · ")}
          </div>
        </Disclosure>
      )}
    </article>
  );
}

interface Props {
  conversationId: string | null;
}

export function ArtifactsPage({ conversationId }: Props) {
  const { artifacts, loading, error } = useArtifacts();
  const [kindFilter, setKindFilter] = useState("all");
  const [sedimentationOnly, setSedimentationOnly] = useState(false);
  const [view, setView] = useState<"groups" | "inbox">("groups");

  /** 移走 Harness 页的两类全局工件(§4 表末行)—— 在所有 filter 之前,绝不进兜底组。 */
  const harnessCount = useMemo(
    () => artifacts.filter((a) => HARNESS_ONLY_KINDS.has(a.kind)).length,
    [artifacts],
  );

  /** 过滤链:harness 两类 → sedimentation 开关 → kind 按钮。后面的计数全部基于真实数组。 */
  const scoped = useMemo(
    () =>
      artifacts
        .filter((a) => !HARNESS_ONLY_KINDS.has(a.kind))
        .filter((a) => (sedimentationOnly ? a.metadata?.source === "sedimentation" : true)),
    [artifacts, sedimentationOnly],
  );

  const filtered = useMemo(
    () => scoped.filter((a) => (kindFilter === "all" ? true : a.kind === kindFilter)),
    [scoped, kindFilter],
  );

  const sedimentCount = useMemo(
    () => artifacts.filter((a) => a.metadata?.source === "sedimentation").length,
    [artifacts],
  );

  /** kind 按钮只列**真实存在**的 kind(计数来自 scoped),不摆 0 计数的按钮。 */
  const kindOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of scoped) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
    return ARTIFACT_KINDS.filter((k) => !HARNESS_ONLY_KINDS.has(k) && (counts.get(k) ?? 0) > 0).map(
      (k) => ({ key: k, label: kindLabel(k), count: counts.get(k) ?? 0 }),
    );
  }, [scoped]);

  /** 分组:计数 = 对真实数组 filter 后的 length;空组不渲染(但计数在分组摘要行里如实显示)。 */
  const groups = useMemo(
    () =>
      GROUPS.map((g) => {
        const kinds: ReadonlyArray<string> = g.kinds;
        const items = filtered
          .filter((a) => kinds.includes(a.kind))
          .sort(g.urgent ? byUrgency : byRecency);
        return { ...g, items };
      }),
    [filtered],
  );

  /** 兜底:不属于任何已知分组的工件(新 kind 加进来时不会静默消失)。harness 两类已在上游剔除。 */
  const others = useMemo(() => {
    const known = new Set<string>(GROUPS.flatMap((g) => g.kinds));
    return filtered.filter((a) => !known.has(a.kind)).sort(byRecency);
  }, [filtered]);

  const inbox = useMemo(() => filtered.filter(isPendingRelay).sort(byUrgency), [filtered]);

  const activeFilterLabels = useMemo(() => {
    const labels: string[] = [];
    if (kindFilter !== "all") labels.push(`kind=${kindLabel(kindFilter)}`);
    if (sedimentationOnly) labels.push("只看沉淀");
    return labels;
  }, [kindFilter, sedimentationOnly]);

  /** 空态文案:没开过滤却空 → 多半是本页只收会话级工件,如实说清楚,别输出「没有工件()」。 */
  const emptyHint = useMemo(() => {
    if (activeFilterLabels.length > 0) {
      return `当前过滤(${activeFilterLabels.join(" + ")})下没有工件。`;
    }
    if (harnessCount > 0) {
      return `本页只展示会话级工件;${harnessCount} 个 harness 提案 / 预览在「Harness」页。`;
    }
    return "当前过滤条件下没有工件。";
  }, [activeFilterLabels, harnessCount]);

  return (
    <div className="ss-page">
      <PageHeader
        title="工件"
        hint="挑选后的结构化产出,聊天记录在「对话」页"
        hintTitle="工件 = 挑选后的结构化产出(受控 kind + 状态机),不是聊天记录;聊天记录在「对话」页。"
        aside={
          <>
            <StatStrip
              items={[
                { label: "总数", value: artifacts.length },
                ...(filtered.length !== artifacts.length
                  ? [{ label: "过滤后", value: filtered.length }]
                  : []),
              ]}
            />
            {loading ? <Pill tone="mute">刷新中</Pill> : null}
          </>
        }
      />

      {error && (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      )}

      {conversationId && artifacts.length > 0 && (
        <>
          {/* 过滤行:视图切换 / kind / 沉淀,一行小圆片 */}
          <div className="flex items-center gap-1 flex-wrap">
            <Chip active={view === "groups"} onClick={() => setView("groups")}>
              按职能分组
            </Chip>
            <Chip
              active={view === "inbox"}
              tone="jade"
              title={INBOX_DESC}
              onClick={() => setView("inbox")}
            >
              待转述 {inbox.length}
            </Chip>
            <span
              style={{ width: 1, alignSelf: "stretch", minHeight: 14, background: "var(--ink-3)" }}
            />
            <Chip active={kindFilter === "all"} onClick={() => setKindFilter("all")}>
              全部 {scoped.length}
            </Chip>
            {kindOptions.map((k) => (
              <Chip key={k.key} active={kindFilter === k.key} onClick={() => setKindFilter(k.key)}>
                {k.label} {k.count}
              </Chip>
            ))}
            {sedimentCount > 0 && (
              <Chip
                active={sedimentationOnly}
                tone="jade"
                title="只看 metadata.source=sedimentation 的沉淀产物"
                onClick={() => setSedimentationOnly((v) => !v)}
              >
                沉淀 {sedimentCount}
              </Chip>
            )}
          </div>

          {harnessCount > 0 && (
            <div className="ss-meta">另有 {harnessCount} 个 harness 提案 / 预览在「Harness」页。</div>
          )}

          {/* 分组摘要:六个分组的真实计数(含 0),空组不会从视野里凭空消失。 */}
          {view === "groups" && (
            <div className="ss-meta">
              {groups.map((g) => `${g.label} ${g.items.length}`).join(" · ")}
              {others.length > 0 && ` · 其它 ${others.length}`}
            </div>
          )}
        </>
      )}

      {!conversationId ? (
        <EmptyState>先在「对话」里选一个会话。</EmptyState>
      ) : loading && artifacts.length === 0 ? (
        <EmptyState>加载中…</EmptyState>
      ) : !error && filtered.length === 0 ? (
        <EmptyState>
          {artifacts.length === 0
            ? `本会话暂无工件 —— 普通的聊天不产生工件。${PLAN_HOWTO}`
            : emptyHint}
        </EmptyState>
      ) : view === "inbox" ? (
        inbox.length === 0 ? (
          <EmptyState>
            当前 {filtered.length} 条里没有待转述的(执行员产出的假设 / 决策,或挂在「等决策」上的才算)。
          </EmptyState>
        ) : (
          <section>
            <GroupHeading label="待转述" count={inbox.length} desc={INBOX_DESC} />
            <div className="grid gap-2">
              {inbox.map((a) => (
                <ArtifactCard key={a.id} a={a} />
              ))}
            </div>
          </section>
        )
      ) : (
        <div>
          {groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <section key={g.key} style={{ marginBottom: 16 }}>
                <GroupHeading label={g.label} count={g.items.length} desc={g.desc} />
                <div className="grid gap-2">
                  {g.items.map((a) => (
                    <ArtifactCard key={a.id} a={a} />
                  ))}
                </div>
              </section>
            ))}
          {others.length > 0 && (
            <section style={{ marginBottom: 16 }}>
              <GroupHeading
                label="其它"
                count={others.length}
                desc="不属于任何已知分组的 kind(新 kind 加入时落这里,不会被静默丢掉)。"
              />
              <div className="grid gap-2">
                {others.map((a) => (
                  <ArtifactCard key={a.id} a={a} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
