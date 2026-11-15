/**
 * toolSet L2 写面(writeToolSetFile / clearToolSetFile)· 测试
 *
 * 钉住四道校验与两条语义:
 *   · ④ 道校验:role 闭合 / 形状 / 未知工具名 / 备份前置;
 *   · 写入语义:state 变 ok(真的收窄工具面)、回读一致;
 *   · 恢复出厂语义 = **删文件回到 absent**(ceiling 全集),不是写空文件;
 *   · 删前留备份(可人工找回)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeToolSetFile,
  clearToolSetFile,
  resolveToolSet,
  toolSetPath,
} from "../../src/platform/harness/toolSet.js";

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ss-tools-write-"));
  clock = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("toolSet 写面", () => {
  it("① 合法写入 ⇒ 文件落盘、state 变 ok、回读一致", () => {
    const r = writeToolSetFile(dir, "research_worker", { allow: ["read", "grep"], deny: ["bash"] }, clock);
    expect(r.ok).toBe(true);
    const res = resolveToolSet(dir, "research_worker");
    expect(res.state).toBe("ok");
    expect(res.file?.allow).toEqual(["read", "grep"]);
    expect(res.file?.deny).toEqual(["bash"]);
  });

  it("② 未知工具名 ⇒ 拒绝并说明(拼写错误写面挡,不静默无效)", () => {
    const r = writeToolSetFile(dir, "research_worker", { allow: ["read", "not_a_tool"], deny: [] }, clock + 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unknown_tool");
    expect(r.detail).toContain("not_a_tool");
  });

  it("③ 形状不对 ⇒ invalid_shape", () => {
    const r = writeToolSetFile(dir, "research_worker", { allow: "read", deny: [] }, clock + 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_shape");
  });

  it("④ 未知角色 ⇒ unknown_role", () => {
    const r = writeToolSetFile(dir, "no_such_role", { allow: [], deny: [] }, clock + 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unknown_role");
  });

  it("⑤ 覆盖前留备份(.bak)", () => {
    writeToolSetFile(dir, "research_worker", { allow: ["read"], deny: [] }, clock);
    const path = toolSetPath(dir, "research_worker");
    const first = readFileSync(path, "utf8");
    writeToolSetFile(dir, "research_worker", { allow: ["grep"], deny: [] }, clock + 1);
    expect(readFileSync(path, "utf8")).toContain("grep");
    // 备份目录里能找到第一版
    const bakDir = join(dir, "harness", "backups", "tools");
    expect(existsSync(bakDir)).toBe(true);
    expect(first).toContain("read");
  });

  it("⑥ 恢复出厂 = 删文件回到 absent(ceiling 全集),不是空文件", () => {
    writeToolSetFile(dir, "research_worker", { allow: ["read"], deny: [] }, clock);
    expect(resolveToolSet(dir, "research_worker").state).toBe("ok");
    clearToolSetFile(dir, "research_worker", clock + 1);
    const res = resolveToolSet(dir, "research_worker");
    expect(res.state).toBe("absent");
    expect(res.file).toBeUndefined();
    expect(existsSync(toolSetPath(dir, "research_worker"))).toBe(false);
  });

  it("⑦ 删前留备份:absent 时清除是无操作;有文件时删后备份在", () => {
    // absent 时清除:无文件可删,是无操作
    const r0 = clearToolSetFile(dir, "research_worker", clock);
    expect(r0.ok).toBe(true);
    // 有文件时:备份落在 backups/tools/
    writeToolSetFile(dir, "research_worker", { allow: ["read"], deny: [] }, clock);
    clearToolSetFile(dir, "research_worker", clock + 1);
    const bakDir = join(dir, "harness", "backups", "tools");
    expect(existsSync(bakDir)).toBe(true);
  });
});
