/**
 * 工作区 · 端口(`WorkspacePort`)—— **冻结接口**,实施前先读本文
 *
 * ── 为什么是一个端口,而不是在工具里直接 `fs` / `git` ──────────────
 *
 * 与 `MemoryPort` / `ClientChannel` / `CodeServicePort` 同一条理由(设计 1 §8.3):
 *   · 工具实现是**纯函数**,依赖全部显式注入 —— 直接 `writeFileSync` / `execFileSync`
 *     会让「一次工具调用」不可测、不可复现,而工具层是本项目唯一能真跑的那一层;
 *   · 落点可替换 —— 将来工作区不在本机(容器卷 / 远端)时,换的是这个实现。
 *
 * ── 这个端口**不管**什么 ──────────────────────────────────────────
 *
 *   · **不判定授权。** 「谁能写」由 `harness/authorize.ts` 的三道门决定,
 *     这里只负责「写到哪、写得成不成」。
 *   · **不碰数据库。** 索引行的读写是 `storage/repo/artifacts.ts` 的事;
 *     顺序(先文件后行)由调用方 `tools/blackboard.ts` 保证 ——
 *     那是**调用方的纪律**,不是端口的。
 *   · **不读 `settings`。** 工作根由调用方传进来(见 `workspace/root.ts`)。
 *
 * ── 读不到的语义:`WorkspaceResult` 而不是抛异常 ────────────────────
 *
 * 「读不到」是一个**要展示给用户的状态**(同 `ProjectLiveView.runtime`),
 * 不是一次程序错误:它必须能被翻成 `runtime: "unavailable"` + 可执行的 `problem`,
 * 而不是变成一个 500。所以这一层用返回值表达失败,**不抛**。
 * 抛出去 = 调用方只能 catch 成一句「内部错误」,而现场(哪条路径、为什么)就丢了。
 */
import type { Stats } from "node:fs";

/** 一次成功的读写结果。失败一律走 {@link WorkspaceResult} 的 `ok: false` 分支。 */
export type WorkspaceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

/** 一条被排除在提交之外的条目 —— **必须可见**(见 `WorkspaceCommit.excluded`)。 */
export interface WorkspaceExcluded {
  /** 项目根相对路径 */
  readonly path: string;
  /** 为什么没进版本库。取值域是闭集,前端照它分派文案。 */
  readonly reason: "secret" | "oversized";
  /** 可执行的细节:秘密命中哪条规则 / 文件多大 */
  readonly detail: string;
}

export interface WorkspaceCommit {
  /** 无变更时为 `false` —— **不产生空提交**(实测:`git commit` 无改动返回 1)。 */
  readonly committed: boolean;
  /** 新 HEAD;`committed === false` 时是当前 HEAD(可能为 null:仓里还没有提交) */
  readonly sha: string | null;
  /**
   * 被闸门挡下的条目。
   *
   * ⚠️ **不许静默**。交付口径是「整仓对甲方可见」⇒ 没进版本库的东西甲方也拿不到,
   * 所以「没进去」与「进去了」在界面上必须长得不一样。
   */
  readonly excluded: readonly WorkspaceExcluded[];
}

/**
 * 工作区文件与版本库。**全部路径都以 `root` 为界**(项目根,见 `workspace/root.ts`)。
 *
 * 所有 `path` 参数都是**项目根相对路径**(`artifacts/x.html`),不是绝对路径;
 * 绝对路径只在返回值里出现。任何逃出 `root` 的路径(**realpath 之后**判,
 * 符号链接也拦得住)一律 `ok: false` —— 与 `codeservice/git.ts` 的
 * `resolveInsideRoot` 同一条判据,不重写第二份。
 */
export interface WorkspacePort {
  /** 算一个项目根相对路径的绝对落点。逃出 root ⇒ `ok: false`。 */
  resolveInside(input: { root: string; path: string }): WorkspaceResult<{ abs: string; path: string }>;

  /**
   * **原子写**:写临时文件 → `rename`。父目录按需建。
   *
   * 为什么必须原子:读到半个文件与读到一份完整文件,在屏幕上**长得一样**;
   * 而工件正文被截断这件事没有任何下游判据会发现。
   */
  writeAtomic(input: {
    root: string;
    path: string;
    content: string;
  }): WorkspaceResult<{ path: string; sha256: string; bytes: number }>;

  /** 读当前工作树里的正文。读不到(不存在 / 不是文件 / 权限)⇒ `ok: false`。 */
  read(input: { root: string; path: string }): WorkspaceResult<string>;

  /**
   * 读**某个提交里**的版本(`git show <sha>:<path>`)。
   *
   * 这是「索引记了 sha ⇒ 内容按 sha 可寻址」的落点:文件被改、被删、被回滚之后,
   * 历史版本仍然读得出来。读不出来(sha 不可达 / 该提交里没有这条路径)⇒ `ok: false`
   * —— 调用方要把它翻成 `runtime: "unavailable"` 并**指向 `at=`**,而不是回空正文。
   */
  show(input: { root: string; sha: string; path: string }): WorkspaceResult<string>;

  /** 路径的 stat(只读面用)。不存在 ⇒ `ok: false`。 */
  stat(input: { root: string; path: string }): WorkspaceResult<Stats>;

  /**
   * 建仓,**幂等**:`git init`(缺省分支 `main`)+ 按传入内容写 `.gitignore` /
   * `README.md` + 首次提交。已有仓时只补缺的文件,不重置、不移动任何东西。
   */
  initRepo(input: {
    root: string;
    gitignore: string;
    readme: string;
  }): WorkspaceResult<{ created: boolean; sha: string | null }>;

  /**
   * 提交:过三条闸门 → `git add -A` → `git commit --author=…`。
   *
   * 闸门(设计 §3.3,失败**必须可见**——由返回值承载,不写日志了事):
   *   · `secret`:命中秘密规则的文件**永不提交**;
   *   · `oversized`:单文件超过上限 ⇒ **不提交**并列出。
   *
   * 并发:同项目两个角色可能同时在动这个仓(agent 在回合内自己提交代码),
   * 撞 `index.lock` 时**退避重试**,用尽才 `ok: false` —— 调用方要把它落成
   * 一条可见的失败,不许静默吞掉(否则「提交了」与「没提交」长得一样)。
   */
  commit(input: {
    root: string;
    /** `Author Name <email>`;名字来自 `identity/org.ts` 的 `ORG`(中文名唯一来源) */
    author: string;
    message: string;
    /** 单文件上限(字节)。缺省由实现给一个常量。 */
    maxFileBytes?: number;
  }): WorkspaceResult<WorkspaceCommit>;

  /** 内容哈希。平台写文件时算一次,提交重建索引时再算一次用于对账。 */
  sha256(content: string): string;
}
