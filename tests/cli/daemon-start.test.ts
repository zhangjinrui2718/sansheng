/**
 * Sansheng CLI · B10-6 回归:daemon 假成功 + pid 身份校验
 *
 * 缺陷(docs/CODE-REVIEW-2026-10-01.md §B10-6):
 *   1. isAlive 只做 process.kill(pid,0) → stale pid 被无关进程复用时误判「在跑」,
 *      runStop 会 SIGTERM→SIGKILL 杀错进程。
 *   2. start -d spawn 后不探测健康即报成功 → 子进程秒死(EADDRINUSE/dist 缺失)
 *      仍写 pid + 报 ok。
 *
 * 覆盖(纯函数 + stub server,不真实 spawn daemon —— 见报告取舍):
 *   - isNodeComm 纯函数:node 二进制识别
 *   - isAlive 身份校验:活的非 node 进程(sleep)→ false
 *   - waitForHealth:轮询直到 200 / 超时 false / 早死(isAborted)false
 *
 * 用 namespace import:RED 阶段新增导出(isNodeComm/waitForHealth)缺失 →
 * 对应 case TypeError;isAlive 已存在 → sleep 身份 case 给出行为级 RED。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import * as cli from "../../src/cli/commands.js";

async function listenEphemeral(handler: (hits: number, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; port: number; url: string }> {
  let hits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/api/health") handler(++hits, res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://127.0.0.1:${port}/api/health` };
}

describe("CLI daemon (B10-6): pid 身份校验 + 健康轮询", () => {
  let proc: ChildProcess | null = null;
  const servers: Server[] = [];

  afterEach(() => {
    try { proc?.kill("SIGKILL"); } catch { /* ignore */ }
    proc = null;
    for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
    servers.length = 0;
  });

  it("isNodeComm: 识别 node 二进制,拒绝其他进程名", () => {
    const isNodeComm = (cli as Record<string, unknown>).isNodeComm as (c: string) => boolean;
    expect(typeof isNodeComm).toBe("function");
    expect(isNodeComm("node")).toBe(true);
    expect(isNodeComm("/usr/local/bin/node")).toBe(true);
    expect(isNodeComm("/opt/homebrew/Cellar/node/26/bin/node")).toBe(true);
    expect(isNodeComm("python3")).toBe(false);
    expect(isNodeComm("sleep")).toBe(false);
    expect(isNodeComm("")).toBe(false);
  });

  it("isAlive: 对活着的非 node 进程返回 false(身份校验,防 stale pid 误杀)", async () => {
    // sleep 5 是活进程(kill(pid,0) 成功),但 comm 不含 node → 必须判 false。
    // RED:旧 isAlive 只做 kill(pid,0) → 返回 true → 本断言失败。
    proc = spawn("sleep", ["5"]);
    await new Promise<void>((r) => proc!.once("spawn", r));
    const pid = proc.pid;
    expect(typeof pid).toBe("number");
    // 先确认进程确实活着(kill 0 不抛)
    expect(() => process.kill(pid!, 0)).not.toThrow();
    expect(cli.isAlive(pid!)).toBe(false);
  });

  it("isAlive: 对本测试进程(node)返回 true", () => {
    expect(cli.isAlive(process.pid)).toBe(true);
  });

  it("isAlive: 对不存在的 pid 返回 false", () => {
    // 极端大 pid,几乎不可能存在
    expect(cli.isAlive(2 ** 30)).toBe(false);
  });

  it("waitForHealth: 轮询直到 /api/health 返回 200 → true(前几次 503)", async () => {
    const waitForHealth = (cli as Record<string, unknown>).waitForHealth as
      | ((url: string, opts?: { timeoutMs?: number; intervalMs?: number; isAborted?: () => boolean }) => Promise<boolean>)
      | undefined;
    expect(typeof waitForHealth).toBe("function");
    const h = await listenEphemeral((hits, res) => {
      if (hits < 3) { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(h.server);
    const ok = await waitForHealth!(h.url, { timeoutMs: 5_000, intervalMs: 40 });
    expect(ok).toBe(true);
  });

  it("waitForHealth: 持续 503 → 超时返回 false", async () => {
    const waitForHealth = (cli as Record<string, unknown>).waitForHealth as
      | ((url: string, opts?: { timeoutMs?: number; intervalMs?: number; isAborted?: () => boolean }) => Promise<boolean>)
      | undefined;
    expect(typeof waitForHealth).toBe("function");
    const h = await listenEphemeral((_hits, res) => { res.writeHead(503); res.end(); });
    servers.push(h.server);
    const ok = await waitForHealth!(h.url, { timeoutMs: 400, intervalMs: 40 });
    expect(ok).toBe(false);
  });

  it("waitForHealth: 连接被拒(无 server)→ 超时返回 false", async () => {
    const waitForHealth = (cli as Record<string, unknown>).waitForHealth as
      | ((url: string, opts?: { timeoutMs?: number; intervalMs?: number; isAborted?: () => boolean }) => Promise<boolean>)
      | undefined;
    expect(typeof waitForHealth).toBe("function");
    // 端口 1 几乎必然拒连
    const ok = await waitForHealth!("http://127.0.0.1:1/api/health", { timeoutMs: 400, intervalMs: 40 });
    expect(ok).toBe(false);
  });

  it("waitForHealth: isAborted 提前置真(子进程早死)→ 立即返回 false", async () => {
    const waitForHealth = (cli as Record<string, unknown>).waitForHealth as
      | ((url: string, opts?: { timeoutMs?: number; intervalMs?: number; isAborted?: () => boolean }) => Promise<boolean>)
      | undefined;
    expect(typeof waitForHealth).toBe("function");
    const started = Date.now();
    const ok = await waitForHealth!("http://127.0.0.1:1/api/health", {
      timeoutMs: 10_000,
      intervalMs: 40,
      isAborted: () => true,
    });
    expect(ok).toBe(false);
    // 早死检测必须远快于 timeoutMs
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
