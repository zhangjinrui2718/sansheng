/**
 * 设置写入 · 测试
 *
 * ── 这一条为什么必须钉住 ────────────────────────────────────────
 *
 * 「用户没填 apiKey 或填的是掩码串 → 保留旧真值」这条规则**写错了后果极隐蔽**:
 * 用户改一下模型名,保存后 API key 被清空,而界面上**看不出任何异常**
 * (掩码照常显示),直到下一次调用报「No API key found」。
 *
 * 所以这里既测「保住了」,也测「真值能更新」(两条都要,只测一条会让
 * 「永远不更新」也能通过)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, genProviderId } from "../../src/server/settings/store.js";
import { applySettingsPatch, toPublicSettings } from "../../src/server/settings/apply.js";
import { Keyring, maskApiKey } from "../../src/server/storage/keyring.js";

let dir: string;
let store: SettingsStore;

const REAL_KEY = "sk-abcdefghijklmnopqrstuvwxyz012345";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sansheng-settings-"));
  const keyring = new Keyring(join(dir, ".keyring"));
  store = new SettingsStore(join(dir, "settings.json"), keyring);
  store.save({
    ...store.load(),
    providers: [{
      id: "p1", label: "测试", provider: "minimax-cn", modelId: "MiniMax-M3",
      apiKey: REAL_KEY, thinkingLevel: "medium",
    }],
    activeProviderId: "p1",
    cwd: "/tmp/ws",
    personaName: "三生",
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("applySettingsPatch · apiKey 保留规则", () => {
  it("**只改 modelId 时 key 必须保住**(掩码回传)", () => {
    const r = applySettingsPatch(store, {
      providers: [{
        id: "p1", provider: "minimax-cn", modelId: "MiniMax-M2",
        apiKey: maskApiKey(REAL_KEY), thinkingLevel: "medium",
      }],
      activeProviderId: "p1",
    });
    expect(r.ok).toBe(true);
    const saved = store.load().providers[0]!;
    expect(saved.modelId).toBe("MiniMax-M2");
    expect(saved.apiKey, "key 被清空了 —— 这是最隐蔽的那种写坏").toBe(REAL_KEY);
  });

  it("**完全不传 apiKey 字段时也要保住**", () => {
    const r = applySettingsPatch(store, {
      providers: [{ id: "p1", provider: "minimax-cn", modelId: "MiniMax-M4" }],
    });
    expect(r.ok).toBe(true);
    expect(store.load().providers[0]!.apiKey).toBe(REAL_KEY);
  });

  it("**传新真值时必须更新**(不能因为怕清空就永不更新)", () => {
    const NEW = "sk-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const r = applySettingsPatch(store, {
      providers: [{ id: "p1", provider: "minimax-cn", modelId: "MiniMax-M3", apiKey: NEW }],
    });
    expect(r.ok).toBe(true);
    expect(store.load().providers[0]!.apiKey).toBe(NEW);
  });

  it("新建 provider(无 id)时用传入的 key", () => {
    const NEW = "sk-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
    const r = applySettingsPatch(store, {
      providers: [
        { id: "p1", provider: "minimax-cn", modelId: "MiniMax-M3", apiKey: maskApiKey(REAL_KEY) },
        { label: "新的", provider: "openai", modelId: "gpt-4", apiKey: NEW },
      ],
    });
    expect(r.ok).toBe(true);
    const added = store.load().providers.find((p) => p.provider === "openai")!;
    expect(added.apiKey).toBe(NEW);
    expect(added.id).not.toBe("");
  });
});

describe("applySettingsPatch · activeProviderId 回落", () => {
  it("指向已删除的 provider 时回落到第一个 —— 不留一个不存在的 id", () => {
    const r = applySettingsPatch(store, {
      providers: [{ id: "p2", provider: "openai", modelId: "gpt-4", apiKey: "sk-x1234567890" }],
      activeProviderId: "p1", // p1 已被删
    });
    expect(r.ok).toBe(true);
    expect(store.load().activeProviderId).toBe("p2");
  });

  it("provider 列表清空时 activeProviderId 置空串(而不是留着旧 id)", () => {
    const r = applySettingsPatch(store, { providers: [] });
    expect(r.ok).toBe(true);
    expect(store.load().activeProviderId).toBe("");
  });
});

describe("applySettingsPatch · 全局字段与错误", () => {
  it("局部更新:只给 cwd 时其他字段不动", () => {
    const before = store.load();
    const r = applySettingsPatch(store, { cwd: "/new/path" });
    expect(r.ok).toBe(true);
    const after = store.load();
    expect(after.cwd).toBe("/new/path");
    expect(after.personaName).toBe(before.personaName);
    expect(after.providers).toHaveLength(before.providers.length);
  });

  it("非对象 → 如实报错,不抛异常", () => {
    const r = applySettingsPatch(store, "不是对象");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("合法 JSON") });
  });

  it("providers 不是数组 → 如实报错", () => {
    const r = applySettingsPatch(store, { providers: "nope" });
    expect(r.ok).toBe(false);
  });

  it("失败时**不落盘**(设置没被改坏)", () => {
    const before = JSON.stringify(store.load());
    applySettingsPatch(store, { providers: 42 });
    expect(JSON.stringify(store.load())).toBe(before);
  });
});

describe("toPublicSettings · 掩码而非空串", () => {
  it("apiKey 是掩码形态,hasApiKey 为 true", () => {
    const pub = toPublicSettings(store.load());
    const p = pub.providers[0]!;
    expect(p.apiKey).toBe(maskApiKey(REAL_KEY));
    expect(p.apiKey).not.toBe("");
    expect(p.hasApiKey).toBe(true);
    // 真值绝不出现在下发形状里
    expect(JSON.stringify(pub)).not.toContain(REAL_KEY);
  });

  it("没配 key 时掩码为空、hasApiKey 为 false", () => {
    store.save({ ...store.load(), providers: [{ ...store.load().providers[0]!, apiKey: "" }] });
    const pub = toPublicSettings(store.load());
    expect(pub.providers[0]!.apiKey).toBe("");
    expect(pub.providers[0]!.hasApiKey).toBe(false);
  });
});

describe("落盘是真的(不是只在内存里)", () => {
  it("写完之后重新读盘能读到新值", () => {
    applySettingsPatch(store, { cwd: "/persisted" });
    const file = join(dir, "settings.json");
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").readFileSync(file, "utf8"),
    ) as { cwd: string };
    expect(raw.cwd).toBe("/persisted");
  });
});
