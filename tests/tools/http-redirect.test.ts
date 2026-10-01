/**
 * Sansheng · A6 回归测试:netSandbox 重定向绕过(SSRF)
 *
 * 来源:docs/CODE-REVIEW-2026-10-01.md §A6(实证 302→环回穿透)。
 *
 * 缺陷形态(修复前):tools/http.ts fetch 未设 redirect,undici 默认 follow ≤20 跳;
 * checkNetRequest 只校验首个 URL,每跳 Location 的 host/port/private-IP 全不复检
 * → allowlist=["localhost"] 时 302 → http://127.0.0.1:<内部端口> 内容原样返回。
 *
 * 修复语义:redirect:"manual" + 手工循环,每跳 new URL(location, currentUrl)
 * (相对地址正确解析)→ 重过 checkNetRequest → 通过才继续;最多 5 跳,超限或
 * 复检失败 → NetSandboxError;非 3xx / 无 Location 按现状原样返回。
 *
 * 测试用本地 stub server(两个端口),afterAll 必须关闭,不 leak port。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { fetchUrl, postJson } from "../../src/server/tools/http.js";
import { NetSandboxError, type NetPolicy } from "../../src/server/tools/netSandbox.js";

let serverA: Server; // 重定向发起端(allowlist 内的 "localhost")
let serverB: Server; // 重定向目标端(另一端口)
let portA = 0;
let portB = 0;

/** 计数:RED 证据用 — 修复后未授权目标必须 0 次命中 */
let hitsInternal = 0;
let hitsLoop = 0;
let hitsFinal = 0;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    serverA = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      if (url === "/to-private-ip") {
        // 302 → 环回 IP 字面量(不在 allowlist 且是 private IP)
        res.writeHead(302, { location: `http://127.0.0.1:${portB}/internal` });
        res.end();
        return;
      }
      if (url === "/to-other-port") {
        // 302 → allowlist 内另一端口(合法跟随)
        res.writeHead(302, { location: `http://localhost:${portB}/final` });
        res.end();
        return;
      }
      if (url === "/loop") {
        hitsLoop += 1;
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      }
      if (url === "/relative") {
        // 相对 Location:必须按当前 URL 解析
        res.writeHead(302, { location: "/final-a" });
        res.end();
        return;
      }
      if (url === "/final-a") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("RELATIVE-OK");
        return;
      }
      if (url === "/no-location") {
        // 3xx 无 Location → 无法跟随,原样返回
        res.writeHead(302, { "content-type": "text/plain" });
        res.end("NO-LOCATION");
        return;
      }
      if (url === "/post-redirect" && req.method === "POST") {
        void readBody(req).then(() => {
          // 302 + POST → 浏览器语义:转 GET 丢 body 跟随
          res.writeHead(302, { location: `http://localhost:${portB}/echo-method` });
          res.end();
        });
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not-found-A");
    });
    serverA.listen(0, () => {
      portA = (serverA.address() as AddressInfo).port;
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    serverB = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      if (url === "/internal") {
        hitsInternal += 1;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("INTERNAL-SECRET");
        return;
      }
      if (url === "/final") {
        hitsFinal += 1;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("FINAL-OK");
        return;
      }
      if (url === "/echo-method") {
        void readBody(req).then((body) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ method: req.method, body }));
        });
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not-found-B");
    });
    serverB.listen(0, () => {
      portB = (serverB.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => serverA.close(() => resolve()));
  await new Promise<void>((resolve) => serverB.close(() => resolve()));
});

/** allowlist 只有 hostname "localhost"(非 IP 字面量);privateIpsAllowed 保持 false。 */
function policyAB(): NetPolicy {
  return {
    allowlist: ["localhost"],
    allowedPorts: new Set<number>([80, 443, 8080, 8443, portA, portB]),
    privateIpsAllowed: false,
  };
}

describe("A6 · netSandbox redirect SSRF 回归", () => {
  it("① 302 → 未授权 host/私网 IP → 必抛 NetSandboxError 不跟随(RED:200 穿透 INTERNAL-SECRET)", async () => {
    hitsInternal = 0;
    let caught: unknown;
    let result: { status: number; body: string } | null = null;
    try {
      const r = await fetchUrl(`http://localhost:${portA}/to-private-ip`, {}, policyAB());
      result = { status: r.status, body: r.body };
    } catch (e) {
      caught = e;
    }
    // RED(修复前):result = { status: 200, body: "INTERNAL-SECRET" },hitsInternal = 1
    expect(
      result,
      `BYPASS: fetch 跟随 302 穿透到 127.0.0.1:${portB}/internal → ${JSON.stringify(result)}`,
    ).toBeNull();
    expect(caught).toBeInstanceOf(NetSandboxError);
    expect((caught as NetSandboxError).code).toBe("private_ip");
    expect(hitsInternal).toBe(0);
  });

  it("② 302 → allowlist 内另一端口 → 正常跟随拿终态(合法跳转不破坏)", async () => {
    hitsFinal = 0;
    const r = await fetchUrl(`http://localhost:${portA}/to-other-port`, {}, policyAB());
    expect(r.status).toBe(200);
    expect(r.body).toBe("FINAL-OK");
    expect(hitsFinal).toBe(1);
  });

  it("③ redirect 环 → 最多 5 跳,超限抛 NetSandboxError", async () => {
    hitsLoop = 0;
    let caught: unknown;
    try {
      await fetchUrl(`http://localhost:${portA}/loop`, {}, policyAB());
    } catch (e) {
      caught = e;
    }
    // RED(修复前):undici 自跟 20 跳后抛 TypeError(非 NetSandboxError)
    expect(caught, "redirect loop must throw").toBeInstanceOf(NetSandboxError);
    expect((caught as NetSandboxError).code).toBe("too_many_redirects");
    // 首跳 1 次 + 跟随 5 次 = 6 次命中后终止
    expect(hitsLoop).toBe(6);
  });

  it("④ 相对 Location → 按当前 URL 正确解析跟随", async () => {
    const r = await fetchUrl(`http://localhost:${portA}/relative`, {}, policyAB());
    expect(r.status).toBe(200);
    expect(r.body).toBe("RELATIVE-OK");
  });

  it("⑤ 3xx 无 Location → 原样返回,不抛(响应语义不变)", async () => {
    const r = await fetchUrl(`http://localhost:${portA}/no-location`, {}, policyAB());
    expect(r.status).toBe(302);
    expect(r.body).toBe("NO-LOCATION");
  });

  it("⑥ POST + 302 → 按浏览器语义转 GET 丢 body 跟随(合法 POST 跳转不破坏)", async () => {
    const r = await postJson(
      `http://localhost:${portA}/post-redirect`,
      { x: 1 },
      {},
      policyAB(),
    );
    expect(r.status).toBe(200);
    const echoed = JSON.parse(r.body) as { method: string; body: string };
    expect(echoed.method).toBe("GET");
    expect(echoed.body).toBe("");
  });
});
