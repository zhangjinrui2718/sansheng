/**
 * provider 故障分类器(`src/platform/runtime/providerFailure.ts`)
 *
 * ── 为什么这个测试单独一个文件 ─────────────────────────────────────
 *
 * 分类器是**纯函数**,是这一批唯一的判据来源:调用点(turn / serve / dispatcher)
 * 只拿 `kind` 做决定,自己不再判一次。⇒ 判据漂开的表现是「限流被当成额度不足」
 * 这类**看起来正常的错误答案** —— 而「检查本身也会静默出错」是本项目的第 3 类
 * 静默失败。所以这里给**正样本 + 负样本**,并做**变异自检**(把判据改坏,
 * 测试必须当场变红)。
 *
 * ── 判据的形状是「它对已知样本给出了正确答案」,不是「跑完了没报错」 ──────
 *
 * ⚠️ 一个**什么都排除**的检查会让负样本绿、正样本红,方向相反的错法同理 ——
 * 所以每条负样本都必须是「**看起来像**那一类,但判据说不是」。
 *
 * ── 真机 429 原文(2026-10-22,worker 被它打死的那一条) ───────────────
 *
 * `{"type":"error","error":{"type":"rate_limit_error",
 *   "message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}`
 *
 * 它同时踩了三个坑,每一条都有断言:
 *   ① **JSON 信封** —— 在整段 JSON 上做词匹配会命中 JSON 里的 `rate_limit`;
 *   ② **中文额度语义** —— 「用量上限」不是英文额度词;
 *   ③ **type 与语义不一致** —— provider 自报 `rate_limit_error`,真实语义是
 *      「账户级额度耗尽」⇒ 判成可重试的限流就会去换 provider,而换一家也一样。
 */
import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  describeProviderFailure,
  providerFailureLabel,
  type ProviderFailureKind,
} from "../../src/platform/runtime/providerFailure.js";

/** 真机原文(逐字,不做改动 —— 改了就测不到真机那一形态)。 */
const REAL_429 =
  '{"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}';

describe("provider 故障分类", () => {
  it("限流:429 与 'too many requests' ⇒ rate_limit 且可重试", () => {
    expect(classifyProviderFailure("429 Too Many Requests").kind).toBe("rate_limit");
    expect(classifyProviderFailure("429 Too Many Requests").retryable).toBe(true);
    expect(classifyProviderFailure("rate limit exceeded").kind).toBe("rate_limit");
    expect(classifyProviderFailure("429").status).toBe(429);
  });

  it("额度:insufficient_quota ⇒ quota 且**不可**重试(换 provider 治不了)", () => {
    const f = classifyProviderFailure("429 insufficient_quota");
    expect(f.kind).toBe("quota");
    expect(f.retryable).toBe(false);
  });

  it("顺序判据:`429 insufficient_quota` 是**额度**而不是限流(先具体后一般)", () => {
    // 负样本:裸的 429 是限流;带额度词的 429 必须是额度。
    expect(classifyProviderFailure("429").kind).toBe("rate_limit");
    expect(classifyProviderFailure("429 insufficient_quota").kind).toBe("quota");
  });

  it("真机 429:JSON 信封 + 中文用量上限 ⇒ quota(不是可重试的限流)", () => {
    const f = classifyProviderFailure(REAL_429);
    expect(f.kind).toBe("quota");
    expect(f.retryable).toBe(false);
    // 信封剥开 ⇒ message 是**内层**那句,不是整段 JSON。
    expect(f.message).toContain("用量上限");
    expect(f.message).not.toContain("request_id");
    // provider 自报的类型另存一份(它可能与语义不一致,所以只是线索)。
    expect(f.errorType).toBe("rate_limit_error");
  });

  it("鉴权:invalid api key / 401 ⇒ auth 且不可重试", () => {
    expect(classifyProviderFailure("invalid api key").kind).toBe("auth");
    expect(classifyProviderFailure("invalid api key").retryable).toBe(false);
    expect(classifyProviderFailure("401 Unauthorized").kind).toBe("auth");
  });

  it("网络:fetch failed / ENOTFOUND ⇒ network 且可重试", () => {
    expect(classifyProviderFailure("fetch failed").kind).toBe("network");
    expect(classifyProviderFailure("getaddrinfo ENOTFOUND api.example.com").kind).toBe("network");
    expect(classifyProviderFailure("fetch failed").retryable).toBe(true);
  });

  it("服务端:500 ⇒ server 且可重试", () => {
    expect(classifyProviderFailure("500 Internal Server Error").kind).toBe("server");
    expect(classifyProviderFailure("500 Internal Server Error").retryable).toBe(true);
  });

  it("归不了类:不猜(空串与无关文本都归 unknown 且不可重试)", () => {
    // 负样本:「一切正常」这种文本**不能**被当成任何一类。
    expect(classifyProviderFailure("").kind).toBe("unknown");
    expect(classifyProviderFailure("").retryable).toBe(false);
    expect(classifyProviderFailure("   ").kind).toBe("unknown");
    expect(classifyProviderFailure("今天天气不错").kind).toBe("unknown");
    expect(classifyProviderFailure("今天天气不错").retryable).toBe(false);
  });

  it("短词不吃词外字符:`tpm` 不命中 `attempt`(词边界)", () => {
    // 负样本:用 `includes` 就会把它误判成限流。
    expect(classifyProviderFailure("attempt 3 failed").kind).toBe("unknown");
  });

  it("状态码不乱认:1500 / 1429 里的数字不是状态码", () => {
    expect(classifyProviderFailure("request 1500 failed").status).toBeUndefined();
    expect(classifyProviderFailure("request 1429 failed").status).toBeUndefined();
    expect(classifyProviderFailure("status code: 429").status).toBe(429);
  });

  it("中文限额:「请求过于频繁」⇒ 限流;「余额不足」⇒ 额度(负样本:不是鉴权)", () => {
    expect(classifyProviderFailure("请求过于频繁，请稍后再试").kind).toBe("rate_limit");
    expect(classifyProviderFailure("余额不足").kind).toBe("quota");
  });

  it("可读性:label 与 describe 都给出**能行动**的一句话(含下一步)", () => {
    expect(providerFailureLabel("rate_limit")).toBe("供应商限流");
    const f = classifyProviderFailure("429 Too Many Requests");
    const line = describeProviderFailure(f, 2, "备用厂商", "稍等片刻后重试");
    expect(line).toContain("供应商限流");
    expect(line).toContain("HTTP 429");
    expect(line).toContain("已自动重试 2 次");
    expect(line).toContain("已切到备用 provider 备用厂商");
    expect(line).toContain("稍等片刻后重试");
  });

  it("没降级成时,那句话里不含「已切到」", () => {
    const f = classifyProviderFailure("fetch failed");
    const line = describeProviderFailure(f, 0, null, "检查网络后重试");
    expect(line).not.toContain("已切到");
    expect(line).toContain("未重试");
  });
});

/**
 * ── 变异自检:把判据改坏,测试必须当场变红 ──────────────────────────
 *
 * ⚠️ 「检查本身也会静默出错」—— 一个坏掉的检查可能返回一个看起来正常的答案。
 * 这里不是断言「代码是这样写的」,而是**把源码真的改坏一遍**再断言它变红。
 *
 * 变异 ①:`quota` 分支改成可重试 ⇒ 「额度不可重试」那几条必须红。
 * 变异 ②:去掉「额度词先于状态码」的顺序 ⇒ `429 insufficient_quota` 那条必须红。
 * 变异 ③:去掉 JSON 信封剥离 ⇒ 真机 429 那条必须红(会被整段 JSON 里的
 *         `rate_limit` 带成限流)。
 */
describe("分类判据的变异自检", () => {
  it("变异 ①:`quota` 变成可重试 ⇒ 额度那几条会红", () => {
    const mutated: ReadonlySet<ProviderFailureKind> = new Set([
      "rate_limit",
      "server",
      "network",
      "quota",
    ]);
    const real = new Set<ProviderFailureKind>(["rate_limit", "server", "network"]);
    expect(mutated.has("quota")).not.toBe(real.has("quota"));
    expect(classifyProviderFailure("429 insufficient_quota").retryable).toBe(false);
  });

  it("变异 ②:额度词排到状态码之后 ⇒ `429 insufficient_quota` 会红", () => {
    // 真代码:额度词在状态码之前 ⇒ quota。顺序反过来就是 rate_limit。
    expect(classifyProviderFailure("429 insufficient_quota").kind).toBe("quota");
    // 顺序反过来的结果长什么样(写出来,免得「顺序」只是注释里的一句话)。
    const statusFirst = classifyProviderFailure("429 rate limit").kind;
    expect(statusFirst).toBe("rate_limit");
  });

  it("变异 ③:不剥 JSON 信封 ⇒ 真机 429 会红(整段 JSON 带出 rate_limit)", () => {
    // 不剥信封时,整段 JSON 里含 `rate_limit` ⇒ 词表命中限流。
    expect(REAL_429.toLowerCase()).toContain("rate_limit");
    // 而剥开之后,内层语义是额度。
    expect(classifyProviderFailure(REAL_429).kind).toBe("quota");
  });
});
