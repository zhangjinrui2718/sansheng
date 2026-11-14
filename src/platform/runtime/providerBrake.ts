/**
 * provider 故障「全局刹车」(批次 31 建立短轴;2026-11-14 双轴化):连续遇到
 * provider 故障时,暂停自动派发一段时间 —— 而不是把「叫醒 3 次」的尝试预算
 * 烧光(45 秒内三次全打在同一个限流窗口里)。
 *
 * ── 两条轴(2026-11-14,用户裁决:「额度用完先停下来;恢复以后继续干活」)──
 *
 * - **短轴**(rate_limit / network / server):这些故障**自己会好**,退避序列
 *   30s → 2min → 8min 封顶 —— 太长的退避没有意义,窗口过了第一枪就通。
 * - **长轴**(quota):额度是**账户级**的,Token Plan 用量上限 / 积分耗尽这类
 *   故障在**计费周期或充值之后会恢复**(2026-11-13 之前的裁决「额度等不好」
 *   被这次用户表述推翻)。它不该把工作项记成 `failed`(终态没人再唤起),
 *   而该**停下来等恢复**。恢复的信号不靠猜时间:冷却到期后自动派发放行
 *   **一次探测回合**,通 ⇒ 清刹车、全部续跑;仍 429 ⇒ 连续故障计数 +1,
 *   冷却沿 30min → 2h → 8h → **24h 封顶**继续退避(探测本身零成本:
 *   立刻被 429 拒掉,不产生任何生成)。**鉴权(auth)不进长轴** —— key 填错
 *   不会自己好,那是配置问题,保持终态 + 业务经理交代。
 *
 * 三条纪律(与 AGENTS.md「provider 故障」一节同源):
 * - 刹车是**限流退避**,不是判据 —— 状态在进程内存里,重启即清
 *   (「无状态排空器」的纪律:判定永远重新查库,这里只是限流);
 * - **auth / unknown 不刹车**(任何一条轴都不):配置问题烧预算 → 升级 →
 *   业务经理向甲方交代是正确行为,等是等不好的;
 * - 每条轴 **episode 内 streak 不清零**(退避单调变长,防「到期立刻再打」的
 *   循环),「过了一段没有故障的时间之后再次失败」算新一段 episode(要播通知);
 * - 冷却常量**集中在这一个文件**,可经 `configureProviderBrake` 覆盖 ——
 *   生产入口是 `ServeOptions` 的四个同名旋钮,测试用它把冷却调到几十毫秒
 *   观察「到期自动恢复」。
 */

import type { ProviderFailureKind } from "./providerFailure.js";

// ── 短轴(限流 / 断网 / 5xx)──────────────────────────────────────

/** 第一档冷却:30 秒(限流窗口的常见长度;太短 = 白打,太长 = 白等)。 */
const DEFAULT_BASE_COOLDOWN_MS = 30_000;
/** 封顶:8 分钟。再长就该人来处理了(设置里换 provider),不是等的问题。 */
const DEFAULT_MAX_COOLDOWN_MS = 480_000;

// ── 长轴(额度)──────────────────────────────────────────────────
//
// 30 分钟起步:额度恢复的最小单位是「充值生效 / 用量窗口滚动」,分钟级探测
// 毫无意义;封顶 24 小时 = 计费周期按天滚动的常见粒度。4 倍退避:
// 30min → 2h → 8h → 24h(三档到顶)。
const DEFAULT_QUOTA_BASE_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_QUOTA_MAX_COOLDOWN_MS = 24 * 60 * 60_000;

/** 每多一次连续故障,冷却翻的倍数:30s → 2min → 8min(三档到顶)。 */
const BACKOFF_FACTOR = 4;

let baseCooldownMs = DEFAULT_BASE_COOLDOWN_MS;
let maxCooldownMs = DEFAULT_MAX_COOLDOWN_MS;
let quotaBaseCooldownMs = DEFAULT_QUOTA_BASE_COOLDOWN_MS;
let quotaMaxCooldownMs = DEFAULT_QUOTA_MAX_COOLDOWN_MS;

/** 冷却常量的覆盖值(缺的键保持现值)。非法值(非正数 / max < base)被忽略 ——
 *  刹车是限流,不是判据,坏参数不该把它变成「永不派发」或「从不退避」。 */
export interface ProviderBrakeOptions {
  readonly baseCooldownMs?: number;
  readonly maxCooldownMs?: number;
  readonly quotaBaseCooldownMs?: number;
  readonly quotaMaxCooldownMs?: number;
}

/**
 * 覆盖冷却常量(进程级,`createPlatformHost` 从 `ServeOptions` 接进来)。
 * 每条轴只在两个数都合法时才整组生效 —— 只改 base 不改 max 可能造出 base > max。
 */
export function configureProviderBrake(opts: ProviderBrakeOptions): void {
  const apply = (
    base: number | undefined,
    max: number | undefined,
    curBase: number,
    curMax: number,
  ): [number, number] | null => {
    const nextBase = base ?? curBase;
    const nextMax = max ?? curMax;
    if (
      !Number.isFinite(nextBase) || nextBase <= 0 ||
      !Number.isFinite(nextMax) || nextMax < nextBase
    ) {
      return null;
    }
    return [nextBase, nextMax];
  };
  const short = apply(opts.baseCooldownMs, opts.maxCooldownMs, baseCooldownMs, maxCooldownMs);
  const quota = apply(
    opts.quotaBaseCooldownMs, opts.quotaMaxCooldownMs, quotaBaseCooldownMs, quotaMaxCooldownMs,
  );
  if (short !== null) [baseCooldownMs, maxCooldownMs] = short;
  if (quota !== null) [quotaBaseCooldownMs, quotaMaxCooldownMs] = quota;
}

/** 视为可重试、值得退避的故障 kind(与 providerFailure.ts 的 retryable 同源)。 */
const BRAKEABLE_KINDS: ReadonlySet<ProviderFailureKind> = new Set([
  "rate_limit",
  "network",
  "server",
]);

/** 进程级状态:连续第几次可重试故障 + 刹车截止时刻(0 = 没在刹车)。 */
let failureStreak = 0;
let brakedUntilAt = 0;
/** 长轴(quota):同一形状,独立的计数与截止时刻。 */
let quotaFailureStreak = 0;
let quotaBrakedUntilAt = 0;

export interface ProviderBrakeNote {
  /** 刹车截止时刻(epoch ms)。没触发刹车时为当前值(0)。 */
  brakedUntilAt: number;
  /**
   * true = 这是**新一段**刹车的第一次失败(通知该播了);
   * false = 刹车期内再次失败/延长冷却(只记日志,不重播 ——「同一条只播一次」)。
   */
  episode: boolean;
  /** 本次生效的冷却时长(ms)。 */
  cooldownMs: number;
  /** 哪条轴生效(quota = 长轴;其余 = 短轴)。没触发刹车时为 null。 */
  axis: "short" | "quota" | null;
}

/**
 * 记一次 provider 故障。`auth` / `unknown` 不计数、不刹车 —— 返回原状态。
 * `quota` 进长轴;`rate_limit` / `network` / `server` 进短轴;两条轴相互独立。
 */
export function noteProviderFailure(
  kind: ProviderFailureKind,
  now: number,
): ProviderBrakeNote {
  const idle: ProviderBrakeNote = { brakedUntilAt: 0, episode: false, cooldownMs: 0, axis: null };
  if (kind === "quota") {
    const wasBraked = now < quotaBrakedUntilAt;
    quotaFailureStreak += 1;
    const cooldownMs = Math.min(
      quotaBaseCooldownMs * BACKOFF_FACTOR ** (quotaFailureStreak - 1),
      quotaMaxCooldownMs,
    );
    quotaBrakedUntilAt = now + cooldownMs;
    return { brakedUntilAt: quotaBrakedUntilAt, episode: !wasBraked, cooldownMs, axis: "quota" };
  }
  if (!BRAKEABLE_KINDS.has(kind)) {
    return idle;
  }
  // 判据:进函数那一刻是否已经在刹车窗内。在 ⇒ 同一段(episode 不重播);
  // 不在(含从未刹车/刹车已过期)⇒ 新一段,要播通知。
  const wasBraked = now < brakedUntilAt;
  failureStreak += 1;
  // episode 内 streak 只增不减 ⇒ 冷却单调变长 ⇒ now + cooldown 恒晚于旧截止,
  // 截止时刻只会被往后推(不会因为重复记同一窗口里的失败而缩短)。
  const cooldownMs = Math.min(
    baseCooldownMs * BACKOFF_FACTOR ** (failureStreak - 1),
    maxCooldownMs,
  );
  brakedUntilAt = now + cooldownMs;
  return { brakedUntilAt, episode: !wasBraked, cooldownMs, axis: "short" };
}

/** 此刻是否在刹车期内(任一条轴在 ⇒ 自动派发应暂停)。 */
export function isBraked(now: number): boolean {
  return now < brakedUntilAt || now < quotaBrakedUntilAt;
}

/**
 * 任何一次**成功收尾**的 agent 回合 ⇒ 两条轴一起清零(调用点负责判「成功」:
 * 超时 / 中断 / 拒执行不算 —— 它们既不是 provider 故障,也不是成功)。
 * (provider 恢复了;下一次故障各自从第一档重新退避,而不是接着上次的档位。)
 */
export function clear(): void {
  failureStreak = 0;
  brakedUntilAt = 0;
  quotaFailureStreak = 0;
  quotaBrakedUntilAt = 0;
}

/** 测试专用:暴露内部状态(生产代码不要读它,判据只有 isBraked)。 */
export function brakeStateForTest(): {
  failureStreak: number;
  brakedUntilAt: number;
  quotaFailureStreak: number;
  quotaBrakedUntilAt: number;
} {
  return { failureStreak, brakedUntilAt, quotaFailureStreak, quotaBrakedUntilAt };
}
