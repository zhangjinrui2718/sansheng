/**
 * Sansheng 平台 · MCP · **secret 存放**(`<dataDir>/harness/mcp/secrets.json`,0600)
 *
 * ── 为什么单独一个文件,而不是塞进 `servers.json` ─────────────────
 *
 * ① **权限位不同**。这一份含明文(经 Keyring 加密后的密文),所以它要 0600;
 *    目录文件要能被 git diff / 人眼读。合成一个文件 ⇒ 整个文件都得 0600,
 *    于是「看一眼配置」也要 root。
 * ② **写入节奏不同**。定义是「建 server 时写一次」,secret 是「换 token 时改」;
 *    合成一份 ⇒ 改 token 要重写整个定义,而定义里那些**不该**被 secret 写入
 *    的代码路径碰一遍。
 * ③ **可见性边界**。读面(HTTP / 工具)只读 `servers.json`;secret 只在
 *    「拼 pi 配置那一刻」被读一次,替换进内存对象,**绝不回写**。
 *
 * ── 明文 secret 不许出现在哪(全部由 `tests/platform/mcp-config.test.ts` grep 落盘字节断言)──
 *
 *   任何数据库 / 任何 API 响应 / 任何日志 / 任何回读。
 *   所以这一层只有两个出口:`seal`(写盘)与 `open`(喂给 pi),
 *   **没有 toJSON / 没有 toString**。
 *
 * ── 端口而不是直接用 `Keyring` ──────────────────────────────────
 *
 * `Keyring` 是在 `bootPlatform` 内部 new 的,**没有**挂到 `RuntimeDeps` 上
 * (它只被 `SettingsStore` 持有)。为了让 `solve.ts` 与测试都能注入,这里定义
 * 一个**更窄的端口** `SecretStore`(只有 seal / open 两个动作),
 * 生产实现由 `boot.ts` 用真 `Keyring` 造。
 *
 * ⚠️ 这样做的代价是:`Keyring` 仍然在 boot 内部 new 两次(一次给
 * `SettingsStore`,一次给这里)。同一个 masterKey、同一个文件(`.keyring`),
 * 所以**两份密文能互相解开** —— 这正是我们要的(否则换 token 要重登 provider)。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpDir } from "./config.js";
import type { McpServerDef } from "./config.js";

/** 密文前缀。落盘的值必须带它 —— 没有前缀的一律按「明文」拒绝(见 `open`)。 */
export const SECRET_PREFIX = "enc:";

/**
 * secret 存取端口。
 *
 * ⚠️ **窄到只有两个动作**是刻意的:它没有 `readFile`,没有 `dump`,
 * 没有「列出全部明文」。类型层就把「顺手把明文打出来」这条路堵掉了。
 */
export interface SecretStore {
  /** 明文 → 落盘值(带 `enc:` 前缀)。 */
  seal(plain: string): string;
  /** 落盘值 → 明文。**不接受**没有 `enc:` 前缀的值。 */
  open(stored: string): string;
}

/** 生产实现:直接包 `Keyring` 的 `encrypt` / `decrypt`。 */
export function keyringSecretStore(keyring: { encrypt(v: string): string; decrypt(v: string): string }): SecretStore {
  return {
    seal: (plain) => `${SECRET_PREFIX}${keyring.encrypt(plain)}`,
    // ⚠️ 不接受明文直通。`Keyring.decrypt` 自己有一条「明文直通」的分支
    // (`isEncrypted` 为 false 就原样返回),而那在这里是一个**危险**的默认:
    // 一个被手工塞进 secrets.json 的明文会被静默采用,而用户以为它是加密的。
    open: (stored) => {
      if (!stored.startsWith(SECRET_PREFIX)) {
        throw new Error("secret 不是加密格式(缺 enc: 前缀)—— 不接受明文,重新写一次");
      }
      return keyring.decrypt(stored.slice(SECRET_PREFIX.length));
    },
  };
}

export function secretsPath(dataDir: string): string {
  return join(mcpDir(dataDir), "secrets.json");
}

/** 一条 server 的明文 secret(env 与 headers 分开,因为它们是两个命名空间)。 */
export interface McpSecrets {
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}

/** 落盘形状:`{ "<server>": { env?: {...}, headers?: {...} } }`,值全是 `enc:` 密文。 */
interface SecretsFile {
  readonly servers?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
}

/** 一条 server 的 (env, headers) 两张表 —— 密文形态。 */
export interface SecretMaps {
  readonly env: Record<string, string>;
  readonly headers: Record<string, string>;
}

/** 读取某条 server 的**密文**。读不到 / 坏文件 ⇒ 空(不是「明文空」)。 */
export function readEncryptedSecrets(
  dataDir: string,
  serverName: string,
): SecretMaps {
  const path = secretsPath(dataDir);
  const empty = { env: {}, headers: {} };
  if (!existsSync(path)) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // 坏文件当成「没有 secret」而不是崩掉:secret 缺失的后果是这个 server
    // 连不上(pi 会报错,日志里有),而崩溃的后果是整个平台起不来。
    return empty;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const servers = (raw as SecretsFile).servers;
  if (servers === undefined || servers === null || typeof servers !== "object") return empty;
  const one = servers[serverName];
  if (one === undefined || one === null || typeof one !== "object") return empty;
  return {
    env: pickStringMap(one.env),
    headers: pickStringMap(one.headers),
  };
}

function pickStringMap(v: unknown): Record<string, string> {
  if (v === undefined || v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

/** 写一条 server 的 secret(整体替换它那一份)。返回回读到的密文形状。 */
export function writeEncryptedSecrets(
  dataDir: string,
  serverName: string,
  secrets: McpSecrets,
): SecretMaps {
  const path = secretsPath(dataDir);
  mkdirSync(mcpDir(dataDir), { recursive: true });

  let file: SecretsFile = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        file = parsed as SecretsFile;
      }
    } catch {
      file = {};
    }
  }
  const servers = { ...(file.servers ?? {}) };
  const entry: { env?: Record<string, string>; headers?: Record<string, string> } = {};
  if (secrets.env !== undefined && Object.keys(secrets.env).length > 0) entry.env = { ...secrets.env };
  if (secrets.headers !== undefined && Object.keys(secrets.headers).length > 0) entry.headers = { ...secrets.headers };
  if (entry.env === undefined && entry.headers === undefined) delete servers[serverName];
  else servers[serverName] = entry;

  const payload = JSON.stringify({ servers }, null, 2);
  // ⚠️ 先以 0600 建,再 chmod 一次:`writeFileSync` 的 `mode` 只对**新建**生效,
  // 而覆盖一个已存在的 0644 文件时它会被沿用(Keyring 的 `tightenKeyringPermissions`
  // 记的就是这个坑)。
  writeFileSync(path, payload, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort:见 docs/SECURITY-NOTES.md 的威胁模型。写盘已经成功,
    // 而把整个 server 配置判成「不可用」比一个宽一档的权限位更糟。
  }
  return { env: entry.env ?? {}, headers: entry.headers ?? {} };
}

/** 删掉一条 server 的 secret(定义被删时由写面调用)。 */
export function deleteEncryptedSecrets(dataDir: string, serverName: string): void {
  const path = secretsPath(dataDir);
  if (!existsSync(path)) return;
  let file: SecretsFile;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    file =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SecretsFile) : {};
  } catch {
    return;
  }
  const servers = { ...(file.servers ?? {}) };
  if (!(serverName in servers)) return;
  delete servers[serverName];
  writeFileSync(path, JSON.stringify({ servers }, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}

/** 这条 server 有没有 secret(**只给布尔值,永不给值**)。 */
export function hasSecrets(dataDir: string, serverName: string): boolean {
  const s = readEncryptedSecrets(dataDir, serverName);
  return Object.keys(s.env).length > 0 || Object.keys(s.headers).length > 0;
}

/**
 * 解出这条 server 的明文 secret,并替换进 `env` / `headers`。
 *
 * ⚠️ **纯内存**:返回的是一个**新对象**,输入 `def` 一个字节都不改,也没有任何
 * 回写路径。拼好的对象直接交给 pi 的 `LoadedMcpConfig`,会话结束即消失。
 *
 * 解不开(密文格式不对 / keyring 不是同一个)⇒ **不静默降级成空字符串** ——
 * 那会让 server 拿一个错的凭据去连,然后报一个与真实原因无关的 401。
 * 这里把该键从结果里**删掉**并在 `unresolved` 里点名,pi 会因为缺变量而
 * 自己报错,而名字在 wiring 与日志里都看得见。
 */
export function withResolvedSecrets(
  dataDir: string,
  def: McpServerDef,
  store: SecretStore,
): {
  readonly env: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly unresolved: readonly string[];
} {
  const stored = readEncryptedSecrets(dataDir, def.name);
  const unresolved: string[] = [];

  const resolveOne = (
    plain: Readonly<Record<string, string>> | undefined,
    cipher: Record<string, string>,
    field: string,
  ): Record<string, string> => {
    const out: Record<string, string> = { ...(plain ?? {}) };
    for (const [k, v] of Object.entries(cipher)) {
      try {
        out[k] = store.open(v);
      } catch (err) {
        // 不写 `out[k] = ""` —— 那是「拿空凭据去连」的自信的假话。
        unresolved.push(`${field}.${k}:${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  };

  return {
    env: resolveOne(def.env, stored.env, "env"),
    headers: resolveOne(def.headers, stored.headers, "headers"),
    unresolved,
  };
}
