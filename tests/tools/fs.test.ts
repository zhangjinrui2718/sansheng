/**
 * Sansheng fs tools / sandbox / registry 单元测试 · M4
 *
 * 18 cases 覆盖(超出 12 最低要求):
 *  - happy: read / write / list / stat × 4
 *  - write.createDirs(true) 创建中间目录
 *  - write 拒绝已存在目录路径 → denied_kind
 *  - sandbox 越界(workspace 外的绝对路径) → outside_allowlist
 *  - sandbox 越写(workspace 内 ../../etc/passwd) → outside_allowlist
 *  - symlink escape(workspace 内 symlink 指 /etc/passwd) → symlink_escape
 *  - too_large(写超过 maxBytes 的文件) → too_large
 *  - stat 不存在 → not_found
 *  - listDir 默认隐藏 .dotfile;includeHidden=true 包含
 *  - registry invoke / list 正常
 *  - registry 重复注册 → DuplicateToolError
 *  - registry invoke 未知名 → ToolNotFoundError
 *  - readFile encoding=base64
 *  - listDir maxEntries 截断
 *  - newCanvasDir 动态加入 allowlist
 *
 * 每个 case 用 mkdtemp 建隔离 tmpdir + 注入 Sandbox policy,不污染 ~/.sansheng/。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile as nodeWriteFile, symlink, mkdir, readFile as nodeReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  Sandbox,
  SandboxError,
  defaultPolicy,
  loadSandboxFromFile,
} from "../../src/server/tools/sandbox.js";
import {
  readFile,
  writeFile,
  listDir,
  stat,
} from "../../src/server/tools/fs.js";
import {
  ToolRegistry,
  ToolNotFoundError,
  DuplicateToolError,
} from "../../src/server/tools/registry.js";

let workspace: string;
let sandbox: Sandbox;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "sansheng-fs-test-"));
  workspace = join(base, "workspace");
  await mkdir(workspace, { recursive: true });
  sandbox = new Sandbox({
    policy: {
      allowlist: [{ path: workspace, kind: "dir" }],
      maxBytes: 1024, // 测试用小上限
    },
    homedir: base,
    tmpdir: base,
  });
  // 静默 unused warning
  void defaultPolicy;
  void loadSandboxFromFile;
});

afterAll(async () => {
  // workspace 的父目录是 mkdtemp 创建的 base,递归清掉
  // macOS 的 rmdir 拒绝尾段为 ".." 的路径(EINVAL)→ 先取 dirname 归一化
  await rm(dirname(workspace), { recursive: true, force: true });
});

describe("fs tools / sandbox (M4)", () => {
  it("1. readFile happy path", async () => {
    const p = join(workspace, "hello.txt");
    await nodeWriteFile(p, "你好世界", "utf8");
    const res = await readFile(sandbox, p);
    expect(res.content).toBe("你好世界");
    expect(typeof res.mtimeMs).toBe("number");
    expect(res.mtimeMs).toBeGreaterThan(0);
  });

  it("2. writeFile happy path", async () => {
    const p = join(workspace, "out.txt");
    const res = await writeFile(sandbox, p, "hello");
    expect(res.bytesWritten).toBe(5);
    expect(typeof res.mtimeMs).toBe("number");
    const back = await readFile(sandbox, p);
    expect(back.content).toBe("hello");
  });

  it("3. listDir happy path", async () => {
    const dir = join(workspace, "listdir");
    await mkdir(dir, { recursive: true });
    await nodeWriteFile(join(dir, "a.txt"), "a");
    await nodeWriteFile(join(dir, "b.txt"), "bb");
    await mkdir(join(dir, "sub"));
    const entries = await listDir(sandbox, dir);
    expect(entries.map((e) => e.name).sort()).toEqual(["a.txt", "b.txt", "sub"]);
    const aTxt = entries.find((e) => e.name === "a.txt");
    expect(aTxt?.kind).toBe("file");
    expect(aTxt?.size).toBe(1);
    const sub = entries.find((e) => e.name === "sub");
    expect(sub?.kind).toBe("dir");
  });

  it("4. stat happy path (file + dir)", async () => {
    const filePath = join(workspace, "stat-file.txt");
    await nodeWriteFile(filePath, "abcdef"); // 6 bytes
    const fs = await stat(sandbox, filePath);
    expect(fs.kind).toBe("file");
    expect(fs.size).toBe(6);
    expect(typeof fs.mtimeMs).toBe("number");
    const ds = await stat(sandbox, workspace);
    expect(ds.kind).toBe("dir");
    expect(ds.size).toBeGreaterThanOrEqual(0);
  });

  it("5. writeFile createDirs=true creates intermediate dirs", async () => {
    const deep = join(workspace, "deep", "nested", "file.txt");
    const res = await writeFile(sandbox, deep, "x", { createDirs: true });
    expect(res.bytesWritten).toBe(1);
    const buf = await nodeReadFile(deep, "utf8");
    expect(buf).toBe("x");
  });

  it("6. writeFile rejects when target is an existing directory", async () => {
    const dir = join(workspace, "isadir");
    await mkdir(dir, { recursive: true });
    // target 本身就是已存在的目录
    let caught: unknown;
    try {
      await writeFile(sandbox, dir, "data");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("denied_kind");
  });

  it("7. sandbox outside allowlist (absolute path /etc/passwd)", async () => {
    let caught: unknown;
    try {
      await readFile(sandbox, "/etc/passwd");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("outside_allowlist");
  });

  it("8. sandbox traversal: workspace/../../etc/passwd", async () => {
    const evil = join(workspace, "..", "..", "etc", "passwd");
    let caught: unknown;
    try {
      await readFile(sandbox, evil);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("outside_allowlist");
  });

  it("9. symlink escape: workspace symlink → /etc/passwd", async () => {
    const link = join(workspace, "evil-link.txt");
    await symlink("/etc/passwd", link);
    let caught: unknown;
    try {
      await readFile(sandbox, link);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    // passwd 存在 → realpath 解链后越界 → symlink_escape
    expect((caught as SandboxError).code).toBe("symlink_escape");
  });

  it("10. too_large: write exceeds policy maxBytes (1024)", async () => {
    const p = join(workspace, "big.txt");
    const huge = "x".repeat(2048);
    let caught: unknown;
    try {
      await writeFile(sandbox, p, huge);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("too_large");
  });

  it("11. stat on missing path → not_found", async () => {
    const ghost = join(workspace, "nope-does-not-exist.bin");
    let caught: unknown;
    try {
      await stat(sandbox, ghost);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("not_found");
  });

  it("12. listDir hides .dotfiles by default; includeHidden exposes them", async () => {
    const dir = join(workspace, "dotdir");
    await mkdir(dir, { recursive: true });
    await nodeWriteFile(join(dir, "visible.txt"), "v");
    await nodeWriteFile(join(dir, ".hidden"), "h");
    const def = await listDir(sandbox, dir);
    expect(def.map((e) => e.name)).toEqual(["visible.txt"]);
    const all = await listDir(sandbox, dir, { includeHidden: true });
    expect(all.map((e) => e.name).sort()).toEqual([".hidden", "visible.txt"]);
  });
});

describe("fs tools · extra coverage", () => {
  it("13. readFile encoding=base64 returns base64 string", async () => {
    const p = join(workspace, "bin.dat");
    await nodeWriteFile(p, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const res = await readFile(sandbox, p, { encoding: "base64" });
    expect(res.content).toBe(Buffer.from([0x00, 0x01, 0x02, 0xff]).toString("base64"));
  });

  it("14. listDir maxEntries truncates", async () => {
    const dir = join(workspace, "many");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      await nodeWriteFile(join(dir, `f${i}.txt`), String(i));
    }
    const res = await listDir(sandbox, dir, { maxEntries: 3 });
    expect(res.length).toBe(3);
  });
});

describe("ToolRegistry", () => {
  it("15. register + invoke round-trip; list() includes name", async () => {
    const reg = new ToolRegistry();
    const calls: Array<unknown> = [];
    reg.register("echo", async (args) => {
      calls.push(args);
      return { ok: true, args };
    });
    expect(reg.list()).toEqual(["echo"]);
    const out = await reg.invoke("echo", { msg: "hi" });
    expect(out).toEqual({ ok: true, args: { msg: "hi" } });
    expect(calls).toEqual([{ msg: "hi" }]);
  });

  it("16. invoke unknown tool throws ToolNotFoundError", async () => {
    const reg = new ToolRegistry();
    await expect(reg.invoke("nope", {})).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it("17. duplicate register throws DuplicateToolError", () => {
    const reg = new ToolRegistry();
    reg.register("dup", async () => 1);
    expect(() => reg.register("dup", async () => 2)).toThrow(DuplicateToolError);
  });
});

describe("Sandbox · dynamic canvas", () => {
  it("18. newCanvasDir creates dir and adds to policy.allowlist", async () => {
    const base = await mkdtemp(join(tmpdir(), "sansheng-canvas-test-"));
    try {
      const sb = new Sandbox({
        policy: {
          allowlist: [{ path: join(base, "workspace"), kind: "dir" }],
          maxBytes: 1024,
        },
        homedir: base,
        tmpdir: base,
      });
      const canvas = await sb.newCanvasDir("session-abc");
      // A5 加固:canvas 在数据目录 <homedir>/.sansheng/canvas/ 下,mkdtemp 随机后缀
      const canvasRoot = join(base, ".sansheng", "canvas");
      expect(canvas.startsWith(canvasRoot)).toBe(true);
      expect(canvas).toMatch(/sansheng-session-abc-[A-Za-z0-9]{6}$/);
      // 不再幂等复用固定名 — 两次调用不同目录(/tmp race 纵深防御)
      const canvas2 = await sb.newCanvasDir("session-abc");
      expect(canvas2).not.toBe(canvas);
      // 现在能在 canvas 内写文件
      const r = await writeFile(sb, join(canvas, "note.txt"), "ok");
      expect(r.bytesWritten).toBe(2);
      const back = await readFile(sb, join(canvas, "note.txt"));
      expect(back.content).toBe("ok");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
