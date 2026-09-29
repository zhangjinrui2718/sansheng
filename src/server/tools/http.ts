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
  const check = checkNetRequest(rawUrl, resolvedPolicy); // throws NetSandboxError

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
  const mergedInit: RequestInit = {
    ...init,
    signal: controller.signal,
  };

  let response: Response;
  try {
    response = await fetch(check.url.toString(), mergedInit);
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof FetchTimeoutError || controller.signal.aborted) {
      throw new NetSandboxError(
        `http: request timeout after ${timeoutMs}ms: ${rawUrl}`,
        "timeout",
        rawUrl,
      );
    }
    throw new NetSandboxError(
      `http: request failed: ${rawUrl}: ${(err as Error).message ?? String(err)}`,
      "resolve_failed",
      rawUrl,
    );
  }
  clearTimeout(timer);

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