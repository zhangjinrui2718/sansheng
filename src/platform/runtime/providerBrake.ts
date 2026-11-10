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
 * - 退避序列 30s → 60s → 120s → … 封顶 600s;**episode 内 streak 不清零**
 *   (退避持续增长,防止「刹车 30s → 期满 → 立刻再打」的 30 秒循环),
 *   但「过了一段没有故障的时间之后再次失败」算新一段 episode(要播通知)。
 */

import type { ProviderFailureKind } from "./providerFailure.js";

const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 600_000;

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
    BASE_COOLDOWN_MS * 2 ** (failureStreak - 1),
    MAX_COOLDOWN_MS,
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
 * 任何一次没有 provider 故障的回合成功收尾 ⇒ 清零。
 * (provider 恢复了;下一次故障从 30s 重新退避。)
 */
export function clear(): void {
  failureStreak = 0;
  brakedUntilAt = 0;
}

/** 测试专用:暴露内部状态(生产代码不要读它,判据只有 isBraked)。 */
export function brakeStateForTest(): { failureStreak: number; brakedUntilAt: number } {
  return { failureStreak, brakedUntilAt };
}
