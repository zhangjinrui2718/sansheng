/**
 * provider 故障分类 —— 「供应商报错了」这件事的**唯一**判据。
 *
 * ── 为什么要有这个文件(真机痛点)────────────────────────────────────
 *
 * 用户原话:「sansheng 有时候会遇到断网、token 限流的问题,导致正在干活的角色失败」。
 * 查下来,平台层**零** provider 故障处理:pi 把 429 / 网络错误变成一条
 * `stopReason:"error"` 的 assistant 消息(**不抛异常**),`session.prompt()`
 * 正常 resolve ⇒ 错误原文既没进日志、也没进库、也没上屏。
 * ⇒ 「失败」这件事在平台这一侧**没有形状**,只能由一个纯函数给它一个。
 *
 * ── 为什么判据是**纯函数**而不是散在调用点上 ────────────────────────
 *
 * 三类静默失败的第 3 类:「检查 / 脚本本身也会静默出错」。分类判据一旦分散到
 * 三个调用点,三处就会在「多一个词少一个词」上漂开 —— 而漂开的表现是
 * 「限流被当成额度不足」这类**看起来正常的错误答案**。
 * ⇒ 判据只有这一处,调用方拿 `kind` 做决定。
 *
 * ── 顺序为什么是「先具体后一般」 ─────────────────────────────────────
 *
 * ⚠️ **`quota` / `auth` 必须排在 `rate_limit` 前面**:429 的原文常常长这样
 * —— `429 insufficient_quota`(额度耗尽恰好也回 429)。先判 429 会把它
 * 归成「可重试的限流」⇒ 平台换一家 provider 重试 ⇒ 换一家也一样(额度是账号级的)
 * ⇒ **无限重试也永远好不了**。
 *
 * `quota` / `auth` 的 `retryable` 是 **false**,就是这条推理的机器形式。
 */
import { log } from "../../shared/log.js";

/** provider 故障的类别。闭集 —— 每一种都有各自的处置(换一家 / 不换)。 */
export type ProviderFailureKind =
  /** 限流:等一会儿会好,换一家通常也好 */
  | "rate_limit"
  /** 额度耗尽:换一家大概率一样(账号级) */
  | "quota"
  /** 鉴权失败:配置问题,换一家也未必好 */
  | "auth"
  /** 断网 / 超时 / 连接被重置 */
  | "network"
  /** 供应商服务端 5xx */
  | "server"
  /** 归不了类 —— **不猜**(猜错的处置比不处置更坏) */
  | "unknown";

export interface ProviderFailure {
  readonly kind: ProviderFailureKind;
  /** 换一家 / 重试有没有意义 */
  readonly retryable: boolean;
  /** provider 原文(截断 500 字) */
  readonly message: string;
  /** 从原文里解析出的 HTTP 状态码(解析不到就没有这个键) */
  readonly status?: number;
  /**
   * provider 自己报的错误类型(信封里的 `error.type`,如 `rate_limit_error`)。
   *
   * ⚠️ **它可能与真实语义不一致** —— 真机遇到过:provider 报
   * `type: "rate_limit_error"`,而 message 写的是「已达到 Token Plan 用量上限」
   * (账户级额度耗尽)。所以它**不是**判据,只是给人看的线索。
   */
  readonly errorType?: string;
}

/** 原文截断上限 —— 告警要能进日志与界面,不是把整个响应体贴进去。 */
const MAX_MESSAGE_CHARS = 500;

/**
 * 每一类的触发词。
 *
 * ⚠️ **分类顺序不等于这里的排列顺序**,真正的顺序在 {@link pickKind} 里。
 * 这里只放「词表」。
 *
 * 词表来自真实 provider 的报错原文(OpenAI / Anthropic / 各类网关 / Node 底层):
 * - `insufficient_quota` / `quota exceeded` / `billing` / `monthly usage limit reached`
 * - `invalid api key` / `authentication` / `unauthorized` / `forbidden`
 * - `rate limit` / `too many requests` / `tokens per minute` / `tpm`
 * - `internal server error` / `bad gateway` / `service unavailable` / `overloaded`
 * - `fetch failed` / `ENOTFOUND` / `ECONNRESET` / `ETIMEDOUT` / `socket hang up`
 */
const QUOTA_WORDS: readonly string[] = [
  "insufficient_quota",
  "quota exceeded",
  "exceeded your current quota",
  "billing",
  "monthly usage limit reached",
  "usage limit reached",
  "quota",
  "余额不足",
  "额度",
  "配额",
  // ⚠️ 下面这一组是**真机 429 原文**逼出来的(2026-10-22):MiniMax 回的是
  // 「已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量」,
  // 里面**一个英文额度词都没有** ⇒ 只按英文词表判会把它当成「可重试的限流」
  // ⇒ 平台换一家 provider 重试 ⇒ 换一家也一样(额度是账号级的)⇒ 白转一圈。
  "用量上限",
  "已达上限",
  "超出用量",
  "积分不足",
  "购买积分",
];

const AUTH_WORDS: readonly string[] = [
  "invalid api key",
  "authentication",
  "unauthorized",
  "forbidden",
  "api key",
  "鉴权",
  "密钥",
  "余额",
];

const RATE_LIMIT_WORDS: readonly string[] = [
  "rate limit",
  "rate_limit",
  "too many requests",
  "tokens per minute",
  "tpm",
  "限流",
  "请求过于频繁",
  "超过速率",
];

const SERVER_WORDS: readonly string[] = [
  "internal server error",
  "bad gateway",
  "service unavailable",
  "overloaded",
  "服务器错误",
];

const NETWORK_WORDS: readonly string[] = [
  "fetch failed",
  "enotfound",
  "eai_again",
  "econnreset",
  "etimedout",
  "epipe",
  "socket hang up",
  "network",
  "timeout",
  "timed out",
  "超时",
  "断网",
  "连接被重置",
];

/**
 * provider 自报的错误类型 → 类别。
 *
 * ⚠️ **只当「决定性」的只有两类**:额度与鉴权 —— 它们是账号/配置级的,
 * 换 provider 治不了,所以必须最先判。其余类型只在**词表全不命中**时兜底
 * (因为 provider 的 `type` 可能与真实语义不一致,见 `ProviderFailure.errorType`)。
 */
const TYPE_KINDS: Readonly<Record<string, ProviderFailureKind>> = {
  insufficient_quota: "quota",
  quota_error: "quota",
  billing_error: "quota",
  authentication_error: "auth",
  permission_error: "auth",
  rate_limit_error: "rate_limit",
  api_error: "server",
  overload_error: "server",
  overloaded_error: "server",
  timeout_error: "network",
  connection_error: "network",
};

/**
 * 剥掉 provider 的 JSON 信封,拿到「内层 message + 内层 type」。
 *
 * ⚠️ **为什么必须剥**:真机原文长这样 ——
 * `{"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限…"}}`
 * 在整段 JSON 上做词匹配会**同时**命中 JSON 里的 `rate_limit` ⇒ 把「账户级
 * 额度耗尽」判成「可重试的限流」。剥开之后:内层 message 的语义说了算,
 * 内层 type 另存一份给人看。
 *
 * 剥不开(不是 JSON / 形状不认识)⇒ 原样返回,一个字都不改。
 */
function unwrapEnvelope(raw: string): { text: string; errorType?: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { text: trimmed };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { text: trimmed };
  }
  if (typeof parsed !== "object" || parsed === null) return { text: trimmed };
  const obj = parsed as Record<string, unknown>;
  const inner = obj.error;
  if (typeof inner === "object" && inner !== null) {
    const e = inner as Record<string, unknown>;
    const message = typeof e.message === "string" ? e.message : undefined;
    const type = typeof e.type === "string" ? e.type : undefined;
    if (message !== undefined || type !== undefined) {
      return {
        text: message ?? trimmed,
        ...(type !== undefined ? { errorType: type } : {}),
      };
    }
  }
  if (typeof obj.message === "string" && typeof obj.type === "string") {
    return { text: obj.message, errorType: obj.type };
  }
  return { text: trimmed };
}

/** 状态码 → 类别。**只覆盖真会出现的错误码** —— 3xx 不是故障。 */
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const SERVER_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set([429]);

/** 「可重试 / 值得换一家」的类别。`quota` / `auth` / `unknown` 不在其中。 */
const RETRYABLE: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
  "rate_limit",
  "server",
  "network",
]);

/**
 * 词表匹配。
 *
 * ⚠️ **纯 ASCII 的词用词边界匹配,含中文的词用 `includes`**:
 * `tpm` 这种短词用 `includes` 会命中 `attempt` 之类的无关文本 ⇒ 一次
 * 「看起来无关」的 429 被归成限流。而中文没有词边界,只能 `includes`。
 *
 * 边界用 `(?<![a-z0-9_])` / `(?![a-z0-9_])`:下划线算词内字符
 * (`rate_limit` 是一个整体,不是 `rate` + `_limit`)。
 */
function matchesWord(haystack: string, needle: string): boolean {
  // 含非 ASCII 字符的词(中文、带空格的英文短语里混了中文的)走子串匹配。
  // eslint-disable-next-line no-control-regex
  if (!/^[\x20-\x7e]+$/.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`).test(haystack);
}

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => matchesWord(haystack, n));
}

/**
 * 从原文里解析 HTTP 状态码。
 *
 * 优先认**带上下文**的写法(`status code: 429` / `status=429` / `HTTP 429`),
 * 找不到再认**独立的三位错误码**。
 *
 * ⚠️ 独立码只认 `4xx` / `5xx`,而且两侧都不许挨着别的数字 ——
 * `1500` 里那个 `500` 不是状态码,`1429` 里那个 `429` 也不是。
 */
function parseStatus(lower: string): number | undefined {
  const contextual: readonly RegExp[] = [
    /status(?:\s+code)?\s*[:=]\s*(\d{3})/,
    /\bhttp[\s/]?(\d{3})\b/,
    /\bcode\s*[:=]\s*(\d{3})\b/,
  ];
  for (const re of contextual) {
    const m = re.exec(lower);
    if (m !== null) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 400 && n <= 599) return n;
    }
  }
  const bare = /(?<![\d])([45]\d{2})(?![\d])/.exec(lower);
  if (bare !== null) {
    const n = Number(bare[1]);
    if (Number.isInteger(n) && n >= 400 && n <= 599) return n;
  }
  return undefined;
}

/**
 * 选类别 —— **顺序就是判据**(见文件头「先具体后一般」那段)。
 *
 * ⚠️ `quota` 与 `auth` 在**状态码类别**之前:429 既是限流也是额度耗尽,
 * `insufficient_quota` 才是那个「更具体」的说法。
 */
function pickKind(
  lower: string,
  status: number | undefined,
  errorType: string | undefined,
): ProviderFailureKind {
  // ① provider 自报的类型:**额度与鉴权是决定性的**(账号/配置级,换 provider 治不了)。
  const typeKind = errorType !== undefined ? TYPE_KINDS[errorType.toLowerCase()] : undefined;
  if (typeKind === "quota") return "quota";
  if (typeKind === "auth") return "auth";
  // ② 词表(先具体后一般)。⚠️ 额度词在状态码之前:`429 + 用量上限` 是额度不是限流。
  if (matchesAny(lower, QUOTA_WORDS)) return "quota";
  if (status !== undefined && AUTH_STATUSES.has(status)) return "auth";
  if (matchesAny(lower, AUTH_WORDS)) return "auth";
  if (
    (status !== undefined && RATE_LIMIT_STATUSES.has(status)) ||
    matchesAny(lower, RATE_LIMIT_WORDS)
  ) {
    return "rate_limit";
  }
  if (
    (status !== undefined && SERVER_STATUSES.has(status)) ||
    matchesAny(lower, SERVER_WORDS)
  ) {
    return "server";
  }
  if (matchesAny(lower, NETWORK_WORDS)) return "network";
  // ③ 词表全不命中 ⇒ 用 provider 自报的类型兜底(限流 / 5xx / 网络)。
  if (typeKind !== undefined) return typeKind;
  return "unknown";
}

/**
 * 把 provider 的报错原文归成一类。
 *
 * - `quota` / `auth` ⇒ **不可重试**、不值得换一家(额度与凭据是账号/配置级的)。
 * - `rate_limit` / `server` / `network` ⇒ 可重试,换一家通常有意义。
 * - `unknown` ⇒ **不猜**:宁可报「归不了类」也不给一个可能错的处置。
 *
 * 空串 / 空白 ⇒ `unknown` + 不可重试(没有原文就没有任何判据)。
 */
export function classifyProviderFailure(message: string): ProviderFailure {
  const raw = typeof message === "string" ? message : "";
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { kind: "unknown", retryable: false, message: "" };
  }
  const { text, errorType } = unwrapEnvelope(trimmed);
  const lower = text.toLowerCase();
  const status = parseStatus(lower);
  const kind = pickKind(lower, status, errorType);
  return {
    kind,
    retryable: RETRYABLE.has(kind),
    message: text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text,
    ...(status !== undefined ? { status } : {}),
    ...(errorType !== undefined ? { errorType } : {}),
  };
}

/**
 * 类别的中文说法 —— 告警与界面上给**人**看的那一份。
 *
 * ⚠️ 角色中文名只有一处(`runtime/org.ts` 的 `ORG`),但**故障类别不是角色** ——
 * 它是这一份判据的读面,放在判据旁边而不是散到调用点。
 */
export function providerFailureLabel(kind: ProviderFailureKind): string {
  switch (kind) {
    case "rate_limit":
      return "供应商限流";
    case "quota":
      return "供应商额度耗尽";
    case "auth":
      return "供应商鉴权失败";
    case "network":
      return "网络故障";
    case "server":
      return "供应商服务端错误";
    case "unknown":
      return "供应商故障(未能归类)";
  }
}

/**
 * 把一次 provider 故障渲染成一句**人能据此行动**的话。
 *
 * 四件东西缺一不可:①分类的中文说法 ②HTTP 状态码(有的话)③provider 原文
 * ④**下一步**。少了第 ④ 条,甲方看到「供应商限流」只能干瞪眼。
 *
 * @param degradedTo 降级成功后是备用 provider 的名字;`null` = 没降级成。
 */
export function describeProviderFailure(
  failure: ProviderFailure,
  retries: number,
  degradedTo: string | null,
  nextStep: string,
): string {
  const head =
    `供应商故障:${providerFailureLabel(failure.kind)}` +
    (failure.status !== undefined ? `(HTTP ${failure.status})` : "");
  const retryPart = retries > 0 ? `已自动重试 ${retries} 次` : "未重试";
  const origin = failure.message.slice(0, 200);
  const originPart = origin === "" ? "原文:（空）" : `原文:${origin}`;
  const degradedPart =
    degradedTo === null ? "" : `已切到备用 provider ${degradedTo}`;
  return [head, retryPart, originPart, degradedPart, nextStep]
    .filter((p) => p !== "")
    .join(" —— ");
}

/** 供日志用的一行摘要。 */
export function providerFailureSummary(failure: ProviderFailure): string {
  return (
    `${providerFailureLabel(failure.kind)}` +
    (failure.status !== undefined ? ` · HTTP ${failure.status}` : "") +
    ` · ${failure.message.slice(0, 200)}`
  );
}

/** 便于调用方在没装日志时也能用:给一个 WARN 级别的提示(测试里不打印)。 */
export function logProviderFailure(where: string, failure: ProviderFailure): void {
  log.warn(`${where} —— ${providerFailureSummary(failure)}`);
}
