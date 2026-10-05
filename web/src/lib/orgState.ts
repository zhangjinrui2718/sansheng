/**
 * 「组织运行态」的**状态派生**(纯函数)。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 项目页那张卡原先只是把 `session_messages` 里 `kind='system'` 的行原样摊开 ——
 * 于是一条「已经自动接回」的停止告警与一条「永远不会自愈」的停止告警**长得一模一样**,
 * 用户只能问「这个到底解没解决?」。这两类事实的状态**都在库里/运行态里查得出来**,
 * 所以这里把它们派生出来,而不是编一句「已处理」。
 *
 * ── 两类记录的状态语义**完全不同**(这是本文件最重要的一条)──────
 *
 *   - **停止推进**:运行态**快照**。它会不会自己过去,取决于「此刻还有没有可执行的
 *     待办」—— 兜底定时器每 10 秒重查一次(`GET /live` 的 `dispatch.intervalMs`)。
 *     所以它的状态是**派生**的,不是写死的。
 *   - **合规告警**:既成事实的**记录**(那个回合确实没留工作记录)。它**没有**「已解决」
 *     这个状态,也**不该有** —— 平台不替模型补那行 `[未播报]`,补出来的「已解决」
 *     是编造现场(7-N)。它能被表达的只有:这是记录、不是待办;能降频的只有机制。
 *
 * ⚠️ 判据全部来自**现成的两个读面**:`GET /api/projects/:id/live`(「此刻」的唯一读面)
 * 与 `GET /api/projects/:id/messages`。**不加表、不加写面、不改迁移。**
 */
import type { ProjectLiveView, SessionMessageView } from "@shared/types/platform";
import { collectPlatformNotices, type PlatformNotice } from "./platformNotices";

/**
 * 一条停止推进的**状态档**。`label` 给人看,`why` 是判据(仓库纪律:屏幕上每个判断
 * 都要能追到事实),`action` 答「要不要我动手」。
 */
export type StopStateKey =
  /** 已经在接着跑(此刻有回合在跑 / 正在排空 / 这条之后又落了回合) */
  | "resumed"
  /** 还没接上,但**会被接上**:兜底定时器每 10 秒重查一次,而队里还有可执行待办 */
  | "will_resume"
  /** 卡在等甲方:流水线停下来的原因是「有问题等你答」 */
  | "waiting_client"
  /** **不会自愈**:待办的尝试预算用尽,平台不再叫醒它们 —— 这一档才真的要人看 */
  | "stalled"
  /** 已收口:那一刻之后没有可执行的活了(未终态工作项 0) */
  | "done"
  /** 运行态读不到(`GET /live` 没拿到)—— **不许**渲染成上面任何一档 */
  | "unreadable";

export interface StopState {
  readonly key: StopStateKey;
  readonly label: string;
  /** 为什么判成这一档(一句话,能追到事实) */
  readonly why: string;
  /** 要不要用户动作 —— 不需要时明确写「不需要你动作」 */
  readonly action: string;
}

export interface StopStateInput {
  readonly createdAt: number;
  /** 「此刻」的运行态;`null` = 读不到(还不算「空闲」) */
  readonly live: ProjectLiveView | null;
  /** 这条记录**之后**落库的回合数(assistant 消息条数)—— 「已接回」的直接证据 */
  readonly turnsAfter: number;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** 库里的可执行待办总数(`collectTodos().runnable`,排空器自己的判据)。 */
function runnableTodos(live: ProjectLiveView): number {
  return live.agents.reduce((n, a) => n + a.todos.length, 0);
}

/** 预算用尽、平台**不再叫醒**的待办总数。 */
function exhaustedTodos(live: ProjectLiveView): number {
  return live.agents.reduce((n, a) => n + a.exhaustedTodos, 0);
}

/**
 * 一条停止记录此刻是**哪一档**。判据顺序是刻意的:先判「读得到吗」,再判「在跑吗」,
 * 最后才落到「会不会自愈」—— 每一档都只要一条事实,不做推测。
 */
export function stopState(input: StopStateInput): StopState {
  const { live, turnsAfter } = input;
  if (live === null) {
    return {
      key: "unreadable",
      label: "读不到运行态",
      why: "这一条是那一刻的记录;此刻有没有在跑读不到(GET /api/projects/:id/live 没拿到)",
      action: "不需要你动作 —— 刷新页面再看一次;读不到不等于空闲",
    };
  }
  const running = live.runningTurns;
  if (running > 0 || live.dispatch.draining) {
    return {
      key: "resumed",
      label: "正在接回",
      why:
        `此刻${running > 0 ? `有 ${running} 个回合在跑` : "正在排空"}` +
        (turnsAfter > 0 ? `;这条之后已经落了 ${turnsAfter} 个回合` : ""),
      action: "不需要你动作",
    };
  }
  if (turnsAfter > 0) {
    return {
      key: "resumed",
      label: "已接回",
      why: `这条之后又有 ${turnsAfter} 个回合落库`,
      action: "不需要你动作",
    };
  }
  // ⚠️ 顺序:**有可执行待办 ⇒ 会被接回**,排在「等你」之前。
  // 两者同时成立时(既有待办、又欠着甲方一个回答),平台仍会把待办跑掉 ——
  // 那时说「在等你」是不准确的,让人以为不答就不动。
  const pending = runnableTodos(live);
  if (pending > 0) {
    return {
      key: "will_resume",
      label: "会被接回",
      why:
        `还有 ${pending} 条可执行待办;兜底每 ${seconds(live.dispatch.intervalMs)} 重查一次` +
        (live.dispatch.lastRunAgeMs !== null
          ? `(上次 ${seconds(live.dispatch.lastRunAgeMs)} 前)`
          : "(本进程还没触发过)"),
      action: "不需要你动作",
    };
  }
  if (live.pendingQuestions > 0) {
    return {
      key: "waiting_client",
      label: "在等你",
      why:
        `此刻没有可执行待办,但有 ${live.pendingQuestions} 个问题等你回答` +
        " —— 它们是流水线停下来的原因",
      action: "到「待办」页回答",
    };
  }
  const exhausted = exhaustedTodos(live);
  if (exhausted > 0) {
    return {
      key: "stalled",
      label: "不会自愈",
      why: `${exhausted} 条待办的尝试预算用尽 —— 平台不再叫醒它们`,
      action: "要你看:到「待办」页看卡住的是哪几条(通常是某个前置一直没动)",
    };
  }
  if (live.openWorks === 0) {
    return {
      key: "done",
      label: "已收口",
      why: "此刻未终态工作项 0,可执行待办 0 —— 那一刻之后没有新的活",
      action: "不需要你动作",
    };
  }
  return {
    key: "stalled",
    label: "停着且没有下一步",
    why: `还有 ${live.openWorks} 个未终态工作项,但可执行待办为空(前置没满足,或都派给了不能执行的角色)`,
    action: "要你看:到「工作项」页看这些工作项在等什么",
  };
}

/**
 * 「此刻」那一行摘要 —— 与状态档同源,给卡片顶部一句话用。
 *
 * ⚠️ `live === null` 时必须**明写读不到**:把它渲染成「空闲」是这个项目已经修过一次的
 * 那类谎(见 `ProjectLiveView.runtime` 的注释)。
 */
export function liveHeadline(live: ProjectLiveView | null): string {
  if (live === null) return "此刻运行态读不到(读不到 ≠ 空闲)";
  const pending = runnableTodos(live);
  const exhausted = exhaustedTodos(live);
  return [
    `此刻:${live.runningTurns} 个回合在跑`,
    `未终态工作项 ${live.openWorks}`,
    `可执行待办 ${pending} 条`,
    ...(exhausted > 0 ? [`预算用尽 ${exhausted} 条`] : []),
    ...(live.pendingQuestions > 0 ? [`等你回答 ${live.pendingQuestions} 条`] : []),
    `兜底每 ${seconds(live.dispatch.intervalMs)}${
      live.dispatch.lastRunAgeMs !== null ? `(上次 ${seconds(live.dispatch.lastRunAgeMs)} 前)` : ""
    }`,
  ].join(" · ");
}

/** 需要用户动手的那几档(卡片据此决定要不要给提示色)。 */
export function needsAttention(state: StopState): boolean {
  return state.key === "stalled" || state.key === "waiting_client";
}

export interface OrgRuntime {
  /** 停止推进:新的在前,每条带派生出来的状态 */
  readonly stops: readonly { readonly notice: PlatformNotice; readonly state: StopState }[];
  /** 合规告警:**记录**,不派生状态 */
  readonly compliance: readonly PlatformNotice[];
  /** 停止推进里需要用户动作的条数(0 = 不需要他做任何事) */
  readonly attention: number;
  /** 其他平台通知(认不出类别的),同样只报事实 */
  readonly others: readonly PlatformNotice[];
}

/**
 * 把 `GET /messages` 里的平台通知 + `GET /live` 的此刻事实,合成项目页要的两组。
 *
 * `turnsAfter` 用 `kind === "assistant"` 的**会话消息**数 —— 它比 `turn_usage` 更适合
 * 这里:usage 只记有 token 的回合,而「有没有接上」问的是「有没有动作」。
 */
export function orgRuntime(input: {
  readonly messages: readonly Pick<SessionMessageView, "id" | "kind" | "content" | "createdAt">[];
  readonly live: ProjectLiveView | null;
}): OrgRuntime {
  const notices = collectPlatformNotices(input.messages);
  const turns = input.messages.filter((m) => m.kind === "assistant");
  const stops = notices.stops.map((notice) => ({
    notice,
    state: stopState({
      createdAt: notice.createdAt,
      live: input.live,
      turnsAfter: turns.filter((t) => t.createdAt > notice.createdAt).length,
    }),
  }));
  return {
    stops,
    compliance: notices.compliance,
    attention: stops.filter((s) => needsAttention(s.state)).length,
    // 认不出类别的那些**照原样留着**并带出去(页面只在真的有时才渲染那一段)——
    // 分类失手退化成「其他」,而不是让一条记录静默消失。
    others: notices.all.filter((n) => n.kind === "other"),
  };
}
