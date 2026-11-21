/**
 * 「表态」的判据层(V2,2026-11-21)—— 纯函数,不 import React。
 *
 * ── 裁决变更记录 ────────────────────────────────────────────────
 *
 * **v5(2026-11-20)**:四类表态卡全部按锚定时刻长进消息流。它的病:卡随对话
 * 滚动**漂移**,可发现性不稳定 —— 一屏历史刷过去,「在等你」的事就沉底了。
 *
 * **V2(2026-11-21,设计书 §4.1)**:未完结表态 → **行动区**(钉在输入区上方,
 * 位置恒定;零待办整区消失);完结表态 → 仍在流里**原地塌缩成一行事实**
 * (v5 的塌缩判据逐字继承 —— 历史不被改写,这正是它要保护的东西)。
 *
 * ⚠️ 两者同源:同一份取数实例算出,不会因为拆开而出现「一处写加载中、
 * 另一处写没有」的假话。
 *
 * ── 判据(诚实边界,逐条继承 v5)────────────────────────────────
 *
 * 1. **主对话线限定**:表态是项目级状态,只属于 `kind='main'` 的线;
 *    接待会话没有项目,一项都没有。
 * 2. **锚定不编造**:行动项与事实行都锚在真实时刻(createdAt/deliveredAt/
 *    裁决时刻/批次 confirmedAt);清单一行不在手 ⇒ 不出项(锚点还没有,
 *    不编一个);重取期间旧行在手 ⇒ 照常出项,不闪。
 * 3. **塌缩两态**:已答复按 `consumedAt` 分「整理中 / 已落 decision 工件」;
 *    裁决带附言;计划确认按批次(`confirmedAt` 相同的一批算一次)。
 * 4. **读不到 ≠ 没有**:读失败 ⇒ `cardsUnavailableOf` 给出一行「读不到」
 *    (行动区常驻显示,折叠不静默);加载中 ⇒ 既不出项也不说读不到。
 * 5. 已收口项目的提问**只数不渲染**(scopeClientQuestions 同一道筛)。
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

/**
 * 行动区的行动项 —— 四个「等你动作」状态点(设计书 §1.2 的动线心脏)。
 * `at` 是锚定时刻(排序用:最早等你的事在最上)。
 */
export type ActionItem =
  | { type: "confirm"; at: number; count: number }
  | { type: "question"; at: number; q: ClientQuestionView }
  | { type: "close"; at: number; q: ClientQuestionView }
  | { type: "acceptance"; at: number; a: AwaitingAcceptanceView };

/** 流里的塌缩事实行(不可操作,留在发生时刻)。 */
export type StreamFact =
  | { kind: "answered"; at: number; id: string; question: string; consumed: boolean }
  | {
      kind: "verdict";
      at: number;
      artifactId: string;
      title: string;
      verdict: "accept" | "reject";
      note: string | null;
    }
  | { kind: "plan-confirmed"; at: number; count: number };

/** 归并后的一个流条目:一轮甲方通道的消息,或一行塌缩事实。 */
export type StreamItem =
  | { kind: "turn"; at: number; turn: Turn }
  | { kind: "fact"; at: number; fact: StreamFact };

/** 两份判据共用的输入 —— 全部来自 `ChatSurface` 持有的那几份取数实例。 */
export interface StreamCardsInput {
  /** `null` = 接待会话 ⇒ 恒为空(接待没有项目,没有表态)。 */
  projectId: string | null;
  /** 当前选中的线是不是主对话(kind='main')。 */
  isMainSession: boolean;
  detail: {
    detail: { awaitingAcceptance: AwaitingAcceptanceView[]; recentDeliveryVerdicts: RecentDeliveryVerdictView[] } | null;
    loading: boolean;
    error: string | null;
  };
  questions: {
    data: readonly ClientQuestionView[];
    closedProjectQuestions: readonly ClientQuestionView[];
    answered: readonly AnsweredClientQuestionView[];
    loading: boolean;
    error: string | null;
  };
  works: {
    data: readonly WorkView[];
    loading: boolean;
    error: string | null;
  };
  /** 服务端算好的「未确认工作项」计数(① 的总开关判据)。 */
  unconfirmedCount: number;
}

/** 计划确认的批次判据:同一毫秒确认的一批算一次事件(confirmWorks 一次写一批)。 */
function confirmedBatchesOf(works: readonly WorkView[]): Array<{ at: number; count: number }> {
  const byAt = new Map<number, number>();
  for (const w of works) {
    if (w.confirmedAt == null) continue;
    byAt.set(w.confirmedAt, (byAt.get(w.confirmedAt) ?? 0) + 1);
  }
  return [...byAt.entries()]
    .map(([at, count]) => ({ at, count }))
    .sort((a, b) => a.at - b.at);
}

/** 行动区:未完结的表态(四状态点)。渲染层复用既有卡身做展开表单,这里只出判据。 */
export function actionItemsOf(input: StreamCardsInput): ActionItem[] {
  if (input.projectId === null) return [];
  if (!input.isMainSession) return [];

  const items: ActionItem[] = [];
  const pid = input.projectId;

  // ③ 待验收 —— 锚在交付时刻。每件交付物一行。
  for (const a of input.detail.detail?.awaitingAcceptance ?? []) {
    items.push({ type: "acceptance", at: a.deliveredAt, a });
  }
  // ②④ 待答 —— intent="close" 是④收口(固定二选一),否则是②答问;
  // 同一道筛(scopeClientQuestions):已收口项目的提问只数不渲染。
  for (const q of scopeClientQuestions(
    input.questions.data,
    input.questions.closedProjectQuestions,
    pid,
  ).items) {
    items.push(
      q.intent === "close"
        ? { type: "close", at: q.createdAt, q }
        : { type: "question", at: q.createdAt, q },
    );
  }
  // ① 确认开工 —— 开关判据是服务端计数;锚 = 最新一条未确认工作项的产生时刻。
  // ⚠️ 判「行在不在手」而不是「在不在取」(v5 变异自检的教训:按 loading 拦会闪)。
  if (input.unconfirmedCount > 0) {
    const pending = input.works.data.filter(
      (w) =>
        w.confirmedAt == null &&
        (w.status === "open" || w.status === "in_progress" || w.status === "blocked"),
    );
    if (pending.length > 0) {
      items.push({ type: "confirm", at: Math.max(...pending.map((w) => w.createdAt)), count: pending.length });
    }
  }
  return items.sort((a, b) => a.at - b.at);
}

/** 流里的塌缩事实行(完结表态;判据逐字继承 v5 的塌缩半边)。 */
export function streamFactsOf(input: StreamCardsInput): StreamFact[] {
  if (input.projectId === null) return [];
  if (!input.isMainSession) return [];

  const pid = input.projectId;
  const facts: StreamFact[] = [];

  for (const v of input.detail.detail?.recentDeliveryVerdicts ?? []) {
    facts.push({
      kind: "verdict",
      at: v.at,
      artifactId: v.artifactId,
      title: v.title,
      verdict: v.verdict,
      note: v.note,
    });
  }
  for (const row of input.questions.answered) {
    if (row.projectId !== pid) continue;
    facts.push({
      kind: "answered",
      at: row.answeredAt,
      id: row.id,
      question: row.question,
      consumed: row.consumedAt !== null,
    });
  }
  for (const batch of confirmedBatchesOf(input.works.data)) {
    facts.push({ kind: "plan-confirmed", at: batch.at, count: batch.count });
  }
  return facts.sort((a, b) => a.at - b.at);
}

/**
 * 归并:甲方通道的轮 + 塌缩事实 ⇒ 一条按锚定时刻排序的流。
 * ⚠️ 稳定排序:同一时刻并列时轮在前(先 push 轮)。
 * ⚠️ 进行中的轮(streaming)不进这条归并 —— 由渲染层按现状接在历史之后。
 */
export function mergeStream(
  turns: ReadonlyArray<{ turn: Turn }>,
  facts: readonly StreamFact[],
): StreamItem[] {
  const items: StreamItem[] = [];
  for (const { turn } of turns) items.push({ kind: "turn", at: turn.startedAt, turn });
  for (const fact of facts) items.push({ kind: "fact", at: fact.at, fact });
  items.sort((a, b) => a.at - b.at);
  return items;
}

/** 流条目的 React key(verdict 按 (artifact, 时刻) 区分:两次裁决是两行事实)。 */
export function streamFactKey(fact: StreamFact): string {
  switch (fact.kind) {
    case "answered":
      return `ans:${fact.id}`;
    case "verdict":
      return `vd:${fact.artifactId}:${fact.at}`;
    case "plan-confirmed":
      return `plan-ok:${fact.at}`;
  }
}

/** 行动项的 React key。 */
export function actionItemKey(item: ActionItem): string {
  switch (item.type) {
    case "confirm":
      return "plan";
    case "question":
    case "close":
      return `q:${item.q.id}`;
    case "acceptance":
      return `acc:${item.a.artifactId}`;
  }
}

/**
 * 「表态清单读不到」的那一行(折叠不静默):详情或提问清单**读失败**时给出,
 * 行动区常驻显示。加载中是 `null` —— 还没查到的东西不许说「读不到」。
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
