/**
 * Sansheng http tools · M4
 *
 * 2 个最小 HTTP 调用工具:fetchUrl + postJson。
 * 任何对外 fetch 必须先经 netSandbox.checkNetRequest 校验,不可绕过。
 *
 * 设计纪律:
 *   - 用 Node 22 global fetch(已在 runtime 内置,无需 polyfill)
 *   - 用 AbortController 做 timeout,不用 setTimeout hack
 *   - response.body 用 stream reader 累计字节,超过 maxBytes → abort + bodyTruncated:true
 *   - fetch 抛错统一 NetSandboxError 包一层:
 *       AbortError → code='timeout'
 *       其他 → code='resolve_failed'
 *     不 leak raw error 给 caller
 *   - response body 一律 utf8 decode;不暴露 binary(后续 binary 走 base64)
 *   - headers 输出小写 key(避免 caller 处理大小写)
 */

import {
  NetSandboxError,
  checkNetRequest,
  resolveNetPolicy,
  type NetPolicy,
} from "./netSandbox.js";

/** HTTP 方法(M4 仅 GET/HEAD)。 */
export type FetchMethod = "GET" | "HEAD";

export interface FetchOpts {
  method?: FetchMethod;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyTruncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A6:手工 redirect 跟随上限。
 * undici 默认 follow ≤20 跳且每跳不过 netSandbox — 现改 redirect:"manual"
 * 循环,每跳重过 checkNetRequest,跳数上限收紧到 5(防环 + 防放大)。
 */
const MAX_REDIRECTS = 5;

/** WHATWG redirect status(304 Not Modified 无 Location 跟随语义,不含)。 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 内部 timeout 包装。 */
class FetchTimeoutError extends Error {
  constructor() {
    super("fetch timeout");
    this.name = "FetchTimeoutError";
    Object.setPrototypeOf(this, FetchTimeoutError.prototype);
  }
}

/** 小写化 header key。 */
function lowerHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * 流式读取 response body,边读边累计字节,超过 maxBytes 抛 truncated sentinel。
 * 内部使用 AbortController,超时一并 abort。
 */
async function readBodyBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ body: string; bodyTruncated: boolean }> {
  if (!response.body) {
    // HEAD or 204 等:空 body
    return { body: "", bodyTruncated: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let collected = "";
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      if (signal.aborted) {
        truncated = true;
        break;
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        // 截掉超出部分,然后终止
        const overflow = totalBytes - maxBytes;
        const kept = chunk.subarray(0, chunk.byteLength - overflow);
        collected += decoder.decode(kept, { stream: true });
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      collected += decoder.decode(chunk, { stream: true });
    }
    collected += decoder.decode(); // flush
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  return { body: collected, bodyTruncated: truncated };
}

/**
 * 通用 fetch with sandbox check + bounded body。
 * internal:供 fetchUrl/postJson 调用,不注册到 registry。
 */
async function performFetch(
  rawUrl: string,
  init: RequestInit & { method?: string },
  policy: NetPolicy,
  opts: { maxBytes?: number; timeoutMs?: number },
): Promise<HttpResult> {
  const resolvedPolicy = resolveNetPolicy(policy);
  // 首个 URL 的 netSandbox 校验(throws NetSandboxError)
  const check = checkNetRequest(rawUrl, resolvedPolicy);

  const maxBytes = opts.maxBytes ?? resolvedPolicy.maxBytes;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new FetchTimeoutError());
  }, timeoutMs);
  // 链上 caller init.signal
  if (init.signal) {
    const outer = init.signal;
    if (outer.aborted) controller.abort(outer.reason);
    outer.addEventListener(
      "abort",
      () => controller.abort(outer.reason),
      { once: true },
    );
  }

  let response: Response;
  // 当前 hop 的请求参数(method/body 会随 redirect 语义演变)。
  let hopInit: RequestInit = { ...init };
  let currentUrl: URL = check.url;
  // 当前 hop 用于错误信息的原始字符串(首跳 = rawUrl,后续 = Location 解析结果)。
  let currentRaw = rawUrl;

  try {
    // A6:手工 redirect 循环(替代 undici 默认 follow)。
    // 每一跳:fetch(redirect:"manual") → 若 3xx 且有 Location → 解析 → 重过
    // checkNetRequest → 通过才继续;最多 MAX_REDIRECTS 跳,超限抛 too_many_redirects。
    // 复检失败(checkNetRequest throw)原样冒泡 — 未授权目标一个字节都拿不到。
    for (let redirects = 0; ; ) {
      const mergedInit: RequestInit = {
        ...hopInit,
        signal: controller.signal,
        redirect: "manual",
      };
      try {
        response = await fetch(currentUrl.toString(), mergedInit);
      } catch (err) {
        if (err instanceof FetchTimeoutError || controller.signal.aborted) {
          throw new NetSandboxError(
            `http: request timeout after ${timeoutMs}ms: ${currentRaw}`,
            "timeout",
            currentRaw,
          );
        }
        throw new NetSandboxError(
          `http: request failed: ${currentRaw}: ${(err as Error).message ?? String(err)}`,
          "resolve_failed",
          currentRaw,
        );
      }

      const location = response.headers.get("location");
      // 非 3xx,或 3xx 但无 Location → 终态,按现状返回(status/headers/body 不变)。
      if (!isRedirectStatus(response.status) || location === null) {
        break;
      }

      // 3xx + Location:必须再跟一跳。先判跳数上限(防环/防放大)。
      if (redirects >= MAX_REDIRECTS) {
        throw new NetSandboxError(
          `http: too many redirects (>${MAX_REDIRECTS}) starting from ${rawUrl}, last location ${location}`,
          "too_many_redirects",
          rawUrl,
        );
      }

      // 相对 Location 按当前 URL 解析(new URL(location, base) 处理相对/绝对)。
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new NetSandboxError(
          `http: invalid redirect Location from ${currentUrl.toString()}: ${location}`,
          "resolve_failed",
          rawUrl,
        );
      }

      // 每跳重过 netSandbox(host/port/private-IP/scheme 全复检)。
      // 失败原样抛 NetSandboxError(code=blocked_host/private_ip/blocked_port/…),
      // url 字段带上被拦的 Location 便于排查。
      let nextCheck: { url: URL };
      try {
        nextCheck = checkNetRequest(nextUrl.toString(), resolvedPolicy);
      } catch (err) {
        if (err instanceof NetSandboxError) {
          throw new NetSandboxError(
            `http: redirect to ${nextUrl.toString()} blocked: ${err.message}`,
            err.code,
            nextUrl.toString(),
          );
        }
        throw err;
      }

      // redirect 语义:303 → GET(HEAD 除外);301/302 + POST → GET。
      // 转 GET 时必须丢 body(fetch 规范:GET/HEAD 不允许 body)。
      const method = (hopInit.method ?? "GET").toUpperCase();
      const status = response.status;
      const toGet =
        (status === 303 && method !== "HEAD") ||
        ((status === 301 || status === 302) && method === "POST");
      if (toGet) {
        const nextHeaders = { ...(hopInit.headers as Record<string, string> | undefined) };
        delete nextHeaders["content-type"];
        delete nextHeaders["content-length"];
        hopInit = { ...hopInit, method: "GET", body: undefined, headers: nextHeaders };
      }

      // 当前 hop 的 body 若已被 fetch 消费,不能再读 — 但转 GET 已丢弃;
      // 保留原 method(307/308)时 body 是 string(postJson 传的 payload),可重发。
      redirects += 1;
      currentUrl = nextCheck.url;
      currentRaw = nextUrl.toString();
    }
  } finally {
    clearTimeout(timer);
  }

  // response headers / body
  const { body, bodyTruncated } = await readBodyBounded(
    response,
    maxBytes,
    controller.signal,
  );

  return {
    status: response.status,
    headers: lowerHeaders(response.headers),
    body,
    bodyTruncated,
  };
}

/** fetchUrl —— M4 GET/HEAD tool。 */
export async function fetchUrl(
  url: string,
  opts: FetchOpts = {},
  policy: NetPolicy,
): Promise<HttpResult> {
  const method: FetchMethod = opts.method ?? "GET";
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  return performFetch(
    url,
    { method, headers },
    policy,
    { maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs },
  );
}

/** postJson —— M4 POST JSON tool。 */
export async function postJson(
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number } = {},
  policy: NetPolicy,
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...(opts.headers ?? {}),
  };
  const payload = JSON.stringify(body);
  return performFetch(
    url,
    { method: "POST", headers, body: payload },
    policy,
    { maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs },
  );
}