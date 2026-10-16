/**
 * MCP · 平台工具(mcp_list / mcp_grant / mcp_revoke)
 *
 * 守两件事:
 *   ① 写工具**只碰授权文件**,不碰 server 定义;未注册的名字被拒并列出可用名。
 *   ② **不存在「新增 / 修改 server 定义」的工具** —— 定义一条 server = 允许平台
 *      执行任意命令 / 向任意地址出网,做成工具就意味着某个模型能替甲方拍板。
 *      与 `POST /api/artifacts/:id/verdict` 同款处置。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { dispatch, TOOL_INDEX } from "../../src/platform/tools/registry.js";
import { MCP_TOOLS } from "../../src/platform/tools/mcp.js";
import { mcpDir, serversPath } from "../../src/platform/mcp/config.js";
import { grantPath, readGrantFile } from "../../src/platform/mcp/grants.js";
import type Database from "better-sqlite3";
import type { Agent } from "../../src/platform/harness/authorize.js";
import type { ToolRunContext } from "../../src/platform/tools/types.js";

const AT = 1_700_000_000_000;
const dirs: string[] = [];
let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sansheng-mcp-tools-"));
  dirs.push(d);
  return d;
}

function seedCatalog(dataDir: string, raw: unknown): void {
  mkdirSync(mcpDir(dataDir), { recursive: true });
  writeFileSync(serversPath(dataDir), JSON.stringify(raw), "utf8");
}

function ctxFor(dataDir: string, role: Agent["role"] = "project_manager"): ToolRunContext {
  db = openPlatformMemoryDb();
  const agent: Agent = { id: "a-pm", role, displayName: "PM" };
  return {
    db,
    agent,
    project: { id: "p1", name: "P", status: "active", assignments: [{ agentId: agent.id }] },
    now: () => AT,
    newId: (p: string) => `${p}_x`,
    dataDir,
  };
}

describe("mcp-tools · 注册与形状", () => {
  it("三条工具都在注册表里,且挂在正确的能力下", () => {
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual(["mcp_grant", "mcp_list", "mcp_revoke"]);
    for (const name of ["mcp_list", "mcp_grant", "mcp_revoke"]) {
      expect(TOOL_INDEX.has(name as never), `${name} 没进注册表`).toBe(true);
    }
    expect(MCP_TOOLS.find((t) => t.name === "mcp_list")?.capability).toBe("mcp.read");
    expect(MCP_TOOLS.find((t) => t.name === "mcp_grant")?.capability).toBe("mcp.grant");
    expect(MCP_TOOLS.find((t) => t.name === "mcp_revoke")?.capability).toBe("mcp.grant");
  });

  it("⚠️ **不存在「新增 / 修改 server 定义」的工具**(定义是人的资产)", () => {
    // 平台注册表(SDK 内置 7 个不在里面 —— 它们由 pi 提供)
    const implemented = [...TOOL_INDEX.keys()];
    for (const forbidden of [
      "mcp_add", "mcp_add_server", "mcp_create_server", "mcp_register",
      "mcp_set", "mcp_update_server", "mcp_write_server", "mcp_define",
    ]) {
      expect(implemented, `不该有「新增定义」的工具:${forbidden}`).not.toContain(forbidden);
    }
    // 也不许有任何一条 MCP 工具的参数里带 secret 字段 —— 那是「模型替甲方配凭据」
    for (const t of MCP_TOOLS) {
      const props = Object.keys((t.parameters as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props.filter((p) => /secret|token|password|apiKey/i.test(p)), `${t.name} 收了凭据参数`).toEqual([]);
    }
  });

  it("⚠️ 这个「不存在」的判据不是空转:三条 MCP 工具**确实**在(负样本)", () => {
    expect([...TOOL_INDEX.keys()].filter((n) => n.startsWith("mcp_")).sort()).toEqual([
      "mcp_grant",
      "mcp_list",
      "mcp_revoke",
    ]);
  });

  it("`mcp.grant` **不在 NUDGE_CAPABILITIES 里**(授权只影响新建会话)", () => {
    const src = readFileSync("src/platform/runtime/dispatcher.ts", "utf8");
    const block = src.slice(src.indexOf("NUDGE_CAPABILITIES"), src.indexOf("NUDGE_CAPABILITIES") + 900);
    expect(block).not.toContain("mcp.grant");
  });
});

describe("mcp-tools · mcp_list(只读)", () => {
  it("列目录 + 各角色授权;没有目录时如实说「还没配」而不是故障", async () => {
    const d = tmp();
    const r = await dispatch("mcp_list", {}, ctxFor(d));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.text).toContain("还没配");
  });

  it("坏目录 ⇒ 报出原因(不是空清单)", async () => {
    const d = tmp();
    mkdirSync(mcpDir(d), { recursive: true });
    writeFileSync(serversPath(d), "{ 坏", "utf8");
    const r = await dispatch("mcp_list", {}, ctxFor(d));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("目录");
  });

  it("没装配 dataDir ⇒ **报装配错误**(不是「没有 MCP」)", async () => {
    const r = await dispatch("mcp_list", {}, { ...ctxFor(tmp()), dataDir: undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("装配错误");
  });

  it("只读的判据:调完之后目录文件与授权文件一个字节都没变", async () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const before = readFileSync(serversPath(d), "utf8");
    const r = await dispatch("mcp_list", {}, ctxFor(d));
    expect(r.ok).toBe(true);
    expect(readFileSync(serversPath(d), "utf8")).toBe(before);
    expect(readdirSync(mcpDir(d))).toEqual(["servers.json"]);
  });
});

describe("mcp-tools · mcp_grant / mcp_revoke", () => {
  it("未注册的 server 名 ⇒ 拒 + 列出可用名 + **不静默创建**", async () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const r = await dispatch("mcp_grant", { server: "ghost", role: "business_manager" }, ctxFor(d));
    expect(r.ok).toBe(false);
    expect(r.alternatives).toEqual(["docs"]);
    expect(r.message).toContain("人的决定");
    // 目录文件没被动过(没有多出 ghost)
    expect(JSON.parse(readFileSync(serversPath(d), "utf8"))).toEqual({ servers: { docs: { url: "https://x/mcp" } } });
  });

  it("非法 server 名 ⇒ 拒(带可执行说明)", async () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const r = await dispatch("mcp_grant", { server: "../escape", role: "business_manager" }, ctxFor(d));
    expect(r.ok).toBe(false);
  });

  it("未知角色 ⇒ 拒 + 列出合法角色", async () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const r = await dispatch("mcp_grant", { server: "docs", role: "boss" }, ctxFor(d));
    expect(r.ok).toBe(false);
    expect(r.alternatives).toContain("business_manager");
  });

  it("授权成功 ⇒ **回读**授权文件 + 返回文本带「只对新建会话生效」", async () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const r = await dispatch("mcp_grant", { server: "docs", role: "research_worker" }, ctxFor(d));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.text).toContain("只对新建的会话生效");
    expect(readGrantFile(d, "research_worker").file).toEqual({ allow: ["docs"], deny: [] });
  });

  it("备份真的落盘(harness/backups/mcp/)—— 第二次写同一角色才有备份", async () => {
    // ⚠️ 首次写没有东西可备份(那是 `undefined`,不是失败)——
    // 所以这条判据必须「写两次同一个角色」,否则它在测一个假场景。
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" }, sentry: { url: "https://y/mcp" } } });
    const first = await dispatch("mcp_grant", { server: "docs", role: "research_worker" }, ctxFor(d));
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(readGrantFile(d, "research_worker").file).toEqual({ allow: ["docs"], deny: [] });
    const r = await dispatch("mcp_grant", { server: "sentry", role: "research_worker" }, ctxFor(d));
    expect(r.ok).toBe(true);
    const backups = join(d, "harness", "backups", "mcp");
    expect(readdirSync(backups).some((f) => f.startsWith("research_worker."))).toBe(true);
    // 备份里是**上一版**(只有 docs),不是新写的
    const bak = readdirSync(backups).find((f) => f.startsWith("research_worker.")) as string;
    expect(JSON.parse(readFileSync(join(backups, bak), "utf8"))).toEqual({ allow: ["docs"], deny: [] });
    expect(readGrantFile(d, "research_worker").file).toEqual({ allow: ["docs", "sentry"], deny: [] });
  });

  it("坏授权文件上**拒绝叠加**授权(而不是在「零授权」上猜)", async () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    mkdirSync(mcpDir(d), { recursive: true });
    writeFileSync(join(mcpDir(d), "business_manager.json"), "{ 坏", "utf8");
    const r = await dispatch("mcp_grant", { server: "docs", role: "business_manager" }, ctxFor(d));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("零授权");
  });

  it("mcp_revoke 生效,且 idemotent", async () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    await dispatch("mcp_grant", { server: "docs", role: "research_worker" }, ctxFor(d));
    const r1 = await dispatch("mcp_revoke", { server: "docs", role: "research_worker" }, ctxFor(d));
    expect(r1.ok).toBe(true);
    expect(readGrantFile(d, "research_worker").file?.allow).toEqual([]);
    const r2 = await dispatch("mcp_revoke", { server: "docs", role: "research_worker" }, ctxFor(d));
    expect(r2.ok).toBe(true);
    expect(r2.text).toContain("没写任何东西");
  });

  it("mcp_revoke 对目录里没有的名字 ⇒ 列出可用名", async () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const r = await dispatch("mcp_revoke", { server: "ghost", role: "research_worker" }, ctxFor(d));
    expect(r.ok).toBe(false);
  });

  it("⚠️ 工具**不改 server 定义**(授权前后目录文件逐字相同)", async () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const before = readFileSync(serversPath(d), "utf8");
    await dispatch("mcp_grant", { server: "docs", role: "research_worker" }, ctxFor(d));
    await dispatch("mcp_revoke", { server: "docs", role: "research_worker" }, ctxFor(d));
    expect(readFileSync(serversPath(d), "utf8")).toBe(before);
  });
});
