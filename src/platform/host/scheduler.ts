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

  const timer = setInterval(() => { tick(); }, intervalMs);
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

// ── fixed-delay 定时器(排空器的兜底触发)────────────────────────

export interface FixedDelayDeps {
  readonly intervalMs: number;
  /** 跑一轮。**它自己负责重入闩** —— 本定时器不关心上一次跑完没有 */
  readonly run: () => Promise<void> | void;
  readonly log?: (line: string) => void;
  /** 第一轮是否等满一个间隔。缺省 true = 严格 fixed-delay 语义 */
  readonly immediateFirstRun?: boolean;
}

export interface FixedDelayLoop {
  stop(): void;
  /** 手动跑一轮(测试与诊断用) */
  runNow(): Promise<void>;
  /** 已经跑过几轮 */
  runs(): number;
  /**
   * 最近一次**开始**跑的时刻(时钟来自 `Date.now()`);没跑过时为 `null`。
   *
   * 它是排空器的**心跳**:读面(`GET /api/projects/:id/live`)靠它显示
   * 「上一次兜底触发距今多久」。没有这一位的话,「排空器还在转」就只存在于日志
   * 里的一行行文字 —— 而用户要的是屏幕上看得见(「我担心系统已经挂了,而实际
   * 还在运行」)。
   *
   * ⚠️ **内存事实**:进程重启即 `null`,而 `null` 的语义是「本进程还没跑过」,
   * 不是「很久以前跑过」。读面必须把这两种状态分开显示。
   */
  lastRunAt(): number | null;
}

/**
 * **fixed-delay** 定时器:上一轮**跑完之后**再等 `intervalMs` 才跑下一轮。
 *
 * 与 `setInterval` 的区别是要紧的:一次排空可能跑几分钟(每个回合都是真模型),
 * 而 `setInterval` 会在这期间按点堆叠触发 —— 上一轮还没结束就又进来一轮。
 * fixed-delay 天然不重叠,缺的那点实时性由「每轮跑完再排下一轮」补回来。
 *
 * 它是排空器的**兜底**触发:重启恢复、事件漏掉的、以及外部直接改库的场合。
 * 它不携带任何状态,只做一件事 —— 说「现在去查一下」。
 */
export function startFixedDelay(deps: FixedDelayDeps): FixedDelayLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let runs = 0;
  let lastRunAt: number | null = null;

  const fire = async (): Promise<void> => {
    runs++;
    // 心跳记在**真正开始**跑的那一刻(不是跑完之后):一次排空可以跑十几分钟,
    // 记在结束时刻会让界面上显示「上一次 0 秒前」而它其实刚跑完 —— 两种读法
    // 都在回答「它还在转吗」,但只有「开始」能同时回答「转过几轮、多久前开始的」。
    lastRunAt = Date.now();
    try {
      await deps.run();
    } catch (err) {
      // 一个静默失败的周期入口等于这个功能不存在 —— 必须响亮
      deps.log?.(`dispatch: 排空抛错 —— ${err instanceof Error ? err.message : String(err)}`);
    }
    schedule();
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => { void fire(); }, deps.intervalMs);
    // 不因为这个定时器把进程钉住
    timer.unref?.();
  };

  if (deps.immediateFirstRun === true) void fire();
  else schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
    runNow: fire,
    runs: () => runs,
    lastRunAt: () => lastRunAt,
  };
}
