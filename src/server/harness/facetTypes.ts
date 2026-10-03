/**
 * Sansheng Harness · 受面条目(facet entry)的公共形状
 *
 * 单独一个文件而不是放进 facet.ts,是为了让 facet 实现方(tools/prompts/
 * skills/rag)只 import 类型、不 import 注册表 —— 避免 `facet.ts ↔ facets/*`
 * 的循环依赖。
 */

/**
 * 一个受面条目。**所有面共用这一形状**,这样 UI / API / diagnose 可以
 * 写一套渲染逻辑,而不是每加一个面就重写一遍(那正是 7-G 之前的状态)。
 *
 * 语义约定:
 *   - `enforced` = 该条目当前**真被某个执行点消费**。false 必须在 `basis`
 *     里写清「缺什么」—— 一个没有理由的 `enforced: false` 等于没标注。
 *   - `source`   = 文件内容等于当前出厂默认(factory)/ 是用户手笔(user)。
 *   - `warnings` = 解析告警。**提权失败、被上界拒绝、读盘回退** 都要落在这里,
 *                  绝不静默 —— 这是本项目反造假纪律在管理面上的落点。
 *   - `detail`   = 面特有结构(工具集合的 allowed / 提示词的 sensitivity 等)。
 *                  刻意不做成泛型:管理面要的是「能渲染」,不是「类型完备」。
 */
export interface HarnessEntry {
  /** 面内唯一 id。tools = role;prompts = unit id;未来 skills = skill 名 */
  id: string;
  /** 真被消费?false 时 basis 必须说明原因 */
  enforced: boolean;
  /** 真实消费点位置(enforced)或缺失原因(!enforced) */
  basis: string;
  /** 内容的字符数;非文本面(如工具集合)留空 */
  chars?: number;
  /** 内容的行数;非文本面留空 */
  lines?: number;
  source: "factory" | "user";
  warnings: string[];
  detail?: unknown;
}

/* ── 批次 7-O:条目详情(编辑器初值)与写面(apply)的公共类型 ─────────────────── */

/**
 * 单条目的完整内容。只读面(GET /api/harness)只给摘要 —— 提示词全文动辄几千字符,
 * 七个角色 × 单元 = 一次性拉全量毫无意义。编辑器点「编辑」时才按需取这一份。
 */
export interface HarnessEntryDetail {
  /** 与 describeHarness() 里完全同一条 entry(同形状,同一数据源) */
  entry: HarnessEntry;
  /** 面特有的内容:prompts = { content, factory, state, apply, sensitivity, owner },
   *  tools = { allow, deny, factory, ceiling, catalog, enforced, apply } */
  payload: unknown;
}

export type HarnessDetailResult =
  | { ok: true; facet: HarnessFacetId; id: string; detail: HarnessEntryDetail }
  | { ok: false; error: "unknown_facet" | "unknown_entry"; message: string };

/* ── 批次 7-O:写面(apply)的公共类型 ─────────────────────────────────────────
 * 放在本文件而不是 facet.ts,与 HarnessEntry 同一个理由:facet 实现方(facets/*)
 * 只 import 类型、不 import 注册表。facet.ts 反过来从本文件 re-export HarnessFacetId,
 * 所以「面 id 的闭合 union 只有一处定义」这条约束仍然成立。 */

/** 受管面 id 的闭合 union(原先定义在 facet.ts,因写面类型需要而移到这里)。 */
export type HarnessFacetId = "tools" | "prompts" | "skills" | "rag";

/**
 * 写面失败的分类。**不返回裸字符串**:UI 要按类型决定提示(404 vs 400 vs 409),
 * 日志要按类型决定级别。unknown_entry 与 invalid_payload 必须分开 ——
 * 前者是「你指的条目不存在」,后者是「条目存在但你写的东西不合法」。
 */
export type ApplyErrorCode =
  | "unknown_facet"   // 面 id 不在注册表内
  | "not_implemented" // 面存在但没实现写(当前只有 skills / rag)
  | "unknown_entry"   // 面内没有这个 id(防路径穿越的第一道闸)
  | "invalid_payload" // id 合法但内容不合法(超长 / 未知工具名 / 类型不对)
  | "io_error";       // 备份 / 写盘 / 回读校验失败 —— 文件**未被改动**

/** 写面请求。payload 形状由各面自己定义(prompts: { content };tools: { allow, deny })。 */
export interface HarnessApplyInput {
  /** 面内条目 id(prompts = unit id;tools = role)。**各面只认注册表里的 id**, */
  id: string;
  payload: unknown;
  /** true = 恢复出厂,忽略 payload */
  reset?: boolean;
}

export interface HarnessApplyOk {
  ok: true;
  facet: HarnessFacetId;
  id: string;
  /** false = 内容与现状一致,未落盘(没有备份,没有副作用) */
  changed: boolean;
  /** 覆盖前那份内容的备份路径(相对 dataDir 的绝对路径);没有可备份的旧文件 → null */
  backupPath: string | null;
  /** 实际写入的文件绝对路径 */
  filePath: string;
  /** 改动后什么时候生效(系统事实,取自各面自己的注册表) */
  apply: string;
  /** 写入告警:被上界拒绝的工具 / allow∩deny / 写成空内容 …… 绝不静默 */
  warnings: string[];
  /** **写完之后的真实快照**,由该面的 describe() 现算 —— 报成功必须等于真生效 */
  entry: HarnessEntry;
}

export interface HarnessApplyErr {
  ok: false;
  error: ApplyErrorCode;
  message: string;
  /** 例如「哪些工具名不认识」;仅供 UI 展示,不当控制流用 */
  details?: unknown;
}

export type HarnessApplyResult = HarnessApplyOk | HarnessApplyErr;

/**
 * 写层的内部返回(apply.ts → facets/*):facet 实现方把它翻译成
 * HarnessApplyResult —— 补上面 id 与「写完后的 entry 快照」,别的形状不变。
 * 这样 apply.ts 不必 import 注册表(facet.ts ↔ facets/* ↔ apply.ts 会成环)。
 */
export type RawApplyResult =
  | {
      ok: true;
      changed: boolean;
      backupPath: string | null;
      filePath: string;
      warnings: string[];
      /** 落盘后的内容(回读得到,不是内存里那份) */
      content: string;
    }
  | { ok: false; error: ApplyErrorCode; message: string; details?: unknown };

