/**
 * `dashboard.ts` —— 项目页的**仪表盘**判据:「现在最要紧的一件事」
 *
 * ── 它治的是什么病 ────────────────────────────────────────────────
 *
 * 改版前的项目页是**一叠清单**:工作项、提问、变更、阻塞,每段一份,
 * 读者要自己在四段里比出「哪件最要紧」。
 *
 * ⇒ 于是**「最要紧」变成了读者的活**。而那恰恰是**平台该给**的答案 ——
 * 平台手里有全部结构化事实(哪些阻塞是高危的、哪些问题在等甲方、
 * 哪些交付物还没验收),却把它们摊平成四个数字。
 *
 * ⚠️ **「最要紧」是**排序**,不是**评价** —— 判据全部来自库里读到的状态,
 * 一条也不来自模型、也不来自「我觉得」。而且**顺序写死在一处**,
 * 想改只改这一张表(§7 里「项目页最要紧一件事怎么排」是留给甲方的题,
 * 排序规则落在这个文件的 `PRIORITY` 里 —— 换规则 = 改一处 + 一条测试)。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 *
 * 1. **读不到 ≠ 没事** —— 运行态读不到时,第一档就是「读不到」,
 *    **不是**「此刻没有待办」。这与 `ProjectLiveView.runtime = "unavailable"`
 *    与 `DataState` 的四态同源。
 * 2. **每一档都要有地址** —— 「最要紧的那件事」必须**能点过去**;
 *    跳不过去的那句话只是一句提醒。
 * 3. **没有待办就说没有** —— 但**不许**编一件出来充数
 *    (「一切顺利」不是待办,「没有需要你动作的事」才是事实)。
 */
import type { AppLocation } from "./route";
import { blockerLocation, projectLocation, workLocation } from "./entityMeta";
import type { BlockerView, ProjectLiveView, WorkView } from "@shared/types/platform";

/**
 * 仪表盘读到的事实。
 *
 * ⚠️ **每一份都带自己的加载态** —— 与关系栏同一条纪律:
 * 「还没查到」与「查过了是 0」在屏幕上长得一模一样,
 * 而把一次读失败说成「没有待办」是**自信的假话**。
 */
export interface DashboardFacts {
  /** 这些事实属于**哪个项目** —— 阻塞的地址要靠它(见 `entityMeta.blockerLocation`)。 */
  projectId?: string | null;
  /** 本项目的工作项(用于数「在跑 / 停了 / 坏了」)。 */
  works: { data: readonly WorkView[]; loading: boolean; error: string | null };
  /** 本项目的阻塞(用于数「高危未解决」)。 */
  blockers: { data: readonly BlockerView[]; loading: boolean; error: string | null };
  /** 等甲方答的问题数。 */
  pendingQuestions: { count: number; loading: boolean; error: string | null };
  /** 已交付、还没验收的交付物数。 */
  pendingAcceptance: { count: number; loading: boolean; error: string | null };
  /** 此刻的运行态;`null` = 读不到(不是「空闲」)。 */
  live: ProjectLiveView | null;
  /** 读运行态本身的状态(区分「读不到」与「没在跑」)。 */
  liveState: { loading: boolean; error: string | null };
}

/** 一件事。 */
export interface NextThing {
  /** 稳定的档位 id(渲染与测试都按它认,不按文案)。 */
  key: string;
  /** 一句话:最要紧的那件事是什么。 */
  label: string;
  /** 判据 —— 为什么是它(一句话,能追到事实)。 */
  why: string;
  /** 去哪儿。`null` = 没有该去的地方(真的没有待办)。 */
  to: AppLocation | null;
  /** 这一档**要不要用户动作**(不用时明确写「不需要你动作」)。 */
  action: string;
}

const OPEN_BLOCKER_STATES = new Set(["open", "acknowledged"]);
/** 高危:甲方要能据此重新决策(与 `report_downstream` 的越窗判据同源)。 */
const HIGH_SEVERITY = new Set(["high", "critical"]);
/** 没在推进的:失败 / 阻塞 —— 两种都需要人看一眼。 */
const STALLED_WORK = new Set(["failed", "blocked"]);

/**
 * 档位顺序 —— **刻意的**,每一条都有理由:
 *
 * 1. `unreadable` —— 运行态读不到。**排第一**是因为「不知道」比「知道有麻烦」更危险:
 *    读不到时若说「没待办」,用户会以为一切正常。
 * 2. `high_blocker` —— 高危阻塞未解决。它**影响时间表**,甲方要能据此重新决策。
 * 3. `waiting_client` —— 等甲方答。球在**甲方**那边 ⇒ 平台自己动不了 ⇒ 只有甲方能动。
 * 4. `waiting_acceptance` —— 等甲方验收。同上,球在甲方那边。
 * 5. `stalled_work` —— 有工作项停了(失败/阻塞)。平台会自己重划范围
 *    (`recover_failed_work`),所以这一档**不急**,排在甲方的事之后。
 * 6. `running` —— 正在跑。**不需要用户动作** —— 但仍要说出来,
 *    因为「没在跑」与「在跑」是两种完全不同的画面。
 * 7. `none` —— 此刻没有等你动作的事。
 */
export const PRIORITY = [
  "next_unreadable",
  "next_high_blocker",
  "next_waiting_client",
  "next_waiting_acceptance",
  "next_stalled_work",
  "next_running",
  "next_none",
] as const;

export type NextThingKey = (typeof PRIORITY)[number];

export function nextThing(facts: DashboardFacts): NextThing {
  // ① 读不到运行态 ⇒ 先说「读不到」,不许说「没待办」。
  if (facts.live === null || facts.live.runtime === "unavailable") {
    return {
      key: "next_unreadable",
      label: "运行态读不到",
      why: "GET /api/projects/:id/live 没拿到(或这个进程没接上运行期快照)—— 读不到不等于没事",
      to: null,
      action: "不需要你动作 —— 刷新页面再看一次",
    };
  }

  // ② 高危阻塞未解决。
  const high = facts.blockers.data.filter(
    (b) => OPEN_BLOCKER_STATES.has(b.status) && HIGH_SEVERITY.has(b.severity),
  );
  if (high.length > 0) {
    return {
      key: "next_high_blocker",
      label: `有 ${high.length} 条高危阻塞没解决`,
      why: `阻塞状态是 open/acknowledged 且严重度是 high/critical(${high[0]?.title ?? ""})`,
      // ⚠️ 地址带项目 id —— 阻塞只存在于某一个项目里(见 `entityMeta.blockerLocation`)。
      to: blockerLocation(high[0]?.id ?? "", facts.projectId),
      action: "要你动作 —— 它影响时间表",
    };
  }

  // ③ 等甲方答。
  if (facts.pendingQuestions.count > 0) {
    return {
      key: "next_waiting_client",
      label: `有 ${facts.pendingQuestions.count} 个问题等你答`,
      why: "client_questions 里 consumed_at 为空的那些 —— 球在你那边,平台自己动不了",
      to: { route: "chat", params: {} },
      action: "要你动作 —— 对话页右下角「待答」",
    };
  }

  // ④ 等甲方验收。
  if (facts.pendingAcceptance.count > 0) {
    return {
      key: "next_waiting_acceptance",
      label: `有 ${facts.pendingAcceptance.count} 份交付物等你验收`,
      why: "已交付(project_sessions.deliverable_artifact_id 非空)、还没有裁决的那些",
      to: { route: "chat", params: {} },
      action: "要你动作 —— 对话页右栏「待你验收」",
    };
  }

  // ⑤ 有工作项停了。
  const stalled = facts.works.data.filter((w) => STALLED_WORK.has(w.status));
  if (stalled.length > 0) {
    return {
      key: "next_stalled_work",
      label: `有 ${stalled.length} 条工作项停了`,
      why: `状态是 failed/blocked(${stalled[0]?.title ?? ""})—— 平台会自己重划范围`,
      to: workLocation(stalled[0]?.id ?? ""),
      action: "暂时不需要你动作 —— 平台会重新划范围",
    };
  }

  // ⑥ 正在跑。
  const running = facts.live.runningTurns;
  if (running > 0) {
    return {
      key: "next_running",
      label: `有 ${running} 个回合正在跑`,
      why: "GET /api/projects/:id/live 的 runningTurns",
      to: { route: "works", params: {} },
      action: "不需要你动作",
    };
  }

  // ⑦ 真的没有。
  return {
    key: "next_none",
    label: "此刻没有等你动作的事",
    why: "没有高危阻塞 · 没有等你答的问题 · 没有等你验收的交付物 · 没有停下的工作项",
    to: null,
    action: "不需要你动作",
  };
}

/**
 * 仪表盘上的**计数卡**(每张卡点了有地方去)。
 *
 * ⚠️ **计数不许自己算** —— 一律从 `detail.counts` 读(那是服务端算好的真值);
 * 自己数一遍会与左栏的徽标漂开,而**两个地方显示不同的数字**是最难查的一类病。
 */
export interface CountCard {
  key: string;
  label: string;
  value: number | null;
  /** 点了去哪儿;`null` = 不可点(没有该去的地方)。 */
  to: AppLocation | null;
  /** 这一格的判据(真 `title=`,不是悬停正文)。 */
  title: string;
}

export interface CountCardFacts {
  works: number;
  openWorks: number;
  artifacts: number;
  pendingQuestions: number;
  openBlockers: number;
  pendingAcceptance: number;
  /** 待质检的产出数(没读面就给 null ⇒ 那一格显示「读不到」)。 */
  pendingReviews?: number | null;
}

export function countCards(facts: CountCardFacts, projectId: string | null): CountCard[] {
  return [
    {
      key: "works",
      label: "工作项",
      value: facts.works,
      to: { route: "works", params: {} },
      title: "本项目的工作项总数(详情里的 works)—— 点了去工作项页看图与推进",
    },
    {
      key: "openWorks",
      label: "没做完",
      value: facts.openWorks,
      to: { route: "works", params: {} },
      title: "非终态的工作项数(open / in_progress / blocked)",
    },
    {
      key: "artifacts",
      label: "工件",
      value: facts.artifacts,
      to: { route: "works", params: {} },
      title: "本项目的工件数 —— 工件现在住在工作项页",
    },
    {
      key: "blockers",
      label: "阻塞",
      value: facts.openBlockers,
      to: projectLocation(projectId),
      title: "还没解决的阻塞数 —— 阻塞只存在于这一个项目里,所以地址带着项目 id",
    },
    {
      key: "questions",
      label: "待答",
      value: facts.pendingQuestions,
      to: { route: "chat", params: {} },
      title: "等甲方回答的问题数",
    },
    {
      key: "acceptance",
      label: "待验收",
      value: facts.pendingAcceptance,
      to: { route: "chat", params: {} },
      title: "已交付、还没有裁决的交付物数",
    },
  ];
}
