/**
 * provider 故障「全局刹车」(批次 31):连续遇到可重试的 provider 故障
 * (rate_limit / network / server)时,暂停自动派发一段时间 —— 而不是把
 * 「叫醒 3 次」的尝试预算烧光(45 秒内三次全打在同一个限流窗口里)。
 *
 * 三条纪律(与 AGENTS.md「provider 故障」一节同源):
 * - 刹车是**限流退避**,不是判据 —— 状态在进程内存里,重启即清
 *   (「无状态排空器」的纪律:判定永远重新查库,这里只是限流);
 * - 只有 **retryable** 的 kind 才刹车:quota / auth / unknown 不刹车、
 *   不重置预算 —— 那是账号/配置问题,烧预算 → 升级 → 业务经理向甲方
 *   交代是**正确**行为,等是等不好的;
 * - 退避序列 30s → 2min → 8min,封顶 8min;**episode 内 streak 不清零**
 *   (退避持续增长,防止「刹车 30s → 期满 → 立刻再打」的 30 秒循环),
 *   但「过了一段没有故障的时间之后再次失败」算新一段 episode(要播通知);
 * - 两个冷却常量**集中在这一个文件**(默认值在下面),可经
 *   `configureProviderBrake` 覆盖 —— 生产入口是 `ServeOptions` 的两个
 *   同名旋钮,测试用它把冷却调到几十毫秒观察「到期自动恢复」。
 */

import type { ProviderFailureKind } from "./providerFailure.js";

/** 第一档冷却:30 秒(限流窗口的常见长度;太短 = 白打,太长 = 白等)。 */
const DEFAULT_BASE_COOLDOWN_MS = 30_000;
/** 封顶:8 分钟。再长就该人来处理了(设置里换 provider),不是等的问题。 */
const DEFAULT_MAX_COOLDOWN_MS = 480_000;
/** 每多一次连续故障,冷却翻的倍数:30s → 2min → 8min(三档到顶)。 */
const BACKOFF_FACTOR = 4;

let baseCooldownMs = DEFAULT_BASE_COOLDOWN_MS;
let maxCooldownMs = DEFAULT_MAX_COOLDOWN_MS;

/** 冷却常量的覆盖值(缺的键保持现值)。非法值(非正数 / max < base)被忽略 ——
 *  刹车是限流,不是判据,坏参数不该把它变成「永不派发」或「从不退避」。 */
export interface ProviderBrakeOptions {
  readonly baseCooldownMs?: number;
  readonly maxCooldownMs?: number;
}

/**
 * 覆盖冷却常量(进程级,`createPlatformHost` 从 `ServeOptions` 接进来)。
 * 只在两个数都合法时才整组生效 —— 只改 base 不改 max 可能造出 base > max。
 */
export function configureProviderBrake(opts: ProviderBrakeOptions): void {
  const base = opts.baseCooldownMs;
  const max = opts.maxCooldownMs;
  const nextBase = base ?? baseCooldownMs;
  const nextMax = max ?? maxCooldownMs;
  if (
    !Number.isFinite(nextBase) || nextBase <= 0 ||
    !Number.isFinite(nextMax) || nextMax < nextBase
  ) {
    return;
  }
  baseCooldownMs = nextBase;
  maxCooldownMs = nextMax;
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
}

/**
 * 记一次 provider 故障。非可重试的 kind 不计数、不刹车 —— 返回原状态。
 */
export function noteProviderFailure(
  kind: ProviderFailureKind,
  now: number,
): ProviderBrakeNote {
  const previous: ProviderBrakeNote = {
    brakedUntilAt,
    episode: false,
    cooldownMs: 0,
  };
  if (!BRAKEABLE_KINDS.has(kind)) {
    return previous;
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
  return {
    brakedUntilAt,
    episode: !wasBraked,
    cooldownMs,
  };
}

/** 此刻是否在刹车期内(自动派发应暂停)。 */
export function isBraked(now: number): boolean {
  return now < brakedUntilAt;
}

/**
 * 任何一次**成功收尾**的 agent 回合 ⇒ 清零(调用点负责判「成功」:
 * 超时 / 中断 / 拒执行不算 —— 它们既不是 provider 故障,也不是成功)。
 * (provider 恢复了;下一次故障从 30s 重新退避,而不是接着上次的档位。)
 */
export function clear(): void {
  failureStreak = 0;
  brakedUntilAt = 0;
}

/** 测试专用:暴露内部状态(生产代码不要读它,判据只有 isBraked)。 */
export function brakeStateForTest(): { failureStreak: number; brakedUntilAt: number } {
  return { failureStreak, brakedUntilAt };
}
