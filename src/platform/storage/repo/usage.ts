/**
 * 回合用量仓储(`turn_usage`,migration 018)
 *
 * ── 粒度:一个**回合**一行,不是一次 LLM 调用一行 ──────────────────
 *
 * 一次 LLM 调用结一次账(SDK 在 `message_end` 上给一条 `Usage`),而一个回合
 * 可能调 N 次工具 ⇒ N+1 次 LLM 调用。**写入侧把这一回合各次调用求和之后写一行**
 * (`runtime/turn.ts` 的单点写入),所以本表的一行 = 一个回合的总账,
 * `SUM(input_tokens)` 就是「这个项目花了多少」。
 *
 * ⚠️ **018 的注释里写的是「一次 LLM 调用一行」,与实现不一致**(迁移已落地、
 * 不能改注释)。影响面:那句注释描述的是**写入侧的落点选择**,本文件按
 * 「回合级」实现 —— 与任务书一致,也与 018 自己「回合总量 = 该回合各行之和」
 * 的算法自洽(只是把「各行」在写入前先合成了 1 行)。若将来改成消息级,
 * 聚合读函数(下面这一族)一个字节都不用改:它们只做 `SUM(...) GROUP BY`。
 *
 * ── 三条纪律(照抄本仓既有仓储)───────────────────────────────────
 *
 *   ① **NULL 用 `IS ?`**:`project_id` 可空(NULL = 接待会话),`= NULL` 恒为
 *      unknown,一条也查不出来 —— 那会让接待会话那笔账**静默消失**,
 *      而「空结果」与「那段真的没花过钱」在接口上长得一样。
 *   ② **闭合集不认识就抛错**:这里没有 kind 列,但 `agent_id` 的读时解析走
 *      `getAgent`,它在角色越界时抛 —— 不会有一个没见过的角色悄悄流出去。
 *   ③ **不在这里拼给人看的名字**:`displayName` / `role` 的装配是
 *      `transport/views.ts` 的事(与 `toWorkView` / `toAskView` 同形)。
 *
 * ── 为什么不给「今天」用 SQL 的 `date('now')` ────────────────────
 *
 * `now` 必须是**注入的**(测试要能不依赖真实时钟穷举窗口边界)。所以窗口的
 * 起止由调用方算好传进来,仓储只做纯查询。`localDayKey` 与
 * `startOfLocalDay` 导出,就是为了让调用方与测试用**同一把尺**。
 */
import type Database from "better-sqlite3";

// ── 形状 ────────────────────────────────────────────────────────

/** `turn_usage` 的一行(回合级)。 */
export interface TurnUsageRow {
  id: string;
  /** NULL = **接待会话**(还没有项目)—— 那是最早那笔真花掉的钱,必须记上。 */
  projectId: string | null;
  /** 来源会话。NULL = 接待会话或那条会话已被删(刻意无外键,见 018 的说明)。 */
  sessionId: string | null;
  agentId: string;
  /** 这一回合在干哪个工作项(NULL = 聊天 / 汇报 / 评审的回合)。 */
  workId: string | null;
  /**
   * provider 侧的 model id。
   *
   * ⚠️ **一回合内混用多个模型时这里写 `null`**(见 `insertTurnUsage` 的说明):
   * 一列装不下两个模型,写其中一个就是**假归属**。
   */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  createdAt: number;
}

interface RawTurnUsage {
  id: string;
  project_id: string | null;
  session_id: string | null;
  agent_id: string;
  work_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  created_at: number;
}

function toRow(raw: RawTurnUsage): TurnUsageRow {
  return {
    id: raw.id,
    projectId: raw.project_id,
    sessionId: raw.session_id,
    agentId: raw.agent_id,
    workId: raw.work_id,
    model: raw.model,
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    cacheRead: raw.cache_read,
    createdAt: raw.created_at,
  };
}

/** 一组用量(窗口内合计 / 今日 / 某角色 / 某一天)。 */
export interface UsageBucket {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** 表里的行数 = **有花费的回合数**(没买到任何 LLM 输出的回合不写行)。 */
  readonly turns: number;
}

export const ZERO_BUCKET: UsageBucket = { input: 0, output: 0, cacheRead: 0, turns: 0 };

/** 按角色分组的一桶(`byAgent[]` 的元素,名字由视图层补)。 */
export interface UsageByAgentBucket extends UsageBucket {
  readonly agentId: string;
}

/** 按本地日历日分组的一桶。`day` 是 `YYYY-MM-DD`(本地时区)。 */
export interface UsageByDayBucket extends UsageBucket {
  readonly day: string;
}

/** 一个项目(或接待会话)的用量聚合。**纯数据,不含显示名**。 */
export interface ProjectUsageAggregate {
  readonly projectId: string | null;
  /**
   * 窗口本身(含今日共 `days` 个本地日历日,闭区间 `[since, until]`)。
   *
   * **必须回报**:窗口是算出来的(依赖 `now` 与本地时区),调用方拿不到它就只能
   * 猜「这个合计是哪段时间的」—— 而一个没有窗口的合计数字看起来永远是对的。
   */
  readonly window: { readonly days: number; readonly since: number; readonly until: number };
  /** 窗口内的合计(与 `window` 一致) */
  readonly totals: UsageBucket;
  /** **全历史**合计 —— 不受窗口影响,「总共花了多少」问的是它 */
  readonly allTime: UsageBucket;
  /** 今日(本地日历日) */
  readonly today: UsageBucket;
  readonly byAgent: readonly UsageByAgentBucket[];
  /** 按天升序(旧的在前)—— 与 `listSessionMessages` 的返回次序同一条规矩 */
  readonly byDay: readonly UsageByDayBucket[];
  /** `byDay` 是否因为 `dayLimit` 被截断(**不许静默少几天**) */
  readonly byDayTruncated: boolean;
  /** 最近一行用量的时刻;**没有任何行时为 `null`**(不拿「现在」冒充) */
  readonly updatedAt: number | null;
}

// ── 窗口与上限 ──────────────────────────────────────────────────

/** 默认窗口:7 个本地日历日(含今日)。 */
export const USAGE_DEFAULT_DAYS = 7;
/** 窗口上界:365 天(一年)。 */
export const USAGE_MAX_DAYS = 365;

/**
 * 把调用方给的 `days` 规范化成 `[1, USAGE_MAX_DAYS]`。
 *
 * **坏值取默认,不取「无上界」** —— 与 `runTurn.wallClockTimeoutMs` 同一条规矩
 * (见 `runtime/turn.ts`):「`0` = 不设上界」等于把唯一的上界悄悄拆掉,
 * 而一个项目的历史能把响应撑到没有意义的大小。
 */
export function normalizeUsageDays(days: number): number {
  if (!Number.isFinite(days)) return USAGE_DEFAULT_DAYS;
  const n = Math.floor(days);
  if (n <= 0) return USAGE_DEFAULT_DAYS;
  return Math.min(n, USAGE_MAX_DAYS);
}

/**
 * `byDay` 保留多少天:默认 = 窗口天数,上界 = 窗口天数。
 *
 * ⚠️ **它只截 `byDay`,绝不截 `totals` / `byAgent`** —— 拿行数上限去截合计
 * 会让「今日花了多少」在历史变长时**静默变小**(数字撒谎)。截断会经
 * `byDayTruncated` 如实报出。
 */
export function normalizeUsageDayLimit(limit: number, days: number): number {
  const cap = normalizeUsageDays(days);
  if (!Number.isFinite(limit)) return cap;
  const n = Math.floor(limit);
  if (n <= 0) return cap;
  return Math.min(n, cap);
}

/** 本地日历日的起点(当天 00:00:00.000)。 */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 本地日历日的键(`YYYY-MM-DD`)。
 *
 * 导出是**为了让它成为唯一一把尺**:窗口边界(`startOfLocalDay`)与 `byDay`
 * 的分组都从它派生,测试也用它算期望值 —— 三处各写一份日期格式化迟早会漂,
 * 而漂出来的表现是「某一天少了几笔」。
 */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── 写 ──────────────────────────────────────────────────────────

/**
 * 写一行回合总账。
 *
 * **单点写入 + 不重试**(幂等策略,任务书已定):表里没有天然键能识别「同一个
 * 回合」,所以写入侧只在 `runTurn` 返回前**写一次**;调用方重跑一个回合 = 新的一
 * 回合 = **新的一行**(那也确实是新花掉的钱)。**不为此加列** —— 一个为幂等而
 * 存在的键会把「同一个回合」变成需要跨进程协商的事实,而这里没有那个需要。
 *
 * `model` 的取法:同一回合内各次调用报的模型**去重**;恰好一个才写它,
 * **多个写 `null`**(一列装不下两个模型,写其中一个就是假归属),一个都没有也写
 * `null`(老行 / provider 没报 —— 不假装知道)。
 */
export function insertTurnUsage(db: Database.Database, row: TurnUsageRow): void {
  db.prepare(
    `INSERT INTO turn_usage
       (id, project_id, session_id, agent_id, work_id, model,
        input_tokens, output_tokens, cache_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.projectId,
    row.sessionId,
    row.agentId,
    row.workId,
    row.model,
    row.inputTokens,
    row.outputTokens,
    row.cacheRead,
    row.createdAt,
  );
}

// ── 读(明细)────────────────────────────────────────────────────

export interface UsageQueryWindow {
  /** 窗口起点(含),毫秒 */
  readonly since: number;
  /** 窗口终点(含),毫秒 */
  readonly until: number;
}

/**
 * 某项目(**或接待会话,传 `null`**)窗口内的明细行,新的在前。
 *
 * `projectId === null` 走 `IS NULL` —— 见文件头的纪律①。这一条有负样本测试:
 * 写成 `= ?` 时接待会话那笔账读出来是**空列表**。
 */
export function listTurnUsage(
  db: Database.Database,
  projectId: string | null,
  window: UsageQueryWindow,
): TurnUsageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM turn_usage
        WHERE project_id IS ? AND created_at >= ? AND created_at <= ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(projectId, window.since, window.until) as RawTurnUsage[];
  return rows.map(toRow);
}

// ── 读(聚合)────────────────────────────────────────────────────

/**
 * 把 `SUM(...)` 的结果行转成一桶。
 *
 * SQLite 的 `SUM` 在**零行**时返回 `NULL`(不是 0),`COUNT(*)` 返回 0 ——
 * 所以这里必须逐列兜底:`?? 0` 少了任何一列,空窗口就会让一个 `null` 流到
 * 前端并在那里变成 `NaN`。
 */
interface RawSum {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  turns: number;
}

function bucketOf(raw: RawSum | undefined): UsageBucket {
  if (raw === undefined) return ZERO_BUCKET;
  return {
    input: raw.input ?? 0,
    output: raw.output ?? 0,
    cacheRead: raw.cache_read ?? 0,
    turns: raw.turns ?? 0,
  };
}

const SUM_COLUMNS = `COALESCE(SUM(input_tokens), 0) AS input,
                     COALESCE(SUM(output_tokens), 0) AS output,
                     COALESCE(SUM(cache_read), 0) AS cache_read,
                     COUNT(*) AS turns`;

export interface AggregateUsageOptions {
  /** 注入的「现在」(窗口与「今日」都以它为基准,不读真实时钟) */
  readonly now: number;
  /** 窗口天数(先用 `normalizeUsageDays` 规范化再传) */
  readonly days: number;
  /** `byDay` 保留几天(先用 `normalizeUsageDayLimit` 规范化再传) */
  readonly dayLimit: number;
}

/**
 * 聚合一个项目(**或接待会话**)的用量。
 *
 * 窗口:`[startOfLocalDay(now) - (days-1) 天, now]` —— **含今日共 `days` 个
 * 本地日历日**。所以 `days = 1` 就是「今日」,`days = 7` 就是「最近 7 天(含今日)」,
 * 与页面上的读法一致(而不是「从此刻往前 168 小时」那种在半天的位置切断月份的口径)。
 *
 * 三个独立查询(合计 / 按角色 / 按天)+ 一个全历史合计。**合计不由明细行相加得出**:
 * 明细会被 `LIMIT` 掉(今天没有 LIMIT,但将来分页会),而合计必须在任何分页下
 * 都是真值 —— 所以两者走不同的 SQL。
 *
 * `byDay` 用 SQLite 的 `date(created_at/1000, 'unixepoch', 'localtime')` 分组,
 * 与 `localDayKey` 是**两套独立实现**;`tests/platform/usage-repo.test.ts` 里
 * 有一条交叉核对让它们互相校验(两边不一致会红)。
 */
export function aggregateProjectUsage(
  db: Database.Database,
  projectId: string | null,
  opts: AggregateUsageOptions,
): ProjectUsageAggregate {
  const days = normalizeUsageDays(opts.days);
  const dayLimit = normalizeUsageDayLimit(opts.dayLimit, days);
  const until = opts.now;
  const todayStart = startOfLocalDay(opts.now);
  // 含今日共 days 天 ⇒ 起点是 (days-1) 天前的本地零点
  const since = startOfLocalDay(todayStart - (days - 1) * 86_400_000);

  const windowWhere = `project_id IS ? AND created_at >= ? AND created_at <= ?`;
  const args = [projectId, since, until] as const;

  const totals = bucketOf(
    db
      .prepare(`SELECT ${SUM_COLUMNS} FROM turn_usage WHERE ${windowWhere}`)
      .get(...args) as RawSum | undefined,
  );

  const allTime = bucketOf(
    db
      .prepare(`SELECT ${SUM_COLUMNS} FROM turn_usage WHERE project_id IS ?`)
      .get(projectId) as RawSum | undefined,
  );

  const today = bucketOf(
    db
      .prepare(
        `SELECT ${SUM_COLUMNS} FROM turn_usage
          WHERE project_id IS ? AND created_at >= ? AND created_at <= ?`,
      )
      .get(projectId, todayStart, until) as RawSum | undefined,
  );

  // 按角色。次序固定(量的降序,同量按 agent_id 字典序)——
  // 接口不能每次给不同顺序,否则「两份数据一样的响应」无法逐字比对。
  const agentRows = db
    .prepare(
      `SELECT agent_id AS agent_id, ${SUM_COLUMNS} FROM turn_usage
        WHERE ${windowWhere}
        GROUP BY agent_id
        ORDER BY input DESC, output DESC, agent_id ASC`,
    )
    // `agent_id` 的读时解析**不在这里**:显示名与角色是视图层的事
    // (与 `toWorkView` 同形)。仓储只交出 id 与数字。
    .all(...args) as Array<RawSum & { agent_id: string }>;
  const byAgent: UsageByAgentBucket[] = agentRows.map((r) => ({
    agentId: r.agent_id,
    ...bucketOf(r),
  }));

  // 按本地日历日。先取**最新** dayLimit 天,再翻回升序交出去
  // (与 `listSessionMessages` 的「降序取尾巴、升序交回去」同形)。
  const dayRows = db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, ${SUM_COLUMNS}
         FROM turn_usage
        WHERE ${windowWhere}
        GROUP BY day
        ORDER BY day DESC
        LIMIT ?`,
    )
    .all(...args, dayLimit) as Array<RawSum & { day: string }>;
  const byDay: UsageByDayBucket[] = dayRows
    .reverse()
    .map((r) => ({ day: r.day, ...bucketOf(r) }));

  // 窗口里有几天有账?用它判断有没有被 dayLimit 截掉 —— **不用「byDay.length
  // < days」猜**,那样「今天还没花钱」会被误报成截断(假警报也是一种撒谎)。
  const dayCountRow = db
    .prepare(
      `SELECT COUNT(DISTINCT date(created_at / 1000, 'unixepoch', 'localtime')) AS n
         FROM turn_usage WHERE ${windowWhere}`,
    )
    .get(...args) as { n: number } | undefined;

  const latest = db
    .prepare(
      `SELECT MAX(created_at) AS at FROM turn_usage
        WHERE project_id IS ? AND created_at >= ? AND created_at <= ?`,
    )
    .get(...args) as { at: number | null } | undefined;

  return {
    projectId,
    window: { days, since, until },
    totals,
    allTime,
    today,
    byAgent,
    byDay,
    byDayTruncated: (dayCountRow?.n ?? 0) > byDay.length,
    updatedAt: latest?.at ?? null,
  };
}
