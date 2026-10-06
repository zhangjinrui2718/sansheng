/**
 * 推进图(时间轴 × 泳道)布局 —— 纯函数,无 DOM、无请求
 *
 * ── 为什么换掉分层 DAG(用户的原话)──────────────────────────────
 *
 * > 工件这个 dag 看看有没有开源组件可以用的,现在都缠在一起了,另外我觉得好一点的
 * > 展示是:横轴是时间,纵轴是工件的类型,即使没在 dag 上的工件也可以放在这个图表里面了
 * > 可以想办法把工作项的完成和工件的产出也标在这个图表里面
 *
 * 「缠在一起」的根因不是手写 SVG,是**分层 DAG 的边交叉**:节点要按依赖关系排位置,
 * 于是边必然互相穿。时间轴上没有这个问题 —— **x 是时间的函数**,位置不需要解,
 * 结构上不可能缠。所以这一版把「位置」这件事从「解一个图」降级成「一次线性映射」。
 *
 * ── 图表的三层语义(每条都对应一句用户要的话)────────────────────
 *
 *   ① **横轴 = 距项目最早事件的耗时**(线性刻度 + 自适应步长,刻度写 `T+0` / `T+18m`);
 *   ② **纵轴 = 泳道**:上半区**一条工作项一道**(工作项 4 条 ⇒ 4 道),下半区
 *      **一种工件 kind 一道**(数据里有几种就几道,**空 kind 不占道**);
 *   ③ **标记**:
 *      · 工作项 = 一条**跨度条**(创建 → 收口),条头/条尾各一个端点:
 *        终态 ⇒ 实心端点(**收口**),未终态 ⇒ 开口端 + 「此刻」线;
 *      · 工件 = 一个**点**,按时间落在**它那个 kind 的那一道**上 ——
 *        **不看它有没有环节**:决策 / 会议 / 变更 / 甲方问答(`workId === null`)
 *        一样有自己的一道(这正是用户要的「没在 dag 上的工件也放进来」);
 *      · 「工作项产出了什么」= 条上的**里程碑刻度**:该工作项的工件在**它自己
 *        那一道**的条上打一个小刻度 —— 于是「完成」与「产出」在**同一行**上读得出来,
 *        而且**不画任何一条边**(边才是缠的来源)。
 *
 * ── 四条不许说假话的纪律 ───────────────────────────────────────
 *
 *  1. **「最后一次变更」不叫「完成时刻」。** `works.updated_at` 会被
 *     `markWorkReviewed` 也碰一次(`repo/works.ts`),所以终态工作项的右端点是
 *     **最后一次变更**,不是精确完成时刻 —— 刻度文案照这个写,不编一个完成时刻
 *     出来。(要精确完成时刻得加列并写入,那是另一次显式改动;在加之前**不许**猜。)
 *  2. **未终态的工作项右端是「开口」的**,画到「此刻」并且**带标记说它还没收口** ——
 *     不能画成一条长度确定的条(那会被读成「这条做完了」)。
 *  3. **`runtime: "unavailable"` 时不许点亮任何东西**:`running` 一律 `false`,
 *     由 `unknown: true` 告诉页面「这一刻读不到」。
 *  4. **不丢任何一条数据**:每件工件恰好落在一个点上,每条工作项恰好一条跨度条;
 *     `total` 与输入长度对得上(页面据此显示计数)。
 */
import type {
  ArtifactKind, ArtifactStatus, ArtifactView, WorkStatus, WorkView,
} from "@shared/types/platform";

// ── 几何常量(布局与渲染共用,免得两边各写一份而漂)──────────────────

/**
 * 左侧泳道名的栏宽(px)。**176 是量出来的**:真机那五条工作项标题最长 22 字
 * (约 242px),栏太窄时即使有省略号也会把名字切一半 —— 第一版 148px 就是这样:
 * 右对齐的文字往左溢出到 `x < 0`,被 SVG 视口裁掉,渲染出来是「础打断模块方案设计」,
 * 读起来像一个错字。配 `clipLabel()` 一起用:栏宽定住,超长的名字截断、全文进 tooltip。
 */
export const TL_GUTTER = 176;
/** 绘图区宽度(px)。**固定值**:SSR 测试与「同一份数据两次渲染一致」都要它确定。 */
export const TL_PLOT_W = 900;
/** 顶部留白。 */
export const TL_PAD_TOP = 10;
/** 工作项泳道高度(px)—— 比工件道高,因为条上还要挂里程碑刻度。 */
export const TL_WORK_LANE_H = 28;
/** 工件 kind 泳道高度(px)。 */
export const TL_KIND_LANE_H = 22;
/** 同组内泳道间距(px)。 */
export const TL_LANE_GAP = 4;
/** 工作项组与工件组之间的分隔(px)。 */
export const TL_GROUP_GAP = 14;
/** 底部刻度行高度(px)。 */
export const TL_AXIS_H = 24;
/** 工件点半径(px)。 */
export const TL_DOT_R = 4.5;
/** 工作项跨度条的高度(px)。 */
export const TL_BAR_H = 10;
/**
 * 时间域的**最小跨度**(2 分钟)。
 *
 * ⚠️ 这个数改过一次(2026-10-06,看了真机渲染图才定):第一版是 **1 小时**,于是
 * 一个真实跨度 31 分钟的项目被硬撑成 1 小时 —— 图上左右各空掉四分之一,而「哪个
 * 先哪个后」的密度正是这张图要表达的东西。只有当跨度**小到横轴失去意义**(几乎
 * 同一秒,例如一件工件)时才需要撑开,那种场合 2 分钟足够了。
 */
export const TL_MIN_SPAN_MS = 2 * 60 * 1000;
/** 时间域两端各留的空白比例(点不会贴在边框上)。 */
export const TL_DOMAIN_PAD_RATIO = 0.04;

/**
 * 工件 kind 的展示顺序:结论类在前、过程类在后(与旧页面的 KIND_ORDER 同一个裁决)。
 * 表里没有的 kind 落在末尾(**不丢**:后端 kind 是闭合联合,但读面容错)。
 */
export const TL_KIND_ORDER: readonly ArtifactKind[] = [
  "decision",
  "project_brief",
  "work_brief",
  "deliverable",
  "evidence",
  "review_finding",
  "change_record",
  "meeting_note",
  "hypothesis",
  "client_question",
  "note",
];

export interface TimelineLane {
  /** `work:<workId>` | `kind:<kind>` */
  key: string;
  label: string;
  group: "work" | "kind";
  /** 自上而下 0 起(渲染层直接用它算 y) */
  index: number;
  y: number;
  height: number;
}

/** 一件工件在图上 = 一个点(它落在**自己 kind 的那一道**上)。 */
export interface TimelineMark {
  id: string;
  laneKey: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  title: string;
  authorName: string;
  createdAt: number;
  x: number;
  y: number;
  /** 产出它的工作项(**可能是 `null`**:决策 / 会议 / 变更 / 甲方问答) */
  workId: string | null;
  workTitle: string | null;
}

/** 一条工作项在图上 = 一条跨度条(+ 条上的产出刻度)。 */
export interface TimelineSpan {
  id: string;
  laneKey: string;
  title: string;
  status: WorkStatus;
  assigneeName: string;
  createdAt: number;
  /**
   * 右端点对应的时刻。终态 = `updatedAt`(**「最后一次变更」**,见文件头纪律①);
   * 未终态 = 「此刻」(**开口**,见纪律②)。
   */
  endedAt: number;
  /** 未终态 ⇒ `true`:页面据此画开口端而不是封口端点 */
  open: boolean;
  /** 此刻是否有回合在它身上跑(`runtime: "unavailable"` 时恒为 `false`) */
  running: boolean;
  /** 工作项读不到运行态(或库里的活没法确认「此刻」) */
  unknown: boolean;
  x1: number;
  x2: number;
  y: number;
  height: number;
  /** 这条工作项产出的工件(条上的里程碑刻度) */
  milestones: Array<{ id: string; kind: ArtifactKind; x: number }>;
}

export interface TimelineTick {
  at: number;
  x: number;
  label: string;
}

export interface TimelineLayout {
  lanes: TimelineLane[];
  marks: TimelineMark[];
  spans: TimelineSpan[];
  ticks: TimelineTick[];
  /** 绘图区几何(渲染层用它画边框 / 网格) */
  plot: { x0: number; x1: number; width: number; height: number };
  /** 时间域。`origin` = **未留白的起点**,即 T+0(与 `from` 差一段留白) */
  domain: { from: number; to: number; origin: number };
  /** 「此刻」线的 x;`null` = 读不到时间域里没有它 */
  nowX: number | null;
  /** 画布总高(含底部刻度行) */
  height: number;
  /** 输入里的工件数(页面计数直接用它 —— 与 `marks.length` 必须相等) */
  artifactCount: number;
}

export interface TimelineInput {
  readonly works: readonly WorkView[];
  readonly artifacts: readonly ArtifactView[];
  /** 页面这一刻的本地时钟 */
  readonly now: number;
  /**
   * 运行态(只读三件事;`null` = 还没拿到过快照 ⇒ 与 `unavailable` 一样**不点亮**)。
   * 形状故意收窄:`ProjectLiveView` 结构化地满足它,而测试能喂两行夹具。
   */
  readonly live: {
    readonly runtime: "host" | "unavailable";
    readonly agents: ReadonlyArray<{ readonly agentId: string; readonly turn: unknown | null }>;
  } | null;
}

/**
 * 一个字符串在屏幕上大约多宽(px)。**只用于把泳道名截到栏宽以内**。
 *
 * 用估算而不是测量:布局是纯函数(SSR / 测试里没有 DOM,`measureText` 不存在),
 * 而这里只需要「别溢出」这个量级的准确度。汉字按 11px、其余按 6.5px(11px 字号下
 * 的经验值,略偏保守 —— 宁可早一点截,也不要溢出被裁)。
 */
export function textWidthPx(text: string): number {
  let w = 0;
  for (const ch of text) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 11 : 6.5;
  return w;
}

/**
 * 把泳道名截到 `maxPx` 以内,超出加省略号。
 *
 * 为什么要它:泳道名是**右对齐**画在栏里的,超长会往左溢出到 `x < 0`,被 SVG 视口
 * 裁掉 —— 屏幕上剩下半截标题(真机第一版就渲染成「础打断模块方案设计」,连第一个字
 * 都没了,读起来像一个错字)。**截断发生在渲染层,全文进 `<title>`**(悬停仍看得到)。
 */
export function clipLabel(text: string, maxPx: number): string {
  if (textWidthPx(text) <= maxPx) return text;
  const ellipsisW = 6.5;
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = textWidthPx(ch);
    if (w + cw + ellipsisW > maxPx) break;
    out += ch;
    w += cw;
  }
  return out === "" ? "…" : `${out}…`;
}

/** 线性时间刻度:`x = plotX0 + (t - from) / span * plotW`。 */
function makeScale(from: number, to: number): (t: number) => number {
  const span = Math.max(1, to - from);
  return (t: number) => TL_GUTTER + ((t - from) / span) * TL_PLOT_W;
}

/** 候选步长(ms),从小到大。挑第一个「刻度数 ≤ 目标」的。 */
const TICK_STEPS: readonly number[] = [
  // 秒级在前:耗时轴上「30 分钟的域只有两根刻度」是可接受的,
  // 「2 分钟的域只有一根」不是 —— 补上这一段,`formatElapsed` 的 `T+30s` 才有读者。
  5_000, 10_000, 15_000, 30_000,
  60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
  60 * 60_000, 2 * 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000,
  24 * 60 * 60_000, 2 * 24 * 60 * 60_000, 7 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000,
];

/** 目标刻度数(含两端)。超过它横轴标签会互相压住 —— 这条是「可读性」的机器表达。 */
const TICK_TARGET = 8;
/**
 * 刻度数的**硬上界**。正常情况下 `span / step <= TICK_TARGET`,所以实际永远是 9 根;
 * 这个数只在输入非有限时兜住循环(见 `timelineTicks` 里那段注释)。
 * 取 200 而不是 8:它要能**装下**正常情况(9 根)又**拦得住**失控(几百 MB)。
 */
export const TICK_HARD_CAP = 200;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 刻度标签 = **距项目最早事件的耗时**,不是墙钟。
 *
 * 2026-10-06 用户原话:「x 轴不要用自然时间,用耗时吧」。真机那份数据的形状
 * 正是这么要求的:7 条子项的 `created_at` 全是 08:40:35、`updated_at` 全是
 * 08:54:25 —— 墙钟轴上它们**长度完全相同**,什么差异都读不出来;而甲方在
 * 14:08 回的那次答复把工件域从 18 分钟撑到 **326 分钟**,于是真正有活动的
 * 14 分钟只占 **4.3%** 的宽度。
 *
 * ⚠️ **如实记下它没有解决什么**:刻度换成人读格式,**不改变域的跨度**,
 * 所以那 4.3% 的占宽照旧(这是用户在被告知之后选的读法)。真正消掉它要
 * 「每条泳道各自从 0 起算」—— 那会让跨泳道的绝对先后不再靠 x 读,
 * 是一次独立的取舍,不在本次范围里。改回去只需换回 `formatTick`。
 *
 * 格式:`T+0` / `T+18m` / `T+2h05m` / `T+3d04h`。**不带日期前缀** ——
 * 耗时本身已经跨天了,再缀一个 `10-06` 是噪音。
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  // 零点是一个**原点标记**,不是时长读数 —— 写 `T+0` 而不是 `T+0s`
  // (工程记法里 `T+0` 才是起点,`T+0s` 读起来像「零秒的时长」)。
  if (total === 0) return "T+0";
  if (total < 60) return `T+${total}s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) return `T+${mins}m`;
  const hours = Math.floor(mins / 60);
  const restMin = mins % 60;
  if (hours < 24) return `T+${hours}h${pad2(restMin)}m`;
  const days = Math.floor(hours / 24);
  return `T+${days}d${pad2(hours % 24)}h`;
}

/**
 * 刻度。**从域起点起每 `step` 一个**,标签是 `T+<耗时>`。
 *
 * ⚠️ 起点是 `origin`(域的**未留白**起点,见 `timelineDomain` 的 pad),不是画布左沿
 * —— 左沿是留白之后的边界,拿它当 T+0 会让「T+0」指向一个没有事件的地方。
 * 刻度不再对齐墙钟整点:耗时轴上「整点」没有意义,而对齐会把第一个刻度推到
 * 域内很深的位置,左边留一段没有刻度的空白。
 */
export function timelineTicks(origin: number, from: number, to: number): TimelineTick[] {
  // ⚠️ **三参数的分工是硬约定**,写错任何一个都只表现为「刻度错位」而不报错:
  //   - `origin`:**T+0 所在的那一刻**(最早的真实事件),决定刻度从哪起、标签是多少;
  //   - `from` / `to`:**布局那条比例尺**的两端(留白之后),决定 x 画在哪。
  // 上一版只给了 `origin` + 一个可选的 `scaleTo`,于是「零点自己算 x」——
  // 那让 T+0 落在画布左沿而不是它该在的位置(域有留白时差一整段),
  // 而类型是对的、刻度只是静默地偏了。所以这里**要求**三份都传进来。
  const span = Math.max(1, to - from);
  const step = TICK_STEPS.find((s) => span / s <= TICK_TARGET) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const scale = makeScale(from, to);
  const ticks: TimelineTick[] = [];
  // ⚠️ **循环有硬上界,而且这个上界不是装饰。** 上一版是 `for(;;) + if (t > to) break`,
  // 于是任何一个非有限的 `to`(NaN / Infinity,来自一个坏掉的夹具或一次算错的域)
  // 都让 `t > to` 恒为假 —— 数组一直涨,进程 OOM。
  // 症状与「测试卡住」完全一样,病因却在数据里:**边界必须由计数兜住,不能只靠比较。**
  for (let i = 0; i < TICK_HARD_CAP; i += 1) {
    const t = origin + i * step;
    if (!(t <= to)) break; // `!(t <= to)` 而不是 `t > to`:NaN 两种写法都成立吗?不 —— 这里要的是
    ticks.push({ at: t, x: scale(t), label: formatElapsed(t - origin) });
  }
  return ticks;
}

/**
 * 时间域:覆盖**所有**时间戳(工作项创建 / 最后一次变更、工件创建),并在有回合在跑
 * 时把「此刻」也算进去(否则正在跑的那条会画到画布外)。
 *
 * 两处兜底(都不许让页面崩或画出一条零宽的轴):
 *   - 跨度小于 `TL_MIN_SPAN_MS` ⇒ 以域中心撑到最小跨度(只有一件工件的项目);
 *   - 两端留 `TL_DOMAIN_PAD_RATIO` 的空白(点不贴边框)。
 */
export function timelineDomain(
  input: TimelineInput,
): { from: number; to: number; origin: number } {
  const stamps: number[] = [];
  for (const w of input.works) {
    stamps.push(w.createdAt, w.updatedAt);
  }
  for (const a of input.artifacts) {
    stamps.push(a.createdAt, a.updatedAt);
  }
  const running = hasRunningTurn(input);
  if (running) stamps.push(input.now, input.now + 1);
  if (stamps.length === 0) {
    // 空项目:给一个「以此刻为中心」的窗口,免得除零
    const mid = input.now;
    return {
      from: mid - TL_MIN_SPAN_MS / 2, to: mid + TL_MIN_SPAN_MS / 2, origin: mid,
    };
  }
  const earliest = Math.min(...stamps);
  const latest = Math.max(...stamps);
  // ⚠️ **T+0 = 最早的那次真实事件,而不是任何留白之后的位置。**
  // 这里就是上一版的洞:先把域撑到 `TL_MIN_SPAN_MS` 再取起点,于是「只有 1 分钟
  // 活动」的项目零点落在**活动开始之前 30 秒**的空处 —— 一条轴上最不该骗人的
  // 就是零点。所以 `origin` 在任何撑开/留白**之前**就钉住。
  const origin = earliest;
  let from = earliest;
  let to = latest;
  if (to - from < TL_MIN_SPAN_MS) {
    const mid = (from + to) / 2;
    from = mid - TL_MIN_SPAN_MS / 2;
    to = mid + TL_MIN_SPAN_MS / 2;
  }
  const pad = Math.round((to - from) * TL_DOMAIN_PAD_RATIO);
  return { from: from - pad, to: to + pad, origin };
}

/** 这个项目此刻有没有回合在跑(`live` 读不到 ⇒ 没有 —— 见文件头纪律③)。 */
function hasRunningTurn(input: TimelineInput): boolean {
  return input.live !== null && input.live.runtime === "host" && input.live.agents.some((a) => a.turn !== null);
}

/**
 * 装配整张图。
 *
 * ⚠️ **车道只按「数据里真的有」来开**:一种工件 kind 在这一版里一件都没有 ⇒ 那道不出现
 * (空道会把图拉长而信息量为零);页面若要知道「契约里的 kind 有哪些没出现」,
 * 那由 `tl` 之外的词表去讲,不由空道讲。
 */
export function layoutTimeline(input: TimelineInput): TimelineLayout {
  const { from, to, origin } = timelineDomain(input);
  const x = makeScale(from, to);
  const scaleFor = (t: number): number =>
    Math.max(TL_GUTTER, Math.min(TL_GUTTER + TL_PLOT_W, x(t)));

  // ── 泳道:上区 = 工作项(按创建时间,再按 id),下区 = 出现过的 kind(按 TL_KIND_ORDER)
  const workOrder = [...input.works].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const presentKinds = new Set(input.artifacts.map((a) => a.kind));
  const kinds = TL_KIND_ORDER.filter((k) => presentKinds.has(k));
  // 契约里新增 kind 而这里没列进顺序表时,**原样补在末尾**(不丢那种工件)
  for (const k of presentKinds) if (!kinds.includes(k)) kinds.push(k);

  const lanes: TimelineLane[] = [];
  let y = TL_PAD_TOP;
  workOrder.forEach((w, i) => {
    lanes.push({ key: `work:${w.id}`, label: w.title || w.id, group: "work", index: i, y, height: TL_WORK_LANE_H });
    y += TL_WORK_LANE_H + TL_LANE_GAP;
  });
  // 两区之间留一条缝(工作项区 / 工件 kind 区),只在两区都非空时留
  if (workOrder.length > 0 && kinds.length > 0) y += TL_GROUP_GAP - TL_LANE_GAP;
  kinds.forEach((k, i) => {
    lanes.push({
      key: `kind:${k}`,
      label: k,
      group: "kind",
      index: workOrder.length + i,
      y,
      height: TL_KIND_LANE_H,
    });
    y += TL_KIND_LANE_H + TL_LANE_GAP;
  });
  const laneBottom = lanes.length > 0 ? y - TL_LANE_GAP : TL_PAD_TOP;
  const plotHeight = Math.max(1, laneBottom - TL_PAD_TOP);
  const laneByKey = new Map(lanes.map((l) => [l.key, l]));

  // ── 工件 → 点(每条恰好一个;`workId` 只影响提示,不影响它在哪一道)
  const workById = new Map(input.works.map((w) => [w.id, w]));
  const marks: TimelineMark[] = input.artifacts.map((a) => {
    const lane = laneByKey.get(`kind:${a.kind}`);
    const cy = (lane?.y ?? TL_PAD_TOP) + (lane?.height ?? TL_KIND_LANE_H) / 2;
    const work = a.workId !== null ? workById.get(a.workId) ?? null : null;
    return {
      id: a.id,
      laneKey: `kind:${a.kind}`,
      kind: a.kind,
      status: a.status,
      title: a.title,
      authorName: a.authorName,
      createdAt: a.createdAt,
      x: scaleFor(a.createdAt),
      y: cy,
      workId: a.workId,
      // 环节读不到时**不编标题**(与 `workGraph` 的 `dangling` 同一条纪律)
      workTitle: work?.title ?? null,
    };
  });

  // ── 工作项 → 跨度条(+ 它自己那一道上的产出刻度)
  const liveOk = input.live !== null && input.live.runtime === "host";
  const runningAgents = new Set(
    liveOk ? (input.live?.agents ?? []).filter((a) => a.turn !== null).map((a) => a.agentId) : [],
  );
  const spans: TimelineSpan[] = workOrder.map((w) => {
    const lane = laneByKey.get(`work:${w.id}`);
    const terminal = w.status === "done" || w.status === "failed" || w.status === "cancelled";
    const endAt = terminal ? w.updatedAt : input.now;
    const mine = marks.filter((m) => m.workId === w.id);
    return {
      id: w.id,
      laneKey: `work:${w.id}`,
      title: w.title || w.id,
      status: w.status,
      assigneeName: w.assigneeName,
      createdAt: w.createdAt,
      endedAt: endAt,
      open: !terminal,
      running: liveOk && runningAgents.has(w.assigneeAgentId) && !terminal,
      unknown: !liveOk,
      x1: scaleFor(w.createdAt),
      x2: Math.max(scaleFor(w.createdAt) + 2, scaleFor(endAt)),
      y: (lane?.y ?? TL_PAD_TOP) + TL_WORK_LANE_H / 2 - TL_BAR_H / 2,
      height: TL_BAR_H,
      milestones: mine
        .sort((p, q) => p.createdAt - q.createdAt)
        .map((m) => ({ id: m.id, kind: m.kind, x: m.x })),
    };
  });

  return {
    lanes,
    marks,
    spans,
    ticks: timelineTicks(origin, from, to),
    plot: { x0: TL_GUTTER, x1: TL_GUTTER + TL_PLOT_W, width: TL_PLOT_W, height: plotHeight },
    domain: { from, to, origin },
    // 「此刻」线只在**读得到运行态且它落在域内**时画 —— 一个凭空出现的竖线会被
    // 读成「有事情正在发生」
    nowX: liveOk && input.now >= from && input.now <= to ? scaleFor(input.now) : null,
    height: laneBottom + TL_AXIS_H,
    artifactCount: input.artifacts.length,
  };
}

/**
 * 一条工件 / 工作项的时间读法(页面与测试共用,免得两处各写一份格式)。
 *
 * `absolute` 为真给「10-05 17:23」,否则给「17:23」。
 */
export function formatClock(at: number, absolute = false): string {
  const d = new Date(at);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return absolute ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}` : hm;
}
