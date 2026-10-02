/**
 * Sansheng Harness · rag facet(未实现占位)
 *
 * 与 skills 同款:**只放一个壳,让缺口在管理面里显式可见**。但 rag 的处境
 * 与 skills 不同 —— 它是「**底层全齐、管理面全无**」,所以本文件的说明比
 * skills 那份长得多,因为将来做的时候不必重新调研。
 *
 * 现状(批次 7-G 时经 grep 核实,不是记忆):
 *   - 写侧:`storage/embeddings.ts` 的 `embedText(text, provider)` + LRU 缓存
 *     (`EMBEDDING_CACHE_MAX_ENTRIES`);调用点在 `kernel/agentKernel.ts:1788`,
 *     **embedding 模型硬编码 `text-embedding-3-small`**(同文件 1791 行),
 *     没有任何地方能改。
 *   - 存储侧:`fragments_vec` 虚表 + sqlite-vec 扩展(migration 002)+
 *     `upsertFragmentEmbedding`;`isVecAvailable` 决定降级。
 *   - 检索侧:`repo/fragments.ts` 的 `searchFragments`(有 embedding 走向量,
 *     否则退 importance 排序)与 `searchFragmentsByText`(LIKE 轻量检索,
 *     默认排除 `kind="summary"`)。
 *   - 消费侧:`ws.ts:633` 每条用户消息做一次 `searchFragmentsByText(db, content,
 *     { limit: 3 })` + `listProfile`,拼成上下文块注入(M3a 记忆富集)。
 *
 * 也就是说**检索已经在生产跑**,只是全部参数写死、管理面不存在。
 * 将来这一面要管的(按收益排序):
 *   1. **语料源**:现在只吃 conversations 的沉淀产物(`kind` 白名单 + extractor)。
 *      `harness/rag/sources.json` 应当能声明「还索引什么」(代码库 / 文档 / 对话归档)。
 *   2. **切分与 embedding 规格**:chunk 大小/重叠、`text-embedding-3-small` 硬编码
 *      → 挪到配置;换模型必须触发**重索引**(维度变了旧向量直接不可比 ——
 *      `repo/fragments.ts` 里 INSERT 维度不符会 throw,已有注释记录)。
 *   3. **检索参数**:`limit: 3`、k 值、相似度阈值、按 `kind` 的过滤 —— 全写死。
 *   4. **重索引 / 索引健康度**:向量表与 fragments 表的漂移检测(现在没有)。
 *
 * ⚠️ 一条必须留给实现者的警告:`searchFragments` 走向量分支的前提是
 * `isVecAvailable(db)`;sqlite-vec 是 optionalDependencies,装不上就静默降级到
 * LIKE/importance。**任何「开了 rag 索引」的 UI 状态都必须显示当前是否真在
 * 向量检索**,否则又是一处「看起来正常但不准」(同 `/api/health` 的 vecLoaded 教训)。
 */
import type { HarnessFacet } from "../facet.js";

export const ragFacet: HarnessFacet = {
  id: "rag",
  title: "检索增强",
  implemented: false,
  notImplementedNote:
    "未实现管理面,但**检索本身已在生产跑**:ws.ts 每条用户消息做一次 searchFragmentsByText(limit=3)+ profile 注入,底层有 fragments_vec + sqlite-vec + embedText。缺的是管理面 —— 语料源、切分规格、embedding 模型(hardcode 在 agentKernel.ts:1791 的 text-embedding-3-small)、检索参数、重索引,全部写死。",
  ensure() {
    // 未实现 → 不写任何出厂文件
  },
  describe() {
    // 未实现 → 空条目。**不编造索引状态** —— 编出来用户会以为该配的都能配。
    return [];
  },
};
