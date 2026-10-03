/**
 * Sansheng · Harness 写面客户端(批次 7-O)
 *
 * 只做三件事:把冻结的后端契约抄成 TS 类型、发四个请求、把失败原样搬上屏。
 * **一个字的校验都不在这里做** —— 校验 / 备份 / 原子写全在 src/server/harness/apply.ts
 * (唯一写盘处),HTTP 层只翻译错误码(src/server/http/harnessRoutes.ts)。前端再补一套
 * 校验只会造出「前端放行、后端拒收」的第二真相源。
 *
 * ── 端点(契约冻结,不要单方面改)────────────────────────────────────────
 *   GET  /api/harness/facets/prompts/entries/:id        → EntryDetail<PromptPayload>
 *   GET  /api/harness/facets/tools/entries/:id          → EntryDetail<ToolPayload>
 *   PUT  /api/harness/facets/prompts/entries/:id        { content, invalidate? }
 *   PUT  /api/harness/facets/tools/entries/:id          { allow, deny, invalidate? }
 *   POST /api/harness/facets/:facet/entries/:id/reset   { confirm: "reset", invalidate? }
 *
 * ── 为什么失败必须原样上屏 ─────────────────────────────────────────────
 * 后端在 message 里说了人话,而且是人话里最有价值的那种:「以下名字不在工具闭合
 * 联合内:「foo」」「内容 200000 字符,超过上限 131072」「角色「x」不在工具集合
 * 注册表内」。前端把它改写成「保存失败」等于把唯一有用的信息扔掉,用户只能去翻
 * 日志。所以 FacetApiError.message 直接进 UI,**不加前缀、不翻译、不截断**。
 * error 码(HTTP 404 / 409 / 400 / 500)只用来选语气,不当控制流。
 */

/** 本批 UI 只碰这两个面;skills / rag 未实现写(409 not_implemented),页面不提供入口。 */
export type FacetId = "prompts" | "tools";

/** 与 src/server/harness/facetTypes.ts 的 HarnessEntry 同形状(同源,同一次计算)。 */
export interface HarnessEntry {
  id: string;
  enforced: boolean;
  basis: string;
  chars?: number;
  lines?: number;
  source: "factory" | "user";
  warnings: string[];
  detail?: unknown;
}

/** GET 详情响应。detail.entry 与 GET /api/harness 里的同一条目是同一份数据。 */
export interface EntryDetail<T> {
  ok: true;
  facet: FacetId;
  id: string;
  detail: { entry: HarnessEntry; payload: T };
}

/** prompts 面 payload(对应 src/server/harness/facets/prompts.ts 的 detail)。 */
export interface PromptPayload {
  content: string;
  factory: string;
  state: string;
  owner: string;
  apply: string;
  /** "contract" = 这份提示词本身是输出协议的一部分;"free" = 普通文案 */
  sensitivity: string;
  consumer: string;
  /** false = 零消费方,改它不会有任何效果 */
  enforced: boolean;
  orphanReason?: string;
}

export type ToolRisk = "readonly" | "mutating" | "exec";

/** 勾选矩阵的一行(对应 facets/tools.ts 的 detail.catalog)。 */
export interface ToolCatalogItem {
  name: string;
  risk: ToolRisk;
  origin: "sdk" | "sansheng";
  summary: string;
  /** false = 不在该角色的 ROLE_CEILING 内 —— 勾了也不会生效 */
  inCeiling: boolean;
  inAllow: boolean;
}

/** tools 面 payload。deny 由文件 / API 管理,本 UI 原样回传、不提供编辑控件。 */
export interface ToolPayload {
  allow: string[];
  deny: string[];
  /** allow − deny − 上界之外 = 真正交给 SDK 的名单 */
  allowed: string[];
  blockedByCeiling: string[];
  factory: { allow: string[]; deny: string[] };
  enforced: boolean;
  basis: string;
  apply: string;
  ceiling: string[];
  catalog: ToolCatalogItem[];
}

/** PUT / reset 成功(HarnessApplyOk + harnessRoutes 追加的 invalidated / invalidateError)。 */
export interface ApplyOk {
  ok: true;
  facet: FacetId;
  id: string;
  /** false = 内容与现状一致,未落盘(没有备份,没有副作用) */
  changed: boolean;
  backupPath: string | null;
  filePath: string;
  apply: string;
  warnings: string[];
  entry: HarnessEntry;
  invalidated?: boolean;
  invalidateError?: string;
}

/**
 * 写面失败。message 保持后端原话(渲染层负责原样显示);details 里可能有
 * { unknown: string[] } —— 哪些工具名不认识。fileChanged 只有 io_error(500) 带 false,
 * 那一句是「文件没被动过」,是用户此刻最需要知道的事。
 */
export class FacetApiError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly fileChanged: boolean | undefined;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: unknown,
    fileChanged?: boolean,
  ) {
    super(message);
    this.name = "FacetApiError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.fileChanged = fileChanged;
  }
}

/** module-level type guard:JSON 值是不是非数组对象。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * 统一发请求 + 统一翻译失败。
 *
 * 断言只有一处(body as T):payload 来自网络边界,后端已按契约产出,前端不再逐字段
 * 复检 —— 真要复检就是「前端第二真相源」,那是本项目明确拒绝的东西。
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new FacetApiError(
      "network_error",
      "请求失败:" + (e instanceof Error ? e.message : String(e)),
      0,
    );
  }
  const raw = await res.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }
  if (!isRecord(body)) {
    throw new FacetApiError(
      "bad_response",
      "响应不是 JSON 对象(HTTP " + res.status + ")",
      res.status,
    );
  }
  // 契约:失败一律非 2xx。这里仍兜一层 ok:false —— 少一次「服务端改了状态码却没改
  // body」时的静默失败。
  if (!res.ok || body["ok"] === false) {
    const code = str(body["error"]) ?? "http_" + res.status;
    const message =
      str(body["message"]) ?? "HTTP " + res.status + ",响应里没有 message —— 这可能不是 sansheng 服务";
    const fileChanged = typeof body["fileChanged"] === "boolean" ? body["fileChanged"] : undefined;
    throw new FacetApiError(code, message, res.status, body["details"], fileChanged);
  }
  return body as T;
}

function jsonInit(method: "PUT" | "POST", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** id 进路径前先编码:后端的 id 白名单是唯一挡路径穿越的地方,前端不越俎代庖。 */
function entryUrl(facet: FacetId, id: string): string {
  return "/api/harness/facets/" + facet + "/entries/" + encodeURIComponent(id);
}

/* ── 读:编辑器初值(点「编辑」才拉,不进总表)─────────────────────────── */

export function fetchPromptEntry(id: string): Promise<EntryDetail<PromptPayload>> {
  return request<EntryDetail<PromptPayload>>(entryUrl("prompts", id));
}

export function fetchToolEntry(id: string): Promise<EntryDetail<ToolPayload>> {
  return request<EntryDetail<ToolPayload>>(entryUrl("tools", id));
}

/* ── 写 ───────────────────────────────────────────────────────────────── */

/**
 * 写提示词。invalidate 默认 **不传** —— 保存配置不该顺手 abort 用户在飞的回合,
 * 要不要立刻重建会话由用户在复选框上自己决定(UI 默认也不勾)。
 */
export function putPromptEntry(id: string, content: string, invalidate: boolean): Promise<ApplyOk> {
  return request<ApplyOk>(
    entryUrl("prompts", id),
    jsonInit("PUT", invalidate ? { content, invalidate: true } : { content }),
  );
}

/** 写工具集合。deny 由调用方**原样回传** —— 本 UI 不编辑 deny,但也不许吞掉它。 */
export function putToolEntry(
  id: string,
  allow: string[],
  deny: string[],
  invalidate: boolean,
): Promise<ApplyOk> {
  return request<ApplyOk>(
    entryUrl("tools", id),
    jsonInit("PUT", invalidate ? { allow, deny, invalidate: true } : { allow, deny }),
  );
}

/**
 * 恢复出厂。confirm:"reset" 是后端硬性要求(丢用户手笔的动作不该被误触触发),
 * 所以确认必须发生在**点击之前**而不是之后 —— UI 用二次点击兑现这一层。
 */
export function resetEntry(facet: FacetId, id: string, invalidate: boolean): Promise<ApplyOk> {
  return request<ApplyOk>(
    entryUrl(facet, id) + "/reset",
    jsonInit("POST", invalidate ? { confirm: "reset", invalidate: true } : { confirm: "reset" }),
  );
}

/* ── 写后 entry.detail 的读取(detail 是 unknown,收窄走 type guard)───── */

/** 写后 tools entry 的 blockedByCeiling(entry.detail,与 GET /api/harness 同源)。 */
export function blockedByCeilingOf(entry: HarnessEntry): string[] {
  if (!isRecord(entry.detail)) return [];
  const list = entry.detail["blockedByCeiling"];
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === "string");
}

/** 写后 prompts entry 的 state(结果行上如实写「现在是 user_edited / default …」)。 */
export function stateOf(entry: HarnessEntry): string | null {
  if (!isRecord(entry.detail)) return null;
  return str(entry.detail["state"]);
}

/** details.unknown —— 「哪些工具名不认识」,原样上屏。 */
export function unknownNamesOf(err: FacetApiError): string[] {
  if (!isRecord(err.details)) return [];
  const list = err.details["unknown"];
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === "string");
}
