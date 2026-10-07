/**
 * 工作项屏 —— **① 工件关系图 + ② 推进图(横轴 = 耗时,纵轴 = 泳道)+ ③④⑤**
 *
 * ── 这一版为什么把「工件」页与「工作项」页合并成一个 tab ──────────
 *
 * 用户的原话是:「我们已经构建了一个图表,这个图表上面有工作项、工件,所以是不是把
 * 工作项和工件合并成一个 tab,就叫做『工作项』,现在这个图表就放在工作项这个 tab
 * 下面,点击对应的绿色进度条,就可以展示在这个工作项上都有哪些工件」。
 *
 * 为什么照做:这张推进图**本来就同时画了这两样东西** —— 上区是工作项(一条工作项
 * 一道),下区是工件(一种 kind 一道),选中态还是**同一处** `resolveSelectedWorkId`。
 * 于是「工件」与「工作项」这两个 tab 之间没有信息边界,只有一条人为的缝:同一批
 * 工作项,一页画时间、一页列表格。合并之后入口只剩一个,三件事各有落点:
 *   ① **推进图**答「什么时候发生的」;
 *   ② **选中的环节**(`WorkNodePanel`)答用户要的那一句 ——
 *      **点一条工作项(绿色条)⇒ 下面显示它挂着的工件**(它是谁的、在等谁、留下了什么);
 *   ③ 下区两道答「工件长在哪条泳道上」(含不挂任何工作项的决策 / 会议 / 变更 / 甲方问答)。
 *
 * ⚠️ 旧「工作项」列表页整页丢弃(它是 `git mv` 的**目标**、不是来源),丢掉的
 * `状态 / 负责人 / 前置 / 目标 / 更新时间` **一样都没丢信息**:`WorkNodePanel` 逐项
 * 都写着,而且写得更准(状态带上 runtime 的「在跑 / 读不到」区分,前置列出依赖的
 * 工作项标题而不是一串 id,目标给正文而不是截断的 110 字)。
 *
 * 导出名一个都没改(`ArtifactsScreen` / `ArtifactsBody` / `ProgressTimeline` /
 * `TimelineLegend` / `WorkDag*` / `WorkNodePanel` / `ArtifactRow` / `ArtifactGroups` /
 * `UnattachedArtifacts` / `DanglingArtifacts` / `resolveSelectedWorkId` / `DagLive`):
 * 它们钉在 `tests/web/artifact-dag.test.ts` 与 `tests/web/artifact-timeline.test.ts` 上。
 * (页面名上一版改过:旧的 `ArtifactsPage` → `WorksPage`。)
 * ⚠️ **2026-10-07 起 `DependencyGraph` 是新增的导出**(旧的折叠块从 `ArtifactsBody`
 * 里整块提出来、去掉 `<Disclosure>`),两份测试相应改成渲染「`DependencyGraph` +
 * `ArtifactsBody`」的组合(保持图在前、面板在后的 DOM 顺序);断言一条都没删,
 * 只有切片助手跟着新顺序换了锚点。
 *
 * ── 这一版为什么把主视图从分层 DAG 换成时间轴泳道 ────────────────
 *
 * 用户对旧产出图的判词是「工件这个 dag 看看有没有开源组件可以用的,**现在都缠在一起
 * 了**」,并给了想要的形状:「我觉得好一点的展示是:横轴是时间,纵轴是工件的类型,
 * 即使没在 dag 上的工件也可以放在这个图表里面了」,还要「把工作项的完成和工件的产出
 * 也标在这个图表里面」。
 *
 * 「缠」的根因不是手写 SVG,而是**分层 DAG 的边交叉**:节点位置要按依赖关系求解,
 * 边必然互相穿。时间轴上没有这个问题 —— **x 是时间的函数**,位置不需要解
 * (`lib/timeline.ts` 文件头逐字写着这一条),结构上不可能缠。所以主视图换成
 * `layoutTimeline`(纯函数)算出的泳道图:横轴一次线性映射,纵轴一条工作项一道、
 * 一种工件 kind 一道。换掉的只是**主视图** —— 旧 DAG 的组件与导出一个都没动,
 * 它当时被收进默认折叠的 `<Disclosure>`(本版又按用户要求提到最上面并展开,
 * 见下「五块各答什么问题」),因为它回答的是「谁在等谁」,那是推进图答不了的。
 *
 * ── 五块各答什么问题(顺序即重要性)────────────────────────────
 *
 * ⚠️ **这一版的顺序是用户定的**(2026-10-07 原话:「工作项中,依赖关系图不要默认
 * 收起,放在最上面,这个页面的信息依次是:依赖关系图、推进图、选中的环节详情」)。
 * 照做的依据:依赖关系回答的是「**谁在等谁**」—— 读这一页的第一问就是「现在卡在
 * 哪一步、谁在等谁交东西」,不知道这个,时间轴上的先后只是「发生了些什么」;
 * 而它此前默认折叠,等于把第一问藏在一个标题行后面。折叠是**可见性**问题,
 * 不是「它没用」—— 所以只改位置与展开状态,组件与信息一个都没删。
 *
 *   ① **依赖关系图**(`DependencyGraph` = `Section` + `WorkDag`)**展开、最上面**
 *      —— 谁在等谁 / 谁是谁的子项(两类边都是「先后」:前置 → 本条、子项 → 父项)。
 *   ② **推进图**(`ProgressTimeline`)—— 整个项目在时间上推进到哪了:
 *      上区一条工作项一道(条 = 创建→收口,条上的刻度 = 它产出的工件),
 *      下区一种工件 kind 一道(点 = 一件工件,**含 `workId === null` 的**决策 /
 *      会议 / 变更 / 甲方问答 —— 这正是用户要的「没在 dag 上的也放进来」);
 *      另有「此刻」竖线与「在跑」的呼吸点。
 *   ③ **选中的环节**(`WorkNodePanel`)—— 这一步是谁的、在等谁、要什么、留下了什么。
 *      **点一条工作项(绿色条)⇒ 下面显示它挂着的工件**:推进图、依赖图与这块联动,
 *      共用一个选中态(`resolveSelectedWorkId`),这就是用户要的那条交互。
 *   ④ **不挂在任何环节上的工件** —— `workId === null` 的那批(它们本来就不由某条
 *      工作项产出,不是「还没归位」)。
 *   ⑤ **环节读不到的工件** —— `workId` 指向一条本次没加载到的工作项(读面容错)。
 *
 * ── 三条「不许说假话」的落点 ────────────────────────────────────
 *
 *  1. **计数一律来自真实数组长度**:② 的小字用 `works.length` / `artifacts.length`,
 *     ① 节点上的 `工件 N` 用布局给的 `artifactCount`,④⑤ 只有真的有条目才渲染,
 *     整页的「加载中…」只在 `loading && works.length === 0 && artifacts.length === 0`
 *     时出现(见 `lib/data.ts` 文件头:「还没查过」不等于「查过了,是空」)。
 *  2. **「读不到运行态」不是「空闲」**:`live === null` 或
 *     `live.runtime === "unavailable"` 时布局给 `running: false` / `unknown: true`
 *     —— ② 一条都不点亮、端点色转 `var(--bone-mute)`、图例那一行明说「运行态读不到」;
 *     ① 的节点边框不点亮(旧行为不变);库里那条 `in_progress` 仍由状态标如实显示
 *     —— 它是**过去的事实**,不是「此刻」。
 *  3. **终态 ≠ 精确完成时刻**:工作项条右端在终态时取 `updatedAt`,而
 *     `markWorkReviewed` 也会碰这一列(`repo/works.ts`)⇒ tooltip 只敢写
 *     「收口(最后一次变更,不是精确完成时刻)」;未终态画成**开口端**并写
 *     「未收口(还在推进,右端 = 此刻)」。排不出先后的环节也不许丢、不许静默
 *     (`workGraph` 的 `unlayeredIds` 在 ① 里照旧说明)。
 *
 * ── 可访问性(为什么 SVG 里不用 `<button>`)──────────────────────
 *
 * SVG 里没法放真 `<button>`,所以可点元素是 `<g role="button" tabIndex={0}>`:
 * `role="button"` 让读屏把它报成按钮,`tabIndex={0}` 让它进 Tab 序列,
 * `onKeyDown` 里 **Enter / Space 与鼠标走同一个回调**(Space 还 `preventDefault`,
 * 否则会滚动页面)。每件图形都带 `<title>`(SVG 原生 tooltip)—— 鼠标用户不必
 * 猜记号的含义,SSR 里也能把 tooltip 断言出来。命中区另说:圆点半径 4.5px 太小,
 * 透明的高/大命中层见下面对应位置的注释。
 *
 * ── 可测性(纯 props)─────────────────────────────────────────────
 *
 * 五块全是**纯 props** 的导出组件(`ArtifactsScreen` / `ProgressTimeline` /
 * `TimelineLegend` / `ArtifactsBody` / `WorkDag` / `WorkDagCanvas` /
 * `WorkNodePanel` / `ArtifactGroups` / `ArtifactRow` / `UnattachedArtifacts` /
 * `DanglingArtifacts`),与 `components/members/RoleHarness.tsx` 导出
 * `RoleHarnessDisclosure` / `HarnessRolePane` 同一处置:`renderToStaticMarkup` +
 * 夹具就能钉住判据,不起服务、不 stub fetch。
 * `WorksPage` 自己只做三件事:取数(`useWorks` / `useArtifacts` /
 * `useProjectLive`)、持有两个交互态(选中的环节、展开了详情的那条工件)、
 * 项目切换时重置它们。
 *
 * `now`(「此刻」)由页面在渲染时取本地时钟:2.5s 的 live 轮询本身会带来重渲染,
 * 不需要再加一个定时器。它是**入场参数**而不是判断依据 —— 同一份数据 + 同一个
 * `now` 两次渲染完全一致(测试据此断言)。
 *
 * 「详情」保持原行为:**按 id 单独拉一次** `GET /api/artifacts/:id`,不拿列表里
 * 那条凑 —— 契约给了 `/:id` 这条端点,它的存在意义就是「列表里的字段可能不是全量」。
 */
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ArtifactKind, ArtifactView, WorkView } from "@shared/types/platform";
import {
  Clamp,
  Disclosure,
  EmptyState,
  KV,
  PageHeader,
  Pill,
  Section,
  StatStrip,
  toneColor,
} from "@/components/ui/primitives";
import { useArtifactContent, useArtifacts, useProjectLive, useWorks } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import { errorMessage, getArtifact } from "@/lib/api";
import {
  AG_NODE_H,
  AG_NODE_W,
  LOGICAL_RELATION_NOTE,
  RELATIONS,
  isIsolated,
  layoutArtifactGraph,
  type ArtifactGraphLayout,
  type ArtifactRelation,
} from "@/lib/artifactGraph";
import {
  DAG_NODE_H,
  DAG_NODE_W,
  layoutWorkDag,
  splitArtifactsByWork,
  workRunningState,
  type WorkDagLayout,
} from "@/lib/workGraph";
import {
  TL_DOT_R,
  TL_GUTTER,
  TL_PAD_TOP,
  TL_PLOT_W,
  TL_WORK_LANE_H,
  formatClock,
  layoutTimeline,
  clipLabel,
} from "@/lib/timeline";
import {
  artifactKindLabel,
  artifactKindTone,
  artifactStatusLabel,
  artifactStatusTone,
  DELIVERY_VERDICT_LABEL,
  DELIVERY_VERDICT_TONE,
  deliverableTypeLabel,
  deliverableTypeTone,
  fmtTime,
  workStatusLabel,
  workStatusTone,
} from "@/lib/vocab";
import { HtmlReport } from "@/components/deliverable/HtmlReport";
import { CodeService } from "@/components/deliverable/CodeService";
import { ContentDriftNote } from "@/components/deliverable/ContentDriftNote";
import { DeliveryVerdictActions } from "@/components/deliverable/DeliveryVerdictActions";
import { bodyMode, htmlReportFileName, shortSha } from "@/lib/deliverable";

/** 展示顺序:结论类优先,过程类靠后。表里没有的 kind 落在末尾(不丢)。 */
const KIND_ORDER: ArtifactKind[] = [
  "decision",
  "project_brief",
  "work_brief",
  // 交付物是整合的产物,与 decision / *_brief 同属「结论类」,排在过程类之前。
  "deliverable",
  "evidence",
  "review_finding",
  "change_record",
  "meeting_note",
  "hypothesis",
  "client_question",
  "note",
];

/**
 * DAG 只读 live 的**两件事**:运行期来源 + 每个角色的回合闩。
 *
 * 类型**故意收窄**:页面拿到的是 `ProjectLiveView`(它结构化地满足这个形状),
 * 而窄类型让测试能喂一份两行夹具,不必造整张 live 视图 —— 同时也把「DAG 到底
 * 读了 live 的哪一部分」钉在类型上,防止以后顺手多读几个字段。
 */
export interface DagLive {
  readonly runtime: "host" | "unavailable";
  readonly agents: ReadonlyArray<{ readonly agentId: string; readonly turn: unknown | null }>;
}

// ── ② 推进图:横轴 = 耗时(T+0),纵轴 = 泳道 ─────────────────────

/**
 * 运行态「读不到」= 还没拿到快照(`live === null`)或宿主没接上运行期快照
 * (`runtime: "unavailable"`)。
 *
 * 这两位在界面上**必须**与「空闲」分开(`lib/timeline.ts` 纪律③、
 * `shared/types/platform.ts` 的 `ProjectLiveView.runtime` 注释逐字写着这件事)。
 */
function runtimeUnreadable(live: DagLive | null): boolean {
  return live === null || live.runtime === "unavailable";
}

/**
 * 推进图的图例(图下方一行小字)。
 *
 * 那一句「运行态读不到」是这一块的**诚实开关**:没有它,一个点都不亮会被读成
 * 「此刻谁都没在跑」,而真相是「读不到」。读不到时这里**不放任何点** —— 灰点也
 * 说明不了「此刻」,只会让人以为读到了什么(旧 DAG 那个灰点的语义不同:它落在
 * 一条**具体的工作项**上,说的是「库里的状态读得到、运行态读不到」)。
 */
export function TimelineLegend({ runtimeUnknown }: { runtimeUnknown: boolean }) {
  return (
    <div className="ss-note" style={{ marginTop: 6 }}>
      {"横轴 = 距项目起点的耗时(T+0 起)· 每条工作项一道(条 = 创建→收口,刻度 = 它产出的工件)· " +
        "每种工件一道(点 = 一件工件)· 开口端 = 未收口"}
      {runtimeUnknown && (
        <span style={{ color: "var(--amber)" }}>
          {" · 运行态读不到:此刻谁在跑读不到,所以一条都没点亮。"}
        </span>
      )}
    </div>
  );
}

/**
 * ② 推进图本体 —— 一张 SVG,横轴 = 耗时,纵轴 = 泳道。
 *
 * **不自己算布局**:坐标全由 `layoutTimeline`(纯函数)给,这里只消费 —— 于是
 * 「每条工作项恰好一道 / 每件工件恰好一点 / 终态封口、未终态开口」这些判据能在
 * `tests/web/timeline.test.ts` 里对着布局钉,而不必从标记里反推。
 *
 * 三处「为什么这么做」(其余判据写在文件头):
 *  · **可点元素**:SVG 里放不了真 `<button>`,用 `role="button" + tabIndex` +
 *    Enter/Space(见文件头「可访问性」)。
 *  · **命中区**:小圆点(半径 `TL_DOT_R` = 4.5px)与 10px 高的条都太细,各加一层
 *    **透明**的命中层(点:r = 7.5 的圆;条:整道高的矩形)。它们只是热区,
 *    视觉与信息量为零。
 *  · **呼吸点用绝对定位的 HTML `<span className="ss-live-dot">`,不用
 *    `<foreignObject>`**:那个构件的颜色、呼吸动画与 `[data-state="unknown"]`
 *    灰点全定义在 `globals.css`,塞进 foreignObject 等于把 HTML 再嵌进 SVG 的尺寸 /
 *    命名空间语义里;而放在同一个**定尺容器**里绝对定位,既复用了既有构件,
 *    又与 SVG 共用同一套布局坐标(`left = x2 - 3`)。
 *
 * 测试靠 `data-mark-id` / `data-span-id` / `data-open` / `data-milestone-*` /
 * `data-now-line` 断言,不靠 class 名猜。
 */
export function ProgressTimeline({
  works,
  artifacts,
  live,
  now,
  selectedId,
  onSelectWork,
  onOpenArtifact,
}: {
  works: readonly WorkView[];
  artifacts: readonly ArtifactView[];
  live: DagLive | null;
  /** 页面这一刻的本地时钟(「此刻」线的位置与未收口的右端都用它) */
  now: number;
  /** 当前选中的环节 id —— 与 ③ 是**同一个**(由 `resolveSelectedWorkId` 解析三态后传入) */
  selectedId: string | null;
  /** 点条:选中它;再点一次同一个 ⇒ `null`(与旧 DAG 节点同一手势) */
  onSelectWork: (workId: string | null) => void;
  /** 点工件点:展开那件工件的详情 */
  onOpenArtifact: (artifactId: string) => void;
}) {
  const layout = useMemo(
    () => layoutTimeline({ works, artifacts, now, live }),
    [works, artifacts, live, now],
  );
  /** 刻度上只给 id 与 kind,标题要从列表里查 —— 查不到就只显示 id,不编标题。 */
  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of artifacts) m.set(a.id, a.title);
    return m;
  }, [artifacts]);

  const unknown = runtimeUnreadable(live);
  const width = TL_GUTTER + TL_PLOT_W;
  const plotTop = TL_PAD_TOP;
  const plotBottom = TL_PAD_TOP + layout.plot.height;
  const laneByKey = new Map(layout.lanes.map((l) => [l.key, l]));
  const workLanes = layout.lanes.filter((l) => l.group === "work");
  const kindLanes = layout.lanes.filter((l) => l.group === "kind");
  const lastWorkLane = workLanes[workLanes.length - 1];
  const firstKindLane = kindLanes[0];
  // 两区分隔线画在**缝的中间**(缝 = `TL_GROUP_GAP`):贴住某一道会被读成那道的一部分
  const groupSeparatorY =
    lastWorkLane !== undefined && firstKindLane !== undefined
      ? (lastWorkLane.y + lastWorkLane.height + firstKindLane.y) / 2
      : null;

  /** Enter / Space 与鼠标点击走同一个回调 —— 键盘用户看到的和点到的完全一样。 */
  const activate =
    (fn: () => void) =>
    (e: ReactKeyboardEvent<SVGGElement>): void => {
      if (e.key === "Enter" || e.key === " ") {
        // Space 默认会滚动页面 —— 不挡掉的话键盘用户点一次就跳走了
        e.preventDefault();
        fn();
      }
    };

  if (layout.lanes.length === 0) {
    // 没有环节也没有工件 ⇒ 不画一张空的坐标系(空轴会被读成「有一条时间线,只是没数据」)
    return (
      <div>
        <EmptyState>
          这个项目还没有环节,也没有工件 —— 推进图要等第一条工作项或第一件工件落下来才有东西可画。
        </EmptyState>
        <TimelineLegend runtimeUnknown={unknown} />
      </div>
    );
  }

  return (
    <div>
      {/* 横向滚动容器:图的宽度是 `TL_GUTTER + TL_PLOT_W` 的定值(SSR 与「同一份
          数据两次渲染一致」都要它确定),窄屏靠滚动看全。 */}
      <div className="sansheng-card" style={{ overflowX: "auto" }}>
        {/* 内层定尺容器:呼吸点是绝对定位的 HTML 构件,要有定尺父层才能与 SVG 同坐标 */}
        <div style={{ position: "relative", width, height: layout.height }}>
          <svg
            width={width}
            height={layout.height}
            viewBox={`0 0 ${width} ${layout.height}`}
            // ⚠️ **不用 `role="img"`**:那会把整棵子树从可访问性树里摘掉,里面的
            // `role="button"` 就再也报不出来了。用 group + aria-label。
            role="group"
            aria-label="推进图:横轴是距项目起点的耗时;上区每条工作项一道,下区每种工件一道"
          >
            {/* ── 左侧泳道名栏(x < TL_GUTTER)──
                右对齐;工作项那道在**固定左边距**加一个 3×10 的竖条当「环节」标记
                (与工作项条同形,工件道没有)。标记不紧贴文字:SSR 里量不到文字宽度,
                固定位置才与「同一份数据两次渲染一致」相容。 */}
            {layout.lanes.map((lane) => {
              const cy = lane.y + lane.height / 2;
              // `kind:evidence` → `evidence`;未知 kind 由 `artifactKindLabel` 原样透出英文
              const kindKey = lane.group === "kind" ? lane.key.slice("kind:".length) : null;
              const label = kindKey === null ? lane.label : artifactKindLabel(kindKey);
              return (
                <g key={`lane:${lane.key}`}>
                  <title>
                    {kindKey === null
                      ? `工作项(环节):${label}`
                      : `工件类型:${label}(${kindKey})`}
                  </title>
                  {kindKey === null && (
                    <g>
                      <title>环节</title>
                      <rect x={6} y={cy - 5} width={3} height={10} rx={1} fill={toneColor("jade")} />
                    </g>
                  )}
                  <text
                    x={TL_GUTTER - 8}
                    y={cy}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize={11}
                    fill="var(--bone-dim)"
                  >
                    {/* ⚠️ **必须截到栏宽以内**(2026-10-06 看真机渲染图才补的):
                        右对齐的长标题会往左溢出到 x < 0,被 SVG 视口裁掉 —— 屏幕上
                        剩半截「础打断模块方案设计」,读起来像错字。估算宽度见
                        `clipLabel`;全文仍然在 `<title>` 里(悬停看得到)。 */}
                    {clipLabel(label, TL_GUTTER - 16)}
                  </text>
                </g>
              );
            })}

            {/* 工作项区 / 工件类型区的分隔线(只在两区都非空时画) */}
            {groupSeparatorY !== null && (
              <g>
                <title>工作项区 与 工件类型区 的分界</title>
                <line
                  x1={0}
                  y1={groupSeparatorY}
                  x2={width}
                  y2={groupSeparatorY}
                  stroke="var(--ink-3)"
                  strokeWidth={1}
                />
              </g>
            )}

            {/* 网格与刻度:每个 tick 一条竖线 + 底部一个标签 */}
            {layout.ticks.map((t) => (
              <g key={`tick:${t.at}`}>
                <title>{`刻度 ${t.label}(${formatClock(t.at, true)})`}</title>
                <line
                  x1={t.x}
                  y1={plotTop}
                  x2={t.x}
                  y2={plotBottom}
                  stroke="var(--ink-3)"
                  strokeWidth={1}
                />
                <text
                  x={t.x}
                  y={plotBottom + 15}
                  // 贴到绘图区左右边缘的刻度改用 start / end:居中会让最右那个
                  // 标签有一半落在 SVG 视口之外,被裁成「17:」。
                  textAnchor={
                    t.x <= TL_GUTTER + 24
                      ? "start"
                      : t.x >= TL_GUTTER + TL_PLOT_W - 24
                        ? "end"
                        : "middle"
                  }
                  fontSize={10}
                  fill="var(--bone-mute)"
                >
                  {t.label}
                </text>
              </g>
            ))}

            {/* 绘图区外框 */}
            <rect
              x={TL_GUTTER}
              y={plotTop}
              width={TL_PLOT_W}
              height={layout.plot.height}
              fill="none"
              stroke="var(--ink-3)"
              strokeWidth={1}
            >
              <title>绘图区:横轴 = 距项目起点的耗时(T+0 起)</title>
            </rect>

            {/* ── 工作项 = 跨度条(条上的刻度 = 它产出的工件)── */}
            {layout.spans.map((span) => {
              const lane = laneByKey.get(span.laneKey);
              const cy = span.y + span.height / 2;
              const selected = span.id === selectedId;
              const barWidth = Math.max(2, span.x2 - span.x1);
              // 端点色:读不到运行态时转 `var(--bone-mute)` —— 那一位是「此刻跑没跑」
              // 的读面,不是「库里那条状态」的读面(条**本身**仍按状态给色)。
              const endColor = span.unknown ? "var(--bone-mute)" : toneColor(workStatusTone(span.status));
              const tip =
                `${span.title}\n` +
                `状态:${workStatusLabel(span.status)}(${span.status})\n` +
                `负责人:${span.assigneeName}\n` +
                `创建:${formatClock(span.createdAt, true)} → ${span.open ? "此刻" : "收口"}:` +
                `${formatClock(span.endedAt, true)}\n` +
                (span.open
                  ? "未收口(还在推进,右端 = 此刻)\n"
                  : "收口(最后一次变更,不是精确完成时刻)\n") +
                `本环节产出 ${span.milestones.length} 件` +
                (span.running ? "\n此刻有回合在跑" : "") +
                (span.unknown ? "\n运行态读不到:这一刻有没有回合在它身上跑,读不到" : "");
              const toggle = (): void => onSelectWork(selected ? null : span.id);
              return (
                <g
                  key={span.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  aria-label={
                    `${span.title}(${workStatusLabel(span.status)}` +
                    `${span.running ? ",此刻有回合在跑" : ""})—— 按回车选中这个环节`
                  }
                  style={{ cursor: "pointer" }}
                  onClick={toggle}
                  onKeyDown={activate(toggle)}
                >
                  <title>{tip}</title>
                  {/* 命中层:条只有 `TL_BAR_H` = 10px 高,直接点很容易点空 —— 一层透明的
                      整道矩形把热区撑到 `TL_WORK_LANE_H`(28px) */}
                  <rect
                    x={span.x1}
                    y={lane?.y ?? span.y}
                    width={barWidth}
                    height={lane?.height ?? TL_WORK_LANE_H}
                    fill="transparent"
                  />
                  <rect
                    data-span-id={span.id}
                    data-open={span.open ? "true" : "false"}
                    data-selected={selected ? "true" : "false"}
                    x={span.x1}
                    y={span.y}
                    width={barWidth}
                    height={span.height}
                    rx={2}
                    fill={toneColor(workStatusTone(span.status))}
                    stroke={selected ? "var(--bone)" : undefined}
                    strokeWidth={selected ? 1.5 : undefined}
                  />
                  {/* 产出刻度:短竖线,颜色按工件 kind。刻度数 = 这条环节的工件数 */}
                  {span.milestones.map((ms) => (
                    <g key={ms.id} data-milestone-id={ms.id} data-milestone-span={span.id}>
                      <title>
                        {`本环节产出的工件:${titleById.get(ms.id) ?? ms.id}` +
                          `(${artifactKindLabel(ms.kind)})`}
                      </title>
                      <line
                        x1={ms.x}
                        y1={span.y - 4}
                        x2={ms.x}
                        y2={span.y + span.height + 4}
                        stroke={toneColor(artifactKindTone(ms.kind))}
                        strokeWidth={2}
                      />
                    </g>
                  ))}
                  {/* 端点:终态 = 实心(收口);未终态 = 竖线 + 空心圆(开口,右端 = 此刻) */}
                  {span.open ? (
                    <g>
                      <title>
                        {`未收口(还在推进,右端 = 此刻)${span.unknown ? " · 运行态读不到" : ""}`}
                      </title>
                      <line
                        x1={span.x2}
                        y1={span.y - 4}
                        x2={span.x2}
                        y2={span.y + span.height + 4}
                        stroke={endColor}
                        strokeWidth={1.5}
                      />
                      <circle cx={span.x2} cy={cy} r={3} fill="var(--ink-1)" stroke={endColor} strokeWidth={1.5} />
                    </g>
                  ) : (
                    <g>
                      <title>
                        {`收口(最后一次变更,不是精确完成时刻)${span.unknown ? " · 运行态读不到" : ""}`}
                      </title>
                      <circle cx={span.x2} cy={cy} r={3} fill={endColor} />
                    </g>
                  )}
                </g>
              );
            })}

            {/* ── 工件 = 点(每件恰好一个,含 `workId === null` 的)── */}
            {layout.marks.map((mark) => {
              const resolved = mark.status !== "open";
              const workLabel =
                mark.workId === null
                  ? "不挂在任何环节上"
                  : mark.workTitle ?? `环节读不到(${mark.workId})`;
              const tip =
                `${artifactKindLabel(mark.kind)}(${mark.kind})\n` +
                `状态:${artifactStatusLabel(mark.status)}(${mark.status})\n` +
                `标题:${mark.title || "(无标题)"}\n` +
                `作者:${mark.authorName}\n` +
                `时刻:${formatClock(mark.createdAt, true)}\n` +
                `产出环节:${workLabel}`;
              const openDetail = (): void => {
                onOpenArtifact(mark.id);
                // 挂在哪条环节上就选它(③ 跟着切);`workId === null` 的工件**不动**
                // 选中态 —— 它本来就不属于任何环节,顺手把别人的选中清掉才是撒谎。
                if (mark.workId !== null) onSelectWork(mark.workId);
              };
              return (
                <g
                  key={mark.id}
                  role="button"
                  tabIndex={0}
                  aria-label={
                    `工件 ${mark.title || mark.id}(${artifactStatusLabel(mark.status)})` +
                    `—— 按回车看详情`
                  }
                  style={{ cursor: "pointer" }}
                  onClick={openDetail}
                  onKeyDown={activate(openDetail)}
                >
                  <title>{tip}</title>
                  {/* 命中层:半径 `TL_DOT_R` 的圆太小,一层 r = 7.5 的透明圆把它撑到
                      15px。仍低于 44px 的无障碍建议值,所以键盘可达性是真兜底
                      (`tabIndex` + Enter/Space) */}
                  <circle cx={mark.x} cy={mark.y} r={TL_DOT_R + 3} fill="transparent" />
                  <circle
                    data-mark-id={mark.id}
                    cx={mark.x}
                    cy={mark.y}
                    r={TL_DOT_R}
                    fill={toneColor(artifactKindTone(mark.kind))}
                    // 状态不是 `open` ⇒ 加一圈浅描边:填充色仍表达 kind,环表达
                    // 「这条已经定过性(已采纳 / 已否决 / 被取代)」。用**形状**(环)
                    // 而不只是颜色 —— 色觉障碍与灰度截图里也分得出来。
                    stroke={resolved ? "var(--bone)" : undefined}
                    strokeWidth={resolved ? 1.5 : undefined}
                  />
                </g>
              );
            })}

            {/* 「此刻」竖虚线(只有读得到运行态且它落在域内时 `nowX` 才非 null) */}
            {layout.nowX !== null && (
              <g data-now-line>
                <title>此刻(本地时钟)</title>
                <line
                  x1={layout.nowX}
                  y1={plotTop}
                  x2={layout.nowX}
                  y2={plotBottom}
                  stroke="var(--jade)"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
                <text
                  x={layout.nowX}
                  y={plotTop + 9}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--jade)"
                >
                  此刻
                </text>
              </g>
            )}
          </svg>

          {/* 在跑的那几条:条尾一个 `.ss-live-dot`(布局保证读不到运行态时全为 false,
              所以这一块在那种情况下一个都不渲染) */}
          {layout.spans
            .filter((s) => s.running)
            .map((s) => (
              <span
                key={`running:${s.id}`}
                className="ss-live-dot"
                title={`${s.title}:此刻有回合在跑`}
                style={{ position: "absolute", left: s.x2 - 3, top: s.y + s.height / 2 - 3 }}
              />
            ))}
        </div>
      </div>
      <TimelineLegend runtimeUnknown={unknown} />
    </div>
  );
}

// ── ① 依赖关系图(旧的产出图,现在在最上面且展开)──────────────────

/**
 * ① 的**理由**(用户说它「缠在一起」,为什么现在反而放在最上面):
 *
 * 用户的原话是「现在都缠在一起了」—— 那是对**主视图**的判断,不是对这张图里
 * 信息的判断。主视图因此换成了推进图(②:x 是时间的函数,位置不需要解,结构上
 * 不可能缠)。但 DAG 回答的是**另一个问题**:「谁在等谁 / 谁是谁的子项」——
 * 推进图答不了它(时间上的先后 ≠ 依赖上的先后:`dependsOn` 可以有环,时间轴对
 * 环没有意见,而这正是 DAG 必须如实报出来的那件事)。
 *
 * ⚠️ **2026-10-07 改动**(用户原话:「工作项中,依赖关系图不要默认收起,放在最上面,
 * 这个页面的信息依次是:依赖关系图、推进图、选中的环节详情」):
 *  · 原来它包在 `<Disclosure>` 里、排在 ②③④ 之后(当时编号 ⑤);
 *  · 现在整块提出来做成导出的 `DependencyGraph`,**去掉 `<Disclosure>` 直接渲染**、
 *    由 `ArtifactsScreen` 排在最前。
 *  · 「缠」的问题不由折叠来解 —— 那只是把第一问藏起来。真正处理它的是这里:
 *    `WorkDagCanvas` 的横向滚动 + 纵向 `maxHeight` 上限(见那里的注释)。
 *  · **一个组件、一条信息都没删**,只是换了位置与展开状态。
 */

/**
 * 画布本体(边一层 SVG + 节点一层绝对定位的 button)。
 *
 * **不自己算布局**:`layout` 由 `layoutWorkDag` 给,渲染层只消费 —— 布局是纯函数,
 * 这样它的判据(最长路径分层 / 去重去自环 / 环单列)与这里的摆放判据能在测试里
 * 分开钉。
 */
export function WorkDagCanvas({
  layout,
  live,
  selectedId,
  onSelect,
}: {
  layout: WorkDagLayout;
  live: DagLive | null;
  /** 当前选中的工作项 id(null = 没选) */
  selectedId: string | null;
  /** 点节点:选它;再点一次同一个 ⇒ null(回到「点一个环节看它的产出」) */
  onSelect: (workId: string | null) => void;
}) {
  return (
    // `maxHeight`:横向溢出必须能滚(用户要求),但纵向也要有个上限 —— 一条层里排上
    // 二十个环节时,画布会长到把 ②③④ 全部推出一屏。滚动条本身就是「还有内容」的
    // 可见信号,不会让人以为图就这么多。
    <div className="ss-dag" style={{ maxHeight: 560 }}>
      {/* 内层定尺容器:`.ss-dag` 自己是滚动容器,绝对定位的节点要有它才能定出
          横向滚动范围(`.ss-dag-edges` 也是相对它定位的)。 */}
      <div style={{ position: "relative", width: layout.width, height: layout.height }}>
        <svg className="ss-dag-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map((e) => (
            <path
              key={`${e.kind}:${e.from}->${e.to}`}
              d={e.path}
              fill="none"
              stroke="var(--bone-mute)"
              strokeWidth={1}
              // 实线 = 拆解,虚线 = 前置依赖。两种关系用**线型**分开;颜色只走既有
              // token,不新造颜色。
              // ⚠️ 两条边的方向都是**先后**(前置 → 本条;子项 → 父项)—— 见
              // `workGraph.ts` 的 `collectEdges`:容器由子项推动,所以「交付」在最右。
              {...(e.kind === "depends_on" ? { strokeDasharray: "4 3" } : {})}
            />
          ))}
        </svg>

        {layout.nodes.map((n) => {
          const run = workRunningState(n.work, live);
          // 「在跑」只有在**真的知道**时才敢点亮:读不到运行态时,库里的
          // in_progress 仍由第一行的 Pill 如实显示,但它不该冒充「此刻」。
          const lit = run.running && !run.unknown;
          // 没有工件的环节不是「产出工件的环节」—— 让它明显安静(降不透明度),
          // 而不是给它编一个别的状态。
          const quiet = n.artifactCount === 0;
          const selected = n.work.id === selectedId;
          return (
            <button
              key={n.work.id}
              type="button"
              className="ss-dag-node"
              data-running={lit ? "true" : "false"}
              data-selected={selected ? "true" : "false"}
              style={{
                left: n.x,
                top: n.y,
                width: DAG_NODE_W,
                height: DAG_NODE_H,
                opacity: quiet ? 0.55 : 1,
              }}
              title={
                `${n.work.title}\n` +
                `负责人:${n.work.assigneeName}\n` +
                `状态:${workStatusLabel(n.work.status)}(${n.work.status})\n` +
                `挂着的工件:${n.artifactCount}` +
                (n.unlayered ? "\n⚠️ 先后算不出来 —— 这条环节在依赖环上或环的下游" : "")
              }
              onClick={() => onSelect(selected ? null : n.work.id)}
            >
              <span className="flex items-center gap-1.5" style={{ minHeight: 16 }}>
                <Pill tone={workStatusTone(n.work.status)} title={n.work.status}>
                  {workStatusLabel(n.work.status)}
                </Pill>
                {/* 呼吸点只在「确定此刻在跑」时出现;unknown 时给一个**灰的、不动的**
                    点(样式在 globals.css 的 `[data-state="unknown"]`),并且图例处
                    有文字说明 —— 颜色单独承担不了这个区别。 */}
                {run.running && (
                  <span
                    className="ss-live-dot"
                    data-state={run.unknown ? "unknown" : undefined}
                    title={
                      run.unknown
                        ? "运行态读不到:这条工作项在库里还标着「进行中」,但这一刻没有可信的回合快照"
                        : "此刻有回合在跑"
                    }
                  />
                )}
                {n.unlayered && (
                  <span className="ss-meta" style={{ marginLeft: "auto", color: "var(--amber)" }}>
                    环
                  </span>
                )}
              </span>
              <span
                className="ss-body truncate"
                style={{ fontSize: 11, lineHeight: "14px", color: "var(--bone)" }}
              >
                {n.work.title || "(无标题)"}
              </span>
              <span className="ss-meta flex items-center gap-1" style={{ marginTop: "auto" }}>
                <span className="truncate" style={{ maxWidth: 74 }}>
                  {n.work.assigneeName}
                </span>
                <span aria-hidden="true">·</span>
                <span
                  title="挂在这个环节上的工件数(= artifactCount)。契约里 work_id 一条边两个语义(产出 ∪ 关于),所以质检挂在被审那条上的 review_finding 也算在这里。"
                  style={{ whiteSpace: "nowrap" }}
                >
                  工件{" "}
                  <span style={{ color: quiet ? "var(--bone-mute)" : "var(--bone-dim)" }}>
                    {n.artifactCount}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 两种边在**人读的话**里的说法。放在这里而不是散在几处:环的提示里要说清
 * 「哪一对、各是什么边」—— 用户据此才知道该删哪一条(`khu` 拆解出 `kv0` 与
 * `kv0` 是 `khu` 的前置,是两种完全不同的关系)。
 */
const EDGE_KIND_LABEL: Record<WorkDagLayout["edges"][number]["kind"], string> = {
  parent: "拆解",
  depends_on: "前置于",
};

/** 图例:三种记号各是什么意思。样式与画布上的边**同一套 token**。 */
export function WorkDagLegend() {
  return (
    <div className="flex items-center gap-3 flex-wrap ss-meta" style={{ marginTop: 6 }}>
      <span className="flex items-center gap-1.5">
        <svg width="18" height="6" aria-hidden="true">
          <path d="M0 3 H18" stroke="var(--bone-mute)" strokeWidth={1} fill="none" />
        </svg>
        {"实线 = 拆解(子项 → 父项)"}
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="18" height="6" aria-hidden="true">
          <path
            d="M0 3 H18"
            stroke="var(--bone-mute)"
            strokeWidth={1}
            strokeDasharray="4 3"
            fill="none"
          />
        </svg>
        {"虚线 = 前置依赖(前置 → 本条)"}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="ss-live-dot" />
        点 = 此刻在跑
      </span>
    </div>
  );
}

/**
 * 产出流程整块:画布 + 图例 + 两行必须说出口的话。
 *
 * `runtimeUnknown` 的两行小字是这一块的**诚实开关**:运行态读不到时,页面不能
 * 因为「没有点亮的节点」而看起来像「此刻一切空闲」。
 */
export function WorkDag({
  layout,
  live,
  selectedId,
  onSelect,
}: {
  layout: WorkDagLayout;
  live: DagLive | null;
  selectedId: string | null;
  onSelect: (workId: string | null) => void;
}) {
  const unlayered = layout.nodes.filter((n) => n.unlayered);
  // live === null = 「还没拿到过」,与 unavailable 一样属于**读不到** —— 两者都
  // 不许被渲染成「没有在跑」。
  const runtimeUnknown = live === null || live.runtime === "unavailable";
  return (
    <div className="flex flex-col">
      <WorkDagCanvas layout={layout} live={live} selectedId={selectedId} onSelect={onSelect} />
      <WorkDagLegend />
      {runtimeUnknown && (
        <div className="ss-note flex items-start gap-1.5" style={{ marginTop: 4 }}>
          <span
            className="ss-live-dot"
            data-state="unknown"
            style={{ marginTop: 5, flex: "0 0 auto" }}
          />
          {/* 这一句是**多行中文**:用字符串字面量拼,免得 JSX 把换行折成空格,
              在句子中间留出一个空格(中文句子里的空格会被读成排版错误)。 */}
          <span>
            {"运行态读不到:这次只连上了 HTTP 读面,宿主没有接上运行期快照 —— 谁此刻在跑读不到。" +
              "所以节点边框一律不点亮;若某个节点上出现灰色点,那只说明库里那条工作项还标着" +
              "「进行中」,不等于此刻有回合在跑。"}
          </span>
        </div>
      )}
      {unlayered.length > 0 && (
        <div className="ss-note" style={{ marginTop: 4, color: "var(--amber)" }}>
          {layout.mutualPairs.length > 0 && (
            <div>
              {`⚠️ 先后算不出来:这 ${layout.mutualPairs.length} 对环节互相咬住 —— `}
              {layout.mutualPairs
                .map((p) => {
                  const name = (id: string): string =>
                    layout.nodes.find((n) => n.work.id === id)?.work.title || id;
                  // 两条边的**方向与 kind** 都写出来:读者据此知道该删哪一条
                  return (
                    `${name(p.a)} ${EDGE_KIND_LABEL[p.ab]} ${name(p.b)}` +
                    ` ↔ ${name(p.b)} ${EDGE_KIND_LABEL[p.ba]} ${name(p.a)}`
                  );
                })
                .join(";")}
            </div>
          )}
          有 {unlayered.length} 个环节的先后算不出来(在依赖环上或环的下游):
          {unlayered.map((n) => n.work.title || n.work.id).join(" · ")}
          {" —— "}
          {"它们被统一排在最后一列,别按左右位置读先后。" +
            "这不是没算,是这几条依赖互相咬住了(谁该先做没有答案)。"}
        </div>
      )}
      {layout.droppedEdges > 0 && (
        <div className="ss-note" style={{ marginTop: 4 }}>
          另有 {layout.droppedEdges} 条边没有画出来(重复、自环,或指向本次没读到的环节)。
        </div>
      )}
    </div>
  );
}

/**
 * **① 依赖关系图整块** = `Section` + `WorkDag`(**展开,没有 `<Disclosure>`**)。
 *
 * 为什么单列成一个导出组件(而不是留在 `ArtifactsBody` 里):
 * 用户要求它**排在最上面**(2026-10-07,见文件头),而 `ArtifactsBody` 那一块
 * 现在是 ③④⑤ —— 顺序由 `ArtifactsScreen` 决定。它是**纯 props** 的,于是
 * `tests/web/artifact-dag.test.ts` 那 22 条节点判据仍然能在
 * 「`DependencyGraph` + `ArtifactsBody`」这个组合上钉住(保持图在前、面板在后
 * 的旧 DOM 顺序),不必起服务。
 *
 * 两块小字的实质**沿用原来那段说明**,只把它从「默认折叠是怕它抢主视图的位置」
 * 改成「为什么它在最上面」:节点 = 工作项,实线 = 拆解(子项 → 父项),
 * 虚线 = 前置依赖(前置 → 本条),两条边的方向**都是先后**;它排最前是因为
 * 「谁在等谁」是读这一页的第一问(推进图回答的是「什么时候发生的」)。
 *
 * ⚠️ 选中态在这里也要解析一次(`resolveSelectedWorkId`)—— 与 ②(推进图)和
 * ③(面板)用的是同一个纯函数、同一份 `picked`,所以三处必然指向同一条工作项。
 */
/** 贝塞尔:从源卡右缘到目标卡左缘,水平出入(层与层之间有 `AG_COL_GAP` 的空间)。 */
function edgePath(fromX: number, fromY: number, toX: number, toY: number): string {
  const dx = Math.max(24, (toX - fromX) / 2);
  return `M ${fromX} ${fromY} C ${fromX + dx} ${fromY}, ${toX - dx} ${toY}, ${toX} ${toY}`;
}

/**
 * **工件关系图整块** = `Section` + `ArtifactRelationGraph`(展开,没有 `<Disclosure>`)。
 *
 * 它**取代**了原先那块工作项依赖关系图(2026-10-06 用户裁决:「我之前说的 dag,
 * 其实是想要工件的 dag」)。为什么旧的那块非换不可 —— 真机库那一版最能说明:
 * 美股项目 39 件工件里,**8 条 `decision` + 3 条 `client_question` 没有
 * `work_id`**,在「节点 = 环节」的图上**一个节点都没有**。甲方视角里最重要的
 * 那一半(拍板与问答)在旧图上完全不可见。
 *
 * 交互:点一个工件节点 ⇒ 展开它的详情,与推进图上「点一个圆点」走**同一条**通路
 * (`onOpenArtifact`)。刻意**不**新增一个「选中工件」状态:旧的 `picked` 是
 * **工作项** id(推进图的绿条选中 + 下面③的面板),而这张图的节点是工件 ——
 * 两种节点塞进同一个状态,必然出现「在图上选中了 A、面板显示 B」。
 * 两个状态各自管各自那一块,判据不混。
 */
export function ArtifactRelationGraph({
  artifacts,
  works,
  openId,
  onOpenArtifact,
}: {
  artifacts: readonly ArtifactView[];
  works: readonly WorkView[];
  /** 已展开详情的那条工件 id(null = 都没展开) */
  openId: string | null;
  onOpenArtifact: (artifactId: string) => void;
}) {
  const layout = layoutArtifactGraph(artifacts, works);
  return (
    <Section
      title="工件关系图"
      count={artifacts.length}
      hint="节点 = 工件,三种边;从左到右读先后"
      hintTitle={
        "节点是**工件** —— 你的决策、质检的产出、交付物都在上面,而不挂在任何工作项上的" +
        "决策与甲方问答**也**在(旧那张「节点 = 环节」的图把它们整个漏掉了)。" +
        `实线 = ${RELATIONS.depends_on.label}(交付物 → 它的依据),` +
        `虚线 = ${RELATIONS.answers.label}(提问 → 答复),` +
        `点线 = ${RELATIONS.parent.label};「质检所审」是派生出来的(库里的边只到工作项粒度)。` +
        `各边的方向**都是先后**(因 → 果),` +
        "所以从左到右读就是「先有什么、后有什么」;这条性质是被检查的,反向边不画、只点名。" +
        ` ${LOGICAL_RELATION_NOTE}`
      }
    >
      {artifacts.length === 0 ? (
        <EmptyState>这个项目还没有工件 —— 关系图要等第一件产出落库才有节点。</EmptyState>
      ) : (
        <div className="flex flex-col">
          <div className="ss-dag" style={{ maxHeight: 620 }}>
            <div style={{ position: "relative", width: layout.width, height: layout.height }}>
              <svg
                className="ss-dag-edges"
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
              >
                {layout.edges.map((e) => (
                  <path
                    key={`${e.rel}:${e.from}->${e.to}`}
                    d={edgePath(e.fromX, e.fromY, e.toX, e.toY)}
                    fill="none"
                    stroke="var(--bone-mute)"
                    strokeWidth={1}
                    {...(RELATIONS[e.rel].dash !== undefined
                      ? { strokeDasharray: RELATIONS[e.rel].dash }
                      : {})}
                  />
                ))}
              </svg>
              {layout.nodes.map((n) => {
                const a = n.artifact;
                const on = openId === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    data-artifact-node={a.id}
                    data-artifact-depth={n.depth}
                    data-artifact-isolated={n.inDegree === 0 && n.outDegree === 0}
                    onClick={() => onOpenArtifact(a.id)}
                    title={`${a.title || "(无标题)"}\n${artifactKindLabel(a.kind)} · ${a.authorName || a.authorAgentId}\n${formatClock(a.createdAt, true)}\n` +
                      `入 ${n.inDegree} · 出 ${n.outDegree}` +
                      (n.workTitle !== null ? `\n产出于「${n.workTitle}」` : "\n不挂任何工作项(决策 / 甲方问答)") +
                      (n.unlayered ? "\n⚠️ 先后算不出来(在关系环上或环的下游)" : "")}
                    style={{
                      position: "absolute",
                      left: n.x,
                      top: n.y,
                      width: AG_NODE_W,
                      height: AG_NODE_H,
                      textAlign: "left",
                      border: `1px solid ${on ? "var(--bone)" : "var(--line)"}`,
                      background: "var(--panel)",
                      borderRadius: 6,
                      padding: "5px 7px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      overflow: "hidden",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span
                        style={{
                          width: 6, height: 6, borderRadius: 2, flex: "0 0 auto",
                          background: toneColor(artifactKindTone(a.kind)),
                        }}
                      />
                      <span className="ss-meta" style={{ color: "var(--bone-mute)" }}>
                        {artifactKindLabel(a.kind)}
                      </span>
                    </span>
                    <span
                      className="ss-body"
                      style={{ color: "var(--bone)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {clipLabel(a.title || a.id, AG_NODE_W - 20)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <ArtifactRelationLegend layout={layout} />
        </div>
      )}
    </Section>
  );
}

/** 图例。**三类边逐类报实数** —— 0 条就写 0,不假装它是个正常关系。 */
export function ArtifactRelationLegend({ layout }: { layout: ArtifactGraphLayout }) {
  const rels: ArtifactRelation[] = ["depends_on", "review_about", "answers", "parent"];
  return (
    <div className="ss-note" style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {rels.map((r) => (
          // `title` = 这一类到底是什么、方向为什么是那样、为什么它是 0 条。
          // 放在悬停里而不是摊在图下方:三段说明加起来有五行,而其中最该被读到的
          // 是**为什么某类是 0** —— 那一行已经在下面常显了。
          <span
            key={r}
            title={RELATIONS[r].why}
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            <svg width={22} height={8} aria-hidden="true">
              <line
                x1={0} y1={4} x2={22} y2={4} stroke="var(--bone-mute)" strokeWidth={1}
                {...(RELATIONS[r].dash !== undefined ? { strokeDasharray: RELATIONS[r].dash } : {})}
              />
            </svg>
            {`${RELATIONS[r].label}(${layout.stats[r]} 条)`}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 3 }}>
        {`「质检所审」是**派生**关系(库里没有这一条边,来自 014 的 work_id 的「关于」语义):` +
          `它是**集合**关系 —— 一条工作项有几份产出就画几条,每条都成立,但没有一条能说` +
          `「它审的就是这一份」。${layout.multiTargetReviews > 0
            ? `本图里有 ${layout.multiTargetReviews} 件审查产出指向了不止一件产出。`
            : "本图里没有一件审查产出指向多份(所以每条边都是一对一)。"}`}
      </div>
      <div style={{ marginTop: 3 }}>{LOGICAL_RELATION_NOTE}</div>
      {isIsolated(layout) && (
        <div style={{ marginTop: 3, color: "var(--amber)" }}>
          {"这一版一件工件都没有连线 —— 卡片仍在,只是它们之间没有**已记录**的关系。" +
            "这是数据没记,不是图画不出来。"}
        </div>
      )}
      {layout.backwardEdges.length > 0 && (
        <div style={{ marginTop: 3, color: "var(--amber)" }}>
          {`⚠️ 有 ${layout.backwardEdges.length} 条边的因果方向反了(源比目标晚),已**不画**:` +
            "「从左到右读先后」这句话在有它们时不成立,所以宁可少画也不画错。"}
        </div>
      )}
      {layout.dangling.length > 0 && (
        <div style={{ marginTop: 3 }}>
          {`另有 ${layout.dangling.length} 条边指向本次没读到的工件,未画。`}
        </div>
      )}
      {layout.unlayeredIds.length > 0 && (
        <div style={{ marginTop: 3, color: "var(--amber)" }}>
          {`有 ${layout.unlayeredIds.length} 件工件的先后算不出来(在关系环上或环的下游):` +
            `${layout.unlayeredIds.join(" · ")} —— 它们被排在第 0 列,别按左右位置读先后。`}
        </div>
      )}
    </div>
  );
}

export function DependencyGraph({
  works,
  artifacts,
  live,
  picked,
  onPick,
}: {
  works: readonly WorkView[];
  artifacts: readonly ArtifactView[];
  live: DagLive | null;
  /** 用户选中的环节(三态:见 `resolveSelectedWorkId`)—— 与 ②③ 同一个来源 */
  picked: string | null | undefined;
  onPick: (workId: string | null) => void;
}) {
  const layout = layoutWorkDag(works, artifacts);
  const selectedId = resolveSelectedWorkId(layout, picked);
  return (
    <Section
      title="依赖关系图"
      count={works.length}
      hint="分层排布,可能较宽"
      // ⚠️ 这一段是**悬停**才出现的整段解释(不是屏幕上那一行小字):两句必须说的话
      // 都在这里 —— 两类边各是什么、方向是哪边;以及它为什么排在最上面。
      hintTitle={
        "节点 = 工作项,实线 = 拆解(子项 → 父项),虚线 = 前置依赖(前置 → 本条)。" +
        "两条边的方向都是**先后**(前置 → 本条;子项 → 父项,容器由子项推动),所以从左到右读就是「先做什么、后做什么」。" +
        "它排在这一页最上面,是因为「谁在等谁」是读这一页的第一问 —— 不知道这个,推进图上的先后只是「发生了些什么」;" +
        "推进图回答的是「什么时候发生的」,两张图答的是不同的问题,都不许少。"
      }
    >
      {works.length === 0 ? (
        <EmptyState>
          这个项目还没有工作项 —— 依赖关系要等项目经理拆出第一条工作项才有节点。
        </EmptyState>
      ) : (
        // ⚠️ 这里**只有** `WorkDag`,没有 `<Disclosure>` / `<details>` —— 展开是
        // 用户明确要求的(「不要默认收起」)。别顺手把它折回去。
        <WorkDag layout={layout} live={live} selectedId={selectedId} onSelect={onPick} />
      )}
    </Section>
  );
}

// ── 工件行 / 工件分组(③ 与 ② 共用同一套渲染代码)──────────────────

/** links 的 rel 是契约里的闭合联合(parent | depends_on | answers);未知值原样透出。 */
const REL_LABEL: Record<string, string> = {
  parent: "父工件",
  depends_on: "依赖",
  answers: "答复",
};

/**
 * 一条工件的摘要行(kind 色点 / status Pill / 标题 / 作者 / 时间 / body 截断),
 * 外加「详情」按钮。② 与 ③ **共用这一个组件** —— 两份渲染代码迟早会长歪。
 *
 * 详情是否展开由父层给(`open` + `onToggle`):一个页面同时只展开一条,
 * 免得一屏里挂出好几段正文。
 */
export function ArtifactRow({
  artifact: a,
  known,
  open,
  onToggle,
}: {
  artifact: ArtifactView;
  /** 本次已加载的工件列表 —— 只用来**顺手**给关联目标显示标题(详情里用) */
  known: readonly ArtifactView[];
  open: boolean;
  onToggle: () => void;
}) {
  const mode = bodyMode(a);
  const isHtmlReport = mode === "html_report";
  const isCodeService = mode === "code_service";
  // 坐标由**服务端**解析好(`transport/views.ts`),前端不再碰 metadata_json
  const csMeta = isCodeService ? a.codeService : null;
  return (
    <article className="sansheng-card p-2.5" title={a.id}>
      <div className="flex items-center gap-2 flex-wrap">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 2,
            flex: "0 0 auto",
            background: toneColor(artifactKindTone(a.kind)),
          }}
        />
        <Pill tone={artifactStatusTone(a.status)} title={a.status}>
          {artifactStatusLabel(a.status)}
        </Pill>
        {isHtmlReport && (
          <Pill tone={deliverableTypeTone("html_report")} title="deliverable_type">
            {deliverableTypeLabel("html_report")}
          </Pill>
        )}
        {isCodeService && (
          <Pill tone={deliverableTypeTone("code_service")} title="deliverable_type">
            {deliverableTypeLabel("code_service")}
          </Pill>
        )}
        {/*
          甲方收货的状态(029)。**只在交付物上出现** —— 非交付物的 acceptance
          是 `null`(契约),而这里不许拿它去猜一个默认值。
          ⚠️ 三个分支分开渲染:`null`(没表态)不是任何一种裁决,把它并进 else
          会让「等你验收」在屏幕上消失。
        */}
        {a.acceptance !== null && (
          a.acceptance.verdict === null ? (
            <Pill
              tone={a.acceptance.handedOver ? "amber" : "mute"}
              title={a.acceptance.handedOver ? "已交付,等你表态" : "还没交付给你"}
            >
              {a.acceptance.handedOver ? "等你验收" : "未交付"}
            </Pill>
          ) : (
            <Pill
              tone={DELIVERY_VERDICT_TONE[a.acceptance.verdict]}
              title={a.acceptance.at === null ? undefined : fmtTime(a.acceptance.at)}
            >
              {DELIVERY_VERDICT_LABEL[a.acceptance.verdict]}
            </Pill>
          )
        )}
        <span className="ss-body" style={{ color: "var(--bone)" }}>
          {a.title || "(无标题)"}
        </span>
        <span className="ss-meta ml-auto">{a.authorName || a.authorAgentId}</span>
        <button
          type="button"
          className="sansheng-button"
          style={{ padding: "1px 8px", fontSize: 11 }}
          title="按 id 拉 GET /api/artifacts/:id,看正文全文与关联关系"
          onClick={onToggle}
        >
          {open ? "收起" : "详情"}
        </button>
      </div>
      {isHtmlReport ? (
        <div className="ss-meta mt-1">
          一份 HTML 报告 —— 点「详情」在沙箱里渲染。
        </div>
      ) : isCodeService ? (
        <div className="ss-meta mt-1">
          代码服务
          {csMeta?.service !== null && csMeta?.service !== undefined ? `「${csMeta.service}」` : ""}
          {csMeta?.branch != null ? ` · 分支 ${csMeta.branch}` : ""}
          {csMeta?.servicePath != null ? ` · 服务目录 ${csMeta.servicePath}` : ""}
          {csMeta?.deliverableCommit != null ? ` · 交付版本 ${shortSha(csMeta.deliverableCommit)}` : ""}
          {csMeta?.port != null ? ` · 端口 ${csMeta.port}` : ""}
          {" —— 点「详情」看仓库坐标与部署命令。"}
        </div>
      ) : (
        // ⚠️ 卡片上**不再印正文**(2026-10-08,设计 §4.2):正文住项目仓里的
        // 一份文件,列表只给落点与字节数。给每张卡片各拉一次正文 = 把列表变回
        // 「每次都把全部正文拉一遍」,那正是这次改动要去掉的东西。
        // 全文在「详情」里**现读**;读不到时由那一段印出 problem(不是空白)。
        <div className="ss-meta mt-1">
          {a.bodyBytes > 0
            ? `正文 ${a.bodyBytes} 字节 —— 点「详情」现读全文。`
            : "这条工件没有正文。"}
        </div>
      )}
      <div className="ss-meta mt-1">
        {fmtTime(a.createdAt)}
        {a.links.length > 0 &&
          ` · 关联 ${a.links.map((l) => `${l.rel}→${l.targetId}`).join(" · ")}`}
      </div>
      {/*
        验收动作(029)。**挂在这里是因为甲方就在这一页读正文** —— 让他看完还要
        跳到项目页去表态,等于把「有事等你」藏起来。
        ⚠️ `handedOver === false` 时组件自己会说明「还没交付」而不显示按钮
        (后端也会拒:没收到货谈不上验收)。
      */}
      {a.acceptance !== null && (
        <DeliveryVerdictActions artifactId={a.id} title={a.title} acceptance={a.acceptance} />
      )}
      {open && <ArtifactDetail id={a.id} known={known} />}
    </article>
  );
}

/**
 * 一串工件按 `kind` 分组(顺序沿用 `KIND_ORDER`,组内按 createdAt 倒序)。
 *
 * 分组的依据**只有本次真实返回的 kind**;契约之外的 kind 原样显示英文(落在末尾),
 * 不猜、也不丢。
 */
export function ArtifactGroups({
  artifacts,
  known,
  openId,
  onToggleDetail,
}: {
  artifacts: readonly ArtifactView[];
  known: readonly ArtifactView[];
  /** 当前展开了详情的那条工件 id(null = 都收起) */
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  const groups = useMemo(() => {
    const byKind = new Map<string, ArtifactView[]>();
    for (const a of artifacts) {
      const bucket = byKind.get(a.kind);
      if (bucket) bucket.push(a);
      else byKind.set(a.kind, [a]);
    }
    return [...byKind.entries()]
      .sort((x, y) => {
        const ix = KIND_ORDER.indexOf(x[0] as ArtifactKind);
        const iy = KIND_ORDER.indexOf(y[0] as ArtifactKind);
        return (ix === -1 ? KIND_ORDER.length : ix) - (iy === -1 ? KIND_ORDER.length : iy);
      })
      .map(([kind, rows]) => ({
        kind,
        rows: [...rows].sort((a, b) => b.createdAt - a.createdAt),
      }));
  }, [artifacts]);

  return (
    <div className={artifacts.length > 0 ? "grid gap-4" : undefined}>
      {groups.map(({ kind, rows }) => (
        <Section key={kind} title={artifactKindLabel(kind)} count={rows.length} hint={kind}>
          <div className="grid gap-1.5">
            {rows.map((a) => (
              <ArtifactRow
                key={a.id}
                artifact={a}
                known={known}
                open={openId === a.id}
                onToggle={() => onToggleDetail(a.id)}
              />
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

// ── ③ 选中的环节 ────────────────────────────────────────────────

/**
 * 一个环节的面板:**这一条工作项是谁的、在等谁、要什么,以及它留下了什么**。
 *
 * `artifacts` 是**只有这个环节的**那几条(调用方用 `splitArtifactsByWork().byWork`
 * 取),不是整个项目的工件 —— 把全项目的工件铺进每个节点是这一版最要防的那种错。
 *
 * 选中来源有两个(② 推进图上的条 / ① 依赖关系图上的节点),但组件只认一个
 * `work` —— 谁选中它不关它的事,面板的形态与文案因此一个字都没改。
 */
export function WorkNodePanel({
  work,
  works,
  artifacts,
  known,
  openId,
  onToggleDetail,
}: {
  work: WorkView;
  /** 本项目全部工作项 —— 只用来把 dependsOn 的 id 翻成标题 */
  works: readonly WorkView[];
  /** **这个环节**挂着的工件(已按 workId 分好) */
  artifacts: readonly ArtifactView[];
  known: readonly ArtifactView[];
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  const deps = work.dependsOn;
  return (
    <Section
      title="选中的环节"
      count={artifacts.length}
      hintTitle="点推进图上的条,或依赖关系图上的节点,切换环节;再点一次同一个取消选中。"
      aside={
        <span className="ss-meta font-mono" title="工作项 id">
          {work.id}
        </span>
      }
    >
      <article className="sansheng-card p-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone={workStatusTone(work.status)} title={work.status}>
            {workStatusLabel(work.status)}
          </Pill>
          <span className="ss-body" style={{ color: "var(--bone)" }}>
            {work.title || "(无标题)"}
          </span>
        </div>

        <div className="flex flex-col">
          {/* ⚠️ `KV` 的 `title` 是**显示在屏幕上的**注解,不是 HTML 属性(见
              primitives.tsx)—— 长解释一律走真 `title=`,否则首屏会多出两行小字。 */}
          <KV label="负责人" value={work.assigneeName || work.assigneeAgentId} />
          <KV
            label="更新"
            value={<span title="契约 WorkView.updatedAt">{fmtTime(work.updatedAt)}</span>}
          />
          <KV
            label="前置"
            value={
              deps.length === 0 ? (
                <span title="契约 WorkView.dependsOn 为空:这条环节不依赖别的工作项">
                  没有前置依赖
                </span>
              ) : (
                <span
                  className="flex items-center gap-1.5 flex-wrap"
                  title="契约 WorkView.dependsOn:本环节依赖哪些工作项(它们是 DAG 上的虚线入边)"
                >
                  {deps.map((id, i) => {
                    const dep = works.find((w) => w.id === id);
                    return (
                      <span key={id} className="flex items-center gap-1.5">
                        {i > 0 && <span>·</span>}
                        {dep !== undefined ? (
                          <span title={`工作项 id:${id}`}>{dep.title || id}</span>
                        ) : (
                          <span className="ss-meta" title={`工作项 id:${id}`}>
                            {id}(本次列表里没有这条工作项)
                          </span>
                        )}
                      </span>
                    );
                  })}
                </span>
              )
            }
          />
        </div>

        {work.goal.length === 0 ? (
          <div className="ss-note">这条工作项没有写目标(goal 为空)。</div>
        ) : (
          <>
            <Clamp lines={2}>{work.goal}</Clamp>
            <Disclosure summary="目标全文">
              <div style={{ whiteSpace: "pre-wrap" }}>{work.goal}</div>
            </Disclosure>
          </>
        )}

        <div>
          <div className="ss-section" style={{ fontSize: 12 }}>
            它挂着的工件({artifacts.length})
          </div>
          {artifacts.length === 0 ? (
            <div className="ss-note">这条工作项还没有产出工件。</div>
          ) : (
            <ArtifactGroups
              artifacts={artifacts}
              known={known}
              openId={openId}
              onToggleDetail={onToggleDetail}
            />
          )}
        </div>
      </article>
    </Section>
  );
}

// ── ④ 不挂在任何环节上的工件 ────────────────────────────────────

/**
 * `workId === null` 的工件:决策 / 会议记录 / 变更记录 / 甲方问答。
 *
 * 这一块**必须自己带一句说明**:它们不是「还没归位」,而是本来就不由某条工作项
 * 产出(契约 `ArtifactView.workId` 的注释逐字写着这件事)。不写这句,读者会把它
 * 读成「流程漏了几条产出」。
 */
export function UnattachedArtifacts({
  artifacts,
  known,
  openId,
  onToggleDetail,
}: {
  artifacts: readonly ArtifactView[];
  known: readonly ArtifactView[];
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  return (
    <Section
      title="不挂在任何环节上的工件"
      count={artifacts.length}
      hint="已在图上(按 kind 落在自己那一行)"
      hintTitle="这些工件的 workId 为 null —— 契约里这是合法状态:它们不由某条工作项产出。⚠️ 它们**不是「没画出来」**:推进图里每一件工件都按自己的 kind 落在一行上(决策 / 会议 / 变更 / 甲方问答各有各的道),这一块只是**同一批工件的清单**(逐条可看详情)。"
    >
      {/* `.ss-dag-orphan`:安静一点,不与主图争注意力(类在 globals.css 里)。 */}
      <div className="ss-dag-orphan">
        <div className="ss-note" style={{ marginBottom: 6 }}>
          {"这些是决策 / 会议记录 / 变更记录 / 甲方问答 —— 它们本来就不由某条工作项产出" +
            "(契约里 ArtifactView.workId 为 null 是合法状态,不是「还没归位」)。" +
            "⚠️ **它们已经在上面那张图上**(按 kind 落在自己那一行),所以这里默认收起:" +
            "点开是为了逐条看详情 / 抄 id,不是因为图上没画。"}
        </div>
        <Disclosure summary={`展开清单(${artifacts.length} 条 · 可逐条看详情)`}>
          <ArtifactGroups
            artifacts={artifacts}
            known={known}
            openId={openId}
            onToggleDetail={onToggleDetail}
          />
        </Disclosure>
      </div>
    </Section>
  );
}

// ── ⑤ 环节读不到的工件 ──────────────────────────────────────────

/**
 * `workId` 指向一条**本次没加载到**的工作项。理论上被外键挡住,但读面必须容错:
 * 直接丢掉它们等于让几条工件无声消失(「见不到的现场等于没有现场」)。
 * 按 workId 分组列出,并写明是**环节读不到**,不是工件没有环节。
 */
export function DanglingArtifacts({
  dangling,
  known,
  openId,
  onToggleDetail,
}: {
  dangling: ReadonlyMap<string, ArtifactView[]>;
  known: readonly ArtifactView[];
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  const entries = [...dangling.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const total = entries.reduce((n, [, rows]) => n + rows.length, 0);
  return (
    <Section
      title="环节读不到的工件"
      count={total}
      hintTitle="它们挂着 workId,但本次没有读到那条工作项(通常是被删了)—— 不是它们没有环节。"
    >
      <div className="grid gap-3">
        {entries.map(([workId, rows]) => (
          <div key={workId}>
            <div className="ss-note" style={{ marginBottom: 4 }}>
              挂在 {workId} 上,但本次读不到这条工作项。
            </div>
            <ArtifactGroups
              artifacts={rows}
              known={known}
              openId={openId}
              onToggleDetail={onToggleDetail}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── ③④⑤ 的组织(纯 props,测试直接渲染它)──────────────────────

/**
 * 选中的环节 id(三态 → 一个 id)。**① 依赖关系图、② 推进图、③ 面板共用的唯一一处判据**:
 * 两处各写一份必然漂(一个高亮 A、另一个显示 B,页面上看起来只是「有点怪」)。
 *
 * `picked` 的三态:
 *   - `undefined` —— 用户还没点过任何东西 ⇒ 用**默认选中的环节**;
 *   - `string`    —— 用户点了它;它已经不在本次列表里(项目换了 / 工作项被删)⇒
 *     退回默认,不留一个指向空气的选择;
 *   - `null`      —— 用户明确取消(再点一次选中项),这时只显示图 + 一句提示。
 *
 * 默认选中的是**布局里第一个有功件的环节**(从左到右、从上到下第一个)—— 它最可能
 * 就是读者想先看的那一步(流程的起点附近),而且「有没有工件」是这一页的分界线:
 * 没有工件的环节给的是一句「还没有产出工件」,先看它没有信息量。
 * (这段判据是**照搬**上一版 `ArtifactsBody` 里那段,只把它从闭包里提出来。)
 */
export function resolveSelectedWorkId(
  layout: WorkDagLayout,
  picked: string | null | undefined,
): string | null {
  const defaultId = layout.nodes.find((n) => n.artifactCount > 0)?.work.id ?? null;
  if (picked === undefined) return defaultId;
  if (picked === null) return null;
  return layout.nodes.some((n) => n.work.id === picked) ? picked : defaultId;
}

/**
 * 本页(工作项页)的 **③④⑤**。**纯 props**:选择态由 `picked` 传入,默认选中也在这一层定,
 * 于是「默认选谁」这件事可以在测试里被钉住,而不是散在 hook 之间。
 *
 * ①(依赖关系图)与 ②(推进图)不在这里 —— 它们由 `ArtifactsScreen` 排在这一块**前面**。
 * 这样切分的好处是这一块的判据(面板只挂自己的工件 / 无环节工件单独列 / 环节读不到)
 * 与两张图的判据(节点计数、点数、条数、端点语义)可以**分开**钉,互不干扰。
 *
 * ⚠️ **2026-10-07 起这一块不再渲染 DAG**(用户要求它展开并排在最上面,整块搬进
 * `DependencyGraph`),所以它的 `live` 参数也一并去掉了 —— ③④⑤ 里没有任何一处
 * 读运行态(「读不到运行态」那两行小字属于 ①)。留一个没人读的参数等于给下一个人
 * 一个错误的暗示(「这块也看 live」)。
 *
 * ⚠️ **块内的 DOM 顺序是 ③ → ④ → ⑤**;阅读顺序是「先看选中的环节,再看两个边角清单」。
 * 位置有一条硬约束:`tests/web/artifact-dag.test.ts` 的 `nodeButton()` 用**工作项标题的
 * 第一次出现**来定位节点卡片(`html.indexOf(title)` + `lastIndexOf("<button", …)`),
 * 而 ③ 面板里也会出现同一条标题(它不是 `<button>`)—— 所以 ① 的节点标记必须排在
 * ③ 之前。`ArtifactsScreen` 就是这样摆的(这也是本块不能把 ① 排到后面的原因)。
 */
export function ArtifactsBody({
  works,
  artifacts,
  picked,
  onPick,
  openId,
  onToggleDetail,
}: {
  works: readonly WorkView[];
  artifacts: readonly ArtifactView[];
  picked: string | null | undefined;
  onPick: (workId: string | null) => void;
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  const layout = layoutWorkDag(works, artifacts);
  const split = splitArtifactsByWork(artifacts, works);
  const selectedId = resolveSelectedWorkId(layout, picked);
  const selectedWork = works.find((w) => w.id === selectedId) ?? null;

  return (
    <div className="grid gap-4">
      {works.length > 0 &&
        (selectedWork === null ? (
          <EmptyState>点一个环节看它的产出。</EmptyState>
        ) : (
          <WorkNodePanel
            work={selectedWork}
            works={works}
            artifacts={split.byWork.get(selectedWork.id) ?? []}
            known={artifacts}
            openId={openId}
            onToggleDetail={onToggleDetail}
          />
        ))}

      {/* ④ 与 ⑤ 只有**真的有条目**才渲染(空块会被读成「漏了东西」)。 */}
      {split.noWork.length > 0 && (
        <UnattachedArtifacts
          artifacts={split.noWork}
          known={artifacts}
          openId={openId}
          onToggleDetail={onToggleDetail}
        />
      )}

      {split.dangling.size > 0 && (
        <DanglingArtifacts
          dangling={split.dangling}
          known={artifacts}
          openId={openId}
          onToggleDetail={onToggleDetail}
        />
      )}
    </div>
  );
}

// ── 页面正文:①② + ③④⑤(纯 props)───────────────────────────────

/**
 * 本页正文 = **① 依赖关系图 + ② 推进图 + ③④⑤**。
 *
 * 抽成纯 props 组件、而不是写死在 `WorksPage` 的 JSX 里,是为了让测试渲染的
 * 就是页面真正渲染的那棵树 —— 否则「点 ② 上的条,③ 面板跟着切」这类判据只能在
 * 测试自己拼的组合上验证,页面真接线错了也不会红。
 *
 * ⚠️ **顺序就是用户定的那一句**(2026-10-07 原话:「工作项中,依赖关系图不要默认
 * 收起,放在最上面,这个页面的信息依次是:依赖关系图、推进图、选中的环节详情」):
 * ① `DependencyGraph` → ② 推进图 `Section` → ③④⑤ `ArtifactsBody`。
 * 别把 ① 挪到后面 —— 除了用户的要求,`nodeButton()` 的定位方式也依赖「节点排在面板
 * 之前」(见 `ArtifactsBody` 的注释)。
 *
 * ② 与 ③ 的选中态来自**同一次** `resolveSelectedWorkId(...)` 调用;① 内部另调一次
 * 同一个纯函数(`DependencyGraph` 保持纯 props,不必把布局从外面塞进去 —— 同一份
 * `works` / `artifacts` / `picked` 进同一个纯函数,结果必然相同)。
 */
export function ArtifactsScreen({
  works,
  artifacts,
  live,
  now,
  picked,
  onPick,
  openId,
  onToggleDetail,
}: {
  works: readonly WorkView[];
  artifacts: readonly ArtifactView[];
  live: DagLive | null;
  /** 页面这一刻的本地时钟(见文件头:入场参数,不是判断依据) */
  now: number;
  picked: string | null | undefined;
  onPick: (workId: string | null) => void;
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  const selectedId = resolveSelectedWorkId(layoutWorkDag(works, artifacts), picked);
  return (
    <div className="grid gap-4">
      {/* ① 工件关系图 —— **第一块,而且是展开的**。
          2026-10-06 用户裁决:「我之前说的 dag,其实是想要工件的 dag」,
          所以它**取代**了原先那块「节点 = 环节」的依赖关系图。 */}
      <ArtifactRelationGraph
        artifacts={artifacts}
        works={works}
        openId={openId}
        onOpenArtifact={onToggleDetail}
      />

      <Section
        title="推进图"
        hint={`${works.length} 条工作项 · ${artifacts.length} 件工件 · 点一条工作项(绿色条)⇒ 下面显示它挂着的工件`}
        hintTitle="点一条工作项(绿色条)⇒ 下面(③「选中的环节」)显示它挂着的工件。横轴 = 距项目起点的耗时(T+0 起;x 是线性的,位置不需要解 —— 所以不存在边交叉);上区每条工作项一道(条 = 创建→收口,刻度 = 它产出的工件),下区每种工件一道(点 = 一件工件,含不挂任何环节的决策 / 会议 / 变更 / 甲方问答)。点条选中环节(与下面的面板联动),点圆点看那件工件。上面那张图回答「它们之间是什么关系」,这张回答「什么时候发生的」。"
      >
        <ProgressTimeline
          works={works}
          artifacts={artifacts}
          live={live}
          now={now}
          selectedId={selectedId}
          onSelectWork={onPick}
          onOpenArtifact={onToggleDetail}
        />
      </Section>

      <ArtifactsBody
        works={works}
        artifacts={artifacts}
        picked={picked}
        onPick={onPick}
        openId={openId}
        onToggleDetail={onToggleDetail}
      />
    </div>
  );
}

// ── 页面:取数 + 两个交互态 ──────────────────────────────────────

export function WorksPage() {
  const projects = useChatStore((s) => s.projects);
  const activeProjectId = useChatStore((s) => s.projectId);
  const [scope, setScope] = useState<string | null>(activeProjectId);
  /** 用户手动选中的环节(见 `ArtifactsBody` 的三态说明)。 */
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  /** 展开了详情的那条工件 id(null = 都收起)。 */
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    // 用户在对话页切了项目 → 本页跟着切(不然会对着旧项目的工作项发呆),
    // 同时把两个交互态清掉:选中项与详情都指向旧项目的 id。
    setScope(activeProjectId);
    setPicked(undefined);
    setOpenId(null);
  }, [activeProjectId]);

  const worksLoad = useWorks(scope);
  const artifactsLoad = useArtifacts({ projectId: scope });
  const liveLoad = useProjectLive(scope);

  const works = worksLoad.data;
  const artifacts = artifactsLoad.data;
  const error = worksLoad.error ?? artifactsLoad.error;
  /**
   * ⚠️ live 只在**没有出错**时当事实。轮询失败后 `useLoad` 会留着上一帧,
   * 拿旧快照渲染「此刻在跑」等于把过去冒充现场 —— 出错时按「读不到」处理
   * (`workRunningState(work, null)` 给 `unknown: true`,界面据此不点亮节点)。
   */
  const live: DagLive | null = liveLoad.error === null ? liveLoad.data : null;

  const unattachedCount = useMemo(
    () => splitArtifactsByWork(artifacts, works).noWork.length,
    [artifacts, works],
  );

  const scopeName =
    scope === null ? "未选项目" : projects.find((p) => p.id === scope)?.name ?? scope;
  /** 「还没查过」与「查过了,是空」必须分开(见 lib/data.ts 文件头)。 */
  const nothingYet = works.length === 0 && artifacts.length === 0;

  return (
    <div className="ss-page">
      <PageHeader
        title="工作项"
        hint={`范围:${scopeName}`}
        hintTitle="本页 = 工作项页(旧的「工件」页已并入这里,不再单开一个 tab)。数据来源:GET /api/projects/:id/works(节点与条)+ /artifacts(点)+ /live(在跑)。契约没有跨项目的 /api/works 与 /api/artifacts —— 工作项与工件总是属于某个项目。kind / status / work_status 都是契约里的闭合集合。"
        aside={
          <div className="flex items-center gap-1.5 flex-wrap">
            <select
              value={scope ?? ""}
              onChange={(e) => setScope(e.target.value === "" ? null : e.target.value)}
              style={{
                background: "var(--ink-1)",
                border: "1px solid var(--ink-3)",
                borderRadius: 4,
                padding: "2px 4px",
                color: "var(--bone-dim)",
                fontSize: 11,
              }}
              title="选择项目"
            >
              <option value="">选择项目…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <StatStrip
              items={[
                { label: "环节", value: works.length, title: "本项目的工作项数(GET /works)" },
                { label: "工件", value: artifacts.length, title: "本项目的工件数(GET /artifacts)" },
                {
                  label: "无环节",
                  value: unattachedCount,
                  title:
                    "workId 为 null 的工件数 —— 它们不由某条工作项产出,但**已经画在图上**" +
                    "(按 kind 落在自己那一行)。页面下方那一块只是**同一批工件的清单**(可逐条看详情)。",
                },
              ]}
            />
          </div>
        }
      />

      {scope === null ? (
        <EmptyState>先在「对话」页的左栏选一个项目,或在上面的选择器里挑一个。</EmptyState>
      ) : error !== null ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : (worksLoad.loading || artifactsLoad.loading) && nothingYet ? (
        <EmptyState>加载中…</EmptyState>
      ) : nothingYet ? (
        <EmptyState>
          这个项目还没有工作项,也没有工件。项目跑起来后,环节与工件会落在这里。
        </EmptyState>
      ) : (
        <ArtifactsScreen
          works={works}
          artifacts={artifacts}
          live={live}
          // 「此刻」= 渲染这一刻的本地时钟。**不额外起定时器**:`useProjectLive`
          // 每 2.5s 轮询一次,重渲染就会带来新的 now(见文件头「可测性」)。
          now={Date.now()}
          picked={picked}
          onPick={setPicked}
          openId={openId}
          onToggleDetail={(id) => setOpenId((cur) => (cur === id ? null : id))}
        />
      )}
    </div>
  );
}

// ── 工件详情(有状态:按 id 单独拉一次)──────────────────────────

/**
 * 工件详情。展开时按 id 拉一次 `GET /api/artifacts/:id`。
 *
 * `known` 只用来**顺手**把关联目标的标题显示出来(目标恰好在本次列表里时),
 * 不做二次请求 —— 目标不在列表里就只显示 id,不编一个标题出来。
 *
 * **详情单独拉一次,不拿列表里那条凑**:契约给了 `/:id` 这条端点,它的存在意义
 * 就是「列表里的字段可能不是全量」;用列表项假装详情,等于把那条端点变成死代码。
 */
function ArtifactDetail({ id, known }: { id: string; known: readonly ArtifactView[] }) {
  const [artifact, setArtifact] = useState<ArtifactView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setArtifact(null);
    setError(null);
    getArtifact(id)
      .then((r) => {
        if (cancelled) return;
        setArtifact(r.artifact);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const titleOf = (targetId: string): string | null =>
    known.find((k) => k.id === targetId)?.title ?? null;

  return (
    <div
      className="mt-2"
      style={{ borderTop: "1px solid var(--ink-3)", paddingTop: 6 }}
      title="GET /api/artifacts/:id"
    >
      {error !== null ? (
        <div className="text-xs" style={{ color: "var(--cinnabar)" }}>
          详情加载失败:{error}
        </div>
      ) : loading ? (
        <div className="ss-meta">详情加载中…</div>
      ) : artifact === null ? (
        <div className="ss-meta">读不到这条工件的详情。</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Pill tone={artifactKindTone(artifact.kind)} title={artifact.kind}>
              {artifactKindLabel(artifact.kind)}
            </Pill>
            <Pill tone={artifactStatusTone(artifact.status)} title={artifact.status}>
              {artifactStatusLabel(artifact.status)}
            </Pill>
            <span className="ss-body" style={{ color: "var(--bone)" }}>
              {artifact.title || "(无标题)"}
            </span>
            <span className="ss-meta ml-auto">
              {artifact.authorName || artifact.authorAgentId} · {fmtTime(artifact.createdAt)}
            </span>
          </div>

          {bodyMode(artifact) === "html_report" ? (
            <>
              <div className="ss-section" style={{ fontSize: 12 }}>
                报告
              </div>
              {/*
                正文由 HtmlReport **自己现读**(`GET /api/artifacts/:id/content`)
                —— 渲染仍走 `sandbox="" + srcDoc`(见那个文件的文件头:
                改成 `<iframe src=...>` 会让模型写的 HTML 与应用同源)。
              */}
              <HtmlReport
                artifactId={artifact.id}
                fileName={htmlReportFileName(artifact.title, artifact.id)}
              />
            </>
          ) : bodyMode(artifact) === "code_service" ? (
            // 坐标(主体)与 markdown 说明都由 CodeService 渲染 —— 它要把坐标
            // 摆在正文之前,所以不能复用下面那个只印 `<pre>` 的分支。
            <CodeService artifactId={artifact.id} service={artifact.codeService} />
          ) : (
            <TextArtifactBody artifactId={artifact.id} />
          )}

          <div>
            <div className="ss-section" style={{ fontSize: 12 }}>
              关联({artifact.links.length})
            </div>
            {artifact.links.length === 0 ? (
              <div className="ss-note">没有出边 —— 这条工件不挂在别的工件上。</div>
            ) : (
              <div className="flex flex-col">
                {artifact.links.map((l) => {
                  const t = titleOf(l.targetId);
                  return (
                    <KV
                      key={`${l.rel}:${l.targetId}`}
                      label={REL_LABEL[l.rel] ?? l.rel}
                      value={t ?? l.targetId}
                      title={t !== null ? l.targetId : "该目标不在本次列表里,只显示 id"}
                    />
                  );
                })}
              </div>
            )}
          </div>

          <Disclosure summary="原始字段">
            <div className="flex flex-col gap-0.5">
              <span>工件 id:{artifact.id}</span>
              <span>项目 id:{artifact.projectId}</span>
              <span>kind:{artifact.kind}</span>
              <span>status:{artifact.status}</span>
              <span>作者 id:{artifact.authorAgentId}</span>
              <span>作者名(authorName):{artifact.authorName}</span>
              <span>产出它的环节(workId):{artifact.workId ?? "null(不由工作项产出)"}</span>
              {/* 正文的**落点**,不是内容(2026-10-08):内容由上面的正文区现读。 */}
              <span>正文落点(bodyPath):{artifact.bodyPath}</span>
              <span>正文字节数(bodyBytes,写入时的快照):{artifact.bodyBytes}</span>
              <span>引入正文的提交(commitSha):{artifact.commitSha ?? "null(还没提交)"}</span>
              <span>
                交付物类型(deliverableType):
                {artifact.deliverableType ?? "null(非交付物,或存量未声明类型的交付物)"}
              </span>
              <span>创建:{fmtTime(artifact.createdAt)}</span>
              <span>更新:{fmtTime(artifact.updatedAt)}</span>
            </div>
          </Disclosure>
        </div>
      )}
    </div>
  );
}

// ── 普通工件的正文(现读)────────────────────────────────────────

/**
 * 普通工件的正文(`<pre>`)—— **现读** `GET /api/artifacts/:id/content`。
 *
 * ── 为什么不再从 `artifact.body` 读 ─────────────────────────────
 *
 * 2026-10-08 起正文住**项目仓里的一份文件**(设计 §4.2):工件视图只给落点
 * (`bodyPath` / `bodyBytes` / `commitSha`),正文要现读。所以 `body` 这个字段
 * 已经从 `ArtifactView` 上消失 —— 不是「改了个名字」。
 *
 * ── 三态必须分开 ────────────────────────────────────────────────
 *
 * `runtime: "unavailable"` 是**读不到**(文件被删 / 被回滚 / `at` 不可达),
 * 把它显示成「这条工件没有正文」就是把一次读失败说成「本来就没有」。
 * 读不到时印 `problem` 那一行,**不许**留空。
 */
function TextArtifactBody({ artifactId }: { artifactId: string }) {
  const { data, loading, error } = useArtifactContent(artifactId);

  if (error !== null) {
    return (
      <div className="ss-note" style={{ color: "var(--cinnabar)" }}>
        读不到正文:{error}
      </div>
    );
  }
  if (loading || data === null) return <div className="ss-meta">读取正文…</div>;
  if (data.runtime !== "ok") {
    return (
      <div
        className="ss-note"
        style={{ color: "var(--cinnabar)" }}
        data-content-runtime="unavailable"
      >
        **读不到**这份正文 —— {data.problem ?? "原因未说明"}。
        (这不是「这条工件没有正文」,是这一次读不到。落点:{data.path})
      </div>
    );
  }
  if (data.content.length === 0) {
    return <div className="ss-note">这条工件的正文是空的。</div>;
  }
  return (
    <>
      <div className="ss-section" style={{ fontSize: 12 }}>
        正文
      </div>
      {/* 索引漂移:一行提示(不是错误、不阻止阅读)—— 见 ContentDriftNote.tsx */}
      <ContentDriftNote drifted={data.drifted} />
      <pre
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: 12,
          lineHeight: 1.7,
          margin: 0,
          padding: "6px 8px",
          background: "var(--ink-1)",
          border: "1px solid var(--ink-3)",
          borderRadius: 6,
          color: "var(--bone-dim)",
          maxHeight: 420,
          overflow: "auto",
        }}
      >
        {data.content}
      </pre>
    </>
  );
}
