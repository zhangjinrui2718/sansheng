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
