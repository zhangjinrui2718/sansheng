/**
 * 工作区扫描 —— **只读**的「项目文件系统」观测面(设计 `docs/DESIGN-WORKSPACE.md` §4.4, **P0**)
 *
 * ── 它回答什么问题 ────────────────────────────────────────────────
 *
 * 「盘上有什么、库里的索引引用了什么、两边对不对得上」。今天盘对整个 UI 是黑盒
 * (§4.4 原话),这一步是最便宜的一步:一个纯函数 + 一条只读端点,不写任何东西。
 *
 * ── 三条纪律(每一条都有对应的负样本测试)────────────────────────
 *
 *   ① **读不到 ≠ 空目录。** `root` 不存在 / 不是目录 / 读不出内容 ⇒
 *      `runtime: "unavailable"` + 非空且带**绝对路径**的 `problem`,`entries` 为空。
 *      这是本项目反复写死的那条(`ProjectLiveView.runtime` 同源):把一次读失败
 *      渲染成空目录,屏幕上与「这个项目还没产出」一模一样。
 *
 *   ② **截断必须说出来。** 深度上限 3 层、条目上限 500。到任一上限(或遇到一个
 *      读不动的子目录)都置 `truncated: true` —— 不许静默少列。上限存在的理由
 *      与 §4.4 无关,是「一个失控的目录树不该把一次 HTTP 请求拖死」。
 *
 *   ③ **读不到 root 时不做对账。** `indexed` / `orphanFile` / `missing` 三个
 *      集合回答的是「两边对不对得上」,而这个问题**需要一次成功的读**才有答案。
 *      root 读不到时 `missing` 保持空 —— 否则「读不到」会被说成「库里的文件都
 *      在盘上消失了」,那是一个更重的谎。索引侧有多少条由 `WorkspaceView.index`
 *      的计数如实承载。
 *
 * ── 为什么是纯函数 ────────────────────────────────────────────────
 *
 * 依赖(`root` / 索引路径)全部显式传入,不读全局、不碰库、不碰 settings ——
 * 与 `codeservice/git.ts` / `web/src/lib/*.ts` 同一种做法:这一层是**唯一能被
 * 单测真跑**的一层,而它一旦偷偷去读环境,测试就只能靠「跑完没报错」当判据。
 */
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 一条盘上的条目。**目录以 `/` 结尾** —— 路径本身就是它的类型声明。 */
export interface WorkspaceEntry {
  /** 相对 root 的路径,如 `artifacts/art_x-report.html`;目录以 `/` 结尾 */
  path: string;
  kind: "file" | "dir";
  /** 文件给字节数;目录给 `null`(不做递归求和 —— 那是另一个问题) */
  bytes: number | null;
  mtimeMs: number;
}

/** 一次扫描的全部结果。`runtime` 是这份结果能不能当事实用的唯一闸门。 */
export interface WorkspaceScan {
  runtime: "ok" | "unavailable";
  /** `runtime === "unavailable"` 时**必须**非空,且写明绝对路径与原因 */
  problem: string | null;
  entries: WorkspaceEntry[];
  /** 到深度 / 条目上限,或有内容读不出来 —— **不许静默截断** */
  truncated: boolean;
  /** 被索引引用、且**在盘上存在**的条目 */
  indexed: WorkspaceEntry[];
  /** 盘上有、索引里没有(只算文件 —— 目录不进索引) */
  orphanFile: string[];
  /** 索引里有、盘上没有(`runtime === "unavailable"` 时恒为空,见文件头 ③) */
  missing: string[];
}

/** 深度上限:root 的直接子项是第 1 层,最多列到第 3 层。 */
export const WORKSPACE_MAX_DEPTH = 3;
/** 条目上限。到界置 `truncated`,不静默少列。 */
export const WORKSPACE_MAX_ENTRIES = 500;

/**
 * 统一成 `/` 分隔、无前导 `./` / `/` 的**项目根相对**路径。
 *
 * 索引侧(P2 之后)落库的是平台生成的相对路径,而扫描侧拼出来的一定是 `/`
 * (见下)。两边各写一遍会漂,所以归一化只有这一处、两边共用。
 */
export function normalizeWorkspacePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
}

/**
 * 一个 dirent 的形态。`realDir` 区分「真的是目录」与「符号链接指向目录」:
 * 只有前者会被递归 —— 跟着链接走会绕开深度上限,还可能成环(扫描是只读的,
 * 但它不该被一个自指的链接拖死)。
 */
function statEntry(
  abs: string,
): { kind: "file" | "dir"; realDir: boolean; bytes: number | null; mtimeMs: number } | null {
  let l;
  try {
    l = lstatSync(abs);
  } catch {
    // 读不到这一条(断链 / 竞态删除 / 权限)。返回 null 由调用方记成截断,
    // **不**在这里编一个 bytes = 0 的假条目。
    return null;
  }
  if (l.isDirectory()) return { kind: "dir", realDir: true, bytes: null, mtimeMs: l.mtimeMs };
  if (l.isSymbolicLink()) {
    try {
      const t = statSync(abs);
      return {
        kind: t.isDirectory() ? "dir" : "file",
        realDir: false,
        bytes: t.isFile() ? t.size : null,
        mtimeMs: t.mtimeMs,
      };
    } catch {
      // 断链:它**确实存在**(lstat 读到了),所以照实列出来,只是大小读不到。
      return { kind: "file", realDir: false, bytes: null, mtimeMs: l.mtimeMs };
    }
  }
  return { kind: "file", realDir: false, bytes: l.size, mtimeMs: l.mtimeMs };
}

/**
 * 读一个目录的名字并排序。读不到返回 `null` —— 与「空目录」是两个答案,
 * 调用方必须分开处理(文件头 ①)。
 */
function readNames(abs: string): string[] | null {
  try {
    return readdirSync(abs).sort();
  } catch {
    return null;
  }
}

/** `Error.message` 里 Node 已经带了 `ENOENT: … , stat '/path'`,照抄即可,不重编。 */
function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 扫一遍 `root`,并与 `indexedPaths`(项目根相对路径)对账。
 *
 * **纯函数**:同样的输入给同样的输出,不碰库、不读 settings、不写任何东西。
 */
export function scanWorkspace(opts: {
  root: string;
  indexedPaths: readonly string[];
}): WorkspaceScan {
  const root = opts.root;
  const indexSet = new Set(
    opts.indexedPaths.map(normalizeWorkspacePath).filter((p) => p !== ""),
  );

  const unavailable = (problem: string): WorkspaceScan => ({
    runtime: "unavailable",
    problem,
    entries: [],
    truncated: false,
    indexed: [],
    orphanFile: [],
    // 见文件头 ③:读不到就不做对账 —— 不许把「读不到」说成「盘上都没有了」。
    missing: [],
  });

  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (e) {
    return unavailable(
      `读不到工作区根目录 ${root}:${reason(e)}。这**不是**「空目录」—— ` +
        `盘上什么都没能读出来,所以「有没有文件」这件事现在没有答案。`,
    );
  }
  if (!rootStat.isDirectory()) {
    return unavailable(
      `工作区根目录 ${root} 不是一个目录(路径存在,但它是一个文件或别的形态)。`,
    );
  }

  const entries: WorkspaceEntry[] = [];
  let truncated = false;

  // BFS:root 的子项是第 1 层。
  const queue: Array<{ abs: string; rel: string; childDepth: number }> = [
    { abs: root, rel: "", childDepth: 1 },
  ];
  let first = true;

  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;
    const names = readNames(dir.abs);
    if (names === null) {
      if (first) {
        // 目录能 stat 但读不出内容(权限 / 竞态):同样是「读不到」。
        return unavailable(
          `读不到工作区根目录 ${dir.abs} 的内容(目录存在,但列不出条目 —— 多半是权限问题)。`,
        );
      }
      // 子目录读不出来 = 它下面**有东西但没列出来**,照实记成截断。
      truncated = true;
      continue;
    }
    first = false;

    for (const name of names) {
      if (name === ".git") continue; // 版本库内部结构不属于观测面
      if (entries.length >= WORKSPACE_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const abs = join(dir.abs, name);
      const rel = dir.rel === "" ? name : `${dir.rel}/${name}`;
      const st = statEntry(abs);
      if (st === null) {
        truncated = true; // 这一条没列出来 ⇒ 列表不全
        continue;
      }
      entries.push({
        path: st.kind === "dir" ? `${rel}/` : rel,
        kind: st.kind,
        bytes: st.bytes,
        mtimeMs: st.mtimeMs,
      });
      if (st.kind !== "dir" || !st.realDir) continue;
      if (dir.childDepth >= WORKSPACE_MAX_DEPTH) {
        // 到深度上限:这一层**不展开**。它下面还有内容(否则第 3 层这个目录
        // 就不该在列表里)⇒ 列表不全,必须说出来。
        const inner = readNames(abs);
        if (inner !== null && inner.some((n) => n !== ".git")) truncated = true;
        continue;
      }
      queue.push({ abs, rel, childDepth: dir.childDepth + 1 });
    }
  }

  // 排序稳定(按 path 字典序)—— 否则同一棵树两次扫描的顺序可能不同,
  // 而读面的 diff / 测试都会跟着 flaky。
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const onDiskAll = new Set(entries.map((e) => e.path));
  const indexed = entries.filter((e) => indexSet.has(e.path));
  const orphanFile = entries
    .filter((e) => e.kind === "file" && !indexSet.has(e.path))
    .map((e) => e.path);
  const missing = [...indexSet].filter((p) => !onDiskAll.has(p)).sort();

  return {
    runtime: "ok",
    problem: null,
    entries,
    truncated,
    indexed,
    orphanFile,
    missing,
  };
}
