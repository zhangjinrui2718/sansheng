/**
 * 工作区扫描(`scanWorkspace`)· 判据测试
 *
 * ── 这个文件盯的是什么 ──────────────────────────────────────────────
 *
 *   ① **`missing` 逐条问盘,不拿遍历结果当判据。** 这是本文件存在的第一理由:
 *      遍历有深度 3 层 / 500 条上限,索引路径**没有**这两个上限 —— 一个真实存在
 *      的文件只要落在上限之外,旧写法就会把它报成「库里有、盘上无」。
 *      这条错误不报错、不截断,看起来像一次成功的对账(本项目最防的那种)。
 *      所以下面的超限用例**先证明它在遍历结果之外**,再断言它不在 `missing` 里 ——
 *      只测后者的话,一个「`missing` 恒为空」的坏实现也会全绿。
 *   ② **读不到 ≠ 空目录。** 根不存在 / 根是文件 ⇒ `runtime: "unavailable"` +
 *      非空 `problem`,`entries` 为空,**并且不做对账**(`missing` 保持空)。
 *   ③ **上限要说话。** 到深度 / 条数上限 ⇒ `truncated: true`;没到 ⇒ `false`
 *      (负样本,防止一个「truncated 恒真」的实现糊过去)。
 *
 * 每个用例都只碰 `mkdtemp` 出来的临时目录 —— 不碰 HOME,不碰 `~/.sansheng/`。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  normalizeWorkspacePath,
  scanWorkspace,
  WORKSPACE_MAX_DEPTH,
  WORKSPACE_MAX_ENTRIES,
  type WorkspaceScan,
} from "../../src/platform/workspace/scan.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ss-ws-scan-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mk(rel: string): string {
  const abs = join(root, rel);
  mkdirSync(abs, { recursive: true });
  return abs;
}

function file(rel: string, content = "x"): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

function paths(scan: WorkspaceScan): string[] {
  return scan.entries.map((e) => e.path);
}

describe("scanWorkspace · 正常对账(正样本)", () => {
  it("盘上的条目如实列出,索引三集合各自对得上", () => {
    file("artifacts/a.html", "<h1>a</h1>");
    file("notes/todo.md", "todo");
    file("orphan.txt", "没人索引我");

    const scan = scanWorkspace({
      root,
      indexedPaths: ["artifacts/a.html", "notes/todo.md"],
    });

    expect(scan.runtime).toBe("ok");
    expect(scan.problem).toBeNull();
    expect(scan.truncated).toBe(false);
    // 目录以 `/` 结尾 —— 路径本身就是类型声明
    expect(paths(scan)).toEqual([
      "artifacts/",
      "artifacts/a.html",
      "notes/",
      "notes/todo.md",
      "orphan.txt",
    ]);
    expect(scan.indexed.map((e) => e.path)).toEqual(["artifacts/a.html", "notes/todo.md"]);
    expect(scan.orphanFile).toEqual(["orphan.txt"]);
    expect(scan.missing).toEqual([]);
  });

  it("索引里真的不存在的路径**必须**进 missing(否则下面的负样本没有意义)", () => {
    file("a.txt");
    const scan = scanWorkspace({ root, indexedPaths: ["a.txt", "ghost.txt"] });
    expect(scan.missing).toEqual(["ghost.txt"]);
    expect(scan.indexed.map((e) => e.path)).toEqual(["a.txt"]);
  });

  it("索引路径先归一化(`./a.txt` 与 `a.txt` 是同一条)", () => {
    file("a.txt");
    const scan = scanWorkspace({ root, indexedPaths: ["./a.txt"] });
    expect(scan.missing).toEqual([]);
    expect(scan.indexed.map((e) => e.path)).toEqual(["a.txt"]);
  });

  it("归一化**不折叠** `..` —— 含 `..` 的索引路径按逃逸处理(见上一条用例)", () => {
    file("a.txt");
    const scan = scanWorkspace({ root, indexedPaths: ["b/../a.txt"] });
    expect(scan.missing).toEqual(["b/../a.txt"]);
  });

  it("`.git` 内部结构不属于观测面", () => {
    file(".git/config");
    file("a.txt");
    const scan = scanWorkspace({ root, indexedPaths: [] });
    expect(paths(scan).some((p) => p.startsWith(".git"))).toBe(false);
    expect(paths(scan)).toContain("a.txt");
  });
});

describe("scanWorkspace · missing 逐条问盘(核心判据)", () => {
  it("超出条数上限的索引文件**不许**被报成 missing —— 它真实存在", () => {
    // 造一棵**超过 500 条上限**的树:600 个文件都在 root 直接子层。
    for (let i = 0; i < 600; i++) {
      file(`f${String(i).padStart(3, "0")}.txt`);
    }
    // 字典序最后那个一定落在前 500 条之外 —— 用它当索引路径。
    const beyond = "f599.txt";

    const scan = scanWorkspace({ root, indexedPaths: [beyond, "真的没有这个.txt"] });

    // ① 先证明这棵树确实被截断了,而且 `beyond` **确实**不在遍历结果里
    //    —— 否则这条用例根本没在考「遍历之外的文件」。
    expect(scan.truncated).toBe(true);
    expect(scan.entries).toHaveLength(WORKSPACE_MAX_ENTRIES);
    expect(paths(scan)).not.toContain(beyond);

    // ② 但它真实存在 ⇒ 不许进 missing。旧写法(拿 entries 当判据)会在这里红。
    expect(scan.missing).not.toContain(beyond);
    // ③ 而真正不存在的路径仍然要进 missing —— 防止「missing 恒空」的坏实现蒙混。
    expect(scan.missing).toEqual(["真的没有这个.txt"]);
  });

  it("超出深度上限的索引文件**不许**被报成 missing", () => {
    // root/a/b/c/d.txt 是第 4 层,遍历只看得到第 3 层(见 scan.ts 的深度判据)。
    file("a/b/c/d.txt");
    file("a/b/c3.txt");

    const scan = scanWorkspace({
      root,
      indexedPaths: ["a/b/c/d.txt", "a/b/c3.txt", "a/b/none.txt"],
    });

    expect(scan.truncated).toBe(true); // c/ 没被展开 ⇒ 必须说出来
    expect(paths(scan)).not.toContain("a/b/c/d.txt"); // 它真的在遍历之外
    expect(paths(scan)).toContain("a/b/c3.txt");
    expect(paths(scan)).toContain("a/b/c/");
    expect(scan.indexed.map((e) => e.path)).toEqual(["a/b/c3.txt"]);
    expect(scan.missing).toEqual(["a/b/none.txt"]); // d.txt 在盘上,不许出现
  });

  it("索引里的逃逸路径(`../x`)**算盘上没有**,不去 stat 根外", () => {
    // 根外真的存在一个文件 —— 若实现去 stat 它,它会「存在」,于是工作区读面
    // 会对一条不属于工作区的路径说「盘上有」。
    writeFileSync(join(root, "..", "outside-for-scan.txt"), "在外面", "utf8");
    try {
      const scan = scanWorkspace({ root, indexedPaths: ["../outside-for-scan.txt"] });
      expect(scan.runtime).toBe("ok");
      expect(scan.missing).toEqual(["../outside-for-scan.txt"]);
    } finally {
      rmSync(join(root, "..", "outside-for-scan.txt"), { force: true });
    }
  });

  it("断链的符号链接不被自相矛盾地报成 missing(它确实列在 entries 里)", () => {
    symlinkSync(join(root, "根本没有这个目标"), join(root, "broken.txt"));
    const scan = scanWorkspace({ root, indexedPaths: ["broken.txt"] });
    expect(scan.runtime).toBe("ok");
    expect(paths(scan)).toContain("broken.txt");
    expect(scan.missing).toEqual([]);
    expect(scan.indexed.map((e) => e.path)).toEqual(["broken.txt"]);
  });
});

describe("scanWorkspace · 读不到不是空目录", () => {
  it("根不存在 ⇒ unavailable + problem + entries 空,且不做对账", () => {
    const missingRoot = join(root, "nope");
    const scan = scanWorkspace({ root: missingRoot, indexedPaths: ["a.txt"] });
    expect(scan.runtime).toBe("unavailable");
    expect(scan.problem).toBeTruthy();
    expect(scan.problem).toContain(missingRoot); // problem 必须指到具体路径
    expect(scan.entries).toEqual([]);
    expect(scan.truncated).toBe(false);
    // ③ 读不到就不做对账 —— 否则「读不到」被说成「库里的文件全没了」,是更重的谎
    expect(scan.missing).toEqual([]);
  });

  it("根是一个文件(不是目录)⇒ unavailable,不是「空目录」", () => {
    const asFile = join(root, "not-a-dir");
    writeFileSync(asFile, "我不是目录", "utf8");
    const scan = scanWorkspace({ root: asFile, indexedPaths: [] });
    expect(scan.runtime).toBe("unavailable");
    expect(scan.problem).toBeTruthy();
    expect(scan.entries).toEqual([]);
  });
});

describe("scanWorkspace · 截断必须说出来", () => {
  it("未到任何上限 ⇒ truncated 为 false(负样本)", () => {
    for (let i = 0; i < 20; i++) file(`f${i}.txt`);
    file("a/b/c.txt"); // 第 3 层正好在上限之内(文件不展开,不受深度上限影响)
    const scan = scanWorkspace({ root, indexedPaths: [] });
    expect(scan.truncated).toBe(false);
    expect(paths(scan)).toContain("a/b/c.txt");
    expect(WORKSPACE_MAX_DEPTH).toBe(3);
  });

  it("条数到界 ⇒ truncated true 且不静默超列", () => {
    for (let i = 0; i < WORKSPACE_MAX_ENTRIES + 5; i++) file(`g${i}.txt`);
    const scan = scanWorkspace({ root, indexedPaths: [] });
    expect(scan.truncated).toBe(true);
    expect(scan.entries).toHaveLength(WORKSPACE_MAX_ENTRIES);
  });

  it("深度到界的目录**本身**要列出来(它下面有内容 ⇒ 截断)", () => {
    // root/x/y/z/w.txt:z 是第 3 层目录,不展开;w.txt 永远列不出来。
    file("x/y/z/w.txt");
    const scan = scanWorkspace({ root, indexedPaths: [] });
    expect(scan.truncated).toBe(true);
    expect(paths(scan)).toEqual(["x/", "x/y/", "x/y/z/"]);
  });
});

describe("normalizeWorkspacePath", () => {
  it("正样本:三种写法归一成同一个相对路径", () => {
    expect(normalizeWorkspacePath("artifacts/a.html")).toBe("artifacts/a.html");
    expect(normalizeWorkspacePath("./artifacts/a.html")).toBe("artifacts/a.html");
    expect(normalizeWorkspacePath("/artifacts/a.html")).toBe("artifacts/a.html");
    expect(normalizeWorkspacePath("artifacts\\a.html")).toBe("artifacts/a.html");
  });

  it("负样本:不做 `..` 折叠、不做 slug 猜测 —— 不是它的职责", () => {
    expect(normalizeWorkspacePath("../a.html")).toBe("../a.html");
    expect(normalizeWorkspacePath("a.html ")).toBe("a.html ");
  });
});
