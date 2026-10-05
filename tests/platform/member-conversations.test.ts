/**
 * A3 · 成员页清单的数据源:`GET /api/projects/:id/member-conversations`
 *
 * ── 这个端点存在的**唯一**理由,就是这个文件要钉住的那条判据 ──────────
 *
 * `GET /api/projects/:id/messages`(`listProjectMessages`)是**给对话页的**:它没有
 * agent 谓词,而且**每个会话只交回一窗口**(默认最新 200 条)。拿它在前端按
 * `agent_id` 分组,「业务经理说了几条」会在消息量超过窗口时**静默少数** ——
 * 而少数的那一版和正确的那一版在屏幕上长得一模一样。
 * (那个窗口**修好之前取的是最早 200 条**,bug①;复核与回归见
 * `tests/platform/project-messages-window.test.ts`。窗口的**存在**没变,所以这条
 * 「条数只能来自 SQL GROUP BY」的判据不受影响。)
 *
 * 所以:条数必须来自 SQL `GROUP BY`,`messages` 只是每组的一页。这里的正负样本是
 *   · 正:`total` == 测试自己用裸 SQL 数出来的 `GROUP BY agent_id` 结果;
 *   · 负:`total` **不等于** `messages.length`(构造一组超过 limit 的消息,
 *     若实现拿 `messages.length` 冒充总数,这条会红)。
 *
 * 第二条钉的是 A1 在真机上实测到的坑:**`agent_id IS NULL` 不等于「甲方」** ——
 * 平台通知(`kind='system'`)与甲方(`kind='user'`)在库里是同一个分组键,
 * 必须靠 `kind` 分开。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { appendSessionMessage, insertSession } from "../../src/platform/storage/repo/sessions.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import type { MemberConversationsResponse } from "@shared/types/platform.js";

const P = "p-members";
const S = "s-1";
let db: Database.Database;
let seq = 0;
let clock = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  clock = 1_700_000_000_000;
  insertProject(db, {
    id: P, name: "登录系统", client: "甲方", goal: "把登录做出来",
    status: "active", createdAt: clock,
  });
  insertSession(db, { id: S, projectId: P, createdAt: clock });
  for (const [id, role, name] of [
    ["bm", "business_manager", "业务经理"],
    ["pm", "project_manager", "项目经理"],
    ["wk", "worker", "工程师"],
    ["qa", "quality_reviewer", "质检"],
  ] as const) {
    insertAgent(db, { id, role, specialization: null, displayName: name, createdAt: clock });
  }
});

afterEach(() => {
  db.close();
});

/** 落一条会话消息(`agentId: null` 就是那两个作者:甲方 / 平台通知)。 */
function msg(agentId: string | null, kind: "user" | "assistant" | "system", content: string): void {
  seq += 1;
  clock += 1;
  appendSessionMessage(db, {
    id: `m${seq}`, sessionId: S, agentId, kind, content, createdAt: clock,
  });
}

function app(over?: Partial<HttpDeps>) {
  const deps: HttpDeps = {
    db,
    dataDir: "/tmp/a3-members-test",
    cwd: "/tmp",
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/a3-members-test", factoryDir: "/tmp/a3-members-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
    ...over,
  };
  return createPlatformApp(deps);
}

async function fetchGroups(limit?: number): Promise<MemberConversationsResponse> {
  const q = limit !== undefined ? `?limit=${limit}` : "";
  const res = await app().request(`/api/projects/${P}/member-conversations${q}`);
  expect(res.status, "端点必须存在且 200").toBe(200);
  return (await res.json()) as MemberConversationsResponse;
}

describe("A3 · 成员页清单:条数来自 SQL GROUP BY", () => {
  it("四个角色各自的条数与库里 GROUP BY agent_id 逐项相同", async () => {
    for (let i = 0; i < 5; i += 1) msg("wk", "assistant", `第 ${i} 项做完了`);
    for (let i = 0; i < 4; i += 1) msg("bm", "assistant", `第 ${i} 次交代`);
    msg("pm", "assistant", "我拆了 3 个工作项");
    msg("qa", "assistant", "审过了");
    msg(null, "user", "把登录做出来");
    msg(null, "user", "顺便加个验证码");

    const body = await fetchGroups();
    const seen = Object.fromEntries(body.groups.map((g) => [String(g.agentId), g.total]));

    // 独立算一遍真值(**不是**复用实现的那条 SQL)
    const truth = db
      .prepare(
        `SELECT m.agent_id AS agentId, COUNT(*) AS n
           FROM session_messages m
           JOIN project_sessions s ON s.id = m.session_id
          WHERE s.project_id = ?
          GROUP BY m.agent_id`,
      )
      .all(P) as Array<{ agentId: string | null; n: number }>;
    expect(Object.keys(seen).length).toBe(truth.length);
    for (const t of truth) {
      expect(seen[String(t.agentId)], `agent ${String(t.agentId)} 的条数`).toBe(t.n);
    }
    // 正样本自检:真值本身不是空的(否则上面那圈是空转)
    expect(truth.length, "真值查询必须命中 5 组(bm/pm/wk/qa/null)").toBe(5);
    expect(seen["wk"]).toBe(5);
    expect(seen["null"]).toBe(2);
  });

  it("⚠️ agentId=null 那一组**必须**靠 kind 把甲方与平台通知分开", async () => {
    msg(null, "user", "把登录做出来");
    msg(null, "user", "再加个验证码");
    msg(null, "system", "排空在 max_rounds 处停下(8 回合)");

    const body = await fetchGroups();
    const g = body.groups.find((x) => x.agentId === null);
    expect(g, "null 组必须存在").toBeDefined();
    expect(g?.total, "null 组的总数 = 甲方 + 平台通知").toBe(3);
    // 正样本:甲方两条
    expect(g?.byKind.user).toBe(2);
    // 负样本:把系统通知算成甲方 —— 这一条红了就说明只看 agentId 没看 kind
    expect(g?.byKind.user, "系统通知不许被算成甲方说的话").not.toBe(3);
    expect(g?.byKind.system).toBe(1);
    expect(g?.agentName).toBeNull();
    expect(g?.role).toBeNull();
  });

  it("每个角色组带 role / agentName(身份解析在服务端,前端不再自己拼)", async () => {
    msg("bm", "assistant", "好的");
    msg("wk", "assistant", "做完了");
    const body = await fetchGroups();
    const bm = body.groups.find((g) => g.agentId === "bm");
    expect(bm?.role).toBe("business_manager");
    expect(bm?.agentName).toBe("业务经理");
    const wk = body.groups.find((g) => g.agentId === "wk");
    expect(wk?.role).toBe("worker");
    expect(wk?.agentName).toBe("工程师");
  });

  it("截断时 total 仍是真值(拿 messages.length 冒充总数会红)", async () => {
    for (let i = 0; i < 7; i += 1) msg("wk", "assistant", `产出 ${i}`);
    const body = await fetchGroups(3);
    const wk = body.groups.find((g) => g.agentId === "wk");
    expect(wk?.total).toBe(7);
    expect(wk?.messages.length).toBe(3);
    expect(wk?.truncated).toBe(true);
    // 新的在前 —— 检查的是「最近 3 条」而不是「最早 3 条」(后者会让检查者看到一段旧历史)
    expect(wk?.messages.map((m) => m.content)).toEqual(["产出 6", "产出 5", "产出 4"]);
    expect(body.limit).toBe(3);
  });

  it("没有消息时 groups 是空数组(不是「有组但 0 条」的假象)", async () => {
    const body = await fetchGroups();
    expect(body.groups).toEqual([]);
  });

  it("项目不存在 → 404 not_found(与其他项目端点同形)", async () => {
    const res = await app().request("/api/projects/p-不存在/member-conversations");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});
