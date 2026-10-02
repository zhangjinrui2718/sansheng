/**
 * 批次 6 · P1 + P2 —— 默认工作目录改为固定目录 `~/sansheng-workspace` + 存量迁移
 *
 * 用户报障(2026-10-02):「/Users/fuyao 这个默认的文件夹不对,应该给一个固定的文件目录」。
 * 根因:store.ts 的 `DEFAULTS.cwd = process.env.HOME ?? "/root"` 让 agent 的工作根是**整个家
 * 目录**;而且 load() 里 `raw.cwd ?? DEFAULTS.cwd` 是「已持久化值优先」—— 只改 DEFAULTS 对
 * 已存在的 settings.json(用户那份 cwd = "/Users/fuyao")**完全无效**,必须做存量迁移。
 *
 * 裁决(jev conf 1.00):默认工作根 = `~/sansheng-workspace`
 * (可见、与应用数据目录 `~/.sansheng` 物理分离、ASCII、避开源码仓库名 `~/projects/sansheng`)。
 *
 * 覆盖:
 *  ① 新默认值 = <homedir>/sansheng-workspace(且缺目录时自动创建)
 *  ② 存量 cwd === homedir(旧出厂默认)→ 迁移 + 落库 + log 告知 + 二次加载幂等(不重写)
 *  ③ 存量自定义值**不被**覆盖(含「恰好是 $HOME 的子目录」这一前缀陷阱)
 *  ④ 默认目录创建失败(EACCES/ENOTDIR)不抛:降级 log.warn,设置值照常生效
 *  ⑤ 自定义路径**不被**自动创建(防手滑路径被静默 mkdir)
 *
 * homedir 控制:POSIX 上 `os.homedir()` 读 `process.env.HOME`(已实测 Node v26.8.1),
 * 每个用例把 HOME 指到 mkdtemp 目录 → 全程不碰真实家目录,也不碰真实 ~/.sansheng。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_WORKSPACE_DIR_NAME,
  SettingsStore,
  defaultWorkspaceDir,
  isLegacyDefaultCwd,
  type Settings,
} from "../../src/server/settings/store.js";
import { Keyring } from "../../src/server/storage/index.js";
import { log } from "../../src/shared/log.js";

let root: string;
/** 冒充 $HOME 的临时目录:DEFAULT_WORKSPACE_DIR_NAME 会挂在它下面 */
let home: string;
let dataDir: string;
let file: string;
let keyring: Keyring;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sansheng-b6-cwd-"));
  home = join(root, "home");
  dataDir = join(root, "data");
  // mkdir home/data 由被测代码负责的场景不要预先建,这里显式建 data(等同 ~/.sansheng)
  mkdirSync(dataDir, { recursive: true });
  file = join(dataDir, "settings.json");
  keyring = new Keyring(join(dataDir, ".keyring"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** 写一份「已是新格式」的 settings.json(providers 是数组 → 不触发 legacy 升级路径) */
function writeSettings(cwd: string, extra: Record<string, unknown> = {}): void {
  const s: Settings = {
    providers: [],
    activeProviderId: "",
    cwd,
    personaName: "三生",
    ...extra,
  } as Settings;
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function readCwdOnDisk(): string {
  return (JSON.parse(readFileSync(file, "utf-8")) as { cwd?: string }).cwd ?? "";
}

describe("批次 6 P1 · 出厂默认工作目录 = ~/sansheng-workspace", () => {
  it("① defaultWorkspaceDir() = <homedir>/sansheng-workspace,不是 $HOME 本身", () => {
    expect(DEFAULT_WORKSPACE_DIR_NAME).toBe("sansheng-workspace");
    expect(defaultWorkspaceDir()).toBe(join(home, "sansheng-workspace"));
    // 关键:默认值**不等于** $HOME(报障的原始症状)
    expect(defaultWorkspaceDir()).not.toBe(home);
  });

  it("① 无 settings.json(全新安装)→ load() 给出新默认,并自动创建该目录", () => {
    expect(existsSync(home)).toBe(false); // 前置:目录还不存在

    const s = new SettingsStore(file, keyring).load();

    expect(s.cwd).toBe(join(home, "sansheng-workspace"));
    expect(existsSync(s.cwd)).toBe(true);
    expect(statSync(s.cwd).isDirectory()).toBe(true);
  });

  it("① 默认目录已存在时 load() 不报错(幂等)", () => {
    const s1 = new SettingsStore(file, keyring).load();
    expect(s1.cwd).toBe(join(home, "sansheng-workspace"));
    const s2 = new SettingsStore(file, keyring).load();
    expect(s2.cwd).toBe(s1.cwd);
  });

  it("⑤ 用户自定义路径不被自动创建(防手滑路径被静默 mkdir)", () => {
    const custom = join(dataDir, "my-project");
    writeSettings(custom);
    expect(existsSync(custom)).toBe(false);

    const s = new SettingsStore(file, keyring).load();

    expect(s.cwd).toBe(custom);
    expect(existsSync(custom)).toBe(false); // 绝不代建
  });
});

describe("批次 6 P2 · 存量迁移:只动旧出厂默认($HOME)", () => {
  it("② cwd === homedir → 迁移到新默认,log 明确告知", () => {
    writeSettings(home);
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const s = new SettingsStore(file, keyring).load();

    expect(s.cwd).toBe(join(home, "sansheng-workspace"));
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/cwd/i);
    expect(logged).toContain(home);
    expect(logged).toContain(join(home, "sansheng-workspace"));
  });

  it("② 迁移落库(走既有 save → 原子写),磁盘上就是新默认", () => {
    writeSettings(home);

    new SettingsStore(file, keyring).load();

    expect(readCwdOnDisk()).toBe(join(home, "sansheng-workspace"));
  });

  it("② 幂等:第二次 load 既不重复日志也不重复写盘(inode 不变)", () => {
    writeSettings(home);
    const first = new SettingsStore(file, keyring).load();
    expect(first.cwd).toBe(join(home, "sansheng-workspace"));
    const inoAfterFirst = statSync(file).ino;

    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const second = new SettingsStore(file, keyring).load();

    expect(second.cwd).toBe(first.cwd);
    // save() 是 tmp+rename(批次 4b C5),每次写盘 inode 必变 → inode 不变 == 没写
    expect(statSync(file).ino).toBe(inoAfterFirst);
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toMatch(/migrat/i);
  });

  it("③ 自定义值不被覆盖(项目目录原样保留)", () => {
    const custom = join(dataDir, "workspace-of-mine");
    writeSettings(custom);

    const s = new SettingsStore(file, keyring).load();

    expect(s.cwd).toBe(custom);
    expect(readCwdOnDisk()).toBe(custom);
  });

  it("③ 前缀陷阱:$HOME 的**子目录**不是旧默认(只做相等判定,不做前缀/包含判定)", () => {
    const child = join(home, "projects", "sansheng");
    writeSettings(child);

    const s = new SettingsStore(file, keyring).load();

    expect(s.cwd).toBe(child);
    expect(s.cwd).not.toBe(defaultWorkspaceDir());
    expect(isLegacyDefaultCwd(child)).toBe(false);
  });

  it("③ isLegacyDefaultCwd 只认「恰好等于 $HOME」", () => {
    expect(isLegacyDefaultCwd(home)).toBe(true);
    expect(isLegacyDefaultCwd(`${home}/`)).toBe(false);
    expect(isLegacyDefaultCwd(home + "-old")).toBe(false);
    expect(isLegacyDefaultCwd(defaultWorkspaceDir())).toBe(false);
    expect(isLegacyDefaultCwd("")).toBe(false);
    expect(isLegacyDefaultCwd(null)).toBe(false);
    expect(isLegacyDefaultCwd(undefined)).toBe(false);
  });

  it("③ 迁移只动 cwd:同一次迁移不碰 providers / personaName", () => {
    writeSettings(home, { personaName: "三生-自定义" });

    const s = new SettingsStore(file, keyring).load();

    expect(s.personaName).toBe("三生-自定义");
    expect(s.providers).toEqual([]);
  });
});

describe("批次 6 P1 · 默认目录创建失败不崩(降级 log.warn)", () => {
  it("④ $HOME 不可写(这里是 ENOTDIR:$HOME 指向一个普通文件)→ 不抛,值照常生效", () => {
    // 造一个「路径上已有文件」的 HOME:任何 mkdir(<file>/...) 必然 ENOTDIR
    const fakeHomeFile = join(root, "home-is-a-file");
    writeFileSync(fakeHomeFile, "not a directory", "utf-8");
    process.env.HOME = fakeHomeFile;

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.spyOn(log, "info").mockImplementation(() => {});

    let s: Settings | null = null;
    expect(() => {
      s = new SettingsStore(file, keyring).load();
    }).not.toThrow(); // 关键:创建失败不得让服务起不来

    expect(s!.cwd).toBe(join(fakeHomeFile, "sansheng-workspace"));
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toMatch(/sansheng-workspace/);
  });

  it("④ 存量迁移 + 创建失败并存:迁移仍落库,不因建目录失败而丢配置", () => {
    const fakeHomeFile = join(root, "home-is-a-file-2");
    writeFileSync(fakeHomeFile, "not a directory", "utf-8");
    process.env.HOME = fakeHomeFile;
    writeSettings(fakeHomeFile);
    vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.spyOn(log, "info").mockImplementation(() => {});

    const s = new SettingsStore(file, keyring).load();

    expect(s.cwd).toBe(join(fakeHomeFile, "sansheng-workspace"));
    expect(readCwdOnDisk()).toBe(join(fakeHomeFile, "sansheng-workspace"));
  });
});
