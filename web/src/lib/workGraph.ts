/**
 * 工件页的**产出图**(DAG)布局 —— 纯函数,无 DOM、无请求
 *
 * ── 这一层要回答的问题 ──────────────────────────────────────────
 *
 * 工件页原来的组织方式是**按 kind 平铺**:决策一堆、证据一堆、评审发现一堆。
 * 那读得出来「产出了什么」,读不出来「**流程走到哪了**」—— 而后者正是用户在
 * 这个页面上要看的东西(他的原话:工件是整个工作流程往前推进的关键节点)。
 *
 * 环节 = **工作项**(`works`),边有两条来源:
 *
 *   - `parentWorkId` —— 拆解(谁是谁的子项),实线;
 *   - `dependsOn`    —— 前置(谁在等谁),虚线。
 *
 * 工件通过 `ArtifactView.workId`(migration 014 的产出边)挂到环节上。
 *
 * ── 四条判据(每一条都对应一个「否则页面会撒谎」的形态)────────────
 *
 *  1. **分层是「最长路径」,不是「父节点的深度 + 1」。** 一个节点的深度必须大于
 *     *所有* 前驱,否则一条跨层的依赖边会**反向**画(从右往左),而画面上看起来
 *     只是「这条线有点怪」。所以用松弛法求最长路径,而不是按树递归。
 *  2. **边要去重、去自环。** 真机库里有 `A → B` 出现两次的行(migration 无
 *     UNIQUE 约束),自环虽然不该存在但一旦出现会让松弛法永远在动 ⇒ 渲染层会
 *     出现「永远算不完」的假象。去重与去自环都在这里做,并且**如实报出**。
 *  3. **排不出先后就说排不出来,而且归因要准。** 依赖环(`work_deps` 的写入侧
 *     `createsCycle` 会拦,但直接改库 / 老数据能绕过它)不该让页面转不出来,也不该
 *     被静默抹平:排不出先后的节点进**单独一层**(`unlayeredIds`),界面上写清
 *     「它们在依赖环上**或环的下游**」。
 *     ⚠️ **这个集合是 Kahn 排序的未出队节点,不是「环上的节点」。** 上一版用
 *     松弛迭代近似,把环**下游**的节点也说成「依赖成环」—— 那是一句假归因
 *     (subagent 在 `A↔B`、`C 是 B 的子项` 上复核出来的)。
 *  4. **不丢任何工件。** `workId === null`(决策 / 会议 / 变更 / 甲方问答)与
 *     `workId` 指向一条**本次没加载到**的工作项(理论上被 FK 挡住,但读面必须
 *     容错)分两类返回 ⇒ 页面各有一处如实列出它们,而不是丢进某个节点假装
 *     是自己产的。
 */
import type { ArtifactView, WorkView } from "@shared/types/platform";

// ── 画布尺寸(布局与渲染共用同一组常量,免得两边各写一份而漂)──────

/** 节点卡片宽度。190 是「一行放得下 12 个中文字 + 一个状态标」的宽度。 */
export const DAG_NODE_W = 190;
/** 节点卡片高度。 */
export const DAG_NODE_H = 62;
/** 相邻两层的水平间距(边的水平空间)。 */
export const DAG_COL_GAP = 64;
/** 同层相邻节点的垂直间距。 */
export const DAG_ROW_GAP = 12;
/** 画布内边距。 */
export const DAG_PAD = 8;

export interface DagNodeLayout {
  work: WorkView;
  /** 列(0 起)。越大越靠右 = 越靠后 */
  depth: number;
  /** 行(该层内 0 起) */
  row: number;
  x: number;
  y: number;
  /** 挂在这个环节上的工件数(含「关于」语义的评审发现,见契约 `ArtifactView.workId`) */
  artifactCount: number;
  /**
   * **排不出先后**的节点 ⇒ 分层对它不成立(单独一层,界面上必须说明)。
   * ⚠️ 它是「在依赖环上**或**环的下游」,不全是环的成员 —— 见 `layerize`。
   */
  unlayered: boolean;
}

export interface DagEdgeLayout {
  from: string;
  to: string;
  kind: "parent" | "depends_on";
  /** SVG `d`(三次贝塞尔,从 `from` 右边中点到 `to` 左边中点) */
  path: string;
}

export interface WorkDagLayout {
  nodes: DagNodeLayout[];
  edges: DagEdgeLayout[];
  /** 画布尺寸(px),渲染层直接用作 SVG / 容器的 width / height */
  width: number;
  height: number;
  /** 层数(0 = 没有节点) */
  layers: number;
  /**
   * **排不出先后**的工作项 id(Kahn 未出队的那些:环上的 ∪ 环的下游)。
   * **必须显示**出「这几个的先后算不出来」,而且归因只到这一步。
   */
  unlayeredIds: string[];
  /** 去重 / 去自环时被丢掉的边条数(诊断用:>0 说明库里本来就有脏边) */
  droppedEdges: number;
}

/**
 * 入边:一个节点「依赖谁 / 挂在哪」。两条边来源合并去重。
 *
 * 去重键是 `(from, to, kind)`:同一条 `dependsOn` 在库里写了两遍(真机实测有过)
 * 只画一条;而「既是父子又互相依赖」是两条**语义不同**的边,都要画。
 */
function collectEdges(
  works: readonly WorkView[],
): { edges: Array<{ from: string; to: string; kind: DagEdgeLayout["kind"] }>; dropped: number } {
  const ids = new Set(works.map((w) => w.id));
  const seen = new Set<string>();
  const out: Array<{ from: string; to: string; kind: DagEdgeLayout["kind"] }> = [];
  let dropped = 0;

  const push = (from: string, to: string, kind: DagEdgeLayout["kind"]): void => {
    // 边指向一条不在本次列表里的工作项 ⇒ 不成边(读面容错,不画幽灵线)
    if (!ids.has(from) || !ids.has(to)) {
      dropped += 1;
      return;
    }
    // 自环:既画不出来也让分层失效
    if (from === to) {
      dropped += 1;
      return;
    }
    const key = `${kind}:${from}->${to}`;
    if (seen.has(key)) {
      dropped += 1;
      return;
    }
    seen.add(key);
    out.push({ from, to, kind });
  };

  for (const w of works) {
    if (w.parentWorkId !== null) push(w.parentWorkId, w.id, "parent");
    for (const dep of w.dependsOn) push(dep, w.id, "depends_on");
  }
  return { edges: out, dropped };
}

/**
 * 分层 = **Kahn 拓扑排序 + 最长路径松弛**。
 *
 * ── 为什么是 Kahn(而不是「松弛法跑 N 轮,看谁还在动」)────────────────
 *
 * 上一版用松弛迭代 + 「最后一轮还在变的节点就是环上的」。它在真机上被
 * subagent 复核出一个**归因错误**:`A ↔ B` 成环、`C` 是 `B` 的子项时,`C` 也
 * 被标成「环上的」—— 其实 `C` 不在环上,它只是**环的下游**。
 *
 * Kahn 的答案**恰好**是「排不出先后」的那个精确集合:**环上的节点 + 从环出发
 * 能到达的节点**(它们的入度永远减不到 0)。于是措辞可以精确到:
 * 「这几个环节的先后算不出来(它们在依赖环上或环的下游)」—— 而上一版只能说
 * 「依赖成环」,那对下游节点是一句**假归因**。
 *
 * 顺带两件事:复杂度从 O(n²) 降到 O(n + m);而且**一个节点都不会丢**
 * (拓扑排序的实现常见错法是「环上节点静默不进结果」,这里未出队的节点被
 * 单独收进 `unlayered`,由调用方摆在尾层并如实标注)。
 */
function layerize(
  nodeIds: readonly string[],
  edges: ReadonlyArray<{ from: string; to: string }>,
): { depth: Map<string, number>; unlayered: Set<string> } {
  const indeg = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const succ = new Map<string, string[]>();
  for (const e of edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const list = succ.get(e.from);
    if (list === undefined) succ.set(e.from, [e.to]);
    else list.push(e.to);
  }

  const depth = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  // 入度为 0 的先入队;队列顺序按 `nodeIds` 的给定顺序(稳定)
  const queue = nodeIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  const ordered = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    ordered.add(id);
    for (const to of succ.get(id) ?? []) {
      const d = depth.get(id) ?? 0;
      if ((depth.get(to) ?? 0) < d + 1) depth.set(to, d + 1);
      const left = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, left);
      if (left === 0) queue.push(to);
    }
  }

  const unlayered = new Set(nodeIds.filter((id) => !ordered.has(id)));
  return { depth, unlayered };
}

/**
 * 把工作项 + 工件装成一张可渲染的图。
 *
 * **不请求任何东西**:`works` / `artifacts` 由调用方从 `useWorks` / `useArtifacts`
 * 拿到(那两条 hook 已经是「WS 事件 → revision → 回查」的既有读者)。
 */
export function layoutWorkDag(
  works: readonly WorkView[],
  artifacts: readonly ArtifactView[],
): WorkDagLayout {
  const artifactCount = new Map<string, number>();
  for (const a of artifacts) {
    if (a.workId === null) continue;
    artifactCount.set(a.workId, (artifactCount.get(a.workId) ?? 0) + 1);
  }

  const { edges, dropped } = collectEdges(works);
  const ids = works.map((w) => w.id);
  const { depth, unlayered } = layerize(ids, edges);

  // 环上的节点统一放到**最后一层**(在正常层之后),并在界面上标注。
  const layered = works.filter((w) => !unlayered.has(w.id));
  const unlayeredWorks = works.filter((w) => unlayered.has(w.id));
  const maxDepth = layered.reduce((m, w) => Math.max(m, depth.get(w.id) ?? 0), -1);

  const byLayer = new Map<number, WorkView[]>();
  for (const w of layered) {
    const d = depth.get(w.id) ?? 0;
    const layer = byLayer.get(d);
    if (layer === undefined) byLayer.set(d, [w]);
    else layer.push(w);
  }
  // 层内顺序:**稳定的** createdAt,再按 id —— 同一份数据两次渲染不许换位置
  // (否则每次回查节点都会跳一下,读者会以为流程变了)。
  const stable = (a: WorkView, b: WorkView): number =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const layer of byLayer.values()) layer.sort(stable);
  unlayeredWorks.sort(stable);

  const layerCount = maxDepth + 1 + (unlayeredWorks.length > 0 ? 1 : 0);
  const nodes: DagNodeLayout[] = [];

  for (const [d, layer] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    layer.forEach((w, row) => {
      nodes.push({
        work: w,
        depth: d,
        row,
        x: DAG_PAD + d * (DAG_NODE_W + DAG_COL_GAP),
        y: DAG_PAD + row * (DAG_NODE_H + DAG_ROW_GAP),
        artifactCount: artifactCount.get(w.id) ?? 0,
        unlayered: false,
      });
    });
  }
  const unlayeredLayer = maxDepth + 1;
  unlayeredWorks.forEach((w, row) => {
    nodes.push({
      work: w,
      depth: unlayeredLayer,
      row,
      x: DAG_PAD + unlayeredLayer * (DAG_NODE_W + DAG_COL_GAP),
      y: DAG_PAD + row * (DAG_NODE_H + DAG_ROW_GAP),
      artifactCount: artifactCount.get(w.id) ?? 0,
      unlayered: true,
    });
  });

  const at = new Map(nodes.map((n) => [n.work.id, n]));
  const edgeLayouts: DagEdgeLayout[] = [];
  for (const e of edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (a === undefined || b === undefined) continue;
    edgeLayouts.push({ from: e.from, to: e.to, kind: e.kind, path: edgePath(a, b) });
  }

  const width =
    layerCount === 0 ? 0 : DAG_PAD * 2 + layerCount * DAG_NODE_W + (layerCount - 1) * DAG_COL_GAP;
  const maxRows = [...byLayer.values()].reduce((m, l) => Math.max(m, l.length), unlayeredWorks.length);
  const height = maxRows === 0 ? 0 : DAG_PAD * 2 + maxRows * DAG_NODE_H + (maxRows - 1) * DAG_ROW_GAP;

  return {
    nodes,
    edges: edgeLayouts,
    width,
    height,
    layers: layerCount,
    unlayeredIds: unlayeredWorks.map((w) => w.id),
    droppedEdges: dropped,
  };
}

/**
 * 一条边在画布上的路径:从 `from` 的**右边缘中点**到 `to` 的**左边缘中点**。
 *
 * 三次贝塞尔(控制点水平外推)而不是直线:同一层里上下相邻的两个节点之间,
 * 直线会与节点卡片重叠,而贝塞尔从卡片右缘出发、进左缘 —— 视觉上「绕开」了。
 * 反向边(目标在左边,环或跨层依赖时可能出现)也照样连,**不隐藏** ——
 * 一条画不出来的边比一条方向怪的边更坏。
 */
function edgePath(from: DagNodeLayout, to: DagNodeLayout): string {
  const x1 = from.x + DAG_NODE_W;
  const y1 = from.y + DAG_NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + DAG_NODE_H / 2;
  // 水平外推量:取两端水平距离的一半(反向边时它也是正的,曲线会绕成一圈)
  const dx = Math.max(24, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/**
 * 工件按「挂点」分三堆。
 *
 *   - `byWork`   —— 挂在某个环节上的(键 = `workId`);
 *   - `noWork`   —— `workId === null`:决策 / 会议 / 变更 / 甲方问答。
 *     **它们不是「还没归位」,而是本来就不由某条工作项产出**;
 *   - `dangling` —— `workId` 指向一条**本次没读到**的工作项。
 *
 * 后两堆都必须被页面**列出来**,而且分开列:混在一起会让读者以为「漏了几条产出」,
 * 而真相是两种完全不同的状态(设计纪律:见不到的现场等于没有现场)。
 */
export function splitArtifactsByWork(
  artifacts: readonly ArtifactView[],
  works: readonly WorkView[],
): {
  byWork: Map<string, ArtifactView[]>;
  noWork: ArtifactView[];
  dangling: Map<string, ArtifactView[]>;
} {
  const known = new Set(works.map((w) => w.id));
  const byWork = new Map<string, ArtifactView[]>();
  const noWork: ArtifactView[] = [];
  const dangling = new Map<string, ArtifactView[]>();

  for (const a of artifacts) {
    if (a.workId === null) {
      noWork.push(a);
      continue;
    }
    if (!known.has(a.workId)) {
      const cur = dangling.get(a.workId);
      if (cur === undefined) dangling.set(a.workId, [a]);
      else cur.push(a);
      continue;
    }
    const cur = byWork.get(a.workId);
    if (cur === undefined) byWork.set(a.workId, [a]);
    else cur.push(a);
  }
  return { byWork, noWork, dangling };
}

/**
 * 一个环节的「正在跑」标记。
 *
 * 判据是**两条一起**:`live` 说这个角色的回合正在跑(宿主内存),而这条工作项
 * 正 `in_progress`(库里的真状态)。只要一条成立就点亮 —— 因为两种「在动」都
 * 存在:worker 正在跑某个工作项(两条都成立),以及项目经理正在拆解(只有前者)。
 *
 * ⚠️ `runtime === "unavailable"` 时**不许**返回「没在跑」的观感:调用方拿到
 * `running: false, unknown: true`,界面必须显示成「读不到」而不是「空闲」。
 */
export function workRunningState(
  work: WorkView,
  live: { runtime: "host" | "unavailable"; agents: ReadonlyArray<{ agentId: string; turn: unknown | null }> } | null,
): { running: boolean; unknown: boolean } {
  if (live === null) return { running: false, unknown: true };
  if (live.runtime === "unavailable") {
    // 运行期读不到 —— 只剩库里那条真状态可用(它不是「现在」,但也不是没有)
    return { running: work.status === "in_progress", unknown: true };
  }
  const agent = live.agents.find((a) => a.agentId === work.assigneeAgentId);
  const turnRunning = agent !== undefined && agent.turn !== null;
  return { running: turnRunning || work.status === "in_progress", unknown: false };
}
