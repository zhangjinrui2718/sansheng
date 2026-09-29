/**
 * Sansheng Sandbox · M4 fs tool boundary guard
 *
 * 任何 fs 工具在触碰 node:fs 前必须先 `await sandbox.resolve(path)`。
 * resolve 会:
 *   1. 把 path 规范化(处理 `..` / `.` / 相对路径)
 *   2. fs.realpath 解开 symlink
 *   3. 校验 normalized 路径在 policy.allowlist 内 → 否则 'outside_allowlist'
 *   4. 校验 real 路径也在 allowlist 内 → 否则 'symlink_escape'
 *
 * Policy 来源优先级:
 *   显式 SandboxOptions.policy > Sandbox.create() 读 ~/.sansheng/sandbox.json > 默认 policy
 *
 * 默认 allowlist:
 *   - ~/.sansheng/workspace/      (递归)
 *   - /tmp/sansheng-canvas/       (单例 canvas,可被 newCanvasDir 按需创建)
 *
 * 默认单文件大小上限 30KB(防止 context blowup)。
 */
import { realpath, stat as fsStat, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir as osHomedir, tmpdir as osTmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { log } from "../../shared/log.js";

/** SandboxError 语义 code 枚举。 */
export type SandboxCode =
  | "outside_allowlist"
  | "too_large"
  | "not_found"
  | "symlink_escape"
  | "denied_kind";

export class SandboxError extends Error {
  public readonly code: SandboxCode;
  public readonly path?: string;
  constructor(message: string, code: SandboxCode, path?: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    this.path = path;
    Object.setPrototypeOf(this, SandboxError.prototype);
  }
}

/** Policy 单条允许规则。kind=dir 表递归子树,kind=file 表仅此单文件。 */
export interface SandboxAllowEntry {
  path: string;
  kind: "dir" | "file";
}

export interface SandboxPolicy {
  allowlist: SandboxAllowEntry[];
  /** 单文件字节上限;默认 30 * 1024。 */
  maxBytes?: number;
  /** true 表允许 symlink 跟随(默认 false: 一律拒绝 symlink 越界)。 */
  followSymlinks?: boolean;
}

export interface SandboxOptions {
  /** 显式 policy;最高优先级。 */
  policy?: SandboxPolicy;
  /** policy 文件路径;默认 ~/.sansheng/sandbox.json。 */
  configPath?: string;
  /** 覆盖默认 homedir(测试用)。 */
  homedir?: string;
  /** 覆盖默认 tmpdir(测试用)。 */
  tmpdir?: string;
}

const DEFAULT_MAX_BYTES = 30 * 1024;

/** 计算默认 policy(home + /tmp/sansheng-canvas/ 单例目录,非 per-session)。 */
export function defaultPolicy(homedir: string, tmpdir: string): SandboxPolicy {
  const ws = join(homedir, ".sansheng", "workspace");
  const canvas = join(tmpdir, "sansheng-canvas");
  return {
    allowlist: [
      { path: ws, kind: "dir" },
      { path: canvas, kind: "dir" },
    ],
    maxBytes: DEFAULT_MAX_BYTES,
    followSymlinks: false,
  };
}

/**
 * 从 JSON 文件加载 policy。
 * - 文件不存在 → null(caller 用默认)
 * - 解析失败 / 字段缺失 → throw(显式 fail-fast,避免静默回退到错 policy)
 */
export async function loadSandboxFromFile(path: string): Promise<SandboxPolicy | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`sandbox config at ${path} is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.allowlist)) {
    throw new Error(`sandbox config at ${path} missing 'allowlist' array`);
  }
  const allowlist: SandboxAllowEntry[] = [];
  for (const entry of obj.allowlist) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== "string") continue;
    const k = e.kind === "file" ? "file" : "dir";
    allowlist.push({ path: resolve(e.path), kind: k });
  }
  const policy: SandboxPolicy = { allowlist };
  if (typeof obj.maxBytes === "number" && Number.isFinite(obj.maxBytes)) {
    policy.maxBytes = obj.maxBytes;
  }
  if (typeof obj.followSymlinks === "boolean") {
    policy.followSymlinks = obj.followSymlinks;
  }
  return policy;
}

export class Sandbox {
  public readonly policy: SandboxPolicy;
  public readonly homedir: string;
  public readonly tmpdir: string;

  constructor(opts: SandboxOptions = {}) {
    this.homedir = opts.homedir ?? osHomedir();
    this.tmpdir = opts.tmpdir ?? osTmpdir();
    this.policy = opts.policy
      ? { ...opts.policy, maxBytes: opts.policy.maxBytes ?? DEFAULT_MAX_BYTES }
      : { ...defaultPolicy(this.homedir, this.tmpdir) };
  }

  /**
   * 异步工厂:支持从 `~/.sansheng/sandbox.json` 读盘合并。
   * 优先级:opts.policy > 文件 > 默认。
   */
  static async create(opts: SandboxOptions = {}): Promise<Sandbox> {
    if (opts.policy) {
      // 显式 policy 优先,跳过文件 IO
      return new Sandbox(opts);
    }
    const homedir = opts.homedir ?? osHomedir();
    const tmpdir = opts.tmpdir ?? osTmpdir();
    const cfgPath = opts.configPath ?? join(homedir, ".sansheng", "sandbox.json");
    let filePolicy: SandboxPolicy | null = null;
    try {
      filePolicy = await loadSandboxFromFile(cfgPath);
      if (filePolicy) log.info("sandbox: loaded policy from", cfgPath);
    } catch (err) {
      log.warn("sandbox: failed to load policy file, falling back to default:", err);
    }
    return new Sandbox({ ...opts, policy: filePolicy ?? undefined });
  }

  /** 大小校验;若超 policy.maxBytes → SandboxError('too_large')。 */
  checkSize(bytes: number, path?: string): void {
    const cap = this.policy.maxBytes ?? DEFAULT_MAX_BYTES;
    if (bytes > cap) {
      throw new SandboxError(
        `size ${bytes}B exceeds policy maxBytes ${cap}B`,
        "too_large",
        path,
      );
    }
  }

  /**
   * 把任意输入 path 规范化并校验到 allowlist。
   * 返回 real(absolute, symlink-resolved) path。
   *
   * - normalized 不在 allowlist → 'outside_allowlist'
   * - normalized 在 allowlist,但 realpath 后越界 → 'symlink_escape'
   * - normalized 本身不存在(常见:writeFile 新建) → 仅校验 normalized 即可
   */
  async resolve(inputPath: string): Promise<string> {
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      throw new SandboxError("path must be non-empty string", "outside_allowlist", inputPath);
    }
    const abs = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
    const normalized = resolve(abs); // collapse .. and .

    // 校验 1:normalized(未解链)必须在某条 allowlist 内
    if (!this.matchAllow(normalized)) {
      // 对 write 路径,parent 可能尚未存在 — resolveForWrite 单独处理
      throw new SandboxError(
        `path ${abs} is outside sandbox allowlist`,
        "outside_allowlist",
        abs,
      );
    }

    // 校验 2:realpath 解链
    try {
      const real = await realpath(normalized);
      if (!this.matchAllow(real)) {
        throw new SandboxError(
          `realpath ${real} (from ${abs}) is outside sandbox allowlist`,
          "symlink_escape",
          abs,
        );
      }
      return real;
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // 路径不存在(写新文件常见):返回 normalized,fs 层拿到 ENOENT 自己 wrap
        return normalized;
      }
      throw err;
    }
  }

  /**
   * 按 allowlist 规则 match 一个绝对路径。
   * dir kind:前缀匹配;file kind:完全相等。
   */
  private matchAllow(absPath: string): SandboxAllowEntry | undefined {
    for (const entry of this.policy.allowlist) {
      if (entry.kind === "dir") {
        if (absPath === entry.path) return entry;
        if (absPath.startsWith(entry.path + sep)) return entry;
      } else {
        if (absPath === entry.path) return entry;
      }
    }
    return undefined;
  }

  /**
   * 工厂:为指定 session 创建 canvas 目录(`/tmp/sansheng-<id>`)。
   * 会自动把此目录加入 policy.collateral(动态写入 allowlist)。
   * 返回绝对路径。
   */
  async newCanvasDir(sessionId: string): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error(`invalid sessionId: ${sessionId}`);
    }
    const dir = join(this.tmpdir, `sansheng-${sessionId}`);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    // 动态追加到 allowlist(mutable 引用)
    const exists = this.policy.allowlist.some((e) => e.path === dir);
    if (!exists) {
      this.policy.allowlist.push({ path: dir, kind: "dir" });
    }
    return dir;
  }

  /** 给 stat / read 等需要确认存在的工具用:resolve 后 ENOENT → 'not_found'。 */
  async statOrThrow(inputPath: string): Promise<Awaited<ReturnType<typeof fsStat>>> {
    const real = await this.resolve(inputPath);
    try {
      return await fsStat(real);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new SandboxError(`path not found: ${inputPath}`, "not_found", inputPath);
      }
      throw err;
    }
  }

  /**
   * 给 writeFile 用:resolve 后校验 size + 可选创建 parent dirs。
   * 返回 absolute target path(可直接用 fs.writeFile(target, ...))。
   */
  async resolveForWrite(
    inputPath: string,
    bytes: number,
    opts: { createDirs?: boolean } = {},
  ): Promise<string> {
    this.checkSize(bytes, inputPath);
    const abs = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
    const normalized = resolve(abs);

    // 1) 父目录必须落在 allowlist 内 — 若不存在且 createDirs,递归建
    const parent = resolve(normalized, "..");
    const parentInAllow = this.matchAllow(parent) !== undefined;
    if (!parentInAllow) {
      if (opts.createDirs) {
        // createDirs 模式:递归 mkdir,但前提是 parent 的祖先路径最终会落在 allowlist
        await this.ensureDirs(parent);
        // 创建后再校验
        if (this.matchAllow(parent) === undefined) {
          throw new SandboxError(
            `parent ${parent} is outside allowlist even after createDirs`,
            "outside_allowlist",
            parent,
          );
        }
      } else {
        throw new SandboxError(
          `parent ${parent} is outside allowlist`,
          "outside_allowlist",
          parent,
        );
      }
    }

    // 2) parent 实际可访问 — 若 parent 不存在,按 createDirs 决定是否 mkdir
    try {
      await fsStat(parent);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
      if (opts.createDirs) {
        await mkdir(parent, { recursive: true });
      } else {
        throw new SandboxError(`parent not found: ${parent}`, "not_found", parent);
      }
    }

    // 3) target 自身:不存在 OK(写新文件);存在且是目录/symlink 则拒绝
    try {
      const targetStat = await fsStat(normalized);
      if (targetStat.isDirectory()) {
        throw new SandboxError(`target is a directory: ${inputPath}`, "denied_kind", inputPath);
      }
      if (targetStat.isSymbolicLink()) {
        throw new SandboxError(
          `refusing to write through symlink: ${inputPath}`,
          "symlink_escape",
          inputPath,
        );
      }
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
      // 写新文件,继续
    }
    return normalized;
  }

  /** 递归创建中间目录(在 allowlist 校验前提下)。 */
  private async ensureDirs(dir: string): Promise<string> {
    const abs = resolve(dir);
    if (existsSync(abs)) return abs;
    const parent = resolve(abs, "..");
    if (parent !== abs) {
      await this.ensureDirs(parent);
    }
    await mkdir(abs, { recursive: true });
    return abs;
  }
}
