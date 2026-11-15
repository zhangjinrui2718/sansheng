/**
 * harness 目录 git 化(vcs.ts)· 测试(2026-11-15)
 *
 * 三个跑批验证了动机(交付说明的「未做清单」有痕迹、性能/失焦 0 次讨论),
 * 但这些都依赖 **harness 目录的历史可回溯** —— vcs.ts 把它做成了 git 仓库。
 *
 * 这里钉住四件事:
 *   · init 幂等(两次 ensureRepo 不炸)+ .gitignore 排除 backups/;
 *   · commit 幂等(无变更 = committed:false,不发空提交)+ sha 可用;
 *   · history 记录触碰文件,可按 path 过滤;
 *   · showAt / restoreFrom 的往返(读旧版 → 回滚 → 内容回到旧版 → 再 commit)。
 *
 * 纪律:git 不可用/失败不抛 —— 专门有一条负样本验证「失败走返回值」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRepo,
  commitAll,
  history,
  showAt,
  restoreFrom,
  isInsideHarnessDir,
} from "../../src/platform/harness/vcs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ss-harness-vcs-"));
  mkdirSync(join(dir, "system_prompts"), { recursive: true });
  writeFileSync(join(dir, "system_prompts", "demo.core.md"), "第零版", "utf8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("harness vcs · git 化历史", () => {
  it("① ensureRepo 幂等:两次调用不炸;.gitignore 排除 backups/", () => {
    const a = ensureRepo(dir);
    expect(a.ok).toBe(true);
    const b = ensureRepo(dir);
    expect(b.ok).toBe(true);
    expect(b.created).toBe(false);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("backups/");
  });

  it("② commit 幂等:无变更 = committed:false,不发空提交", () => {
    ensureRepo(dir);
    const first = commitAll(dir, "seed");
    expect(first.committed).toBe(true);
    const again = commitAll(dir, "seed 第二次");
    expect(again.committed).toBe(false);
  });

  it("③ 保存 → commit → 修改 → commit ⇒ history 两条,且 files 记录了触碰的文件", () => {
    ensureRepo(dir);
    writeFileSync(join(dir, "system_prompts", "demo.core.md"), "第一版", "utf8");
    expect(commitAll(dir, "prompt: 保存 demo.core 第一版").committed).toBe(true);
    writeFileSync(join(dir, "system_prompts", "demo.core.md"), "第二版", "utf8");
    expect(commitAll(dir, "prompt: 保存 demo.core 第二版").committed).toBe(true);

    const h = history(dir);
    expect(h.ok).toBe(true);
    expect(h.entries.length).toBeGreaterThanOrEqual(2);
    expect(h.entries[0]!.message).toContain("第二版");
    expect(h.entries[0]!.files).toContain("system_prompts/demo.core.md");
  });

  it("④ history 按 path 过滤:只看触到该文件的提交", () => {
    ensureRepo(dir);
    writeFileSync(join(dir, "system_prompts", "a.md"), "a1", "utf8");
    commitAll(dir, "a 第一版");
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "tools", "demo.json"), "{}", "utf8");
    commitAll(dir, "工具面(与 a 无关)");
    const h = history(dir, { relPath: "system_prompts/a.md" });
    expect(h.entries.length).toBe(1);
    expect(h.entries[0]!.message).toContain("a 第一版");
  });

  it("⑤ showAt:读指定提交里的旧内容;restoreFrom 回滚后再 commit,内容与旧版一致", () => {
    ensureRepo(dir);
    writeFileSync(join(dir, "system_prompts", "demo.core.md"), "旧版正文", "utf8");
    expect(commitAll(dir, "旧版").committed).toBe(true);
    const entries = history(dir, { relPath: "system_prompts/demo.core.md" }).entries;
    const oldSha = entries[0]!.sha;

    writeFileSync(join(dir, "system_prompts", "demo.core.md"), "新版正文", "utf8");
    expect(commitAll(dir, "新版").committed).toBe(true);

    const show = showAt(dir, oldSha, "system_prompts/demo.core.md");
    expect(show.ok).toBe(true);
    expect(show.content).toBe("旧版正文");

    const restore = restoreFrom(dir, oldSha, "system_prompts/demo.core.md");
    expect(restore.ok).toBe(true);
    expect(restore.content).toBe("旧版正文");
    expect(readFileSync(join(dir, "system_prompts", "demo.core.md"), "utf8")).toBe("旧版正文");

    // 回滚本身也成为一条历史(可再回滚 = 「回滚可回滚」)
    expect(commitAll(dir, "回滚到旧版").committed).toBe(true);
  });

  it("⑥ 路径穿越被拒(isInsideHarnessDir)", () => {
    expect(isInsideHarnessDir(dir, "system_prompts/demo.core.md")).toBe(true);
    expect(isInsideHarnessDir(dir, "../outside.md")).toBe(false);
    expect(isInsideHarnessDir(dir, "/etc/passwd")).toBe(false);
    const r = restoreFrom(dir, "deadbeef", "../outside.md");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("越界");
  });

  it("⑦ git 失败走返回值不抛(show 一个不存在的 sha)", () => {
    ensureRepo(dir);
    const r = showAt(dir, "0000000000000000000000000000000000000000", "system_prompts/x.md");
    expect(r.ok).toBe(false);
    expect(r.detail).toBeTruthy();
  });
});
