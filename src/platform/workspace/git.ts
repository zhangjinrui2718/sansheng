/**
 * 工作区端口的**真实现**:直接读本机文件系统 + 调 `git`(契约见 `./port.ts`)。
 *
 * ── 这个文件里每一处「为什么」都对着契约里的一句话 ────────────────────
 *
 *   · `resolveInside` **在 realpath 之后**判包含性 —— 只比字符串前缀拦不住
 *     符号链接(`<root>/link → /etc`)。判据与 `codeservice/git.ts` 的
 *     `resolveInsideRoot` 同源,**不重写第二份语义**:同样先解析、再比、再 stat。
 *   · `writeAtomic` 临时文件 → `rename`:同一个目录内 rename 才是在一个文件系统
 *     上的原子替换(跨目录/跨设备会退化成「先删后建」)。
 *   · `commit` 的三条闸门**用返回值说话**,不写日志了事 —— 「没进版本库的东西
 *     甲方也拿不到」(设计 §7),所以「没进去」必须与「进去了」长得不一样。
 *   · `commit` 撞 `index.lock` **退避重试**,用尽才 `ok: false`;调用方要把它落成
 *     一条可见的失败。静默吞掉会让「提交了」与「没提交」在屏幕上长得一样。
 *   · `show` 是「索引记了 sha ⇒ 内容按 sha 可寻址」的落点:文件被改、被删、被
 *     回滚之后,历史版本仍然读得出来。
 *
 * ── 两条自检(本项目「检查本身也会静默出错」的教训)─────────────────
 *
 *   ① 提交前**自检暂存区**:闸门挡下的路径若仍出现在 `git diff --cached` 里,
 *      直接 `ok: false` 拒绝提交 —— 宁可这次不提交,也不让一个坏掉的闸门
 *      静默地把秘密写进历史(git 历史不可回收)。
 *   ② 提交前**核对仓库根**:`git rev-parse --show-toplevel` 必须等于工作区根。
 *      否则 `<root>` 只是某个父仓的子目录,一次 housekeeping 提交会写进**工作区
 *      之外**的历史 —— 那是一个不可撤销的越界。
 *
 * ── 交付口径带来的连带后果(设计 §7)────────────────────────────
 *
 * 甲方拿到的就是**被提交的东西**。所以闸门不是内部卫生:
 *   · 第 1 条(秘密)是**唯一**挡在秘密与甲方之间的机制;
 *   · 第 2 条(超大文件)必须**显示** —— 没纳入的东西和纳入的东西都要看得见。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Stats } from "node:fs";
import type {
  WorkspaceCommit, WorkspaceExcluded, WorkspacePort, WorkspaceResult,
} from "./port.js";
import { normalizeWorkspacePath } from "./scan.js";

/**
 * 单文件上限的**缺省值**(10 MB,设计 §3.3 第 2 条)。
 *
 * 为什么这个闸门是硬要求:git 历史**不可回收** —— 一次大输出(模型抓来的数据集)
 * 会把仓库永久撑大,而「用 git 取代归档」正是这个工作区的前提。
 */
export const WORKSPACE_MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * 平台自己提交时的 author。项目的角色中文名唯一来源是 `identity/org.ts` 的 `ORG`
 * (调用方传进 `commit` 的 `author`);这个常量只用于 `initRepo` 的首次提交 ——
 * 那一次没有「哪个角色」可言。
 */
export const PLATFORM_AUTHOR = "三生平台 <platform@sansheng.local>";

/** 缺省退避:撞 `index.lock` 之后最多再试 3 次(设计 §3.1「退避重试 3 次」)。 */
const DEFAULT_LOCK_RETRIES = 3;
const LOCK_BACKOFF_MS = [60, 180, 500] as const;

/**
 * 干净的环境(`codeservice/git.ts` 同一套纪律)。
 *
 * ⚠️ **`GIT_DIR` 必须被 `delete`,不能设成 `""`** —— 空串会被 git 当成一个**路径**
 * (`fatal: not a git repository: ''`),于是每次提交都失败,而错误读起来像
 * 「这个目录不是仓库」(把一次环境 bug 说成一次数据问题)。
 *
 * `commit.gpgsign=false` / 提交者身份走 `-c`:一次提交的结果必须是**仓库自身**的
 * 事实,而不是「跑这台机器的人碰巧配了什么」—— 签名密钥缺失会让提交直接失败,
 * 而那是机器配置,不是这次交付的问题。
 */
const GIT_IDENTITY_ARGS = [
  "-c", "user.name=三生平台",
  "-c", "user.email=platform@sansheng.local",
  "-c", "commit.gpgsign=false",
] as const;

const GIT_ENV: NodeJS.ProcessEnv = (() => {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e["GIT_DIR"];
  delete e["GIT_WORK_TREE"];
  delete e["GIT_INDEX_FILE"];
  e["GIT_CONFIG_NOSYSTEM"] = "1"; // 不读系统级 gitconfig
  e["GIT_TERMINAL_PROMPT"] = "0"; // 绝不弹交互(否则会挂住一个回合)
  e["LC_ALL"] = "C"; // 输出可预测(不随 locale 变),也让 index.lock 的判据稳定
  return e;
})();

interface GitRun {
  ok: boolean;
  out: string;
  err: string;
}

/**
 * 跑一条 git 命令,**不抛**。失败时把 stderr 原样带回来 ——
 * 闸门与重试的判据(是不是 `index.lock`)都读它。
 */
function runGit(cwd: string, args: readonly string[]): GitRun {
  try {
    const out = execFileSync("git", [...GIT_IDENTITY_ARGS, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: GIT_ENV,
      timeout: 30_000,
      // `git status --ignored` 在一个大工作树里可能超过 1 MB 的缺省上限。
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out, err: "" };
  } catch (e) {
    const stderr = (e as { stderr?: string | Buffer }).stderr;
    const err = typeof stderr === "string" ? stderr : stderr?.toString() ?? (e instanceof Error ? e.message : String(e));
    return { ok: false, out: "", err };
  }
}

/** 失败一律走返回值(契约文件头:`ok:false` 不抛异常)。 */
function fail<T>(problem: string): WorkspaceResult<T> {
  return { ok: false, problem };
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** git 的 stderr 第一行 —— 问题描述里要原样保留现场,不要转述。 */
function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim();
}

/** `-z` 输出按 NUL 切;去掉空串(git 以 NUL 结尾,切出来会多一个)。 */
function splitZ(out: string): string[] {
  return out.split("\0").filter((s) => s !== "");
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 最深的**已存在**祖先(`lstat` 判 —— 断链的符号链接也算「存在」)。
 *
 * 用来在目标文件还不存在时仍然能做 realpath 包含性校验:
 * `writeAtomic` 写的是一个还没建出来的文件,`realpathSync(abs)` 会直接抛,
 * 只比字符串前缀又拦不住符号链接。取最深已存在祖先的真实路径,才既拦得住
 * 逃逸、又不要求目标已存在。
 */
function deepestExisting(abs: string): string | null {
  let cur = abs;
  for (;;) {
    try {
      lstatSync(cur);
      return cur;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

const AUTHOR_RE = /^(.+?)\s*<([^<>@\s]+@[^<>\s]+)>$/;

/** `Author Name <email>` → 拆开;形状不对返回 null(不猜、不补)。 */
function parseAuthor(raw: string): { name: string; email: string } | null {
  const m = AUTHOR_RE.exec(raw.trim());
  if (m === null) return null;
  const name = m[1]?.trim() ?? "";
  const email = m[2] ?? "";
  if (name === "" || email === "") return null;
  return { name, email };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 秘密规则(设计 §3.3 第 1 条的**机械判据**)。
 *
 * ⚠️ **刻意照字面收窄**:`.env` 只匹配这个名字本身,`*.key` / `*.pem` 只看扩展名,
 * `secrets/` 看任意一段路径。不把 `.env.local` / `.env.production` 一并吞进来,
 * 是因为那会把 `.env.example` 这类**本该提交**的模板一起挡下(一次可见的误伤,
 * 而交付物会凭空缺一个文件)。要放宽就改这一张表 —— **这一处是唯一判据**,
 * 它同时决定闸门与「被 .gitignore 忽略的秘密」的可见性。
 */
const SECRET_RULES: ReadonlyArray<{ readonly rule: string; readonly match: (p: string) => boolean }> = [
  { rule: ".env", match: (p) => basename(p) === ".env" },
  { rule: "*.key", match: (p) => extname(p).toLowerCase() === ".key" },
  { rule: "*.pem", match: (p) => extname(p).toLowerCase() === ".pem" },
  { rule: "secrets/", match: (p) => p.split("/").includes("secrets") },
];

/** 命中哪条秘密规则;没命中返回 null。目录以 `/` 结尾,先削掉再判。 */
function secretRule(relPath: string): string | null {
  const p = relPath.replace(/\/+$/, "");
  for (const r of SECRET_RULES) {
    if (r.match(p)) return r.rule;
  }
  return null;
}

/**
 * 同步睡一小会儿。Node 没有 `sleepSync`,而退避重试必须是同步的
 * (端口整体是同步 API)。`Atomics.wait` 在 Node 主线程可用。
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 撞锁的判据。git 的原文:`Unable to create '…/index.lock': File exists.` */
function isLockProblem(problem: string): boolean {
  return /index\.lock|Another git process/i.test(problem);
}

export interface GitWorkspaceOptions {
  /** 单文件上限缺省值;`commit` 的入参可以逐次覆盖。 */
  readonly maxFileBytes?: number;
  /** 撞 `index.lock` 之后**额外**再试几次(缺省 3)。 */
  readonly lockRetries?: number;
  /** 退避时长(毫秒),按已失败的次数给。 */
  readonly lockBackoffMs?: (attempt: number) => number;
  /** 注入睡眠,好让「重试之后成功」这条路径能被确定性地测出来。 */
  readonly sleep?: (ms: number) => void;
}

/** 分块 —— `git reset -- <几千个路径>` 会撞上 argv 长度上限。 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createGitWorkspace(opts: GitWorkspaceOptions = {}): WorkspacePort {
  const defaultMaxFileBytes = opts.maxFileBytes ?? WORKSPACE_MAX_FILE_BYTES;
  const lockRetries = opts.lockRetries ?? DEFAULT_LOCK_RETRIES;
  const backoff = opts.lockBackoffMs ?? ((attempt: number) => LOCK_BACKOFF_MS[attempt] ?? 500);
  const sleep = opts.sleep ?? sleepSync;

  function sha256(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  function resolveInside(input: {
    root: string;
    path: string;
  }): WorkspaceResult<{ abs: string; path: string }> {
    const raw = input.path;
    if (raw.trim() === "") {
      return fail(
        "`path` 是空串。工作区里的每个路径参数都必须是**项目根相对路径**(如 `artifacts/x.html`)。",
      );
    }
    // 契约明确:path 是项目根相对路径,绝对路径只在**返回值**里出现。
    // 收下绝对路径等于让调用方绕过「相对哪个根」这件事 —— 拒绝并说清楚。
    if (isAbsolute(raw)) {
      return fail(
        `\`path\` 必须是**项目根相对路径**,收到绝对路径「${raw}」。` +
          `绝对路径只在返回值里出现 —— 平台生成的落点(\`artifacts/…\`)与索引里的 ` +
          `\`body_path\` 都是相对的,相对的是工作区根。`,
      );
    }
    const rootResolved = resolve(input.root);
    const abs = resolve(rootResolved, raw);
    const prefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
    if (abs === rootResolved || !abs.startsWith(prefix)) {
      return fail(
        `路径「${raw}」解析为 ${abs},**在工作区根 ${rootResolved} 之外**。` +
          `工作区端口只允许项目根之内的路径 —— 逃出去意味着一次工具调用能写盘上任意位置。`,
      );
    }

    // 包含性校验**在 realpath 之后**再做一次:符号链接可以指向根之外,
    // 只比字符串前缀拦不住(`<root>/link → /etc`)。
    // 根**不存在**时跳过这一层(那里一个符号链接都还不可能存在,写入会按需建目录);
    // 目标不存在时取最深已存在祖先做判定。
    const rootReal = realpathOrNull(rootResolved);
    if (rootReal !== null) {
      const existing = deepestExisting(abs) ?? rootResolved;
      const realExisting = realpathOrNull(existing);
      if (realExisting === null) {
        return fail(
          `无法解析「${existing}」的真实路径(符号链接断了,或路径上的目录读不到)。` +
            `这一层必须判得出来 —— 判不出来就不能说这次写入落在工作区之内。`,
        );
      }
      const realPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
      if (realExisting !== rootReal && !realExisting.startsWith(realPrefix)) {
        return fail(
          `路径「${raw}」经符号链接解析到 **${realExisting}**,在工作区根 ${rootReal} ` +
            `之外。工作区里的符号链接可以指向根内部,但不许把一次写入引到根外面去。`,
        );
      }
    }

    return {
      ok: true,
      value: { abs, path: normalizeWorkspacePath(relative(rootResolved, abs)) },
    };
  }

  function writeAtomic(input: {
    root: string;
    path: string;
    content: string;
  }): WorkspaceResult<{ path: string; sha256: string; bytes: number }> {
    const located = resolveInside({ root: input.root, path: input.path });
    if (!located.ok) return located;
    const abs = located.value.abs;
    const dir = dirname(abs);
    const tmp = join(
      dir,
      `.${basename(abs)}.${process.pid.toString(36)}.${Date.now().toString(36)}.${Math.random()
        .toString(36)
        .slice(2, 8)}.tmp`,
    );
    try {
      mkdirSync(dir, { recursive: true });
      // rename 之前再核一次真实父目录:建目录这一步可能跟随了一个刚被放进来的
      // 符号链接。宁可这次失败,也不把内容写到根外面。
      const rootResolved = resolve(input.root);
      const rootReal = realpathOrNull(rootResolved);
      if (rootReal !== null) {
        const dirReal = realpathOrNull(dir);
        const realPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
        if (dirReal === null || (dirReal !== rootReal && !dirReal.startsWith(realPrefix))) {
          return fail(
            `工作区目录 ${dir} 的真实路径解析到工作区根 ${rootReal} 之外,拒绝写入` +
              `(目录链上出现了指向根外的符号链接)。`,
          );
        }
      }
      writeFileSync(tmp, input.content, "utf8");
      // 同目录 rename = 同一个文件系统上的**原子替换**。跨目录/跨设备会退化成
      // 「先删后建」,读到半个文件的窗口就回来了。
      renameSync(tmp, abs);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // 清理失败不该盖掉真正的失败原因。
      }
      return fail(
        `写不到工作区文件 ${abs}:${reason(e)}。工作区内容必须真的落在盘上 —— ` +
          `调用方(先文件后行)拿到这个失败时**不要**继续插索引行。`,
      );
    }
    return {
      ok: true,
      value: {
        path: located.value.path,
        sha256: sha256(input.content),
        bytes: Buffer.byteLength(input.content, "utf8"),
      },
    };
  }

  function read(input: { root: string; path: string }): WorkspaceResult<string> {
    const located = resolveInside(input);
    if (!located.ok) return located;
    const abs = located.value.abs;
    try {
      if (statSync(abs).isDirectory()) {
        return fail(
          `「${input.path}」是一个目录,不是文件。工件正文读的是一条文件路径 —— ` +
            `目录没有正文可读,这不是「空正文」。`,
        );
      }
    } catch {
      // 不存在 / 读不到状态:交给下面 readFileSync 给出带 errno 的现场。
    }
    try {
      return { ok: true, value: readFileSync(abs, "utf8") };
    } catch (e) {
      return fail(
        `读不到工作区文件 ${abs}:${reason(e)}。这是「读不到」,**不是空内容** —— ` +
          `读面要把它翻成 runtime: "unavailable" 并指向这条路径。`,
      );
    }
  }

  function show(input: { root: string; sha: string; path: string }): WorkspaceResult<string> {
    const located = resolveInside({ root: input.root, path: input.path });
    if (!located.ok) return located;
    const sha = input.sha.trim().toLowerCase();
    // sha 先过形状:它会被拼进 `git show <sha>:<path>`,不是十六进制就没有意义,
    // 也不该把任意字符串交给 git 去当 revision 解析。
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      return fail(
        `\`sha\` 必须是提交 sha(7–40 位十六进制),收到「${input.sha}」。` +
          `索引里记的 \`commit_sha\`、以及 \`?at=\` 参数都必须是这个形状。`,
      );
    }
    const rootResolved = resolve(input.root);
    const r = runGit(rootResolved, ["show", `${sha}:${located.value.path}`]);
    if (!r.ok) {
      return fail(
        `读不到提交 ${sha} 里的「${located.value.path}」:` +
          `${firstLine(r.err)}。这可能是这个提交里没有这条路径,或这个提交已经不可达 ` +
          `(reset --hard 之后只剩 reflog)—— 两种情况都要如实报「读不到」,不许回空正文。`,
      );
    }
    return { ok: true, value: r.out };
  }

  function stat(input: { root: string; path: string }): WorkspaceResult<Stats> {
    const located = resolveInside(input);
    if (!located.ok) return located;
    try {
      return { ok: true, value: statSync(located.value.abs) };
    } catch (e) {
      return fail(`读不到工作区路径 ${located.value.abs} 的状态:${reason(e)}。`);
    }
  }

  function headSha(root: string): string | null {
    const r = runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const s = r.ok ? r.out.trim() : "";
    return /^[0-9a-f]{40}$/.test(s) ? s : null;
  }

  /**
   * 一次提交尝试(不含退避)。**闸门 + 自检都在这一个函数里** ——
   * 退避重试整段重跑,不会把「加了一半的暂存区」留给下一次。
   */
  function commitOnce(
    rootReal: string,
    input: { author: string; message: string; maxFileBytes: number },
  ): WorkspaceResult<WorkspaceCommit> {
    const excluded: WorkspaceExcluded[] = [];

    // ── 候选 = `git add -A` 会暂存的东西(被 .gitignore 忽略的不算)──
    const listed = runGit(rootReal, ["ls-files", "-co", "--exclude-standard", "-z"]);
    if (!listed.ok) {
      return fail(`列不出工作树里会被提交的文件:${firstLine(listed.err)}`);
    }
    const candidates = splitZ(listed.out);
    const blocked: string[] = [];
    for (const p of candidates) {
      const rule = secretRule(p);
      if (rule !== null) {
        blocked.push(p);
        excluded.push({
          path: p,
          reason: "secret",
          detail: `命中秘密规则「${rule}」:这类文件**永不提交**(设计 §3.3 第 1 条)。`,
        });
        continue;
      }
      const size = (() => {
        try {
          return statSync(join(rootReal, p)).size;
        } catch {
          return null; // 竞态删除:它不进这次提交,也不该让整次提交失败。
        }
      })();
      if (size !== null && size > input.maxFileBytes) {
        blocked.push(p);
        excluded.push({
          path: p,
          reason: "oversized",
          detail:
            `${formatBytes(size)} 超过单文件上限 ${formatBytes(input.maxFileBytes)}` +
            `(设计 §3.3 第 2 条)。git 历史不可回收,一次大输出会永久污染仓库。`,
        });
        continue;
      }
    }

    // ── 被 .gitignore 忽略、但命中秘密规则的条目:**仍然要如实报出来** ──
    //
    // 这类文件根本不会成为 `git add -A` 的候选(平台写的 `.gitignore` 里就有
    // `.env` / `*.key` / `*.pem` / `secrets/`),所以只扫候选的话它们会**彻底
    // 不出现** —— 而「没进去」与「进去了」必须长得不一样。
    // 这里只报**秘密**:被忽略的超大文件(构建产物)不进这个清单 ——
    // 它们不是被体积闸门挡下的,说成「因体积未纳入版本库」是另一种假话。
    const ignored = runGit(rootReal, ["status", "--ignored", "--porcelain", "-z"]);
    if (ignored.ok) {
      const records = splitZ(ignored.out);
      for (let i = 0; i < records.length; i++) {
        const rec = records[i] ?? "";
        const xy = rec.slice(0, 2);
        const p = rec.slice(3);
        if (xy.startsWith("R") || xy.startsWith("C")) i++; // -z 下第二条路径是独立记录
        if (xy !== "!!") continue;
        const rule = secretRule(p);
        if (rule === null) continue;
        const path = p.replace(/\/+$/, "");
        if (excluded.some((e) => e.path === path)) continue;
        excluded.push({
          path,
          reason: "secret",
          detail:
            `被 .gitignore 忽略,且命中秘密规则「${rule}」:它**没有**进版本库` +
            `(设计 §3.3 第 1 条)。工作区根不该放秘密。`,
        });
      }
    }

    // ── `git add -A` 之后把闸门挡下的条目**退出暂存区** ──
    const added = runGit(rootReal, ["add", "-A"]);
    if (!added.ok) {
      return fail(`\`git add -A\` 失败:${firstLine(added.err)}`);
    }
    if (blocked.length > 0) {
      for (const part of chunk(blocked, 200)) {
        // `:(literal)` —— 文件名里带 `*` / `[` 时,pathspec 的 glob 会把它当模式,
        // 于是退出暂存区的可能是**另一个**文件。字面量是这里唯一正确的写法。
        const r = runGit(rootReal, ["reset", "-q", "--", ...part.map((p) => `:(literal)${p}`)]);
        if (!r.ok) {
          return fail(`把闸门挡下的文件退出暂存区失败:${firstLine(r.err)}`);
        }
      }
    }

    const staged = runGit(rootReal, ["diff", "--cached", "--name-only", "-z"]);
    if (!staged.ok) {
      return fail(`读不出暂存区清单:${firstLine(staged.err)}`);
    }
    const stagedSet = new Set(splitZ(staged.out));

    // ── 自检:闸门挡下的路径**一条都不许**留在暂存区里 ──
    //
    // 宁可这次不提交(可见的 `ok:false`),也不让一个坏掉的闸门静默地把秘密
    // 写进历史。这正是本项目「一个坏掉的检查会给出看起来很正常的错误答案」
    // 那条教训的落法:检查失败要说检查失败,不许当通过。
    const leaked = excluded.filter((e) => stagedSet.has(e.path)).map((e) => e.path);
    if (leaked.length > 0) {
      return fail(
        `闸门自检失败:${leaked.join("、")} 在被拒绝之后仍然出现在暂存区里,` +
          `拒绝提交。这不是文件的问题,是闸门的问题 —— 空提交比一次泄露好。`,
      );
    }

    const head = headSha(rootReal);
    if (stagedSet.size === 0) {
      // 契约:无变更**不产生空提交**(实测 `git commit` 无改动返回 1)。
      return { ok: true, value: { committed: false, sha: head, excluded } };
    }

    const committed = runGit(rootReal, [
      "commit",
      `--author=${input.author}`,
      "-m",
      input.message,
    ]);
    if (!committed.ok) {
      return fail(`\`git commit\` 失败:${firstLine(committed.err)}`);
    }
    const newHead = headSha(rootReal);
    if (newHead === null) {
      return fail(
        `提交命令报告成功,但读不到新的 HEAD —— 这次提交的 sha 拿不到,` +
          `索引就没法回填 \`commit_sha\`。如实报失败,不猜一个 sha。`,
      );
    }
    return { ok: true, value: { committed: true, sha: newHead, excluded } };
  }

  function commit(input: {
    root: string;
    author: string;
    message: string;
    maxFileBytes?: number;
  }): WorkspaceResult<WorkspaceCommit> {
    const author = parseAuthor(input.author);
    if (author === null) {
      return fail(
        `\`author\` 必须是 "名字 <邮箱>" 形式,收到「${input.author}」。` +
          `角色的中文名只有一处来源(\`identity/org.ts\` 的 \`ORG\`)—— 拼错会让 ` +
          `\`git log\` 里的归属对不上组织架构。`,
      );
    }
    if (input.message.trim() === "") {
      return fail(
        "`message` 是空串。提交说明是这次提交**为什么发生**的唯一现场 —— " +
          "空说明的提交在 `git log` 里与「不知道干了什么」长得一样。",
      );
    }
    const limit = input.maxFileBytes ?? defaultMaxFileBytes;
    if (!Number.isFinite(limit) || limit <= 0) {
      return fail(`\`maxFileBytes\` 必须是正数,收到「${String(input.maxFileBytes)}」。`);
    }

    const rootResolved = resolve(input.root);
    const rootReal = realpathOrNull(rootResolved);
    if (rootReal === null) {
      return fail(
        `工作区根 ${rootResolved} 不存在(或读不到)。没有目录就没有仓库 —— ` +
          `先建项目目录并 \`initRepo\`,不要在这里隐式创建。`,
      );
    }

    // ⚠️ 仓库根必须**就是这个目录**。`<root>` 若是某个父仓的子目录,
    // `git add -A` + `git commit` 会把工作区之外的改动一起提交进父仓历史。
    const top = runGit(rootResolved, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) {
      return fail(
        `「${rootResolved}」不是一个 git 仓库:${firstLine(top.err)}。` +
          `工作区必须先由 \`initRepo\` 建仓 —— 提交失败要**可见**,` +
          `静默跳过会让「提交了」与「没提交」在屏幕上长得一样。`,
      );
    }
    const topReal = realpathOrNull(top.out.trim()) ?? resolve(top.out.trim());
    if (topReal !== rootReal) {
      return fail(
        `「${rootResolved}」不是仓库根 —— 它在仓库 ${topReal} 内部。` +
          `往父仓提交会把工作区**之外**的改动写进历史,拒绝执行。`,
      );
    }

    const attempt = (): WorkspaceResult<WorkspaceCommit> =>
      commitOnce(rootReal, { author: input.author.trim(), message: input.message, maxFileBytes: limit });

    // 并发:同项目两个角色可能同时在动这个仓(agent 在回合内自己提交代码),
    // 平台做 housekeeping 时可能撞 `index.lock`。退避重试,用尽才可见地失败。
    let last: WorkspaceResult<WorkspaceCommit> | null = null;
    for (let i = 0; i <= lockRetries; i++) {
      const r = attempt();
      if (r.ok) return r;
      last = r;
      if (!isLockProblem(r.problem)) return r;
      if (i === lockRetries) break;
      sleep(backoff(i));
    }
    const detail = last !== null && !last.ok ? last.problem : "";
    return fail(
      `提交撞上 git 的 \`index.lock\`,退避重试 ${lockRetries} 次仍然失败。` +
        `原始错误:${detail}`,
    );
  }

  function initRepo(input: {
    root: string;
    gitignore: string;
    readme: string;
  }): WorkspaceResult<{ created: boolean; sha: string | null }> {
    const rootResolved = resolve(input.root);
    try {
      mkdirSync(rootResolved, { recursive: true });
    } catch (e) {
      return fail(`建不出工作区根目录 ${rootResolved}:${reason(e)}。`);
    }

    let created = false;
    if (!existsSync(join(rootResolved, ".git"))) {
      const r = runGit(rootResolved, ["init", "-b", "main"]);
      if (!r.ok) {
        return fail(`\`git init\` 失败(${rootResolved}):${firstLine(r.err)}`);
      }
      created = true;
    }

    // **只补缺的文件**:已有仓时一个字都不覆盖 —— 覆盖 README 等于把
    // 「这个项目是干什么的」改回平台模板,而且会静默丢掉人工写的说明。
    for (const [name, content] of [
      [".gitignore", input.gitignore],
      ["README.md", input.readme],
    ] as const) {
      const p = join(rootResolved, name);
      if (existsSync(p)) continue;
      const w = writeAtomic({ root: rootResolved, path: name, content });
      if (!w.ok) return w;
    }

    const committed = commit({
      root: rootResolved,
      author: PLATFORM_AUTHOR,
      message: "初始化项目工作区(.gitignore / README.md)",
    });
    if (!committed.ok) return committed;
    return { ok: true, value: { created, sha: committed.value.sha } };
  }

  return { resolveInside, writeAtomic, read, show, stat, initRepo, commit, sha256 };
}

/**
 * 一个**永远拒绝**的实现。给「没有注入端口」的装配错误用。
 *
 * 为什么不返回 `undefined` 然后让工具静默通过:那样一次 `board_write` 会在没接
 * 工作区的环境里拿到「写好了」的假答案,而盘上什么都没有 —— 静默通过比失败
 * 危险得多(与 `codeservice/git.ts` 的 `unavailableCodeService` 同一条理由)。
 */
export function unavailableWorkspace(problem: string): WorkspacePort {
  const no = <T,>(): WorkspaceResult<T> => ({ ok: false, problem });
  return {
    resolveInside: () => no(),
    writeAtomic: () => no(),
    read: () => no(),
    show: () => no(),
    stat: () => no(),
    initRepo: () => no(),
    commit: () => no(),
    // 哈希是纯计算,与盘无关 —— 它照常工作,好让「算 sha」这条路径不因为
    // 少了一个装配项而失败。
    sha256: (content) => createHash("sha256").update(content, "utf8").digest("hex"),
  };
}
