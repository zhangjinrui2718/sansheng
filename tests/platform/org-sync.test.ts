/**
 * 组织对齐:新增角色必须能进入**已存在的项目**(2026-10-08,加 `coding_worker` 时发现)
 *
 * ── 这一条盯的是什么 ────────────────────────────────────────────
 *
 * `ensureOrg` 管的是「组织里有哪几个人」,`ensureProjectOrg` 管的是「谁在哪个项目里」。
 * 后者此前**只在立项那一刻跑一次** —— 于是「新增一个角色」对存量项目是
 * **结构性不发生**的:
 *
 *   · `cw` 会被建出来(组织级),但它不是任何已存在项目的成员
 *   · `buildToolContext` 对非成员返回 `agent_not_assigned` ⇒ 会话建不出来
 *   · 项目经理 `work_create(assigneeRole='coding_worker')` 撞上
 *     「项目里没有这个角色的成员」⇒ 编码工**永远不会被派活**
 *
 * 而成员页列出的是「这个项目里有谁」—— 少的那个角色只是不出现,
 * 看起来和「还没派到它」**一模一样**。这是 7-E 的又一次现身:
 * 声明(code 里有这个角色)与读者(项目成员表)之间断了。
 *
 * 所以本测试带**两个方向的判据**:
 *   ① 缺席的人要被补进来(否则新角色是死的);
 *   ② **被移出的人不许被复活**(否则「用户表过的态」会在下次启动时被静静撤销)。
 * 只有 ① 的话,一个「无脑 addMember」的实现会全绿。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent, listAgents } from "../../src/platform/storage/repo/agents.js";
import {
  insertProject, addMember, removeMember, loadProjectRoster,
} from "../../src/platform/storage/repo/projects.js";
import {
  ORG, ensureOrg, ensureProjectOrg, syncOrgForExistingProjects, roleDisplayName, pickWorker,
} from "../../src/platform/runtime/org.js";
import { PROJECT_ROLES, EXECUTOR_ROLES, isExecutorRole } from "../../src/platform/identity/role.js";

let db: Database.Database;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
});
afterEach(() => db.close());

/** 只播种**旧的四个人**(模拟 025 之前的库)。 */
function seedLegacyOrg(): void {
  for (const m of ORG.filter((o) => o.id !== "cw")) {
    insertAgent(db, {
      id: m.id, role: m.role, specialization: m.spec, displayName: m.name, createdAt: T0,
    });
  }
}

describe("组织对齐 · 新增角色必须能进入已存在的项目", () => {
  it("ORG 与 PROJECT_ROLES 逐项对齐(五个角色,两个执行角色)", () => {
    expect([...ORG].map((m) => m.role).sort()).toEqual([...PROJECT_ROLES].sort());
    expect(ORG.length).toBe(5);
    expect(EXECUTOR_ROLES.length).toBe(2);
    // 正样本自检:名字都在(空表会让上面那圈空转)
    expect(roleDisplayName("research_worker")).toBe("研究员");
    expect(roleDisplayName("coding_worker")).toBe("工程师");
  });

  it("**正样本**:存量项目在启动对齐之后长出编码工成员", () => {
    seedLegacyOrg();
    insertProject(db, { id: "pj_1", name: "老项目", client: "甲方", goal: "g", status: "active", createdAt: T0 });
    // 老库的形态:四个人都在项目里,没有 cw —— 而且 agents 表里也没有 cw 这一行
    for (const m of ORG.filter((o) => o.id !== "cw")) addMember(db, "pj_1", m.id, T0);

    const before = loadProjectRoster(db, "pj_1").map((r) => r.id);
    expect(before).not.toContain("cw");

    // 启动路径的两步(serve.ts 就是按这个顺序调它们)
    ensureOrg(db, T0);
    const lines = syncOrgForExistingProjects(db, T0);

    expect(lines.length, "补齐必须**如实报出来**,不能静默").toBeGreaterThan(0);
    const after = loadProjectRoster(db, "pj_1").map((r) => r.id);
    expect(after).toContain("cw");
    // 幂等:再跑一次,什么都不该发生
    expect(syncOrgForExistingProjects(db, T0)).toEqual([]);
  });

  it("**负样本**:被移出项目的人**不许被复活**(用户表过的态不该被启动时撤销)", () => {
    seedLegacyOrg();
    ensureOrg(db, T0);
    insertProject(db, { id: "pj_1", name: "老项目", client: "甲方", goal: "g", status: "active", createdAt: T0 });
    for (const m of ORG) addMember(db, "pj_1", m.id, T0);
    // 用户明确把研究工移出这个项目
    removeMember(db, "pj_1", "wk", T0 + 1);
    expect(loadProjectRoster(db, "pj_1").map((r) => r.id)).not.toContain("wk");

    syncOrgForExistingProjects(db, T0 + 2);

    expect(
      loadProjectRoster(db, "pj_1").map((r) => r.id),
      "无脑 addMember 会把「移出」这个动作在下次启动时静静撤销 —— 这正是本条要挡的",
    ).not.toContain("wk");
  });

  it("`ensureProjectOrg` 的直接判据:一行都没有才加,有行(哪怕是旧的移除行)就不碰", () => {
    seedLegacyOrg();
    ensureOrg(db, T0);
    insertProject(db, { id: "pj_1", name: "p", client: "甲方", goal: "g", status: "active", createdAt: T0 });
    addMember(db, "pj_1", "wk", T0);
    removeMember(db, "pj_1", "wk", T0 + 1);

    const added = ensureProjectOrg(db, "pj_1", T0 + 2);
    expect(added).not.toContain("wk(入项目)");
    // 其余四个是「一行都没有」→ 必须被加进来
    expect(added).toContain("bm(入项目)");
    expect(loadProjectRoster(db, "pj_1").map((r) => r.id).sort()).toEqual(["bm", "cw", "pm", "qa"]);
  });

  it("`pickWorker` 只能挑到**执行角色** —— 派错人的代价是那条工作项永远不会被跑", () => {
    ensureOrg(db, T0);
    // 不指定时按 EXECUTOR_ROLES 的顺序取第一个在手的人
    const first = pickWorker(db);
    expect(first).not.toBeNull();
    expect(isExecutorRole(first!.role)).toBe(true);
    expect(first!.role).toBe(EXECUTOR_ROLES[0]);

    // 指定 id:执行角色 → 拿到;非执行角色(项目经理)→ null,而不是「随便挑一个」
    expect(pickWorker(db, "cw")?.role).toBe("coding_worker");
    expect(pickWorker(db, "pm")).toBeNull();
    expect(pickWorker(db, "bm")).toBeNull();
    expect(pickWorker(db, "不存在")).toBeNull();
  });

  it("`ensureOrg` 会把**已知角色的显示名与角色拉齐**(改名之后库里不许留旧名)", () => {
    // 真机形态:026 把 `wk` 的角色改成研究工之后,库里那一行的 `display_name`
    // 还停在「工程师」 —— 成员页照库里的显示,与 ORG / 前端兜底表**当场漂开**,
    // 而没有任何检查会红(这正是 role-names 那份测试存在的原因)。
    insertAgent(db, { id: "wk", role: "research_worker", specialization: "engineering", displayName: "工程师", createdAt: T0 });
    const created = ensureOrg(db, T0);
    expect(created, "校准也要如实报出来(幂等不等于静默)").toContain("wk(校准为 研究员/research_worker)");
    expect(listAgents(db).find((a) => a.id === "wk")?.displayName).toBe("研究员");
    // 幂等:再跑一次什么都不做
    expect(ensureOrg(db, T0)).toEqual([]);
  });
});
