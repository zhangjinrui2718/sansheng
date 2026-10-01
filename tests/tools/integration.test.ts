/**
 * Sansheng ToolRegistry integration 单元测试 · M4
 *
 * 11 cases 覆盖(超出 6 最低要求):
 *  1. createToolRegistry().size() === 6
 *  2. entries() 包含全部 6 个名字
 *  2b. 每个 entry 都有非空 description
 *  3. invoke('fs.stat', { path }) 走 sandbox(tmp dir,afterAll 删)
 *  4. invoke('http.fetch', { url }) 用 localhost ephemeral server
 *  5. invoke('fs.readFile', { path: '/etc/passwd' }) 抛 SandboxError(验证 sandbox 生效)
 *  6. invoke('http.fetch', { url: 'http://example.com' }) 抛 NetSandboxError(blocked_host)
 *  6b. invoke('http.fetch', { url: 'http://127.0.0.1' }) 抛 NetSandboxError(private_ip,即使在 allowlist)
 *  7. invoke('not_found', {}) 抛 ToolNotFoundError
 *  8. createToolRegistry().register({...}) 重复名 → 抛 DuplicateToolError
 *  9. fs.writeFile + fs.readFile roundtrip 走 sandbox 写入读回一致
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Sandbox, SandboxError } from "../../src/server/tools/sandbox.js";
import {
  ToolNotFoundError,
  DuplicateToolError,
} from "../../src/server/tools/registry.js";
import { NetSandboxError, type NetPolicy } from "../../src/server/tools/netSandbox.js";
import { createToolRegistry } from "../../src/server/tools/integration.js";

const TOOL_NAMES = [
  "fs.readFile",
  "fs.writeFile",
  "fs.listDir",
  "fs.stat",
  "http.fetch",
  "http.postJson",
] as const;

let workspace: string;
let sandbox: Sandbox;

// net policy that allowlists a localhost ephemeral server on any port
function netPolicyForLocalServer(port: number): NetPolicy {
  return {
    allowlist: ["127.0.0.1", "localhost"],
    allowedPorts: new Set<number>([80, 443, 8080, 8443, port]),
    privateIpsAllowed: true,
  };
}

let server: Server;
let port: number;
let lastMethod = "";
let lastBody = "";

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "sansheng-integration-test-"));
  workspace = join(base, "workspace");
  await mkdir(workspace, { recursive: true });
  sandbox = new Sandbox({
    policy: {
      allowlist: [{ path: workspace, kind: "dir" }],
      maxBytes: 1024 * 1024, // 1 MiB;够用
    },
    homedir: base,
    tmpdir: base,
  });

  await new Promise<void>((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      lastMethod = req.method ?? "GET";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        lastBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, method: lastMethod, body: lastBody }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        port = addr.port;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  // macOS 的 rmdir 拒绝尾段为 ".." 的路径(EINVAL)→ 先取 dirname 归一化
  await rm(dirname(workspace), { recursive: true, force: true });
});

describe("createToolRegistry · shape", () => {
  it("1. size() === 6", async () => {
    const r = await createToolRegistry({ sandbox });
    expect(r.size()).toBe(6);
  });

  it("2. entries() contain all 6 tool names", async () => {
    const r = await createToolRegistry({ sandbox });
    const names = r.entries().map((e) => e.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
  });

  it("each entry has a non-empty description", async () => {
    const r = await createToolRegistry({ sandbox });
    for (const e of r.entries()) {
      expect(typeof e.description).toBe("string");
      expect((e.description ?? "").length).toBeGreaterThan(0);
    }
  });
});

describe("createToolRegistry · happy paths through sandbox", () => {
  it("3. fs.stat reports a file inside the canvas", async () => {
    const r = await createToolRegistry({ sandbox });
    const p = join(workspace, "stat-target.txt");
    await nodeWriteFile(p, "abc");
    const res = await r.invoke("fs.stat", { path: p });
    expect(res).toMatchObject({ kind: "file", size: 3 });
  });

  it("4. http.fetch hits a localhost ephemeral server", async () => {
    const r = await createToolRegistry({
      sandbox,
      netPolicy: netPolicyForLocalServer(port),
    });
    const url = `http://127.0.0.1:${port}/hello`;
    const res = (await r.invoke("http.fetch", { url })) as { status: number; body: string };
    expect(res.status).toBe(200);
    const echo = JSON.parse(res.body);
    expect(echo.method).toBe("GET");
  });

  it("9. fs.writeFile + fs.readFile roundtrip stays inside the canvas", async () => {
    const r = await createToolRegistry({ sandbox });
    const p = join(workspace, "roundtrip.txt");
    await r.invoke("fs.writeFile", { path: p, content: "你好世界" });
    const back = (await r.invoke("fs.readFile", { path: p })) as { content: string };
    expect(back.content).toBe("你好世界");
  });
});

describe("createToolRegistry · boundary guards", () => {
  it("5. fs.readFile outside canvas throws SandboxError (outside_allowlist)", async () => {
    const r = await createToolRegistry({ sandbox });
    let caught: unknown = null;
    try {
      await r.invoke("fs.readFile", { path: "/etc/passwd" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("outside_allowlist");
  });

  it("6. http.fetch to non-allowlisted public host throws NetSandboxError (blocked_host) under default policy", async () => {
    const r = await createToolRegistry({ sandbox }); // default netPolicy: empty allowlist
    let caught: unknown = null;
    try {
      await r.invoke("http.fetch", { url: "http://example.com/" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NetSandboxError);
    expect((caught as NetSandboxError).code).toBe("blocked_host");
  });

  it("6b. http.fetch to private IP throws NetSandboxError (private_ip) when host IS allowlisted", async () => {
    const r = await createToolRegistry({
      sandbox,
      netPolicy: {
        allowlist: ["127.0.0.1"],
        // privateIpsAllowed: false (default) → 仍因 private_ip 拒绝
      },
    });
    let caught: unknown = null;
    try {
      await r.invoke("http.fetch", { url: "http://127.0.0.1:2718/" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NetSandboxError);
    expect((caught as NetSandboxError).code).toBe("private_ip");
  });
});

describe("createToolRegistry · registry error cases", () => {
  it("7. invoke('not_found', {}) throws ToolNotFoundError", async () => {
    const r = await createToolRegistry({ sandbox });
    let caught: unknown = null;
    try {
      await r.invoke("not_found", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolNotFoundError);
  });

  it("8. re-registering a tool name throws DuplicateToolError", async () => {
    const r = await createToolRegistry({ sandbox });
    expect(() =>
      r.register("fs.readFile", async () => "dup"),
    ).toThrow(DuplicateToolError);
  });
});
