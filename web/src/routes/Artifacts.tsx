/**
 * Sansheng · 工件页(批次 UI U1 · P0-B「按沟通职能」重做)
 *
 * 数据源:`GET /api/artifacts?conversationId=<id>&limit=200`
 *   —— blackboard v3 artifact 的**唯一读端点**(src/server/http/blackboardRoutes.ts:74),
 *   scope 默认 conversation(全局工件在 Harness 页的 proposals/previews 里展示)。
 *   返回体已由真实 server 冒烟验证:`{ artifacts: BlackboardArtifact[] }`,
 *   单条含 id/scope/conversationId/kind/title/body/author/status/createdAt/updatedAt
 *   + 可选 refs/executors/dependsOn/parentIntent/metadata。
 *   本批(P0)**零后端改动**:不加端点、不动 DB、不动 WS 事件 —— 只是已有数据的重新组织。
 *
 * 为什么改成按职能分组(docs/PRODUCT-DESIGN-2026-10-02.md §4):
 *   artifact 的 10 个 kind 是**受控词汇表**,不是聊天记录 —— 每条都带 author(谁产出)、
 *   status(生命周期状态机)、refs/dependsOn(关系)、metadata。数据模型**早就是**「挑选后的
 *   结构化产出」,上一版 UI 把它按 createdAt 倒序平铺,才让用户误以为「这里应该有聊天记录」。
 *   所以这一批只做四件事:
 *   ① 取消时间倒序流水账,改按**沟通职能**分组(§4 表):
 *      待决 = hypothesis(重点是 status=waiting_for_decision)、决策 = decision、
 *      证据 = evidence、批驳 = critique、沉淀 = note / reflection。
 *      §4 表未列的 `intent` / `todo` 归入「意图与待办」—— 不给它们建组就等于把真实数据
 *      藏起来(反造假:宁可多一组,不静默丢数据)。
 *      `harness_proposal` / `implementation_preview` 属 **Harness 页**,在 filter 之前就被
 *      `HARNESS_ONLY_KINDS` 剔掉,**不进任何分组**、也进不了兜底的「其它」组(§4 表末行)。
 *      若真拉到了,页首如实写一行「另有 N 个 … 在 Harness 页」,不假装它们不存在。
 *   ② 每张卡片画一条 status 状态机轨道 + 「轮到 X」白话读法(§4②):工件是**带状态机的
 *      消息**,页面要能一眼看出「现在轮到谁」;`waiting_for_decision` 额外加左侧琥珀色边条。
 *   ③ 「待转述」视图 = 沟通员的**待发件箱**(§4③):`(author=executor 且 kind ∈
 *      {hypothesis, decision}) 或 status=waiting_for_decision`。这是「agent 和沟通员沟通」
 *      这个需求在 UI 上第一次有落点 —— 之前这个角色分工完全不可见。
 *   ④ 页首一行教学文案(§4④):工件 = 挑选后的结构化产出,聊天记录在「对话」页。成本一行字,
 *      直接消除「我为什么在这里找不到聊天记录」。
 *
 * 反造假纪律(本项目最强的一条):页面上**每一个数字**都来自本次 fetch 到的数组
 *   (总条数 / 过滤后 / 分组计数 / kind 按钮计数 / 沉淀计数 / 待转述计数),没有硬编码常量;
 *   数据为空就显示空态并说明**为什么**空。「待转述 N」与待转述列表共用同一个谓词
 *   `isPendingRelay`,不会出现按钮写 N、点进去 0 条。分组计数 = 对真实数组 filter 后的 length。
 *
 * 保留(与新分组正交叠加,互不覆盖):kind 过滤按钮(按真实数据动态列出,无 0 计数按钮)
 *   + sedimentation 过滤(metadata.source=sedimentation)+ 「N 条 · 过滤后 N」计数行。
 *
 * 实时性:WS 的 artifact_created / artifact_status_changed / plan_done 经 chat store
 * 汇总成 artifactRevision 计数(与既有 historyRefreshTrigger 同款模式),页面依赖它回查。
 * **不把 artifact 本体塞进 store** —— 权威数据永远回查后端,避免两份真相。
 *
 * 视觉:完全沿用既有页面骨架(Memory.tsx / Agents.tsx 同款 `<main className="px-4 pb-4">`
 *   + `sansheng-h2` / `sansheng-card` / `sansheng-button` / `sansheng-text-mute`),
 *   颜色只用 tokens.css 既有变量(--ink-0..4 / --bone* / --jade* / --bamboo / --amber /
 *   --ochre / --cinnabar / --cyan),无新配色 / 无新字体 / 无新间距体系,UI 标签一律不用 emoji。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChatStore } from "@/stores/chat";
import { ARTIFACT_KINDS } from "@shared/types/blackboard";
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

/** 状态机的白话读法 —— 这一页的核心价值是「一眼看出现在轮到谁」(§4②)。 */
const TURNS: Record<string, string> = {
  open: "待接手",
  in_progress: "在推进",
  waiting_for_decision: "等人拍板",
  resolved: "已闭环",
  superseded: "已作废",
  failed: "已失败",
};

/** 状态机轨道上的六个刻度,顺序 = shared/types/blackboard.ts ARTIFACT_STATUSES。 */
const STATUS_ORDER: ReadonlyArray<ArtifactStatus> = [
  "open",
  "in_progress",
  "waiting_for_decision",
  "resolved",
  "superseded",
  "failed",
];

/** 「待决」分组内的紧迫度(§4①:重点是 waiting_for_decision);其余分组只用时间序。 */
const STATUS_RANK: Record<string, number> = {
  waiting_for_decision: 0,
  failed: 1,
  in_progress: 2,
  open: 3,
  resolved: 4,
  superseded: 5,
};

/** author 是真实的角色维度,给个中文读法(不认识的角色原样透出,不吞)。 */
const AUTHOR_LABEL: Record<string, string> = {
  user: "用户",
  communicator: "沟通员",
  planner: "规划员",
  executor: "执行员",
  critic: "评审员",
  memory: "记忆员",
  reflection: "反思员",
  harness_manager: "Harness 管理员",
};

/** 属 Harness 页的全局工件:本页任何分组都不列(含兜底「其它」组)。 */
const HARNESS_ONLY_KINDS: ReadonlySet<string> = new Set([
  "harness_proposal",
  "implementation_preview",
]);

interface GroupDef {
  key: string;
  label: string;
  /** 分组语义,原样写自 §4 表格,贴在分组头上,免得用户猜这个组是干嘛的。 */
  desc: string;
  kinds: ReadonlyArray<ArtifactKind>;
  /** 「待决」组按状态机紧迫度排(§4①),其余组按更新时间倒序。 */
  urgent?: boolean;
}

const GROUPS: ReadonlyArray<GroupDef> = [
  {
    key: "pending",
    label: "待决",
    desc: "卡住等人拍板的工作 —— 执行员提的假设,状态到「等决策」的最需要先看。",
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
    label: "证据",
    desc: "执行员的观察产出。",
    kinds: ["evidence"],
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
    desc: "跑完之后活下来的长期记忆(笔记 / 反思)。",
    kinds: ["note", "reflection"],
  },
];

/**
 * 待转述(§4③)= 沟通员**应当转达给用户**的工件,即沟通员的待发件箱:
 *   (a) 执行员产出的假设 / 决策,或 (b) 任何挂在「等决策」上的工件。
 * 徽章与列表共用这一个谓词 —— 两处各算一套就会出现「写 N 条、点进去 0 条」。
 */
function isPendingRelay(a: Artifact): boolean {
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

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** 状态机轨道:六个刻度,当前状态按 STATUS_TONE 着色,其余压暗。只标位置,不伪造流转历史。 */
function LifecycleTrack({ status }: { status: ArtifactStatus }) {
  return (
    <span
      className="font-mono inline-flex"
      style={{ gap: 3, alignItems: "center" }}
      title={`工件状态机:open → in_progress → waiting_for_decision → resolved / superseded / failed;高亮 = 当前 ${STATUS_LABEL[status] ?? status}`}
    >
      {STATUS_ORDER.map((s) => (
        <span
          key={s}
          style={{
            width: 10,
            height: 3,
            borderRadius: 1,
            background: s === status ? STATUS_TONE[s] ?? "var(--bone-mute)" : "var(--ink-3)",
          }}
        />
      ))}
    </span>
  );
}

function ArtifactCard({ a }: { a: Artifact }) {
  const tone = STATUS_TONE[a.status] ?? "var(--bone-mute)";
  const blocked = a.status === "waiting_for_decision";
  return (
    <article
      className="sansheng-card p-3"
      style={blocked ? { borderLeft: "2px solid var(--amber)" } : undefined}
    >
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
            color: tone,
          }}
        >
          {STATUS_LABEL[a.status] ?? a.status}
        </span>
        <span className="font-mono" style={{ fontSize: 10, color: tone }}>
          轮到 {TURNS[a.status] ?? a.status}
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
          {AUTHOR_LABEL[a.author] ?? a.author} · {fmtTime(a.createdAt)}
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
      <div
        className="sansheng-text-mute font-mono mt-1 flex items-center gap-2"
        style={{ fontSize: 10, flexWrap: "wrap" }}
      >
        <LifecycleTrack status={a.status} />
        {a.updatedAt !== a.createdAt && `更新 ${fmtTime(a.updatedAt)}`}
        {a.parentIntent && `parent ${a.parentIntent}`}
        {a.dependsOn && a.dependsOn.length > 0 && `dependsOn ${a.dependsOn.join(", ")}`}
        {a.executors && a.executors.length > 0 && `执行 ${a.executors.join(", ")}`}
      </div>
    </article>
  );
}

function SectionHeader({ label, count, desc }: { label: string; count: number; desc: string }) {
  return (
    <div className="mb-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-medium" style={{ color: "var(--bone)" }}>
          {label}
        </span>
        <span className="sansheng-text-mute font-mono" style={{ fontSize: 10 }}>
          {count} 条
        </span>
      </div>
      <div className="sansheng-text-mute text-xs" style={{ lineHeight: 1.6 }}>
        {desc}
      </div>
    </div>
  );
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
  const [view, setView] = useState<"groups" | "inbox">("groups");

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
      (k) => ({ key: k, label: KIND_LABEL[k] ?? k, count: counts.get(k) ?? 0 }),
    );
  }, [scoped]);

  /** 分组:计数 = 对真实数组 filter 后的 length;空组不渲染(但计数在分组摘要行里如实显示)。 */
  const groups = useMemo(
    () =>
      GROUPS.map((g) => {
        const kinds: ReadonlyArray<string> = g.kinds;
        const items = filtered.filter((a) => kinds.includes(a.kind)).sort(g.urgent ? byUrgency : byRecency);
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
    if (kindFilter !== "all") labels.push(`kind = ${KIND_LABEL[kindFilter] ?? kindFilter}`);
    if (sedimentationOnly) labels.push("只看沉淀");
    return labels;
  }, [kindFilter, sedimentationOnly]);

  /** 空态文案:没开过滤却空 → 多半是本页只收会话级工件,如实说清楚,别输出「没有工件()」。 */
  const emptyHint = useMemo(() => {
    if (activeFilterLabels.length > 0) {
      return `当前过滤条件下没有工件(${activeFilterLabels.join(" + ")})。`;
    }
    if (harnessCount > 0) {
      return `本页只展示会话级工件;${harnessCount} 个全局 harness 提案 / 预览在「Harness」页。`;
    }
    return "当前过滤条件下没有工件。";
  }, [activeFilterLabels, harnessCount]);

  return (
    <main className="px-4 pb-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="sansheng-h2">工件</h2>
        <div className="text-xs sansheng-text-mute font-mono">
          {artifacts.length} 条
          {filtered.length !== artifacts.length && ` · 过滤后 ${filtered.length}`}
          {loading && " · 刷新中"}
        </div>
      </div>

      {/* 教学文案(§4④):一句话说清这一页是什么、聊天记录在哪。 */}
      <div className="sansheng-text-mute text-xs mb-3" style={{ lineHeight: 1.6 }}>
        工件 = 挑选后的结构化产出(受控 kind + 状态机),不是聊天记录;聊天记录在「对话」页。
      </div>

      {harnessCount > 0 && (
        <div className="sansheng-text-mute text-xs mb-2" style={{ lineHeight: 1.6 }}>
          另有 {harnessCount} 个 harness 提案 / 实施预览属全局工件,在「Harness」页展示,本页不列。
        </div>
      )}

      {conversationId && artifacts.length > 0 && (
        <>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <button
              className="sansheng-button"
              onClick={() => setView("groups")}
              style={{
                padding: "3px 9px",
                fontSize: 11,
                background: view === "groups" ? "var(--ink-2)" : "transparent",
                color: view === "groups" ? "var(--bone)" : "var(--bone-dim)",
                borderColor: view === "groups" ? "var(--ink-4)" : "transparent",
              }}
            >
              按职能分组
            </button>
            <button
              className="sansheng-button"
              onClick={() => setView("inbox")}
              title="沟通员的待发件箱:执行员产出的假设 / 决策,以及任何挂在「等决策」上的工件"
              style={{
                padding: "3px 9px",
                fontSize: 11,
                background: view === "inbox" ? "var(--jade-soft)" : "transparent",
                color: view === "inbox" ? "var(--jade)" : "var(--bone-dim)",
                borderColor: view === "inbox" ? "var(--jade)" : "transparent",
              }}
            >
              待转述 {inbox.length}
            </button>
          </div>

          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <button
              className="sansheng-button"
              onClick={() => setKindFilter("all")}
              style={{
                padding: "3px 9px",
                fontSize: 11,
                background: kindFilter === "all" ? "var(--ink-2)" : "transparent",
                color: kindFilter === "all" ? "var(--bone)" : "var(--bone-dim)",
                borderColor: kindFilter === "all" ? "var(--ink-4)" : "transparent",
              }}
            >
              全部 {scoped.length}
            </button>
            {kindOptions.map((k) => (
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
                {k.label} {k.count}
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

          {/* 分组摘要:六个分组的真实计数(含 0),空组不会从视野里凭空消失。 */}
          {view === "groups" && (
            <div className="sansheng-text-mute font-mono text-xs mb-3" style={{ lineHeight: 1.6 }}>
              {groups.map((g) => `${g.label} ${g.items.length}`).join(" · ")}
              {others.length > 0 && ` · 其它 ${others.length}`}
            </div>
          )}
        </>
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
            : emptyHint}
        </div>
      ) : view === "inbox" ? (
        inbox.length === 0 ? (
          <div className="sansheng-card p-4 text-sm opacity-80">
            当前过滤条件下没有待转述的工件。
            <br />
            <span className="sansheng-text-mute" style={{ fontSize: 11 }}>
              判定条件:执行员产出的假设 / 决策,或任何 status = 等决策的工件。现在这 {filtered.length}{" "}
              条都不满足 —— 沟通员没有该转达的东西。
            </span>
          </div>
        ) : (
          <section>
            <SectionHeader
              label="待转述"
              count={inbox.length}
              desc="沟通员的待发件箱 —— 执行员产出的假设 / 决策,以及任何挂在「等决策」上的工件;按状态机紧迫度排序。"
            />
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
              <section key={g.key} className="mb-4">
                <SectionHeader label={g.label} count={g.items.length} desc={g.desc} />
                <div className="grid gap-2">
                  {g.items.map((a) => (
                    <ArtifactCard key={a.id} a={a} />
                  ))}
                </div>
              </section>
            ))}
          {others.length > 0 && (
            <section className="mb-4">
              <SectionHeader
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
    </main>
  );
}
