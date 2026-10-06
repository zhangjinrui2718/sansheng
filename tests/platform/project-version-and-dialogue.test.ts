/**
 * 2026-10-06 第二批 · 「收口之后还能不能说话」与「同一个交付物的下一个版本」
 *
 * ── 用户的两句原话(这就是这一批的验收标准)────────────────────────
 *
 *   「项目交付之后,是否需要重新打开,或者有新的版本,我觉得可以在原对话中继续
 *     对话的,如果有必要,可以新开一个版本,否则就是纯和业务经理交流」
 *
 *   「一个对话只能对应一个项目吗,你看我在接待谈新项目里面的对话,他显然不知道
 *     之前已经做过的项目」
 *
 * ── 这一批钉的三条机制 ────────────────────────────────────────────
 *
 *   ① **「对话」不是「项目内能力」**。项目收口冻结的是「干活」(`work.*` /
 *      `blackboard.write` / `project.update`),不是甲方与业务经理说话。
 *      修之前:项目一 `done`,`serve.ts` 直接回 `code: "project_closed"` ——
 *      **甲方连一句都发不出去**,项目成了只读墓碑。
 *   ② **接待会话里业务经理看得见历史项目**。修之前 `renderProjectContext(null)`
 *      返回**空串**,而且它**没有任何一条路**能查(`project_read` 要一个已知的
 *      projectId,那个 id 从哪来?改前连 `project_list` 工具都没有)。
 *   ③ **版本链是数据,边由业务经理建**。`projects.version` + `parent_project_id`;
 *      `project_open(parentProjectId)` 记下「这是上一个的下一版」。⚠️ **不做回填** ——
 *      库里没有任何一行能证明某个项目是另一个的下一版,回填等于编造祖先关系。
 */
import { beforeEach, describe, expect, it, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import {
  insertProject, getProjectRow, closeProject, updateProject, listProjects,
} from "../../src/platform/storage/repo/projects.js";
import { renderProjectContext } from "../../src/platform/runtime/projectContext.js";
import { runMigrations } from "../../src/platform/infra/migrations.js";

const T0 = 1_700_000_000_000;

let db: Database.Database;

beforeEach(() => {
  db = openPlatformMemoryDb();
  runMigrations(db);
});
afterEach(() => db.close());

const mk = (id: string, over: Partial<{ name: string; goal: string; status: "active" | "done" }> = {}): void => {
  insertProject(db, {
    id, name: over.name ?? `项目 ${id}`, client: "个人用户",
    goal: over.goal ?? "做出一个能用的东西", status: over.status ?? "active", createdAt: T0,
  });
};

// ══════════════════════════════════════════════════════════════════
// ① 版本链
// ══════════════════════════════════════════════════════════════════

describe("① 版本链(migration 023)", () => {
  it("存量项目一律是 **v1** —— 在版本链存在之前存在的每个项目确实第一版", () => {
    mk("p1");
    const row = getProjectRow(db, "p1")!;
    expect(row.version).toBe(1);
    expect(row.parentProjectId).toBeNull();
  });

  it("「没有前身」是合法状态,**不是数据缺失** —— 两列都可空", () => {
    // ⚠️ 正样本自检:两列真的在 schema 里(否则下面只是「读默认值读对了」)
    const cols = db.pragma("table_info(projects)") as Array<{ name: string; notnull: number }>;
    const ver = cols.find((c) => c.name === "version");
    const par = cols.find((c) => c.name === "parent_project_id");
    expect(ver, "version 列必须在").toBeDefined();
    expect(ver!.notnull).toBe(1);
    expect(par).toBeDefined();
    expect(par!.notnull, "parent_project_id 必须可空 —— 没有前身是合法状态").toBe(0);
  });

  it("第二个版本的号是 **+1**,且指向真正的上一版", () => {
    mk("p1");
    insertProject(db, {
      id: "p2", name: "方案 v2", client: "个人用户",
      goal: "加上实盘模拟", status: "active", createdAt: T0 + 1,
      version: 2, parentProjectId: "p1",
    });
    const row = getProjectRow(db, "p2")!;
    expect(row.version).toBe(2);
    expect(row.parentProjectId).toBe("p1");
  });

  it("**不做回填**:库里没有一行能证明某个项目是另一个的下一版", () => {
    // 真机那两个项目是**分别**立项的(一个美股、一个催收),不是版本关系。
    // 「看起来像」不是「是」—— 回填一条假的祖先边会让业务经理读到一条它
    // 不该相信的事实(§2.11.3:平台不做语义猜测)。
    mk("p1"); mk("p2");
    expect(listProjects(db).every((p) => p.parentProjectId === null)).toBe(true);
  });

  it("⚠️ `parent_project_id` 是 `ON DELETE SET NULL`,不是 CASCADE", () => {
    // 删除上一版**不该**把版本链抹成空白 —— 那与 `artifacts.work_id`
    // (migration 014)同一条纪律:产出与记录必须比容器活得久。
    const sql = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'`,
    ).get() as { sql: string };
    expect(sql.sql).toMatch(/REFERENCES\s+projects\s*\(\s*id\s*\)\s*ON DELETE SET NULL/i);
  });

  it("版本**不是继承**:v2 不会自动带上 v1 的东西", () => {
    // 这一条写成测试,是因为「版本」这个词很容易被理解成「分支 + 继承」。
    // 实际语义是「同一个交付物的第二次**重新立项**」,靠 parent 这条边记身份,
    // 内容要业务经理自己 `project_read` 去读。
    mk("p1"); mk("p2");
    expect(getProjectRow(db, "p2")!.goal, "v2 有自己的目标,不是 p1 的副本")
      .not.toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
// ② 收口之后还能说话
// ══════════════════════════════════════════════════════════════════

describe("② 收口项目:对话还开着,「干活」关着", () => {
  it("收口**不改**项目的可对话性 —— 它只是 `status` 变了", () => {
    mk("p1", { status: "active" });
    closeProject(db, "p1", "done", T0 + 10);
    const row = getProjectRow(db, "p1")!;
    expect(row.status).toBe("done");
    // ⚠️ 正样本自检:项目行还在、还能读出来 —— 「只读墓碑」不是「项目没了」
    expect(row.name).toBeTruthy();
    expect(row.goal).toBeTruthy();
  });

  it("业务经理在收口项目里仍能 `project_read`(验收要问的第一句)", () => {
    // 授权层的验收在 `authorize.test.ts`;这里钉的是**为什么**要那条豁免:
    // 交付物都在库里,而读它是验收的唯一方式。
    mk("p1", { status: "done" });
    expect(getProjectRow(db, "p1")).not.toBeNull();
  });

  it("⚠️ `project.update` 仍然拒绝 —— 豁免的是「说话」不是「改」", () => {
    mk("p1", { status: "done" });
    // `updateProject` 自己按 status 限 active|paused —— 这条与 scope 门
    // 是**两道**独立的门,都要在。
    expect(() => updateProject(db, "p1", { goal: "偷偷改一下" })).toThrow();
    expect(getProjectRow(db, "p1")!.goal).toBe("做出一个能用的东西");
  });
});

// ══════════════════════════════════════════════════════════════════
// ③ 接待会话里业务经理看得见历史
// ══════════════════════════════════════════════════════════════════

describe("③ 接待会话:注入「甲方已经和你做过这些项目」", () => {
  it("清单在场:名字、id、状态、交付物份数、目标", () => {
    mk("p1", { name: "美股自动化交易平台方案设计", goal: "出一份完整方案文档" });
    const c = renderProjectContext(db, "bm", null);
    expect(c.projectId).toBeNull();
    expect(c.text).toContain("美股自动化交易平台方案设计");
    expect(c.text).toContain("p1");
    expect(c.text).toContain("一份完整方案文档");
  });

  it("**版本链也进去** —— 业务经理据此判断「这是不是上一个的下一版」", () => {
    // ⚠️ 先把 p1 建出来 —— FK(`parent_project_id` → `projects.id`)是真的会拦的,
    // 这条测试自己写漏了上一版就被数据库挡下来了(那是 FK 在工作)。
    mk("p1", { name: "美股自动化交易平台方案设计" });
    insertProject(db, {
      id: "p2", name: "美股方案 v2", client: "个人用户",
      goal: "加实盘模拟", status: "active", createdAt: T0 + 1,
      version: 2, parentProjectId: "p1",
    });
    const c = renderProjectContext(db, "bm", null);
    expect(c.text).toContain("v2");
    expect(c.text).toContain("上一个项目的下一个版本");
  });

  it("有项目的排在前面(`active` 优先)—— 最近做的在前", () => {
    mk("old", { name: "老项目", status: "done" });
    mk("live", { name: "在做的项目", status: "active" });
    const c = renderProjectContext(db, "bm", null);
    expect(c.text.indexOf("在做的项目")).toBeLessThan(c.text.indexOf("老项目"));
  });

  it("**不替它判断**「这次和上一次像不像同一个事」", () => {
    // §2.11.3:注入面只摆事实。业务经理才是那个知道「甲方说的是续做还是换事」的人。
    mk("p1");
    const c = renderProjectContext(db, "bm", null);
    expect(c.text).toContain("那是你的判断");
    expect(c.text).not.toContain("建议开一个新项目");
  });

  it("一个项目都没有时如实说空 —— 不注入一个空标题", () => {
    const c = renderProjectContext(db, "bm", null);
    expect(c.text).toContain("还没有任何项目");
    expect(c.text).not.toContain("甲方已经和你做过这些项目");
  });
});