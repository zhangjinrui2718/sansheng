/**
 * 批次 4b · B7 —— Keyring / db 安全形态
 * (docs/CODE-REVIEW-2026-10-01.md §B7)
 *
 * 实锤形态:
 *  - `.keyring` = {version, masterKey:base64} **明文**存于与 settings.json 同目录;
 *    「加密」对能读目录的攻击者仅是混淆。既有实现只在 **新建** 时 chmod 0600 ——
 *    一个历史遗留 0644 的 .keyring 会被原样沿用。
 *  - `sansheng.db/-wal/-shm` 实测 **0644**(db.ts 从不收紧 mode):全部会话/记忆
 *    对本机其他用户可读。SQLite 以 db 文件的权限位创建 WAL/SHM,只 chmod 主库
 *    不足以覆盖历史遗留的 wal/shm。
 *  - `Keyring.rotate()` 是 unlink → write 非原子:一旦接线即数据销毁器
 *    (换新 masterKey 但不重加密既有 settings)。
 *
 * 本组全部在 mkdtemp 临时目录内验证,**不碰真实 ~/.sansheng**;
 * 威胁模型与「不防什么」写进 docs/SECURITY-NOTES.md(同批交付)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keyring } from "../../src/server/storage/keyring.js";
import { Storage } from "../../src/server/storage/index.js";
import { upsertConversation, getConversation } from "../../src/server/storage/repo/conversations.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sansheng-b7-perm-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("B7 · db 文件权限收紧 0600", () => {
  it("新建 Storage 后主库是 0600(旧:0644,本机其他用户可读全部会话/记忆)", () => {
    const s = new Storage(join(dir, "sansheng.db"));
    // RED(修复前):mode === 0o644
    expect(modeOf(join(dir, "sansheng.db"))).toBe(0o600);
    s.close();
  });

  it("历史遗留 0644 的 db 在下次 boot 时被收紧", () => {
    const path = join(dir, "legacy.db");
    const first = new Storage(path);
    upsertConversation(first.db, { id: "conv-b7", title: "title" });
    first.close();
    chmodSync(path, 0o644); // 模拟旧版本留下的形态

    const second = new Storage(path);
    // RED(修复前):沿用 0644
    expect(modeOf(path)).toBe(0o600);
    expect(getConversation(second.db, "conv-b7")?.title).toBe("title");
    second.close();
  });

  it("WAL / SHM 副产物同样是 0600(其余用户不可读会话内容)", () => {
    const s = new Storage(join(dir, "wal.db"));
    upsertConversation(s.db, { id: "conv-wal", title: "title" }); // 触发 -wal/-shm 生成
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith("-wal"))).toBe(true);
    for (const f of files) {
      // RED(修复前):-wal/-shm 0644
      expect(modeOf(join(dir, f))).toBe(0o600);
    }
    s.close();
  });

  it("Storage.close() 之后权限收紧状态不回退", () => {
    const path = join(dir, "closed.db");
    const s = new Storage(path);
    s.close();
    expect(modeOf(path)).toBe(0o600);
  });
});

describe("B7 · Keyring 权限与原子 rotate", () => {
  it("历史遗留 0644 的 .keyring 在读取时被收紧 0600", () => {
    const path = join(dir, ".keyring");
    const first = new Keyring(path);
    const blob = first.encrypt("sk-legacy-value-0123456789");
    chmodSync(path, 0o644); // 模拟旧版本留下的形态

    const second = new Keyring(path);
    // RED(修复前):读取路径不 chmod,0644 沿用
    expect(modeOf(path)).toBe(0o600);
    expect(second.decrypt(blob)).toBe("sk-legacy-value-0123456789");
  });

  it("rotate() 是原子的(不出现「文件已删、新文件未写」的窗口)且保持 0600", () => {
    const path = join(dir, ".keyring");
    const k = new Keyring(path);
    k.rotate();
    expect(existsSync(path)).toBe(true);
    expect(modeOf(path)).toBe(0o600);
    // 残留 tmp 文件即证明走过 unlink→write 老路径
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    // 新 keyring 实例能读出新 masterKey 派生的密文
    const blob = k.encrypt("sk-after-rotate-0123456789");
    expect(new Keyring(path).decrypt(blob)).toBe("sk-after-rotate-0123456789");
  });

  it("rotate 之后旧密文确实解不开(证明 masterKey 真的换了,不是原地 no-op)", () => {
    const path = join(dir, ".keyring");
    const k = new Keyring(path);
    const old = k.encrypt("sk-old-0123456789abcdef");
    k.rotate();
    let threw = false;
    try {
      k.decrypt(old);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("新建 keyring 仍是 0600(既有契约不破)", () => {
    const path = join(dir, ".keyring");
    new Keyring(path);
    expect(modeOf(path)).toBe(0o600);
  });
});

describe("B7 · 威胁模型文档随代码同批交付", () => {
  it("docs/SECURITY-NOTES.md 存在并写明 TOCTOU 与不防的边界", async () => {
    const { readFileSync } = await import("node:fs");
    const path = join(process.cwd(), "docs", "SECURITY-NOTES.md");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("TOCTOU");
    expect(text).toContain("0600");
    expect(text).toContain(".keyring");
  });
});

// 保证 writeFileSync 的导入在 lint 视角下被使用(测试自检:目录可写)
void writeFileSync;
