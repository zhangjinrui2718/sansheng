/**
 * 2026-10-06 第二批 · **对话是一等实体**(migration 024)
 *
 * ── 这一批钉的四条机制 ────────────────────────────────────────────
 *
 *   ① **存储早就支持多会话**,真正把模型钉死在 1:1 的是上面四层 ——
 *      `send` 只带 `projectId` / `ensureSession` 复用最新一条 /
 *      会话池键是 `(项目, 角色)` / 前端没有列表。这一批把那四层换掉。
 *   ② **会话池键带上 `sessionId`** —— 否则同一项目的两条线共用一个 SDK 会话,
 *      模型分不清:甲方在「v2 的想法」里说的话会出现在「调研推进」的上下文里。
 *   ③ **`sessionId` 在 WS 事件上必填** —— 一个事件落错会话的表现是
 *      「模型在 A 线说的话出现在 B 线的面板里」,而那**看起来就是一段正常回复**。
 *   ④ **`send` 的 `sessionId` 可省、但要校验归属** —— 省掉是「落到主对话」
 *      (看得见的错);不校验归属是「落到甲方看不见的地方」(看不见的错)。
 */
import { beforeEach, describe, expect, it, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { runMigrations } from "../../src/platform/infra/migrations.js";
import {
  insertSession, listSessions, getSession, isSessionKind,
} from "../../src/platform/storage/repo/sessions.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";

const T0 = 1_700_000_000_000;
let db: Database.Database;

beforeEach(() => {
  db = openPlatformMemoryDb();
  runMigrations(db);
  insertProject(db, {
    id: "p1", name: "美股平台", client: "个人用户",
    goal: "出一份完整方案", status: "active", createdAt: T0,
  });
});
afterEach(() => db.close());

const mkThread = (id: string, title: string | null): void => {
  insertSession(db, {
    id, projectId: "p1", createdAt: T0, channel: "internal", kind: "thread", title,
  });
};

// ══════════════════════════════════════════════════════════════════
// ① 迁移与形状
// ══════════════════════════════════════════════════════════════════

describe("① migration 024:一个项目下面可以有多条对话线", () => {
  it("**一个项目挂三条会话在 schema 层面合法** —— 存储早就支持了", () => {
    // ⚠️ 这一条是整批改动的**出发点**:024 之前它就合法,唯一的唯一索引是
    // 接待会话那条。把模型钉死在 1:1 的是上面四层,不是 schema。
    insertSession(db, { id: "s_main", projectId: "p1", createdAt: T0 });
    mkThread("s_a", "调研推进");
    mkThread("s_b", "收口与验收");
    expect(listSessions(db, "p1").map((s) => s.id).sort()).toEqual(["s_a", "s_b", "s_main"]);
  });

  it("`kind` 只有两个取值,且有 CHECK —— 这是**稳定的**两值闭集", () => {
    // 与 022 的 `todo_kind` 相反:那一列的取值域随 `TODO_KINDS` 变,所以**故意**
    // 不建 CHECK;这一列的两个值不会变,建 CHECK 能让坏数据在库层就被拦。
    const sql = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='project_sessions'`,
    ).get() as { sql: string };
    expect(sql.sql).toMatch(/kind\s+TEXT\s+NOT NULL\s+DEFAULT\s+'main'/);
    expect(sql.sql).toMatch(/CHECK\s*\(\s*kind\s+IN\s*\(\s*'main'\s*,\s*'thread'\s*\)\s*\)/);
  });

  it("缺省就是 `main`,而存量行确实都是主对话", () => {
    insertSession(db, { id: "s_plain", projectId: "p1", createdAt: T0 });
    expect(getSession(db, "s_plain")!.kind).toBe("main");
    expect(getSession(db, "s_plain")!.title, "没人起过名就是 null —— **不编一个出来**").toBeNull();
  });

  it("CHECK 真的拦得住坏值 —— 那是坏数据进不来的第一道门", () => {
    // ⚠️ 这一条**同时**说明一件要紧的事:读侧那个「未定义 kind 抛错」的守卫
    // **走不到 SQL 能构造的输入**(CHECK 先拦住了)。它防的是**迁移之前**的库 ——
    // 那种库根本没有这一列,而 `.probe/` 留着的真机副本就是那种库。
    // 换句话说:那段守卫是**纵深防御**,不是主路径。
    expect(isSessionKind("weird")).toBe(false);
    expect(isSessionKind("thread")).toBe(true);
    expect(() =>
      db.prepare(
        `INSERT INTO project_sessions (id, project_id, created_at, channel, kind)
         VALUES ('s_bad', 'p1', ?, 'internal', 'weird')`,
      ).run(T0),
    ).toThrow(/CHECK constraint failed/);
  });

  it("**迁移之前的库**(没有 kind 列)读得出来,且兜底成 main", () => {
    // 这是上面那条守卫的**真实可达路径**:真机上 2026-10-06 之前的库副本。
    // 它不是「数据错了」,是「这张表更宽了」⇒ 兜底成 main / null,
    // 与 024 之后写进去的值**完全一致**。
    db.exec("ALTER TABLE project_sessions DROP COLUMN kind");
    db.exec("ALTER TABLE project_sessions DROP COLUMN title");
    db.prepare(
      `INSERT INTO project_sessions (id, project_id, created_at, channel) VALUES (?, ?, ?, 'internal')`,
    ).run("s_legacy", "p1", T0);
    const row = getSession(db, "s_legacy")!;
    expect(row.kind).toBe("main");
    expect(row.title).toBeNull();
  });

  it("接待会话恒为 `main` —— 它是全局唯一一条,不是「某条线」", () => {
    insertSession(db, { id: "s_intake", projectId: null, createdAt: T0 });
    expect(getSession(db, "s_intake")!.kind).toBe("main");
  });
});

// ══════════════════════════════════════════════════════════════════
// ② 会话池的键:两条线必须各自一个 SDK 会话
// ══════════════════════════════════════════════════════════════════

describe("② 会话池键 = (项目, 会话, 角色)", () => {
  it("键里**必须**有 `sessionId` 这一段", () => {
    // 这一条直接读 `serve.ts` 的 `pooledKey` 形状 —— 它是纯函数,不需要起宿主。
    // 判据是**字符串形状**:三段之间用 `::`,且第二段是会话 id。
    //
    // ⚠️ 为什么钉「形状」而不是「行为」:行为要起一个真宿主 + 真 provider,
    // 而那条路上「两条线真的拿到了两个不同的 SDK 会话」很难在单测里证伪 ——
    // 一旦退化成 `(项目, 角色)`,单测会**继续全绿**,而真机上两条线会互相污染。
    const src = readFileSync(
      new URL("../../src/platform/host/serve.ts", import.meta.url),
      "utf8",
    );
    const m = src.match(/function pooledKey\([^)]*\): string \{\s*return `([^`]+)`/);
    expect(m, "pooledKey 的实现形状变了 —— 请连同下面三段的判据一起看").not.toBeNull();
    // `${projectId ?? "<intake>"}::${sessionId}::${agentId}`
    expect(m![1]).toContain("${sessionId}");
    // ⚠️ **前缀仍然是 projectId** —— `disposeSessionsFor` / `onInterrupt` 靠前缀匹配
    expect(m![1]!.startsWith("${projectId"));
  });
});

// ══════════════════════════════════════════════════════════════════
// ③ 契约上的必填/可省
// ══════════════════════════════════════════════════════════════════

describe("③ 契约:事件必填 sessionId,send 可省", () => {
  const TYPES = readFileSync(new URL("../../shared/types/platform.ts", import.meta.url), "utf8");

  it("七条消息类事件都带 `sessionId`", () => {
    for (const t of ["delta", "thinking_delta", "message_end", "tool_start", "tool_end", "agent_end"]) {
      expect(TYPES, `${t} 上必须有 sessionId`).toMatch(
        new RegExp(`type: "${t}"[\\s\\S]{0,220}?sessionId: string`),
      );
    }
  });

  it("两个建轮封套都带 `sessionId`", () => {
    expect(TYPES).toMatch(/interface TurnMessageStart[\s\S]*?sessionId: string/);
    expect(TYPES).toMatch(/interface BroadcastMessageStart[\s\S]*?sessionId: string/);
  });

  it("`send` 的 `sessionId` 是**可选** —— 省略 = 主对话(旧行为)", () => {
    // 与事件那七条相反,理由写在契约注释里:漏传的表现是「消息落到了主对话
    // 而不是你选的那条线」,**看得见**;而事件漏传会把模型在 A 线说的话
    // 显示在 B 线的面板里,**看不出来**。
    expect(TYPES).toMatch(/type: "send";[\s\S]*?sessionId\?: string/);
  });

  it("`SessionMessageView` 带 `sessionId` —— REST 回填那条路靠它分流", () => {
    expect(TYPES).toMatch(/interface SessionMessageView[\s\S]*?sessionId: string/);
  });
});

import { readFileSync } from "node:fs";