/**
 * BC1 ProjectManagement · works / work_deps 仓储
 *
 * `works` 是工作项树(通过 parent_work_id 分层),`work_deps` 是 DAG 依赖边。
 *
 * ── 环检测为什么必须在 repo 层 ────────────────────────────────────
 *
 * 自环由 schema 的 `CHECK (work_id <> depends_on_work_id)` 拒绝,但**多跳环**
 * SQL 表达不了。而这个项目在旧代码里已经踩过一次 DAG 通配 bug —— 死循环的
 * 表现是「计划永远跑不完」,事后极难归因。所以 `createsCycle` 是写依赖前的
 * 强制前置,不是可选的优化。
 */
import type Database from "better-sqlite3";
import { insertDispatchEvent, type DispatchEventKind } from "./dispatch.js";

export type WorkStatus = "open" | "in_progress" | "blocked" | "done" | "failed" | "cancelled";

export const WORK_STATUSES: readonly WorkStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "failed",
  "cancelled",
];

/**
 * 工作项的**审查态**(migration 013)。数据模型里此前没有「等待审查」这个状态,
 * 所以质检的待办只能靠级联观察到的内存事件 —— 不持久、重启不补跑。
 *
 *   none    不该被审(非 done)
 *   pending 已是 done、等着审   ← 质检的待办 = 一条查询(见 listWorksPendingReview)
 *   done    审过了(平台在质检那个回合成功结束后写)
 */
export type ReviewState = "none" | "pending" | "done";

export const REVIEW_STATES: readonly ReviewState[] = ["none", "pending", "done"];

export function isReviewState(v: unknown): v is ReviewState {
  return typeof v === "string" && (REVIEW_STATES as readonly string[]).includes(v);
}

/** 终态:不再推进。用于判断「能不能从这条边继续往下解」 */
const TERMINAL: ReadonlySet<WorkStatus> = new Set<WorkStatus>(["done", "failed", "cancelled"]);

export function isWorkStatus(v: unknown): v is WorkStatus {
  return typeof v === "string" && (WORK_STATUSES as readonly string[]).includes(v);
}

export function isTerminalWorkStatus(s: WorkStatus): boolean {
  return TERMINAL.has(s);
}

// ── 状态迁移表:机制,不是文档 ────────────────────────────────────
//
// 设计 §2.7:此前 `works.status` 只是**一个闭集 + 一个写口**,`updateWorkStatus`
// 不校验迁移 —— `work_update` 与 `report` 都能传闭集里的任意值,于是
// `work_update` 描述里那句 `open → in_progress → (blocked) → done|failed|cancelled`
// **是文档,不是机制**(与 §1.3「写在提示词里的规则会失效」同款病)。
//
// 现在这张表就是机制,判定落在**唯一写口** `updateWorkStatus` 里 ——
// 落在写口而不是那两个工具里,否则第三个调用方出现时又会漏。
//
// ── 每一条边都是从**实际可达路径**倒推的,不是凭手感画的 ──────────
//
//   open / in_progress / blocked 三态之间**全通**,且都能直接到任一终态。
//     依据:`execution.ts` 的 `checkRunnable` 只拒绝三个终态,所以
//     `open | in_progress | blocked` 都是「可以被跑」的状态;而
//     `pendingWork.collectPendingWork` 只把 `open | in_progress` 算待办 ——
//     于是 `blocked` 想再被跑,必须由模型先把它挪回 `open` / `in_progress`
//     (这两条边少一条,工作项就永久卡死)。
//     再依据:大量既有调用方**直接**从 `open` 写 `done` / `failed` / `cancelled`
//     (`tests/platform/storage.test.ts` 的 depState 那一组就是这样,
//     而现实里 worker 一开工就先被 `runWorkItem` 置成 `in_progress`,
//     所以「open → 终态」不是假路径,而是「一次回合之内跑完」的形状)。
//
//   done → in_progress:**允许** —— 理由与代价见下面【裁决 ①】。
//   failed → in_progress:**允许** —— failed 的工作项不在任何待办里
//     (`collectPendingWork` 只看 open/in_progress),`checkRunnable` 也拒绝它,
//     所以「重试」是它唯一的复活路径;少了这条边,一次失败就把下游
//     (`depState.failed` 不算满足)永久堵死。
//   cancelled → 任何状态:**禁止** —— 见下面【裁决 ②】。
export const WORK_TRANSITIONS: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
  open: ["in_progress", "blocked", "done", "failed", "cancelled"],
  in_progress: ["open", "blocked", "done", "failed", "cancelled"],
  blocked: ["open", "in_progress", "done", "failed", "cancelled"],
  // 退回重做(§12 #9)—— 代价见下面【裁决 ①】。
  done: ["in_progress"],
  // 重试。failed 不在待办里、也跑不了,这条边是它唯一的复活路径。
  failed: ["in_progress"],
  // **真终态**,没有出边 —— 见下面【裁决 ②】。
  cancelled: [],
};

// ── 两条裁决(§12 #9 把 `done → in_progress` 列为未决,这里给出判断与理由) ──
//
// 【裁决 ①】`done → in_progress`(审查后退回重做)**允许**。理由逐条对代码:
//
//   1. 它是**今天就在跑的合法路径**,而且有测试钉着它 ——
//      `tests/platform/dispatcher.test.ts` 的「迁出 done → review_state = none」
//      走的正是这一步。判它非法等于让现状变红,而「现有合法路径被迁移校验
//      挡死」恰恰是这次改动最要防的失败形态。
//   2. §12 #9 的另一条出路(判非法,退回重做走「新建一条工作项 + supersedes」)
//      **今天结构上不存在**:全仓没有工作项级的 `supersedes` 边(只有
//      `artifacts.status` 有同名取值,那是工件的状态机,不是工作项树)。
//      判非法之后,质检打回的那份产出**没有任何机械路径回到可执行状态** ——
//      而唯一剩下的做法恰好就是「取消旧的 + 新建一份」,也就是本次要修的
//      那个真机事故路径。收紧它会把模型**推回事故路径**,这是不接受 (a) 的
//      决定性理由。
//   3. `review_state` 那一半已经在写口上做对了:迁出 `done` 清成 `none`,
//      所以「等审」不会挂在一份已经退回重做的产出上。
//
//   **代价(如实记下,§12 #9 的原话)**:已经**消费掉**的 outbox 事件不会撤回,
//   于是「已向甲方交代过完成」与「其实还没做完」可以同时成立 ——
//   `consumed_at` 在这一次退回上开始撒谎。这是本次改动**没有**修掉的那一半。
//
//   出路仍开着,但两条都需要一笔 `dispatch_events` 重建:(a) 退回时写一条新事件
//   (如 `work_reopened`)把先前那次交代显式作废;(b) 给 outbox 加撤销/版本语义。
//   **不擅自加 `work_reopened`**:`kind` 闭集每加一个取值都要重建表,那是 015
//   的活、不在本次边界内 —— 悄悄加一个会让 015 的作者少放一个取值,
//   于是运行期直接撞 CHECK。
//
// 【裁决 ②】`cancelled` 是**真终态**,零出边。
//
//   「取消」的语义是「**这块范围不要了**」(§2.8),不是「这条活暂时不做」,
//   所以它就该是汇点:范围重新需要时要做的是**新的一件事**(新目标、新判据),
//   而不是把旧工作项复活;复活还会让 `depState.cancelled` 那条可见性
//   (「你的输入少了一块」)凭空消失。
//
//   这条边**可以**判非法(不像裁决 ① 那样会挡死路径):全仓没有任何调用方、
//   也没有任何测试走 `cancelled → *`;§2.7 记录它「也允许」只是「写口不校验
//   迁移」的副作用,不是有人依赖的行为。拦下时返回的结构化错误会**回灌**
//   出边集合(`[]`),模型据此知道该新建一条而不是复活旧的
//   (8-F:拒绝必须让模型能自纠)。

/** 这条迁移合法吗?**同状态不算迁移**(幂等空操作),一律放行。 */
export function isWorkTransitionAllowed(from: WorkStatus, to: WorkStatus): boolean {
  if (from === to) return true;
  return (WORK_TRANSITIONS[from] as readonly WorkStatus[]).includes(to);
}

/**
 * 迁移合法性的**纯判定**(不写库),写口与需要「失败时一个字节都不写」的
 * 调用方共用它 —— 规则只有一处,拒绝文案也只有一处。
 *
 * 调用方为什么要能提前判:一次 `work_update` 可以**同时**改依赖与状态。
 * 若先把依赖写了再发现状态非法,就留下了一个半成品(依赖变了、状态没变),
 * 而半成品在事后是看不出来的。提前判一次,失败时零写入。
 */
export type WorkTransitionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "illegal_transition";
      readonly from: WorkStatus;
      readonly to: WorkStatus;
      /** 合法下一跳(回灌给模型自纠,8-F) */
      readonly allowed: readonly WorkStatus[];
      readonly message: string;
    };

export function checkWorkTransition(
  id: string,
  from: WorkStatus,
  to: WorkStatus,
): WorkTransitionCheck {
  if (isWorkTransitionAllowed(from, to)) return { ok: true };
  const allowed = nextWorkStatuses(from);
  return {
    ok: false,
    reason: "illegal_transition",
    from,
    to,
    allowed,
    message:
      `工作项 ${id} 不能从「${from}」迁移到「${to}」` +
      (allowed.length === 0
        ? `:「${from}」是终态,没有出边 —— 范围重新需要时请新建一条工作项(不要复活旧的)`
        : `;从「${from}」出发只能到:${allowed.join(" | ")}`),
  };
}

/**
 * 从 `from` 出发的合法下一跳。拒绝时回灌给模型(8-F),所以它只列**出边**,
 * 不含 `from` 自己 —— 「原地不动」不是模型该收到的建议。
 */
export function nextWorkStatuses(from: WorkStatus): readonly WorkStatus[] {
  return WORK_TRANSITIONS[from];
}

export interface WorkRow {
  id: string;
  projectId: string;
  parentWorkId: string | null;
  title: string;
  goal: string;
  status: WorkStatus;
  /** 审查态(migration 013)。质检的待办由它查出来,不靠任何内存事件。 */
  reviewState: ReviewState;
  assigneeAgentId: string;
  createdAt: number;
  updatedAt: number;
}

interface RawWork {
  id: string;
  project_id: string;
  parent_work_id: string | null;
  title: string;
  goal: string;
  status: string;
  review_state: string;
  assignee_agent_id: string;
  created_at: number;
  updated_at: number;
}

function rowToWork(raw: RawWork): WorkRow {
  if (!isWorkStatus(raw.status)) {
    throw new Error(`works 表里出现未定义状态「${raw.status}」(id=${raw.id})`);
  }
  if (!isReviewState(raw.review_state)) {
    throw new Error(`works 表里出现未定义 review_state「${raw.review_state}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    parentWorkId: raw.parent_work_id,
    title: raw.title,
    goal: raw.goal,
    status: raw.status,
    reviewState: raw.review_state,
    assigneeAgentId: raw.assignee_agent_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

// ── works ───────────────────────────────────────────────────────

/**
 * 新建工作项时它就 `done` 的场合(测试/CLI 直接造终态项):那也是一份没人审过的
 * 产出,所以进 `pending`,与「状态迁移到 done」走同一条语义。
 */
function initialReviewState(status: WorkStatus): ReviewState {
  return status === "done" ? "pending" : "none";
}

/**
 * 插入用的一行。`reviewState` 可省:调用方不需要知道审查态这条内部状态 ——
 * 它由状态推导(见 `initialReviewState`),只有重建历史数据时才显式指定。
 */
export type NewWorkRow = Omit<WorkRow, "reviewState"> & { readonly reviewState?: ReviewState };

export function insertWork(db: Database.Database, row: NewWorkRow): void {
  db.prepare(
    `INSERT INTO works (id, project_id, parent_work_id, title, goal, status, review_state,
                        assignee_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.projectId, row.parentWorkId, row.title, row.goal,
    row.status, row.reviewState ?? initialReviewState(row.status), row.assigneeAgentId,
    row.createdAt, row.updatedAt,
  );
}

export function getWork(db: Database.Database, id: string): WorkRow | null {
  const raw = db.prepare(`SELECT * FROM works WHERE id = ?`).get(id) as RawWork | undefined;
  return raw ? rowToWork(raw) : null;
}

export interface ListWorksFilter {
  status?: WorkStatus;
  assigneeAgentId?: string;
  parentWorkId?: string;
  /** true = 只要顶层工作项(parent 为空) */
  rootsOnly?: boolean;
}

export function listWorks(
  db: Database.Database,
  projectId: string,
  filter: ListWorksFilter = {},
): WorkRow[] {
  const where = ["project_id = ?"];
  const vals: unknown[] = [projectId];
  if (filter.status !== undefined) { where.push("status = ?"); vals.push(filter.status); }
  if (filter.assigneeAgentId !== undefined) {
    where.push("assignee_agent_id = ?"); vals.push(filter.assigneeAgentId);
  }
  if (filter.parentWorkId !== undefined) {
    where.push("parent_work_id = ?"); vals.push(filter.parentWorkId);
  }
  if (filter.rootsOnly === true) where.push("parent_work_id IS NULL");
  const rows = db
    .prepare(`SELECT * FROM works WHERE ${where.join(" AND ")} ORDER BY created_at`)
    .all(...vals) as RawWork[];
  return rows.map(rowToWork);
}

// ── 写入侧的「可打扰」判据 ───────────────────────────────────────
//
// ── 用户的原话 ────────────────────────────────────────────────────
//
// > 我觉得现在**业务经理干的事情太多了** …… 业务经理就不需要再将项目实际执行的
// > **细节进展**直接同步给用户,你看聊天记录里面的一长串,**真真甲方不关心这些**
//
// ── 根因(复核过)────────────────────────────────────────────────
//
// 此前 `updateWorkStatus` 每迁入 done / failed / blocked 就写一行 outbox,而
// `collectTodos`(`runtime/dispatcher.ts`)只要**一条**未消费事件就生成
// `report_downstream`;它优先级最低,所以**总会在某个 tick 把业务经理叫醒一次**。
// 于是:唤醒频率由**单条状态迁移**决定,而业务经理并没有「这条不值得叫醒我」
// 的选项 —— 判据只有模型自己的自述。
//
// ── 方案甲:把判据从模型的自述换成**库里的一个事实** ────────────────
//
// 只在**可打扰**时写 outbox。判据是这条工作项在**工作分解树里的位置**:
//
//   某条**根工作项**终态(`parent_work_id IS NULL`)            → ✅ 写
//   **里程碑**(某根工作项的全部后代都终态)                    → ✅ 写
//   `work_failed`                                             → ✅ 写(与位置无关)
//   `blocker_opened` 且 severity ∈ {high, critical}            → ✅ 写
//   `blocker_opened` 且 severity ∈ {low, medium}               → ❌ 不写
//   **中间工作项**终态(`parent_work_id IS NOT NULL`)           → ❌ 不写 ← 用户抱怨的「一长串」
//
// 理由:根工作项就是**甲方能听懂的那一层**(它是交付物本身);中间的叶子工作项
// 是项目经理与 worker 之间的执行细节。甲方的注意力是稀缺资源,不该被「子任务
// 3 完成了」这种进度流水打断 —— 那是 `board_list` / `project_read` 能查出来的
// 事实,不需要推送。
//
// ── ⚠️ 为什么必须收在**写入侧**,不能收在判定侧 ────────────────────
//
// 消费是**全量**的:`consumePendingDispatchEvents` 无差别标记该项目**全部**未消费
// 事件(`WHERE project_id = ? AND consumed_at IS NULL`)。若把过滤放在判定侧
// (即 outbox 里仍有那一长串、只是不生成待办),那么一次**可打扰**事件会把
// 一串不可打扰事件**一起**标记成已交代 —— `consumed_at` 开始撒谎,那些行
// 再也不会被看见。判据必须在**进门**的时候生效。
//
// ── 代价(如实记下)──────────────────────────────────────────────
//
// outbox 从「**事件流水**」缩成了「**待交代队列**」:库里不再有「每一条状态迁移
// 的历史」。想回答「这条子任务什么时候完成的」要去看 `works.updated_at` 与会话
// 消息,而不是这一张表。这是**换来「不打扰甲方」的代价**,不是免费的:
// `dispatch_events` 从此不能当作审计面用。
//
// 另有一条已知的、可接受的重复:根工作项 A 的子项全部终结时写一条里程碑事件,
// A 自己随后迁入终态时再写它自己那条 —— 两条各自都有信息量(「分解的工作都收口了」
// 与「A 交付了」),不是同一条的重复。反之,**根自己已经终态时不再补发里程碑**
// (它的终态已经是一条事件),避免为同一件事写两行。
//
// severity 那一条(`blocker_opened` 只有 high / critical 值得打扰)**不在这里**判 ——
// 它不是工作项事件,判据落在 outbox 唯一的门 `insertDispatchEvent`
// (`repo/dispatch.ts` 的 `worthInterrupting`):门只有一个,可打扰判据就长在门上。

/** 里程碑:某个根工作项的全部后代都终结了,而根自己还没有。 */
interface Milestone {
  readonly rootId: string;
  readonly rootTitle: string;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly rootStatus: WorkStatus;
}

/**
 * 沿 `parent_work_id` 向上找根祖先。
 *
 * 用 `UNION`(而不是 `UNION ALL`):`parent_work_id` 万一被写成一个环,
 * `UNION ALL` 的递归 CTE 会**永远跑下去**(这也是 `createsCycle` 那条注释里
 * 记的同一类事故:死循环的表现是「计划永远跑不完」,事后极难归因)。
 * 去重之后必然终止;找不到根就返回 `null`,调用方据此不发里程碑事件。
 */
function rootAncestorOf(db: Database.Database, workId: string): string | null {
  const row = db
    .prepare(
      `WITH RECURSIVE up(id, parent_work_id) AS (
         SELECT id, parent_work_id FROM works WHERE id = ?
         UNION
         SELECT w.id, w.parent_work_id FROM works w JOIN up ON w.id = up.parent_work_id
       )
       SELECT id FROM up WHERE parent_work_id IS NULL LIMIT 1`,
    )
    .get(workId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * 这个根工作项**全部后代**的终态统计。**不含根本身** ——
 * 「子项都收口了但根还开着」正是里程碑要抓的那一刻。
 */
function descendantStates(
  db: Database.Database,
  rootId: string,
): { total: number; done: number; failed: number; cancelled: number } {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id, status) AS (
         SELECT id, status FROM works WHERE parent_work_id = ?
         UNION
         SELECT w.id, w.status FROM works w JOIN sub ON w.parent_work_id = sub.id
       )
       SELECT status, COUNT(*) AS n FROM sub GROUP BY status`,
    )
    .all(rootId) as Array<{ status: string; n: number }>;
  const n = (s: WorkStatus) => rows.find((r) => r.status === s)?.n ?? 0;
  return {
    total: rows.reduce((acc, r) => acc + r.n, 0),
    done: n("done"),
    failed: n("failed"),
    cancelled: n("cancelled"),
  };
}

/** 这一刻算不算走到了里程碑?不算就返回 `null`。 */
function milestoneReached(db: Database.Database, workId: string): Milestone | null {
  const rootId = rootAncestorOf(db, workId);
  if (rootId === null || rootId === workId) return null;
  const root = getWork(db, rootId);
  if (root === null) return null;
  // 根自己已经是一条事件了 —— 不为同一件事写两行(见上面「代价」那段)。
  if (isTerminalWorkStatus(root.status)) return null;
  const s = descendantStates(db, rootId);
  if (s.total === 0) return null;
  if (s.done + s.failed + s.cancelled !== s.total) return null;
  return {
    rootId, rootTitle: root.title,
    total: s.total, done: s.done, failed: s.failed, cancelled: s.cancelled,
    rootStatus: root.status,
  };
}

/** 一条待写的下游事件(判定结果,还没落库)。 */
interface Announcement {
  readonly kind: DispatchEventKind;
  readonly subjectId: string;
  readonly summary: string;
}

/**
 * 这次状态迁移该写哪几条 outbox 事件?**空数组 = 判定为不可打扰。**
 *
 * 顺序即上面的表:① 根工作项自己 ② `failed` 永远可打扰 ③ 里程碑。
 * 三条互斥与叠加关系都写在行内注释里。
 */
function announcementsFor(db: Database.Database, work: WorkRow, status: WorkStatus): Announcement[] {
  const out: Announcement[] = [];
  const isRoot = work.parentWorkId === null;

  // ① 根工作项:它自己就是甲方能听懂的那一层。
  if (isRoot) {
    const kind = EVENT_KIND[status];
    if (kind !== undefined) {
      out.push({ kind, subjectId: work.id, summary: labelFor(work.title, status) });
    }
  } else if (status === "failed") {
    // ② 失败**与树的位置无关** —— 它需要有人介入,永远可打扰。
    //    (中间工作项的其他状态在这一支里被静默放行 = 判定为不可打扰。)
    out.push({ kind: "work_failed", subjectId: work.id, summary: labelFor(work.title, status) });
  }

  // ③ 里程碑:中间工作项**终结**之后,某个根工作项的后代可能刚好全部收口。
  //    这里只算终态迁移 —— `blocked` 不是终态,它不改变「全部收口」的判定。
  if (!isRoot && isTerminalWorkStatus(status)) {
    const m = milestoneReached(db, work.id);
    if (m !== null) {
      out.push({
        kind: "work_done",
        subjectId: m.rootId,
        summary:
          `里程碑:「${m.rootTitle}」的 ${m.total} 个子项已全部终结` +
          `(完成 ${m.done} · 失败 ${m.failed} · 取消 ${m.cancelled};` +
          `根工作项仍为 ${m.rootStatus})`,
      });
    }
  }
  return out;
}

/**
 * 状态 → 下游事件种类。`cancelled` 是本次新增的(设计 §12 #10):
 * 它此前**不写任何事件**,于是「一条工作项被取消」业务经理与质检都不知道 ——
 * 而它正是下游依赖悬空的来源(真机事故的起点)。
 */
const EVENT_KIND: Readonly<Partial<Record<WorkStatus, DispatchEventKind>>> = {
  done: "work_done",
  failed: "work_failed",
  blocked: "work_blocked",
  cancelled: "work_cancelled",
};

function labelFor(title: string, status: WorkStatus): string {
  const how =
    status === "done" ? "已完成"
    : status === "failed" ? "失败了"
    : status === "cancelled" ? "已取消(这块范围不要了)"
    : "受阻";
  return `「${title}」${how}`;
}

/** 判定为可打扰、但当前 schema 还写不进去的事件(015 落地后不会再出现)。 */
export interface DeferredAnnouncement {
  readonly kind: DispatchEventKind;
  readonly needsMigration: string;
  readonly detail: string;
}

/**
 * 改状态的结果。**非法迁移返回结构化原因,不抛** —— 抛出去会把整轮对话打崩
 * (工具层的第一条纪律),而模型只能靠错误信息决定下一步。
 */
export type WorkStatusChange =
  | {
      readonly ok: true;
      /** false = 同状态,幂等空操作(不产生任何事件) */
      readonly changed: boolean;
      readonly from: WorkStatus;
      readonly to: WorkStatus;
      /** 真的写进 outbox 的事件条数。`0` = 这次迁移判定为**不可打扰** */
      readonly announced: number;
      /** 判定为可打扰、但 schema 还不允许落库的(需要 migration 015) */
      readonly deferred: readonly DeferredAnnouncement[];
    }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "illegal_transition";
      readonly from: WorkStatus | null;
      readonly to: WorkStatus;
      /** 合法下一跳(回灌给模型自纠,8-F)。`not_found` 时为空 */
      readonly allowed: readonly WorkStatus[];
      readonly message: string;
    };

/**
 * 改状态。**这是 `works.status` 的唯一写口**,所以三件事都在这里维护 ——
 * 散到各个调用方去写,迟早有一条路漏掉,而漏掉的表现是静默的
 * (产出没人审 / 做完了没人向甲方交代 / 非法迁移溜过去)。
 *
 * 三条不变量:
 *   ① **迁移合法性**由 `WORK_TRANSITIONS` 判定,非法返回结构化原因(不抛)
 *   ② 迁入 `done` → `review_state = 'pending'`(产出等审);迁出 `done` → `none`
 *   ③ 迁入终态 / `blocked` 时按**可打扰判据**写 `dispatch_events`
 *      (业务经理的汇报待办由它查出来 —— 不再是级联观察到的内存事件;
 *      判据见上面那一段长注释,`announced: 0` 是**刻意**的结果,不是漏写)
 */
export function updateWorkStatus(
  db: Database.Database,
  id: string,
  status: WorkStatus,
  at: number,
): WorkStatusChange {
  const before = getWork(db, id);
  if (before === null) {
    return {
      ok: false, reason: "not_found", from: null, to: status, allowed: [],
      message: `找不到工作项 ${id}`,
    };
  }
  const same = before.status === status;
  if (!same) {
    const check = checkWorkTransition(id, before.status, status);
    if (!check.ok) return check;
  }

  // 同状态也照写 UPDATE(维持原实现:updated_at 与会审态都要被维护),
  // 但它**不是迁移**,所以不产生任何事件。
  const reviewState: ReviewState =
    status !== "done"
      ? "none"
      : before.status === "done"
        ? (before.reviewState ?? "pending")
        : "pending";
  db.prepare(`UPDATE works SET status = ?, updated_at = ?, review_state = ? WHERE id = ?`).run(
    status, at, reviewState, id,
  );
  if (same) {
    return { ok: true, changed: false, from: before.status, to: status, announced: 0, deferred: [] };
  }

  let announced = 0;
  const deferred: DeferredAnnouncement[] = [];
  for (const a of announcementsFor(db, before, status)) {
    const r = insertDispatchEvent(db, {
      projectId: before.projectId,
      kind: a.kind,
      subjectId: a.subjectId,
      summary: a.summary,
      createdAt: at,
    });
    if (r.ok) {
      announced++;
    } else if (r.reason === "kind_not_enabled_by_schema") {
      deferred.push({ kind: r.kind, needsMigration: r.needsMigration, detail: r.detail });
    }
    // reason === "not_worth_interrupting":刻意不写。这里写不到 —— 它只对
    // `blocker_opened` 生效,而这条路径只发工作项事件(留这一句是为了穷尽性)。
  }
  return { ok: true, changed: true, from: before.status, to: status, announced, deferred };
}

/**
 * **等审的工作项** —— 质检那条待办的唯一判据。
 *
 * 它就是一条查询(部分索引 `idx_works_pending_review` 为它建),所以:
 *   - 重启后能补跑(状态在库里,不在进程内存里)
 *   - 「刚刚完成」这种内存事件不再是判据(那是批次 20 不持久、重启不补跑的根因)
 */
export function listWorksPendingReview(
  db: Database.Database,
  projectId: string,
): WorkRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM works
       WHERE project_id = ? AND status = 'done' AND review_state = 'pending'
       ORDER BY updated_at, id`,
    )
    .all(projectId) as RawWork[];
  return rows.map(rowToWork);
}

/**
 * 标记已审(平台在质检那个回合**成功结束之后**写)。
 *
 * 判据不是「模型有没有写 review_finding」—— 那依赖模型自己建立 artifact_link,
 * 现有模型里没有保证(见 `docs/DESIGN-PLATFORM.md` 与 AGENTS.md 的说明)。
 * 平台能确定的事实是:**这一份产出已经被交给质检看过一次了**;它到底审出了什么,
 * 现场在那一回合的会话消息与工件里。若这一回合失败/被中断,调用方**不写**,
 * 于是下次 tick 重来(at-least-once)。
 */
export function markWorkReviewed(db: Database.Database, id: string, at: number): void {
  db.prepare(
    `UPDATE works SET review_state = 'done', updated_at = ?
     WHERE id = ? AND status = 'done' AND review_state = 'pending'`,
  ).run(at, id);
}

/** 改派。设计 1 §3.3:改派与分派走同一条解析路径,避免「改派绕过歧义检查」。 */
export function assignWork(
  db: Database.Database,
  id: string,
  assigneeAgentId: string,
  at: number,
): void {
  db.prepare(`UPDATE works SET assignee_agent_id = ?, updated_at = ? WHERE id = ?`).run(
    assigneeAgentId,
    at,
    id,
  );
}

export function deleteWork(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM works WHERE id = ?`).run(id);
}

// ── work_deps ───────────────────────────────────────────────────

/**
 * 加一条依赖前的环检测。
 *
 * 语义:要加 `workId depends on depId`。若从 `depId` 沿 depends_on 方向能走回
 * `workId`,则这条边会成环。
 *
 * 用已访问集合 + 显式栈做 DFS —— 不设深度上限(工作项树本来可能很深),
 * 靠 visited 保证终止。
 */
export function createsCycle(
  db: Database.Database,
  workId: string,
  depId: string,
): boolean {
  if (workId === depId) return true; // 自环(schema 也拦,这里给出更早的失败)
  const stmt = db.prepare(`SELECT depends_on_work_id FROM work_deps WHERE work_id = ?`);
  const visited = new Set<string>();
  const stack = [depId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === workId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const r of stmt.all(cur) as Array<{ depends_on_work_id: string }>) {
      stack.push(r.depends_on_work_id);
    }
  }
  return false;
}

export type AddDepResult =
  | { ok: true }
  | { ok: false; reason: "self" | "cycle" | "duplicate" | "not_found" };

/** 加依赖。**环检测是前置**,成环时不写库并返回结构化原因。 */
export function addDep(db: Database.Database, workId: string, depId: string): AddDepResult {
  if (workId === depId) return { ok: false, reason: "self" };
  if (getWork(db, workId) === null || getWork(db, depId) === null) {
    return { ok: false, reason: "not_found" };
  }
  const exists = db
    .prepare(`SELECT 1 FROM work_deps WHERE work_id = ? AND depends_on_work_id = ?`)
    .get(workId, depId);
  if (exists) return { ok: false, reason: "duplicate" };
  if (createsCycle(db, workId, depId)) return { ok: false, reason: "cycle" };
  db.prepare(`INSERT INTO work_deps (work_id, depends_on_work_id) VALUES (?, ?)`).run(workId, depId);
  return { ok: true };
}

export function removeDep(db: Database.Database, workId: string, depId: string): void {
  db.prepare(`DELETE FROM work_deps WHERE work_id = ? AND depends_on_work_id = ?`).run(
    workId,
    depId,
  );
}

/**
 * 整体替换一条工作项的依赖边。**`work_create` 与 `work_update` 共用这一段** ——
 * 两处各写一套迟早会漂,而漂的表现是「创建时拦得住的环,改依赖时放过去了」。
 *
 * ── 它解决的那个真机事故(用户数据复核过)─────────────────────────
 *
 * 在 `work_update` 拿到 `dependsOn` 之前,**唯一**能画依赖边的工具是 `work_create`,
 * 而 `removeDep` **零生产调用方**(全仓只有定义与一条单测)。也就是说
 * **已有工作项的依赖边改不了** —— 于是项目经理要重做一条工作项时,只能
 * 「取消旧的 + 新建一份」。真机数据里那条 `cancelled` 事故正是这条路径的产物:
 *
 *   [cancelled] 三段式 vs omni 综合对比与替代路径分析   wk_mutsr5um7pvqej0r
 *   [open]      三段式 vs omni 综合对比与替代路径分析   wk_mutsrwg6tfcjv5x1  ← 同名新建
 *   [open]      调研报告整合与撰写                      wk_mutsrwg8cl7tatjx
 *       前置:… + 三段式 vs omni 综合对比 = cancelled    ← 指向被取消的那份旧的
 *
 * (`~/.sansheng/sansheng.db` 实测:那 5 条边里最后一条指向 `cancelled`。)
 *
 * ── 语义与纪律 ────────────────────────────────────────────────────
 *
 *   - **整体替换**:给 `[]` 就是清空依赖。不在集合里的旧边一律 `removeDep`。
 *   - 环检测**复用 `addDep` / `createsCycle`**,不另写一套。而且**先判后写**:
 *     非法 id / 自环 / 跨项目 / 成环时**一个字节都不写库**(不是「写一半再回滚」)。
 *   - 非法时返回结构化原因(不抛)。
 *
 * 为什么「先判后写」是安全的(而不是必须在移除之后才判得准):
 * `createsCycle(db, workId, depId)` 从 `depId` 沿 `depends_on` 方向找 `workId`,
 * 途中一旦抵达 `workId` 立即为真 —— 所以它**永远不会遍历 `workId` 的出边**。
 * 而这次替换改动的恰好只是 `workId` 的出边,因此判定结果与「先移除后判定」
 * 完全一致。
 */
export type SetWorkDepsResult =
  | {
      readonly ok: true;
      readonly before: readonly string[];
      readonly added: readonly string[];
      readonly removed: readonly string[];
      /** 替换之后的完整依赖集合(= 调用方给的集合去重后) */
      readonly deps: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "self" | "not_found" | "cross_project" | "cycle";
      /** 出问题的那条边的另一端(便于模型自纠) */
      readonly offending: string;
      readonly message: string;
    };

export function setWorkDeps(
  db: Database.Database,
  workId: string,
  deps: readonly string[],
): SetWorkDepsResult {
  const work = getWork(db, workId);
  if (work === null) {
    return {
      ok: false, reason: "not_found", offending: workId,
      message: `找不到工作项 ${workId}`,
    };
  }

  // ── 第一遍:只读的合法性校验(一个字节都不写) ──
  const wanted: string[] = [];
  for (const d of deps) {
    if (d === workId) {
      return {
        ok: false, reason: "self", offending: d,
        message: `工作项不能依赖自己(${workId})`,
      };
    }
    const dep = getWork(db, d);
    if (dep === null) {
      return {
        ok: false, reason: "not_found", offending: d,
        message: `找不到前置工作项 ${d}`,
      };
    }
    if (dep.projectId !== work.projectId) {
      return {
        ok: false, reason: "cross_project", offending: d,
        message:
          `前置工作项 ${d} 属于项目 ${dep.projectId},与 ${workId}(项目 ${work.projectId})` +
          `不是同一个项目 —— 依赖边不跨项目`,
      };
    }
    if (!wanted.includes(d)) wanted.push(d); // 入参里重复的 id 不报错(边还在,没丢信息)
  }

  const before = listDeps(db, workId);
  const toRemove = before.filter((d) => !wanted.includes(d));
  const toAdd = wanted.filter((d) => !before.includes(d));

  for (const d of toAdd) {
    // `createsCycle` 就是 `addDep` 内部用的那一个 —— 同一套环检测,不是复制品。
    if (createsCycle(db, workId, d)) {
      return {
        ok: false, reason: "cycle", offending: d,
        message: `依赖 ${d} 会成环(${workId} → ${d} 已存在一条反向路径)—— 一个字节都没写`,
      };
    }
  }

  // ── 第二遍:写。到这里已经不可能失败(万一失败就整体回滚,不留半成品) ──
  const apply = db.transaction(() => {
    for (const d of toRemove) removeDep(db, workId, d);
    for (const d of toAdd) {
      const r = addDep(db, workId, d);
      if (!r.ok) throw new Error(`setWorkDeps 的预检与写入不一致(${d}: ${r.reason})`);
    }
  });
  apply();

  return { ok: true, before, added: toAdd, removed: toRemove, deps: wanted };
}

/** 我的前置(我必须等谁) */
export function listDeps(db: Database.Database, workId: string): string[] {
  const rows = db
    .prepare(`SELECT depends_on_work_id FROM work_deps WHERE work_id = ?`)
    .all(workId) as Array<{ depends_on_work_id: string }>;
  return rows.map((r) => r.depends_on_work_id);
}

/** 我的后继(谁在等我)—— 一条边完成后要唤醒的那批 */
export function listDependents(db: Database.Database, workId: string): string[] {
  const rows = db
    .prepare(`SELECT work_id FROM work_deps WHERE depends_on_work_id = ?`)
    .all(workId) as Array<{ work_id: string }>;
  return rows.map((r) => r.work_id);
}

/**
 * 一条工作项的前置状态,**分三态**而不是一个布尔。
 *
 * 为什么必须分开:旧系统的 todo 依赖只有「满足/未满足」,于是上游 failed 时
 * 下游只能干等 —— 而它等的那个东西永远不会来。旧代码为此专门有
 * `cascadeFailDependents`。这里把区分做进返回值,让调用方**必须**显式决定
 * 「等」还是「级联失败」,不能靠默认行为糊过去。
 */
export interface DepState {
  /** 已 done —— 依赖满足 */
  satisfied: string[];
  /**
   * 被**取消**的前置 —— **不构成阻塞**。
   *
   * 取消的语义是「这块范围不要了」,不是「这条活失败了」。把它归进 `failed`
   * 会让下游**永远等一个不会有人做的活** —— 真机事故:项目经理取消了「综合对比」
   * 并新建了一份同名项,而新「报告整合」的 `dependsOn` 指向了**被取消的那份旧的**,
   * 于是那条工作项永远不会被唤醒(数据里躺了很久,不报错)。
   *
   * 单独一类而不是并入 satisfied,是因为**它必须可见** —— 下游要知道自己是在
   * 「前置被取消」的前提下开工的,而不是以为一切按计划。
   */
  cancelled: string[];
  /** failed —— 真的失败了,**仍然不满足**(这条才需要人介入) */
  failed: string[];
  /** 仍在推进 —— 等得起 */
  pending: string[];
  /** 依赖指向的工作项不存在(数据损坏) */
  missing: string[];
}

export function depState(db: Database.Database, workId: string): DepState {
  const state: DepState = { satisfied: [], cancelled: [], failed: [], pending: [], missing: [] };
  for (const d of listDeps(db, workId)) {
    const w = getWork(db, d);
    if (w === null) { state.missing.push(d); continue; }
    if (w.status === "done") state.satisfied.push(d);
    else if (w.status === "cancelled") state.cancelled.push(d);
    else if (w.status === "failed") state.failed.push(d);
    else state.pending.push(d);
  }
  return state;
}

/**
 * 前置是否全部满足(可以开工)。
 *
 * - `failed` / `pending` / `missing` → **不满足**(它们不该被当成放行)
 * - `cancelled` → **算满足**(取消 = 范围不要了,不构成阻塞;但见 `DepState.cancelled`,
 *   它必须对下游可见)
 */
export function depsSatisfied(db: Database.Database, workId: string): boolean {
  const s = depState(db, workId);
  return s.failed.length === 0 && s.pending.length === 0 && s.missing.length === 0;
}
