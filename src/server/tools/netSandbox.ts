/**
 * Sansheng NetSandbox · M4 http tool boundary guard
 *
 * 任何 http 工具在触碰 global fetch 前必须先 `checkNetRequest(url, policy)`。
 * checkNetRequest 会:
 *   1. parse URL → protocol/host/port 校验
 *   2. 校验 protocol 为 http:/https: → 否则 'bad_scheme'
 *   3. 校验 host 在 allowlist 内(精确 or `*.example.com` 通配)→ 否则 'blocked_host'
 *   4. 校验 host 非 private IP(127.x / 10.x / 172.16-31.x / 192.168.x / ::1 / fc00::/7 / fe80::/10)→ 否则 'private_ip'
 *      除非 policy.privateIpsAllowed === true
 *   5. 校验 port 在 allowlist 内(默认 80/443/8080/8443)→ 否则 'blocked_port'
 *
 * Policy 显式传入(Single Responsibility,本模块不读 ~/.sansheng/net.json — M5 才需要)。
 * 默认 allowlist 为空(全部 deny,conservative by default)。
 *
 * 设计纪律:
 *   - 仅静态校验,不做 IO;超时/解析失败的区分由 http.ts 在 fetch 层 wrap
 *   - 不解析 DNS;但可选择性调 dns.lookup 拒 private IP(默认 ON,与 IP 同步逻辑足够拦截 IPv4-literal 攻击)
 *     - 浏览器与 fetch 通常不解析 hostname 为 IP 才发请求;user 注入 IP-literal 才需要拦
 *     - 故此处解析 IP-literal-only,不为 hostname 做 dns lookup(避免 M4 阶段加 async + 抖动)
 */
import { log } from "../../shared/log.js";

/** NetSandboxError 语义 code 枚举。 */
export type NetSandboxCode =
  | "bad_scheme"
  | "blocked_host"
  | "private_ip"
  | "blocked_port"
  | "too_large"
  | "timeout"
  | "resolve_failed"
  /** A6:redirect 链超过手工跟随上限(每跳复检的循环防环)。 */
  | "too_many_redirects";

export class NetSandboxError extends Error {
  public readonly code: NetSandboxCode;
  public readonly url?: string;
  constructor(message: string, code: NetSandboxCode, url?: string) {
    super(message);
    this.name = "NetSandboxError";
    this.code = code;
    this.url = url;
    Object.setPrototypeOf(this, NetSandboxError.prototype);
  }
}

/** 协议白名单(M4 限定 http/https,其他 scheme 一律拒)。 */
export const ALLOWED_SCHEMES = ["http:", "https:"] as const;
export type AllowedScheme = (typeof ALLOWED_SCHEMES)[number];

/** 默认端口白名单:http 80 / https 443 + 2 个常见开发端口。 */
export const DEFAULT_ALLOWED_PORTS = new Set<number>([80, 443, 8080, 8443]);

/** 单条 host 规则:精确域名 or `*.example.com` 通配。 */
export type NetHostRule = string;

export interface NetPolicy {
  /** 允许的 host 列表(精确 or `*.example.com` 通配)。空数组 = 全部 deny。 */
  allowlist: readonly string[];
  /** 允许的端口集合。默认 80/443/8080/8443。 */
  allowedPorts?: ReadonlySet<number>;
  /** 显式放行 private IP(127.x / 10.x / 172.16-31.x / 192.168.x / ::1 / fc00::/7 / fe80::/10)。默认 false。 */
  privateIpsAllowed?: boolean;
  /** 默认 body 上限(字节)。默认 5 MiB。 */
  maxBytes?: number;
}

/** 默认最大 body 字节数(5 MiB)。 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 判定字符串是否为 IPv4 literal(简化:纯数字+点)。
 * 不处理 IPv6 [::1]:syntax —— 见 isPrivateIp。
 */
function isIPv4Literal(host: string): boolean {
  // 严格 4 段纯数字,无 leading zero
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (p.length === 0 || p.length > 3) return false;
    if (!/^[0-9]+$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
    if (p.length > 1 && p.startsWith("0")) return false;
  }
  return true;
}

/** IPv4-literal → 私有地址段判定。 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224) return true; // multicast 224.0.0.0/4 + reserved 240+
  return false;
}

/** IPv6 literal → 私有地址段判定。 */
function isPrivateIPv6(host: string): boolean {
  // 常见缩写形式
  const lc = host.toLowerCase();
  if (lc === "::1") return true; // loopback
  if (lc === "::" || lc === "0:0:0:0:0:0:0:0" || lc === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (lc.startsWith("fe8") || lc.startsWith("fe9") || lc.startsWith("fea") || lc.startsWith("feb")) {
    // fe80::/10
    return true;
  }
  if (lc.startsWith("fc") || lc.startsWith("fd")) {
    // fc00::/7 (unique local)
    return true;
  }
  if (lc.startsWith("ff")) {
    // ff00::/8 multicast
    return true;
  }
  return false;
}

/** 综合判定 host 是否为 private/loopback/link-local/multicast IP。 */
export function isPrivateHost(host: string): boolean {
  // IPv6 wrapped in brackets? strip.
  const h = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  if (h.includes(":")) {
    // IPv6 literal
    return isPrivateIPv6(h);
  }
  if (isIPv4Literal(h)) {
    return isPrivateIPv4(h);
  }
  return false; // hostname(non-literal): 不做 dns lookup,留给后续调用
}

/** 判定 host 是否匹配单条规则(精确 or `*.example.com` 通配)。 */
export function hostRuleMatches(rule: string, host: string): boolean {
  const lcRule = rule.toLowerCase();
  const lcHost = host.toLowerCase();
  if (lcRule.startsWith("*.")) {
    const base = lcRule.slice(2);
    if (base.length === 0) return false;
    // match subdomain.base OR base itself? 标准通配:*.example.com 匹配 a.example.com,NOT example.com
    return lcHost.endsWith("." + base);
  }
  return lcRule === lcHost;
}

/** 校验 host 在 policy.allowlist 内。 */
export function isHostAllowed(
  host: string,
  allowlist: readonly string[],
): boolean {
  for (const rule of allowlist) {
    if (hostRuleMatches(rule, host)) return true;
  }
  return false;
}

/**
 * 校验 URL 是否允许请求。返回解析后的 parts,或 throw NetSandboxError。
 * 这是无 IO 的纯函数,可同步调用。
 */
export function checkNetRequest(
  rawUrl: string,
  policy: NetPolicy,
): { url: URL; port: number } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetSandboxError(
      `netSandbox: invalid URL: ${rawUrl}`,
      "resolve_failed",
      rawUrl,
    );
  }

  // 1. scheme
  const proto = url.protocol;
  if (proto !== "http:" && proto !== "https:") {
    throw new NetSandboxError(
      `netSandbox: scheme not allowed: ${proto} (allowed: http, https)`,
      "bad_scheme",
      rawUrl,
    );
  }

  const host = url.hostname; // 不含端口和 brackets
  if (host.length === 0) {
    throw new NetSandboxError(
      `netSandbox: empty host in URL`,
      "resolve_failed",
      rawUrl,
    );
  }

  // 2. private IP
  if (isPrivateHost(host)) {
    if (!policy.privateIpsAllowed) {
      throw new NetSandboxError(
        `netSandbox: host is private/loopback and policy.privateIpsAllowed is false: ${host}`,
        "private_ip",
        rawUrl,
      );
    }
    // 否则显式允许,继续往下走
  }

  // 3. allowlist(精确 or 通配)
  if (!isHostAllowed(host, policy.allowlist)) {
    throw new NetSandboxError(
      `netSandbox: host not in allowlist: ${host}`,
      "blocked_host",
      rawUrl,
    );
  }

  // 4. port
  const port = url.port
    ? Number(url.port)
    : proto === "https:"
      ? 443
      : 80;
  const allowedPorts = policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!allowedPorts.has(port)) {
    throw new NetSandboxError(
      `netSandbox: port not allowed: ${port} (allowed: ${Array.from(
        allowedPorts,
      ).join(",")})`,
      "blocked_port",
      rawUrl,
    );
  }

  return { url, port };
}

/** 解析 policy,填充默认值。 */
export function resolveNetPolicy(policy: NetPolicy): {
  allowlist: readonly string[];
  allowedPorts: ReadonlySet<number>;
  privateIpsAllowed: boolean;
  maxBytes: number;
} {
  return {
    allowlist: policy.allowlist,
    allowedPorts: policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS,
    privateIpsAllowed: policy.privateIpsAllowed ?? false,
    maxBytes: policy.maxBytes ?? DEFAULT_MAX_BYTES,
  };
}

/** 调试辅助:打印当前 policy 摘要。 */
export function describeNetPolicy(policy: NetPolicy): string {
  return JSON.stringify({
    allowlist: policy.allowlist,
    allowedPorts: Array.from(policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS),
    privateIpsAllowed: policy.privateIpsAllowed ?? false,
    maxBytes: policy.maxBytes ?? DEFAULT_MAX_BYTES,
  });
}

/** 模块加载日志(便于 M5+ 排查 sandbox 初始化)。 */
log.muted("netSandbox: M4 module loaded (no default network access)");