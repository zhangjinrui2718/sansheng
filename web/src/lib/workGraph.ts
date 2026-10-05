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
   * 「在依赖环上**或**环的下游」—— **仅用于标注**(界面上必须说明),
   * **不决定摆位**(摆位按拆解树;只有父子成环的节点才进尾列)。
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
   * **环上或环的下游**的工作项 id(Kahn 未出队的那些)。
   * **必须显示**出「这几个的先后算不出来」,而且归因只到这一步。
   * ⚠️ 它**不再决定摆位** —— 摆位由拆解树(`parentWorkId`)决定,见 `parentDepths`。
   */
  unlayeredIds: string[];
  /**
   * **互相咬住的一对边**(`u→v` 与 `v→u` 同时存在,任意 kind 组合)。
   *
   * 界面据此说出病灶 —— 真机现场是「`khu --parent--> kv0` 与
   * `kv0 --depends_on--> khu`」,只有列出这两条边才读得懂为什么这一块标了环,
   * 而且它直接指向该改哪一条。
   */
  mutualPairs: Array<{ a: string; b: string; ab: "parent" | "depends_on"; ba: "parent" | "depends_on" }>;
  /** 去重 / 去自环时被丢掉的边条数(诊断用:>0 说明库里本来就有脏边) */
  droppedEdges: number;
}

/**
 * 边:**方向 = 先后**(谁必须先发生)。两条来源:
 *
 *   - `depends_on`:`dep → work`(前置先,本条后);
 *   - `parent_work_id`:**`child → parent`** —— ⚠️ 这个方向是 2026-10-06 定下来的,
 *     它同时修掉了真机那份数据的「环」。
 *
 * ── 为什么父边是「子 → 父」而不是「父 → 子」────────────────────────
 *
 * 把父边画成「父先于子」时,真机数据立刻出现一个**假环**:`khu` 是 `kv0` 的父
 * (父先于子),同时 `khu` 又 `depends_on kv0`(子先于父)⇒ 方向矛盾 ⇒ Kahn 一个都
 * 排不出来 ⇒ **五个节点全挤进一列**,用户的原话是「现在的 dag 完全是乱的」。
 *
 * 而平台自己的语义是**子先于父**:容器根工作项由子项推动、`integrate` 在子项全部
 * 收口之后才跑(`runtime/dispatcher.ts` 的 `integrate` 规则就是这个判据)。于是
 * 那份数据的先后关系是:
 *
 *     基础打断 / 全双工 → 节律(等全双工) → 整合(等前三个) → 交付(等整合)
 *
 * —— **一个环都没有**,五个节点排在四列上,「交付在最后」也正是事实。
 *
 * ⚠️ 所以「有没有环」这件事**依赖方向的定义**:同一对节点上「拆解 + 前置」方向
 * **一致**时不是环(真机就是这样),方向**相反**时才是(`mutualPairs` 会指出来)。
 * 这个定义写在代码里,不由读者猜。
 *
 * 去重键是 `(kind, from, to)`:同一条 `dependsOn` 在库里写了两遍(真机实测有过)
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
    // ⚠️ 子 → 父(先后方向,见上)
    if (w.parentWorkId !== null) push(w.id, w.parentWorkId, "parent");
    for (const dep of w.dependsOn) push(dep, w.id, "depends_on");
  }
  return { edges: out, dropped };
}

/**
 * 分层 = **Kahn 拓扑排序 + 最长路径**(边的方向即先后)。
 *
 * 入度为 0 的先出队;出队时把后继的深度推到 `max(现深度, 本深度 + 1)`。这一趟同时
 * 拿到两件事:
 *
 *   - `depth`     —— 每个节点的列号(最长路径 ⇒ 任何一条边都**从左指向右**);
 *   - `unlayered` —— **没能出队**的节点 = 在环上 ∪ 环的下游(Kahn 的精确语义)。
 *
 * `unlayered` 是**保守**集合:真机那种「根 ⇄ 子项」的组合会把它下游的子项也算进来。
 * 所以界面上那句「先后算不出来」必须写全,并且用 `mutualPairs` 说出**具体是哪两条边**
 * (只报集合的话,读者知道有环但不知道该改哪条)。
 */
function precedenceDepths(
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
  return { depth, unlayered: new Set(nodeIds.filter((id) => !ordered.has(id))) };
}

/**
 * **互相咬住的一对边**(`u→v` 与 `v→u` 同时存在,任意 kind 组合)。
 *
 * 这才是**能读懂、能动手改**的病灶。真机上一版曾把「所有反向可达的边」都报出来,
 * 在这样的图上会一次报九条边(环在顶部,所有边都通往环)—— 那等于把「有环」说了
 * 九遍,一句病灶都没说。判据要落到人手上能改的那一条边。
 */
function mutualPairs(
  edges: ReadonlyArray<{ from: string; to: string; kind: DagEdgeLayout["kind"] }>,
): WorkDagLayout["mutualPairs"] {
  const kindOf = new Map<string, DagEdgeLayout["kind"]>();
  for (const e of edges) kindOf.set(`${e.from}|${e.to}`, e.kind);
  const out: WorkDagLayout["mutualPairs"] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const back = kindOf.get(`${e.to}|${e.from}`);
    if (back === undefined) continue;
    const key = [e.from, e.to].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: e.from, b: e.to, ab: e.kind, ba: back });
  }
  return out;
}

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
  const { depth, unlayered } = precedenceDepths(ids, edges);
  const pairs = mutualPairs(edges);

  // 排不出先后的节点统一放**最后一列**(在正常层之后),并在界面上说明。
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
    mutualPairs: pairs,
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
  const spans = x2 - x1;
  // ⚠️ **跨列(超过一格)的边要"让路"**(2026-10-06 看真机渲染图补的):两端同一
  // 行时贝塞尔退化成一条水平直线,而它正好从中间那些卡片的**垂直中心**穿过 ——
  // 卡片是不透明的,线在卡片后面时看不见、在缝隙里又露出来,读者会以为「这条线
  // 断成两截」。这里给跨列边一个向下的弧度,让它从卡片**下方**绕过去。
  const dip = spans > (DAG_NODE_W + DAG_COL_GAP) * 1.5 ? Math.min(26, DAG_NODE_H / 2 + 6) : 0;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1 + dip}, ${x2 - dx} ${y2 + dip}, ${x2} ${y2}`;
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
