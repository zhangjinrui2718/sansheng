/**
 * Sansheng Sandbox · M4 fs tool boundary guard
 *
 * 任何 fs 工具在触碰 node:fs 前必须先 `await sandbox.resolve(path)`。
 * resolve 会:
 *   1. 把 path 规范化(处理 `..` / `.` / 相对路径)
 *   2. fs.realpath 解开 symlink
 *   3. 校验 normalized 路径在 policy.allowlist 内 → 否则 'outside_allowlist'
 *   4. 校验 real 路径在 allowlist(entry 同样解链后)内 → 否则 'symlink_escape'
 *      · real-vs-real 比较:macOS 的 /tmp、/var 本身是 symlink(→ /private/*),
 *        若拿 raw entry 比较会把合法路径误判为逃逸;Linux 行为不变。
 *
 * Policy 来源优先级:
 *   显式 SandboxOptions.policy > Sandbox.create() 读 ~/.sansheng/sandbox.json > 默认 policy
 *
 * resolveForWrite(A5 修复后)与 resolve() 同款 real-vs-real:
 *   parent 词法 matchAllow + realFormOf→matchAllowReal 双闸门,最终组件用 lstat
 *   (不跟随 symlink)检查 — 目标已存在且是 symlink → 拒绝写(default-deny)。
 *
 * 默认 allowlist:
 *   - ~/.sansheng/workspace/      (递归)
 *   - ~/.sansheng/canvas/         (canvas 根;per-session 目录由 newCanvasDir mkdtemp 按需创建)
 *   (A5 加固:canvas 从世界可写的 /tmp 迁入数据目录 — 固定名 /tmp/sansheng-canvas
 *    可被任何本地进程预埋 symlink,经典 /tmp race;newCanvasDir 用 mkdtemp 随机后缀)
 *
 * 默认单文件大小上限 30KB(防止 context blowup)。
 */
import { realpath, stat as fsStat, lstat, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir as osHomedir, tmpdir as osTmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
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

/**
 * 计算默认 policy(workspace + canvas 根,均在数据目录 ~/.sansheng/ 下)。
 * A5 加固:canvas 不再落 /tmp(世界可写 + 固定名 → symlink 预埋/race 面)。
 */
export function defaultPolicy(homedir: string): SandboxPolicy {
  const ws = join(homedir, ".sansheng", "workspace");
  const canvas = join(homedir, ".sansheng", "canvas");
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
      : { ...defaultPolicy(this.homedir) };
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

    // 校验 2:realpath 解链。
    // 注意:比较双方都必须用 real 形式 — macOS 上 /tmp、/var 本身是 symlink
    // (→ /private/tmp、/private/var),raw allowlist entry 与 realpath 结果前缀
    // 不同,直接 matchAllow(real) 会把合法路径误判为 symlink_escape。
    try {
      const real = await realpath(normalized);
      if (!(await this.matchAllowReal(real))) {
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

  /** entry.path → real 形式缓存(mutable allowlist 追加条目时按需计算)。 */
  private realEntryCache = new Map<string, string>();

  /**
   * 最长已存在祖先 → realpath → 拼回剩余段(无缓存)。
   * A5:resolveForWrite 对任意 parent 计算 real 形式用它 — 写路径的 parent
   * 不可进 entry 缓存(路径无界,Map 会无限增长)。
   */
  private async realForm(path: string): Promise<string> {
    let existing = path;
    const rest: string[] = [];
    for (;;) {
      if (existsSync(existing)) break;
      const parent = resolve(existing, "..");
      if (parent === existing) break; // 已到根
      rest.unshift(basename(existing));
      existing = parent;
    }
    let realBase: string;
    try {
      realBase = await realpath(existing);
    } catch {
      realBase = existing; // 理论上不可达(根目录必存在);保守回退
    }
    return rest.length > 0 ? join(realBase, ...rest) : realBase;
  }

  /**
   * 计算 allowlist entry 的 real(symlink-resolved)形式(带缓存,entry 数有界)。
   * entry 可能尚未创建(如 canvas 目录懒创建)→ 向上找最长已存在祖先,
   * realpath 该祖先后拼回剩余段。Linux 上无 symlink 前缀时结果 = 原路径。
   */
  private async realFormOf(entryPath: string): Promise<string> {
    const cached = this.realEntryCache.get(entryPath);
    if (cached !== undefined) return cached;
    const real = await this.realForm(entryPath);
    this.realEntryCache.set(entryPath, real);
    return real;
  }

  /**
   * real-vs-real 的 allowlist 匹配:先把每条 entry 也解链再比较。
   * 用于 resolve() 的校验 2 — 消除 macOS /tmp、/var symlink 前缀误报,
   * 同时保留原语义(workspace 内 symlink 指向外部仍会因 real 越界被拒)。
   */
  private async matchAllowReal(absPath: string): Promise<boolean> {
    for (const entry of this.policy.allowlist) {
      const realEntry = await this.realFormOf(entry.path);
      if (entry.kind === "dir") {
        if (absPath === realEntry) return true;
        if (absPath.startsWith(realEntry + sep)) return true;
      } else {
        if (absPath === realEntry) return true;
      }
    }
    return false;
  }

  /**
   * 工厂:为指定 session 创建 canvas 目录。
   *
   * A5 加固(docs/CODE-REVIEW-2026-10-01.md §A5):
   *   - 位置从 `/tmp/sansheng-<id>`(世界可写 + 固定名 → 任何本地进程可预埋
   *     symlink / race)迁到数据目录 `~/.sansheng/canvas/` 下(与 workspace 同一
   *     homedir 注入约定,SandboxOptions.homedir 是测试 seam);
   *   - 创建改用 mkdtemp 随机后缀(纵深防御:目录名不可预测,无法预埋)。
   *   注意语义变化:不再幂等复用同名目录,每次调用创建新随机目录。
   *
   * 会自动把此目录加入 policy.allowlist(动态写入)。返回绝对路径。
   */
  async newCanvasDir(sessionId: string): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error(`invalid sessionId: ${sessionId}`);
    }
    const root = join(this.homedir, ".sansheng", "canvas");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, `sansheng-${sessionId}-`));
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
   *
   * A5 修复(docs/CODE-REVIEW-2026-10-01.md §A5,实证 PWNED-A/PWNED-B):
   *   - parent 在词法 matchAllow 之外必须再过 real-vs-real matchAllowReal —
   *     堵死「allowlist 内 symlink 父目录指向外部」的写穿(旧实现词法前缀
   *     命中即放行,fsStat 跟随 symlink 使越界检查恒过);
   *   - 最终组件检查改 lstat(不跟随 symlink)— 目标已存在且是 symlink →
   *     拒绝写(default-deny,不做 realpath-then-allow 宽松版);旧 fsStat 版
   *     isSymbolicLink() 恒 false,是死代码;
   *   - 顺序纪律:词法 → real 两道闸门全过之后才允许 mkdir 副作用(RED 状态
   *     createDirs 会先经 symlink 在沙箱外创建目录再抛);
   *   - macOS /tmp、/var symlink 前缀由 realForm(parent) vs realFormOf(entry)
   *     的 real-vs-real 比较消除(与读路径 resolve() 同款基建,不误杀)。
   */
  async resolveForWrite(
    inputPath: string,
    bytes: number,
    opts: { createDirs?: boolean } = {},
  ): Promise<string> {
    this.checkSize(bytes, inputPath);
    const abs = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
    const normalized = resolve(abs);

    // 1) 词法闸门:parent 必须落在 allowlist 内(语义不变 — outside_allowlist)
    const parent = resolve(normalized, "..");
    if (this.matchAllow(parent) === undefined) {
      throw new SandboxError(
        `parent ${parent} is outside allowlist`,
        "outside_allowlist",
        parent,
      );
    }

    // 2) A5 real-vs-real 闸门:parent 解链后的 real 形式必须仍在某条 entry
    //    的 real 形式内。parent 不存在时 realForm 走「最长已存在祖先」重接 —
    //    createDirs 的深层新目录同样先校验后创建。
    const realParent = await this.realForm(parent);
    if (!(await this.matchAllowReal(realParent))) {
      throw new SandboxError(
        `parent realpath ${realParent} (from ${parent}) escapes sandbox allowlist`,
        "symlink_escape",
        parent,
      );
    }

    // 3) 两道闸门都过了才允许副作用:parent 不存在时按 createDirs 决定 mkdir
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

    // 4) target 自身:不存在 OK(写新文件);存在且是目录/symlink 则拒绝。
    //    A5:lstat 不跟随 symlink — isSymbolicLink() 从此真实可达(死代码修复)。
    try {
      const targetStat = await lstat(normalized);
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
}
