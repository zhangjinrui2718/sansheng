/**
 * Sansheng · Agents 页(P0-A:blackboard 工作面 + 真实角色表)
 *
 * 依据:`docs/PRODUCT-DESIGN-2026-10-02.md` §1(角色表)与 §3(Blackboard 四区),
 * 对应排期 P0 #1(四区工作面)/ #4(只列 4 个真实 agent)/ #6(失败原因可见)。
 * 零后端改动:本文件只重新组织**已有**工件数据,不动 DB、不加端点、不动 WS 事件。
 *
 * ── 批次 UI U4:屏幕文字分层(本页)──────────────────────────────────
 * 这一版**没有增删任何数据源**,只重新组织已经在屏幕上的东西。原则一句话:
 * **结论留在屏幕上,解释移进 `Disclosure` / `title=`,开发者自述回到本注释。**
 * 为了让这段搬移可回溯(也为了后来的人能一眼看出「哪句话被挪到哪儿了」),
 * 逐条记录:
 *  - 四区的编号「① 意图头 / ② DAG 区 / ③ 阻塞队列 / ④ 沉淀区」删除 ——
 *    那是产品设计文档的行号,对读页面的人零信息量(见 primitives.tsx 的 Section)。
 *    「意图头」与「DAG 区」并成**一张卡**:意图标题 + 状态 + 一行健康度,下面直接是树。
 *  - DAG 节点上原来那行 `依赖 todo-1, todo-2` 与裸 id `{todo.id}` → 节点 `title=`。
 *    ⚠️ 这里修的是一个**把正常当异常显示**的旧 bug:旧代码的渲染条件是
 *    `missingDeps.length > 0 || selfDep || dependsOn.length > 0` —— 于是**每个正常的
 *    有依赖节点**都渲染一行「缺失依赖 …(本会话无此 todo,未建边)」样式的元信息,
 *    即使 missingDeps 是空的。现在:**没有异常就什么都不显示**;缺失依赖 / 自环
 *    是真异常,仍然留在屏幕上(配一个 cinnabar Pill + 明细),不进折叠层。
 *  - 每个节点无条件挂的「未声明 executor」pill → **只在真的声明了 executor 时才挂**;
 *    没声明不是一条需要通知读者的信息。未声明的事实并进节点 `title=`。
 *  - 失败原因旁的「来源 metadata.errorReason(…)」/「来源工件正文(planner 写的
 *    待办描述,通常不含失败信息)」长标签 → `<Pill>来源</Pill>`,全句进 `title=`。
 *    **失败正文本身一个字没删**(P0 #6:这是全页最高价值的信息,不受本次分层影响)。
 *    「无详细原因(见对话页错误提示)—— 该工件既没有 metadata.errorReason,正文也是
 *    空的。」保留前半句,后半句进 `title=`。
 *  - 阻塞队列末尾 5 行「等待时长是估算值」脚注 → `<Disclosure summary="等待时长怎么算的">`,
 *    **原文一字未改** —— 这是反造假口径,不许丢,只是不再要求每个读者读完。
 *  - 沉淀区脚注「「活下来」= status 不在 failed / superseded 里」→ 本注释 + Section 的一行 hint。
 *  - 角色表后面 4 段解释(「—」的含义 / 术语规则 / 只列 4 个角色的理由 /
 *    harness_manager 的提示词来源)→ 全部搬进本注释;页面上只留**一行** `ss-note`
 *    + 它的 `title=`(三种事实各留一句最短的说法,详见 ROLE_TABLE_NOTE)。
 *  - 抬头那串 kind 汇总(「意图 2 · 待办 6 · 笔记 1」)→ `PageHeader` 的 `hintTitle`
 *    (悬停可见),as StatStrip 的主体在右侧。
 *  **反造假纪律没有放松**:每一个数字仍然是对**本次真实数组** filter 后的 `.length`,
 *    阈值仍是 orchestrator 的默认值(见下方阻塞队列段),没有一处新造的指标。
 *
 * ── 数据源(唯一)──────────────────────────────────────────────────────
 * `GET /api/artifacts?conversationId=<id>&limit=200` → `{ artifacts: BlackboardArtifact[] }`
 * (src/server/http/blackboardRoutes.ts),经 `lib/artifacts.ts` 的 `useArtifacts()` 读取
 * —— 与本文件自己的 fetch 逐字等价(同端点 / 同 limit / 同错误解析),只是不再抄第四份。
 * 实时性仍靠 WS 的 `artifact_created` / `artifact_status_changed` / `plan_done` 汇总出的
 * `artifactRevision` 计数触发回查;**不把工件本体塞进 store**,权威数据永远回查后端。
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
 * 称呼按 §1.1 术语规则:角色表里是配置键/文件名 → 英文 id;工件上的「谁产出的」→ 中文读法
 * (实现即 `lib/artifacts.ts` 的 `authorLabel()` / `AUTHOR_LABEL`,共享给四个页面)。
 *
 * ROLE_TABLE_NOTE(页面上一行 `ss-note` 的 `title=`,原文):
 *   「—」= 本会话没有该角色产出的工件,不是「空闲」—— 后端没有 per-role 运行态接口,
 *   这里展示的是**工件作者维度的事实**。表内用英文 id,因为它是配置键 / harness
 *   文件名(旁边那列就是「提示词来源」);工件上的「谁产出的」用中文读法。未知 author
 *   值原样透出,不猜。只列这 4 个:critic / memory / reflection 没有实现,也没有任何
 *   代码读它们的 harness 提示词,故界面不列出(不摆点不亮的灰行)。
 *
 * ── 每块板的字段(为什么用这些、不用别的)───────────────────────────
 * 意图头 —— `intent.title/status/author/createdAt` + 名下 todo 的 status 聚合。
 *    **健康度一行是 P0 最关键的修复**:旧版只写 `todo 0/6 done`,而实测
 *    conv_muqsidb0_wgru 的 6 个 todo **全部 failed**,失败原因完全不可见。
 *    现在失败数是 `status==="failed"` 的 todo 计数(真实字段,不是推断)。
 *    「已耗时」用 `Date.now()-createdAt`,靠 `useNow` 的 1s tick 驱动重渲染
 *    —— 页面不轮询后端,只重算展示值。
 * DAG 区 —— todo 是节点、`dependsOn` 是边,**树状缩进**而非 canvas:
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
 * 阻塞队列 —— `status==="waiting_for_decision"` 的 todo 单独一条泳道。
 *    这是整个系统最有信息量的状态(executor 卡住等人拍板),旧版完全不可见。
 *    等待时长 = `Date.now()-updatedAt`,**页面上明写这是估算**(Disclosure 里):
 *    工件 updatedAt 是「最后一次写入时间」,不等于后台 `waiting` map 的入队时刻
 *    (那个 map 是 private,无 getter / HTTP / 事件,只能 P1 补发)。阈值色标取
 *    `orchestrator.ts:207-208` 的默认 escalationMs(5 分钟)/ failMs(1 小时),
 *    同样是默认值不是运行实例的实配值。
 * 沉淀区 —— `decision` / `note` / `reflection` 中「还活着」的:
 *    status ∉ {failed, superseded}(被取代的结论不算活下来的)。
 *    已经在 DAG 节点下作为执行结果展示的不重复列,只在一行注明数量。
 *
 * ── P0 #6 失败原因可见 ──────────────────────────────────────────────
 * 取值优先级:`metadata.errorReason`(字符串)→ `body` → 「无详细原因(见对话页错误提示)」。
 * 两处刻意加了限定,否则会**说谎**:
 *  - 走 `body` 分支时出处标「工件正文」:todo 的 body 是 **planner 写的待办描述**,
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
 * 根元素是 `<div className="ss-page">`(不是 `<main>`:app shell 已经拥有滚动容器和
 * `<main>`,嵌套 `<main>` 是无效 HTML)。字号层级交给 `components/ui/primitives` +
 * globals.css 的 `.ss-*` 类,标签映射(kind / status / author / 时长)交给
 * `lib/artifacts.ts` 的共享词表 —— 本文件**不再自持任何标签表或 Pill/Section 组件**。
 * 状态用色点 + mono pill 表达,不用 emoji 当 UI 标签。
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ArtifactKind } from "@shared/types/blackboard";
import {
  ALIVE_STATUSES,
  PLAN_HOWTO,
  TERMINAL_STATUSES,
  authorLabel,
  excerpt,
  fmtDuration,
  fmtTime,
  isString,
  kindLabel,
  kindTone,
  statusLabel,
  statusTone,
  strList,
  useArtifacts,
} from "@/lib/artifacts";
import type { Artifact } from "@/lib/artifacts";
import {
  Clamp,
  Disclosure,
  EmptyState,
  Flag,
  PageHeader,
  Pill,
  Section,
  StatStrip,
  toneColor,
} from "@/components/ui/primitives";
import type { Tone } from "@/components/ui/primitives";

// ───────────────────────────── 静态表 ─────────────────────────────

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

/** DAG 节点下挂的结果工件种类(设计文档 §3②「evidence / hypothesis / failure」)。 */
const OUTPUT_KINDS: ArtifactKind[] = ["evidence", "hypothesis", "note"];

/** 沉淀区:事后活下来的 kind。 */
const SETTLED_KINDS: ArtifactKind[] = ["decision", "note", "reflection"];

/** orchestrator.ts:207-208 的默认 escalationMs / failMs(实配值 UI 读不到,页面上注明)。 */
const ESCALATION_MS = 5 * 60 * 1000;
const FAIL_MS = 60 * 60 * 1000;

/** StatStrip 的 item 类型(与 primitives 一致,用于在 useMemo 外组装常量数组)。 */
interface Stat {
  label: string;
  value: ReactNode;
  tone?: Tone;
  title?: string;
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

/**
 * 出处说明。页面上只显示 `Pill「来源」`,全文走 `title=`(悬停可见)——
 * 限定语必须留着:走 body 分支时,那句话里的「通常不含失败信息」是本条最容易
 * 被误读成「这就是失败原因」的地方。
 */
const FAILURE_SOURCE_TITLE: Record<FailureSource, string> = {
  errorReason: "来源 metadata.errorReason(写入方在工件上记录的失败原因)",
  body: "来源工件正文(planner 写的待办描述,通常不含失败信息)",
  note: "来源该节点产出的失败记录(note 工件的标题)",
  none: "",
};

/** 失败原因彻底取不到时的兜底文案(后半句解释进 title=)。 */
const NO_REASON_NOTE =
  "该工件既没有 metadata.errorReason,正文也是空的,后端未记录更细的失败原因。";

/** 角色表那三件事(「—」的含义 / 术语规则 / 为什么只有 4 个角色)的完整解释。 */
const ROLE_TABLE_NOTE =
  "「—」= 本会话没有该角色产出的工件,不是「空闲」—— 后端没有 per-role 运行态接口," +
  "这里展示的是工件作者维度的事实。表内用英文 id,因为它是配置键 / harness 文件名" +
  "(旁边那列就是「提示词来源」);工件上的「谁产出的」用中文读法。未知 author 值原样透出,不猜。" +
  " 只列这 4 个:critic / memory / reflection 没有实现,也没有任何代码读它们的 harness 提示词,故界面不列出。";

/** 等待时长的估算口径(原文照抄,进 Disclosure;见文件头阻塞队列段)。 */
const WAIT_ESTIMATE_NOTE = (
  <>
    等待时长 = 现在 − 工件 updatedAt,是<b>估算值</b>:updatedAt 只是「最后一次写入时间」,
    不等于后台 waiting 队列的入队时刻(该队列无 getter / 事件,要走状态快照接口补齐才是真计时)。
    阈值取 orchestrator 的默认 escalationMs = 5 分钟 / failMs = 1 小时,自建实例改过这两个参数时页面上看不到。
  </>
);

// ───────────────────────────── 节点视图 ─────────────────────────────

interface TodoNodeViewProps {
  node: DagNode;
  depth: number;
  outputsByTodo: Map<string, Artifact[]>;
}

/**
 * DAG 的一个节点。屏幕上只有「状态色点 + 标题 + 状态 pill(非 open 时)+ 终态用时
 * + 已声明的 executor」;裸 id / 依赖 id 进 `title=`。
 * **异常(缺失依赖 / 自环)例外 —— 它必须可见**(配 cinnabar Pill 与一行明细),
 * 这是「关系不假装」的落点,不是噪声。
 */
function TodoNodeView({ node, depth, outputsByTodo }: TodoNodeViewProps) {
  const todo = node.todo;
  const outputs = outputsByTodo.get(todo.id) ?? [];
  const failed = todo.status === "failed";
  const failure = failed ? failureInfo(todo, outputs) : null;
  // 失败 todo 的 note 是失败原因本身,已在失败块里展开,不再进通用结果列表。
  const genericOutputs = failed ? outputs.filter((a) => a.kind !== "note") : outputs;
  const terminal = TERMINAL_STATUSES.includes(todo.status);
  const tone = statusTone(todo.status);
  const deps = strList(todo.dependsOn);
  const executors = strList(todo.executors);
  const anomaly = node.missingDeps.length > 0 || node.selfDep;

  // 节点原始字段(id / 依赖 / executor / 异常明细)——只在悬停时出现。
  const rawTitle = [
    todo.id,
    deps.length > 0 ? `依赖 ${deps.join(", ")}` : null,
    executors.length > 0 ? `executor ${executors.join(", ")}` : "未声明 executor",
    ...node.missingDeps.map((d) => `缺失依赖 ${d}(本会话无此 todo,未建边)`),
    node.selfDep ? "自环依赖(按根节点处理)" : null,
  ]
    .filter((s): s is string => s !== null)
    .join(" · ");

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
              background: toneColor(tone),
              flex: "0 0 auto",
              marginTop: 6,
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap" title={rawTitle}>
              <span className="ss-body" style={{ color: "var(--bone)" }}>
                {todo.title}
              </span>
              {/* open 的色点已经说完了(「还没开始」),不再挂同义的 pill。 */}
              {todo.status !== "open" && <Pill tone={tone}>{statusLabel(todo.status)}</Pill>}
              {anomaly && (
                <Pill tone="cinnabar" title={rawTitle}>
                  依赖异常
                </Pill>
              )}
              {executors.length > 0 && <Pill tone="bone" title="工件 executors 字段(谁被指派执行)">指派 {executors.join(", ")}</Pill>}
              {terminal && <span className="ss-meta">用时 {fmtDuration(todo.updatedAt - todo.createdAt)}</span>}
            </div>
            {anomaly && (
              <div className="ss-meta" style={{ color: "var(--cinnabar)" }}>
                {[
                  node.missingDeps.length > 0
                    ? `缺失依赖 ${node.missingDeps.join(", ")}(本会话无此 todo,未建边)`
                    : null,
                  node.selfDep ? "自环依赖(按根节点处理)" : null,
                ]
                  .filter((s): s is string => s !== null)
                  .join(" · ")}
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
    <Flag tone="cinnabar">
      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
        <Pill tone="cinnabar">失败</Pill>
        {info.source !== "none" && (
          <Pill tone="bone" title={FAILURE_SOURCE_TITLE[info.source]}>
            来源
          </Pill>
        )}
      </div>
      {info.source === "none" ? (
        <div className="ss-note" title={NO_REASON_NOTE}>
          无详细原因(见对话页错误提示)
        </div>
      ) : (
        <div className="ss-body" style={{ whiteSpace: "pre-wrap" }}>
          {info.text}
        </div>
      )}
      {notes.map((n) => (
        <div key={n.id} className="mt-1">
          <div className="ss-body">{n.title}</div>
          {n.body && <div className="ss-note">{excerpt(n.body, 240)}</div>}
        </div>
      ))}
    </Flag>
  );
}

function OutputRow({ artifact }: { artifact: Artifact }) {
  return (
    <div
      className="rounded p-1"
      style={{ background: "var(--ink-1)", borderTop: "1px solid var(--ink-3)" }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Pill tone={kindTone(artifact.kind)}>{kindLabel(artifact.kind)}</Pill>
        {artifact.status !== "open" && (
          <Pill tone={statusTone(artifact.status)}>{statusLabel(artifact.status)}</Pill>
        )}
        <span className="ss-meta ml-auto">
          {authorLabel(artifact.author)} · {fmtTime(artifact.createdAt)}
        </span>
      </div>
      <div className="ss-body" style={{ color: "var(--bone)" }}>
        {artifact.title}
      </div>
      {/* 结果工件的正文可能有几百字(实测 evidence 常常是整篇调研报告),压到两行:
          全文在工件页与对话页都拿得到,这里要的是「产出了什么」而不是全文。 */}
      {artifact.body && (
        <Clamp lines={2}>
          <span className="ss-note">{excerpt(artifact.body, 200)}</span>
        </Clamp>
      )}
    </div>
  );
}

// ───────────────────────────── 一块板 ─────────────────────────────

interface IntentCardProps {
  board: Board;
  now: number;
  outputsByTodo: Map<string, Artifact[]>;
}

/** 一块板 = **一张卡**:意图标题 + 状态 + 健康度一行,下面直接是执行树。 */
function IntentCard({ board, now, outputsByTodo }: IntentCardProps) {
  const intent = board.intent;
  const own = board.todos;
  const forest = useMemo(() => buildDag(own), [own]);
  const done = own.filter((t) => t.status === "resolved" || t.status === "superseded").length;
  const failed = own.filter((t) => t.status === "failed").length;
  const waiting = own.filter((t) => t.status === "waiting_for_decision").length;
  const anomalies = forest.anomalyCount + forest.detached.length;
  const intentOutputs = intent ? (outputsByTodo.get(intent.id) ?? []) : [];
  const intentFailure =
    intent && intent.status === "failed" ? failureInfo(intent, intentOutputs) : null;

  const stats: Stat[] = [
    { label: "待办", value: own.length },
    { label: "完成", value: done, tone: done > 0 ? "bamboo" : undefined },
    { label: "等决策", value: waiting, tone: waiting > 0 ? "amber" : undefined },
    { label: "失败", value: failed, tone: failed > 0 ? "cinnabar" : undefined },
  ];
  if (anomalies > 0) stats.push({ label: "依赖异常", value: anomalies, tone: "cinnabar" });
  if (intent) stats.push({ label: "已耗时", value: fmtDuration(now - intent.createdAt) });

  return (
    <section className="sansheng-card p-4">
      <div className="flex items-start gap-2 flex-wrap">
        {intent ? (
          <>
            <Pill tone={statusTone(intent.status)} title={`intent 状态:${statusLabel(intent.status)}`}>
              {statusLabel(intent.status)}
            </Pill>
            <span className="ss-body" style={{ color: "var(--bone)" }}>
              {intent.title}
            </span>
          </>
        ) : (
          <span className="ss-body" style={{ color: "var(--bone)" }}>
            未归属意图的待办
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <StatStrip items={stats} />
        <span className="ss-meta">
          {intent
            ? `提出者 ${authorLabel(intent.author)} · ${fmtTime(intent.createdAt)}`
            : "未归属任何意图"}
        </span>
      </div>
      {intentFailure && (
        <FailureBlock
          info={intentFailure}
          notes={intentOutputs.filter((a) => a.kind === "note")}
        />
      )}

      <div className="mt-3">
        <Section
          title="执行树"
          count={own.length}
          hint={own.length > 0 ? `${forest.roots.length} 个根` : undefined}
        >
          {own.length === 0 ? (
            <EmptyState>这个意图下还没有 todo 工件。</EmptyState>
          ) : (
            <div className="grid gap-1">
              {forest.roots.map((node) => (
                <TodoNodeView key={node.todo.id} node={node} depth={0} outputsByTodo={outputsByTodo} />
              ))}
              {forest.detached.length > 0 && (
                <div
                  className="rounded p-2 mt-2"
                  style={{ border: "1px solid var(--cinnabar)" }}
                >
                  <div className="ss-note" style={{ color: "var(--cinnabar)" }}>
                    成环,这 {forest.detached.length} 个待办从任何根都到不了,单独列出。
                  </div>
                  <div className="grid gap-1 mt-1">
                    {forest.detached.map((t) => (
                      <div
                        key={t.id}
                        className="rounded p-1"
                        style={{ background: "var(--ink-1)" }}
                      >
                        <div className="ss-body" style={{ color: "var(--bone)" }}>
                          {t.title}
                        </div>
                        <div className="ss-meta" title={`${t.id} · 依赖 ${strList(t.dependsOn).join(", ") || "—"}`}>
                          <Pill tone={statusTone(t.status)}>{statusLabel(t.status)}</Pill>
                          <span className="ml-1">
                            依赖 {strList(t.dependsOn).join(", ") || "—"} · {t.id}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Section>
      </div>
    </section>
  );
}

// ───────────────────────────── 页面 ─────────────────────────────

interface Props {
  conversationId: string | null;
}

export function AgentsPage({ conversationId }: Props) {
  const { artifacts, loading, error } = useArtifacts();
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

  // 阻塞队列:waiting_for_decision 的 todo(全会话,不按 intent 切)
  const waitingTodos = useMemo(
    () => todos.filter((t) => t.status === "waiting_for_decision"),
    [todos],
  );

  // 沉淀区:活下来的 decision / note / reflection,已挂在执行树下的不重复列
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

  const failedTodos = useMemo(() => todos.filter((t) => t.status === "failed").length, [todos]);

  // kind 汇总:每个数字都是本次真实数组的计数,只是不再常驻屏幕(见 PageHeader hintTitle)
  const kindSummary = useMemo(() => {
    const acc = new Map<string, number>();
    for (const a of artifacts) acc.set(a.kind, (acc.get(a.kind) ?? 0) + 1);
    return [...acc.entries()].map(([k, n]) => `${kindLabel(k)} ${n}`).join(" · ");
  }, [artifacts]);

  const headerStats: Stat[] = [
    { label: "工件", value: artifacts.length },
    { label: "意图", value: intents.length },
    { label: "待办", value: todos.length },
    { label: "等决策", value: waitingTodos.length, tone: waitingTodos.length > 0 ? "amber" : undefined },
    { label: "失败", value: failedTodos, tone: failedTodos > 0 ? "cinnabar" : undefined },
  ];
  if (loading && artifacts.length > 0) headerStats.push({ label: "状态", value: "刷新中", tone: "mute" });

  return (
    <div className="ss-page">
      <PageHeader
        title="Agent 工作面"
        // 空页不挂 hint:「本会话的 blackboard」这类说明,在下面就写着「还没有工件」
        // 时是纯噪声;而且 blackboard 是内部术语,不是用户会用的词。
        hint={artifacts.length > 0 ? "本会话的 agent 产出" : undefined}
        hintTitle={
          kindSummary
            ? `${kindSummary} —— 本页只读本会话的工件(GET /api/artifacts,limit=200),实时性靠 WS 的工件事件触发回查,不轮询。`
            : "本页只读本会话的工件(GET /api/artifacts,limit=200),实时性靠 WS 的工件事件触发回查,不轮询。"
        }
        // 同理,空页不摆一排 0。那五个 0 在没有数据时不是「测出来的 0」,
        // 只是「还没查 / 查了是空」—— 摆出来等于拿计数冒充事实。
        aside={artifacts.length > 0 ? <StatStrip items={headerStats} /> : undefined}
      />

      {error && (
        <Flag tone="cinnabar">
          <span className="ss-body" style={{ color: "var(--cinnabar)" }}>
            加载失败:{error}
          </span>
        </Flag>
      )}

      {!conversationId ? (
        <EmptyState>先在「对话」里选一个会话。</EmptyState>
      ) : loading && artifacts.length === 0 ? (
        <EmptyState>加载中…</EmptyState>
      ) : artifacts.length === 0 ? (
        <EmptyState>
          {/* 旧文案写「发送 /plan 你的目标」—— 读起来像**要照抄的字面量**,而
              ChatSurface 判的是 `text.startsWith("/plan ")`,真照抄进去 goal 就是
              「你的目标」四个字,规划员会老老实实去规划「你的目标」。
              句式改成「以 /plan 开头发一条,后面跟你的目标」,句法本身说明了只有
              /plan 是字面量;三页共用 PLAN_HOWTO,免得又各写一遍漂移。 */}
          本会话还没有工件 —— 普通的聊天不会产生工件。{PLAN_HOWTO}
        </EmptyState>
      ) : (
        <div className="grid gap-3">
          {boards.map((board) => (
            <IntentCard key={board.key} board={board} now={now} outputsByTodo={outputsByTodo} />
          ))}

          <div className="grid gap-3 lg:grid-cols-2">
            {/* 阻塞队列 */}
            <Section
              title="等决策"
              count={waitingTodos.length}
              hint="executor 卡住等人拍板"
              className="sansheng-card p-4"
              aside={<Pill tone="mute" title="status = waiting_for_decision">waiting_for_decision</Pill>}
            >
              {waitingTodos.length === 0 ? (
                <EmptyState>没有待办卡在等决策(不代表都跑完了)。</EmptyState>
              ) : (
                <div className="grid gap-2">
                  {waitingTodos.map((t) => {
                    const waited = now - t.updatedAt;
                    const overFail = waited >= FAIL_MS;
                    const overEscalation = waited >= ESCALATION_MS;
                    const executors = strList(t.executors);
                    return (
                      <div
                        key={t.id}
                        className="rounded p-2"
                        style={{ background: "var(--ink-1)" }}
                      >
                        <Flag tone={overFail ? "cinnabar" : "amber"}>
                          <div className="flex items-baseline justify-between gap-2 flex-wrap">
                            <span className="ss-body" style={{ color: "var(--bone)" }}>
                              {t.title}
                            </span>
                            <span
                              className="ss-meta"
                              style={{ color: toneColor(overFail ? "cinnabar" : "amber") }}
                            >
                              已等 {fmtDuration(waited)}
                              {overEscalation
                                ? overFail
                                  ? " · 已过 1 小时判失败阈值"
                                  : " · 已过 5 分钟升级阈值"
                                : ""}
                            </span>
                          </div>
                          <div className="ss-meta">
                            {executors.length > 0 ? <>{executors.join(", ")} · </> : null}
                            最后写入 {fmtTime(t.updatedAt)}
                          </div>
                          {t.body && <div className="ss-note">{excerpt(t.body, 160)}</div>}
                        </Flag>
                      </div>
                    );
                  })}
                  <Disclosure summary="等待时长怎么算的">{WAIT_ESTIMATE_NOTE}</Disclosure>
                </div>
              )}
            </Section>

            {/* 沉淀区 */}
            <Section
              title="沉淀"
              count={settledTop.length}
              hint="活下来的结论(不含失败与被取代)"
              className="sansheng-card p-4"
              aside={
                settledLinked > 0 ? (
                  <Pill tone="mute" title="已作为执行结果挂在执行树节点下的条数,不在此重复列">
                    另 {settledLinked} 条在执行树下
                  </Pill>
                ) : null
              }
            >
              {settledTop.length === 0 ? (
                <EmptyState>
                  {settled.length === 0
                    ? "本会话没有活下来的 decision / note / reflection。"
                    : "全部已挂在执行树节点下。"}
                </EmptyState>
              ) : (
                <div className="grid gap-2">
                  {settledTop.map((a) => (
                    <OutputRow key={a.id} artifact={a} />
                  ))}
                </div>
              )}
            </Section>
          </div>

          {/* §1 角色表 */}
          <Section title="Agent 角色表" hint="按工件作者聚合" className="sansheng-card p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left sansheng-text-mute">
                  <th className="ss-meta font-normal">角色</th>
                  <th className="ss-meta font-normal">提示词来源</th>
                  <th className="ss-meta font-normal">产出数</th>
                  <th className="ss-meta font-normal">最新</th>
                </tr>
              </thead>
              <tbody>
                {REAL_AGENTS.map((r) => {
                  const items = byRole.get(r);
                  const last = items ? items[items.length - 1] : undefined;
                  return (
                    <tr key={r} style={{ borderTop: "1px solid var(--ink-3)" }}>
                      <td className="py-1 font-mono" style={{ fontSize: 11 }}>
                        {r}
                      </td>
                      <td className="ss-meta">{AGENT_PROMPT_SOURCE[r]}</td>
                      <td className="ss-meta">{items ? items.length : "—"}</td>
                      <td
                        className="truncate ss-body"
                        style={{ maxWidth: 240, color: last ? "var(--bone-dim)" : undefined }}
                        title={last ? `${last.title} · ${fmtTime(last.createdAt)}` : ROLE_TABLE_NOTE}
                      >
                        {last ? last.title : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="ss-note mt-2" title={ROLE_TABLE_NOTE}>
              「—」= 本会话没有该角色的工件。表内用配置键(英文),critic / memory / reflection
              尚未实现故不列。
            </p>
            {otherAuthors.length > 0 && (
              <p className="ss-meta mt-1">本会话其它工件作者:{otherAuthors.map((k) => authorLabel(k)).join(" · ")}</p>
            )}
            {!artifacts.some((a) => a.author === "harness_manager") && (
              <p
                className="ss-meta mt-1"
                title="harness_manager 的提示词编译在代码里(没有 md 文件),且它只对 harness_proposal 工件有反应 —— 发射点还没补(设计文档 §6③)。"
              >
                harness_manager:本会话无产出。
              </p>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
