/**
 * MCP · HTTP 写面(`/api/mcp/*`)—— **定义与凭据只有人写得动**
 *
 * 守三件事:
 *   ① **secret 的值永不出现** —— 读面只给 `hasSecrets` 与 key 名;写 secret 的
 *      响应不回显密文(密文也是凭据材料)。
 *   ② **删除不静默级联删授权** —— 仍被谁授权着就 409 并点名那些人。
 *   ③ **不知道有哪些合法名字时要回灌清单**(8-F:拒绝要让调用方能自纠)。
 *
 * ⚠️ 这一层**刻意没有**「连接状态」端点 —— Wave 1 平台读不到
 * (pi 把它写进 `<agentDir>/mcp.log`),宁可没有也不伪造。
 */
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import { keyringSecretStore, secretsPath } from "../../src/platform/mcp/secrets.js";
import { mcpDir, serversPath } from "../../src/platform/mcp/config.js";
import { readGrantFile } from "../../src/platform/mcp/grants.js";
import { Keyring } from "../../src/platform/infra/keyring.js";
import type { McpCatalogView, McpRoleGrantView } from "@shared/types/platform.js";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sansheng-mcp-http-"));
  dirs.push(d);
  return d;
}

function appFor(d: string, over: Partial<HttpDeps> = {}) {
  db = openPlatformMemoryDb();
  const deps: HttpDeps = {
    db,
    dataDir: d,
    cwd: d,
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => NOW,
    newId: (p) => `${p}_x`,
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: d, factoryDir: join(d, "factory") },
    settings: { read: () => ({}), write: async () => ({ ok: true as const, settings: {} }), providers: () => [] },
    secretStore: keyringSecretStore(new Keyring(join(d, ".keyring"))),
    ...over,
  };
  return createPlatformApp(deps);
}

const post = (a: ReturnType<typeof appFor>, path: string, body: unknown) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (a: ReturnType<typeof appFor>, path: string, body: unknown) =>
  a.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("mcp-http · server 目录", () => {
  it("GET 在没有目录时返回空清单 + 路径(不是 500)", async () => {
    const d = dataDir();
    const a = appFor(d);
    const r = await a.request("/api/mcp/servers");
    expect(r.status).toBe(200);
    const body = (await r.json()) as McpCatalogView;
    expect(body.servers).toEqual([]);
    expect(body.path).toBe(serversPath(d));
  });

  it("POST 新建 / 整体替换一条,返回**回读**结果", async () => {
    const d = dataDir();
    const a = appFor(d);
    const r1 = await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp", description: "文档" });
    expect(r1.status).toBe(200);
    const r2 = await post(a, "/api/mcp/servers", { name: "docs", url: "https://y/mcp" });
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { server: { url: string; description?: string } };
    expect(body.server.url).toBe("https://y/mcp");
    // 整体替换:description 没了(不是合并)
    expect(body.server.description).toBeUndefined();
    const list = (await (await a.request("/api/mcp/servers")).json()) as McpCatalogView;
    expect(list.servers).toHaveLength(1);
  });

  it("非法 server 名 / `!command` ⇒ 400 且带可执行说明", async () => {
    const d = dataDir();
    const a = appFor(d);
    expect((await post(a, "/api/mcp/servers", { name: "../x", command: "y" })).status).toBe(400);
    const r = await post(a, "/api/mcp/servers", { name: "evil", command: "y", env: { K: "!id" } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("执行这条命令");
  });

  it("目录坏着时 POST ⇒ 409(不在坏目录上叠加)", async () => {
    const d = dataDir();
    const a = appFor(d);
    // 先用合法请求建目录,再手工写坏
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(mcpDir(d), { recursive: true });
    writeFileSync(serversPath(d), "{ 坏", "utf8");
    const r = await post(a, "/api/mcp/servers", { name: "other", url: "https://y/mcp" });
    expect(r.status).toBe(409);
  });

  it("GET 把目录文件的 problem 一并带出来(坏目录不静默)", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(mcpDir(d), { recursive: true });
    writeFileSync(serversPath(d), "{ 坏", "utf8");
    const body = (await (await a.request("/api/mcp/servers")).json()) as McpCatalogView;
    expect(body.servers).toEqual([]);
    expect(body.problem).toBeDefined();
  });
});

describe("mcp-http · secret:值永不出现", () => {
  it("PUT 写 secret → 响应只有 hasSecrets 与 key 名,**不回显密文**", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    const PLAINTEXT = "sk-live-abcdefghijklmnop-1234567890";
    const r = await put(a, "/api/mcp/servers/docs/secrets", { headers: { Authorization: PLAINTEXT } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    const text = JSON.stringify(body);
    expect(text).not.toContain(PLAINTEXT);
    expect(text).not.toContain("enc:");
    expect(body["hasSecrets"]).toBe(true);

    const list = (await (await a.request("/api/mcp/servers")).json()) as McpCatalogView;
    expect(JSON.stringify(list)).not.toContain(PLAINTEXT);
    expect(list.servers[0].hasSecrets).toBe(true);
    // 盘上那个文件也只在 secrets.json 里,目录文件里没有
    expect(readFileSync(serversPath(d), "utf8")).not.toContain(PLAINTEXT);
    expect(readFileSync(secretsPath(d), "utf8")).not.toContain(PLAINTEXT);
  });

  it("`!` 开头的 secret 被拒(它是配置里就能打开的任意命令执行通道)", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    const r = await put(a, "/api/mcp/servers/docs/secrets", { env: { K: "!cat /etc/passwd" } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("执行这条命令");
  });

  it("给不存在的 server 写 secret ⇒ 404 + 列出可用名", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    const r = await put(a, "/api/mcp/servers/ghost/secrets", { env: { K: "v" } });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: { validIds?: string[] } }).error.validIds).toEqual(["docs"]);
  });

  it("没有 secret 端口 ⇒ 500 并说清是装配错误(**不把明文写下去**)", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    const b = appFor(d, { secretStore: undefined });
    const r = await put(b, "/api/mcp/servers/docs/secrets", { env: { K: "v" } });
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("装配错误");
  });
});

describe("mcp-http · 删除不静默级联删授权", () => {
  it("仍被授权着 ⇒ 409 并点名那些角色", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    await put(a, "/api/mcp/roles/project_manager", { allow: ["docs"], deny: [] });
    const r = await a.request("/api/mcp/servers/docs", { method: "DELETE" });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: { grantedTo?: string[] } };
    expect(body.error.grantedTo).toEqual(["project_manager"]);
    // 定义还在盘上(没有被悄悄删掉)
    expect(readFileSync(serversPath(d), "utf8")).toContain("docs");
  });

  it("没人授权 ⇒ 删掉定义(并把 secret 一起清掉)", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    await put(a, "/api/mcp/servers/docs/secrets", { headers: { A: "v" } });
    const r = await a.request("/api/mcp/servers/docs", { method: "DELETE" });
    expect(r.status).toBe(200);
    const list = (await (await a.request("/api/mcp/servers")).json()) as McpCatalogView;
    expect(list.servers).toEqual([]);
    expect(readFileSync(secretsPath(d), "utf8")).not.toContain('"docs"');
  });
});

describe("mcp-http · 角色授权", () => {
  it("GET 在没有授权文件时是 `absent` + 空名单 + 可用名", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    const body = (await (await a.request("/api/mcp/roles/project_manager")).json()) as McpRoleGrantView;
    expect(body.state).toBe("absent");
    expect(body.allow).toEqual([]);
    expect(body.availableServers).toEqual(["docs"]);
  });

  it("PUT 写授权;未知 server 名 ⇒ 400 + 列出可用名(**不静默忽略**)", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    const bad = await put(a, "/api/mcp/roles/project_manager", { allow: ["ghost"], deny: [] });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: { availableServers?: string[] } };
    expect(body.error.availableServers).toEqual(["docs"]);
    expect(readGrantFile(d, "project_manager").state).toBe("absent");

    const ok = await put(a, "/api/mcp/roles/project_manager", { allow: ["docs"], deny: [] });
    expect(ok.status).toBe(200);
    expect(readGrantFile(d, "project_manager").file).toEqual({ allow: ["docs"], deny: [] });
  });

  it("两个字段缺一 ⇒ 400(与解析器的纪律一致)", async () => {
    const d = dataDir();
    const a = appFor(d);
    expect((await put(a, "/api/mcp/roles/project_manager", { allow: [] })).status).toBe(400);
    expect((await put(a, "/api/mcp/roles/project_manager", { deny: [] })).status).toBe(400);
  });

  it("未知角色 ⇒ 400 + 列出合法角色", async () => {
    const d = dataDir();
    const a = appFor(d);
    const r = await a.request("/api/mcp/roles/boss");
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { validIds?: string[] } }).error.validIds).toContain("project_manager");
  });

  it("读面 `grantedTo` 反映**授权文件本身**(工具改过也能对上)", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    await put(a, "/api/mcp/roles/business_manager", { allow: ["docs"], deny: [] });
    const list = (await (await a.request("/api/mcp/servers")).json()) as McpCatalogView;
    expect(list.servers[0].grantedTo).toEqual(["business_manager"]);
  });

  it("授权里写了目录没有的名字 ⇒ GET 如实报出 `unknownServers`", async () => {
    const d = dataDir();
    const a = appFor(d);
    await post(a, "/api/mcp/servers", { name: "docs", url: "https://x/mcp" });
    // 直接写盘(模拟历史文件):绕过 PUT 的 400 判据
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(mcpDir(d), { recursive: true });
    writeFileSync(join(mcpDir(d), "project_manager.json"), '{"allow":["docs","ghost"],"deny":[]}', "utf8");
    const body = (await (await a.request("/api/mcp/roles/project_manager")).json()) as McpRoleGrantView;
    expect(body.unknownServers).toEqual(["ghost"]);
  });
});

describe("mcp-http · ⚠️ 没有「连接状态」端点", () => {
  it("Wave 1 刻意不做:那些路径返回 404(而不是伪造一个状态)", async () => {
    const d = dataDir();
    const a = appFor(d);
    for (const p of ["/api/mcp/status", "/api/mcp/connections", "/api/mcp/health"]) {
      expect((await a.request(p)).status, `${p} 不该存在`).toBe(404);
    }
  });
});
