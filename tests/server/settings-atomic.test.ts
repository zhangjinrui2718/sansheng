/**
 * 批次 4b · C5 —— settings.json 损坏静默清空 + 非原子写
 * (docs/CODE-REVIEW-2026-10-01.md §C5)
 *
 * 旧实现的两个互相成就的缺陷:
 *  - `load()` 的 catch 没有日志 → 损坏时**静默**回退 DEFAULTS;随后任意一次
 *    save() 把默认值写回,旧配置永久丢失,用户毫无察觉;
 *  - `save()` 直接 `writeFileSync` 截断重写 —— 写一半崩溃/断电留下截断 JSON,
 *    正好触发上述静默清空。
 *
 * 修复契约:
 *  - 损坏时响亮 log.error + **备份原文件**(settings.json.corrupt-<ts>)再回退默认;
 *  - 写盘原子化:先写同目录临时文件再 rename(同分区 rename 原子);
 *  - 序列化失败时旧文件必须原样保留(绝不半截覆盖)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsStore, writeJsonAtomic, type Settings } from "../../src/server/settings/store.js";
import { Keyring } from "../../src/server/storage/index.js";
import { log } from "../../src/shared/log.js";

let dir: string;
let file: string;
let keyring: Keyring;

const BASE: Settings = {
  providers: [
    {
      id: "p1",
      label: "p1",
      provider: "deepseek",
      modelId: "deepseek-chat",
      apiKey: "sk-c5-0123456789abcdef",
      thinkingLevel: "medium",
    },
  ],
  activeProviderId: "p1",
  cwd: "/tmp",
  personaName: "三生",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sansheng-c5-settings-"));
  file = join(dir, "settings.json");
  keyring = new Keyring(join(dir, ".keyring"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("C5 · 损坏的 settings.json 不再被静默清空", () => {
  it("load() 遇到损坏 JSON → 响亮日志 + 备份原文件", () => {
    const corrupt = '{"providers": [ this is not json';
    writeFileSync(file, corrupt, { mode: 0o600 });
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    const store = new SettingsStore(file, keyring);
    const s = store.load();

    // 旧行为:静默回退默认,文件仍在但内容无备份 → 旧配置永久丢失
    const logged = [...errSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/settings/i);
    expect(s.providers).toEqual([]); // 仍然降级为默认(不猜内容),但不是静默的

    const backups = readdirSync(dir).filter((f) => f.startsWith("settings.json.corrupt-"));
    expect(backups).toHaveLength(1);
    // RED(修复前):没有任何备份
    expect(readFileSync(join(dir, backups[0]!), "utf-8")).toBe(corrupt);
  });

  it("备份不覆盖既有文件(两次损坏产生两份备份)", () => {
    writeFileSync(file, "{bad", { mode: 0o600 });
    new SettingsStore(file, keyring).load();
    writeFileSync(file, "{worse", { mode: 0o600 });
    new SettingsStore(file, keyring).load();
    const backups = readdirSync(dir).filter((f) => f.startsWith("settings.json.corrupt-"));
    expect(backups).toHaveLength(2);
  });

  it("备份是逐字节原文件(不是重新序列化的清空默认),且权限 0600", () => {
    const store = new SettingsStore(file, keyring);
    store.save(BASE); // 写一份合法的加密配置
    const good = readFileSync(file, "utf-8");
    // 模拟「写到一半崩溃」:内容被截断成非法 JSON
    const truncated = good.slice(0, Math.floor(good.length / 2));
    writeFileSync(file, truncated, { mode: 0o600 });
    new SettingsStore(file, keyring).load();

    const backupName = readdirSync(dir).find((f) => f.startsWith("settings.json.corrupt-"))!;
    // RED(修复前):没有任何备份;若有备份也会是「降级后的默认」内容
    expect(readFileSync(join(dir, backupName), "utf-8")).toBe(truncated);
    expect(statSync(join(dir, backupName)).mode & 0o777).toBe(0o600);
    // 备份里出现的是原文件的「providers」键,而不是降级默认的空数组
    expect(readFileSync(join(dir, backupName), "utf-8")).toContain('"id": "p1"');
  });
});

describe("C5 · 写盘原子化(tmp + rename)", () => {
  it("save() 之后不残留任何临时文件", () => {
    const store = new SettingsStore(file, keyring);
    store.save(BASE);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("save() 走 rename(同名文件的 inode 变化 —— 原地截断重写不会变 inode)", () => {
    const store = new SettingsStore(file, keyring);
    store.save(BASE);
    const before = statSync(file).ino;
    store.save({ ...BASE, personaName: "三生-2" });
    const after = statSync(file).ino;
    // RED(修复前):writeFileSync 原地截断 → inode 不变
    expect(after).not.toBe(before);
    expect((JSON.parse(readFileSync(file, "utf-8")) as Settings).personaName).toBe("三生-2");
  });

  it("序列化失败时旧文件原样保留(绝不半截覆盖)", () => {
    const store = new SettingsStore(file, keyring);
    store.save(BASE);
    const good = readFileSync(file, "utf-8");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // 构造一个 JSON.stringify 必然抛的 Settings 载荷
    const bad = { ...BASE, extra: circular } as unknown as Settings;
    expect(() => store.save(bad)).toThrow();
    // RED(修复前):即使如此,原地 write 也可能已把文件截断
    expect(readFileSync(file, "utf-8")).toBe(good);
  });

  it("writeJsonAtomic 保留 0600 权限与最终内容", () => {
    const target = join(dir, "atomic.json");
    writeJsonAtomic(target, '{"a":1}');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe('{"a":1}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("writeJsonAtomic 不残留 tmp 文件", () => {
    const target = join(dir, "atomic2.json");
    writeJsonAtomic(target, "{}");
    writeJsonAtomic(target, '{"b":2}');
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});

// 供未来断言复用(证明 rename 是本模块的原子性来源)
void renameSync;
