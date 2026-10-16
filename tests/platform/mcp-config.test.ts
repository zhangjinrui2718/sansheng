/**
 * MCP · server 目录(`servers.json`)与 secret 存放
 *
 * ── 这一组守着的三件事 ──────────────────────────────────────────
 *
 * ① **`!command` 被硬拒绝。** pi 的 `!cmd` 语法是「执行这条命令并取它的输出」——
 *    那是一条**配置里就能打开的任意命令执行通道**。它写在 `env` / `headers` 的
 *    值里,所以判据必须落在**值**上,而不是靠文档提醒。
 * ② **明文 secret 不落在任何地方。** 这一条不是靠读代码确认的,是**真的去 grep
 *    落盘的字节**:目录文件、secret 文件、备份文件,逐个读出来找那个明文串。
 *    「代码里看不到明文」与「盘上没有明文」是两件事 —— 7-N 的现场纪律。
 * ③ **坏目录文件不静默。** `state: "invalid"` + `problem` 非空,而且**整份不生效**
 *    (不是「挑几条能解析的继续用」):半份生效的目录意味着「你以为接上的和实际
 *    接上的不一样」,那比全不生效更难查。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMcpCatalog, resolveMcpCatalog, isValidServerName, serversPath, mcpDir,
  writeMcpCatalog, toCatalogEntry,
} from "../../src/platform/mcp/config.js";
import {
  readEncryptedSecrets, writeEncryptedSecrets, deleteEncryptedSecrets, hasSecrets, withResolvedSecrets,
  keyringSecretStore, SECRET_PREFIX,
} from "../../src/platform/mcp/secrets.js";
import { strayMcpFiles } from "../../src/platform/mcp/grants.js";
import { Keyring } from "../../src/platform/infra/keyring.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sansheng-mcp-cfg-"));
  dirs.push(d);
  return d;
}

function writeCatalog(dataDir: string, raw: unknown): void {
  mkdirSync(mcpDir(dataDir), { recursive: true });
  writeFileSync(serversPath(dataDir), JSON.stringify(raw, null, 2), "utf8");
}

describe("mcp-config · 目录解析与校验", () => {
  it("stdio / http 两种形状各认一种,解析后带对 transport", () => {
    const p = parseMcpCatalog({
      servers: {
        docs: { command: "npx", args: ["-y", "server-docs"], description: "文档库" },
        sentry: { url: "https://mcp.sentry.dev/mcp" },
      },
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.servers.map((s) => [s.name, s.transport])).toEqual([
      ["docs", "stdio"],
      ["sentry", "http"],
    ]);
  });

  it("**`!` 开头的 env / headers 值被拒收**,并给可执行的处置", () => {
    const p = parseMcpCatalog({
      servers: { evil: { command: "x", env: { TOKEN: "!cat ~/.keyring" } } },
    });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    // 判据是**拒收 + 说清为什么 + 说清怎么办**,不是「碰巧没过」
    expect(p.detail).toContain("执行这条命令");
    expect(p.detail).toContain("secrets");
  });

  it("`!` 开头在 headers 里同样被拒(http 形式)", () => {
    const p = parseMcpCatalog({
      servers: { evil: { url: "https://x.example/mcp", headers: { Authorization: "!op read keyring" } } },
    });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.detail).toContain("执行这条命令");
  });

  it("`${VAR}` 引用**原样保留**(不展开、不拦)", () => {
    const p = parseMcpCatalog({
      servers: { docs: { url: "https://x.example/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } } },
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.servers[0].headers).toEqual({ Authorization: "Bearer ${DOCS_TOKEN}" });
  });

  it("command 与 url **两个都有 / 两个都没有**都拒", () => {
    const both = parseMcpCatalog({ servers: { x: { command: "a", url: "https://b" } } });
    expect(both.ok).toBe(false);
    const neither = parseMcpCatalog({ servers: { x: { description: "什么传输都不是" } } });
    expect(neither.ok).toBe(false);
  });

  it("server 名只允许字母 / 数字 / _ / -", () => {
    expect(isValidServerName("docs")).toBe(true);
    expect(isValidServerName("my-server_2")).toBe(true);
    expect(isValidServerName("../escape")).toBe(false);
    expect(isValidServerName("a.b")).toBe(false);
    expect(isValidServerName("")).toBe(false);
    const p = parseMcpCatalog({ servers: { "../escape": { command: "x" } } });
    expect(p.ok).toBe(false);
  });

  it("**任何一条不合法 ⇒ 整份 invalid**(不是挑几条继续用)", () => {
    const p = parseMcpCatalog({
      servers: { good: { command: "x" }, bad: { command: "y", url: "https://z" } },
    });
    expect(p.ok).toBe(false);
  });

  it("盘上没有目录文件 ⇒ `absent`(不是「空目录」,也不是故障)", () => {
    const c = resolveMcpCatalog(tmp());
    expect(c.state).toBe("absent");
    expect(c.servers).toEqual([]);
    expect(c.problem).toBeUndefined();
  });

  it("坏文件 → `invalid` + problem 可见 + 零 server 生效", () => {
    const d = tmp();
    mkdirSync(mcpDir(d), { recursive: true });
    writeFileSync(serversPath(d), "{ 这不是 json", "utf8");
    const c = resolveMcpCatalog(d);
    expect(c.state).toBe("invalid");
    expect(c.servers).toEqual([]);
    expect(c.problem).toContain("没有生效");
  });

  it("**一条合法 server 不影响另一条被拒的效果**:坏目录里一条都不生效", () => {
    const d = tmp();
    writeCatalog(d, { servers: { good: { command: "x" }, bad: {} } });
    expect(resolveMcpCatalog(d).servers).toEqual([]);
  });

  it("stray 文件被报出(落在空处的意图)", () => {
    const d = tmp();
    mkdirSync(mcpDir(d), { recursive: true });
    writeFileSync(join(mcpDir(d), "pm.json"), '{"allow":[],"deny":[]}', "utf8");
    writeFileSync(join(mcpDir(d), "servers.json"), '{"servers":{}}', "utf8");
    writeFileSync(join(mcpDir(d), "secrets.json"), '{"servers":{}}', "utf8");
    writeFileSync(join(mcpDir(d), "notes.txt"), "x", "utf8");
    expect(strayMcpFiles(d)).toEqual(["pm.json"]);
  });

  it("写面:报成功 = **回读**磁盘上那份(不是内存入参)", () => {
    const d = tmp();
    const w = writeMcpCatalog(
      d,
      {
        servers: [{ name: "docs", transport: "http", url: "https://x.example/mcp" }],
        state: "ok",
        path: serversPath(d),
        problem: undefined,
      },
      1_700_000_000_000,
    );
    expect(w.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(serversPath(d), "utf8")) as Record<string, unknown>;
    expect(onDisk).toEqual({ servers: { docs: { url: "https://x.example/mcp" } } });
  });
});

describe("mcp-config · secret:明文不在任何落盘字节里", () => {
  it("`enc:` 前缀 + 0600;明文 grep 不到目录文件 / secret 文件 / 备份", () => {
    const d = tmp();
    const keyring = new Keyring(join(d, ".keyring"));
    const store = keyringSecretStore(keyring);
    const PLAINTEXT = "sk-super-secret-value-1234567890";

    writeCatalog(d, { servers: { docs: { url: "https://x.example/mcp", headers: { Authorization: "${TOKEN}" } } } });
    writeEncryptedSecrets(d, "docs", { headers: { Authorization: store.seal(PLAINTEXT) } });

    // 权限位
    const st = statSync(join(mcpDir(d), "secrets.json"));
    expect(st.mode & 0o777).toBe(0o600);

    // 真的去 grep 落盘的每一个字节文件
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const files = walk(d).filter((f) => !f.endsWith(".keyring"));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      expect(readFileSync(f, "utf8"), `${f} 里有明文 secret`).not.toContain(PLAINTEXT);
    }

    // 但它确实能解回来(否则上面是「什么都没写」的假通过)
    const stored = readEncryptedSecrets(d, "docs");
    expect(stored.headers["Authorization"].startsWith(SECRET_PREFIX)).toBe(true);
    const resolved = withResolvedSecrets(
      d,
      { name: "docs", transport: "http", url: "https://x.example/mcp", headers: { Authorization: "${TOKEN}" } },
      store,
    );
    expect(resolved.headers).toEqual({ Authorization: PLAINTEXT });
    expect(resolved.unresolved).toEqual([]);
  });

  it("**没有 `enc:` 前缀的值一律拒收**(不接受手工塞进来的明文)", () => {
    const store = keyringSecretStore(new Keyring(join(tmp(), ".keyring")));
    expect(() => store.open("明文")).toThrow(/enc:/);
  });

  it("解不开的 secret **不降级成空串**,而是点名报出来", () => {
    const d = tmp();
    const store = keyringSecretStore(new Keyring(join(d, ".keyring")));
    writeEncryptedSecrets(d, "docs", { headers: { Authorization: store.seal("v") } });
    // 换一个 keyring(= 另一个 masterKey)去解
    // ⚠️ `.keyring2` 是**另一个** masterKey —— 解不开正是要测的那件事
    const other = keyringSecretStore(new Keyring(join(d, "other.keyring")));
    const resolved = withResolvedSecrets(
      d,
      { name: "docs", transport: "http", url: "https://x/mcp", headers: {} },
      other,
    );
    expect(resolved.unresolved.length).toBe(1);
    // ⚠️ 关键:那个键**不在**结果里 —— 拿空凭据去连比报错更难查
    expect(resolved.headers).toEqual({});
  });

  it("secret 文件不存在 / 坏掉 ⇒ 读成空(不是崩,也不是明文)", () => {
    const d = tmp();
    expect(readEncryptedSecrets(d, "nope")).toEqual({ env: {}, headers: {} });
    mkdirSync(mcpDir(d), { recursive: true });
    writeFileSync(join(mcpDir(d), "secrets.json"), "{{{", "utf8");
    expect(readEncryptedSecrets(d, "nope")).toEqual({ env: {}, headers: {} });
    expect(hasSecrets(d, "nope")).toBe(false);
  });

  it("删 server 时 secret 一起删", () => {
    const d = tmp();
    const store = keyringSecretStore(new Keyring(join(d, ".keyring")));
    writeEncryptedSecrets(d, "docs", { env: { K: store.seal("v") } });
    expect(hasSecrets(d, "docs")).toBe(true);
    deleteEncryptedSecrets(d, "docs");
    expect(hasSecrets(d, "docs")).toBe(false);
  });
});

describe("mcp-config · toCatalogEntry 不带 name / 不带 secret 值", () => {
  it("name 是键,不是字段;`${VAR}` 原样带出去", () => {
    expect(toCatalogEntry({ name: "docs", transport: "http", url: "https://x", headers: { A: "${B}" } })).toEqual({
      url: "https://x",
      headers: { A: "${B}" },
    });
  });
});
