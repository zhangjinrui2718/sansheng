/**
 * 批次 4b 4a-OQ2(审查 §C9 遗留 open question):`?limit=` 解析的**单一来源**。
 *
 * 4a C9-4 把 http.ts 的 /api/memory/fragments + /api/conversations 统一到
 * parseLimitQuery,并显式留了 OQ:「blackboardRoutes.ts 自带防御(parseInt +
 * isFinite 静默回退 100),本批次不动」。本文件把那套语义提到独立模块,
 * 两个调用方共用 —— 放进 http.ts 会让 blackboardRoutes 反向 import 父模块
 * (循环依赖),所以单列。
 *
 * 契约:
 *  - 缺省 / 空串 → fallback(再 clamp 到 [1, max]);
 *  - 非法(非有限数值,`abc` / `NaN` / `Infinity`)→ null,调用方回 **400 invalid_limit**;
 *  - 合法 → trunc + clamp。
 * 静默回退为什么不行:客户端参数写错时拿到 200 + 一份「看起来正常」的数据,
 * 排障时最难查。better-sqlite3 收到 NaN 更是直接 datatype mismatch → 500,
 * 把客户端错误伪装成服务端故障。
 */
export function parseLimitQuery(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}
