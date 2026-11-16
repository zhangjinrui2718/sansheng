-- 031 · 结构化验收判据(2026-11-15)
--
-- 设计:以终为始(Begin with the End in Mind)的**工程化** ——
-- 此前项目的验收判据只存在于 goal 自由文本里(BM 立项时写在目标中),
-- 不可查询、不可逐条引用、不可逐条核验。「引用判据原文」的锚点闸
-- (tools/client.ts)只能做模糊包含匹配。
--
-- 本迁移把判据升级为**结构化数据**:
--   · `acceptance_criteria` = JSON 数组(每条一个可检验的判据句子);
--   · `project_open` 必填;`project_update` 可改;
--   · 下游(质检逐条审 / ask_client 锚点引用 / 交付自检对照)按条消费。
--
-- ── 为什么是纯加列,不是重建表 ────────────────────────────────────
--
-- 与 030(`knowledge_tier`)同一条先例:纯加列、NOT NULL 带默认、无 CHECK ——
-- 取值域(JSON 数组)在读写两侧的 TS 里校验,不靠 schema 闭集。
-- 重建 `projects` 表要动七条外键(018 记过数),成本与风险不成比例。
--
-- ── 存量项目 = 空数组 ────────────────────────────────────────────
--
-- 存量项目的判据躺在 goal 文本里,**不自动抽取** —— 从自由文本机械提取
-- 结构化判据是平台做不到的事(与 030 的 tier 不同:tier 有 kind 可判,
-- 判据没有)。空数组 =「还没有结构化判据」,由 BM 在下一次 edit 时补
-- (BM 持 project.update)。诚实:空就是空,不伪造。

ALTER TABLE projects
  ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '[]';
