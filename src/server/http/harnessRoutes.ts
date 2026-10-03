/**
 * Sansheng HTTP routes · 批次 7-O:Harness 写面
 *
 * Extracted from http.ts for testability —— registerHarnessRoutes(app, { dataDir })
 * 可以在 vitest 里用一个临时 dataDir 直接挂载,不需要起 kernel / storage / WS。
 *
 * Routes registered:
 *   - GET  /api/harness/facets/:facet/entries/:id    单条目详情(编辑器初值)
 *   - PUT  /api/harness/facets/:facet/entries/:id    写入 { content } | { allow, deny }
 *   - POST /api/harness/facets/:facet/entries/:id/reset   恢复出厂(显式确认,独立按钮)
 *
 * ── 三条不变的原则 ──────────────────────────────────────────────────────
 *
 * 1. **本模块不做任何校验。** id 白名单、内容上限、工具名闭合联合、备份与原子写
 *    全在 src/server/harness/apply.ts;这里只把 HarnessApplyResult 的 error 码
 *    翻译成 HTTP 状态码。反过来说也成立:绕过 HTTP 直调 applyFacet 得到的是
 *    同一套判定 —— UI 拿到的不是「另一条更宽松的路径」。
 *
 * 2. **状态码是有含义的,不是随手挑的。**
 *      404 unknown_facet / unknown_entry  你指的条目不存在(含 ../ 这类非法 id)
 *      409 not_implemented               面在,但没实现写(skills / rag)
 *      400 invalid_payload               条目存在但你写的东西不合法
 *      500 io_error                      备份/写盘失败 —— **文件未被改动**
 *    500 的响应体里必须能看出「没改动」,否则用户会以为改了一半。
 *
 * 3. **写端点全部落在 B4 安全守卫之后。** createApp 顶部 `app.use("*",
 *    createSecurityMiddleware())` 最先注册,Hono 按注册顺序执行 →
 *    PUT/POST 自动获得 Host 校验(DNS rebinding)+ Origin / Sec-Fetch-Site
 *    校验(CSRF)。**不要给写路由加豁免**:本地单用户服务被任意网页改掉
 *    agent 提示词,是一句提示词就能完成的提权。
 *
 * ── 为什么「立即生效」要用户显式勾选 ─────────────────────────────────────
 * 沟通员的 Pi session 被 kernel 缓存,改完它的提示词要 invalidate() 才读得到
 * 新值 —— 而 invalidate() 会 abort 在飞回合。默认不做,是因为「保存配置」
 * 不该顺手掐掉用户正在进行的对话;UI 上给一个写清楚的复选框,让用户自己决定。
 */
import type { Hono } from "hono";
import { log } from "../../shared/log.js";
import { describeFacetEntry, applyFacet } from "../harness/facet.js";
import type {
  ApplyErrorCode,
  HarnessFacetId,
} from "../harness/facetTypes.js";

export interface HarnessRoutesOptions {
  dataDir: string;
  /**
   * 可选:写完后丢弃当前 Pi session(沟通员提示词立即生效)。
   * **默认不调用** —— 调用方(createApp)传入 kernel.invalidate 的引用,
   * 由本模块在 body.invalidate === true 时才触发。抛错不吞:如实写进响应。
   */
  invalidateKernel?: () => void;
}

/** error 码 → HTTP 状态码。一个函数、一张表,不许在两处各写一遍。 */
const STATUS_BY_ERROR: Readonly<Record<ApplyErrorCode, 400 | 404 | 409 | 500>> = {
  unknown_facet: 404,
  unknown_entry: 404,
  not_implemented: 409,
  invalid_payload: 400,
  io_error: 500,
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** facet 路径参数收窄到闭合 union。拼错的 id 一律当 unknown_facet(404)。 */
function isFacetId(v: string): v is HarnessFacetId {
  return v === "tools" || v === "prompts" || v === "skills" || v === "rag";
}

function readBody(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

export function registerHarnessRoutes(app: Hono, opts: HarnessRoutesOptions): void {
  // GET 详情 —— 编辑器初值。只读,GET 豁免 Origin 校验(与既有 /api/* GET 一致)。
  app.get("/api/harness/facets/:facet/entries/:id", (c) => {
    const facet = c.req.param("facet");
    const id = c.req.param("id");
    if (!isFacetId(facet)) {
      return c.json({ error: "unknown_facet", message: `未知的受管面「${facet}」` }, 404);
    }
    const result = describeFacetEntry(facet, opts.dataDir, id);
    if (!result.ok) {
      return c.json({ error: result.error, message: result.message }, 404);
    }
    return c.json(result);
  });

  // PUT 写入 —— prompts 收 { content },tools 收 { allow, deny }。
  // 面自己认自己的 payload 形状(applyFacet 分发),这里不预判。
  app.put("/api/harness/facets/:facet/entries/:id", async (c) => {
    const facet = c.req.param("facet");
    const id = c.req.param("id");
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await c.req.json();
      body = readBody(parsed);
    } catch (err) {
      // JSON 解析失败与「body 缺失」在这里是同一件事(Hono 两者都 reject),
      // 但要分开说:前者是客户端写错了,后者可能是漏传了字段。
      return c.json(
        {
          ok: false,
          error: "invalid_payload",
          message: `请求体不是合法 JSON(或为空):${errMsg(err)} —— prompts 面要 { content },tools 面要 { allow, deny }`,
        },
        400,
      );
    }
    if (!isFacetId(facet)) {
      return c.json({ ok: false, error: "unknown_facet", message: `未知的受管面「${facet}」` }, 404);
    }
    const result = applyFacet(facet, opts.dataDir, { id, payload: body, reset: false });
    if (!result.ok) {
      return failResponse(c, result);
    }
    return c.json(withInvalidate(result, body, opts));
  });

  // POST 恢复出厂 —— **显式确认的独立动作**,不复用 PUT。
  // 为什么要求显式 confirm:"恢复出厂"会丢掉用户手笔,不能被一个误触的
  // / 一条重放的请求触发(备份在,但用户未必知道怎么捞回来)。
  app.post("/api/harness/facets/:facet/entries/:id/reset", async (c) => {
    const facet = c.req.param("facet");
    const id = c.req.param("id");
    const parsed: unknown = await c.req.json().catch(() => null);
    const body = readBody(parsed);
    // confirm 检查**先于**面 id 检查:「你没确认」比「你指的条目不存在」更贴近
    // 用户此刻的动作意图(他在点恢复出厂),顺序反了会得到一条莫名其妙的 404。
    if (body["confirm"] !== "reset") {
      return c.json(
        {
          ok: false,
          error: "invalid_payload",
          message: '恢复出厂需要显式确认:body 传 { "confirm": "reset" }',
        },
        400,
      );
    }
    if (!isFacetId(facet)) {
      return c.json({ ok: false, error: "unknown_facet", message: `未知的受管面「${facet}」` }, 404);
    }
    const result = applyFacet(facet, opts.dataDir, { id, payload: {}, reset: true });
    if (!result.ok) {
      return failResponse(c, result);
    }
    return c.json(withInvalidate(result, body, opts));
  });
}

/** 失败响应。500 时补一句「文件未被改动」—— 那是用户最需要知道的一句。 */
function failResponse(
  c: { json: (b: unknown, s?: 400 | 404 | 409 | 500) => Response },
  result: { error: ApplyErrorCode; message: string; details?: unknown },
): Response {
  const status = STATUS_BY_ERROR[result.error];
  log.warn(`harness apply 失败(${result.error}):${result.message}`);
  return c.json(
    {
      ok: false,
      error: result.error,
      message: result.message,
      ...(result.details !== undefined ? { details: result.details } : {}),
      ...(status === 500 ? { fileChanged: false } : {}),
    },
    status,
  );
}

/**
 * 写成功后按需 invalidate kernel,并把结果如实写进响应。
 * 失败**不吞**:写盘已经成功(文件变了),只是「立即生效」这一步没做成 ——
 * 那必须告诉用户「配置已保存,但当前会话仍在用旧手册,重启或等下一次 start 生效」。
 */
function withInvalidate(
  result: Extract<ReturnType<typeof applyFacet>, { ok: true }>,
  body: Record<string, unknown>,
  opts: HarnessRoutesOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...result };
  if (body["invalidate"] !== true || !opts.invalidateKernel) {
    return out;
  }
  try {
    opts.invalidateKernel();
    out["invalidated"] = true;
  } catch (err) {
    log.warn("harness apply 后的 kernel.invalidate 失败:", err);
    out["invalidated"] = false;
    out["invalidateError"] = `配置已保存,但当前会话仍在用旧手册:${errMsg(err)}`;
  }
  return out;
}
