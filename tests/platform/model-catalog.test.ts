/**
 * 平台自有模型目录的等价性测试(2026-11-16 · pi 适配器域批次)
 *
 * ── 这组测试证明的是「vendor 之后行为没变」────────────────────────
 *
 * `src/platform/runtime/agentRuntime/pi/modelCatalog.ts` 整表 vendor 了
 * pi-ai `dist/providers/data/*.json` 的 chat 模型(42 家 / 1555 条),
 * `providers.ts` 的 `resolveModel` / `listProviders` / `providerEnvKey` 改读
 * 平台目录。判据不是「能跑」,是「**与已安装的 pi-ai 内置目录逐条相同**」——
 *
 *   · provider 名单(id + 名字 + 顺序)逐项相同;
 *   · 每家 provider 的 chat 模型 id 集相同;
 *   · 每条模型对象 deep-equal(pi-ai 的 `getBuiltinModel` vs `resolveCatalogModel`);
 *   · `resolveModel`(带 B6 的浅拷贝 + baseUrl 覆盖语义)抽查三家解析成功;
 *   · env 映射表非空、抽查已知条目、providers.ts 与平台目录读同一张表;
 *   · 覆盖层机制(`applyCatalogOverrides`)三条语义用合成数据钉住 ——
 *     覆盖清单 2026-11-10 起为空,留机制不留数据,机制必须仍然被测试咬住。
 *
 * ⚠️ 对着**已安装的 pi-ai** 对照意味着:上游升级导致漂移会**当场红** ——
 * 那是有意的(漂移必须看得见,重跑 modelCatalog.ts 尾注释里的生成命令即可)。
 */
import { describe, it, expect } from "vitest";
import {
  builtinProviders,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import {
  catalogProviderInfos,
  catalogChatModels,
  resolveCatalogModel,
  applyCatalogOverrides,
  PROVIDER_ENV_KEY,
} from "../../src/platform/runtime/agentRuntime/pi/modelCatalog.js";
import {
  listProviders,
  providerEnvKey,
  resolveModel,
} from "../../src/platform/runtime/agentRuntime/pi/providers.js";
import type { Model } from "@earendil-works/pi-ai";

describe("平台目录 vs 已安装的 pi-ai · 整表等价", () => {
  it("provider 名单逐项相同(id + 名字 + 顺序)", () => {
    const expected = builtinProviders().map((p) => ({ id: p.id, name: p.name ?? p.id }));
    const actual = catalogProviderInfos().map((p) => ({ id: p.id, name: p.name }));
    expect(actual).toEqual(expected);
    expect(actual.length).toBe(42);
  });

  it("每家 provider 的 chat 模型与 pi-ai 逐条 deep-equal(42 家 × 全量)", () => {
    for (const p of builtinProviders()) {
      const upstream = getBuiltinModels(p.id);
      const own = catalogChatModels(p.id);
      expect(
        own.map((m) => m.id),
        `provider ${p.id} 的模型 id 集合与 pi-ai 不一致`,
      ).toEqual(upstream.map((m) => m.id));
      for (const m of upstream) {
        expect(resolveCatalogModel(p.id, m.id), `${p.id}/${m.id} 内容漂移`).toEqual(m);
      }
    }
  });

  it("抽查:pi-ai `getBuiltinModel` 与平台解析同答(同 id 同对象内容)", () => {
    for (const [provider, modelId] of [
      ["minimax-cn", "MiniMax-M3"],
      ["minimax-cn", "MiniMax-M2.7"],
      ["moonshotai-cn", "kimi-k2.6"],
      ["anthropic", "claude-fable-5"],
    ] as const) {
      const upstream = getBuiltinModels(provider).find((m) => m.id === modelId);
      expect(upstream, `pi-ai 里找不到抽查样本 ${provider}/${modelId}`).toBeDefined();
      expect(resolveCatalogModel(provider, modelId)).toEqual(upstream);
    }
    // 查不到 = undefined(与 pi-ai 同答,不是抛错)
    expect(resolveCatalogModel("minimax-cn", "不存在的模型")).toBeUndefined();
    expect(resolveCatalogModel("不存在的provider", "MiniMax-M3")).toBeUndefined();
  });
});

describe("resolveModel · 行为等价(B6 语义保持)", () => {
  it("minimax-cn / moonshotai-cn / anthropic 各一型解析成功,内容与目录一致", () => {
    for (const [provider, modelId] of [
      ["minimax-cn", "MiniMax-M3"],
      ["moonshotai-cn", "kimi-k2.6"],
      ["anthropic", "claude-fable-5"],
    ] as const) {
      const m = resolveModel({ provider, modelId, apiKey: "k" });
      expect(m, `${provider}/${modelId} 应解析成功`).not.toBeNull();
      expect(m).toEqual(resolveCatalogModel(provider, modelId));
    }
  });

  it("没有 apiKey → null;未知模型 → null(不抛错)", () => {
    expect(resolveModel({ provider: "minimax-cn", modelId: "MiniMax-M3", apiKey: "" })).toBeNull();
    expect(resolveModel({ provider: "minimax-cn", modelId: "ghost", apiKey: "k" })).toBeNull();
  });

  it("baseUrl 覆盖写进**拷贝**,目录里那一份永不被写(B6 第 1 条)", () => {
    const pristine = resolveCatalogModel("minimax-cn", "MiniMax-M3");
    const customized = resolveModel({
      provider: "minimax-cn",
      modelId: "MiniMax-M3",
      apiKey: "k",
      baseUrl: "https://gateway.example.com/anthropic",
    });
    expect(customized?.baseUrl).toBe("https://gateway.example.com/anthropic");
    // 共享目录不被改写:再解析一次(不传 baseUrl)仍回到默认
    const again = resolveModel({ provider: "minimax-cn", modelId: "MiniMax-M3", apiKey: "k" });
    expect(again?.baseUrl).toBe(pristine?.baseUrl);
    expect(resolveCatalogModel("minimax-cn", "MiniMax-M3")).toEqual(pristine);
  });

  it("baseUrl 传 null = 回到 catalog 默认(显式清除自定义值,不是粘滞)", () => {
    resolveModel({
      provider: "minimax-cn", modelId: "MiniMax-M3", apiKey: "k",
      baseUrl: "https://gateway.example.com/anthropic",
    });
    const cleared = resolveModel({
      provider: "minimax-cn", modelId: "MiniMax-M3", apiKey: "k", baseUrl: null,
    });
    expect(cleared?.baseUrl).not.toBe("https://gateway.example.com/anthropic");
  });
});

describe("listProviders · 与 pi-ai 的读面等价", () => {
  it("全表对照:provider 名单、模型清单、reasoning/contextWindow 派生都相同", () => {
    const expected = builtinProviders()
      .filter((p) => p.id !== "radius")
      .map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        models: getBuiltinModels(p.id).map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          provider: p.id,
          contextWindow: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : undefined,
          reasoning: Boolean(m.reasoning),
        })),
      }));
    expect(listProviders()).toEqual(expected);
  });

  it("radius 被滤掉,但平台目录本身保留它(过滤是读面的决定,不是数据的)", () => {
    expect(catalogProviderInfos().some((p) => p.id === "radius")).toBe(true);
    expect(listProviders().some((p) => p.id === "radius")).toBe(false);
  });
});

describe("env 映射表 · 随 vendor 收进平台目录", () => {
  it("非空,且抽查已知条目", () => {
    const entries = Object.entries(PROVIDER_ENV_KEY);
    expect(entries.length).toBeGreaterThanOrEqual(30);
    expect(PROVIDER_ENV_KEY["anthropic"]).toBe("ANTHROPIC_API_KEY");
    expect(PROVIDER_ENV_KEY["minimax-cn"]).toBe("MINIMAX_CN_API_KEY");
    // 多家共用一个变量名是有意的(failover 的 env 通道判据依赖这张表)
    expect(PROVIDER_ENV_KEY["moonshotai"]).toBe("MOONSHOT_API_KEY");
    expect(PROVIDER_ENV_KEY["moonshotai-cn"]).toBe("MOONSHOT_API_KEY");
  });

  it("providers.ts 的 providerEnvKey 读的就是这张表(不是另一份)", () => {
    for (const [provider, envKey] of Object.entries(PROVIDER_ENV_KEY)) {
      expect(providerEnvKey(provider), `${provider} 两张表不一致`).toBe(envKey);
    }
    expect(providerEnvKey("github-copilot")).toBeUndefined();
  });

  it("刻意不列 OAuth/别路 provider(huggingface/typesafe/radius/bedrock)—— 加条目 = 改降级行为", () => {
    for (const p of ["huggingface", "typesafe", "radius", "amazon-bedrock", "github-copilot", "openai-codex"]) {
      expect(PROVIDER_ENV_KEY[p], `${p} 不该有 env 映射(见 modelCatalog.ts 的注释)`).toBeUndefined();
    }
  });
});

describe("applyCatalogOverrides · 覆盖层机制(清单空,机制必须仍在)", () => {
  const baseModel: Model<any> = {
    id: "Base-M", name: "Base-M", api: "anthropic-messages", provider: "prov",
    baseUrl: "https://api.example.com", reasoning: true, input: ["text"],
    cost: { input: 1, output: 2 }, contextWindow: 100000, maxTokens: 8000, type: "chat",
  };
  const base = { prov: { "Base-M": baseModel } };

  it("同名覆盖(整对象替换,不是字段级 merge)", () => {
    const replacement = { ...baseModel, name: "Base-M (custom)" };
    const merged = applyCatalogOverrides(base, { prov: { "Base-M": replacement } });
    expect(merged["prov"]?.["Base-M"]?.name).toBe("Base-M (custom)");
    expect(Object.keys(merged["prov"] ?? {})).toEqual(["Base-M"]);
  });

  it("新名 = 新增;未知 provider = 建新桶", () => {
    const extra = { ...baseModel, id: "Extra-M", name: "Extra-M" };
    const merged = applyCatalogOverrides(base, {
      prov: { "Extra-M": extra },
      "brand-new": { "New-M": extra },
    });
    expect(merged["prov"]?.["Extra-M"]).toEqual(extra);
    expect(merged["brand-new"]?.["New-M"]).toEqual(extra);
    expect(merged["prov"]?.["Base-M"]).toEqual(baseModel);
  });

  it("纯函数:base 与 overrides 都不被改写", () => {
    const overrides = { prov: { "Extra-M": { ...baseModel, id: "Extra-M" } } };
    applyCatalogOverrides(base, overrides);
    expect(Object.keys(base["prov"] ?? {})).toEqual(["Base-M"]);
    expect(Object.keys(overrides["prov"] ?? {})).toEqual(["Extra-M"]);
  });
});
