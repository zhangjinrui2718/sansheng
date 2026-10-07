/**
 * 工作区端口(`WorkspacePort` 真实现)· 判据测试
 *
 * ── 这个文件盯的是什么 ──────────────────────────────────────────────
 *
 * 端口契约(`src/platform/workspace/port.ts`)里每一句「必须/不许」在这里都有一条
 * 对应的**正样本 + 负样本**。只测一个方向的检查会全绿:一个「什么都拒」的实现
 * 能满足所有负样本,一个「什么都放行」的实现能满足所有正样本。
 *
 *   ① **路径逃逸必须被拒。** `../escape`、绝对路径、指向根外的符号链接;
 *      而根内的正常路径、指向根内的符号链接**必须通过**。
 *   ② **原子写**:写完之后内容 / sha256 / 字节数对得上,且目录里不留 `.tmp`。
 *   ③ **`ok:false` 不抛异常**:读不到、写不到、提交失败全部走返回值。
 *   ④ **`initRepo` 幂等**:跑两遍不重置、不覆盖人工文件,只补缺的。
 *   ⑤ **`commit` 无变更不产生空提交**;有变更时 sha 与 author 都对。
 *   ⑥ **闸门不静默**:秘密(`.env` / `*.key` / `*.pem` / `secrets/`)与超大文件
 *      **不进提交**且在 `excluded` 里逐条列出(含被 `.gitignore` 忽略的秘密 ——
 *      它们连候选都不是,只扫候选的话会彻底不出现)。
 *   ⑦ **`show` 按 sha 可寻址**:文件被改、被删之后历史版本仍读得出来。
 *   ⑧ **撞 `index.lock` 退避重试**,用尽才可见地失败。
 *
 * 全部只碰 `mkdtemp` 出来的临时目录(`root` 与 `outside` 各一个),绝不碰 HOME /
 * `~/.sansheng/`。真 git 真跑 —— 桩掉 git 等于把被测对象换成测试自己写的东西。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitWorkspace, PLATFORM_AUTHOR, unavailableWorkspace, WORKSPACE_MAX_FILE_BYTES,
} from "../../src/platform/workspace/git.js";
import type { WorkspacePort } from "../../src/platform/workspace/port.js";

const AUTHOR = "业务经理 <bm@sansheng.local>";

const GITIGNORE = [
  "# 秘密:永不提交,并在提交时告警",
  ".env",
  "secrets/",
  "",
  "# 平台暂存",
  ".platform-tmp/",
  "",
].join("\n");
const README = "# 示例项目\n\n目标是验证工作区端口。\n";

let root = "";
let outside = "";
let port: WorkspacePort;

/** 测试自己的 git(与实现分开的一条通道)——查看结果用它,不用被测代码自述。 */
function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();
}

function lsFiles(dir: string): string[] {
  return git(dir, "ls-files").split("\n").filter((s) => s !== "");
}

function headOf(dir: string): string {
  return git(dir, "rev-parse", "HEAD");
}

/** 在一个空目录里建好仓(所有 commit 用例的共同起点)。 */
function initWithRepo(target: string, p: WorkspacePort = port): void {
  const r = p.initRepo({ root: target, gitignore: GITIGNORE, readme: README });
  if (!r.ok) throw new Error(`initRepo 失败:${r.problem}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ss-ws-git-"));
  outside = mkdtempSync(join(tmpdir(), "ss-ws-out-"));
  port = createGitWorkspace();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveInside · 包含性(realpath 之后判)", () => {
  it("正样本:根内的相对路径通过,abs 与归一化后的 path 都对", () => {
    const r = port.resolveInside({ root, path: "artifacts/x.html" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.abs).toBe(join(root, "artifacts/x.html"));
    expect(r.value.path).toBe("artifacts/x.html");
  });

  it("正样本:`./` 前缀归一化,目标还不存在也能解析(原子写要用)", () => {
    const r = port.resolveInside({ root, path: "./artifacts/deep/还没写.md" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toBe("artifacts/deep/还没写.md");
    expect(existsSync(r.value.abs)).toBe(false);
  });

  it("负样本:`../escape` 被拒 —— 一次工具调用不许写盘上任意位置", () => {
    const r = port.resolveInside({ root, path: "../escape.txt" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem).toContain("之外");
  });

  it("负样本:绕一圈的 `a/../../escape` 同样被拒", () => {
    const r = port.resolveInside({ root, path: "a/../../escape.txt" });
    expect(r.ok).toBe(false);
  });

  it("负样本:绝对路径被拒(契约:path 一律是项目根相对路径)", () => {
    expect(port.resolveInside({ root, path: "/etc/hosts" }).ok).toBe(false);
    expect(port.resolveInside({ root, path: join(root, "a.txt") }).ok).toBe(false);
  });

  it("负样本:空串被拒(空路径不是「根」)", () => {
    expect(port.resolveInside({ root, path: "" }).ok).toBe(false);
    expect(port.resolveInside({ root, path: "   " }).ok).toBe(false);
  });

  it("负样本:指向根外的符号链接被拒,而且真的没写出去", () => {
    symlinkSync(outside, join(root, "link-out"));
    const r = port.resolveInside({ root, path: "link-out/evil.txt" });
    expect(r.ok).toBe(false);
    const w = port.writeAtomic({ root, path: "link-out/evil.txt", content: "逃逸" });
    expect(w.ok).toBe(false);
    expect(existsSync(join(outside, "evil.txt"))).toBe(false);
  });

  it("正样本:指向根**内**的符号链接正常通过(不是把所有链接都当逃逸)", () => {
    mkdirSync(join(root, "real"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "alias"));
    const w = port.writeAtomic({ root, path: "alias/a.txt", content: "经别名写入" });
    expect(w.ok).toBe(true);
    expect(readFileSync(join(root, "real", "a.txt"), "utf8")).toBe("经别名写入");
    const rd = port.read({ root, path: "alias/a.txt" });
    expect(rd.ok).toBe(true);
    if (rd.ok) expect(rd.value).toBe("经别名写入");
  });
});

describe("writeAtomic / read / stat", () => {
  it("正样本:写完盘上内容一致,sha256 与 bytes 对得上,且不留临时文件", () => {
    const content = "<h1>技术方案</h1>\n中文正文\n";
    const w = port.writeAtomic({ root, path: "artifacts/report.html", content });
    expect(w.ok).toBe(true);
    if (!w.ok) return;

    expect(readFileSync(join(root, "artifacts/report.html"), "utf8")).toBe(content);
    expect(w.value.path).toBe("artifacts/report.html");
    expect(w.value.sha256).toBe(
      createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"),
    );
    expect(w.value.bytes).toBe(Buffer.byteLength(content, "utf8"));
    // 临时文件必须已经被 rename 掉 —— 留一个 .tmp 就是一次「读到半个文件」的入口
    expect(readdirSync(join(root, "artifacts")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("正样本:父目录按需建", () => {
    const w = port.writeAtomic({ root, path: "a/b/c/d.md", content: "深" });
    expect(w.ok).toBe(true);
    expect(existsSync(join(root, "a/b/c/d.md"))).toBe(true);
  });

  it("正样本:read 现读工作树内容;stat 给出真的 Stats", () => {
    port.writeAtomic({ root, path: "x.txt", content: "hello" });
    const rd = port.read({ root, path: "x.txt" });
    expect(rd.ok).toBe(true);
    if (rd.ok) expect(rd.value).toBe("hello");
    const st = port.stat({ root, path: "x.txt" });
    expect(st.ok).toBe(true);
    if (st.ok) {
      expect(st.value.isFile()).toBe(true);
      expect(st.value.size).toBe(5);
    }
  });

  it("负样本:read / stat 读不到时是 ok:false(不是空内容、不是 0 字节)", () => {
    const rd = port.read({ root, path: "没有这个.md" });
    expect(rd.ok).toBe(false);
    if (!rd.ok) expect(rd.problem).toContain("读不到");
    expect(port.stat({ root, path: "没有这个.md" }).ok).toBe(false);
  });

  it("负样本:read 一个目录被拒(目录没有正文可读)", () => {
    mkdirSync(join(root, "adir"), { recursive: true });
    const rd = port.read({ root, path: "adir" });
    expect(rd.ok).toBe(false);
    if (!rd.ok) expect(rd.problem).toContain("目录");
  });

  it("sha256 与已知向量一致,且不同内容给不同哈希(双向)", () => {
    expect(port.sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(port.sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(port.sha256("abc")).not.toBe(port.sha256("abd"));
  });

  it("单文件上限的缺省值是 10 MB(设计 §3.3 第 2 条)", () => {
    expect(WORKSPACE_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("initRepo · 幂等", () => {
  it("正样本:建目录 + 建仓 + 写两个文件 + 首次提交(author 是平台)", () => {
    const proj = join(root, "proj");
    const r = port.initRepo({ root: proj, gitignore: GITIGNORE, readme: README });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.created).toBe(true);
    expect(r.value.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(proj, ".git"))).toBe(true);
    expect(readFileSync(join(proj, ".gitignore"), "utf8")).toBe(GITIGNORE);
    expect(readFileSync(join(proj, "README.md"), "utf8")).toBe(README);
    expect(lsFiles(proj).sort()).toEqual([".gitignore", "README.md"]);
    expect(git(proj, "log", "-1", "--format=%an <%ae>")).toBe(PLATFORM_AUTHOR);
    expect(git(proj, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("正样本:跑第二遍(没有任何变更)不重置、不产生新提交", () => {
    const proj = join(root, "proj");
    initWithRepo(proj);
    const before = headOf(proj);

    const again = port.initRepo({ root: proj, gitignore: GITIGNORE, readme: README });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.created).toBe(false);
    expect(again.value.sha).toBe(before);
    expect(headOf(proj)).toBe(before);
    expect(git(proj, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("正样本:不覆盖人工改过的 README(只补缺,不重置)", () => {
    const proj = join(root, "proj");
    initWithRepo(proj);
    const first = headOf(proj);

    // 人工写的说明(平台**不许**覆盖它)
    writeFileSync(join(proj, "README.md"), "# 人工改过的说明\n", "utf8");

    const again = port.initRepo({ root: proj, gitignore: GITIGNORE, readme: README });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.created).toBe(false);
    expect(readFileSync(join(proj, "README.md"), "utf8")).toBe("# 人工改过的说明\n");
    // 仓库没被重置:第一条提交还在,新的 HEAD 是它的子孙(不是重来一遍)
    expect(git(proj, "rev-list", "--count", "HEAD")).toBe("2");
    expect(() => git(proj, "merge-base", "--is-ancestor", first, "HEAD")).not.toThrow();
  });

  it("正样本:只补缺的文件 —— 删掉 README 之后它会回来", () => {
    const proj = join(root, "proj");
    initWithRepo(proj);
    rmSync(join(proj, "README.md"));
    const again = port.initRepo({ root: proj, gitignore: GITIGNORE, readme: README });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.created).toBe(false);
    expect(readFileSync(join(proj, "README.md"), "utf8")).toBe(README);
    expect(lsFiles(proj)).toContain("README.md");
  });

  it("正样本:目录里已经有文件时,首次提交把它们一起收进去", () => {
    const proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "already.txt"), "早就有了\n", "utf8");
    const r = port.initRepo({ root: proj, gitignore: GITIGNORE, readme: README });
    expect(r.ok).toBe(true);
    expect(lsFiles(proj).sort()).toEqual([".gitignore", "README.md", "already.txt"]);
  });
});

describe("commit · 闸门与可见性", () => {
  it("负样本:不是仓库 ⇒ ok:false,且说得出该怎么办", () => {
    mkdirSync(join(root, "plain"), { recursive: true });
    const r = port.commit({ root: join(root, "plain"), author: AUTHOR, message: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("不是一个 git 仓库");
  });

  it("负样本:工作区根是父仓的子目录 ⇒ 拒绝(不许把区外改动提进父仓)", () => {
    initWithRepo(root);
    const sub = join(root, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "a.txt"), "x", "utf8");
    const r = port.commit({ root: sub, author: AUTHOR, message: "越界提交" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("不是仓库根");
    expect(lsFiles(root)).not.toContain("sub/a.txt");
  });

  it("负样本:author 形状不对 ⇒ 拒绝(不猜、不补)", () => {
    initWithRepo(root);
    for (const bad of ["业务经理", "业务经理 bm@sansheng.local", "<>", ""]) {
      const r = port.commit({ root, author: bad, message: "x" });
      expect(r.ok).toBe(false);
    }
  });

  it("负样本:空提交说明 ⇒ 拒绝(现场不能是空的)", () => {
    initWithRepo(root);
    expect(port.commit({ root, author: AUTHOR, message: "   " }).ok).toBe(false);
  });

  it("正样本:无变更 ⇒ committed:false,sha 是当前 HEAD(不产生空提交)", () => {
    initWithRepo(root);
    const head = headOf(root);
    const r = port.commit({ root, author: AUTHOR, message: "什么都没改" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.committed).toBe(false);
    expect(r.value.sha).toBe(head);
    expect(r.value.excluded).toEqual([]);
    expect(headOf(root)).toBe(head);
  });

  it("正样本:有变更 ⇒ committed:true,sha 变了,author 是传进去的角色", () => {
    initWithRepo(root);
    const before = headOf(root);
    writeFileSync(join(root, "code.ts"), "export const a = 1;\n", "utf8");
    const r = port.commit({ root, author: AUTHOR, message: "编码工交付" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.committed).toBe(true);
    expect(r.value.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.value.sha).not.toBe(before);
    expect(r.value.sha).toBe(headOf(root));
    expect(lsFiles(root)).toContain("code.ts");
    // 设计 §3.1:author 是角色,committer 是平台 —— 用测试自己的 git 读事实
    expect(git(root, "log", "-1", "--format=%an <%ae>|%cn")).toBe(
      "业务经理 <bm@sansheng.local>|三生平台",
    );
    expect(git(root, "log", "-1", "--format=%s")).toBe("编码工交付");
  });

  it("正样本 + 负样本:秘密不进提交、逐条可见;`.gitignore` 漏掉的秘密由闸门兜住", () => {
    // ⚠️ 这份 .gitignore **故意只列 .env 与 secrets/**:于是 server.key / ca.pem
    // 会真的成为 `git add -A` 的候选 —— 闸门必须自己把它们挡住并退出暂存区。
    // 如果只测被忽略的秘密,这条路径永远走不到(候选里根本没有它们)。
    const narrow = "# 秘密\n.env\nsecrets/\n";
    const init = port.initRepo({ root, gitignore: narrow, readme: README });
    expect(init.ok).toBe(true);

    writeFileSync(join(root, ".env"), "TOKEN=abcdef\n", "utf8");
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets/token.txt"), "s3cr3t\n", "utf8");
    writeFileSync(join(root, "server.key"), "-----BEGIN KEY-----\n", "utf8");
    mkdirSync(join(root, "certs"), { recursive: true });
    writeFileSync(join(root, "certs/ca.pem"), "-----BEGIN CERT-----\n", "utf8");
    // 负样本:长得像秘密但**不该**被挡的普通文件
    writeFileSync(join(root, ".envrc"), "export A=1\n", "utf8");
    writeFileSync(join(root, "notes.md"), "# 说明\n", "utf8");

    const r = port.commit({ root, author: AUTHOR, message: "写工件" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const excludedPaths = r.value.excluded.map((e) => e.path).sort();
    // `secrets/` 整目录被 .gitignore 忽略 ⇒ `git status --ignored` 折叠成一条
    // 目录记录(设计如此:`node_modules` 那种量级不可能逐文件展开)。
    expect(excludedPaths).toEqual([".env", "certs/ca.pem", "secrets", "server.key"]);
    for (const e of r.value.excluded) {
      expect(e.reason).toBe("secret");
      expect(e.detail).not.toBe("");
    }
    const secretsEntry = r.value.excluded.find((e) => e.path === "secrets");
    expect(secretsEntry?.detail).toContain("secrets/");
    expect(secretsEntry?.detail).toContain(".gitignore");
    // 秘密没有被写进版本库,正常文件进去了
    const tracked = lsFiles(root);
    for (const p of excludedPaths) expect(tracked).not.toContain(p);
    expect(tracked).toContain(".envrc");
    expect(tracked).toContain("notes.md");
    // 提交内容里也没有它们
    const inCommit = git(root, "show", "--name-only", "--format=", "HEAD").split("\n");
    for (const p of excludedPaths) expect(inCommit).not.toContain(p);
    // 暂存区干净(被挡的文件真的退出去了,不是「加进去又提交了」)
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
    // 现场仍然可见:未被忽略的秘密是 untracked(不是消失)
    expect(git(root, "status", "--porcelain")).toContain("?? server.key");
  });

  it("正样本 + 负样本:超大文件不进提交、进 excluded,且每次提交都看得见", () => {
    const small = createGitWorkspace({ maxFileBytes: 1024 });
    initWithRepo(root, small);
    writeFileSync(join(root, "small.txt"), "小文件\n", "utf8");
    writeFileSync(join(root, "big.bin"), "x".repeat(2048), "utf8");

    const first = small.commit({ root, author: AUTHOR, message: "带一个大文件" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.committed).toBe(true);
    expect(first.value.excluded).toHaveLength(1);
    expect(first.value.excluded[0]?.path).toBe("big.bin");
    expect(first.value.excluded[0]?.reason).toBe("oversized");
    expect(first.value.excluded[0]?.detail).toContain("超过单文件上限");
    expect(lsFiles(root)).toContain("small.txt");
    expect(lsFiles(root)).not.toContain("big.bin");
    // 没纳入的东西要看得见:它还是 untracked,而不是被静默吞掉
    expect(git(root, "status", "--porcelain")).toContain("?? big.bin");
    expect(statSync(join(root, "big.bin")).size).toBe(2048);

    // 第二次:没有别的变更 ⇒ committed:false,但 big.bin **仍然**在 excluded 里
    const second = small.commit({ root, author: AUTHOR, message: "再试一次" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.committed).toBe(false);
    expect(second.value.excluded.map((e) => e.path)).toEqual(["big.bin"]);
  });

  it("正样本:撞 index.lock ⇒ 退避重试之后成功(不是直接失败)", () => {
    const slept: number[] = [];
    const retrying = createGitWorkspace({
      lockRetries: 3,
      sleep: (ms) => {
        slept.push(ms);
        rmSync(join(root, ".git", "index.lock"), { force: true }); // 另一个角色提交完了
      },
    });
    initWithRepo(root, retrying);
    writeFileSync(join(root, "code.ts"), "v1\n", "utf8");
    writeFileSync(join(root, ".git", "index.lock"), "", "utf8"); // 假装另一个回合正在提交

    const r = retrying.commit({ root, author: AUTHOR, message: "重试后成功" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.committed).toBe(true);
    expect(slept).toHaveLength(1); // 退避了一次,第二次就成了
    expect(lsFiles(root)).toContain("code.ts");
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
  });

  it("负样本:锁一直在 ⇒ 重试用尽后**可见地**失败,改动没被提交", () => {
    const slept: number[] = [];
    const retrying = createGitWorkspace({
      lockRetries: 3,
      sleep: (ms) => {
        slept.push(ms);
      }, // 锁一直不动
    });
    initWithRepo(root, retrying);
    const head = headOf(root);
    writeFileSync(join(root, "code.ts"), "v1\n", "utf8");
    writeFileSync(join(root, ".git", "index.lock"), "", "utf8");

    const r = retrying.commit({ root, author: AUTHOR, message: "注定失败" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem).toContain("index.lock");
    expect(r.problem).toContain("退避重试 3 次");
    expect(slept).toHaveLength(3); // 首次失败 + 3 次退避 = 4 次尝试
    expect(headOf(root)).toBe(head);
    expect(lsFiles(root)).not.toContain("code.ts");
  });
});

describe("show · 按 sha 可寻址", () => {
  it("正样本:文件改过、删掉之后,旧提交里的版本仍然读得出来", () => {
    initWithRepo(root);
    const v1 = "第一版正文\n";
    const v2 = "第二版正文\n";

    expect(port.writeAtomic({ root, path: "artifacts/a.md", content: v1 }).ok).toBe(true);
    const c1 = port.commit({ root, author: AUTHOR, message: "v1" });
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    expect(c1.value.sha).not.toBeNull();
    const sha1 = c1.value.sha ?? "";

    expect(port.writeAtomic({ root, path: "artifacts/a.md", content: v2 }).ok).toBe(true);
    const c2 = port.commit({ root, author: AUTHOR, message: "v2" });
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    const sha2 = c2.value.sha ?? "";

    const readNow = port.read({ root, path: "artifacts/a.md" });
    expect(readNow.ok && readNow.value).toBe(v2);
    const old = port.show({ root, sha: sha1, path: "artifacts/a.md" });
    expect(old.ok).toBe(true);
    if (old.ok) expect(old.value).toBe(v1); // 与当前版本**不同**才有意义
    const now = port.show({ root, sha: sha2, path: "artifacts/a.md" });
    expect(now.ok && now.value).toBe(v2);

    // 删掉工作树里的文件:read 读不到,但历史版本仍然在
    rmSync(join(root, "artifacts/a.md"));
    const readGone = port.read({ root, path: "artifacts/a.md" });
    expect(readGone.ok).toBe(false); // 读不到 ≠ 空正文
    const fromHistory = port.show({ root, sha: sha1, path: "artifacts/a.md" });
    expect(fromHistory.ok).toBe(true);
    if (fromHistory.ok) expect(fromHistory.value).toBe(v1);
  });

  it("负样本:sha 不可达 / 该提交里没有这条路径 / sha 形状不对 ⇒ 都是 ok:false", () => {
    initWithRepo(root);
    port.writeAtomic({ root, path: "a.md", content: "a\n" });
    const c = port.commit({ root, author: AUTHOR, message: "a" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const sha = c.value.sha ?? "";

    const unreachable = port.show({ root, sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", path: "a.md" });
    expect(unreachable.ok).toBe(false);
    const absent = port.show({ root, sha, path: "没有这个.md" });
    expect(absent.ok).toBe(false);
    const badShape = port.show({ root, sha: "not-a-sha", path: "a.md" });
    expect(badShape.ok).toBe(false);
    if (!badShape.ok) expect(badShape.problem).toContain("十六进制");
    // 逃逸路径同样拦住(show 不走另一套判据)
    expect(port.show({ root, sha, path: "../outside.txt" }).ok).toBe(false);
  });
});

describe("unavailableWorkspace · 没接端口时不许静默放行", () => {
  it("每个方法都 ok:false 且带同一句 problem;sha256 仍能算", () => {
    const p = unavailableWorkspace("这次装配没有工作区端口");
    expect(p.read({ root, path: "a" }).ok).toBe(false);
    expect(p.writeAtomic({ root, path: "a", content: "x" }).ok).toBe(false);
    expect(p.resolveInside({ root, path: "a" }).ok).toBe(false);
    expect(p.stat({ root, path: "a" }).ok).toBe(false);
    expect(p.show({ root, sha: "abc", path: "a" }).ok).toBe(false);
    expect(p.initRepo({ root, gitignore: "", readme: "" }).ok).toBe(false);
    expect(p.commit({ root, author: AUTHOR, message: "x" }).ok).toBe(false);
    const w = p.writeAtomic({ root, path: "a", content: "x" });
    if (!w.ok) expect(w.problem).toBe("这次装配没有工作区端口");
    expect(p.sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
