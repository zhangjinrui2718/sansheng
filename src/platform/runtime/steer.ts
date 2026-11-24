/**
 * 补话(2026-11-25)· 判据 —— 甲方在业务经理**正在回答**时说的话,
 * 补进当前这一轮,而不是排到下一轮。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────
 *
 * 此前(036)忙时只能排队:业务经理跑一个长回合时,甲方说「等一下,需求改了」
 * 要等它把旧需求做完、下一轮才被听到。回合越长(看门狗放开了 10 分钟总时长之后
 * 尤其如此),这句话就白等越久。
 *
 * SDK 的 `AgentSession.steer()` 做的正是这件事:排在当前这批工具调用跑完之后、
 * 下一次调模型之前送进去。multica 的同款机制(`pkg/agent/pi_supplement.go`)
 * 点出了一个坑:**排队成功不是送达回执** —— steer 可能和回合结束赛跑,
 * 留在队列里等下一次运行。所以这里把结果分成三格处理(见下「账怎么记」)。
 *
 * ── 规则(与 AGENTS.md「补话」一节同一条)───────────────────────
 *
 *   · 只对**甲方触发**的业务经理回合生效,且这句话必须发在**那条回合所在的线**上
 *     (主对话);发在别的线上、或对方在跑内部任务 ⇒ 照旧排队(036 的行为不变);
 *   · 每轮最多补 {@link MAX_STEERS_PER_TURN} 句,超出的排队;
 *   · **账怎么记**(`queued_client_messages`,at-least-once):
 *       看到**送达回执**(那条用户消息真的开始了、且正文逐字相等)**并且**这一轮
 *       成功结束** ⇒ 才销账;没看到回执 / 这一轮失败 ⇒ 账行留着,由下一轮的
 *       `answer_client_message` 带上,同时丢掉 SDK 里残留的那半句(否则说两遍)。
 *
 * 本文件只有**纯函数**,接线在 `host/serve.ts`。
 */

/** 一轮最多补几句 —— 防甲方(或脚本)在一轮里无限插话,把回合拖成没完没了。 */
export const MAX_STEERS_PER_TURN = 3;

/** 一次补话尝试的结果。`ok: false` 的五种都退回排队(036 的行为)。 */
export type SteerAttempt =
  | { readonly ok: true }
  /** 这一轮已经补满了 */
  | { readonly ok: false; readonly reason: "cap" }
  /** 在跑的不是甲方触发的回合,或发在别的线上 */
  | { readonly ok: false; readonly reason: "not-steerable"; readonly detail: string }
  /** 会话还没有(建会话那几秒)或端口没有 steer */
  | { readonly ok: false; readonly reason: "unavailable" }
  /** SDK 说「已被某个输入处理器消费」—— 没有回执会来,不能当送达 */
  | { readonly ok: false; readonly reason: "handled" }
  /** `steer()` 自己抛错了 */
  | { readonly ok: false; readonly reason: "error"; readonly detail: string };

/** 受阻的那一格(上面去掉成功的那一支)。 */
export type SteerBlocked = Exclude<SteerAttempt, { readonly ok: true }>;

/** 受阻原因的一行说明(宿主写日志用;没有细节就只有原因码)。 */
export function describeSteerBlocked(b: SteerBlocked): string {
  switch (b.reason) {
    case "not-steerable":
    case "error":
      return `${b.reason}:${b.detail}`;
    default:
      return b.reason;
  }
}

/**
 * 回执要对上的**目标文本**:补进去的那句话,在 SDK 排队之后**实际**排进去的文本。
 *
 * 为什么不直接用甲方原话:`steer()` 会先展开 `/技能名` 与提示词模板,送进模型的
 * 文本可能与原话不同 —— 逐字比对就必须比 SDK 排进去的那一份。SDK 在排队时广播
 * `queue_update`(整份队列快照),所以:
 *
 *   · 与上一份快照相比**新增**的条目里有一份与原话逐字相同的 ⇒ 就是它;
 *   · 没有逐字相同的(被展开过)⇒ 取**最后一条新增**(SDK 紧接着就答复,
 *     最新加进去的那条就是这一次的 —— multica `pi_supplement.go:49-63` 同款);
 *   · 还没看到任何新增 ⇒ 先按原话认(回执可能先到)。
 */
export function steerTargetOf(
  prevSteering: readonly string[],
  nextSteering: readonly string[],
  steeredText: string,
): string {
  const remaining = new Map<string, number>();
  for (const t of prevSteering) remaining.set(t, (remaining.get(t) ?? 0) + 1);
  const added: string[] = [];
  for (const t of nextSteering) {
    const n = remaining.get(t) ?? 0;
    if (n > 0) remaining.set(t, n - 1);
    else added.push(t);
  }
  if (added.includes(steeredText)) return steeredText;
  return added.length > 0 ? added[added.length - 1]! : steeredText;
}

/** 送达回执的判据:一条用户消息**开始了**,且正文与目标逐字相等。 */
export function isSteerReceipt(deliveredText: string, target: string): boolean {
  return deliveredText === target;
}

/**
 * 这句话能不能补进在跑的那一轮 —— 判据只有这一处。
 * 返回 `null` = 可以补;否则返回受阻的那一格(宿主据此退回排队,并把原因写进日志)。
 *
 * ⚠️ 次数上限在这里只是**粗筛**:两条消息挨着到时都可能通过它,精确的计数在
 * 那一轮自己的 `steer` 里同步递增(见 `host/serve.ts`)。
 *
 * @param entry 在飞登记表里那个回合的登记(`null` = 那条线上没有在跑的回合)
 * @param line  这句话发在哪条线上;`runningLine` = 那条回合所在的线
 */
export function steerBlocker(input: {
  entry: {
    readonly trigger: TurnTriggerLike | null;
    /** 这一轮已经补了几句 */
    steered: () => number;
  } | null;
  line: string | undefined;
  runningLine: string | null;
  hasSteer: boolean;
}): SteerBlocked | null {
  if (input.runningLine === null) return { ok: false, reason: "unavailable" };
  if (input.entry === null) return { ok: false, reason: "unavailable" };
  // 只有**甲方触发**的那一轮能补:对方在跑内部任务(汇报 / 整合 / 带回排队的话)
  // 时,插进去的话会混进一件跟它无关的活里。
  if (input.entry.trigger?.kind !== "user") {
    return { ok: false, reason: "not-steerable", detail: "在跑的不是甲方触发的回合" };
  }
  // 未指定线 = 主对话;那条回合就在主对话上(`handleUserMessage` 固定传 undefined)。
  if ((input.line ?? input.runningLine) !== input.runningLine) {
    return { ok: false, reason: "not-steerable", detail: "这句话发在另一条对话线上" };
  }
  if (!input.hasSteer) return { ok: false, reason: "unavailable" };
  if (input.entry.steered() >= MAX_STEERS_PER_TURN) return { ok: false, reason: "cap" };
  return null;
}

interface TurnTriggerLike {
  readonly kind: "user" | "todo";
}
