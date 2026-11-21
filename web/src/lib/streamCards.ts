/**
 * 「表态卡进流」的判据层(v5,2026-11-20)—— 纯函数,不 import React。
 *
 * ── 裁决变更记录 ────────────────────────────────────────────────
 *
 * **2026-11-20 用户裁决**:待答 / 验收 / 收口提议 / 计划确认四类「等你表态」的事
 * 全部进**对话流**,以卡的形式渲染;右侧收件箱(`ChatRightRail` + `Inbox`)与
 * 头部计划 band 退场。这**取代**了 `PlanConfirmCard.tsx:6-13` 的旧推理
 * (「提问是状态不是消息 —— 插进消息流意味着答完之后要从历史里删一条」)。
 *
 * 新形态怎么解掉旧顾虑:卡**锚定在它发生的时刻**(提问的 createdAt、交付的
 * deliveredAt、拆解的产生时刻),它不是插一条消息,而是流里一个**带时刻坐标的
 * 事实点**;完结之后**原地塌缩成一行事实**(「已答复」「已接受」「已确认开工」),
 * 不删除、也不再冒充待办。历史没有被改写 —— 这正是旧推理要保护的东西。
 *
 * ── 判据 ──────────────────────────────────────────────────────
 *
 * 1. **主对话线限定**:表态是**项目级**状态,卡只在 `kind='main'` 的线渲染
 *    (交付线是交付物的容器,不是表态的地方 —— 2026-10-07 纪律沿用);
 *    接待会话(`projectId === null`)没有项目,没有表态,一张卡都没有。
 * 2. **锚定**:question = `createdAt`;acceptance = `deliveredAt`;
 *    verdict = 裁决落库时刻;answered = `answeredAt`;plan = 最新一条未确认
 *    工作项的 `createdAt`;plan-confirmed = 批次确认时刻(`confirmedAt` 相同的
 *    一批算一次确认事件)。同一时刻并列时**轮在前、卡在后**(稳定排序,插入序)。
 * 3. **塌缩**:已答复提问按 `consumedAt` 分两态(整理中 / 已落 decision 工件);
 *    裁决带附言;计划确认带条数。塌缩行不再可操作。
 * 4. **诚实边界**:
 *    - 加载中 ⇒ 一张卡都没有,但也**不渲染任何「暂无待表态」**(空态文案在流里
 *      退场 —— 流的空态只有「真的没有消息」那一件事,由 `MessageList` 的 Empty 判);
 *    - 读失败 ⇒ 卡照旧不渲染,但 `cardsUnavailableOf` 给出一行「读不到」,
 *      由调用方挂在流尾(折叠不静默,与 `HiddenNotice` 同一格);
 *    - 已收口项目的提问**只数不渲染**(兑现不了 —— 2026-10-07 纪律逐字继承;
 *      计数落点仍是项目页「待你回答」);
 *    - `unconfirmedCount > 0` 但工作项清单**一行都不在手**时**不出计划卡**
 *      (锚点还没有,不编一个);重取期间旧行在手 ⇒ 照常出卡,不闪。
 */
import type { Turn } from "@/stores/chat";
import type {
  AwaitingAcceptanceView,
  AnsweredClientQuestionView,
  ClientQuestionView,
  RecentDeliveryVerdictView,
  WorkView,
} from "@shared/types/platform";
import { scopeClientQuestions } from "./questionScope";

/** 流里的一张表态卡。`at` 是它在流里的锚定时刻(epoch ms)。 */
export type StreamCard =
  | { kind: "question"; at: number; q: ClientQuestionView }
  | { kind: "answered"; at: number; id: string; question: string; consumed: boolean }
  | { kind: "acceptance"; at: number; a: AwaitingAcceptanceView }
  | {
      kind: "verdict";
      at: number;
      artifactId: string;
      title: string;
      verdict: "accept" | "reject";
      note: string | null;
    }
  | { kind: "plan"; at: number }
  | { kind: "plan-confirmed"; at: number; count: number };

/** 归并后的一个流条目:一轮甲方通道的消息,或一张表态卡。 */
export type StreamItem =
  | { kind: "turn"; at: number; turn: Turn }
  | { kind: "card"; at: number; card: StreamCard };

/** `streamCardsOf` 的输入 —— 全部来自 `ChatSurface` 持有的那几份取数实例。 */
export interface StreamCardsInput {
  /** `null` = 接待会话 ⇒ 恒为空(接待没有项目,没有表态)。 */
  projectId: string | null;
  /** 当前选中的线是不是主对话(kind='main')。表态是项目级状态,只渲染在主对话线。 */
  isMainSession: boolean;
  detail: {
    detail: { awaitingAcceptance: AwaitingAcceptanceView[]; recentDeliveryVerdicts: RecentDeliveryVerdictView[] } | null;
    loading: boolean;
    error: string | null;
  };
  questions: {
    /** 全局待答(open 工件)—— 经 `scopeClientQuestions` 按项目筛(唯一读者判据) */
    data: readonly ClientQuestionView[];
    /** 收口项目那批(带坐标)—— 只数不渲染;传进来是为了过同一道筛,不许 map 成卡 */
    closedProjectQuestions: readonly ClientQuestionView[];
    /** 已答复行(v5 读面)—— 塌缩事实来源 */
    answered: readonly AnsweredClientQuestionView[];
    loading: boolean;
    error: string | null;
  };
  works: {
    data: readonly WorkView[];
    loading: boolean;
    error: string | null;
  };
  /** 服务端算好的「未确认工作项」计数(计划卡的总开关判据)。 */
  unconfirmedCount: number;
}

/** 计划卡的批次判据:同一毫秒确认的一批算一次「已确认开工」事件(confirmWorks 一次写一批)。 */
function confirmedBatchesOf(works: readonly WorkView[]): Array<{ at: number; count: number }> {
  const byAt = new Map<number, number>();
  for (const w of works) {
    // `confirmedAt` 类型可选是给存量夹具的(与 reviewState 同一条先例);undefined 按 null 解释。
    if (w.confirmedAt == null) continue;
    byAt.set(w.confirmedAt, (byAt.get(w.confirmedAt) ?? 0) + 1);
  }
  return [...byAt.entries()]
    .map(([at, count]) => ({ at, count }))
    .sort((a, b) => a.at - b.at);
}

/** 把几份取数实例变成流里的卡(纯函数;顺序 = 锚定时刻升序,由 mergeStream 最终排序)。 */
export function streamCardsOf(input: StreamCardsInput): StreamCard[] {
  // 接待会话:没有项目就没有表态,一张卡都没有(不是「加载中」)。
  if (input.projectId === null) return [];
  // 非主对话线:表态是项目级状态,只渲染在主对话线(文件头判据 1)。
  if (!input.isMainSession) return [];

  const cards: StreamCard[] = [];
  const pid = input.projectId;

  // 待验收(还没裁决的)—— 锚在交付时刻。
  for (const a of input.detail.detail?.awaitingAcceptance ?? []) {
    cards.push({ kind: "acceptance", at: a.deliveredAt, a });
  }
  // 已裁决的(塌缩事实)—— 锚在裁决落库时刻。
  for (const v of input.detail.detail?.recentDeliveryVerdicts ?? []) {
    cards.push({
      kind: "verdict",
      at: v.at,
      artifactId: v.artifactId,
      title: v.title,
      verdict: v.verdict,
      note: v.note,
    });
  }
  // 待答(open 工件)—— 收口提议与普通提问同一种卡(渲染层按 intent 分叉),
  // 锚在提问时刻。**筛只有一道**:`scopeClientQuestions`(2026-10-12 显示作用域
  // 判据的唯一落点,收件箱退场后它的读者迁到这里)—— 它同时保证已收口项目的
  // 提问进不了 `items`(只数不渲染),这里不需要再判项目状态。
  for (const q of scopeClientQuestions(
    input.questions.data,
    input.questions.closedProjectQuestions,
    pid,
  ).items) {
    cards.push({ kind: "question", at: q.createdAt, q });
  }
  // 已答复的(塌缩事实)—— 锚在答复时刻,consumed 区分两态。
  for (const row of input.questions.answered) {
    if (row.projectId !== pid) continue;
    cards.push({
      kind: "answered",
      at: row.answeredAt,
      id: row.id,
      question: row.question,
      consumed: row.consumedAt !== null,
    });
  }
  // 计划(未确认开工)—— 开关判据是服务端计数;锚 = 最新一条未确认工作项的产生时刻。
  // ⚠️ 判的是「行在不在手」,不是「在不在取」:useLoad 重取期间保留旧数据,
  // 按 loading 拦会让这张卡在每次 WS revision bump 时闪没(变异自检抓出来的)。
  // 首载还没有任何行 ⇒ 不出卡(锚点还没有,不编一个 —— 文件头判据 4)。
  if (input.unconfirmedCount > 0) {
    const pending = input.works.data.filter(
      (w) =>
        w.confirmedAt == null &&
        (w.status === "open" || w.status === "in_progress" || w.status === "blocked"),
    );
    if (pending.length > 0) {
      const at = Math.max(...pending.map((w) => w.createdAt));
      cards.push({ kind: "plan", at });
    }
  }
  // 已确认开工的批次(塌缩事实)—— 每个批次时刻一行,`confirmedAt` 相同算一批。
  for (const batch of confirmedBatchesOf(input.works.data)) {
    cards.push({ kind: "plan-confirmed", at: batch.at, count: batch.count });
  }
  return cards.sort((a, b) => a.at - b.at);
}

/**
 * 归并:甲方通道的轮 + 表态卡 ⇒ 一条按锚定时刻排序的流。
 *
 * ⚠️ **稳定排序**:同一时刻并列时轮在前(先 push 轮)—— 消息先说,表态跟着发生,
 * 这个次序在并列时是更自然的读法,且**确定性**比选哪边更重要。
 * ⚠️ 进行中的轮(`streaming`)**不进这条归并** —— 它们锚在「此刻」,由渲染层
 * 按现状接在历史之后(与既有行为一致),卡不插队。
 */
export function mergeStream(
  turns: ReadonlyArray<{ turn: Turn }>,
  cards: readonly StreamCard[],
): StreamItem[] {
  const items: StreamItem[] = [];
  for (const { turn } of turns) items.push({ kind: "turn", at: turn.startedAt, turn });
  for (const card of cards) items.push({ kind: "card", at: card.at, card });
  items.sort((a, b) => a.at - b.at);
  return items;
}

/**
 * 流的 React key(稳定的,不随排序变化):同类同实体共享 key 会让 React 复用
 * 错 DOM;verdict 按 (artifact, 时刻) 区分 —— 同一交付物的两次裁决是两行事实。
 */
export function streamCardKey(card: StreamCard): string {
  switch (card.kind) {
    case "question":
      return `q:${card.q.id}`;
    case "answered":
      return `ans:${card.id}`;
    case "acceptance":
      return `acc:${card.a.artifactId}`;
    case "verdict":
      return `vd:${card.artifactId}:${card.at}`;
    case "plan":
      return "plan";
    case "plan-confirmed":
      return `plan-ok:${card.at}`;
  }
}

/**
 * 「表态清单读不到」的那一行(折叠不静默):详情或提问清单**读失败**时给出,
 * 调用方挂在流尾(与 `HiddenNotice` 同一格)。加载中是 `null` —— 还没查到的东西
 * 不许说「读不到」,那与「渲染成没有」是同一种假话的另一个方向。
 */
export function cardsUnavailableOf(input: {
  projectId: string | null;
  detailError: string | null;
  questionsError: string | null;
}): string | null {
  if (input.projectId === null) return null;
  const parts: string[] = [];
  if (input.detailError !== null) parts.push("项目详情");
  if (input.questionsError !== null) parts.push("提问台账");
  if (parts.length === 0) return null;
  return `表态清单读不到(${parts.join(" · ")})—— 稍后自动重试`;
}
