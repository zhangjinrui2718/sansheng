/**
 * Harness 写面 · 四条规矩
 *
 * 每一条都来自旧系统 7-O 的真实教训。这里逐条钉住 —— 因为它们全是
 * 「写错了不会报错、只会静默做错事」的那一类。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  promptUnitIds, rolesForUnit, writePromptUnit, resetPromptUnit, listBackups,
  unitFilePath, type FactoryDirs,
} from "../../src/platform/harness/write.js";

let dataDir: string;
let factoryDir: string;
let dirs: FactoryDirs;
const NOW = 1_700_000_000_000;

const ANY_UNIT = "business_manager.core";

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "sansheng-hw-"));
  dataDir = join(root, "data");
  factoryDir = join(root, "factory");
  mkdirSync(join(dataDir, "harness", "system_prompts"), { recursive: true });
  mkdirSync(factoryDir, { recursive: true });
  // 出厂副本:每个单元都给一份,便于测「恢复出厂」
  for (const id of promptUnitIds()) {
    writeFileSync(join(factoryDir, `${id}.md`), `出厂内容:${id}`, "utf8");
  }
  dirs = { dataDir, factoryDir };
});
afterEach(() => {
  rmSync(join(dataDir, ".."), { recursive: true, force: true });
});

describe("规矩① · id 必须来自闭合注册表", () => {
  it("注册表由 ROLE_SPECS 推导,含全部 12 个单元", () => {
    expect(promptUnitIds()).toHaveLength(12);
    expect(promptUnitIds()).toContain(ANY_UNIT);
    expect(promptUnitIds()).toContain("quality_reviewer.protocol");
  });

  it("**路径穿越被挡住** —— 这是唯一那道防线", () => {
    for (const evil of ["../../../settings.json", "../keyring", "/etc/passwd", "a/../../b"]) {
      const r = writePromptUnit(dirs, evil, "坏内容", NOW);
      expect(r.ok, `「${evil}」不该被接受`).toBe(false);
      expect(r.reason).toBe("unknown_unit");
    }
    // 数据目录外没有多出任何文件
    expect(existsSync(join(dataDir, "settings.json"))).toBe(false);
  });

  it("未知 id 不写任何文件", () => {
    const r = writePromptUnit(dirs, "not.a.unit", "x", NOW);
    expect(r.reason).toBe("unknown_unit");
    expect(existsSync(unitFilePath(dirs, "not.a.unit"))).toBe(false);
  });

  it("rolesForUnit 说明这个单元是给谁用的", () => {
    expect(rolesForUnit(ANY_UNIT)).toEqual(["business_manager"]);
    expect(rolesForUnit("collaboration.ask").sort()).toEqual(
      ["project_manager", "quality_reviewer", "worker"].sort(),
    );
  });
});

describe("规矩② · 备份是写的前置", () => {
  it("**覆盖前先落备份**,内容与覆盖前一致", () => {
    writePromptUnit(dirs, ANY_UNIT, "第一版", NOW);
    const r = writePromptUnit(dirs, ANY_UNIT, "第二版", NOW + 1000);
    expect(r.ok).toBe(true);
    expect(r.backupPath).toBeDefined();
    expect(readFileSync(r.backupPath!, "utf8")).toBe("第一版");
  });

  it("**首次创建不落备份**(没有东西可备份),但也不算失败", () => {
    const r = writePromptUnit(dirs, ANY_UNIT, "第一版", NOW);
    expect(r.ok).toBe(true);
    expect(r.backupPath).toBeUndefined();
    expect(listBackups(dataDir, ANY_UNIT)).toEqual([]);
  });

  it("备份最多留 10 份", () => {
    for (let i = 0; i < 15; i++) writePromptUnit(dirs, ANY_UNIT, `第 ${i} 版`, NOW + i * 1000);
    expect(listBackups(dataDir, ANY_UNIT).length).toBe(10);
  });

  it("同毫秒多次写不会互相覆盖备份(撞名要避让)", () => {
    writePromptUnit(dirs, ANY_UNIT, "v1", NOW);
    writePromptUnit(dirs, ANY_UNIT, "v2", NOW); // 同一毫秒
    writePromptUnit(dirs, ANY_UNIT, "v3", NOW);
    const b = listBackups(dataDir, ANY_UNIT);
    expect(b.length, "同一毫秒的三次写应产生两份不重名的备份").toBe(2);
    expect(new Set(b.map((x) => x.path)).size).toBe(2);
  });
});

describe("规矩③ · 报成功 = 真生效", () => {
  it("返回的是**回读**到的正文", () => {
    const r = writePromptUnit(dirs, ANY_UNIT, "写入的内容", NOW);
    expect(r.content).toBe("写入的内容");
    expect(readFileSync(unitFilePath(dirs, ANY_UNIT), "utf8")).toBe("写入的内容");
  });

  it("写完立刻能从盘上读到(不是只在内存里)", () => {
    writePromptUnit(dirs, ANY_UNIT, "落盘校验", NOW);
    const p = unitFilePath(dirs, ANY_UNIT);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("落盘校验");
  });

  it("不留 .tmp 残骸(原子写要清理干净)", () => {
    writePromptUnit(dirs, ANY_UNIT, "x", NOW);
    const tmp = `${unitFilePath(dirs, ANY_UNIT)}.tmp`;
    expect(existsSync(tmp)).toBe(false);
  });
});

describe("规矩④ · 恢复出厂 ≠ 删文件", () => {
  it("**写回出厂字节**,不是删掉用户文件", () => {
    writePromptUnit(dirs, ANY_UNIT, "用户改过的版本", NOW);
    const r = resetPromptUnit(dirs, ANY_UNIT, NOW + 1000);
    expect(r.ok).toBe(true);
    expect(r.content).toBe(`出厂内容:${ANY_UNIT}`);
    // 文件**仍然存在** —— 删文件会变成「未装载」态,那是另一件事
    expect(existsSync(unitFilePath(dirs, ANY_UNIT))).toBe(true);
    expect(readFileSync(unitFilePath(dirs, ANY_UNIT), "utf8")).toBe(`出厂内容:${ANY_UNIT}`);
  });

  it("恢复出厂也落备份(用户的版本还能找回来)", () => {
    writePromptUnit(dirs, ANY_UNIT, "用户版", NOW);
    resetPromptUnit(dirs, ANY_UNIT, NOW + 1000);
    const b = listBackups(dataDir, ANY_UNIT);
    expect(b.length).toBe(1);
    expect(readFileSync(b[0]!.path, "utf8")).toBe("用户版");
  });

  it("**找不到出厂副本时如实报错**,不偷偷改成删文件", () => {
    rmSync(join(factoryDir, `${ANY_UNIT}.md`));
    writePromptUnit(dirs, ANY_UNIT, "用户版", NOW);
    const r = resetPromptUnit(dirs, ANY_UNIT, NOW + 1000);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_factory_copy");
    expect(r.detail).toContain("删掉用户文件只会让它变成「未装载」");
    // 用户的内容**没被动过**
    expect(readFileSync(unitFilePath(dirs, ANY_UNIT), "utf8")).toBe("用户版");
  });

  it("未知 id 的恢复出厂也被挡下", () => {
    expect(resetPromptUnit(dirs, "../evil", NOW).reason).toBe("unknown_unit");
  });
});
