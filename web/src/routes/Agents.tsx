/**
 * Sansheng · Agents 页(P0-A:blackboard 工作面 + 真实角色表)
 *
 * 依据:`docs/PRODUCT-DESIGN-2026-10-02.md` §1(角色表)与 §3(Blackboard 四区),
 * 对应排期 P0 #1(四区工作面)/ #4(只列 4 个真实 agent)/ #6(失败原因可见)。
 * 零后端改动:本文件只重新组织**已有**工件数据,不动 DB、不加端点、不动 WS 事件。
 *
 * ── 数据源(唯一)──────────────────────────────────────────────────────
 * `GET /api/artifacts?conversationId=<id>&limit=200` → `{ artifacts: BlackboardArtifact[] }`
 * (src/server/http/blackboardRoutes.ts)。实时性仍靠 WS 的 `artifact_created` /
 * `artifact_status_changed` / `plan_done` 汇总出的 `artifactRevision` 计数触发回查
 * (与 Artifacts.tsx 同款);**不把工件本体塞进 store**,权威数据永远回查后端。
 * 取代了上一版对 legacy `GET /api/blackboard/:id` 的轮询(upsertBlackboard 全仓
 * 无调用方 → 恒 null)与 `/api/agents/:id`(硬编码 `{agents:[]}` 的 M3c 占位)。
 *
 * ── §1 角色表:为什么只有 4 行 ───────────────────────────────────────
 * critic / memory / reflection **没有 class 实现、没有任何代码读它们的 harness 提示词**
 * (设计文档 §1 表 + r2 修订),2026-10-02 用户决定**暂不实现 → 界面不列出**。
 * 三行永远点不亮的灰行是噪声,所以整行删掉,而不是标「未接线」。
 * 保留 communicator / planner / executor / harness_manager 四行:`harness_manager`
 * 在工件里几乎没有 author(它只对 `harness_proposal` 反应,发射点还没补 —— §6③),
 * 但角色表是**静态事实表**,不是运行态表,所以保留;没产出时显示「—」并注明
 * 「= 本会话没有它的工件」,不写任何「运行中 / idle」之类恒定文案。
 * 注:`harness_manager` 不在 `RoleKind` 联合里(shared/types/agents.ts:97 只列了
 * communicator/planner/executor/critic/memory/reflection),但它是真实 class
 * (harnessManager.ts:145)且是合法 `ArtifactAuthor`(shared/types/blackboard.ts:83)
 * —— 故本页用本地 `RealAgent` 联合,不为了 UI 去动共享类型(设计文档 §8 明确「保留不动」)。
 * 称呼按 §1.1 术语规则:角色表里是配置键/文件名 → 英文 id;工件上的「谁产出的」→ 中文读法。
 *
 * ── §3 四区:每区用哪些字段,为什么不用别的方式 ─────────────────────
 * ① 意图头 —— `intent.title/status/author/createdAt` + 名下 todo 的 status 聚合。
 *    **健康度一行是本批最关键的修复**:旧版只写 `todo 0/6 done`,而实测
 *    conv_muqsidb0_wgru 的 6 个 todo **全部 failed**,失败原因完全不可见。
 *    现在失败数是 `status==="failed"` 的 todo 计数(真实字段,不是推断)。
 *    「已耗时」用 `Date.now()-createdAt`,靠 `useNow` 的 1s tick 驱动重渲染
 *    —— 页面不轮询后端,只重算展示值。
 * ② DAG 区 —— todo 是节点、`dependsOn` 是边,**树状缩进**而非 canvas:
 *    一次计划本来就是 DAG,旧版把它画成平铺列表,`dependsOn/executors/status`
 *    三个字段一个都没用(设计文档 §3)。节点上挂三类结果工件
 *    (evidence / hypothesis / note)。
 *    ⚠️ 结果工件指向 todo 的**真实**通道是 `metadata.relatedArtifacts`
 *    (executor.ts:445/476/492 都写 `relatedArtifacts:[todo.id]`),
 *    **不是** `dependsOn`(executor 从不写 dependsOn)。本页三条通道并查:
 *    `dependsOn`(契约里声明的,planner 侧可能用)/ `metadata.relatedArtifacts`
 *    (真实路径)/ `refs`(契约里声明的)。空数组时是无副作用的 no-op。
 *    失败 todo 的 note 被并进「失败记录」块(它们是失败原因本身),不再重复
 *    出现在通用结果列表里;非失败 todo 的 note 走通用列表。
 * ③ 阻塞队列 —— `status==="waiting_for_decision"` 的 todo 单独一条泳道。
 *    这是整个系统最有信息量的状态(executor 卡住等人拍板),旧版完全不可见。
 *    等待时长 = `Date.now()-updatedAt`,**页面上明写这是估算**:工件 updatedAt 是
 *    「最后一次写入时间」,不等于后台 `waiting` map 的入队时刻(那个 map 是 private,
 *    无 getter / HTTP / 事件,只能 P1 补发)。阈值色标取 `orchestrator.ts:207-208`
 *    的默认 escalationMs(5 分钟)/ failMs(1 小时),同样是默认值不是运行实例的实配值。
 * ④ 沉淀区 —— `decision` / `note` / `reflection` 中「还活着」的:
 *    status ∉ {failed, superseded}(被取代的结论不算活下来的)。
 *    已经在 DAG 节点下作为执行结果展示的不重复列,只在一行注明数量。
 *
 * ── P0 #6 失败原因可见 ──────────────────────────────────────────────
 * 取值优先级:`metadata.errorReason`(字符串)→ `body` → 「无详细原因(见对话页错误提示)」。
 * 两处刻意加了限定,否则会**说谎**:
 *  - 走 `body` 分支时明确标「取自工件正文」:todo 的 body 是 **planner 写的待办描述**,
 *    executor 直接失败时 orchestrator 只 `updateArtifactStatus(failed)`、**不写**
 *    errorReason(blackboards.ts:352-397),此时 body 里根本没有失败信息。
 *  - 两者都空时,回落到「节点下产出的失败 note」标题 —— 真实样本正是这条路:
 *    note 标题形如 `Executor · parse failed for todo-2`(executor.ts:526),
 *    body 里带 `Raw (first 500 chars)`,那才是真正的失败现场。
 *  这样每一条 failed 都有出处,不会退化成「无原因」的黑洞。
 *
 * ── DAG 建树的健壮性(缺失依赖 / 成环 / 孤儿)────────────────────────
 *  - **缺失依赖**:`dependsOn` 指向本会话不存在的 todo id → 不建边,记 `missingDeps`,
 *    该节点照常当根渲染,并在节点下方标出缺哪几个 id(数据不丢、关系不假装)。
 *  - **自环**:`dependsOn` 含自己 → 当作无依赖(根),标 `selfDep`。
 *  - **成环**:DFS 用 `visited` 集合,**进入节点先打标再递归**,回边直接剪断 →
 *    恒定终止,不死循环;剪断后从任何根都到不了的节点单独进「未挂载」列表并注明原因。
 *  - **孤儿**:todo 的 `parentIntent` 指向不存在的 intent(或没写)→ 不并进任何意图板,
 *    单开一块「未归属意图的待办」,同样跑完整 DAG。
 *  - 重复 id 以先出现者为准(后写覆盖同 id 的 node,children 累加),不抛异常。
 *
 * ── 视觉 ────────────────────────────────────────────────────────────
 * 完全沿用既有骨架(`<main className="px-4 pb-4">` + `sansheng-h2` + `sansheng-card` +
 * `sansheng-button` + `sansheng-text-mute`)与既有 CSS 变量(`--ink-1..4`、`--bone*`、
 * `--jade/--jade-soft`、`--bamboo`、`--amber`、`--ochre`、`--cinnabar`、`--cyan, #4cc9c0`),
 * 不引入新配色/字体/间距;状态用色块 + mono pill 表达,不用 emoji 当 UI 标签。
 * 标签映射(KIND_LABEL / STATUS_LABEL / KIND_TONE / STATUS_TONE)在本文件内自持一份,
 * **不抽公共模块** —— Artifacts.tsx 也各自持有一份,抽出去会和并行改动打架。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useChatStore } from "@/stores/chat";
import type { ArtifactKind, ArtifactStatus } from "@shared/types/blackboard";

/** 与 src/server/http/blackboardRoutes.ts listArtifacts 的上限一致。 */
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
  metadata?: { [k: string]: unknown };
  createdAt: number;
  updatedAt: number;
}

// ───────────────────────────── 静态表(本地自持,见文件头)─────────────────────────────

/** §1:真实存在的 4 个 agent(critic/memory/reflection 无实现,界面不列出)。 */
type RealAgent = "communicator" | "planner" | "executor" | "harness_manager";

const REAL_AGENTS: RealAgent[] = ["communicator", "planner", "executor", "harness_manager"];

const REAL_AGENT_SET: ReadonlySet<string> = new Set<string>(REAL_AGENTS);

/** harness 提示词的来源(设计文档 §1 表最后一列 + §6①)。 */
const AGENT_PROMPT_SOURCE: Record<RealAgent, string> = {
  communicator: "读盘",
  planner: "读盘",
  executor: "读盘",
  harness_manager: "内置兜底",
};

/**
 * 角色**叙事读法**(设计文档 §1.1 术语规则:角色作为「谁产出的」主语 → 中文读法;
 * 角色作为配置键/文件名 → 英文 id,见下面的 Agent 角色表)。
 * 它是「任意 author 值的翻译表」不是「角色名册」—— critic/memory/reflection 虽
 * 不进角色表(§1:暂不实现),但历史数据里可能有这些 author,原样显示才是信息。
 * 与 Artifacts.tsx 的同名表是两份本地副本(不抽公共模块,避免与并行改动冲突)。
 */
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

/** ② DAG 节点下挂的结果工件种类(设计文档 §3②「evidence / hypothesis / failure」)。 */
const OUTPUT_KINDS: ArtifactKind[] = ["evidence", "hypothesis", "note"];

/** ④ 沉淀区:事后活下来的 kind。 */
const SETTLED_KINDS: ArtifactKind[] = ["decision", "note", "reflection"];

/** 「还活着」= 没失败、没被取代。 */
const ALIVE_STATUSES: ArtifactStatus[] = ["open", "in_progress", "waiting_for_decision", "resolved"];

/** 终态 todo 才显示「用时」(open/in_progress 的 updatedAt 差值会随时间失真)。 */
const TERMINAL_STATUSES: ArtifactStatus[] = ["resolved", "failed", "superseded"];

/** orchestrator.ts:207-208 的默认 escalationMs / failMs(实配值 UI 读不到,页面已注明)。 */
const ESCALATION_MS = 5 * 60 * 1000;
const FAIL_MS = 60 * 60 * 1000;

// ───────────────────────────── module-level type guard ─────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** 从 `unknown` 字段里安全取字符串数组(artifact 的可选字段全是 unknown)。 */
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(isString) : [];
}

// ───────────────────────────── 展示工具 ─────────────────────────────

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function excerpt(text: string, n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** 1s tick:让「已耗时 / 已等待」这类 `Date.now()` 派生值能自己往前走(不轮询后端)。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// ───────────────────────────── DAG 建树 ─────────────────────────────

interface DagNode {
  todo: Artifact;
  children: DagNode[];
  /** dependsOn 指向了本会话不存在的 todo id。 */
  missingDeps: string[];
  /** dependsOn 含自己。 */
  selfDep: boolean;
}

interface DagForest {
  roots: DagNode[];
  /** 从任何根都到不了的节点(成环被剪断后剩下的部分),按 createdAt 排。 */
  detached: Artifact[];
  /** 缺失依赖 + 自环的总处数(成环由 detached.length 单独表达)。 */
  anomalyCount: number;
}

/** 一块板 = 一个意图(或一块无归属的孤儿待办)+ 它名下的 todo。 */
interface Board {
  key: string;
  intent: Artifact | null;
  todos: Artifact[];
}

/**
 * todo → 树。容错见文件头「DAG 建树的健壮性」四条:
 * 缺失依赖不建边、自环当根、成环靠 visited 剪断、孤儿由调用方分组处理。
 * 终止性:每个节点进入时先写 visited,回边立即返回 null —— 恒定终止,无死循环。
 */
function buildDag(todos: Artifact[]): DagForest {
  const nodeById = new Map<string, DagNode>();
  for (const t of todos) {
    nodeById.set(t.id, { todo: t, children: [], missingDeps: [], selfDep: false });
  }

  const childrenOf = new Map<string, string[]>();
  const rootIds: string[] = [];
  let anomalyCount = 0;

  for (const node of nodeById.values()) {
    const deps = strList(node.todo.dependsOn);
    let linked = 0;
    for (const d of deps) {
      if (d === node.todo.id) {
        node.selfDep = true;
        anomalyCount += 1;
        continue;
      }
      if (!nodeById.has(d)) {
        node.missingDeps.push(d);
        anomalyCount += 1;
        continue;
      }
      const list = childrenOf.get(d);
      if (list) list.push(node.todo.id);
      else childrenOf.set(d, [node.todo.id]);
      linked += 1;
    }
    if (linked === 0) rootIds.push(node.todo.id);
  }

  const visited = new Set<string>();
  const expand = (id: string): DagNode | null => {
    if (visited.has(id)) return null; // 剪断回边 / 重复入边
    const node = nodeById.get(id);
    if (!node) return null;
    visited.add(id);
    for (const childId of childrenOf.get(id) ?? []) {
      const child = expand(childId);
      if (child) node.children.push(child);
    }
    return node;
  };

  const roots: DagNode[] = [];
  for (const id of rootIds) {
    const node = expand(id);
    if (node) roots.push(node);
  }
  const detached = [...nodeById.values()]
    .filter((n) => !visited.has(n.todo.id))
    .map((n) => n.todo)
    .sort((a, b) => a.createdAt - b.createdAt);

  return { roots, detached, anomalyCount };
}

// ───────────────────────────── 失败原因(P0 #6)─────────────────────────────

type FailureSource = "errorReason" | "body" | "note" | "none";

interface FailureInfo {
  source: FailureSource;
  text: string;
}

/**
 * 取值链:`metadata.errorReason` → `body` → 该节点产出的失败 note 标题 → 无。
 * 每档都带 source,渲染时如实标出处(见文件头 P0 #6 说明:body 里通常没有失败信息)。
 */
function failureInfo(todo: Artifact, outputs: Artifact[]): FailureInfo {
  const reason = todo.metadata?.errorReason;
  if (isString(reason) && reason.trim().length > 0) {
    return { source: "errorReason", text: reason };
  }
  if (todo.body && todo.body.trim().length > 0) {
    return { source: "body", text: todo.body };
  }
  const notes = outputs.filter((a) => a.kind === "note");
  if (notes.length > 0) {
    return { source: "note", text: notes.map((n) => n.title).join(" · ") };
  }
  return { source: "none", text: "" };
}

const FAILURE_SOURCE_LABEL: Record<FailureSource, string> = {
  errorReason: "来源 metadata.errorReason",
  body: "来源工件正文(planner 写的待办描述,通常不含失败信息)",
  note: "来源该节点产出的失败记录",
  none: "",
};

// ───────────────────────────── 本地小组件 ─────────────────────────────

function Pill({ text, tone, bg }: { text: string; tone: string; bg?: string }) {
  return (
    <span
      className="font-mono rounded"
      style={{
        fontSize: 10,
        padding: "0 6px",
        background: bg ?? "var(--ink-3)",
        color: tone,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
      <h3 className="font-medium">{children}</h3>
      {right ? <div className="sansheng-text-mute font-mono" style={{ fontSize: 10 }}>{right}</div> : null}
    </div>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm opacity-80" style={{ lineHeight: 1.7 }}>
      {children}
    </p>
  );
}

interface TodoNodeViewProps {
  node: DagNode;
  depth: number;
  outputsByTodo: Map<string, Artifact[]>;
}

/** ② DAG 的一个节点:状态色块 + 标题 + 状态 + 指派 executor + 用时 + 失败原因 + 结果工件。 */
function TodoNodeView({ node, depth, outputsByTodo }: TodoNodeViewProps) {
  const todo = node.todo;
  const outputs = outputsByTodo.get(todo.id) ?? [];
  const failed = todo.status === "failed";
  const failure = failed ? failureInfo(todo, outputs) : null;
  // 失败 todo 的 note 是失败原因本身,已在失败块里展开,不再进通用结果列表。
  const genericOutputs = failed ? outputs.filter((a) => a.kind !== "note") : outputs;
  const terminal = TERMINAL_STATUSES.includes(todo.status);
  const tone = STATUS_TONE[todo.status] ?? "var(--bone-mute)";

  return (
    <div
      style={
        depth > 0
          ? { marginLeft: 12, borderLeft: "1px solid var(--ink-4)", paddingLeft: 10 }
          : undefined
      }
    >
      <div
        className="sansheng-card p-2"
        style={
          todo.status === "waiting_for_decision"
            ? { borderLeft: "2px solid var(--amber)" }
            : failed
              ? { borderLeft: "2px solid var(--cinnabar)" }
              : undefined
        }
      >
        <div className="flex items-start gap-2">
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: tone,
              flex: "0 0 auto",
              marginTop: 6,
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm" style={{ color: "var(--bone)", lineHeight: 1.5 }}>
              {todo.title}
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Pill text={STATUS_LABEL[todo.status] ?? todo.status} tone={tone} />
              <Pill
                text={todo.executors?.length ? `executor: ${todo.executors.join(", ")}` : "未声明 executor"}
                tone="var(--bone-mute)"
              />
              {terminal && (
                <span className="sansheng-text-mute font-mono" style={{ fontSize: 10 }}>
                  用时 {fmtDuration(todo.updatedAt - todo.createdAt)}
                </span>
              )}
              <span className="sansheng-text-mute font-mono" style={{ fontSize: 10 }}>
                {todo.id}
              </span>
            </div>
            {(node.missingDeps.length > 0 || node.selfDep || strList(todo.dependsOn).length > 0) && (
              <div className="sansheng-text-mute font-mono mt-1" style={{ fontSize: 10, lineHeight: 1.6 }}>
                {strList(todo.dependsOn).length > 0 && <>依赖 {strList(todo.dependsOn).join(", ")}</>}
                {node.missingDeps.length > 0 && (
                  <span style={{ color: "var(--cinnabar)" }}>
                    {" · "}缺失依赖 {node.missingDeps.join(", ")}(本会话无此 todo,未建边)
                  </span>
                )}
                {node.selfDep && (
                  <span style={{ color: "var(--cinnabar)" }}>{" · "}自环依赖(按根节点处理)</span>
                )}
              </div>
            )}
            {failure && <FailureBlock info={failure} notes={outputs.filter((a) => a.kind === "note")} />}
            {genericOutputs.length > 0 && (
              <div className="grid gap-1 mt-2">
                {genericOutputs.map((a) => (
                  <OutputRow key={a.id} artifact={a} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {node.children.map((child) => (
        <div key={child.todo.id} className="mt-1">
          <TodoNodeView node={child} depth={depth + 1} outputsByTodo={outputsByTodo} />
        </div>
      ))}
    </div>
  );
}

function FailureBlock({ info, notes }: { info: FailureInfo; notes: Artifact[] }) {
  return (
    <div style={{ borderLeft: "2px solid var(--cinnabar)", paddingLeft: 8, marginTop: 6 }}>
      <div style={{ fontSize: 10 }} className="font-mono" >
        <span style={{ color: "var(--cinnabar)" }}>失败</span>
        {info.source !== "none" && (
          <span className="sansheng-text-mute">{" · " + FAILURE_SOURCE_LABEL[info.source]}</span>
        )}
      </div>
      {info.source === "none" ? (
        <div className="sansheng-text-mute" style={{ fontSize: 11 }}>
          无详细原因(见对话页错误提示)—— 该工件既没有 metadata.errorReason,正文也是空的。
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--bone-dim)", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
          {info.text}
        </div>
      )}
      {notes.map((n) => (
        <div key={n.id} style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: "var(--bone-dim)" }}>{n.title}</div>
          {n.body && (
            <div className="sansheng-text-mute" style={{ fontSize: 11, lineHeight: 1.6 }}>
              {excerpt(n.body, 240)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function OutputRow({ artifact }: { artifact: Artifact }) {
  return (
    <div
      className="rounded p-1"
      style={{ background: "var(--ink-1)", borderTop: "1px solid var(--ink-3)" }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Pill text={KIND_LABEL[artifact.kind] ?? artifact.kind} tone={KIND_TONE[artifact.kind] ?? "var(--bone-dim)"} />
        <Pill
          text={STATUS_LABEL[artifact.status] ?? artifact.status}
          tone={STATUS_TONE[artifact.status] ?? "var(--bone-mute)"}
        />
        <span className="sansheng-text-mute font-mono ml-auto" style={{ fontSize: 10 }}>
          {AUTHOR_LABEL[artifact.author] ?? artifact.author} · {fmtTime(artifact.createdAt)}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--bone)", lineHeight: 1.5 }}>{artifact.title}</div>
      {artifact.body && (
        <div className="sansheng-text-mute" style={{ fontSize: 11, lineHeight: 1.6 }}>
          {excerpt(artifact.body, 200)}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── 页面 ─────────────────────────────

interface Props {
  conversationId: string | null;
}

export function AgentsPage({ conversationId }: Props) {
  // artifactRevision:artifact 生命周期事件(批次 U1 接线)→ 回查
  const artifactRevision = useChatStore((s) => s.artifactRevision);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    void load();
  }, [load, artifactRevision]);

  const now = useNow(artifacts.length > 0);

  // §1 角色表:按 artifact.author 聚合(真实数据,没有就是没有)
  const byRole = useMemo(() => {
    const map = new Map<string, Artifact[]>();
    for (const a of artifacts) {
      const list = map.get(a.author);
      if (list) list.push(a);
      else map.set(a.author, [a]);
    }
    return map;
  }, [artifacts]);

  const todos = useMemo(() => artifacts.filter((a) => a.kind === "todo"), [artifacts]);
  const intents = useMemo(
    () => artifacts.filter((a) => a.kind === "intent").sort((a, b) => b.createdAt - a.createdAt),
    [artifacts],
  );

  // 结果工件 → todo 的反向索引(三条通道并查,见文件头)
  const outputsByTodo = useMemo(() => {
    const map = new Map<string, Artifact[]>();
    for (const a of artifacts) {
      if (!OUTPUT_KINDS.includes(a.kind)) continue;
      const targets = new Set<string>([
        ...strList(a.dependsOn),
        ...strList(a.refs),
        ...strList(a.metadata?.relatedArtifacts),
      ]);
      for (const t of targets) {
        const list = map.get(t);
        if (list) list.push(a);
        else map.set(t, [a]);
      }
    }
    for (const list of map.values()) list.sort((x, y) => x.createdAt - y.createdAt);
    return map;
  }, [artifacts]);

  const linkedOutputIds = useMemo(() => {
    const ids = new Set<string>();
    for (const list of outputsByTodo.values()) for (const a of list) ids.add(a.id);
    return ids;
  }, [outputsByTodo]);

  // 每块板 = 一个 intent 名下的 todo;孤儿(parentIntent 缺失/指向不存在的 intent)自成一板
  const boards = useMemo(() => {
    const intentIds = new Set(intents.map((i) => i.id));
    const orphanTodos = todos.filter((t) => !isString(t.parentIntent) || !intentIds.has(t.parentIntent));
    const list: Board[] = intents.map((intent) => ({
      key: intent.id,
      intent,
      todos: todos.filter((t) => t.parentIntent === intent.id),
    }));
    if (orphanTodos.length > 0) {
      list.push({ key: "__orphan__", intent: null, todos: orphanTodos });
    }
    return list;
  }, [intents, todos]);

  // ③ 阻塞队列:waiting_for_decision 的 todo(全会话,不按 intent 切)
  const waitingTodos = useMemo(
    () => todos.filter((t) => t.status === "waiting_for_decision"),
    [todos],
  );

  // ④ 沉淀区:活下来的 decision / note / reflection,已挂在 DAG 节点下的不重复列
  const settled = useMemo(
    () =>
      artifacts
        .filter((a) => SETTLED_KINDS.includes(a.kind) && ALIVE_STATUSES.includes(a.status))
        .sort((a, b) => b.createdAt - a.createdAt),
    [artifacts],
  );
  const settledTop = useMemo(
    () => settled.filter((a) => !linkedOutputIds.has(a.id)),
    [settled, linkedOutputIds],
  );
  const settledLinked = settled.length - settledTop.length;

  const otherAuthors = useMemo(
    () => [...byRole.keys()].filter((k) => !REAL_AGENT_SET.has(k)),
    [byRole],
  );

  const kindSummary = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const a of artifacts) acc[a.kind] = (acc[a.kind] ?? 0) + 1;
    return Object.entries(acc)
      .map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`)
      .join(" · ");
  }, [artifacts]);

  return (
    <main className="px-4 pb-4">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <h2 className="sansheng-h2">Agents & Blackboard</h2>
        <div className="text-xs sansheng-text-mute font-mono">
          {artifacts.length} 个工件{kindSummary ? ` · ${kindSummary}` : ""}
          {loading ? " · 刷新中" : ""}
        </div>
      </div>

      {error && (
        <div className="sansheng-card p-3 text-xs mb-3" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      )}

      {!conversationId ? (
        <div className="sansheng-card p-4 text-sm opacity-80">
          先在「对话」选一个会话,再切换到「Agent」查看 blackboard。
        </div>
      ) : (
        <div className="grid gap-3">
          {loading && artifacts.length === 0 ? (
            <div className="sansheng-card p-4 text-sm opacity-80">加载中…</div>
          ) : artifacts.length === 0 ? (
            <div className="sansheng-card p-4 text-sm opacity-80">
              <EmptyHint>
                本会话还没有任何工件,所以四区(意图头 / DAG / 阻塞队列 / 沉淀区)没有内容可画 ——
                这是真实空态,不是没接上。
                <br />
                发送 <code>/plan 你的目标</code> 后,communicator 会写 intent、planner 会写带
                dependsOn 的 todo,executor 的产出落在节点下。
              </EmptyHint>
            </div>
          ) : (
            <>
              {boards.map((board) => {
                const forest = buildDag(board.todos);
                const own = board.todos;
                const done = own.filter(
                  (t) => t.status === "resolved" || t.status === "superseded",
                ).length;
                const failed = own.filter((t) => t.status === "failed").length;
                const waiting = own.filter((t) => t.status === "waiting_for_decision").length;
                const intentFailure =
                  board.intent && board.intent.status === "failed"
                    ? failureInfo(board.intent, outputsByTodo.get(board.intent.id) ?? [])
                    : null;
                return (
                  <div key={board.key} className="grid gap-3">
                    {/* ① 意图头 */}
                    <section className="sansheng-card p-4">
                      <SectionTitle
                        right={
                          board.intent
                            ? `提出者 ${AUTHOR_LABEL[board.intent.author] ?? board.intent.author} · ${fmtTime(
                                board.intent.createdAt,
                              )}`
                            : "无 intent 工件"
                        }
                      >
                        ① 意图头
                      </SectionTitle>
                      {board.intent ? (
                        <>
                          <div className="flex items-start gap-2">
                            <Pill
                              text={STATUS_LABEL[board.intent.status] ?? board.intent.status}
                              tone={STATUS_TONE[board.intent.status] ?? "var(--bone-mute)"}
                            />
                            <div className="text-sm" style={{ color: "var(--bone)", lineHeight: 1.5 }}>
                              {board.intent.title}
                            </div>
                          </div>
                          <div className="sansheng-text-mute mt-2" style={{ fontSize: 11, lineHeight: 1.7 }}>
                            已耗时 {fmtDuration(now - board.intent.createdAt)}
                            {" · "}
                            {own.length} 个 todo · {done} 完成 · {waiting} 等决策 · {failed} 失败
                            {forest.anomalyCount + forest.detached.length > 0 &&
                              ` · ${forest.anomalyCount + forest.detached.length} 处依赖异常`}
                          </div>
                          {intentFailure && (
                            <FailureBlock
                              info={intentFailure}
                              notes={(outputsByTodo.get(board.intent.id) ?? []).filter(
                                (a) => a.kind === "note",
                              )}
                            />
                          )}
                        </>
                      ) : (
                        <EmptyHint>
                          本会话没有 intent 工件,下面这 {own.length} 个待办的 parentIntent
                          指向了不存在的 intent(或没写),单独成板以免丢数据。
                        </EmptyHint>
                      )}
                    </section>

                    {/* ② DAG 区 */}
                    <section className="sansheng-card p-4">
                      <SectionTitle
                        right={`${own.length} 个 todo · ${forest.roots.length} 个根${
                          forest.detached.length > 0 ? ` · ${forest.detached.length} 个未挂载` : ""
                        }`}
                      >
                        ② DAG 区
                      </SectionTitle>
                      {own.length === 0 ? (
                        <EmptyHint>
                          这个意图名下没有 todo 工件(Planner 还没写,或已被清理)。树状布局按
                          dependsOn 画边,没有 todo 就没有边可画。
                        </EmptyHint>
                      ) : (
                        <div className="grid gap-1">
                          {forest.roots.map((node) => (
                            <TodoNodeView
                              key={node.todo.id}
                              node={node}
                              depth={0}
                              outputsByTodo={outputsByTodo}
                            />
                          ))}
                          {forest.detached.length > 0 && (
                            <div
                              className="rounded p-2 mt-2"
                              style={{ border: "1px solid var(--cinnabar)" }}
                            >
                              <div style={{ fontSize: 11, color: "var(--cinnabar)" }}>
                                依赖成环,这 {forest.detached.length} 个 todo 从任何根都到不了,
                                单独列出(不丢数据、不假装它们有父节点):
                              </div>
                              <div className="grid gap-1 mt-1">
                                {forest.detached.map((t) => (
                                  <div
                                    key={t.id}
                                    className="rounded p-1"
                                    style={{ background: "var(--ink-1)" }}
                                  >
                                    <div style={{ fontSize: 12, color: "var(--bone)" }}>{t.title}</div>
                                    <div className="sansheng-text-mute font-mono" style={{ fontSize: 10 }}>
                                      <Pill
                                        text={STATUS_LABEL[t.status] ?? t.status}
                                        tone={STATUS_TONE[t.status] ?? "var(--bone-mute)"}
                                      />
                                      {"  "}
                                      依赖 {strList(t.dependsOn).join(", ") || "—"} · {t.id}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </section>
                  </div>
                );
              })}

              <div className="grid grid-cols-2 gap-3">
                {/* ③ 阻塞队列 */}
                <section className="sansheng-card p-4">
                  <SectionTitle right={`${waitingTodos.length} 个待办卡在等决策`}>③ 阻塞队列</SectionTitle>
                  {waitingTodos.length === 0 ? (
                    <EmptyHint>
                      本会话没有 status=waiting_for_decision 的待办 —— executor 没有卡在拍板上
                      (这不代表它们都跑完了,失败与未开始的去看 ② DAG 区)。
                    </EmptyHint>
                  ) : (
                    <div className="grid gap-2">
                      {waitingTodos.map((t) => {
                        const waited = now - t.updatedAt;
                        const overFail = waited >= FAIL_MS;
                        const overEscalation = waited >= ESCALATION_MS;
                        return (
                          <div
                            key={t.id}
                            className="rounded p-2"
                            style={{
                              background: "var(--ink-1)",
                              borderLeft: `2px solid ${overFail ? "var(--cinnabar)" : "var(--amber)"}`,
                            }}
                          >
                            <div style={{ fontSize: 12, color: "var(--bone)", lineHeight: 1.5 }}>
                              {t.title}
                            </div>
                            <div className="sansheng-text-mute font-mono mt-1" style={{ fontSize: 10 }}>
                              已等 {fmtDuration(waited)}
                              {overEscalation && (
                                <span style={{ color: overFail ? "var(--cinnabar)" : "var(--amber)" }}>
                                  {overFail ? " · 已过 1 小时判失败阈值" : " · 已过 5 分钟升级阈值"}
                                </span>
                              )}
                            </div>
                            <div className="sansheng-text-mute font-mono" style={{ fontSize: 10 }}>
                              {t.executors?.length ? `${t.executors.join(", ")} · ` : ""}
                              最后写入 {fmtTime(t.updatedAt)}
                            </div>
                            {t.body && (
                              <div className="sansheng-text-mute mt-1" style={{ fontSize: 11, lineHeight: 1.6 }}>
                                {excerpt(t.body, 160)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <div className="sansheng-text-mute" style={{ fontSize: 10, lineHeight: 1.6 }}>
                        等待时长 = 现在 − 工件 updatedAt,是
                        <span style={{ color: "var(--bone-dim)" }}>估算值</span>:updatedAt 只是「最后一次
                        写入时间」,不等于后台 waiting 队列的入队时刻(该队列无 getter / 事件,
                        要等状态快照接口补齐才是真计时)。阈值取 orchestrator 的默认
                        escalationMs=5 分钟 / failMs=1 小时,自建实例改过这两个参数时页面上看不到。
                      </div>
                    </div>
                  )}
                </section>

                {/* ④ 沉淀区 */}
                <section className="sansheng-card p-4">
                  <SectionTitle
                    right={`${settledTop.length} 条${
                      settledLinked > 0 ? ` · 另 ${settledLinked} 条已挂在 DAG 节点下` : ""
                    }`}
                  >
                    ④ 沉淀区
                  </SectionTitle>
                  {settledTop.length === 0 ? (
                    <EmptyHint>
                      {settled.length === 0
                        ? "本会话没有活下来的 decision / note / reflection(被取代 superseded 和失败的都不算)。"
                        : "本会话的 decision / note / reflection 全部已作为执行结果挂在 ② DAG 区节点下,不在此重复列出。"}
                    </EmptyHint>
                  ) : (
                    <div className="grid gap-2">
                      {settledTop.map((a) => (
                        <OutputRow key={a.id} artifact={a} />
                      ))}
                      <div className="sansheng-text-mute" style={{ fontSize: 10, lineHeight: 1.6 }}>
                        「活下来」= status 不在 failed / superseded 里(被取代的结论不算)。
                      </div>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}

          {/* §1 角色表 */}
          <section className="sansheng-card p-4">
            <SectionTitle right={`本会话 ${artifacts.length} 个工件`}>Agent 角色表</SectionTitle>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left sansheng-text-mute">
                  <th style={{ fontSize: 11 }}>角色</th>
                  <th style={{ fontSize: 11 }}>提示词</th>
                  <th style={{ fontSize: 11 }}>产出</th>
                  <th style={{ fontSize: 11 }}>最新</th>
                </tr>
              </thead>
              <tbody>
                {REAL_AGENTS.map((r) => {
                  const items = byRole.get(r);
                  const last = items ? items[items.length - 1] : undefined;
                  return (
                    <tr key={r} style={{ borderTop: "1px solid var(--ink-3)" }}>
                      <td className="py-1">{r}</td>
                      <td className="font-mono sansheng-text-mute" style={{ fontSize: 11 }}>
                        {AGENT_PROMPT_SOURCE[r]}
                      </td>
                      <td className="font-mono sansheng-text-mute">{items ? items.length : "—"}</td>
                      <td
                        className="truncate"
                        style={{ maxWidth: 200, color: last ? "var(--bone-dim)" : undefined }}
                        title={last ? `${last.title} · ${fmtTime(last.createdAt)}` : undefined}
                      >
                        {last ? last.title : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="sansheng-text-mute mt-2" style={{ fontSize: 11, lineHeight: 1.7 }}>
              「—」= 本会话没有该角色产出的工件(不是「空闲」,后端没有 per-role 运行态接口,
              这里展示的是工件作者维度的事实)。
              {harnessNote(artifacts)}
            </div>
            {otherAuthors.length > 0 && (
              <div className="sansheng-text-mute mt-1" style={{ fontSize: 11, lineHeight: 1.7 }}>
                本会话还出现过的其它工件作者:
                {otherAuthors.map((k) => AUTHOR_LABEL[k] ?? k).join(" · ")}
              </div>
            )}
            <div className="sansheng-text-mute mt-1" style={{ fontSize: 11, lineHeight: 1.7 }}>
              只列这 4 个:critic / memory / reflection 没有实现,也没有任何代码读它们的
              harness 提示词,决定暂不实现,故界面不列出(不摆点不亮的灰行)。
            </div>
            <div className="sansheng-text-mute mt-1" style={{ fontSize: 11, lineHeight: 1.7 }}>
              称呼按设计文档 §1.1:角色名在本表用英文 id(它是配置键 / harness 文件名,
              旁边就是「提示词来源」);工件上的「谁产出的」用中文读法(沟通员 / 规划员 /
              执行员)。未知 author 值原样透出,不猜。
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

/** harness_manager 在工件里几乎没有 author —— 如实说明,不要留一个光秃秃的 0。 */
function harnessNote(artifacts: Artifact[]): string {
  if (artifacts.some((a) => a.author === "harness_manager")) return "";
  return " harness_manager 提示词编译在代码里(没有 md 文件),且它只对 harness_proposal 工件有反应 —— 本会话没有它的产出。";
}
