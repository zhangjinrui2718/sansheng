/**
 * Sansheng · A5 回归测试:fs sandbox 写路径 symlink 逃逸
 *
 * 来源:docs/CODE-REVIEW-2026-10-01.md §A5(实证 PWNED-A / PWNED-B)。
 *
 * 缺陷形态(修复前):
 *  - resolveForWrite 只做词法 matchAllow(parent),parent 是 symlink 指向外部时
 *    词法前缀仍在 allowlist 内 → 写穿成功(PWNED-A);
 *  - 最终组件的 symlink 检查用 fsStat(follows symlink)→ isSymbolicLink() 恒
 *    false,死代码(PWNED-B,fs.ts:129 的 lstat 补救只覆盖 writeFile 工具层,
 *    resolveForWrite 本体仍放行);
 *  - canvas 目录固定名落在世界可写的 /tmp(经典 /tmp race 预埋 symlink 面)。
 *
 * 覆盖:
 *  ① allowlist 内 symlink 父目录 → writeFile 必抛 symlink_escape 且外部无落盘
 *  ①b createDirs:true 同样必抛,且不在外部创建中间目录
 *  ② 最终组件是 symlink → resolveForWrite 必抛(修复 fsStat 死代码)
 *  ③ 正常写 / 正常 createDirs / 覆盖已有文件不受影响(防误杀)
 *  ④ macOS 合法 symlink 根(/tmp → /private/tmp、os.tmpdir() 的 /var/folders →
 *     /private/var/folders)下的 dataDir 写不误杀(real-vs-real,读路径同款)
 *  ⑤ canvas 加固:默认 policy canvas 迁到 <homedir>/.sansheng/canvas,
 *     newCanvasDir 用 mkdtemp 随机后缀,两次调用目录不同
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile as nodeWriteFile,
  readFile as nodeReadFile,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sandbox, SandboxError } from "../../src/server/tools/sandbox.js";
import { writeFile, readFile } from "../../src/server/tools/fs.js";

let base: string;
let workspace: string;
let outside: string;
let sandbox: Sandbox;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "sansheng-a5-escape-"));
  workspace = join(base, "ws");
  outside = join(base, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  sandbox = new Sandbox({
    policy: { allowlist: [{ path: workspace, kind: "dir" }], maxBytes: 1024 },
    homedir: base,
    tmpdir: base,
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("A5 · sandbox 写路径 symlink 逃逸回归", () => {
  it("① allowlist 内 symlink 父目录指向外部 → writeFile 必抛 symlink_escape(PWNED-A)", async () => {
    const evilDir = join(workspace, "evil-dir");
    await symlink(outside, evilDir); // ln -s <外部目录> <allowlist 内>
    const target = join(evilDir, "pwned.txt");
    const outsideFile = join(outside, "pwned.txt");

    let caught: unknown;
    let writeSucceeded = false;
    try {
      await writeFile(sandbox, target, "PWNED-A");
      writeSucceeded = true;
    } catch (e) {
      caught = e;
    }
    // RED(修复前):writeSucceeded=true 且 outsideFile 已被创建 — 沙箱外写穿。
    expect(
      writeSucceeded,
      `PWNED-A: 写穿成功,实际落盘 ${outsideFile}(realpath ${realpathSync(outside)}/pwned.txt)`,
    ).toBe(false);
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("symlink_escape");
    expect(existsSync(outsideFile)).toBe(false);
  });

  it("①b createDirs:true 经 symlink 父目录 → 必抛且不在外部创建中间目录", async () => {
    const evilDir = join(workspace, "evil-dir");
    if (!existsSync(evilDir)) await symlink(outside, evilDir);
    const target = join(evilDir, "deep", "nested", "pwned.txt");

    let caught: unknown;
    let resolved: string | null = null;
    try {
      resolved = await sandbox.resolveForWrite(target, 1, { createDirs: true });
    } catch (e) {
      caught = e;
    }
    expect(resolved, `PWNED-A(createDirs): resolveForWrite 放行了 ${target}`).toBeNull();
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("symlink_escape");
    expect(existsSync(join(outside, "deep"))).toBe(false);
  });

  it("② 最终组件是 symlink → resolveForWrite 必抛(修复 fsStat 死代码,PWNED-B)", async () => {
    const outsideFile = join(outside, "secret.txt");
    await nodeWriteFile(outsideFile, "SECRET", "utf8");
    const link = join(workspace, "link-to-secret.txt");
    await symlink(outsideFile, link);

    let caught: unknown;
    let resolved: string | null = null;
    try {
      resolved = await sandbox.resolveForWrite(link, 5);
    } catch (e) {
      caught = e;
    }
    // RED(修复前):resolved = link 路径("resolveForWrite passed final symlink")。
    expect(resolved, `PWNED-B: resolveForWrite 放行了最终 symlink ${link}`).toBeNull();
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("symlink_escape");

    // 工具层 writeFile 同样拒绝(fs.ts lstat 补救保持),且外部目标内容不被覆盖
    let caught2: unknown;
    try {
      await writeFile(sandbox, link, "XXXXX");
    } catch (e) {
      caught2 = e;
    }
    expect(caught2).toBeInstanceOf(SandboxError);
    expect((caught2 as SandboxError).code).toBe("symlink_escape");
    expect(await nodeReadFile(outsideFile, "utf8")).toBe("SECRET");
  });

  it("③ 正常写 / createDirs / 覆盖已有文件不受影响(防误杀)", async () => {
    const p = join(workspace, "normal.txt");
    const r1 = await writeFile(sandbox, p, "hello");
    expect(r1.bytesWritten).toBe(5);
    expect((await readFile(sandbox, p)).content).toBe("hello");

    // 覆盖已有正常文件
    const r2 = await writeFile(sandbox, p, "world!");
    expect(r2.bytesWritten).toBe(6);
    expect(await nodeReadFile(p, "utf8")).toBe("world!");

    // createDirs 深层新目录
    const deep = join(workspace, "a", "b", "c", "d.txt");
    const r3 = await writeFile(sandbox, deep, "x", { createDirs: true });
    expect(r3.bytesWritten).toBe(1);
    expect(await nodeReadFile(deep, "utf8")).toBe("x");

    // 正常 mkdir 后写入
    const dir = join(workspace, "plain-dir");
    await mkdir(dir, { recursive: true });
    const r4 = await writeFile(sandbox, join(dir, "f.txt"), "y");
    expect(r4.bytesWritten).toBe(1);
  });

  it("④ macOS symlink 根(/tmp、os.tmpdir())下合法目录写不误杀(real-vs-real)", async () => {
    // macOS: /tmp → /private/tmp;os.tmpdir() 通常在 /var/folders/... → /private/var/...
    // 两者都是"allowlist entry 的 raw 前缀本身经 symlink"形态 — 与生产 dataDir/
    // 测试 tmpdir 一致。读路径 resolve() 已用 real-vs-real 处理(f379c50);
    // 写路径修复后必须同样不误杀。
    for (const root of ["/tmp", tmpdir()]) {
      const b = await mkdtemp(join(root, "sansheng-a5-legit-"));
      try {
        const ws = join(b, "ws");
        await mkdir(ws, { recursive: true });
        const sb = new Sandbox({
          policy: { allowlist: [{ path: ws, kind: "dir" }], maxBytes: 1024 },
          homedir: b,
          tmpdir: b,
        });
        const p = join(ws, "legit.txt");
        const r = await writeFile(sb, p, "legit");
        expect(r.bytesWritten).toBe(5);
        expect((await readFile(sb, p)).content).toBe("legit");
        // 深层 createDirs 同样不误杀
        const deep = join(ws, "s1", "s2", "f.txt");
        await writeFile(sb, deep, "z", { createDirs: true });
        expect(await nodeReadFile(deep, "utf8")).toBe("z");
      } finally {
        await rm(b, { recursive: true, force: true });
      }
    }
  });

  it("⑤ canvas 加固:默认 policy 迁到 <homedir>/.sansheng/canvas + newCanvasDir mkdtemp 随机后缀", async () => {
    const sb = new Sandbox({ homedir: base, tmpdir: base }); // 默认 policy
    const canvasRoot = join(base, ".sansheng", "canvas");
    // 默认 allowlist 不再含 /tmp 固定名 canvas,而是数据目录下的 canvas 根
    expect(
      sb.policy.allowlist.some((e) => e.path === canvasRoot && e.kind === "dir"),
      `default allowlist should contain ${canvasRoot}: ${JSON.stringify(sb.policy.allowlist)}`,
    ).toBe(true);
    expect(sb.policy.allowlist.some((e) => e.path === join(base, "sansheng-canvas"))).toBe(false);

    const dir1 = await sb.newCanvasDir("session-abc");
    expect(dir1.startsWith(canvasRoot)).toBe(true);
    // mkdtemp 随机后缀(替代固定名,防 /tmp race 预埋)
    expect(dir1).toMatch(/sansheng-session-abc-[A-Za-z0-9]{6}$/);
    const dir2 = await sb.newCanvasDir("session-abc");
    expect(dir2).not.toBe(dir1); // 随机后缀 → 两次调用不同目录
    // 动态加入 allowlist 后可写可读
    const r = await writeFile(sb, join(dir1, "note.txt"), "ok");
    expect(r.bytesWritten).toBe(2);
    expect((await readFile(sb, join(dir1, "note.txt"))).content).toBe("ok");
  });
});
