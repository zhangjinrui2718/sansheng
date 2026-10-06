/**
 * 工件关系图(DAG)布局 —— 纯函数,无 DOM、无请求
 *
 * ── 它取代的是**工作项依赖图** ───────────────────────────────────
 *
 * 用户 2026-10-06 原话:「我之前说的 dag,其实是想要**工件的** dag,这个工件
 * 比如说是我的决策、质检的产出」。而那一版建的是**工作项** DAG(节点 = 环节,
 * 边 = 拆解 / 前置)—— 节点类型就错了:用户在项目里真正会指着说「这个」的东西
 * 是「我拍的那条决策」「质检说我不通过的那条发现」,不是「环节 3」。
 *
 * 真机库那一版最能说明错在哪(2026-10-06 14:10 实测):
 * 美股项目 39 件工件里,**8 条 `decision` + 3 条 `client_question` 没有
 * `work_id`** —— 它们不挂任何环节,在工作项 DAG 上**一个节点都没有**。
 * 也就是说:甲方视角里最重要的那一半(决策与问答)在这张图上完全不可见。
 *
 * ── 三类边:哪些是真有的,哪些还没有 ──────────────────────────────
 *
 *   | 关系 | 来源 | 真机条数 | 样式 |
 *   |---|---|---|---|
 *   | 任务依赖 | `links` 的 `depends_on` | 11(交付物 ← 它的依据) | 实线 |
 *   | 触发顺序 | `links` 的 `answers`(答复 ← 提问) | 2 | 虚线 |
 *   | 逻辑关系 | —— **没有写入侧** | **0** | 点线 + **图例如实写「0 条」** |
 *
 * ⚠️ **第三类为什么是 0,以及为什么不拿前两类凑**:它需要「谁因为谁的判断而
 * 做了什么决定」这种**语义事实**,而库里没有这一列。`review_verdicts`(021)
 * 记了「质检判不通过」,但**记不下「业务经理据此改了什么」**;`asks` 是
 * agent↔agent 的通道,甲方决策不经过它。
 * **用「同一时间窗内谁在谁之后」推一条边出来,就是编造关系** —— 本项目为
 * 「看似能跑、其实在编」付过太多代价。所以这里如实报 0,见 `REL_STATS`。
 * 要它变成非 0 需要一次写入侧改动(`artifact_links.rel` 闭集只能靠重建表放宽,
 * 配方见 `migrations/015`),那是独立一步。
 *
 * ── 为什么按时间分层就不会「缠在一起」 ────────────────────────────
 *
 * 用户对旧图的原话是「现在都缠在一起了」。缠的根因不是手写 SVG,是
 * **分层 DAG 的边交叉**:节点位置由依赖关系解出,于是边必然互相穿。
 *
 * 而这三类边**全都是因果边**(它们都指向「因」的反面:后发生的那件)。
 * ⇒ 把拓扑序**锚在时间上**(每条边只能从早指向晚),得到的分层就天然
 * 单调于时间,**不存在一条往回指的边** —— 而往回指的边正是交叉的主要来源。
 * 剩下的交叉只有同层内的,那由「同层按 kind 归堆」缓解,而不是靠解方程。
 *
 * ⚠️ 这条性质是**被检查的**,不是被假设的:反向边会被收集进 `backwardEdges`
 * 并在界面上点名(`见 ArtifactRelationGraph` 的图例),不是被静默画出来。
 *
 * ── 五条不许说假话的纪律 ─────────────────────────────────────────
 *
 *  1. **反向边不画。** 收进 `backwardEdges` 如实报出。画出来会让「从左到右读
 *     就是先后」这句话当场失效,而那是这张图唯一的承诺。
 *  2. **排不出先后就说排不出来。** 成环的节点进 `unlayeredIds`(Kahn 的未出队
 *     集合,**不是「环上的节点」** —— 上一版用松弛迭代近似,把环的**下游**也说成
 *     「成环」,那是一句假归因)。
 *  3. **重复边去重、悬空目标点名。** `links` 没有 UNIQUE 约束,真机上出现过
 *     `A → B` 两行;目标不在本次加载的工件集里也要**报出来**(`dangling`),
 *     不能丢一条边假装图是完整的。
 *  4. **一件工件都不许丢。** 没有任何边的孤点也要画(只是没有连线),否则
 *     「甲方拍的那条决策」会从图上消失 —— 那正是这一版要修的东西。
 *  5. **`parent` 是死值。** 闭集里有它,但全仓**零写入侧**、真机 0 行。
 *     照画不误(契约里有),但图例会写明它 0 条,而不是假装它是个正常关系。
 */
import type { ArtifactView, WorkView } from "@shared/types/platform";

// ── 画布尺寸(布局与渲染共用,免得两边各写一份而漂)─────────────────

/** 节点卡片宽度。「kind 色条 + 标题两行」要放得下 10 个中文字。 */
export const AG_NODE_W = 168;
export const AG_NODE_H = 52;
export const AG_COL_GAP = 84;
export const AG_ROW_GAP = 10;
export const AG_PAD = 8;

/**
 * 三类关系。**键与 `ArtifactLinkRel` 的取值一一对应**,不是另发明的一套 ——
 * 另发明一套就多一份「两份定义迟早漂」的机会。
 *
 * `drawnAs` 是**画出来**的样子(实线 / 虚线 / 点线),不是存储的样子。
 */
export type ArtifactRelation = "depends_on" | "answers" | "parent" | "review_about";

/**
 * ⚠️ **`review_about` 是四类里唯一一个**不落库**的**。
 *
 * 它派生自 migration 014 的 `artifacts.work_id` —— 而那一列**一条边两个语义**:
 * worker 写 `evidence` 是「产出」,质检把 `review_finding` 挂到同一条工作项上
 * 表达的是「**关于**它」(AGENTS.md 明确记着这条)。本函数把后者读出来:
 * `review_finding(W)` → `W` 上的非审查类产出。
 *
 * **它是一个「集合」关系,不是「具体某一条」**:一条工作项有 3 份 evidence 时,
 * 质检的结论对它们**都**成立,而库里**记不下**它具体针对哪一份 ——
 * 那种情况下画 3 条边,每一条都是真的,但**没有一条能说「它审的就是这份」**。
 * 所以图例里那句话必须写出来,否则读者会以为每条边都是精确定向的。
 *
 * 为什么不把它落成一条真边(那样就精确了):那要一次写入侧改动
 * (`review_verdict` 加一个 `reviewedArtifactId` + 提示词要求质检指明),
 * 是独立一步。而**在它落地之前,画这组「集合」边比画 0 条有用得多** ——
 * 真机上 8 条审查产出**一条边都没有**(2026-10-06 实测:36 件工件里 12 件孤点,
 * 其中 8 件就是审查产出),那正是用户点名要看的东西。
 */

export interface RelationSpec {
  readonly label: string;
  readonly why: string;
  /** SVG `stroke-dasharray`;`undefined` = 实线 */
  readonly dash: string | undefined;
  /**
   * 边的**因果方向**。库里 `depends_on` 记的是「A 依赖 B」(B 在前)、
   * `answers` 记的是「答复回应提问」(提问在前)—— 所以**画出来时两条都要反向**,
   * 让箭头一律从「因」指向「果」。这条是上面「按时间分层不交叉」的前提。
   */
  readonly reversed: boolean;
}

export const RELATIONS: Readonly<Record<ArtifactRelation, RelationSpec>> = {
  depends_on: {
    label: "任务依赖",
    why: "交付物依赖它所依据的产出。库里存的是「A 依赖 B」,画出来时反向(B → A)以便从左到右读先后。",
    dash: undefined,
    reversed: true,
  },
  answers: {
    label: "触发顺序",
    why: "答复回应提问。库里存的是「答复 answers 提问」,画出来时反向(提问 → 答复)以便读成「问 → 答」。",
    dash: "5 4",
    reversed: true,
  },
  review_about: {
    label: "质检所审",
    why:
      "**派生,库里没有这一条边。** 来源是 migration 014 的 `work_id` 的第二个语义" +
      "(「关于」:质检把 review_finding 挂到被审的那条工作项上)。" +
      "⚠️ 这是**集合**关系:一条工作项有几份产出,就画几条边 —— 每一条都成立," +
      "但**没有一条能说「它审的就是这一份」**,因为库里没记这一层。",
    dash: "1 3",
    reversed: false,
  },
  parent: {
    label: "父工件",
    why:
      "契约闭集里的第三个取值,但**全仓零写入侧、真机 0 行** —— 画出来会是永远空着的一类。" +
      "这里如实留着并报 0,不假装它是个正常关系(与 `REL_STATS` 里的说明同源)。",
    dash: "2 3",
    reversed: false,
  },
};

/**
 * 「逻辑关系」在图例里的**如实说明**。它不是 `ArtifactLinkRel` 的一个取值 ——
 * 它是**用户要的、而库里还没有的**那一类。写成常量的理由:界面上那句解释
 * 与本文件的注释必须同源,分两处写迟早漂。
 */
export const LOGICAL_RELATION_NOTE =
  "逻辑关系(「这条决策是因为那条质检发现」)—— **当前 0 条**。" +
  "库里没有这一列事实,而「按时间先后推一条出来」是编造关系,所以不画。" +
  "要它变成非 0 需要一次写入侧改动。";

// ── 布局输出 ──────────────────────────────────────────────────────

export interface ArtifactNodeLayout {
  artifact: ArtifactView;
  /** 列(0 起)。越大越靠右 = 越晚 */
  depth: number;
  /** 行(该层内 0 起) */
  row: number;
  x: number;
  y: number;
  /** 它产出的工作项标题(**可能为 null** —— 决策/问答本来就不挂环节) */
  workTitle: string | null;
  /** 入度 = 有几条边指向它。0 ⇒ 孤点(图上就是一个没有连线的卡片) */
  inDegree: number;
  outDegree: number;
  /** 在依赖环上**或环的下游**(仅用于标注,不决定摆位) */
  unlayered: boolean;
}

export interface ArtifactEdgeLayout {
  /** 源节点 id(**画出来**的那一端,已按 `reversed` 归一) */
  from: string;
  /** 目标节点 id */
  to: string;
  rel: ArtifactRelation;
  /** 去重后可能有多条同向边,这里只画一条 */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface ArtifactGraphLayout {
  nodes: ArtifactNodeLayout[];
  edges: ArtifactEdgeLayout[];
  /** 每类关系的**实画**条数(图例据实说 0 或几) */
  stats: Record<ArtifactRelation, number>;
  /**
   * 一次「质检所审」边是**集合**关系的产物:一个 finding 指向同一条工作项的多份产出。
   * 这个数 = 有几件审查产出**指向了不止一件**产出 —— 界面上必须说清,
   * 否则读者会把每条边都当成「它审的就是这一份」。
   */
  readonly multiTargetReviews: number;
  /**
   * 因果方向**反了**的边(源比目标晚)。**不画**,在这里如实报出。
   * 空集是正常状态;非空意味着库里存了一条「果 → 因」的边。
   */
  backwardEdges: Array<{ from: string; to: string; rel: ArtifactRelation }>;
  /** 目标不在本次工件集里的边(**不画**,并报出) */
  dangling: Array<{ from: string; to: string; rel: ArtifactRelation }>;
  /**
   * 成环上的、或环的下游(Kahn 未出队集合)。
   *
   * ⚠️ **经纪律①的时间过滤之后,环只可能出现在「同一毫秒」的节点之间** ——
   * 跨时刻的环必然有一条边是「果 → 因」,而那种边已经被剔掉了。所以这个集合在
   * 真机上通常很小甚至为空,**那不是判据没跑**。
   */
  unlayeredIds: readonly string[];
  width: number;
  height: number;
  /** 输入里的工件数(页面计数直接用它,与 `nodes.length` 必须相等) */
  artifactCount: number;
}

// ── 布局 ──────────────────────────────────────────────────────────

interface RawEdge {
  /** 归一后的因果方向:从因指向果 */
  from: string;
  to: string;
  rel: ArtifactRelation;
}

function isRelation(v: string): v is ArtifactRelation {
  return v === "depends_on" || v === "answers" || v === "parent";
}

/**
 * 收集**去重后**的因果边,并把三类异常分流出去。
 *
 * 分流而不是丢弃 —— 三类异常的成因完全不同(数据写反了 / 目标没加载到 /
 * 关系本身成环),混成一句「有 N 条边有问题」等于把诊断信息扔掉。
 */
function collectEdges(
  artifacts: readonly ArtifactView[],
): { edges: RawEdge[]; backward: RawEdge[]; dangling: RawEdge[] } {
  const known = new Set(artifacts.map((a) => a.id));
  const seen = new Set<string>();
  const edges: RawEdge[] = [];
  const dangling: RawEdge[] = [];
  // 分流前的全集:反向边在这里就被挑出来。
  const all: RawEdge[] = [];
  const stamp = new Map(artifacts.map((a) => [a.id, a.createdAt]));
  for (const a of artifacts) {
    for (const l of a.links) {
      // 未知 rel **原样跳过**而不是塞进某一类:契约是闭集,出现未知值说明
      // 前后端有一处漂了,那该由 `c10-dead-code` 之类的守卫报,不该由本函数猜。
      if (!isRelation(l.rel)) continue;
      if (!known.has(l.targetId)) {
        dangling.push({ from: a.id, to: l.targetId, rel: l.rel });
        continue;
      }
      if (l.targetId === a.id) continue; // 自环:库里有 CHECK 挡着,这里兜底
      const reversed = RELATIONS[l.rel].reversed;
      const from = reversed ? l.targetId : a.id;
      const to = reversed ? a.id : l.targetId;
      const key = `${from} ${to} ${l.rel}`;
      if (seen.has(key)) continue; // 真机上 `A → B` 出现过两行(migration 无 UNIQUE)
      seen.add(key);
      const e: RawEdge = { from, to, rel: l.rel };
      all.push(e);
      // **同一毫秒写下的两件不算反向** —— 方向不可判定,判成反向会误杀一批同刻边
      // (同一次工具调用里落两件工件就是这种情况)。
      const f = stamp.get(from);
      const t = stamp.get(to);
      if (f !== undefined && t !== undefined && f <= t) edges.push(e);
    }
  }
  return { edges, backward: all.filter((e) => !edges.includes(e)), dangling };
}

/** Kahn 拓扑分层:每列取「所有前驱都在更早列」的最长路径。 */
function layerize(
  ids: readonly string[],
  edges: readonly RawEdge[],
): { depth: Map<string, number>; unlayered: Set<string> } {
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) {
    out.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of edges) {
    // edges 的两端必然都在 ids 里(collectEdges 已滤掉 dangling)
    out.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const depth = new Map<string, number>();
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of queue) depth.set(id, 0);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head]!;
    head += 1;
    for (const nx of out.get(id) ?? []) {
      depth.set(nx, Math.max(depth.get(nx) ?? 0, (depth.get(id) ?? 0) + 1));
      const left = (indeg.get(nx) ?? 0) - 1;
      indeg.set(nx, left);
      if (left === 0) queue.push(nx);
    }
  }
  // 未出队 = 在环上**或环的下游**。⚠️ 刻意不区分这两者:Kahn 分不出来,
  // 而说成「成环」就是把下游也冤枉了(那是上一版的假归因)。
  const unlayered = new Set(ids.filter((id) => !depth.has(id)));
  for (const id of ids) if (!depth.has(id)) depth.set(id, 0);
  return { depth, unlayered };
}

export function layoutArtifactGraph(
  artifacts: readonly ArtifactView[],
  works: readonly WorkView[] = [],
): ArtifactGraphLayout {
  const workTitle = new Map(works.map((w) => [w.id, w.title]));
  // 反向边**在 `collectEdges` 里就分流掉了**,这里不再滤第二次 ——
  // 两处各滤一次的话「被滤掉的那些」就没人拿得到,`backwardEdges` 恒为空,
  // 图例上那行永远不会亮(2026-10-06 实测踩过:数组声明了却从没被 push)。
  const { edges, backward, dangling } = collectEdges(artifacts);

  // ── 派生边:质检所审(见 `review_about` 的注释)─────────────────
  //
  // ⚠️ **只连「审查当时就已经存在」的产出**(`target.createdAt <= f.createdAt`)。
  // 这一条既是语义也是几何:
  //   - 语义:质检审的是它动手之前就摆在那里的东西。整合稿(deliverable)是质检
  //     **之后**才由项目经理写的 —— 说「质检审了整合稿」是**编的**。
  //   - 几何:这样边才永远从早指向晚,「从左到右读先后」才成立。
  //     真机那份库正好能证伪反过来的写法:`evidence 08:42:36 → finding 08:53:55
  //     → deliverable 08:55:56`,发现挂在一份**比它晚两分钟**的整合稿上时,
  //     画出来就是一条反向边(2026-10-06 实测踩到)。
  // 同刻的算连上 —— 一次工具调用里落两件是常态。
  const byWork = new Map<string, ArtifactView[]>();
  for (const a of artifacts) {
    if (a.workId === null) continue;
    if (a.kind === "review_finding") continue;
    byWork.set(a.workId, [...(byWork.get(a.workId) ?? []), a]);
  }
  const seenDerived = new Set<string>();
  for (const f of artifacts) {
    if (f.kind !== "review_finding" || f.workId === null) continue;
    for (const target of byWork.get(f.workId) ?? []) {
      if (target.createdAt > f.createdAt) continue; // 审查当时还不存在 ⇒ 不是它审的
      const key = `${target.id} ${f.id} review_about`;
      if (seenDerived.has(key)) continue;
      seenDerived.add(key);
      // 箭头是 **产出 → 审查**,即「因 → 果」:先有这份产出,后有对它的结论。
      // ⚠️ 标签读作「质检所审」,但**箭头指向审查那一端** —— 与另外三类边同向,
      // 于是「从左到右读先后」这句话对四类边都成立。反过来画(finding → 产出)
      // 会让每一条「质检所审」都变成一条反向边(2026-10-06 实测:真机上 8 条全反)。
      edges.push({ from: target.id, to: f.id, rel: "review_about" });
    }
  }

  const ids = artifacts.map((a) => a.id);
  const { depth, unlayered } = layerize(ids, edges);

  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }

  // ── 摆位:同列内按 kind 归堆(同一种工件挨在一起,边更短、读起来更像泳道)──
  const kindRank = new Map<string, number>();
  for (const a of [...artifacts].sort((p, q) =>
    p.kind === q.kind ? p.createdAt - q.createdAt : p.kind < q.kind ? -1 : 1,
  )) {
    if (!kindRank.has(a.kind)) kindRank.set(a.kind, kindRank.size);
  }
  const ordered = [...artifacts].sort((p, q) => {
    const dp = depth.get(p.id) ?? 0;
    const dq = depth.get(q.id) ?? 0;
    if (dp !== dq) return dp - dq;
    const kp = kindRank.get(p.kind) ?? 0;
    const kq = kindRank.get(q.kind) ?? 0;
    if (kp !== kq) return kp - kq;
    return p.createdAt - q.createdAt || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
  });
  const rowInCol = new Map<number, number>();
  const nodes: ArtifactNodeLayout[] = ordered.map((a) => {
    const d = depth.get(a.id) ?? 0;
    const row = rowInCol.get(d) ?? 0;
    rowInCol.set(d, row + 1);
    return {
      artifact: a,
      depth: d,
      row,
      x: AG_PAD + d * (AG_NODE_W + AG_COL_GAP),
      y: AG_PAD + row * (AG_NODE_H + AG_ROW_GAP),
      workTitle: a.workId !== null ? workTitle.get(a.workId) ?? null : null,
      inDegree: inDeg.get(a.id) ?? 0,
      outDegree: outDeg.get(a.id) ?? 0,
      unlayered: unlayered.has(a.id),
    };
  });
  const byId = new Map(nodes.map((n) => [n.artifact.id, n]));

  const stats: Record<ArtifactRelation, number> =
    { depends_on: 0, answers: 0, parent: 0, review_about: 0 };
  const edgeLayouts: ArtifactEdgeLayout[] = [];
  for (const e of edges) {
    const s = byId.get(e.from);
    const t = byId.get(e.to);
    if (s === undefined || t === undefined) continue;
    stats[e.rel] += 1;
    edgeLayouts.push({
      from: e.from, to: e.to, rel: e.rel,
      fromX: s.x + AG_NODE_W, fromY: s.y + AG_NODE_H / 2,
      toX: t.x, toY: t.y + AG_NODE_H / 2,
    });
  }

  // 「有几件审查产出指向了不止一件产出」—— 集合关系的现场,界面上要写出来。
  // ⚠️ 键是 **`to`**(审查那一端):箭头是「产出 → 审查」,所以一份产出被几件审查
  // 指向与一件审查看了几份产出,是两个不同的数,而**界面要报的是后者**。
  const targetsPerFinding = new Map<string, number>();
  for (const e of edges) {
    if (e.rel !== "review_about") continue;
    targetsPerFinding.set(e.to, (targetsPerFinding.get(e.to) ?? 0) + 1);
  }
  const multiTargetReviewCount = [...targetsPerFinding.values()].filter((n) => n > 1).length;

  const maxCol = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  const maxRow = nodes.reduce((m, n) => Math.max(m, n.row), 0);
  return {
    nodes,
    edges: edgeLayouts,
    stats,
    multiTargetReviews: multiTargetReviewCount,
    backwardEdges: backward,
    dangling,
    unlayeredIds: [...unlayered].sort(),
    width: AG_PAD * 2 + (maxCol + 1) * AG_NODE_W + maxCol * AG_COL_GAP,
    height: AG_PAD * 2 + (maxRow + 1) * AG_NODE_H + maxRow * AG_ROW_GAP,
    artifactCount: artifacts.length,
  };
}

/** 这张图上一件都没有边 —— 界面上要**说清为什么**,不能只画一排孤零零的卡片。 */
export function isIsolated(layout: ArtifactGraphLayout): boolean {
  return layout.edges.length === 0;
}
