/**
 * 平台 · 调度器
 *
 * ── 它做什么,以及**刻意不做什么** ──────────────────────────────
 *
 * 做:周期扫描已过截止时间仍未答复的提问,把结果推给前端,让徽标亮起来。
 *
 * **不做:自动升级。** 2026-10-04 经 jev 校准(p=0.81,margin 0.63):
 *
 *   > 单人本地服务里「人暂时没回」是**常态而不是故障**。自动升级会把组织图
 *   > 变成噪音放大器,而噪音的代价是用户学会忽略通知 —— 和「严重程度通胀」
 *   > 是同一类问题。
 *
 * 这条与 7-L 的 fail-safe 原则(「判断轮缺席/超时/解析失败一律退回升级」)
 * **不冲突**:那条针对的是**单次判断轮**的缺席(机器没能做出判断,所以退回人工),
 * 而这里针对的是**人暂时没回**(判断者存在,只是还没轮到它)。
 *
 * ── 设计上的一条纪律:`tick()` 与定时器分开 ──────────────────────
 *
 * 扫描逻辑是纯的(给定 db + now,产出报告),定时器只是它的驱动。
 * 于是测试可以直接调 `tick()`,不必等真实时间 —— 这是本项目反复用的
 * 「把纯逻辑与副作用分开」的处置(参考 `runtime/pendingWork.ts`)。
 */
import type Database from "better-sqlite3";
import { listOverdueAsks } from "../storage/repo/asks.js";
import { listProjects } from "../storage/repo/projects.js";
import type { ServerEvent } from "@shared/types/platform.js";

export interface OverdueProjectReport {
  readonly projectId: string;
  readonly projectName: string;
  readonly askIds: readonly string[];
}

export interface SchedulerReport {
  readonly scannedAt: number;
  /** 有待答超时的项目(只含非空项) */
  readonly projects: readonly OverdueProjectReport[];
  /** 超时提问总数 */
  readonly total: number;
}

export interface SchedulerDeps {
  readonly db: Database.Database;
  readonly now: () => number;
  /** 广播事件(WS 未连接时是无害的空操作) */
  readonly broadcast: (ev: ServerEvent) => void;
  /** 扫描间隔,缺省 60 秒 */
  readonly intervalMs?: number;
  /** 日志 */
  readonly log?: (line: string) => void;
  /**
   * **每次 tick 之后再扫一次组织**(批次 20 接线:驱动者循环的周期入口)。
   *
   * ── 为什么挂在调度器上,而不是另起一个定时器 ──────────────────────
   *
   * 调度器已经是「进程里唯一那个周期性看一眼」的东西。再起一个定时器意味着
   * 两个周期互相不知道对方(V1 的 `--data` 与 `--data-dir` 就是这么漂的)。
   *
   * ── 它**不改变** `schedulerTick` 的纯性 ──────────────────────────
   *
   * `tick()` 仍然是「读库 → 算报告 → 广播」;组织那件事由宿主注入的回调做,
   * 而回调是**异步且 fire-and-forget** 的 —— `tick` 不等它,所以一次慢级联
   * 不会把超时扫描也拖住。回调自己负责「上次还没跑完就别再起一次」。
   */
  readonly onTick?: (report: SchedulerReport) => void;
}

/**
 * 扫一遍。**纯逻辑** —— 读库、算报告、广播,不启动任何会话、不改任何状态。
 *
 * 「不改状态」是刻意的:调度器一旦能改状态,它就成了一个**自主行为者**,
 * 而它的判断依据(时间过了)太弱,不足以承担那个角色。
 */
export function schedulerTick(db: Database.Database, now: number): SchedulerReport {
  const projects: OverdueProjectReport[] = [];

  for (const p of listProjects(db)) {
    const overdue = listOverdueAsks(db, now, p.id);
    if (overdue.length === 0) continue;
    projects.push({
      projectId: p.id,
      projectName: p.name,
      askIds: overdue.map((a) => a.id),
    });
  }

  return {
    scannedAt: now,
    projects,
    total: projects.reduce((n, p) => n + p.askIds.length, 0),
  };
}

export interface Scheduler {
  /** 手动跑一次(测试与诊断用) */
  tick(): SchedulerReport;
  stop(): void;
  /** 扫描次数与最后一次报告(诊断用) */
  stats(): { ticks: number; lastTotal: number };
}

/**
 * 启动调度器。
 *
 * **不主动发起对话。** 它只推事件 —— 用户看到徽标才会去处理。
 * 「系统自己去找人说话」是另一个量级的设计决定(主动代理),不在本批范围内。
 */
export function startScheduler(deps: SchedulerDeps): Scheduler {
  const intervalMs = deps.intervalMs ?? 60_000;
  let ticks = 0;
  let lastTotal = 0;
  /** 上一次已告知的超时集合 —— 只在**变化时**推,避免每分钟刷一遍同样的东西 */
  let lastSignature = "";

  const tick = (): SchedulerReport => {
    ticks++;
    const report = schedulerTick(deps.db, deps.now());
    lastTotal = report.total;

    // 只在集合变化时广播 —— 每分钟推一遍相同内容会让前端无谓重渲染,
    // 而且会淹没真正的新事件
    const signature = report.projects
      .map((p) => `${p.projectId}:${[...p.askIds].sort().join(",")}`)
      .sort()
      .join("|");
    if (signature === lastSignature) return report;
    const isFirst = lastSignature === "";
    lastSignature = signature;

    if (report.total > 0 || !isFirst) {
      for (const p of report.projects) {
        deps.broadcast({
          type: "overdue_asks",
          projectId: p.projectId,
          askIds: p.askIds,
          count: p.askIds.length,
        });
      }
    }
    if (report.total > 0) {
      deps.log?.(
        `scheduler: ${report.total} 条提问已超时(` +
          report.projects.map((p) => `${p.projectName}:${p.askIds.length}`).join(" · ") +
          `)—— 只告知,不自动升级`,
      );
    }
    return report;
  };

  const timer = setInterval(() => {
    const report = tick();
    // 组织那件事在 tick 之后跑,且**不等它** —— 见 SchedulerDeps.onTick 的说明。
    // 放在「签名没变就 early return」之外是有意的:超时集合没变,不代表组织
    // 层面没有新待办(用户刚在项目里说了句话,那个待办的签名与超时集合无关)。
    try {
      deps.onTick?.(report);
    } catch (err) {
      deps.log?.(
        `scheduler: onTick 抛错 —— ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, intervalMs);
  // 不因为这个定时器把进程钉住(测试里尤其重要)
  timer.unref?.();

  // 启动时先跑一次,不必等第一个间隔
  tick();

  return {
    tick,
    stop: () => clearInterval(timer),
    stats: () => ({ ticks, lastTotal }),
  };
}
