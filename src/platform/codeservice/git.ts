/**
 * 代码服务端口的**真实现**:直接读本机文件系统 + 调 `git`。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────
 *
 *   ① **只读**。它从不 `git init`、不 commit、不改任何文件 —— 「造出仓库」是
 *      编码工用 `write` / `bash` 做的事,平台只负责**核对**它真的做了。
 *      写入侧与核对侧分开,是「7-E:声明与读者」这条教训的直接落法:
 *      平台既当运动员又当裁判的话,那个裁判没有意义。
 *
 *   ② **不信模型给的任何字符串**。路径要解析 + 包含性校验,HEAD 要跟
 *      `git rev-parse` 的输出比对,分支要能在 `refs/heads/` 里找到。
 *      校验通过之后写进库的是**读到的值**,不是模型写的值。
 *
 *   ③ **失败要能自纠**。每条拒绝都带「你该做什么」,而不是 git 的原文。
 *      模型下一步只能靠这段文字(7-D/8-F)。
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CodeServiceClaim, CodeServiceFacts, CodeServiceInspection, CodeServicePort, RepoCommit,
} from "./port.js";

/**
 * 干净的环境。
 *
 * ⚠️ **`GIT_DIR` 必须被 `delete`,不能设成 `""`。** 实测(本机 git):
 * `GIT_DIR="" git rev-parse --is-inside-work-tree` → `fatal: not a git repository: ''`
 * —— 空串被当成一个**路径**,于是每一次核对都会失败,而失败信息读起来像
 * 「这个目录不是 git 仓库」(把一次环境 bug 说成一次数据问题)。
 * 所以要清的是**键**,不是值。
 *
 * 禁掉这些的理由:核对结果必须是**仓库自身**的事实,而不是「跑这台机器的人
 * 碰巧配了什么」。`GIT_DIR` / `GIT_WORK_TREE` 尤其危险 —— 继承它们会让一次核对
 * 读到**另一个仓库**。
 */
const GIT_ENV: NodeJS.ProcessEnv = (() => {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e["GIT_DIR"];
  delete e["GIT_WORK_TREE"];
  delete e["GIT_INDEX_FILE"];
  e["GIT_CONFIG_NOSYSTEM"] = "1"; // 不读系统级 gitconfig
  e["GIT_TERMINAL_PROMPT"] = "0"; // 绝不弹交互(否则会挂住一个回合)
  e["LC_ALL"] = "C"; // 输出可预测(不随 locale 变)
  return e;
})();

/** 跑一条 git 命令。失败返回 null(逐条判断,不抛)。 */
function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: GIT_ENV,
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

function headSha(repoPath: string): string | null {
  const out = git(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const sha = out?.trim() ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * 一段**可执行的**处置说明:建仓库的最小命令序列。
 *
 * 抽出来是因为它会出现在好几条拒绝里,而它们必须**逐字一致** ——
 * 模型对同一件事拿到两种说法时,下一步就变成猜。
 */
const HOW_TO_DELIVER_A_SERVICE = [
  "交付一个代码服务的最小步骤(**项目根已经是一个 git 仓库,不要再 `git init`**):",
  "  cd <项目根>",
  "  mkdir -p services/<服务名>          # ← 这个目录就是 servicePath / docker build 的上下文",
  "  # 写你的代码,并把 Dockerfile 放进**服务目录里面**(不是项目根)",
  "  git add -A && git commit -m \"<这次交付做了什么>\"",
  "  git rev-parse HEAD   # ← 这个 sha 就是 metadata 的 headCommit",
].join("\n");

export function createGitCodeService(opts: { workspaceRoot: string }): CodeServicePort {
  // 工作根的 realpath 只算一次。它必须存在 —— 不存在时 realpathSync 会抛,
  // 那是一次**装配错误**(boot 给的目录没了),不该被当成「这次核对失败」。
  const rootReal = (() => {
    const r = resolve(opts.workspaceRoot);
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  })();

  /** 把模型给的路径解析成一个**确实位于工作根之内**的绝对路径。 */
  function resolveInsideRoot(
    raw: string,
  ): { ok: true; abs: string } | { ok: false; reason: string } {
    if (raw.trim() === "") {
      return { ok: false, reason: "`repoPath` 是空串。它必须是仓库在磁盘上的路径。" };
    }
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(rootReal, raw);
    // 包含性校验**在 realpath 之后**做:符号链接可以指向根之外,只比字符串前缀
    // 是拦不住的(`/root/work/link → /etc`)。
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return {
        ok: false,
        reason:
          `找不到路径「${raw}」(解析为 ${abs})。代码服务的仓库必须**真的存在于磁盘上**,` +
          `平台会去核对它 —— 先把它建出来再写这条交付物。\n\n${HOW_TO_DELIVER_A_SERVICE}`,
      };
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      return {
        ok: false,
        reason:
          `仓库路径「${raw}」解析到 ${real},**不在工作根 ${rootReal} 之内**。` +
          `代码服务交付物的仓库必须落在工作根下面 —— 交付物要能在甲方那台机器上被找到、` +
          `被克隆,把仓库放在工作根之外意味着它随时会消失。`,
      };
    }
    let st;
    try {
      st = statSync(real);
    } catch {
      return { ok: false, reason: `读不到路径「${raw}」的状态。` };
    }
    if (!st.isDirectory()) {
      return {
        ok: false,
        reason: `「${raw}」是一个文件,不是目录。代码服务的 \`repoPath\` 要指向**仓库根目录**。`,
      };
    }
    return { ok: true, abs: real };
  }

  /**
   * 把模型给的 `servicePath` 解析成**仓库之内**的一个真实目录(设计 §3.2a)。
   *
   * 三条判据:必须是**相对路径**、解析后**在仓库之内**(realpath 之后比,
   * 符号链接也拦得住)、且**是一个目录**。交付物的边界由它定义 —— 判松了,
   * 交付物会把项目根里的 `artifacts/` / `work/`(内部工作记录)一起算进去,
   * 而一个项目交两个服务时两条交付物在 `repoPath` 上完全相同,读面分不出谁是谁。
   */
  function resolveService(
    repoPath: string,
    raw: string,
  ): { ok: true; gitPath: string; abs: string } | { ok: false; reason: string } {
    const p = raw.trim();
    if (p === "") {
      return {
        ok: false,
        reason:
          "`servicePath` 是空串。它必须是仓库内的**服务目录**相对路径(例如 `services/billing`)—— " +
          "交付物的边界与 `docker build` 的构建上下文都由它定义。",
      };
    }
    if (isAbsolute(p)) {
      return {
        ok: false,
        reason:
          `\`servicePath\` 必须是**仓库内相对路径**(例如 \`services/billing\`),收到绝对路径「${p}」。` +
          `绝对路径只出现在 \`repoPath\` 里 —— 交付物的边界要能跟着仓库一起被 clone 到甲方那台机器上。`,
      };
    }
    const abs = resolve(repoPath, p);
    const prefix = repoPath.endsWith(sep) ? repoPath : repoPath + sep;
    if (abs === repoPath) {
      return {
        ok: false,
        reason:
          `\`servicePath\` 不能是仓库根(收到「${p}」)。项目根里还有 \`artifacts/\`(内部工件正文)` +
          `与 \`work/\`(中间产物)—— 拿它当交付物,边界就消失了,而且一个项目交两个服务时` +
          `两条交付物在 \`repoPath\` 上完全相同。请把服务放进一个子目录(如 \`services/<名字>\`)。`,
      };
    }
    if (!abs.startsWith(prefix)) {
      return {
        ok: false,
        reason:
          `服务目录「${p}」解析为 ${abs},**不在仓库 ${repoPath} 之内**。` +
          `交付物的内容必须真的在项目仓里 —— 在仓外意味着甲方 clone 下来拿不到它。`,
      };
    }
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return {
        ok: false,
        reason:
          `找不到服务目录「${p}」(解析为 ${abs})。\`servicePath\` 是交付物的**构建上下文** —— ` +
          `它必须真的存在于项目仓里,先把它建出来再写这条交付物。\n\n${HOW_TO_DELIVER_A_SERVICE}`,
      };
    }
    if (real !== repoPath && !real.startsWith(prefix)) {
      return {
        ok: false,
        reason:
          `服务目录「${p}」经符号链接解析到 **${real}**,不在仓库 ${repoPath} 之内` +
          `(它要么在仓外,要么兜回了仓库根)。工作区里的符号链接可以指向仓库内部,` +
          `但不许让一次交付引用仓外的内容。`,
      };
    }
    let st;
    try {
      st = statSync(real);
    } catch {
      return { ok: false, reason: `读不到服务目录「${p}」的状态。` };
    }
    if (!st.isDirectory()) {
      return {
        ok: false,
        reason:
          `「${p}」是一个文件,不是目录。\`servicePath\` 要指向**服务目录**(构建上下文),` +
          `甲方在它下面执行 \`docker build\` —— 指向一个文件时那条命令无从开始。`,
      };
    }
    // git 的 pathspec 用**仓库相对、斜杠分隔**的路径;`abs` 可能带符号链接形式,
    // 而 `real` 用来判包含性(上面)。两者都保留,各司其职。
    const gitPath = relative(repoPath, abs).split(sep).join("/");
    return { ok: true, gitPath, abs };
  }

  function inspect(claim: CodeServiceClaim): CodeServiceInspection {
    const located = resolveInsideRoot(claim.repoPath);
    if (!located.ok) return { ok: false, reason: located.reason };
    const repoPath = located.abs;

    // ── ① 真的是 git 仓库吗 ──
    const insideWorkTree = git(repoPath, ["rev-parse", "--is-inside-work-tree"])?.trim();
    if (insideWorkTree !== "true") {
      return {
        ok: false,
        reason:
          `「${repoPath}」不是一个 git 工作区(\`git rev-parse --is-inside-work-tree\` 没有回 true)。` +
          `一个**代码服务**交付物必须是一个真的 git 仓库 —— 它是甲方拿去部署、` +
          `拿去继续开发的东西,不是一堆躺着的文件。\n\n${HOW_TO_DELIVER_A_SERVICE}`,
      };
    }

    // ── ①b 而这个路径必须**就是仓库根**(不是它里面的某个子目录)──
    //
    // `--is-inside-work-tree` 在子目录里也回 true,所以只靠它会把
    // `<repo>/src` 这种路径记成「仓库路径」—— 甲方拿到之后 `docker build .`
    // 会从一个没有 Dockerfile 的目录开始,而错误现场在很久之后才出现。
    // 判据要精确到「根」:`git rev-parse --show-toplevel` 必须等于这个路径。
    const toplevel = git(repoPath, ["rev-parse", "--show-toplevel"]);
    if (toplevel !== null && toplevel.trim() !== "") {
      let topReal: string;
      try {
        topReal = realpathSync(toplevel.trim());
      } catch {
        topReal = resolve(toplevel.trim());
      }
      if (topReal !== repoPath) {
        return {
          ok: false,
          reason:
            `「${repoPath}」是仓库 **${topReal}** 内部的一个子目录,不是仓库根。` +
            `\`repoPath\` 必须指向**仓库根目录** —— 甲方在它下面执行 \`git clone\` 与 ` +
            `\`docker build .\`,指向子目录会让这两条命令从错的地方开始。` +
            `把它改成 ${topReal}(或者用 \`git rev-parse --show-toplevel\` 读出来照抄)。`,
        };
      }
    }

    // ── ② HEAD 存在吗(空仓库没有 commit)──
    const head = headSha(repoPath);
    if (head === null) {
      return {
        ok: false,
        reason:
          `仓库「${repoPath}」还没有任何提交(HEAD 解析不出来)。` +
          `一份没有提交的代码服务交付物是**无法被部署**的 —— 甲方 clone 下来会得到一个空目录。` +
          `先 \`git add -A && git commit\`。\n\n${HOW_TO_DELIVER_A_SERVICE}`,
      };
    }

    // ── ③ 模型声称的 HEAD 与真实 HEAD 一致吗 ──
    const claimed = claim.headCommit.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(claimed)) {
      return {
        ok: false,
        reason:
          `\`headCommit\` 必须是 HEAD 的提交 sha(7–40 位十六进制),收到「${claim.headCommit}」。` +
          `在仓库里跑 \`git rev-parse HEAD\` 就是它。`,
      };
    }
    if (!head.startsWith(claimed)) {
      return {
        ok: false,
        reason:
          `\`headCommit\` 说你交付的是「${claim.headCommit}」,而仓库 ${repoPath} 的 HEAD 实际是 ` +
          `**${head}**。两者必须一致 —— 交付物的意义就是「甲方拿到的是**这一个**提交」,` +
          `记错了就等于把交付钉在了一个不存在(或还没做完)的版本上。` +
          `要么把 \`headCommit\` 改成 ${head},要么先在仓库里把这次的工作提交掉` +
          `(\`git add -A && git commit\`)。`,
      };
    }

    // ── ④ 分支存在,而且它就是 HEAD 的顶端 ──
    const branch = claim.branch.trim();
    if (branch === "") {
      return { ok: false, reason: "`branch` 是空串。它必须是仓库里真实存在的分支名(例如 `main`)。" };
    }
    const branchSha = git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])?.trim();
    if (branchSha === undefined || !/^[0-9a-f]{40}$/.test(branchSha)) {
      const all = (git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]) ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      return {
        ok: false,
        reason:
          `仓库里没有分支「${branch}」。现有分支:${all.length > 0 ? all.join(", ") : "(一个都没有)"}。` +
          `代码服务交付物记的是**一个分支的当前顶端** —— 分支写错,甲方就不知道从哪一条线开始。`,
      };
    }
    if (branchSha !== head) {
      return {
        ok: false,
        reason:
          `分支「${branch}」的顶端是 ${branchSha},而 HEAD 是 ${head} —— ` +
          `这一次交付的提交**不在**那条分支的顶端上。平台记录的是「分支的当前顶端」,` +
          `两者必须同一个提交:要么 \`git checkout ${branch}\` 之后重新提交,` +
          `要么把 \`branch\` 改成 HEAD 真正所在的那条分支。`,
      };
    }

    // ── ④b 服务目录 = 交付物的边界(设计 §3.2a)──
    //
    // 它必须**在仓库之内**,而且**不是仓库根**:项目根里还有 `artifacts/` 与
    // `work/`,拿根当交付物等于把内部工作记录也算进交付物。`repoPath` 与
    // `servicePath` 是同一个仓库的两个层次 —— 前者是仓库,后者是这一份交付物。
    const service = resolveService(repoPath, claim.servicePath);
    if (!service.ok) return { ok: false, reason: service.reason };

    // ── ⑤ Dockerfile(**服务目录之内**,不是仓库根)──
    const dockerfileAbs = join(service.abs, "Dockerfile");
    if (!existsSync(dockerfileAbs) || !statSync(dockerfileAbs).isFile()) {
      return {
        ok: false,
        reason:
          `服务目录 ${service.gitPath} 里没有 \`Dockerfile\`(仓库根有没有都不算)。` +
          `「可以独立部署到 Docker 上」这句话的**机械判据**就是构建上下文里有它 —— ` +
          `没有的话,这份交付物在甲方那里是一句承诺,不是一件东西。` +
          `把 \`Dockerfile\` 写进 ${service.gitPath}/(构建 + 启动这个服务),提交之后再来写这条交付物。`,
      };
    }
    const dockerfile = `${service.gitPath}/Dockerfile`;

    // ── ⑥ 这个交付物的**版本**:最后触及服务目录的那个提交 ──
    //
    // 为什么不能拿 HEAD 当版本:平台每回合都会写工件正文并提交 ⇒ HEAD 一直在动,
    // 而交付物根本没变。判据很硬:平台写一堆工件提交之后这个值不动;
    // 动了服务目录它必须动。
    //
    // 它必须存在(类型是 `string`,没有「空版本」这种状态):服务目录里一个
    // **被提交的文件**都没有时,交付物在 git 里根本不存在 —— 甲方 clone 下来是空的。
    const deliverableCommit = (
      git(repoPath, ["log", "-1", "--format=%H", "--", service.gitPath]) ?? ""
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(deliverableCommit)) {
      return {
        ok: false,
        reason:
          `服务目录 ${service.gitPath} 里还没有任何**被提交的**文件 —— 它在 git 历史里不存在。` +
          `交付物的内容 = 被 git 跟踪的文件,所以一份没提交的服务 clone 下来是空的。` +
          `先 \`git add ${service.gitPath} && git commit\` 再写这条交付物。\n\n${HOW_TO_DELIVER_A_SERVICE}`,
      };
    }
    const deliverableSubject = (
      git(repoPath, ["log", "-1", "--format=%s", "--", service.gitPath]) ?? ""
    ).trim();

    // ── ⑦ 读事实(全部来自 git / fs,没有一个是模型说的)──
    const headSubject = (git(repoPath, ["log", "-1", "--pretty=%s"]) ?? "").trim();
    // `commitCount` 也**按服务目录算** —— 数整个仓库的话,平台每回合写工件的
    // 提交都会让「这个服务改了多少次」虚增。
    const countRaw = (
      git(repoPath, ["rev-list", "--count", "HEAD", "--", service.gitPath]) ?? ""
    ).trim();
    const commitCount = /^\d+$/.test(countRaw) ? Number(countRaw) : 0;
    // 服务目录的**一级条目**读面用来一眼看结构。
    const files = (() => {
      try {
        return readdirSync(service.abs)
          .filter((n) => n !== ".git")
          .filter((n) => {
            // 断链的符号链接会让 statSync 抛 —— 一个坏链接不该让整次核对失败,
            // 它只是**不进列表**。
            try {
              const l = lstatSync(join(service.abs, n));
              return l.isSymbolicLink() || l.isDirectory() || l.isFile();
            } catch {
              return false;
            }
          })
          .sort()
          .slice(0, 60);
      } catch {
        return [];
      }
    })();
    // 交付物的内容 = **被 git 跟踪的文件** ⇒ 被 `.gitignore` 吃掉的东西甲方
    // clone 不到,交付物**静默残缺**。而 `node_modules` / 构建产物本来就该被忽略,
    // 所以这是**告警不是拒绝**(设计 §3.2d):列出来,让读面说清楚。
    const ignoredFiles = (
      git(repoPath, ["status", "--ignored", "--porcelain", "--", service.gitPath]) ?? ""
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("!! "))
      .map((l) => l.slice(3).trim().replace(/\/+$/, ""))
      .filter((l) => l !== "")
      .slice(0, 60);

    const facts: CodeServiceFacts = {
      repoPath,
      repoName: repoPath.split(sep).filter((s) => s !== "").pop() ?? repoPath,
      servicePath: service.gitPath,
      branch,
      headCommit: head,
      headSubject,
      deliverableCommit,
      deliverableSubject,
      commitCount,
      dockerfile,
      files,
      ignoredFiles,
    };
    return { ok: true, facts };
  }

  function recentCommits(input: {
    readonly repoPath: string;
    readonly servicePath: string;
    readonly limit: number;
  }): readonly RepoCommit[] | null {
    // ⚠️ **读面**的路径校验比写入侧宽:这里只回答「这一版改了什么」,
    // 而一条**已经成立**的交付物不该因为仓库后来被删/被移走而在界面上变成
    // 「不存在」。读不到就如实返回 null,由读面渲染成「读不到」—— 与
    // `runtime: "unavailable"` 那条纪律同源:读不到不是空。
    const repoPath = input.repoPath;
    const spec = input.servicePath.trim();
    const args = [
      "log",
      `-${Math.max(1, Math.min(100, input.limit))}`,
      "--pretty=%H%x1f%h%x1f%an%x1f%at%x1f%s",
    ];
    if (spec !== "") {
      // ⚠️ **必须按 `servicePath` 过滤**:项目仓里还有平台每回合写工件的提交,
      // 不过滤的话「这个服务改了什么」会混进一堆与它无关的提交(设计 §3.2b)。
      // 逃出仓库的路径 ⇒ 读不到(`null`),**不是**空列表。
      if (isAbsolute(spec)) return null;
      const abs = resolve(repoPath, spec);
      const prefix = repoPath.endsWith(sep) ? repoPath : repoPath + sep;
      if (!abs.startsWith(prefix)) return null;
      args.push("--", spec);
    }
    const raw = git(repoPath, args);
    if (raw === null) return null;
    const out: RepoCommit[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const [sha, shortSha, author, atRaw, subject] = line.split("\u001f");
      if (!sha || !shortSha) continue;
      const at = Number(atRaw);
      out.push({
        sha,
        shortSha,
        author: author ?? "",
        committedAt: Number.isFinite(at) ? at * 1000 : 0,
        subject: subject ?? "",
      });
    }
    return out;
  }

  /**
   * 这个提交在仓库里**还可达**吗。
   *
   * 交付物与工作区**同仓**(设计 §3.2c)⇒ 一次 `git reset --hard` 就能让
   * 库里的 `deliverableCommit` 变成不可达对象,而索引仍指着它。读面必须能
   * 如实报 `unreachable` —— **不许**回一个空提交列表假装正常。
   *
   * 两条判据,缺一不可:
   *   ① 对象还在(`git cat-file -e <sha>^{commit}`);
   *   ② 还能从 HEAD 走到(`merge-base --is-ancestor`)。⚠️ 只判 ① 是不够的:
   *      `reset --hard` 之后旧提交在 `.git` 里**仍然存在**(直到 gc),
   *      于是「不可达」会被读成「可达」—— 那正是这条判据要防的形态。
   */
  function isReachable(input: { readonly repoPath: string; readonly sha: string }): boolean {
    const sha = input.sha.trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return false;
    if (git(input.repoPath, ["cat-file", "-e", `${sha}^{commit}`]) === null) return false;
    return git(input.repoPath, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== null;
  }

  return { inspect, recentCommits, isReachable };
}

/**
 * 一个**永远拒绝**的实现。给「没有注入端口」的装配错误用。
 *
 * 为什么不返回 `undefined` 然后让工具静默通过:那样一条 `code_service`
 * 交付物在没装配核对端口的环境里会被**照单全收**,而它可能指向一个不存在的
 * 仓库 —— 静默通过比失败危险得多(7-E 的同一条)。
 */
export function unavailableCodeService(reason: string): CodeServicePort {
  return {
    inspect: () => ({ ok: false, reason }),
    recentCommits: () => null,
    // 「没接上核对面」⇒ 可达性**也不知道**。回 `false`(读面渲染成
    // `unreachable` 之外的那条 unavailable 分支由端口缺席表达)——
    // 唯一不许的是回 `true` 假装核对过。
    isReachable: () => false,
  };
}
