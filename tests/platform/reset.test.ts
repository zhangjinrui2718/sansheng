/**
 * 数据重置的守卫 —— **两份判据,缺一不可**(2026-10-05 补,此前只写在注释里)
 *
 * ── 为什么这份文件现在才存在 ────────────────────────────────────
 *
 * `src/platform/host/reset.ts` 的文件头**曾经声称**「有一个测试断言清单覆盖所有
 * 平台表(见 `tests/platform/reset.test.ts`)」,而 `git log --all` 里从来没有这个
 * 文件 —— **注释里的守卫是假的**。代价在真机上量了出来:
 *
 *   · migration 013 的 `dispatch_events` / `dispatch_attempts` 与 018 的
 *     `turn_usage` 都不在 `PLATFORM_DATA_TABLES` 里;
 *   · `turn_usage.agent_id → agents(id)` 是 **NO ACTION** ⇒ 库里有 usage 行时,
 *     删到 `agents` 那一步 `FOREIGN KEY constraint failed`;
 *   · 重置是**一个事务** ⇒ 整体回滚 ⇒ **一行都没清**,接口 500。
 *
 * 现场:`.probe/`(W3 的 500 复现)与 `~/.sansheng` 的真实库(9 行 `turn_usage`)。
 *
 * ── 两条判据 ────────────────────────────────────────────────────
 *
 * ① **覆盖**(静态):`sqlite_master` 里的每一张表都必须落在
 *    `PLATFORM_DATA_TABLES`(要被清)或 `NON_RESET_TABLES`(明确不清)里。
 *    加表时漏登记 ⇒ 这里红。
 * ② **行为**(动态):在一个**真形状**的库上(每张平台表都有行,含 `turn_usage`
 *    与两张 dispatch 表)真的跑一次 `resetPlatformData`,断言:
 *    不抛、清单里的表全 0 行、`schema_version` 不动。
 *    —— ①能过而②不过,正是上面那次事故的形状(清单"看起来"全,顺序/闭集错)。
 *
 * ⚠️ **两条检查都自带正负样本**:①用一张临时表证明「漏登记真的会被点名」;
 * ②先断言夹具真的把行写进去了(否则「清空后为 0」在空库上也成立,是空转)。
 * 本项目三类静默失败之一就是「检查本身返回一个看起来正常的错误答案」。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import {
  PLATFORM_DATA_TABLES, NON_RESET_TABLES, resetPlatformData,
} from "../../src/platform/host/reset.js";
import { insertAgent, listAgents } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { recordClientQuestion } from "../../src/platform/storage/repo/clientQuestions.js";
import { insertReviewVerdict } from "../../src/platform/storage/repo/reviewVerdicts.js";
import { insertSession, appendSessionMessage } from "../../src/platform/storage/repo/sessions.js";
import { insertDispatchEvent, bumpAttempt } from "../../src/platform/storage/repo/dispatch.js";
import { insertTurnUsage } from "../../src/platform/storage/repo/usage.js";
import { insertBlocker } from "../../src/platform/storage/repo/blockers.js";
import { insertChange } from "../../src/platform/storage/repo/changes.js";
import { insertAsk } from "../../src/platform/storage/repo/asks.js";
import { insertMeeting } from "../../src/platform/storage/repo/meetings.js";
import { blockWork } from "../../src/platform/storage/repo/blockers.js";
import { affectWork } from "../../src/platform/storage/repo/changes.js";
import { addDep } from "../../src/platform/storage/repo/works.js";
import { addArtifactLink } from "../../src/platform/storage/repo/artifacts.js";
import { SqliteMemory } from "../../src/platform/memory/sqliteMemory.js";

let db: Database.Database;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
});
afterEach(() => {
  db.close();
});

/** 库里**所有**表(排除 sqlite 自己的内部表)。 */
function allTables(): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/** ① 的判据本体(导出形态便于正样本自检)。 */
function uncoveredTables(names: readonly string[]): string[] {
  const known = new Set([...PLATFORM_DATA_TABLES, ...NON_RESET_TABLES]);
  return names.filter((n) => !known.has(n));
}

describe("① 覆盖差集:清单必须覆盖库里每一张表", () => {
  it("正样本:空库(只有 migration 建的表)全部被登记", () => {
    const missing = uncoveredTables(allTables());
    expect(missing, `漏登记的:${missing.join(", ")}`).toEqual([]);
    // 非空自检:这条断言不是在空数组上空转 —— 迁移确实建了表
    expect(allTables().length).toBeGreaterThan(15);
    expect(PLATFORM_DATA_TABLES).toContain("turn_usage");
    expect(PLATFORM_DATA_TABLES).toContain("dispatch_events");
    expect(PLATFORM_DATA_TABLES).toContain("dispatch_attempts");
  });

  it("负样本:新加一张表而忘了登记 ⇒ **必须被点名**(否则这条检查没有牙)", () => {
    db.exec(`CREATE TABLE nazgul_test_stray (id TEXT PRIMARY KEY)`);
    const missing = uncoveredTables(allTables());
    expect(missing, "临时表必须出现在漏登记名单里").toEqual(["nazgul_test_stray"]);
  });

  it("清单里没有重复项(重复删除是无害的,但重复意味着有人手抄错了)", () => {
    const dup = PLATFORM_DATA_TABLES.filter((t, i) => PLATFORM_DATA_TABLES.indexOf(t) !== i);
    expect(dup).toEqual([]);
  });
});

/**
 * 造一个**真形状**的库:每张平台表都有行。
 *
 * 走仓储(invariant 与生产同形),而不是裸 SQL —— 裸 SQL 会绕开闭集校验,
 * 于是「重置失败」可能被夹具自身的形状掩盖。两处例外在下面各自标注了理由
 * (`memory_profile` 没有仓储,`turn_usage` 的边界说明在 `usage.ts`)。
 */
async function seedEverything(): Promise<{ project: string; work: string; agent: string }> {
  const agent = "ag_test";
  const reviewer = "ag_reviewer";
  const project = "pj_test";
  const root = "wk_root";
  const child = "wk_child";
  for (const [id, role, name] of [
    [agent, "business_manager", "业务经理"],
    [reviewer, "quality_reviewer", "质检"],
  ] as const) {
    insertAgent(db, { id, role, specialization: null, displayName: name, createdAt: NOW });
  }
  insertProject(db, {
    id: project, name: "P", client: "甲方", goal: "G", status: "active", createdAt: NOW,
  });
  addMember(db, project, agent, NOW);
  addMember(db, project, reviewer, NOW);
  insertWork(db, {
    id: root, projectId: project, parentWorkId: null, title: "T", goal: "G",
    status: "done", reviewState: "done", assigneeAgentId: agent,
    createdAt: NOW, updatedAt: NOW,
  });
  insertWork(db, {
    id: child, projectId: project, parentWorkId: root, title: "T2", goal: "G2",
    status: "open", assigneeAgentId: reviewer, createdAt: NOW, updatedAt: NOW,
  });
  // work_deps:root 依赖 child(反向也合法,只要不成环)
  const dep = addDep(db, root, child);
  if (!dep.ok) throw new Error(`夹具的 work_deps 没写进去:${dep.reason}`);

  insertArtifact(db, {
    id: "art_test", projectId: project, conversationId: null, kind: "evidence",
    status: "open", authorAgentId: agent, title: "A", body: "B",
    metadataJson: null, createdAt: NOW, updatedAt: NOW, workId: root,
  });
  insertArtifact(db, {
    id: "art_test2", projectId: project, conversationId: null, kind: "note",
    status: "open", authorAgentId: agent, title: "A2", body: "B2",
    metadataJson: null, createdAt: NOW, updatedAt: NOW, workId: null,
  });
  const link = addArtifactLink(db, "art_test", "depends_on", "art_test2");
  if (!link.ok) throw new Error(`夹具的 artifact_links 没写进去:${link.reason}`);

  // 提问工件 + 它的台账行(020)。`question_artifact_id` 有外键指向 `artifacts`,
  // 所以工件必须先在 —— 顺序反了这里会撞 FOREIGN KEY(而那正是本测试要防的那类
  // 「外键安全顺序」问题,自己先犯一次很愚蠢)。
  insertArtifact(db, {
    id: "q_test", projectId: project, conversationId: null, kind: "client_question",
    status: "open", authorAgentId: agent, title: "问甲方", body: "问什么",
    metadataJson: null, createdAt: NOW, updatedAt: NOW, workId: null,
  });
  // ⚠️ 只登记提问、**不**写答复:答复行带 `answer_artifact_id`(外键指 `artifacts`),
  // 而这张夹具要防的是「`client_questions` 整张表漏登记」—— 那会让「重置」在
  // 有提问记录的库上直接 500。走仓储而不是裸 SQL:它是这条记录唯一的生产写口。
  recordClientQuestion(db, {
    questionArtifactId: "q_test", projectId: project, askedBy: agent, askedAt: NOW,
  });

  // review_verdicts(021):一条 `fail`。**选 fail 不选 pass** —— 那正是事故现场
  // 的形状(质检判了不通过),而 `pass` 那条会让这张表在夹具里看不出任何问题。
  // `finding_artifact_id` 留空:它对 `artifacts` 是 NO ACTION,留空才不把夹具
  // 绑在工件上(工件上面已经被别的测试用掉了)。
  insertReviewVerdict(db, {
    workId: root, projectId: project, verdict: "fail", severity: "medium",
    findingArtifactId: null, note: "夹具:判不通过", reviewedBy: reviewer, createdAt: NOW,
  });

  insertSession(db, { id: "s_test", projectId: project, createdAt: NOW });
  appendSessionMessage(db, {
    id: "m_test", sessionId: "s_test", agentId: agent, kind: "assistant",
    content: "c", createdAt: NOW, originSource: "turn", triggerKind: "todo",
  });
  insertBlocker(db, {
    id: "bl_test", projectId: project, raisedByAgentId: agent, title: "B",
    detail: "d", severity: "high", status: "open", createdAt: NOW,
    resolvedAt: null, resolution: null,
  });
  // blocker_blocks:阻塞挂到工作项上(否则这张边表在夹具里是空的)
  blockWork(db, "bl_test", child);
  insertChange(db, {
    id: "ch_test", projectId: project, title: "C",
    rationale: "r", impactJson: null, status: "proposed",
    decidedByAgentId: null, createdAt: NOW, decidedAt: null,
  });
  // change_affects:变更的影响面(同上)
  affectWork(db, "ch_test", child);
  // ⚠️ `insertAsk` 拒收「向自己提问」⇒ 这里用第二个 agent
  insertAsk(db, {
    id: "ak_test", projectId: project, fromAgentId: agent, toAgentId: reviewer,
    question: "q", hypothesis: "h", optionsJson: null, needs: null,
    createdAt: NOW, deadlineAt: null,
  });
  // meetings + meeting_participants(后者由 insertMeeting 一起写)
  insertMeeting(db, {
    id: "mt_test", projectId: project, topic: "T", agendaJson: null,
    conveningAgentId: agent, createdAt: NOW, participants: [agent, reviewer],
  });
  insertDispatchEvent(db, {
    projectId: project, kind: "work_failed", subjectId: root, summary: "s", createdAt: NOW,
  });
  bumpAttempt(db, { projectId: project, todoKey: "execute_work:wk_test", targetState: NOW, at: NOW });
  // 这条是 2026-10-05 那次 500 的直接诱因:`agent_id` 是 NO ACTION
  insertTurnUsage(db, {
    id: "u_test", projectId: project, sessionId: "s_test", agentId: agent, workId: root,
    model: null, inputTokens: 1, outputTokens: 1, cacheRead: 0, createdAt: NOW,
  });
  // ⚠️ **必须有这一条(接待会话的形状:`project_id IS NULL`)。**
  // 真机上 9 行 usage 里 **7 行是 NULL**(接待会话那几个回合 —— 产品里最早花掉的钱)。
  // 差别是决定性的:`projects` 被删时会**级联**带走有 project_id 的那几行,而
  // `project_id IS NULL` 的那批留了下来,它们的 `agent_id` 仍指着 `agents`(NO ACTION)
  // ⇒ 删 `agents` 时 FOREIGN KEY 失败 ⇒ 整个事务回滚。
  // 夹具里只放「有 project_id」的那一条时,`projects` 的级联会顺手把它清掉,
  // 于是**这条回归测试在坏掉的实现上照样绿** —— 我第一版就是这样,已实测。
  insertTurnUsage(db, {
    id: "u_intake", projectId: null, sessionId: null, agentId: agent, workId: null,
    model: null, inputTokens: 1, outputTokens: 1, cacheRead: 0, createdAt: NOW,
  });
  // memory_fragments:走端口实现(唯一写口)
  await new SqliteMemory(db, { newId: (p) => `${p}_test`, now: () => NOW }).remember({
    content: "夹具片段", kind: "fact", sourceProjectId: project,
  });
  // memory_profile:**没有仓储**,唯一的写面是 HTTP 的 `PUT /api/profile/:key` 里那段裸 SQL
  // (见 `transport/http.ts`)。这里照抄它的形状,否则这张表就只能靠路由写。
  db.prepare(
    `INSERT INTO memory_profile (id, payload_json, updated_at) VALUES (?, ?, ?)`,
  ).run("persona", JSON.stringify({ name: "三生" }), NOW);

  return { project, work: root, agent };
}

describe("② 行为:在真形状的库上真的清干净(含 turn_usage / dispatch_*)", () => {
  it("先证明夹具不是空的(否则「清空后为 0」是空转)", async () => {
    const { project } = await seedEverything();
    for (const t of PLATFORM_DATA_TABLES) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(n, `${t} 夹具必须有行`).toBeGreaterThan(0);
    }
    // 逐项确认那三张「后补」的表真的写进去了
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM turn_usage`).get() as { n: number }).n,
    ).toBeGreaterThan(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_events`).get() as { n: number }).n,
    ).toBeGreaterThan(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_attempts`).get() as { n: number }).n,
    ).toBeGreaterThan(0);
    expect(project).toBe("pj_test");
  });

  it("**回归(2026-10-05 的事故)**:有 turn_usage 行时重置不再抛 FK,且把行清光", async () => {
    await seedEverything();
    // 事故的判据:这里曾经抛 SQLITE_CONSTRAINT_FOREIGNKEY
    expect(() => resetPlatformData(db)).not.toThrow();

    for (const t of PLATFORM_DATA_TABLES) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(n, `${t} 必须被清空`).toBe(0);
    }
    // 负样本:不是「什么都没清也算过」—— 上面那一圈如果表不存在会抛,不会静默跳过
    expect(listAgents(db)).toEqual([]);
  });

  it("不该动的**不动**:`schema_version` 保留(重置数据不回退 schema)", async () => {
    await seedEverything();
    const before = db.prepare(`SELECT COUNT(*) AS n FROM schema_version`).get() as { n: number };
    expect(before.n).toBeGreaterThan(0);
    resetPlatformData(db);
    const after = db.prepare(`SELECT COUNT(*) AS n FROM schema_version`).get() as { n: number };
    expect(after.n, "migration 账本必须原样保留").toBe(before.n);
    expect(NON_RESET_TABLES).toContain("schema_version");
  });

  it("重复重置是幂等的(第二次 no-op,不抛)", async () => {
    await seedEverything();
    const first = resetPlatformData(db);
    expect(first.totalRows).toBeGreaterThan(0);
    const second = resetPlatformData(db);
    expect(second.totalRows).toBe(0);
  });
});
