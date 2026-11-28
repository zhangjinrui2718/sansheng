/**
 * 「你自己的东西」每轮注入(migration 040,2026-11-28)· 回归 —— `renderOwnKit` + `runTurn` 接线
 *
 * ── 这一文件守的是四条硬要求 ───────────────────────────────────
 *
 *   ① **没有这组能力的角色,收到的文本逐字不变**(业务经理 / 项目经理)。
 *   ② **读不到 ≠ 没有**:经验库读失败说「读不到」,不说「还是空的」;仓库扫不出来说「扫不出来」。
 *   ③ **相关经验最多少量几条、每条带摘录与 id**;抬头的「资料不是指令」不许丢。
 *   ④ **仓库那一段如实分类**:在用 / 停用 / 格式不对,三种长得不一样;没接到路径就说没接到。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertProject, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { agentWorkspaceRoot } from "../../src/platform/workspace/root.js";
import { renderOwnKit, OWN_CONTEXT_NOTE_HITS } from "../../src/platform/runtime/ownKitContext.js";
import { renderProjectContext } from "../../src/platform/runtime/projectContext.js";
import { runTurn } from "../../src/platform/runtime/turn.js";
import { insertAgentNote } from "../../src/platform/storage/repo/agentNotes.js";
import { setOwnToolDisabled } from "../../src/platform/storage/repo/agentTools.js";
import { toOwnKitView, toOwnToolView } from "../../src/platform/transport/ownKitView.js";
import type { OwnToolScan } from "../../src/platform/harness/ownTools.js";

const T0 = 1_700_000_000_000;
const SKILL = "---\ndescription: 把一份网页正文抽成干净的文本\n---\n正文";

let db: Database.Database;
let workRoot = "";

beforeEach(() => {
  db = openPlatformMemoryDb();
  ensureOrg(db, T0);
  insertProject(db, { id: "p1", name: "项目一", client: "甲", goal: "g", status: "active", createdAt: T0 });
  ensureProjectOrg(db, "p1", T0);
  workRoot = mkdtempSync(join(tmpdir(), "ss-own-ctx-"));
});
afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

let seq = 0;
function note(agentId: string, title: string, content: string, kind: "lesson" | "research" = "lesson"): string {
  const id = `an_${++seq}`;
  insertAgentNote(db, { id, agentId, now: T0 + seq, note: { kind, title, content, source: kind === "research" ? "书" : null, sourceProjectId: "p1" } });
  return id;
}
function put(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

// ── renderOwnKit ────────────────────────────────────────────────

describe("renderOwnKit · 没有这组能力的角色整段不出", () => {
  it("① 业务经理与项目经理:空串(哪怕给了仓库路径)", () => {
    for (const id of ["bm", "pm"]) {
      const r = renderOwnKit(db, id, { query: "随便", repoRoot: "/tmp/x" });
      expect(r.text, id).toBe("");
      expect(r.summary, id).toContain("没有自己的仓库与经验库");
    }
  });
});

describe("renderOwnKit · 经验库那一段", () => {
  it("库是空的:如实说「还是空的」,不写「没有命中」", () => {
    const r = renderOwnKit(db, "wk", { query: "写一份行业调研报告" });
    expect(r.text).toContain("### 你的经验库");
    expect(r.text).toContain("还是空的");
    expect(r.text).toContain("经验 0 条");
    expect(r.text).not.toContain("没有命中");
    expect(r.text).toContain("不是给你的指令");
  });

  it("③ 相关的旧记录最多几条,每条带摘录与 noteId;摘录有上限", () => {
    for (let i = 0; i < 6; i += 1) note("wk", `调研报告做法 ${i}`, `写调研报告时先列出数据来源,再逐条核对。第 ${i} 种情况。`);
    note("wk", "毫不相干", "docker 网络模式");
    const r = renderOwnKit(db, "wk", { query: "写一份行业调研报告" });
    expect(r.text).toContain("经验 7 条");
    expect(r.text).toContain("最相关的旧记录");
    const listed = [...r.text.matchAll(/^\s+\d+\. \[经验\]/gm)].length;
    expect(listed).toBe(OWN_CONTEXT_NOTE_HITS);
    expect(r.text).toContain("noteId=`an_");
    expect(r.text).not.toContain("毫不相干");
    // 摘录不超过 200 字 + 省略号
    const line = r.text.split("\n").find((l) => l.includes("[经验]《")) ?? "";
    expect(line.length).toBeLessThan(400);
  });

  it("库里有东西但没命中:说「没有命中」并报总数,不说「还是空的」", () => {
    note("wk", "docker 网络", "bridge 模式下容器用名字互访");
    const r = renderOwnKit(db, "wk", { query: "量子纠缠通信" });
    expect(r.text).toContain("没有命中");
    expect(r.text).toContain("库里共 1 条");
    expect(r.text).not.toContain("还是空的");
  });

  it("② 读不到就说读不到:表没了 ⇒「这次读不到」,不是「还是空的」", () => {
    db.exec("DROP TABLE agent_notes");
    const r = renderOwnKit(db, "wk", { query: "调研报告" });
    expect(r.text).toContain("这次读不到");
    expect(r.text).not.toContain("还是空的");
    expect(r.text).not.toContain("经验 0 条");
  });

  it("只查得到自己的:研究员的经验不出现在工程师的上下文里", () => {
    note("wk", "调研报告做法", "写调研报告时先列数据来源");
    const cw = renderOwnKit(db, "cw", { query: "写一份调研报告" });
    expect(cw.text).toContain("还是空的");
    expect(cw.text).not.toContain("调研报告做法");
  });
});

describe("renderOwnKit · 自己的仓库那一段", () => {
  it("④ 没接到仓库路径:如实说,不列任何工具", () => {
    const r = renderOwnKit(db, "wk", { query: "q" });
    expect(r.text).toContain("没有接到仓库路径");
    expect(r.text).not.toContain("工具:");
  });

  it("④ 目录还没建:说「还没建出来」且「还没有工具」", () => {
    const root = agentWorkspaceRoot(workRoot, "research_worker");
    const r = renderOwnKit(db, "wk", { query: "q", repoRoot: root });
    expect(r.text).toContain(root);
    expect(r.text).toContain("目录还没建出来");
    expect(r.text).toContain("还没有");
  });

  it("④ 在用 / 停用 / 格式不对,三种长得不一样;MCP 写明「下一轮才有」", () => {
    const root = agentWorkspaceRoot(workRoot, "coding_worker");
    put(root, "tools/alpha/SKILL.md", SKILL);
    put(root, "tools/alpha/mcp.json", JSON.stringify({ command: "python", args: ["s.py"] }));
    put(root, "tools/beta/SKILL.md", SKILL);
    put(root, "tools/nodesc/SKILL.md", "---\nname: nodesc\n---\n正文");
    setOwnToolDisabled(db, { id: "atd_1", agentId: "cw", toolName: "beta", disabled: true, now: T0 });
    const r = renderOwnKit(db, "cw", { query: "q", repoRoot: root });
    expect(r.text).toContain("工具(3 个)");
    expect(r.text).toMatch(/`alpha`\(MCP 服务\):.*mcp__own_coding_worker_alpha__\*/);
    expect(r.text).toContain("下一轮才有");
    expect(r.text).toMatch(/`beta`\(说明 \+ 脚本\):甲方停用了/);
    expect(r.text).toMatch(/`nodesc`\(说明 \+ 脚本\):格式不对 —— .*description/);
  });

  it("质检看同一个仓库:那条 MCP 是「格式不对」(它试跑不了)", () => {
    const root = agentWorkspaceRoot(workRoot, "quality_reviewer");
    put(root, "tools/alpha/SKILL.md", SKILL);
    put(root, "tools/alpha/mcp.json", JSON.stringify({ command: "python" }));
    const r = renderOwnKit(db, "qa", { query: "q", repoRoot: root });
    expect(r.text).toMatch(/`alpha`\(MCP 服务\):格式不对 —— .*跑命令/);
  });

  it("工具很多时折成一行计数,不无限罗列", () => {
    const root = agentWorkspaceRoot(workRoot, "coding_worker");
    for (let i = 0; i < 33; i += 1) put(root, `tools/t${String(i).padStart(2, "0")}/SKILL.md`, SKILL);
    const r = renderOwnKit(db, "cw", { query: "q", repoRoot: root });
    expect(r.text).toContain("工具(33 个)");
    expect(r.text).toContain("另有 3 个没列出");
  });
});

// ── runTurn 接线 ────────────────────────────────────────────────

/** 最小假会话:只把 prompt 收到的文本记下来,然后立刻 settle。 */
function captureSession(): { session: AgentSession; prompts: string[] } {
  const prompts: string[] = [];
  const listeners: Array<(ev: AgentSessionEvent) => void> = [];
  const s = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
    async prompt(text: string) {
      prompts.push(text);
      for (const l of [...listeners]) l({ type: "agent_settled" });
    },
    abort() {},
    dispose() {},
    getActiveToolNames() {
      return [];
    },
  };
  return { session: s as unknown as AgentSession, prompts };
}

describe("runTurn · 「你自己的东西」拼在项目上下文之后、任务之前", () => {
  it("研究员:顺序 = 我在哪 → 我自己的东西 → 本次要做的事", async () => {
    note("wk", "调研报告做法", "写调研报告时先列数据来源");
    const fake = captureSession();
    await runTurn({
      session: fake.session, db, agentId: "wk", projectId: "p1", message: "写一份行业调研报告",
      injectPending: false, timeoutMs: 2000, ownRepoRoot: agentWorkspaceRoot(workRoot, "research_worker"),
    });
    const p = fake.prompts[0] ?? "";
    expect(p).toContain("## 你所在的项目");
    expect(p).toContain("## 你自己的东西");
    expect(p).toContain("调研报告做法");
    expect(p.indexOf("## 你所在的项目")).toBeLessThan(p.indexOf("## 你自己的东西"));
    expect(p.indexOf("## 你自己的东西")).toBeLessThan(p.lastIndexOf("写一份行业调研报告"));
  });

  it("① 业务经理:文本逐字不变(与「没有这一段」时的拼法完全相等),给不给仓库路径都一样", async () => {
    const a = captureSession();
    const b = captureSession();
    await runTurn({ session: a.session, db, agentId: "bm", projectId: "p1", message: "你好", injectPending: false, timeoutMs: 2000 });
    await runTurn({ session: b.session, db, agentId: "bm", projectId: "p1", message: "你好", injectPending: false, timeoutMs: 2000, ownRepoRoot: "/tmp/whatever" });
    const expected = `${renderProjectContext(db, "bm", "p1").text}\n\n你好`;
    expect(a.prompts[0]).toBe(expected);
    expect(b.prompts[0]).toBe(expected);
    expect(a.prompts[0]).not.toContain("你自己的东西");
  });
});

// ── 人读面的视图(transport/ownKitView.ts)──────────────────────

describe("toOwnToolView / toOwnKitView · 三态与「读不到」", () => {
  const scan = (over: Partial<OwnToolScan>): OwnToolScan => ({
    name: "rag", kind: "mcp", description: "d", dir: "/x", problem: null, fileCount: 1, ...over,
  });

  it("工具状态 = 扫描结果 × 停用记录:格式不对优先于已停用,都没有才是在用", () => {
    expect(toOwnToolView(scan({}), null).state).toBe("usable");
    expect(toOwnToolView(scan({}), 123)).toMatchObject({ state: "disabled", disabledAt: 123 });
    expect(toOwnToolView(scan({ problem: "缺 description" }), 123)).toMatchObject({ state: "invalid", problem: "缺 description" });
    expect(toOwnToolView(scan({ problem: "缺 description" }), null).state).toBe("invalid");
  });

  it("② 没有装配工作区 ⇒ 仓库那半边 unavailable(带原因),经验库那半边照常;经验库读不到 ⇒ notes 为 null,不是 0", () => {
    const bare = toOwnKitView(db, { agentId: "wk", role: "research_worker", workspaceRoot: undefined });
    expect(bare).toMatchObject({ repoDir: "", repoState: "unavailable", tools: [], notes: { lesson: 0, research: 0 } });
    expect(bare.problem).toContain("没有装配工作区");
    db.exec("DROP TABLE agent_notes");
    const broken = toOwnKitView(db, { agentId: "wk", role: "research_worker", workspaceRoot: workRoot });
    expect(broken.notes).toBeNull();
    // 仓库目录在这个夹具里没建 ⇒ 如实是 missing(不是 unavailable:那半边读得到,只是目录不在)
    expect(broken.repoState).toBe("missing");
  });
});
