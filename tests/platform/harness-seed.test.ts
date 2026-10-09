/**
 * Harness 启动 seed · 只补缺失,绝不覆盖
 *
 * ── 这组用例钉的是一条**语义分界** ────────────────────────────────
 *
 * 「恢复出厂」是用户亲手点的动作,它的语义是**覆盖**(我要换回默认)。
 * 启动 seed 是系统自己做的,它**只填空缺**。
 *
 * 两者一旦混用(拿 `resetPromptUnit` 当 seed 跑一遍),后果是**静默**的:
 * 用户改过的提示词在下次重启后变回出厂字节,而界面上没有任何东西提示过他。
 * 相比之下,一个**报错**或**警告**都算好结果 —— 静默覆盖才是这一层唯一
 * 不可接受的失败形态,所以下面的用例重点不在「落盘了没有」,而在
 * 「**已存在的那份有没有被碰过**」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  promptUnitIds, seedPromptUnits, unitFilePath, type FactoryDirs,
} from "../../src/platform/harness/write.js";

let root: string;
let dataDir: string;
let factoryDir: string;
let dirs: FactoryDirs;

const EDITED = "business_manager.core";
const UNTOUCHED = "quality_reviewer.protocol";
/** 出厂字节里带一个哨兵串,用来证明「落盘的是出厂那份」而不是别的什么 */
const FACTORY_MARK = "出厂内容";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sansheng-seed-"));
  dataDir = join(root, "data");
  factoryDir = join(root, "factory");
  mkdirSync(factoryDir, { recursive: true });
  // **dataDir 一个子目录都不预建** —— 全新安装的形态。
  // 预建了就会漏掉「seed 必须自己 mkdir 出 harness/system_prompts/」这条路径。
  for (const id of promptUnitIds()) {
    writeFileSync(join(factoryDir, `${id}.md`), `${FACTORY_MARK}:${id}`, "utf8");
  }
  dirs = { dataDir, factoryDir };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("启动 seed · 空 dataDir", () => {
  it("每个单元都落盘,内容**逐字节等于**出厂副本", () => {
    const r = seedPromptUnits(dirs);

    expect(r.seeded).toHaveLength(promptUnitIds().length);
    expect(r.alreadyPresent).toHaveLength(0);
    expect(r.factoryMissing).toHaveLength(0);
    expect(r.failed).toHaveLength(0);

    // 不只数个数 —— 逐个回读,证明落的是出厂那份字节
    for (const id of promptUnitIds()) {
      const p = unitFilePath(dirs, id);
      expect(existsSync(p), `${id} 未落盘`).toBe(true);
      expect(readFileSync(p, "utf8")).toBe(`${FACTORY_MARK}:${id}`);
    }
  });

  it("自己 mkdir 出 harness/system_prompts/ —— 不依赖目录预先存在", () => {
    expect(existsSync(join(dataDir, "harness", "system_prompts"))).toBe(false);
    seedPromptUnits(dirs);
    expect(existsSync(join(dataDir, "harness", "system_prompts"))).toBe(true);
  });
});

describe("启动 seed · **不覆盖已存在的用户编辑**", () => {
  it("已存在的单元内容一个字节都不变", () => {
    // 模拟用户手改过两个单元
    const mine = "我改过的提示词,重启也不许变回去";
    writePrompt(dirs, EDITED, mine);
    writePrompt(dirs, UNTOUCHED, mine);

    const r = seedPromptUnits(dirs);

    // 已存在的进 alreadyPresent,**不进 seeded** —— 那两个桶互斥
    expect(r.alreadyPresent).toEqual(expect.arrayContaining([EDITED, UNTOUCHED]));
    expect(r.seeded).not.toContain(EDITED);
    expect(r.seeded).not.toContain(UNTOUCHED);

    expect(readFileSync(unitFilePath(dirs, EDITED), "utf8")).toBe(mine);
    expect(readFileSync(unitFilePath(dirs, UNTOUCHED), "utf8")).toBe(mine);
  });

  it("部分覆盖:改过的留下、缺的补上,两类都不串味", () => {
    const mine = "只改了这一个";
    writePrompt(dirs, EDITED, mine);

    const r = seedPromptUnits(dirs);

    expect(r.alreadyPresent).toEqual([EDITED]);
    expect(r.seeded).toHaveLength(promptUnitIds().length - 1);
    // 用户那份没被动
    expect(readFileSync(unitFilePath(dirs, EDITED), "utf8")).toBe(mine);
    // 其余是出厂那份(说明补的确实补到了)
    expect(readFileSync(unitFilePath(dirs, UNTOUCHED), "utf8")).toBe(`${FACTORY_MARK}:${UNTOUCHED}`);
  });

  it("**seed 不写备份** —— 它不是「用户写」,不该在那条路上留痕迹", () => {
    writePrompt(dirs, EDITED, "改过一次");
    seedPromptUnits(dirs);
    // 备份目录只有用户自己那次 writePromptUnit 留下的,seed 不新增
    const bakDir = join(dataDir, "harness", "backups", "prompts");
    const before = existsSync(bakDir) ? readdirSync(bakDir) : [];
    seedPromptUnits(dirs);
    const after = existsSync(bakDir) ? readdirSync(bakDir) : [];
    expect(after).toEqual(before);
  });
});

describe("启动 seed · 幂等", () => {
  it("第二次启动全落 alreadyPresent,不再写盘", () => {
    const first = seedPromptUnits(dirs);
    expect(first.seeded).toHaveLength(promptUnitIds().length);

    const second = seedPromptUnits(dirs);
    expect(second.seeded).toHaveLength(0);
    expect(second.alreadyPresent).toHaveLength(promptUnitIds().length);
    expect(second.factoryMissing).toHaveLength(0);
    expect(second.failed).toHaveLength(0);
  });

  it("反复启动不产生 .tmp 残留", () => {
    seedPromptUnits(dirs);
    seedPromptUnits(dirs);
    seedPromptUnits(dirs);
    const files = readdirSync(join(dataDir, "harness", "system_prompts"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(files).toHaveLength(promptUnitIds().length);
  });
});

describe("启动 seed · 出厂副本缺失(构建漏拷 copy-harness.mjs)", () => {
  it("缺的那一个被跳过并如实上报,**其余照常落盘**,且不抛异常", () => {
    rmSync(join(factoryDir, `${UNTOUCHED}.md`));

    let r!: ReturnType<typeof seedPromptUnits>;
    // 关键:不许抛。少一个单元不构成启动失败(server 照常起,其余 agent 照常用)
    expect(() => {
      r = seedPromptUnits(dirs);
    }).not.toThrow();

    // 如实上报 —— 调用方据此打警告,不是静默
    expect(r.factoryMissing).toEqual([UNTOUCHED]);
    expect(r.failed).toHaveLength(0);

    // 其余 13 个正常落盘
    expect(r.seeded).toHaveLength(promptUnitIds().length - 1);
    expect(r.seeded).not.toContain(UNTOUCHED);
    expect(existsSync(unitFilePath(dirs, UNTOUCHED))).toBe(false);
    expect(existsSync(unitFilePath(dirs, EDITED))).toBe(true);
    expect(readFileSync(unitFilePath(dirs, EDITED), "utf8")).toBe(`${FACTORY_MARK}:${EDITED}`);
  });

  it("出厂副本整个目录都不存在 —— 全员上报缺失,一个字节不写,不抛", () => {
    rmSync(factoryDir, { recursive: true });

    const r = seedPromptUnits(dirs);

    expect(r.seeded).toHaveLength(0);
    expect(r.factoryMissing).toHaveLength(promptUnitIds().length);
    expect(r.failed).toHaveLength(0);
    expect(existsSync(join(dataDir, "harness", "system_prompts"))).toBe(false);
  });

  it("出厂副本缺失时,用户已编辑的单元仍**原样保留**(缺失只影响没落过盘的那些)", () => {
    const mine = "我的提示词";
    writePrompt(dirs, EDITED, mine);
    rmSync(factoryDir, { recursive: true });

    const r = seedPromptUnits(dirs);

    expect(r.alreadyPresent).toEqual([EDITED]);
    expect(r.factoryMissing).toHaveLength(promptUnitIds().length - 1);
    expect(readFileSync(unitFilePath(dirs, EDITED), "utf8")).toBe(mine);
  });
});

describe("启动 seed · 落盘失败要单独报,不能混进「出厂副本缺失」", () => {
  it("dataDir 不可写时进 failed,不是 factoryMissing(否则会误导排查方向)", () => {
    const blocked = join(root, "blocked");
    mkdirSync(blocked, { recursive: true });
    // 造一个「路径被文件占住」:mkdirSync 会 EEXIST/ENOTDIR
    const bDirs: FactoryDirs = { dataDir: blocked, factoryDir };
    writeFileSync(join(blocked, "harness"), "我是文件不是目录", "utf8");

    const r = seedPromptUnits(bDirs);

    expect(r.seeded).toHaveLength(0);
    expect(r.factoryMissing).toHaveLength(0);
    expect(r.failed).toHaveLength(promptUnitIds().length);
    // failed 里带上了原因,足够让人去查
    expect(r.failed[0]).toContain(promptUnitIds()[0]!);
  });
});

/** 落一份「用户编辑」到 dataDir(自建目录树,不依赖 seed)。 */
function writePrompt(d: FactoryDirs, id: string, content: string): void {
  const p = unitFilePath(d, id);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}