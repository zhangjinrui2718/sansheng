/**
 * 批次 4b · B6 —— resolveModel 改写 pi-ai 共享 catalog + 明文 key 进 process.env
 * (docs/CODE-REVIEW-2026-10-01.md §B6,原文明写「实证」)
 *
 * 缺陷 1(共享 catalog 被变异):`getBuiltinModel` 返回**共享对象非克隆**
 * (pi-ai providers/all.js:49),registry.ts 直接 `m.baseUrl = baseUrl` →
 * 用户删除自定义 baseUrl 后,进程内依然粘滞(第二次 resolve 不传 baseUrl 仍返回旧值)。
 *
 * 缺陷 2(明文 key 泄漏到 process.env):`process.env[envKey] = apiKey` 让
 * server spawn 的一切子进程(Pi session 的工具执行)继承全部 provider 明文 key;
 * 切 provider 后旧 key 永不删除。
 *
 * 修复契约:
 *  - resolveModel 返回**浅拷贝**;共享 catalog 对象永不被写;
 *  - baseUrl 语义显式:传值 = 覆盖;不传/传 null = 回到 catalog 默认(可清除);
 *  - resolveModel **不写 process.env**;
 *  - env 同步收敛到「仅 active provider 的一次性同步」入口
 *    syncActiveProviderApiKeyEnv(),切 provider 时旧 env key 被删除。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { BuiltinProvider } from "@earendil-works/pi-ai/providers/all";

import { resolveModel, syncActiveProviderApiKeyEnv } from "../../src/server/providers/registry.js";

const PROVIDER = "deepseek";
const MODEL_ID = "deepseek-v4-pro"; // catalog 实有模型(实证:deepseek 只有 flash / v4-pro)
const API_KEY = "sk-b6-test-0123456789abcdef";

function catalogBaseUrl(): string {
  return getBuiltinModel(PROVIDER as BuiltinProvider, MODEL_ID as never).baseUrl;
}

describe("B6 · resolveModel 不再改写 pi-ai 共享 catalog", () => {
  it("自定义 baseUrl 后不带 baseUrl 重新 resolve → 回到 catalog 默认(旧:粘滞)", () => {
    const before = catalogBaseUrl();
    const first = resolveModel({
      provider: PROVIDER,
      modelId: MODEL_ID,
      apiKey: API_KEY,
      baseUrl: "https://custom.example.com/v1",
    });
    expect(first?.baseUrl).toBe("https://custom.example.com/v1");

    // RED(修复前):getBuiltinModel 返回同一对象 → 这次也返回粘滞的 custom baseUrl
    const second = resolveModel({ provider: PROVIDER, modelId: MODEL_ID, apiKey: API_KEY });
    expect(second?.baseUrl).toBe(before);
  });

  it("catalog 共享对象本身未被变异(其实体与 baseUrl 都不变)", () => {
    const shared = getBuiltinModel(PROVIDER as BuiltinProvider, MODEL_ID as never);
    const beforeShared = shared.baseUrl;
    const resolved = resolveModel({
      provider: PROVIDER,
      modelId: MODEL_ID,
      apiKey: API_KEY,
      baseUrl: "https://another.example.com/v1",
    });
    // RED(修复前):resolved === shared,共享对象被就地改写
    expect(resolved).not.toBe(shared);
    expect(shared.baseUrl).toBe(beforeShared);
    expect(getBuiltinModel(PROVIDER as BuiltinProvider, MODEL_ID as never).baseUrl).toBe(beforeShared);
  });

  it("显式 baseUrl:null = 清除自定义 baseUrl,回到 catalog 默认", () => {
    resolveModel({
      provider: PROVIDER,
      modelId: MODEL_ID,
      apiKey: API_KEY,
      baseUrl: "https://sticky.example.com/v1",
    });
    const cleared = resolveModel({
      provider: PROVIDER,
      modelId: MODEL_ID,
      apiKey: API_KEY,
      baseUrl: null,
    });
    expect(cleared?.baseUrl).toBe(catalogBaseUrl());
  });

  it("无 apiKey → null(既有契约不变)", () => {
    expect(resolveModel({ provider: PROVIDER, modelId: MODEL_ID, apiKey: "" })).toBeNull();
  });

  it("未知 modelId → null 且不抛(既有契约不变)", () => {
    expect(
      resolveModel({ provider: PROVIDER, modelId: "no-such-model-xyz", apiKey: API_KEY }),
    ).toBeNull();
  });
});

describe("B6 · 明文 key 不再进 process.env", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "ANTHROPIC_API_KEY"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("resolveModel 本身不写 process.env(旧:直接 process.env[envKey] = apiKey)", () => {
    resolveModel({ provider: PROVIDER, modelId: MODEL_ID, apiKey: API_KEY });
    // RED(修复前):DEEPSEEK_API_KEY === API_KEY
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("syncActiveProviderApiKeyEnv 是唯一 env 写入口,且只保留 active provider 的 key", () => {
    syncActiveProviderApiKeyEnv(PROVIDER, API_KEY);
    expect(process.env.DEEPSEEK_API_KEY).toBe(API_KEY);

    // 切到另一个 provider(共用 MOONSHOT_API_KEY 名的两条映射)——
    // 旧 env 键必须被删掉,进程里不会同时留两家的明文 key
    syncActiveProviderApiKeyEnv("moonshotai", "sk-b6-other-9876543210");
    expect(process.env.MOONSHOT_API_KEY).toBe("sk-b6-other-9876543210");
    // RED(修复前):旧 key 永不清除,env 里同时躺着两家的明文
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("切回第一个 provider 时,第二家的 key 同样被清除", () => {
    syncActiveProviderApiKeyEnv("moonshotai", "sk-b6-other-9876543210");
    syncActiveProviderApiKeyEnv(PROVIDER, API_KEY);
    expect(process.env.MOONSHOT_API_KEY).toBeUndefined();
    expect(process.env.DEEPSEEK_API_KEY).toBe(API_KEY);
  });

  it("空 apiKey / 无 env 映射的 provider 不写 env(不产生空串噪声)", () => {
    syncActiveProviderApiKeyEnv(PROVIDER, API_KEY);
    syncActiveProviderApiKeyEnv("github-copilot", "whatever");
    expect(process.env.DEEPSEEK_API_KEY).toBe(API_KEY);
  });
});
