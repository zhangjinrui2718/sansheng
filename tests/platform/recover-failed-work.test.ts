/**
 * 第 14 条规则 `recover_failed_work`(2026-10-06 真机静默停摆)
 *
 * ── 真机现场 ────────────────────────────────────────────────────
 *
 * 项目「美股自动化交易平台方案设计·单报告合并版」:一条 worker 工作项在单回合读进
 * **109,231 token** 之后撞上墙钟上界(10 分钟)被 `abort()` 打断,经 `updateWorkStatus`
 * 这个唯一写口记成 `failed`。`work_failed` outbox 事件被消费了(业务经理确实被叫醒、
 * 去向甲方交代)—— **然后再没有任何人被叫醒**。直接跑 `collectTodos`:
 * `runnable: 0, exhausted: 0`。
 *
 * ⚠️ **`exhausted` 也是 0**:不是「试够了所以放弃」,是**没有任何一条规则提到
 * `failed`**。`blocked` 有 `resolve_blocked_work`,`failed` 一条都没有。而
 * 「零待办」与「组织已经把活干完了」在日志里长得**一模一样**。
 *
 * 这一批钉四件事:判据成立、判据不成立、**不重跑**(叫 PM 而不是让 worker 再来一次)、
 * 预算到界不静默。
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { runMigrations } from "../../src/platform/infra/migrations.js";
import { addMember, insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertWork, updateWorkStatus } from "../../src/platform/storage/repo/works.js";
import { collectTodos } from "../../src/platform/runtime/dispatcher.js";
import { insertDispatchEvent } from "../../src/platform/storage/repo/dispatch.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { resolveClientQuestion } from "../../src/platform/tools/client.js";
import { ensureOrg } from "../../src/platform/runtime/org.js";

const T0 = 1_700_000_000_000;
let db: Database.Database;
let pmId: string;

beforeEach(() => {
  db = openPlatformMemoryDb();
  runMigrations(db);
  ensureOrg(db, T0);
  // ⚠️ **从库里读,不在测试里另抄一份 id 表**(AGENTS.md:角色属性只有一处真相)
  pmId = (db.prepare(`SELECT id FROM agents WHERE role = 'project_manager'`).get() as
    { id: string }).id;
  insertProject(db, {
    id: "p1", name: "单报告合并版", client: "个人用户",
    goal: "把七份报告合成一份", status: "active", createdAt: T0,
  });
  // ⚠️ **花名册来自 `project_assignments`,不是 `agents`**(`loadProjectRoster` 的 SQL)。
  // 少了这一步 `q.members` 是空的,而规则的第一行就是「找不到 pm 就返回 []」——
  // 那会让所有依赖项目经理的规则**静默不产待办**,而测试看起来只是「没产出」。
  for (const id of ["bm", "pm", "wk", "qa"]) addMember(db, "p1", id, T0);
});
afterEach(() => db.close());

function addWork(id: string, status: "open" | "in_progress" | "done" | "failed"): void {
  insertWork(db, {
    id, projectId: "p1", title: `工作项 ${id}`, goal: "做点事",
    status, assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
  });
}

const board = (maxAttemptsPerTodo?: number) =>
  collectTodos({ db, projectId: "p1", now: T0 + 60_000, ...(maxAttemptsPerTodo !== undefined ? { maxAttemptsPerTodo } : {}) });

const recover = () => board().runnable.filter((t) => t.kind === "recover_failed_work");

describe("① 判据:有工作项停在 failed 就叫项目经理", () => {
  it("一条 `failed` ⇒ 产出**一条** `recover_failed_work`,目标是项目经理", () => {
    addWork("w1", "open");
    addWork("w2", "failed");
    const got = recover();
    expect(got).toHaveLength(1);
    expect(got[0]!.role).toBe("project_manager");
    expect(got[0]!.agentId).toBe(pmId);
    expect(got[0]!.refs).toEqual(["w2"]);
  });

  it("⚠️ 负样本:没有 `failed` 时**一条都不产出**", () => {
    addWork("w1", "open");
    addWork("w2", "in_progress");
    addWork("w3", "done");
    addWork("w4", "cancelled");
    expect(recover()).toEqual([]);
  });

  it("⚠️ 负样本:只读 `status` —— 不读正文、不猜「失败原因」", () => {
    // `works` 表**没有**「为什么失败」那一列。这条钉住判据不越过结构化的列:
    // 哪怕工作项标题里写着「失败」「error」,也不该被算成 failed。
    addWork("w1", "open");
    db.prepare(`UPDATE works SET title = '这个失败了 error' WHERE id = 'w1'`).run();
    expect(recover()).toEqual([]);
  });

  it("多条 `failed` ⇒ 仍是**一条**待办,refs 收全部(集合谓词)", () => {
    addWork("w1", "failed");
    addWork("w2", "failed");
    addWork("w3", "open");
    const got = recover();
    expect(got).toHaveLength(1);
    expect(got[0]!.refs).toEqual(["w1", "w2"]);
  });
});

describe("② 终止判据:处置掉之后规则自动安静", () => {
  it("PM 把失败的那条关掉 ⇒ 判据不成立 ⇒ 没有待办", () => {
    addWork("w1", "failed");
    expect(recover()).toHaveLength(1);
    updateWorkStatus(db, "w1", "cancelled", T0 + 30_000);
    // ⚠️ 这一条是「不会一直骚扰 PM」的保证:key 是**集合谓词**
    // (`recover_failed_work:<排序后的 id 串>`),集合清空 ⇒ 待办消失。
    expect(recover()).toEqual([]);
  });

  it("处置掉**一条** ⇒ 集合缩小 ⇒ key 变 ⇒ 预算重新算(不是拿旧的继续扣)", () => {
    addWork("w1", "failed");
    addWork("w2", "failed");
    const before = recover()[0]!.key;
    updateWorkStatus(db, "w1", "cancelled", T0 + 30_000);
    const after = recover()[0]!;
    expect(after.key).not.toBe(before);
    expect(after.refs).toEqual(["w2"]);
  });
});

describe("③ 不重跑:目标是项目经理,不是 worker", () => {
  it("kind 是 `recover_failed_work` 而不是 `execute_work`", () => {
    addWork("w1", "failed");
    const kinds = board().runnable.map((t) => t.kind);
    // ⚠️ `execute_work` **不会**捡 `failed`(`myOpenWorks` 只要 open|in_progress),
    // 所以这条待办的唯一内容就是「叫人来重新划范围」。如果哪天它变成了
    // `execute_work`,那就是「原样重跑」—— 那会同样超时。
    expect(kinds).toContain("recover_failed_work");
    expect(kinds).not.toContain("execute_work");
  });

  it("任务正文讲清「不要原样重跑」并给出可用的动词", () => {
    addWork("w1", "failed");
    const todo = recover()[0]!;
    // 渲染现场走 `renderTask`,这里断言它**能被渲染出来**且提到关键动作。
    // ⚠️ 措辞不在这里钉死(它会随提示词调整),钉的是「不是一句空话」。
    expect(todo.label).toContain("失败");
    expect(todo.label).toContain("1 条");
  });
});

describe("④ 预算到界:不静默停", () => {
  it("尝试预算耗尽后从 `runnable` 移到 `exhausted`", () => {
    addWork("w1", "failed");
    // maxAttempts = 1 ⇒ 叫过一次之后预算走完。
    // 判据仍然成立(工作项还是 failed),所以它**必须**出现在 exhausted 里,
    // 而不是从待办里消失 —— 消失 = 静默停。
    const first = collectTodos({ db, projectId: "p1", now: T0 + 60_000, maxAttemptsPerTodo: 1 });
    expect(first.runnable.filter((t) => t.kind === "recover_failed_work")).toHaveLength(1);
  });

  it("`exhausted` 里的那条带得动人的 label —— 公告文案就靠它", () => {
    addWork("w1", "failed");
    const b = board(1);
    // 预算是 0 次时它就已经 exhausted 了(见 collectTodos 的 attempts >= max 判定)。
    const ex = b.exhausted.filter((t) => t.kind === "recover_failed_work");
    for (const t of ex) {
      expect(t.label.length, "公告文案要能读懂,不能是空串或一个 key")
        .toBeGreaterThan(4);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑤ 等甲方时不再追加新的交代回合(2026-10-07 真机:三连问)
// ══════════════════════════════════════════════════════════════════

/**
 * 真机现场:一个**已经 `done`、交付物也验收过**的项目,业务经理在 20 分钟里连问
 * 甲方三件 —— `09:03:42` / `09:03:59`(相隔 **17 秒**)/ `09:13:38`。
 * 而 `ask_client` **没有任何合并窗口**(`report_downstream` 自己有「攒够 N 条或等 T」,
 * 提问那条没有)。
 *
 * ⇒ 机制这一层拦的是「球在甲方那边时又被叫醒」;**一轮里问两件**要靠提示词。
 */
describe("⑥ 球在甲方那边时,不再追加新的交代回合", () => {
  /**
   * 建一条未答复的提问 = 球在甲方那边。
   *
   * ⚠️ **`question_artifact_id` 有外键指向 `artifacts`**(migration 020),所以
   * 不能随手塞一个 id —— 那样测试会挂在 FOREIGN KEY 上,而不是挂在判据上。
   * 走真实工件 ⇒ 外键满足,而且这条提问在界面上**真的会出现**。
   */
  const askClient = (): void => {
    insertArtifact(db, {
      id: "q_t1", projectId: "p1", kind: "client_question", status: "open",
      authorAgentId: "bm", title: "整合报告这件事,现在算交付了吗?",
      body: "候选 A/B/C", createdAt: T0 + 10_000, updatedAt: T0 + 10_000,
    });
    db.prepare(
      `INSERT INTO client_questions (question_artifact_id, project_id, asked_by, asked_at)
       VALUES ('q_t1', 'p1', 'bm', ?)`,
    ).run(T0 + 10_000);
  };

  it("有未答复提问时,`report_downstream` **不产出**待办", () => {
    addWork("w1", "done");
    // ⚠️ **要攒够 3 条**(`--report-batch-size` 默认 3):`report_downstream` 有
    // 合并窗口,1 条 + 不到 5 分钟 ⇒ 判据不成立 ⇒ 下面那条正样本会**因为
    // 别的原因**一直空(夹具不够),而测试照样绿。
    for (let i = 0; i < 3; i++) {
      insertDispatchEvent(db, {
        projectId: "p1", kind: "work_done", subjectId: "w1",
        summary: `一条完成了 ${i}`, createdAt: T0 + 20_000,
      });
    }
    // ⚠️ **先断言「没有提问时确实会产出」** —— 否则下面那条可能因为别的原因
    // 一直空(夹具建错、事件类型不对),而测试照样绿。
    expect(board().runnable.some((t) => t.kind === "report_downstream")).toBe(true);

    askClient();
    expect(
      board().runnable.some((t) => t.kind === "report_downstream"),
      "球在甲方那边时不该再追加交代",
    ).toBe(false);
  });

  it("⚠️ **抑制不是丢弃**:那行 outbox 仍未被消费,答复后会一起交代", () => {
    addWork("w1", "done");
    // ⚠️ **要攒够 3 条**(`--report-batch-size` 默认 3):`report_downstream` 有
    // 合并窗口,1 条 + 不到 5 分钟 ⇒ 判据不成立 ⇒ 下面那条正样本会**因为
    // 别的原因**一直空(夹具不够),而测试照样绿。
    for (let i = 0; i < 3; i++) {
      insertDispatchEvent(db, {
        projectId: "p1", kind: "work_done", subjectId: "w1",
        summary: `一条完成了 ${i}`, createdAt: T0 + 20_000,
      });
    }
    askClient();
    board(); // 跑一次,模拟排空器查过
    const row = db.prepare(
      `SELECT consumed_at FROM dispatch_events WHERE project_id = 'p1' AND kind = 'work_done'`,
    ).get() as { consumed_at: number | null };
    // `pruneAttempts` 只动预算账本;`consumed_at` 是**消费**侧,归 `markConsumed`。
    // 这条钉的是「抑制期间它没有被消费掉」—— 丢了就再也交代不出去了。
    expect(row.consumed_at, "被抑制的那行必须留在库里,否则甲方答复后就消失了").toBeNull();
  });

  it("甲方答复之后(球回来),交代待办重新成立", () => {
    addWork("w1", "done");
    // ⚠️ **要攒够 3 条**(`--report-batch-size` 默认 3):`report_downstream` 有
    // 合并窗口,1 条 + 不到 5 分钟 ⇒ 判据不成立 ⇒ 下面那条正样本会**因为
    // 别的原因**一直空(夹具不够),而测试照样绿。
    for (let i = 0; i < 3; i++) {
      insertDispatchEvent(db, {
        projectId: "p1", kind: "work_done", subjectId: "w1",
        summary: `一条完成了 ${i}`, createdAt: T0 + 20_000,
      });
    }
    askClient();
    expect(board().runnable.some((t) => t.kind === "report_downstream")).toBe(false);
    // 球回到业务经理这边。
    // ⚠️ **走真实答复路径**(`resolveClientQuestion`),不手改 `client_questions.answered_at`。
    // 因为 `awaitingClient` 读的是**工件 `status`**(`client_question` + `open`),
    // 只改 `answered_at` 的话判据仍然成立 —— 那个测试会**因为夹具走偏**而红,
    // 而它要钉的其实是「球回来之后能不能继续交代」。
    resolveClientQuestion(db, "q_t1", "A —— 已经看过了", T0 + 60_000, {
      newId: (p: string) => `${p}_ans`, answeredByAgentId: "bm",
    });
    expect(
      board().runnable.some((t) => t.kind === "report_downstream"),
      "球回来之后必须能继续交代 —— 否则被抑制的行永远出不来",
    ).toBe(true);
  });
});
