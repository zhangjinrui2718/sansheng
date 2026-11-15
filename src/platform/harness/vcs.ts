/**
 * Harness 目录的 **git 化历史**(2026-11-15,Wave:版本/对比/回滚)
 *
 * ── 为什么把 `<dataDir>/harness/` 变成一个 git 仓库 ────────────────
 *
 * 旧形态只有「最近 10 份 `.bak` 备份」—— 没有命名、没有 diff、没有任意点
 * 回滚,改坏了只能凭记忆重写。调研(Clause:见当日会话)给出的结论是:
 * 开源界(Claude Code subagents / Cursor rules / OpenHands microagents)
 * 对 agent 配置的通行解法就是 **文件即真相 + git 版本化** —— diff / 历史 /
 * 回滚 / 分享(push 到任意 remote)全部白嫖 git,不需要发明「备份列表」。
 *
 * 三生已经是 markdown + JSON 文件的形状,缺的只是把目录变成仓库。
 *
 * ── 与「.bak 备份」的关系 ─────────────────────────────────────────
 *
 * **两套都保留,职责不同**:
 *   · `.bak`(write.ts 规矩②)—— **写的前置**:覆盖前的那一份,备份失败
 *     就拒绝写入。它是写入纪律,不是历史。
 *   · git 历史 —— **事后的时间线**:每次写成功后整目录 commit 一发,
 *     提供任意点回滚与 diff。
 * `.gitignore` 把 `backups/` 排除 —— 备份快照不该在 git 历史里重复记账。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 *
 * 1. **失败不抛、不打挂调用方** —— git 不可用(没装/只读盘)时,harness
 *    的读写照常工作,只是没有历史。与工作区 `workspace/git.ts` 同一条纪律。
 * 2. **保存即提交,提交里没有「半成品」** —— commit 在写面成功**之后**调,
 *    快照永远是可用状态;没有变更就报 `committed:false`,不发空提交。
 * 3. **路径必须落在 harness 目录内** —— relPath 来自 HTTP 的历史条目,
 *    但仍过一遍归属断言(与 `toolSetPath` 规矩①同源)。
 */
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, sep } from "node:path";

const GIT_IDENTITY_ARGS = [
  "-c", "user.name=三生平台",
  "-c", "user.email=platform@sansheng.local",
  "-c", "commit.gpgsign=false",
] as const;

/** 与 workspace/git.ts 同一套环境清洗:`GIT_DIR` 必须删除而非置空。 */
const GIT_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
})();

interface GitRun {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function runGit(harnessDir: string, args: readonly string[]): GitRun {
  try {
    const out = execFileSync("git", [...GIT_IDENTITY_ARGS, ...args], {
      cwd: harnessDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: GIT_ENV,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, out, err: "" };
  } catch (e) {
    const stderr = (e as { stderr?: string | Buffer }).stderr;
    const err =
      typeof stderr === "string" ? stderr : stderr?.toString() ?? (e instanceof Error ? e.message : String(e));
    return { ok: false, out: "", err };
  }
}

/** relPath 必须解析在 harnessDir 内部(路径穿越的唯一防线,规矩①同源)。 */
export function isInsideHarnessDir(harnessDir: string, relPath: string): boolean {
  const root = resolve(harnessDir);
  const p = resolve(root, relPath);
  return p.startsWith(root + sep);
}

export interface EnsureRepoResult {
  readonly ok: boolean;
  /** true = 这次调用新建了仓库 */
  readonly created: boolean;
  readonly detail?: string;
}

/**
 * 把 harness 目录初始化成 git 仓库(幂等)。已存在时一个字节都不碰。
 * 首建时写 `.gitignore`(排除 `backups/` —— 备份快照不进历史)。
 */
export function ensureRepo(harnessDir: string): EnsureRepoResult {
  if (existsSync(join(harnessDir, ".git"))) {
    return { ok: true, created: false };
  }
  try {
    const r = runGit(harnessDir, ["init"]);
    if (!r.ok) return { ok: false, created: false, detail: r.err };
    const gitignore = join(harnessDir, ".gitignore");
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, "backups/\n", "utf8");
    }
    return { ok: true, created: true };
  } catch (err) {
    return { ok: false, created: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export interface CommitResult {
  readonly ok: boolean;
  /** true = 确实产生了一个新提交;false = 没有变更(或 git 不可用) */
  readonly committed: boolean;
  readonly sha?: string;
  readonly detail?: string;
}

/**
 * 整目录提交(幂等):`git add -A` → 有暂存变更才 commit。
 * 消息由调用方起 —— 它知道这次变更是谁、为什么(保存 / 恢复出厂 / seed)。
 */
export function commitAll(harnessDir: string, message: string): CommitResult {
  const init = ensureRepo(harnessDir);
  if (!init.ok) return { ok: false, committed: false, detail: init.detail };
  const add = runGit(harnessDir, ["add", "-A"]);
  if (!add.ok) return { ok: false, committed: false, detail: add.err };
  const staged = runGit(harnessDir, ["diff", "--cached", "--quiet"]);
  // `git diff --cached --quiet` 的退出码:有暂存变更 = 1,无 = 0
  if (staged.ok) return { ok: true, committed: false };
  const commit = runGit(harnessDir, ["commit", "-m", message]);
  if (!commit.ok) return { ok: false, committed: false, detail: commit.err };
  const sha = runGit(harnessDir, ["rev-parse", "HEAD"]);
  return { ok: true, committed: true, ...(sha.ok ? { sha: sha.out.trim() } : {}) };
}

export interface HarnessCommitEntry {
  readonly sha: string;
  /** epoch 秒(git 的 %ct) */
  readonly at: number;
  readonly message: string;
  /** 本次提交触碰的文件(相对 harnessDir) */
  readonly files: readonly string[];
}

export interface HistoryResult {
  readonly ok: boolean;
  readonly entries: readonly HarnessCommitEntry[];
  readonly detail?: string;
}

/**
 * 提交历史(新的在前)。`relPath` 可选 —— 只看触到某个文件的提交
 * (管理页按单元过滤历史用的就是它)。
 */
export function history(
  harnessDir: string,
  opts: { relPath?: string; limit?: number } = {},
): HistoryResult {
  if (!existsSync(join(harnessDir, ".git"))) {
    return { ok: true, entries: [] };
  }
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const args = ["log", `--max-count=${limit}`, "--format=%H%x1f%ct%x1f%s"];
  if (opts.relPath !== undefined) args.push("--", opts.relPath);
  const log = runGit(harnessDir, args);
  if (!log.ok) return { ok: false, entries: [], detail: log.err };

  // name-status 单独跑一次(与 log 同序同限):--name-status 与自定义 format
  // 无法在同一条命令里可靠配对,分两条 log 输出按行对齐反而更稳
  const filesBySha = new Map<string, string[]>();
  if (opts.relPath === undefined) {
    // 每个提交块以 `\x1e<sha>` 开头(格式前缀),随后是触碰的文件行
    const fsLog = runGit(harnessDir, [
      "log", `--max-count=${limit}`, "--name-only", "--format=%x1e%H",
    ]);
    if (fsLog.ok) {
      let currentSha = "";
      for (const line of fsLog.out.split("\n")) {
        if (line.startsWith("\x1e")) {
          currentSha = line.slice(1);
          filesBySha.set(currentSha, []);
          continue;
        }
        if (currentSha !== "" && line.trim() !== "") {
          filesBySha.get(currentSha)!.push(line.trim());
        }
      }
    }
  }

  const entries: HarnessCommitEntry[] = [];
  for (const line of log.out.split("\n")) {
    if (line.trim() === "") continue;
    const [sha, atStr, message] = line.split("\x1f");
    if (sha === undefined) continue;
    const files = opts.relPath !== undefined ? [opts.relPath] : filesBySha.get(sha) ?? [];
    entries.push({ sha, at: Number(atStr) || 0, message: message ?? "", files });
  }
  return { ok: true, entries };
}

export interface ShowResult {
  readonly ok: boolean;
  readonly content?: string;
  readonly detail?: string;
}

/** 读某个提交里的一份文件原文(「查看此版」与回滚的共同底层)。 */
export function showAt(harnessDir: string, sha: string, relPath: string): ShowResult {
  if (!isInsideHarnessDir(harnessDir, relPath)) {
    return { ok: false, detail: `路径越界:${relPath}` };
  }
  const r = runGit(harnessDir, ["show", `${sha}:${relPath}`]);
  if (!r.ok) return { ok: false, detail: r.err };
  return { ok: true, content: r.out };
}

export interface RestoreResult {
  readonly ok: boolean;
  /** 回滚后的文件内容(= sha 那一版的原文) */
  readonly content?: string;
  readonly detail?: string;
}

/**
 * 把一份文件回滚到某个提交的版本:`git checkout <sha> -- <relPath>`(落进
 * 暂存与工作树)→ 由调用方随后 `commitAll` 记一笔「回滚」。
 *
 * ⚠️ **不再走 `.bak` 备份**:当前版本在 HEAD 历史里本来就有,回滚动作
 * 自己也会成为一条新历史 —— 备份在这里是三重冗余。
 */
export function restoreFrom(harnessDir: string, sha: string, relPath: string): RestoreResult {
  if (!isInsideHarnessDir(harnessDir, relPath)) {
    return { ok: false, detail: `路径越界:${relPath}` };
  }
  const show = showAt(harnessDir, sha, relPath);
  if (!show.ok) return show;
  const checkout = runGit(harnessDir, ["checkout", sha, "--", relPath]);
  if (!checkout.ok) return { ok: false, detail: checkout.err };
  return { ok: true, content: show.content };
}
