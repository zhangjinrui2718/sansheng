/**
 * Sansheng ToolRegistry · M4 integration
 *
 * 把 M4 fs 4 件套 + http 2 件套注册到 ToolRegistry,提供给 agent kernel / HTTP endpoints 用。
 *
 * 设计取舍:
 *   - fn throw 透传,不在 wrapper 层 try/catch 包装。
 *     原因 1:SandboxError / NetSandboxError 是 instance,instanceof 链路会丢。
 *     原因 2:HTTP /api/tools/invoke 已有全局 onError 兜底返 500 JSON,不需要 endpoint 再包一层。
 *     原因 3:栈帧(原始 throw site)完整保留,调试更友好。
 *   - 默认 sandbox = `Sandbox.create()`(异步,支持 ~/.sansheng/sandbox.json 覆盖)。
 *   - 默认 netPolicy 优先读 `~/.sansheng/net.json`,文件不存在则用 netSandbox 默认
 *     (空 allowlist + 默认 ports 80/443/8080/8443 + private IP 拒绝 + 5 MiB body cap)。
 *   - 本模块**只**组装,不动 fs.ts / http.ts / netSandbox.ts 源码。
 */
import { readFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

import { log } from "../../shared/log.js";
import { Sandbox } from "./sandbox.js";
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  listDir,
  stat as fsStat,
} from "./fs.js";
import { fetchUrl, postJson } from "./http.js";
import {
  type NetPolicy,
  resolveNetPolicy,
} from "./netSandbox.js";
import { ToolRegistry } from "./registry.js";

/**
 * 加载 ~/.sansheng/net.json。文件不存在 → null(caller 用默认)。
 * 解析失败 → warn + return null(同 sandbox 模式的容错策略:避免静默回退到错 policy,但也不应让
 * 一个配错文件让整个 server 起不来 —— M5 会做更严格的 schema 校验)。
 */
async function loadNetPolicyFromFile(path?: string): Promise<NetPolicy | null> {
  const cfgPath = path ?? join(osHomedir(), ".sansheng", "net.json");
  let raw: string;
  try {
    raw = await readFile(cfgPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    log.warn(`integration: failed to read ${cfgPath}, falling back to default:`, err);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`integration: ${cfgPath} is not valid JSON, falling back to default:`, err);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    log.warn(`integration: ${cfgPath} is not an object, falling back to default`);
    return null;
  }
  const obj = parsed as { allowlist?: unknown };
  if (!Array.isArray(obj.allowlist)) {
    log.warn(`integration: ${cfgPath} missing 'allowlist' array, falling back to default`);
    return null;
  }
  const allowlist: string[] = [];
  for (const h of obj.allowlist) {
    if (typeof h === "string" && h.length > 0) allowlist.push(h);
  }
  return resolveNetPolicy({ allowlist });
}

/** 默认 netPolicy(conservative:空 allowlist = 全部 deny)。 */
function defaultNetPolicy(): NetPolicy {
  return resolveNetPolicy({ allowlist: [] });
}

export interface CreateToolRegistryOptions {
  /** 显式 sandbox;不传 → Sandbox.create()(异步,从 ~/.sansheng/sandbox.json 加载)。 */
  sandbox?: Sandbox;
  /** 显式 net policy;不传 → loadNetPolicyFromFile() 或 default。 */
  netPolicy?: NetPolicy;
}

/**
 * 创建一个装好 M4 fs+http 6 个工具的 ToolRegistry。
 *
 * 默认行为:
 *   - sandbox = Sandbox.create()(从 ~/.sansheng/sandbox.json 读盘;失败/不存在用默认 policy)
 *   - netPolicy = loadNetPolicyFromFile()(失败/不存在用空 allowlist 默认)
 *
 * 显式传 opts.sandbox / opts.netPolicy 时跳过文件加载(测试用)。
 */
export async function createToolRegistry(
  opts: CreateToolRegistryOptions = {},
): Promise<ToolRegistry> {
  const sandbox = opts.sandbox ?? (await Sandbox.create());
  const netPolicy = opts.netPolicy ?? ((await loadNetPolicyFromFile()) ?? defaultNetPolicy());

  const registry = new ToolRegistry();

  registry.register(
    "fs.readFile",
    async (args: unknown) => {
      const a = (args ?? {}) as { path?: unknown; encoding?: unknown };
      if (typeof a.path !== "string") {
        throw new TypeError("fs.readFile: 'path' must be a string");
      }
      const encoding =
        a.encoding === "base64" || a.encoding === "utf8" ? a.encoding : undefined;
      return fsReadFile(sandbox, a.path, encoding ? { encoding } : {});
    },
    "Read a file from the canvas (utf8 or base64)",
  );

  registry.register(
    "fs.writeFile",
    async (args: unknown) => {
      const a = (args ?? {}) as {
        path?: unknown;
        content?: unknown;
        createDirs?: unknown;
      };
      if (typeof a.path !== "string") {
        throw new TypeError("fs.writeFile: 'path' must be a string");
      }
      if (typeof a.content !== "string" && !(a.content instanceof Uint8Array)) {
        throw new TypeError("fs.writeFile: 'content' must be string or Uint8Array");
      }
      const createDirs = typeof a.createDirs === "boolean" ? a.createDirs : undefined;
      return fsWriteFile(
        sandbox,
        a.path,
        a.content,
        createDirs !== undefined ? { createDirs } : {},
      );
    },
    "Write content to canvas (atomic, mkdir -p optional)",
  );

  registry.register(
    "fs.listDir",
    async (args: unknown) => {
      const a = (args ?? {}) as {
        path?: unknown;
        includeHidden?: unknown;
        maxEntries?: unknown;
      };
      if (typeof a.path !== "string") {
        throw new TypeError("fs.listDir: 'path' must be a string");
      }
      const includeHidden =
        typeof a.includeHidden === "boolean" ? a.includeHidden : undefined;
      const maxEntries =
        typeof a.maxEntries === "number" ? a.maxEntries : undefined;
      const opts: { includeHidden?: boolean; maxEntries?: number } = {};
      if (includeHidden !== undefined) opts.includeHidden = includeHidden;
      if (maxEntries !== undefined) opts.maxEntries = maxEntries;
      return listDir(sandbox, a.path, opts);
    },
    "List a directory in the canvas",
  );

  registry.register(
    "fs.stat",
    async (args: unknown) => {
      const a = (args ?? {}) as { path?: unknown };
      if (typeof a.path !== "string") {
        throw new TypeError("fs.stat: 'path' must be a string");
      }
      return fsStat(sandbox, a.path);
    },
    "Stat a file/dir in the canvas",
  );

  registry.register(
    "http.fetch",
    async (args: unknown) => {
      const a = (args ?? {}) as {
        url?: unknown;
        method?: unknown;
        headers?: unknown;
        maxBytes?: unknown;
        timeoutMs?: unknown;
      };
      if (typeof a.url !== "string") {
        throw new TypeError("http.fetch: 'url' must be a string");
      }
      const method =
        a.method === "GET" || a.method === "HEAD" ? a.method : undefined;
      const headers =
        a.headers && typeof a.headers === "object" && !Array.isArray(a.headers)
          ? (a.headers as Record<string, string>)
          : undefined;
      const maxBytes = typeof a.maxBytes === "number" ? a.maxBytes : undefined;
      const timeoutMs = typeof a.timeoutMs === "number" ? a.timeoutMs : undefined;
      return fetchUrl(
        a.url,
        {
          ...(method ? { method } : {}),
          ...(headers ? { headers } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
        netPolicy,
      );
    },
    "HTTP GET/HEAD to a public URL (allowlisted ports only)",
  );

  registry.register(
    "http.postJson",
    async (args: unknown) => {
      const a = (args ?? {}) as {
        url?: unknown;
        body?: unknown;
        headers?: unknown;
        maxBytes?: unknown;
        timeoutMs?: unknown;
      };
      if (typeof a.url !== "string") {
        throw new TypeError("http.postJson: 'url' must be a string");
      }
      const headers =
        a.headers && typeof a.headers === "object" && !Array.isArray(a.headers)
          ? (a.headers as Record<string, string>)
          : undefined;
      const maxBytes = typeof a.maxBytes === "number" ? a.maxBytes : undefined;
      const timeoutMs = typeof a.timeoutMs === "number" ? a.timeoutMs : undefined;
      return postJson(
        a.url,
        a.body,
        {
          ...(headers ? { headers } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
        netPolicy,
      );
    },
    "HTTP POST with JSON body to a public URL",
  );

  return registry;
}
