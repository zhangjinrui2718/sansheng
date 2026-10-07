/**
 * BC3 Blackboard · 代码服务端口(`code_service` 交付物的**核对面**)
 *
 * ── 它解决的是什么 ──────────────────────────────────────────────
 *
 * 用户原话(2026-10-08):「加一个新的交付物类型,叫做代码服务,这个是一个 git
 * 仓库,然后这个仓库可以独立部署到 docker 上面」。
 *
 * 于是「一份交付物」第一次有了**仓库坐标**(路径 / 分支 / HEAD / Dockerfile)。
 * 而坐标是**模型写的字符串** —— 如果不核对,模型只要写一行
 * `deliverableType='code_service'` 加一段看起来很真的 metadata,平台就会记下
 * 「这个项目交付了一个代码服务」,而磁盘上什么都不存在。这正是本项目 7-E 那条
 * 教训的另一种形态:**声明必须有读者**,而这里「读者」就是这段核对。
 *
 * ⇒ `board_write` 写 `code_service` 时,**必须**先过 `inspect()`;
 *   它不信模型给的任何一个字,而是自己去盘上把事实读出来。核对通过之后,
 *   写进 `metadata_json` 的是**平台读到的事实**,不是模型的声明。
 *
 * ── 为什么是一个端口,而不是在工具里直接 `execFileSync("git")` ──────
 *
 * 与 `MemoryPort` / `ClientChannel` 同一条理由(设计 1 §8.3):
 *   · 工具实现是**纯函数**,依赖全部显式注入 —— 直接 spawn 会让「一次工具调用」
 *     不可测、不可复现,而工具层的测试是本项目唯一能真跑的那一层;
 *   · 存储形态可替换 —— 将来仓库不在本机(远程 / 容器卷)时,换的是这个实现,
 *     不是工具层。
 */
import type { DeliverableType } from "../storage/repo/artifacts.js";

/**
 * 一个代码服务的**已核实坐标**。每一个字段都是平台从盘上读出来的,
 * 没有一个是模型说的 —— 这是这个类型存在的全部意义。
 */
export interface CodeServiceFacts {
  /** 仓库根,**绝对路径**(已 realpath,符号链接已解析) */
  readonly repoPath: string;
  /** 仓库目录名(= 建议的镜像名基底) */
  readonly repoName: string;
  /** 分支名,且 `HEAD` 正好是它的顶端 */
  readonly branch: string;
  /** 40 位全 sha */
  readonly headCommit: string;
  /** HEAD 的提交标题(第一行)—— 给读面一句话看明白「这版做了什么」 */
  readonly headSubject: string;
  /** 从 HEAD 往回数得到的提交总数 */
  readonly commitCount: number;
  /** Dockerfile 在仓库里的相对路径(必须在根:`Dockerfile`) */
  readonly dockerfile: string;
  /** 仓库根的一级条目(不含 `.git`),读面用来一眼看结构 */
  readonly files: readonly string[];
}

/**
 * 核对结果。
 *
 * ⚠️ **失败必须带可执行的处置**(7-D/8-F):模型只能靠这段文字决定下一步。
 * 「not a git repository」这种原文不够 —— 它得知道要 `git init`、
 * `git add -A`、`git commit`,`git rev-parse HEAD` 拿到 sha。
 */
export type CodeServiceInspection =
  | { readonly ok: true; readonly facts: CodeServiceFacts }
  | { readonly ok: false; readonly reason: string };

/** 一次核对的输入 —— 全部来自模型在 `board_write` 里写的 metadata。 */
export interface CodeServiceClaim {
  /** 仓库路径(绝对,或在工作根之下的相对路径) */
  readonly repoPath: string;
  /** 模型声称的分支 */
  readonly branch: string;
  /** 模型声称的 HEAD 提交(短 sha 也接受,前缀匹配即可) */
  readonly headCommit: string;
}

/** 读面用的一条提交(不是核对面 —— 它只在渲染交付物时读)。 */
export interface RepoCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly committedAt: number;
  readonly author: string;
}

export interface CodeServicePort {
  /**
   * 去盘上核对一个「代码服务」的坐标。**同步**:工具调用本身是同步的,
   * 而这是一次本地 `git` 调用(几毫秒),不值得为它把工具层改成异步。
   */
  inspect(claim: CodeServiceClaim): CodeServiceInspection;
  /**
   * 读最近若干条提交。**给读面用**(工件详情页的「这版改了什么」),
   * 不参与写入判定 —— 读失败不该让一条已经成立的交付物变成不存在,
   * 所以它返回 `null` 而不是抛错。
   */
  recentCommits(repoPath: string, limit: number): readonly RepoCommit[] | null;
}

/**
 * `kind='deliverable' + deliverableType='code_service'` 在 metadata 里
 * **必须**带的键。和 `CodeServiceClaim` 一一对应 —— 列在这里是为了让
 * 「缺哪个键」这句拒绝能机械生成,而不是靠人手写三遍。
 */
export const CODE_SERVICE_REQUIRED_META = ["repoPath", "branch", "headCommit", "service", "port"] as const;

/** 一个类型化的小断言:这个交付物类型是不是需要仓库核对。 */
export function needsRepoVerification(t: DeliverableType): boolean {
  return t === "code_service";
}
