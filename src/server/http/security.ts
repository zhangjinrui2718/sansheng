/**
 * Sansheng · 本地服务安全守卫(B4)
 *
 * 来源:docs/CODE-REVIEW-2026-10-01.md §B4 —— http.ts 原无任何 Origin/Host 校验,
 * 任意网页可用 text/plain 简单请求(无预检)`POST /api/reset {"confirm":"reset"}`
 * 跨站删库;无 Host 校验 → DNS rebinding 后可读响应;WS 握手同样无 Origin 校验。
 *
 * 威胁模型(单用户本地服务,bind 127.0.0.1):
 *  - Host 校验(全部方法):hostname ∈ {127.0.0.1, localhost, ::1}(任意端口)
 *    否则 421 —— DNS rebinding 后 Host 头是攻击者域名 → 拒,响应不可读。
 *  - Origin 校验(仅状态变更方法 POST/PUT/PATCH/DELETE):
 *      · 无 Origin 头 → 放行(curl/CLI/非浏览器客户端不发 Origin);
 *      · 有 Origin → hostname 必须在同一白名单(任意端口)。hostname 级已够
 *        防 CSRF:恶意页面的 Origin 必然是外部域名;端口级会误杀 vite dev
 *        proxy(5173 → 2718)的开发态前端(主会话裁决:hostname 级);
 *      · Origin: "null"(sandboxed iframe)/ 畸形 → 拒(URL 解析失败即不可信)。
 *  - Sec-Fetch-Site: cross-site → 直接 403(新浏览器信号,恶意页无法把它
 *    伪造成 same-origin;旧浏览器无此头时由 Origin 校验兜底)。
 *  - GET/HEAD 不做 Origin 拦截(SPA 静态资源 / 浏览器直开 / 健康检查)。
 *
 * WS 握手(upgrade)复用 isAllowedOriginHeader():有 Origin → 同一白名单;
 * 无 Origin → 放行(见 ws.ts upgrade 钩子;批次 1 集成测试客户端即无 Origin 形态)。
 */
import type { MiddlewareHandler } from "hono";

/** 本地服务 hostname 白名单(任意端口)。 */
export const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

/** 状态变更方法(仅这些做 Origin 校验;GET/HEAD/OPTIONS 豁免)。 */
const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** "[::1]" → "::1";大小写与首尾空白归一。 */
function normalizeHostname(host: string): string {
  const h = host.trim().toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/** hostname 是否在本地白名单(接受带 IPv6 brackets 的形式)。 */
export function isLocalHostname(host: string): boolean {
  return LOCAL_HOSTNAMES.has(normalizeHostname(host));
}

/**
 * 从 Host 头值("127.0.0.1:2718" / "[::1]:2718" / "localhost")提取 hostname;
 * 畸形(无法 URL 解析)→ null(视为不可信)。
 */
export function hostHeaderHostname(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Origin 头值是否可信:可 URL 解析且 hostname ∈ 本地白名单。
 * "null"(sandboxed iframe)/ 畸形 / 外部域名 → false。
 * ws.ts 的 upgrade 钩子复用本函数(单一白名单来源,避免两处漂移)。
 */
export function isAllowedOriginHeader(origin: string): boolean {
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Hono 安全守卫中间件。createApp 里必须注册在**所有**中间件(含 logger)与
 * 路由之前 —— Hono 按注册顺序执行,后注册的任何处理路径(含 serveStatic
 * 兜底与 /api/*)都先过校验。
 */
export function createSecurityMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // 1) Host 校验(全部方法)— DNS rebinding 防线。
    //    node-server 生产请求必带 Host;缺失时回退用请求 URL 的 host
    //    (Hono app.request 测试路径下 host 头可能未显式设置)。
    const hostHeader = c.req.header("host") ?? new URL(c.req.url).host;
    const hostname = hostHeaderHostname(hostHeader);
    if (hostname === null || !isLocalHostname(hostname)) {
      return c.json(
        { error: "misdirected_request", message: `Host not local: ${hostHeader}` },
        421,
      );
    }

    // 2) 状态变更方法:Sec-Fetch-Site + Origin 校验(CSRF 防线)。
    if (STATE_CHANGING_METHODS.has(c.req.method.toUpperCase())) {
      const secFetchSite = c.req.header("sec-fetch-site");
      if (secFetchSite !== undefined && secFetchSite.trim().toLowerCase() === "cross-site") {
        return c.json({ error: "forbidden", message: "cross-site request blocked" }, 403);
      }
      const origin = c.req.header("origin");
      if (origin !== undefined && !isAllowedOriginHeader(origin)) {
        return c.json({ error: "forbidden", message: `Origin not local: ${origin}` }, 403);
      }
    }

    await next();
  };
}
