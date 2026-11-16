/**
 * 甲方打扰闸(2026-11-15)· 测试
 *
 * 用户裁决:「BM 需要严格控制对用户的打扰,根据项目目标判断是否需要追问用户」。
 * 两道机制门(都在 ask_client 工具内部,不是提示词层):
 *
 *   ① 并发上限:同项目未答提问挂满 2 条即拒 —— 打扰有硬预算。卡住的是
 *      「此刻挂在甲方那里的」,不是生命周期累计(长项目不受惩罚);
 *   ② 判据锚点:问题必须引用**项目目标原文**的 ≥10 字连续片段(归一化后
 *      包含判定)—— 与目标无关的问题不配打扰甲方;拒绝消息教 BM
 *      「先把判据写进目标」(BM 持 project.update,它自己能修)。
 *
 * tell_client(单向播报)不受闸门影响 —— 打扰预算只管「等甲方拍板」的问题。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { insertArtifact, getArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { Agent, Project } from "../../src/platform/harness/authorize.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { countOpenClientQuestions } from "../../src/platform/storage/repo/clientQuestions.js";

let db: Database.Database;
let dir: string;
const asked: number[] = [];
let seq = 0;
let clock = 1_700_000_000_000;
let project: Project;

const GOAL = "二战坦克塔防:守住全部 10 波进攻,交付可玩的单文件游戏";
const ANCHOR = "守住全部 10 波进攻,交付可玩";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ss-ask-gate-"));
  db = openPlatformMemoryDb();
  seq = 0;
  clock = 1_700_000_000_000;
  insertAgent(db, { id: "bm", role: "business_manager", specialization: null, displayName: "业务经理", createdAt: clock });
  insertProject(db, { id: "p1", name: "塔防", client: "甲", goal: GOAL, status: "active", createdAt: clock });
  addMember(db, "p1", "bm", clock);
  project = loadProjectForAuthz(db, "p1")!;
  mkdirSync(join(dir, "system_prompts"), { recursive: true });
  writeFileSync(join(dir, "system_prompts", "seed.md"), "seed", "utf8");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function ctx(): ToolRunContext {
  return {
    db,
    agent: { id: "bm", role: "business_manager", displayName: "业务经理" },
    project,
    now: () => clock,
    newId: (p: string) => `${p}_${++seq}`,
    client: {
      async ask() {
        asked.push(1);
      },
      async tell() {},
    },
    workspace: createGitWorkspace(),
    workspaceRoot: dir,
  };
}


async function call(args: Record<string, unknown>): Promise<ToolResult> {
  const r = dispatch("ask_client", args, ctx());
  return (r instanceof Promise ? await r : r) as ToolResult;
}

/** 直接在台账里种一条 open 的甲方提问(不经过闸门 —— 种的是「已问出的」) */
function seedOpen(id: string, question: string): void {
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null, kind: "client_question", status: "open",
    authorAgentId: "bm", title: question, bodyPath: null, bodySha256: null, bodyBytes: null,
    metadataJson: null, createdAt: clock, updatedAt: clock,
  });
  insertSession(db, { id: `s_${id}`, projectId: "p1", createdAt: clock });
  appendSessionMessage(db, {
    id: `msg_${id}`, sessionId: `s_${id}`, agentId: "bm", kind: "user",
    content: question, createdAt: clock, originSource: "turn", triggerKind: "user",
  });
  recordClientQuestion(db, {
    questionArtifactId: id, projectId: "p1", askedBy: "bm", askedAt: clock,
  });
}

const base = { question: "炮塔射程要不要覆盖第二段路径?", blocks: ANCHOR };

describe("① 并发上限:同项目最多挂 2 条未答提问", () => {
  it("挂满 2 条后再问 ⇒ open_question_limit,且不落工件不投递", async () => {
    const r1 = await call(base);
    if (!r1.ok) console.log("DEBUG_FAIL", r1.code, r1.message);
    expect(r1.ok).toBe(true);
    const r2 = await call({ ...base, question: "第二问" });
    expect(r2.ok).toBe(true);

    const refused = await call({ ...base, question: "第三问" });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("open_question_limit");
    expect(refused.message).toContain("上限");

    // 拒绝 ⇒ 不落工件不投递:open 的只有前两条
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE kind='client_question' AND status='open'`).get(),
    ).toMatchObject({ n: 2 });
  });

  it("甲方答掉一条 ⇒ 名额腾出,能再问(恢复机制的反向验证)", async () => {
    const r1 = await call(base);
    expect(r1.ok).toBe(true);
    // 甲方答掉第一问:工件转 accepted + 台账 answered
    const qid = db
      .prepare(`SELECT id FROM artifacts WHERE kind='client_question' AND status='open' LIMIT 1`)
      .get() as { id: string };
    db.prepare(`UPDATE artifacts SET status='accepted' WHERE id=?`).run(qid.id);
    const again = await call({ ...base, question: "第二问" });
    expect(again.ok).toBe(true);
  });
});

describe("② 判据锚点:问题必须引用目标原文", () => {
  it("缺 blocks 字段 ⇒ invalid_args(参数校验在前)", async () => {
    const r = await call({ question: "没有锚点的问题" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("invalid_args");
  });

  it("锚点归一化后 < 10 字 ⇒ 拒绝并教引用原文", async () => {
    const r = await call({ question: "问题", blocks: "守住" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("goal_anchor");
    expect(r.message).toContain("锚定");
  });

  it("锚点与目标原文对不上 ⇒ 拒绝,并指引先把判据写进目标", async () => {
    const r = await call({ question: "问题", blocks: "多语言成就系统排行榜" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("goal_anchor");
    expect(r.message).toContain("对不上");
  });

  it("锚点是目标原文的连续片段 ⇒ 通过,且正文带上【卡住的判据】头", async () => {
    const r = await call(base);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("已向甲方提问");
    // 正文里能看到锚点(甲方在待答卡片上看得见「卡住的是哪条判据」)
    // body_path 相对**项目工作区根**(workRoot/projects/p1),不是 harnessDir
    const row = db
      .prepare(`SELECT body_path FROM artifacts ORDER BY created_at DESC LIMIT 1`)
      .get() as { body_path: string };
    const body = readFileSync(join(dir, "projects", "p1", row.body_path), "utf8");
    expect(body).toContain("卡住的判据");
  });
});

describe("③ tell_client 不受闸门影响", () => {
  it("挂满名额后 tell_client 照常可用(单向播报不占提问名额)", async () => {
    await call(base);
    await call({ ...base, question: "第二问" });
    const r = dispatch("tell_client", { text: "进度播报,不是提问" }, ctx());
    expect(r !== undefined).toBe(true);
    const t = (r instanceof Promise ? await r : r) as { ok?: boolean; text?: string };
    expect(t.ok).toBe(true);
  });
});
