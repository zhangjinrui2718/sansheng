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
  /**
   * 仓库根,**绝对路径**(已 realpath,符号链接已解析)。
   *
   * ⚠️ 2026-10-08 起它就是**项目根**:代码服务不再有独立仓库,直接复用项目仓。
   * 交付物的**边界**改由 {@link servicePath} 表达 —— 项目根里还有 `artifacts/` /
   * `work/`,拿它当交付物等于把内部工作记录也算进交付物,而且一个项目交两个服务时
   * 两条交付物的 `repoPath` 会完全相同,读面分不出谁是谁。
   */
  readonly repoPath: string;
  /** 仓库目录名(= 项目目录名) */
  readonly repoName: string;
  /** **服务目录**:仓库内的相对路径,即构建上下文(`docker build services/x`)。Dockerfile 在这里。 */
  readonly servicePath: string;
  /** 分支名,且 `HEAD` 正好是它的顶端 */
  readonly branch: string;
  /** 40 位全 sha(交付那一刻的仓库现场) */
  readonly headCommit: string;
  /** HEAD 的提交标题(第一行) */
  readonly headSubject: string;
  /**
   * **这个交付物的版本** = 最后触及 `servicePath` 的那个提交
   * (`git log -1 --format=%H -- <servicePath>`)。
   *
   * ⚠️ 为什么不能直接用 `headCommit`:平台**每个回合**都会写工件正文并提交,
   * 于是 HEAD 一直在动,而交付物根本没变 —— 用 HEAD 当版本会让一条已经交付的
   * 代码服务看起来「一直在改」。判据很硬:**平台写一堆工件提交之后这个值不动;
   * 动了服务目录它必须动。**
   */
  readonly deliverableCommit: string;
  /** `deliverableCommit` 的提交标题(第一行)—— 读面用一句话说「这版做了什么」 */
  readonly deliverableSubject: string;
  /** 触及 `servicePath` 的提交总数(`git rev-list --count HEAD -- <servicePath>`) */
  readonly commitCount: number;
  /** Dockerfile 在**仓库内**的相对路径(必须在 `servicePath` 之内) */
  readonly dockerfile: string;
  /** `servicePath` 的一级条目(不含 `.git`),读面用来一眼看结构 */
  readonly files: readonly string[];
  /**
   * `servicePath` 下被 `.gitignore` **忽略**的条目。
   *
   * 交付物的内容 = **被 git 跟踪的文件** ⇒ 忽略掉的东西甲方 clone 不到,
   * 交付物**静默残缺**。而 `node_modules` / 构建产物本来就该被忽略,
   * 所以这是**告警不是拒绝**:列出来,让读面说清楚。
   */
  readonly ignoredFiles: readonly string[];
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
  /** 仓库路径(绝对,或在工作根之下的相对路径)—— 2026-10-08 起就是**项目根** */
  readonly repoPath: string;
  /** 服务目录(仓库内相对路径,如 `services/billing-api`);Dockerfile 必须在它里面 */
  readonly servicePath: string;
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
   *
   * ⚠️ 必须**按 `servicePath` 过滤**:项目仓里还有平台写工件的提交,
   * 不过滤的话「这个服务改了什么」会混进一堆与它无关的提交。
   */
  recentCommits(input: {
    readonly repoPath: string;
    readonly servicePath: string;
    readonly limit: number;
  }): readonly RepoCommit[] | null;
  /**
   * 这个提交在仓库里**还可达**吗(`git cat-file -e <sha>^{commit}` +
   * `merge-base --is-ancestor`)。
   *
   * 交付物与工作区同仓 ⇒ 一次 `git reset --hard` 就能让 `deliverableCommit`
   * 变成不可达对象,而库里的索引仍然指着它。读面必须能如实报 `unreachable` ——
   * **不许**回一个空提交列表假装正常。
   */
  isReachable(input: { readonly repoPath: string; readonly sha: string }): boolean;
}

/**
 * `kind='deliverable' + deliverableType='code_service'` 在 metadata 里
 * **必须**带的键。和 `CodeServiceClaim` 一一对应 —— 列在这里是为了让
 * 「缺哪个键」这句拒绝能机械生成,而不是靠人手写三遍。
 */
export const CODE_SERVICE_REQUIRED_META = [
  "repoPath",
  "servicePath",
  "branch",
  "headCommit",
  "service",
  "port",
] as const;

/** 一个类型化的小断言:这个交付物类型是不是需要仓库核对。 */
export function needsRepoVerification(t: DeliverableType): boolean {
  return t === "code_service";
}
