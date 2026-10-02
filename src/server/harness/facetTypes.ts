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
