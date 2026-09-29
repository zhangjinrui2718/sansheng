/**
 * Sansheng http tools / netSandbox 单元测试 · M4
 *
 * 11 cases 覆盖(超出 10 最低要求):
 *  - happy GET(本地 ephemeral server)
 *  - happy POST JSON
 *  - blocked host(URL 不在 allowlist)
 *  - private IP 拒绝(默认 policy)
 *  - private IP 允许(privateIpsAllowed:true)
 *  - blocked port(URL 是 port 9999)
 *  - bad scheme(ftp://)
 *  - too large(下载超过 maxBytes)
 *  - timeout(server hang)
 *  - DNS resolve failed
 *  - HEAD method
 *
 * 测试 fixture 的本地 server 必须在 afterAll 关闭,不能 leak port。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { fetchUrl, postJson } from "../../src/server/tools/http.js";
import {
  NetSandboxError,
  isPrivateHost,
  hostRuleMatches,
  isHostAllowed,
  checkNetRequest,
  type NetPolicy,
} from "../../src/server/tools/netSandbox.js";

/**
 * 通用 netSandbox policy fixture。
 *  - 默认 allowlist 包含 127.0.0.1(loopback)用 `privateIpsAllowed:true` 显式放行
 *  - 端口默认 80/443/8080/8443;test server 用 0 → assigned PORT 帮透传(走非标端口需 allowPorts 显式)
 */
function policyForLocalServer(port: number, opts?: { maxBytes?: number }): NetPolicy {
  return {
    allowlist: ["127.0.0.1", "localhost"],
    allowedPorts: new Set<number>([80, 443, 8080, 8443, port]),
    privateIpsAllowed: true,
    maxBytes: opts?.maxBytes,
  };
}

let server: Server;
let port: number;
let lastBody = "";
let lastContentType = "";
let lastMethod = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      lastMethod = req.method ?? "GET";
      lastContentType = req.headers["content-type"] ?? "";

      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        lastBody = Buffer.concat(chunks).toString("utf8");

        const url = req.url ?? "/";
        // /slow path 用于 timeout 测试,故意不响应
        if (url === "/slow") {
          return; // hang
        }
        if (url === "/big") {
          // chunked transfer-encoding,服务端不写 Content-Length
          res.writeHead(200, {
            "content-type": "text/plain",
            "transfer-encoding": "chunked",
          });
          // 写 1MB 块 × 10 = 10MB
          const chunk = Buffer.alloc(1024 * 1024, "x");
          let i = 0;
          const tick = setInterval(() => {
            if (i >= 10) {
              clearInterval(tick);
              res.end();
              return;
            }
            res.write(chunk);
            i += 1;
          }, 10);
          return;
        }
        if (url === "/echo" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              echo: lastBody,
              contentType: lastContentType,
              method: lastMethod,
            }),
          );
          return;
        }
        // default 200 OK with small body
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`hello ${url}`);
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
});

describe("netSandbox · pure helpers", () => {
  it("isPrivateHost recognizes common private IPv4 ranges", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.254")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("1.1.1.1")).toBe(false);
  });

  it("isPrivateHost recognizes IPv6 loopback / link-local / ULA", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("fc00::1")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
  });

  it("hostRuleMatches handles exact and wildcard", () => {
    expect(hostRuleMatches("example.com", "example.com")).toBe(true);
    expect(hostRuleMatches("example.com", "sub.example.com")).toBe(false);
    expect(hostRuleMatches("*.example.com", "a.example.com")).toBe(true);
    expect(hostRuleMatches("*.example.com", "example.com")).toBe(false);
    expect(hostRuleMatches("*.example.com", "b.a.example.com")).toBe(true);
    expect(hostRuleMatches("EXAMPLE.com", "example.com")).toBe(true); // case-insensitive
  });

  it("isHostAllowed walks the allowlist", () => {
    expect(isHostAllowed("a.example.com", ["example.com", "*.example.com"])).toBe(
      true,
    );
    expect(isHostAllowed("evil.test", ["example.com"])).toBe(false);
    expect(isHostAllowed("anything", [])).toBe(false);
  });

  it("checkNetRequest rejects bad scheme", () => {
    const policy: NetPolicy = { allowlist: ["example.com"] };
    expect(() => checkNetRequest("ftp://example.com/", policy)).toThrowError(
      NetSandboxError,
    );
    try {
      checkNetRequest("ftp://example.com/", policy);
    } catch (e) {
      expect((e as NetSandboxError).code).toBe("bad_scheme");
    }
  });

  it("checkNetRequest rejects host not in allowlist", () => {
    const policy: NetPolicy = { allowlist: ["example.com"] };
    expect(() =>
      checkNetRequest("http://attacker.test/", policy),
    ).toThrowError(NetSandboxError);
    try {
      checkNetRequest("http://attacker.test/", policy);
    } catch (e) {
      expect((e as NetSandboxError).code).toBe("blocked_host");
    }
  });
});

describe("http tools · happy paths", () => {
  it("fetchUrl GET returns body and headers", async () => {
    const url = `http://127.0.0.1:${port}/world`;
    const policy = policyForLocalServer(port);
    const res = await fetchUrl(url, {}, policy);
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello /world");
    expect(res.bodyTruncated).toBe(false);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-type"]).toBeDefined();
  });

  it("postJson sends JSON and echoes it", async () => {
    const url = `http://127.0.0.1:${port}/echo`;
    const policy = policyForLocalServer(port);
    const payload = { hello: "world", n: 42 };
    const res = await postJson(url, payload, {}, policy);
    expect(res.status).toBe(200);
    const echo = JSON.parse(res.body);
    expect(echo.method).toBe("POST");
    expect(echo.contentType).toContain("application/json");
    expect(JSON.parse(echo.echo)).toEqual(payload);
  });

  it("fetchUrl HEAD returns empty body", async () => {
    const url = `http://127.0.0.1:${port}/world`;
    const policy = policyForLocalServer(port);
    const res = await fetchUrl(url, { method: "HEAD" }, policy);
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
    expect(res.bodyTruncated).toBe(false);
  });
});

describe("http tools · sandbox rejections", () => {
  it("blocked host: URL not in allowlist", async () => {
    const policy: NetPolicy = {
      allowlist: ["example.com"],
      privateIpsAllowed: true,
    };
    let caught: NetSandboxError | null = null;
    try {
      await fetchUrl("http://127.0.0.1:1/x", {}, policy);
    } catch (e) {
      caught = e as NetSandboxError;
    }
    expect(caught).toBeInstanceOf(NetSandboxError);
    expect(caught?.code).toBe("blocked_host");
  });

  it("private IP rejected by default policy", async () => {
    const policy: NetPolicy = {
      allowlist: ["127.0.0.1"], // 即使 allow,private IP 默认仍拒
    };
    let caught: NetSandboxError | null = null;
    try {
      await fetchUrl("http://127.0.0.1:1/x", {}, policy);
    } catch (e) {
      caught = e as NetSandboxError;
    }
    expect(caught).toBeInstanceOf(NetSandboxError);
    expect(caught?.code).toBe("private_ip");
  });

  it("private IP allowed when privateIpsAllowed=true", async () => {
    const policy: NetPolicy = {
      allowlist: ["127.0.0.1"],
      privateIpsAllowed: true,
      allowedPorts: new Set<number>([port]),
    };
    const url = `http://127.0.0.1:${port}/world`;
    const res = await fetchUrl(url, {}, policy);
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello /world");
  });

  it("blocked port: port 9999 not in default allowlist", async () => {
    const policy: NetPolicy = {
      allowlist: ["example.com"],
      privateIpsAllowed: true,
      allowedPorts: new Set<number>([80, 443]), // 不含 9999
    };
    let caught: NetSandboxError | null = null;
    try {
      await fetchUrl("http://example.com:9999/", {}, policy);
    } catch (e) {
      caught = e as NetSandboxError;
    }
    expect(caught).toBeInstanceOf(NetSandboxError);
    expect(caught?.code).toBe("blocked_port");
  });

  it("bad scheme: ftp:// rejected", async () => {
    const policy: NetPolicy = { allowlist: ["example.com"] };
    let caught: NetSandboxError | null = null;
    try {
      await fetchUrl("ftp://example.com/x", {}, policy);
    } catch (e) {
      caught = e as NetSandboxError;
    }
    expect(caught).toBeInstanceOf(NetSandboxError);
    expect(caught?.code).toBe("bad_scheme");
  });

  it("too large: body over limit truncated", async () => {
    const policy = policyForLocalServer(port, { maxBytes: 2 * 1024 * 1024 }); // 2 MiB
    const url = `http://127.0.0.1:${port}/big`;
    const res = await fetchUrl(url, {}, policy);
    expect(res.status).toBe(200);
    expect(res.bodyTruncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("timeout: server hang triggers timeout error", async () => {
    const policy = policyForLocalServer(port);
    const url = `http://127.0.0.1:${port}/slow`;
    let caught: NetSandboxError | null = null;
    try {
      await fetchUrl(url, { timeoutMs: 200 }, policy);
    } catch (e) {
      caught = e as NetSandboxError;
    }
    expect(caught).toBeInstanceOf(NetSandboxError);
    expect(caught?.code).toBe("timeout");
  });

  it("DNS resolve failed: invalid host", async () => {
    const policy: NetPolicy = {
      allowlist: ["*.invalid"],
    };
    let caught: NetSandboxError | null = null;
    try {
      await fetchUrl(
        "http://does-not-exist-host-12345.invalid/",
        {},
        policy,
      );
    } catch (e) {
      caught = e as NetSandboxError;
    }
    expect(caught).toBeInstanceOf(NetSandboxError);
    // DNS failure → resolve_failed(网络层未连接成功)
    expect(caught?.code).toBe("resolve_failed");
  });
});